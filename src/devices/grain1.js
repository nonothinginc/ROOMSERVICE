export const meta = {
  id: 'grain1',
  name: 'GRAIN-1',
  category: 'instrument',
  visualizer: 'grains',
  params: [
    { id: 'grainSize', label: 'SIZE', min: 0.02, max: 0.35, default: 0.11, step: 0.005, unit: 's' },
    { id: 'overlap', label: 'OVLP', min: 0.01, max: 0.2, default: 0.06, step: 0.005, unit: 's' },
    { id: 'spray', label: 'SPRY', min: 0, max: 100, default: 28, step: 1, unit: '%' },
    { id: 'pitch', label: 'PTCH', min: -24, max: 24, default: 0, step: 0.5, unit: 'st' },
    { id: 'revProb', label: 'REV', min: 0, max: 100, default: 15, step: 1, unit: '%' },
    { id: 'position', label: 'POS', min: 0, max: 100, default: 32, step: 1, unit: '%' }
  ]
};

function createProceduralCloudBuffer(Tone) {
  const ctx = Tone.getContext().rawContext;
  const sr = ctx.sampleRate || 44100;
  const len = Math.floor(sr * 3.0);
  const buf = ctx.createBuffer(2, len, sr);
  const freqs = [110, 164.81, 220, 277.18, 329.63, 440, 554.37, 659.25];

  for (let ch = 0; ch < 2; ch++) {
    const data = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      const env = Math.sin((i / len) * Math.PI);
      let s = 0;
      for (let k = 0; k < freqs.length; k++) {
        const detune = ch === 0 ? 1 + k * 0.0012 : 1 - k * 0.0011;
        const mod = 0.5 + 0.5 * Math.sin(2 * Math.PI * (0.2 + k * 0.07) * t + k);
        s += Math.sin(2 * Math.PI * freqs[k] * detune * t) * mod * (0.22 / (1 + k * 0.35));
      }
      data[i] = s * (0.3 + 0.7 * env);
    }
  }
  return buf;
}

export function createNode(Tone) {
  const input = new Tone.Gain(1);
  const output = new Tone.Gain(0.8);
  const vca = new Tone.Gain(0);
  const filter = new Tone.Filter({ type: 'lowpass', frequency: 9500, Q: 0.9 });

  const cloudBuffer = createProceduralCloudBuffer(Tone);
  const player = new Tone.GrainPlayer({
    url: cloudBuffer,
    loop: true,
    grainSize: 0.11,
    overlap: 0.06,
    playbackRate: 1,
    detune: 0
  });

  player.connect(filter);
  filter.connect(vca);
  vca.connect(output);

  const state = {
    grainSize: 0.11,
    overlap: 0.06,
    spray: 28,
    pitch: 0,
    revProb: 15,
    position: 32
  };

  let started = false;
  let lastTime = -1;
  let bufferDuration = cloudBuffer.duration || 3.0;

  const particles = Array.from({ length: 24 }, (_, i) => ({
    x: (i / 24),
    y: 0.5,
    life: Math.random()
  }));

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
    if (id === 'grainSize') {
      player.grainSize = Math.max(0.015, Math.min(0.5, value));
    } else if (id === 'overlap') {
      player.overlap = Math.max(0.005, Math.min(0.3, value));
    } else if (id === 'pitch') {
      player.detune = value * 100;
    } else if (id === 'position') {
      const pos = Math.max(0, Math.min(0.95, value / 100)) * bufferDuration;
      player.loopStart = pos;
      player.loopEnd = Math.min(bufferDuration, pos + Math.max(0.25, state.grainSize * 4));
    }
  }

  function setXY(x, y) {
    // x: -1..1 -> position, y: -1..1 -> spray
    const posPct = Math.max(0, Math.min(100, (x * 0.5 + 0.5) * 100));
    const sprayPct = Math.max(0, Math.min(100, (y * 0.5 + 0.5) * 100));
    setParam('position', posPct);
    setParam('spray', sprayPct);
  }

  function loadBuffer(audioBuffer) {
    if (!audioBuffer) return;
    player.buffer.set(audioBuffer);
    bufferDuration = audioBuffer.duration || 1.0;
    setParam('position', state.position);
  }

  function triggerNote(midi, durSec = 0.25, time, vel = 0.85) {
    const t = monotonic(time);
    const basePitch = (midi - 60) * 100;
    const sprayRange = (state.spray / 100) * 0.45 * bufferDuration;
    const jitter = (Math.random() - 0.5) * sprayRange;
    const basePos = (state.position / 100) * Math.max(0.2, bufferDuration - 0.3);
    const offset = Math.max(0, Math.min(bufferDuration - 0.08, basePos + jitter));

    player.detune = state.pitch * 100 + basePitch;
    player.reverse = Math.random() * 100 < state.revProb;

    if (!started) {
      try {
        player.start(t, offset);
        started = true;
      } catch {
        // ignore if context locked
      }
    }

    const amp = Math.max(0.08, Math.min(1, vel)) * 0.85;
    vca.gain.cancelScheduledValues(t);
    vca.gain.setValueAtTime(0.0001, t);
    vca.gain.linearRampToValueAtTime(amp, t + 0.025);
    vca.gain.setTargetAtTime(0.0001, t + Math.max(0.04, durSec), Math.max(0.04, state.grainSize));
  }

  function releaseAll(time) {
    const t = monotonic(time);
    vca.gain.cancelScheduledValues(t);
    vca.gain.setTargetAtTime(0.0001, t, 0.04);
  }

  function getVisualizerData() {
    const posNorm = state.position / 100;
    const sprNorm = state.spray / 100;
    for (const p of particles) {
      p.life += 0.045;
      if (p.life >= 1) {
        p.life = 0;
        p.x = Math.max(0.05, Math.min(0.95, posNorm + (Math.random() - 0.5) * sprNorm * 0.8));
        p.y = Math.max(0.1, Math.min(0.9, 0.5 + (Math.random() - 0.5) * (0.25 + sprNorm * 0.7)));
      }
    }
    return {
      type: 'grains',
      particles: particles.map((p) => ({ x: p.x, y: p.y, r: 1 + (1 - p.life) * (state.grainSize * 12) }))
    };
  }

  function dispose() {
    try {
      if (started) player.stop();
    } catch {
      // ignore
    }
    player.dispose();
    filter.dispose();
    vca.dispose();
    input.dispose();
    output.dispose();
  }

  return {
    input,
    output,
    setParam,
    setXY,
    loadBuffer,
    triggerNote,
    releaseAll,
    getVisualizerData,
    dispose
  };
}
