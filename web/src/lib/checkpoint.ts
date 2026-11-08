/**
 * Checkpoint file format: "HLS1" + 40-char ROM sha1 + gzip(raw mGBA save state).
 * The ROM hash prevents restoring a snapshot taken with a different ROM build, which would crash.
 */
const MAGIC = 'HLS1';
const HASH_LEN = 40;

async function pipe(data: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Blob([data as BlobPart]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(out).arrayBuffer());
}

export async function encodeCheckpoint(state: Uint8Array, romHash: string): Promise<Uint8Array> {
  const header = new TextEncoder().encode(MAGIC + romHash.padEnd(HASH_LEN, '0').slice(0, HASH_LEN));
  const body = await pipe(state, new CompressionStream('gzip'));
  const out = new Uint8Array(header.length + body.length);
  out.set(header);
  out.set(body, header.length);
  return out;
}

/** Returns the raw state, or null when the file is invalid or belongs to another ROM build. */
export async function decodeCheckpoint(file: Uint8Array, romHash: string): Promise<Uint8Array | null> {
  if (file.length < MAGIC.length + HASH_LEN) return null;
  const header = new TextDecoder().decode(file.subarray(0, MAGIC.length + HASH_LEN));
  if (!header.startsWith(MAGIC)) return null;
  if (romHash && header.slice(MAGIC.length) !== romHash.padEnd(HASH_LEN, '0').slice(0, HASH_LEN)) return null;
  try {
    return await pipe(file.subarray(MAGIC.length + HASH_LEN), new DecompressionStream('gzip'));
  } catch {
    return null;
  }
}
