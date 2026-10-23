// Popup-side handle on a content-script project session (LIVE_SESSION_*
// messages, see bridgeProtocol.ts and src/content/liveBridgeHandler.ts).
//
// One session means one socket and one joinProject for a whole pull,
// instead of one of each per read, write, create and upload. The safety
// logic stays where it was: the conflict detector, the OT diff and the
// verify comparison run in the popup (overleafWriteBack.ts); the content
// script only moves bytes over the session socket.

import { chunk } from '../../shared/concurrency';
import {
  BRIDGE_FEATURE_MIRROR,
  BRIDGE_FEATURE_SESSIONS,
  BRIDGE_VERSION,
  type BridgeFailure,
  type BridgeRequest,
  type BridgeResponse,
  type LiveCreateDocResponseData,
  type LiveDeleteEntityResponseData,
  type LivePingResponseData,
  type LiveReplaceFileResponseData,
  type LiveSessionDocRead,
  type LiveSessionFileHash,
  type LiveSessionHashFilesResponseData,
  type LiveSessionOpenResponseData,
  type LiveSessionReadDocsResponseData,
  type LiveUploadBinaryResponseData,
  type LiveWriteDocResponseData,
} from './bridgeProtocol';
import { findOverleafTab, sendBridgeRequest } from './liveSyncManager';
import type { DocSnapshot } from './overleafDocumentClient';
import { diffToOps } from './overleafOt';
import { LiveSyncError, asDetail, type LiveProjectFolder, type LiveSyncErrorCode } from './types';

const PING_TIMEOUT_MS = 5_000;
// Connect + joinProject, each with its own timeout in the content script.
const OPEN_TIMEOUT_MS = 45_000;
const CLOSE_TIMEOUT_MS = 5_000;
// Docs per LIVE_SESSION_READ_DOCS message. The content script pipelines
// them on its socket; chunking keeps each message well inside its timeout
// and gives the UI progress to show.
const READ_BATCH_SIZE = 12;
// Covers a reconnect inside the content script (connect + joinProject)
// plus pre-write read, applyOtUpdate, confirmation wait and verify read.
const WRITE_TIMEOUT_MS = 60_000;
const CREATE_TIMEOUT_MS = 60_000;
// Socket check, folder POSTs, the fresh listing check and the multipart
// POST itself; the POST part grows with the file (sized for a slow uplink).
const UPLOAD_BASE_TIMEOUT_MS = 90_000;
const UPLOAD_BASE64_CHARS_PER_SECOND = 64 * 1024;
// Reopen a lost session (Overleaf tab reloaded mid-run) at most this often.
const MAX_REOPENS = 2;
// "Make Overleaf match GitHub exactly". Uploaded files fetched per
// LIVE_SESSION_HASH_FILES message (the content script fetches a few at a
// time and the whole batch must fit the timeout below).
const HASH_FILES_BATCH_SIZE = 8;
const HASH_FILES_TIMEOUT_MS = 60_000 + HASH_FILES_BATCH_SIZE * 30_000;
// A replacement or deletion first re-reads the project tree (a join, up to
// 45 s), checks Overleaf's listing and re-reads the doc or file (30 s each)
// before its request, so these sit well above the plain upload's.
const DELETE_TIMEOUT_MS = 180_000;
const REPLACE_FILE_EXTRA_TIMEOUT_MS = 120_000;

function readBatchTimeoutMs(docCount: number): number {
  return 45_000 + docCount * 10_000;
}

function uploadTimeoutMs(contentBase64Length: number): number {
  return UPLOAD_BASE_TIMEOUT_MS + Math.ceil(contentBase64Length / UPLOAD_BASE64_CHARS_PER_SECOND) * 1_000;
}

// Failures that mean the bridge itself is gone, not that one operation
// failed. After one of these the session stops sending, so the rest of the
// run fails fast instead of waiting out a timeout per file. 'network' is
// the popup's own timer: the content script may still be busy with that
// operation, and anything sent now would queue behind it.
const TRANSPORT_FAILURES: ReadonlySet<LiveSyncErrorCode> = new Set<LiveSyncErrorCode>([
  'network',
  'protocol_unavailable',
  'bridge_session_lost',
]);

const NOT_ATTEMPTED_MESSAGE =
  'Not attempted: the connection to the Overleaf tab was lost. Run the pull again.';

const OUTDATED_BRIDGE_MESSAGE =
  'This Overleaf tab was opened before the extension was updated, so the pull cannot run there yet. Nothing was written.';
const OUTDATED_MIRROR_MESSAGE =
  'This Overleaf tab was opened before the extension was updated, so “Make Overleaf match GitHub exactly” cannot run there yet. Nothing was changed.';

