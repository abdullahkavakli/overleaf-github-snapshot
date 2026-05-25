// Orchestrates the experimental live read-only pull.
//
// Architecture: the popup runs in chrome-extension://… origin and cannot
// open a WebSocket Overleaf will accept. So this module looks up the
// active Overleaf project tab and dispatches a LIVE_FETCH_SNAPSHOT
// message to the content script running on overleaf.com — the content
// script holds the Socket.IO 0.9 client, runs joinProject/joinDoc,
// gathers static files via REST, and returns a SerializedProjectFile[].
// We deserialize and hand the result to the diff/commit pipeline.
//
// If the content script is missing (e.g. the user installed/updated the
// extension after opening the Overleaf tab), LIVE_PING will fail and we
// surface a clear "refresh the Overleaf tab" recovery action.
//
// AGPL-3.0. The protocol vocabulary is adapted from Overleaf Workshop.

import type { ExperimentalConfig, ProjectFile } from '../../shared/types';
import {
  projectFileFromWire,
  type BridgeRequest,
  type BridgeResponse,
  type LiveSnapshotResponseData,
  BRIDGE_VERSION,
} from './bridgeProtocol';
import { LiveSyncError, type OverleafLiveSnapshot } from './types';

const LIVE_FETCH_TIMEOUT_MS = 60_000;

// MV3 only auto-injects content scripts at navigation time, so any Overleaf
// tab opened before the extension was installed or updated will not have
// the bridge loaded. The user shouldn't have to know that — every bridge
// call goes through sendBridgeRequest which auto-injects on
// protocol_unavailable, then poll-retries the same request to cover the
// @crxjs loader's async import gap.
//
// The content script's own double-init guard (see overleafContentScript.ts)
// keeps re-injection idempotent: subsequent injections in the same isolated
// world become no-ops, so concurrent bridge calls don't pile up duplicate
// listeners that would double-handle messages.
async function injectOverleafContentScripts(tabId: number): Promise<void> {
  const manifest = chrome.runtime.getManifest();
  const entries = manifest.content_scripts ?? [];
  const files: string[] = [];
  for (const cs of entries) {
    const matchesOverleaf = cs.matches?.some((m) => m.includes('overleaf.com'));
    if (matchesOverleaf && cs.js) files.push(...cs.js);
  }
  if (files.length === 0) {
    throw new Error('Manifest declares no overleaf.com content scripts to inject.');
  }
  await chrome.scripting.executeScript({ target: { tabId }, files });
}

export async function findOverleafTab(projectId: string): Promise<chrome.tabs.Tab | null> {
  const tabs = await chrome.tabs.query({
    url: [`https://www.overleaf.com/project/${projectId}*`],
  });
  if (tabs.length === 0) return null;
  // Prefer the active tab if multiple match.
  const active = tabs.find((t) => t.active);
  return (active ?? tabs[0]) ?? null;
}

// One-shot raw send. No auto-inject. Used by sendBridgeRequest's retry
// loop and not exposed because almost no caller wants the no-auto-inject
// semantics.
function sendBridgeRequestRaw<T>(
  tabId: number,
  request: BridgeRequest,
  timeoutMs: number,
): Promise<BridgeResponse<T>> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve({
        ok: false,
        code: 'network',
        message: `Live bridge did not respond within ${timeoutMs}ms.`,
        recovery: 'Refresh the Overleaf tab and retry.',
      });
    }, timeoutMs);

    try {
      chrome.tabs.sendMessage(tabId, request, (response) => {
        clearTimeout(timer);
        const lastError = chrome.runtime.lastError;
        if (lastError) {
          resolve({
            ok: false,
            code: 'protocol_unavailable',
            message:
              lastError.message ??
              'No content script responded on the Overleaf tab. Refresh it.',
            recovery: 'Refresh the Overleaf project tab so the content script reloads.',
          });
          return;
        }
        if (!response || typeof response !== 'object') {
          resolve({
            ok: false,
            code: 'protocol_unavailable',
            message: 'Live bridge returned an empty response.',
          });
          return;
        }
        resolve(response as BridgeResponse<T>);
      });
    } catch (e) {
      clearTimeout(timer);
      resolve({
        ok: false,
        code: 'unknown',
        message: e instanceof Error ? e.message : String(e),
      });
    }
  });
}

