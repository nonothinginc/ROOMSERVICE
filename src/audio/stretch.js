/**
 * Audio-thread time-stretch for playlist audio clips (BEATS / TONES / TEXTURE warp modes).
 *
 * Replaces Tone.GrainPlayer, whose grains are scheduled from the main thread (every grain is a
 * new node created by JS, so UI jank or GC = audible stutter). Here a single AudioWorkletNode per
 * (clip, direction, lane) holds the sample once; a trigger is one message; grains are
 * Hann-windowed overlap-add computed on the audio thread with no allocation in process().
 *
 * rate  = timeline speed through the source (project BPM / clip BPM) -> tempo
 * pitch = grain read speed (2^(semitones/12))                        -> pitch, independent of tempo
 * When rate ≈ 1 and pitch ≈ 1 the voice reads the source directly (no grains, no artefacts).
 */

const WORKLET = String.raw`
const MAX_VOICES = 4;
const MAX_GRAINS = 8;

class StretchVoices extends AudioWorkletProcessor {
  constructor() {
    super();
    this.L = null; this.R = null; this.len = 0;
    this.voices = [];
    for (let v = 0; v < MAX_VOICES; v++) {
      const grains = [];
      for (let g = 0; g < MAX_GRAINS; g++) grains.push({ on: false, src: 0, i: 0 });
      this.voices.push({ on: false, id: 0, start: 0, end: 0, stopAt: Infinity, pos: 0, rate: 1, pitch: 1,
        G: 1536, hop: 768, norm: 1, spray: 0, direct: false, sinceHop: 0, gain: 1, fadeIn: 0, fadeOut: 0,
        into: 0, t: 0, grains, seed: 1 + v * 7919 });
    }
    this.port.onmessage = (e) => this.onMsg(e.data);
  }

  onMsg(m) {
    if (m.type === 'load') {
      this.L = m.L; this.R = m.R || m.L; this.len = m.L.length;
    } else if (m.type === 'play') {
      const start = Math.round(m.when * sampleRate);
      // A re-trigger of the same clip (loop wrap / re-sync): the old voice ends exactly where the
      // new one begins, so there is no gap at the seam
      let prev = null;
      for (const x of this.voices) if (x.on && x.id === m.id) { prev = x; x.stopAt = Math.min(x.stopAt, start); }
      let v = this.voices.find((x) => !x.on);
      if (!v) v = this.voices.filter((x) => x !== prev).reduce((a, b) => (a.start < b.start ? a : b));
      v.on = true; v.id = m.id;
      v.start = start;
      v.end = v.start + Math.max(1, Math.round(m.durFrames));
      v.stopAt = Infinity;
      v.pos = m.offset; v.rate = m.rate; v.pitch = m.pitch;
      v.G = m.grain; v.hop = m.hop; v.norm = m.norm; v.spray = m.spray;
      v.direct = Math.abs(m.rate - 1) < 0.002 && Math.abs(m.pitch - 1) < 0.002;
      v.sinceHop = v.hop; v.gain = m.gain; v.fadeIn = m.fadeIn; v.fadeOut = m.fadeOut;
      v.into = m.into || 0; v.t = 0;
      for (const g of v.grains) g.on = false;
    } else if (m.type === 'stop') {
      for (const v of this.voices) if (v.on && (m.id == null || v.id === m.id)) v.stopAt = Math.round(m.when * sampleRate);
    }
  }

  rnd(v) {
    v.seed = (v.seed * 1103515245 + 12345) & 0x7fffffff;
    return v.seed / 0x7fffffff;
  }

  read(buf, p) {
    if (p < 0 || p >= this.len - 1) return 0;
    const i = p | 0;
    const f = p - i;
    return buf[i] + (buf[i + 1] - buf[i]) * f;
  }

  process(_in, outputs) {
    const out = outputs[0];
    const oL = out[0];
    const oR = out[1] || out[0];
    const n = oL.length;
    oL.fill(0);
    if (oR !== oL) oR.fill(0);
    if (!this.L) return true;
    const frame0 = currentFrame;

    for (let vi = 0; vi < this.voices.length; vi++) {
      const v = this.voices[vi];
      if (!v.on) continue;
      if (frame0 + n <= v.start) continue;
      const total = v.end - v.start;
      for (let s = 0; s < n; s++) {
        const f = frame0 + s;
        if (f < v.start) continue;
        if (f >= v.end || f >= v.stopAt + 64) { v.on = false; break; }

        // Envelope: clip gain, fades (in counts from the clip start incl. re-sync offset), de-click
        const fromStart = v.t + v.into;
        const toEnd = total - v.t;
        let env = v.gain;
        if (v.fadeIn > 0 && fromStart < v.fadeIn) env *= fromStart / v.fadeIn;
        if (v.fadeOut > 0 && toEnd < v.fadeOut) env *= toEnd / v.fadeOut;
        else if (toEnd < 192) env *= toEnd / 192;
        if (f >= v.stopAt) env *= Math.max(0, 1 - (f - v.stopAt) / 64);

        let l = 0, r = 0;
        if (v.direct) {
          l = this.read(this.L, v.pos);
          r = this.read(this.R, v.pos);
        } else {
          if (v.sinceHop >= v.hop) {
            v.sinceHop = 0;
            for (let gi = 0; gi < v.grains.length; gi++) {
              const g = v.grains[gi];
              if (g.on) continue;
              g.on = true; g.i = 0;
              g.src = v.pos + (v.spray > 0 ? (this.rnd(v) - 0.5) * v.spray * v.G : 0);
              break;
            }
          }
          v.sinceHop++;
          const G = v.G;
          for (let gi = 0; gi < v.grains.length; gi++) {
            const g = v.grains[gi];
            if (!g.on) continue;
            // Periodic Hann window: overlapping copies at hop = G/2 sum to 1
            const w = 0.5 - 0.5 * Math.cos((6.283185307179586 * g.i) / G);
            const p = g.src + g.i * v.pitch;
            l += this.read(this.L, p) * w;
            r += this.read(this.R, p) * w;
            if (++g.i >= G) g.on = false;
          }
          l *= v.norm; r *= v.norm;
        }
        oL[s] += l * env;
        if (oR !== oL) oR[s] += r * env;
        v.pos += v.rate;
        v.t++;
      }
    }
    return true;
  }
}
registerProcessor('roomservice-stretch', StretchVoices);
`;

