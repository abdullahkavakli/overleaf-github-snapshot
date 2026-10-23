// Shared orchestration for the "pull from GitHub into Overleaf" flow. Both
// the popup panel and the Options dev panel call planPullIntoOverleaf, show
// the plan, and call applyPullPlan only after the user confirms it, so the
// two entry points behave the same.
//
// The whole pull runs on ONE bridge session (one Overleaf socket, one
// joinProject), kept open from the plan to its apply. Before that change
// every read, write, create and upload opened its own socket and
// joinProject, about 2N+K+2 joins for N docs, which tripped Overleaf's
// join rate limit on larger projects.
//
// "Make Overleaf match GitHub exactly" (an option of the pull, off by
// default) extends both steps: the plan also lists uploaded files to replace
// and Overleaf files to delete, and the apply carries them out after a typed
// `delete` confirmation (planMirror, applyMirror).

import { OverleafBridgeSession } from '../overleaf/live/bridgeSession';
import { uint8ToBase64 } from '../overleaf/live/bridgeProtocol';
import {
  flattenProjectFolders,
  flattenProjectTree,
  type FlatProjectEntry,
} from '../overleaf/live/overleafProjectLoader';
import { withProjectPullLock } from '../overleaf/live/projectPullLock';
import {
  UNSTORABLE_WRITTEN_NOTE,
  filterWriteBackCandidates,
  isAllowedWriteBackExtension,
  readFailedMessage,
  takeZipBackup,
  unchangedMessage,
  writeSelectedFilesBackToOverleaf,
  type OverleafZipBackup,
} from '../overleaf/live/overleafWriteBack';
import {
  LiveSyncError,
  asDetail,
  recoveryActionForLiveSyncError,
  type LiveSyncErrorCode,
  type WriteBackCandidate,
  type WriteBackResult,
} from '../overleaf/live/types';
import { computeSha256 } from '../diff/fileHasher';
import {
  isIgnoredByGitignores,
  parseGitignore,
  type GitignoreFile,
} from '../diff/gitignore';
import { isIgnored } from '../diff/ignoreRules';
import {
  hasOverleafUnstorableChars,
  normalizeLineEndings,
  toOverleafStorableText,
} from '../shared/lineEndings';
import {
  ALL_FILE_TYPES,
  DEFAULT_IGNORE_PATTERNS,
  SYMLINK_SKIPPED_REASON_PREFIX,
  writeBackExtensionsFor,
} from '../shared/constants';
import { formatGitHubError, isEmptyRepositoryError } from '../github/githubClient';
import { findCommonTopLevelFolder } from '../zip/normalizeZipPaths';
import type { ExperimentalConfig, ProjectFile, RepoConfig } from '../shared/types';
import type {
  GitHubBranchSnapshot,
  GitHubGitignore,
  GitHubTreeEntry,
} from './sourceFromGitHubBranch';

export type CreateResult = {
  path: string;
  // 'created'  -> doc exists on Overleaf with the expected content
  // 'failed'   -> creation attempted and the bridge returned an error
  // 'skipped'  -> nothing created (extension not in the user's writeBack
  //               whitelist, the name was already taken in Overleaf, or
  //               not attempted after the connection to the Overleaf tab
  //               was lost)
  status: 'created' | 'failed' | 'skipped';
  message?: string;
};

// Row text when the popup gave up waiting (code 'network'): the content
// script may still finish the request. Running the pull again is safe and
// settles it: an uploaded file is then skipped as existing, and a doc
// created empty is filled in by the normal write path.
const CREATE_TIMED_OUT_MESSAGE =
  'The Overleaf tab did not answer in time, so it is unknown whether this file was created. Run the pull again to check.';
const UPLOAD_TIMED_OUT_MESSAGE =
  'The Overleaf tab did not answer in time, so it is unknown whether this file was uploaded. Run the pull again to check.';
// Rows for binaries that are not uploaded.
const BINARY_EXISTS_ROW = 'Already in Overleaf. Existing files are never replaced.';
// The same case with "Make Overleaf match GitHub exactly" on: an uploaded
// file is compared and replaced there, so this is only a path where Overleaf
// keeps an editable text file but GitHub's file is not a known text type.
const BINARY_DOC_KEPT_ROW = 'Already in Overleaf as an editable text file. It is left as it is.';
const BINARY_MATCHES_ROW = 'Already in Overleaf with the same content.';
const BINARY_CREATE_OFF_ROW = 'Not in Overleaf yet. Tick “Also create new files in Overleaf” to upload it.';
// Row for a new text file whose type is not in the allowed list.
const CREATE_TYPE_NOT_ALLOWED_ROW =
  'Not added: this file type is not in Options → Allowed write-back extensions.';
// Rows for a GitHub text file that is not valid UTF-8 (for example saved as
// Windows-1252): Overleaf would get U+FFFD where the odd characters are, so
// the pull never writes or adds it. The Not-pulled row is the doc / create
// row; the reason is the preview's left-out line.
const NOT_UTF8_ROW =
  "Not pulled: this file isn't saved as UTF-8 text, so Overleaf would show some characters as \uFFFD. Re-save it as UTF-8 to pull it.";
