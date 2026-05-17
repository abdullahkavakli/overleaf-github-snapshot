import type {
  ExperimentalConfig,
  ProjectLink,
  ProjectLinkMap,
  RepoConfig,
} from '../shared/types';
import {
  DEFAULT_ALLOWED_WRITE_BACK_EXTENSIONS,
  DEFAULT_EXPERIMENTAL_CONFIG,
  DEFAULT_REPO_CONFIG,
  STORAGE_KEYS,
} from '../shared/constants';

function chromeStorageGet<T = unknown>(keys: string | string[]): Promise<Record<string, T>> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(keys, (result) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve(result as Record<string, T>);
    });
  });
}

function chromeStorageSet(items: Record<string, unknown>): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(items, () => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve();
    });
  });
}

function chromeStorageRemove(keys: string | string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.remove(keys, () => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve();
    });
  });
}

function normalizeRepoConfig(stored: Partial<RepoConfig> | undefined): RepoConfig {
  if (!stored) return { ...DEFAULT_REPO_CONFIG };
  return {
    ...DEFAULT_REPO_CONFIG,
    ...stored,
    ignorePatterns:
      stored.ignorePatterns && stored.ignorePatterns.length > 0
        ? [...stored.ignorePatterns]
        : [...DEFAULT_REPO_CONFIG.ignorePatterns],
  };
}

export async function getProjectLinkMap(): Promise<ProjectLinkMap> {
  const result = await chromeStorageGet<Record<string, Partial<ProjectLink>>>(
    STORAGE_KEYS.PROJECT_LINKS,
  );
  const stored = result[STORAGE_KEYS.PROJECT_LINKS];
  if (!stored || typeof stored !== 'object') return {};
  const map: ProjectLinkMap = {};
  for (const [projectId, link] of Object.entries(stored)) {
    map[projectId] = {
      repo: normalizeRepoConfig(link?.repo),
      token: typeof link?.token === 'string' ? link.token : '',
    };
  }
  return map;
}

export async function getProjectLink(projectId: string): Promise<ProjectLink | null> {
  const map = await getProjectLinkMap();
  return map[projectId] ?? null;
}

export async function setProjectLink(
  projectId: string,
  link: ProjectLink,
): Promise<void> {
  const map = await getProjectLinkMap();
  map[projectId] = {
    repo: normalizeRepoConfig(link.repo),
    token: link.token,
  };
  await chromeStorageSet({ [STORAGE_KEYS.PROJECT_LINKS]: map });
}

export async function removeProjectLink(projectId: string): Promise<void> {
  const map = await getProjectLinkMap();
  if (!(projectId in map)) return;
  delete map[projectId];
  await chromeStorageSet({ [STORAGE_KEYS.PROJECT_LINKS]: map });
}

export async function clearProjectLinks(): Promise<void> {
  await chromeStorageRemove(STORAGE_KEYS.PROJECT_LINKS);
}

// Reads the pre-0.5.0 single repo config + token so the popup can pre-fill the
// first project the user links. Returns null on a fresh install (nothing to
// migrate).
export async function readLegacySingleConfig(): Promise<{
  repo: RepoConfig;
  token: string;
} | null> {
  const result = await chromeStorageGet<unknown>([
    STORAGE_KEYS.REPO_CONFIG,
    STORAGE_KEYS.GITHUB_TOKEN,
  ]);
  const storedRepo = result[STORAGE_KEYS.REPO_CONFIG] as
    | Partial<RepoConfig>
    | undefined;
  const storedToken = result[STORAGE_KEYS.GITHUB_TOKEN];
  const token = typeof storedToken === 'string' ? storedToken : '';
  if (!storedRepo && token.length === 0) return null;
  return { repo: normalizeRepoConfig(storedRepo), token };
}

export async function clearLegacySingleConfig(): Promise<void> {
  await chromeStorageRemove([STORAGE_KEYS.REPO_CONFIG, STORAGE_KEYS.GITHUB_TOKEN]);
}

export function isConfigured(config: RepoConfig): boolean {
  return Boolean(config.owner?.trim() && config.repo?.trim() && config.branch?.trim());
}

export function isLinkComplete(link: ProjectLink): boolean {
  return isConfigured(link.repo) && link.token.trim().length > 0;
}

function sanitizeExtensions(values: unknown): string[] {
  if (!Array.isArray(values)) return [...DEFAULT_ALLOWED_WRITE_BACK_EXTENSIONS];
  const cleaned = values
    .map((v) => (typeof v === 'string' ? v.trim().toLowerCase() : ''))
    .filter((v) => v.length > 0)
    .map((v) => (v.startsWith('.') ? v : `.${v}`));
  return cleaned.length > 0 ? cleaned : [...DEFAULT_ALLOWED_WRITE_BACK_EXTENSIONS];
}

export async function getExperimentalConfig(): Promise<ExperimentalConfig> {
  const result = await chromeStorageGet<Partial<ExperimentalConfig>>(
    STORAGE_KEYS.EXPERIMENTAL_CONFIG,
  );
  const stored = result[STORAGE_KEYS.EXPERIMENTAL_CONFIG];
  if (!stored) return { ...DEFAULT_EXPERIMENTAL_CONFIG };
  return {
    ...DEFAULT_EXPERIMENTAL_CONFIG,
    ...stored,
    allowedWriteBackExtensions: sanitizeExtensions(stored.allowedWriteBackExtensions),
  };
}

export async function setExperimentalConfig(config: ExperimentalConfig): Promise<void> {
  await chromeStorageSet({ [STORAGE_KEYS.EXPERIMENTAL_CONFIG]: config });
}

export async function clearExperimentalConfig(): Promise<void> {
  await chromeStorageRemove(STORAGE_KEYS.EXPERIMENTAL_CONFIG);
}
