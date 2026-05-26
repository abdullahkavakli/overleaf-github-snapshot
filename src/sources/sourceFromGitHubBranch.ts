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
import { COMMON_BINARY_EXTENSIONS, TEXT_EXTENSIONS } from '../shared/constants';
import { computeSha256 } from '../diff/fileHasher';
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

function applyTargetDir(
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

export type GitHubBranchSnapshot = {
  owner: string;
  repo: string;
  branch: string;
  commitSha: string;
  files: ProjectFile[];
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
};

const DEFAULT_CONCURRENCY = 6;

export async function sourceFromGitHubBranch(
  token: string,
  config: RepoConfig,
  options: SourceFromGitHubBranchOptions = {},
): Promise<GitHubBranchSnapshot> {
  const client = new GitHubClient(token);
  const ref = await client.getRef(config.owner, config.repo, config.branch);
  const commit = await client.getCommit(config.owner, config.repo, ref.object.sha);
  const tree = await client.getTree(config.owner, config.repo, commit.tree.sha, true);

  if (tree.truncated) {
    throw new Error(
      'GitHub tree was truncated. Repository is too large to pull as-is — set a target directory on the project mapping so only a subset is pulled.',
    );
  }

  const allowedExts = options.allowedExtensions
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

  for (const item of tree.tree) {
    if (item.type !== 'blob' || !item.path || !item.sha) continue;
    const projectPath = applyTargetDir(item.path, config.targetDir);
    if (projectPath === null) continue; // outside targetDir, ignored silently

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
        const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
        const file: ProjectFile = {
          path: job.projectPath,
          content: bytes,
          text,
          encoding: 'utf-8',
          sha256,
          sizeBytes: bytes.byteLength,
          isBinary: false,
        };
        return file;
      }),
    );
    files.push(...batchResults);
  }

  files.sort((a, b) => a.path.localeCompare(b.path));

  return {
    owner: config.owner,
    repo: config.repo,
    branch: config.branch,
    commitSha: ref.object.sha,
    files,
    skipped,
  };
}
