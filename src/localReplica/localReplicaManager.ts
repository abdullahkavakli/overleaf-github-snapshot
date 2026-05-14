// Local replica prototype manager.
//
// Holds the user's chosen folder handle and the last-known Overleaf base
// snapshot. Exposes only explicit operations:
//
//   * compareToOverleaf(...)     — three-way diff, no writes
//   * pullOverleafToLocal(...)   — write Overleaf snapshot to local folder
//                                   (requires the user to have approved)
//   * collectLocalSnapshot(...)  — read local folder for further actions
//
// There is no file watcher, no background sync, and no implicit write to
// either side. Phase-7 explicitly forbids destructive automatic sync.

import type { ProjectFile } from '../shared/types';
import {
  getLocalReplicaCapabilities,
  pickLocalFolder,
  readLocalFolderAsProjectFiles,
  writeProjectFilesToFolder,
} from './localFolderAccess';
import { compareReplicas } from './localConflictDetector';
import type {
  LocalReplicaCapabilities,
  LocalReplicaComparison,
  LocalReplicaSession,
} from './localReplicaTypes';

let session: LocalReplicaSession | null = null;

export function getLocalReplicaSession(): LocalReplicaSession | null {
  return session;
}

export function getCapabilities(): LocalReplicaCapabilities {
  return getLocalReplicaCapabilities();
}

export async function chooseLocalFolder(): Promise<LocalReplicaSession> {
  const handle = await pickLocalFolder();
  session = {
    folderName: handle.name,
    handle,
    baseSnapshot: null,
  };
  return session;
}

export function setBaseSnapshot(files: ProjectFile[]): void {
  if (!session) return;
  session.baseSnapshot = files;
}

export async function collectLocalSnapshot(): Promise<ProjectFile[]> {
  if (!session || !session.handle) {
    throw new Error('local_replica_unavailable: no folder chosen.');
  }
  return readLocalFolderAsProjectFiles(session.handle as FileSystemDirectoryHandle);
}

export async function compareToOverleaf(
  overleafFiles: ProjectFile[],
  githubCurrent?: Map<string, string>,
): Promise<LocalReplicaComparison> {
  if (!session) {
    throw new Error('local_replica_unavailable: no folder chosen.');
  }
  const localFiles = await collectLocalSnapshot();
  return compareReplicas(
    session.baseSnapshot,
    overleafFiles,
    localFiles,
    githubCurrent,
  );
}

export async function pullOverleafToLocal(
  overleafFiles: ProjectFile[],
): Promise<void> {
  if (!session || !session.handle) {
    throw new Error('local_replica_unavailable: no folder chosen.');
  }
  await writeProjectFilesToFolder(
    session.handle as FileSystemDirectoryHandle,
    overleafFiles,
  );
  session.baseSnapshot = overleafFiles;
}

export function clearLocalSession(): void {
  session = null;
}
