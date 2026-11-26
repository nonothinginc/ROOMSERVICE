import {
  KIT_NAMES,
  buildKitAssignment,
  computePeaks,
  ensureFactoryDrumKits,
  getReversedBuffer,
  getSamplePool
} from '../audio/drum-kits.js';
import { analyzeAudioBuffer } from '../audio/bpm-detector.js';

export const meta = {
  id: 'drum8',
  name: 'DRUM-8',
  category: 'instrument',
  visualizer: 'meter',
  params: [
    { id: 'mode', label: 'MODE', control: 'segmented', options: ['SYNTH', 'RACK'], min: 0, max: 1, default: 0, step: 1, unit: '' },
    { id: 'kit', label: 'KIT', control: 'segmented', options: ['909', '808', 'RAND', 'COMBO'], showWhen: { param: 'mode', equals: 1 }, min: 0, max: 3, default: 0, step: 1, unit: '' },
    { id: 'tune', label: 'TUNE', min: -12, max: 12, default: 0, step: 0.5, unit: 'st' },
    { id: 'decay', label: 'DEC', min: 0.2, max: 2.0, default: 1.0, step: 0.05, unit: 'x' },
    { id: 'tone', label: 'TONE', min: 400, max: 14000, default: 9500, step: 50, unit: 'Hz', curve: 'exp' },
    { id: 'drive', label: 'DRV', min: 0, max: 100, default: 18, step: 1, unit: '%' }
  ]
};

export const DRUM_VOICE_NAMES = ['KICK', 'SNARE', 'CLAP', 'CH', 'OH', 'RIM', 'TOM', 'PERC'];

