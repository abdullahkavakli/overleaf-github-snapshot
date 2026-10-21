// Shared orchestration for the "pull from GitHub into Overleaf" flow. Both
// the popup panel and the Options dev panel call pullSnapshotIntoOverleaf,
// so the two entry points behave the same.
//
// The whole pull runs on ONE bridge session (one Overleaf socket, one
// joinProject). Before that change every read, write, create and upload
// opened its own socket and joinProject, about 2N+K+2 joins for N docs,
// which tripped Overleaf's join rate limit on larger projects.

import { OverleafBridgeSession } from '../overleaf/live/bridgeSession';
import { uint8ToBase64 } from '../overleaf/live/bridgeProtocol';
import { flattenProjectTree } from '../overleaf/live/overleafProjectLoader';
import { withProjectPullLock } from '../overleaf/live/projectPullLock';
import {
  UNCHANGED_DOC_MESSAGE,
  isAllowedWriteBackExtension,
  readFailedMessage,
  takeZipBackup,
  writeSelectedFilesBackToOverleaf,
  type OverleafZipBackup,
} from '../overleaf/live/overleafWriteBack';
import {
  recoveryActionForLiveSyncError,
  type LiveSyncError,
  type LiveSyncErrorCode,
  type WriteBackCandidate,
  type WriteBackResult,
} from '../overleaf/live/types';
import { computeSha256 } from '../diff/fileHasher';
import { findCommonTopLevelFolder } from '../zip/normalizeZipPaths';
import type { ExperimentalConfig, ProjectFile } from '../shared/types';

export type CreateResult = {
  path: string;
  // 'created'  -> doc exists on Overleaf with the expected content
  // 'failed'   -> creation attempted and the bridge returned an error
  // 'skipped'  -> no Overleaf call made (e.g. extension not in the user's
  //               writeBack whitelist, or not attempted after the
  //               connection to the Overleaf tab was lost)
  status: 'created' | 'failed' | 'skipped';
  message?: string;
};

// Row text when the popup gave up waiting (code 'network'): the content
// script may still finish the request. Running the pull again is safe and
// settles it: an uploaded file is then skipped as existing, and a doc
// created empty is filled in by the normal write path.
const CREATE_TIMED_OUT_MESSAGE =
  'The Overleaf tab did not answer in time, so it is unknown whether this doc was created. Run the pull again to check.';
const UPLOAD_TIMED_OUT_MESSAGE =
  'The Overleaf tab did not answer in time, so it is unknown whether this file was uploaded. Run the pull again to check.';

function getExtension(path: string): string {
  const base = path.split('/').pop() ?? path;
  const idx = base.lastIndexOf('.');
  if (idx < 0) return '';
  return base.substring(idx).toLowerCase();
}

