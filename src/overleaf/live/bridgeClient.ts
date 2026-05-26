// Popup-side wrappers around the live-sync bridge messages used by the
// write-back path. These let the popup (which lives in chrome-extension://
// origin and cannot open an Overleaf-accepted WebSocket itself) drive
// individual project-metadata / doc-read / doc-write operations against
// the content script that does own a same-origin socket.
//
// The functions here only do typed messaging — the conflict detector,
// OT diff computation, and verify-after-write all stay in the popup
// (see overleafWriteBack.ts).

import {
  BRIDGE_VERSION,
  type BridgeResponse,
  type LiveCreateDocResponseData,
  type LiveProjectMetadataResponseData,
  type LiveReadDocResponseData,
  type LiveUploadBinaryResponseData,
  type LiveWriteDocResponseData,
  type OtOp,
} from './bridgeProtocol';
import { findOverleafTab, sendBridgeRequest } from './liveSyncManager';
import { LiveSyncError } from './types';

const METADATA_TIMEOUT_MS = 30_000;
const READ_DOC_TIMEOUT_MS = 20_000;
const WRITE_DOC_TIMEOUT_MS = 30_000;
// Create-doc may need to mkdir several folders + create the doc + seed
// content via OT, all in one bridge call. Budget extra time accordingly.
const CREATE_DOC_TIMEOUT_MS = 45_000;
// Binary upload includes mkdir + multipart POST of arbitrarily-large
// files. Cap higher; the popup's user-visible failure mode is a typed
// network timeout, not silent hang.
const UPLOAD_BINARY_TIMEOUT_MS = 90_000;

// Resolve the tab id for a project, throwing a typed error if no tab
// matches. Centralised so write-back callers don't have to duplicate the
// "open the Overleaf tab" hint.
async function resolveTabId(projectId: string): Promise<number> {
  const tab = await findOverleafTab(projectId);
  if (!tab || typeof tab.id !== 'number') {
    throw new LiveSyncError(
      'project_join_failed',
      `No open Overleaf tab matches project ${projectId}.`,
      'Open the Overleaf project tab and try again.',
    );
  }
  return tab.id;
}

export async function fetchProjectMetadataViaBridge(
  projectId: string,
): Promise<BridgeResponse<LiveProjectMetadataResponseData>> {
  const tabId = await resolveTabId(projectId);
  return sendBridgeRequest<LiveProjectMetadataResponseData>(
    tabId,
    {
      type: 'LIVE_FETCH_PROJECT_METADATA',
      version: BRIDGE_VERSION,
      projectId,
    },
    METADATA_TIMEOUT_MS,
  );
}

export async function readDocViaBridge(
  projectId: string,
  docId: string,
): Promise<BridgeResponse<LiveReadDocResponseData>> {
  const tabId = await resolveTabId(projectId);
  return sendBridgeRequest<LiveReadDocResponseData>(
    tabId,
    {
      type: 'LIVE_READ_DOC',
      version: BRIDGE_VERSION,
      projectId,
      docId,
    },
    READ_DOC_TIMEOUT_MS,
  );
}

export async function writeDocViaBridge(
  projectId: string,
  docId: string,
  ops: OtOp[],
  baseVersion: number,
): Promise<BridgeResponse<LiveWriteDocResponseData>> {
  const tabId = await resolveTabId(projectId);
  return sendBridgeRequest<LiveWriteDocResponseData>(
    tabId,
    {
      type: 'LIVE_WRITE_DOC',
      version: BRIDGE_VERSION,
      projectId,
      docId,
      ops,
      baseVersion,
    },
    WRITE_DOC_TIMEOUT_MS,
  );
}

export async function createDocAtPathViaBridge(
  projectId: string,
  path: string,
  initialContent: string,
): Promise<BridgeResponse<LiveCreateDocResponseData>> {
  const tabId = await resolveTabId(projectId);
  return sendBridgeRequest<LiveCreateDocResponseData>(
    tabId,
    {
      type: 'LIVE_CREATE_DOC_AT_PATH',
      version: BRIDGE_VERSION,
      projectId,
      path,
      initialContent,
    },
    CREATE_DOC_TIMEOUT_MS,
  );
}

export async function uploadBinaryViaBridge(
  projectId: string,
  path: string,
  contentBase64: string,
): Promise<BridgeResponse<LiveUploadBinaryResponseData>> {
  const tabId = await resolveTabId(projectId);
  return sendBridgeRequest<LiveUploadBinaryResponseData>(
    tabId,
    {
      type: 'LIVE_UPLOAD_BINARY',
      version: BRIDGE_VERSION,
      projectId,
      path,
      contentBase64,
    },
    UPLOAD_BINARY_TIMEOUT_MS,
  );
}
