// Shared orchestration helpers for the "pull from GitHub into Overleaf"
// flow. Both the popup panel and the Options dev panel call into here so
// the create-missing-files behaviour stays consistent between them.

import {
  createDocAtPathViaBridge,
  uploadBinaryViaBridge,
} from '../overleaf/live/bridgeClient';
import { uint8ToBase64 } from '../overleaf/live/bridgeProtocol';
import type { ProjectFile } from '../shared/types';

export type CreateResult = {
  path: string;
  // 'created'  -> doc exists on Overleaf with the expected content
  // 'failed'   -> creation attempted and the bridge returned an error
  // 'skipped'  -> filtered out before any Overleaf call (e.g. extension
  //               not in the user's writeBack whitelist)
  status: 'created' | 'failed' | 'skipped';
  message?: string;
};

function getExtension(path: string): string {
  const base = path.split('/').pop() ?? path;
  const idx = base.lastIndexOf('.');
  if (idx < 0) return '';
  return base.substring(idx).toLowerCase();
}

// Iterates the to-create list, filters by allowedExtensions (mirroring
// the write-back path's filter so pulls are symmetric), and calls
// createDocAtPathViaBridge for each one. Each per-file result is
// independent — a failure on file N does NOT abort the rest.
export async function createMissingDocsForPull(
  projectId: string,
  toCreate: Array<{ path: string; content: string }>,
  allowedExtensions: string[],
  onProgress: (msg: string) => void,
): Promise<CreateResult[]> {
  const allowed = new Set(allowedExtensions);
  const results: CreateResult[] = [];

  for (let i = 0; i < toCreate.length; i++) {
    const candidate = toCreate[i]!;
    const ext = getExtension(candidate.path);
    if (!allowed.has(ext)) {
      results.push({
        path: candidate.path,
        status: 'skipped',
        message: `Extension ${ext || '(none)'} not in allowed write-back list.`,
      });
      continue;
    }

    onProgress(`Creating ${i + 1}/${toCreate.length}: ${candidate.path}`);
    try {
      const response = await createDocAtPathViaBridge(
        projectId,
        candidate.path,
        candidate.content,
      );
      if (response.ok) {
        results.push({
          path: candidate.path,
          status: 'created',
          message: `v${response.data.version} (${response.data.text.length} bytes)`,
        });
      } else {
        results.push({
          path: candidate.path,
          status: 'failed',
          message: response.message,
        });
      }
    } catch (e) {
      results.push({
        path: candidate.path,
        status: 'failed',
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return results;
}

export type BinaryResult = {
  path: string;
  // 'uploaded'  -> file present in Overleaf with the expected bytes
  // 'failed'    -> upload attempted and the bridge returned an error
  // 'skipped'   -> not uploaded for a structural reason (already exists,
  //                or "Also create" was off)
  status: 'uploaded' | 'failed' | 'skipped';
  message?: string;
};

// Iterates the binary files pulled from GitHub and decides per-file:
//   - already in Overleaf as a fileRef -> skip (replace-on-upload is a
//                                          separate slice not in this build)
//   - not in Overleaf and createMissing=false -> skip with hint
//   - not in Overleaf and createMissing=true  -> uploadBinaryViaBridge
//
// Per-file failures don't abort the loop; each one becomes its own
// BinaryResult row that the UI surfaces.
export async function uploadBinariesForPull(
  projectId: string,
  binaryFiles: ProjectFile[],
  existingFilePaths: Set<string>,
  createMissing: boolean,
  onProgress: (msg: string) => void,
): Promise<BinaryResult[]> {
  const results: BinaryResult[] = [];

  for (let i = 0; i < binaryFiles.length; i++) {
    const file = binaryFiles[i]!;

    if (existingFilePaths.has(file.path)) {
      results.push({
        path: file.path,
        status: 'skipped',
        message: 'File already exists in Overleaf — replace-on-upload is not implemented in this build.',
      });
      continue;
    }
    if (!createMissing) {
      results.push({
        path: file.path,
        status: 'skipped',
        message: 'Not in Overleaf; enable "Also create new files" to upload.',
      });
      continue;
    }

    onProgress(`Uploading binary ${i + 1}/${binaryFiles.length}: ${file.path}`);
    try {
      const contentBase64 = uint8ToBase64(file.content);
      const response = await uploadBinaryViaBridge(projectId, file.path, contentBase64);
      if (response.ok) {
        results.push({
          path: file.path,
          status: 'uploaded',
          message: `${response.data.sizeBytes} bytes`,
        });
      } else {
        results.push({
          path: file.path,
          status: 'failed',
          message: response.message,
        });
      }
    } catch (e) {
      results.push({
        path: file.path,
        status: 'failed',
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return results;
}
