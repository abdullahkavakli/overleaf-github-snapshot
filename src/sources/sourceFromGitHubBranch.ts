// Reverse-direction source: pull a GitHub branch's tree into a
// normalised list of text ProjectFiles so the live write-back path can
// loop them into Overleaf.
//
// Scope choices:
//   - Text files only. Binaries (PDFs, images, etc.) are skipped because
//     the live write-back path is OT-based and only handles text docs.
//   - Honors RepoConfig.targetDir by stripping the prefix when present,
//     so paths come back project-relative (matching what Overleaf shows).
//   - No ignorePatterns filter — those are commit-direction rules ("don't
//     ship .aux to GitHub"), irrelevant when reading FROM GitHub.
//   - Refuses to operate on a truncated tree (GitHub's recursive tree
//     API returns truncated=true for very large repos — silently
//     pulling a partial tree would lead to spurious "missing files" in
//     the writeback diff).
//   - Optional `allowedExtensions` pre-filter skips files that would be
//     rejected downstream by writeSelectedFilesBackToOverleaf, saving
//     one HTTP round-trip per non-allowed file.
//   - Blob fetches run in parallel batches of N (default 6) since most
//     of the latency is network RTT to api.github.com rather than CPU.

import { GitHubClient } from '../github/githubClient';
import {
  ALL_FILE_TYPES,
  COMMON_BINARY_EXTENSIONS,
  SYMLINK_SKIPPED_REASON_PREFIX,
  TEXT_EXTENSIONS,
} from '../shared/constants';
import { computeSha256 } from '../diff/fileHasher';
import { isRepoPathUnderDir } from '../diff/gitignore';
import { decodeUtf8Text } from '../shared/lineEndings';
import { base64ToUint8 } from '../overleaf/live/bridgeProtocol';
import type { ProjectFile, RepoConfig } from '../shared/types';

function getExtension(path: string): string {
  const base = path.split('/').pop() ?? path;
  const idx = base.lastIndexOf('.');
  if (idx < 0) return '';
  return base.substring(idx).toLowerCase();
}

function isLikelyText(path: string): boolean {
  const ext = getExtension(path);
  if (TEXT_EXTENSIONS.has(ext)) return true;
  if (COMMON_BINARY_EXTENSIONS.has(ext)) return false;
  // Conservative: unknown extensions get skipped from the pull. The user
  // can add the extension to the writeBack allowedExtensions list and
  // re-run; that flow assumes the extension was opt-in to begin with.
  return false;
}

// Maps a repo path to a project-relative one by stripping RepoConfig.targetDir
// (null: outside it). The pull and the "match GitHub exactly" deletion rules
// share this, so both see the same paths.
export function applyTargetDir(
  fullPath: string,
  targetDir: string | undefined,
): string | null {
  const td = (targetDir ?? '').trim().replace(/^\/+|\/+$/g, '');
  if (!td) return fullPath;
  const prefix = `${td}/`;
  if (fullPath === td) return null;
  if (!fullPath.startsWith(prefix)) return null;
  const rest = fullPath.substring(prefix.length);
  return rest || null;
}

// One entry of the branch's full tree inside the target directory, with the
// project-relative path. 'file' is a regular blob, 'folder' a directory,
// 'submodule' a link to another repository (tree type 'commit', mode 160000)
// and 'symlink' a symbolic link (a blob of mode 120000). Unlike `files` it is
// not filtered by file type, binary or UTF-8: it is what exists on GitHub. A
// submodule or a symlink is never pulled (there is no file to copy), and
// "Make Overleaf match GitHub exactly" keeps whatever Overleaf holds at or
// under its path.
export type GitHubTreeEntry = {
  path: string;
  kind: 'file' | 'folder' | 'submodule' | 'symlink';
};

// The text of one .gitignore of the repository. `dir` is the repository
// folder that holds it ('' for the root), so a rule applies to the files
// below that folder (see src/diff/gitignore.ts).
export type GitHubGitignore = { dir: string; text: string };

