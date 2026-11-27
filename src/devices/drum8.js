import {
  KIT_NAMES,
  buildKitAssignment,
  computePeaks,
  ensureFactoryDrumKits,
  getReversedBuffer,
  getSampleById,
  getSamplePool,
  onDrumKitsUpdated
} from '../audio/drum-kits.js';
import { getVaBuffer, triggerVA808, triggerVA909 } from '../audio/analog-drums.js';
import { analyzeAudioBuffer } from '../audio/bpm-detector.js';

export const meta = {
  id: 'drum8',
  name: 'DRUM-8',
  category: 'instrument',
  visualizer: 'meter',
  params: [
    { id: 'mode', label: 'MODE', control: 'segmented', options: ['SYNTH', 'RACK'], min: 0, max: 1, default: 0, step: 1, unit: '' },
    { id: 'kit', label: 'KIT', control: 'segmented', options: ['909', '808', 'RAND', 'COMBO'], min: 0, max: 3, default: 0, step: 1, unit: '' },
    { id: 'tune', label: 'TUNE', min: -12, max: 12, default: 0, step: 0.5, unit: 'st' },
    { id: 'decay', label: 'DEC', min: 0.2, max: 2.0, default: 1.0, step: 0.05, unit: 'x' },
    { id: 'tone', label: 'TONE', min: 400, max: 14000, default: 9500, step: 50, unit: 'Hz', curve: 'exp' },
    { id: 'drive', label: 'DRV', min: 0, max: 100, default: 18, step: 1, unit: '%' }
  ],
  extendedParams: [
    { id: 'punch', label: 'PUNCH', min: 0, max: 100, default: 30, step: 1, unit: '%' },
    { id: 'sub', label: 'SUB', min: -12, max: 12, default: 2, step: 0.5, unit: 'dB' },
    { id: 'air', label: 'AIR', min: -12, max: 12, default: 1, step: 0.5, unit: 'dB' },
    { id: 'hpf', label: 'HPF', min: 20, max: 1200, default: 24, step: 5, unit: 'Hz', curve: 'exp' },
    { id: 'comp', label: 'GLUE', min: 0, max: 100, default: 25, step: 1, unit: '%' },
    { id: 'width', label: 'WIDTH', min: 0, max: 100, default: 60, step: 1, unit: '%' }
  ]
};

export const DRUM_VOICE_NAMES = ['KICK', 'SNARE', 'CLAP', 'CH', 'OH', 'RIM', 'TOM', 'PERC'];
const DEFAULT_VOICE_PANS = [0, 0, 0, -0.22, 0.24, 0.32, -0.26, 0.36];
// Classic 808+909 COMBO circuit map (0 = 909, 1 = 808): 808 Kick/CH/OH/Cowbell + 909 Snare/Clap/Rim/Tom
const COMBO_SYNTH_MAP = [1, 0, 0, 1, 1, 0, 0, 1];

const driveCurveCache = new Map();
function getPadDriveCurve(drivePct) {
  const bucket = Math.max(5, Math.min(100, Math.round(drivePct / 5) * 5));
  if (driveCurveCache.has(bucket)) return driveCurveCache.get(bucket);
  const n = 256;
  const curve = new Float32Array(n);
  const k = 1 + (bucket / 100) * 14;
  const norm = Math.tanh(k);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * k) / norm;
  }
  driveCurveCache.set(bucket, curve);
  return curve;
}

