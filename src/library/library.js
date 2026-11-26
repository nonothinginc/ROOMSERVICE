/**
 * ROOMSERVICE Sample Library: persistent, offline, device-first.
 *
 * Import a pack (ZIP or loose audio files) once; every sample is classified
 * (category, tempo, loop length, root note), stored in IndexedDB with its original
 * bytes, and becomes available everywhere: playlist, MPC pads, MPC chopper, sampler.
 */
import * as Tone from 'tone';
import { engine } from '../audio/engine.js';
import { addUserSampleBuffer, computePeaks, ensureFactoryDrumKits } from '../audio/drum-kits.js';
import { SONG_MAX_STEPS, store } from '../state/store.js';
import { CATEGORIES, classifySample, cleanName, naturalCompare, shortLabel } from './classify.js';
import * as db from './library-db.js';
import { listZipEntries } from './zip-read.js';

const AUDIO_EXT = /\.(wav|wave|aif|aiff|mp3|ogg|oga|flac|m4a)$/i;
const JUNK = /(^|\/)(__MACOSX|\.DS_Store|\._)/;
const CACHE_BUDGET_BYTES = 96 * 1024 * 1024;

const listeners = new Set();
const bufferCache = new Map(); // id -> { buffer, bytes }
let cacheBytes = 0;
let audition = null; // { id, player }

export const libraryState = {
  ready: false,
  packs: [],
  samples: [],
  importing: null, // { name, done, total, current }
  auditionId: null,
  persisted: false
};

function emit() {
  for (const fn of listeners) {
    try {
      fn(libraryState);
    } catch (err) {
      console.error('[library] listener', err);
    }
  }
  store.emit('library', libraryState);
}

function sortSamples() {
  const order = new Map(CATEGORIES.map((c, i) => [c.id, i]));
  libraryState.samples.sort(
    (a, b) => (order.get(a.category) ?? 99) - (order.get(b.category) ?? 99) || naturalCompare(a.path, b.path)
  );
}

function slug(s, max = 40) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, max) || 'pack';
}

