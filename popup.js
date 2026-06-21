// Popup controller for Gemini Chat Saver extension

document.addEventListener("DOMContentLoaded", async () => {
  const chatCountBadge = document.getElementById("chat-count");
  const recentListContainer = document.getElementById("recent-list");
  const btnOpenDashboard = document.getElementById("btn-open-dashboard");
  const syncStatusText = document.getElementById("sync-status");

  // 1. Initialize Dexie Database
  let db = null;
  try {
    db = new Dexie("GeminiChatSaverDB");
    db.version(1).stores({
      chats: "id, title, updatedAt"
    });
  } catch (e) {
    console.error("Dexie failed in popup:", e);
    recentListContainer.innerHTML = `<div class="empty-state">Database error.</div>`;
    return;
  }

  // 2. Load Stats and Recent List
  try {
    const totalChats = await db.chats.count();
    chatCountBadge.innerText = `${totalChats} ${totalChats === 1 ? 'Chat' : 'Chats'}`;

    if (totalChats === 0) {
      recentListContainer.innerHTML = `
        <div class="empty-state">
          No chats saved yet. Go to gemini.google.com to start chatting!
        </div>
      `;
    } else {
      // Get 3 most recently updated chats
      const recentChats = await db.chats
        .orderBy("updatedAt")
        .reverse()
        .limit(3)
        .toArray();

      recentListContainer.innerHTML = ""; // Clear loader
      
      recentChats.forEach(chat => {
        const item = document.createElement("div");
        item.className = "recent-item";
        
        // Relative time formatting
        const relativeTime = getRelativeTime(chat.updatedAt);
        const messageCount = chat.messages ? chat.messages.length : 0;
        
        item.innerHTML = `
          <div class="recent-item-title">${escapeHTML(chat.title)}</div>
          <div class="recent-item-meta">
            <span>${messageCount} ${messageCount === 1 ? 'message' : 'messages'}</span>
            <span>${relativeTime}</span>
          </div>
        `;
        
        // Click navigates to specific chat in dashboard
        item.addEventListener("click", () => {
          chrome.runtime.sendMessage({ 
            action: "open_dashboard", 
            chatId: chat.id 
          });
          window.close(); // Close popup
        });
        
        recentListContainer.appendChild(item);
      });
    }
  } catch (err) {
    console.error("Error reading database in popup: ", err);
    recentListContainer.innerHTML = `<div class="empty-state">Error loading history.</div>`;
  }

  // 3. Setup Open Dashboard click listener
  btnOpenDashboard.addEventListener("click", () => {
    chrome.runtime.sendMessage({ action: "open_dashboard" });
    window.close();
  });

  // 4. Update Google Drive Sync status message
  chrome.storage.local.get(["gdrive_client_id", "gdrive_last_sync"], (res) => {
    if (res.gdrive_client_id) {
      if (res.gdrive_last_sync && res.gdrive_last_sync.time) {
        const relativeTime = getRelativeTime(res.gdrive_last_sync.time);
        if (res.gdrive_last_sync.status === "success") {
          syncStatusText.innerText = `Sync: Synced ${relativeTime}`;
          syncStatusText.className = "active";
        } else {
          syncStatusText.innerText = "Sync: Action required";
          syncStatusText.className = "error";
        }
      } else {
        syncStatusText.innerText = "Sync Configured";
        syncStatusText.className = "active";
      }
    } else {
      syncStatusText.innerText = "Local storage active";
      syncStatusText.className = "local";
    }
  });
});

// Helper: formats timestamps to relative times
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

// Helper: escapes HTML characters to prevent XSS
function escapeHTML(str) {
  if (!str) return "";
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