export function createNode(Tone) {
  const rawCtx = Tone.getContext().rawContext;
  ensureFactoryDrumKits(rawCtx);

  const input = new Tone.Gain(1);
  const output = new Tone.Gain(0.88);
  const bus = new Tone.Gain(1);
  const busHpf = new Tone.Filter({ type: 'highpass', frequency: 24, Q: 0.7 });
  const subShelf = new Tone.Filter({ type: 'lowshelf', frequency: 75, gain: 2 });
  const airShelf = new Tone.Filter({ type: 'highshelf', frequency: 7500, gain: 1 });
  const shaper = new Tone.Distortion({ distortion: 0.14, wet: 0.18 });
  const toneFilter = new Tone.Filter({ type: 'lowpass', frequency: 9500, Q: 0.7 });
  const busComp = new Tone.Compressor({ threshold: -12, ratio: 3.1, attack: 0.012, release: 0.11 });
  const compMakeup = new Tone.Gain(1.12);
  const meter = new Tone.Meter({ smoothing: 0.75 });

  bus.connect(busHpf);
  busHpf.connect(subShelf);
  subShelf.connect(airShelf);
  airShelf.connect(shaper);
  shaper.connect(toneFilter);
  toneFilter.connect(busComp);
  busComp.connect(compMakeup);
  compMakeup.connect(output);
  output.connect(meter);

  // Per-voice stereo, filter & drive strip for Mode 0 (Virtual Analog 808/909 SYNTH)
  const synthStrips = Array.from({ length: 8 }, (_, idx) => {
    const rawIn = rawCtx.createGain();
    const filter = new Tone.Filter({ type: 'lowpass', frequency: 18000, Q: 0.7 });
    const shaperNode = rawCtx.createWaveShaper();
    const gain = new Tone.Gain(1);
    const panner = new Tone.Panner(DEFAULT_VOICE_PANS[idx] * 0.6);
    Tone.connect(rawIn, filter);
    filter.connect(gain);
    gain.connect(panner);
    panner.connect(bus);
    return { rawIn, filter, shaperNode, gain, panner, driveActive: false };
  });

  // Mode 1: 16-Pad Sample Rack + Per-Pad Modulation
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
    pitchEnv: 0,
    attack: 0,
    decay: 1.0,
    filterType: 'lowpass',
    cutoff: 18000,
    res: 0.7,
    drive: 0,
    pan: index < 8 ? DEFAULT_VOICE_PANS[index] : 0,
    gain: 1,
    reverse: false,
    chokeGroup: index === 3 || index === 4 ? 1 : 0
  }));

  const padFlashAt = new Array(16).fill(0);
  const lastVoiceTime = new Array(16).fill(-1);
  const activeChokePlayers = new Map();
  let synthVoiceCircuit = new Array(8).fill(0); // 0 = VA-909, 1 = VA-808
  let lastTriggerLevel = 0;

  const state = {
    mode: 0,
    kit: 0,
    tune: 0,
    decay: 1.0,
    tone: 9500,
    drive: 18,
    punch: 30,
    sub: 2,
    air: 1,
    hpf: 24,
    comp: 25,
    width: 60
  };

  function refreshSynthCircuitMap(kitIdx) {
    const k = Math.max(0, Math.min(3, Math.round(kitIdx)));
    if (k === 0) synthVoiceCircuit = new Array(8).fill(0);
    else if (k === 1) synthVoiceCircuit = new Array(8).fill(1);
    else if (k === 3) synthVoiceCircuit = [...COMBO_SYNTH_MAP];
    else synthVoiceCircuit = Array.from({ length: 8 }, () => (Math.random() < 0.5 ? 0 : 1));
  }

  function syncSynthStrip(idx) {
    const strip = synthStrips[idx];
    const pad = pads[idx];
    if (!strip || !pad) return;
    const now = Tone.now();
    strip.filter.type = pad.filterType || 'lowpass';
    strip.filter.frequency.setTargetAtTime(Math.max(80, Math.min(20000, pad.cutoff ?? 18000)), now, 0.015);
    strip.filter.Q.setTargetAtTime(Math.max(0.4, Math.min(18, pad.res ?? 0.7)), now, 0.015);
    strip.gain.gain.setTargetAtTime(Math.max(0.05, Math.min(1.6, pad.gain ?? 1)), now, 0.015);
    strip.panner.pan.setTargetAtTime(Math.max(-1, Math.min(1, (pad.pan || 0) * (state.width / 100))), now, 0.015);
  }

  function syncBusDynamics() {
    const now = Tone.now();
    busComp.threshold.setTargetAtTime(-4 - (state.comp / 100) * 24, now, 0.02);
    busComp.ratio.setTargetAtTime(1.5 + (state.comp / 100) * 6.5, now, 0.02);
    busComp.attack.setTargetAtTime(0.003 + (state.punch / 100) * 0.028, now, 0.02);
    compMakeup.gain.setTargetAtTime(1 + (state.comp / 100) * 0.32 + (state.punch / 100) * 0.2, now, 0.02);
  }

  syncBusDynamics();

  function applyKit(kitIdx) {
    ensureFactoryDrumKits(Tone.getContext().rawContext);
    refreshSynthCircuitMap(kitIdx);
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

  // When authentic WAV samples finish decoding asynchronously, refresh matching pads seamlessly
  const unsubKits = onDrumKitsUpdated(() => {
    for (let i = 0; i < 16; i++) {
      const p = pads[i];
      if (!p.sampleId) continue;
      const fresh = getSampleById(p.sampleId);
      if (fresh && fresh.buffer && fresh.buffer !== p.buffer) {
        p.buffer = fresh.buffer;
        p.peaks = fresh.peaks;
        p.duration = fresh.duration;
      }
    }
  });

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
    if (padIdx < 8) syncSynthStrip(padIdx);
  }

  function resetPadMod(padIdx) {
    const pad = pads[padIdx];
    if (!pad) return;
    Object.assign(pad, {
      tune: 0,
      pitchEnv: 0,
      attack: 0,
      decay: 1.0,
      filterType: 'lowpass',
      cutoff: 18000,
      res: 0.7,
      drive: 0,
      pan: padIdx < 8 ? DEFAULT_VOICE_PANS[padIdx] : 0,
      gain: 1.0
    });
    if (padIdx < 8) syncSynthStrip(padIdx);
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
    } else if (id === 'hpf') {
      busHpf.frequency.setTargetAtTime(Math.max(20, Math.min(2000, value)), now, 0.015);
    } else if (id === 'sub') {
      subShelf.gain.setTargetAtTime(Math.max(-12, Math.min(12, value)), now, 0.02);
    } else if (id === 'air') {
      airShelf.gain.setTargetAtTime(Math.max(-12, Math.min(12, value)), now, 0.02);
    } else if (id === 'punch' || id === 'comp') {
      syncBusDynamics();
    } else if (id === 'width') {
      for (let i = 0; i < 8; i++) syncSynthStrip(i);
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
    const raw = toneCtx.rawContext;
    const buf = pad.reverse ? getReversedBuffer(raw, pad.buffer) : pad.buffer;
    const dur = buf.duration || 0.25;
    const s = Math.max(0, Math.min(0.98, pad.reverse ? 1 - pad.endNorm : pad.startNorm));
    const e = Math.max(s + 0.01, Math.min(1, pad.reverse ? 1 - pad.startNorm : pad.endNorm));
    const offset = s * dur;
    const baseDur = Math.max(0.015, (e - s) * dur);
    const padDecay = Math.max(0.05, Math.min(2.0, pad.decay ?? 1.0));
    const sliceDur = Math.max(0.015, baseDur * Math.min(2.0, state.decay * padDecay));

    const src = toneCtx.createBufferSource();
    src.buffer = buf;
    const baseRate = Math.max(0.15, Math.min(4.0, Math.pow(2, (state.tune + (pad.tune || 0)) / 12)));
    if (Math.abs(pad.pitchEnv || 0) > 0.15) {
      const envRate = Math.max(0.15, Math.min(4.0, baseRate * Math.pow(2, pad.pitchEnv / 12)));
      src.playbackRate.setValueAtTime(envRate, t);
      src.playbackRate.exponentialRampToValueAtTime(baseRate, t + 0.065);
    } else {
      src.playbackRate.setValueAtTime(baseRate, t);
    }

    const filt = raw.createBiquadFilter();
    filt.type = pad.filterType || 'lowpass';
    filt.frequency.setValueAtTime(Math.max(80, Math.min(20000, pad.cutoff ?? 18000)), t);
    filt.Q.setValueAtTime(Math.max(0.4, Math.min(18, pad.res ?? 0.7)), t);

    let driveNode = null;
    if ((pad.drive || 0) > 1) {
      driveNode = raw.createWaveShaper();
      driveNode.curve = getPadDriveCurve(pad.drive);
    }

    const srcGain = toneCtx.createGain();
    const targetAmp = Math.max(0.02, Math.min(1.6, vel * (pad.gain ?? 1)));
    const atkSec = Math.max(0.001, (pad.attack || 0) / 1000);
    if ((pad.attack || 0) > 1) {
      srcGain.gain.setValueAtTime(0.0001, t);
      srcGain.gain.linearRampToValueAtTime(targetAmp, t + atkSec);
    } else {
      srcGain.gain.setValueAtTime(targetAmp, t);
    }
    if (padDecay < 0.98) {
      srcGain.gain.setTargetAtTime(0.0001, t + atkSec, Math.max(0.012, sliceDur * 0.34));
    }

    const panner = raw.createStereoPanner();
    panner.pan.setValueAtTime(Math.max(-1, Math.min(1, (pad.pan || 0) * (state.width / 100))), t);

    src.connect(filt);
    if (driveNode) {
      filt.connect(driveNode);
      driveNode.connect(srcGain);
    } else {
      filt.connect(srcGain);
    }
    srcGain.connect(panner);
    Tone.connect(panner, bus);

    if (pad.chokeGroup > 0) {
      activeChokePlayers.set(pad.chokeGroup, src);
    }

    src.onended = () => {
      if (pad.chokeGroup > 0 && activeChokePlayers.get(pad.chokeGroup) === src) {
        activeChokePlayers.delete(pad.chokeGroup);
      }
      try {
        src.disconnect();
        filt.disconnect();
        driveNode?.disconnect();
        srcGain.disconnect();
        panner.disconnect();
      } catch {
        // ignore
      }
    };

    try {
      src.start(t, offset, sliceDur);
    } catch {
      try {
        src.disconnect();
        filt.disconnect();
        driveNode?.disconnect();
        srcGain.disconnect();
        panner.disconnect();
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

    // Mode 0: Virtual Analog 808 / 909 Circuit Synthesis
    const idx = ((rawIdx % 8) + 8) % 8;
    padFlashAt[idx] = performance.now();
    const t = voiceTime(idx, time);
    const pad = pads[idx];
    const strip = synthStrips[idx];
    const raw = Tone.getContext().rawContext;

    const totalTune = state.tune + (pad.tune || 0);
    const totalDecay = Math.max(0.15, Math.min(2.4, state.decay * (pad.decay ?? 1.0)));
    const opts = { tune: totalTune, decay: totalDecay, pitchEnv: pad.pitchEnv || 0 };

    if (strip && (pad.attack || 0) > 1) {
      const atk = pad.attack / 1000;
      const g = Math.max(0.05, Math.min(1.6, pad.gain ?? 1));
      strip.gain.gain.setValueAtTime(0.001, t);
      strip.gain.gain.linearRampToValueAtTime(g, t + atk);
    }

    const use808 = synthVoiceCircuit[idx] === 1;
    // Replay the pre-rendered circuit voice (2 nodes) when cached; first hit renders in background
    const cached = getVaBuffer(raw.sampleRate, use808 ? 808 : 909, idx, v, opts);
    if (cached) {
      const src = raw.createBufferSource();
      src.buffer = cached.buffer;
      const g = raw.createGain();
      g.gain.value = v / cached.layerVel;
      src.connect(g);
      g.connect(strip.rawIn);
      src.onended = () => {
        src.disconnect();
        g.disconnect();
      };
      src.start(t);
    } else if (use808) {
      triggerVA808(raw, strip.rawIn, idx, t, v, opts);
    } else {
      triggerVA909(raw, strip.rawIn, idx, t, v, opts);
    }
  }

  function releaseAll() {}

  function getActiveSources() {
    if (Math.round(state.mode) === 0) {
      return DRUM_VOICE_NAMES.map((name, index) => ({
        index,
        midi: 48 + index,
        label: `${String(index + 1).padStart(2, '0')} ${synthVoiceCircuit[index] === 1 ? '808' : '909'} ${name}`
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
      synthVoiceCircuit,
      pads,
      padFlashAt,
      poolCount: getSamplePool().length
    };
  }

  function getGlobalState() {
    return { ...state };
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
    unsubKits();
    for (const pl of activeChokePlayers.values()) {
      try {
        pl.dispose();
      } catch {
        // ignore
      }
    }
    activeChokePlayers.clear();
    for (const s of synthStrips) {
      try {
        s.rawIn.disconnect();
      } catch {
        // ignore
      }
      s.filter.dispose();
      s.gain.dispose();
      s.panner.dispose();
    }
    busHpf.dispose();
    subShelf.dispose();
    airShelf.dispose();
    shaper.dispose();
    toneFilter.dispose();
    busComp.dispose();
    compMakeup.dispose();
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
    resetPadMod,
    clearPad,
    chopPadAcrossPads,
    getActiveSources,
    getPadInfo,
    getGlobalState,
    getMeter,
    getVisualizerData,
    dispose
  };
}
