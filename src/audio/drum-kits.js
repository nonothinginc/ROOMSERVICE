let initialized = false;
let authenticStarted = false;
let authenticLoaded = false;
let poolUid = 1;

const samplePool = [];
const sampleById = new Map();
const reversedCache = new WeakMap();
const kitUpdateListeners = new Set();

export function onDrumKitsUpdated(fn) {
  kitUpdateListeners.add(fn);
  return () => kitUpdateListeners.delete(fn);
}

const AUTHENTIC_FILES = {
  '909_0': './samples/909/kick.wav',
  '909_1': './samples/909/snare.wav',
  '909_2': './samples/909/clap.wav',
  '909_3': './samples/909/ch.wav',
  '909_4': './samples/909/oh.wav',
  '909_5': './samples/909/rim.wav',
  '909_6': './samples/909/tom.wav',
  '909_7': './samples/909/ride.wav',
  '808_0': './samples/808/kick.wav',
  '808_1': './samples/808/snare.wav',
  '808_2': './samples/808/clap.wav',
  '808_3': './samples/808/ch.wav',
  '808_4': './samples/808/oh.wav',
  '808_5': './samples/808/clave.wav',
  '808_6': './samples/808/tom.wav',
  '808_7': './samples/808/cowbell.wav'
};

export async function loadAuthenticDrumKits(audioCtx) {
  if (!audioCtx || authenticLoaded || authenticStarted) return;
  authenticStarted = true;
  try {
    const entries = Object.entries(AUTHENTIC_FILES);
    let updatedCount = 0;
    await Promise.all(
      entries.map(async ([id, url]) => {
        try {
          const res = await fetch(url);
          if (!res.ok) return;
          const ab = await res.arrayBuffer();
          const buf = await audioCtx.decodeAudioData(ab);
          const entry = sampleById.get(id);
          if (entry && buf) {
            entry.buffer = buf;
            entry.peaks = computePeaks(buf);
            entry.duration = buf.duration;
            entry.authentic = true;
            reversedCache.delete(buf);
            updatedCount++;
          }
        } catch {
          // Keep offline fallback buffer for this slot
        }
      })
    );
    if (updatedCount > 0) {
      authenticLoaded = true;
      for (const fn of kitUpdateListeners) {
        try {
          fn();
        } catch {
          // ignore
        }
      }
    } else {
      authenticStarted = false;
    }
  } catch {
    authenticStarted = false;
  }
}

export const KIT_NAMES = ['909', '808', 'RAND', 'COMBO'];

export function computePeaks(audioBuffer, count = 128) {
  const ch = audioBuffer.getChannelData(0);
  const len = ch.length;
  const peaks = new Array(count).fill(0);
  const block = Math.max(1, Math.floor(len / count));
  for (let i = 0; i < count; i++) {
    const start = i * block;
    const end = Math.min(len, start + block);
    let max = 0;
    const step = Math.max(1, Math.floor(block / 16));
    for (let j = start; j < end; j += step) {
      const v = Math.abs(ch[j]);
      if (v > max) max = v;
    }
    peaks[i] = max;
  }
  return peaks;
}

function registerEntry(entry) {
  samplePool.push(entry);
  sampleById.set(entry.id, entry);
  return entry;
}

function makeBuf(audioCtx, durationSec, renderFn) {
  const sr = audioCtx.sampleRate || 44100;
  const len = Math.max(256, Math.floor(sr * durationSec));
  const buf = audioCtx.createBuffer(2, len, sr);
  const L = buf.getChannelData(0);
  const R = buf.getChannelData(1);
  for (let i = 0; i < len; i++) {
    const s = renderFn(i / sr, i, sr);
    const out = Math.tanh(s);
    L[i] = out;
    R[i] = out;
  }
  return buf;
}

