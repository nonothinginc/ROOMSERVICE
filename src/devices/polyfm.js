export const meta = {
  id: 'polyfm',
  name: 'POLY-FM',
  category: 'instrument',
  visualizer: 'waveform',
  params: [
    { id: 'harm', label: 'HARM', min: 0.5, max: 8.0, default: 2.0, step: 0.5, unit: 'x' },
    { id: 'modIdx', label: 'MOD', min: 0, max: 18, default: 5.5, step: 0.2, unit: '' },
    { id: 'cutoff', label: 'CUT', min: 200, max: 14000, default: 4800, step: 20, unit: 'Hz', curve: 'exp' },
    { id: 'attack', label: 'ATK', min: 0.005, max: 1.5, default: 0.015, step: 0.005, unit: 's' },
    { id: 'release', label: 'REL', min: 0.05, max: 2.5, default: 0.42, step: 0.02, unit: 's' },
    { id: 'detune', label: 'DET', min: 0, max: 40, default: 8, step: 1, unit: 'ct' }
  ]
};

function midiToFreq(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

export function createNode(Tone) {
  const input = new Tone.Gain(1);
  const output = new Tone.Gain(0.75);
  const filter = new Tone.Filter({ type: 'lowpass', frequency: 4800, Q: 1.1 });

  const poly = new Tone.PolySynth(Tone.FMSynth, {
    maxPolyphony: 4,
    options: {
      harmonicity: 2.0,
      modulationIndex: 5.5,
      detune: 8,
      oscillator: { type: 'sine' },
      modulation: { type: 'triangle' },
      envelope: { attack: 0.015, decay: 0.25, sustain: 0.6, release: 0.42 },
      modulationEnvelope: { attack: 0.01, decay: 0.3, sustain: 0.3, release: 0.3 }
    }
  });

  poly.connect(filter);
  filter.connect(output);

  const state = {
    harm: 2.0,
    modIdx: 5.5,
    cutoff: 4800,
    attack: 0.015,
    release: 0.42,
    detune: 8
  };

  let lastTime = -1;

  function monotonic(time) {
    const now = Tone.now();
    const base = typeof time === 'number' ? time : now;
    const t = Math.max(base, now, lastTime + 0.0005);
    lastTime = t;
    return t;
  }

  function setParam(id, value) {
    if (!(id in state)) return;
    state[id] = value;
    const now = Tone.now();
    if (id === 'harm') {
      poly.set({ harmonicity: value });
    } else if (id === 'modIdx') {
      poly.set({ modulationIndex: value });
    } else if (id === 'cutoff') {
      filter.frequency.setTargetAtTime(Math.max(100, value), now, 0.02);
    } else if (id === 'attack') {
      poly.set({ envelope: { attack: Math.max(0.002, value) } });
    } else if (id === 'release') {
      poly.set({ envelope: { release: Math.max(0.02, value) } });
    } else if (id === 'detune') {
      poly.set({ detune: value });
    }
  }

  function triggerNote(midi, durSec = 0.25, time, vel = 0.8) {
    const t = monotonic(time);
    const freq = midiToFreq(midi);
    poly.triggerAttackRelease(freq, Math.max(0.04, durSec), t, Math.max(0.05, Math.min(1, vel)));
  }

  function releaseAll(time) {
    const t = monotonic(time);
    poly.releaseAll(t);
  }

  function getVisualizerData() {
    const pts = [];
    const idx = state.modIdx * 0.25;
    const h = state.harm;
    for (let i = 0; i < 48; i++) {
      const p = (i / 47) * Math.PI * 2;
      const y = Math.sin(p + idx * Math.sin(p * h));
      pts.push(Math.max(-1, Math.min(1, y * 0.85)));
    }
    return { type: 'waveform', points: pts };
  }

  function dispose() {
    poly.dispose();
    filter.dispose();
    input.dispose();
    output.dispose();
  }

  return {
    input,
    output,
    setParam,
    triggerNote,
    releaseAll,
    getVisualizerData,
    dispose
  };
}
