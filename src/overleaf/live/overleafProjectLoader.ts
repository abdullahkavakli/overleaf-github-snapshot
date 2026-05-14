// Discover Overleaf project metadata using the logged-in browser session.
//
// Strategy (in order of preference):
//
//   1. GET /project/<id>/entities  — JSON listing of every doc + fileRef in
//      the project. This is the most stable surface and is what Overleaf
//      Workshop (AGPL-3.0) uses. It returns a flat list rather than the
//      nested folder tree, so we adopt that shape directly. CSRF is required.
//
//   2. Fall back to scraping <meta name="ol-csrfToken"> / <meta name="ol-project">
//      out of the project page HTML — works on older Overleaf builds where
//      the entities route isn't exposed or returns 404.
//
// Auth model: we rely on the browser's existing Overleaf session via
// `credentials: 'include'`. This file never reads document.cookie and never
// requests chrome.cookies. CSRF tokens come from the project-page HTML.
//
// This module is part of the AGPL-3.0 live-sync layer; its design is
// derived from Overleaf Workshop's project entities flow.

import { LiveSyncError, type LiveProjectFolder, type LiveProjectMetadata } from './types';

// ──────────────────────────────────────────────────────────────────────────
// CSRF + project-page bootstrap
// ──────────────────────────────────────────────────────────────────────────