function create909Bank(audioCtx) {
  const specs = [
    {
      name: '909 KICK',
      dur: 0.42,
      fn: (t) => {
        const env = Math.exp(-t * 11);
        const f = 46 + 155 * Math.exp(-t * 48);
        const click = Math.exp(-t * 280) * 0.45;
        return Math.sin(2 * Math.PI * f * t) * env * 1.15 + click;
      }
    },
    {
      name: '909 SNARE',
      dur: 0.28,
      fn: (t) => {
        const body = (Math.sin(2 * Math.PI * 185 * t) + 0.6 * Math.sin(2 * Math.PI * 330 * t)) * Math.exp(-t * 24) * 0.55;
        const noise = (Math.random() * 2 - 1) * Math.exp(-t * 15) * 0.72;
        return body + noise;
      }
    },
    {
      name: '909 CLAP',
      dur: 0.34,
      fn: (t) => {
        const burst =
          (t < 0.012 ? 1 : 0) +
          (t >= 0.014 && t < 0.025 ? 0.9 : 0) +
          (t >= 0.027 && t < 0.038 ? 0.8 : 0) +
          (t >= 0.038 ? Math.exp(-(t - 0.038) * 14) * 0.75 : 0);
        return (Math.random() * 2 - 1) * burst * 0.85;
      }
    },
    {
      name: '909 CH',
      dur: 0.09,
      fn: (t) => {
        const metal =
          Math.sign(Math.sin(2 * Math.PI * 3100 * t)) +
          Math.sign(Math.sin(2 * Math.PI * 4650 * t)) +
          Math.sign(Math.sin(2 * Math.PI * 6800 * t));
        return (metal * 0.25 + (Math.random() * 2 - 1) * 0.55) * Math.exp(-t * 52);
      }
    },
    {
      name: '909 OH',
      dur: 0.48,
      fn: (t) => {
        const metal =
          Math.sign(Math.sin(2 * Math.PI * 3120 * t)) +
          Math.sign(Math.sin(2 * Math.PI * 4720 * t)) +
          Math.sign(Math.sin(2 * Math.PI * 6950 * t));
        return (metal * 0.22 + (Math.random() * 2 - 1) * 0.48) * Math.exp(-t * 7.5);
      }
    },
    {
      name: '909 RIM',
      dur: 0.1,
      fn: (t) => (Math.sin(2 * Math.PI * 470 * t) + 0.8 * Math.sin(2 * Math.PI * 1680 * t)) * Math.exp(-t * 48)
    },
    {
      name: '909 TOM',
      dur: 0.34,
      fn: (t) => {
        const f = 82 + 95 * Math.exp(-t * 22);
        return Math.sin(2 * Math.PI * f * t) * Math.exp(-t * 9.5) * 0.95;
      }
    },
    {
      name: '909 RIDE',
      dur: 0.65,
      fn: (t) => {
        const m =
          Math.sin(2 * Math.PI * 2180 * t) +
          Math.sin(2 * Math.PI * 3420 * t) +
          Math.sin(2 * Math.PI * 5240 * t);
        return (m * 0.24 + (Math.random() * 2 - 1) * 0.22) * Math.exp(-t * 4.5);
      }
    }
  ];

  return specs.map((sp, slotHint) => {
    const buffer = makeBuf(audioCtx, sp.dur, sp.fn);
    return registerEntry({
      id: `909_${slotHint}`,
      name: sp.name,
      bank: '909',
      slotHint,
      buffer,
      peaks: computePeaks(buffer),
      duration: buffer.duration
    });
  });
}

function create808Bank(audioCtx) {
  const specs = [
    {
      name: '808 KICK',
      dur: 0.72,
      fn: (t) => {
        const f = 42 + 85 * Math.exp(-t * 28);
        return Math.sin(2 * Math.PI * f * t) * Math.exp(-t * 4.6) * 1.15;
      }
    },
    {
      name: '808 SNARE',
      dur: 0.26,
      fn: (t) => {
        const tone = (Math.sin(2 * Math.PI * 175 * t) + 0.5 * Math.sin(2 * Math.PI * 260 * t)) * Math.exp(-t * 26) * 0.6;
        const snap = (Math.random() * 2 - 1) * Math.exp(-t * 17) * 0.62;
        return tone + snap;
      }
    },
    {
      name: '808 CLAP',
      dur: 0.3,
      fn: (t) => {
        const env =
          (t < 0.01 ? 1 : 0) +
          (t >= 0.012 && t < 0.022 ? 0.9 : 0) +
          (t >= 0.024 && t < 0.034 ? 0.85 : 0) +
          (t >= 0.034 ? Math.exp(-(t - 0.034) * 16) * 0.65 : 0);
        return (Math.random() * 2 - 1) * env * 0.8;
      }
    },
    {
      name: '808 CH',
      dur: 0.075,
      fn: (t) => {
        const metal =
          Math.sign(Math.sin(2 * Math.PI * 3650 * t)) +
          Math.sign(Math.sin(2 * Math.PI * 5180 * t)) +
          Math.sign(Math.sin(2 * Math.PI * 7820 * t));
        return (metal * 0.28 + (Math.random() * 2 - 1) * 0.35) * Math.exp(-t * 60);
      }
    },
    {
      name: '808 OH',
      dur: 0.44,
      fn: (t) => {
        const metal =
          Math.sign(Math.sin(2 * Math.PI * 3650 * t)) +
          Math.sign(Math.sin(2 * Math.PI * 5180 * t)) +
          Math.sign(Math.sin(2 * Math.PI * 7820 * t));
        return (metal * 0.25 + (Math.random() * 2 - 1) * 0.32) * Math.exp(-t * 8.5);
      }
    },
    {
      name: '808 CLAVE',
      dur: 0.14,
      fn: (t) => Math.sin(2 * Math.PI * 2480 * t) * Math.exp(-t * 34) * 0.85
    },
    {
      name: '808 TOM',
      dur: 0.4,
      fn: (t) => {
        const f = 74 + 55 * Math.exp(-t * 16);
        return Math.sin(2 * Math.PI * f * t) * Math.exp(-t * 7.8) * 0.95;
      }
    },
    {
      name: '808 COWB',
      dur: 0.34,
      fn: (t) => {
        const sq = Math.sign(Math.sin(2 * Math.PI * 540 * t)) + Math.sign(Math.sin(2 * Math.PI * 800 * t));
        return sq * 0.36 * Math.exp(-t * 11.5);
      }
    }
  ];

  return specs.map((sp, slotHint) => {
    const buffer = makeBuf(audioCtx, sp.dur, sp.fn);
    return registerEntry({
      id: `808_${slotHint}`,
      name: sp.name,
      bank: '808',
      slotHint,
      buffer,
      peaks: computePeaks(buffer),
      duration: buffer.duration
    });
  });
}