export function createNode(Tone) {
  const rawCtx = Tone.getContext().rawContext;
  ensureFactoryDrumKits(rawCtx);

  const input = new Tone.Gain(1);
  const output = new Tone.Gain(0.85);
  const bus = new Tone.Gain(1);
  const toneFilter = new Tone.Filter({ type: 'lowpass', frequency: 9500, Q: 0.7 });
  const shaper = new Tone.Distortion({ distortion: 0.14, wet: 0.18 });
  const meter = new Tone.Meter({ smoothing: 0.75 });

  bus.connect(shaper);
  shaper.connect(toneFilter);
  toneFilter.connect(output);
  output.connect(meter);

  // Mode 0: Synthesized 8-voice engine
  const kick = new Tone.MembraneSynth({
    pitchDecay: 0.045,
    octaves: 6,
    oscillator: { type: 'sine' },
    envelope: { attack: 0.001, decay: 0.32, sustain: 0.01, release: 0.12 }
  }).connect(bus);

  const snareBody = new Tone.MembraneSynth({
    pitchDecay: 0.02,
    octaves: 2.5,
    oscillator: { type: 'triangle' },
    envelope: { attack: 0.001, decay: 0.12, sustain: 0, release: 0.06 }
  }).connect(bus);

  const snareNoiseFilter = new Tone.Filter({ type: 'highpass', frequency: 1400 }).connect(bus);
  const snareNoise = new Tone.NoiseSynth({
    noise: { type: 'white' },
    envelope: { attack: 0.001, decay: 0.17, sustain: 0, release: 0.05 }
  }).connect(snareNoiseFilter);

  const clapFilter = new Tone.Filter({ type: 'bandpass', frequency: 1800, Q: 1.4 }).connect(bus);
  const clap = new Tone.NoiseSynth({
    noise: { type: 'pink' },
    envelope: { attack: 0.002, decay: 0.22, sustain: 0, release: 0.08 }
  }).connect(clapFilter);

  const hatFilter = new Tone.Filter({ type: 'highpass', frequency: 6500 }).connect(bus);
  const closedHat = new Tone.NoiseSynth({
    noise: { type: 'white' },
    envelope: { attack: 0.001, decay: 0.045, sustain: 0, release: 0.02 }
  }).connect(hatFilter);

  const openHat = new Tone.NoiseSynth({
    noise: { type: 'white' },
    envelope: { attack: 0.001, decay: 0.28, sustain: 0, release: 0.08 }
  }).connect(hatFilter);

  const rim = new Tone.Synth({
    oscillator: { type: 'triangle' },
    envelope: { attack: 0.001, decay: 0.045, sustain: 0, release: 0.02 }
  }).connect(bus);

  const tom = new Tone.MembraneSynth({
    pitchDecay: 0.035,
    octaves: 3.5,
    envelope: { attack: 0.002, decay: 0.22, sustain: 0, release: 0.08 }
  }).connect(bus);

  const perc = new Tone.FMSynth({
    harmonicity: 2.7,
    modulationIndex: 7,
    envelope: { attack: 0.001, decay: 0.11, sustain: 0, release: 0.04 },
    modulationEnvelope: { attack: 0.001, decay: 0.08, sustain: 0, release: 0.02 }
  }).connect(bus);

  // Mode 1: 16-Pad Sample Rack
  const pads = Array.from({ length: 16 }, (_, index) => ({
    index,
    midi: 48 + index,
    name: index < 8 ? DRUM_VOICE_NAMES[index] : `PAD ${String(index + 1).padStart(2, '0')}`,
    bank: 'EMPTY',
    sampleId: null,
    buffer: null,
    peaks: [],
    duration: 0,
    active: false,
    startNorm: 0,
    endNorm: 1,
    tune: 0,
    gain: 1,
    reverse: false,
    chokeGroup: index === 3 || index === 4 ? 1 : 0
  }));

  const padFlashAt = new Array(16).fill(0);
  const lastVoiceTime = new Array(16).fill(-1);
  const activeChokePlayers = new Map();
  let lastTriggerLevel = 0;

  const state = {
    mode: 0, // 0 = SYNTH, 1 = RACK
    kit: 0, // 0 = 909, 1 = 808, 2 = RAND, 3 = COMBO
    tune: 0,
    decay: 1.0,
    tone: 9500,
    drive: 18
  };

  function applyKit(kitIdx) {
    ensureFactoryDrumKits(Tone.getContext().rawContext);
    const kitName = KIT_NAMES[Math.max(0, Math.min(KIT_NAMES.length - 1, Math.round(kitIdx)))];
    const assigned = buildKitAssignment(kitName);
    for (let i = 0; i < 8; i++) {
      const smp = assigned[i];
      if (!smp) continue;
      pads[i].name = smp.name;
      pads[i].bank = smp.bank;
      pads[i].sampleId = smp.id;
      pads[i].buffer = smp.buffer;
      pads[i].peaks = smp.peaks;
      pads[i].duration = smp.duration;
      pads[i].active = true;
      pads[i].startNorm = 0;
      pads[i].endNorm = 1;
      pads[i].reverse = false;
      pads[i].chokeGroup = i === 3 || i === 4 ? 1 : 0;
    }
  }

  applyKit(0);

  function rerollKit() {
    applyKit(state.kit);
  }

  function setPadSample(padIdx, sampleEntry, opts = {}) {
    if (padIdx < 0 || padIdx >= 16 || !sampleEntry) return;
    const pad = pads[padIdx];
    pad.name = opts.name || sampleEntry.name || `PAD ${String(padIdx + 1).padStart(2, '0')}`;
    pad.bank = opts.bank || sampleEntry.bank || 'USER';
    pad.sampleId = sampleEntry.id || null;
    pad.buffer = sampleEntry.buffer;
    pad.peaks = sampleEntry.peaks || computePeaks(sampleEntry.buffer);
    pad.duration = sampleEntry.duration || sampleEntry.buffer?.duration || 0;
    pad.active = true;
    pad.startNorm = opts.startNorm ?? 0;
    pad.endNorm = opts.endNorm ?? 1;
    pad.tune = opts.tune ?? 0;
    pad.gain = opts.gain ?? 1;
    pad.reverse = Boolean(opts.reverse);
    if (opts.chokeGroup !== undefined) pad.chokeGroup = opts.chokeGroup;
  }

  function updatePad(padIdx, patch) {
    const pad = pads[padIdx];
    if (!pad) return;
    Object.assign(pad, patch);
  }

  function clearPad(padIdx) {
    const pad = pads[padIdx];
    if (!pad) return;
    pad.active = false;
    pad.buffer = null;
    pad.peaks = [];
    pad.sampleId = null;
    pad.bank = 'EMPTY';
    pad.name = `PAD ${String(padIdx + 1).padStart(2, '0')}`;
    pad.startNorm = 0;
    pad.endNorm = 1;
    pad.reverse = false;
  }

  function chopPadAcrossPads(sourcePadIdx, count = 8, chopMode = 'EQUAL') {
    const src = pads[sourcePadIdx];
    if (!src || !src.buffer) return false;
    const n = Math.max(2, Math.min(16, count));
    const dur = src.buffer.duration || 1;
    const regionStart = src.startNorm;
    const regionEnd = Math.max(regionStart + 0.04, src.endNorm);
    const cuts = [];

    if (chopMode === 'TRANSIENTS') {
      const analysis = analyzeAudioBuffer(src.buffer);
      const tNorms = analysis.transients
        .map((t) => t / dur)
        .filter((x) => x > regionStart + 0.01 && x < regionEnd - 0.01);
      const pts = [regionStart, ...tNorms.slice(0, n - 1), regionEnd];
      for (let i = 0; i < n; i++) {
        const a = pts[i] ?? regionStart + (i / n) * (regionEnd - regionStart);
        const b = pts[i + 1] ?? regionEnd;
        cuts.push([a, Math.max(a + 0.015, b)]);
      }
    } else {
      const span = regionEnd - regionStart;
      for (let i = 0; i < n; i++) {
        cuts.push([regionStart + (i / n) * span, regionStart + ((i + 1) / n) * span]);
      }
    }

    for (let i = 0; i < n; i++) {
      setPadSample(
        i,
        {
          id: src.sampleId,
          name: `CHOP ${String(i + 1).padStart(2, '0')}`,
          bank: 'CHOP',
          buffer: src.buffer,
          peaks: src.peaks,
          duration: dur
        },
        {
          startNorm: cuts[i][0],
          endNorm: cuts[i][1],
          chokeGroup: 1
        }
      );
    }
    return true;
  }

  function loadSample(voiceIdx, audioBuffer) {
    if (voiceIdx >= 0 && voiceIdx < 16 && audioBuffer) {
      setPadSample(voiceIdx, {
        id: `ext_${voiceIdx}`,
        name: `SMP ${String(voiceIdx + 1).padStart(2, '0')}`,
        bank: 'USER',
        buffer: audioBuffer,
        peaks: computePeaks(audioBuffer),
        duration: audioBuffer.duration
      });
    }
  }

  function voiceTime(voiceIdx, time) {
    const now = Tone.immediate();
    const base = typeof time === 'number' ? time : now;
    const t = Math.max(base, now, lastVoiceTime[voiceIdx] + 0.001);
    lastVoiceTime[voiceIdx] = t;
    return t;
  }

  function tuneFreq(hz) {
    return hz * Math.pow(2, state.tune / 12);
  }

  function setParam(id, value) {
    if (!(id in state)) return;
    const prev = state[id];
    state[id] = value;
    const now = Tone.now();

    if (id === 'kit') {
      const nextKit = Math.round(value);
      if (nextKit !== Math.round(prev)) {
        applyKit(nextKit);
      }
    } else if (id === 'tone') {
      toneFilter.frequency.setTargetAtTime(Math.max(200, value), now, 0.015);
    } else if (id === 'drive') {
      shaper.wet.setTargetAtTime(Math.max(0, Math.min(1, value / 100)), now, 0.015);
      shaper.distortion = 0.05 + (value / 100) * 0.75;
    } else if (id === 'decay') {
      kick.envelope.decay = 0.32 * value;
      snareNoise.envelope.decay = 0.17 * value;
      closedHat.envelope.decay = Math.max(0.02, 0.045 * value);
      openHat.envelope.decay = 0.28 * value;
      tom.envelope.decay = 0.22 * value;
    }
  }

  function triggerRackPad(idx, time, vel) {
    const pad = pads[idx];
    if (!pad || !pad.active || !pad.buffer) return;
    const t = voiceTime(idx, time);

    if (pad.chokeGroup > 0) {
      const prevSrc = activeChokePlayers.get(pad.chokeGroup);
      if (prevSrc) {
        try {
          prevSrc.stop(t);
        } catch {
          // ignore
        }
      }
    }

    const toneCtx = Tone.getContext();
    const buf = pad.reverse ? getReversedBuffer(toneCtx.rawContext, pad.buffer) : pad.buffer;
    const dur = buf.duration || 0.25;
    const s = Math.max(0, Math.min(0.98, pad.reverse ? 1 - pad.endNorm : pad.startNorm));
    const e = Math.max(s + 0.01, Math.min(1, pad.reverse ? 1 - pad.startNorm : pad.endNorm));
    const offset = s * dur;
    const sliceDur = Math.max(0.015, (e - s) * dur * Math.min(2.0, state.decay));

    const src = toneCtx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.setValueAtTime(Math.pow(2, (state.tune + pad.tune) / 12), t);

    const srcGain = toneCtx.createGain();
    srcGain.gain.setValueAtTime(Math.max(0.02, Math.min(1.4, vel * pad.gain)), t);

    src.connect(srcGain);
    Tone.connect(srcGain, bus);

    if (pad.chokeGroup > 0) {
      activeChokePlayers.set(pad.chokeGroup, src);
    }

    src.onended = () => {
      if (pad.chokeGroup > 0 && activeChokePlayers.get(pad.chokeGroup) === src) {
        activeChokePlayers.delete(pad.chokeGroup);
      }
      try {
        src.disconnect();
        srcGain.disconnect();
      } catch {
        // ignore
      }
    };

    try {
      src.start(t, offset, sliceDur);
    } catch {
      try {
        src.disconnect();
        srcGain.disconnect();
      } catch {
        // ignore
      }
    }
  }

  function triggerNote(midi, durSec = 0.15, time, vel = 0.85) {
    const rawIdx = Math.round(midi) - 48;
    const v = Math.max(0.05, Math.min(1, vel));
    lastTriggerLevel = v;

    if (Math.round(state.mode) === 1) {
      if (rawIdx >= 0 && rawIdx < 16) {
        padFlashAt[rawIdx] = performance.now();
        triggerRackPad(rawIdx, time, v);
      }
      return;
    }

    const idx = ((rawIdx % 8) + 8) % 8;
    padFlashAt[idx] = performance.now();
    const t = voiceTime(idx, time);

    switch (idx) {
      case 0:
        kick.triggerAttackRelease(tuneFreq(50), Math.max(0.08, 0.25 * state.decay), t, v);
        break;
      case 1:
        snareBody.triggerAttackRelease(tuneFreq(185), 0.1, t, v * 0.7);
        snareNoise.triggerAttackRelease(Math.max(0.05, 0.15 * state.decay), t, v * 0.75);
        break;
      case 2:
        clap.triggerAttackRelease(Math.max(0.06, 0.18 * state.decay), t, v * 0.9);
        break;
      case 3:
        closedHat.triggerAttackRelease(Math.max(0.02, 0.04 * state.decay), t, v * 0.75);
        break;
      case 4:
        openHat.triggerAttackRelease(Math.max(0.08, 0.26 * state.decay), t, v * 0.75);
        break;
      case 5:
        rim.triggerAttackRelease(tuneFreq(780), 0.04, t, v * 0.7);
        break;
      case 6:
        tom.triggerAttackRelease(tuneFreq(115), Math.max(0.08, 0.2 * state.decay), t, v * 0.85);
        break;
      case 7:
        perc.triggerAttackRelease(tuneFreq(340), Math.max(0.04, 0.1 * state.decay), t, v * 0.8);
        break;
    }
  }

  function releaseAll() {}

  function getActiveSources() {
    if (Math.round(state.mode) === 0) {
      return DRUM_VOICE_NAMES.map((name, index) => ({
        index,
        midi: 48 + index,
        label: `${String(index + 1).padStart(2, '0')} ${name}`
      }));
    }
    const active = pads
      .filter((p) => p.active)
      .map((p) => ({
        index: p.index,
        midi: p.midi,
        label: `${String(p.index + 1).padStart(2, '0')} ${p.name}`
      }));
    return active.length > 0
      ? active
      : [{ index: 0, midi: 48, label: '01 PAD 01' }];
  }

  function getPadInfo() {
    return {
      mode: Math.round(state.mode),
      kit: Math.round(state.kit),
      pads,
      padFlashAt,
      poolCount: getSamplePool().length
    };
  }

  function getMeter() {
    const db = meter.getValue();
    const norm = Math.max(0, Math.min(1, (db + 60) / 60));
    lastTriggerLevel = Math.max(lastTriggerLevel * 0.88, norm);
    return norm;
  }

  function getVisualizerData() {
    return { type: 'meter', value: getMeter() };
  }

  function dispose() {
    for (const pl of activeChokePlayers.values()) {
      try {
        pl.dispose();
      } catch {
        // ignore
      }
    }
    activeChokePlayers.clear();
    kick.dispose();
    snareBody.dispose();
    snareNoise.dispose();
    snareNoiseFilter.dispose();
    clap.dispose();
    clapFilter.dispose();
    closedHat.dispose();
    openHat.dispose();
    hatFilter.dispose();
    rim.dispose();
    tom.dispose();
    perc.dispose();
    shaper.dispose();
    toneFilter.dispose();
    bus.dispose();
    meter.dispose();
    input.dispose();
    output.dispose();
  }

  return {
    input,
    output,
    setParam,
    triggerNote,
    releaseAll,
    loadSample,
    applyKit,
    rerollKit,
    setPadSample,
    updatePad,
    clearPad,
    chopPadAcrossPads,
    getActiveSources,
    getPadInfo,
    getMeter,
    getVisualizerData,
    dispose
  };
}
