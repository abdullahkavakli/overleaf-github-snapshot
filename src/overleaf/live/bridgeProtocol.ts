// Message protocol between the popup (extension context) and the content
// script running on overleaf.com. The content script holds the WebSocket
// because:
//
//   * MV3 extension WebSockets are sent with Origin: chrome-extension://...,
//     which Overleaf rejects.
//   * Content scripts run in the page origin and inherit cookies + CSRF
//     access via the page DOM.
//
// All messages are JSON-serialisable. Binary file content travels as a
// base64 string to survive structured-clone over chrome.runtime messaging.

import type { ProjectFile } from '../../shared/types';
import type { LiveProjectFolder, LiveSyncErrorCode } from './types';
import type { OtOp } from './overleafOt';

// Re-export so the content script can use the shared OT type without
// reaching into the popup-only overleafOt module path.
export type { OtOp };

export const BRIDGE_VERSION = 1 as const;

// Feature flag a content script advertises in its LIVE_PING reply when it
// understands the LIVE_SESSION_* messages below. A tab opened before an
// extension update keeps running the old content script (the double-init
// guard turns re-injection into a no-op), so callers check this flag
// before relying on sessions.
export const BRIDGE_FEATURE_SESSIONS = 'project-session-v1';

// Advertised by a content script that also understands the messages of
// "Make Overleaf match GitHub exactly" (LIVE_SESSION_HASH_FILES,
// LIVE_SESSION_REPLACE_FILE, LIVE_SESSION_DELETE_ENTITY). A tab with a
// content script from an earlier version keeps it until it is reloaded, so
// that pull option checks this flag before it plans anything.
export const BRIDGE_FEATURE_MIRROR = 'mirror-v1';

export type BridgeRequest =
  | {
      type: 'LIVE_PING';
      version: typeof BRIDGE_VERSION;
    }
  | {
      type: 'LIVE_FETCH_SNAPSHOT';
      version: typeof BRIDGE_VERSION;
      projectId: string;
    }
  | {
      type: 'LIVE_FETCH_PROJECT_METADATA';
      version: typeof BRIDGE_VERSION;
      projectId: string;
    }
  | {
      type: 'LIVE_READ_DOC';
      version: typeof BRIDGE_VERSION;
      projectId: string;
      docId: string;
    }
  | {
      type: 'LIVE_WRITE_DOC';
      version: typeof BRIDGE_VERSION;
      projectId: string;
      docId: string;
      ops: OtOp[];
      baseVersion: number;
    }
  | {
      type: 'LIVE_CREATE_DOC_AT_PATH';
      version: typeof BRIDGE_VERSION;
      projectId: string;
      // Project-relative path, e.g. "appendix.md" or "chapters/intro.tex".
      // Folders along the path are created on demand. Refused if the doc
      // already exists at this path (use LIVE_WRITE_DOC instead).
      path: string;
      // Initial content for the new doc. Empty string is allowed and
      // skips the OT-seed step entirely.
      initialContent: string;
    }
  | {
      type: 'LIVE_UPLOAD_BINARY';
      version: typeof BRIDGE_VERSION;
      projectId: string;
      // Project-relative path. Folders along the path are mkdir-ed on
      // demand. First cut refuses to replace an existing fileRef at the
      // same path — a future slice can add explicit replace semantics.
      path: string;
      // Binary content, base64-encoded (chrome.tabs.sendMessage's
      // structured-clone treats Uint8Array inconsistently across MV3
      // builds; base64 over the wire is what the read snapshot already
      // uses).
      contentBase64: string;
    }
  // Project sessions: one socket + one joinProject in the content script,
  // shared by every operation of a pull. LIVE_SESSION_OPEN returns the
  // session ID and the project tree; the other messages name the session.
  // Each operation keeps the safety steps of its one-shot counterpart above.
  | {
      type: 'LIVE_SESSION_OPEN';
      version: typeof BRIDGE_VERSION;
      projectId: string;
    }
  | {
      type: 'LIVE_SESSION_READ_DOCS';
      version: typeof BRIDGE_VERSION;
      projectId: string;
      sessionId: string;
      // Distinct doc IDs. The content script joins a few at a time on the
      // session socket and reports success or failure per doc.
      docIds: string[];
    }
  | {
      type: 'LIVE_SESSION_WRITE_DOC';
      version: typeof BRIDGE_VERSION;
      projectId: string;
      sessionId: string;
      docId: string;
      ops: OtOp[];
      baseVersion: number;
    }
  | {
      type: 'LIVE_SESSION_CREATE_DOC';
      version: typeof BRIDGE_VERSION;
      projectId: string;
      sessionId: string;
      path: string;
      initialContent: string;
    }
  | {
      type: 'LIVE_SESSION_UPLOAD_BINARY';
      version: typeof BRIDGE_VERSION;
      projectId: string;
      sessionId: string;
      path: string;
      contentBase64: string;
    }
  // "Make Overleaf match GitHub exactly" (pull option, off by default). The
  // popup sends these only for a confirmed plan; each one re-checks Overleaf
  // before changing anything (see replaceUploadedFileInSession and
  // deleteEntityInSession in liveBridgeHandler.ts).
  | {
      // Read-only: SHA-256 and size of uploaded files, fetched from Overleaf.
      type: 'LIVE_SESSION_HASH_FILES';
      version: typeof BRIDGE_VERSION;
      projectId: string;
      sessionId: string;
      fileIds: string[];
    }
  | {
      // Replaces an uploaded file by uploading new bytes over it.
      type: 'LIVE_SESSION_REPLACE_FILE';
      version: typeof BRIDGE_VERSION;
      projectId: string;
      sessionId: string;
      path: string;
      // The file ID the plan saw at `path`, and the SHA-256 of the bytes it
      // read then. Both must still hold right before the upload.
      fileId: string;
      expectedSha256: string;
      contentBase64: string;
    }
  | {
      // Deletes one doc, uploaded file or (empty) folder.
      type: 'LIVE_SESSION_DELETE_ENTITY';
      version: typeof BRIDGE_VERSION;
      projectId: string;
      sessionId: string;
      kind: 'doc' | 'file' | 'folder';
      path: string;
      // The entity ID the plan saw at `path`.
      entityId: string;
      // Docs only: SHA-256 (UTF-8 bytes) of the text the plan read. The doc
      // is read again and must still match.
      expectedSha256?: string;
    }
  | {
      type: 'LIVE_SESSION_CLOSE';
      version: typeof BRIDGE_VERSION;
      projectId: string;
      sessionId: string;
    };

