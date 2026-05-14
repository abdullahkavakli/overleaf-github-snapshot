import type { ExperimentalConfig, RepoConfig } from '../shared/types';
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

export async function getRepoConfig(): Promise<RepoConfig> {
  const result = await chromeStorageGet<Partial<RepoConfig>>(STORAGE_KEYS.REPO_CONFIG);
  const stored = result[STORAGE_KEYS.REPO_CONFIG];
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

export async function setRepoConfig(config: RepoConfig): Promise<void> {
  await chromeStorageSet({ [STORAGE_KEYS.REPO_CONFIG]: config });
}

export async function clearRepoConfig(): Promise<void> {
  await chromeStorageRemove(STORAGE_KEYS.REPO_CONFIG);
}

export function isConfigured(config: RepoConfig): boolean {
  return Boolean(config.owner?.trim() && config.repo?.trim() && config.branch?.trim());
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
