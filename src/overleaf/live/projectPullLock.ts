// Extension-side lock: only one pull (or Options write-back test) runs
// against an Overleaf project at a time in this browser, whether it was
// started from the popup or the Options page.
//
// The content script already serializes the changes it sends to Overleaf
// per project (runProjectMutation in src/content/liveBridgeHandler.ts), but
// only inside one tab. Two runs aimed at two tabs of the same project could
// still both read a doc at the same version and apply the same change
// twice, so every run also holds this lock from start to finish, and a
// second run is refused before it touches Overleaf.
//
// The lock is a record in chrome.storage.session: shared by every
// extension page, covered by the existing "storage" permission, and
// cleared when the browser quits. It names its owner and expires
// PULL_LOCK_TTL_MS after the last renewal. A popup closed mid-run is
// killed without running its `finally`, so the expiry is what frees the
// lock then. chrome.storage has no compare-and-set, so the
// read-check-write runs under a Web Lock, which all pages of the extension
// share.

import { LiveSyncError } from './types';

const PULL_LOCK_TTL_MS = 90_000;
// Chrome may slow timers in a hidden page (an Options tab in the
// background) to about one per minute; renewals stay well inside the TTL.
const PULL_LOCK_RENEW_MS = 20_000;
const LOCK_TABLE_NAME = 'ofs-pull-lock-table';

type PullLockRecord = { owner: string; expiresAt: number };

function lockKey(projectId: string): string {
  return `pullLock:${projectId}`;
}

function newOwnerId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function liveRecord(value: unknown, now: number): PullLockRecord | null {
  if (!value || typeof value !== 'object') return null;
  const r = value as Partial<PullLockRecord>;
  if (typeof r.owner !== 'string' || typeof r.expiresAt !== 'number') return null;
  return r.expiresAt > now ? (r as PullLockRecord) : null;
}

// Runs `fn` while holding the Web Lock that guards the lock records, so a
// read-check-write on chrome.storage.session is atomic across pages.
async function underTableLock<T>(fn: () => Promise<T>): Promise<T> {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  if (!locks) return fn();
  let result: T | undefined;
  await locks.request(LOCK_TABLE_NAME, async () => {
    result = await fn();
  });
  return result as T;
}

// Runs `run` while holding the pull lock for `projectId`. Throws a
// LiveSyncError ('project_busy') without calling `run` when another live
// owner holds it.
export async function withProjectPullLock<T>(
  projectId: string,
  run: () => Promise<T>,
): Promise<T> {
  const area = typeof chrome !== 'undefined' ? chrome.storage?.session : undefined;
  if (!area) {
    throw new LiveSyncError(
      'unknown',
      'This version of Chrome cannot keep two pulls from running at once, so the pull did not start. Nothing was written.',
      'Update Chrome, then try again.',
    );
  }
  const key = lockKey(projectId);
  const owner = newOwnerId();
  const write = (): Promise<void> =>
    area.set({ [key]: { owner, expiresAt: Date.now() + PULL_LOCK_TTL_MS } satisfies PullLockRecord });

  const acquired = await underTableLock(async () => {
    const held = liveRecord((await area.get(key))[key], Date.now());
    if (held) return false;
    await write();
    return true;
  });
  if (!acquired) {
    throw new LiveSyncError(
      'project_busy',
      'Another pull into this Overleaf project is already running, in the popup or on the Options page. Nothing was written.',
      'Wait for the other pull to finish, then try again. If you closed the window that was running it, try again in two minutes.',
    );
  }

  const renew = setInterval(() => {
    void underTableLock(async () => {
      const current = (await area.get(key))[key] as Partial<PullLockRecord> | undefined;
      if (current?.owner === owner) await write();
    }).catch(() => {
      // The next renewal tries again.
    });
  }, PULL_LOCK_RENEW_MS);
  try {
    return await run();
  } finally {
    clearInterval(renew);
    try {
      await underTableLock(async () => {
        const current = (await area.get(key))[key] as Partial<PullLockRecord> | undefined;
        if (current?.owner === owner) await area.remove(key);
      });
    } catch {
      // The record expires on its own.
    }
  }
}
