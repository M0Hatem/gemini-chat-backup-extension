// Background service worker for Gemini Chat Saver

// Handle click on extension icon (optional fallback if popup isn't set, but popup is set)
chrome.runtime.onInstalled.addListener(() => {
  console.log("Gemini Chat Saver installed successfully!");
});

// Listener for messages from popup, content scripts, and dashboard
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "open_dashboard") {
    openDashboard(request.chatId);
    sendResponse({ status: "success" });
  } else if (request.action === "fetch_image") {
    fetchImageAsBase64(request.url)
      .then(base64Data => {
        sendResponse({ base64: base64Data });
      })
      .catch(err => {
        console.error("Image fetch failed: ", err);
        sendResponse({ base64: null, error: err.message });
      });
    return true; // Keep message channel open for async response
  } else if (request.action === "continue_chat") {
    // Store conversation context for injection
    chrome.storage.local.set({
      pending_continue_chat: request.historyText
    }, () => {
      // Open Gemini in a new tab
      chrome.tabs.create({ url: "https://gemini.google.com/app" });
      sendResponse({ status: "success" });
    });
    return true;
  } else if (request.action === "sync_gdrive") {
    syncWithGoogleDrive(request.clientId, request.localChats)
      .then(result => {
        sendResponse({ success: true, result: result });
      })
      .catch(err => {
        console.error("Gdrive sync failed: ", err);
        sendResponse({ success: false, error: err.message });
      });
    return true; // Keep channel open
  }
});

// Open dashboard.html or highlight it if already open
function openDashboard(chatId) {
  const dashboardUrl = chrome.runtime.getURL("dashboard.html");
  chrome.tabs.query({}, (tabs) => {
    // Look for existing dashboard tab
    const existingTab = tabs.find(tab => tab.url && tab.url.startsWith(dashboardUrl));
    
    // Construct final URL with optional active chatId hash
    const targetUrl = chatId ? `${dashboardUrl}#${chatId}` : dashboardUrl;
    
    if (existingTab) {
      chrome.tabs.update(existingTab.id, { active: true, url: targetUrl }, () => {
        // Bring parent window to front if active
        chrome.windows.update(existingTab.windowId, { drawAttention: true, focused: true });
      });
    } else {
      chrome.tabs.create({ url: targetUrl });
    }
  });
}

// Bypasses CORS in background to fetch and convert image to Base64
async function fetchImageAsBase64(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch image, status: ${response.status}`);
  }
  const blob = await response.blob();
  const buffer = await blob.arrayBuffer();
  
  // Convert array buffer to binary string
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  
  const base64String = btoa(binary);
  return `data:${blob.type || "image/png"};base64,${base64String}`;
}

// Google Drive Sync API Operations
async function syncWithGoogleDrive(clientId, localChats) {
  if (!clientId) {
    throw new Error("Google Client ID is missing. Set it in settings.");
  }
  
  const redirectUri = chrome.identity.getRedirectURL();
  const scope = "https://www.googleapis.com/auth/drive.file";
  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${clientId}&response_type=token&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(scope)}`;
  
  // Run OAuth flow
  const responseUrl = await new Promise((resolve, reject) => {
    chrome.identity.launchWebAuthFlow({
      url: authUrl,
      interactive: true
    }, (redirectUrl) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else if (!redirectUrl) {
        reject(new Error("OAuth flow completed with no redirect URL."));
      } else {
        resolve(redirectUrl);
      }
    });
  });
  
  // Extract token from redirected URL hash parameters
  const matches = responseUrl.match(/access_token=([^&]+)/);
  if (!matches) {
    throw new Error("Access token could not be parsed from authorization redirect URL.");
  }
  const token = matches[1];
  
  // 1. Search if the backup file exists in Google Drive
  const searchUrl = "https://www.googleapis.com/drive/v3/files?q=" + encodeURIComponent("name='gemini_chats_backup.json' and trashed=false");
  const searchResponse = await fetch(searchUrl, {
    headers: { "Authorization": `Bearer ${token}` }
  });
  if (!searchResponse.ok) {
    throw new Error(`Gdrive search failed: ${searchResponse.statusText}`);
  }
  const searchData = await searchResponse.json();
  const file = searchData.files && searchData.files[0];
  
  let mergedChats = [...localChats];
  
  if (file) {
    // 2. If file exists, download it
    const downloadUrl = `https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`;
    const downloadResponse = await fetch(downloadUrl, {
      headers: { "Authorization": `Bearer ${token}` }
    });
    
    if (downloadResponse.ok) {
      try {
        const remoteChats = await downloadResponse.json();
        // Merge Logic: Combine local and remote. In case of duplicates, preserve the one with newer updatedAt
        const mergedMap = new Map();
        
        // Put all local chats in the map
        localChats.forEach(c => mergedMap.set(c.id, c));
        
        // Merge remote chats
        if (Array.isArray(remoteChats)) {
          remoteChats.forEach(rc => {
            if (mergedMap.has(rc.id)) {
              const lc = mergedMap.get(rc.id);
              // Compare updatedAt timestamps
              if ((rc.updatedAt || 0) > (lc.updatedAt || 0)) {
                mergedMap.set(rc.id, rc);
              }
            } else {
              mergedMap.set(rc.id, rc);
            }
          });
        }
        
        mergedChats = Array.from(mergedMap.values());
      } catch (e) {
        console.warn("Could not parse remote backup JSON, overwriting with local: ", e);
      }
    }
    
    // 3. Update the existing file in Drive
    const updateUrl = `https://www.googleapis.com/upload/drive/v3/files/${file.id}?uploadType=media`;
    const updateResponse = await fetch(updateUrl, {
      method: "PATCH",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(mergedChats)
    });
    
    if (!updateResponse.ok) {
      throw new Error(`Gdrive update failed: ${updateResponse.statusText}`);
    }
  } else {
    // 4. If file doesn't exist, create it
    const metadata = {
      name: "gemini_chats_backup.json",
      mimeType: "application/json"
    };
    
    const boundary = "314159265358979323846";
    const delimiter = `\r\n--${boundary}\r\n`;
    const closeDelimiter = `\r\n--${boundary}--\r\n`;
    
    const multipartBody = 
      delimiter +
      'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
      JSON.stringify(metadata) +
      delimiter +
      'Content-Type: application/json\r\n\r\n' +
      JSON.stringify(mergedChats) +
      closeDelimiter;
      
    const createUrl = "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart";
    const createResponse = await fetch(createUrl, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": `multipart/related; boundary=${boundary}`
      },
      body: multipartBody
    });
    
    if (!createResponse.ok) {
      throw new Error(`Gdrive creation failed: ${createResponse.statusText}`);
    }
  }
  
  return mergedChats; // Return merged list so local database can sync with it
}
