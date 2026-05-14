// Source manager: turn each input mode (manual ZIP, automatic ZIP route,
// experimental live pull) into a uniform SourceSnapshot. The diff/commit
// pipeline only ever operates on SourceSnapshot.files, so it remains source-
// agnostic.

import type { ProjectFile } from '../shared/types';
import { readZipFromFile } from '../zip/zipReader';
import {
  fetchOverleafZipSnapshot,
  type OverleafZipSnapshot,
} from '../overleaf/overleafZipClient';
import type { SourceSnapshot } from './sourceTypes';

export async function sourceFromManualZip(file: File): Promise<SourceSnapshot> {
  const files: ProjectFile[] = await readZipFromFile(file);
  return {
    mode: 'manual-zip',
    displayName: file.name,
    files,
    warnings: [],
    metadata: {
      fileName: file.name,
      sizeBytes: file.size,
    },
  };
}

export function snapshotFromOverleafZip(
  zipSnapshot: OverleafZipSnapshot,
): SourceSnapshot {
  return {
    mode: 'overleaf-zip-route',
    projectId: zipSnapshot.projectId,
    displayName: `Overleaf project ${zipSnapshot.projectId}`,
    files: zipSnapshot.files,
    warnings: [],
    metadata: {
      fetchedFromUrl: zipSnapshot.fetchedFromUrl,
      zipSizeBytes: zipSnapshot.zipSizeBytes,
    },
  };
}

export async function sourceFromOverleafZipRoute(
  projectId: string,
): Promise<SourceSnapshot> {
  const snap = await fetchOverleafZipSnapshot(projectId);
  return snapshotFromOverleafZip(snap);
}