export function ensureFactoryDrumKits(audioCtx) {
  if (!audioCtx) return;
  if (!initialized) {
    initialized = true;
    create909Bank(audioCtx);
    create808Bank(audioCtx);
  }
  if (!authenticLoaded && !authenticStarted) {
    loadAuthenticDrumKits(audioCtx);
  }
}

export function getSamplePool() {
  return samplePool;
}

export function getSampleById(id) {
  return sampleById.get(id) || null;
}

export function addUserSampleBuffer(name, audioBuffer, bank = 'USER') {
  const cleanName = String(name || 'SMP')
    .replace(/\.[^.]+$/, '')
    .toUpperCase()
    .slice(0, 12);
  const entry = registerEntry({
    id: `usr_${poolUid++}`,
    name: cleanName,
    bank,
    slotHint: null,
    buffer: audioBuffer,
    peaks: computePeaks(audioBuffer),
    duration: audioBuffer.duration
  });
  return entry;
}

export function buildKitAssignment(kitName) {
  const pool909 = samplePool.filter((s) => s.bank === '909');
  const pool808 = samplePool.filter((s) => s.bank === '808');
  const userPool = samplePool.filter((s) => s.bank === 'USER');

  if (kitName === '909') return pool909.slice(0, 8);
  if (kitName === '808') return pool808.slice(0, 8);

  if (kitName === 'RAND') {
    const all = userPool.length > 0 ? [...userPool, ...pool909, ...pool808] : samplePool;
    const out = [];
    for (let i = 0; i < 8; i++) {
      // Favor user-loaded samples if present in pool, while mixing full pool
      const sourcePool = userPool.length > 0 && Math.random() < 0.65 ? userPool : all;
      out.push(sourcePool[Math.floor(Math.random() * sourcePool.length)]);
    }
    return out;
  }

  // COMBO: blend 909, 808, and any user pool sounds per slot
  const out = [];
  for (let i = 0; i < 8; i++) {
    if (userPool.length > 0 && Math.random() < 0.35) {
      out.push(userPool[Math.floor(Math.random() * userPool.length)]);
    } else {
      const pick909 = Math.random() < 0.5;
      out.push((pick909 ? pool909[i] : pool808[i]) || pool909[i] || pool808[i]);
    }
  }
  return out;
}

export function getReversedBuffer(audioCtx, buffer) {
  if (!audioCtx || !buffer) return buffer;
  if (reversedCache.has(buffer)) return reversedCache.get(buffer);
  const rev = audioCtx.createBuffer(buffer.numberOfChannels, buffer.length, buffer.sampleRate);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const src = buffer.getChannelData(c);
    const dst = rev.getChannelData(c);
    for (let i = 0, n = src.length; i < n; i++) {
      dst[i] = src[n - 1 - i];
    }
  }
  reversedCache.set(buffer, rev);
  return rev;
}