const MODES = {
  BEATS: { grainMs: 32, overlap: 2 },
  TONES: { grainMs: 70, overlap: 2 },
  TEXTURE: { grainMs: 140, overlap: 4 }
};

let ready = null;

export function loadStretchWorklet(ctx) {
  if (ready) return ready;
  const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
  ready = ctx.audioWorklet
    .addModule(url)
    .then(() => true)
    .catch((err) => {
      console.warn('[stretch] worklet unavailable, falling back to GrainPlayer', err);
      return false;
    })
    .finally(() => URL.revokeObjectURL(url));
  return ready;
}

/** One stretch node per (audio clip, direction, lane): the sample is copied to the audio thread once. */
export class StretchBanks {
  constructor(ctx) {
    this.ctx = ctx;
    this.ok = false;
    this.banks = new Map(); // key -> { node, lastUsed }
    loadStretchWorklet(ctx).then((ok) => {
      this.ok = ok;
    });
  }

  get(key, buffer, destination) {
    let b = this.banks.get(key);
    if (!b) {
      const node = new AudioWorkletNode(this.ctx, 'roomservice-stretch', {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2]
      });
      const L = buffer.getChannelData(0).slice();
      const R = buffer.numberOfChannels > 1 ? buffer.getChannelData(1).slice() : null;
      node.port.postMessage({ type: 'load', L, R }, R ? [L.buffer, R.buffer] : [L.buffer]);
      // Connected only while it has voices: idle worklets still cost a JS call per render quantum
      b = { node, dest: destination, connected: false, busyUntil: 0, lastUsed: 0 };
      this.banks.set(key, b);
      this.evict();
    }
    b.lastUsed = performance.now();
    return b.node;
  }

  /** Disconnect banks whose voices have all finished. */
  sweep(now) {
    for (const b of this.banks.values()) {
      if (b.connected && b.busyUntil < now) {
        try {
          b.node.disconnect();
        } catch {
          // ignore
        }
        b.connected = false;
      }
    }
  }

  bankFor(node) {
    for (const b of this.banks.values()) if (b.node === node) return b;
    return null;
  }

  /** Keep at most 24 banks; drop the least recently used. */
  evict() {
    if (this.banks.size <= 24) return;
    const oldest = [...this.banks.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
    try {
      oldest[1].node.disconnect();
    } catch {
      // ignore
    }
    this.banks.delete(oldest[0]);
  }

  play(node, { id, when, offsetSec, durSec, rate, semitones, mode, grainSize, spray, gainLin, fadeInSec, fadeOutSec, intoSec }) {
    const sr = this.ctx.sampleRate;
    const bank = this.bankFor(node);
    if (bank) {
      if (!bank.connected) {
        node.connect(bank.dest);
        bank.connected = true;
      }
      bank.busyUntil = Math.max(bank.busyUntil, when + durSec + 0.25);
    }
    const m = MODES[mode] || MODES.BEATS;
    const grainMs = mode === 'TEXTURE' && grainSize ? grainSize * 1000 : m.grainMs;
    const G = Math.max(256, Math.round((grainMs / 1000) * sr));
    const hop = Math.max(64, Math.floor(G / m.overlap));
    node.port.postMessage({
      type: 'play',
      id,
      when,
      offset: offsetSec * sr,
      durFrames: durSec * sr,
      rate,
      pitch: Math.pow(2, (semitones || 0) / 12),
      grain: G,
      hop,
      // Hann at hop G/k sums to k/2; ×1.25 makes up the ~2 dB granular OLA loses on decorrelated grains
      norm: (2 / m.overlap) * 1.25,
      spray: mode === 'TEXTURE' ? Math.min(1, (spray || 0) / 100) : 0,
      gain: gainLin,
      fadeIn: fadeInSec * sr,
      fadeOut: fadeOutSec * sr,
      into: intoSec * sr
    });
  }

  stop(node, id, when) {
    node.port.postMessage({ type: 'stop', id, when });
  }
}
