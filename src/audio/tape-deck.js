/**
 * TAPE DECK: a performable tape machine on the master bus.
 *
 * The worklet always records the master into a 24 s stereo loop of "tape". Idle, it is a
 * zero-latency pass-through. While a manipulation is held, the output is read from the tape
 * with real transport physics (inertia, brake, varispeed, reverse, scrub, stutter loop) and
 * crossfades back to live on release ("slip"), so the song never loses its place.
 * AGE (wow/flutter) and DRIVE (soft saturation) colour the output; PRINT captures the
 * deck output so performances become playlist clips.
 */

const WORKLET = String.raw`
const TAPE_SECONDS = 24;
const PEAK_BLOCK = 256;

class TapeDeck extends AudioWorkletProcessor {
  constructor() {
    super();
    this.N = Math.floor(sampleRate * TAPE_SECONDS);
    this.L = new Float32Array(this.N);
    this.R = new Float32Array(this.N);
    this.wp = 0;            // absolute samples written
    this.rp = 0;            // absolute read position (float)
    this.v = 1;             // current tape speed
    this.target = 1;        // target speed
    this.mode = 'live';     // live | stop | rev | back | vari | scrub | loop
    this.mix = 0;           // 0 = live input, 1 = tape read
    this.loopA = 0; this.loopLen = 0;
    this.age = 0; this.drive = 0; this.wowPh = 0; this.flPh = 0;
    this.printing = false; this.printBufL = []; this.printBufR = []; this.printFrames = 0; this.printChunkL = null; this.printChunkR = null; this.printFill = 0;
    this.peakAcc = 0; this.peakCount = 0; this.newPeaks = [];
    this.telemetryEvery = Math.round(sampleRate / 60 / 128); this.blockCount = 0;
    this.outPeak = 0;
    this.port.onmessage = (e) => this.onMsg(e.data);
  }

  onMsg(m) {
    if (m.type === 'mode') {
      const prev = this.mode;
      this.mode = m.mode;
      if (m.mode === 'live') {
        this.target = 1;
      } else {
        if (prev === 'live') { this.rp = this.wp - 1; this.v = 1; }
        if (m.mode === 'stop') this.target = 0;
        if (m.mode === 'rev') this.target = -1;
        if (m.mode === 'back') this.target = -3.2;
        if (m.mode === 'vari') this.target = m.speed ?? 1;
        if (m.mode === 'scrub') this.target = 0;
        if (m.mode === 'loop') {
          this.loopLen = Math.max(256, Math.floor(m.seconds * sampleRate));
          this.loopA = Math.max(this.wp - this.N + 1024, this.rp - this.loopLen);
          this.target = 1;
        }
      }
    } else if (m.type === 'speed') {
      this.target = m.speed;
    } else if (m.type === 'scrub') {
      this.target = m.speed;
    } else if (m.type === 'tone') {
      if (m.age != null) this.age = m.age;
      if (m.drive != null) this.drive = m.drive;
    } else if (m.type === 'print') {
      this.printing = Boolean(m.on);
      if (this.printing) { this.printFrames = 0; this.printChunkL = new Float32Array(16384); this.printChunkR = new Float32Array(16384); this.printFill = 0; }
      else this.flushPrint(true);
    }
  }

  flushPrint(final) {
    if (this.printChunkL && this.printFill > 0) {
      this.port.postMessage({ type: 'print-chunk', l: this.printChunkL.slice(0, this.printFill), r: this.printChunkR.slice(0, this.printFill) });
    }
    this.printFill = 0;
    if (final) { this.port.postMessage({ type: 'print-end', frames: this.printFrames }); this.printChunkL = null; this.printChunkR = null; }
  }

  readAt(buf, pos) {
    // 4-point Hermite interpolation on the circular tape
    const N = this.N;
    const i = Math.floor(pos);
    const f = pos - i;
    const im1 = ((i - 1) % N + N) % N, i0 = (i % N + N) % N, i1 = (i0 + 1) % N, i2 = (i0 + 2) % N;
    const xm1 = buf[im1], x0 = buf[i0], x1 = buf[i1], x2 = buf[i2];
    const c1 = 0.5 * (x1 - xm1);
    const c2 = xm1 - 2.5 * x0 + 2 * x1 - 0.5 * x2;
    const c3 = 0.5 * (x2 - xm1) + 1.5 * (x0 - x1);
    return ((c3 * f + c2) * f + c1) * f + x0;
  }

  process(inputs, outputs) {
    const inp = inputs[0];
    const out = outputs[0];
    const inL = inp[0] || null;
    const inR = inp[1] || inL;
    const oL = out[0];
    const oR = out[1] || out[0];
    const n = oL.length;
    const N = this.N;
    const live = this.mode === 'live';
    const slew = this.mode === 'stop' ? 1 / (sampleRate * 0.55) : this.mode === 'scrub' ? 1 / (sampleRate * 0.03) : 1 / (sampleRate * 0.09);
    const mixTarget = live ? 0 : 1;
    const mixStep = 1 / 384;
    const ageDepth = this.age * 0.012;
    const dk = 1 + this.drive * 3; // like a real drive stage: louder and rounder, max ~4x into tanh
    const dNorm = Math.tanh(dk);

    for (let s = 0; s < n; s++) {
      const xl = inL ? inL[s] : 0;
      const xr = inR ? inR[s] : 0;
      const w = this.wp % N;
      this.L[w] = xl;
      this.R[w] = xr;
      this.wp++;

      // Transport physics: speed slews toward target (motor inertia / brake)
      const dv = this.target - this.v;
      this.v += Math.abs(dv) <= slew * 4 ? dv : Math.sign(dv) * slew * 4;

      let yl = xl, yr = xr;
      if (this.mix > 0 || !live) {
        let sp = this.v;
        if (ageDepth > 0) {
          this.wowPh += 0.55 / sampleRate; this.flPh += 7.3 / sampleRate;
          sp += ageDepth * (Math.sin(this.wowPh * 6.2832) * 0.8 + Math.sin(this.flPh * 6.2832) * 0.2);
        }
        if (!live || this.mix > 0) this.rp += live ? 1 : sp;
        if (this.mode === 'loop') {
          if (this.rp >= this.loopA + this.loopLen) this.rp -= this.loopLen;
        }
        // Stay on recorded tape: never read the future or overwritten past
        const maxR = this.wp - 3; // Hermite reads i+2: stay behind the write head
        const minR = this.wp - N + 4;
        if (this.rp > maxR) { this.rp = maxR; if (this.v > 1) this.v = 1; }
        if (this.rp < minR) { this.rp = minR; this.v = 0; }
        // Playback level follows tape speed (as on a real machine): a stopped head reads
        // silence, not a frozen sample (which would be a DC offset on the master)
        const lvl = live ? 1 : Math.min(1, Math.abs(sp) * 1.6);
        let tl = this.readAt(this.L, this.rp) * lvl;
        let tr = this.readAt(this.R, this.rp) * lvl;
        // Loop boundary de-click: short fade at the seam
        if (this.mode === 'loop') {
          const into = this.rp - this.loopA;
          const edge = Math.min(into, this.loopLen - into);
          if (edge < 96) { const g = Math.max(0, edge / 96); tl *= g; tr *= g; }
        }
        if (this.mix < mixTarget) this.mix = Math.min(1, this.mix + mixStep);
        else if (this.mix > mixTarget) this.mix = Math.max(0, this.mix - mixStep);
        yl = xl * (1 - this.mix) + tl * this.mix;
        yr = xr * (1 - this.mix) + tr * this.mix;
      } else {
        this.rp = this.wp - 1;
        this.v = 1;
      }
      if (live && this.mix <= 0) { this.rp = this.wp - 1; }

      if (this.drive > 0.001) {
        yl = Math.tanh(yl * dk) / dNorm;
        yr = Math.tanh(yr * dk) / dNorm;
      }
      oL[s] = yl;
      if (oR !== oL) oR[s] = yr;

      const a = Math.abs(yl) > Math.abs(yr) ? Math.abs(yl) : Math.abs(yr);
      if (a > this.outPeak) this.outPeak = a;
      const ain = Math.abs(xl) > Math.abs(xr) ? Math.abs(xl) : Math.abs(xr);
      if (ain > this.peakAcc) this.peakAcc = ain;
      if (++this.peakCount >= PEAK_BLOCK) { this.newPeaks.push(Math.min(255, Math.round(this.peakAcc * 255))); this.peakAcc = 0; this.peakCount = 0; }

      if (this.printing) {
        this.printChunkL[this.printFill] = yl;
        this.printChunkR[this.printFill] = yr;
        this.printFill++;
        this.printFrames++;
        if (this.printFill >= this.printChunkL.length) this.flushPrint(false);
      }
    }

    if (++this.blockCount >= this.telemetryEvery) {
      this.blockCount = 0;
      this.port.postMessage({
        type: 't', wp: this.wp, rp: this.rp, v: this.v, mode: this.mode, mix: this.mix,
        loopA: this.loopA, loopLen: this.loopLen, peaks: this.newPeaks, out: this.outPeak,
        printing: this.printing, printFrames: this.printFrames
      });
      this.newPeaks = [];
      this.outPeak = 0;
    }
    return true;
  }
}
registerProcessor('roomservice-tape-deck', TapeDeck);
`;

