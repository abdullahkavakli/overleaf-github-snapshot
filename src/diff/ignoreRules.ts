function escapeRegex(s: string): string {
  return s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}

function patternToRegex(pattern: string): RegExp {
  // Trim leading "./"
  let p = pattern.trim();
  if (p.startsWith('./')) p = p.substring(2);

  // Anchored if starts with "/"
  let anchored = false;
  if (p.startsWith('/')) {
    anchored = true;
    p = p.substring(1);
  }

  // Build regex: ** matches across path segments, * matches within a single segment.
  const segments = p.split('/').map((seg) => {
    if (seg === '**') return '.*';
    return seg
      .split('*')
      .map(escapeRegex)
      .join('[^/]*')
      .replace(/\?/g, '[^/]');
  });
  const body = segments.join('/');
  const prefix = anchored ? '^' : '(^|.*/)';
  return new RegExp(`${prefix}${body}$`);
}

export function isIgnored(path: string, patterns: string[]): boolean {
  for (const raw of patterns) {
    const pattern = raw.trim();
    if (!pattern || pattern.startsWith('#')) continue;
    const re = patternToRegex(pattern);
    if (re.test(path)) return true;
    // Also match the basename if pattern has no slash
    if (!pattern.includes('/')) {
      const basename = path.split('/').pop() ?? path;
      if (re.test(basename)) return true;
    }
  }
  return false;
}

export function filterIgnored<T extends { path: string }>(items: T[], patterns: string[]): T[] {
  return items.filter((item) => !isIgnored(item.path, patterns));
}
