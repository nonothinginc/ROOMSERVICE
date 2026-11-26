export const meta = {
  id: 'tape',
  name: 'TAPE-1',
  category: 'effect',
  visualizer: 'tape-lcd',
  params: [
    { id: 'ips', label: 'IPS', control: 'segmented', options: ['3.75', '7.5', '15', '30'], min: 0, max: 3, default: 2, step: 1, unit: '' },
    { id: 'drive', label: 'DRIVE', min: 0, max: 100, default: 38, step: 1, unit: '%' },
    { id: 'sat', label: 'SAT', min: 0, max: 100, default: 45, step: 1, unit: '%' },
    { id: 'bias', label: 'BIAS', min: 0, max: 100, default: 55, step: 1, unit: '%' },
    { id: 'flutter', label: 'W/F', min: 0, max: 100, default: 18, step: 1, unit: '%' },
    { id: 'mix', label: 'MIX', min: 0, max: 100, default: 100, step: 1, unit: '%' }
  ],
  extendedParams: [
    { id: 'formula', label: 'TAPE', control: 'segmented', options: ['456', 'FERRIC', 'CHROME', 'LO-FI'], min: 0, max: 3, default: 0, step: 1, unit: '' },
    { id: 'bump', label: 'BUMP', min: 0, max: 100, default: 35, step: 1, unit: '%' },
    { id: 'loss', label: 'LOSS', min: 0, max: 100, default: 25, step: 1, unit: '%' },
    { id: 'wow', label: 'WOW', min: 0, max: 100, default: 22, step: 1, unit: '%' },
    { id: 'hiss', label: 'HISS', min: 0, max: 100, default: 10, step: 1, unit: '%' },
    { id: 'wear', label: 'WEAR', min: 0, max: 100, default: 0, step: 1, unit: '%' },
    { id: 'out', label: 'OUT', min: -12, max: 12, default: 0, step: 0.5, unit: 'dB' }
  ]
};

const IPS_VALUES = [3.75, 7.5, 15, 30];
const HEAD_BUMP_HZ = [45, 58, 88, 128];
const LOSS_CUTOFF_HZ = [5200, 9200, 14800, 19500];

