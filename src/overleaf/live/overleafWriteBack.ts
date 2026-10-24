// Explicit write-back of selected text files to Overleaf.
//
// This is the strict-safety path. Every write is preceded by:
//   1. A ZIP backup: Overleaf's export must download and be a valid ZIP.
//      The archive is not kept; Overleaf's History is the way back.
//   2. A re-read of the current Overleaf content via the live channel.
//   3. A conflict check against the user's base snapshot. If the remote
//      changed since the base, we REFUSE to write (status = "conflict").
//   4. An OT update on the document, sent only while the doc is still at
//      the version that was read (otherwise status = "conflict").
// and followed by a read-back that must match the intended text.
//
// No blind replace. No automatic conflict resolution. No silent overwrite.
//
// All reads and writes go through one bridge session (one Overleaf socket
// and joinProject), either the caller's or one opened for this call.

import {
  describeOverleafZipFetchError,
  downloadOverleafZip,
  type OverleafZipSnapshot,
} from '../overleafZipClient';
import { ZipError, readZipFromBytes } from '../../zip/zipReader';
import { OverleafBridgeSession } from './bridgeSession';
import { withProjectPullLock } from './projectPullLock';
import { checkWriteBackConflict } from './conflictDetector';
import { flattenProjectTree } from './overleafProjectLoader';
import {
  hasOverleafUnstorableChars,
  normalizeLineEndings,
  toOverleafStorableText,
} from '../../shared/lineEndings';
import { ALL_FILE_TYPES } from '../../shared/constants';
import {
  LiveSyncError,
  asDetail,
  type OverleafWriteBackOptions,
  type WriteBackCandidate,
  type WriteBackResult,
} from './types';

// Result message for a doc whose GitHub content already matches Overleaf.
export const UNCHANGED_DOC_MESSAGE = 'Overleaf already has this content, so nothing was written.';

// Same, when the only difference is line endings (Overleaf keeps no "\r").
export const UNCHANGED_LINE_ENDINGS_MESSAGE = 'Already matches GitHub (only the line endings differ).';

// Same, when the only difference is characters Overleaf can't store: it
// replaces each half of a surrogate pair with U+FFFD, so an emoji shows as two.
export const UNCHANGED_UNSTORABLE_MESSAGE =
  "Already matches GitHub, except for characters Overleaf can't store (such as emoji), which it shows as \uFFFD.";

// Same, for a GitHub file that isn't valid UTF-8, when Overleaf holds the text
// those bytes decode to (the invalid bytes shown as U+FFFD).
export const UNCHANGED_NOT_UTF8_MESSAGE =
  "Already matches GitHub, except for characters that aren't saved as UTF-8 text there, which Overleaf shows as \uFFFD. Re-save the file as UTF-8 on GitHub to fix them.";

// Note on a row for a file that was written or created although part of its
// GitHub text can't be stored.
export const UNSTORABLE_WRITTEN_NOTE =
  "Overleaf can't store some characters in this file (such as emoji), so it shows them as \uFFFD.";

// Why a doc whose GitHub text is already in Overleaf needs no write. Which
// differences were tolerated decides the wording.
export function unchangedMessage(
  gitHubText: string,
  overleafText: string,
  gitHubIsNotUtf8 = false,
): string {
  if (gitHubIsNotUtf8) return UNCHANGED_NOT_UTF8_MESSAGE;
  if (gitHubText === overleafText) return UNCHANGED_DOC_MESSAGE;
  if (normalizeLineEndings(gitHubText) === normalizeLineEndings(overleafText)) {
    return UNCHANGED_LINE_ENDINGS_MESSAGE;
  }
  return UNCHANGED_UNSTORABLE_MESSAGE;
}

// The popup gave up waiting for a write (code 'network'); the content
// script may still have applied it. Running the pull again settles it.
const WRITE_TIMED_OUT_MESSAGE =
  'The Overleaf tab did not answer in time, so it is unknown whether this file was written. Run the pull again to check.';

