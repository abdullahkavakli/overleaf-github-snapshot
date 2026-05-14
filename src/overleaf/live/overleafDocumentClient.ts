// Read an editable Overleaf document (a "doc") via the joinDoc real-time
// channel. The full live editing protocol is Socket.IO-based and version
// gated; we expose a typed stub that the realtime client populates, and
// surface a clear `protocol_unavailable` error if the runtime cannot
// negotiate a safe join.
//
// We intentionally do NOT reimplement the full OT engine here. Phase 6
// requires versioning to be confirmed before allowing write-back; if the
// version cannot be read safely, we refuse the write and report
// `document_version_unknown`.

import { LiveSyncError } from './types';

export type DocSnapshot = {
  docId: string;
  version: number;
  lines: string[];
  text: string;
};

export type DocChannel = {
  fetchSnapshot(docId: string): Promise<DocSnapshot>;
  applyUpdate(docId: string, oldText: string, newText: string, baseVersion: number): Promise<DocSnapshot>;
  close(): void;
};

// Singleton holder for the active channel — set by the realtime client when
// a project connection is open.
let activeChannel: DocChannel | null = null;

export function setActiveDocChannel(channel: DocChannel | null): void {
  if (activeChannel && activeChannel !== channel) {
    try {
      activeChannel.close();
    } catch {
      // ignore
    }
  }
  activeChannel = channel;
}

export function getActiveDocChannel(): DocChannel | null {
  return activeChannel;
}

export async function fetchDocSnapshot(docId: string): Promise<DocSnapshot> {
  if (!activeChannel) {
    throw new LiveSyncError(
      'protocol_unavailable',
      'No active Overleaf real-time channel.',
    );
  }
  return activeChannel.fetchSnapshot(docId);
}

export async function applyDocUpdate(
  docId: string,
  oldText: string,
  newText: string,
  baseVersion: number,
): Promise<DocSnapshot> {
  if (!activeChannel) {
    throw new LiveSyncError(
      'protocol_unavailable',
      'No active Overleaf real-time channel.',
    );
  }
  return activeChannel.applyUpdate(docId, oldText, newText, baseVersion);
}
