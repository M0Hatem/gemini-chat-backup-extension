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
    syncWithGoogleDrive(request.clientId, request.localChats, true)
      .then(async (result) => {
        const syncStatus = {
          status: "success",
          time: Date.now(),
          error: null
        };
        await chrome.storage.local.set({ gdrive_last_sync: syncStatus });
        sendResponse({ success: true, result: result });
      })
      .catch(async (err) => {
        console.error("Gdrive sync failed: ", err);
        const errMsg = err.message || "";
        let displayMsg = errMsg;
        if (errMsg.includes("interaction required") || errMsg.includes("User interaction required")) {
          displayMsg = "Authentication required. Please click 'Sync with Google Drive' to authorize.";
        }
        const syncStatus = {
          status: "error",
          time: Date.now(),
          error: displayMsg
        };
        await chrome.storage.local.set({ gdrive_last_sync: syncStatus });
        sendResponse({ success: false, error: displayMsg });
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
  const CHUNK_SIZE = 8192; // Use chunks to avoid call stack size exceeded on large images
  for (let i = 0; i < len; i += CHUNK_SIZE) {
    const chunk = bytes.subarray(i, i + CHUNK_SIZE);
    binary += String.fromCharCode.apply(null, chunk);
  }
  
  const base64String = btoa(binary);
  return `data:${blob.type || "image/png"};base64,${base64String}`;
}

// Google Drive Sync API Operations
async function syncWithGoogleDrive(clientId, localChats, interactive = true) {
  if (!clientId) {
    throw new Error("Google Client ID is missing. Set it in settings.");
  }
  
  // Use cached token, or retrieve silently, or fallback to interactive
  const token = await getGoogleAccessToken(clientId, interactive);
  
  // 1. Search or create the folder "Gemini Chat Backups"
  let folderId = "root";
  try {
    const folderSearchUrl = "https://www.googleapis.com/drive/v3/files?q=" + encodeURIComponent("name='Gemini Chat Backups' and mimeType='application/vnd.google-apps.folder' and trashed=false");
    const folderSearchResponse = await fetch(folderSearchUrl, {
      headers: { "Authorization": `Bearer ${token}` }
    });
    
    if (folderSearchResponse.status === 401) {
      // Token is invalid or revoked, clear cache and retry
      await chrome.storage.local.remove(["gdrive_access_token", "gdrive_token_expires_at"]);
      throw new Error("Google authorization expired. Please click 'Sync with Google Drive' to sign in again.");
    }
    
    if (folderSearchResponse.ok) {
      const folderSearchData = await folderSearchResponse.json();
      if (folderSearchData.files && folderSearchData.files.length > 0) {
        folderId = folderSearchData.files[0].id;
      } else {
        // Create folder
        const createFolderUrl = "https://www.googleapis.com/drive/v3/files";
        const createFolderResponse = await fetch(createFolderUrl, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${token}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            name: "Gemini Chat Backups",
            mimeType: "application/vnd.google-apps.folder"
          })
        });
        if (createFolderResponse.ok) {
          const createFolderData = await createFolderResponse.json();
          folderId = createFolderData.id;
        } else {
          console.warn("Failed to create folder, saving to root: ", createFolderResponse.statusText);
        }
      }
    }
  } catch (err) {
    if (err.message.includes("expired")) throw err;
    console.warn("Failed folder checking/creation, saving to root: ", err);
  }

  // 2. Search if the backup file exists in the folder
  const searchUrl = "https://www.googleapis.com/drive/v3/files?q=" + encodeURIComponent(`name='gemini_chats_backup.json' and '${folderId}' in parents and trashed=false`);
  const searchResponse = await fetch(searchUrl, {
    headers: { "Authorization": `Bearer ${token}` }
  });
  if (!searchResponse.ok) {
    throw new Error(`Gdrive search failed: ${searchResponse.statusText}`);
  }
  const searchData = await searchResponse.json();
  const file = searchData.files && searchData.files[0];
  
  let remoteChats = [];
  let fileExists = false;
  
  if (file) {
    fileExists = true;
    // 3. If file exists, download it
    const downloadUrl = `https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`;
    const downloadResponse = await fetch(downloadUrl, {
      headers: { "Authorization": `Bearer ${token}` }
    });
    
    if (downloadResponse.ok) {
      try {
        const rawData = await downloadResponse.json();
        if (rawData) {
          if (Array.isArray(rawData)) {
            // Old format: raw array
            remoteChats = rawData;
          } else if (rawData.chats && Array.isArray(rawData.chats)) {
            // New format: wrapped version object
            remoteChats = rawData.chats;
          }
        }
      } catch (e) {
        console.warn("Could not parse remote backup JSON: ", e);
      }
    }
  }
  
  // OPTIMIZATION: If local is empty, skip uploading and write remote directly
  if (!localChats || localChats.length === 0) {
    console.log("Local database is blank. Direct import completed. Skipping upload back to Google Drive.");
    return remoteChats;
  }
  
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
  
  const mergedChats = Array.from(mergedMap.values());
  
  // Upload merged versioned schema back to Google Drive
  const backupPayload = {
    backupVersion: "1.0",
    updatedAt: Date.now(),
    chats: mergedChats
  };
  
  if (fileExists) {
    // Update existing file
    const updateUrl = `https://www.googleapis.com/upload/drive/v3/files/${file.id}?uploadType=media`;
    const updateResponse = await fetch(updateUrl, {
      method: "PATCH",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(backupPayload)
    });
    
    if (!updateResponse.ok) {
      throw new Error(`Gdrive update failed: ${updateResponse.statusText}`);
    }
  } else {
    // Create new file inside the folder
    const metadata = {
      name: "gemini_chats_backup.json",
      mimeType: "application/json",
      parents: [folderId]
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
      JSON.stringify(backupPayload) +
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
  
  return mergedChats;
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
  // We only run this check if the incoming session ID is NOT already active for this URL ID
  if (urlId && currentSessionId !== urlId && chatRecord.messages && chatRecord.messages.length > 0) {
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

  // 5. Schedule background auto-backup if enabled (Default to true if undefined)
  chrome.storage.local.get(["gdrive_client_id", "gdrive_auto_backup"], (res) => {
    if (res.gdrive_client_id && res.gdrive_auto_backup !== false) {
      console.log("Scheduling background auto-backup alarm in 1 minute...");
      chrome.alarms.create("gdrive_auto_backup", { delayInMinutes: 1.0 });
    }
  });

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

// Alarm listener for background auto-backup
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "gdrive_auto_backup") {
    console.log("Auto-backup alarm fired!");
    chrome.storage.local.get(["gdrive_client_id", "gdrive_auto_backup"], async (res) => {
      if (res.gdrive_client_id && res.gdrive_auto_backup !== false) {
        try {
          if (!db) {
            console.error("Auto-backup failed: Database not initialized");
            return;
          }
          const localChats = await db.chats.toArray();
          console.log(`Running background auto-backup for ${localChats.length} chats...`);
          
          // Call sync with interactive = false
          const mergedChats = await syncWithGoogleDrive(res.gdrive_client_id, localChats, false);
          
          // Clear and replace local database with unified merged results
          await db.chats.clear();
          for (const chat of mergedChats) {
            await db.chats.put(chat);
          }
          
          // Update storage with sync success status
          const syncStatus = {
            status: "success",
            time: Date.now(),
            error: null
          };
          await chrome.storage.local.set({ gdrive_last_sync: syncStatus });
          console.log("Auto-backup completed successfully!");
          
          // Notify any open dashboard components to refresh
          chrome.runtime.sendMessage({ action: "db_updated", source: "auto_backup" }).catch(() => {
            // Ignore error if no listener is open
          });
        } catch (err) {
          console.error("Auto-backup execution failed: ", err);
          const errMsg = err.message || "";
          let displayMsg = errMsg;
          if (errMsg.includes("interaction required") || errMsg.includes("User interaction required")) {
            displayMsg = "Authentication required. Please click 'Sync with Google Drive' to authorize.";
          }
          const syncStatus = {
            status: "error",
            time: Date.now(),
            error: displayMsg
          };
          await chrome.storage.local.set({ gdrive_last_sync: syncStatus });
          chrome.runtime.sendMessage({ action: "db_updated", source: "auto_backup" }).catch(() => {});
        }
      }
    });
  }
});

