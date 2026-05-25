// Shared orchestration helpers for the "pull from GitHub into Overleaf"
// flow. Both the popup panel and the Options dev panel call into here so
// the create-missing-files behaviour stays consistent between them.

import { createDocAtPathViaBridge } from '../overleaf/live/bridgeClient';

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