const UNREACHABLE_TAB_MESSAGE =
  'The Overleaf tab could not be reached; it may have been closed or reloaded.';
const UNREACHABLE_TAB_RECOVERY = 'Reload the Overleaf tab, then run the pull again.';

// sendBridgeRequest's own failures are reworded here for the pull's
// result rows. Only its timer reports 'network', and every
// 'protocol_unavailable' is its own (the tab could not be reached even
// after injecting the content script). A project page the content script
// cannot use comes back as 'page_not_recognized', which is not retried.
async function send<T>(
  tabId: number,
  request: BridgeRequest,
  timeoutMs: number,
): Promise<BridgeResponse<T>> {
  const response = await sendBridgeRequest<T>(tabId, request, timeoutMs);
  if (response.ok) return response;
  if (response.code === 'network') {
    return {
      ...response,
      message: `The Overleaf tab did not answer within ${Math.round(timeoutMs / 1000)} seconds.`,
    };
  }
  if (response.code === 'protocol_unavailable') {
    return { ...response, message: UNREACHABLE_TAB_MESSAGE, recovery: UNREACHABLE_TAB_RECOVERY };
  }
  return response;
}

function requestOpen(
  tabId: number,
  projectId: string,
): Promise<BridgeResponse<LiveSessionOpenResponseData>> {
  return send<LiveSessionOpenResponseData>(
    tabId,
    { type: 'LIVE_SESSION_OPEN', version: BRIDGE_VERSION, projectId },
    OPEN_TIMEOUT_MS,
  );
}

export class OverleafBridgeSession {
  private reopens = 0;
  private closed = false;
  private brokenBy: BridgeFailure | null = null;

  private constructor(
    readonly projectId: string,
    private readonly tabId: number,
    private sessionId: string,
    private tree: LiveProjectFolder[],
    private readonly features: readonly string[],
    private mainDocId: string | undefined,
  ) {}

  // Opens a session on the project's Overleaf tab. Throws a LiveSyncError,
  // before anything is written, when the tab's content script predates
  // sessions ('bridge_outdated') or the session cannot be opened.
  static async open(projectId: string): Promise<OverleafBridgeSession> {
    if (!/^[a-zA-Z0-9]+$/.test(projectId)) {
      throw new LiveSyncError('unknown', 'Invalid Overleaf project ID.');
    }
    const tab = await findOverleafTab(projectId);
    if (!tab || typeof tab.id !== 'number') {
      throw new LiveSyncError(
        'project_join_failed',
        `No open Overleaf tab matches project ${projectId}.`,
        'Open the Overleaf project tab and try again.',
      );
    }
    const tabId = tab.id;

    // sendBridgeRequest injects the content script if the tab has none.
    // A tab that already runs an older one keeps it (its double-init guard
    // makes injection a no-op), and that script ignores LIVE_SESSION_*
    // messages, so check its advertised features first.
    const ping = await send<LivePingResponseData>(
      tabId,
      { type: 'LIVE_PING', version: BRIDGE_VERSION },
      PING_TIMEOUT_MS,
    );
    if (!ping.ok) {
      throw new LiveSyncError(
        ping.code,
        `The extension couldn't talk to the Overleaf tab, so nothing was written. Details: ${asDetail(ping.message)}.`,
        UNREACHABLE_TAB_RECOVERY,
      );
    }
    if (!ping.data.onProjectPage) {
      throw new LiveSyncError(
        'project_join_failed',
        'The Overleaf tab is not showing a project.',
        'Open the project in that tab, then try again.',
      );
    }
    if (!ping.data.features?.includes(BRIDGE_FEATURE_SESSIONS)) {
      throw new LiveSyncError(
        'bridge_outdated',
        OUTDATED_BRIDGE_MESSAGE,
        'Reload the Overleaf tab, then run the pull again.',
      );
    }

    const opened = await requestOpen(tabId, projectId);
    if (!opened.ok) {
      throw new LiveSyncError(opened.code, opened.message, opened.recovery);
    }
    return new OverleafBridgeSession(
      projectId,
      tabId,
      opened.data.sessionId,
      opened.data.rootFolder,
      ping.data.features ?? [],
      opened.data.rootDocId,
    );
  }

  // Throws 'bridge_outdated', before anything is changed, unless the tab's
  // content script handles the messages of "Make Overleaf match GitHub
  // exactly" (see BRIDGE_FEATURE_MIRROR).
  requireMirrorSupport(): void {
    if (!this.features.includes(BRIDGE_FEATURE_MIRROR)) {
      throw new LiveSyncError(
        'bridge_outdated',
        OUTDATED_MIRROR_MESSAGE,
        'Reload the Overleaf tab, then run the pull again.',
      );
    }
  }

