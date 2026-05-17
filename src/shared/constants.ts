import type { ExperimentalConfig, RepoConfig } from './types';

export const STORAGE_KEYS = {
  // legacy — read-only, consumed once by the per-project migration
  GITHUB_TOKEN: 'github_token',
  REPO_CONFIG: 'repo_config',
  PROJECT_LINKS: 'project_links',
  EXPERIMENTAL_CONFIG: 'experimental_config',
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

export const DEFAULT_EXPERIMENTAL_CONFIG: ExperimentalConfig = {
  experimentalLiveSyncEnabled: false,
  liveReadOnlyPullEnabled: false,
  overleafWriteBackEnabled: false,
  localReplicaEnabled: false,
  requireZipBackupBeforeWriteBack: true,
  requireConfirmationBeforeWriteBack: true,
  allowBinaryWriteBack: false,
  allowedWriteBackExtensions: [...DEFAULT_ALLOWED_WRITE_BACK_EXTENSIONS],
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
