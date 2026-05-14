// Automatic Overleaf source ZIP fetcher.
//
// Uses the user's existing logged-in browser session via `credentials: 'include'`.
// We never read, store, display, or log Overleaf cookies. The browser attaches
// them transparently to the fetch — the extension itself never sees them.

import { unzipSync } from 'fflate';
import type { ProjectFile } from '../shared/types';
import { readZipFromBytes } from '../zip/zipReader';

export type OverleafZipSnapshot = {
  projectId: string;
  files: ProjectFile[];
  source: 'overleaf-zip-route';
  fetchedFromUrl: string;
  zipSizeBytes: number;
};

export type OverleafZipFetchErrorCode =
  | 'not_logged_in'
  | 'forbidden'
  | 'not_found'
  | 'endpoint_changed'
  | 'not_zip'
  | 'network'
  | 'zip_parse_failed'
  | 'unknown';

export class OverleafZipFetchError extends Error {
  code: OverleafZipFetchErrorCode;
  status?: number;
  url?: string;

  constructor(
    code: OverleafZipFetchErrorCode,
    message: string,
    init: { status?: number; url?: string } = {},
  ) {
    super(message);
    this.name = 'OverleafZipFetchError';
    this.code = code;
    this.status = init.status;
    this.url = init.url;
  }
}

function candidateUrls(projectId: string): string[] {
  return [
    `https://www.overleaf.com/project/${encodeURIComponent(projectId)}/download/zip`,
    `https://www.overleaf.com/project/download/zip?project_ids=${encodeURIComponent(projectId)}`,
  ];
}

function looksLikeZip(bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false;
  const b0 = bytes[0];
  const b1 = bytes[1];
  const b2 = bytes[2];
  const b3 = bytes[3];
  // Standard local file header
  if (b0 === 0x50 && b1 === 0x4b && b2 === 0x03 && b3 === 0x04) return true;
  // Empty archive
  if (b0 === 0x50 && b1 === 0x4b && b2 === 0x05 && b3 === 0x06) return true;
  // Spanned archive
  if (b0 === 0x50 && b1 === 0x4b && b2 === 0x07 && b3 === 0x08) return true;
  return false;
}

function looksLikeHtml(bytes: Uint8Array): boolean {
  // Probe the first 1KB for an html tag or DOCTYPE.
  const n = Math.min(bytes.length, 1024);
  let probe = '';
  for (let i = 0; i < n; i++) probe += String.fromCharCode(bytes[i]);
  const lower = probe.toLowerCase().trimStart();
  return (
    lower.startsWith('<!doctype html') ||
    lower.startsWith('<html') ||
    lower.startsWith('<!--')
  );
}

function isLoginUrl(responseUrl: string): boolean {
  try {
    const u = new URL(responseUrl);
    return u.pathname === '/login' || u.pathname.startsWith('/login/');
  } catch {
    return responseUrl.includes('/login');
  }
}

// Some Overleaf endpoints have historically returned a ZIP that contains a
// single nested .zip when the user requests "download as zip" from a folder
// view rather than the project root. Unwrap one level if no other meaningful
// project files exist in the outer archive.
export async function maybeUnwrapSingleNestedZip(
  bytes: Uint8Array,
): Promise<Uint8Array> {
  if (!looksLikeZip(bytes)) return bytes;
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch {
    return bytes;
  }
  const keys = Object.keys(entries).filter((k) => !k.endsWith('/'));
  if (keys.length === 0) return bytes;
  const nestedZips = keys.filter((k) => k.toLowerCase().endsWith('.zip'));
  if (nestedZips.length !== 1) return bytes;

  const onlyZip = nestedZips[0];
  const others = keys.filter((k) => k !== onlyZip);
  // If there are meaningful (non-junk) files alongside, keep the outer archive.
  const meaningful = others.filter((k) => {
    const base = k.split('/').pop() ?? k;
    if (base.startsWith('.')) return false;
    if (base === 'Thumbs.db') return false;
    return true;
  });
  if (meaningful.length > 0) return bytes;
  return entries[onlyZip];
}

type RawAttempt = {
  url: string;
  bytes: Uint8Array;
};