  // Project tree from the session's joinProject.
  get rootFolder(): LiveProjectFolder[] {
    return this.tree;
  }

  // ID of the project's main document, when the Overleaf tab reported one
  // (an older content script doesn't).
  get rootDocId(): string | undefined {
    return this.mainDocId;
  }

  private async call<T>(
    build: (sessionId: string) => BridgeRequest,
    timeoutMs: number,
  ): Promise<BridgeResponse<T>> {
    if (this.closed) {
      return {
        ok: false,
        code: 'bridge_session_lost',
        message: 'The Overleaf session for this run was already closed.',
      };
    }
    if (this.brokenBy) {
      // Never sent. Callers report it as not attempted, not as failed; the
      // operation that hit the transport failure carries the real cause.
      return { ok: false, code: 'not_attempted', message: NOT_ATTEMPTED_MESSAGE };
    }

    let response = await send<T>(this.tabId, build(this.sessionId), timeoutMs);
    if (!response.ok && response.code === 'bridge_session_lost' && this.reopens < MAX_REOPENS) {
      // The content script lost the session (tab reloaded). Every
      // operation re-validates against Overleaf before changing anything,
      // so running it again on a new session is safe.
      this.reopens++;
      const reopened = await requestOpen(this.tabId, this.projectId);
      if (reopened.ok) {
        this.sessionId = reopened.data.sessionId;
        this.tree = reopened.data.rootFolder;
        this.mainDocId = reopened.data.rootDocId;
        response = await send<T>(this.tabId, build(this.sessionId), timeoutMs);
      } else {
        response = reopened;
      }
    }
    if (!response.ok && TRANSPORT_FAILURES.has(response.code)) {
      this.brokenBy = response;
    }
    return response;
  }

  // Reads docs in batches. Per-doc failures come back as `ok: false`
  // entries; a failure of a whole batch throws, because it means the
  // bridge itself is in trouble.
  async readDocs(
    docIds: string[],
    onProgress?: (done: number, total: number) => void,
  ): Promise<Map<string, LiveSessionDocRead>> {
    const unique = Array.from(new Set(docIds));
    const out = new Map<string, LiveSessionDocRead>();
    let done = 0;
    for (const batch of chunk(unique, READ_BATCH_SIZE)) {
      const response = await this.call<LiveSessionReadDocsResponseData>(
        (sessionId) => ({
          type: 'LIVE_SESSION_READ_DOCS',
          version: BRIDGE_VERSION,
          projectId: this.projectId,
          sessionId,
          docIds: batch,
        }),
        readBatchTimeoutMs(batch.length),
      );
      if (!response.ok) {
        throw new LiveSyncError(response.code, response.message, response.recovery);
      }
      for (const doc of response.data.docs) out.set(doc.docId, doc);
      for (const docId of batch) {
        if (!out.has(docId)) {
          out.set(docId, {
            docId,
            ok: false,
            code: 'document_join_failed',
            message: 'The Overleaf tab sent no result for this file.',
          });
        }
      }
      done += batch.length;
      onProgress?.(done, unique.length);
    }
    return out;
  }

  // Fresh read of one doc. Throws a LiveSyncError when it fails.
  async fetchSnapshot(docId: string): Promise<DocSnapshot> {
    const read = (await this.readDocs([docId])).get(docId);
    if (!read || !read.ok) {
      throw new LiveSyncError(
        read?.code ?? 'document_join_failed',
        read?.message ?? 'The Overleaf tab sent no result for this file.',
      );
    }
    return { docId, version: read.version, lines: read.text.split('\n'), text: read.text };
  }

  // Applies oldText -> newText at baseVersion and returns the doc as read
  // back afterwards. The content script refuses unless the doc is still at
  // baseVersion. Throws a LiveSyncError when the write fails.
  async applyUpdate(
    docId: string,
    oldText: string,
    newText: string,
    baseVersion: number,
  ): Promise<DocSnapshot> {
    const ops = diffToOps(oldText, newText);
    if (ops.length === 0) {
      // Nothing to send; read the current state so the caller's verify
      // check still has data.
      return this.fetchSnapshot(docId);
    }
    const response = await this.call<LiveWriteDocResponseData>(
      (sessionId) => ({
        type: 'LIVE_SESSION_WRITE_DOC',
        version: BRIDGE_VERSION,
        projectId: this.projectId,
        sessionId,
        docId,
        ops,
        baseVersion,
      }),
      WRITE_TIMEOUT_MS,
    );
    if (!response.ok) {
      throw new LiveSyncError(response.code, response.message, response.recovery);
    }
    const { newVersion, text } = response.data;
    return { docId, version: newVersion, lines: text.split('\n'), text };
  }

