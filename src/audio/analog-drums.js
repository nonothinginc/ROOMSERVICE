// Authentic WebAudio Virtual Analog Drum Circuit Synthesis
// Inspired by vincentriemer/io-808 and classic TR-909 analog schematics.

const noiseBufCache = new WeakMap();

function getNoiseBuffers(rawCtx) {
  if (noiseBufCache.has(rawCtx)) return noiseBufCache.get(rawCtx);
  const sr = rawCtx.sampleRate || 44100;
  const len = Math.floor(sr * 1.5);
  const white = rawCtx.createBuffer(1, len, sr);
  const pink = rawCtx.createBuffer(1, len, sr);
  const wData = white.getChannelData(0);
  const pData = pink.getChannelData(0);

  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < len; i++) {
    const wn = Math.random() * 2 - 1;
    wData[i] = wn;
    b0 = 0.99886 * b0 + wn * 0.0555179;
    b1 = 0.99332 * b1 + wn * 0.0750759;
    b2 = 0.96900 * b2 + wn * 0.1538520;
    b3 = 0.86650 * b3 + wn * 0.3104856;
    b4 = 0.55000 * b4 + wn * 0.5329522;
    b5 = -0.7616 * b5 - wn * 0.0168980;
    pData[i] = Math.max(-1, Math.min(1, (b0 + b1 + b2 + b3 + b4 + b5 + b6 + wn * 0.5362) * 0.11));
    b6 = wn * 0.115926;
  }

  const pair = { white, pink };
  noiseBufCache.set(rawCtx, pair);
  return pair;
}

const softClipCache = new WeakMap();
function getSoftClipCurve() {
  const key = globalThis;
  if (softClipCache.has(key)) return softClipCache.get(key);
  const n = 256;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * 1.65) / Math.tanh(1.65);
  }
  softClipCache.set(key, curve);
  return curve;
}

function scheduleCleanup(nodes, endDelayMs) {
  const ms = Math.max(120, Math.min(4000, Math.round(endDelayMs)));
  setTimeout(() => {
    for (const n of nodes) {
      try {
        n.disconnect();
      } catch {
        // ignore
      }
    }
  }, ms);
}

function createPulseClick(rawCtx, t, dest, level = 0.35, cutoffHz = 2200) {
  const osc = rawCtx.createOscillator();
  const filt = rawCtx.createBiquadFilter();
  const gain = rawCtx.createGain();
  osc.type = 'triangle';
  osc.frequency.setValueAtTime(1400, t);
  osc.frequency.exponentialRampToValueAtTime(180, t + 0.008);
  filt.type = 'lowpass';
  filt.frequency.setValueAtTime(cutoffHz, t);
  gain.gain.setValueAtTime(level, t);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.012);
  osc.connect(filt);
  filt.connect(gain);
  gain.connect(dest);
  osc.start(t);
  osc.stop(t + 0.014);
  return [osc, filt, gain];
}

function createNoiseBurst(rawCtx, buf, t, durSec, filterType, freq, q, gainVal, dest) {
  const src = rawCtx.createBufferSource();
  src.buffer = buf;
  const filt = rawCtx.createBiquadFilter();
  filt.type = filterType;
  filt.frequency.setValueAtTime(freq, t);
  filt.Q.setValueAtTime(q, t);
  const g = rawCtx.createGain();
  g.gain.setValueAtTime(Math.max(0.0001, gainVal), t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + durSec);
  src.connect(filt);
  filt.connect(g);
  g.connect(dest);
  src.start(t);
  src.stop(t + durSec + 0.01);
  return [src, filt, g];
}

function createOscBank(rawCtx, freqs, t, stopAt, dest, amp = 0.2) {
  const out = rawCtx.createGain();
  out.gain.setValueAtTime(amp, t);
  out.connect(dest);
  const nodes = [out];
  for (const f of freqs) {
    const osc = rawCtx.createOscillator();
    osc.type = 'square';
    osc.frequency.setValueAtTime(f, t);
    osc.connect(out);
    osc.start(t);
    osc.stop(stopAt);
    nodes.push(osc);
  }
  return nodes;
}

