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

export class ZipError extends Error {
  constructor(message: string) {
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
    throw new ZipError(`Failed to read ZIP: ${e instanceof Error ? e.message : String(e)}`);
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

function bytesToText(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
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
    throw new ZipError('ZIP file is empty.');
  }

  const rawFiles = decodeZipOrThrow(bytes);
  if (Object.keys(rawFiles).length === 0) {
    throw new ZipError('ZIP contains no files.');
  }

  const normalized = normalizeZipPaths(rawFiles);
  if (normalized.size === 0) {
    throw new ZipError('ZIP contains no usable files after normalization.');
  }
  if (normalized.size > MAX_FILES) {
    throw new ZipError(`ZIP contains too many files (${normalized.size} > ${MAX_FILES}).`);
  }

  let totalSize = 0;
  const result: ProjectFile[] = [];

  for (const [path, content] of normalized) {
    if (content.byteLength > MAX_FILE_SIZE_BYTES) {
      throw new ZipError(
        `File "${path}" is ${formatBytes(content.byteLength)} which exceeds the ${formatBytes(
          MAX_FILE_SIZE_BYTES,
        )} per-file limit.`,
      );
    }
    totalSize += content.byteLength;
    if (totalSize > MAX_PROJECT_SIZE_BYTES) {
      throw new ZipError(
        `Project exceeds the ${formatBytes(MAX_PROJECT_SIZE_BYTES)} total size limit.`,
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
        throw new ZipError(`Failed to read "${path}" as UTF-8 text.`);
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
