import type { DiffItem, DiffSummary, GitHubTreeItem, ProjectFile, RepoConfig } from '../shared/types';
import { computeGitBlobSha } from './fileHasher';
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

export async function computeDiff(
  zipFiles: ProjectFile[],
  githubTree: GitHubTreeItem[],
  config: RepoConfig,
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

  for (const [repoPath, { file, newSha }] of zipMap) {
    const existing = githubInScope.get(repoPath);
    if (!existing) {
      diffs.push({
        path: repoPath,
        status: 'added',
        newSha,
        sizeBytes: file.sizeBytes,
      });
    } else if (existing.sha === newSha) {
      diffs.push({
        path: repoPath,
        status: 'unchanged',
        oldSha: existing.sha,
        newSha,
        sizeBytes: file.sizeBytes,
      });
    } else {
      diffs.push({
        path: repoPath,
        status: 'modified',
        oldSha: existing.sha,
        newSha,
        sizeBytes: file.sizeBytes,
      });
    }
  }

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