// Row text for a doc whose current text could not be read, so no write was
// sent for it. `reason` may be a full sentence.
export function readFailedMessage(reason: string): string {
  return `Not written: this file couldn't be read from Overleaf. Run the pull again. Details: ${asDetail(reason)}.`;
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

// Row text for a file whose type is not in the allowed list.
export const NOT_ALLOWED_TYPE_MESSAGE =
  'Not written: this file type is not in Options → Allowed write-back extensions.';

export function isAllowedWriteBackExtension(
  path: string,
  allowedExtensions: string[],
): boolean {
  if (allowedExtensions.includes(ALL_FILE_TYPES)) return true;
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
        message: NOT_ALLOWED_TYPE_MESSAGE,
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
  // The parsed archive, used only to skip docs whose text already matches
  // GitHub (ignoring line endings). null when the archive is valid but was not parsed: empty (for
  // a project with no docs or files), or beyond the ZIP reader's limits.
  snapshot: OverleafZipSnapshot | null;
};

const ZIP_BACKUP_RECOVERY =
  'Check that you are signed in to Overleaf and can download this project as a ZIP, then try again.';
const ZIP_BACKUP_FAILED = 'Nothing was changed in Overleaf: the project ZIP could not be checked.';

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
  let download;
  try {
    download = await downloadOverleafZip(projectId);
  } catch (e) {
    // The download error's own advice, when it has one, replaces the
    // generic hint, so the banner gives one piece of advice.
    const { summary, advice, details } = describeOverleafZipFetchError(e);
    throw new LiveSyncError(
      'write_back_not_safe',
      [ZIP_BACKUP_FAILED, summary, details].filter((part) => part).join(' '),
      advice ?? ZIP_BACKUP_RECOVERY,
    );
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
        `${ZIP_BACKUP_FAILED} Overleaf sent an empty ZIP, but the project has files.`,
        ZIP_BACKUP_RECOVERY,
      );
    }
    throw new LiveSyncError(
      'write_back_not_safe',
      `${ZIP_BACKUP_FAILED} Overleaf's project ZIP couldn't be opened. Details: ${asDetail(e instanceof Error ? e.message : String(e))}.`,
      ZIP_BACKUP_RECOVERY,
    );
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
    // The caller (applyPullPlan) holds the pull lock.
    const written = await writeOnSession(projectId, context.session, allowed, options, context);
    return [...rejected, ...written];
  }

  // Standalone (Options → Developer tools → Write-back test): this call takes the
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
        message:
          "Not written: Overleaf has no editable text file at this path. It may have been renamed or deleted, or it is an uploaded file.",
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

    // Overleaf stores no "\r" and turns every surrogate (each half of an
    // emoji) into U+FFFD, so the text it will hold after this write is the
    // storable form. Writing, checking and verifying all use that form, so a
    // CRLF or emoji file does not fail verification on every pull.
    const newText = toOverleafStorableText(candidate.newText);

    const check = await checkWriteBackConflict(
      candidate.path,
      candidate.oldText,
      currentSnapshot.text,
      newText,
    );

    if (check.status === 'unchanged') {
      results.push({
        path: candidate.path,
        status: 'skipped',
        message: unchangedMessage(candidate.newText, candidate.oldText),
      });
      continue;
    }

    if (check.status === 'conflict') {
      results.push({
        path: candidate.path,
        status: 'conflict',
        message: check.reason ?? 'This file changed in Overleaf after it was read, so it was not overwritten.',
      });
      continue;
    }

    try {
      const after = await session.applyUpdate(
        docId,
        candidate.oldText,
        newText,
        currentSnapshot.version,
      );
      // Verify by reading back the doc.
      if (normalizeLineEndings(after.text) !== newText) {
        results.push({
          path: candidate.path,
          status: 'failed',
          message:
            "After writing, this file in Overleaf doesn't match the new version (someone may have edited it at the same time). Open it in Overleaf to check; its History can restore an earlier version.",
        });
        continue;
      }
      results.push({
        path: candidate.path,
        status: 'written',
        // The caller may have converted the text already (the pull does); this
        // covers a caller that passes the GitHub text as it is.
        ...(hasOverleafUnstorableChars(candidate.newText) ? { message: UNSTORABLE_WRITTEN_NOTE } : {}),
      });
    } catch (e) {
      results.push(
        notAttemptedRow(candidate.path, e) ?? {
          path: candidate.path,
          // 'remote_changed': the doc moved on between the fresh read and
          // the write, so the content script sent nothing.
          status: e instanceof LiveSyncError && e.code === 'remote_changed' ? 'conflict' : 'failed',
          message:
            e instanceof LiveSyncError && e.code === 'network'
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
