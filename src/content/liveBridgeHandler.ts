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

// Overleaf transmits doc lines as a JS string whose code units encode the
// document bytes in latin1 (a.k.a. ISO-8859-1). To recover the original
// UTF-8 text we have to map every code unit back to a byte, then decode
// that byte array as UTF-8. Workshop's `decodePackedUtf8` does the same
// trick on Node Buffers — here it's TextDecoder.
function decodePackedUtf8(line: string): string {
  const bytes = new Uint8Array(line.length);
  for (let i = 0; i < line.length; i++) {
    bytes[i] = line.charCodeAt(i) & 0xff;
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
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
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
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

    const timer = setTimeout(() => {
      settle(() => reject(new Error(`joinProject did not respond within ${JOIN_PROJECT_TIMEOUT_MS}ms`)));
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
  const lines = linesRaw.map((l) =>
    typeof l === 'string' ? decodePackedUtf8(l) : '',
  );
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
// Phase-1 write-back bridge handlers (read + metadata real, write stubbed).
//
// These reuse the same connect+joinProject machinery as handleLiveFetchSnapshot
// but expose finer-grained primitives so the popup-side write-back path can
// drive an individual doc read/write rather than always pulling the whole
// project. The actual OT applyUpdate wire-format work lives in a later
// slice — handleLiveWriteDoc is intentionally a stub here.
// ──────────────────────────────────────────────────────────────────────────

type OpenedSession = {
  client: SocketIo09Client;
  project: WorkshopProject;
  dbg: (msg: string) => void;
};

// All the connect+joinProject boilerplate, returned as a typed
// BridgeResponse so callers can early-return on failure with the same
// shape the popup already handles. On success the caller is responsible
// for calling `client.disconnect()` (use a try/finally).
async function openProjectSession(
  projectId: string,
): Promise<BridgeResponse<OpenedSession>> {
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

  const csrfToken = extractCsrfFromDocument();
  if (!csrfToken) {
    return failure(
      'protocol_unavailable',
      'CSRF token not found in this project page (no <meta name="ol-csrfToken">). Page layout may have changed.',
      'Refresh the Overleaf tab and try again.',
    );
  }

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
    debug: diagnosticsEnabled,
  });

  dbg('phase: connecting');
  try {
    await client.connect();
  } catch (e) {
    const msg =
      e instanceof SocketIo09Error ? e.message : e instanceof Error ? e.message : String(e);
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

  return {
    ok: true,
    data: { client, project: projectResult.project, dbg },
  };
}

export async function handleLiveFetchProjectMetadata(
  projectId: string,
): Promise<BridgeResponse<LiveProjectMetadataResponseData>> {
  const session = await openProjectSession(projectId);
  if (!session.ok) return session;
  const { client, project, dbg } = session.data;
  try {
    dbg('phase: metadata-only return');
    return {
      ok: true,
      data: {
        projectId,
        rootFolder: project.rootFolder ?? [],
        name: project.name,
      },
    };
  } finally {
    client.disconnect();
  }
}

export async function handleLiveReadDoc(
  projectId: string,
  docId: string,
): Promise<BridgeResponse<LiveReadDocResponseData>> {
  if (!/^[a-zA-Z0-9]+$/.test(docId)) {
    return failure('unknown', `Invalid Overleaf doc ID: ${docId}`);
  }
  const session = await openProjectSession(projectId);
  if (!session.ok) return session;
  const { client, dbg } = session.data;
  try {
    dbg(`phase: joinDoc ${docId}`);
    const result = await joinDoc(client, docId);
    // Best-effort: tell the server we're done so it doesn't keep pushing
    // OT updates we won't consume. Mirrors handleLiveFetchSnapshot.
    try {
      client.emit('leaveDoc', docId);
    } catch {
      // ignore
    }
    return {
      ok: true,
      data: { docId, version: result.version, text: result.text },
    };
  } catch (e) {
    return failure(
      'document_join_failed',
      e instanceof Error ? e.message : String(e),
      'Refresh the Overleaf tab and retry, or fall back to the ZIP route.',
    );
  } finally {
    client.disconnect();
  }
}

// Send a single OT update over the live socket. Wire vocabulary
// (`applyOtUpdate`, `[docId, { op, v }]`, err-first ack) is established
// in Overleaf's published Socket.IO protocol and matches what Overleaf
// Workshop uses. Concrete safety nets:
//
//   1. joinDoc the target first to acquire the doc lock and read the
//      current version. If currentVersion !== baseVersion, refuse — the
//      doc moved since the popup computed its diff.
//   2. Emit applyOtUpdate with the err-first ack convention the rest
//      of the codebase relies on. Any server-side err shape is surfaced
//      verbatim as `remote_changed` so the popup can prompt re-read.
//   3. Re-joinDoc to fetch the authoritative post-write version+text.
//      The popup then runs the existing verify check (`after.text ===
//      candidate.newText`) before declaring success. Silent corruption
//      requires both the server AND the verify-read to lie — extremely
//      unlikely.
export async function handleLiveWriteDoc(
  projectId: string,
  docId: string,
  ops: OtOp[],
  baseVersion: number,
): Promise<BridgeResponse<LiveWriteDocResponseData>> {
  if (!/^[a-zA-Z0-9]+$/.test(docId)) {
    return failure('unknown', `Invalid Overleaf doc ID: ${docId}`);
  }
  if (!Array.isArray(ops) || ops.length === 0) {
    return failure('unknown', 'No operations to apply (ops array is empty).');
  }
  if (!Number.isInteger(baseVersion) || baseVersion < 0) {
    return failure('unknown', `Invalid baseVersion: ${baseVersion}`);
  }

  const session = await openProjectSession(projectId);
  if (!session.ok) return session;
  const { client, dbg } = session.data;

  try {
    // 1. Acquire the doc + verify version.
    dbg(`phase: joinDoc ${docId} (pre-write)`);
    let preWrite: JoinDocResult;
    try {
      preWrite = await joinDoc(client, docId);
    } catch (e) {
      return failure(
        'document_join_failed',
        `Could not joinDoc ${docId} before write: ${e instanceof Error ? e.message : String(e)}`,
        'Refresh the Overleaf tab and retry.',
      );
    }
    if (preWrite.version !== baseVersion) {
      // best-effort cleanup
      try { client.emit('leaveDoc', docId); } catch { /* ignore */ }
      return failure(
        'remote_changed',
        `Document version changed since base (popup saw ${baseVersion}, server is at ${preWrite.version}).`,
        'Re-read the document, recompute the diff, and retry.',
      );
    }

    // 2. Apply the update. Err-first ack convention matches the rest of
    //    the socket client; any err object becomes a rejection here.
    dbg(`phase: applyOtUpdate ${docId} ops=${ops.length} v=${baseVersion}`);
    try {
      await client.emitWithAck<unknown[]>(
        'applyOtUpdate',
        [docId, { op: ops, v: baseVersion }],
        20_000,
      );
    } catch (e) {
      try { client.emit('leaveDoc', docId); } catch { /* ignore */ }
      const msg = e instanceof Error ? e.message : String(e);
      return failure(
        'remote_changed',
        `Overleaf rejected applyOtUpdate: ${msg}`,
        'Re-read the document, recompute the diff, and retry.',
      );
    }

    // 3. Leave + re-join to read the authoritative post-write state.
    try { client.emit('leaveDoc', docId); } catch { /* ignore */ }
    dbg(`phase: joinDoc ${docId} (post-write verify)`);
    let postWrite: JoinDocResult;
    try {
      postWrite = await joinDoc(client, docId);
    } catch (e) {
      return failure(
        'document_join_failed',
        `Wrote update but could not re-read for verification: ${e instanceof Error ? e.message : String(e)}`,
        'The write may have landed; reopen the Overleaf tab and inspect.',
      );
    }
    try { client.emit('leaveDoc', docId); } catch { /* ignore */ }

    return {
      ok: true,
      data: { docId, newVersion: postWrite.version, text: postWrite.text },
    };
  } finally {
    client.disconnect();
  }
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

async function postOverleafJson<T>(
  url: string,
  body: unknown,
  csrfToken: string,
): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-Csrf-Token': csrfToken,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    let detail = '';
    try {
      detail = (await response.text()).slice(0, 200);
    } catch {
      // ignore
    }
    throw new Error(`HTTP ${response.status} ${url}${detail ? ` — ${detail}` : ''}`);
  }
  return (await response.json()) as T;
}

export async function handleLiveCreateDocAtPath(
  projectId: string,
  path: string,
  initialContent: string,
): Promise<BridgeResponse<LiveCreateDocResponseData>> {
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
  const filename = segments[segments.length - 1]!;
  const folderSegments = segments.slice(0, -1);

  const csrfToken = extractCsrfFromDocument();
  if (!csrfToken) {
    return failure(
      'protocol_unavailable',
      'CSRF token not found in the Overleaf project page.',
      'Refresh the Overleaf tab and try again.',
    );
  }

  const session = await openProjectSession(projectId);
  if (!session.ok) return session;
  const { client, project, dbg } = session.data;

  try {
    const root = project.rootFolder?.[0];
    if (!root || !root._id) {
      return failure(
        'project_join_failed',
        'joinProject did not return a usable rootFolder._id.',
      );
    }

    let currentFolderId: string = root._id;
    let currentFolder: WorkshopFolder = root;

    for (const segName of folderSegments) {
      const existing = (currentFolder.folders ?? []).find((f) => f.name === segName);
      if (existing && existing._id) {
        dbg(`mkdir: existing folder "${segName}" id=${existing._id}`);
        currentFolderId = existing._id;
        currentFolder = existing;
        continue;
      }
      dbg(`mkdir: creating folder "${segName}" under ${currentFolderId}`);
      let created: { _id?: string; name?: string };
      try {
        created = await postOverleafJson<{ _id?: string; name?: string }>(
          `https://www.overleaf.com/project/${encodeURIComponent(projectId)}/folder`,
          { parent_folder_id: currentFolderId, name: segName },
          csrfToken,
        );
      } catch (e) {
        return failure(
          'unknown',
          `Folder creation failed for "${segName}": ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      if (!created._id) {
        return failure('unknown', `Folder creation returned no _id for "${segName}".`);
      }
      const newFolder: WorkshopFolder = {
        _id: created._id,
        name: segName,
        folders: [],
        docs: [],
        fileRefs: [],
      };
      (currentFolder.folders ??= []).push(newFolder);
      currentFolderId = created._id;
      currentFolder = newFolder;
    }

    const existingDoc = (currentFolder.docs ?? []).find((d) => d.name === filename);
    if (existingDoc) {
      return failure(
        'unknown',
        `Document already exists at "${path}". Use write-back instead of create.`,
      );
    }
    const existingFile = (currentFolder.fileRefs ?? []).find((f) => f.name === filename);
    if (existingFile) {
      return failure(
        'unknown',
        `A non-doc file already exists at "${path}". Refusing to create a doc with the same name.`,
      );
    }

    dbg(`creating doc "${filename}" in folder ${currentFolderId}`);
    let createdDoc: { _id?: string; name?: string };
    try {
      createdDoc = await postOverleafJson<{ _id?: string; name?: string }>(
        `https://www.overleaf.com/project/${encodeURIComponent(projectId)}/doc`,
        { parent_folder_id: currentFolderId, name: filename },
        csrfToken,
      );
    } catch (e) {
      return failure(
        'unknown',
        `Doc creation failed for "${filename}": ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    if (!createdDoc._id) {
      return failure('unknown', `Doc creation returned no _id for "${filename}".`);
    }
    const newDocId = createdDoc._id;

    if (initialContent.length === 0) {
      return {
        ok: true,
        data: { docId: newDocId, path, version: 0, text: '' },
      };
    }

    // Give the server a brief grace window — a freshly-created doc isn't
    // always immediately addressable on the realtime channel.
    await new Promise((r) => setTimeout(r, 250));

    dbg(`joinDoc ${newDocId} (initial seed)`);
    let initial: JoinDocResult;
    try {
      initial = await joinDoc(client, newDocId);
    } catch (e) {
      return failure(
        'document_join_failed',
        `Doc created but joinDoc failed for content seed: ${e instanceof Error ? e.message : String(e)}. The doc exists but is empty.`,
        'Open the Overleaf tab and paste content into the new doc manually.',
      );
    }
    if (initial.text !== '') {
      try { client.emit('leaveDoc', newDocId); } catch { /* ignore */ }
      return failure(
        'unknown',
        `New doc is unexpectedly non-empty (length ${initial.text.length}). Refusing to overwrite to avoid clobbering content.`,
      );
    }

    dbg(`applyOtUpdate ${newDocId} insert len=${initialContent.length} v=${initial.version}`);
    try {
      await client.emitWithAck<unknown[]>(
        'applyOtUpdate',
        [newDocId, { op: [{ p: 0, i: initialContent }], v: initial.version }],
        20_000,
      );
    } catch (e) {
      try { client.emit('leaveDoc', newDocId); } catch { /* ignore */ }
      return failure(
        'unknown',
        `Doc created but initial content insert failed: ${e instanceof Error ? e.message : String(e)}. The doc exists but is empty.`,
        'Re-run the pull, or paste content into the doc manually.',
      );
    }

    try { client.emit('leaveDoc', newDocId); } catch { /* ignore */ }

    dbg(`joinDoc ${newDocId} (verify seed)`);
    let verify: JoinDocResult;
    try {
      verify = await joinDoc(client, newDocId);
    } catch (e) {
      return failure(
        'document_join_failed',
        `Doc created and content sent, but verify-read failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    try { client.emit('leaveDoc', newDocId); } catch { /* ignore */ }

    if (verify.text !== initialContent) {
      return failure(
        'unknown',
        `Doc created but verify-read returned different content (server len ${verify.text.length} vs expected ${initialContent.length}).`,
      );
    }

    return {
      ok: true,
      data: { docId: newDocId, path, version: verify.version, text: verify.text },
    };
  } finally {
    client.disconnect();
  }
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

function generateUuid(): string {
  // crypto.randomUUID is widely available in content-script contexts now.
  // Fallback included just to stay defensive on older Chromes.
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // RFC4122-ish fallback; non-cryptographic but the server treats it as
  // a deduplication token, not an identity.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.floor(Math.random() * 16);
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

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
  const blob = new Blob([fresh.buffer], { type: mimeForFilename(filename) });
  const form = new FormData();
  form.append('qqfile', blob, filename);
  form.append('qqfilename', filename);
  form.append('qquuid', generateUuid());
  form.append('qqtotalfilesize', String(bytes.length));
  // Belt-and-braces: also send folder_id in the form body. Some
  // Overleaf builds read it from req.body rather than req.query, and
  // sending both is harmless.
  form.append('folder_id', parentFolderId);

  const url = `https://www.overleaf.com/project/${encodeURIComponent(
    projectId,
  )}/upload?folder_id=${encodeURIComponent(parentFolderId)}`;

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
  });

  if (!response.ok) {
    let detail = '';
    try {
      detail = (await response.text()).slice(0, 200);
    } catch {
      // ignore
    }
    throw new Error(`HTTP ${response.status} ${url}${detail ? ` — ${detail}` : ''}`);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (e) {
    throw new Error(`Upload response was not JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  const obj = body as { entity_id?: string; _id?: string; success?: boolean };
  const fileId = obj.entity_id ?? obj._id;
  if (!fileId) {
    throw new Error(`Upload response had no entity_id / _id: ${JSON.stringify(body).slice(0, 200)}`);
  }
  return { fileId };
}

export async function handleLiveUploadBinary(
  projectId: string,
  path: string,
  contentBase64: string,
): Promise<BridgeResponse<LiveUploadBinaryResponseData>> {
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
  const filename = segments[segments.length - 1]!;
  const folderSegments = segments.slice(0, -1);

  let bytes: Uint8Array;
  try {
    bytes = base64ToUint8(contentBase64.replace(/\s+/g, ''));
  } catch (e) {
    return failure(
      'unknown',
      `Could not decode base64 payload: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  const csrfToken = extractCsrfFromDocument();
  if (!csrfToken) {
    return failure(
      'protocol_unavailable',
      'CSRF token not found in the Overleaf project page.',
      'Refresh the Overleaf tab and try again.',
    );
  }

  // We still need joinProject to resolve the rootFolder tree even
  // though the actual upload is REST. mkdir-folder walks share the
  // same shape as create-doc above.
  const session = await openProjectSession(projectId);
  if (!session.ok) return session;
  const { client, project, dbg } = session.data;

  try {
    const root = project.rootFolder?.[0];
    if (!root || !root._id) {
      return failure(
        'project_join_failed',
        'joinProject did not return a usable rootFolder._id.',
      );
    }

    let currentFolderId: string = root._id;
    let currentFolder: WorkshopFolder = root;

    for (const segName of folderSegments) {
      const existing = (currentFolder.folders ?? []).find((f) => f.name === segName);
      if (existing && existing._id) {
        dbg(`upload mkdir: existing folder "${segName}" id=${existing._id}`);
        currentFolderId = existing._id;
        currentFolder = existing;
        continue;
      }
      dbg(`upload mkdir: creating folder "${segName}" under ${currentFolderId}`);
      let created: { _id?: string };
      try {
        created = await postOverleafJson<{ _id?: string }>(
          `https://www.overleaf.com/project/${encodeURIComponent(projectId)}/folder`,
          { parent_folder_id: currentFolderId, name: segName },
          csrfToken,
        );
      } catch (e) {
        return failure(
          'unknown',
          `Folder creation failed for "${segName}": ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      if (!created._id) {
        return failure('unknown', `Folder creation returned no _id for "${segName}".`);
      }
      const newFolder: WorkshopFolder = {
        _id: created._id,
        name: segName,
        folders: [],
        docs: [],
        fileRefs: [],
      };
      (currentFolder.folders ??= []).push(newFolder);
      currentFolderId = created._id;
      currentFolder = newFolder;
    }

    // Refuse to replace an existing fileRef or shadow a doc.
    const existingDoc = (currentFolder.docs ?? []).find((d) => d.name === filename);
    if (existingDoc) {
      return failure(
        'unknown',
        `A doc already exists at "${path}". Refusing to upload a binary with the same name.`,
      );
    }
    const existingFile = (currentFolder.fileRefs ?? []).find((f) => f.name === filename);
    if (existingFile) {
      return failure(
        'unknown',
        `A file already exists at "${path}". Replace-on-upload is not yet implemented; skipping.`,
        'To replace, delete the existing file in Overleaf manually, then re-run the pull.',
      );
    }

    dbg(`uploading binary "${filename}" (${bytes.length} bytes) to folder ${currentFolderId}`);
    let uploaded: { fileId: string };
    try {
      uploaded = await postOverleafMultipartUpload(
        projectId,
        currentFolderId,
        filename,
        bytes,
        csrfToken,
      );
    } catch (e) {
      return failure(
        'unknown',
        `Binary upload failed for "${filename}": ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    return {
      ok: true,
      data: { fileId: uploaded.fileId, path, sizeBytes: bytes.length },
    };
  } finally {
    client.disconnect();
  }
}
