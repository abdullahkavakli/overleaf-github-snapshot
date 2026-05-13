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
