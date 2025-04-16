// In-memory store for game files { path: Blob }
let gameFiles = {};
// Store the specific hostname (e.g., 1a2b3c.poki-gdn.com) for the current game
let currentGameHost = null;
// Store the initial path segment (e.g., /b8a82132-1aed-4a50-a46c-152cc13dddac/)
let currentGameBasePathSegment = null;
// Store the full URL of the index.html for potential later use
let indexHtmlUrl = null;
// Map to track download IDs and their corresponding Object URLs for cleanup
const activeDownloads = new Map();

// --- Web Request Header Listener ---

browser.webRequest.onBeforeSendHeaders.addListener(
  handleHeaders,
  {
    urls: ["*://*.poki-gdn.com/*"], // Filter for the game CDN
    types: ["main_frame", "sub_frame", "script", "stylesheet", "image", "font", "xmlhttprequest", "other"]
  },
  ["blocking", "requestHeaders"] // Need blocking and requestHeaders to modify headers
);

async function handleHeaders(details) {
  const requestUrl = new URL(details.url);
  const requestHostname = requestUrl.hostname;
  const requestPathname = requestUrl.pathname;
  let refererSet = false;

  // --- 1. Handle index.html request ---
  if (requestPathname.endsWith('index.html')) {
    // If this is the first index.html we see for this page load, capture its host
    if (!currentGameHost) {
      currentGameHost = requestHostname;
      indexHtmlUrl = details.url; // Store the full URL
      // Extract the first path segment (including leading/trailing slashes if present)
      const pathSegments = requestPathname.split('/').filter(Boolean);
      if (pathSegments.length > 1) { // Ensure there's a segment before index.html
          currentGameBasePathSegment = `/${pathSegments[0]}/`;
          console.log(`Game host identified: ${currentGameHost}, Base path segment: ${currentGameBasePathSegment}`);
      } else {
          console.warn(`Could not determine base path segment from: ${requestPathname}`);
          currentGameBasePathSegment = '/'; // Fallback
      }

      // Set Referer specifically for the initial index.html request
      for (let header of details.requestHeaders) {
        if (header.name.toLowerCase() === 'referer') {
          header.value = 'https://games.poki.com/';
          refererSet = true;
          break;
        }
      }
      if (!refererSet) {
        details.requestHeaders.push({ name: 'Referer', value: 'https://games.poki.com/' });
      }
      console.log(`Set Referer for ${requestPathname} to https://games.poki.com/`);

      // Fetch and store index.html
      fetchAndStoreAsset(details.url, 'index.html'); // Use fixed path 'index.html'

    } else if (requestHostname === currentGameHost) {
      // It's another index.html request for the *same* game host
      setReferer(details.requestHeaders, `https://${currentGameHost}/`);
      fetchAndStoreAsset(details.url, 'index.html');
    }
  }
  // --- 2. Handle other asset requests ---
  else if (currentGameHost && requestHostname === currentGameHost) {
    // Only capture assets if they belong to the identified game host
    setReferer(details.requestHeaders, `https://${currentGameHost}/`);

    // Calculate relative path, removing the base path segment if applicable
    let relativePath = requestPathname.substring(1); // Default
    if (currentGameBasePathSegment && requestPathname.startsWith(currentGameBasePathSegment)) {
        relativePath = requestPathname.substring(currentGameBasePathSegment.length);
    } else {
        console.warn(`Asset path ${requestPathname} does not start with expected base segment ${currentGameBasePathSegment}. Using full path.`);
    }

    if (relativePath) {
      fetchAndStoreAsset(details.url, relativePath);
    } else {
      console.warn(`Could not determine relative path for asset: ${details.url}`);
    }
  }

  return { requestHeaders: details.requestHeaders };
}

// --- Helper to Set Referer ---
function setReferer(headers, refererValue) {
    let refererSet = false;
    for (let header of headers) {
        if (header.name.toLowerCase() === 'referer') {
        header.value = refererValue;
        refererSet = true;
        break;
        }
    }
    if (!refererSet) {
        headers.push({ name: 'Referer', value: refererValue });
    }
}

// --- Helper to Fetch and Store Assets ---
async function fetchAndStoreAsset(url, storagePath) {
  if (!gameFiles[storagePath]) {
    console.log(`Fetching and storing: ${storagePath} from ${url}`);
    try {
      const response = await fetch(url);
      if (response.ok) {
        if (!gameFiles[storagePath]) {
          const blob = await response.blob();
          gameFiles[storagePath] = blob;
          console.log(`Stored: ${storagePath} (${(blob.size / 1024).toFixed(2)} KB)`);
          updateBadge();
        }
      } else {
        console.warn(`Failed to fetch ${url} (for path ${storagePath}): ${response.status} ${response.statusText}`);
      }
    } catch (error) {
      console.error(`Error fetching ${url} (for path ${storagePath}):`, error);
    }
  }
}