// Iterates the to-create list, filters by allowedExtensions (mirroring
// the write-back path's filter so pulls are symmetric), and creates each
// doc through the session. Each per-file result is independent — a
// failure on file N does NOT abort the rest. Sequential on purpose:
// creates add folders to the project tree that later creates reuse.
export async function createMissingDocsForPull(
  session: OverleafBridgeSession,
  toCreate: Array<{ path: string; content: string }>,
  allowedExtensions: string[],
  onProgress: (msg: string) => void,
): Promise<CreateResult[]> {
  const allowed = new Set(allowedExtensions);
  const results: CreateResult[] = [];

  for (let i = 0; i < toCreate.length; i++) {
    const candidate = toCreate[i]!;
    const ext = getExtension(candidate.path);
    if (!allowed.has(ext)) {
      results.push({
        path: candidate.path,
        status: 'skipped',
        message: `Extension ${ext || '(none)'} not in allowed write-back list.`,
      });
      continue;
    }

    onProgress(`Creating ${i + 1}/${toCreate.length}: ${candidate.path}`);
    try {
      const response = await session.createDocAtPath(candidate.path, candidate.content);
      if (response.ok) {
        results.push({
          path: candidate.path,
          status: 'created',
          message: `v${response.data.version} (${response.data.text.length} bytes)`,
        });
      } else if (response.code === 'not_attempted') {
        results.push({ path: candidate.path, status: 'skipped', message: response.message });
      } else if (response.code === 'network') {
        results.push({ path: candidate.path, status: 'failed', message: CREATE_TIMED_OUT_MESSAGE });
      } else {
        results.push({
          path: candidate.path,
          status: 'failed',
          message: response.message,
        });
      }
    } catch (e) {
      results.push({
        path: candidate.path,
        status: 'failed',
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return results;
}

export type BinaryResult = {
  path: string;
  // 'uploaded'  -> file present in Overleaf with the expected bytes
  // 'failed'    -> upload attempted and the bridge returned an error
  // 'skipped'   -> not uploaded for a structural reason (already exists,
  //                "Also create" was off, or not attempted after the
  //                connection to the Overleaf tab was lost)
  status: 'uploaded' | 'failed' | 'skipped';
  message?: string;
};

// Iterates the binary files pulled from GitHub and decides per-file:
//   - already in Overleaf as a fileRef -> skip (replace-on-upload is a
//                                          separate slice not in this build)
//   - not in Overleaf and createMissing=false -> skip with hint
//   - not in Overleaf and createMissing=true  -> upload through the session
//
// `existingFilePaths` comes from the tree read when the session opened, so
// it is only a pre-filter: the content script checks Overleaf's current
// listing right before each upload and refuses ('already_exists') when the
// path was taken in the meantime.
//
// Per-file failures don't abort the loop; each one becomes its own
// BinaryResult row that the UI surfaces.
export async function uploadBinariesForPull(
  session: OverleafBridgeSession,
  binaryFiles: ProjectFile[],
  existingFilePaths: Set<string>,
  createMissing: boolean,
  onProgress: (msg: string) => void,
): Promise<BinaryResult[]> {
  const results: BinaryResult[] = [];

  for (let i = 0; i < binaryFiles.length; i++) {
    const file = binaryFiles[i]!;

    if (existingFilePaths.has(file.path)) {
      results.push({
        path: file.path,
        status: 'skipped',
        message: 'File already exists in Overleaf — replace-on-upload is not implemented in this build.',
      });
      continue;
    }
    if (!createMissing) {
      results.push({
        path: file.path,
        status: 'skipped',
        message: 'Not in Overleaf; enable "Also create new files" to upload.',
      });
      continue;
    }

    onProgress(`Uploading binary ${i + 1}/${binaryFiles.length}: ${file.path}`);
    try {
      const contentBase64 = uint8ToBase64(file.content);
      const response = await session.uploadBinary(file.path, contentBase64);
      if (response.ok) {
        results.push({
          path: file.path,
          status: 'uploaded',
          message: `${response.data.sizeBytes} bytes`,
        });
      } else if (response.code === 'already_exists' || response.code === 'not_attempted') {
        results.push({ path: file.path, status: 'skipped', message: response.message });
      } else if (response.code === 'network') {
        results.push({ path: file.path, status: 'failed', message: UPLOAD_TIMED_OUT_MESSAGE });
      } else {
        results.push({
          path: file.path,
          status: 'failed',
          message: response.message,
        });
      }
    } catch (e) {
      results.push({
        path: file.path,
        status: 'failed',
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return results;
}

// Maps each Overleaf entry path to its file in the backup ZIP, or returns
// null when the two can't be lined up with certainty. zipReader strips a
// top-level folder shared by every entry, so a project whose files all
// live in one folder comes back without that prefix. A mapping is used
// only when it accounts for every entry in the project tree, and only when
// exactly one of "as is" and "prefix stripped" does.
export function alignZipWithProjectTree(
  zipFiles: ProjectFile[],
  projectPaths: string[],
): Map<string, ProjectFile> | null {
  if (projectPaths.length === 0) return null;
  const zipByPath = new Map(zipFiles.map((f) => [f.path, f] as const));
  const lineUp = (toZipPath: (p: string) => string): Map<string, ProjectFile> | null => {
    const out = new Map<string, ProjectFile>();
    for (const p of projectPaths) {
      const file = zipByPath.get(toZipPath(p));
      if (!file) return null;
      out.set(p, file);
    }
    return out;
  };

  const asIs = lineUp((p) => p);
  const top = findCommonTopLevelFolder(projectPaths);
  const stripped = top ? lineUp((p) => p.substring(top.length + 1)) : null;
  if (asIs && !stripped) return asIs;
  if (stripped && !asIs) return stripped;
  return null;
}

// True only when the backup ZIP holds exactly the GitHub bytes for this
// doc, i.e. Overleaf already has the content and the doc needs no socket
// work. Byte equality makes line endings and encoding compare exactly;
// anything that differs goes through the full read / conflict / write /
// verify path.
export function zipMatchesGitHub(
  zipFile: ProjectFile | undefined,
  gitHubFile: ProjectFile,
): boolean {
  if (!zipFile || zipFile.isBinary || gitHubFile.isBinary) return false;
  if (zipFile.sizeBytes !== gitHubFile.sizeBytes) return false;
  if (zipFile.sha256 !== gitHubFile.sha256) return false;
  return zipFile.text !== undefined && zipFile.text === gitHubFile.text;
}

export type PullIntoOverleafOutcome =
  // No GitHub file has an Overleaf doc, creation is off, and there are no
  // binaries. Nothing was written.
  | { kind: 'nothing-to-do'; toCreateCount: number }
  | {
      kind: 'done';
      // null when no GitHub text file had a matching Overleaf doc.
      results: WriteBackResult[] | null;
      createResults: CreateResult[] | null;
      binaryResults: BinaryResult[] | null;
    };

// Recovery line for the pull error banners (popup and Options). The generic
// hints (recoveryActionForLiveSyncError) suggest the ZIP route, which copies
// Overleaf to GitHub, so it is no fallback for a pull. null when the message
// already gives the advice (an outdated tab, a rate-limited project join).
export function recoveryForPullError(e: LiveSyncError): string | null {
  const advice = e.recovery ?? pullRecoveryForCode(e.code);
  const core = advice.replace(/\.$/, '').toLowerCase();
  return e.message.toLowerCase().includes(core) ? null : advice;
}

function pullRecoveryForCode(code: LiveSyncErrorCode): string {
  switch (code) {
    case 'protocol_unavailable':
    case 'socket_connection_failed':
    case 'project_join_failed':
    case 'document_join_failed':
    case 'document_version_unknown':
    case 'unknown':
      return 'Run the pull again. If it keeps failing, reload the Overleaf tab.';
    default:
      return recoveryActionForLiveSyncError(code);
  }
}

export type PullIntoOverleafParams = {
  projectId: string;
  // Files from sourceFromGitHubBranch (text and, if enabled, binaries).
  files: ProjectFile[];
  experimental: ExperimentalConfig;
  createMissing: boolean;
  onProgress: (message: string) => void;
  // Called once the GitHub text files without an Overleaf doc are known.
  onMissingInOverleaf: (paths: string[]) => void;
};

// Pulls GitHub content into Overleaf:
//   0. Take the project's pull lock (projectPullLock.ts); a second pull of
//      the same project, from the popup or the Options page, is refused.
//   1. Open one bridge session; its joinProject tree maps paths to IDs.
//   2. If any write may follow and the option is on, take the ZIP backup.
//      A failed backup aborts the pull before anything is written.
//   3. Docs whose ZIP bytes equal the GitHub bytes are skipped with no
//      socket work. The rest are read in pipelined batches; docs that
//      already match GitHub are skipped.
//   4. Docs that differ go through writeSelectedFilesBackToOverleaf on the
//      same session: fresh read, conflict check, version-checked write,
//      verify-after-write, one doc at a time.
//   5. Create missing docs and upload new binaries (create-only), if asked.
export function pullSnapshotIntoOverleaf(
  params: PullIntoOverleafParams,
): Promise<PullIntoOverleafOutcome> {
  return withProjectPullLock(params.projectId, () => pullUnderLock(params));
}

async function pullUnderLock(params: PullIntoOverleafParams): Promise<PullIntoOverleafOutcome> {
  const { projectId, experimental, createMissing, onProgress } = params;
  const textFiles = params.files.filter((f) => !f.isBinary);
  const binaryFiles = params.files.filter((f) => f.isBinary);

  onProgress('Resolving Overleaf docs…');
  const session = await OverleafBridgeSession.open(projectId);
  try {
    const entries = flattenProjectTree(session.rootFolder);
    const docIdByPath = new Map<string, string>();
    const fileIdByPath = new Map<string, string>();
    for (const entry of entries) {
      if (entry.kind === 'doc' && entry.id) docIdByPath.set(entry.path, entry.id);
      if (entry.kind === 'file' && entry.id) fileIdByPath.set(entry.path, entry.id);
    }

    const matched: Array<{ file: ProjectFile; docId: string }> = [];
    const toCreate: { path: string; content: string }[] = [];
    for (const file of textFiles) {
      const docId = docIdByPath.get(file.path);
      if (docId) matched.push({ file, docId });
      else toCreate.push({ path: file.path, content: file.text ?? '' });
    }
    params.onMissingInOverleaf(toCreate.map((c) => c.path));

    const nothingToDo =
      matched.length === 0 &&
      !(createMissing && toCreate.length > 0) &&
      binaryFiles.length === 0;
    if (nothingToDo) {
      return { kind: 'nothing-to-do', toCreateCount: toCreate.length };
    }

    // The backup gates every write of this run: doc writes, creates and
    // uploads.
    const mayWrite =
      matched.length > 0 ||
      (createMissing &&
        (toCreate.length > 0 || binaryFiles.some((f) => !fileIdByPath.has(f.path))));
    let zipBackup: OverleafZipBackup | undefined;
    if (experimental.requireZipBackupBeforeWriteBack && mayWrite) {
      onProgress('Taking a ZIP backup of the Overleaf project…');
      zipBackup = await takeZipBackup(projectId, entries.length > 0);
    }

    let results: WriteBackResult[] | null = null;
    if (matched.length > 0) {
      results = await syncMatchedDocs(session, matched, entries.map((e) => e.path), {
        projectId,
        experimental,
        zipBackup,
        onProgress,
      });
    }

    let createResults: CreateResult[] | null = null;
    if (createMissing && toCreate.length > 0) {
      createResults = await createMissingDocsForPull(
        session,
        toCreate,
        experimental.allowedWriteBackExtensions,
        onProgress,
      );
    }

    // Binaries only reach this point when allowBinaryWriteBack is on (the
    // GitHub source filters them otherwise). createMissing doubles as the
    // upload-vs-report-as-skipped gate.
    let binaryResults: BinaryResult[] | null = null;
    if (binaryFiles.length > 0) {
      binaryResults = await uploadBinariesForPull(
        session,
        binaryFiles,
        new Set(fileIdByPath.keys()),
        createMissing,
        onProgress,
      );
    }

    return { kind: 'done', results, createResults, binaryResults };
  } finally {
    await session.close();
  }
}

async function syncMatchedDocs(
  session: OverleafBridgeSession,
  matched: Array<{ file: ProjectFile; docId: string }>,
  projectPaths: string[],
  ctx: {
    projectId: string;
    experimental: ExperimentalConfig;
    zipBackup: OverleafZipBackup | undefined;
    onProgress: (message: string) => void;
  },
): Promise<WriteBackResult[]> {
  const allowedExtensions = ctx.experimental.allowedWriteBackExtensions;
  // No snapshot (backup not parsed) means no ZIP-skip: every doc is read.
  const zipByPath = ctx.zipBackup?.snapshot
    ? alignZipWithProjectTree(ctx.zipBackup.snapshot.files, projectPaths)
    : null;

  const rowByPath = new Map<string, WriteBackResult>();
  const candidates: WriteBackCandidate[] = [];
  const toRead: Array<{ file: ProjectFile; docId: string }> = [];
  for (const m of matched) {
    const newText = m.file.text ?? '';
    if (!isAllowedWriteBackExtension(m.file.path, allowedExtensions)) {
      // writeSelectedFilesBackToOverleaf rejects these by extension before
      // reading anything, so they need no read here either.
      candidates.push({ path: m.file.path, oldText: '', newText, baseSha256: '' });
    } else if (zipByPath && zipMatchesGitHub(zipByPath.get(m.file.path), m.file)) {
      rowByPath.set(m.file.path, {
        path: m.file.path,
        status: 'skipped',
        message: UNCHANGED_DOC_MESSAGE,
      });
    } else {
      toRead.push(m);
    }
  }

  if (toRead.length > 0) {
    const reads = await session.readDocs(
      toRead.map((m) => m.docId),
      (done, total) => ctx.onProgress(`Reading Overleaf docs ${done}/${total}…`),
    );
    const enc = new TextEncoder();
    for (const m of toRead) {
      const newText = m.file.text ?? '';
      const read = reads.get(m.docId);
      if (read && read.ok) {
        if (read.text === newText) {
          // Already identical; the write path would report it unchanged.
          rowByPath.set(m.file.path, {
            path: m.file.path,
            status: 'skipped',
            message: UNCHANGED_DOC_MESSAGE,
          });
          continue;
        }
        candidates.push({
          path: m.file.path,
          oldText: read.text,
          newText,
          baseSha256: await computeSha256(enc.encode(read.text)),
        });
      } else {
        // No base text, so no safe write: an empty stand-in base would make
        // the conflict check call a non-empty doc "unchanged" whenever the
        // GitHub file is empty. The read already had one retry in the
        // content script; a new pull reads it again.
        rowByPath.set(m.file.path, {
          path: m.file.path,
          status: 'failed',
          message: readFailedMessage(read?.message ?? 'no result'),
        });
      }
    }
  }

  if (candidates.length > 0) {
    ctx.onProgress(`Writing ${candidates.length} file(s) to Overleaf…`);
    const out = await writeSelectedFilesBackToOverleaf(
      ctx.projectId,
      candidates,
      {
        requireZipBackup: ctx.experimental.requireZipBackupBeforeWriteBack,
        requireConfirmation: false,
        allowedExtensions,
        allowBinary: ctx.experimental.allowBinaryWriteBack,
      },
      { session, zipBackup: ctx.zipBackup, onProgress: ctx.onProgress },
    );
    for (const row of out) rowByPath.set(row.path, row);
  }

  // One row per matched file, in GitHub path order.
  const results: WriteBackResult[] = [];
  for (const m of matched) {
    const row = rowByPath.get(m.file.path);
    if (row) results.push(row);
  }
  return results;
}