const WORKLET_CODE = `
class TapeHysteresisProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'drive', defaultValue: 0.38, minValue: 0, maxValue: 1 },
      { name: 'sat', defaultValue: 0.45, minValue: 0, maxValue: 1 },
      { name: 'bias', defaultValue: 0.55, minValue: 0, maxValue: 1 },
      { name: 'flutter', defaultValue: 0.18, minValue: 0, maxValue: 1 },
      { name: 'wow', defaultValue: 0.22, minValue: 0, maxValue: 1 },
      { name: 'loss', defaultValue: 0.25, minValue: 0, maxValue: 1 },
      { name: 'hiss', defaultValue: 0.10, minValue: 0, maxValue: 1 },
      { name: 'wear', defaultValue: 0, minValue: 0, maxValue: 1 },
      { name: 'ips', defaultValue: 2, minValue: 0, maxValue: 3 },
      { name: 'formula', defaultValue: 0, minValue: 0, maxValue: 3 }
    ];
  }

  constructor() {
    super();
    this.bufSize = 2048;
    this.delayBuf = [new Float32Array(this.bufSize), new Float32Array(this.bufSize)];
    this.writeIdx = 0;

    // Per-channel Jiles-Atherton & filter states
    this.M = [0, 0];
    this.Hprev = [0, 0];
    this.upPrev = [0, 0];
    this.dcX = [0, 0];
    this.dcY = [0, 0];
    this.lossState = [0, 0];
    this.pinkB0 = [0, 0];
    this.pinkB1 = [0, 0];
    this.pinkB2 = [0, 0];

    // Mechanical W/F & Wear states
    this.wowPhase = 0;
    this.flutterPhase1 = 0;
    this.flutterPhase2 = 0;
    this.ouDrift = 0;
    this.dropEnv = 1;
    this.dropTarget = 1;
    this.dropCounter = 0;
    this.rngState = 2463534242;

    // Telemetry buffers (posted at ~60Hz)
    this.blockCounter = 0;
    this.loopPts = new Float32Array(48); // 24 (H, M) pairs
    this.waveIn = new Float32Array(32);
    this.waveOut = new Float32Array(32);
  }

  nextRand() {
    let x = this.rngState | 0;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.rngState = x;
    return ((x >>> 0) / 4294967296) * 2 - 1;
  }

  langevin(x) {
    const ax = Math.abs(x);
    if (ax < 1e-4) return x / 3 - (x * x * x) / 45;
    if (ax > 16) return Math.sign(x) - 1 / x;
    const ex = Math.exp(2 * x);
    const coth = (ex + 1) / (ex - 1);
    return coth - 1 / x;
  }

  langevinDeriv(x) {
    const ax = Math.abs(x);
    if (ax < 1e-4) return 1 / 3 - (x * x) / 15;
    if (ax > 16) return 1 / (x * x);
    const ex = Math.exp(2 * x);
    const sinh = (ex - 1) / (2 * Math.exp(x));
    return 1 / (x * x) - 1 / (sinh * sinh);
  }

  jaDeriv(H, M, dH, Ms, a, alpha, k, c) {
    const He = H + alpha * M;
    const x = He / a;
    const Man = Ms * this.langevin(x);
    const dMan = (Ms / a) * this.langevinDeriv(x);
    const diff = Man - M;
    const dir = dH >= 0 ? 1 : -1;
    const deltaM = (dH > 0 && diff > 0) || (dH < 0 && diff < 0) ? 1 : 0;
    const oneMinusC = 1 - c;
    let denom = oneMinusC * dir * k - alpha * diff;
    if (Math.abs(denom) < 0.08) denom = denom >= 0 ? 0.08 : -0.08;
    let dMdH = (oneMinusC * deltaM * diff + c * dMan) / denom;
    if (!Number.isFinite(dMdH)) dMdH = 0;
    return Math.max(-4, Math.min(4, dMdH));
  }

  stepHysteresis(ch, H, Ms, a, alpha, k, c) {
    let M = this.M[ch];
    const H0 = this.Hprev[ch];
    const dH = H - H0;
    if (Math.abs(dH) > 1e-7) {
      const k1 = this.jaDeriv(H0, M, dH, Ms, a, alpha, k, c) * dH;
      const k2 = this.jaDeriv(H0 + 0.5 * dH, M + 0.5 * k1, dH, Ms, a, alpha, k, c) * dH;
      M += k2;
    }
    if (!Number.isFinite(M)) M = 0;
    M = Math.max(-1.6, Math.min(1.6, M));
    this.M[ch] = M;
    this.Hprev[ch] = H;
    return M;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !output || output.length === 0) return true;

    const driveP = parameters.drive[0];
    const satP = parameters.sat[0];
    const biasP = parameters.bias[0];
    const flutterP = parameters.flutter[0];
    const wowP = parameters.wow[0];
    const lossP = parameters.loss[0];
    const hissP = parameters.hiss[0];
    const wearP = parameters.wear[0];
    const ipsIdx = Math.max(0, Math.min(3, Math.round(parameters.ips[0])));
    const formulaIdx = Math.max(0, Math.min(3, Math.round(parameters.formula[0])));

    // Tape formula presets (456, FERRIC, CHROME, LO-FI)
    const formulaMs = [1.05, 0.92, 1.15, 0.72][formulaIdx];
    const formulaK = [0.42, 0.56, 0.34, 0.78][formulaIdx];
    const formulaAlpha = [0.0014, 0.0022, 0.0010, 0.0036][formulaIdx];
    const formulaAsym = [0.025, 0.045, 0.015, 0.085][formulaIdx];
    const ipsCutoffBase = [5200, 9200, 14800, 19500][ipsIdx];
    const ipsSpeedScale = [0.55, 0.8, 1.0, 1.25][ipsIdx];

    const Ms = Math.max(0.45, formulaMs * (1.12 - satP * 0.46));
    const a = 0.25 + (1 - satP) * 0.32;
    const alpha = formulaAlpha + satP * 0.002;
    const c = 0.14 + biasP * 0.68;
    const k = Math.max(0.12, formulaK * (1.35 - biasP * 0.75));
    const preGain = 0.45 + driveP * 2.6;
    const postComp = 1 / Math.max(0.55, Math.pow(preGain, 0.42));

    const sr = sampleRate || 48000;
    const targetCutoff = Math.max(1400, ipsCutoffBase * (1 - lossP * 0.72) * (1 - wearP * 0.35));
    const lpCoeff = Math.exp((-2 * Math.PI * targetCutoff) / sr);
    const hissAmp = hissP * hissP * 0.018 * (1 + wearP * 0.8);

    const nSamples = output[0].length;
    const in0 = input[0];
    const in1 = input[1] || input[0];
    const out0 = output[0];
    const out1 = output[1] || null;
    const hasStereo = Boolean(out1);

    let inPeak = 0;
    let outPeak = 0;
    let inSumSq = 0;
    let outSumSq = 0;
    let lastFlutterMod = 0;

    // Mechanical LFO increments per sample
    const wowInc = (2 * Math.PI * (0.65 * ipsSpeedScale + 0.35)) / sr;
    const flInc1 = (2 * Math.PI * (8.4 * ipsSpeedScale + 4.0)) / sr;
    const flInc2 = (2 * Math.PI * (15.2 * ipsSpeedScale + 6.5)) / sr;
    const baseDelay = 280; // ~5.8ms center tap for zero-clipping modulation
    const wowDepth = wowP * (135 / ipsSpeedScale);
    const flDepth = flutterP * (28 / ipsSpeedScale);

    for (let i = 0; i < nSamples; i++) {
      const s0 = in0 ? in0[i] : 0;
      const s1 = in1 ? in1[i] : s0;

      // Update dropout & OU random drift
      if (this.dropCounter <= 0) {
        if (wearP > 0.04 && Math.abs(this.nextRand()) < wearP * 0.008) {
          this.dropTarget = 1 - wearP * (0.35 + Math.abs(this.nextRand()) * 0.55);
          this.dropCounter = Math.floor(sr * (0.015 + Math.abs(this.nextRand()) * 0.06));
        } else {
          this.dropTarget = 1;
          this.dropCounter = 128;
        }
      } else {
        this.dropCounter--;
      }
      this.dropEnv += (this.dropTarget - this.dropEnv) * 0.04;

      this.wowPhase += wowInc;
      if (this.wowPhase > 6.2831853) this.wowPhase -= 6.2831853;
      this.flutterPhase1 += flInc1;
      if (this.flutterPhase1 > 6.2831853) this.flutterPhase1 -= 6.2831853;
      this.flutterPhase2 += flInc2;
      if (this.flutterPhase2 > 6.2831853) this.flutterPhase2 -= 6.2831853;
      this.ouDrift = this.ouDrift * 0.996 + this.nextRand() * 0.004;

      const modOffset =
        Math.sin(this.wowPhase) * wowDepth +
        (Math.sin(this.flutterPhase1) * 0.65 + Math.sin(this.flutterPhase2) * 0.35 + this.ouDrift * 2.2) * flDepth;
      lastFlutterMod = modOffset;

      const delaySamples = Math.max(4, Math.min(this.bufSize - 4, baseDelay + modOffset));
      this.delayBuf[0][this.writeIdx] = s0;
      if (hasStereo) this.delayBuf[1][this.writeIdx] = s1;

      const readPos = (this.writeIdx - delaySamples + this.bufSize) % this.bufSize;
      const rIdx0 = readPos | 0;
      const rIdx1 = (rIdx0 + 1) % this.bufSize;
      const frac = readPos - rIdx0;

      const d0 = this.delayBuf[0][rIdx0] * (1 - frac) + this.delayBuf[0][rIdx1] * frac;
      const d1 = hasStereo ? this.delayBuf[1][rIdx0] * (1 - frac) + this.delayBuf[1][rIdx1] * frac : d0;
      this.writeIdx = (this.writeIdx + 1) % this.bufSize;

      // Channel 0: 2x Oversampled Jiles-Atherton hysteresis + DC block + Loss + Hiss
      const h0Raw = d0 * preGain + formulaAsym * driveP;
      const h0Mid = 0.5 * (this.upPrev[0] + h0Raw);
      this.upPrev[0] = h0Raw;
      this.stepHysteresis(0, Math.max(-3.5, Math.min(3.5, h0Mid)), Ms, a, alpha, k, c);
      let y0 = this.stepHysteresis(0, Math.max(-3.5, Math.min(3.5, h0Raw)), Ms, a, alpha, k, c) * postComp * this.dropEnv;

      // DC blocker
      const dc0 = y0 - this.dcX[0] + 0.995 * this.dcY[0];
      this.dcX[0] = y0;
      this.dcY[0] = dc0;
      y0 = dc0;

      // Spacing loss LP
      this.lossState[0] = y0 + (this.lossState[0] - y0) * lpCoeff;
      y0 = this.lossState[0];

      // Tape hiss (pink-filtered)
      if (hissAmp > 1e-6) {
        const wn = this.nextRand();
        this.pinkB0[0] = 0.997 * this.pinkB0[0] + wn * 0.029;
        this.pinkB1[0] = 0.985 * this.pinkB1[0] + wn * 0.032;
        this.pinkB2[0] = 0.950 * this.pinkB2[0] + wn * 0.048;
        y0 += (this.pinkB0[0] + this.pinkB1[0] + this.pinkB2[0] + wn * 0.18) * hissAmp;
      }

      if (!Number.isFinite(y0)) y0 = 0;
      y0 = Math.max(-1.4, Math.min(1.4, y0));
      out0[i] = y0;

      if (hasStereo) {
        const h1Raw = d1 * preGain + formulaAsym * driveP;
        const h1Mid = 0.5 * (this.upPrev[1] + h1Raw);
        this.upPrev[1] = h1Raw;
        this.stepHysteresis(1, Math.max(-3.5, Math.min(3.5, h1Mid)), Ms, a, alpha, k, c);
        let y1 = this.stepHysteresis(1, Math.max(-3.5, Math.min(3.5, h1Raw)), Ms, a, alpha, k, c) * postComp * this.dropEnv;

        const dc1 = y1 - this.dcX[1] + 0.995 * this.dcY[1];
        this.dcX[1] = y1;
        this.dcY[1] = dc1;
        y1 = dc1;

        this.lossState[1] = y1 + (this.lossState[1] - y1) * lpCoeff;
        y1 = this.lossState[1];

        if (hissAmp > 1e-6) {
          const wn = this.nextRand();
          this.pinkB0[1] = 0.997 * this.pinkB0[1] + wn * 0.029;
          this.pinkB1[1] = 0.985 * this.pinkB1[1] + wn * 0.032;
          this.pinkB2[1] = 0.950 * this.pinkB2[1] + wn * 0.048;
          y1 += (this.pinkB0[1] + this.pinkB1[1] + this.pinkB2[1] + wn * 0.18) * hissAmp;
        }
        if (!Number.isFinite(y1)) y1 = 0;
        y1 = Math.max(-1.4, Math.min(1.4, y1));
        out1[i] = y1;
      }

      const absIn = Math.max(Math.abs(s0), Math.abs(s1));
      const absOut = Math.abs(y0);
      if (absIn > inPeak) inPeak = absIn;
      if (absOut > outPeak) outPeak = absOut;
      inSumSq += s0 * s0;
      outSumSq += y0 * y0;

      if ((i & 3) === 0) {
        const idx32 = (i >> 2) & 31;
        this.waveIn[idx32] = s0;
        this.waveOut[idx32] = y0;
        if (idx32 < 24) {
          this.loopPts[idx32 * 2] = Math.max(-1, Math.min(1, h0Raw * 0.45));
          this.loopPts[idx32 * 2 + 1] = Math.max(-1, Math.min(1, this.M[0] / Math.max(0.4, Ms)));
        }
      }
    }

    this.blockCounter++;
    if (this.blockCounter >= 6) {
      this.blockCounter = 0;
      const inRms = Math.sqrt(inSumSq / nSamples);
      const outRms = Math.sqrt(outSumSq / nSamples);
      const satAmount = Math.max(0, Math.min(1, Math.abs(this.M[0]) / Math.max(0.4, Ms)));
      this.port.postMessage({
        inPeak,
        outPeak,
        inRms,
        outRms,
        satAmount,
        flutterMod: lastFlutterMod,
        dropout: 1 - this.dropEnv,
        loopPts: Array.from(this.loopPts),
        waveIn: Array.from(this.waveIn),
        waveOut: Array.from(this.waveOut)
      });
    }

    return true;
  }
}

registerProcessor('roomservice-tape-hysteresis', TapeHysteresisProcessor);
`;

