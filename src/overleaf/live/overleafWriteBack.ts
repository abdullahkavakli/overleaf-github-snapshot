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
// and followed by a read-back that must match the intended text.
//
// No blind replace. No automatic conflict resolution. No silent overwrite.
//
// All reads and writes go through one bridge session (one Overleaf socket
// and joinProject), either the caller's or one opened for this call.

import { downloadOverleafZip, type OverleafZipSnapshot } from '../overleafZipClient';
import { ZipError, readZipFromBytes } from '../../zip/zipReader';
import { OverleafBridgeSession } from './bridgeSession';
import { withProjectPullLock } from './projectPullLock';
import { checkWriteBackConflict } from './conflictDetector';
import { flattenProjectTree } from './overleafProjectLoader';
import {
  LiveSyncError,
  type OverleafWriteBackOptions,
  type WriteBackCandidate,
  type WriteBackResult,
} from './types';

// Result message for a doc whose GitHub content already matches Overleaf.
export const UNCHANGED_DOC_MESSAGE = 'No local change versus base — nothing to write.';

// The popup gave up waiting for a write (code 'network'); the content
// script may still have applied it. Running the pull again settles it.
const WRITE_TIMED_OUT_MESSAGE =
  'The Overleaf tab did not answer in time, so it is unknown whether this doc was written. Run the pull again to check.';

// Row text for a doc whose current text could not be read, so no write was
// sent for it. `reason` may be a full sentence; its final period is dropped
// inside the parentheses.
export function readFailedMessage(reason: string): string {
  return `Not written: reading the current text from Overleaf failed (${reason.replace(/\.$/, '')}). Run the pull again.`;
}

// An operation the session never sent ('not_attempted') becomes a skipped
// row; the operation that lost the connection carries the cause.
function notAttemptedRow(path: string, e: unknown): WriteBackResult | null {
  if (!(e instanceof LiveSyncError) || e.code !== 'not_attempted') return null;
  return { path, status: 'skipped', message: e.message };
}

function getExtension(path: string): string {
  const base = path.split('/').pop() ?? path;
  const idx = base.lastIndexOf('.');
  if (idx < 0) return '';
  return base.substring(idx).toLowerCase();
}

export function isAllowedWriteBackExtension(
  path: string,
  allowedExtensions: string[],
): boolean {
  const ext = getExtension(path);
  if (!ext) return false;
  return allowedExtensions.includes(ext);
}

