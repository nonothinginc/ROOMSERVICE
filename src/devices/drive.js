export const meta = {
  id: 'drive',
  name: 'DRIVE',
  category: 'effect',
  visualizer: 'curve',
  params: [
    { id: 'drive', label: 'DRV', min: 0, max: 100, default: 30, step: 1, unit: '%' },
    { id: 'bits', label: 'BITS', min: 2, max: 16, default: 16, step: 1, unit: 'b' },
    { id: 'crush', label: 'RATE', min: 0, max: 100, default: 0, step: 1, unit: '%' },
    { id: 'tone', label: 'TONE', min: 600, max: 16000, default: 9000, step: 50, unit: 'Hz', curve: 'exp' },
    { id: 'mix', label: 'MIX', min: 0, max: 100, default: 60, step: 1, unit: '%' }
  ]
};

const WORKLET_CODE = `
class SampleHoldProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: 'crush', defaultValue: 0, minValue: 0, maxValue: 1 }];
  }
  constructor() {
    super();
    this.phasor = 0;
    this.last = [0, 0];
  }
  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !output) return true;
    const crushArr = parameters.crush;
    for (let ch = 0; ch < output.length; ch++) {
      const inp = input[ch] || input[0];
      const out = output[ch];
      if (!inp || !out) continue;
      let phasor = this.phasor;
      let held = this.last[ch] || 0;
      for (let i = 0; i < out.length; i++) {
        const c = crushArr.length > 1 ? crushArr[i] : crushArr[0];
        const step = Math.max(0.02, 1 - c * 0.96);
        phasor += step;
        if (phasor >= 1) {
          phasor -= 1;
          held = inp[i];
        }
        out[i] = held;
      }
      if (ch === 0) this.phasor = phasor;
      this.last[ch] = held;
    }
    return true;
  }
}
registerProcessor('roomservice-sample-hold', SampleHoldProcessor);
`;

const workletLoadPromises = new WeakMap();

function ensureWorkletLoaded(rawContext) {
  if (!rawContext || !rawContext.audioWorklet) return Promise.resolve(false);
  if (workletLoadPromises.has(rawContext)) return workletLoadPromises.get(rawContext);
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
  workletLoadPromises.set(rawContext, p);
  return p;
}

export function createNode(Tone) {
  const input = new Tone.Gain(1);
  const output = new Tone.Gain(1);
  const dryWet = new Tone.CrossFade(0.6);
  const shaper = new Tone.WaveShaper((x) => x, 512);
  const toneFilter = new Tone.Filter({ type: 'lowpass', frequency: 9000, Q: 0.7 });

  input.connect(dryWet.a);
  input.connect(shaper);
  shaper.connect(toneFilter);
  toneFilter.connect(dryWet.b);
  dryWet.connect(output);

  let workletNode = null;
  let disposed = false;

  const state = {
    drive: 30,
    bits: 16,
    crush: 0,
    tone: 9000,
    mix: 60
  };

  function updateCurve() {
    const amount = 1 + (state.drive / 100) * 14;
    const levels = Math.pow(2, Math.max(2, Math.round(state.bits)) - 1);
    const useBits = Math.round(state.bits) < 16;
    shaper.setMap((x) => {
      let y = Math.tanh(x * amount) / Math.tanh(amount);
      if (useBits) {
        y = Math.round(y * levels) / levels;
      }
      return y;
    });
  }

  updateCurve();

  // The sample-rate crusher is a JS AudioWorklet. Keep it OUT of the signal path unless RATE > 0:
  // on Android WebView worklets are not reliably real-time, and an idle worklet on every drum
  // track crackled the whole mix.
  const rawCtx = Tone.getContext().rawContext;
  let workletReady = false;
  let crusherInPath = false;
  ensureWorkletLoaded(rawCtx).then((ok) => {
    workletReady = Boolean(ok) && !disposed;
    syncCrusher();
  });

  function syncCrusher() {
    const want = workletReady && state.crush > 0;
    if (want === crusherInPath || disposed) return;
    try {
      if (want) {
        if (!workletNode) {
          workletNode = new AudioWorkletNode(rawCtx, 'roomservice-sample-hold');
        }
        const param = workletNode.parameters.get('crush');
        if (param) param.value = state.crush / 100;
        shaper.disconnect(toneFilter);
        Tone.connect(shaper, workletNode);
        Tone.connect(workletNode, toneFilter);
      } else {
        shaper.disconnect(workletNode);
        workletNode.disconnect();
        Tone.connect(shaper, toneFilter);
      }
      crusherInPath = want;
    } catch {
      // keep whatever path is intact
    }
  }

  function setParam(id, value) {
    if (!(id in state)) return;
    state[id] = value;
    const now = Tone.now();
    if (id === 'drive' || id === 'bits') {
      updateCurve();
    } else if (id === 'crush') {
      syncCrusher();
      if (workletNode) {
        const param = workletNode.parameters.get('crush');
        if (param) param.setTargetAtTime(Math.max(0, Math.min(1, value / 100)), now, 0.015);
      }
    } else if (id === 'tone') {
      toneFilter.frequency.setTargetAtTime(Math.max(300, value), now, 0.015);
    } else if (id === 'mix') {
      dryWet.fade.setTargetAtTime(Math.max(0, Math.min(1, value / 100)), now, 0.015);
    }
  }

  function getVisualizerData() {
    const pts = [];
    const amount = 1 + (state.drive / 100) * 14;
    const levels = Math.pow(2, Math.max(2, Math.round(state.bits)) - 1);
    const useBits = Math.round(state.bits) < 16;
    for (let i = 0; i < 48; i++) {
      const x = (i / 47) * 2 - 1;
      let y = Math.tanh(x * amount) / Math.tanh(amount);
      if (useBits) y = Math.round(y * levels) / levels;
      pts.push(y);
    }
    return { type: 'curve', points: pts };
  }

  function dispose() {
    disposed = true;
    try {
      if (workletNode) workletNode.disconnect();
    } catch {
      // ignore
    }
    shaper.dispose();
    toneFilter.dispose();
    dryWet.dispose();
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
