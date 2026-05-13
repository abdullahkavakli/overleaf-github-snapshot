import type { CommitResult, DiffItem, ProjectFile, RepoConfig } from '../shared/types';
import { GitHubApiError, GitHubClient, type CreateTreeItem } from './githubClient';
import { isInsideTargetDir, mapZipPathToRepoPath, normalizeTargetDir } from '../diff/diffEngine';

function uint8ToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const chunk = bytes.subarray(i, i + CHUNK);
    binary += String.fromCharCode.apply(null, Array.from(chunk));
  }
  return btoa(binary);
}

export type CommitProgress = {
  phase: 'verifyRef' | 'createBlobs' | 'createTree' | 'createCommit' | 'updateRef';
  current?: number;
  total?: number;
  detail?: string;
};

export type CommitOptions = {
  onProgress?: (progress: CommitProgress) => void;
};

// The exact base the preview was computed against. createCommit refuses to
// proceed if the branch has moved off this commit since the diff was taken.
export type PreviewBase = {
  commitSha: string;
  treeSha: string;
};

export class CommitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommitError';
  }
}

export async function createCommit(
  token: string,
  config: RepoConfig,
  zipFiles: ProjectFile[],
  diffs: DiffItem[],
  commitMessage: string,
  previewBase: PreviewBase,
  options: CommitOptions = {},
): Promise<CommitResult> {
  if (!commitMessage.trim()) {
    throw new CommitError('Commit message is empty.');
  }

  const targetDir = normalizeTargetDir(config.targetDir);

  const actionable = diffs.filter((d) => {
    if (d.status === 'unchanged') return false;
    if (d.status === 'deleted' && !config.includeDeletions) return false;
    return true;
  });

  if (actionable.length === 0) {
    throw new CommitError('No changes to commit.');
  }

  // Safety: refuse any deletion outside targetDir.
  for (const d of actionable) {
    if (d.status === 'deleted' && !isInsideTargetDir(d.path, targetDir)) {
      throw new CommitError(
        `Refusing to delete file outside target directory: ${d.path}`,
      );
    }
  }

  // Build a fast lookup for incoming files keyed by mapped (repo) path.
  const fileByRepoPath = new Map<string, ProjectFile>();
  for (const file of zipFiles) {
    fileByRepoPath.set(mapZipPathToRepoPath(file.path, targetDir), file);
  }

  const client = new GitHubClient(token);
  const { owner, repo, branch } = config;

  options.onProgress?.({ phase: 'verifyRef' });
  const ref = await client.getRef(owner, repo, branch);
  if (ref.object.sha !== previewBase.commitSha) {
    // Someone pushed to this branch between the preview render and now.
    // Bail before doing any blob/tree/commit work — the diff the user saw
    // no longer applies to the current branch tip.
    throw new CommitError(
      'GitHub branch changed since preview. Refresh the diff and try again.',
    );
  }
  // The ref is still on the preview's base commit, so its tree SHA is
  // exactly previewBase.treeSha — no need to refetch the commit object.
  const currentCommitSha = previewBase.commitSha;
  const baseTreeSha = previewBase.treeSha;

  const tree: CreateTreeItem[] = [];

  // Handle deletions
  for (const d of actionable) {
    if (d.status === 'deleted') {
      tree.push({
        path: d.path,
        mode: '100644',
        type: 'blob',
        sha: null,
      });
    }
  }

  // Handle additions/modifications. Binary files require explicit blob creation.
  const binaryFiles = actionable.filter(
    (d) => (d.status === 'added' || d.status === 'modified') && fileByRepoPath.get(d.path)?.isBinary,
  );
  let processed = 0;
  for (const d of actionable) {
    if (d.status !== 'added' && d.status !== 'modified') continue;
    const file = fileByRepoPath.get(d.path);
    if (!file) {
      throw new CommitError(`Internal error: missing file content for ${d.path}.`);
    }
    if (file.isBinary) {
      processed += 1;
      options.onProgress?.({
        phase: 'createBlobs',
        current: processed,
        total: binaryFiles.length,
        detail: file.path,
      });
      const base64 = uint8ToBase64(file.content);
      const blob = await client.createBlob(owner, repo, base64, 'base64');
      tree.push({
        path: d.path,
        mode: '100644',
        type: 'blob',
        sha: blob.sha,
      });
    } else {
      tree.push({
        path: d.path,
        mode: '100644',
        type: 'blob',
        content: file.text ?? new TextDecoder('utf-8').decode(file.content),
      });
    }
  }

  options.onProgress?.({ phase: 'createTree' });
  const newTree = await client.createTree(owner, repo, baseTreeSha, tree);

  options.onProgress?.({ phase: 'createCommit' });
  const newCommit = await client.createCommit(
    owner,
    repo,
    commitMessage.trim(),
    newTree.sha,
    [currentCommitSha],
  );

  options.onProgress?.({ phase: 'updateRef' });
  try {
    await client.updateRef(owner, repo, branch, newCommit.sha, false);
  } catch (e) {
    if (e instanceof GitHubApiError && (e.status === 409 || e.status === 422)) {
      throw new CommitError(
        'GitHub branch changed since preview. Refresh the diff and try again.',
      );
    }
    throw e;
  }

  return {
    sha: newCommit.sha,
    htmlUrl:
      newCommit.html_url ??
      `https://github.com/${owner}/${repo}/commit/${newCommit.sha}`,
  };
}
