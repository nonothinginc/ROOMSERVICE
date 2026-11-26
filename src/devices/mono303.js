export const meta = {
  id: 'mono303',
  name: 'MONO-303',
  category: 'instrument',
  visualizer: 'waveform',
  params: [
    { id: 'wave', label: 'WAVE', control: 'segmented', options: ['SAW', 'SQR'], min: 0, max: 1, default: 0, step: 1, unit: '' },
    { id: 'cutoff', label: 'CUT', min: 80, max: 8000, default: 920, step: 1, unit: 'Hz', curve: 'exp' },
    { id: 'res', label: 'RES', min: 0.5, max: 18, default: 6.5, step: 0.1, unit: 'Q' },
    { id: 'envMod', label: 'ENV', min: 0, max: 5000, default: 2100, step: 10, unit: 'Hz' },
    { id: 'decay', label: 'DEC', min: 0.04, max: 1.2, default: 0.28, step: 0.01, unit: 's' },
    { id: 'accent', label: 'ACC', min: 0, max: 100, default: 45, step: 1, unit: '%' }
  ]
};

function midiToFreq(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

export function createNode(Tone) {
  const input = new Tone.Gain(1);
  const output = new Tone.Gain(0.8);
  const osc = new Tone.Oscillator({ type: 'sawtooth', frequency: 110 });
  const filter = new Tone.Filter({ type: 'lowpass', rolloff: -24, frequency: meta.params[1].default, Q: meta.params[2].default });
  const vca = new Tone.Gain(0);

  osc.connect(filter);
  filter.connect(vca);
  vca.connect(output);

  const state = {
    wave: 0,
    cutoff: 920,
    res: 6.5,
    envMod: 2100,
    decay: 0.28,
    accent: 45
  };

  let oscStarted = false;
  let lastTriggerTime = -1;
  let lastFreq = 110;
  let gateActive = false;

  function ensureStarted(t) {
    if (!oscStarted) {
      try {
        osc.start(t);
        oscStarted = true;
      } catch {
        // AudioContext might still be suspended before first user unlock
      }
    }
  }

  function monotonicTime(time) {
    const now = Tone.immediate();
    const base = typeof time === 'number' ? time : now;
    const t = Math.max(base, now, lastTriggerTime + 0.0005);
    lastTriggerTime = t;
    return t;
  }

  function setParam(id, value) {
    if (!(id in state)) return;
    state[id] = value;
    const now = Tone.now();
    if (id === 'wave') {
      osc.type = Math.round(value) === 0 ? 'sawtooth' : 'square';
    } else if (id === 'cutoff') {
      filter.frequency.setTargetAtTime(Math.max(40, Math.min(18000, value)), now, 0.015);
    } else if (id === 'res') {
      filter.Q.setTargetAtTime(Math.max(0.5, Math.min(24, value)), now, 0.015);
    }
  }

  function computeBaseCutoff(opts) {
    const offset = opts && typeof opts.cutoffOffset === 'number' ? opts.cutoffOffset : 0;
    const mult = Math.pow(2, offset * 2.5);
    return Math.max(60, Math.min(14000, state.cutoff * mult));
  }

  function triggerNote(midi, durSec = 0.14, time, vel = 0.85, opts = {}) {
    const t = monotonicTime(time);
    ensureStarted(t);
    const freq = midiToFreq(midi);
    const accentBoost = vel > 0.88 ? 1 + (state.accent / 100) * 0.65 : 1;
    const baseCut = computeBaseCutoff(opts);
    const peakCut = Math.min(16000, baseCut + state.envMod * vel * accentBoost);
    const amp = Math.max(0.05, Math.min(1, vel)) * (vel > 0.88 ? 1.12 : 0.9);
    const dec = Math.max(0.04, state.decay * (vel > 0.88 ? 0.78 : 1));
    const endT = t + Math.max(0.03, durSec);

    osc.frequency.cancelScheduledValues(t);
    osc.frequency.setValueAtTime(freq, t);
    lastFreq = freq;

    filter.frequency.cancelScheduledValues(t);
    filter.frequency.setValueAtTime(Math.max(60, baseCut), t);
    filter.frequency.exponentialRampToValueAtTime(Math.max(80, peakCut), t + 0.006);
    filter.frequency.exponentialRampToValueAtTime(Math.max(60, baseCut), t + 0.01 + dec);

    vca.gain.cancelScheduledValues(t);
    vca.gain.setValueAtTime(0.0001, t);
    vca.gain.linearRampToValueAtTime(amp, t + 0.004);
    vca.gain.setTargetAtTime(0.0001, endT, Math.max(0.012, dec * 0.22));
    gateActive = true;
  }

  function triggerSlide(fromMidi, toMidi, durSec = 0.14, time, vel = 0.85, opts = {}) {
    const t = monotonicTime(time);
    ensureStarted(t);
    const startFreq = fromMidi != null ? midiToFreq(fromMidi) : lastFreq;
    const targetFreq = midiToFreq(toMidi);
    const slideDur = Math.max(0.025, durSec * 0.92);
    const baseCut = computeBaseCutoff(opts);
    const endT = t + Math.max(0.03, durSec);

    osc.frequency.cancelScheduledValues(t);
    if (!gateActive) {
      osc.frequency.setValueAtTime(startFreq, t);
      vca.gain.cancelScheduledValues(t);
      vca.gain.setValueAtTime(0.0001, t);
      vca.gain.linearRampToValueAtTime(Math.max(0.15, vel * 0.9), t + 0.005);
      filter.frequency.cancelScheduledValues(t);
      filter.frequency.setTargetAtTime(Math.max(60, baseCut + state.envMod * 0.35), t, 0.02);
    } else {
      osc.frequency.setValueAtTime(Math.max(20, startFreq), t);
    }
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, targetFreq), t + slideDur);
    lastFreq = targetFreq;

    vca.gain.setTargetAtTime(0.0001, endT, 0.035);
    gateActive = true;
  }

  function releaseAll(time) {
    const t = monotonicTime(time);
    vca.gain.cancelScheduledValues(t);
    vca.gain.setTargetAtTime(0.0001, t, 0.02);
    gateActive = false;
  }

  function getVisualizerData() {
    const pts = [];
    const isSq = Math.round(state.wave) === 1;
    const cutNorm = Math.log10(state.cutoff / 80) / Math.log10(8000 / 80);
    const resAmt = (state.res / 18) * 0.35;
    for (let i = 0; i < 48; i++) {
      const p = i / 47;
      let y = isSq ? (p % 0.5 < 0.25 ? 0.7 : -0.7) : 1 - 2 * ((p * 2) % 1);
      y = y * (0.35 + cutNorm * 0.55) + Math.sin(p * Math.PI * 12) * resAmt * cutNorm;
      pts.push(Math.max(-1, Math.min(1, y)));
    }
    return { type: 'waveform', points: pts };
  }

  function dispose() {
    try {
      if (oscStarted) osc.stop();
    } catch {
      // ignore
    }
    osc.dispose();
    filter.dispose();
    vca.dispose();
    input.dispose();
    output.dispose();
  }

  return {
    input,
    output,
    setParam,
    triggerNote,
    triggerSlide,
    releaseAll,
    getVisualizerData,
    dispose
  };
}
