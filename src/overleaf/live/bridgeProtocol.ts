// Message protocol between the popup (extension context) and the content
// script running on overleaf.com. The content script holds the WebSocket
// because:
//
//   * MV3 extension WebSockets are sent with Origin: chrome-extension://...,
//     which Overleaf rejects.
//   * Content scripts run in the page origin and inherit cookies + CSRF
//     access via the page DOM.
//
// All messages are JSON-serialisable. Binary file content travels as a
// base64 string to survive structured-clone over chrome.runtime messaging.

import type { ProjectFile } from '../../shared/types';
import type { LiveSyncErrorCode } from './types';

export const BRIDGE_VERSION = 1 as const;

export type BridgeRequest =
  | {
      type: 'LIVE_PING';
      version: typeof BRIDGE_VERSION;
    }
  | {
      type: 'LIVE_FETCH_SNAPSHOT';
      version: typeof BRIDGE_VERSION;
      projectId: string;
    };

export type SerializedProjectFile = {
  path: string;
  // Always base64 over the wire — Uint8Array doesn't survive structured-
  // clone in all MV3 versions, and base64 keeps message size predictable.
  contentBase64: string;
  text?: string;
  encoding: 'utf-8' | 'base64';
  sha256: string;
  sizeBytes: number;
  isBinary: boolean;
};

export type BridgeFailure = {
  ok: false;
  code: LiveSyncErrorCode;
  message: string;
  recovery?: string;
};

export type BridgeSuccess<T> = {
  ok: true;
  data: T;
};

export type BridgeResponse<T> = BridgeSuccess<T> | BridgeFailure;

export type LiveSnapshotResponseData = {
  projectId: string;
  files: SerializedProjectFile[];
  warnings: string[];
  fetchedAt: string;
};

export function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const chunk = bytes.subarray(i, i + CHUNK);
    binary += String.fromCharCode.apply(null, Array.from(chunk));
  }
  return btoa(binary);
}

export function base64ToUint8(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function projectFileToWire(file: ProjectFile): SerializedProjectFile {
  return {
    path: file.path,
    contentBase64: uint8ToBase64(file.content),
    text: file.text,
    encoding: file.encoding,
    sha256: file.sha256,
    sizeBytes: file.sizeBytes,
    isBinary: file.isBinary,
  };
}

export function projectFileFromWire(wire: SerializedProjectFile): ProjectFile {
  return {
    path: wire.path,
    content: base64ToUint8(wire.contentBase64),
    text: wire.text,
    encoding: wire.encoding,
    sha256: wire.sha256,
    sizeBytes: wire.sizeBytes,
    isBinary: wire.isBinary,
  };
}
