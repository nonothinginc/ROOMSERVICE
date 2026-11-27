#!/usr/bin/env node
/**
 * Bundle sample packs for the local / APK build.
 *
 *   node tools/build-packs.mjs            # local-packs/*.zip (+ folders) -> packs/
 *
 * Each pack is extracted to packs/<packId>/..., every sample is analysed once here on the Mac
 * with the same classifier the app uses (category, BPM, loop length, root note, peaks), and a
 * single packs/index.json is written. The app loads that index instantly and fetches audio
 * on demand, so nothing is imported or duplicated on the device.
 *
 * packs/ and local-packs/ are gitignored: packs are for this device only.
 * Non-WAV audio (aif/mp3/flac/m4a) is converted to WAV with macOS afconvert.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifySample, cleanName } from '../src/library/classify.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'local-packs');
const OUT = path.join(ROOT, 'packs');
const AUDIO = /\.(wav|wave|aif|aiff|mp3|flac|m4a|ogg)$/i;
const JUNK = /(^|\/)(__MACOSX|\.DS_Store|\._)/;

const slug = (s, max = 400) =>
  String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, max) || 'pack';

/** Minimal WAV decoder: PCM 8/16/24/32-bit int and 32/64-bit float, any channel count. */
function decodeWav(buf) {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not RIFF/WAVE');
  let p = 12;
  let fmt = null;
  let data = null;
  while (p + 8 <= buf.length) {
    const id = buf.toString('ascii', p, p + 4);
    const size = buf.readUInt32LE(p + 4);
    const body = p + 8;
    if (id === 'fmt ') {
      let format = buf.readUInt16LE(body);
      const channels = buf.readUInt16LE(body + 2);
      const sampleRate = buf.readUInt32LE(body + 4);
      const bits = buf.readUInt16LE(body + 14);
      if (format === 0xfffe && size >= 26) format = buf.readUInt16LE(body + 24); // WAVE_FORMAT_EXTENSIBLE
      fmt = { format, channels, sampleRate, bits };
    } else if (id === 'data') {
      data = buf.subarray(body, Math.min(buf.length, body + size));
    }
    p = body + size + (size % 2);
  }
  if (!fmt || !data) throw new Error('missing fmt/data');
  const { format, channels, sampleRate, bits } = fmt;
  const bps = bits / 8;
  const frames = Math.floor(data.length / (bps * channels));
  const chans = Array.from({ length: channels }, () => new Float32Array(frames));
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      const o = (i * channels + c) * bps;
      let v;
      if (format === 3) v = bits === 64 ? data.readDoubleLE(o) : data.readFloatLE(o);
      else if (bits === 8) v = (data[o] - 128) / 128;
      else if (bits === 16) v = data.readInt16LE(o) / 32768;
      else if (bits === 24) v = data.readIntLE(o, 3) / 8388608;
      else if (bits === 32) v = data.readInt32LE(o) / 2147483648;
      else throw new Error(`unsupported ${bits}-bit`);
      chans[c][i] = v;
    }
  }
  return {
    sampleRate,
    numberOfChannels: channels,
    length: frames,
    duration: frames / sampleRate,
    getChannelData: (c) => chans[c]
  };
}

function peaks(buffer, count = 48) {
  const ch = buffer.getChannelData(0);
  const block = Math.max(1, Math.floor(ch.length / count));
  const out = [];
  for (let i = 0; i < count; i++) {
    let max = 0;
    const end = Math.min(ch.length, (i + 1) * block);
    for (let j = i * block; j < end; j += Math.max(1, block >> 4)) max = Math.max(max, Math.abs(ch[j]));
    out.push(Math.round(Math.min(1, max) * 255));
  }
  return out;
}

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(f));
    else out.push(f);
  }
  return out;
}

/** Extract a ZIP to a temp dir (macOS ditto handles ZIP64 and odd encodings). */
function extractZip(zip) {
  const dest = path.join(OUT, '.extract', slug(path.basename(zip)));
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  execFileSync('ditto', ['-x', '-k', zip, dest]);
  return dest;
}

function main() {
  if (!fs.existsSync(SRC)) {
    console.log('No local-packs/ folder. Put pack ZIPs or folders there.');
    return;
  }
  fs.mkdirSync(OUT, { recursive: true });
  const sources = fs.readdirSync(SRC).filter((f) => !f.startsWith('.'));
  const index = { version: 1, builtAt: new Date().toISOString(), packs: [] };

  for (const src of sources) {
    const full = path.join(SRC, src);
    const isZip = /\.zip$/i.test(src);
    if (!isZip && !fs.statSync(full).isDirectory()) continue;
    const name = cleanName(src);
    const packId = `bi-${slug(name, 40)}`;
    const base = isZip ? extractZip(full) : full;
    let files = walk(base)
      .map((f) => path.relative(base, f).split(path.sep).join('/'))
      .filter((r) => AUDIO.test(r) && !JUNK.test(r));
    // Drop a single shared top folder
    const tops = new Set(files.map((r) => r.split('/')[0]));
    const strip = tops.size === 1 && files.every((r) => r.includes('/'));

    const packOut = path.join(OUT, packId);
    fs.rmSync(packOut, { recursive: true, force: true });
    const samples = [];
    let bytes = 0;
    let skipped = 0;
    for (const rel of files) {
      const logical = strip ? rel.split('/').slice(1).join('/') : rel;
      const outRel = logical.replace(AUDIO, '.wav');
      const dst = path.join(packOut, outRel);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      try {
        const srcFile = path.join(base, rel);
        if (/\.(wav|wave)$/i.test(rel)) fs.copyFileSync(srcFile, dst);
        else execFileSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16', srcFile, dst]);
        const wav = fs.readFileSync(dst);
        const buffer = decodeWav(wav);
        const info = classifySample(logical, buffer);
        samples.push({
          id: `${packId}:${slug(logical)}`,
          packId,
          name: cleanName(logical.split('/').pop()),
          path: logical,
          url: `packs/${packId}/${outRel.split('/').map(encodeURIComponent).join('/')}`,
          ...info,
          duration: +buffer.duration.toFixed(4),
          channels: buffer.numberOfChannels,
          sampleRate: buffer.sampleRate,
          peaks: peaks(buffer),
          size: wav.length,
          builtin: true
        });
        bytes += wav.length;
      } catch (err) {
        skipped++;
        fs.rmSync(dst, { force: true });
        console.warn(`  skip ${logical}: ${err.message}`);
      }
    }
    index.packs.push({ id: packId, name, count: samples.length, bytes, builtin: true, samples });
    const cats = samples.reduce((m, s) => ((m[s.category] = (m[s.category] || 0) + 1), m), {});
    console.log(`${name}: ${samples.length} samples (${(bytes / 1e6).toFixed(1)} MB)${skipped ? `, ${skipped} skipped` : ''}`);
    console.log('  ', Object.entries(cats).map(([k, v]) => `${k} ${v}`).join(' · '));
  }
  fs.rmSync(path.join(OUT, '.extract'), { recursive: true, force: true });
  fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify(index));
  console.log(`index: ${index.packs.length} packs, ${index.packs.reduce((a, p) => a + p.count, 0)} samples`);
}

main();
