// Content script for Overleaf project pages.
//
// It adds nothing to the page. It only answers LIVE_* messages sent by the
// popup and the options page with chrome.tabs.sendMessage. Those pages run
// on the chrome-extension:// origin, which Overleaf's realtime server
// rejects, so the socket and the REST calls have to run here, on the
// project page's origin (see liveBridgeHandler.ts, loaded on demand).
//
// What this script must NEVER do:
//   - Read the GitHub token (it is not provided to content scripts).
//   - Read document.cookie. Overleaf requests use credentials: 'include'.
//   - Change Overleaf's DOM.

import {
  BRIDGE_FEATURE_MIRROR,
  BRIDGE_FEATURE_SESSIONS,
  type BridgeFailure,
  type LivePingResponseData,
} from '../overleaf/live/bridgeProtocol';

// Response for an exception no handler turned into a typed failure.
function unexpectedFailure(e: unknown): BridgeFailure {
  return {
    ok: false,
    code: 'unknown',
    message: `Something unexpected went wrong on the Overleaf tab. Details: ${
      e instanceof Error ? e.message : String(e)
    }`,
    recovery: 'Reload the Overleaf tab, then try again.',
  };
}

function projectIdFromUrl(): string | null {
  const m = location.pathname.match(/\/project\/([a-zA-Z0-9]+)/);
  return m ? m[1] : null;
}

