// Local folder access wrapper around the File System Access API.
//
// Capability-detection lives here. If the API is unavailable, callers
// receive a typed unavailability state — we never silently fall back to a
// no-op or fake folder.

import type { ProjectFile } from '../shared/types';
import { computeSha256 } from '../diff/fileHasher';
import {
  COMMON_BINARY_EXTENSIONS,
  TEXT_EXTENSIONS,
} from '../shared/constants';
import type { LocalReplicaCapabilities } from './localReplicaTypes';

declare global {
  interface Window {
    showDirectoryPicker?: (options?: {
      mode?: 'read' | 'readwrite';
    }) => Promise<FileSystemDirectoryHandle>;
  }
}

export function getLocalReplicaCapabilities(): LocalReplicaCapabilities {
  const supported =
    typeof window !== 'undefined' &&
    typeof window.showDirectoryPicker === 'function';
  return { fileSystemAccessApi: !!supported };
}

export async function pickLocalFolder(): Promise<FileSystemDirectoryHandle> {
  if (typeof window === 'undefined' || typeof window.showDirectoryPicker !== 'function') {
    throw new Error('local_replica_unavailable: File System Access API is not supported in this browser.');
  }
  // Ask for readwrite up front; user can downgrade in their permission
  // dialog. The write permission is needed for pull-to-disk; comparison
  // alone works with read access.
  return window.showDirectoryPicker({ mode: 'readwrite' });
}

function getExtension(path: string): string {
  const base = path.split('/').pop() ?? path;
  const idx = base.lastIndexOf('.');
  if (idx < 0) return '';
  return base.substring(idx).toLowerCase();
}

function looksBinary(bytes: Uint8Array): boolean {
  const len = Math.min(bytes.length, 8192);
  for (let i = 0; i < len; i++) if (bytes[i] === 0) return true;
  return false;
}

function detectBinary(path: string, bytes: Uint8Array): boolean {
  const ext = getExtension(path);
  if (TEXT_EXTENSIONS.has(ext)) return false;
  if (COMMON_BINARY_EXTENSIONS.has(ext)) return true;
  return looksBinary(bytes);
}

// Read every file under a directory handle into the same ProjectFile shape
// the ZIP path produces. Cap at 5000 files / 200MB just like the ZIP reader.
const MAX_LOCAL_FILES = 5000;
const MAX_LOCAL_TOTAL_BYTES = 200 * 1024 * 1024;

export async function readLocalFolderAsProjectFiles(
  root: FileSystemDirectoryHandle,
  ignoreNames: string[] = ['.git', 'node_modules', '.DS_Store'],
): Promise<ProjectFile[]> {
  const ignoreSet = new Set(ignoreNames);
  const files: ProjectFile[] = [];
  let totalBytes = 0;

  async function walk(dir: FileSystemDirectoryHandle, prefix: string): Promise<void> {
    // entries() is async-iterable on FileSystemDirectoryHandle.
    // @ts-expect-error -- TS types for entries() vary across lib targets.
    for await (const [name, handle] of dir.entries()) {
      if (ignoreSet.has(name)) continue;
      const path = prefix ? `${prefix}/${name}` : name;
      if ((handle as { kind: string }).kind === 'directory') {
        await walk(handle as FileSystemDirectoryHandle, path);
        continue;
      }
      if ((handle as { kind: string }).kind !== 'file') continue;
      const file = await (handle as FileSystemFileHandle).getFile();
      const buf = await file.arrayBuffer();
      const bytes = new Uint8Array(buf);
      totalBytes += bytes.byteLength;
      if (files.length + 1 > MAX_LOCAL_FILES) {
        throw new Error(`local_replica_too_many_files: > ${MAX_LOCAL_FILES}`);
      }
      if (totalBytes > MAX_LOCAL_TOTAL_BYTES) {
        throw new Error('local_replica_too_large');
      }
      const isBinary = detectBinary(path, bytes);
      const sha256 = await computeSha256(bytes);
      if (isBinary) {
        files.push({
          path,
          content: bytes,
          encoding: 'base64',
          sha256,
          sizeBytes: bytes.byteLength,
          isBinary: true,
        });
      } else {
        const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
        files.push({
          path,
          content: bytes,
          text,
          encoding: 'utf-8',
          sha256,
          sizeBytes: bytes.byteLength,
          isBinary: false,
        });
      }
    }
  }

  await walk(root, '');
  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}

// Write the given files to the directory handle. Caller is responsible for
// asking the user to confirm. We never delete files we don't recognize.
export async function writeProjectFilesToFolder(
  root: FileSystemDirectoryHandle,
  files: ProjectFile[],
): Promise<void> {
  for (const file of files) {
    const parts = file.path.split('/').filter((p) => p.length > 0);
    if (parts.length === 0) continue;
    let dir: FileSystemDirectoryHandle = root;
    for (let i = 0; i < parts.length - 1; i++) {
      dir = await dir.getDirectoryHandle(parts[i], { create: true });
    }
    const fileName = parts[parts.length - 1];
    const fh = await dir.getFileHandle(fileName, { create: true });
    const writable = await fh.createWritable();
    try {
      // Pass the underlying Uint8Array directly; FileSystemWritableFileStream
      // accepts BufferSource.
      await writable.write(file.content as unknown as BufferSource);
    } finally {
      await writable.close();
    }
  }
}
