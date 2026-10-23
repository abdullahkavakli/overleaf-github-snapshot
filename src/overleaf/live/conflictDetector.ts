// Strict conflict detector used by the experimental write-back path.
//
// Compare three views of a file:
//   - "base"    : what the user saw when they previewed the diff (their
//                 working set; comes from the Overleaf ZIP snapshot or live
//                 read taken at preview time).
//   - "remote"  : what is currently on Overleaf right now (re-fetched
//                 immediately before write).
//   - "local"   : the proposed new content the user wants to write.
//
// If remote ≠ base, somebody else changed the file. We never overwrite in
// that case — we surface the conflict and require manual resolution.

import { computeSha256 } from '../../diff/fileHasher';
import { toOverleafStorableText } from '../../shared/lineEndings';

export type ConflictStatus =
  | 'safe' // remote === base, write may proceed
  | 'unchanged' // local === base (ignoring line endings and characters Overleaf can't store), nothing to write
  | 'conflict'; // remote !== base AND local !== remote

export type ConflictCheckResult = {
  path: string;
  status: ConflictStatus;
  baseSha256: string;
  remoteSha256: string;
  localSha256: string;
  reason?: string;
};

const enc = new TextEncoder();

export async function checkWriteBackConflict(
  path: string,
  baseText: string,
  remoteText: string,
  localText: string,
): Promise<ConflictCheckResult> {
  const [baseSha, remoteSha, localSha] = await Promise.all([
    computeSha256(enc.encode(baseText)),
    computeSha256(enc.encode(remoteText)),
    computeSha256(enc.encode(localText)),
  ]);

  // "Nothing to write" compares what Overleaf would hold: it keeps no CR and
  // turns each half of an emoji into U+FFFD, so a local text that differs
  // from base only in "\r" or in such characters has no change to send.
  // The remote-vs-base comparison below stays byte-exact on purpose. Both
  // come from Overleaf, so any difference at all means the doc moved, and
  // being stricter than necessary there can only cause a refused write,
  // never an overwrite.
  if (localSha === baseSha || toOverleafStorableText(localText) === toOverleafStorableText(baseText)) {
    return {
      path,
      status: 'unchanged',
      baseSha256: baseSha,
      remoteSha256: remoteSha,
      localSha256: localSha,
      reason: 'No local change to write back.',
    };
  }

  if (remoteSha !== baseSha) {
    return {
      path,
      status: 'conflict',
      baseSha256: baseSha,
      remoteSha256: remoteSha,
      localSha256: localSha,
      reason: 'This file changed in Overleaf after it was read, so it was not overwritten.',
    };
  }

  return {
    path,
    status: 'safe',
    baseSha256: baseSha,
    remoteSha256: remoteSha,
    localSha256: localSha,
  };
}
