// Fetch a static (non-doc) file from Overleaf using the logged-in session.
//
// Static files in Overleaf projects (images, PDFs, .bib files added as
// uploads) are served via a per-file URL. We never read cookies — the
// browser attaches them through `credentials: 'include'`.

import { LiveSyncError } from './types';

export async function fetchProjectFileBytes(
  projectId: string,
  fileId: string,
): Promise<Uint8Array> {
  if (!/^[a-zA-Z0-9]+$/.test(projectId) || !/^[a-zA-Z0-9]+$/.test(fileId)) {
    throw new LiveSyncError('unknown', 'Invalid project or file identifier.');
  }
  const url = `https://www.overleaf.com/project/${encodeURIComponent(
    projectId,
  )}/file/${encodeURIComponent(fileId)}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      credentials: 'include',
      redirect: 'follow',
      cache: 'no-store',
    });
  } catch (e) {
    throw new LiveSyncError(
      'network',
      `Failed to fetch project file: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (response.status === 401) {
    throw new LiveSyncError('not_logged_in', 'You are not signed in to Overleaf.');
  }
  if (response.status === 403) {
    throw new LiveSyncError('forbidden', 'Access denied for this file.');
  }
  if (!response.ok) {
    throw new LiveSyncError(
      'protocol_unavailable',
      `Overleaf file endpoint returned HTTP ${response.status}.`,
    );
  }
  const buffer = await response.arrayBuffer();
  return new Uint8Array(buffer);
}
