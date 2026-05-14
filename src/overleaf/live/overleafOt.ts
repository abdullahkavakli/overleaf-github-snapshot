// Compute the smallest set of insert/delete operations needed to transform
// `oldText` into `newText`. This is a thin diff helper used by the
// write-back path. The Overleaf live-editing protocol expects operations to
// be expressed as `{ p, i }` (insert) or `{ p, d }` (delete) records on a
// shared document version; this helper does the conversion clean-room from
// a string diff, so we never have to copy AGPL OT code.

export type OtOp = { p: number; i: string } | { p: number; d: string };

// Find common prefix and suffix and emit a single replace as one delete +
// one insert. This is conservative but always correct, and it is what
// applyDocUpdate consumers expect when no character-level operations are
// available.
export function diffToOps(oldText: string, newText: string): OtOp[] {
  if (oldText === newText) return [];
  const minLen = Math.min(oldText.length, newText.length);
  let start = 0;
  while (start < minLen && oldText.charCodeAt(start) === newText.charCodeAt(start)) {
    start++;
  }
  let oldEnd = oldText.length;
  let newEnd = newText.length;
  while (
    oldEnd > start &&
    newEnd > start &&
    oldText.charCodeAt(oldEnd - 1) === newText.charCodeAt(newEnd - 1)
  ) {
    oldEnd--;
    newEnd--;
  }

  const ops: OtOp[] = [];
  const removed = oldText.substring(start, oldEnd);
  const inserted = newText.substring(start, newEnd);
  if (removed.length > 0) {
    ops.push({ p: start, d: removed });
  }
  if (inserted.length > 0) {
    // After a delete at position p, the insert is also anchored at p
    // because the deleted range collapses.
    ops.push({ p: start, i: inserted });
  }
  return ops;
}