export const library = {
  onChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },

  async init() {
    if (libraryState.ready) return;
    try {
      const [packs, samples] = await Promise.all([db.getAllPacks(), db.getAllSamples()]);
      libraryState.packs = packs.sort((a, b) => a.addedAt - b.addedAt);
      libraryState.samples = samples;
      sortSamples();
      libraryState.persisted = Boolean(await navigator.storage?.persisted?.());
    } catch (err) {
      console.warn('[library] init failed', err);
    }
    libraryState.ready = true;
    emit();
    if (import.meta.env.DEV) this.seedLocalPacks();
  },

  /**
   * Local builds only: ZIPs in ./local-packs (served by the dev server, never deployed)
   * are imported once, automatically, as built-in packs.
   */
  async seedLocalPacks() {
    try {
      const res = await fetch('./local-packs/index.json', { cache: 'no-store' });
      if (!res.ok) return;
      const { packs = [] } = await res.json();
      const missing = packs.filter((p) => !libraryState.packs.some((x) => x.id === `pk-${slug(cleanName(p.file))}`));
      if (!missing.length) return;
      const files = [];
      for (const p of missing) {
        const zr = await fetch(`./local-packs/${encodeURIComponent(p.file)}`);
        if (zr.ok) files.push(new File([await zr.blob()], p.file, { type: 'application/zip' }));
      }
      const added = await this.importFiles(files);
      for (const pack of added || []) {
        pack.builtin = true;
        await db.putPack(pack);
      }
      emit();
    } catch (err) {
      console.warn('[library] local pack seeding skipped', err);
    }
  },

  categoryCounts(packId = null) {
    const counts = {};
    for (const s of libraryState.samples) {
      if (packId && s.packId !== packId) continue;
      counts[s.category] = (counts[s.category] || 0) + 1;
    }
    return counts;
  },

  /** Import ZIP packs and/or loose audio files. Each ZIP becomes its own pack. */
  async importFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length || libraryState.importing) return null;
    // Decoding works on a suspended context: don't block (auto-seeding runs before any user gesture)
    engine.unlock();
    const ctx = Tone.getContext().rawContext;
    libraryState.persisted = await db.requestPersistence();

    const zips = files.filter((f) => /\.zip$/i.test(f.name));
    const loose = files.filter((f) => AUDIO_EXT.test(f.name));
    const results = [];
    // One progress state across every pack in this batch
    this.batch = { packs: zips.length + (loose.length ? 1 : 0), index: 0 };

    for (const zip of zips) {
      const entries = listZipEntries(await zip.arrayBuffer()).filter((e) => AUDIO_EXT.test(e.name) && !JUNK.test(e.name));
      // Drop a single shared top folder ("Pack_001/Breaks/x.wav" -> "Breaks/x.wav")
      const tops = new Set(entries.map((e) => e.name.split('/')[0]));
      const strip = tops.size === 1 && entries.every((e) => e.name.includes('/'));
      const items = entries.map((e) => ({ path: strip ? e.name.split('/').slice(1).join('/') : e.name, read: e.read }));
      results.push(await this.ingest(cleanName(zip.name), items, ctx));
    }

    if (loose.length) {
      const rel = loose[0].webkitRelativePath?.split('/')[0];
      const name = rel || `IMPORT ${new Date().toISOString().slice(0, 10)}`;
      const items = loose.map((f) => ({
        path: f.webkitRelativePath ? f.webkitRelativePath.split('/').slice(1).join('/') : f.name,
        read: async () => new Uint8Array(await f.arrayBuffer())
      }));
      results.push(await this.ingest(name, items, ctx));
    }
    this.batch = null;
    libraryState.importing = null;
    emit();
    return results;
  },

  async ingest(packName, items, ctx) {
    const packId = `pk-${slug(packName)}`;
    // Re-importing a pack replaces it cleanly
    if (libraryState.packs.some((p) => p.id === packId)) await this.removePack(packId, false);

    if (this.batch) this.batch.index++;
    libraryState.importing = {
      name: packName,
      done: 0,
      total: items.length,
      current: '',
      pack: this.batch ? `${this.batch.index}/${this.batch.packs}` : ''
    };
    emit();
    let bytesTotal = 0;
    let added = 0;
    const metas = [];

    for (const item of items) {
      libraryState.importing.current = item.path.split('/').pop();
      try {
        const bytes = await item.read();
        // decodeAudioData detaches its input, so decode a copy and keep the original
        const buffer = await ctx.decodeAudioData(bytes.slice().buffer);
        const info = classifySample(item.path, buffer);
        const meta = {
          // Full path, never truncated: long sibling names must not collide
          id: `${packId}:${slug(item.path, 400)}`,
          packId,
          name: cleanName(item.path.split('/').pop()),
          path: item.path,
          ...info,
          channels: buffer.numberOfChannels,
          sampleRate: buffer.sampleRate,
          peaks: computePeaks(buffer, 48).map((v) => Math.round(v * 255)),
          size: bytes.byteLength,
          fav: false,
          addedAt: Date.now()
        };
        await db.putSample(meta, bytes.buffer.byteLength === bytes.byteLength ? bytes.buffer : bytes.slice().buffer);
        metas.push(meta);
        bytesTotal += bytes.byteLength;
        added++;
      } catch (err) {
        console.warn('[library] skipped', item.path, err?.message || err);
      }
      libraryState.importing.done++;
      // Let the UI breathe between files on the handheld
      if (libraryState.importing.done % 3 === 0) {
        emit();
        await new Promise((r) => setTimeout(r, 0));
      }
    }

    const pack = { id: packId, name: packName, count: added, bytes: bytesTotal, addedAt: Date.now() };
    await db.putPack(pack);
    libraryState.packs.push(pack);
    libraryState.samples.push(...metas);
    sortSamples();
    if (!this.batch) libraryState.importing = null;
    emit();
    return pack;
  },

  async removePack(packId, notify = true) {
    const ids = await db.deletePack(packId);
    const gone = new Set(ids);
    for (const id of gone) {
      const c = bufferCache.get(id);
      if (c) {
        cacheBytes -= c.bytes;
        bufferCache.delete(id);
      }
    }
    libraryState.packs = libraryState.packs.filter((p) => p.id !== packId);
    libraryState.samples = libraryState.samples.filter((s) => !gone.has(s.id));
    if (notify) emit();
  },

  async toggleFav(id) {
    const s = libraryState.samples.find((x) => x.id === id);
    if (!s) return;
    s.fav = !s.fav;
    await db.updateSampleMeta(s);
    emit();
  },

  /** Decoded AudioBuffer with an LRU cache bounded by CACHE_BUDGET_BYTES. */
  async getBuffer(id) {
    const hit = bufferCache.get(id);
    if (hit) {
      bufferCache.delete(id);
      bufferCache.set(id, hit);
      return hit.buffer;
    }
    const bytes = await db.getSampleBytes(id);
    if (!bytes) throw new Error('sample missing');
    const ctx = Tone.getContext().rawContext;
    const buffer = await ctx.decodeAudioData(bytes.slice(0));
    const size = buffer.length * buffer.numberOfChannels * 4;
    bufferCache.set(id, { buffer, bytes: size });
    cacheBytes += size;
    for (const [k, v] of bufferCache) {
      if (cacheBytes <= CACHE_BUDGET_BYTES || k === id) break;
      bufferCache.delete(k);
      cacheBytes -= v.bytes;
    }
    return buffer;
  },

  /**
   * Preview. Loops play in time with the project: re-pitched to project BPM and,
   * when the transport runs, started on the next beat so you hear them in context.
   */
  async audition(id) {
    if (libraryState.auditionId === id) {
      this.stopAudition();
      return;
    }
    this.stopAudition();
    const meta = libraryState.samples.find((s) => s.id === id);
    if (!meta) return;
    await engine.unlock();
    libraryState.auditionId = id;
    emit();
    const buffer = await this.getBuffer(id);
    if (libraryState.auditionId !== id) return;
    const st = store.getState();
    const out = engine.masterGain || Tone.getDestination();
    const player = new Tone.Player(buffer).connect(out);
    const isLoop = meta.kind === 'loop' && meta.bpm;
    if (isLoop) {
      player.loop = true;
      player.playbackRate = st.bpm / meta.bpm;
    } else {
      player.onstop = () => {
        if (audition?.player === player) this.stopAudition();
      };
    }
    const tr = Tone.getTransport();
    const when = isLoop && st.isPlaying ? tr.nextSubdivision('4n') : Tone.immediate() + 0.01;
    player.start(when);
    audition = { id, player };
  },

  stopAudition() {
    if (audition) {
      const { player } = audition;
      audition = null;
      try {
        player.stop();
        setTimeout(() => player.dispose(), 120);
      } catch {
        // ignore
      }
    }
    if (libraryState.auditionId) {
      libraryState.auditionId = null;
      emit();
    }
  },

  /**
   * Route a sample into the project.
   * target.kind: 'playlist' | 'pad' | 'chop' | 'sampler'
   */
  async send(id, target = { kind: 'playlist' }) {
    const meta = libraryState.samples.find((s) => s.id === id);
    if (!meta) return null;
    await engine.unlock();
    ensureFactoryDrumKits(Tone.getContext().rawContext);
    const buffer = await this.getBuffer(id);
    const st = store.getState();
    const label = shortLabel(meta.name);

    if (target.kind === 'playlist') {
      // First loop into an empty song sets the project tempo to the loop's tempo
      if (meta.kind === 'loop' && meta.bpm && st.arrClips.length === 0) engine.setBpm(Math.round(meta.bpm));
      const ac = engine.registerAudioBuffer(label, buffer);
      if (meta.bpm) ac.detectedBpm = meta.bpm;
      ac.warpMode = meta.kind === 'loop' ? 'BEATS' : 'RE-PITCH';
      const clip = st.arrClips[st.arrClips.length - 1];
      const len = meta.bpm ? Math.max(1, Math.round((meta.duration * meta.bpm) / 15)) : clip.lengthSteps;
      const at = target.step ?? (st.playMode === 'SONG' ? Math.floor(st.currentStep / 16) * 16 : 0);
      clip.startStep = Math.max(0, Math.min(SONG_MAX_STEPS - len, at));
      clip.lengthSteps = len;
      clip.lane = target.lane ?? findFreeLane(st, clip.startStep, len);
      store.emit('arr', { action: 'library', id });
      return { kind: 'playlist', clip };
    }

    if (target.kind === 'pad' || target.kind === 'chop') {
      const trackId = target.trackId ?? ensureDrumTrack(st);
      if (target.kind === 'chop') {
        await engine.loadSampleToMpcChop(trackId, buffer, label);
        return { kind: 'chop', trackId };
      }
      const entry = addUserSampleBuffer(label, buffer, 'USER');
      const node = engine.getDrumNode(trackId);
      if (st.tracks[trackId]?.inserts[0]?.params.mode === 0) store.setDeviceParam(trackId, 0, 'mode', 1);
      node?.setPadSample(target.padIdx ?? 0, entry);
      store.emit('drum-pads', { trackId });
      return { kind: 'pad', trackId, padIdx: target.padIdx ?? 0 };
    }

    if (target.kind === 'sampler') {
      const trackId = target.trackId ?? store.addInstrumentTrack('grain1');
      await engine.loadSampleToSampler(trackId, buffer, label);
      return { kind: 'sampler', trackId };
    }
    return null;
  }
};

function findFreeLane(st, start, len) {
  const busy = (lane) => st.arrClips.some((c) => c.lane === lane && c.startStep < start + len && c.startStep + c.lengthSteps > start);
  // Prefer lanes 5-8 for audio, then anything free
  for (const lane of [4, 5, 6, 7, 3, 2, 1, 0]) if (!busy(lane)) return lane;
  return 7;
}

function ensureDrumTrack(st) {
  const existing = st.tracks.find((t) => t.inserts[0]?.deviceId === 'drum8');
  if (existing) return existing.id;
  return store.addInstrumentTrack('drum8');
}
