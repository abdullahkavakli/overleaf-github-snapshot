import { unzipSync } from 'fflate';
import type { ProjectFile } from '../shared/types';
import {
  COMMON_BINARY_EXTENSIONS,
  MAX_FILES,
  MAX_FILE_SIZE_BYTES,
  MAX_PROJECT_SIZE_BYTES,
  TEXT_EXTENSIONS,
} from '../shared/constants';
import { computeSha256 } from '../diff/fileHasher';
import { normalizeZipPaths } from './normalizeZipPaths';

// 'empty': a valid archive with no files in it. 'over_limit': a valid
// archive beyond MAX_FILES / MAX_FILE_SIZE_BYTES / MAX_PROJECT_SIZE_BYTES.
// 'unreadable': anything else (not a ZIP, corrupt, undecodable).
export type ZipErrorKind = 'unreadable' | 'empty' | 'over_limit';

export class ZipError extends Error {
  constructor(
    message: string,
    readonly kind: ZipErrorKind = 'unreadable',
  ) {
    super(message);
    this.name = 'ZipError';
  }
}

// Synchronous decode is required under Chrome MV3's default CSP
// (script-src 'self'; object-src 'self';) — fflate's async unzip creates
// workers from blob: URLs, which the policy forbids. Sync decode runs on
// the renderer thread; project size is capped by MAX_PROJECT_SIZE_BYTES,
// so the freeze is bounded.
function decodeZipOrThrow(bytes: Uint8Array): Record<string, Uint8Array> {
  try {
    return unzipSync(bytes);
  } catch (e) {
    throw new ZipError(
      `This file couldn't be opened as a ZIP. Details: ${(e instanceof Error ? e.message : String(e)).replace(/\.$/, '')}.`,
    );
  }
}

function getExtension(path: string): string {
  const base = path.split('/').pop() ?? path;
  const idx = base.lastIndexOf('.');
  if (idx < 0) return '';
  return base.substring(idx).toLowerCase();
}

function looksBinary(bytes: Uint8Array): boolean {
  const len = Math.min(bytes.length, 8192);
  for (let i = 0; i < len; i++) {
    if (bytes[i] === 0) return true;
  }
  return false;
}

function detectBinary(path: string, bytes: Uint8Array): boolean {
  const ext = getExtension(path);
  if (TEXT_EXTENSIONS.has(ext)) return false;
  if (COMMON_BINARY_EXTENSIONS.has(ext)) return true;
  return looksBinary(bytes);
}

// ignoreBOM: a leading BOM stays in the text, matching the bytes (and the
// Overleaf doc), so commits and comparisons keep it.
function bytesToText(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false, ignoreBOM: true }).decode(bytes);
}

export async function readZipFromFile(file: File): Promise<ProjectFile[]> {
  if (!file) {
    throw new ZipError('No ZIP file provided.');
  }
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  return readZipFromBytes(bytes);
}

export async function readZipFromBytes(bytes: Uint8Array): Promise<ProjectFile[]> {
  if (bytes.length === 0) {
    throw new ZipError('This ZIP file is empty.');
  }

  const rawFiles = decodeZipOrThrow(bytes);
  if (Object.keys(rawFiles).length === 0) {
    throw new ZipError('This ZIP contains no files.', 'empty');
  }

  const normalized = normalizeZipPaths(rawFiles);
  if (normalized.size === 0) {
    // Only directory entries.
    throw new ZipError('This ZIP contains only folders, no files.', 'empty');
  }
  if (normalized.size > MAX_FILES) {
    throw new ZipError(
      `This project has ${normalized.size} files, more than the limit of ${MAX_FILES}.`,
      'over_limit',
    );
  }

  let totalSize = 0;
  const result: ProjectFile[] = [];

  for (const [path, content] of normalized) {
    if (content.byteLength > MAX_FILE_SIZE_BYTES) {
      throw new ZipError(
        `"${path}" is ${formatBytes(content.byteLength)}, more than the limit of ${formatBytes(
          MAX_FILE_SIZE_BYTES,
        )} per file.`,
        'over_limit',
      );
    }
    totalSize += content.byteLength;
    if (totalSize > MAX_PROJECT_SIZE_BYTES) {
      throw new ZipError(
        `This project is larger than the limit of ${formatBytes(MAX_PROJECT_SIZE_BYTES)} in total.`,
        'over_limit',
      );
    }

    const isBinary = detectBinary(path, content);
    let text: string | undefined;
    let encoding: 'utf-8' | 'base64' = 'utf-8';
    if (isBinary) {
      encoding = 'base64';
    } else {
      try {
        text = bytesToText(content);
      } catch (e) {
        throw new ZipError(`"${path}" couldn't be read as UTF-8 text.`);
      }
    }

    const sha256 = await computeSha256(content);

    result.push({
      path,
      content,
      text,
      encoding,
      sha256,
      sizeBytes: content.byteLength,
      isBinary,
    });
  }

  // Stable sort by path so previews are deterministic.
  result.sort((a, b) => a.path.localeCompare(b.path));
  return result;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