export function triggerVA808(rawCtx, dest, voiceIdx, time, vel = 0.85, opts = {}) {
  const { tune = 0, decay = 1.0, pitchEnv = 0 } = opts;
  const pitchMult = Math.pow(2, tune / 12);
  const decMult = Math.max(0.15, Math.min(2.4, decay));
  const noises = getNoiseBuffers(rawCtx);
  const cleanup = [];
  let maxDur = 0.5;

  switch (voiceIdx) {
    case 0: {
      // 808 Bass Drum: sub sine VCO + exponential pitch envelope + PulseTrigger + warm clip
      const d = 0.42 * decMult;
      maxDur = d + 0.06;
      const vco = rawCtx.createOscillator();
      vco.type = 'sine';
      const baseF = 47 * pitchMult;
      const startF = Math.max(30, baseF * Math.pow(2, (12 + pitchEnv) / 12));
      vco.frequency.setValueAtTime(startF, time);
      vco.frequency.exponentialRampToValueAtTime(baseF, time + 0.09);

      const vca = rawCtx.createGain();
      vca.gain.setValueAtTime(0.001, time);
      vca.gain.linearRampToValueAtTime(vel * 1.1, time + 0.002);
      vca.gain.exponentialRampToValueAtTime(0.0008, time + d);

      const vcf = rawCtx.createBiquadFilter();
      vcf.type = 'lowpass';
      vcf.frequency.setValueAtTime(420, time);
      vcf.Q.setValueAtTime(1.1, time);

      const clip = rawCtx.createWaveShaper();
      clip.curve = getSoftClipCurve();

      vco.connect(vca);
      vca.connect(vcf);
      vcf.connect(clip);
      clip.connect(dest);
      vco.start(time);
      vco.stop(time + maxDur);

      cleanup.push(vco, vca, vcf, clip, ...createPulseClick(rawCtx, time, vcf, vel * 0.36, 1800));
      break;
    }

    case 1: {
      // 808 Snare: dual bridged-T sine resonators (476Hz + 238Hz) + HPF white noise snappy
      const d = 0.16 * decMult;
      maxDur = d + 0.05;
      const bodyVca = rawCtx.createGain();
      bodyVca.gain.setValueAtTime(vel * 0.65, time);
      bodyVca.gain.exponentialRampToValueAtTime(0.0005, time + 0.065 * Math.min(1.5, decMult));
      bodyVca.connect(dest);

      for (const f of [238, 476]) {
        const osc = rawCtx.createOscillator();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(f * pitchMult, time);
        osc.connect(bodyVca);
        osc.start(time);
        osc.stop(time + 0.12);
        cleanup.push(osc);
      }
      cleanup.push(bodyVca, ...createNoiseBurst(rawCtx, noises.white, time, d, 'highpass', 1650 * pitchMult, 0.7, vel * 0.68, dest));
      break;
    }

    case 2: {
      // 808 Handclap (io-808 maracasHandclap): 1kHz BP white noise + 3 sawtooth bursts + tail
      const tailDur = 0.19 * decMult;
      maxDur = tailDur + 0.05;
      const src = rawCtx.createBufferSource();
      src.buffer = noises.white;
      const bp = rawCtx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.setValueAtTime(1050 * pitchMult, time);
      bp.Q.setValueAtTime(2.1, time);

      const vca = rawCtx.createGain();
      vca.gain.setValueAtTime(0.0001, time);
      // 3 crisp retrigger bursts at 0, 10ms, 20ms then reverb decay
      [0, 0.010, 0.020].forEach((off) => {
        vca.gain.setValueAtTime(vel * 0.95, time + off);
        vca.gain.linearRampToValueAtTime(vel * 0.12, time + off + 0.0085);
      });
      vca.gain.setValueAtTime(vel * 0.72, time + 0.029);
      vca.gain.exponentialRampToValueAtTime(0.0005, time + 0.029 + tailDur);

      src.connect(bp);
      bp.connect(vca);
      vca.connect(dest);
      src.start(time);
      src.stop(time + maxDur);
      cleanup.push(src, bp, vca);
      break;
    }

    case 3:
    case 4: {
      // 808 Closed / Open Hat (io-808 squareOscBank 6-osc metallic -> BP 10k -> VCA -> HP 8k)
      const isOpen = voiceIdx === 4;
      const d = (isOpen ? 0.34 : 0.052) * decMult;
      maxDur = d + 0.04;
      const freqs = [263, 400, 421, 474, 587, 845].map((f) => f * pitchMult);
      const bp = rawCtx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.setValueAtTime(10000, time);
      bp.Q.setValueAtTime(1.1, time);

      const vca = rawCtx.createGain();
      vca.gain.setValueAtTime(vel * 0.85, time);
      vca.gain.exponentialRampToValueAtTime(0.0005, time + d);

      const hp = rawCtx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.setValueAtTime(7600, time);

      const bank = createOscBank(rawCtx, freqs, time, time + maxDur, bp, 0.24);
      bp.connect(vca);
      vca.connect(hp);
      hp.connect(dest);
      cleanup.push(...bank, bp, vca, hp);
      break;
    }

    case 5: {
      // 808 Clave / Rimshot: resonant dual triangle/sine click
      const d = 0.06 * Math.min(1.5, decMult);
      maxDur = d + 0.03;
      const osc = rawCtx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(2480 * pitchMult, time);
      const bp = rawCtx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.setValueAtTime(2480 * pitchMult, time);
      bp.Q.setValueAtTime(3.2, time);
      const vca = rawCtx.createGain();
      vca.gain.setValueAtTime(vel * 0.88, time);
      vca.gain.exponentialRampToValueAtTime(0.0005, time + d);
      osc.connect(bp);
      bp.connect(vca);
      vca.connect(dest);
      osc.start(time);
      osc.stop(time + maxDur);
      cleanup.push(osc, bp, vca);
      break;
    }

    case 6: {
      // 808 Low Tom: pitch-swept sine + click + soft pink thump
      const d = 0.24 * decMult;
      maxDur = d + 0.05;
      const osc = rawCtx.createOscillator();
      osc.type = 'sine';
      const baseF = 80 * pitchMult;
      osc.frequency.setValueAtTime(baseF * Math.pow(2, (7 + pitchEnv) / 12), time);
      osc.frequency.exponentialRampToValueAtTime(baseF, time + 0.08);
      const vca = rawCtx.createGain();
      vca.gain.setValueAtTime(vel * 0.92, time);
      vca.gain.exponentialRampToValueAtTime(0.0005, time + d);
      osc.connect(vca);
      vca.connect(dest);
      osc.start(time);
      osc.stop(time + maxDur);
      cleanup.push(
        osc,
        vca,
        ...createPulseClick(rawCtx, time, dest, vel * 0.22, 1200),
        ...createNoiseBurst(rawCtx, noises.pink, time, 0.11 * decMult, 'lowpass', 1800, 0.7, vel * 0.16, dest)
      );
      break;
    }

    case 7: {
      // 808 Cowbell (io-808): 540Hz + 800Hz square waves -> dual short/long VCA -> BP 2640Hz
      const d = 0.34 * decMult;
      maxDur = d + 0.04;
      const bp = rawCtx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.setValueAtTime(2640 * pitchMult, time);
      bp.Q.setValueAtTime(1.6, time);
      bp.connect(dest);

      const vca = rawCtx.createGain();
      vca.gain.setValueAtTime(vel * 0.75, time);
      vca.gain.linearRampToValueAtTime(vel * 0.22, time + 0.016);
      vca.gain.exponentialRampToValueAtTime(0.0005, time + d);
      vca.connect(bp);

      for (const f of [540, 800]) {
        const osc = rawCtx.createOscillator();
        osc.type = 'square';
        osc.frequency.setValueAtTime(f * pitchMult, time);
        osc.connect(vca);
        osc.start(time);
        osc.stop(time + maxDur);
        cleanup.push(osc);
      }
      cleanup.push(bp, vca);
      break;
    }
  }

  scheduleCleanup(cleanup, (time - rawCtx.currentTime + maxDur) * 1000 + 180);
}

