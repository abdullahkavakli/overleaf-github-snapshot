// Orchestrates the experimental live read-only pull.
//
// Flow:
//   1. Confirm experimental flags are on (caller passes config).
//   2. Load project metadata from the project page HTML.
//   3. Open a real-time channel (probes Engine.IO; bails if the protocol is
//      unrecognized so we never silently produce empty / wrong content).
//   4. For each doc, fetch a snapshot via the real-time channel.
//   5. For each static file, fetch bytes from the per-file endpoint.
//   6. Normalize into ProjectFile[] using the same hashing/binary-detection
//      pipeline the ZIP path uses, so downstream diff/commit code is
//      identical.
//
// If any required step fails we throw a typed LiveSyncError so the popup
// can show a clear "use ZIP route" message.

import type { ExperimentalConfig, ProjectFile } from '../../shared/types';
import { COMMON_BINARY_EXTENSIONS, TEXT_EXTENSIONS } from '../../shared/constants';
import { computeSha256 } from '../../diff/fileHasher';
import {
  fetchProjectMetadata,
  flattenProjectTree,
  type FlatProjectEntry,
} from './overleafProjectLoader';
import { openProjectConnection } from './overleafRealtimeClient';
import { fetchDocSnapshot } from './overleafDocumentClient';
import { fetchProjectFileBytes } from './overleafFileClient';
import { LiveSyncError, type OverleafLiveSnapshot } from './types';

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

async function buildTextProjectFile(
  path: string,
  text: string,
): Promise<ProjectFile> {
  const enc = new TextEncoder();
  const bytes = enc.encode(text);
  const sha256 = await computeSha256(bytes);
  return {
    path,
    content: bytes,
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
): Promise<ProjectFile> {
  const isBinary = detectBinary(path, bytes);
  const sha256 = await computeSha256(bytes);
  if (isBinary) {
    return {
      path,
      content: bytes,
      encoding: 'base64',
      sha256,
      sizeBytes: bytes.byteLength,
      isBinary: true,
    };
  }
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  return {
    path,
    content: bytes,
    text,
    encoding: 'utf-8',
    sha256,
    sizeBytes: bytes.byteLength,
    isBinary: false,
  };
}

export async function fetchOverleafLiveSnapshot(
  projectId: string,
  experimental: ExperimentalConfig,
): Promise<OverleafLiveSnapshot> {
  if (!experimental.experimentalLiveSyncEnabled) {
    throw new LiveSyncError(
      'live_sync_disabled',
      'Experimental live sync is disabled.',
    );
  }
  if (!experimental.liveReadOnlyPullEnabled) {
    throw new LiveSyncError(
      'live_sync_disabled',
      'Live read-only pull is disabled.',
    );
  }

  const metadata = await fetchProjectMetadata(projectId);
  const entries = flattenProjectTree(metadata.rootFolder);
  if (entries.length === 0) {
    throw new LiveSyncError(
      'project_join_failed',
      'Project contains no files we can read via the live channel.',
    );
  }

  await openProjectConnection(projectId);

  const warnings: string[] = [];
  const files: ProjectFile[] = [];

  for (const entry of entries) {
    try {
      if (entry.kind === 'doc') {
        const file = await readDoc(entry);
        if (file) files.push(file);
      } else {
        const file = await readFile(projectId, entry);
        if (file) files.push(file);
      }
    } catch (e) {
      if (e instanceof LiveSyncError) {
        // Doc reads will currently fail with `protocol_unavailable` in the
        // stub realtime client. Surface that to the caller as a single
        // typed error rather than silently producing an incomplete project.
        if (e.code === 'protocol_unavailable' && entry.kind === 'doc') {
          throw new LiveSyncError(
            'protocol_unavailable',
            'Live read-only pull is unavailable because Overleaf\'s live protocol could not be detected. Use ZIP snapshot instead.',
            'Use the ZIP snapshot route as a fallback.',
          );
        }
        warnings.push(`${entry.path}: ${e.message}`);
      } else {
        warnings.push(
          `${entry.path}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  }

  files.sort((a, b) => a.path.localeCompare(b.path));

  return {
    projectId,
    files,
    source: 'overleaf-live-readonly',
    fetchedAt: new Date().toISOString(),
    warnings,
  };
}

async function readDoc(entry: FlatProjectEntry): Promise<ProjectFile | null> {
  const snapshot = await fetchDocSnapshot(entry.id);
  return buildTextProjectFile(entry.path, snapshot.text);
}

async function readFile(
  projectId: string,
  entry: FlatProjectEntry,
): Promise<ProjectFile | null> {
  const bytes = await fetchProjectFileBytes(projectId, entry.id);
  return buildBinaryProjectFile(entry.path, bytes);
}