  createDocAtPath(
    path: string,
    initialContent: string,
  ): Promise<BridgeResponse<LiveCreateDocResponseData>> {
    return this.call<LiveCreateDocResponseData>(
      (sessionId) => ({
        type: 'LIVE_SESSION_CREATE_DOC',
        version: BRIDGE_VERSION,
        projectId: this.projectId,
        sessionId,
        path,
        initialContent,
      }),
      CREATE_TIMEOUT_MS,
    );
  }

  uploadBinary(
    path: string,
    contentBase64: string,
  ): Promise<BridgeResponse<LiveUploadBinaryResponseData>> {
    return this.call<LiveUploadBinaryResponseData>(
      (sessionId) => ({
        type: 'LIVE_SESSION_UPLOAD_BINARY',
        version: BRIDGE_VERSION,
        projectId: this.projectId,
        sessionId,
        path,
        contentBase64,
      }),
      uploadTimeoutMs(contentBase64.length),
    );
  }

  // SHA-256 and size of uploaded files, read from Overleaf (read-only).
  // Per-file failures come back as `ok: false` entries; a failure of a whole
  // batch throws, because it means the bridge itself is in trouble.
  async hashFiles(
    fileIds: string[],
    onProgress?: (done: number, total: number) => void,
  ): Promise<Map<string, LiveSessionFileHash>> {
    const unique = Array.from(new Set(fileIds));
    const out = new Map<string, LiveSessionFileHash>();
    let done = 0;
    for (const batch of chunk(unique, HASH_FILES_BATCH_SIZE)) {
      const response = await this.call<LiveSessionHashFilesResponseData>(
        (sessionId) => ({
          type: 'LIVE_SESSION_HASH_FILES',
          version: BRIDGE_VERSION,
          projectId: this.projectId,
          sessionId,
          fileIds: batch,
        }),
        HASH_FILES_TIMEOUT_MS,
      );
      if (!response.ok) {
        throw new LiveSyncError(response.code, response.message, response.recovery);
      }
      for (const file of response.data.files) out.set(file.fileId, file);
      for (const fileId of batch) {
        if (!out.has(fileId)) {
          out.set(fileId, {
            fileId,
            ok: false,
            code: 'unknown',
            message: 'The Overleaf tab sent no result for this file.',
          });
        }
      }
      done += batch.length;
      onProgress?.(done, unique.length);
    }
    return out;
  }

  // Replaces an uploaded file with new bytes. The content script refuses
  // unless the path still holds `fileId` with bytes matching
  // `expectedSha256` (what the plan read).
  replaceUploadedFile(
    path: string,
    fileId: string,
    expectedSha256: string,
    contentBase64: string,
  ): Promise<BridgeResponse<LiveReplaceFileResponseData>> {
    return this.call<LiveReplaceFileResponseData>(
      (sessionId) => ({
        type: 'LIVE_SESSION_REPLACE_FILE',
        version: BRIDGE_VERSION,
        projectId: this.projectId,
        sessionId,
        path,
        fileId,
        expectedSha256,
        contentBase64,
      }),
      uploadTimeoutMs(contentBase64.length) + REPLACE_FILE_EXTRA_TIMEOUT_MS,
    );
  }

  // Deletes one doc, uploaded file or empty folder. The content script
  // refuses unless the entity at `path` still has the planned ID (and, for a
  // doc, the planned text).
  deleteEntity(
    kind: 'doc' | 'file' | 'folder',
    path: string,
    entityId: string,
    expectedSha256?: string,
  ): Promise<BridgeResponse<LiveDeleteEntityResponseData>> {
    return this.call<LiveDeleteEntityResponseData>(
      (sessionId) => ({
        type: 'LIVE_SESSION_DELETE_ENTITY',
        version: BRIDGE_VERSION,
        projectId: this.projectId,
        sessionId,
        kind,
        path,
        entityId,
        ...(expectedSha256 !== undefined ? { expectedSha256 } : {}),
      }),
      DELETE_TIMEOUT_MS,
    );
  }

  // Best effort. The content script also closes a session that sits idle.
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await sendBridgeRequest(
        this.tabId,
        {
          type: 'LIVE_SESSION_CLOSE',
          version: BRIDGE_VERSION,
          projectId: this.projectId,
          sessionId: this.sessionId,
        },
        CLOSE_TIMEOUT_MS,
      );
    } catch {
      // ignore
    }
  }
}
