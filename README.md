# Gemini Chat Saver & Sync

A Chrome extension and dashboard that saves and indexes your Google Gemini conversations locally and syncs them to your Google Drive.

## Why this exists

If you turn off "Gemini Apps Activity" in Google My Activity to prevent Google from training models on your chats, Google deletes your conversation history. Once deleted, you can no longer search or review your past conversations on the Gemini website.

This extension solves this problem by keeping a local copy of your history in your browser database. You can keep your activity turned off in Google My Activity while retaining a private, searchable history of your chats.

Your data is stored locally in your browser and syncs directly to your Google Drive folder. No third-party servers or external databases are used.

## Features

- Local saving: The extension reads the Gemini page as you chat and saves the text to an IndexedDB database using Dexie.js.
- Image attachments: It downloads images from the chat, converts them to base64, and saves them in the database for offline viewing.
- Background sync: A Chrome alarm triggers a silent background sync to Google Drive one minute after you update a chat.
- Folder organization: Backups are stored in a dedicated folder named "Gemini Chat Backups" in your Google Drive.
- Token caching: The extension caches your Google authorization token and silently renews it when it expires, avoiding repetitive account-selection popups.
- Dashboard interface: A dark midnight-blue dashboard displays your saved chats.
- Search snippets: Searching on the dashboard displays the exact sentence containing your search terms with highlights.
- Resume chats: Click a button to copy the formatted chat history directly back into the Gemini prompt box so you can continue the thread.
- Local backups: Export or import your database as a JSON file at any time.

## Tech stack

- HTML5, CSS, and ES6 JavaScript
- Dexie.js for IndexedDB database operations
- Marked.js for rendering markdown output
- DOMPurify for HTML sanitization
- Chrome Manifest V3 Alarms and Identity APIs

## Installation

Since this is an unpacked extension, you can load it directly into Google Chrome:

1. Download the latest `gemini-chat-saver.zip` from the Releases section of this repository and extract it (or clone this repository).
2. Open Chrome and navigate to `chrome://extensions/`.
3. Turn on developer mode using the switch in the top-right corner.
4. Click the "Load unpacked" button in the top-left corner.
5. Select the extracted folder containing the `manifest.json` file.

## Google Cloud Console setup

To use the Google Drive sync, you need to create a Client ID in the Google Cloud Console:

### Step 1: Create a project
1. Go to the [Google Cloud Console Credentials Page](https://console.cloud.google.com/apis/credentials).
2. Click the project dropdown at the top, select **New Project**, name it "Gemini Archive", and click **Create**.
3. Select your new project from the list.

### Step 2: Configure the OAuth consent screen
1. Click **OAuth consent screen** in the left sidebar.
2. Choose **External** and click **Create**.
3. Fill in the required fields:
   - **App name**: "Gemini Archive"
   - **User support email**: Choose your email address
   - **Developer contact info**: Enter your email address
4. Click **Save and Continue** (you do not need to add any scopes).
5. On the **Test Users** page, click **+ ADD USERS**, enter the Gmail address you plan to back up to, click **Save**, and click **Save and Continue**.
6. Click **Back to Dashboard**.

### Step 3: Create a Client ID
1. Click **Credentials** in the left sidebar.
2. Click **+ Create Credentials** at the top and select **OAuth client ID**.
3. Set **Application type** to **Web application**.
4. Scroll to **Authorized redirect URIs**, click **+ ADD URI**, and paste your extension's Redirect URI. You can find this URI by opening the settings panel on your extension's dashboard.
5. Click **Create**.
6. Copy the **Client ID** from the confirmation dialog.

### Step 4: Add to the dashboard
1. Open the extension dashboard page.
2. Click the settings icon in the bottom-left corner of the sidebar.
3. Paste the Client ID into the input field and click **Save Client ID**.
4. Check **Enable Background Auto-Backup** and click **Sync with Google Drive** to authorize the first backup.