export type GitHubBranchSnapshot = {
  owner: string;
  repo: string;
  branch: string;
  commitSha: string;
  files: ProjectFile[];
  // Every entry of the branch inside the target directory (see
  // GitHubTreeEntry). "Make Overleaf match GitHub exactly" decides what is
  // missing from GitHub with this list, never with `files`.
  treeEntries: GitHubTreeEntry[];
  // The repository's .gitignore files that govern the target directory (the
  // ones in it and in the folders above it, read only when
  // `readGitignores` was asked for). "Make Overleaf match GitHub exactly"
  // keeps the Overleaf files they exclude.
  gitignores: GitHubGitignore[];
  // Always false today: a truncated tree is refused above before this is
  // returned. The mirror plan checks it again so a future change can't turn
  // the entries GitHub left out of a truncated listing into deletions.
  treeTruncated: boolean;
  // Paths that landed inside the targetDir but were not pulled — usually
  // because they're not in the text-extension whitelist. Surfaced so the
  // pull dev panel can show the user what got dropped.
  skipped: { path: string; reason: string }[];
};

export type SourceFromGitHubBranchOptions = {
  // Optional pre-filter that mirrors writeSelectedFilesBackToOverleaf's
  // extension allowlist. Files with extensions not in this list are
  // skipped before the blob fetch, saving one HTTP round-trip each.
  // When omitted, only the isLikelyText filter applies.
  // Has no effect on binary files (those are gated by includeBinaries).
  allowedExtensions?: string[];
  // When true, binary files (and unknown extensions) are also fetched
  // and returned with encoding='base64', isBinary=true. Callers gate
  // this on the user's allowBinaryWriteBack preference because uploads
  // back to Overleaf go through a different endpoint (multipart upload,
  // not OT) and only happen if the user explicitly opted in.
  includeBinaries?: boolean;
  // Max parallel /git/blobs requests. Defaults to 6, chosen as a balance
  // between obvious speedup and staying well within GitHub's secondary
  // rate-limit guidance for authenticated users.
  concurrency?: number;
  // Also read the repository's .gitignore files (see
  // GitHubBranchSnapshot.gitignores). Set for "Make Overleaf match GitHub
  // exactly" only.
  readGitignores?: boolean;
};

const DEFAULT_CONCURRENCY = 6;

// Mode git gives a symbolic link.
const SYMLINK_MODE = '120000';
// Reason shown for a symbolic link the pull leaves out.
const SYMLINK_SKIPPED_REASON = `${SYMLINK_SKIPPED_REASON_PREFIX} on GitHub, which is not a file Overleaf can hold`;

