// Live-snapshot bridge handler. Runs inside the overleaf.com content
// script context. The popup sends LIVE_FETCH_SNAPSHOT and this handler:
//
//   1. Pulls CSRF from the current document's <meta name="ol-csrfToken">
//      (no extra HTTP needed — we're already on the project page).
//   2. Opens a Socket.IO 0.9 connection to the same origin (which is
//      precisely why this runs in a content script rather than the popup;
//      the WS origin is then www.overleaf.com, which Overleaf accepts).
//   3. Calls joinProject to discover the full file tree with doc IDs.
//   4. For each editable doc, joinDoc to fetch the latest lines+version.
//   5. For each static file, GET /project/:id/file/:fileId via fetch with
//      credentials: 'include'.
//   6. Hashes + base64-encodes everything into SerializedProjectFile[] and
//      returns to the popup.
//
// On any failure, returns a typed BridgeFailure with a recovery hint.
//
// This module is AGPL-3.0; the Socket.IO message vocabulary
// (joinProject / joinDoc / otUpdateApplied) is adapted from Overleaf
// Workshop (AGPL-3.0).

import { SocketIo09Client, SocketIo09Error } from './socketIo09';
import type {
  BridgeFailure,
  BridgeResponse,
  LiveCreateDocResponseData,
  LiveProjectMetadataResponseData,
  LiveReadDocResponseData,
  LiveSessionDocRead,
  LiveSessionOpenResponseData,
  LiveSessionReadDocsResponseData,
  LiveSnapshotResponseData,
  LiveUploadBinaryResponseData,
  LiveWriteDocResponseData,
  OtOp,
  SerializedProjectFile,
} from '../overleaf/live/bridgeProtocol';
import { base64ToUint8, uint8ToBase64 } from '../overleaf/live/bridgeProtocol';
import {
  COMMON_BINARY_EXTENSIONS,
  TEXT_EXTENSIONS,
} from '../shared/constants';
import { mapWithConcurrency } from '../shared/concurrency';
import { computeSha256 } from '../diff/fileHasher';
import type { LiveSyncErrorCode } from '../overleaf/live/types';

const JOIN_PROJECT_TIMEOUT_MS = 20_000;
const JOIN_DOC_TIMEOUT_MS = 15_000;

type WorkshopProjectEntry = {
  _id: string;
  name: string;
};

type WorkshopFolder = {
  _id?: string;
  name: string;
  folders?: WorkshopFolder[];
  docs?: WorkshopProjectEntry[];
  fileRefs?: WorkshopProjectEntry[];
};

type WorkshopProject = {
  _id: string;
  rootFolder?: WorkshopFolder[];
  name?: string;
};

type FlatEntry = {
  id: string;
  path: string;
  kind: 'doc' | 'file';
};

function extractCsrfFromDocument(): string | null {
  const meta = document.querySelector('meta[name="ol-csrfToken"]');
  if (!meta) return null;
  return meta.getAttribute('content');
}

function flattenWorkshopTree(rootFolder: WorkshopFolder[] | undefined): FlatEntry[] {
  if (!rootFolder || rootFolder.length === 0) return [];
  const out: FlatEntry[] = [];
  const walk = (folder: WorkshopFolder, prefix: string) => {
    const here =
      folder.name === 'rootFolder' || !folder.name
        ? prefix
        : prefix
          ? `${prefix}/${folder.name}`
          : folder.name;
    for (const doc of folder.docs ?? []) {
      out.push({
        id: doc._id,
        path: here ? `${here}/${doc.name}` : doc.name,
        kind: 'doc',
      });
    }
    for (const file of folder.fileRefs ?? []) {
      out.push({
        id: file._id,
        path: here ? `${here}/${file.name}` : file.name,
        kind: 'file',
      });
    }
    for (const sub of folder.folders ?? []) {
      walk(sub, here);
    }
  };
  for (const f of rootFolder) walk(f, '');
  return out;
}

function getExtension(path: string): string {
  const base = path.split('/').pop() ?? path;
  const idx = base.lastIndexOf('.');
  if (idx < 0) return '';
  return base.substring(idx).toLowerCase();
}

function looksBinary(bytes: Uint8Array): boolean {
  const len = Math.min(bytes.length, 8192);
  for (let i = 0; i < len; i++) if (bytes[i] === 0) return true;
  return false;
}

function detectBinary(path: string, bytes: Uint8Array): boolean {
  const ext = getExtension(path);
  if (TEXT_EXTENSIONS.has(ext)) return false;
  if (COMMON_BINARY_EXTENSIONS.has(ext)) return true;
  return looksBinary(bytes);
}

// Overleaf's real-time server packs every joinDoc line before sending it
// (services/real-time WebsocketController.joinDoc: `encodeForWebsockets =
// text => unescape(encodeURIComponent(text))`), so each code unit carries
// one UTF-8 byte. That is an application-level encoding on top of the
// WebSocket frame, so the browser's frame decode does not undo it.
// Only applyOtUpdate ops travel unpacked, so writes need no matching encode.
//
// The server skips packing for `history-ot` docs, but only for clients that
// send `supportsHistoryOT`; we don't, so it refuses those docs instead.
//
// Strict on purpose: a code unit above 0xFF or invalid UTF-8 means the
// premise no longer holds, and failing the read is safer than writing
// mojibake back to Overleaf or GitHub.
//
// ignoreBOM keeps a leading U+FEFF (a .tex uploaded from an editor that
// saves UTF-8 with a BOM). The default decoder drops it, which makes the
// text one character shorter than the server's doc, so every OT position
// computed from it lands one character early.
function decodePackedUtf8(line: string): string {
  const bytes = new Uint8Array(line.length);
  for (let i = 0; i < line.length; i++) {
    const unit = line.charCodeAt(i);
    if (unit > 0xff) {
      throw new Error('joinDoc line is not latin1-packed UTF-8 (Overleaf protocol changed?)');
    }
    bytes[i] = unit;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new Error('joinDoc line is not valid packed UTF-8 (Overleaf protocol changed?)');
  }
}

async function buildTextProjectFile(
  path: string,
  text: string,
): Promise<SerializedProjectFile> {
  const enc = new TextEncoder();
  const bytes = enc.encode(text);
  const sha256 = await computeSha256(bytes);
  return {
    path,
    contentBase64: uint8ToBase64(bytes),
    text,
    encoding: 'utf-8',
    sha256,
    sizeBytes: bytes.byteLength,
    isBinary: false,
  };
}

async function buildBinaryProjectFile(
  path: string,
  bytes: Uint8Array,
): Promise<SerializedProjectFile> {
  const isBinary = detectBinary(path, bytes);
  const sha256 = await computeSha256(bytes);
  if (isBinary) {
    return {
      path,
      contentBase64: uint8ToBase64(bytes),
      encoding: 'base64',
      sha256,
      sizeBytes: bytes.byteLength,
      isBinary: true,
    };
  }
  // ignoreBOM: keep a leading BOM so `text` matches the bytes.
  const text = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true }).decode(bytes);
  return {
    path,
    contentBase64: uint8ToBase64(bytes),
    text,
    encoding: 'utf-8',
    sha256,
    sizeBytes: bytes.byteLength,
    isBinary: false,
  };
}

function failure(code: LiveSyncErrorCode, message: string, recovery?: string): BridgeFailure {
  return { ok: false, code, message, recovery };
}

// Readable reason from a Socket.IO error payload (connectionRejected,
// otUpdateError). Overleaf sends either a string or { message, code }.
function describeServerError(arg: unknown): string {
  if (typeof arg === 'string' && arg) return arg;
  if (arg && typeof arg === 'object') {
    const o = arg as { message?: unknown; code?: unknown; info?: { code?: unknown } };
    if (typeof o.message === 'string' && o.message) return o.message;
    if (typeof o.code === 'string' && o.code) return o.code;
    if (o.info && typeof o.info.code === 'string') return o.info.code;
  }
  return 'no reason given';
}

async function fetchStaticFile(
  projectId: string,
  fileId: string,
): Promise<Uint8Array> {
  const url = `https://www.overleaf.com/project/${encodeURIComponent(projectId)}/file/${encodeURIComponent(fileId)}`;
  const response = await fetch(url, {
    method: 'GET',
    credentials: 'include',
    redirect: 'follow',
    cache: 'no-store',
  });
  if (response.status === 401) throw new Error('not_logged_in: 401');
  if (response.status === 403) throw new Error('forbidden: 403');
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const buf = await response.arrayBuffer();
  return new Uint8Array(buf);
}

type JoinProjectResult = {
  project: WorkshopProject;
  protocolVersion: number | null;
  permissions: unknown;
};

// A failed joinProject. The message is what the live read-only snapshot
// has always shown; connectAndJoinProject words its own from `kind` and
// `detail` where that message names protocol steps.
class JoinProjectError extends Error {
  constructor(
    message: string,
    readonly kind: 'rejected' | 'rate_limited' | 'closed' | 'timeout',
    readonly detail: string,
  ) {
    super(message);
    this.name = 'JoinProjectError';
  }
}

