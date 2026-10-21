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
  // The Overleaf tab runs a content script from before the bridge learned
  // project sessions (re-injection is a no-op there), so it cannot serve
  // LIVE_SESSION_* messages until the tab is reloaded.
  | 'bridge_outdated'
  // A LIVE_SESSION_* message named a session the content script no longer
  // holds (tab reloaded, or the session idled out).
  | 'bridge_session_lost'
  // A create-only operation found a doc or file already at the target path
  // in Overleaf, so it changed nothing.
  | 'already_exists'
  // Another pull (or Options write-back test) into the same project is
  // still running in this browser (projectPullLock.ts).
  | 'project_busy'
  // The operation was never sent: an earlier one in the same run lost the
  // connection to the Overleaf tab (bridgeSession.ts).
  | 'not_attempted'
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
    case 'bridge_outdated':
      return 'Reload the Overleaf tab so the updated extension script loads, then try again.';
    case 'bridge_session_lost':
      return 'Run the pull again; if it keeps happening, reload the Overleaf tab.';
    case 'already_exists':
      return 'Nothing was replaced. To use the GitHub version, delete or rename the file in Overleaf, then run the pull again.';
    case 'project_busy':
      return 'Wait for the other pull to finish, then try again. If you closed the window that was running it, try again in two minutes.';
    case 'not_attempted':
      return 'Run the pull again.';
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