// OAuth Access Token Manager (handles Caching and silent renewal)
async function getGoogleAccessToken(clientId, interactive = true) {
  // 1. Check cache first
  const cached = await new Promise((resolve) => {
    chrome.storage.local.get(["gdrive_access_token", "gdrive_token_expires_at"], resolve);
  });
  
  // 5 minutes buffer before actual expiration
  if (cached.gdrive_access_token && cached.gdrive_token_expires_at && (Date.now() < cached.gdrive_token_expires_at - 300000)) {
    console.log("Reusing cached Google access token...");
    return cached.gdrive_access_token;
  }
  
  const redirectUri = chrome.identity.getRedirectURL();
  const scope = "https://www.googleapis.com/auth/drive.file";
  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${clientId}&response_type=token&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(scope)}`;
  
  // 2. Try silent auth first (interactive: false)
  try {
    console.log("Attempting silent token retrieval...");
    const silentUrl = await new Promise((resolve, reject) => {
      chrome.identity.launchWebAuthFlow({
        url: authUrl,
        interactive: false
      }, (redirectUrl) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else if (!redirectUrl) {
          reject(new Error("No redirect URL."));
        } else {
          resolve(redirectUrl);
        }
      });
    });
    
    return await saveAndReturnToken(silentUrl);
  } catch (err) {
    console.log("Silent auth failed: ", err.message);
    
    // 3. Fallback to interactive if allowed
    if (interactive) {
      console.log("Falling back to interactive auth flow...");
      const interactiveUrl = await new Promise((resolve, reject) => {
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
      
      return await saveAndReturnToken(interactiveUrl);
    } else {
      throw new Error("Google authentication required. Please click 'Sync with Google Drive' to authorize.");
    }
  }
}

async function saveAndReturnToken(responseUrl) {
  const tokenMatch = responseUrl.match(/access_token=([^&]+)/);
  if (!tokenMatch) {
    throw new Error("Access token could not be parsed from redirect URL.");
  }
  const token = tokenMatch[1];
  
  const expiresMatch = responseUrl.match(/expires_in=([^&]+)/);
  const expiresInSeconds = expiresMatch ? parseInt(expiresMatch[1], 10) : 3600;
  const expiresAt = Date.now() + (expiresInSeconds * 1000);
  
  await chrome.storage.local.set({
    gdrive_access_token: token,
    gdrive_token_expires_at: expiresAt
  });
  
  console.log(`Successfully obtained and cached Google token. Expires in ${expiresInSeconds}s.`);
  return token;
}

