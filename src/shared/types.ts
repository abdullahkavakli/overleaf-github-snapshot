export type RepoConfig = {
  owner: string;
  repo: string;
  branch: string;
  targetDir?: string;
  includeDeletions: boolean;
  ignorePatterns: string[];
};

export type ProjectLink = {
  repo: RepoConfig;
  token: string;
};

export type ProjectLinkMap = Record<string, ProjectLink>;

export type ProjectFile = {
  path: string;
  content: Uint8Array;
  text?: string;
  encoding: 'utf-8' | 'base64';
  sha256: string;
  sizeBytes: number;
  isBinary: boolean;
  // Set only by the GitHub-branch source, on a text file whose bytes are not
  // valid UTF-8: `text` then holds U+FFFD where the invalid bytes were, so
  // it must never be written to Overleaf.
  invalidUtf8?: boolean;
};

export type DiffStatus = 'added' | 'modified' | 'deleted' | 'unchanged';

export type DiffItem = {
  path: string;
  status: DiffStatus;
  oldSha?: string;
  newSha?: string;
  sizeBytes?: number;
  // Plain-language caution shown with the row in the preview.
  warning?: string;
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
  // A pull that would replace existing Overleaf files asks the user to type
  // "replace" in its preview (pullNeedsTypedConfirmation).
  requireConfirmationBeforeWriteBack: boolean;
  allowBinaryWriteBack: boolean;
  // On: the pull takes every text file and ignores allowedWriteBackExtensions
  // (see writeBackExtensionsFor).
  includeAllFileTypes: boolean;
  allowedWriteBackExtensions: string[];
};

export type UIPreferences = {
  // Off by default: the popup has no Manual ZIP upload (not the section, not
  // the picker in the error view, not the one in the no-tab flow).
  manualZipUploadEnabled: boolean;
  // Only applies while manualZipUploadEnabled is on: show the Manual ZIP
  // upload section in the popup all the time, not only after the automatic
  // fetch fails or when no Overleaf tab is open.
  alwaysShowManualUpload: boolean;
  // Popup and Options colour theme; 'system' follows prefers-color-scheme.
  // Dark by default.
  theme: ThemePreference;
};

export type ThemePreference = 'system' | 'light' | 'dark';