// Guard against double-initialization. MV3 isolated worlds persist
// across chrome.scripting.executeScript calls, so re-running the loader
// would otherwise register the bridge listener twice — every incoming
// message would then be handled twice, causing duplicate LIVE_WRITE_DOC
// applyOtUpdate sends and (worse) duplicate LIVE_CREATE_DOC_AT_PATH
// folder/doc creations in Overleaf. First injection wins.
const __w = window as Window & { __overleafGithubSnapshotBridgeLoaded?: boolean };
if (!__w.__overleafGithubSnapshotBridgeLoaded) {
  __w.__overleafGithubSnapshotBridgeLoaded = true;

type AnyBridgeMessage = {
  type?: string;
  version?: number;
  projectId?: string;
  docId?: string;
  ops?: unknown;
  baseVersion?: unknown;
  path?: unknown;
  initialContent?: unknown;
  contentBase64?: unknown;
};

chrome.runtime.onMessage.addListener(
  (message: AnyBridgeMessage, _sender, sendResponse) => {
    if (!message || typeof message !== 'object') return false;
    if (message.type === 'LIVE_PING') {
      const data: LivePingResponseData = {
        onProjectPage: !!projectIdFromUrl(),
        features: [BRIDGE_FEATURE_SESSIONS, BRIDGE_FEATURE_MIRROR],
      };
      sendResponse({ ok: true, data });
      return false;
    }
    if (typeof message.type === 'string' && message.type.startsWith('LIVE_SESSION_')) {
      // Project-session messages (see liveBridgeHandler.ts). The handler
      // validates every field itself.
      void (async () => {
        try {
          const mod = await import('./liveBridgeHandler');
          sendResponse(await mod.handleLiveSessionMessage(message));
        } catch (e) {
          sendResponse(unexpectedFailure(e));
        }
      })();
      return true;
    }
    if (message.type === 'LIVE_FETCH_SNAPSHOT') {
      const projectId = typeof message.projectId === 'string' ? message.projectId : '';
      if (!projectId) {
        sendResponse({ ok: false, code: 'unknown', message: 'projectId missing in request' });
        return false;
      }
      // Defer the heavy work to a dynamic import so the rest of the
      // content script stays lightweight on every page-load.
      void (async () => {
        try {
          const mod = await import('./liveBridgeHandler');
          const result = await mod.handleLiveFetchSnapshot(projectId);
          sendResponse(result);
        } catch (e) {
          sendResponse(unexpectedFailure(e));
        }
      })();
      return true; // async response
    }
    if (message.type === 'LIVE_FETCH_PROJECT_METADATA') {
      const projectId = typeof message.projectId === 'string' ? message.projectId : '';
      if (!projectId) {
        sendResponse({ ok: false, code: 'unknown', message: 'projectId missing in request' });
        return false;
      }
      void (async () => {
        try {
          const mod = await import('./liveBridgeHandler');
          const result = await mod.handleLiveFetchProjectMetadata(projectId);
          sendResponse(result);
        } catch (e) {
          sendResponse(unexpectedFailure(e));
        }
      })();
      return true;
    }
    if (message.type === 'LIVE_READ_DOC') {
      const projectId = typeof message.projectId === 'string' ? message.projectId : '';
      const docId = typeof message.docId === 'string' ? message.docId : '';
      if (!projectId || !docId) {
        sendResponse({
          ok: false,
          code: 'unknown',
          message: 'projectId and docId are required',
        });
        return false;
      }
      void (async () => {
        try {
          const mod = await import('./liveBridgeHandler');
          const result = await mod.handleLiveReadDoc(projectId, docId);
          sendResponse(result);
        } catch (e) {
          sendResponse(unexpectedFailure(e));
        }
      })();
      return true;
    }
    if (message.type === 'LIVE_UPLOAD_BINARY') {
      const projectId = typeof message.projectId === 'string' ? message.projectId : null;
      const path = typeof message.path === 'string' ? message.path : null;
      const contentBase64 =
        typeof message.contentBase64 === 'string' ? message.contentBase64 : null;
      // Diagnostic: report exactly what's missing or non-string so callers
      // can debug serialization issues. Empty-string contentBase64 is
      // allowed (0-byte file uploads are legitimate; let Overleaf decide).
      if (projectId === null || path === null || contentBase64 === null) {
        const problems: string[] = [];
        if (projectId === null) problems.push('projectId (missing or non-string)');
        if (path === null) problems.push('path (missing or non-string)');
        if (contentBase64 === null) problems.push('contentBase64 (missing or non-string)');
        sendResponse({
          ok: false,
          code: 'unknown',
          message: `LIVE_UPLOAD_BINARY rejected — ${problems.join(', ')}`,
        });
        return false;
      }
      if (!projectId || !path) {
        sendResponse({
          ok: false,
          code: 'unknown',
          message: `LIVE_UPLOAD_BINARY rejected — projectId or path is an empty string`,
        });
        return false;
      }
      void (async () => {
        try {
          const mod = await import('./liveBridgeHandler');
          const result = await mod.handleLiveUploadBinary(projectId, path, contentBase64);
          sendResponse(result);
        } catch (e) {
          sendResponse(unexpectedFailure(e));
        }
      })();
      return true;
    }
    if (message.type === 'LIVE_CREATE_DOC_AT_PATH') {
      const projectId = typeof message.projectId === 'string' ? message.projectId : '';
      const path = typeof message.path === 'string' ? message.path : '';
      const initialContent =
        typeof message.initialContent === 'string' ? message.initialContent : '';
      if (!projectId || !path) {
        sendResponse({
          ok: false,
          code: 'unknown',
          message: 'projectId and path are required',
        });
        return false;
      }
      void (async () => {
        try {
          const mod = await import('./liveBridgeHandler');
          const result = await mod.handleLiveCreateDocAtPath(projectId, path, initialContent);
          sendResponse(result);
        } catch (e) {
          sendResponse(unexpectedFailure(e));
        }
      })();
      return true;
    }
    if (message.type === 'LIVE_WRITE_DOC') {
      const projectId = typeof message.projectId === 'string' ? message.projectId : '';
      const docId = typeof message.docId === 'string' ? message.docId : '';
      const baseVersion =
        typeof message.baseVersion === 'number' ? message.baseVersion : NaN;
      const ops = Array.isArray(message.ops) ? message.ops : null;
      if (!projectId || !docId || ops === null || !Number.isFinite(baseVersion)) {
        sendResponse({
          ok: false,
          code: 'unknown',
          message: 'projectId, docId, ops[], and baseVersion are required',
        });
        return false;
      }
      void (async () => {
        try {
          const mod = await import('./liveBridgeHandler');
          // ops is shaped by the popup-side OtOp builder; the handler is
          // currently a stub but the dispatcher still hands it through
          // verbatim so the wire format is exercised end-to-end.
          const result = await mod.handleLiveWriteDoc(
            projectId,
            docId,
            ops as Parameters<typeof mod.handleLiveWriteDoc>[2],
            baseVersion,
          );
          sendResponse(result);
        } catch (e) {
          sendResponse(unexpectedFailure(e));
        }
      })();
      return true;
    }
    return false;
  },
);

} // end of double-init guard
