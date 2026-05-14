// Three-way comparator for the local replica prototype.
//
// Compute the smallest possible conflict matrix between:
//   - the user's last Overleaf base snapshot,
//   - the current state of Overleaf,
//   - the current state of the chosen local folder.
//
// GitHub state is optional and only used to label rows; it never drives
// automatic resolution.

import type { ProjectFile } from '../shared/types';
import type { LocalReplicaComparison, LocalReplicaEntry, LocalReplicaStatus } from './localReplicaTypes';

function indexBy<T>(items: T[], key: (item: T) => string): Map<string, T> {
  const m = new Map<string, T>();
  for (const item of items) m.set(key(item), item);
  return m;
}

export function compareReplicas(
  base: ProjectFile[] | null,
  overleafCurrent: ProjectFile[],
  localCurrent: ProjectFile[],
  githubCurrent?: Map<string, string>,
): LocalReplicaComparison {
  const baseMap = indexBy(base ?? [], (f) => f.path);
  const overleafMap = indexBy(overleafCurrent, (f) => f.path);
  const localMap = indexBy(localCurrent, (f) => f.path);
  const allPaths = new Set<string>([
    ...baseMap.keys(),
    ...overleafMap.keys(),
    ...localMap.keys(),
  ]);

  const entries: LocalReplicaEntry[] = [];
  for (const path of allPaths) {
    const baseSha = baseMap.get(path)?.sha256;
    const overleafSha = overleafMap.get(path)?.sha256;
    const localSha = localMap.get(path)?.sha256;
    const githubSha = githubCurrent?.get(path);

    const status = computeStatus(baseSha, overleafSha, localSha);
    entries.push({
      path,
      status,
      overleafBaseSha: baseSha,
      overleafCurrentSha: overleafSha,
      localCurrentSha: localSha,
      githubCurrentSha: githubSha,
    });
  }
  entries.sort((a, b) => a.path.localeCompare(b.path));
  return {
    entries,
    generatedAt: new Date().toISOString(),
  };
}

function computeStatus(
  base: string | undefined,
  overleaf: string | undefined,
  local: string | undefined,
): LocalReplicaStatus {
  const inBase = base !== undefined;
  const inOverleaf = overleaf !== undefined;
  const inLocal = local !== undefined;

  if (!inOverleaf && !inLocal) {
    // Should not happen if iteration covers union of paths, but be safe.
    return 'deleted_overleaf';
  }
  if (!inOverleaf && inLocal) {
    if (inBase) return 'deleted_overleaf';
    return 'local_only';
  }
  if (inOverleaf && !inLocal) {
    if (inBase) return 'deleted_local';
    return 'overleaf_only';
  }
  // Both present.
  const overleafChanged = inBase && overleaf !== base;
  const localChanged = inBase && local !== base;
  if (!inBase) {
    // No base reference; treat parity as overleaf_only if shas differ to
    // force the user to decide.
    if (overleaf === local) return 'unchanged';
    return 'both_modified_conflict';
  }
  if (!overleafChanged && !localChanged) return 'unchanged';
  if (overleafChanged && !localChanged) return 'overleaf_modified';
  if (!overleafChanged && localChanged) return 'local_modified';
  if (overleafChanged && localChanged) {
    if (overleaf === local) return 'unchanged';
    return 'both_modified_conflict';
  }
  return 'unchanged';
}
