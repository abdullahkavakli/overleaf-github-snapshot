// Real-time client stub for the experimental live-sync mode.
//
// The full Overleaf Socket.IO protocol requires:
//   1. GET /socket.io/?EIO=4&transport=polling
//   2. Negotiate a session id (sid).
//   3. Open a websocket transport.
//   4. Emit joinProject(projectId), then joinDoc(docId) for each editable doc.
//
// The exact wire format depends on the Overleaf build and changes frequently.
// Rather than ship a fragile (and AGPL-tainted) reimplementation, this client
// performs the minimum capability negotiation and reports
// `protocol_unavailable` if any step is missing — at which point the caller
// falls back to the ZIP route.
//
// This file deliberately contains NO blind credential handling, NO cookie
// scraping, and NO third-party socket library import. The browser session
// is reused implicitly through `credentials: 'include'`.

import {
  getActiveDocChannel,
  setActiveDocChannel,
  type DocChannel,
  type DocSnapshot,
} from './overleafDocumentClient';
import { LiveSyncError } from './types';

export type ProjectConnection = {
  projectId: string;
  close(): void;
};

let activeConnection: ProjectConnection | null = null;

async function probeSocketHandshake(): Promise<void> {
  const url = `https://www.overleaf.com/socket.io/?EIO=4&transport=polling&t=${Date.now()}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      credentials: 'include',
      redirect: 'follow',
      cache: 'no-store',
      headers: { Accept: 'text/plain, */*' },
    });
  } catch (e) {
    throw new LiveSyncError(
      'socket_connection_failed',
      `Could not reach Overleaf real-time endpoint: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (response.status === 401 || (response.url && response.url.includes('/login'))) {
    throw new LiveSyncError('not_logged_in', 'You are not signed in to Overleaf.');
  }
  if (!response.ok) {
    throw new LiveSyncError(
      'protocol_unavailable',
      `Overleaf real-time handshake returned HTTP ${response.status}.`,
    );
  }
  const text = await response.text();
  // Engine.IO v4 handshakes begin with "0{". If the response doesn't look
  // like one, we don't know how to talk to this server.
  if (!text.startsWith('0{')) {
    throw new LiveSyncError(
      'protocol_unavailable',
      'Overleaf real-time handshake did not return a recognized payload. Live sync is unavailable on this build.',
    );
  }
}

class StubDocChannel implements DocChannel {
  // The realtime channel is not implemented in this prototype. Any attempt
  // to read or write a doc must explicitly fail rather than silently return
  // empty content — silent partial reads would result in destructive
  // commits.
  async fetchSnapshot(_docId: string): Promise<DocSnapshot> {
    throw new LiveSyncError(
      'protocol_unavailable',
      'Overleaf real-time document fetch is not implemented in this build.',
    );
  }
  async applyUpdate(
    _docId: string,
    _oldText: string,
    _newText: string,
    _baseVersion: number,
  ): Promise<DocSnapshot> {
    throw new LiveSyncError(
      'write_back_not_safe',
      'Overleaf real-time write-back is not implemented in this build (versioned channel unavailable).',
    );
  }
  close(): void {
    /* no-op */
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

  await probeSocketHandshake();

  // Capability detected, but we don't ship a full Engine.IO client. Install
  // a stub doc channel so callers receive a clear "not implemented" error
  // instead of incorrect data.
  setActiveDocChannel(new StubDocChannel());

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