export function triggerVA909(rawCtx, dest, voiceIdx, time, vel = 0.85, opts = {}) {
  const { tune = 0, decay = 1.0, pitchEnv = 0 } = opts;
  const pitchMult = Math.pow(2, tune / 12);
  const decMult = Math.max(0.15, Math.min(2.4, decay));
  const noises = getNoiseBuffers(rawCtx);
  const cleanup = [];
  let maxDur = 0.45;

  switch (voiceIdx) {
    case 0: {
      // 909 Kick: punchy triangle/sine sweep (195 -> 50 Hz) + 1.8kHz transient snap + clip
      const d = 0.29 * decMult;
      maxDur = d + 0.05;
      const osc = rawCtx.createOscillator();
      osc.type = 'triangle';
      const baseF = 50 * pitchMult;
      const startF = Math.max(40, 195 * pitchMult * Math.pow(2, pitchEnv / 12));
      osc.frequency.setValueAtTime(startF, time);
      osc.frequency.exponentialRampToValueAtTime(baseF * 1.4, time + 0.025);
      osc.frequency.exponentialRampToValueAtTime(baseF, time + 0.09);

      const lp = rawCtx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(680, time);
      lp.Q.setValueAtTime(1.4, time);

      const vca = rawCtx.createGain();
      vca.gain.setValueAtTime(0.001, time);
      vca.gain.linearRampToValueAtTime(vel * 1.15, time + 0.0015);
      vca.gain.exponentialRampToValueAtTime(0.0008, time + d);

      const clip = rawCtx.createWaveShaper();
      clip.curve = getSoftClipCurve();

      osc.connect(lp);
      lp.connect(vca);
      vca.connect(clip);
      clip.connect(dest);
      osc.start(time);
      osc.stop(time + maxDur);

      cleanup.push(
        osc,
        lp,
        vca,
        clip,
        ...createNoiseBurst(rawCtx, noises.white, time, 0.016, 'bandpass', 1900, 1.2, vel * 0.48, clip)
      );
      break;
    }

    case 1: {
      // 909 Snare: dual pitched triangle resonators (185 + 330 Hz) + LP-snappy noise
      const d = 0.18 * decMult;
      maxDur = d + 0.05;
      const bodyVca = rawCtx.createGain();
      bodyVca.gain.setValueAtTime(vel * 0.72, time);
      bodyVca.gain.exponentialRampToValueAtTime(0.0005, time + 0.085 * Math.min(1.5, decMult));
      bodyVca.connect(dest);

      for (const f of [185, 330]) {
        const osc = rawCtx.createOscillator();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(f * 1.25 * pitchMult, time);
        osc.frequency.exponentialRampToValueAtTime(f * pitchMult, time + 0.035);
        osc.connect(bodyVca);
        osc.start(time);
        osc.stop(time + 0.14);
        cleanup.push(osc);
      }
      cleanup.push(bodyVca, ...createNoiseBurst(rawCtx, noises.white, time, d, 'bandpass', 3600 * pitchMult, 0.75, vel * 0.78, dest));
      break;
    }

    case 2: {
      // 909 Clap: crisp 9ms multi-burst + 1.45kHz bright bandpass tail
      const tailDur = 0.21 * decMult;
      maxDur = tailDur + 0.05;
      const src = rawCtx.createBufferSource();
      src.buffer = noises.pink;
      const bp = rawCtx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.setValueAtTime(1450 * pitchMult, time);
      bp.Q.setValueAtTime(1.5, time);

      const vca = rawCtx.createGain();
      vca.gain.setValueAtTime(0.0001, time);
      [0, 0.009, 0.018].forEach((off) => {
        vca.gain.setValueAtTime(vel * 0.98, time + off);
        vca.gain.linearRampToValueAtTime(vel * 0.15, time + off + 0.0075);
      });
      vca.gain.setValueAtTime(vel * 0.78, time + 0.027);
      vca.gain.exponentialRampToValueAtTime(0.0005, time + 0.027 + tailDur);

      src.connect(bp);
      bp.connect(vca);
      vca.connect(dest);
      src.start(time);
      src.stop(time + maxDur);
      cleanup.push(src, bp, vca);
      break;
    }

    case 3:
    case 4: {
      // 909 Hats: metallic 6-osc square bank + bright HPF noise transient
      const isOpen = voiceIdx === 4;
      const d = (isOpen ? 0.38 : 0.055) * decMult;
      maxDur = d + 0.04;
      const freqs = [310, 465, 512, 620, 740, 1020].map((f) => f * pitchMult);
      const hp = rawCtx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.setValueAtTime(6800, time);
      const vca = rawCtx.createGain();
      vca.gain.setValueAtTime(vel * 0.85, time);
      vca.gain.exponentialRampToValueAtTime(0.0005, time + d);

      const bank = createOscBank(rawCtx, freqs, time, time + maxDur, hp, 0.19);
      hp.connect(vca);
      vca.connect(dest);
      cleanup.push(
        ...bank,
        hp,
        vca,
        ...createNoiseBurst(rawCtx, noises.white, time, d * 0.85, 'highpass', 7200, 0.8, vel * 0.45, dest)
      );
      break;
    }

    case 5: {
      // 909 Rimshot: 470 Hz + 1680 Hz sharp metallic pulse
      const d = 0.055 * Math.min(1.5, decMult);
      maxDur = d + 0.03;
      const bp = rawCtx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.setValueAtTime(1250 * pitchMult, time);
      bp.Q.setValueAtTime(1.8, time);
      const vca = rawCtx.createGain();
      vca.gain.setValueAtTime(vel * 0.9, time);
      vca.gain.exponentialRampToValueAtTime(0.0005, time + d);
      bp.connect(vca);
      vca.connect(dest);

      for (const f of [470, 1680]) {
        const osc = rawCtx.createOscillator();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(f * pitchMult, time);
        osc.connect(bp);
        osc.start(time);
        osc.stop(time + maxDur);
        cleanup.push(osc);
      }
      cleanup.push(bp, vca);
      break;
    }

    case 6: {
      // 909 Tom: punchy analog sweep (175 -> 82 Hz)
      const d = 0.25 * decMult;
      maxDur = d + 0.05;
      const osc = rawCtx.createOscillator();
      osc.type = 'sine';
      const baseF = 82 * pitchMult;
      osc.frequency.setValueAtTime(175 * pitchMult * Math.pow(2, pitchEnv / 12), time);
      osc.frequency.exponentialRampToValueAtTime(baseF, time + 0.075);
      const vca = rawCtx.createGain();
      vca.gain.setValueAtTime(vel * 0.94, time);
      vca.gain.exponentialRampToValueAtTime(0.0005, time + d);
      osc.connect(vca);
      vca.connect(dest);
      osc.start(time);
      osc.stop(time + maxDur);
      cleanup.push(osc, vca, ...createPulseClick(rawCtx, time, dest, vel * 0.26, 1500));
      break;
    }

    case 7: {
      // 909 Ride / Metallic Perc: 6-osc shimmer bank -> resonant 4.2kHz bandpass
      const d = 0.42 * decMult;
      maxDur = d + 0.05;
      const freqs = [580, 815, 1140, 1480, 1920, 2410].map((f) => f * pitchMult);
      const bp = rawCtx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.setValueAtTime(4200, time);
      bp.Q.setValueAtTime(1.4, time);
      const vca = rawCtx.createGain();
      vca.gain.setValueAtTime(vel * 0.72, time);
      vca.gain.exponentialRampToValueAtTime(0.0005, time + d);
      const bank = createOscBank(rawCtx, freqs, time, time + maxDur, bp, 0.2);
      bp.connect(vca);
      vca.connect(dest);
      cleanup.push(...bank, bp, vca);
      break;
    }
  }

  scheduleCleanup(cleanup, (time - rawCtx.currentTime + maxDur) * 1000 + 180);
}

