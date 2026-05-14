import type { ProjectFile } from '../shared/types';

export type SourceMode =
  | 'manual-zip'
  | 'overleaf-zip-route'
  | 'overleaf-live-readonly'
  | 'local-replica';

export type SourceSnapshot = {
  mode: SourceMode;
  projectId?: string;
  displayName: string;
  files: ProjectFile[];
  warnings: string[];
  metadata: Record<string, unknown>;
};

export function describeSourceMode(mode: SourceMode): string {
  switch (mode) {
    case 'manual-zip':
      return 'Manual ZIP upload';
    case 'overleaf-zip-route':
      return 'Automatic Overleaf ZIP snapshot';
    case 'overleaf-live-readonly':
      return 'Experimental live read-only';
    case 'local-replica':
      return 'Local replica prototype';
    default:
      return mode;
  }
}
