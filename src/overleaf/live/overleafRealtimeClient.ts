// Real-time client for the experimental live-sync mode.
//
// The popup itself cannot open a same-origin WebSocket Overleaf will
// accept (its origin is chrome-extension://, which the server rejects).
// We instead delegate every per-doc read/write to the content-script
// bridge, which holds the Socket.IO 0.9 client on the project page.
//
// This file deliberately contains NO blind credential handling, NO cookie
// scraping, and NO third-party socket library import. The browser session
// is reused implicitly through the bridge calls that run on overleaf.com.

import {
  readDocViaBridge,
  writeDocViaBridge,
} from './bridgeClient';
import {
  getActiveDocChannel,
  setActiveDocChannel,
  type DocChannel,
  type DocSnapshot,
} from './overleafDocumentClient';
import { diffToOps } from './overleafOt';
import { LiveSyncError } from './types';

export type ProjectConnection = {
  projectId: string;
  close(): void;
};

let activeConnection: ProjectConnection | null = null;

// Bridge-backed doc channel. Each read/write is one chrome.tabs.sendMessage
// round-trip to the content script, which in turn opens its own short-lived
// Socket.IO connection per request. There is no socket state held in the
// popup; that's deliberate — the popup can be closed/reopened at any time.
class BridgeDocChannel implements DocChannel {
  constructor(private readonly projectId: string) {}

  async fetchSnapshot(docId: string): Promise<DocSnapshot> {
    const response = await readDocViaBridge(this.projectId, docId);
    if (!response.ok) {
      throw new LiveSyncError(response.code, response.message, response.recovery);
    }
    const { version, text } = response.data;
    return { docId, version, lines: text.split('\n'), text };
  }

  async applyUpdate(
    docId: string,
    oldText: string,
    newText: string,
    baseVersion: number,
  ): Promise<DocSnapshot> {
    const ops = diffToOps(oldText, newText);
    if (ops.length === 0) {
      // No-op write: re-fetch the current state so the caller's verify
      // path sees consistent data without burning a write.
      return this.fetchSnapshot(docId);
    }
    const response = await writeDocViaBridge(this.projectId, docId, ops, baseVersion);
    if (!response.ok) {
      throw new LiveSyncError(response.code, response.message, response.recovery);
    }
    const { newVersion, text } = response.data;
    return { docId, version: newVersion, lines: text.split('\n'), text };
  }

  close(): void {
    /* no-op — there is no persistent socket on the popup side. */
  }
}

export async function openProjectConnection(
  projectId: string,
): Promise<ProjectConnection> {
  if (!/^[a-zA-Z0-9]+$/.test(projectId)) {
    throw new LiveSyncError('unknown', 'Invalid Overleaf project ID.');
  }
  if (activeConnection && activeConnection.projectId === projectId) {
    return activeConnection;
  }
  closeActiveConnection();

  // No popup-side handshake probe: every bridge read/write triggers its
  // own connect+joinProject inside the content script and returns a
  // typed error if anything fails. Probing twice would just slow the
  // first call without adding signal.
  setActiveDocChannel(new BridgeDocChannel(projectId));

  const connection: ProjectConnection = {
    projectId,
    close() {
      if (activeConnection === this) {
        activeConnection = null;
      }
      const channel = getActiveDocChannel();
      if (channel) {
        setActiveDocChannel(null);
      }
    },
  };
  activeConnection = connection;
  return connection;
}

export function closeActiveConnection(): void {
  if (activeConnection) {
    try {
      activeConnection.close();
    } catch {
      // ignore
    }
    activeConnection = null;
  }
  setActiveDocChannel(null);
}