const workletPromises = new WeakMap();

function ensureTapeWorklet(rawContext) {
  if (!rawContext || !rawContext.audioWorklet) return Promise.resolve(false);
  if (workletPromises.has(rawContext)) return workletPromises.get(rawContext);
  const blob = new Blob([WORKLET_CODE], { type: 'application/javascript' });
  const url = URL.createObjectURL(blob);
  const p = rawContext.audioWorklet
    .addModule(url)
    .then(() => {
      URL.revokeObjectURL(url);
      return true;
    })
    .catch(() => {
      URL.revokeObjectURL(url);
      return false;
    });
  workletPromises.set(rawContext, p);
  return p;
}

export function createNode(Tone) {
  const input = new Tone.Gain(1);
  const output = new Tone.Gain(1);
  const dryWet = new Tone.CrossFade(1.0);
  const headBump = new Tone.Filter({ type: 'peaking', frequency: 88, Q: 1.35, gain: 2.5 });
  const fallbackShaper = new Tone.WaveShaper((x) => Math.tanh(x * 1.8) / Math.tanh(1.8), 512);
  const fallbackLoss = new Tone.Filter({ type: 'lowpass', frequency: 14800, Q: 0.65 });
  const outGain = new Tone.Gain(1);
  const outMeter = new Tone.Meter({ smoothing: 0.72 });

  // Initial path active immediately before/if AudioWorklet resolves
  input.connect(dryWet.a);
  input.connect(headBump);
  headBump.connect(fallbackShaper);
  fallbackShaper.connect(fallbackLoss);
  fallbackLoss.connect(outGain);
  outGain.connect(dryWet.b);
  dryWet.connect(output);
  output.connect(outMeter);

  let workletNode = null;
  let disposed = false;
  let reelAngle = 0;
  let lastAngleTick = performance.now();

  const state = {
    ips: 2,
    drive: 38,
    sat: 45,
    bias: 55,
    flutter: 18,
    mix: 100,
    formula: 0,
    bump: 35,
    loss: 25,
    wow: 22,
    hiss: 10,
    wear: 0,
    out: 0
  };

  const telemetry = {
    inPeak: 0,
    outPeak: 0,
    inRms: 0,
    outRms: 0,
    satAmount: 0,
    flutterMod: 0,
    dropout: 0,
    loopPts: [],
    waveIn: [],
    waveOut: []
  };

  function syncFallbackTone() {
    const now = Tone.now();
    const ipsIdx = Math.max(0, Math.min(3, Math.round(state.ips)));
    headBump.frequency.setTargetAtTime(HEAD_BUMP_HZ[ipsIdx], now, 0.02);
    headBump.gain.setTargetAtTime((state.bump / 100) * 6.5, now, 0.02);
    const cutoff = Math.max(1400, LOSS_CUTOFF_HZ[ipsIdx] * (1 - (state.loss / 100) * 0.72));
    fallbackLoss.frequency.setTargetAtTime(cutoff, now, 0.02);
    const amt = 1 + (state.drive / 100) * 3.5 + (state.sat / 100) * 2.5;
    fallbackShaper.setMap((x) => Math.tanh(x * amt) / Math.tanh(amt));
  }

  function pushWorkletParams() {
    if (!workletNode) return;
    const now = Tone.now();
    const map = {
      drive: state.drive / 100,
      sat: state.sat / 100,
      bias: state.bias / 100,
      flutter: state.flutter / 100,
      wow: state.wow / 100,
      loss: state.loss / 100,
      hiss: state.hiss / 100,
      wear: state.wear / 100,
      ips: Math.round(state.ips),
      formula: Math.round(state.formula)
    };
    for (const [k, val] of Object.entries(map)) {
      const p = workletNode.parameters.get(k);
      if (p) p.setTargetAtTime(val, now, 0.015);
    }
  }

  syncFallbackTone();

  const rawCtx = Tone.getContext().rawContext;
  ensureTapeWorklet(rawCtx).then((ok) => {
    if (!ok || disposed) return;
    try {
      workletNode = new AudioWorkletNode(rawCtx, 'roomservice-tape-hysteresis', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2]
      });
      workletNode.port.onmessage = (ev) => {
        const d = ev.data;
        if (!d) return;
        telemetry.inPeak = d.inPeak || 0;
        telemetry.outPeak = d.outPeak || 0;
        telemetry.inRms = d.inRms || 0;
        telemetry.outRms = d.outRms || 0;
        telemetry.satAmount = d.satAmount || 0;
        telemetry.flutterMod = d.flutterMod || 0;
        telemetry.dropout = d.dropout || 0;
        telemetry.loopPts = d.loopPts || [];
        telemetry.waveIn = d.waveIn || [];
        telemetry.waveOut = d.waveOut || [];
      };
      headBump.disconnect(fallbackShaper);
      Tone.connect(headBump, workletNode);
      Tone.connect(workletNode, outGain);
      pushWorkletParams();
    } catch {
      workletNode = null;
    }
  });

  function setParam(id, value) {
    if (!(id in state)) return;
    state[id] = value;
    const now = Tone.now();

    if (id === 'mix') {
      dryWet.fade.setTargetAtTime(Math.max(0, Math.min(1, value / 100)), now, 0.015);
    } else if (id === 'out') {
      const lin = Math.pow(10, Math.max(-12, Math.min(12, value)) / 20);
      outGain.gain.setTargetAtTime(lin, now, 0.015);
    } else {
      syncFallbackTone();
      pushWorkletParams();
    }
  }

  function getMeter() {
    const db = outMeter.getValue();
    return Math.max(0, Math.min(1, (db + 60) / 60));
  }

  function getVisualizerData() {
    const now = performance.now();
    const dt = Math.min(0.1, Math.max(0.001, (now - lastAngleTick) / 1000));
    lastAngleTick = now;

    const ipsIdx = Math.max(0, Math.min(3, Math.round(state.ips)));
    const ips = IPS_VALUES[ipsIdx];
    const speedFactor = ips / 15;
    const wfJitter = 1 + (telemetry.flutterMod || 0) * 0.0025;
    reelAngle = (reelAngle + dt * 1.45 * speedFactor * wfJitter) % (Math.PI * 2);

    const m = Math.max(getMeter(), telemetry.outPeak || 0);
    return {
      type: 'tape-lcd',
      ipsIdx,
      ips,
      formulaIdx: Math.max(0, Math.min(3, Math.round(state.formula))),
      drive: state.drive,
      sat: state.sat,
      bias: state.bias,
      flutter: state.flutter,
      wow: state.wow,
      bump: state.bump,
      loss: state.loss,
      hiss: state.hiss,
      wear: state.wear,
      mix: state.mix,
      out: state.out,
      reelAngle,
      meter: m,
      telemetry: {
        ...telemetry,
        outPeak: Math.max(telemetry.outPeak || 0, m)
      }
    };
  }

  function dispose() {
    disposed = true;
    try {
      if (workletNode) {
        workletNode.port.onmessage = null;
        workletNode.disconnect();
      }
    } catch {
      // ignore
    }
    headBump.dispose();
    fallbackShaper.dispose();
    fallbackLoss.dispose();
    outGain.dispose();
    dryWet.dispose();
    outMeter.dispose();
    input.dispose();
    output.dispose();
  }

  return {
    input,
    output,
    setParam,
    getMeter,
    getVisualizerData,
    dispose
  };
}