async function attemptFetch(url: string): Promise<RawAttempt> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      credentials: 'include',
      redirect: 'follow',
      cache: 'no-store',
      headers: {
        Accept: 'application/zip, application/octet-stream, */*',
      },
    });
  } catch (e) {
    throw new OverleafZipFetchError(
      'network',
      `Network error fetching Overleaf ZIP: ${e instanceof Error ? e.message : String(e)}`,
      { url },
    );
  }

  const finalUrl = response.url || url;

  if (response.status === 401 || isLoginUrl(finalUrl)) {
    throw new OverleafZipFetchError(
      'not_logged_in',
      'You appear to be signed out of Overleaf. Sign in and try again.',
      { status: response.status, url: finalUrl },
    );
  }
  if (response.status === 403) {
    throw new OverleafZipFetchError(
      'forbidden',
      'Overleaf refused the ZIP download (HTTP 403). You may not have access to this project.',
      { status: response.status, url: finalUrl },
    );
  }
  if (response.status === 404) {
    throw new OverleafZipFetchError(
      'not_found',
      'Overleaf ZIP endpoint returned 404 for this project.',
      { status: response.status, url: finalUrl },
    );
  }
  if (!response.ok) {
    throw new OverleafZipFetchError(
      'unknown',
      `Overleaf ZIP request failed: HTTP ${response.status}.`,
      { status: response.status, url: finalUrl },
    );
  }

  const contentType = (response.headers.get('content-type') || '').toLowerCase();
  let buffer: ArrayBuffer;
  try {
    buffer = await response.arrayBuffer();
  } catch (e) {
    throw new OverleafZipFetchError(
      'network',
      `Failed to read Overleaf ZIP body: ${e instanceof Error ? e.message : String(e)}`,
      { status: response.status, url: finalUrl },
    );
  }
  const bytes = new Uint8Array(buffer);

  if (bytes.length === 0) {
    throw new OverleafZipFetchError(
      'endpoint_changed',
      'Overleaf returned an empty response where a ZIP was expected.',
      { status: response.status, url: finalUrl },
    );
  }

  if (contentType.includes('text/html') || looksLikeHtml(bytes)) {
    // HTML means we hit the login/SPA shell instead of the ZIP route.
    if (isLoginUrl(finalUrl)) {
      throw new OverleafZipFetchError(
        'not_logged_in',
        'Overleaf returned its login page instead of a ZIP. Sign in and try again.',
        { status: response.status, url: finalUrl },
      );
    }
    throw new OverleafZipFetchError(
      'endpoint_changed',
      'Overleaf returned HTML where a ZIP was expected — the export endpoint may have changed.',
      { status: response.status, url: finalUrl },
    );
  }

  if (!looksLikeZip(bytes)) {
    throw new OverleafZipFetchError(
      'not_zip',
      'Overleaf response did not contain a valid ZIP signature.',
      { status: response.status, url: finalUrl },
    );
  }

  return { url: finalUrl, bytes };
}

export async function fetchOverleafZipSnapshot(
  projectId: string,
): Promise<OverleafZipSnapshot> {
  if (!projectId || !/^[a-zA-Z0-9]+$/.test(projectId)) {
    throw new OverleafZipFetchError(
      'unknown',
      'Invalid Overleaf project ID.',
    );
  }

  const urls = candidateUrls(projectId);
  let lastError: OverleafZipFetchError | null = null;
  let attempt: RawAttempt | null = null;

  for (const url of urls) {
    try {
      attempt = await attemptFetch(url);
      break;
    } catch (e) {
      if (e instanceof OverleafZipFetchError) {
        lastError = e;
        // Try next URL only for not_found; other failures propagate immediately.
        if (e.code === 'not_found') continue;
        throw e;
      }
      throw new OverleafZipFetchError(
        'unknown',
        e instanceof Error ? e.message : String(e),
        { url },
      );
    }
  }

  if (!attempt) {
    throw (
      lastError ??
      new OverleafZipFetchError(
        'not_found',
        'No Overleaf ZIP endpoint returned a usable response.',
      )
    );
  }

  const unwrapped = await maybeUnwrapSingleNestedZip(attempt.bytes);

  let files: ProjectFile[];
  try {
    files = await readZipFromBytes(unwrapped);
  } catch (e) {
    throw new OverleafZipFetchError(
      'zip_parse_failed',
      `Failed to parse Overleaf ZIP: ${e instanceof Error ? e.message : String(e)}`,
      { url: attempt.url },
    );
  }

  return {
    projectId,
    files,
    source: 'overleaf-zip-route',
    fetchedFromUrl: attempt.url,
    zipSizeBytes: unwrapped.byteLength,
  };
}

export function formatOverleafZipFetchError(error: unknown): string {
  if (error instanceof OverleafZipFetchError) {
    switch (error.code) {
      case 'not_logged_in':
        return 'You are not signed in to Overleaf in this browser. Open Overleaf, sign in, then try again.';
      case 'forbidden':
        return 'Overleaf refused the ZIP download — your account may not have access to this project.';
      case 'not_found':
        return 'Overleaf could not find this project to export.';
      case 'endpoint_changed':
        return 'Overleaf returned an unexpected response — the export endpoint may have changed.';
      case 'not_zip':
        return 'Overleaf returned something that does not look like a ZIP.';
      case 'network':
        return `Network error contacting Overleaf: ${error.message}`;
      case 'zip_parse_failed':
        return `The Overleaf ZIP could not be parsed: ${error.message}`;
      default:
        return error.message;
    }
  }
  if (error instanceof Error) return error.message;
  return String(error);
}
