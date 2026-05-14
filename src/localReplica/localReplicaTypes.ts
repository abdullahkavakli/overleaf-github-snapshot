import type { ProjectFile } from '../shared/types';

export type LocalReplicaStatus =
  | 'unchanged'
  | 'local_modified'
  | 'overleaf_modified'
  | 'both_modified_conflict'
  | 'local_only'
  | 'overleaf_only'
  | 'deleted_local'
  | 'deleted_overleaf';

export type LocalReplicaEntry = {
  path: string;
  status: LocalReplicaStatus;
  overleafBaseSha?: string;
  overleafCurrentSha?: string;
  localCurrentSha?: string;
  githubCurrentSha?: string;
};

export type LocalReplicaComparison = {
  entries: LocalReplicaEntry[];
  generatedAt: string;
};

export type LocalReplicaSession = {
  folderName: string;
  // Browser handle, when File System Access API is available.
  // Kept opaque on purpose so callers don't depend on the concrete type
  // (which is `FileSystemDirectoryHandle`, only present in supporting
  // browsers).
  handle: unknown | null;
  baseSnapshot: ProjectFile[] | null;
};

export type LocalReplicaCapabilities = {
  fileSystemAccessApi: boolean;
};
