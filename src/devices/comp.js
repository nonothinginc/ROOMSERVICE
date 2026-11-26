export const meta = {
  id: 'comp',
  name: 'COMP',
  category: 'effect',
  visualizer: 'meter',
  params: [
    { id: 'threshold', label: 'THRS', min: -48, max: 0, default: -18, step: 0.5, unit: 'dB' },
    { id: 'ratio', label: 'RAT', min: 1, max: 20, default: 4, step: 0.5, unit: ':1' },
    { id: 'attack', label: 'ATK', min: 0.001, max: 0.2, default: 0.01, step: 0.001, unit: 's' },
    { id: 'release', label: 'REL', min: 0.02, max: 1.0, default: 0.18, step: 0.01, unit: 's' },
    { id: 'makeup', label: 'GAIN', min: 0, max: 18, default: 3, step: 0.5, unit: 'dB' }
  ]
};

export function createNode(Tone) {
  const input = new Tone.Gain(1);
  const output = new Tone.Gain(1);
  const comp = new Tone.Compressor({
    threshold: -18,
    ratio: 4,
    attack: 0.01,
    release: 0.18
  });
  const makeup = new Tone.Gain(Tone.dbToGain(3));

  input.connect(comp);
  comp.connect(makeup);
  makeup.connect(output);

  const state = {
    threshold: -18,
    ratio: 4,
    attack: 0.01,
    release: 0.18,
    makeup: 3
  };

  function setParam(id, value) {
    if (!(id in state)) return;
    state[id] = value;
    const now = Tone.now();
    if (id === 'threshold') {
      comp.threshold.setTargetAtTime(value, now, 0.015);
    } else if (id === 'ratio') {
      comp.ratio.setTargetAtTime(Math.max(1, value), now, 0.015);
    } else if (id === 'attack') {
      comp.attack.setTargetAtTime(Math.max(0.001, value), now, 0.015);
    } else if (id === 'release') {
      comp.release.setTargetAtTime(Math.max(0.01, value), now, 0.015);
    } else if (id === 'makeup') {
      makeup.gain.setTargetAtTime(Tone.dbToGain(value), now, 0.015);
    }
  }

  function getMeter() {
    const gr = Math.abs(comp.reduction || 0);
    return Math.max(0, Math.min(1, gr / 24));
  }

  function getVisualizerData() {
    return {
      type: 'comp-curve',
      threshold: state.threshold,
      ratio: state.ratio,
      attackMs: Math.round(state.attack * 1000),
      releaseMs: Math.round(state.release * 1000),
      grDb: Math.abs(comp.reduction || 0)
    };
  }

  function dispose() {
    comp.dispose();
    makeup.dispose();
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