function parseMetaJsonContent(html: string, name: string): unknown | null {
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

export type ProjectBootstrap = {
  projectId: string;
  csrfToken: string;
  // Populated when the project-page HTML still embeds the bootstrap blob.
  // May be null on newer Overleaf builds — in that case we use the entities
  // REST endpoint instead.
  projectMeta: Record<string, unknown> | null;
};

export async function fetchProjectBootstrap(
  projectId: string,
): Promise<ProjectBootstrap> {
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

  const idMeta = parseMetaJsonContent(html, 'ol-project_id') as string | null;
  if (idMeta && typeof idMeta === 'string' && idMeta !== projectId) {
    throw new LiveSyncError(
      'protocol_unavailable',
      `Overleaf project page reported a different ID (${idMeta}).`,
    );
  }

  const csrfToken = parseMetaJsonContent(html, 'ol-csrfToken') as string | null;
  if (!csrfToken || typeof csrfToken !== 'string') {
    throw new LiveSyncError(
      'protocol_unavailable',
      'CSRF token not found on Overleaf project page (no <meta name="ol-csrfToken">). Project page layout may have changed.',
    );
  }

  const projectMeta = parseMetaJsonContent(html, 'ol-project') as
    | Record<string, unknown>
    | null;

  return { projectId, csrfToken, projectMeta };
}

// ──────────────────────────────────────────────────────────────────────────
// REST: /project/<id>/entities — flat list of every doc + file in project
// ──────────────────────────────────────────────────────────────────────────

export type ProjectEntity = {
  path: string;
  type: 'doc' | 'file';
};

export type ProjectEntitiesResponse = {
  projectId: string;
  entities: ProjectEntity[];
};

// Overleaf's /project/:id/entities returns a JSON object shaped roughly:
//   { project_id: "...", entities: [ { path: "/main.tex", type: "doc" }, ... ] }
// We normalise here so the rest of the code doesn't care about the exact
// field names.
export async function fetchProjectEntities(
  bootstrap: ProjectBootstrap,
): Promise<ProjectEntitiesResponse> {
  const url = `https://www.overleaf.com/project/${encodeURIComponent(bootstrap.projectId)}/entities`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      credentials: 'include',
      redirect: 'follow',
      cache: 'no-store',
      headers: {
        Accept: 'application/json',
        'X-Csrf-Token': bootstrap.csrfToken,
      },
    });
  } catch (e) {
    throw new LiveSyncError(
      'network',
      `Failed to load project entities: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (response.status === 401) {
    throw new LiveSyncError('not_logged_in', 'You are not signed in to Overleaf.');
  }
  if (response.status === 403) {
    throw new LiveSyncError('forbidden', 'Overleaf refused access to project entities.');
  }
  if (response.status === 404) {
    throw new LiveSyncError(
      'protocol_unavailable',
      'Overleaf /entities endpoint not found on this build — falling back to project-page metadata.',
    );
  }
  if (!response.ok) {
    throw new LiveSyncError(
      'protocol_unavailable',
      `Project entities request returned HTTP ${response.status}.`,
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (e) {
    throw new LiveSyncError(
      'protocol_unavailable',
      `Project entities response was not JSON: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  const rawEntities = (body as { entities?: unknown })?.entities;
  if (!Array.isArray(rawEntities)) {
    throw new LiveSyncError(
      'protocol_unavailable',
      'Project entities response shape was unexpected (missing "entities" array).',
    );
  }

  const entities: ProjectEntity[] = [];
  for (const raw of rawEntities) {
    if (!raw || typeof raw !== 'object') continue;
    const o = raw as { path?: unknown; type?: unknown };
    if (typeof o.path !== 'string' || typeof o.type !== 'string') continue;
    if (o.type !== 'doc' && o.type !== 'file') continue;
    // Strip the leading "/" Overleaf uses so paths match the ZIP path
    // shape downstream (project-relative, no leading slash).
    const cleanPath = o.path.replace(/^\/+/, '');
    if (!cleanPath) continue;
    entities.push({ path: cleanPath, type: o.type });
  }

  if (entities.length === 0) {
    throw new LiveSyncError(
      'project_join_failed',
      'Project entities response contained no usable doc/file entries.',
    );
  }

  return { projectId: bootstrap.projectId, entities };
}

// ──────────────────────────────────────────────────────────────────────────
// Bootstrap-tree fallback (older Overleaf builds)
// ──────────────────────────────────────────────────────────────────────────

export async function fetchProjectMetadata(
  projectId: string,
): Promise<LiveProjectMetadata> {
  const bootstrap = await fetchProjectBootstrap(projectId);
  const project = bootstrap.projectMeta;
  const rootFolderRaw =
    project && Array.isArray((project as { rootFolder?: unknown }).rootFolder)
      ? ((project as { rootFolder?: unknown }).rootFolder as LiveProjectFolder[])
      : null;
  const rootDoc_id =
    project && typeof (project as { rootDoc_id?: unknown }).rootDoc_id === 'string'
      ? ((project as { rootDoc_id?: string }).rootDoc_id as string)
      : null;
  const name =
    project && typeof (project as { name?: unknown }).name === 'string'
      ? ((project as { name?: string }).name as string)
      : null;

  if (!rootFolderRaw) {
    throw new LiveSyncError(
      'protocol_unavailable',
      'Project bootstrap blob not found on the project page. Use the entities REST endpoint instead.',
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
  // For docs from /entities, id is unknown until joinProject runs; we
  // populate it lazily once the realtime channel returns the project tree.
  id: string | null;
  path: string;
  kind: 'doc' | 'file';
};

export function flattenProjectTree(
  rootFolder: LiveProjectFolder[] | undefined,
): FlatProjectEntry[] {
  const out: FlatProjectEntry[] = [];
  if (!rootFolder || rootFolder.length === 0) return out;
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
  const here2 = folder.name === 'rootFolder' || !folder.name ? prefix : here;

  for (const doc of folder.docs ?? []) {
    out.push({ id: doc._id, path: here2 ? `${here2}/${doc.name}` : doc.name, kind: 'doc' });
  }
  for (const file of folder.fileRefs ?? []) {
    out.push({ id: file._id, path: here2 ? `${here2}/${file.name}` : file.name, kind: 'file' });
  }
  for (const sub of folder.folders ?? []) {
    walkFolder(sub, here2, out);
  }
}

export function entitiesToFlatTree(entities: ProjectEntity[]): FlatProjectEntry[] {
  return entities.map((e) => ({ id: null, path: e.path, kind: e.type }));
}
