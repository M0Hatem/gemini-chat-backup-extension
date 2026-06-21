// Dashboard controller for Gemini Chat Archive Dashboard

document.addEventListener("DOMContentLoaded", async () => {
  // Database instance
  let db = null;
  try {
    db = new Dexie("GeminiChatSaverDB");
    db.version(1).stores({
      chats: "id, title, updatedAt"
    });
  } catch (e) {
    console.error("Dexie failed to load in dashboard:", e);
    alert("Database initialization error. Please reload the tab.");
    return;
  }

  // Active state
  let activeChatId = null;

  // DOM Elements
  const chatList = document.getElementById("chat-list");
  const searchInput = document.getElementById("search-input");
  
  const chatView = document.getElementById("chat-view");
  const welcomeView = document.getElementById("welcome-view");
  const activeChatTitle = document.getElementById("active-chat-title");
  const activeChatMeta = document.getElementById("active-chat-meta");
  const messagesContainer = document.getElementById("messages-container");
  
  const btnContinue = document.getElementById("btn-continue");
  const btnExportMd = document.getElementById("btn-export-md");
  const btnCopyRaw = document.getElementById("btn-copy-raw");
  const btnDelete = document.getElementById("btn-delete");
  
  const statChatsVal = document.getElementById("stat-chats-val");
  const statMessagesVal = document.getElementById("stat-messages-val");
  
  // Settings Modal Elements
  const settingsModal = document.getElementById("settings-modal");
  const btnSettingsToggle = document.getElementById("btn-settings-toggle");
  const btnSettingsClose = document.getElementById("btn-settings-close");
  const modalOverlay = settingsModal.querySelector(".modal-overlay");
  
  const inputClientId = document.getElementById("input-client-id");
  const redirectUrlDisplay = document.getElementById("redirect-url-display");
  const btnSaveClientId = document.getElementById("btn-save-client-id");
  const btnSyncGdrive = document.getElementById("btn-sync-gdrive");
  const gdriveStatus = document.getElementById("gdrive-status");
  
  const checkboxAutoBackup = document.getElementById("checkbox-auto-backup");
  const gdriveLastSyncInfo = document.getElementById("gdrive-last-sync-info");
  const gdriveLastSyncStatusVal = document.getElementById("gdrive-last-sync-status-val");
  const gdriveLastSyncTimeVal = document.getElementById("gdrive-last-sync-time-val");
  const selectTheme = document.getElementById("select-theme");
  const accountFilterList = document.getElementById("account-filter-list");

  const btnExportJson = document.getElementById("btn-export-json");
  const btnImportTrigger = document.getElementById("btn-import-trigger");
  const inputImportJson = document.getElementById("input-import-json");
  const localStatus = document.getElementById("local-status");
  
  const loadingOverlay = document.getElementById("loading-overlay");
  const loadingText = document.getElementById("loading-text");

  // Display authorized redirect URL for Google Cloud Console configuration
  try {
    const redirectUrl = chrome.identity.getRedirectURL();
    redirectUrlDisplay.textContent = redirectUrl;
  } catch (err) {
    redirectUrlDisplay.textContent = "chrome-extension://<id>";
  }

  // Helper to apply the active theme preference
  function applyTheme(theme) {
    if (theme === "system" || !theme) {
      document.documentElement.removeAttribute("data-theme");
    } else {
      document.documentElement.setAttribute("data-theme", theme);
    }
  }

  // --- 1. Load Settings and Client ID ---
  let currentSyncInfo = null;
  chrome.storage.local.get(["gdrive_client_id", "gdrive_auto_backup", "gdrive_last_sync", "theme_preference"], (res) => {
    if (res.gdrive_client_id) {
      inputClientId.value = res.gdrive_client_id;
      btnSyncGdrive.disabled = false;
    }
    // Default background auto-backup to true if undefined
    if (res.gdrive_auto_backup !== false) {
      checkboxAutoBackup.checked = true;
    }
    if (res.gdrive_last_sync) {
      currentSyncInfo = res.gdrive_last_sync;
      updateLastSyncDisplay(currentSyncInfo);
    }
    const themePref = res.theme_preference || "system";
    selectTheme.value = themePref;
    applyTheme(themePref);
  });

  selectTheme.addEventListener("change", () => {
    const selected = selectTheme.value;
    applyTheme(selected);
    chrome.storage.local.set({ theme_preference: selected });
  });

  // Periodically refresh relative time display for last sync
  setInterval(() => {
    if (currentSyncInfo) {
      updateLastSyncDisplay(currentSyncInfo);
    }
  }, 10000);

  // Monitor storage changes to dynamically update last sync info
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.gdrive_last_sync) {
      currentSyncInfo = changes.gdrive_last_sync.newValue;
      updateLastSyncDisplay(currentSyncInfo);
    }
  });

  // Listen for database updates broadcasted by the background script on auto-backups
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "db_updated") {
      console.log("Database updated in background. Refreshing views...");
      refreshSidebar(searchInput.value);
      updateWelcomeStats();
      if (activeChatId) {
        loadChatIntoView(activeChatId);
      }
    }
  });

  // --- 2. Initial Render ---
  await refreshSidebar();
  await updateWelcomeStats();
  handleHashNavigation();

  // Listen for hash changes in URL (for deep linking)
  window.addEventListener("hashchange", handleHashNavigation);

  // --- 3. Sidebar Actions & Search ---
  searchInput.addEventListener("input", debounce(async () => {
    await refreshSidebar(searchInput.value);
  }, 300));

  async function refreshSidebar(query = "") {
    try {
      let chats = [];
      const lowerQuery = query.toLowerCase().trim();
      if (!lowerQuery) {
        chats = await db.chats.orderBy("updatedAt").reverse().toArray();
      } else {
        chats = await db.chats.filter(c => {
          const matchTitle = c.title.toLowerCase().includes(lowerQuery);
          const matchMsg = c.messages && c.messages.some(m => m.text.toLowerCase().includes(lowerQuery));
          return matchTitle || matchMsg;
        }).toArray();
        
        // Sort search results by updated date
        chats.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      }

      chatList.innerHTML = "";
      
      if (chats.length === 0) {
        chatList.innerHTML = `<div class="empty-sidebar">No chats found.</div>`;
        return;
      }

      chats.forEach(chat => {
        const item = document.createElement("div");
        item.className = `chat-item ${chat.id === activeChatId ? "active" : ""}`;
        item.dataset.id = chat.id;
        
        const relativeTime = getRelativeTime(chat.updatedAt);
        const msgCount = chat.messages ? chat.messages.length : 0;
        
        let snippetHTML = "";
        if (lowerQuery) {
          const matchMsg = chat.messages ? chat.messages.find(m => m.text.toLowerCase().includes(lowerQuery)) : null;
          if (matchMsg) {
            const snippet = createSearchSnippet(matchMsg.text, query);
            if (snippet) {
              snippetHTML = `<div class="chat-item-snippet">${snippet}</div>`;
            }
          }
        }
        
        item.innerHTML = `
          <div class="chat-item-title">${escapeHTML(chat.title)}</div>
          ${snippetHTML}
          <div class="chat-item-meta">
            <span>${msgCount} ${msgCount === 1 ? 'msg' : 'msgs'}</span>
            <span>${relativeTime}</span>
          </div>
        `;
        
        item.addEventListener("click", () => {
          window.location.hash = chat.id;
        });
        
        chatList.appendChild(item);
      });
    } catch (err) {
      console.error("Sidebar refresh failed:", err);
      chatList.innerHTML = `<div class="empty-sidebar">Error loading database.</div>`;
    }
  }

  function createSearchSnippet(text, query) {
    if (!text || !query) return "";
    const lowerText = text.toLowerCase();
    const lowerQuery = query.toLowerCase();
    const index = lowerText.indexOf(lowerQuery);
    if (index === -1) return "";

    // Set boundary window surrounding matched word
    const start = Math.max(0, index - 40);
    const end = Math.min(text.length, index + query.length + 50);
    
    let snippet = text.substring(start, end);
    if (start > 0) snippet = "..." + snippet;
    if (end < text.length) snippet = snippet + "...";

    // Escape HTML and highlight matching query
    const escapedSnippet = escapeHTML(snippet);
    const regex = new RegExp(`(${escapeRegExp(query)})`, "gi");
    return escapedSnippet.replace(regex, "<mark class='search-highlight'>$1</mark>");
  }

  function escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  async function updateWelcomeStats() {
    try {
      const totalChats = await db.chats.count();
      const chats = await db.chats.toArray();
      let totalMessages = 0;
      chats.forEach(c => {
        if (c.messages) totalMessages += c.messages.length;
      });
      
      statChatsVal.textContent = totalChats;
      statMessagesVal.textContent = totalMessages;
    } catch (e) {
      console.error("Stats load failed:", e);
    }
  }

  function handleHashNavigation() {
    const hash = window.location.hash.substring(1);
    if (hash) {
      loadChatIntoView(hash);
    } else {
      activeChatId = null;
      chatView.classList.add("hidden");
      welcomeView.classList.remove("hidden");
      
      // Update sidebar active class
      document.querySelectorAll(".chat-item").forEach(item => {
        item.classList.remove("active");
      });
    }
  }

  // --- 4. Chat View Operations ---
  async function loadChatIntoView(id) {
    try {
      const chat = await db.chats.get(id);
      if (!chat) {
        window.location.hash = "";
        return;
      }

      activeChatId = id;
      
      // Update active selection in sidebar
      document.querySelectorAll(".chat-item").forEach(item => {
        if (item.dataset.id === id) {
          item.classList.add("active");
        } else {
          item.classList.remove("active");
        }
      });

      // Populate text info
      activeChatTitle.textContent = chat.title;
      let metaText = `Last updated: ${new Date(chat.updatedAt).toLocaleString()}`;
      if (chat.accountEmail) {
        metaText += ` • Account: ${chat.accountEmail}`;
      }
      activeChatMeta.textContent = metaText;
      
      // Render messages list
      messagesContainer.innerHTML = "";
      
      if (chat.messages && chat.messages.length > 0) {
        chat.messages.forEach(msg => {
          const wrapper = document.createElement("div");
          wrapper.className = `message-wrapper ${msg.role}`;
          
          const bubble = document.createElement("div");
          bubble.className = "message-bubble";
          
          // Header
          const header = document.createElement("div");
          header.className = "msg-header";
          const formattedTime = new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
          header.innerHTML = `<span>${msg.role === "user" ? "You" : "Gemini"}</span><span>${formattedTime}</span>`;
          bubble.appendChild(header);
          
          // Parse Markdown safely
          const content = document.createElement("div");
          content.className = "msg-content";
          
          // Run marked + DOMPurify sanitization
          const htmlContent = DOMPurify.sanitize(marked.parse(msg.text));
          content.innerHTML = htmlContent;
          
          // Add copy triggers to parsed code block elements
          content.querySelectorAll("pre").forEach(pre => {
            const copyBtn = document.createElement("button");
            copyBtn.className = "code-copy-btn";
            copyBtn.innerText = "Copy";
            copyBtn.addEventListener("click", () => {
              const codeNode = pre.querySelector("code");
              if (codeNode) {
                navigator.clipboard.writeText(codeNode.innerText).then(() => {
                  copyBtn.innerText = "Copied ✓";
                  setTimeout(() => copyBtn.innerText = "Copy", 2000);
                });
              }
            });
            pre.appendChild(copyBtn);
          });
          
          bubble.appendChild(content);
          
          // Render images inside block
          if (msg.images && msg.images.length > 0) {
            const imgContainer = document.createElement("div");
            imgContainer.className = "msg-images";
            
            msg.images.forEach(imgData => {
              const img = document.createElement("img");
              img.className = "chat-image";
              img.src = imgData;
              img.alt = "Attachment";
              
              // Click image to preview full-screen
              img.addEventListener("click", () => {
                const viewer = window.open();
                viewer.document.write(`<img src="${imgData}" style="max-width:100%; height:auto; margin:auto; display:block;" />`);
              });
              
              imgContainer.appendChild(img);
            });
            
            bubble.appendChild(imgContainer);
          }
          
          wrapper.appendChild(bubble);
          messagesContainer.appendChild(wrapper);
        });
      }
      
      // Reveal view panels
      welcomeView.classList.add("hidden");
      chatView.classList.remove("hidden");
      
      // Auto Scroll to bottom
      messagesContainer.scrollTop = messagesContainer.scrollHeight;
    } catch (err) {
      console.error("Failed to load chat detail:", err);
      alert("Error displaying chat history details.");
    }
  }

  // --- 5. Button Actions: Delete, Copy, Export, Continue ---
  btnDelete.addEventListener("click", async () => {
    if (!activeChatId) return;
    
    const confirmDelete = confirm("Are you sure you want to delete this conversation permanently? This action cannot be undone.");
    if (confirmDelete) {
      try {
        await db.chats.delete(activeChatId);
        window.location.hash = ""; // Clear view state
        await refreshSidebar();
        await updateWelcomeStats();
      } catch (err) {
        console.error("Delete failed:", err);
        alert("Failed to delete the chat.");
      }
    }
  });

  btnCopyRaw.addEventListener("click", async () => {
    if (!activeChatId) return;
    try {
      const chat = await db.chats.get(activeChatId);
      if (!chat) return;
      
      let rawText = "";
      chat.messages.forEach(msg => {
        const sender = msg.role === "user" ? "User" : "Gemini";
        rawText += `${sender}: ${msg.text}\n\n`;
      });
      
      await navigator.clipboard.writeText(rawText);
      
      const originalText = btnCopyRaw.innerHTML;
      btnCopyRaw.innerHTML = `<span class="btn-icon">✓</span><span>Copied!</span>`;
      setTimeout(() => {
        btnCopyRaw.innerHTML = originalText;
      }, 2000);
    } catch (e) {
      console.error("Copy failed: ", e);
    }
  });

  btnExportMd.addEventListener("click", async () => {
    if (!activeChatId) return;
    try {
      const chat = await db.chats.get(activeChatId);
      if (!chat) return;

      let md = `# ${chat.title}\n\n`;
      md += `*Archive Exported on ${new Date().toLocaleString()}*\n\n`;
      md += `---\n\n`;

      chat.messages.forEach(msg => {
        const sender = msg.role === "user" ? "**User**" : "**Gemini**";
        const timeStr = new Date(msg.timestamp).toLocaleString();
        md += `### ${sender} *(${timeStr})*\n\n${msg.text}\n\n`;
        
        // Include inline images as raw base64 data URLs
        if (msg.images && msg.images.length > 0) {
          msg.images.forEach((img, idx) => {
            md += `![Attachment ${idx + 1}](${img})\n\n`;
          });
        }
        md += `---\n\n`;
      });

      const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${chat.title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.md`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error("Export MD failed: ", e);
    }
  });

  btnContinue.addEventListener("click", async () => {
    if (!activeChatId) return;
    try {
      const chat = await db.chats.get(activeChatId);
      if (!chat) return;
      
      // Format chat history sequentially
      let historyText = "";
      chat.messages.forEach(msg => {
        const label = msg.role === "user" ? "User" : "Gemini";
        historyText += `[${label}]: ${msg.text}\n`;
      });
      
      // Direct message to background.js service worker
      chrome.runtime.sendMessage({
        action: "continue_chat",
        historyText: historyText
      });
    } catch (e) {
      console.error("Failed to execute continue operation:", e);
    }
  });

  // --- 6. Settings Modal Navigation ---
  btnSettingsToggle.addEventListener("click", () => {
    settingsModal.classList.remove("hidden");
    gdriveStatus.className = "sync-status-msg";
    gdriveStatus.textContent = "";
    localStatus.className = "sync-status-msg";
    localStatus.textContent = "";
    loadAccountFilterSettings();
  });

  function closeModal() {
    settingsModal.classList.add("hidden");
  }

  btnSettingsClose.addEventListener("click", closeModal);
  modalOverlay.addEventListener("click", closeModal);

  // --- 7. Google Drive Client ID and Sync Operations ---
  // Enable sync button dynamically and auto-save as the user types/pastes their Client ID
  inputClientId.addEventListener("input", () => {
    const val = inputClientId.value.trim();
    btnSyncGdrive.disabled = !val;
    if (val) {
      chrome.storage.local.set({ gdrive_client_id: val });
    } else {
      chrome.storage.local.remove(["gdrive_client_id", "gdrive_access_token", "gdrive_token_expires_at"]);
    }
  });

  checkboxAutoBackup.addEventListener("change", () => {
    const isEnabled = checkboxAutoBackup.checked;
    chrome.storage.local.set({ gdrive_auto_backup: isEnabled });
  });

  function updateLastSyncDisplay(syncInfo) {
    if (!syncInfo || !syncInfo.time) {
      gdriveLastSyncInfo.classList.add("hidden");
      return;
    }
    gdriveLastSyncInfo.classList.remove("hidden");
    
    if (syncInfo.status === "success") {
      gdriveLastSyncStatusVal.textContent = "✅ Success";
      gdriveLastSyncStatusVal.style.color = "var(--success-color)";
    } else {
      gdriveLastSyncStatusVal.textContent = `❌ Error: ${syncInfo.error || "Unknown error"}`;
      gdriveLastSyncStatusVal.style.color = "var(--danger-color)";
    }
    
    const relativeTime = getRelativeTime(syncInfo.time);
    gdriveLastSyncTimeVal.textContent = relativeTime;
  }

  btnSaveClientId.addEventListener("click", () => {
    const val = inputClientId.value.trim();
    if (val) {
      chrome.storage.local.set({ gdrive_client_id: val }, () => {
        btnSyncGdrive.disabled = false;
        showStatus(gdriveStatus, "success", "Google Client ID saved successfully!");
      });
    } else {
      chrome.storage.local.remove(["gdrive_client_id", "gdrive_access_token", "gdrive_token_expires_at"], () => {
        btnSyncGdrive.disabled = true;
        showStatus(gdriveStatus, "error", "Client ID cleared. Cloud sync disabled.");
      });
    }
  });

  btnSyncGdrive.addEventListener("click", async () => {
    const clientId = inputClientId.value.trim();
    if (!clientId) {
      alert("Please enter a Google Client ID first in the settings input box.");
      return;
    }

    gdriveStatus.className = "sync-status-msg";
    gdriveStatus.textContent = "";
    
    // Launch loading state
    loadingOverlay.classList.remove("hidden");
    loadingText.textContent = "Connecting to Google Drive...";

    try {
      // Load current local chats from database
      const localChats = await db.chats.toArray();
      
      // Dispatch background sync task
      chrome.runtime.sendMessage({
        action: "sync_gdrive",
        clientId: clientId,
        localChats: localChats
      }, async (response) => {
        loadingOverlay.classList.add("hidden");
        
        if (response && response.success) {
          const mergedChats = response.result;
          
          // Clear local database and write back unified merged record list
          await db.chats.clear();
          for (const chat of mergedChats) {
            await db.chats.put(chat);
          }
          
          showStatus(gdriveStatus, "success", "Database successfully synchronized with Google Drive!");
          alert("Synchronization successful!");
          
          // Refresh app view layouts
          await refreshSidebar(searchInput.value);
          await updateWelcomeStats();
          if (activeChatId) {
            await loadChatIntoView(activeChatId);
          }
        } else {
          let errMsg = response ? response.error : "Unknown synchronization error.";
          if (errMsg.includes("undefined") && (errMsg.includes("launchWebAuthFlow") || errMsg.includes("identity"))) {
            errMsg = "Chrome Identity API is not available in this window. Google Account sync is disabled in Incognito/Guest mode or if your Chrome profile policies block it.";
          }
          showStatus(gdriveStatus, "error", `Sync failed: ${errMsg}`);
          alert(`Sync failed: ${errMsg}`);
        }
      });
    } catch (err) {
      loadingOverlay.classList.add("hidden");
      showStatus(gdriveStatus, "error", `Sync failed: ${err.message}`);
      alert(`Sync failed error: ${err.message}`);
    }
  });



  // --- 7b. Account Filtering Configuration ---
  async function loadAccountFilterSettings() {
    chrome.storage.local.get(["detected_accounts", "allowed_accounts"], (res) => {
      const detected = res.detected_accounts || [];
      const allowed = res.allowed_accounts || [];

      accountFilterList.innerHTML = "";

      if (detected.length === 0) {
        accountFilterList.innerHTML = `
          <div class="empty-state" style="font-size: 13px; color: var(--text-muted); padding: 8px 0;">
            No accounts detected yet. Open Gemini and start chatting to register your accounts here.
          </div>
        `;
        return;
      }

      // Sort alphabetically
      detected.sort();

      detected.forEach(email => {
        const item = document.createElement("div");
        item.className = "account-filter-item";

        const isChecked = allowed.includes(email);

        item.innerHTML = `
          <input type="checkbox" id="chk-acc-${email}" class="account-filter-checkbox" ${isChecked ? "checked" : ""}>
          <label for="chk-acc-${email}" class="account-filter-label">
            <span>${escapeHTML(email)}</span>
          </label>
        `;

        const checkbox = item.querySelector("input");
        checkbox.addEventListener("change", () => {
          updateAllowedAccounts();
        });

        accountFilterList.appendChild(item);
      });
    });
  }

  function updateAllowedAccounts() {
    const checkboxes = accountFilterList.querySelectorAll(".account-filter-checkbox");
    const allowed = [];
    checkboxes.forEach(cb => {
      if (cb.checked) {
        const email = cb.id.replace("chk-acc-", "");
        allowed.push(email);
      }
    });

    chrome.storage.local.set({ allowed_accounts: allowed }, () => {
      console.log("Allowed accounts updated:", allowed);
    });
  }

  // --- 8. Local Backup JSON File Export & Import Operations ---
  btnExportJson.addEventListener("click", async () => {
    localStatus.className = "sync-status-msg";
    try {
      const allChats = await db.chats.toArray();
      const jsonStr = JSON.stringify(allChats, null, 2);
      const blob = new Blob([jsonStr], { type: "application/json;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `gemini_chats_local_backup_${Date.now()}.json`;
      a.click();
      URL.revokeObjectURL(url);
      showStatus(localStatus, "success", "Local database backup downloaded successfully!");
    } catch (err) {
      showStatus(localStatus, "error", `Database export failed: ${err.message}`);
    }
  });

  btnImportTrigger.addEventListener("click", () => {
    inputImportJson.click();
  });

  inputImportJson.addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;

    localStatus.className = "sync-status-msg";
    localStatus.textContent = "";

    const reader = new FileReader();
    reader.onload = async (event) => {
      try {
        const importedData = JSON.parse(event.target.result);
        if (!Array.isArray(importedData)) {
          throw new Error("Invalid backup format. Expected a JSON array of chats.");
        }

        // Import records into Dexie
        let importCount = 0;
        for (const chat of importedData) {
          if (chat.id && chat.title && chat.messages) {
            await db.chats.put(chat);
            importCount++;
          }
        }

        showStatus(localStatus, "success", `Import completed successfully! Restored ${importCount} conversations.`);
        
        // Refresh views
        await refreshSidebar(searchInput.value);
        await updateWelcomeStats();
        if (activeChatId) {
          await loadChatIntoView(activeChatId);
        }
      } catch (err) {
        showStatus(localStatus, "error", `Import failed: ${err.message}`);
      }
      
      // Reset input element value to allow importing same file again
      inputImportJson.value = "";
    };
    reader.readAsText(file);
  });

  // --- Helper UI Utilities ---
  function showStatus(elem, type, message) {
    elem.className = `sync-status-msg ${type}`;
    elem.textContent = message;
  }

  function getRelativeTime(timestamp) {
    const diff = Date.now() - timestamp;
    const secs = Math.floor(diff / 1000);
    const mins = Math.floor(secs / 60);
    const hours = Math.floor(mins / 60);
    const days = Math.floor(hours / 24);

    if (secs < 60) return "Just now";
    if (mins < 60) return `${mins}m ago`;
    if (hours < 24) return `${hours}h ago`;
    if (days === 1) return "Yesterday";
    return `${days} days ago`;
  }

  function escapeHTML(str) {
    if (!str) return "";
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
      const later = () => {
        clearTimeout(timeout);
        func(...args);
      };
      clearTimeout(timeout);
      timeout = setTimeout(later, wait);
    };
  }
});