// --- Message Listener for Popup ---
browser.runtime.onMessage.addListener(async (message, sender, sendResponse) => { // Make listener async
  // Removed initial log

  if (message.action === "createZip") {
    console.log("Action is 'createZip'."); // Simplified log
    const fileCount = Object.keys(gameFiles).length;
    console.log("Files captured:", fileCount);
    if (fileCount === 0) {
      console.warn("No files captured to zip.");
      sendResponse({ status: "error", message: "No files captured." });
      return true;
    }

    // --- Get active tab URL and extract game name ---
    let pokiGameName = 'poki_game'; // Default
    try {
        const tabs = await browser.tabs.query({ active: true, currentWindow: true });
        if (tabs.length > 0 && tabs[0].url) {
            const activeTabUrl = tabs[0].url;
            console.log("Active tab URL:", activeTabUrl);
            const url = new URL(activeTabUrl);
            if (url.hostname.endsWith('poki.com')) {
                const pathParts = url.pathname.split('/');
                const gameIdIndex = pathParts.indexOf('g');
                if (gameIdIndex !== -1 && gameIdIndex < pathParts.length - 1) {
                    pokiGameName = pathParts[gameIdIndex + 1];
                    pokiGameName = pokiGameName.replace(/[^a-zA-Z0-9_-]/g, '_'); // Sanitize
                    console.log("Extracted game name from active tab:", pokiGameName);
                } else {
                     console.log("Could not find 'g' segment in active tab path:", url.pathname);
                }
            } else {
                 console.log("Active tab hostname does not end with poki.com:", url.hostname);
            }
        } else {
            console.warn("Could not get active tab or its URL.");
        }
    } catch (e) {
        console.error("Error getting active tab or parsing its URL:", e);
    }
    // --- End extraction ---

    // Now call generateAndDownloadZip with the potentially updated name
    generateAndDownloadZip(pokiGameName)
      .then(() => {
        sendResponse({ status: "success" });
      })
      .catch(error => {
        console.error("Error generating zip:", error);
        sendResponse({ status: "error", message: error.message });
      });

    return true;
  }
});

// --- Zip Generation and Download ---
// (Now accepts pokiGameName as an argument)
async function generateAndDownloadZip(pokiGameName = 'poki_game') { // Use passed name or default
  const zip = new JSZip();
  let fileCount = 0;

  for (const path in gameFiles) {
    if (gameFiles.hasOwnProperty(path)) {
      zip.file(path, gameFiles[path]);
      fileCount++;
    }
  }

  if (fileCount === 0) {
      throw new Error("No files to add to zip.");
  }

  console.log(`Generating zip with ${fileCount} files...`);
  const zipBlob = await zip.generateAsync({ type: "blob" });
  console.log(`Zip generated: ${(zipBlob.size / 1024).toFixed(2)} KB`);

  const objectUrl = URL.createObjectURL(zipBlob); // Renamed to objectUrl for clarity
  // Use the extracted pokiGameName directly for the filename, adding .zip
  const filename = `${pokiGameName}.zip`;
  console.log(`Using filename: ${filename}`);

  try {
    const downloadId = await browser.downloads.download({
        url: objectUrl,
        filename: filename, // Use the extracted game name
        conflictAction: "uniquify",
        saveAs: false
    });

    console.log(`Zip download started with ID: ${downloadId}. URL: ${objectUrl}`);
    // Store the URL to revoke later, keyed by download ID
    activeDownloads.set(downloadId, objectUrl);

    // Clear state *after* download starts successfully
    gameFiles = {};
    currentGameHost = null;
    currentGameBasePathSegment = null;
    indexHtmlUrl = null;
    updateBadge();

  } catch (error) {
    console.error("Zip download failed to start:", error);
    URL.revokeObjectURL(objectUrl); // Revoke immediately if download fails to start
  }
}

// --- Download Change Listener ---
browser.downloads.onChanged.addListener(handleDownloadChange);

function handleDownloadChange(delta) {
  // Check if the download ID is one we are tracking
  if (activeDownloads.has(delta.id)) {
    // Check if the download has completed or failed
    if (delta.state && (delta.state.current === 'complete' || delta.state.current === 'interrupted')) {
      const objectUrl = activeDownloads.get(delta.id);
      console.log(`Download ${delta.id} finished with state: ${delta.state.current}. Revoking URL: ${objectUrl}`);
      URL.revokeObjectURL(objectUrl);
      // Remove from tracking
      activeDownloads.delete(delta.id);

      if (delta.state.current === 'interrupted') {
          console.error(`Download ${delta.id} failed or was interrupted. Error: ${delta.error?.current || 'Unknown'}`);
      }
    }
  }
}


// --- Badge Update ---
function updateBadge() {
    const count = Object.keys(gameFiles).length;
    browser.browserAction.setBadgeText({ text: count > 0 ? String(count) : "" });
    browser.browserAction.setBadgeBackgroundColor({ color: "#007bff" });
}

// --- Tab Update Listener ---
browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (tab.url && tab.url.includes("poki.com/") && (changeInfo.status === 'loading' || changeInfo.status === 'complete')) {
        if (changeInfo.url || changeInfo.status === 'loading') {
             browser.tabs.query({ active: true, currentWindow: true }).then(activeTabs => {
                 if (activeTabs.length > 0 && activeTabs[0].id === tabId) {
                    if (currentGameHost || Object.keys(gameFiles).length > 0) {
                        console.log("Navigating on Poki page, clearing captured files and host state for tab:", tabId);
                        gameFiles = {};
                        currentGameHost = null;
                        currentGameBasePathSegment = null;
                        indexHtmlUrl = null;
                        updateBadge();
                        // Also clear any pending download URL revocations for safety? Maybe not needed.
                    }
                 }
             });
        }
    }
});

console.log("Poki Downloader background script (v4 - Download Cleanup) loaded.");
updateBadge();