export function filterWriteBackCandidates(
  candidates: WriteBackCandidate[],
  options: OverleafWriteBackOptions,
): { allowed: WriteBackCandidate[]; rejected: WriteBackResult[] } {
  const allowed: WriteBackCandidate[] = [];
  const rejected: WriteBackResult[] = [];
  for (const c of candidates) {
    if (!isAllowedWriteBackExtension(c.path, options.allowedExtensions)) {
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

// A backup ZIP fetched during the current run, before any write.
export type OverleafZipBackup = {
  projectId: string;
  takenAt: string;
  // The parsed archive, used only to skip docs whose bytes already match
  // GitHub. null when the archive is valid but was not parsed: empty (for
  // a project with no docs or files), or beyond the ZIP reader's limits.
  snapshot: OverleafZipSnapshot | null;
};

const ZIP_BACKUP_RECOVERY =
  'Check that you are signed in to Overleaf and can download this project as a ZIP, then try again.';

// The gate is "Overleaf's export downloaded and is a valid ZIP"; a failed
// download, a response that is not a ZIP, or an archive that cannot be
// read aborts the run before anything is written. Parsing the archive is
// only for the ZIP-skip optimisation, so an archive beyond the reader's
// size limits passes the gate with ZIP-skip off. An empty archive passes
// only when the project tree has no docs or files either (Overleaf leaves
// empty folders out of the export).
export async function takeZipBackup(
  projectId: string,
  projectHasEntries: boolean,
): Promise<OverleafZipBackup> {
  const failed = (detail: string): LiveSyncError =>
    new LiveSyncError(
      'write_back_not_safe',
      `Cannot write back: backup ZIP fetch failed (${detail}).`,
      ZIP_BACKUP_RECOVERY,
    );
  let download;
  try {
    download = await downloadOverleafZip(projectId);
  } catch (e) {
    throw failed(e instanceof Error ? e.message : String(e));
  }
  const takenAt = new Date().toISOString();
  try {
    const files = await readZipFromBytes(download.bytes);
    return {
      projectId,
      takenAt,
      snapshot: {
        projectId,
        files,
        source: 'overleaf-zip-route',
        fetchedFromUrl: download.fetchedFromUrl,
        zipSizeBytes: download.zipSizeBytes,
      },
    };
  } catch (e) {
    if (e instanceof ZipError && e.kind === 'over_limit') {
      return { projectId, takenAt, snapshot: null };
    }
    if (e instanceof ZipError && e.kind === 'empty') {
      if (!projectHasEntries) return { projectId, takenAt, snapshot: null };
      throw new LiveSyncError(
        'write_back_not_safe',
        'Cannot write back: the backup ZIP from Overleaf is empty, but the project has files.',
        ZIP_BACKUP_RECOVERY,
      );
    }
    throw failed(`Failed to parse Overleaf ZIP: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export type WriteBackRunContext = {
  // Open session to reuse. Without one, a session is opened for this call
  // and closed before it returns.
  session?: OverleafBridgeSession;
  // Backup already taken in this run, before any write. Without one, and
  // with options.requireZipBackup set, a backup is taken here first.
  zipBackup?: OverleafZipBackup;
  onProgress?: (message: string) => void;
};

export async function writeSelectedFilesBackToOverleaf(
  projectId: string,
  candidates: WriteBackCandidate[],
  options: OverleafWriteBackOptions,
  context: WriteBackRunContext = {},
): Promise<WriteBackResult[]> {
  if (candidates.length === 0) return [];

  const { allowed, rejected } = filterWriteBackCandidates(candidates, options);
  if (allowed.length === 0) return rejected;

  if (context.session) {
    if (context.session.projectId !== projectId) {
      throw new LiveSyncError(
        'write_back_not_safe',
        'Internal error: the Overleaf session belongs to a different project.',
      );
    }
    // The caller (pullSnapshotIntoOverleaf) holds the pull lock.
    const written = await writeOnSession(projectId, context.session, allowed, options, context);
    return [...rejected, ...written];
  }

  // Standalone (Options → Developer write-back test): this call takes the
  // pull lock and owns the session. The session opens first, so a tab that
  // is outdated or unreachable fails before the ZIP backup downloads the
  // whole project; the backup still comes before the first read or write.
  return withProjectPullLock(projectId, async () => {
    const session = await OverleafBridgeSession.open(projectId);
    try {
      const written = await writeOnSession(projectId, session, allowed, options, context);
      return [...rejected, ...written];
    } finally {
      await session.close();
    }
  });
}

async function writeOnSession(
  projectId: string,
  session: OverleafBridgeSession,
  allowed: WriteBackCandidate[],
  options: OverleafWriteBackOptions,
  context: WriteBackRunContext,
): Promise<WriteBackResult[]> {
  const results: WriteBackResult[] = [];

  // Backup before any write. We never proceed without one when the option
  // is set.
  if (options.requireZipBackup && context.zipBackup?.projectId !== projectId) {
    await takeZipBackup(projectId, flattenProjectTree(session.rootFolder).length > 0);
  }

  // Resolve doc IDs from the session's joinProject tree (authoritative
  // even on Overleaf builds that no longer embed the bootstrap blob in
  // HTML).
  const docIdByPath = new Map<string, string>();
  for (const entry of flattenProjectTree(session.rootFolder)) {
    if (entry.kind === 'doc' && entry.id) docIdByPath.set(entry.path, entry.id);
  }

  for (let i = 0; i < allowed.length; i++) {
    const candidate = allowed[i]!;
    const docId = docIdByPath.get(candidate.path);
    if (!docId) {
      results.push({
        path: candidate.path,
        status: 'skipped',
        message: 'File is not an editable Overleaf document (likely a static file).',
      });
      continue;
    }

    context.onProgress?.(`Writing ${i + 1}/${allowed.length}: ${candidate.path}`);

    let currentSnapshot;
    try {
      currentSnapshot = await session.fetchSnapshot(docId);
    } catch (e) {
      results.push(
        notAttemptedRow(candidate.path, e) ?? {
          path: candidate.path,
          status: 'failed',
          message: readFailedMessage(e instanceof Error ? e.message : String(e)),
        },
      );
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
        message: UNCHANGED_DOC_MESSAGE,
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
      const after = await session.applyUpdate(
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
      results.push(
        notAttemptedRow(candidate.path, e) ?? {
          path: candidate.path,
          status: 'failed',
          message:
            e instanceof LiveSyncError && e.code === 'write_back_not_safe'
              ? 'Write-back is unavailable because safe Overleaf document versioning could not be confirmed.'
              : e instanceof LiveSyncError && e.code === 'network'
                ? WRITE_TIMED_OUT_MESSAGE
                : e instanceof Error
                  ? e.message
                  : String(e),
        },
      );
    }
  }

  return results;
}
