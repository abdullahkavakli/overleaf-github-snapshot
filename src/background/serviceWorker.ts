// Background service worker for "Overleaf Snapshot to GitHub".
//
// The popup and options pages make GitHub API calls directly from their
// privileged extension contexts. The service worker exists for:
//   1. Lifecycle events (install/update).
//   2. Routing messages from the content script (which must never see the
//      GitHub token, ZIP contents, or repo configuration).

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    chrome.runtime.openOptionsPage().catch(() => {
      // Options page may not be ready yet; ignore silently.
    });
  }
});

type IncomingMessage =
  | { type: 'OVERLEAF_BUTTON_CLICKED'; projectId?: string }
  | { type: 'OPEN_OPTIONS' }
  | { type: 'PING' };

chrome.runtime.onMessage.addListener((message: IncomingMessage, _sender, sendResponse) => {
  switch (message?.type) {
    case 'OVERLEAF_BUTTON_CLICKED': {
      // Content scripts cannot programmatically open the action popup in MV3.
      // We acknowledge the click; the content script renders an instruction tooltip
      // telling the user to click the extension icon themselves.
      sendResponse({ ok: true });
      return false;
    }
    case 'OPEN_OPTIONS': {
      chrome.runtime.openOptionsPage().then(
        () => sendResponse({ ok: true }),
        (err) => sendResponse({ ok: false, error: String(err?.message ?? err) }),
      );
      return true;
    }
    case 'PING': {
      sendResponse({ ok: true });
      return false;
    }
    default:
      return false;
  }
});