// Public send. Auto-injects the content script on protocol_unavailable
// and poll-retries the SAME request. Safe to retry because
// chrome.runtime.lastError = "Receiving end does not exist" fires BEFORE
// the message is delivered, so the original request never reached
// page-side code — even non-idempotent writes haven't run.
export async function sendBridgeRequest<T>(
  tabId: number,
  request: BridgeRequest,
  timeoutMs: number,
): Promise<BridgeResponse<T>> {
  const first = await sendBridgeRequestRaw<T>(tabId, request, timeoutMs);
  if (first.ok) return first;
  if (first.code !== 'protocol_unavailable') return first;

  try {
    await injectOverleafContentScripts(tabId);
  } catch (e) {
    return {
      ok: false,
      code: 'protocol_unavailable',
      message: `Live bridge not reachable and on-demand injection failed: ${
        e instanceof Error ? e.message : String(e)
      }`,
      recovery: 'Refresh the Overleaf project tab so the content script reloads.',
    };
  }

  // Poll the bridge briefly — the @crxjs loader's dynamic import means the
  // listener isn't synchronously ready when executeScript() resolves.
  for (let i = 0; i < 5; i++) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    const retry = await sendBridgeRequestRaw<T>(tabId, request, timeoutMs);
    if (retry.ok) return retry;
    if (retry.code !== 'protocol_unavailable') return retry;
  }
  return {
    ok: false,
    code: 'protocol_unavailable',
    message: 'Live bridge not reachable on the Overleaf tab even after on-demand injection.',
    recovery: 'Refresh the Overleaf project tab manually.',
  };
}

export async function fetchOverleafLiveSnapshot(
  projectId: string,
  experimental: ExperimentalConfig,
): Promise<OverleafLiveSnapshot> {
  if (!experimental.experimentalLiveSyncEnabled) {
    throw new LiveSyncError('live_sync_disabled', 'Experimental live sync is disabled.');
  }
  if (!experimental.liveReadOnlyPullEnabled) {
    throw new LiveSyncError('live_sync_disabled', 'Live read-only pull is disabled.');
  }

  const tab = await findOverleafTab(projectId);
  if (!tab || typeof tab.id !== 'number') {
    throw new LiveSyncError(
      'project_join_failed',
      `No open Overleaf tab matches project ${projectId}.`,
      'Open the Overleaf project tab and try again.',
    );
  }

  // Ping to confirm the bridge is reachable. sendBridgeRequest itself
  // auto-injects + poll-retries on protocol_unavailable, so we don't
  // need a separate inject path here — the explicit ping just lets us
  // surface the project_join_failed case (tab is on a non-project URL)
  // before we kick off the heavier LIVE_FETCH_SNAPSHOT.
  const ping = await sendBridgeRequest<{ onProjectPage: boolean }>(
    tab.id,
    { type: 'LIVE_PING', version: BRIDGE_VERSION },
    5_000,
  );
  if (!ping.ok) {
    throw new LiveSyncError(
      'protocol_unavailable',
      `Live bridge not reachable on the Overleaf tab: ${ping.message}`,
      ping.recovery ?? 'Refresh the Overleaf tab so the updated content script loads.',
    );
  }
  if (!ping.data.onProjectPage) {
    throw new LiveSyncError(
      'project_join_failed',
      'The Overleaf tab is not currently on a project URL.',
      'Open the project (https://www.overleaf.com/project/...) and try again.',
    );
  }

  const response = await sendBridgeRequest<LiveSnapshotResponseData>(
    tab.id,
    { type: 'LIVE_FETCH_SNAPSHOT', version: BRIDGE_VERSION, projectId },
    LIVE_FETCH_TIMEOUT_MS,
  );

  if (!response.ok) {
    throw new LiveSyncError(response.code, response.message, response.recovery);
  }

  const files: ProjectFile[] = response.data.files.map(projectFileFromWire);
  files.sort((a, b) => a.path.localeCompare(b.path));

  return {
    projectId: response.data.projectId,
    files,
    source: 'overleaf-live-readonly',
    fetchedAt: response.data.fetchedAt,
    warnings: response.data.warnings,
  };
}
