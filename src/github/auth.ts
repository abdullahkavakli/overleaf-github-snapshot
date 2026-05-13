import { STORAGE_KEYS } from '../shared/constants';

function chromeStorageGet(key: string): Promise<Record<string, string | undefined>> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(key, (result) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve(result as Record<string, string | undefined>);
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

function chromeStorageRemove(key: string): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.remove(key, () => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve();
    });
  });
}

export async function getToken(): Promise<string | null> {
  const result = await chromeStorageGet(STORAGE_KEYS.GITHUB_TOKEN);
  const raw = result[STORAGE_KEYS.GITHUB_TOKEN];
  if (typeof raw !== 'string' || raw.length === 0) return null;
  return raw;
}

export async function setToken(token: string): Promise<void> {
  await chromeStorageSet({ [STORAGE_KEYS.GITHUB_TOKEN]: token });
}

export async function clearToken(): Promise<void> {
  await chromeStorageRemove(STORAGE_KEYS.GITHUB_TOKEN);
}

export async function hasToken(): Promise<boolean> {
  return (await getToken()) !== null;
}