export async function sourceFromGitHubBranch(
  token: string,
  config: RepoConfig,
  options: SourceFromGitHubBranchOptions = {},
): Promise<GitHubBranchSnapshot> {
  const client = new GitHubClient(token);
  const ref = await client.getRef(config.owner, config.repo, config.branch);
  const commit = await client.getCommit(config.owner, config.repo, ref.object.sha);
  const tree = await client.getTree(config.owner, config.repo, commit.tree.sha, true);

  const treeTruncated: boolean = tree.truncated === true;
  if (treeTruncated) {
    throw new Error(
      "This repository has too many files for GitHub to list in one request, so it can't be pulled. Use a smaller repository.",
    );
  }

  const allowedExts =
    options.allowedExtensions && !options.allowedExtensions.includes(ALL_FILE_TYPES)
      ? new Set(options.allowedExtensions)
      : null;
  const includeBinaries = options.includeBinaries === true;
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);

  // Pass 1: walk the tree and decide which blobs to fetch. Doing the
  // filtering up-front lets us batch the network calls cleanly and keeps
  // the skipped reasons consistent independent of fetch concurrency.
  type Job = { projectPath: string; sha: string; treatAsText: boolean };
  const jobs: Job[] = [];
  const skipped: { path: string; reason: string }[] = [];
  const treeEntries: GitHubTreeEntry[] = [];
  const gitignoreJobs: Array<{ dir: string; sha: string }> = [];
  const targetDir = (config.targetDir ?? '').trim().replace(/^\/+|\/+$/g, '');

  for (const item of tree.tree) {
    const isSymlink = item.type === 'blob' && item.mode === SYMLINK_MODE;
    if (item.path) {
      // The full tree, before any type filter (see GitHubTreeEntry).
      const entryPath = applyTargetDir(item.path, config.targetDir);
      if (entryPath !== null) {
        treeEntries.push({
          path: entryPath,
          kind:
            item.type === 'tree'
              ? 'folder'
              : item.type === 'commit'
                ? 'submodule'
                : isSymlink
                  ? 'symlink'
                  : 'file',
        });
      }
      // A .gitignore above or inside the target directory governs it.
      if (
        options.readGitignores === true &&
        item.type === 'blob' &&
        !isSymlink &&
        item.sha &&
        (item.path === '.gitignore' || item.path.endsWith('/.gitignore'))
      ) {
        const folder = item.path === '.gitignore' ? '' : item.path.slice(0, -'/.gitignore'.length);
        // Inside the target directory, or in a folder above it.
        if (isRepoPathUnderDir(folder, targetDir) || isRepoPathUnderDir(targetDir, folder)) {
          gitignoreJobs.push({ dir: folder, sha: item.sha });
        }
      }
    }
    if (item.type !== 'blob' || !item.path || !item.sha) continue;
    const projectPath = applyTargetDir(item.path, config.targetDir);
    if (projectPath === null) continue; // outside targetDir, ignored silently
    if (isSymlink) {
      // The blob holds the link's target path, not file content: never fetch
      // it, and never write it to Overleaf as a file.
      skipped.push({ path: projectPath, reason: SYMLINK_SKIPPED_REASON });
      continue;
    }

    const treatAsText = isLikelyText(projectPath);
    if (!treatAsText) {
      if (!includeBinaries) {
        skipped.push({
          path: projectPath,
          reason: 'binary or unknown file type — text-only pull in this run',
        });
        continue;
      }
      // Binary path: include without the text-extension filter, since
      // binaries are gated by the user's allowBinaryWriteBack preference
      // at the call site rather than the allowedWriteBackExtensions list.
      jobs.push({ projectPath, sha: item.sha, treatAsText: false });
      continue;
    }
    if (allowedExts && !allowedExts.has(getExtension(projectPath))) {
      skipped.push({
        path: projectPath,
        reason: `extension not in allowed write-back list — wouldn't be written anyway`,
      });
      continue;
    }
    jobs.push({ projectPath, sha: item.sha, treatAsText: true });
  }

  // Pass 2: fetch blobs in parallel batches of `concurrency`. We rely on
  // GitHub's HTTP/2 multiplexing on api.github.com — issuing N requests
  // concurrently is the right shape; sequential was just simpler.
  const files: ProjectFile[] = [];
  for (let i = 0; i < jobs.length; i += concurrency) {
    const batch = jobs.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map(async (job) => {
        const blob = await client.getBlob(config.owner, config.repo, job.sha);
        // GitHub returns base64 with 60-char line wrapping; modern atob
        // tolerates whitespace, but stripping is cheap insurance.
        const bytes = base64ToUint8(blob.content.replace(/\s+/g, ''));
        const sha256 = await computeSha256(bytes);
        if (!job.treatAsText) {
          const file: ProjectFile = {
            path: job.projectPath,
            content: bytes,
            encoding: 'base64',
            sha256,
            sizeBytes: bytes.byteLength,
            isBinary: true,
          };
          return file;
        }
        // A leading BOM stays in the text, as it does in the Overleaf doc, so
        // the pull neither strips it nor sees a change. Bytes that are not
        // valid UTF-8 (a Windows-1252 file) decode to U+FFFD; the file is
        // flagged so the pull never writes that text to Overleaf.
        const decoded = decodeUtf8Text(bytes);
        const file: ProjectFile = {
          path: job.projectPath,
          content: bytes,
          text: decoded.text,
          encoding: 'utf-8',
          sha256,
          sizeBytes: bytes.byteLength,
          isBinary: false,
          ...(decoded.valid ? {} : { invalidUtf8: true }),
        };
        return file;
      }),
    );
    files.push(...batchResults);
  }

  files.sort((a, b) => a.path.localeCompare(b.path));

  // The .gitignore files, when asked for. A read that fails fails the pull:
  // without them the files the repository ignores could not be protected.
  const gitignores: GitHubGitignore[] = [];
  for (let i = 0; i < gitignoreJobs.length; i += concurrency) {
    const batch = gitignoreJobs.slice(i, i + concurrency);
    const texts = await Promise.all(
      batch.map(async (job) => {
        const blob = await client.getBlob(config.owner, config.repo, job.sha);
        const bytes = base64ToUint8(blob.content.replace(/\s+/g, ''));
        return { dir: job.dir, text: decodeUtf8Text(bytes).text };
      }),
    );
    gitignores.push(...texts);
  }

  return {
    owner: config.owner,
    repo: config.repo,
    branch: config.branch,
    commitSha: ref.object.sha,
    files,
    treeEntries,
    gitignores,
    treeTruncated,
    skipped,
  };
}
