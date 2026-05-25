// Reverse-direction source: pull a GitHub branch's tree into a
// normalised list of text ProjectFiles so the live write-back path can
// loop them into Overleaf.
//
// Scope choices for first cut:
//   - Text files only. Binaries (PDFs, images, etc.) are skipped because
//     the live write-back path is OT-based and only handles text docs.
//   - Honors RepoConfig.targetDir by stripping the prefix when present,
//     so paths come back project-relative (matching what Overleaf shows).
//   - No ignorePatterns filter — those are commit-direction rules ("don't
//     ship .aux to GitHub"), irrelevant when reading FROM GitHub.
//   - Sequential blob fetches; a parallel implementation can come later
//     once we have a sense of rate-limit headroom in practice.
//   - Refuses to operate on a truncated tree (GitHub's recursive tree
//     API returns truncated=true for very large repos — silently
//     pulling a partial tree would lead to spurious "missing files" in
//     the writeback diff).

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

export async function sourceFromGitHubBranch(
  token: string,
  config: RepoConfig,
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

  const files: ProjectFile[] = [];
  const skipped: { path: string; reason: string }[] = [];

  for (const item of tree.tree) {
    if (item.type !== 'blob' || !item.path || !item.sha) continue;
    const projectPath = applyTargetDir(item.path, config.targetDir);
    if (projectPath === null) continue; // outside targetDir, ignored silently

    if (!isLikelyText(projectPath)) {
      skipped.push({
        path: projectPath,
        reason: 'binary or unknown file type — pull is text-only in this build',
      });
      continue;
    }

    const blob = await client.getBlob(config.owner, config.repo, item.sha);
    // GitHub returns base64 with 60-char line wrapping; modern atob tolerates
    // whitespace, but stripping is cheap insurance.
    const bytes = base64ToUint8(blob.content.replace(/\s+/g, ''));
    const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    const sha256 = await computeSha256(bytes);

    files.push({
      path: projectPath,
      content: bytes,
      text,
      encoding: 'utf-8',
      sha256,
      sizeBytes: bytes.byteLength,
      isBinary: false,
    });
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
