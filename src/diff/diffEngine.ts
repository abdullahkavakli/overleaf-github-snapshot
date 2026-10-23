import type { DiffItem, DiffSummary, GitHubTreeItem, ProjectFile, RepoConfig } from '../shared/types';
import {
  decodeUtf8Text,
  hasOverleafUnstorableChars,
  normalizeLineEndings,
  toOverleafStorableText,
} from '../shared/lineEndings';
import { computeGitBlobSha, gitBlobShaMatchesIgnoringLineEndings } from './fileHasher';
import { isIgnored } from './ignoreRules';

export function normalizeTargetDir(targetDir: string | undefined): string {
  if (!targetDir) return '';
  return targetDir
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
}

export function mapZipPathToRepoPath(zipPath: string, targetDir: string): string {
  return targetDir ? `${targetDir}/${zipPath}` : zipPath;
}

export function isInsideTargetDir(repoPath: string, targetDir: string): boolean {
  if (!targetDir) return true;
  return repoPath === targetDir || repoPath.startsWith(targetDir + '/');
}

export type ComputeDiffOptions = {
  // Downloads one GitHub blob's bytes by SHA (one API call). Used only for a
  // text file that still differs from GitHub after the cheap checks and whose
  // Overleaf text contains U+FFFD, to see whether GitHub's own version has
  // characters Overleaf can't hold (see settleReplacementCharFiles). Without
  // it those files stay "modified", with a warning.
  fetchBlobBytes?: (sha: string) => Promise<Uint8Array>;
};

// At most this many blobs are downloaded for one diff, MAX_PARALLEL at a time;
// a project with more such files is far from normal. The rest stay modified,
// with the "not checked" warning.
const MAX_REPLACEMENT_CHAR_CHECKS = 100;
const MAX_PARALLEL_BLOB_CHECKS = 6;

const REPLACEMENT_CHAR_LOSS_WARNING =
  "Overleaf shows some characters of this file as \uFFFD (it can't store emoji and some other symbols, or the file on GitHub isn't saved as UTF-8). Committing it would replace the original characters on GitHub with \uFFFD.";
const REPLACEMENT_CHAR_UNCHECKED_WARNING =
  "This file contains \uFFFD characters, and its GitHub version couldn't be checked, so committing it may replace the original characters on GitHub with \uFFFD.";

export async function computeDiff(
  zipFiles: ProjectFile[],
  githubTree: GitHubTreeItem[],
  config: RepoConfig,
  options: ComputeDiffOptions = {},
): Promise<DiffItem[]> {
  const targetDir = normalizeTargetDir(config.targetDir);
  const ignorePatterns = config.ignorePatterns ?? [];

  // Filter zip files by ignore rules (against original zip paths)
  const zipKept = zipFiles.filter((f) => !isIgnored(f.path, ignorePatterns));

  // Hash all kept zip files to compute git blob SHAs.
  const zipMap = new Map<string, { file: ProjectFile; newSha: string }>();
  for (const file of zipKept) {
    const newSha = await computeGitBlobSha(file.content);
    const repoPath = mapZipPathToRepoPath(file.path, targetDir);
    zipMap.set(repoPath, { file, newSha });
  }

  // Filter github tree to scope and ignore patterns.
  const githubInScope = new Map<string, GitHubTreeItem>();
  for (const item of githubTree) {
    if (item.type !== 'blob') continue;
    if (!isInsideTargetDir(item.path, targetDir)) continue;
    // Compare ignore rules against the path *inside* the target dir so user patterns work consistently.
    const zipRelative = targetDir ? item.path.substring(targetDir.length + 1) : item.path;
    if (isIgnored(zipRelative, ignorePatterns)) continue;
    githubInScope.set(item.path, item);
  }

  const diffs: DiffItem[] = [];
  // Modified text files whose Overleaf text contains U+FFFD, settled below.
  const replacementCharChecks: Array<{ item: DiffItem; text: string }> = [];

  for (const [repoPath, { file, newSha }] of zipMap) {
    const existing = githubInScope.get(repoPath);
    if (!existing) {
      diffs.push({
        path: repoPath,
        status: 'added',
        newSha,
        sizeBytes: file.sizeBytes,
      });
    } else if (
      existing.sha === newSha ||
      // Overleaf keeps no CR, so a repo file with CRLF (or CR) line endings
      // never hashes the same as its Overleaf copy. A text file that
      // differs only that way is unchanged; no extra GitHub request needed.
      (!file.isBinary &&
        existing.sha !== undefined &&
        (await gitBlobShaMatchesIgnoringLineEndings(file.content, existing.sha)))
    ) {
      diffs.push({
        path: repoPath,
        status: 'unchanged',
        oldSha: existing.sha,
        newSha,
        sizeBytes: file.sizeBytes,
      });
    } else {
      const item: DiffItem = {
        path: repoPath,
        status: 'modified',
        oldSha: existing.sha,
        newSha,
        sizeBytes: file.sizeBytes,
      };
      diffs.push(item);
      if (!file.isBinary && existing.sha !== undefined) {
        const text = file.text ?? decodeUtf8Text(file.content).text;
        if (text.includes('\uFFFD')) replacementCharChecks.push({ item, text });
      }
    }
  }

  await settleReplacementCharFiles(replacementCharChecks, options.fetchBlobBytes);

  for (const [path, item] of githubInScope) {
    if (!zipMap.has(path)) {
      diffs.push({
        path,
        status: 'deleted',
        oldSha: item.sha,
        sizeBytes: item.size,
      });
    }
  }

  diffs.sort((a, b) => {
    const order: Record<DiffItem['status'], number> = {
      added: 0,
      modified: 1,
      deleted: 2,
      unchanged: 3,
    };
    const cmp = order[a.status] - order[b.status];
    if (cmp !== 0) return cmp;
    return a.path.localeCompare(b.path);
  });

  return diffs;
}