export const TAPE_SECONDS = 24;
export const PEAK_BLOCK = 256;
const PEAK_RING = Math.ceil((48000 * TAPE_SECONDS) / PEAK_BLOCK) + 64;

export function createTapeDeck(Tone, { onPrint } = {}) {
  const ctx = Tone.getContext().rawContext;
  const telemetry = {
    ready: false,
    wp: 0,
    rp: 0,
    v: 1,
    mode: 'live',
    mix: 0,
    loopA: 0,
    loopLen: 0,
    out: 0,
    printing: false,
    printFrames: 0,
    sampleRate: ctx.sampleRate,
    // Coarse peak history of the input (one byte per PEAK_BLOCK samples), indexed by absolute block
    peaks: new Uint8Array(PEAK_RING),
    peakHead: 0,
    tapeSecondsTotal: 0
  };
  let node = null;
  let printL = [];
  let printR = [];
  const state = { age: 0, drive: 0 };

  async function attach(from, to) {
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
    try {
      await ctx.audioWorklet.addModule(url);
      node = new AudioWorkletNode(ctx, 'roomservice-tape-deck', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2]
      });
      node.port.onmessage = (e) => {
        const d = e.data;
        if (d.type === 't') {
          telemetry.wp = d.wp;
          telemetry.rp = d.rp;
          telemetry.v = d.v;
          telemetry.mode = d.mode;
          telemetry.mix = d.mix;
          telemetry.loopA = d.loopA;
          telemetry.loopLen = d.loopLen;
          telemetry.out = d.out;
          telemetry.printing = d.printing;
          telemetry.printFrames = d.printFrames;
          for (const p of d.peaks) {
            telemetry.peaks[telemetry.peakHead % PEAK_RING] = p;
            telemetry.peakHead++;
          }
          telemetry.tapeSecondsTotal = d.wp / ctx.sampleRate;
        } else if (d.type === 'print-chunk') {
          printL.push(d.l);
          printR.push(d.r);
        } else if (d.type === 'print-end') {
          const frames = printL.reduce((a, c) => a + c.length, 0);
          if (frames > ctx.sampleRate * 0.25) {
            const buf = ctx.createBuffer(2, frames, ctx.sampleRate);
            let o = 0;
            for (let i = 0; i < printL.length; i++) {
              buf.getChannelData(0).set(printL[i], o);
              buf.getChannelData(1).set(printR[i], o);
              o += printL[i].length;
            }
            onPrint?.(buf);
          }
          printL = [];
          printR = [];
        }
      };
      // Splice into the master chain only once the worklet exists (otherwise stay direct)
      Tone.connect(from, node);
      Tone.connect(node, to);
      from.disconnect(to);
      telemetry.ready = true;
      node.port.postMessage({ type: 'tone', ...state });
    } catch (err) {
      console.warn('[tape-deck] worklet unavailable, master stays direct', err);
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  const send = (msg) => node?.port.postMessage(msg);

  return {
    telemetry,
    attach,
    /** mode: live | stop | rev | back | vari | scrub | loop */
    setMode(mode, opts = {}) {
      send({ type: 'mode', mode, ...opts });
    },
    setSpeed(speed) {
      send({ type: 'speed', speed });
    },
    scrub(speed) {
      send({ type: 'scrub', speed });
    },
    setTone(patch) {
      Object.assign(state, patch);
      send({ type: 'tone', ...patch });
    },
    getTone() {
      return { ...state };
    },
    setPrint(on) {
      send({ type: 'print', on });
    },
    peakAt(absBlock) {
      if (absBlock < 0 || absBlock >= telemetry.peakHead || telemetry.peakHead - absBlock >= PEAK_RING) return 0;
      return telemetry.peaks[absBlock % PEAK_RING] / 255;
    }
  };
}
