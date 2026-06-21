// Background service worker for Gemini Chat Saver
importScripts("lib/dexie.min.js");

// Initialize database
let db = null;
try {
  db = new Dexie("GeminiChatSaverDB");
  db.version(1).stores({
    chats: "id, title, updatedAt"
  });
  console.log("Gemini Chat Saver database initialized in background.");
} catch (e) {
  console.error("Dexie initialization failed inside background script:", e);
}

// Handle click on extension icon (optional fallback if popup isn't set, but popup is set)
chrome.runtime.onInstalled.addListener(() => {
  console.log("Gemini Chat Saver installed successfully!");
});

// Listener for messages from popup, content scripts, and dashboard
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "open_dashboard") {
    openDashboard(request.chatId);
    sendResponse({ status: "success" });
  } else if (request.action === "save_chat") {
    saveChatFromContent(request.chat, request.urlId, request.currentSessionId)
      .then((result) => {
        sendResponse({ status: "success", currentSessionId: result.currentSessionId });
      })
      .catch((err) => {
        console.error("Failed to save chat in background:", err);
        sendResponse({ status: "error", error: err.message });
      });
    return true; // Keep channel open
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

// Handles saving a scraped chat record from a content script
async function saveChatFromContent(chatRecord, urlId, currentSessionId) {
  if (!db) {
    throw new Error("Database not initialized");
  }

  let activeId = urlId;
  let newSessionId = currentSessionId;
  let isGlitchedUrl = false;

  // 1. Check if the URL ID is glitched (meaning the DOM conversation is different from the saved one)
  if (urlId && chatRecord.messages && chatRecord.messages.length > 0) {
    try {
      const existing = await db.chats.get(urlId);
      if (existing && existing.messages && existing.messages.length > 0) {
        const firstIncoming = chatRecord.messages[0];
        const firstExisting = existing.messages[0];
        if (firstIncoming && firstExisting) {
          if (firstIncoming.role !== firstExisting.role || firstIncoming.text !== firstExisting.text) {
            console.log(`Detected glitched URL ID: URL is ${urlId} but first message mismatch.`);
            isGlitchedUrl = true;
          }
        }
      }
    } catch (err) {
      console.error("Failed to check if URL is glitched: ", err);
    }
  }

  // 2. Identify active session ID and handle migration if URL ID generated
  if (!activeId || isGlitchedUrl) {
    // If it's a glitched URL, we treat the current session as a new temp session
    if (!currentSessionId || isGlitchedUrl || !currentSessionId.startsWith("temp_")) {
      newSessionId = "temp_" + Date.now();
    }
    activeId = newSessionId;
  } else {
    // If we had a temporary ID, and now a real Gemini URL ID is generated, migrate it!
    if (currentSessionId && currentSessionId.startsWith("temp_") && currentSessionId !== urlId) {
      console.log(`Migrating temp session ${currentSessionId} to official ID ${urlId}`);
      try {
        const tempRecord = await db.chats.get(currentSessionId);
        if (tempRecord) {
          tempRecord.id = urlId;
          tempRecord.updatedAt = Date.now();
          await db.chats.put(tempRecord);
          await db.chats.delete(currentSessionId);
        }
      } catch (err) {
        console.error("Migration error: ", err);
      }
    }
    newSessionId = urlId;
    activeId = urlId;
  }

  // 2. Retrieve existing record to preserve timestamps and image buffers
  let existingRecord = null;
  try {
    existingRecord = await db.chats.get(activeId);
  } catch (err) {
    console.error("Dexie get failed in background: ", err);
  }

  const messages = chatRecord.messages;

  // Preserve timestamps if messages match
  messages.forEach((msg, idx) => {
    if (existingRecord && existingRecord.messages && existingRecord.messages[idx]) {
      const extMsg = existingRecord.messages[idx];
      if (extMsg.role === msg.role && extMsg.text === msg.text) {
        msg.timestamp = extMsg.timestamp;
        
        // Preserve base64 image data if already fetched
        if (extMsg.images && extMsg.images.length > 0) {
          msg.images = extMsg.images.map((img, imgIdx) => {
            // Keep the Base64 version if we have it and the incoming is still HTTP
            if (img && img.startsWith('data:') && (!msg.images[imgIdx] || msg.images[imgIdx].startsWith('http'))) {
              return img;
            }
            return msg.images[imgIdx] || img;
          });
        }
      }
    }
  });

  // 3. Update database record
  const newRecord = {
    id: activeId,
    title: chatRecord.title,
    messages: messages,
    updatedAt: Date.now()
  };

  await db.chats.put(newRecord);
  console.log(`Saved chat "${chatRecord.title}" with ${messages.length} messages. ID: ${activeId}`);

  // 4. Trigger asynchronous background downloads to encode images to base64 format
  triggerBackgroundPrefetchImages(activeId, messages);

  return { currentSessionId: newSessionId };
}

// Prefetch HTTP images and convert them to Base64 to save directly in the DB
function triggerBackgroundPrefetchImages(chatId, messages) {
  messages.forEach((msg, msgIdx) => {
    if (msg.images && msg.images.length > 0) {
      msg.images.forEach((imgUrl, imgIdx) => {
        if (imgUrl && imgUrl.startsWith("http")) {
          fetchImageAsBase64(imgUrl)
            .then(async (base64) => {
              if (base64) {
                console.log(`Image fetched in background. Saving to DB for chat ${chatId}, message ${msgIdx}, image ${imgIdx}`);
                try {
                  const chat = await db.chats.get(chatId);
                  if (chat && chat.messages && chat.messages[msgIdx] && chat.messages[msgIdx].images) {
                    chat.messages[msgIdx].images[imgIdx] = base64;
                    chat.updatedAt = Date.now();
                    await db.chats.put(chat);
                    console.log(`Permanently saved base64 image in DB for chat ${chatId}`);
                  }
                } catch (err) {
                  console.error("Failed to update base64 image in DB: ", err);
                }
              }
            })
            .catch(err => {
              console.error(`Failed to fetch image ${imgUrl}:`, err);
            });
        }
      });
    }
  });
}

