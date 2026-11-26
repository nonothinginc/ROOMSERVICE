export const meta = {
  id: 'eq3',
  name: 'EQ-3',
  category: 'effect',
  visualizer: 'curve',
  params: [
    { id: 'low', label: 'LOW', min: -18, max: 18, default: 0, step: 0.5, unit: 'dB' },
    { id: 'mid', label: 'MID', min: -18, max: 18, default: 0, step: 0.5, unit: 'dB' },
    { id: 'midFreq', label: 'FREQ', min: 250, max: 4000, default: 1000, step: 10, unit: 'Hz', curve: 'exp' },
    { id: 'high', label: 'HIGH', min: -18, max: 18, default: 0, step: 0.5, unit: 'dB' }
  ]
};

export function createNode(Tone) {
  const input = new Tone.Gain(1);
  const output = new Tone.Gain(1);

  const lowShelf = new Tone.Filter({ type: 'lowshelf', frequency: 160, gain: 0 });
  const midPeak = new Tone.Filter({ type: 'peaking', frequency: 1000, Q: 1.2, gain: 0 });
  const highShelf = new Tone.Filter({ type: 'highshelf', frequency: 3500, gain: 0 });

  input.connect(lowShelf);
  lowShelf.connect(midPeak);
  midPeak.connect(highShelf);
  highShelf.connect(output);

  const state = { low: 0, mid: 0, midFreq: 1000, high: 0 };

  function setParam(id, value) {
    if (!(id in state)) return;
    state[id] = value;
    const now = Tone.now();
    if (id === 'low') {
      lowShelf.gain.setTargetAtTime(value, now, 0.015);
    } else if (id === 'mid') {
      midPeak.gain.setTargetAtTime(value, now, 0.015);
    } else if (id === 'midFreq') {
      midPeak.frequency.setTargetAtTime(Math.max(80, value), now, 0.015);
    } else if (id === 'high') {
      highShelf.gain.setTargetAtTime(value, now, 0.015);
    }
  }

  function evalCurveDb(freq) {
    const lowW = 1 / (1 + Math.pow(freq / 160, 2));
    const highW = 1 / (1 + Math.pow(3500 / freq, 2));
    const midDist = Math.log2(freq / state.midFreq);
    const midW = Math.exp(-(midDist * midDist) * 1.4);
    return state.low * lowW + state.mid * midW + state.high * highW;
  }

  function getVisualizerData() {
    const points = [];
    const n = 64;
    const minLog = Math.log10(20);
    const maxLog = Math.log10(16000);
    for (let i = 0; i < n; i++) {
      const freq = Math.pow(10, minLog + (i / (n - 1)) * (maxLog - minLog));
      points.push(Math.max(-1, Math.min(1, evalCurveDb(freq) / 18)));
    }
    const bandFreqs = [95, state.midFreq, 6000];
    const bands = bandFreqs.map((freq) => ({
      x: Math.max(0.03, Math.min(0.97, (Math.log10(freq) - minLog) / (maxLog - minLog))),
      y: Math.max(-1, Math.min(1, evalCurveDb(freq) / 18))
    }));
    return { type: 'eq-curve', points, bands };
  }

  function dispose() {
    lowShelf.dispose();
    midPeak.dispose();
    highShelf.dispose();
    input.dispose();
    output.dispose();
  }

  return {
    input,
    output,
    setParam,
    getVisualizerData,
    dispose
  };
}
