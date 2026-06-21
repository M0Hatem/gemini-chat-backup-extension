// Content script for Google Gemini website
// Integrates Dexie for database operations and watches chat elements

// Global state variables
let currentSessionId = null; // Tracks current chat ID
let scrapeTimeout = null;     // Debounce timer
let activeObserver = null;    // MutationObserver reference

// On load: Check for "Continue Chat" payload
chrome.storage.local.get("pending_continue_chat", (res) => {
  if (res.pending_continue_chat) {
    console.log("Pending Continue Chat found! Injecting history...");
    injectHistoryPrompt(res.pending_continue_chat);
  }
});

// Helper: Sets value in contenteditable input and triggers events
function setInputValue(element, value) {
  element.focus();
  try {
    // Select all text in the element
    document.execCommand('selectAll', false, null);
    // Replace with new text
    document.execCommand('insertText', false, value);
    return true;
  } catch (e) {
    console.error('execCommand insertText failed:', e);
  }
  
  // Fallback direct update
  if (element.tagName === 'TEXTAREA' || element.tagName === 'INPUT') {
    element.value = value;
  } else {
    element.innerText = value;
  }
  
  // Dispatch events to update framework internal state
  const inputEvent = new Event('input', { bubbles: true, cancelable: true });
  element.dispatchEvent(inputEvent);
  const changeEvent = new Event('change', { bubbles: true, cancelable: true });
  element.dispatchEvent(changeEvent);
  
  return true;
}

// Inject prompt history into prompt area
function injectHistoryPrompt(historyText) {
  let attempts = 0;
  const maxAttempts = 30; // 15 seconds
  
  const timer = setInterval(() => {
    attempts++;
    // Look for prompt input box
    let input = document.querySelector('[role="textbox"]') || 
                document.querySelector('div[contenteditable="true"]') || 
                document.querySelector('textarea') ||
                document.querySelector('#prompt-textarea') || 
                document.querySelector('.prompt-textarea');
                
    if (input) {
      clearInterval(timer);
      console.log("Prompt input box found. Injecting content...");
      
      const promptValue = `[System Instruction: The user wants to continue their previous conversation. Below is the historical transcript of the chat. Please read it carefully and continue the conversation starting from the last user message. Do not repeat the history in your response, just continue the chat naturally.]\n\n--- HISTORICAL CONVERSATION START ---\n${historyText}\n--- HISTORICAL CONVERSATION END ---\n\nUser: `;
      
      setInputValue(input, promptValue);
      
      // Clear pending storage payload
      chrome.storage.local.remove("pending_continue_chat");
      
      // Inject a beautiful overlay notification in the web interface
      showInjectionNotification();
    } else if (attempts >= maxAttempts) {
      clearInterval(timer);
      console.warn("Failed to find Gemini prompt input area after 15 seconds.");
    }
  }, 500);
}

// Injects a premium notification banner in the Gemini UI
function showInjectionNotification() {
  const banner = document.createElement("div");
  banner.id = "gcs-injection-banner";
  banner.innerHTML = `
    <div class="gcs-banner-content">
      <span class="gcs-banner-icon">🔁</span>
      <span class="gcs-banner-text">Previous conversation history loaded! Write your message below and send.</span>
      <button class="gcs-banner-close">&times;</button>
    </div>
  `;
  
  // Style the banner
  const style = document.createElement("style");
  style.id = "gcs-banner-styles";
  style.textContent = `
    #gcs-injection-banner {
      position: fixed;
      top: 20px;
      left: 50%;
      transform: translateX(-50%);
      background: rgba(30, 31, 32, 0.95);
      backdrop-filter: blur(10px);
      border: 1px solid rgba(66, 133, 244, 0.4);
      color: #e3e3e3;
      padding: 12px 24px;
      border-radius: 12px;
      z-index: 99999;
      box-shadow: 0 10px 30px rgba(0,0,0,0.5);
      font-family: 'Outfit', 'Inter', sans-serif;
      animation: gcs-slide-down 0.4s cubic-bezier(0.16, 1, 0.3, 1);
    }
    .gcs-banner-content {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .gcs-banner-icon {
      font-size: 18px;
    }
    .gcs-banner-text {
      font-size: 14px;
      font-weight: 500;
    }
    .gcs-banner-close {
      background: none;
      border: none;
      color: #999;
      font-size: 20px;
      cursor: pointer;
      padding: 0;
      margin-left: 10px;
      transition: color 0.2s;
    }
    .gcs-banner-close:hover {
      color: #fff;
    }
    @keyframes gcs-slide-down {
      from { top: -60px; opacity: 0; }
      to { top: 20px; opacity: 1; }
    }
  `;
  
  document.head.appendChild(style);
  document.body.appendChild(banner);
  
  banner.querySelector(".gcs-banner-close").addEventListener("click", () => {
    banner.remove();
  });
  
  // Auto-remove after 8 seconds
  setTimeout(() => {
    if (banner.parentNode) {
      banner.style.opacity = "0";
      banner.style.transition = "opacity 0.5s ease";
      setTimeout(() => banner.remove(), 500);
    }
  }, 8000);
}

// Retrieve Gemini's current Chat ID from the URL
function getChatIdFromUrl() {
  const path = window.location.pathname;
  // Match "/app/chat/<id>" first, then fall back to "/app/<id>"
  const match = path.match(/\/app\/chat\/([a-zA-Z0-9_-]+)/) || path.match(/\/app\/([a-zA-Z0-9_-]+)/);
  if (match && match[1] && match[1] !== "chat") {
    return match[1];
  }
  return null;
}