async function awaitJoinProject(
  client: SocketIo09Client,
  projectId: string,
): Promise<JoinProjectResult> {
  // Two-track wait: the v1 server scheme returns the project via an ack on
  // the joinProject emit; the v2 scheme emits a joinProjectResponse event.
  // Whichever lands first wins.
  let resolved = false;
  return new Promise<JoinProjectResult>((resolve, reject) => {
    const cleanup: Array<() => void> = [];
    const settle = (fn: () => void) => {
      if (resolved) return;
      resolved = true;
      for (const c of cleanup) {
        try {
          c();
        } catch {
          // ignore
        }
      }
      fn();
    };

    const unsubEvent = client.on((event) => {
      if (event.name === 'connectionRejected') {
        // Overleaf sends this instead of joinProjectResponse when the join
        // fails, then disconnects (services/real-time Router). Its web tier
        // rate-limits project joins, which shows up here as "rate-limit hit
        // when joining project". Fail now instead of waiting out the timer.
        const reason = describeServerError(event.args[0]);
        const rateLimited = /rate.?limit|TooManyRequests/i.test(reason);
        settle(() =>
          reject(
            new JoinProjectError(
              `Overleaf rejected the project join: ${reason}.${
                rateLimited
                  ? ' Overleaf limits how often a project can be joined; wait a minute, then retry.'
                  : ''
              }`,
              rateLimited ? 'rate_limited' : 'rejected',
              reason,
            ),
          ),
        );
        return;
      }
      if (event.name !== 'joinProjectResponse') return;
      const projectArg = (event.args[0] as { project?: WorkshopProject } | undefined)?.project;
      if (!projectArg) return;
      settle(() =>
        resolve({
          project: projectArg,
          protocolVersion: null,
          permissions: null,
        }),
      );
    });
    cleanup.push(unsubEvent);
    cleanup.push(
      client.onDisconnect((reason) => {
        settle(() =>
          reject(
            new JoinProjectError(
              `Overleaf closed the connection before joinProject completed (${reason}).`,
              'closed',
              reason,
            ),
          ),
        );
      }),
    );

    const timer = setTimeout(() => {
      settle(() =>
        reject(
          new JoinProjectError(
            `joinProject did not respond within ${JOIN_PROJECT_TIMEOUT_MS}ms`,
            'timeout',
            '',
          ),
        ),
      );
    }, JOIN_PROJECT_TIMEOUT_MS);
    cleanup.push(() => clearTimeout(timer));

    client
      .emitWithAck<unknown[]>('joinProject', [{ project_id: projectId }], JOIN_PROJECT_TIMEOUT_MS)
      .then((args) => {
        // v1 scheme: ack args = [project, permissions, protocolVersion]
        const project = args[0] as WorkshopProject | undefined;
        const permissions = args[1] ?? null;
        const protocolVersion =
          typeof args[2] === 'number' ? (args[2] as number) : null;
        if (project && project.rootFolder) {
          settle(() => resolve({ project, permissions, protocolVersion }));
        }
      })
      .catch(() => {
        /* server may use v2 scheme; the event listener handles that path */
      });
  });
}

type JoinDocResult = {
  text: string;
  version: number;
};

async function joinDoc(
  client: SocketIo09Client,
  docId: string,
): Promise<JoinDocResult> {
  const args = await client.emitWithAck<unknown[]>(
    'joinDoc',
    [docId, { encodeRanges: true }],
    JOIN_DOC_TIMEOUT_MS,
  );
  // ack = [docLines, version, updates, ranges]
  const linesRaw = args[0];
  const versionRaw = args[1];
  if (!Array.isArray(linesRaw)) {
    throw new Error(`joinDoc ack: lines is not an array (got ${typeof linesRaw})`);
  }
  if (typeof versionRaw !== 'number') {
    throw new Error(`joinDoc ack: version missing or not a number`);
  }
  const lines = linesRaw.map((l) => (typeof l === 'string' ? decodePackedUtf8(l) : ''));
  const text = lines.join('\n');
  return { text, version: versionRaw };
}

