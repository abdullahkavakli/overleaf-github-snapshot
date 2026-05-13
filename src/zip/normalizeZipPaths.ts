export class UnsafePathError extends Error {
  constructor(public path: string) {
    super(`Unsafe path in ZIP: ${path}`);
    this.name = 'UnsafePathError';
  }
}

function isUnsafe(p: string): boolean {
  if (p === '') return true;
  if (p.startsWith('/')) return true;
  if (/^[a-zA-Z]:[\\/]/.test(p)) return true; // Windows absolute
  const segs = p.split('/');
  if (segs.some((s) => s === '..')) return true;
  return false;
}

export function normalizeSinglePath(rawPath: string): string {
  let p = rawPath.replace(/\\/g, '/');
  // Collapse repeated slashes
  p = p.replace(/\/+/g, '/');
  // Strip leading "./"
  while (p.startsWith('./')) p = p.substring(2);
  if (isUnsafe(p)) {
    throw new UnsafePathError(rawPath);
  }
  return p;
}

export function findCommonTopLevelFolder(paths: string[]): string | null {
  if (paths.length === 0) return null;
  const firstSeg = paths[0].split('/')[0];
  // Need at least one slash in each path so there's something below the folder
  for (const p of paths) {
    const seg = p.split('/')[0];
    if (seg !== firstSeg) return null;
    if (!p.includes('/')) return null;
  }
  return firstSeg;
}

export function stripTopLevelFolder(paths: Map<string, Uint8Array>): Map<string, Uint8Array> {
  const keys = Array.from(paths.keys());
  const top = findCommonTopLevelFolder(keys);
  if (!top) return paths;
  const stripped = new Map<string, Uint8Array>();
  const prefix = top + '/';
  for (const [p, c] of paths) {
    stripped.set(p.substring(prefix.length), c);
  }
  return stripped;
}

export function normalizeZipPaths(rawFiles: Record<string, Uint8Array>): Map<string, Uint8Array> {
  const result = new Map<string, Uint8Array>();
  for (const [rawPath, content] of Object.entries(rawFiles)) {
    if (rawPath.endsWith('/')) continue; // directory entry
    const normalized = normalizeSinglePath(rawPath);
    if (normalized.endsWith('/')) continue;
    result.set(normalized, content);
  }
  return stripTopLevelFolder(result);
}