// Start observing changes on the DOM to capture chat log
function startObserver() {
  if (activeObserver) return;
  
  console.log("Starting DOM MutationObserver...");
  activeObserver = new MutationObserver(() => {
    // Debounce the scraper by 1.5 seconds to run efficiently
    clearTimeout(scrapeTimeout);
    scrapeTimeout = setTimeout(scrapeAndSaveChat, 1500);
  });
  
  activeObserver.observe(document.body, {
    childList: true,
    subtree: true
  });
}

// Main logic: extracts conversations, sends data to background script
async function scrapeAndSaveChat() {
  const urlId = getChatIdFromUrl();
  
  // 1. Scrape chat elements
  const userElems = Array.from(document.querySelectorAll('query-text, .query-text, user-query .query-text'));
  const modelElems = Array.from(document.querySelectorAll('message-content, .message-content, .model-response, model-response message-content'));
  
  // 2. Identify active session ID
  let activeId = urlId;
  if (!activeId) {
    if (userElems.length === 0 && modelElems.length === 0) {
      // Empty/new tab, reset session tracking and do nothing
      currentSessionId = null;
      return;
    }
    
    // We have messages but no URL ID yet (temporary state before Google saves the chat)
    if (!currentSessionId || !currentSessionId.startsWith("temp_")) {
      currentSessionId = "temp_" + Date.now();
    }
    activeId = currentSessionId;
  } else {
    // If we have an official URL ID, sync currentSessionId immediately if it changed (and doesn't start with temp_)
    if (currentSessionId !== urlId) {
      if (!currentSessionId || !currentSessionId.startsWith("temp_")) {
        currentSessionId = urlId;
      }
    }
  }
  
  if (userElems.length === 0 && modelElems.length === 0) {
    return; // No conversation items found
  }
  
  // Assemble messages with DOM positional comparison
  const rawMessages = [];
  
  userElems.forEach(el => {
    rawMessages.push({
      role: 'user',
      text: el.innerText.trim(),
      images: extractTurnImages(el),
      element: el
    });
  });
  
  modelElems.forEach(el => {
    rawMessages.push({
      role: 'model',
      text: el.innerText.trim(),
      images: extractTurnImages(el),
      element: el
    });
  });
  
  // Sort elements in true document order
  rawMessages.sort((a, b) => {
    const position = a.element.compareDocumentPosition(b.element);
    if (position & Node.DOCUMENT_POSITION_FOLLOWING) {
      return -1;
    } else if (position & Node.DOCUMENT_POSITION_PRECEDING) {
      return 1;
    }
    return 0;
  });
  
  // Create sanitized array without element references
  const messages = rawMessages.map(m => ({
    role: m.role,
    text: m.text,
    images: m.images,
    timestamp: Date.now()
  }));
  
  // 3. Extract chat title
  let title = document.title.replace(" - Gemini", "").replace("Gemini - ", "").trim();
  if (title === "Gemini" || title === "New chat" || title === "") {
    // Fetch a snippet of the first user prompt as a title fallback
    const firstUserMsg = messages.find(m => m.role === 'user');
    if (firstUserMsg && firstUserMsg.text) {
      title = firstUserMsg.text.substring(0, 40) + (firstUserMsg.text.length > 40 ? "..." : "");
    } else {
      title = "Untitled Chat";
    }
  }
  
  // 4. Send save message to background script
  const chatRecord = {
    title: title,
    messages: messages
  };
  
  chrome.runtime.sendMessage({
    action: "save_chat",
    chat: chatRecord,
    urlId: urlId,
    currentSessionId: currentSessionId
  }, (response) => {
    if (chrome.runtime.lastError) {
      console.error("Failed to send save_chat message:", chrome.runtime.lastError);
      return;
    }
    if (response && response.status === "success") {
      if (response.currentSessionId) {
        currentSessionId = response.currentSessionId;
      }
    } else if (response && response.status === "error") {
      console.error("Background failed to save chat:", response.error);
    }
  });
}

// Extracts image sources within a message container
function extractTurnImages(element) {
  // Find container parent first to make sure we don't miss inline attachments in user prompt box
  const parent = element.parentElement || element;
  const imgs = Array.from(parent.querySelectorAll('img'));
  const urls = [];
  
  imgs.forEach(img => {
    const src = img.src;
    if (!src) return;
    
    // Filter out UI elements (avatars, icons, buttons)
    if (img.width < 32 || img.height < 32) return;
    if (src.includes('avatar') || src.includes('profile') || src.includes('lh3.googleusercontent.com/a/')) return;
    
    urls.push(src);
  });
  
  return urls;
}

// Initialize Observer on window load
if (document.readyState === "complete" || document.readyState === "interactive") {
  startObserver();
} else {
  window.addEventListener("DOMContentLoaded", startObserver);
}

// Keep tracking active tab URL changes (for Single Page App navigation)
let lastUrl = location.href;
new MutationObserver(() => {
  const currentUrl = location.href;
  if (currentUrl !== lastUrl) {
    lastUrl = currentUrl;
    console.log("SPA URL Change detected! Resetting session tracking.");
    // Reset session tracking if we navigated back to new chat
    const urlId = getChatIdFromUrl();
    if (!urlId) {
      currentSessionId = null;
    }
    // Promptly run scraper to capture new screen state
    clearTimeout(scrapeTimeout);
    scrapeTimeout = setTimeout(scrapeAndSaveChat, 1000);
  }
}).observe(document, { subtree: true, childList: true });