export type LivePingResponseData = {
  onProjectPage: boolean;
  // Absent on content scripts that predate BRIDGE_FEATURE_SESSIONS.
  features?: string[];
};

export type SerializedProjectFile = {
  path: string;
  // Always base64 over the wire — Uint8Array doesn't survive structured-
  // clone in all MV3 versions, and base64 keeps message size predictable.
  contentBase64: string;
  text?: string;
  encoding: 'utf-8' | 'base64';
  sha256: string;
  sizeBytes: number;
  isBinary: boolean;
};

export type BridgeFailure = {
  ok: false;
  code: LiveSyncErrorCode;
  message: string;
  recovery?: string;
};

export type BridgeSuccess<T> = {
  ok: true;
  data: T;
};

export type BridgeResponse<T> = BridgeSuccess<T> | BridgeFailure;

export type LiveSnapshotResponseData = {
  projectId: string;
  files: SerializedProjectFile[];
  warnings: string[];
  fetchedAt: string;
};

// Phase-1 write-back protocol responses. The popup owns the conflict
// detector and the OT diff; the content script owns the socket. These
// three responses are the minimum surface needed to wire the existing
// writeSelectedFilesBackToOverleaf flow to a real channel.
export type LiveProjectMetadataResponseData = {
  projectId: string;
  // Shape-compatible with WorkshopFolder[] returned by joinProject —
  // popup's existing flattenProjectTree consumes this directly.
  rootFolder: LiveProjectFolder[];
  name?: string;
};

export type LiveReadDocResponseData = {
  docId: string;
  version: number;
  text: string;
};

export type LiveWriteDocResponseData = {
  docId: string;
  newVersion: number;
  text: string;
};

export type LiveCreateDocResponseData = {
  docId: string;
  path: string;
  version: number;
  text: string;
};

export type LiveUploadBinaryResponseData = {
  fileId: string;
  path: string;
  sizeBytes: number;
};

export type LiveSessionOpenResponseData = {
  sessionId: string;
  rootFolder: LiveProjectFolder[];
  name?: string;
  // ID of the project's main document (joinProject's rootDoc_id), when it
  // has one. Older content scripts leave it out.
  rootDocId?: string;
};

export type LiveSessionDocRead =
  | { docId: string; ok: true; version: number; text: string }
  | { docId: string; ok: false; code: LiveSyncErrorCode; message: string };

export type LiveSessionReadDocsResponseData = {
  docs: LiveSessionDocRead[];
};

export type LiveSessionFileHash =
  | { fileId: string; ok: true; sha256: string; sizeBytes: number }
  | { fileId: string; ok: false; code: LiveSyncErrorCode; message: string };

export type LiveSessionHashFilesResponseData = {
  files: LiveSessionFileHash[];
};

export type LiveReplaceFileResponseData = {
  // The ID Overleaf gave the replacement (a replaced file gets a new one).
  fileId: string;
  path: string;
  sizeBytes: number;
  // Overleaf made the replacement an editable text file instead of an
  // uploaded file (its own rule for the name and content).
  becameDoc?: boolean;
  // A repeat of a request this session had already carried out (the popup
  // sends a request again when the first reply never arrived): the check
  // found the replacement in place with the sent bytes, and nothing was
  // uploaded this time.
  alreadyDone?: boolean;
};

export type LiveDeleteEntityResponseData = {
  path: string;
  kind: 'doc' | 'file' | 'folder';
  // A repeat of a delete this session had already carried out: the entity was
  // gone, and nothing was deleted this time.
  alreadyDone?: boolean;
};

export type LiveSessionCloseResponseData = {
  closed: boolean;
};

export function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const chunk = bytes.subarray(i, i + CHUNK);
    binary += String.fromCharCode.apply(null, Array.from(chunk));
  }
  return btoa(binary);
}

export function base64ToUint8(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function projectFileToWire(file: ProjectFile): SerializedProjectFile {
  return {
    path: file.path,
    contentBase64: uint8ToBase64(file.content),
    text: file.text,
    encoding: file.encoding,
    sha256: file.sha256,
    sizeBytes: file.sizeBytes,
    isBinary: file.isBinary,
  };
}

export function projectFileFromWire(wire: SerializedProjectFile): ProjectFile {
  return {
    path: wire.path,
    content: base64ToUint8(wire.contentBase64),
    text: wire.text,
    encoding: wire.encoding,
    sha256: wire.sha256,
    sizeBytes: wire.sizeBytes,
    isBinary: wire.isBinary,
  };
}