export async function handleLiveFetchSnapshot(
  projectId: string,
): Promise<BridgeResponse<LiveSnapshotResponseData>> {
  if (!/^[a-zA-Z0-9]+$/.test(projectId)) {
    return failure('unknown', `Invalid Overleaf project ID: ${projectId}`);
  }

  // Confirm we're on the right project — content script may have been
  // injected on a different project page.
  const onPath = window.location.pathname;
  if (!onPath.startsWith(`/project/${projectId}`)) {
    return failure(
      'project_join_failed',
      `Content script is on a different page (${onPath}). Reopen the popup from the matching Overleaf project tab.`,
      'Switch to the Overleaf project tab that matches the popup before retrying.',
    );
  }

  const csrfToken = extractCsrfFromDocument();
  if (!csrfToken) {
    return failure(
      'protocol_unavailable',
      'CSRF token not found in this project page (no <meta name="ol-csrfToken">). Page layout may have changed.',
      'Refresh the Overleaf tab and try again.',
    );
  }

  // Diagnostics are OFF by default in stable releases. Even though the
  // socket client now redacts every payload to structural shape (no
  // document content can leak), a stable build should stay silent unless
  // the user explicitly opts in. Opt-in is one line in the Overleaf tab's
  // DevTools console — no rebuild, no setting, no extra permission:
  //   localStorage.setItem('ofs-live-debug', '1')
  // then re-run the live pull. Set it back to '0' (or remove it) to stop.
  let diagnosticsEnabled = false;
  try {
    diagnosticsEnabled = window.localStorage?.getItem('ofs-live-debug') === '1';
  } catch {
    // localStorage can throw in sandboxed/blocked contexts — treat as off.
  }
  const dbg = (msg: string): void => {
    if (diagnosticsEnabled) console.debug(`[ofs-live] ${msg}`);
  };

  const client = new SocketIo09Client({
    baseUrl: 'https://www.overleaf.com',
    handshakeQuery: { projectId, t: String(Date.now()) },
    websocketQuery: { projectId },
    // Redacted structural logging only (string lengths / array+object
    // shape / protocol field names — never document content). Off unless
    // the user opts in via the localStorage flag above.
    debug: diagnosticsEnabled,
  });

  dbg('phase: connecting');
  try {
    await client.connect();
  } catch (e) {
    const msg = e instanceof SocketIo09Error ? e.message : e instanceof Error ? e.message : String(e);
    return failure(
      'socket_connection_failed',
      `Could not open the Overleaf real-time channel: ${msg}`,
      'Refresh the Overleaf tab and retry, or fall back to the ZIP route.',
    );
  }

  dbg('phase: joinProject');
  let projectResult: JoinProjectResult;
  try {
    projectResult = await awaitJoinProject(client, projectId);
  } catch (e) {
    client.disconnect();
    return failure(
      'project_join_failed',
      e instanceof Error ? e.message : String(e),
      'Refresh the Overleaf tab and retry, or fall back to the ZIP route.',
    );
  }

  const entries = flattenWorkshopTree(projectResult.project.rootFolder);
  dbg(
    `phase: iterate entries (${entries.length}: ${entries.filter((e) => e.kind === 'doc').length} docs, ${entries.filter((e) => e.kind === 'file').length} files)`,
  );
  if (entries.length === 0) {
    client.disconnect();
    return failure(
      'project_join_failed',
      'joinProject succeeded but the project tree is empty.',
    );
  }

  const files: SerializedProjectFile[] = [];
  const warnings: string[] = [];

  for (const entry of entries) {
    dbg(`entry ${entry.kind}: ${entry.path}`);
    try {
      if (entry.kind === 'doc') {
        const result = await joinDoc(client, entry.id);
        const file = await buildTextProjectFile(entry.path, result.text);
        files.push(file);
        // Tell the server we're done with this doc so it doesn't keep
        // pushing OT updates we don't care about.
        try {
          client.emit('leaveDoc', entry.id);
        } catch {
          // ignore — best effort
        }
      } else {
        const bytes = await fetchStaticFile(projectId, entry.id);
        const file = await buildBinaryProjectFile(entry.path, bytes);
        files.push(file);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      dbg(`entry ${entry.path} failed: ${msg}`);
      warnings.push(`${entry.path}: ${msg}`);
    }
  }

  dbg(`phase: done (${files.length} files, ${warnings.length} warnings)`);
  client.disconnect();

  files.sort((a, b) => a.path.localeCompare(b.path));

  return {
    ok: true,
    data: {
      projectId,
      files,
      warnings,
      fetchedAt: new Date().toISOString(),
    },
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Project sessions, and the read / write / create / upload operations that
// run on them.
//
// connect + joinProject is the expensive step, and Overleaf's web tier
// rate-limits project joins (an over-limit join comes back as
// `connectionRejected`). The pull from GitHub therefore opens ONE session
// (one socket, one joinProject) and sends every read, write, create and
// upload of the run through it as LIVE_SESSION_* messages. The original
// one-shot messages (LIVE_READ_DOC, LIVE_WRITE_DOC, …) run the same
// operations on a session that lives for that single call.
//
// Concurrency on the shared socket:
//   - Reads pipeline a few joinDocs (READ_DOCS_CONCURRENCY), always for
//     distinct docs. Acks are matched by id, and Overleaf's real-time
//     joinDoc handler runs per call, so overlapping joinDocs for different
//     docs are independent.
//   - Operations that change Overleaf (write, create, upload) run one at a
//     time per PROJECT, across every session and one-shot handler in this
//     tab (runProjectMutation). Two pulls of the same project, e.g. one from
//     the popup and one from the Options page, would otherwise both read a
//     doc at version V and apply the same change twice; Overleaf transforms
//     the second update instead of rejecting it, so the text ends up
//     duplicated. The popup and Options pages also refuse a second
//     concurrent pull (projectPullLock.ts), which covers different tabs.
//
// Overleaf disconnects a socket after a rejected applyOtUpdate, and after a
// doc-updater error on any doc that socket joined. The session reconnects
// (new socket, new joinProject) on its next operation, at most
// MAX_SESSION_RECONNECTS times, and gives up for good if a reconnect fails.
// ──────────────────────────────────────────────────────────────────────────

const READ_DOCS_CONCURRENCY = 4;
const MAX_DOCS_PER_READ = 50;
// The popup closes its session when a pull ends; this only reaps sessions
// whose popup went away mid-run.
const SESSION_IDLE_TIMEOUT_MS = 180_000;
const MAX_OPEN_SESSIONS = 4;
const MAX_SESSION_RECONNECTS = 4;
const APPLY_OT_ACK_TIMEOUT_MS = 20_000;
// How long to wait for Overleaf to confirm an applied update before the
// verify read runs anyway.
const APPLY_CONFIRM_TIMEOUT_MS = 5_000;
// After an update with no verdict, how often (and how far apart) the verify
// read is repeated while the doc still shows the base version.
const UNCONFIRMED_REREADS = 3;
const UNCONFIRMED_REREAD_DELAY_MS = 1_000;
const DOC_ID_RE = /^[a-zA-Z0-9]+$/;
// Same text as recoveryActionForLiveSyncError('bridge_session_lost'), so the
// popup shows one hint whichever side reports the lost session.
const SESSION_LOST_RECOVERY = 'Run the pull again; if it keeps happening, reload the Overleaf tab.';
// Hints for a failed connect or project join on the session path (the pull
// and the Options write-back test). No ZIP-route advice: that route copies
// Overleaf to GitHub, so it is no fallback for a pull. Reloading the tab
// joins the project again, so a rate-limited join only gets "wait"; its
// message already says that, and the pull banner does not repeat it.
const JOIN_FAILED_RECOVERY = 'Wait a minute, then try again. If it keeps failing, reload the Overleaf tab.';
const JOIN_RATE_LIMITED_RECOVERY = 'Wait a minute, then retry.';
// Deadlines for the Overleaf REST calls made inside the project's mutation
// chain (folder and doc POSTs, the entities listing, the upload POST). A
// request that never settles would otherwise hold the chain, and with it
// every later write, create and upload of the project in this tab.
// Folder and doc POSTs and the listing may end early: Overleaf adds
// entries under a project lock and refuses a name that is taken, so a POST
// that still lands after its deadline only adds an entry that a later
// create of the same path is refused against (an empty doc is filled by
// the next pull). An upload POST REPLACES an entry of the same name
// (ProjectUploadController), so ending it early would let a rerun's
// create-only check race an upload that is still landing. Its deadline
// therefore comes long after the popup's own timer for the whole upload
// (bridgeSession.ts, which reports the outcome as unknown) and only bounds
// a request that never settles.
const OVERLEAF_REST_TIMEOUT_MS = 30_000;
const UPLOAD_POST_BASE_TIMEOUT_MS = 300_000;
const UPLOAD_POST_BYTES_PER_SECOND = 48 * 1024;

// Tail of the mutation chain per project ID; see runProjectMutation.
const projectMutations = new Map<string, Promise<void>>();

// Runs `fn` after every earlier mutation of the same project in this tab
// has settled. The whole operation runs inside, so for a write the
// pre-write version check, applyOtUpdate, the confirmation wait and the
// verify read all happen before another write of that project starts.
function runProjectMutation<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
  const previous = projectMutations.get(projectId) ?? Promise.resolve();
  const run = previous.then(fn);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  projectMutations.set(projectId, tail);
  void tail.then(() => {
    if (projectMutations.get(projectId) === tail) projectMutations.delete(projectId);
  });
  return run;
}

class BridgeOpError extends Error {
  constructor(
    readonly code: LiveSyncErrorCode,
    message: string,
    readonly recovery?: string,
  ) {
    super(message);
    this.name = 'BridgeOpError';
  }
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function failureFromError(
  e: unknown,
  code: LiveSyncErrorCode,
  recovery?: string,
): BridgeFailure {
  if (e instanceof BridgeOpError) return failure(e.code, e.message, e.recovery ?? recovery);
  return failure(code, errorMessage(e), recovery);
}

function diagnosticsLogger(): { enabled: boolean; dbg: (msg: string) => void } {
  let enabled = false;
  try {
    enabled = window.localStorage?.getItem('ofs-live-debug') === '1';
  } catch {
    // localStorage can throw in sandboxed/blocked contexts — treat as off.
  }
  return {
    enabled,
    dbg: (msg: string) => {
      if (enabled) console.debug(`[ofs-live] ${msg}`);
    },
  };
}

// Preconditions checked before any socket is opened for a project.
function checkProjectPage(projectId: string): BridgeFailure | null {
  if (!/^[a-zA-Z0-9]+$/.test(projectId)) {
    return failure('unknown', `Invalid Overleaf project ID: ${projectId}`);
  }
  const onPath = window.location.pathname;
  if (!onPath.startsWith(`/project/${projectId}`)) {
    return failure(
      'project_join_failed',
      `Content script is on a different page (${onPath}). Reopen the popup from the matching Overleaf project tab.`,
      'Switch to the Overleaf project tab that matches the popup before retrying.',
    );
  }
  if (!extractCsrfFromDocument()) {
    return failure(
      'protocol_unavailable',
      'CSRF token not found in this project page (no <meta name="ol-csrfToken">). Page layout may have changed.',
      'Refresh the Overleaf tab and try again.',
    );
  }
  return null;
}

async function connectAndJoinProject(
  projectId: string,
  debug: boolean,
  dbg: (msg: string) => void,
): Promise<{ client: SocketIo09Client; project: WorkshopProject }> {
  const client = new SocketIo09Client({
    baseUrl: 'https://www.overleaf.com',
    handshakeQuery: { projectId, t: String(Date.now()) },
    websocketQuery: { projectId },
    debug,
  });

  dbg('phase: connecting');
  try {
    await client.connect();
  } catch (e) {
    client.disconnect();
    throw new BridgeOpError(
      'socket_connection_failed',
      // Without SocketIo09Error's "[stage] " tag.
      `Could not connect to Overleaf: ${errorMessage(e).replace(/^\[\w+\] /, '')}`,
      JOIN_FAILED_RECOVERY,
    );
  }

  dbg('phase: joinProject');
  try {
    const joined = await awaitJoinProject(client, projectId);
    return { client, project: joined.project };
  } catch (e) {
    client.disconnect();
    throw projectJoinFailure(e);
  }
}

// The session path's wording for a failed joinProject: what happened in the
// message, what to do in the recovery.
function projectJoinFailure(e: unknown): BridgeOpError {
  if (!(e instanceof JoinProjectError)) {
    return new BridgeOpError('project_join_failed', errorMessage(e), JOIN_FAILED_RECOVERY);
  }
  switch (e.kind) {
    case 'rate_limited':
      return new BridgeOpError('project_join_failed', e.message, JOIN_RATE_LIMITED_RECOVERY);
    case 'rejected':
      return new BridgeOpError('project_join_failed', e.message, JOIN_FAILED_RECOVERY);
    case 'closed':
      return new BridgeOpError(
        'project_join_failed',
        `Overleaf closed the connection before the project opened (${e.detail}).`,
        JOIN_FAILED_RECOVERY,
      );
    case 'timeout':
      return new BridgeOpError(
        'project_join_failed',
        `Overleaf did not open the project within ${JOIN_PROJECT_TIMEOUT_MS / 1000} seconds.`,
        JOIN_FAILED_RECOVERY,
      );
  }
}

// Project-room broadcasts that change the path of an existing entry
// (services/web EditorController.renameEntity / moveEntity). The cached
// tree maps folder paths to folder IDs, so after one of these a create or
// upload could land in a folder that now sits at a different path.
const TREE_MOVE_EVENTS: ReadonlySet<string> = new Set(['reciveEntityRename', 'reciveEntityMove']);

class ProjectSession {
  // Cached joinProject tree. Creates and uploads record what they add, so
  // later operations in the same run see it; a reconnect or reloadTree()
  // replaces it with the server's fresh tree. It only maps paths to IDs:
  // whether a path is free is checked against Overleaf right before an
  // upload (see uploadBinaryInSession).
  project: WorkshopProject;
  // Set when the session socket sees a rename or move after the cached
  // tree was read; ensureFolderPath re-reads the tree before using it.
  treeMoved = false;
  lastUsed = Date.now();
  private client: SocketIo09Client;
  private reconnecting: Promise<SocketIo09Client> | null = null;
  private reconnects = 0;
  private broken: BridgeOpError | null = null;
  // A failed reloadTree(), returned again instead of joining again until a
  // reconnect shows that joins work. Same reasoning as `broken`: the usual
  // cause is the join rate limit, and every retry is another join.
  private treeReloadFailure: BridgeOpError | null = null;
  // Folder paths whose refused POST already led to a tree re-read
  // (ensureFolderPath), so a name Overleaf keeps refusing costs one re-read.
  private readonly rereadFolderPaths = new Set<string>();
  private closed = false;
  private inFlight = 0;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  private constructor(
    readonly id: string,
    readonly projectId: string,
    opened: { client: SocketIo09Client; project: WorkshopProject },
    private readonly debug: boolean,
    readonly dbg: (msg: string) => void,
    // Set for sessions kept across messages; called after
    // SESSION_IDLE_TIMEOUT_MS without an operation.
    private readonly onIdle: (() => void) | null,
  ) {
    this.client = opened.client;
    this.project = opened.project;
    this.watchTree(opened.client);
  }

  private watchTree(client: SocketIo09Client): void {
    client.on((event) => {
      if (TREE_MOVE_EVENTS.has(event.name)) this.treeMoved = true;
    });
  }

  // Replaces the cached tree with a fresh joinProject on a short-lived
  // socket, so the session socket and its joined docs are left alone.
  // On failure treeMoved keeps the value it had: only a rename or move seen
  // on the socket sets it, never a failed re-read.
  async reloadTree(): Promise<void> {
    if (this.closed) {
      throw new BridgeOpError('bridge_session_lost', 'The Overleaf session was closed.', SESSION_LOST_RECOVERY);
    }
    if (this.treeReloadFailure) throw this.treeReloadFailure;
    const wasMoved = this.treeMoved;
    // Cleared first: a rename that arrives during the join sets it again.
    this.treeMoved = false;
    this.dbg('phase: re-read project tree');
    try {
      const fresh = await connectAndJoinProject(this.projectId, this.debug, this.dbg);
      fresh.client.disconnect();
      this.project = fresh.project;
    } catch (e) {
      if (wasMoved) this.treeMoved = true;
      this.treeReloadFailure =
        e instanceof BridgeOpError ? e : new BridgeOpError('project_join_failed', errorMessage(e), JOIN_FAILED_RECOVERY);
      throw this.treeReloadFailure;
    }
  }

  // True the first time it is called for `folderPath` in this session.
  claimFolderReread(folderPath: string): boolean {
    if (this.rereadFolderPaths.has(folderPath)) return false;
    this.rereadFolderPaths.add(folderPath);
    return true;
  }

  static async open(
    projectId: string,
    id: string,
    onIdle: (() => void) | null,
  ): Promise<ProjectSession> {
    const problem = checkProjectPage(projectId);
    if (problem) throw new BridgeOpError(problem.code, problem.message, problem.recovery);
    const { enabled, dbg } = diagnosticsLogger();
    const opened = await connectAndJoinProject(projectId, enabled, dbg);
    return new ProjectSession(id, projectId, opened, enabled, dbg, onIdle);
  }

  get isClosed(): boolean {
    return this.closed;
  }

  get isBusy(): boolean {
    return this.inFlight > 0;
  }

  // The session's socket, reconnecting first if Overleaf dropped it.
  // Concurrent callers share one reconnect.
  getClient(): Promise<SocketIo09Client> {
    if (this.closed) {
      return Promise.reject(
        new BridgeOpError('bridge_session_lost', 'The Overleaf session was closed.', SESSION_LOST_RECOVERY),
      );
    }
    if (this.client.isOpen()) return Promise.resolve(this.client);
    if (this.broken) return Promise.reject(this.broken);
    return this.reconnecting ?? this.startReconnect();
  }

  private startReconnect(): Promise<SocketIo09Client> {
    if (this.reconnects >= MAX_SESSION_RECONNECTS) {
      this.broken = new BridgeOpError(
        'socket_connection_failed',
        `Overleaf closed the real-time connection ${this.reconnects + 1} times during this run.`,
        'Refresh the Overleaf tab and run the pull again.',
      );
      return Promise.reject(this.broken);
    }
    this.reconnects++;
    this.dbg(`phase: reconnect ${this.reconnects}/${MAX_SESSION_RECONNECTS}`);
    const stale = this.client;
    const attempt = (async () => {
      stale.disconnect();
      try {
        const fresh = await connectAndJoinProject(this.projectId, this.debug, this.dbg);
        if (this.closed) {
          fresh.client.disconnect();
          throw new BridgeOpError('bridge_session_lost', 'The Overleaf session was closed.', SESSION_LOST_RECOVERY);
        }
        this.client = fresh.client;
        this.project = fresh.project;
        this.treeMoved = false;
        this.treeReloadFailure = null;
        this.watchTree(fresh.client);
        return fresh.client;
      } catch (e) {
        // Don't retry a failed join for the rest of this run: the usual
        // cause is Overleaf's join rate limit, and every retry is another
        // join against it.
        this.broken =
          e instanceof BridgeOpError ? e : new BridgeOpError('socket_connection_failed', errorMessage(e));
        throw this.broken;
      }
    })();
    this.reconnecting = attempt;
    const clear = () => {
      if (this.reconnecting === attempt) this.reconnecting = null;
    };
    attempt.then(clear, clear);
    return attempt;
  }

  // Runs `fn` in the project's mutation chain, so writes, creates and
  // uploads never interleave, whichever session sends them.
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    return runProjectMutation(this.projectId, fn);
  }

  async track<T>(fn: () => Promise<T>): Promise<T> {
    this.inFlight++;
    this.lastUsed = Date.now();
    this.clearIdleTimer();
    try {
      return await fn();
    } finally {
      this.inFlight--;
      this.lastUsed = Date.now();
      if (this.inFlight === 0) this.armIdleTimer();
    }
  }

  armIdleTimer(): void {
    const onIdle = this.onIdle;
    if (this.closed || !onIdle) return;
    this.clearIdleTimer();
    this.idleTimer = setTimeout(onIdle, SESSION_IDLE_TIMEOUT_MS);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.clearIdleTimer();
    this.client.disconnect();
  }
}

// Sessions kept across LIVE_SESSION_* messages, by session ID.
const openSessions = new Map<string, ProjectSession>();

function newSessionId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function closeRegisteredSession(id: string): boolean {
  const session = openSessions.get(id);
  if (!session) return false;
  openSessions.delete(id);
  session.close();
  session.dbg(`session ${id} closed`);
  return true;
}

async function openRegisteredSession(
  projectId: string,
): Promise<BridgeResponse<LiveSessionOpenResponseData>> {
  if (openSessions.size >= MAX_OPEN_SESSIONS) {
    // A popup that closed mid-run leaves its session until the idle timer
    // fires; reap the least recently used idle one.
    const idle = Array.from(openSessions.values())
      .filter((s) => !s.isBusy)
      .sort((a, b) => a.lastUsed - b.lastUsed)[0];
    if (idle) closeRegisteredSession(idle.id);
  }
  if (openSessions.size >= MAX_OPEN_SESSIONS) {
    return failure(
      'unknown',
      `This Overleaf tab already has ${openSessions.size} busy extension sessions.`,
      'Wait for the running pull to finish, then retry.',
    );
  }

  const id = newSessionId();
  let session: ProjectSession;
  try {
    session = await ProjectSession.open(projectId, id, () => {
      closeRegisteredSession(id);
    });
  } catch (e) {
    return failureFromError(e, 'project_join_failed', JOIN_FAILED_RECOVERY);
  }
  openSessions.set(id, session);
  session.armIdleTimer();
  session.dbg(`session ${id} open`);
  return {
    ok: true,
    data: {
      sessionId: id,
      rootFolder: session.project.rootFolder ?? [],
      name: session.project.name,
    },
  };
}

type SessionMessage = {
  type?: unknown;
  projectId?: unknown;
  sessionId?: unknown;
  docIds?: unknown;
  docId?: unknown;
  ops?: unknown;
  baseVersion?: unknown;
  path?: unknown;
  initialContent?: unknown;
  contentBase64?: unknown;
};

// Entry point for every LIVE_SESSION_* message.
export async function handleLiveSessionMessage(
  raw: unknown,
): Promise<BridgeResponse<unknown>> {
  if (!raw || typeof raw !== 'object') {
    return failure('unknown', 'Malformed session message.');
  }
  const message = raw as SessionMessage;
  const projectId = typeof message.projectId === 'string' ? message.projectId : '';
  if (!projectId) return failure('unknown', 'projectId missing in request');

  if (message.type === 'LIVE_SESSION_OPEN') return openRegisteredSession(projectId);

  const sessionId = typeof message.sessionId === 'string' ? message.sessionId : '';
  const session = openSessions.get(sessionId);
  if (!session || session.projectId !== projectId || session.isClosed) {
    if (message.type === 'LIVE_SESSION_CLOSE') return { ok: true, data: { closed: false } };
    return failure(
      'bridge_session_lost',
      'The Overleaf session for this run is no longer open (the tab was reloaded, or the session sat idle too long).',
      SESSION_LOST_RECOVERY,
    );
  }
  if (message.type === 'LIVE_SESSION_CLOSE') {
    return { ok: true, data: { closed: closeRegisteredSession(sessionId) } };
  }
  return session.track(() => runSessionOperation(session, message));
}

async function runSessionOperation(
  session: ProjectSession,
  message: SessionMessage,
): Promise<BridgeResponse<unknown>> {
  switch (message.type) {
    case 'LIVE_SESSION_READ_DOCS': {
      const docIds = Array.isArray(message.docIds) ? message.docIds : [];
      if (
        docIds.length === 0 ||
        docIds.length > MAX_DOCS_PER_READ ||
        !docIds.every((id) => typeof id === 'string' && DOC_ID_RE.test(id))
      ) {
        return failure('unknown', `docIds must be 1 to ${MAX_DOCS_PER_READ} Overleaf doc IDs.`);
      }
      const data: LiveSessionReadDocsResponseData = {
        docs: await readDocsInSession(session, docIds as string[]),
      };
      return { ok: true, data };
    }
    case 'LIVE_SESSION_WRITE_DOC': {
      const docId = typeof message.docId === 'string' ? message.docId : '';
      const invalid = validateWriteRequest(docId, message.ops, message.baseVersion);
      if (invalid) return invalid;
      const ops = message.ops as OtOp[];
      const baseVersion = message.baseVersion as number;
      return session.exclusive(() => writeDocInSession(session, docId, ops, baseVersion));
    }
    case 'LIVE_SESSION_CREATE_DOC': {
      const target = parseProjectPath(message.path);
      if (!target.ok) return target;
      if (typeof message.initialContent !== 'string') {
        return failure('unknown', 'initialContent (missing or non-string)');
      }
      const initialContent = message.initialContent;
      return session.exclusive(() => createDocInSession(session, target.data, initialContent));
    }
    case 'LIVE_SESSION_UPLOAD_BINARY': {
      const target = parseProjectPath(message.path);
      if (!target.ok) return target;
      if (typeof message.contentBase64 !== 'string') {
        return failure('unknown', 'contentBase64 (missing or non-string)');
      }
      const bytes = decodeBase64Payload(message.contentBase64);
      if (!bytes.ok) return bytes;
      return session.exclusive(() => uploadBinaryInSession(session, target.data, bytes.data));
    }
    default:
      return failure('unknown', `Unknown session message type: ${String(message.type)}`);
  }
}

// Why a doc read failed, in words for the pull's result rows. The raw error
// names protocol messages; diagnostics log it instead.
function docReadFailureReason(e: unknown): string {
  if (e instanceof BridgeOpError) return e.message;
  if (e instanceof SocketIo09Error) {
    switch (e.kind) {
      case 'server-error':
        return `Overleaf refused to send the doc: ${describeServerError(e.serverError)}`;
      case 'transport':
        return 'The connection to Overleaf dropped';
      case 'timeout':
        return `Overleaf did not send the doc within ${JOIN_DOC_TIMEOUT_MS / 1000} seconds`;
    }
  }
  return 'Overleaf sent the doc in a form this extension cannot read';
}

// Reads distinct docs with a few joinDocs in flight on the session socket.
// No leaveDoc: current Overleaf treats it as a no-op, and on older builds a
// leaveDoc could cancel a joinDoc still in flight on the same socket.
async function readDocsInSession(
  session: ProjectSession,
  docIds: string[],
): Promise<LiveSessionDocRead[]> {
  const unique = Array.from(new Set(docIds));
  const outcomes = new Map<string, LiveSessionDocRead>();
  const readOne = async (docId: string): Promise<void> => {
    try {
      const client = await session.getClient();
      session.dbg(`phase: joinDoc ${docId}`);
      const doc = await joinDoc(client, docId);
      outcomes.set(docId, { docId, ok: true, version: doc.version, text: doc.text });
    } catch (e) {
      session.dbg(`phase: joinDoc ${docId} failed (${errorMessage(e)})`);
      const code = e instanceof BridgeOpError ? e.code : 'document_join_failed';
      outcomes.set(docId, { docId, ok: false, code, message: docReadFailureReason(e) });
    }
  };

  await mapWithConcurrency(unique, READ_DOCS_CONCURRENCY, readOne);

  // One sequential retry for failures: a dropped socket fails every
  // in-flight ack at once, and getClient() reconnects for the retry.
  for (const docId of unique) {
    if (outcomes.get(docId)?.ok !== true) await readOne(docId);
  }
  return unique.map(
    (docId) =>
      outcomes.get(docId) ?? {
        docId,
        ok: false as const,
        code: 'document_join_failed' as const,
        message: 'No read result.',
      },
  );
}

function isOtOp(op: unknown): op is OtOp {
  if (!op || typeof op !== 'object') return false;
  const o = op as { p?: unknown; i?: unknown; d?: unknown };
  if (typeof o.p !== 'number' || !Number.isInteger(o.p) || o.p < 0) return false;
  return (typeof o.i === 'string') !== (typeof o.d === 'string');
}

function validateWriteRequest(
  docId: string,
  ops: unknown,
  baseVersion: unknown,
): BridgeFailure | null {
  if (!DOC_ID_RE.test(docId)) {
    return failure('unknown', `Invalid Overleaf doc ID: ${docId}`);
  }
  if (!Array.isArray(ops) || ops.length === 0) {
    return failure('unknown', 'No operations to apply (ops array is empty).');
  }
  if (!ops.every(isOtOp)) {
    return failure('unknown', 'ops must be { p, i } or { p, d } operations.');
  }
  if (typeof baseVersion !== 'number' || !Number.isInteger(baseVersion) || baseVersion < 0) {
    return failure('unknown', `Invalid baseVersion: ${String(baseVersion)}`);
  }
  return null;
}

type ApplyConfirmation =
  | { kind: 'applied' }
  | { kind: 'rejected'; message: string }
  | { kind: 'closed' }
  | { kind: 'timeout' };

// Overleaf acks applyOtUpdate once the update is queued, not once it is
// applied (services/real-time WebsocketController.applyOtUpdate). Later the
// sender gets `otUpdateApplied` carrying only { v, doc }, or `otUpdateError`
// followed by a disconnect (DocumentUpdaterController). Waiting for one of
// those keeps the verify read from racing the doc-updater queue.
function watchOwnUpdate(
  client: SocketIo09Client,
  docId: string,
  timeoutMs: number,
): { outcome: Promise<ApplyConfirmation>; stop: () => void } {
  let resolveOutcome: (c: ApplyConfirmation) => void = () => {};
  const outcome = new Promise<ApplyConfirmation>((resolve) => {
    resolveOutcome = resolve;
  });
  const cleanup: Array<() => void> = [];
  let done = false;
  const finish = (c: ApplyConfirmation): void => {
    if (done) return;
    done = true;
    for (const fn of cleanup) fn();
    resolveOutcome(c);
  };
  cleanup.push(
    client.on((event) => {
      if (event.name === 'otUpdateApplied') {
        const update = event.args[0] as { doc?: unknown; op?: unknown } | undefined;
        // Collaborators' updates carry `op`; the sender's own comes back bare.
        if (update && update.doc === docId && update.op === undefined) {
          finish({ kind: 'applied' });
        }
      } else if (event.name === 'otUpdateError') {
        const detail = event.args[1] as { doc_id?: unknown } | undefined;
        if (!detail || detail.doc_id === undefined || detail.doc_id === docId) {
          finish({ kind: 'rejected', message: describeServerError(event.args[0]) });
        }
      }
    }),
  );
  cleanup.push(client.onDisconnect(() => finish({ kind: 'closed' })));
  const timer = setTimeout(() => finish({ kind: 'timeout' }), timeoutMs);
  cleanup.push(() => clearTimeout(timer));
  return { outcome, stop: () => finish({ kind: 'timeout' }) };
}

type ApplyOutcome =
  | { kind: 'applied' }
  // No verdict: the connection dropped with the update in flight, the ack
  // timed out, or no confirmation came in time. The update may or may not
  // have been applied; a read decides.
  | { kind: 'unknown' }
  | { kind: 'rejected'; failure: BridgeFailure };

function rejectedOutcome(message: string): ApplyOutcome {
  return {
    kind: 'rejected',
    failure: failure('remote_changed', message, 'Re-read the document, recompute the diff, and retry.'),
  };
}

// Sends one OT update and waits for Overleaf's verdict.
async function applyOtUpdateAndConfirm(
  session: ProjectSession,
  client: SocketIo09Client,
  docId: string,
  ops: OtOp[],
  version: number,
): Promise<ApplyOutcome> {
  const watch = watchOwnUpdate(client, docId, APPLY_CONFIRM_TIMEOUT_MS);
  session.dbg(`phase: applyOtUpdate ${docId} ops=${ops.length} v=${version}`);
  try {
    // Err-first ack, unwrapped by emitWithAck; any err rejects here.
    await client.emitWithAck<unknown[]>(
      'applyOtUpdate',
      [docId, { op: ops, v: version }],
      APPLY_OT_ACK_TIMEOUT_MS,
    );
  } catch (e) {
    watch.stop();
    // Overleaf's own verdicts: an otUpdateError for this doc that arrived
    // before the ack failed, or an error ack.
    const seen = await watch.outcome;
    if (seen.kind === 'rejected') {
      return rejectedOutcome(`Overleaf could not apply the update: ${seen.message}`);
    }
    if (e instanceof SocketIo09Error && e.kind === 'server-error') {
      return rejectedOutcome(`Overleaf refused the change: ${describeServerError(e.serverError)}`);
    }
    // Anything else is a lost connection (or a lost ack), not a rejection.
    // Real-time submits an update even when its sender has disconnected
    // (WebsocketController.applyOtUpdate), and it disconnects this socket
    // after a doc-updater error on ANY doc the socket joined, e.g. one the
    // user is editing. The caller's read on the reconnected socket decides.
    session.dbg(`phase: applyOtUpdate ${docId} -> no verdict (${errorMessage(e)})`);
    return { kind: 'unknown' };
  }
  const confirmation = await watch.outcome;
  session.dbg(`phase: applyOtUpdate ${docId} -> ${confirmation.kind}`);
  if (confirmation.kind === 'rejected') {
    return rejectedOutcome(`Overleaf could not apply the update: ${confirmation.message}`);
  }
  return confirmation.kind === 'applied' ? { kind: 'applied' } : { kind: 'unknown' };
}

// The read after an update. Without Overleaf's confirmation the update may
// still be queued, so while the doc still shows `baseVersion` this reads
// again a few times before answering. The caller holds the project's
// mutation chain throughout, so no other write of this project can start
// from the old version in the meantime.
async function readAfterUpdate(
  session: ProjectSession,
  docId: string,
  baseVersion: number,
  confirmed: boolean,
): Promise<JoinDocResult> {
  let read = await joinDoc(await session.getClient(), docId);
  if (confirmed) return read;
  for (let i = 0; i < UNCONFIRMED_REREADS && read.version === baseVersion; i++) {
    await new Promise((r) => setTimeout(r, UNCONFIRMED_REREAD_DELAY_MS));
    read = await joinDoc(await session.getClient(), docId);
  }
  return read;
}

// Writes one doc. The safety nets, in order:
//   1. joinDoc the target (this also grants the socket write access to it)
//      and refuse unless its version still equals baseVersion, i.e. the doc
//      has not moved since the popup's fresh read and conflict check.
//   2. applyOtUpdate at that version and wait for Overleaf's verdict.
//   3. joinDoc again and return the authoritative text, which the popup
//      compares against the intended content (verify-after-write).
async function writeDocInSession(
  session: ProjectSession,
  docId: string,
  ops: OtOp[],
  baseVersion: number,
): Promise<BridgeResponse<LiveWriteDocResponseData>> {
  let client: SocketIo09Client;
  let preWrite: JoinDocResult;
  try {
    client = await session.getClient();
    session.dbg(`phase: joinDoc ${docId} (pre-write)`);
    preWrite = await joinDoc(client, docId);
  } catch (e) {
    if (e instanceof BridgeOpError) return failureFromError(e, 'document_join_failed');
    session.dbg(`phase: joinDoc ${docId} (pre-write) failed (${errorMessage(e)})`);
    return failure(
      'document_join_failed',
      `Not written: could not read the doc right before writing it (${docReadFailureReason(e)}).`,
      'Refresh the Overleaf tab and retry.',
    );
  }
  if (preWrite.version !== baseVersion) {
    return failure(
      'remote_changed',
      `Document version changed since base (popup saw ${baseVersion}, server is at ${preWrite.version}).`,
      'Re-read the document, recompute the diff, and retry.',
    );
  }

  const applied = await applyOtUpdateAndConfirm(session, client, docId, ops, baseVersion);
  if (applied.kind === 'rejected') return applied.failure;

  let postWrite: JoinDocResult;
  try {
    session.dbg(`phase: joinDoc ${docId} (post-write verify)`);
    postWrite = await readAfterUpdate(session, docId, baseVersion, applied.kind === 'applied');
  } catch (e) {
    session.dbg(`phase: joinDoc ${docId} (post-write verify) failed (${errorMessage(e)})`);
    return failure(
      'document_join_failed',
      `Sent the change, but could not read the doc back to check it (${docReadFailureReason(e)}).`,
      'The change may have landed; check the doc in Overleaf, or run the pull again.',
    );
  }
  if (applied.kind === 'unknown' && postWrite.version === baseVersion) {
    return failure(
      'unknown',
      'The connection to Overleaf was interrupted while this doc was being written, and the doc still shows its old text. Run the pull again to retry it.',
    );
  }
  return {
    ok: true,
    data: { docId, newVersion: postWrite.version, text: postWrite.text },
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Phase-3: create a new doc at a project-relative path. Walks the path
// mkdir-style (POST /project/:id/folder for missing dirs), creates the
// doc (POST /project/:id/doc), then optionally seeds initial content
// via the same applyOtUpdate path the write handler uses.
//
// Wire format references match Workshop's vocabulary:
//   POST /project/:id/folder  body { parent_folder_id, name }  -> { _id, ... }
//   POST /project/:id/doc     body { parent_folder_id, name }  -> { _id, ... }
// Both require CSRF (X-Csrf-Token header) + the user's browser session
// (`credentials: 'include'`). If Overleaf has changed either endpoint
// we surface a typed failure and the worst case is an orphaned empty
// doc — never a destructive overwrite of existing content.
// ──────────────────────────────────────────────────────────────────────────

// A non-2xx answer from an Overleaf REST route. `detail` is the start of the
// response body: Overleaf answers a refused name with HTTP 400 and a plain
// text reason (services/web ErrorController, e.g. "file already exists").
class OverleafHttpError extends Error {
  constructor(
    readonly status: number,
    url: string,
    readonly detail: string,
  ) {
    super(`HTTP ${status} ${url}${detail ? ` — ${detail}` : ''}`);
    this.name = 'OverleafHttpError';
  }
}

async function overleafHttpError(response: Response, url: string): Promise<OverleafHttpError> {
  let detail = '';
  try {
    detail = (await response.text()).slice(0, 200);
  } catch {
    // ignore
  }
  return new OverleafHttpError(response.status, url, detail);
}

// The request got no answer before its deadline. Whatever it asked for may
// still have happened in Overleaf.
class OverleafRequestTimeout extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Overleaf did not answer within ${Math.round(timeoutMs / 1000)} seconds`);
    this.name = 'OverleafRequestTimeout';
  }
}

// Runs one REST call, request and body read, against a deadline. At the
// deadline the request is aborted and the call rejects with an
// OverleafRequestTimeout, even if the fetch has not reacted to the abort.
function withDeadline<T>(timeoutMs: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const timeout = new OverleafRequestTimeout(timeoutMs);
      reject(timeout);
      controller.abort(timeout);
    }, timeoutMs);
  });
  return Promise.race([run(controller.signal), deadline]).finally(() => clearTimeout(timer));
}

async function postOverleafJson<T>(
  url: string,
  body: unknown,
  csrfToken: string,
): Promise<T> {
  return withDeadline(OVERLEAF_REST_TIMEOUT_MS, async (signal) => {
    const response = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-Csrf-Token': csrfToken,
      },
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok) throw await overleafHttpError(response, url);
    return (await response.json()) as T;
  });
}

type ProjectPath = { path: string; filename: string; folderSegments: string[] };

function parseProjectPath(path: unknown): BridgeResponse<ProjectPath> {
  if (typeof path !== 'string' || path.length === 0) {
    return failure('unknown', 'Empty path.');
  }
  if (path.startsWith('/') || path.includes('..') || path.endsWith('/')) {
    return failure(
      'unknown',
      `Invalid path "${path}" — must be project-relative, no leading "/", no "..", no trailing "/".`,
    );
  }
  const segments = path.split('/').filter((s) => s.length > 0);
  if (segments.length === 0) {
    return failure('unknown', 'Empty path.');
  }
  return {
    ok: true,
    data: {
      path,
      filename: segments[segments.length - 1]!,
      folderSegments: segments.slice(0, -1),
    },
  };
}

function decodeBase64Payload(contentBase64: string): BridgeResponse<Uint8Array> {
  try {
    return { ok: true, data: base64ToUint8(contentBase64.replace(/\s+/g, '')) };
  } catch (e) {
    return failure('unknown', `Could not decode base64 payload: ${errorMessage(e)}`);
  }
}

type FolderWalk =
  | { kind: 'done'; result: BridgeResponse<{ folderId: string; folder: WorkshopFolder }> }
  // `folderPath` is the folder Overleaf refused to create; `nameTaken` is
  // set when the reason was a name already in use there.
  | { kind: 'post-failed'; segName: string; folderPath: string; nameTaken: boolean; message: string };

// Overleaf refuses a folder whose name is already used by a doc, file or
// folder in the parent with HTTP 400 "file already exists"
// (ProjectEntityMongoUpdateHandler._checkValidElementName, DuplicateNameError
// in ErrorController). Older builds answered "...already exists" as well.
function isNameTakenError(e: unknown): boolean {
  return e instanceof OverleafHttpError && e.status === 400 && /already exists/i.test(e.detail);
}

// One walk of `folderSegments` down from the project root in the session's
// cached tree, creating missing folders (POST /project/:id/folder) and
// recording them so later creates in the same run reuse them.
async function walkFolderPath(
  session: ProjectSession,
  folderSegments: string[],
  csrfToken: string,
): Promise<FolderWalk> {
  const root = session.project.rootFolder?.[0];
  if (!root || !root._id) {
    return {
      kind: 'done',
      result: failure(
        'project_join_failed',
        'Overleaf sent the project without its top folder, so nothing was added. Reload the Overleaf tab, then run the pull again.',
      ),
    };
  }

  let folderId: string = root._id;
  let folder: WorkshopFolder = root;
  for (let i = 0; i < folderSegments.length; i++) {
    const segName = folderSegments[i]!;
    const existing = (folder.folders ?? []).find((f) => f.name === segName);
    if (existing && existing._id) {
      session.dbg(`mkdir: existing folder "${segName}" id=${existing._id}`);
      folderId = existing._id;
      folder = existing;
      continue;
    }
    session.dbg(`mkdir: creating folder "${segName}" under ${folderId}`);
    let created: { _id?: string; name?: string };
    try {
      created = await postOverleafJson<{ _id?: string; name?: string }>(
        `https://www.overleaf.com/project/${encodeURIComponent(session.projectId)}/folder`,
        { parent_folder_id: folderId, name: segName },
        csrfToken,
      );
    } catch (e) {
      return {
        kind: 'post-failed',
        segName,
        folderPath: folderSegments.slice(0, i + 1).join('/'),
        nameTaken: isNameTakenError(e),
        message: errorMessage(e),
      };
    }
    if (!created._id) {
      return {
        kind: 'done',
        result: failure('unknown', `Folder creation returned no _id for "${segName}".`),
      };
    }
    const newFolder: WorkshopFolder = {
      _id: created._id,
      name: segName,
      folders: [],
      docs: [],
      fileRefs: [],
    };
    (folder.folders ??= []).push(newFolder);
    folderId = created._id;
    folder = newFolder;
  }
  return { kind: 'done', result: { ok: true, data: { folderId, folder } } };
}

