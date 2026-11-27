export const meta = {
  id: 'delay',
  name: 'DELAY',
  category: 'effect',
  visualizer: 'meter',
  params: [
    { id: 'time', label: 'TIME', min: 0, max: 5, default: 2, step: 1, unit: '' },
    { id: 'feedback', label: 'FDBK', min: 0, max: 0.9, default: 0.42, step: 0.02, unit: '' },
    { id: 'damp', label: 'DAMP', min: 600, max: 12000, default: 3600, step: 50, unit: 'Hz', curve: 'exp' },
    { id: 'spread', label: 'SPRD', min: 0, max: 100, default: 80, step: 1, unit: '%' },
    { id: 'mix', label: 'MIX', min: 0, max: 100, default: 35, step: 1, unit: '%' }
  ]
};

export const DELAY_DIVISIONS = ['16n', '8n', '8n.', '4n', '4n.', '2n'];

export function createNode(Tone) {
  const input = new Tone.Gain(1);
  const output = new Tone.Gain(1);
  const dryWet = new Tone.CrossFade(0.35);
  const ping = new Tone.PingPongDelay({ delayTime: '8n.', feedback: 0.42, maxDelay: 2.0 });
  const damp = new Tone.BiquadFilter({ type: 'lowpass', frequency: 3600, Q: 0.5 });
  const meter = new Tone.Meter({ smoothing: 0.7 });

  input.connect(dryWet.a);
  input.connect(ping);
  ping.connect(damp);
  damp.connect(dryWet.b);
  damp.connect(meter);
  dryWet.connect(output);

  const state = {
    time: 2,
    feedback: 0.42,
    damp: 3600,
    spread: 80,
    mix: 35
  };

  function setParam(id, value) {
    if (!(id in state)) return;
    state[id] = value;
    const now = Tone.now();
    if (id === 'time') {
      const div = DELAY_DIVISIONS[Math.max(0, Math.min(DELAY_DIVISIONS.length - 1, Math.round(value)))];
      ping.delayTime.value = div;
    } else if (id === 'feedback') {
      ping.feedback.setTargetAtTime(Math.max(0, Math.min(0.92, value)), now, 0.02);
    } else if (id === 'damp') {
      damp.frequency.setTargetAtTime(Math.max(300, value), now, 0.02);
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
      type: 'delay-grid',
      division: DELAY_DIVISIONS[Math.max(0, Math.min(DELAY_DIVISIONS.length - 1, Math.round(state.time)))] || '8n.',
      feedback: state.feedback,
      mix: state.mix,
      spread: state.spread,
      meter: getMeter()
    };
  }

  function dispose() {
    ping.dispose();
    damp.dispose();
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
