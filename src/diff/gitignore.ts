// Matcher for the repository's own .gitignore files, used by "Make Overleaf
// match GitHub exactly" to keep Overleaf files that GitHub deliberately
// doesn't hold (for example a figure PDF listed under `*.pdf`).
//
// It covers the common syntax of gitignore(5): `*`, `?`, `[a-z]`, `**`
// (leading `**/`, middle `/**/`, trailing `/**`), a trailing `/` (folders
// only), a leading `/` or a middle `/` (anchored to the .gitignore's own
// folder) and `\` escapes. Patterns are relative to the folder that holds
// their .gitignore, and a path is ignored when it or any folder above it
// matches.
//
// Negations (`!pattern`) are skipped on purpose. Honouring them would keep
// fewer files, and the caller only uses this to decide what to KEEP, so
// ignoring a negation can only keep more. Paths and patterns are compared
// in Unicode NFC.

export type GitignoreRule = {
  regex: RegExp;
  // Matches only folders (the pattern ended with `/`).
  dirOnly: boolean;
  // Matched against the whole path below the .gitignore's folder; otherwise
  // against the last segment of the path (a bare name matches at any depth).
  anchored: boolean;
};

// One .gitignore: `dir` is the repository folder that holds it ('' for the
// repository root, otherwise a path without a leading or trailing slash).
export type GitignoreFile = { dir: string; rules: GitignoreRule[] };

const nfc = (s: string): string => s.normalize('NFC');

function escapeRegexChar(ch: string): string {
  return /[\\^$.*+?()[\]{}|/-]/.test(ch) ? `\\${ch}` : ch;
}

// One path segment of a pattern as a regex source: `*` and `?` stay inside a
// segment, `[...]` is a character class, `\x` is a literal x.
function segmentToRegexSource(segment: string): string {
  let out = '';
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i]!;
    if (ch === '\\') {
      i++;
      if (i < segment.length) out += escapeRegexChar(segment[i]!);
      continue;
    }
    if (ch === '*') {
      // Several stars in a row (not a whole `**` segment) act as one.
      while (segment[i + 1] === '*') i++;
      out += '[^/]*';
      continue;
    }
    if (ch === '?') {
      out += '[^/]';
      continue;
    }
    if (ch === '[') {
      const close = findClassEnd(segment, i);
      if (close > 0) {
        let body = segment.slice(i + 1, close);
        if (body.includes('[:')) {
          // POSIX classes such as [[:digit:]] aren't translated. Matching
          // any one character instead ignores at least what git ignores,
          // so a mirror pull keeps more files, never fewer.
          out += '[^/]';
          i = close;
          continue;
        }
        let negate = false;
        if (body.startsWith('!') || body.startsWith('^')) {
          negate = true;
          body = body.slice(1);
        }
        const inner = body.replace(/\\/g, '\\\\').replace(/\]/g, '\\]').replace(/\^/g, '\\^');
        out += `[${negate ? '^' : ''}${inner}]`;
        i = close;
        continue;
      }
    }
    out += escapeRegexChar(ch);
  }
  return out;
}

// Index of the `]` that closes a class opened at `start`, or -1 when there
// is none (the `[` is then an ordinary character). A `]` right after the
// opening (or after `!` / `^`) is part of the class.
function findClassEnd(segment: string, start: number): number {
  let i = start + 1;
  if (segment[i] === '!' || segment[i] === '^') i++;
  if (segment[i] === ']') i++;
  for (; i < segment.length; i++) {
    // Skip a POSIX class like [:digit:] so its `]` doesn't end the outer class.
    if (segment[i] === '[' && segment[i + 1] === ':') {
      const end = segment.indexOf(':]', i + 2);
      if (end > 0) {
        i = end + 1;
        continue;
      }
    }
    if (segment[i] === ']') return i;
  }
  return -1;
}

function patternBodyToRegexSource(body: string): string {
  const segments = body.split('/');
  let out = '';
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]!;
    const last = i === segments.length - 1;
    if (segment === '**') {
      if (segments.length === 1) out += '.*';
      else if (last) out += '.*'; // trailing `/**`: everything inside
      else out += '(?:.*/)?'; // leading `**/` or middle `/**/`: any folders, or none
      continue;
    }
    out += segmentToRegexSource(segment);
    if (!last) out += '/';
  }
  return out;
}

// Trailing spaces are dropped unless escaped with a backslash.
function trimTrailingSpaces(line: string): string {
  let end = line.length;
  while (end > 0 && line[end - 1] === ' ' && line[end - 2] !== '\\') end--;
  return line.slice(0, end);
}

// Parses the text of a .gitignore into rules. Blank lines, comments and
// negations are skipped.
export function parseGitignore(text: string): GitignoreRule[] {
  const rules: GitignoreRule[] = [];
  const clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (const rawLine of clean.split(/\r\n|\n|\r/)) {
    let line = trimTrailingSpaces(nfc(rawLine));
    if (line === '' || line.startsWith('#')) continue;
    // A negation re-includes files; ignoring it keeps more, which is the
    // safe side for the caller.
    if (line.startsWith('!')) continue;
    if (line.startsWith('\\#') || line.startsWith('\\!')) line = line.slice(1);

    let dirOnly = false;
    if (line.endsWith('/')) {
      dirOnly = true;
      line = line.slice(0, -1);
    }
    let anchored = false;
    if (line.startsWith('/')) {
      anchored = true;
      line = line.slice(1);
    }
    if (line === '') continue;
    // A slash anywhere but the end ties the pattern to the .gitignore's folder.
    if (line.includes('/')) anchored = true;

    try {
      rules.push({ regex: new RegExp(`^${patternBodyToRegexSource(line)}$`), dirOnly, anchored });
    } catch {
      // A pattern that can't be compiled is skipped: keeping fewer files
      // than the repository ignores would be the unsafe direction, but a
      // broken pattern has no meaning to honour either.
    }
  }
  return rules;
}

// True when `path` is `dir` or lies below it ('' is the repository root).
export function isRepoPathUnderDir(path: string, dir: string): boolean {
  return dir === '' || path === dir || path.startsWith(`${dir}/`);
}

// True when `repoPath` (a path from the repository root) is ignored by the
// given .gitignore files: it, or a folder above it, matches a rule of a
// .gitignore in a folder above it. `isDir` says whether `repoPath` itself is
// a folder.
export function isIgnoredByGitignores(
  repoPath: string,
  isDir: boolean,
  gitignores: readonly GitignoreFile[],
): boolean {
  const path = nfc(repoPath);
  for (const file of gitignores) {
    const dir = nfc(file.dir);
    if (file.rules.length === 0) continue;
    // A .gitignore only governs what is below its own folder.
    if (dir !== '' && !path.startsWith(`${dir}/`)) continue;
    const rel = dir === '' ? path : path.slice(dir.length + 1);
    const segments = rel.split('/');
    let candidate = '';
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i]!;
      candidate = i === 0 ? segment : `${candidate}/${segment}`;
      const candidateIsDir = i < segments.length - 1 ? true : isDir;
      for (const rule of file.rules) {
        if (rule.dirOnly && !candidateIsDir) continue;
        if (rule.regex.test(rule.anchored ? candidate : segment)) return true;
      }
    }
  }
  return false;
}