// Resolves (and creates as needed) the folder for a new entry. The cached
// tree can be out of date: a rename or move seen on the session socket
// triggers a fresh read first, and a folder POST refused because the name
// is taken (e.g. a folder someone else created during this run) re-reads
// the tree and walks the path again. Every re-read is a joinProject, which
// counts against Overleaf's join limit, so:
//   - a root-level entry never re-reads: the root folder's ID never
//     changes, Overleaf refuses a doc whose name is taken, and an upload
//     checks a fresh listing right before its POST;
//   - other refusals (an invalid name, the project's file limit) do not
//     re-read, since a fresh tree would not change them;
//   - each folder path re-reads at most once per session, because a doc or
//     file with the folder's name is refused the same way and stays.
async function ensureFolderPath(
  session: ProjectSession,
  folderSegments: string[],
  csrfToken: string,
): Promise<BridgeResponse<{ folderId: string; folder: WorkshopFolder }>> {
  if (session.treeMoved && folderSegments.length > 0) {
    try {
      await session.reloadTree();
    } catch (e) {
      const failed = failureFromError(e, 'project_join_failed', JOIN_FAILED_RECOVERY);
      return {
        ...failed,
        message: `A folder was renamed or moved in Overleaf during this pull, and reading the project's folders again failed: ${failed.message}`,
      };
    }
  }
  for (;;) {
    const walk = await walkFolderPath(session, folderSegments, csrfToken);
    if (walk.kind === 'done') return walk.result;
    if (!walk.nameTaken || !session.claimFolderReread(walk.folderPath)) {
      return failure('unknown', `Folder creation failed for "${walk.segName}": ${walk.message}`);
    }
    try {
      await session.reloadTree();
    } catch (e) {
      return failure(
        'unknown',
        `Folder creation failed for "${walk.segName}" (${walk.message}), and re-reading the project failed: ${errorMessage(e)}`,
      );
    }
  }
}