// A text file from Overleaf with U+FFFD in it is not necessarily a change:
// Overleaf can't hold an emoji or another character outside the BMP (each half
// becomes U+FFFD), and an earlier pull may have written U+FFFD for the invalid
// bytes of a file that isn't UTF-8. Committing the Overleaf text would replace
// GitHub's original characters with U+FFFD. So GitHub's blob is downloaded and
// decoded the way the pull decodes it (lossy UTF-8, BOM kept); when what
// Overleaf could hold of it (toOverleafStorableText) equals the Overleaf text,
// the file is unchanged and GitHub's version stays. Otherwise it stays
// modified, with a warning when the commit would turn characters into U+FFFD.
async function settleReplacementCharFiles(
  checks: Array<{ item: DiffItem; text: string }>,
  fetchBlobBytes: ComputeDiffOptions['fetchBlobBytes'],
): Promise<void> {
  const settle = async ({ item, text }: { item: DiffItem; text: string }): Promise<void> => {
    try {
      const bytes = await fetchBlobBytes!(item.oldSha!);
      const gitHub = decodeUtf8Text(bytes);
      if (toOverleafStorableText(gitHub.text) === normalizeLineEndings(text)) {
        item.status = 'unchanged';
        return;
      }
      if (!gitHub.valid || hasOverleafUnstorableChars(gitHub.text)) {
        item.warning = REPLACEMENT_CHAR_LOSS_WARNING;
      }
    } catch {
      item.warning = REPLACEMENT_CHAR_UNCHECKED_WARNING;
    }
  };

  const checked = fetchBlobBytes ? checks.slice(0, MAX_REPLACEMENT_CHAR_CHECKS) : [];
  for (const { item } of checks.slice(checked.length)) item.warning = REPLACEMENT_CHAR_UNCHECKED_WARNING;
  for (let i = 0; i < checked.length; i += MAX_PARALLEL_BLOB_CHECKS) {
    await Promise.all(checked.slice(i, i + MAX_PARALLEL_BLOB_CHECKS).map(settle));
  }
}

export function summarize(diffs: DiffItem[]): DiffSummary {
  const summary: DiffSummary = { added: 0, modified: 0, deleted: 0, unchanged: 0 };
  for (const d of diffs) {
    summary[d.status] += 1;
  }
  return summary;
}

export function hasActionableChanges(diffs: DiffItem[], includeDeletions: boolean): boolean {
  return diffs.some((d) => {
    if (d.status === 'added' || d.status === 'modified') return true;
    if (d.status === 'deleted' && includeDeletions) return true;
    return false;
  });
}
