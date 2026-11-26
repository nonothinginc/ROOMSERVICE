const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  CRC_TABLE[i] = c >>> 0;
}

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function buildZip(entries) {
  const prepared = entries.map((e) => {
    const nameBytes = textEncoder.encode(e.name);
    const raw = typeof e.data === 'string' ? textEncoder.encode(e.data) : new Uint8Array(e.data);
    return {
      nameBytes,
      raw,
      crc: crc32(raw),
      offset: 0
    };
  });

  let localTotal = 0;
  let cdTotal = 0;
  for (const p of prepared) {
    p.offset = localTotal;
    localTotal += 30 + p.nameBytes.length + p.raw.length;
    cdTotal += 46 + p.nameBytes.length;
  }

  const out = new Uint8Array(localTotal + cdTotal + 22);
  const view = new DataView(out.buffer);
  let pos = 0;

  for (const p of prepared) {
    view.setUint32(pos, 0x04034b50, true);
    view.setUint16(pos + 4, 20, true);
    view.setUint16(pos + 6, 0x0800, true); // UTF-8
    view.setUint16(pos + 8, 0, true); // stored
    view.setUint16(pos + 10, 0, true);
    view.setUint16(pos + 12, 0, true);
    view.setUint32(pos + 14, p.crc, true);
    view.setUint32(pos + 18, p.raw.length, true);
    view.setUint32(pos + 22, p.raw.length, true);
    view.setUint16(pos + 26, p.nameBytes.length, true);
    view.setUint16(pos + 28, 0, true);
    out.set(p.nameBytes, pos + 30);
    out.set(p.raw, pos + 30 + p.nameBytes.length);
    pos += 30 + p.nameBytes.length + p.raw.length;
  }

  const cdStart = pos;
  for (const p of prepared) {
    view.setUint32(pos, 0x02014b50, true);
    view.setUint16(pos + 4, 20, true);
    view.setUint16(pos + 6, 20, true);
    view.setUint16(pos + 8, 0x0800, true);
    view.setUint16(pos + 10, 0, true);
    view.setUint16(pos + 12, 0, true);
    view.setUint16(pos + 14, 0, true);
    view.setUint32(pos + 16, p.crc, true);
    view.setUint32(pos + 20, p.raw.length, true);
    view.setUint32(pos + 24, p.raw.length, true);
    view.setUint16(pos + 28, p.nameBytes.length, true);
    view.setUint16(pos + 30, 0, true);
    view.setUint16(pos + 32, 0, true);
    view.setUint16(pos + 34, 0, true);
    view.setUint16(pos + 36, 0, true);
    view.setUint32(pos + 38, 0, true);
    view.setUint32(pos + 42, p.offset, true);
    out.set(p.nameBytes, pos + 46);
    pos += 46 + p.nameBytes.length;
  }

  view.setUint32(pos, 0x06054b50, true);
  view.setUint16(pos + 4, 0, true);
  view.setUint16(pos + 6, 0, true);
  view.setUint16(pos + 8, prepared.length, true);
  view.setUint16(pos + 10, prepared.length, true);
  view.setUint32(pos + 12, cdTotal, true);
  view.setUint32(pos + 16, cdStart, true);
  view.setUint16(pos + 20, 0, true);

  return out;
}

export function parseZip(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  const view = new DataView(arrayBuffer);
  let eocdOffset = -1;

  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65558); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) {
    throw new Error('Invalid .roomservice archive (missing EOCD)');
  }

  const totalEntries = view.getUint16(eocdOffset + 10, true);
  let cdPos = view.getUint32(eocdOffset + 16, true);
  const files = new Map();

  for (let i = 0; i < totalEntries; i++) {
    if (view.getUint32(cdPos, true) !== 0x02014b50) break;
    const method = view.getUint16(cdPos + 10, true);
    const compSize = view.getUint32(cdPos + 20, true);
    const nameLen = view.getUint16(cdPos + 28, true);
    const extraLen = view.getUint16(cdPos + 30, true);
    const commentLen = view.getUint16(cdPos + 32, true);
    const localOffset = view.getUint32(cdPos + 42, true);
    const name = textDecoder.decode(bytes.subarray(cdPos + 46, cdPos + 46 + nameLen));

    const lfhNameLen = view.getUint16(localOffset + 26, true);
    const lfhExtraLen = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + lfhNameLen + lfhExtraLen;
    if (method === 0) {
      files.set(name, bytes.slice(dataStart, dataStart + compSize));
    }

    cdPos += 46 + nameLen + extraLen + commentLen;
  }

  return files;
}

export function encodeAudioBufferToWav(audioBuffer) {
  const numChannels = Math.min(2, audioBuffer.numberOfChannels || 1);
  const sampleRate = audioBuffer.sampleRate || 44100;
  const numFrames = audioBuffer.length;
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const dataSize = numFrames * blockAlign;
  const out = new Uint8Array(44 + dataSize);
  const view = new DataView(out.buffer);

  const writeStr = (off, str) => {
    for (let i = 0; i < str.length; i++) out[off + i] = str.charCodeAt(i);
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);

  const chData = [];
  for (let c = 0; c < numChannels; c++) {
    chData.push(audioBuffer.getChannelData(c));
  }

  let offset = 44;
  for (let i = 0; i < numFrames; i++) {
    for (let c = 0; c < numChannels; c++) {
      const s = Math.max(-1, Math.min(1, chData[c][i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      offset += 2;
    }
  }

  return out;
}
