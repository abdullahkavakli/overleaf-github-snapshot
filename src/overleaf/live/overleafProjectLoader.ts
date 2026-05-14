// Discover Overleaf project metadata using the logged-in browser session.
//
// Implementation note: Overleaf's open-source server and the (AGPL) Overleaf
// Workshop extension demonstrate that the project page bootstraps with a
// `<meta name="ol-project_id">` tag and several `<meta name="ol-*">` blobs
// that contain enough information to identify the project, the root folder
// tree, and the root document. We avoid copying any AGPL source by
// reimplementing only this minimal discovery — and we keep all parsing in
// the browser context. We never touch cookies.

import { LiveSyncError, type LiveProjectFolder, type LiveProjectMetadata } from './types';

function parseMetaJsonContent(html: string, name: string): unknown | null {
  // Quote-aware regex for <meta name="..." content="...">
  const re = new RegExp(
    `<meta[^>]+name=["']${name.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}["'][^>]+content=["']([^"']*)["']`,
    'i',
  );
  const match = html.match(re);
  if (!match) return null;
  const decoded = decodeHtmlEntities(match[1]);
  try {
    return JSON.parse(decoded);
  } catch {
    return decoded;
  }
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

export async function fetchProjectMetadata(
  projectId: string,
): Promise<LiveProjectMetadata> {
  if (!/^[a-zA-Z0-9]+$/.test(projectId)) {
    throw new LiveSyncError('unknown', `Invalid Overleaf project ID: ${projectId}`);
  }

  const url = `https://www.overleaf.com/project/${encodeURIComponent(projectId)}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      credentials: 'include',
      redirect: 'follow',
      cache: 'no-store',
      headers: { Accept: 'text/html' },
    });
  } catch (e) {
    throw new LiveSyncError(
      'network',
      `Failed to load Overleaf project page: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  const finalUrl = response.url || url;
  if (response.status === 401 || finalUrl.includes('/login')) {
    throw new LiveSyncError('not_logged_in', 'You are not signed in to Overleaf.');
  }
  if (response.status === 403) {
    throw new LiveSyncError('forbidden', 'Overleaf refused access to this project.');
  }
  if (!response.ok) {
    throw new LiveSyncError(
      'protocol_unavailable',
      `Overleaf project page returned HTTP ${response.status}.`,
    );
  }

  let html: string;
  try {
    html = await response.text();
  } catch (e) {
    throw new LiveSyncError(
      'network',
      `Failed to read Overleaf project page body: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  // Required: project ID. Stop short if we cannot even confirm we're on a
  // project page.
  const idMeta = parseMetaJsonContent(html, 'ol-project_id') as string | null;
  if (idMeta && typeof idMeta === 'string' && idMeta !== projectId) {
    throw new LiveSyncError(
      'protocol_unavailable',
      `Overleaf project page reported a different ID (${idMeta}).`,
    );
  }

  const project = parseMetaJsonContent(html, 'ol-project') as Record<string, unknown> | null;
  const rootFolderRaw =
    (project && Array.isArray((project as { rootFolder?: unknown }).rootFolder)
      ? ((project as { rootFolder?: unknown }).rootFolder as LiveProjectFolder[])
      : null) ?? (parseMetaJsonContent(html, 'ol-rootFolder') as LiveProjectFolder[] | null);
  const rootDoc_id =
    (project && typeof (project as { rootDoc_id?: unknown }).rootDoc_id === 'string'
      ? ((project as { rootDoc_id?: string }).rootDoc_id as string)
      : null) ?? (parseMetaJsonContent(html, 'ol-rootDoc_id') as string | null);
  const name =
    (project && typeof (project as { name?: unknown }).name === 'string'
      ? ((project as { name?: string }).name as string)
      : null) ?? (parseMetaJsonContent(html, 'ol-projectName') as string | null);

  if (!rootFolderRaw) {
    // No meta blob we recognize. Bail with a clear protocol-unavailable
    // error so the caller falls back to ZIP.
    throw new LiveSyncError(
      'protocol_unavailable',
      'Overleaf project metadata could not be detected from the project page. The HTML layout may have changed.',
    );
  }

  return {
    projectId,
    rootFolder: rootFolderRaw,
    rootDoc_id: rootDoc_id ?? undefined,
    name: name ?? undefined,
  };
}

export type FlatProjectEntry = {
  id: string;
  path: string;
  kind: 'doc' | 'file';
};

export function flattenProjectTree(
  rootFolder: LiveProjectFolder[] | undefined,
): FlatProjectEntry[] {
  const out: FlatProjectEntry[] = [];
  if (!rootFolder || rootFolder.length === 0) return out;
  // Top-level folder is the (unnamed) root in Overleaf; descend into it.
  for (const folder of rootFolder) {
    walkFolder(folder, '', out);
  }
  return out;
}

function walkFolder(
  folder: LiveProjectFolder,
  prefix: string,
  out: FlatProjectEntry[],
): void {
  const here = folder.name && folder.name.length > 0 && prefix !== ''
    ? `${prefix}/${folder.name}`
    : folder.name && folder.name.length > 0
      ? folder.name
      : prefix;
  // The synthetic root folder Overleaf returns has name "rootFolder" and
  // empty name in some payloads; treat both as empty path.
  const here2 =
    folder.name === 'rootFolder' || !folder.name ? prefix : here;

  for (const doc of folder.docs ?? []) {
    out.push({
      id: doc._id,
      path: here2 ? `${here2}/${doc.name}` : doc.name,
      kind: 'doc',
    });
  }
  for (const file of folder.fileRefs ?? []) {
    out.push({
      id: file._id,
      path: here2 ? `${here2}/${file.name}` : file.name,
      kind: 'file',
    });
  }
  for (const sub of folder.folders ?? []) {
    walkFolder(sub, here2, out);
  }
}
