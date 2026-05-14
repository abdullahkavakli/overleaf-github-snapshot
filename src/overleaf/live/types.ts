// Types shared by experimental live-sync modules.
//
// IMPORTANT: nothing in these modules reads document.cookie, opens the
// chrome.cookies API, or stores Overleaf credentials. The browser attaches
// the user's existing Overleaf session to outgoing same-origin requests via
// `credentials: 'include'`; the extension never sees the cookie itself.

import type { ProjectFile } from '../../shared/types';

export type LiveSyncErrorCode =
  | 'live_sync_disabled'
  | 'protocol_unavailable'
  | 'socket_connection_failed'
  | 'project_join_failed'
  | 'document_join_failed'
  | 'document_version_unknown'
  | 'unsupported_file_type'
  | 'remote_changed'
  | 'write_back_disabled'
  | 'write_back_not_safe'
  | 'local_replica_unavailable'
  | 'not_logged_in'
  | 'forbidden'
  | 'network'
  | 'unknown';

export class LiveSyncError extends Error {
  code: LiveSyncErrorCode;
  recovery?: string;

  constructor(code: LiveSyncErrorCode, message: string, recovery?: string) {
    super(message);
    this.name = 'LiveSyncError';
    this.code = code;
    this.recovery = recovery;
  }
}

export function recoveryActionForLiveSyncError(code: LiveSyncErrorCode): string {
  switch (code) {
    case 'live_sync_disabled':
      return 'Enable experimental live sync in the extension options.';
    case 'protocol_unavailable':
    case 'socket_connection_failed':
    case 'project_join_failed':
    case 'document_join_failed':
    case 'document_version_unknown':
      return 'Use the ZIP snapshot route instead, or refresh the Overleaf tab.';
    case 'unsupported_file_type':
      return 'Skip this file or perform the change in Overleaf directly.';
    case 'remote_changed':
      return 'Resolve the conflict manually — refresh the diff and retry.';
    case 'write_back_disabled':
      return 'Enable explicit write-back in the extension options first.';
    case 'write_back_not_safe':
      return 'Write-back is unavailable because safe Overleaf document versioning could not be confirmed.';
    case 'local_replica_unavailable':
      return 'Local replica requires File System Access API or a native helper.';
    case 'not_logged_in':
      return 'Sign in to Overleaf in this browser and try again.';
    case 'forbidden':
      return 'Your account may not have access to this project.';
    case 'network':
      return 'Check your network and try again.';
    default:
      return 'Use the ZIP snapshot route as a fallback.';
  }
}

export type OverleafLiveSnapshot = {
  projectId: string;
  files: ProjectFile[];
  source: 'overleaf-live-readonly';
  fetchedAt: string;
  warnings: string[];
};

export type LiveProjectFolder = {
  _id?: string;
  name: string;
  folders?: LiveProjectFolder[];
  docs?: LiveProjectEntry[];
  fileRefs?: LiveProjectEntry[];
};

export type LiveProjectEntry = {
  _id: string;
  name: string;
  type?: string;
};

export type LiveProjectMetadata = {
  projectId: string;
  rootFolder?: LiveProjectFolder[];
  rootDoc_id?: string;
  name?: string;
};

export type WriteBackCandidate = {
  path: string;
  oldText: string;
  newText: string;
  baseSha256: string;
};

export type WriteBackResult = {
  path: string;
  status: 'written' | 'skipped' | 'conflict' | 'failed';
  message?: string;
};

export type OverleafWriteBackOptions = {
  requireZipBackup: boolean;
  requireConfirmation: boolean;
  allowedExtensions: string[];
  allowBinary: boolean;
};
