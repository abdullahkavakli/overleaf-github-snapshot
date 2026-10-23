// Background service worker for "Overleaf GitHub Snapshot".
//
// The popup and options pages make GitHub API calls directly from their
// privileged extension contexts, and reach Overleaf by messaging the
// content script on the Overleaf tab. The service worker only:
//   1. Opens the options page on first install.
//   2. Answers the OPEN_OPTIONS and PING runtime messages.

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    chrome.runtime.openOptionsPage().catch(() => {
      // Options page may not be ready yet; ignore silently.
    });
  }
});

type IncomingMessage =
  | { type: 'OPEN_OPTIONS' }
  | { type: 'PING' };

chrome.runtime.onMessage.addListener((message: IncomingMessage, _sender, sendResponse) => {
  switch (message?.type) {
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