const NOT_UTF8_REASON =
  "it isn't saved as UTF-8 text, so Overleaf would show some characters as \uFFFD. Re-save it as UTF-8 to pull it.";

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
  toCreate: Array<{ path: string; content: string; hasUnstorableChars?: boolean }>,
  allowedExtensions: string[],
  onProgress: (msg: string) => void,
): Promise<CreateResult[]> {
  const allowed = new Set(allowedExtensions);
  const allTypes = allowed.has(ALL_FILE_TYPES);
  const results: CreateResult[] = [];

  for (let i = 0; i < toCreate.length; i++) {
    const candidate = toCreate[i]!;
    const ext = getExtension(candidate.path);
    if (!allTypes && !allowed.has(ext)) {
      results.push({ path: candidate.path, status: 'skipped', message: CREATE_TYPE_NOT_ALLOWED_ROW });
      continue;
    }

    onProgress(`Adding ${i + 1}/${toCreate.length}: ${candidate.path}`);
    try {
      const response = await session.createDocAtPath(
        candidate.path,
        toOverleafStorableText(candidate.content),
      );
      if (response.ok) {
        results.push({
          path: candidate.path,
          status: 'created',
          ...(candidate.hasUnstorableChars ? { message: UNSTORABLE_WRITTEN_NOTE } : {}),
        });
      } else if (response.code === 'already_exists' || response.code === 'not_attempted') {
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
//   - already in Overleaf as a fileRef -> skip (uploads never replace)
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
      results.push({ path: file.path, status: 'skipped', message: BINARY_EXISTS_ROW });
      continue;
    }
    if (!createMissing) {
      results.push({ path: file.path, status: 'skipped', message: BINARY_CREATE_OFF_ROW });
      continue;
    }

    onProgress(`Uploading ${i + 1}/${binaryFiles.length}: ${file.path}`);
    try {
      const contentBase64 = uint8ToBase64(file.content);
      const response = await session.uploadBinary(file.path, contentBase64);
      if (response.ok) {
        results.push({ path: file.path, status: 'uploaded' });
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

const nfc = (text: string): string => text.normalize('NFC');

// Gives each GitHub file the spelling Overleaf already uses for its folders
// and for itself when the two differ only in Unicode normalization (NFC
// against NFD). Exact matches win. A name that fits more than one Overleaf
// entry, and no exact one, is returned in `ambiguous` and left out of the
// pull. A file with no counterpart keeps its path.
export function alignGitHubNamesWithOverleaf(
  files: ProjectFile[],
  entries: FlatProjectEntry[],
  folders: Array<{ path: string }>,
): { files: ProjectFile[]; ambiguous: ProjectFile[] } {
  const byNfc = (paths: string[]): Map<string, string[]> => {
    const out = new Map<string, string[]>();
    for (const path of paths) {
      const key = nfc(path);
      const list = out.get(key);
      if (list) list.push(path);
      else out.set(key, [path]);
    }
    return out;
  };
  const folderNames = byNfc(folders.map((f) => f.path));
  const entryNames = byNfc(entries.map((e) => e.path));
  // The Overleaf spelling of `candidate`: itself, the only entry it matches,
  // 'none', or 'ambiguous'.
  const resolve = (
    names: Map<string, string[]>,
    candidate: string,
  ): string | 'none' | 'ambiguous' => {
    const list = names.get(nfc(candidate));
    if (!list) return 'none';
    if (list.includes(candidate)) return candidate;
    return list.length === 1 ? list[0]! : 'ambiguous';
  };

  const aligned: Array<{ file: ProjectFile; original: ProjectFile; moved: boolean }> = [];
  const ambiguous: ProjectFile[] = [];
  for (const file of files) {
    const segments = file.path.split('/');
    let prefix = '';
    let unclear = false;
    for (let i = 0; i < segments.length - 1 && !unclear; i++) {
      const candidate = prefix ? `${prefix}/${segments[i]}` : segments[i]!;
      const hit = resolve(folderNames, candidate);
      if (hit === 'ambiguous') unclear = true;
      else prefix = hit === 'none' ? candidate : hit;
    }
    const leaf = segments[segments.length - 1]!;
    const candidate = prefix ? `${prefix}/${leaf}` : leaf;
    const hit = unclear ? 'ambiguous' : resolve(entryNames, candidate);
    if (hit === 'ambiguous') {
      ambiguous.push(file);
      continue;
    }
    const path = hit === 'none' ? candidate : hit;
    aligned.push(
      path === file.path
        ? { file, original: file, moved: false }
        : { file: { ...file, path }, original: file, moved: true },
    );
  }
  // Two GitHub names that land on one Overleaf path (the repository holds
  // both spellings): the one that already reads exactly like Overleaf's
  // stays, a respelled one is left out.
  const perPath = new Map<string, number>();
  for (const { file } of aligned) perPath.set(file.path, (perPath.get(file.path) ?? 0) + 1);
  const kept: ProjectFile[] = [];
  for (const { file, original, moved } of aligned) {
    if (moved && (perPath.get(file.path) ?? 0) > 1) {
      ambiguous.push(original);
    } else {
      kept.push(file);
    }
  }
  return { files: kept, ambiguous };
}

// True only when the backup ZIP holds the GitHub content for this doc, i.e.
// Overleaf already has it and the doc needs no socket work. Identical text
// matches, and so does text that differs only in what Overleaf can't keep:
// it has no "\r" (a CRLF or CR file never has them), and it turns each half
// of an emoji into U+FFFD. Anything else (a BOM, an encoding difference, a
// real edit) goes through the full read / conflict / write / verify path.
export function zipMatchesGitHub(
  zipFile: ProjectFile | undefined,
  gitHubFile: ProjectFile,
): boolean {
  if (!zipFile || zipFile.isBinary || gitHubFile.isBinary) return false;
  if (zipFile.text === undefined || gitHubFile.text === undefined) return false;
  if (
    zipFile.sizeBytes === gitHubFile.sizeBytes &&
    zipFile.sha256 === gitHubFile.sha256 &&
    zipFile.text === gitHubFile.text
  ) {
    return true;
  }
  return normalizeLineEndings(zipFile.text) === toOverleafStorableText(gitHubFile.text);
}

// "Make Overleaf match GitHub exactly" result rows.
export type FileReplaceResult = {
  path: string;
  // 'replaced' -> Overleaf now holds the GitHub bytes
  // 'skipped'  -> nothing changed: Overleaf's file changed after the
  //               preview, or it could not be checked
  // 'failed'   -> the upload went wrong or its outcome is unknown
  status: 'replaced' | 'skipped' | 'failed';
  message?: string;
};

export type DeleteResult = {
  path: string;
  kind: 'doc' | 'file' | 'folder';
  // 'deleted' -> gone from Overleaf
  // 'skipped' -> kept: it changed after the preview, could not be checked,
  //              or was not attempted
  // 'failed'  -> the delete went wrong or its outcome is unknown
  status: 'deleted' | 'skipped' | 'failed';
  message?: string;
};

// What applyPullPlan reports, one row per file. A list is null when the
// pull had no file of that kind.
export type PullIntoOverleafOutcome = {
  // GitHub text files that have an Overleaf doc, and (as skipped rows) those
  // whose path is an uploaded file there.
  results: WriteBackResult[] | null;
  // GitHub text files without one ("Also create new files" on).
  createResults: CreateResult[] | null;
  binaryResults: BinaryResult[] | null;
  // Only with "Make Overleaf match GitHub exactly" (null otherwise): uploaded
  // files compared with GitHub, and the deletions.
  fileReplaceResults?: FileReplaceResult[] | null;
  deleteResults?: DeleteResult[] | null;
};

// Recovery line for the pull error banners (popup and Options). The generic
// hints (recoveryActionForLiveSyncError) suggest the ZIP route, which copies
// Overleaf to GitHub, so it is no fallback for a pull. null when the message
// already gives the advice.
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

// An apply reuses the plan's ZIP backup only while it is this recent; an
// older one is taken again before the first write.
export const PLAN_ZIP_BACKUP_MAX_AGE_MS = 10 * 60_000;

// Row text for a planned doc that no longer holds the text the preview was
// computed from: it was edited in Overleaf after the preview, and the
// conflict check left it as it is.
export const EDITED_AFTER_PREVIEW_MESSAGE =
  'Not replaced: this file was edited in Overleaf after the preview, so that edit was kept. Run the pull again to review it.';


// Reasons the preview gives for the files a pull leaves alone.
const ONLY_ON_GITHUB_REASON = 'only on GitHub. Tick “Also create new files in Overleaf” to add it.';
const TYPE_NOT_ALLOWED_REASON =
  'its file type is not in your allowed list (Options → Allowed write-back extensions).';
const BINARY_EXISTS_REASON =
  'already in Overleaf. Existing images and other non-text files are never replaced.';
const UPLOADED_FILE_AT_PATH_REASON =
  'Overleaf has an uploaded file at this path, and the pull never replaces one.';
const BINARY_DOC_KEPT_REASON =
  "Overleaf keeps an editable text file at this path, but GitHub's file is not a known text type. It is left as it is, and it is not deleted.";
// A GitHub symbolic link: there is no file content to copy.
const SYMLINK_NOT_PULLED_REASON =
  "it is a symbolic link on GitHub, which isn't a file Overleaf can hold, so it is never added.";
// Overleaf has more than one file whose name differs from GitHub's only in
// how accented letters are encoded (for example "ü" as one character or as
// "u" plus a mark), so the pull can't tell which one GitHub means.
const AMBIGUOUS_NAME_REASON =
  'Overleaf has more than one file with this name written with different accent encodings, so it is not clear which one GitHub means. It is left as it is.';
const AMBIGUOUS_NAME_ROW = `Not changed: ${AMBIGUOUS_NAME_REASON}`;
const BINARY_OFF_REASON =
  'not a known text file type. Turn on “Allow uploading new images and other non-text files” in Options to upload it.';

function readFailedReason(detail: string): string {
  return `could not be read from Overleaf, so it will not be written. Run the pull again. Details: ${asDetail(detail)}.`;
}

// One existing Overleaf doc the pull would replace with the GitHub version.
export type PlannedReplace = {
  path: string;
  // The Overleaf text read while planning. It is the conflict base for the
  // write, so an edit made in Overleaf after the preview is a conflict.
  baseText: string;
  newText: string;
  // Approximate size of the change, for the preview (countChangedLines).
  linesAdded: number;
  linesRemoved: number;
  // The GitHub text had characters Overleaf can't store (such as emoji), which
  // newText already has as U+FFFD; the preview and the result row say so.
  hasUnstorableChars?: boolean;
};

// An uploaded file in Overleaf (a fileRef) that "Make Overleaf match GitHub
// exactly" will replace, because its bytes differ from the GitHub file.
export type PlannedFileReplace = {
  path: string;
  // The file ID Overleaf had at `path` when planning. The upload is refused
  // unless the path still holds this file.
  fileId: string;
  // SHA-256 and size of the Overleaf bytes read while planning: the base the
  // apply compares a fresh read against, as the doc replace does with text.
  baseSha256: string;
  baseSizeBytes: number;
  // The GitHub bytes that will be uploaded.
  newBytes: Uint8Array;
  newSha256: string;
  newSizeBytes: number;
  // Overleaf marks the file as a linked file (imported from a URL or another
  // project). The upload makes it a plain uploaded file, which the preview
  // says.
  linked?: boolean;
};

// One Overleaf entity that "Make Overleaf match GitHub exactly" will delete:
// not on GitHub, and not matching the ignore patterns.
export type PlannedDelete = {
  path: string;
  kind: 'doc' | 'file' | 'folder';
  // The entity ID Overleaf had at `path` when planning.
  entityId: string;
  // Docs: the text read while planning, the base a fresh read is compared with.
  baseText?: string;
  // The project's main document (Overleaf has no main document once it is
  // deleted); the preview warns about it.
  isRootDoc?: boolean;
};

// Why a file that is only in Overleaf is kept instead of deleted:
//   build       a build file such as .aux or .log (DEFAULT_IGNORE_PATTERNS)
//   pattern     one of the ignore patterns the user set for this project
//   gitignore   the repository's own .gitignore excludes it
//   submodule   it is at or under a path GitHub has as a submodule
//   symlink     it is at or under a path GitHub has as a symbolic link
export type MirrorKeepSource = 'build' | 'pattern' | 'gitignore' | 'submodule' | 'symlink';

export type MirrorKept = { path: string; source: MirrorKeepSource };

// The extra work of "Make Overleaf match GitHub exactly". A plan has one
// only when the option was on for its pull.
export type MirrorPlan = {
  replaceFiles: PlannedFileReplace[];
  // Docs and uploaded files first (by path), then folders, deepest first. An
  // apply deletes them in this order.
  deletions: PlannedDelete[];
  // Docs and uploaded files in `deletions`, and folders in it.
  deleteFileCount: number;
  deleteFolderCount: number;
  // Docs and uploaded files in the project when planning, not counting the
  // ones kept for being ignored or inside a submodule or symlink (`kept`):
  // the base of the large-deletion share and of the mapping checks.
  projectFileCount: number;
  // More than MIRROR_LARGE_DELETION_FILES files, or more than
  // MIRROR_LARGE_DELETION_FRACTION of the project's: the confirmation is
  // `delete N` instead of `delete`.
  largeDeletion: boolean;
  // Only in Overleaf but kept, each with the reason (see MirrorKeepSource).
  kept: MirrorKept[];
  // Only in Overleaf but kept for another reason, shown in the preview.
  notDeleted: Array<{ path: string; reason: string }>;
};

// A pull worked out without writing anything. applyPullPlan writes the
// replace, create and upload items (and, with `mirror`, the uploaded-file
// replacements and deletions), and nothing else.
export type PullPlan = {
  readonly projectId: string;
  readonly experimental: ExperimentalConfig;
  readonly createMissing: boolean;
  readonly replace: PlannedReplace[];
  // New docs ("Also create new files" on).
  readonly create: Array<{ path: string; content: string; hasUnstorableChars?: boolean }>;
  // New binaries ("Also create new files" on).
  readonly upload: ProjectFile[];
  // Files whose Overleaf copy already matches GitHub.
  readonly upToDate: string[];
  // GitHub text files with nothing at their path in Overleaf, whether created
  // or not. A path held by an uploaded file is not listed here.
  readonly missingInOverleaf: string[];
  // Files the pull leaves alone, with the reason the preview shows.
  readonly notPulled: Array<{ path: string; reason: string }>;
  // "Make Overleaf match GitHub exactly": null when the option was off.
  readonly mirror: MirrorPlan | null;
  // Used only by this module.
  readonly internal: PullPlanInternals;
};

type PullPlanInternals = {
  // Rows decided while planning (already matching, unreadable, filtered),
  // reported with the apply's rows.
  docRows: WriteBackResult[];
  createRows: CreateResult[];
  binaryRows: BinaryResult[];
  // Uploaded files that could not be read ("Make Overleaf match GitHub
  // exactly" only). One that already matches GitHub has no row: it is
  // counted in the plan's `upToDate`.
  fileReplaceRows: FileReplaceResult[];
  // Position of each GitHub path in the input, so rows keep GitHub's order.
  order: Map<string, number>;
  zipBackup: OverleafZipBackup | undefined;
  // Open from the end of planning until the plan is applied or discarded;
  // null when there is nothing to apply.
  session: OverleafBridgeSession | null;
  used: boolean;
};

// What "Make Overleaf match GitHub exactly" needs from GitHub and the
// project's mapping. Its presence turns the option on for a plan.
export type MirrorInput = {
  // Every entry of the branch inside the target directory, from
  // GitHubBranchSnapshot.treeEntries. Never the filtered `files` list: files
  // left out by type, binary or UTF-8 are still on GitHub and must not count
  // as missing.
  gitHubEntries: GitHubTreeEntry[];
  gitHubTreeTruncated?: boolean;
  // The mapping's ignore patterns (RepoConfig.ignorePatterns).
  // DEFAULT_IGNORE_PATTERNS always apply as well.
  ignorePatterns: string[];
  // The repository's .gitignore files that govern the target directory
  // (GitHubBranchSnapshot.gitignores): what they exclude is kept.
  gitignores: GitHubGitignore[];
  // The project's target directory (RepoConfig.targetDir), to line the
  // project's paths up with the repository paths the .gitignore files use.
  targetDir?: string;
};

// The mirror input for a pull, from the branch as it was just read and the
// project's mapping. The popup and the Options page both use it.
export function mirrorInputFromSnapshot(
  snapshot: Pick<GitHubBranchSnapshot, 'treeEntries' | 'treeTruncated' | 'gitignores'>,
  repo: Pick<RepoConfig, 'ignorePatterns' | 'targetDir'>,
): MirrorInput {
  return {
    gitHubEntries: snapshot.treeEntries,
    gitHubTreeTruncated: snapshot.treeTruncated,
    ignorePatterns: mirrorIgnorePatterns(repo),
    gitignores: snapshot.gitignores,
    targetDir: repo.targetDir,
  };
}

export type PullPlanParams = {
  projectId: string;
  // Files from sourceFromGitHubBranch (text and, if enabled, binaries).
  files: ProjectFile[];
  // The files sourceFromGitHubBranch left out (snapshot.skipped).
  skippedOnGitHub: Array<{ path: string; reason: string }>;
  experimental: ExperimentalConfig;
  createMissing: boolean;
  // Set for "Make Overleaf match GitHub exactly". The plan then also adds
  // new files of every type (as if "Also create new files" and all file
  // types and non-text uploads were on), and the callers must have fetched
  // `files` with pullSourceOptions(experimental, true).
  mirror?: MirrorInput;
  onProgress: (message: string) => void;
};

// Settings a pull with "Make Overleaf match GitHub exactly" uses instead of
// the stored ones: every file type, and new non-text files uploaded.
export function withMirrorSettings(experimental: ExperimentalConfig): ExperimentalConfig {
  return { ...experimental, includeAllFileTypes: true, allowBinaryWriteBack: true };
}

// Options for sourceFromGitHubBranch for a pull.
export function pullSourceOptions(
  experimental: ExperimentalConfig,
  mirror: boolean,
): { allowedExtensions: string[]; includeBinaries: boolean; readGitignores: boolean } {
  const effective = mirror ? withMirrorSettings(experimental) : experimental;
  return {
    allowedExtensions: writeBackExtensionsFor(effective),
    includeBinaries: effective.allowBinaryWriteBack,
    // The repository's .gitignore files protect files from the deletion.
    readGitignores: mirror,
  };
}

// The ignore patterns for the deletion rule: the mapping's, plus the
// defaults (build files such as .aux that never go to GitHub).
export function mirrorIgnorePatterns(repo: Pick<RepoConfig, 'ignorePatterns'>): string[] {
  return Array.from(new Set([...DEFAULT_IGNORE_PATTERNS, ...(repo.ignorePatterns ?? [])]));
}

// A pull deleting more than this many files, or more than this share of the
// project's files, asks for `delete N` instead of `delete`.
export const MIRROR_LARGE_DELETION_FILES = 20;
export const MIRROR_LARGE_DELETION_FRACTION = 0.3;

// Works out what a pull would do. Nothing is written:
//   0. Take the project's pull lock (projectPullLock.ts) while planning; a
//      second pull of the same project, from the popup or the Options page,
//      is refused.
//   1. Open one bridge session; its joinProject tree maps paths to IDs.
//   2. If any write may follow and the option is on, take the ZIP backup.
//      A failed backup aborts the pull here.
//   3. Docs whose ZIP text equals the GitHub text (ignoring line endings)
//      already match, with no socket work. The rest are read in pipelined
//      batches; a doc whose text differs from GitHub goes on the replace
//      list with that text as base.
//   4. With "Also create new files", new docs and new binaries go on the
//      create and upload lists.
// The lock is released when planning ends. The session stays open for
// applyPullPlan, unless there is nothing to apply. A plan that is never
// applied (Cancel, popup closed) writes nothing, and the content script
// closes its idle session.
export function planPullIntoOverleaf(params: PullPlanParams): Promise<PullPlan> {
  return withProjectPullLock(params.projectId, () => planUnderLock(params));
}

async function planUnderLock(params: PullPlanParams): Promise<PullPlan> {
  const { projectId, onProgress } = params;
  // "Make Overleaf match GitHub exactly" implies new files of every type.
  const mirrorInput = params.mirror;
  const experimental = mirrorInput ? withMirrorSettings(params.experimental) : params.experimental;
  const createMissing = mirrorInput ? true : params.createMissing;
  // Refuses (before any session is opened) when GitHub's tree can't be
  // trusted to say what is missing from it.
  const github = mirrorInput ? mirrorGitHubView(mirrorInput, params.files) : null;
  const allowedExtensions = writeBackExtensionsFor(experimental);
  const internal: PullPlanInternals = {
    docRows: [],
    createRows: [],
    binaryRows: [],
    fileReplaceRows: [],
    order: new Map(params.files.map((f, i) => [f.path, i] as const)),
    zipBackup: undefined,
    session: null,
    used: false,
  };
  const plan: PullPlan = {
    projectId,
    experimental,
    createMissing,
    replace: [],
    create: [],
    upload: [],
    upToDate: [],
    missingInOverleaf: [],
    notPulled: params.skippedOnGitHub.map((s) => ({
      path: s.path,
      reason: s.reason.startsWith(SYMLINK_SKIPPED_REASON_PREFIX)
        ? SYMLINK_NOT_PULLED_REASON
        : s.reason.startsWith('binary')
          ? BINARY_OFF_REASON
          : TYPE_NOT_ALLOWED_REASON,
    })),
    mirror: github
      ? {
          replaceFiles: [],
          deletions: [],
          deleteFileCount: 0,
          deleteFolderCount: 0,
          projectFileCount: 0,
          largeDeletion: false,
          kept: [],
          notDeleted: [],
        }
      : null,
    internal,
  };
  const unchangedRow = (file: ProjectFile, overleafText: string): WriteBackResult => ({
    path: file.path,
    status: 'skipped',
    message: unchangedMessage(file.text ?? '', overleafText, file.invalidUtf8 === true),
  });

  onProgress('Opening the Overleaf project…');
  const session = await OverleafBridgeSession.open(projectId);
  try {
    // An Overleaf tab with an older content script can't carry out the
    // option: stop before anything is read or written.
    if (github) session.requireMirrorSupport();
    const entries = flattenProjectTree(session.rootFolder);
    const docIdByPath = new Map<string, string>();
    const fileIdByPath = new Map<string, string>();
    for (const entry of entries) {
      if (entry.kind === 'doc' && entry.id) docIdByPath.set(entry.path, entry.id);
      if (entry.kind === 'file' && entry.id) fileIdByPath.set(entry.path, entry.id);
    }

    // A GitHub name that differs from an Overleaf one only in Unicode
    // normalization (NFC against NFD, as a Mac writes "ü") is the same file:
    // it takes Overleaf's spelling for every compare and write, so it is
    // neither added a second time nor deleted.
    const { files: gitHubFiles, ambiguous } = alignGitHubNamesWithOverleaf(
      params.files,
      entries,
      flattenProjectFolders(session.rootFolder),
    );
    gitHubFiles.forEach((f, i) => internal.order.set(f.path, i));
    for (const file of ambiguous) {
      plan.notPulled.push({ path: file.path, reason: AMBIGUOUS_NAME_REASON });
      if (file.isBinary) {
        internal.binaryRows.push({ path: file.path, status: 'skipped', message: AMBIGUOUS_NAME_ROW });
      } else {
        internal.docRows.push({ path: file.path, status: 'skipped', message: AMBIGUOUS_NAME_ROW });
      }
    }

    // Uploaded files that GitHub also has: with the option on they are
    // compared with the GitHub bytes (planMirror) instead of being left out.
    const fileRefCandidates: Array<{ file: ProjectFile; fileId: string }> = [];
    // Docs and uploaded files that only Overleaf has, and the ones kept
    // because they match the ignore patterns (decided from the tree alone).
    const mirrorScope = github ? scopeMirrorDeletions(github, entries, plan) : null;

    const matched: Array<{ file: ProjectFile; docId: string }> = [];
    const binaries: ProjectFile[] = [];
    for (const file of gitHubFiles) {
      if (file.isBinary) {
        binaries.push(file);
        continue;
      }
      const docId = docIdByPath.get(file.path);
      if (docId) {
        matched.push({ file, docId });
        continue;
      }
      const fileId = fileIdByPath.get(file.path);
      if (fileId !== undefined) {
        if (github) {
          fileRefCandidates.push({ file, fileId });
          continue;
        }
        // Overleaf refuses a doc whose name is taken by a file, and the pull
        // never replaces a file. Not "missing": it is reported as not
        // changed, and never offered for creation, whether or not "Also
        // create new files" is on.
        plan.notPulled.push({ path: file.path, reason: UPLOADED_FILE_AT_PATH_REASON });
        internal.docRows.push({
          path: file.path,
          status: 'skipped',
          message: UPLOADED_FILE_AT_PATH_REASON,
        });
        continue;
      }
      plan.missingInOverleaf.push(file.path);
      if (createMissing && !isAllowedWriteBackExtension(file.path, allowedExtensions)) {
        // Same row createMissingDocsForPull gives it.
        plan.notPulled.push({ path: file.path, reason: TYPE_NOT_ALLOWED_REASON });
        internal.createRows.push({ path: file.path, status: 'skipped', message: CREATE_TYPE_NOT_ALLOWED_ROW });
      } else if (file.invalidUtf8) {
        // Never added, with "Also create new files" on or off: the text
        // read from the file is not what the file holds.
        plan.notPulled.push({ path: file.path, reason: NOT_UTF8_REASON });
        internal.createRows.push({ path: file.path, status: 'skipped', message: NOT_UTF8_ROW });
      } else if (!createMissing) {
        plan.notPulled.push({ path: file.path, reason: ONLY_ON_GITHUB_REASON });
      } else {
        const text = file.text ?? '';
        plan.create.push({
          path: file.path,
          content: toOverleafStorableText(text),
          ...(hasOverleafUnstorableChars(text) ? { hasUnstorableChars: true } : {}),
        });
      }
    }

    const isTaken = (path: string) => fileIdByPath.has(path) || docIdByPath.has(path);
    const mayWrite =
      matched.length > 0 ||
      plan.create.length > 0 ||
      (createMissing && binaries.some((f) => !isTaken(f.path))) ||
      // Deleting, or replacing an uploaded file, are writes too.
      (mirrorScope !== null &&
        (mirrorScope.deleteCandidates.length > 0 ||
          fileRefCandidates.length > 0 ||
          binaries.some((f) => fileIdByPath.has(f.path))));
    // The backup gates every write of this run: doc writes, creates and
    // uploads.
    if (experimental.requireZipBackupBeforeWriteBack && mayWrite) {
      onProgress('Checking that Overleaf can export the project…');
      internal.zipBackup = await takeZipBackup(projectId, entries.length > 0);
    }
    // No snapshot (backup off or not parsed) means no ZIP-skip: every doc
    // is read, and an existing binary is not compared.
    const zipByPath = internal.zipBackup?.snapshot
      ? alignZipWithProjectTree(
          internal.zipBackup.snapshot.files,
          entries.map((e) => e.path),
        )
      : null;

    for (const file of binaries) {
      if (isTaken(file.path)) {
        const fileId = fileIdByPath.get(file.path);
        if (github && fileId !== undefined) {
          fileRefCandidates.push({ file, fileId });
          continue;
        }
        const zipFile = zipByPath?.get(file.path);
        if (zipFile && zipFile.sizeBytes === file.sizeBytes && zipFile.sha256 === file.sha256) {
          plan.upToDate.push(file.path);
          internal.binaryRows.push({ path: file.path, status: 'skipped', message: BINARY_MATCHES_ROW });
        } else if (github) {
          // With the option on an uploaded file is compared and replaced
          // (above), so only an editable doc can be here: "never replaced"
          // would be wrong wording.
          plan.notPulled.push({ path: file.path, reason: BINARY_DOC_KEPT_REASON });
          internal.binaryRows.push({ path: file.path, status: 'skipped', message: BINARY_DOC_KEPT_ROW });
        } else {
          plan.notPulled.push({ path: file.path, reason: BINARY_EXISTS_REASON });
          internal.binaryRows.push({ path: file.path, status: 'skipped', message: BINARY_EXISTS_ROW });
        }
      } else if (!createMissing) {
        plan.notPulled.push({ path: file.path, reason: ONLY_ON_GITHUB_REASON });
        internal.binaryRows.push({ path: file.path, status: 'skipped', message: BINARY_CREATE_OFF_ROW });
      } else {
        plan.upload.push({ ...file });
      }
    }

    const toRead: Array<{ file: ProjectFile; docId: string }> = [];
    for (const m of matched) {
      const path = m.file.path;
      if (!isAllowedWriteBackExtension(path, allowedExtensions)) {
        // Never written: writeSelectedFilesBackToOverleaf rejects it by
        // extension. Same row it would give.
        const { rejected } = filterWriteBackCandidates(
          [{ path, oldText: '', newText: m.file.text ?? '', baseSha256: '' }],
          {
            requireZipBackup: experimental.requireZipBackupBeforeWriteBack,
            requireConfirmation: false,
            allowedExtensions,
            allowBinary: experimental.allowBinaryWriteBack,
          },
        );
        internal.docRows.push(...rejected);
        plan.notPulled.push({ path, reason: TYPE_NOT_ALLOWED_REASON });
      } else if (zipByPath && zipMatchesGitHub(zipByPath.get(path), m.file)) {
        plan.upToDate.push(path);
        internal.docRows.push(unchangedRow(m.file, zipByPath.get(path)?.text ?? ''));
      } else {
        toRead.push(m);
      }
    }

    if (toRead.length > 0) {
      const reads = await session.readDocs(
        toRead.map((m) => m.docId),
        (done, total) => onProgress(`Reading files from Overleaf ${done}/${total}…`),
      );
      for (const m of toRead) {
        const path = m.file.path;
        // Overleaf keeps no "\r" (document-updater splits lines on
        // \r\n|\n|\r) and turns each surrogate into U+FFFD, so plan, write
        // and verify the text it can actually hold.
        const newText = toOverleafStorableText(m.file.text ?? '');
        const read = reads.get(m.docId);
        if (read && read.ok) {
          if (normalizeLineEndings(read.text) === newText) {
            plan.upToDate.push(path);
            internal.docRows.push(unchangedRow(m.file, read.text));
            continue;
          }
          if (m.file.invalidUtf8) {
            // Overleaf holds something else than the lossy text of this file
            // (it may be the properly decoded text), so writing would replace
            // it with U+FFFD. Leave it alone.
            plan.notPulled.push({ path, reason: NOT_UTF8_REASON });
            internal.docRows.push({ path, status: 'skipped', message: NOT_UTF8_ROW });
            continue;
          }
          const { added, removed } = countChangedLines(read.text, newText);
          plan.replace.push({
            path,
            baseText: read.text,
            newText,
            linesAdded: added,
            linesRemoved: removed,
            ...(hasOverleafUnstorableChars(m.file.text ?? '') ? { hasUnstorableChars: true } : {}),
          });
        } else {
          // No base text, so no safe write: an empty stand-in base would make
          // the conflict check call a non-empty doc "unchanged" whenever the
          // GitHub file is empty. The read already had one retry in the
          // content script; a new pull reads it again.
          const detail = read?.message ?? 'no result';
          internal.docRows.push({ path, status: 'failed', message: readFailedMessage(detail) });
          plan.notPulled.push({ path, reason: readFailedReason(detail) });
        }
      }
    }

    if (github && mirrorScope) {
      await planMirror({
        session,
        plan,
        github,
        scope: mirrorScope,
        entries,
        fileRefCandidates,
        zipByPath,
        onProgress,
      });
    }

    plan.notPulled.sort((a, b) => a.path.localeCompare(b.path));
    if (pullPlanChangeCount(plan) > 0) internal.session = session;
    return plan;
  } finally {
    if (internal.session !== session) await session.close();
  }
}

// ── "Make Overleaf match GitHub exactly": planning ─────────────────────

const MIRROR_NOT_RUN = '“Make Overleaf match GitHub exactly” was not run, so nothing was changed in Overleaf.';
const MIRROR_UNTICK_RECOVERY =
  'Untick “Make Overleaf match GitHub exactly” to pull without deleting anything.';
const MIRROR_CHECK_MAPPING_RECOVERY =
  'Check the branch and the target directory of this project in Options, or untick “Make Overleaf match GitHub exactly”.';

// What exists on GitHub, for the deletion rule. Every path is in Unicode NFC,
// so a name written the other way (NFD) still counts as the same file.
type MirrorGitHubView = {
  // Every entry of the branch inside the target directory, of any kind, plus
  // the parent folders of each (a tree listing has them, but a caller's list
  // might not) and every pulled file.
  paths: Set<string>;
  // Regular files only (and every pulled file): what an Overleaf file can
  // "line up" with. A submodule or a symbolic link is not one.
  filePaths: Set<string>;
  // Submodules and symbolic links: Overleaf's files at or under these paths
  // are kept, because GitHub's tree doesn't list what is behind them.
  opaque: Map<string, 'submodule' | 'symlink'>;
  // Build files (DEFAULT_IGNORE_PATTERNS), then the mapping's own patterns,
  // then the repository's .gitignore files.
  buildPatterns: string[];
  userPatterns: string[];
  gitignores: GitignoreFile[];
  // The project's target directory, to turn a project path into the
  // repository path the .gitignore files use ('' for none).
  targetDir: string;
};

function mirrorGitHubView(input: MirrorInput, files: ProjectFile[]): MirrorGitHubView {
  if (input.gitHubTreeTruncated) {
    throw new LiveSyncError(
      'write_back_not_safe',
      `${MIRROR_NOT_RUN} GitHub listed only part of this repository because it has too many files, so a file that is only in Overleaf can't be told apart from one GitHub left out of the list.`,
      MIRROR_UNTICK_RECOVERY,
    );
  }
  const paths = new Set<string>();
  const filePaths = new Set<string>();
  const opaque = new Map<string, 'submodule' | 'symlink'>();
  const addWithParents = (rawPath: string): void => {
    const path = nfc(rawPath);
    paths.add(path);
    let slash = path.lastIndexOf('/');
    while (slash > 0) {
      paths.add(path.slice(0, slash));
      slash = path.lastIndexOf('/', slash - 1);
    }
  };
  for (const entry of input.gitHubEntries) {
    addWithParents(entry.path);
    if (entry.kind === 'file') filePaths.add(nfc(entry.path));
    if (entry.kind === 'submodule' || entry.kind === 'symlink') opaque.set(nfc(entry.path), entry.kind);
  }
  for (const file of files) {
    addWithParents(file.path);
    filePaths.add(nfc(file.path));
  }
  if (filePaths.size === 0) {
    throw new LiveSyncError(
      'write_back_not_safe',
      `${MIRROR_NOT_RUN} GitHub has no files in the repository folder this project is linked to, so every file in Overleaf would be deleted.`,
      'Check the branch and the target directory of this project in Options, or untick “Make Overleaf match GitHub exactly”.',
    );
  }
  const buildPatterns = DEFAULT_IGNORE_PATTERNS.map(nfc);
  return {
    paths,
    filePaths,
    opaque,
    buildPatterns,
    userPatterns: input.ignorePatterns.map(nfc).filter((p) => !buildPatterns.includes(p)),
    gitignores: (input.gitignores ?? []).map((g) => ({ dir: g.dir, rules: parseGitignore(g.text) })),
    targetDir: (input.targetDir ?? '').trim().replace(/^\/+|\/+$/g, ''),
  };
}

// Set when `path` is, or lies under, a submodule or symbolic link of GitHub.
function opaqueKeep(github: MirrorGitHubView, path: string): 'submodule' | 'symlink' | null {
  if (github.opaque.size === 0) return null;
  let prefix = '';
  for (const segment of nfc(path).split('/')) {
    prefix = prefix ? `${prefix}/${segment}` : segment;
    const kind = github.opaque.get(prefix);
    if (kind) return kind;
  }
  return null;
}

// Why an Overleaf path that GitHub doesn't have is kept as ignored, or null.
// Checked in this order, so the preview names the most specific reason.
function ignoreKeep(github: MirrorGitHubView, path: string, isDir: boolean): MirrorKeepSource | null {
  const normalized = nfc(path);
  if (isIgnored(normalized, github.buildPatterns)) return 'build';
  if (github.userPatterns.length > 0 && isIgnored(normalized, github.userPatterns)) return 'pattern';
  if (
    github.gitignores.length > 0 &&
    isIgnoredByGitignores(
      github.targetDir ? `${github.targetDir}/${normalized}` : normalized,
      isDir,
      github.gitignores,
    )
  ) {
    return 'gitignore';
  }
  return null;
}

type MirrorScope = {
  // Docs and uploaded files that GitHub doesn't have and that are not kept:
  // the deletion candidates.
  deleteCandidates: FlatProjectEntry[];
};

// A mapping that doesn't line up with the project, or one where most of the
// project isn't on GitHub, would turn a mirror into wiping the project.
const MIRROR_MIN_MATCH_SHARE = 0.5;

// Splits the Overleaf tree by the deletion rule, from the tree alone (no
// Overleaf read yet), so the ZIP backup can be taken before anything else if
// a write might follow. Refuses when the mapping looks wrong.
function scopeMirrorDeletions(
  github: MirrorGitHubView,
  entries: FlatProjectEntry[],
  plan: PullPlan,
): MirrorScope {
  const mirror = plan.mirror!;
  const deleteCandidates: FlatProjectEntry[] = [];
  // The files that say whether this project lines up with GitHub: not kept
  // as ignored, and not inside a submodule or symbolic link.
  const comparable: FlatProjectEntry[] = [];
  for (const entry of entries) {
    const opaque = opaqueKeep(github, entry.path);
    if (opaque) {
      mirror.kept.push({ path: entry.path, source: opaque });
      continue;
    }
    // On GitHub as anything (a file, or a folder of that name): never missing.
    const onGitHub = github.paths.has(nfc(entry.path));
    if (!onGitHub) {
      const ignored = ignoreKeep(github, entry.path, false);
      if (ignored) {
        mirror.kept.push({ path: entry.path, source: ignored });
        continue;
      }
    }
    comparable.push(entry);
    if (onGitHub) continue;
    if (!entry.id) {
      mirror.notDeleted.push({ path: entry.path, reason: NOT_DELETED_NO_ID_REASON });
      continue;
    }
    deleteCandidates.push(entry);
  }
  mirror.projectFileCount = comparable.length;
  if (deleteCandidates.length > 0) refuseIfMappingLooksWrong(github, comparable);
  mirror.kept.sort((a, b) => a.path.localeCompare(b.path));
  return { deleteCandidates };
}

// Throws (before anything is touched) when the files of the project that are
// neither ignored nor behind a submodule or symbolic link don't line up with
// GitHub well enough to trust the deletion.
function refuseIfMappingLooksWrong(github: MirrorGitHubView, comparable: FlatProjectEntry[]): void {
  const total = comparable.length;
  const matched = comparable.filter((e) => github.filePaths.has(nfc(e.path))).length;
  const files = (n: number) => `${n} file${n === 1 ? '' : 's'}`;

  // Every file sits in one folder that GitHub doesn't have around them: the
  // export from Overleaf drops a folder that holds everything, so GitHub
  // holds the files one level up.
  const top = findCommonTopLevelFolder(comparable.map((e) => e.path));
  if (top) {
    const strippedMatched = comparable.filter((e) =>
      github.filePaths.has(nfc(e.path.slice(top.length + 1))),
    ).length;
    if (strippedMatched > matched) {
      throw new LiveSyncError(
        'write_back_not_safe',
        `${MIRROR_NOT_RUN} Every file in this Overleaf project is inside the folder “${top}”, but GitHub has the same files without that folder (${strippedMatched} of ${total} line up that way, against ${matched} as they are). Deleting would remove the project's files and add them again in a different place. The branch or the target directory of this project may be wrong.`,
        MIRROR_CHECK_MAPPING_RECOVERY,
      );
    }
  }
  if (matched === 0) {
    // Not one file has a counterpart on GitHub: almost surely the target
    // directory (or the branch) doesn't line up with this project, and
    // deleting would empty it.
    throw new LiveSyncError(
      'write_back_not_safe',
      `${MIRROR_NOT_RUN} None of the ${files(total)} in this Overleaf project has a file with the same path on GitHub, so deleting would remove the whole project. The branch or the target directory of this project may point at the wrong place.`,
      MIRROR_CHECK_MAPPING_RECOVERY,
    );
  }
  if (matched < MIRROR_MIN_MATCH_SHARE * total) {
    throw new LiveSyncError(
      'write_back_not_safe',
      `${MIRROR_NOT_RUN} Only ${matched} of the ${files(total)} in this Overleaf project (not counting build and ignored files) ${matched === 1 ? 'has' : 'have'} the same path on GitHub, so deleting would remove most of the project. The branch or the target directory of this project may point at the wrong place.`,
      'Check the branch and the target directory of this project in Options. If the other files really exist only in Overleaf, commit them to GitHub first, or untick “Make Overleaf match GitHub exactly”.',
    );
  }
}

const NOT_DELETED_NO_ID_REASON =
  'only in Overleaf, but Overleaf gave it no ID the extension could use, so it will not be deleted.';
const FILE_READ_FAILED_REASON_PREFIX = 'could not be read from Overleaf, so it will not be replaced. Run the pull again.';
const DELETE_READ_FAILED_REASON_PREFIX = 'only in Overleaf, but it could not be read, so it will not be deleted. Run the pull again.';

type MirrorPlanContext = {
  session: OverleafBridgeSession;
  plan: PullPlan;
  github: MirrorGitHubView;
  scope: MirrorScope;
  entries: FlatProjectEntry[];
  fileRefCandidates: Array<{ file: ProjectFile; fileId: string }>;
  zipByPath: Map<string, ProjectFile> | null;
  onProgress: (message: string) => void;
};

// The second half of the plan with "Make Overleaf match GitHub exactly",
// still read-only:
//   (a) Uploaded files that GitHub also has. Equal bytes (the backup ZIP
//       says so, or Overleaf's bytes hash the same) mean "already matches";
//       different bytes plan a replacement, which keeps the Overleaf file's
//       ID and hash as the base for the apply.
//   (b) Deletions: the candidates from scopeMirrorDeletions. A doc is read
//       first and its text kept as the base; one that can't be read stays.
//       A folder is deleted only if GitHub has no such folder, it isn't kept
//       as ignored or inside a submodule or symbolic link, and everything in
//       it is being deleted (or it is empty already).
async function planMirror(ctx: MirrorPlanContext): Promise<void> {
  const { session, plan, github, scope, entries, fileRefCandidates, zipByPath, onProgress } = ctx;
  const mirror = plan.mirror!;
  const { internal } = plan;
  const linkedFileIds = new Set(
    entries.filter((e) => e.kind === 'file' && e.linked && e.id).map((e) => e.id as string),
  );

  // (a)
  const toHash: Array<{ file: ProjectFile; fileId: string }> = [];
  for (const candidate of fileRefCandidates) {
    const zipFile = zipByPath?.get(candidate.file.path);
    if (
      zipFile &&
      zipFile.sizeBytes === candidate.file.sizeBytes &&
      zipFile.sha256 === candidate.file.sha256
    ) {
      plan.upToDate.push(candidate.file.path);
    } else {
      toHash.push(candidate);
    }
  }
  if (toHash.length > 0) {
    const hashes = await session.hashFiles(
      toHash.map((c) => c.fileId),
      (done, total) => onProgress(`Comparing uploaded files with GitHub ${done}/${total}…`),
    );
    for (const { file, fileId } of toHash) {
      const hash = hashes.get(fileId);
      if (!hash || !hash.ok) {
        const detail = hash && !hash.ok ? hash.message : 'no result';
        plan.notPulled.push({
          path: file.path,
          reason: `${FILE_READ_FAILED_REASON_PREFIX} Details: ${asDetail(detail)}.`,
        });
        internal.fileReplaceRows.push({
          path: file.path,
          status: 'failed',
          message: `Not replaced: this uploaded file ${FILE_READ_FAILED_REASON_PREFIX} Details: ${asDetail(detail)}.`,
        });
        continue;
      }
      if (hash.sha256 === file.sha256 && hash.sizeBytes === file.sizeBytes) {
        plan.upToDate.push(file.path);
        continue;
      }
      mirror.replaceFiles.push({
        path: file.path,
        fileId,
        baseSha256: hash.sha256,
        baseSizeBytes: hash.sizeBytes,
        newBytes: file.content,
        newSha256: file.sha256,
        newSizeBytes: file.sizeBytes,
        ...(linkedFileIds.has(fileId) ? { linked: true } : {}),
      });
    }
    mirror.replaceFiles.sort((a, b) => a.path.localeCompare(b.path));
  }

  // (b) files and docs
  const fileDeletes: PlannedDelete[] = [];
  const docCandidates = scope.deleteCandidates.filter((e) => e.kind === 'doc');
  for (const entry of scope.deleteCandidates) {
    if (entry.kind === 'file') fileDeletes.push({ path: entry.path, kind: 'file', entityId: entry.id! });
  }
  if (docCandidates.length > 0) {
    const reads = await session.readDocs(
      docCandidates.map((e) => e.id!),
      (done, total) => onProgress(`Reading files that are only in Overleaf ${done}/${total}…`),
    );
    for (const entry of docCandidates) {
      const read = reads.get(entry.id!);
      if (read && read.ok) {
        fileDeletes.push({
          path: entry.path,
          kind: 'doc',
          entityId: entry.id!,
          baseText: read.text,
          ...(session.rootDocId !== undefined && entry.id === session.rootDocId ? { isRootDoc: true } : {}),
        });
      } else {
        const detail = read && !read.ok ? read.message : 'no result';
        mirror.notDeleted.push({
          path: entry.path,
          reason: `${DELETE_READ_FAILED_REASON_PREFIX} Details: ${asDetail(detail)}.`,
        });
      }
    }
  }
  fileDeletes.sort((a, b) => a.path.localeCompare(b.path));

  // (b) folders: not on GitHub, not kept, and left empty by the deletions
  // (or empty already).
  const deletedEntityIds = new Set(fileDeletes.map((d) => d.entityId));
  const deletedFolderIds = new Set<string>();
  const folderDeletes: PlannedDelete[] = [];
  const depth = (path: string): number => path.split('/').length;
  const folders = flattenProjectFolders(session.rootFolder).sort(
    (a, b) => depth(b.path) - depth(a.path) || a.path.localeCompare(b.path),
  );
  for (const folder of folders) {
    if (github.paths.has(nfc(folder.path))) continue;
    if (opaqueKeep(github, folder.path)) continue;
    if (ignoreKeep(github, folder.path, true)) continue;
    if (!folder.entryIds.every((id) => deletedEntityIds.has(id))) continue;
    if (!folder.folderIds.every((id) => deletedFolderIds.has(id))) continue;
    deletedFolderIds.add(folder.id);
    folderDeletes.push({ path: folder.path, kind: 'folder', entityId: folder.id });
  }

  mirror.deletions = [...fileDeletes, ...folderDeletes];
  mirror.deleteFileCount = fileDeletes.length;
  mirror.deleteFolderCount = folderDeletes.length;
  mirror.largeDeletion =
    mirror.deleteFileCount > MIRROR_LARGE_DELETION_FILES ||
    mirror.deleteFileCount > MIRROR_LARGE_DELETION_FRACTION * mirror.projectFileCount;
}

// Writes the plan's items, and nothing else:
//   0. Take the pull lock again; a pull of the project that is running now
//      refuses this one before anything is written.
//   1. With the backup option on, make sure this run has a ZIP backup no
//      older than PLAN_ZIP_BACKUP_MAX_AGE_MS: the plan's, or a new one. A
//      failed backup aborts before any write.
//   2. Replace docs through writeSelectedFilesBackToOverleaf with the text
//      read while planning as base: fresh read, conflict check,
//      version-checked write, verify-after-write. A doc edited in Overleaf
//      after the preview fails the conflict check and is left as it is.
//   3. Create the planned docs and upload the planned binaries. Both stay
//      create-only: a path taken since the plan is refused.
//   4. With "Make Overleaf match GitHub exactly" only: replace the planned
//      uploaded files, then delete the planned docs and uploaded files, then
//      the planned folders (applyMirror). Each is re-checked in Overleaf
//      right before it happens and skipped if it changed after the preview.
// The plan's session is reused (it reopens if the content script closed it
// while the preview was open) and closed at the end. A plan applies once;
// a file added on GitHub after the plan is not part of it.
export async function applyPullPlan(
  plan: PullPlan,
  onProgress: (message: string) => void,
  // What the user typed in the preview. Required (and checked here, not only
  // by the UI) when the plan deletes files or replaces uploaded files.
  typedConfirmation?: string,
): Promise<PullIntoOverleafOutcome> {
  const { internal } = plan;
  if (
    !internal.used &&
    pullHasDestructiveChanges(plan) &&
    !isPullConfirmationTyped(typedConfirmation ?? '', plan)
  ) {
    // Refused before anything is touched; the plan stays usable.
    throw new LiveSyncError(
      'write_back_not_safe',
      `Nothing was changed: this pull deletes or replaces files in Overleaf, and the confirmation (“${pullConfirmationWord(plan)}”) was not typed.`,
      'Type the confirmation word in the preview, then confirm.',
    );
  }
  if (internal.used) {
    throw new LiveSyncError(
      'unknown',
      'This preview was already used, so nothing was written.',
      'Run the pull again to see a new preview.',
    );
  }
  internal.used = true;
  const session = internal.session;
  internal.session = null;
  if (!session) return outcomeOf(plan, [], [], []);
  try {
    return await withProjectPullLock(plan.projectId, () =>
      applyUnderLock(plan, session, onProgress),
    );
  } finally {
    await session.close();
  }
}

// Ends a plan that will not be applied (Cancel). Nothing is written.
export async function discardPullPlan(plan: PullPlan): Promise<void> {
  const { internal } = plan;
  internal.used = true;
  const session = internal.session;
  internal.session = null;
  await session?.close();
}

async function applyUnderLock(
  plan: PullPlan,
  session: OverleafBridgeSession,
  onProgress: (message: string) => void,
): Promise<PullIntoOverleafOutcome> {
  const { projectId, experimental } = plan;
  const allowedExtensions = writeBackExtensionsFor(experimental);

  let zipBackup = plan.internal.zipBackup;
  if (
    experimental.requireZipBackupBeforeWriteBack &&
    !isRecentBackup(zipBackup, projectId, Date.now())
  ) {
    onProgress('Checking that Overleaf can export the project…');
    zipBackup = await takeZipBackup(projectId, flattenProjectTree(session.rootFolder).length > 0);
  }

  const docRows: WriteBackResult[] = [];
  if (plan.replace.length > 0) {
    onProgress(`Writing ${plan.replace.length} file(s) to Overleaf…`);
    const enc = new TextEncoder();
    const candidates: WriteBackCandidate[] = [];
    for (const item of plan.replace) {
      candidates.push({
        path: item.path,
        oldText: item.baseText,
        newText: item.newText,
        baseSha256: await computeSha256(enc.encode(item.baseText)),
      });
    }
    const written = await writeSelectedFilesBackToOverleaf(
      projectId,
      candidates,
      {
        requireZipBackup: experimental.requireZipBackupBeforeWriteBack,
        // The user confirmed the preview.
        requireConfirmation: false,
        allowedExtensions,
        allowBinary: experimental.allowBinaryWriteBack,
      },
      { session, zipBackup, onProgress },
    );
    const withUnstorable = new Set(
      plan.replace.filter((r) => r.hasUnstorableChars).map((r) => r.path),
    );
    for (const row of written) {
      if (row.status === 'conflict') {
        // Its only conflict: the fresh read differs from the planning read.
        docRows.push({ ...row, message: EDITED_AFTER_PREVIEW_MESSAGE });
      } else if (row.status === 'written' && !row.message && withUnstorable.has(row.path)) {
        docRows.push({ ...row, message: UNSTORABLE_WRITTEN_NOTE });
      } else {
        docRows.push(row);
      }
    }
  }

  const createRows =
    plan.create.length > 0
      ? await createMissingDocsForPull(session, plan.create, allowedExtensions, onProgress)
      : [];
  // The plan lists only paths that had no entry, and the content script
  // checks Overleaf's current listing again before each upload.
  const binaryRows =
    plan.upload.length > 0
      ? await uploadBinariesForPull(session, plan.upload, new Set(), true, onProgress)
      : [];
  // Uploaded-file replacements, then deletions: the destructive steps run
  // last, after everything the pull adds or updates.
  const mirrorRows = plan.mirror
    ? await applyMirror(session, plan.mirror, onProgress)
    : { fileReplaceRows: [], deleteRows: [] };
  return outcomeOf(plan, docRows, createRows, binaryRows, mirrorRows.fileReplaceRows, mirrorRows.deleteRows);
}

// ── "Make Overleaf match GitHub exactly": applying ─────────────────────

const REPLACE_TIMED_OUT_MESSAGE =
  'The Overleaf tab did not answer in time, so it is unknown whether this file was replaced. Run the pull again to check.';
const DELETE_TIMED_OUT_MESSAGE =
  'The Overleaf tab did not answer in time, so it is unknown whether this was deleted. Run the pull again to check.';
const FOLDER_NOT_EMPTY_ROW =
  'Not deleted: this folder still holds files that were not deleted, so it was kept.';

// Codes where the content script (or the popup) refused before changing
// anything: the row reads "Not replaced / Not deleted", not "Failed".
const REFUSED_CODES: ReadonlySet<LiveSyncErrorCode> = new Set<LiveSyncErrorCode>([
  'remote_changed',
  'write_back_not_safe',
  'not_attempted',
  'already_exists',
]);

// Row text when a repeated request (sent again because the first reply never
// arrived) found the work already done by the first one.
const REPLACED_CONFIRMED_MESSAGE =
  'Confirmed on a second check: Overleaf already holds the GitHub version.';
const DELETED_CONFIRMED_MESSAGE = 'Confirmed on a second check: Overleaf no longer has it.';

// Private on purpose: it skips the typed confirmation, so the only way in is
// applyPullPlan, which checks it against the plan first.
async function replaceUploadedFilesForPull(
  session: OverleafBridgeSession,
  items: PlannedFileReplace[],
  onProgress: (message: string) => void,
): Promise<FileReplaceResult[]> {
  const rows: FileReplaceResult[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    onProgress(`Replacing uploaded file ${i + 1}/${items.length}: ${item.path}`);
    try {
      const response = await session.replaceUploadedFile(
        item.path,
        item.fileId,
        item.baseSha256,
        uint8ToBase64(item.newBytes),
      );
      if (response.ok) {
        const notes = [
          response.data.becameDoc
            ? 'Overleaf now keeps this file as editable text instead of an uploaded file.'
            : '',
          response.data.alreadyDone ? REPLACED_CONFIRMED_MESSAGE : '',
        ].filter((note) => note !== '');
        rows.push({
          path: item.path,
          status: 'replaced',
          ...(notes.length > 0 ? { message: notes.join(' ') } : {}),
        });
      } else if (REFUSED_CODES.has(response.code)) {
        rows.push({ path: item.path, status: 'skipped', message: response.message });
      } else if (response.code === 'network') {
        rows.push({ path: item.path, status: 'failed', message: REPLACE_TIMED_OUT_MESSAGE });
      } else {
        rows.push({ path: item.path, status: 'failed', message: response.message });
      }
    } catch (e) {
      rows.push({
        path: item.path,
        status: 'failed',
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return rows;
}

// Deletes the planned entities in the plan's order: docs and uploaded files,
// then folders deepest first. A folder is only asked for when nothing in it
// was left behind; the content script checks again that it is empty. Private
// for the same reason as replaceUploadedFilesForPull.
async function deleteEntitiesForPull(
  session: OverleafBridgeSession,
  items: PlannedDelete[],
  onProgress: (message: string) => void,
): Promise<DeleteResult[]> {
  const enc = new TextEncoder();
  const rows: DeleteResult[] = [];
  // Paths of planned entities that are still in Overleaf.
  const kept: string[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    const row = (status: DeleteResult['status'], message?: string): void => {
      rows.push({ path: item.path, kind: item.kind, status, ...(message ? { message } : {}) });
      if (status !== 'deleted') kept.push(item.path);
    };
    if (item.kind === 'folder' && kept.some((p) => p.startsWith(`${item.path}/`))) {
      row('skipped', FOLDER_NOT_EMPTY_ROW);
      continue;
    }
    onProgress(`Deleting ${i + 1}/${items.length}: ${item.path}`);
    try {
      const response = await session.deleteEntity(
        item.kind,
        item.path,
        item.entityId,
        item.kind === 'doc' ? await computeSha256(enc.encode(item.baseText ?? '')) : undefined,
      );
      if (response.ok) row('deleted', response.data.alreadyDone ? DELETED_CONFIRMED_MESSAGE : undefined);
      else if (REFUSED_CODES.has(response.code)) row('skipped', response.message);
      else if (response.code === 'network') row('failed', DELETE_TIMED_OUT_MESSAGE);
      else row('failed', response.message);
    } catch (e) {
      row('failed', e instanceof Error ? e.message : String(e));
    }
  }
  return rows;
}

async function applyMirror(
  session: OverleafBridgeSession,
  mirror: MirrorPlan,
  onProgress: (message: string) => void,
): Promise<{ fileReplaceRows: FileReplaceResult[]; deleteRows: DeleteResult[] }> {
  const fileReplaceRows =
    mirror.replaceFiles.length > 0
      ? await replaceUploadedFilesForPull(session, mirror.replaceFiles, onProgress)
      : [];
  const deleteRows =
    mirror.deletions.length > 0 ? await deleteEntitiesForPull(session, mirror.deletions, onProgress) : [];
  return { fileReplaceRows, deleteRows };
}

function isRecentBackup(
  backup: OverleafZipBackup | undefined,
  projectId: string,
  now: number,
): boolean {
  if (!backup || backup.projectId !== projectId) return false;
  const age = now - Date.parse(backup.takenAt);
  return age >= 0 && age <= PLAN_ZIP_BACKUP_MAX_AGE_MS;
}

function outcomeOf(
  plan: PullPlan,
  docRows: WriteBackResult[],
  createRows: CreateResult[],
  binaryRows: BinaryResult[],
  fileReplaceRows: FileReplaceResult[] = [],
  deleteRows: DeleteResult[] = [],
): PullIntoOverleafOutcome {
  const { order } = plan.internal;
  const inGitHubOrder = <T extends { path: string }>(rows: T[]): T[] | null =>
    rows.length === 0
      ? null
      : rows.sort((a, b) => (order.get(a.path) ?? 0) - (order.get(b.path) ?? 0));
  return {
    results: inGitHubOrder([...plan.internal.docRows, ...docRows]),
    createResults: inGitHubOrder([...plan.internal.createRows, ...createRows]),
    binaryResults: inGitHubOrder([...plan.internal.binaryRows, ...binaryRows]),
    // Only a plan with the option on has these lists, so a pull without it
    // reports exactly what it always did. Deletion rows keep the order they
    // ran in (their paths are not on GitHub).
    ...(plan.mirror
      ? {
          fileReplaceResults: inGitHubOrder([...plan.internal.fileReplaceRows, ...fileReplaceRows]),
          deleteResults: deleteRows.length === 0 ? null : deleteRows,
        }
      : {}),
  };
}

// Approximate size of a change for the preview: lines only in the new text
// (added) and only in the old one (removed), compared as multisets, so a
// moved line counts as neither. Linear in the text size.
export function countChangedLines(
  oldText: string,
  newText: string,
): { added: number; removed: number } {
  const remaining = new Map<string, number>();
  for (const line of oldText.split('\n')) remaining.set(line, (remaining.get(line) ?? 0) + 1);
  let added = 0;
  for (const line of newText.split('\n')) {
    const left = remaining.get(line) ?? 0;
    if (left > 0) remaining.set(line, left - 1);
    else added++;
  }
  let removed = 0;
  for (const left of remaining.values()) removed += left;
  return { added, removed };
}

// ── Preview wording, shared by the popup and the Options page ──────────

// The word the user types to confirm a pull that replaces files.
export const PULL_CONFIRM_WORD = 'replace';
// The word for a pull that deletes files or replaces uploaded files
// ("Make Overleaf match GitHub exactly").
export const PULL_DELETE_WORD = 'delete';

export function pullPlanChangeCount(plan: PullPlan): number {
  return (
    plan.replace.length +
    plan.create.length +
    plan.upload.length +
    (plan.mirror ? plan.mirror.replaceFiles.length + plan.mirror.deletions.length : 0)
  );
}

// True when the plan would delete something in Overleaf or replace an
// uploaded file there. Such a pull always needs the typed `delete`, whatever
// "Ask me to confirm before replacing files in Overleaf" says.
export function pullHasDestructiveChanges(plan: PullPlan): boolean {
  return plan.mirror !== null && (plan.mirror.deletions.length > 0 || plan.mirror.replaceFiles.length > 0);
}

// What the user must type before the pull's confirm button works; null when
// nothing is asked. A destructive plan asks for `delete`, or `delete N`
// (N = the exact number of files to be deleted) when the deletion is large.
export function pullConfirmationWord(plan: PullPlan): string | null {
  if (pullHasDestructiveChanges(plan)) {
    return plan.mirror!.largeDeletion
      ? `${PULL_DELETE_WORD} ${plan.mirror!.deleteFileCount}`
      : PULL_DELETE_WORD;
  }
  // The typed confirmation is asked for only when the pull would replace an
  // existing Overleaf file and requireConfirmationBeforeWriteBack ("Ask me to
  // confirm before replacing files in Overleaf") is on.
  return plan.experimental.requireConfirmationBeforeWriteBack && plan.replace.length > 0
    ? PULL_CONFIRM_WORD
    : null;
}

export function pullNeedsTypedConfirmation(plan: PullPlan): boolean {
  return pullConfirmationWord(plan) !== null;
}

// With a plan: the word that plan asks for (trimmed, any case, spaces
// collapsed). Without one: the plain `replace` word.
export function isPullConfirmationTyped(text: string, plan?: PullPlan): boolean {
  const word = plan ? pullConfirmationWord(plan) : PULL_CONFIRM_WORD;
  if (word === null) return true;
  return text.trim().toLowerCase().replace(/\s+/g, ' ') === word;
}

export type PullPreviewText = {
  // Lead-in for the list of replaced files; null when none is replaced.
  replace: string | null;
  create: string | null;
  upload: string | null;
  upToDate: string | null;
  // Lead-in for the list of files left alone.
  notPulled: string | null;
  // Set when the pull would change nothing; there is nothing to confirm.
  nothingToPull: string | null;
  confirmLabel: string;
  // Only for a plan with "Make Overleaf match GitHub exactly".
  mirror?: MirrorPreviewText;
};

export type MirrorPreviewText = {
  // "Will be deleted from Overleaf (N)": title of the list of docs and
  // uploaded files that will be deleted; null when none.
  deleteTitle: string | null;
  // Why they are deleted, and that Overleaf's History can restore them.
  deleteNote: string | null;
  // Lead-in for the list of folders that will be removed; null when none.
  deleteFolders: string | null;
  // "Uploaded files that will be replaced (N)"; null when none.
  replaceFilesTitle: string | null;
  replaceFilesNote: string | null;
  // Files only in Overleaf that are kept, one group per reason (build files,
  // your ignore patterns, the repository's .gitignore, a submodule, a
  // symbolic link), each with a sentence that says why. Empty when none.
  kept: Array<{ source: MirrorKeepSource; summary: string; paths: string[] }>;
  // Files only in Overleaf that could not be read, so they are kept.
  notDeleted: string | null;
  // Red warning for a large deletion; null for a normal one.
  largeDeletionWarning: string | null;
  // Red warning when the project's main document is on the deletion list.
  rootDocWarning: string | null;
};

export function describePullPlan(plan: PullPlan): PullPreviewText {
  const replaced = plan.replace.length;
  const created = plan.create.length;
  const uploaded = plan.upload.length;
  const matching = plan.upToDate.length;
  const leftOut = plan.notPulled.length;
  const changes = pullPlanChangeCount(plan);
  const destructive = pullHasDestructiveChanges(plan);
  let nothingToPull: string | null = null;
  if (changes === 0) {
    nothingToPull =
      leftOut === 0
        ? 'Nothing to pull: Overleaf already matches GitHub.'
        : matching === 0
          ? 'Nothing to pull: no file can be replaced, added or uploaded. The list below says why.'
          : 'Nothing to pull: every file that can be pulled already matches GitHub. The list below says why the others were left out.';
  }
  return {
    replace:
      replaced === 0
        ? null
        : replaced === 1
          ? "This file in Overleaf will be replaced with the GitHub version — any edits in it that aren't on GitHub will be lost (you can recover them from Overleaf's History):"
          : `These ${replaced} files in Overleaf will be replaced with the GitHub version — any edits in them that aren't on GitHub will be lost (you can recover them from Overleaf's History):`,
    create:
      created === 0 ? null : created === 1 ? '1 new file will be added.' : `${created} new files will be added.`,
    upload:
      uploaded === 0
        ? null
        : uploaded === 1
          ? '1 image or other non-text file will be uploaded.'
          : `${uploaded} images and other non-text files will be uploaded.`,
    upToDate:
      matching === 0 ? null : matching === 1 ? '1 file already matches.' : `${matching} files already match.`,
    notPulled:
      leftOut === 0
        ? null
        : leftOut === 1
          ? '1 file will not be pulled:'
          : `${leftOut} files will not be pulled:`,
    nothingToPull,
    confirmLabel: destructive ? describeDestructiveConfirmLabel(plan) : changes === 1 ? 'Pull 1 file' : `Pull ${changes} files`,
    ...(plan.mirror ? { mirror: describeMirrorPlan(plan.mirror) } : {}),
  };
}

const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

// Button text for a pull that deletes or replaces: says what it will do, for
// example "Pull 3 files, replace 1 uploaded file and delete 5 files".
function describeDestructiveConfirmLabel(plan: PullPlan): string {
  const mirror = plan.mirror!;
  const pulled = plan.replace.length + plan.create.length + plan.upload.length;
  const parts: string[] = [];
  if (pulled > 0) parts.push(`pull ${pulled} ${plural(pulled, 'file', 'files')}`);
  const replacedFiles = mirror.replaceFiles.length;
  if (replacedFiles > 0) {
    parts.push(`replace ${replacedFiles} uploaded ${plural(replacedFiles, 'file', 'files')}`);
  }
  if (mirror.deleteFileCount > 0) {
    parts.push(`delete ${mirror.deleteFileCount} ${plural(mirror.deleteFileCount, 'file', 'files')}`);
  } else if (mirror.deleteFolderCount > 0) {
    parts.push(`delete ${mirror.deleteFolderCount} ${plural(mirror.deleteFolderCount, 'folder', 'folders')}`);
  }
  const text =
    parts.length <= 1
      ? parts.join('')
      : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// Groups of kept files in the order the preview shows them.
const MIRROR_KEEP_ORDER: MirrorKeepSource[] = ['submodule', 'symlink', 'gitignore', 'pattern', 'build'];

// The sentence that heads one group of kept files.
function describeKeptGroup(source: MirrorKeepSource, n: number): string {
  const lead = `${n} ${plural(n, 'file', 'files')} only in Overleaf ${plural(n, 'is', 'are')} kept`;
  switch (source) {
    case 'build':
      return `${lead} because ${plural(n, 'it is a build file', 'they are build files')} (such as .aux or .log) that ${plural(n, "isn't", "aren't")} sent to GitHub:`;
    case 'pattern':
      return `${lead} because ${plural(n, 'it matches', 'they match')} the ignore patterns you set for this project:`;
    case 'gitignore':
      return `${lead} because the repository's .gitignore excludes ${plural(n, 'it', 'them')}:`;
    case 'submodule':
      return `${lead} because ${plural(n, 'it is', 'they are')} inside a folder that GitHub has as a submodule (a link to another repository), so GitHub's file list can't say what belongs there:`;
    case 'symlink':
      return `${lead} because ${plural(n, 'it is', 'they are')} at or inside a path that GitHub has as a symbolic link, which Overleaf can't hold, so GitHub's file list can't say what belongs there:`;
  }
}

// Note shown next to an uploaded file in the replace list.
const LINKED_FILE_NOTE = 'linked file: it will become a plain uploaded file';

export function describeFileReplaceNote(item: PlannedFileReplace): string | undefined {
  return item.linked ? LINKED_FILE_NOTE : undefined;
}

function describeMirrorPlan(mirror: MirrorPlan): MirrorPreviewText {
  const files = mirror.deleteFileCount;
  const folders = mirror.deleteFolderCount;
  const replaced = mirror.replaceFiles.length;
  const linked = mirror.replaceFiles.filter((f) => f.linked).length;
  const kept = mirror.kept.length;
  const unchecked = mirror.notDeleted.length;
  const rootDoc = mirror.deletions.find((d) => d.isRootDoc);
  const percent =
    mirror.projectFileCount > 0 ? Math.round((files / mirror.projectFileCount) * 100) : 100;
  return {
    deleteTitle: files === 0 ? null : `Will be deleted from Overleaf (${files})`,
    deleteNote:
      files === 0
        ? null
        : `${plural(files, 'This file is', 'These files are')} in Overleaf but not on GitHub, so ${plural(files, 'it', 'they')} will be deleted from Overleaf. You can restore deleted files from Overleaf's History.`,
    deleteFolders:
      folders === 0
        ? null
        : `${plural(folders, '1 folder that is not on GitHub is', `${folders} folders that are not on GitHub are`)} empty, or will be left empty, and will be removed too:`,
    replaceFilesTitle: replaced === 0 ? null : `Uploaded files that will be replaced (${replaced})`,
    replaceFilesNote:
      replaced === 0
        ? null
        : `${plural(replaced, 'This uploaded file in Overleaf differs', 'These uploaded files in Overleaf differ')} from the GitHub version and will be replaced with it. You can restore the old ${plural(replaced, 'version', 'versions')} from Overleaf's History.${
            linked === 0
              ? ''
              : ` ${plural(linked, '1 of them is a linked file (imported from a URL or another project) and becomes', `${linked} of them are linked files (imported from a URL or another project) and become`)} a plain uploaded ${plural(linked, 'file', 'files')} that no longer ${plural(linked, 'updates', 'update')} from its source.`
          }`,
    kept:
      kept === 0
        ? []
        : MIRROR_KEEP_ORDER.map((source) => ({
            source,
            paths: mirror.kept.filter((k) => k.source === source).map((k) => k.path),
          }))
            .filter((group) => group.paths.length > 0)
            .map((group) => ({
              ...group,
              summary: describeKeptGroup(group.source, group.paths.length),
            })),
    notDeleted:
      unchecked === 0
        ? null
        : `${unchecked} ${plural(unchecked, 'file that is', 'files that are')} only in Overleaf will be kept, because ${plural(unchecked, 'it', 'they')} couldn't be checked:`,
    largeDeletionWarning: mirror.largeDeletion
      ? `Large deletion: this will delete ${files} of the ${mirror.projectFileCount} files in this Overleaf project (${percent}%${kept > 0 ? `, not counting ${kept} ${plural(kept, 'file that is', 'files that are')} kept` : ''}). Check the list before you confirm.`
      : null,
    rootDocWarning: rootDoc
      ? `The main document of this project, ${rootDoc.path}, is on the deletion list. Once it is deleted the project has no main document until you choose a new one in Overleaf's Menu, and it may not compile. You can restore it from Overleaf's History.`
      : null,
  };
}

const UNSTORABLE_PREVIEW_NOTE =
  "characters Overleaf can't store, such as emoji, will show as \uFFFD";

// Short change size shown next to a file in the replace list.
export function describeLineChange(item: PlannedReplace): string {
  const size =
    item.linesAdded === 0 && item.linesRemoved === 0
      ? 'lines moved'
      : `+${item.linesAdded} −${item.linesRemoved} lines`;
  return item.hasUnstorableChars ? `${size} (${UNSTORABLE_PREVIEW_NOTE})` : size;
}

// Note shown next to a file the pull will write or add although Overleaf
// can't store some of its characters; undefined when it can store them all.
export function describeCreateNote(item: { hasUnstorableChars?: boolean }): string | undefined {
  return item.hasUnstorableChars ? UNSTORABLE_PREVIEW_NOTE : undefined;
}

// ── Result and error wording, shared by the popup and the Options page ──

// Banner text for a failed pull, and the "What to try" line under it.
export function describePullError(e: unknown): { message: string; recovery: string | null } {
  if (isEmptyRepositoryError(e)) {
    return { message: 'The GitHub repository is empty, so there is nothing to pull.', recovery: null };
  }
  if (e instanceof LiveSyncError) return { message: e.message, recovery: recoveryForPullError(e) };
  return { message: formatGitHubError(e), recovery: null };
}

// Error text when the GitHub branch has no file the pull can use.
export function describeNothingOnGitHub(
  branch: string,
  targetDir: string | undefined,
  skippedCount: number,
  mirror = false,
): string {
  const where = targetDir ? `${branch} (in ${targetDir}/)` : branch;
  if (skippedCount === 0 && mirror) {
    // Not an error to fix by pulling: an empty GitHub side must never empty
    // the Overleaf project.
    return `Nothing to pull: ${where} has no files. “Make Overleaf match GitHub exactly” does nothing in that case, so no file in Overleaf is deleted.`;
  }
  if (skippedCount === 0) return `Nothing to pull: ${where} has no files.`;
  return `Nothing to pull: none of the ${skippedCount} file${skippedCount === 1 ? '' : 's'} on ${where} can be pulled. Check “Allowed write-back extensions” in Options, or turn on “Allow uploading new images and other non-text files”.`;
}

type PullRowStatus =
  | WriteBackResult['status']
  | CreateResult['status']
  | BinaryResult['status']
  | FileReplaceResult['status']
  | DeleteResult['status'];

// Label for one result row. `kind` is the list the row is in.
export function pullResultLabel(
  kind: 'doc' | 'create' | 'upload' | 'replaceFile' | 'delete',
  status: PullRowStatus,
): string {
  switch (status) {
    case 'replaced':
      return 'Replaced';
    case 'deleted':
      return 'Deleted';
    case 'written':
      return 'Updated';
    case 'created':
      return 'Added';
    case 'uploaded':
      return 'Uploaded';
    case 'conflict':
      return 'Not replaced';
    case 'failed':
      return 'Failed';
    case 'skipped':
      return kind === 'doc'
        ? 'Not changed'
        : kind === 'create'
          ? 'Not added'
          : kind === 'delete'
            ? 'Not deleted'
            : kind === 'replaceFile'
              ? 'Not replaced'
              : 'Not uploaded';
  }
}

// A row's message without a leading "<label>:" that would repeat the
// label shown before it ("Not added — x.tex: Not added: …").
export function pullRowMessage(label: string, message: string | undefined): string | undefined {
  if (!message) return undefined;
  const prefix = `${label.toLowerCase()}: `;
  if (!message.toLowerCase().startsWith(prefix)) return message;
  const rest = message.slice(prefix.length);
  return rest.charAt(0).toUpperCase() + rest.slice(1);
}

// One-line summary of a finished pull: non-zero counts only.
export function describePullOutcome(outcome: PullIntoOverleafOutcome): string[] {
  const count = <T extends { status: string }>(rows: T[] | null, status: T['status']): number =>
    rows?.filter((r) => r.status === status).length ?? 0;
  const { results, createResults, binaryResults, fileReplaceResults, deleteResults } = outcome;
  const parts: Array<[number, string]> = [
    [count(results, 'written'), 'updated'],
    [count(createResults, 'created'), 'added'],
    [count(binaryResults, 'uploaded'), 'uploaded'],
    // "Make Overleaf match GitHub exactly" (zero, so absent, without it):
    [count(fileReplaceResults ?? null, 'replaced'), 'replaced (uploaded files)'],
    [count(deleteResults ?? null, 'deleted'), 'deleted'],
    [count(results, 'skipped'), 'not changed'],
    [count(results, 'conflict'), 'not replaced (edited in Overleaf)'],
    [count(createResults, 'skipped'), 'not added'],
    [count(binaryResults, 'skipped'), 'not uploaded'],
    [count(fileReplaceResults ?? null, 'skipped'), 'not replaced (uploaded files)'],
    [count(deleteResults ?? null, 'skipped'), 'not deleted'],
    [
      count(results, 'failed') +
        count(createResults, 'failed') +
        count(binaryResults, 'failed') +
        count(fileReplaceResults ?? null, 'failed') +
        count(deleteResults ?? null, 'failed'),
      'failed',
    ],
  ];
  const shown = parts.filter(([n]) => n > 0).map(([n, label]) => `${n} ${label}`);
  return shown.length > 0 ? shown : ['Nothing was changed'];
}