async function createDocInSession(
  session: ProjectSession,
  target: ProjectPath,
  initialContent: string,
): Promise<BridgeResponse<LiveCreateDocResponseData>> {
  const { path, filename, folderSegments } = target;
  const csrfToken = extractCsrfFromDocument();
  if (!csrfToken) {
    return failure(
      'protocol_unavailable',
      'CSRF token not found in the Overleaf project page.',
      'Refresh the Overleaf tab and try again.',
    );
  }

  // The socket must work before anything is created: the content is seeded
  // over it, and a broken session (rejected reconnect, join rate limit,
  // reconnects used up) would otherwise leave an empty doc for every
  // remaining create. Empty creates check too, so a working socket keeps
  // the cached tree current (ProjectSession.treeMoved) for ensureFolderPath.
  // On failure the original code goes back unchanged and nothing is created.
  try {
    await session.getClient();
  } catch (e) {
    return failureFromError(e, 'socket_connection_failed');
  }

  const parent = await ensureFolderPath(session, folderSegments, csrfToken);
  if (!parent.ok) return parent;
  const { folderId, folder } = parent.data;

  if ((folder.docs ?? []).some((d) => d.name === filename)) {
    return failure(
      'unknown',
      `Document already exists at "${path}". Use write-back instead of create.`,
    );
  }
  if ((folder.fileRefs ?? []).some((f) => f.name === filename)) {
    return failure(
      'unknown',
      `A non-doc file already exists at "${path}". Refusing to create a doc with the same name.`,
    );
  }

  session.dbg(`creating doc "${filename}" in folder ${folderId}`);
  let createdDoc: { _id?: string; name?: string };
  try {
    createdDoc = await postOverleafJson<{ _id?: string; name?: string }>(
      `https://www.overleaf.com/project/${encodeURIComponent(session.projectId)}/doc`,
      { parent_folder_id: folderId, name: filename },
      csrfToken,
    );
  } catch (e) {
    if (e instanceof OverleafRequestTimeout) {
      return failure(
        'unknown',
        `${e.message}, so it is unknown whether this doc was created. Run the pull again to check.`,
      );
    }
    return failure('unknown', `Doc creation failed for "${filename}": ${errorMessage(e)}`);
  }
  if (!createdDoc._id) {
    return failure('unknown', `Doc creation returned no _id for "${filename}".`);
  }
  const newDocId = createdDoc._id;
  // Record it so a later create or upload in this session sees it.
  (folder.docs ??= []).push({ _id: newDocId, name: filename });

  if (initialContent.length === 0) {
    return {
      ok: true,
      data: { docId: newDocId, path, version: 0, text: '' },
    };
  }

  // Give the server a brief grace window — a freshly-created doc isn't
  // always immediately addressable on the realtime channel.
  await new Promise((r) => setTimeout(r, 250));

  let client: SocketIo09Client;
  let initial: JoinDocResult;
  try {
    client = await session.getClient();
    session.dbg(`joinDoc ${newDocId} (initial seed)`);
    initial = await joinDoc(client, newDocId);
  } catch (e) {
    session.dbg(`joinDoc ${newDocId} (initial seed) failed (${errorMessage(e)})`);
    return failure(
      'document_join_failed',
      `Doc created, but its content could not be added: reading the new doc failed (${docReadFailureReason(e).replace(/\.$/, '')}). The doc exists in Overleaf but is empty; run the pull again to fill it in.`,
      'Run the pull again, or paste the content into the new doc in Overleaf.',
    );
  }
  if (initial.text !== '') {
    return failure(
      'unknown',
      `New doc is unexpectedly non-empty (length ${initial.text.length}). Refusing to overwrite to avoid clobbering content.`,
    );
  }

  const seeded = await applyOtUpdateAndConfirm(
    session,
    client,
    newDocId,
    [{ p: 0, i: initialContent }],
    initial.version,
  );
  if (seeded.kind === 'rejected') {
    return failure(
      'unknown',
      `Doc created but initial content insert failed: ${seeded.failure.message}. The doc exists but is empty.`,
      'Re-run the pull, or paste content into the doc manually.',
    );
  }

  let verify: JoinDocResult;
  try {
    session.dbg(`joinDoc ${newDocId} (verify seed)`);
    verify = await readAfterUpdate(session, newDocId, initial.version, seeded.kind === 'applied');
  } catch (e) {
    session.dbg(`joinDoc ${newDocId} (verify seed) failed (${errorMessage(e)})`);
    return failure(
      'document_join_failed',
      `Doc created and its content sent, but reading it back to check it failed (${docReadFailureReason(e).replace(/\.$/, '')}). Check the doc in Overleaf, or run the pull again.`,
    );
  }
  if (verify.text !== initialContent) {
    return failure(
      'unknown',
      `Doc created, but reading it back showed different content (${verify.text.length} characters in Overleaf, ${initialContent.length} expected). Check the doc in Overleaf.`,
    );
  }

  return {
    ok: true,
    data: { docId: newDocId, path, version: verify.version, text: verify.text },
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Phase-3: upload a binary file to a project-relative path. Walks the
// path mkdir-style and POSTs the bytes via multipart to the upload
// endpoint Overleaf uses for its drag-drop file uploader.
//
// First cut intentionally refuses to replace an existing file at the
// same path — a separate replace path (PUT-style, or DELETE+POST) is
// safer to add as its own slice once basic upload is validated. The
// safety story is therefore the same as create-doc: failures leave
// either no change (refused before any POST) or one extra fileRef in
// Overleaf (POST succeeded but our local tracking didn't pick up the
// new id), never destructive overwrite of existing content.
//
// Wire format guess (fineuploader convention used by Workshop):
//   POST /project/:id/upload?folder_id=<parentFolderId>
//   Headers: X-Csrf-Token
//   Body: multipart/form-data with fields:
//     qqfile          file blob
//     qqfilename      filename string
//     qquuid          client-generated UUID
//     qqtotalfilesize byte count
//   Response JSON shape varies; we look for { entity_id } or { _id }.
// ──────────────────────────────────────────────────────────────────────────

function mimeForFilename(name: string): string {
  const idx = name.lastIndexOf('.');
  const ext = idx >= 0 ? name.substring(idx).toLowerCase() : '';
  switch (ext) {
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.gif':
      return 'image/gif';
    case '.webp':
      return 'image/webp';
    case '.bmp':
      return 'image/bmp';
    case '.svg':
      return 'image/svg+xml';
    case '.tiff':
    case '.tif':
      return 'image/tiff';
    case '.pdf':
      return 'application/pdf';
    case '.eps':
      return 'application/postscript';
    case '.zip':
      return 'application/zip';
    case '.csv':
      return 'text/csv';
    default:
      return 'application/octet-stream';
  }
}

async function postOverleafMultipartUpload(
  projectId: string,
  parentFolderId: string,
  filename: string,
  bytes: Uint8Array,
  csrfToken: string,
): Promise<{ fileId: string }> {
  // Copy into a fresh ArrayBuffer-backed Uint8Array so TS's strict
  // SharedArrayBuffer-vs-ArrayBuffer split is satisfied for the Blob
  // constructor. The .slice() also unanchors from any pooled buffer
  // the caller's bytes may have been a view into.
  const fresh = new Uint8Array(bytes.byteLength);
  fresh.set(bytes);
  // Type the blob with the actual MIME we can infer from the filename
  // extension. Overleaf's upload validator does its own content sniffing
  // either way, but sending a sensible Content-Type can't hurt and may
  // satisfy strict-mode checks on newer builds.
  const mimeType = mimeForFilename(filename);
  const blob = new Blob([fresh.buffer], { type: mimeType });
  const form = new FormData();
  // Field shape captured from current Overleaf's own upload UI. Earlier
  // guesses (qqfilename / qquuid / qqtotalfilesize / folder_id) were
  // wrong — the route's content sniffer rejected with "invalid_filename"
  // until the field names matched what their drag-drop sends.
  //   relativePath:   literal string "null" for a non-folder-tree upload
  //   targetFolderId: parent folder _id (same value as URL ?folder_id=)
  //   name:           leaf filename
  //   type:           MIME type
  //   qqfile:         the binary content blob (filename + Content-Type
  //                   set automatically by FormData.append)
  form.append('relativePath', 'null');
  form.append('targetFolderId', parentFolderId);
  form.append('name', filename);
  form.append('type', mimeType);
  form.append('qqfile', blob, filename);

  const url = `https://www.overleaf.com/project/${encodeURIComponent(
    projectId,
  )}/upload?folder_id=${encodeURIComponent(parentFolderId)}`;

  const timeoutMs =
    UPLOAD_POST_BASE_TIMEOUT_MS + Math.ceil(bytes.byteLength / UPLOAD_POST_BYTES_PER_SECOND) * 1_000;
  const body = await withDeadline(timeoutMs, async (signal) => {
    const response = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: {
        // Do NOT set Content-Type — the browser fills in the multipart
        // boundary automatically when body is a FormData.
        'X-Csrf-Token': csrfToken,
        // Many web frameworks (Overleaf included) gate the upload route
        // behind an XHR-only check as a CSRF/scraping defense. Without
        // this header the server can reject with a generic-looking
        // `invalid_filename` rather than the more obvious "not an AJAX
        // request" error.
        'X-Requested-With': 'XMLHttpRequest',
        Accept: 'application/json',
      },
      body: form,
      signal,
    });

    if (!response.ok) throw await overleafHttpError(response, url);

    try {
      return (await response.json()) as unknown;
    } catch (e) {
      if (signal.aborted) throw e;
      throw new Error(`Upload response was not JSON: ${e instanceof Error ? e.message : String(e)}`);
    }
  });
  const obj = body as { entity_id?: string; _id?: string; success?: boolean };
  const fileId = obj.entity_id ?? obj._id;
  if (!fileId) {
    throw new Error(`Upload response had no entity_id / _id: ${JSON.stringify(body).slice(0, 200)}`);
  }
  return { fileId };
}

