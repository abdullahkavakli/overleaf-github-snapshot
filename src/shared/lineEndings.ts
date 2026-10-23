// Text helpers for comparing GitHub text with Overleaf text: line endings and
// characters Overleaf can't store. No imports, so every bundle (popup,
// content script) and a plain Node test script can load this file.
//
// Overleaf stores a doc as lines and drops the carriage returns of CRLF
// (Windows) and lone-CR (old Mac) text. A file read back from Overleaf
// therefore never has the "\r" characters the GitHub file has, even when
// the rest of the text is identical. Wherever GitHub text is compared with
// Overleaf text, or sent to Overleaf, it goes through normalizeLineEndings
// (or toOverleafStorableText, which includes it) first so both sides use
// "\n".

// "\r\n" and a lone "\r" both become "\n". Idempotent.
export function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

// Overleaf can't hold a character outside the Basic Multilingual Plane (an
// emoji such as the loudspeaker, some math symbols), nor a lone surrogate:
// document-updater's UpdateManager._sanitizeUpdate does
// `op.i = op.i.replace(/[\uD800-\uDFFF]/g, '\uFFFD')` on every insert. That
// works on UTF-16 code units, so a character stored as a surrogate pair
// becomes TWO U+FFFD, and the doc keeps the same length in code units.
const UNSTORABLE_UNIT = /[\uD800-\uDFFF]/;
const UNSTORABLE_UNITS = /[\uD800-\uDFFF]/g;

// True when Overleaf would change `text` on insert (it holds a surrogate code
// unit, so an emoji or another character outside the BMP).
export function hasOverleafUnstorableChars(text: string): boolean {
  return UNSTORABLE_UNIT.test(text);
}

// The text a doc holds after `text` was written to Overleaf: line endings
// normalized and every surrogate code unit replaced with U+FFFD, exactly as
// Overleaf does. Idempotent. Wherever GitHub text is compared with, or sent
// to, Overleaf it goes through this, so a file whose only difference is such
// characters is seen as unchanged and a write verifies.
export function toOverleafStorableText(text: string): string {
  return normalizeLineEndings(text).replace(UNSTORABLE_UNITS, '\uFFFD');
}

// Decodes bytes as UTF-8 text the way every file read here does (a leading
// BOM stays in the text). `valid` is false when the bytes are not valid
// UTF-8 (for example Windows-1252 curly quotes, 0x93 and 0x94); the text
// then holds U+FFFD where the invalid bytes were. A valid file that really
// contains U+FFFD stays valid.
export function decodeUtf8Text(bytes: Uint8Array): { text: string; valid: boolean } {
  try {
    return { text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes), valid: true };
  } catch {
    return { text: new TextDecoder('utf-8', { fatal: false, ignoreBOM: true }).decode(bytes), valid: false };
  }
}

const LF = 0x0a;
const CR = 0x0d;

// Byte version of normalizeLineEndings. Safe on UTF-8: 0x0A and 0x0D never
// occur inside a multi-byte sequence. Returns the input itself when it has
// no CR.
export function normalizeLineEndingsBytes(bytes: Uint8Array): Uint8Array {
  if (bytes.indexOf(CR) < 0) return bytes;
  const out = new Uint8Array(bytes.length);
  let n = 0;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    if (b === CR) {
      out[n++] = LF;
      if (bytes[i + 1] === LF) i++;
    } else {
      out[n++] = b;
    }
  }
  return out.subarray(0, n);
}

export type LineEndingStyle = 'crlf' | 'cr';

// Rewrites every LF in `lfBytes` (text that is already LF-only) as CRLF or
// as a lone CR.
export function applyLineEndingStyleBytes(
  lfBytes: Uint8Array,
  style: LineEndingStyle,
): Uint8Array {
  let lfCount = 0;
  for (let i = 0; i < lfBytes.length; i++) if (lfBytes[i] === LF) lfCount++;
  const out = new Uint8Array(lfBytes.length + (style === 'crlf' ? lfCount : 0));
  let n = 0;
  for (let i = 0; i < lfBytes.length; i++) {
    const b = lfBytes[i]!;
    if (b === LF) {
      out[n++] = CR;
      if (style === 'crlf') out[n++] = LF;
    } else {
      out[n++] = b;
    }
  }
  return out;
}

// The byte sequences that differ from `content` only in line endings and
// are uniform: the LF form, the CRLF form and the CR form (the one equal to
// `content` itself is left out). Empty when `content` has no line break.
export function lineEndingVariantsBytes(content: Uint8Array): Uint8Array[] {
  const lf = normalizeLineEndingsBytes(content);
  if (lf.indexOf(LF) < 0) return [];
  const all = [lf, applyLineEndingStyleBytes(lf, 'crlf'), applyLineEndingStyleBytes(lf, 'cr')];
  return all.filter((v) => !sameBytes(v, content));
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
