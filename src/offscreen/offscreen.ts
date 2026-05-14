// Offscreen document entrypoint.
//
// Reserved for hosting a long-lived Overleaf real-time connection if the
// experimental live-sync mode is enabled and the service worker / popup
// context cannot keep a WebSocket open. The current build does not use it
// (live sync surfaces `protocol_unavailable` until a safe Engine.IO client
// lands), but the file ships so future revisions can wire up an offscreen
// keepalive without modifying the manifest pipeline.
//
// IMPORTANT:
//   - This script must NEVER read document.cookie.
//   - This script must NEVER request chrome.cookies.
//   - The browser session is reused implicitly via credentials: 'include'.

type OffscreenMessage = { type: 'PING' } | { type: 'CLOSE' };

chrome.runtime.onMessage.addListener(
  (message: OffscreenMessage, _sender, sendResponse) => {
    switch (message?.type) {
      case 'PING':
        sendResponse({ ok: true });
        return false;
      case 'CLOSE':
        // No active sockets yet; just acknowledge.
        sendResponse({ ok: true });
        return false;
      default:
        return false;
    }
  },
);
