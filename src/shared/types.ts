export type RepoConfig = {
  owner: string;
  repo: string;
  branch: string;
  targetDir?: string;
  includeDeletions: boolean;
  ignorePatterns: string[];
};

export type ProjectFile = {
  path: string;
  content: Uint8Array;
  text?: string;
  encoding: 'utf-8' | 'base64';
  sha256: string;
  sizeBytes: number;
  isBinary: boolean;
};

export type DiffStatus = 'added' | 'modified' | 'deleted' | 'unchanged';

export type DiffItem = {
  path: string;
  status: DiffStatus;
  oldSha?: string;
  newSha?: string;
  sizeBytes?: number;
};

export type GitHubTreeItem = {
  path: string;
  mode?: string;
  type: 'blob' | 'tree' | 'commit';
  sha?: string;
  size?: number;
  url?: string;
};

export type GitHubTreeResponse = {
  sha: string;
  url: string;
  tree: GitHubTreeItem[];
  truncated: boolean;
};

export type CommitResult = {
  sha: string;
  htmlUrl: string;
};

export type ConnectionTestResult = {
  ok: boolean;
  user?: { login: string };
  defaultBranch?: string;
  branchFound?: boolean;
  contentsPermission?: boolean;
  error?: string;
};

export type DiffSummary = {
  added: number;
  modified: number;
  deleted: number;
  unchanged: number;
};

export type ExperimentalConfig = {
  experimentalLiveSyncEnabled: boolean;
  liveReadOnlyPullEnabled: boolean;
  overleafWriteBackEnabled: boolean;
  localReplicaEnabled: boolean;
  requireZipBackupBeforeWriteBack: boolean;
  requireConfirmationBeforeWriteBack: boolean;
  allowBinaryWriteBack: boolean;
  allowedWriteBackExtensions: string[];
};
