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
  LiveSnapshotResponseData,
  SerializedProjectFile,
} from '../overleaf/live/bridgeProtocol';
import { uint8ToBase64 } from '../overleaf/live/bridgeProtocol';
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