// Fresh list of every doc and file path in the project, read from
// Overleaf's database at call time (services/web
// ProjectController.projectEntitiesJson, GET /project/:id/entities:
// { project_id, entities: [{ path: '/main.tex', type: 'doc' | 'file' }] }).
// A plain REST read, so it does not count against the project-join limit.
// Throws on anything unexpected; callers treat that as "not confirmed".
async function fetchProjectEntityPaths(
  projectId: string,
  csrfToken: string,
): Promise<Map<string, string>> {
  const url = `https://www.overleaf.com/project/${encodeURIComponent(projectId)}/entities`;
  const body = await withDeadline(OVERLEAF_REST_TIMEOUT_MS, async (signal) => {
    const response = await fetch(url, {
      method: 'GET',
      credentials: 'include',
      cache: 'no-store',
      headers: { Accept: 'application/json', 'X-Csrf-Token': csrfToken },
      signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return (await response.json()) as { entities?: unknown } | null;
  });
  const raw = body?.entities;
  if (!Array.isArray(raw)) throw new Error('the project listing has an unexpected shape');
  const out = new Map<string, string>();
  for (const entry of raw) {
    const e = entry as { path?: unknown; type?: unknown } | null;
    // Fail closed: an entry we cannot read could be the target path.
    if (!e || typeof e.path !== 'string' || typeof e.type !== 'string') {
      throw new Error('the project listing has an unreadable entry');
    }
    out.set(e.path.replace(/^\/+/, ''), e.type);
  }
  return out;
}

// Create-only. Overleaf's upload route REPLACES an existing doc or file of
// the same name (ProjectUploadController.uploadFile adds the entity with
// replace=true), so this function is the only guard. The session's tree can
// be minutes old by the time a pull reaches its uploads, so right before the
// POST it asks Overleaf for the current listing and refuses if the path is
// taken, or if the listing cannot be read. The session socket must be up
// first: a reconnect refreshes the tree, and a live socket is what reports
// folder renames and moves (ProjectSession.treeMoved).
async function uploadBinaryInSession(
  session: ProjectSession,
  target: ProjectPath,
  bytes: Uint8Array,
): Promise<BridgeResponse<LiveUploadBinaryResponseData>> {
  const { path, filename, folderSegments } = target;
  const csrfToken = extractCsrfFromDocument();
  if (!csrfToken) {
    return failure(
      'protocol_unavailable',
      'CSRF token not found in the Overleaf project page.',
      'Refresh the Overleaf tab and try again.',
    );
  }

  try {
    await session.getClient();
  } catch (e) {
    return failureFromError(e, 'socket_connection_failed');
  }

  const parent = await ensureFolderPath(session, folderSegments, csrfToken);
  if (!parent.ok) return parent;
  const { folderId, folder } = parent.data;

  // The cached tree already knows about entries that existed when the
  // session opened and the ones this session added.
  if ((folder.docs ?? []).some((d) => d.name === filename)) {
    return failure(
      'already_exists',
      `A doc already exists at "${path}" in Overleaf, so this file was not uploaded.`,
    );
  }
  if ((folder.fileRefs ?? []).some((f) => f.name === filename)) {
    return failure(
      'already_exists',
      `A file already exists at "${path}" in Overleaf, so it was not uploaded.`,
    );
  }

  let current: Map<string, string>;
  try {
    current = await fetchProjectEntityPaths(session.projectId, csrfToken);
  } catch (e) {
    return failure(
      'write_back_not_safe',
      `Not uploaded: could not check with Overleaf whether "${path}" already exists (${errorMessage(e)}).`,
      'Run the pull again. If it keeps happening, reload the Overleaf tab.',
    );
  }
  const taken = current.get(path);
  if (taken !== undefined) {
    return failure(
      'already_exists',
      `A ${taken === 'doc' ? 'doc' : 'file'} already exists at "${path}" in Overleaf, so this file was not uploaded.`,
    );
  }

  session.dbg(`uploading binary "${filename}" (${bytes.length} bytes) to folder ${folderId}`);
  let uploaded: { fileId: string };
  try {
    uploaded = await postOverleafMultipartUpload(
      session.projectId,
      folderId,
      filename,
      bytes,
      csrfToken,
    );
  } catch (e) {
    if (e instanceof OverleafRequestTimeout) {
      return failure(
        'unknown',
        `${e.message}, so it is unknown whether this file was uploaded. Run the pull again to check.`,
      );
    }
    return failure('unknown', `Binary upload failed for "${filename}": ${errorMessage(e)}`);
  }
  // Record it so a later create or upload in this session sees it.
  (folder.fileRefs ??= []).push({ _id: uploaded.fileId, name: filename });

  return {
    ok: true,
    data: { fileId: uploaded.fileId, path, sizeBytes: bytes.length },
  };
}

// ──────────────────────────────────────────────────────────────────────────
// One-shot handlers for the original per-call messages: open a session,
// run one operation, close it. The pull uses LIVE_SESSION_* instead; the
// Options write-back test still reads through these.
// ──────────────────────────────────────────────────────────────────────────

async function withOneShotSession<T>(
  projectId: string,
  run: (session: ProjectSession) => Promise<BridgeResponse<T>>,
): Promise<BridgeResponse<T>> {
  let session: ProjectSession;
  try {
    session = await ProjectSession.open(projectId, 'one-shot', null);
  } catch (e) {
    return failureFromError(e, 'project_join_failed', JOIN_FAILED_RECOVERY);
  }
  try {
    return await run(session);
  } finally {
    session.close();
  }
}

export async function handleLiveFetchProjectMetadata(
  projectId: string,
): Promise<BridgeResponse<LiveProjectMetadataResponseData>> {
  return withOneShotSession(projectId, async (session) => {
    session.dbg('phase: metadata-only return');
    return {
      ok: true,
      data: {
        projectId,
        rootFolder: session.project.rootFolder ?? [],
        name: session.project.name,
      },
    };
  });
}

export async function handleLiveReadDoc(
  projectId: string,
  docId: string,
): Promise<BridgeResponse<LiveReadDocResponseData>> {
  if (!DOC_ID_RE.test(docId)) {
    return failure('unknown', `Invalid Overleaf doc ID: ${docId}`);
  }
  return withOneShotSession(projectId, async (session) => {
    try {
      session.dbg(`phase: joinDoc ${docId}`);
      const result = await joinDoc(await session.getClient(), docId);
      return {
        ok: true,
        data: { docId, version: result.version, text: result.text },
      };
    } catch (e) {
      return failureFromError(
        e,
        'document_join_failed',
        'Refresh the Overleaf tab and retry, or fall back to the ZIP route.',
      );
    }
  });
}

export async function handleLiveWriteDoc(
  projectId: string,
  docId: string,
  ops: OtOp[],
  baseVersion: number,
): Promise<BridgeResponse<LiveWriteDocResponseData>> {
  const invalid = validateWriteRequest(docId, ops, baseVersion);
  if (invalid) return invalid;
  return withOneShotSession(projectId, (session) =>
    session.exclusive(() => writeDocInSession(session, docId, ops, baseVersion)),
  );
}

export async function handleLiveCreateDocAtPath(
  projectId: string,
  path: string,
  initialContent: string,
): Promise<BridgeResponse<LiveCreateDocResponseData>> {
  const target = parseProjectPath(path);
  if (!target.ok) return target;
  return withOneShotSession(projectId, (session) =>
    session.exclusive(() => createDocInSession(session, target.data, initialContent)),
  );
}

export async function handleLiveUploadBinary(
  projectId: string,
  path: string,
  contentBase64: string,
): Promise<BridgeResponse<LiveUploadBinaryResponseData>> {
  const target = parseProjectPath(path);
  if (!target.ok) return target;
  const bytes = decodeBase64Payload(contentBase64);
  if (!bytes.ok) return bytes;
  return withOneShotSession(projectId, (session) =>
    session.exclusive(() => uploadBinaryInSession(session, target.data, bytes.data)),
  );
}
