import { createNativeFreeverb } from '../audio/native-freeverb.js';

export const meta = {
  id: 'verb',
  name: 'VERB',
  category: 'effect',
  visualizer: 'meter',
  params: [
    { id: 'decay', label: 'DEC', min: 0.2, max: 0.96, default: 0.72, step: 0.02, unit: '' },
    { id: 'preDelay', label: 'PRE', min: 0, max: 0.12, default: 0.018, step: 0.002, unit: 's' },
    { id: 'damp', label: 'DAMP', min: 800, max: 14000, default: 5200, step: 50, unit: 'Hz', curve: 'exp' },
    { id: 'size', label: 'SIZE', min: 0.1, max: 0.98, default: 0.68, step: 0.02, unit: '' },
    { id: 'mix', label: 'MIX', min: 0, max: 100, default: 32, step: 1, unit: '%' }
  ]
};

export function createNode(Tone) {
  const input = new Tone.Gain(1);
  const output = new Tone.Gain(1);
  const dryWet = new Tone.CrossFade(0.32);
  const pre = new Tone.Delay({ delayTime: 0.018, maxDelay: 0.2 });
  // Native-node Freeverb: Tone.Freeverb's 8 worklet combs cost ~10% of a core each (RG477V)
  const reverb = createNativeFreeverb(Tone.getContext().rawContext, { roomSize: 0.68, dampening: 5200 });
  const dampFilter = new Tone.BiquadFilter({ type: 'lowpass', frequency: 5200 });
  const meter = new Tone.Meter({ smoothing: 0.75 });

  input.connect(dryWet.a);
  input.connect(pre);
  pre.connect(reverb.input);
  Tone.connect(reverb.output, dampFilter);
  dampFilter.connect(dryWet.b);
  dampFilter.connect(meter);
  dryWet.connect(output);

  const state = {
    decay: 0.72,
    preDelay: 0.018,
    damp: 5200,
    size: 0.68,
    mix: 32
  };

  function setParam(id, value) {
    if (!(id in state)) return;
    state[id] = value;
    const now = Tone.now();
    if (id === 'decay' || id === 'size') {
      const room = Math.max(0.1, Math.min(0.98, state.size * 0.55 + state.decay * 0.45));
      reverb.roomSize.setTargetAtTime(room, now, 0.02);
    } else if (id === 'preDelay') {
      pre.delayTime.setTargetAtTime(Math.max(0, Math.min(0.18, value)), now, 0.02);
    } else if (id === 'damp') {
      reverb.dampening = Math.max(500, value);
      dampFilter.frequency.setTargetAtTime(Math.max(500, value), now, 0.02);
    } else if (id === 'mix') {
      dryWet.fade.setTargetAtTime(Math.max(0, Math.min(1, value / 100)), now, 0.02);
    }
  }

  function getMeter() {
    const db = meter.getValue();
    return Math.max(0, Math.min(1, (db + 60) / 60));
  }

  function getVisualizerData() {
    return {
      type: 'reverb-depth',
      size: state.size,
      decay: state.decay,
      mix: state.mix,
      meter: getMeter()
    };
  }

  function dispose() {
    pre.dispose();
    reverb.dispose();
    dampFilter.dispose();
    dryWet.dispose();
    meter.dispose();
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
