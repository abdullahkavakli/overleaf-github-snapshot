import type { ExperimentalConfig, RepoConfig, UIPreferences } from './types';

export const STORAGE_KEYS = {
  // legacy — read-only, consumed once by the per-project migration
  GITHUB_TOKEN: 'github_token',
  REPO_CONFIG: 'repo_config',
  PROJECT_LINKS: 'project_links',
  EXPERIMENTAL_CONFIG: 'experimental_config',
  UI_PREFERENCES: 'ui_preferences',
  // Overleaf project IDs that have "Make Overleaf match GitHub exactly"
  // ticked ({ [projectId]: true }). Per project, never global: it is the one
  // option that deletes files.
  MIRROR_PROJECTS: 'mirror_match_projects',
} as const;

export const DEFAULT_ALLOWED_WRITE_BACK_EXTENSIONS: string[] = [
  '.tex',
  '.bib',
  '.cls',
  '.sty',
  '.bst',
  '.md',
  '.txt',
];

// Pull from GitHub into Overleaf (the master switch plus write-back) is on by
// default, by the owner's decision. It stays behind a preview and, for a
// pull that replaces files, the typed confirmation. The other features are
// off. These defaults apply only to a profile that never saved the live sync
// settings; stored values are kept.
export const DEFAULT_EXPERIMENTAL_CONFIG: ExperimentalConfig = {
  experimentalLiveSyncEnabled: true,
  liveReadOnlyPullEnabled: false,
  overleafWriteBackEnabled: true,
  localReplicaEnabled: false,
  requireZipBackupBeforeWriteBack: true,
  requireConfirmationBeforeWriteBack: true,
  allowBinaryWriteBack: false,
  includeAllFileTypes: false,
  allowedWriteBackExtensions: [...DEFAULT_ALLOWED_WRITE_BACK_EXTENSIONS],
};

// Start of the reason sourceFromGitHubBranch gives a GitHub symbolic link it
// leaves out of a pull (it holds a link target, not file content). The pull
// lists and the preview recognise it by this start.
export const SYMLINK_SKIPPED_REASON_PREFIX = 'symbolic link';

// In an allowed-extensions list, matches every file type.
export const ALL_FILE_TYPES = '*';

// The extension list the pull applies: every type while "Include all file
// types" is on, otherwise the user's list.
export function writeBackExtensionsFor(config: ExperimentalConfig): string[] {
  return config.includeAllFileTypes ? [ALL_FILE_TYPES] : config.allowedWriteBackExtensions;
}

export const DEFAULT_UI_PREFERENCES: UIPreferences = {
  manualZipUploadEnabled: false,
  alwaysShowManualUpload: false,
};

export const DEFAULT_IGNORE_PATTERNS: string[] = [
  '*.aux',
  '*.bbl',
  '*.blg',
  '*.fdb_latexmk',
  '*.fls',
  '*.log',
  '*.out',
  '*.synctex.gz',
  '*.toc',
  '*.xdv',
  '.DS_Store',
  'Thumbs.db',
];

export const DEFAULT_REPO_CONFIG: RepoConfig = {
  owner: '',
  repo: '',
  branch: 'main',
  targetDir: '',
  includeDeletions: false,
  ignorePatterns: [...DEFAULT_IGNORE_PATTERNS],
};

export const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024;
export const MAX_PROJECT_SIZE_BYTES = 200 * 1024 * 1024;
export const MAX_FILES = 5000;

export const GITHUB_API_BASE = 'https://api.github.com';

// GitHub's "new fine-grained token" page accepts query params that pre-fill
// name, description, resource owner and permissions. Repository selection
// can't be pre-filled, so the user still has to pick the repo there.
export function buildTokenCreationUrl(repo: Pick<RepoConfig, 'owner' | 'repo'>): string {
  const owner = repo.owner.trim();
  const name = repo.repo.trim();
  const params = new URLSearchParams();
  params.set('name', (name ? `Overleaf sync: ${name}` : 'Overleaf sync').slice(0, 40));
  params.set(
    'description',
    `Used by the Overleaf GitHub Snapshot extension to commit to ${
      owner && name ? `${owner}/${name}` : 'one repository'
    }.`,
  );
  if (owner) params.set('target_name', owner);
  params.set('contents', 'write');
  params.set('metadata', 'read');
  return `https://github.com/settings/personal-access-tokens/new?${params.toString()}`;
}

export const TEXT_EXTENSIONS = new Set<string>([
  '.tex',
  '.bib',
  '.bst',
  '.cls',
  '.sty',
  '.txt',
  '.md',
  '.markdown',
  '.json',
  '.yml',
  '.yaml',
  '.html',
  '.htm',
  '.css',
  '.js',
  '.ts',
  '.csv',
  '.tsv',
  '.gitignore',
  '.gitattributes',
  '.editorconfig',
  '.cfg',
  '.ini',
  '.toml',
  '.xml',
  '.rst',
  '.r',
  '.py',
  '.sh',
  '.latexmkrc',
]);

export const COMMON_BINARY_EXTENSIONS = new Set<string>([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.pdf',
  '.eps',
  '.zip',
  '.gz',
  '.tar',
  '.tgz',
  '.bz2',
  '.7z',
  '.rar',
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.bin',
  '.dat',
  '.dvi',
  '.ttf',
  '.otf',
  '.woff',
  '.woff2',
  '.mp3',
  '.mp4',
  '.mov',
  '.avi',
  '.ico',
]);