/* ------------------------------------------------------------------------------------------
 * Render cache: a circuit voice is deterministic for given (circuit, voice, tune, decay,
 * pitch-env, velocity layer), so it is rendered once offline and replayed as a single buffer
 * source per hit instead of building 10-40 nodes per hit on the main thread.
 * ---------------------------------------------------------------------------------------- */
const vaCache = new Map(); // key -> AudioBuffer | Promise
const VA_CACHE_MAX = 192;
const VEL_LAYERS = [0.55, 1.0];

export function vaVelLayer(vel) {
  return vel < 0.75 ? 0 : 1;
}

function vaKey(circuit, idx, layer, opts) {
  return `${circuit}|${idx}|${layer}|${(opts.tune || 0).toFixed(2)}|${(opts.decay ?? 1).toFixed(2)}|${opts.pitchEnv || 0}`;
}

/** Cached buffer for this voice, or null (and a background render is started). */
export function getVaBuffer(sampleRate, circuit, idx, vel, opts) {
  const layer = vaVelLayer(vel);
  const key = vaKey(circuit, idx, layer, opts);
  const hit = vaCache.get(key);
  if (hit instanceof AudioBuffer) {
    vaCache.delete(key);
    vaCache.set(key, hit); // LRU touch
    return { buffer: hit, layerVel: VEL_LAYERS[layer] };
  }
  if (!hit) {
    const p = renderVa(sampleRate, circuit, idx, VEL_LAYERS[layer], opts)
      .then((buf) => {
        vaCache.set(key, buf);
        while (vaCache.size > VA_CACHE_MAX) vaCache.delete(vaCache.keys().next().value);
        return buf;
      })
      .catch(() => vaCache.delete(key));
    vaCache.set(key, p);
  }
  return null;
}

async function renderVa(sampleRate, circuit, idx, vel, opts) {
  const dur = Math.min(3.2, 0.7 + 1.3 * (opts.decay ?? 1));
  const off = new OfflineAudioContext(2, Math.ceil(sampleRate * dur), sampleRate);
  (circuit === 808 ? triggerVA808 : triggerVA909)(off, off.destination, idx, 0, vel, opts);
  const buf = await off.startRendering();
  // Trim the silent tail so replay sources end as early as the live voice would
  const a = buf.getChannelData(0);
  const b = buf.getChannelData(1);
  let end = a.length - 1;
  while (end > 0 && Math.abs(a[end]) < 1e-4 && Math.abs(b[end]) < 1e-4) end--;
  const len = Math.min(a.length, end + Math.ceil(sampleRate * 0.01));
  const out = new AudioBuffer({ length: len, numberOfChannels: 2, sampleRate });
  out.copyToChannel(a.subarray(0, len), 0);
  out.copyToChannel(b.subarray(0, len), 1);
  return out;
}
