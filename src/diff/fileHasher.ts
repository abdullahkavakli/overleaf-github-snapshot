import { lineEndingVariantsBytes } from '../shared/lineEndings';

function bufferToHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

function toArrayBufferView(content: Uint8Array): ArrayBuffer {
  if (content.byteOffset === 0 && content.byteLength === content.buffer.byteLength) {
    return content.buffer as ArrayBuffer;
  }
  return content.slice().buffer;
}

export async function computeSha256(content: Uint8Array): Promise<string> {
  const buffer = await crypto.subtle.digest('SHA-256', toArrayBufferView(content));
  return bufferToHex(buffer);
}

// Git computes blob SHA as SHA-1 of "blob <size>\0<content>" where \0 is a NUL byte.
export async function computeGitBlobSha(content: Uint8Array): Promise<string> {
  const prefix = new TextEncoder().encode(`blob ${content.byteLength}`);
  const combined = new Uint8Array(prefix.length + 1 + content.length);
  combined.set(prefix, 0);
  combined[prefix.length] = 0x00;
  combined.set(content, prefix.length + 1);
  const buffer = await crypto.subtle.digest('SHA-1', toArrayBufferView(combined));
  return bufferToHex(buffer);
}

// True when `content` is not byte-identical to the git blob `expectedSha`
// but would be once its line endings were rewritten uniformly as LF, CRLF
// or CR. Text files only (the caller checks). Overleaf keeps no CR, so a
// repo file with CRLF or CR endings never hashes the same as the Overleaf
// copy of it. This lets the diff see such a file as unchanged without
// downloading the blob from GitHub.
export async function gitBlobShaMatchesIgnoringLineEndings(
  content: Uint8Array,
  expectedSha: string,
): Promise<boolean> {
  for (const variant of lineEndingVariantsBytes(content)) {
    if ((await computeGitBlobSha(variant)) === expectedSha) return true;
  }
  return false;
}
