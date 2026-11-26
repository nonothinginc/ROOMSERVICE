/**
 * Streaming-friendly ZIP reader for sample packs.
 * Supports STORE (0) and DEFLATE (8) entries using the browser's native
 * DecompressionStream('deflate-raw'), so no third-party inflate code ships.
 * Entries are inflated lazily, one at a time, to keep peak memory low on the device.
 */

const decoder = new TextDecoder();

function findEocd(view, len) {
  for (let i = len - 22; i >= Math.max(0, len - 65558); i--) {
    if (view.getUint32(i, true) === 0x06054b50) return i;
  }
  return -1;
}

/** @returns {{ name: string, size: number, read: () => Promise<Uint8Array> }[]} */
export function listZipEntries(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  const view = new DataView(arrayBuffer);
  const eocd = findEocd(view, bytes.length);
  if (eocd < 0) throw new Error('Not a ZIP archive');

  const total = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const entries = [];

  for (let i = 0; i < total; i++) {
    if (view.getUint32(p, true) !== 0x02014b50) break;
    const flags = view.getUint16(p + 8, true);
    const method = view.getUint16(p + 10, true);
    const compSize = view.getUint32(p + 20, true);
    const size = view.getUint32(p + 24, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOffset = view.getUint32(p + 42, true);
    const rawName = bytes.subarray(p + 46, p + 46 + nameLen);
    // UTF-8 (flag bit 11) or CP437; pack names are ASCII in practice, so one decoder covers both
    const name = decoder.decode(rawName);
    p += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith('/') || (method !== 0 && method !== 8)) continue;
    if (flags & 0x1) continue; // encrypted

    entries.push({
      name,
      size,
      read: async () => {
        const lfhName = view.getUint16(localOffset + 26, true);
        const lfhExtra = view.getUint16(localOffset + 28, true);
        const start = localOffset + 30 + lfhName + lfhExtra;
        const data = bytes.subarray(start, start + compSize);
        if (method === 0) return data.slice();
        const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
        return new Uint8Array(await new Response(stream).arrayBuffer());
      }
    });
  }
  return entries;
}
