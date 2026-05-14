// Explicit write-back of selected text files to Overleaf.
//
// This is the strict-safety path. Every write is preceded by:
//   1. A ZIP backup (so the user can roll back).
//   2. A re-read of the current Overleaf content via the live channel.
//   3. A conflict check against the user's base snapshot. If the remote
//      changed since the base, we REFUSE to write (status = "conflict").
//   4. An OT update on the document. If the doc channel cannot return a
//      version, we REFUSE to write (status = "failed", message includes
//      `write_back_not_safe`).
//
// No blind replace. No automatic conflict resolution. No silent overwrite.

import { fetchOverleafZipSnapshot } from '../overleafZipClient';
import { checkWriteBackConflict } from './conflictDetector';
import {
  applyDocUpdate,
  fetchDocSnapshot,
  getActiveDocChannel,
} from './overleafDocumentClient';
import { openProjectConnection } from './overleafRealtimeClient';
import {
  fetchProjectMetadata,
  flattenProjectTree,
} from './overleafProjectLoader';
import {
  LiveSyncError,
  type OverleafWriteBackOptions,
  type WriteBackCandidate,
  type WriteBackResult,
} from './types';

function getExtension(path: string): string {
  const base = path.split('/').pop() ?? path;
  const idx = base.lastIndexOf('.');
  if (idx < 0) return '';
  return base.substring(idx).toLowerCase();
}

function isAllowedExtension(
  path: string,
  options: OverleafWriteBackOptions,
): boolean {
  const ext = getExtension(path);
  if (!ext) return false;
  return options.allowedExtensions.includes(ext);
}

export function filterWriteBackCandidates(
  candidates: WriteBackCandidate[],
  options: OverleafWriteBackOptions,
): { allowed: WriteBackCandidate[]; rejected: WriteBackResult[] } {
  const allowed: WriteBackCandidate[] = [];
  const rejected: WriteBackResult[] = [];
  for (const c of candidates) {
    if (!isAllowedExtension(c.path, options)) {
      rejected.push({
        path: c.path,
        status: 'skipped',
        message: `Extension not in allowed write-back list (${options.allowedExtensions.join(', ')}).`,
      });
      continue;
    }
    allowed.push(c);
  }
  return { allowed, rejected };
}

export async function writeSelectedFilesBackToOverleaf(
  projectId: string,
  candidates: WriteBackCandidate[],
  options: OverleafWriteBackOptions,
): Promise<WriteBackResult[]> {
  if (candidates.length === 0) return [];

  const { allowed, rejected } = filterWriteBackCandidates(candidates, options);
  const results: WriteBackResult[] = [...rejected];

  if (allowed.length === 0) return results;

  // Backup before any write. We never proceed without one when the option
  // is set.
  if (options.requireZipBackup) {
    try {
      await fetchOverleafZipSnapshot(projectId);
    } catch (e) {
      throw new LiveSyncError(
        'write_back_not_safe',
        `Cannot write back: backup ZIP fetch failed (${e instanceof Error ? e.message : String(e)}).`,
      );
    }
  }

  // Open the realtime connection and resolve doc IDs.
  await openProjectConnection(projectId);
  const channel = getActiveDocChannel();
  if (!channel) {
    throw new LiveSyncError(
      'write_back_not_safe',
      'Write-back is unavailable because safe Overleaf document versioning could not be confirmed.',
    );
  }

  const metadata = await fetchProjectMetadata(projectId);
  const entries = flattenProjectTree(metadata.rootFolder);
  const docIdByPath = new Map<string, string>();
  for (const entry of entries) {
    if (entry.kind === 'doc') docIdByPath.set(entry.path, entry.id);
  }

  for (const candidate of allowed) {
    const docId = docIdByPath.get(candidate.path);
    if (!docId) {
      results.push({
        path: candidate.path,
        status: 'skipped',
        message: 'File is not an editable Overleaf document (likely a static file).',
      });
      continue;
    }

    let currentSnapshot;
    try {
      currentSnapshot = await fetchDocSnapshot(docId);
    } catch (e) {
      results.push({
        path: candidate.path,
        status: 'failed',
        message:
          e instanceof LiveSyncError && e.code === 'protocol_unavailable'
            ? 'Live document read is not implemented on this Overleaf build (write_back_not_safe).'
            : e instanceof Error
              ? e.message
              : String(e),
      });
      continue;
    }

    const check = await checkWriteBackConflict(
      candidate.path,
      candidate.oldText,
      currentSnapshot.text,
      candidate.newText,
    );

    if (check.status === 'unchanged') {
      results.push({
        path: candidate.path,
        status: 'skipped',
        message: 'No local change versus base — nothing to write.',
      });
      continue;
    }

    if (check.status === 'conflict') {
      results.push({
        path: candidate.path,
        status: 'conflict',
        message: check.reason ?? 'Remote changed since base.',
      });
      continue;
    }

    try {
      const after = await applyDocUpdate(
        docId,
        candidate.oldText,
        candidate.newText,
        currentSnapshot.version,
      );
      // Verify by reading back the doc.
      if (after.text !== candidate.newText) {
        results.push({
          path: candidate.path,
          status: 'failed',
          message: 'Write completed but verification read returned different content.',
        });
        continue;
      }
      results.push({ path: candidate.path, status: 'written' });
    } catch (e) {
      results.push({
        path: candidate.path,
        status: 'failed',
        message:
          e instanceof LiveSyncError && e.code === 'write_back_not_safe'
            ? 'Write-back is unavailable because safe Overleaf document versioning could not be confirmed.'
            : e instanceof Error
              ? e.message
              : String(e),
      });
    }
  }

  return results;
}
