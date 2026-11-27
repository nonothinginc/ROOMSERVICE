import * as Tone from 'tone';
import { getDevice } from '../device-registry.js';
import { getSongEnd, getSongRange, nextId, store } from '../state/store.js';
import { analyzeAudioBuffer } from './bpm-detector.js';
import { addUserSampleBuffer, ensureFactoryDrumKits, getReversedBuffer, getSamplePool } from './drum-kits.js';
import { createPunchFx } from './punch-fx.js';
import { createTapeDeck } from './tape-deck.js';
import { StretchBanks } from './stretch.js';
import { attachRenderCapacity, getLatencyMode, getLatencyProfile, playoutGlitches, recordSlack, timing } from './perf.js';

function evalAutoClip(autoClip, normX) {
  const pts = autoClip.points;
  if (!pts || pts.length === 0) return 0.5;
  const x = Math.max(0, Math.min(1, normX));
  if (x <= pts[0].x) return pts[0].y;
  if (x >= pts[pts.length - 1].x) return pts[pts.length - 1].y;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    if (x >= a.x && x <= b.x) {
      const t = (x - a.x) / Math.max(0.0001, b.x - a.x);
      // Smooth cosine interpolation for organic Bezier feel
      const mu = (1 - Math.cos(t * Math.PI)) * 0.5;
      return a.y * (1 - mu) + b.y * mu;
    }
  }
  return 0.5;
}

const DB_METER_POINTS = [
  [-60, 0],
  [-48, 0.05],
  [-36, 0.14],
  [-24, 0.30],
  [-18, 0.44],
  [-12, 0.60],
  [-6, 0.78],
  [-3, 0.89],
  [0, 1.0]
];

export function dbToMeterNorm(db) {
  if (!Number.isFinite(db) || db <= -60) return 0;
  if (db >= 0) return 1;
  for (let i = 0; i < DB_METER_POINTS.length - 1; i++) {
    const [db0, n0] = DB_METER_POINTS[i];
    const [db1, n1] = DB_METER_POINTS[i + 1];
    if (db <= db1) {
      const t = (db - db0) / (db1 - db0);
      return n0 + t * (n1 - n0);
    }
  }
  return 1;
}

function emptyMeterInfo() {
  return {
    peakL: 0,
    peakR: 0,
    rmsL: 0,
    rmsR: 0,
    peakDbL: -60,
    peakDbR: -60,
    rmsDbL: -60,
    rmsDbR: -60,
    peakDb: -60,
    rmsDb: -60,
    clip: false
  };
}

function createStereoMeter(rawCtx) {
  const input = rawCtx.createGain();
  input.channelCount = 2;
  input.channelCountMode = 'explicit';
  input.channelInterpretation = 'speakers';

  const splitter = rawCtx.createChannelSplitter(2);
  const analyserL = rawCtx.createAnalyser();
  const analyserR = rawCtx.createAnalyser();
  analyserL.fftSize = 256;
  analyserR.fftSize = 256;
  analyserL.smoothingTimeConstant = 0;
  analyserR.smoothingTimeConstant = 0;

  input.connect(splitter);
  splitter.connect(analyserL, 0);
  splitter.connect(analyserR, 1);

  const bufL = new Float32Array(256);
  const bufR = new Float32Array(256);

  function sample() {
    analyserL.getFloatTimeDomainData(bufL);
    analyserR.getFloatTimeDomainData(bufR);
    let pkL = 0;
    let pkR = 0;
    let sqL = 0;
    let sqR = 0;
    for (let i = 0; i < 256; i++) {
      const vL = bufL[i];
      const vR = bufR[i];
      const aL = vL < 0 ? -vL : vL;
      const aR = vR < 0 ? -vR : vR;
      if (aL > pkL) pkL = aL;
      if (aR > pkR) pkR = aR;
      sqL += vL * vL;
      sqR += vR * vR;
    }
    const rmsL = Math.sqrt(sqL / 256);
    const rmsR = Math.sqrt(sqR / 256);
    const toDb = (v) => Math.max(-60, Math.min(3, 20 * Math.log10(Math.max(v, 1e-5))));
    const peakDbL = toDb(pkL);
    const peakDbR = toDb(pkR);
    const rmsDbL = toDb(rmsL);
    const rmsDbR = toDb(rmsR);
    return {
      peakL: pkL,
      peakR: pkR,
      rmsL,
      rmsR,
      peakDbL,
      peakDbR,
      rmsDbL,
      rmsDbR,
      peakDb: Math.max(peakDbL, peakDbR),
      rmsDb: Math.max(rmsDbL, rmsDbR),
      clip: pkL >= 0.988 || pkR >= 0.988
    };
  }

  return { input, sample };
}

class AudioEngine {
  constructor() {
    this.initialized = false;
    this.channels = [];
    this.returnA = null;
    this.returnB = null;
    this.sendABus = null;
    this.sendBBus = null;
    this.returnAGain = null;
    this.returnBGain = null;
    this.masterBus = null;
    this.punchFx = null;
    this.masterGain = null;
    this.limiter = null;
    this.masterMeter = null;
    this.masterPreMeter = null;
    this.masterStereoMeter = null;
    this.returnAStereoMeter = null;
    this.returnBStereoMeter = null;
    this.smoothedGrDb = 0;
    this.waveformAnalyser = null;
    this.fftAnalyser = null;
    this.repeatId = null;
    this.countInTimer = null;
    this.droneState = { active: false, rootMidi: 48, rx: 0, ry: 0, hold: false, oscs: [], filter: null, gain: null };

    this.activeAudioSources = new Map();
    this.songResync = false;
    this.jam = null;
    // Recent (step, audio time) pairs: what is *audible* now, independent of lookahead
    this.stepLog = new Float64Array(16 * 3);
    this.stepLogHead = 0;
    this.stepLogCount = 0;
    this.jamTimers = [];
    this.samplerBuffers = new Map();
    this.lastActiveMidiByTrack = new Array(8).fill(null);
    this.mediaRecorder = null;
    this.recordedChunks = [];
    this.micStream = null;
    this.labPreview = null;
    this.lastFrameTime = performance.now();
    this.fps = 60;
  }

  init() {
    if (this.initialized) return;
    this.initialized = true;

    try {
      // Native AudioContext, not Tone's standardized-audio-context wrapper:
      //  - native constructors (AudioWorkletNode in TAPE-1 / DRIVE, GainNode) accept it
      //  - connect() skips the wrapper's whole-graph cycle detection on every per-hit node
      const native = new window.AudioContext({ latencyHint: getLatencyProfile().latencyHint });
      this.renderCapacity = attachRenderCapacity(native);
      // Sequencing runs on the main thread, which also draws 60-120 fps canvases. A 20 ms
      // lookahead let any longer UI/GC stall drop or delay notes; 60 ms (LIVE) / 120 ms (SAFE)
      // absorbs those. Live playing is unaffected: pads/keys use Tone.immediate().
      Tone.setContext(new Tone.Context({ context: native, lookAhead: getLatencyProfile().lookAhead, updateInterval: 0.02 }));
    } catch {
      try {
        const curCtx = Tone.getContext();
        curCtx.lookAhead = getLatencyProfile().lookAhead;
        curCtx.updateInterval = 0.015;
      } catch {
        // ignore if unsupported
      }
    }

    const state = store.getState();
    const transport = Tone.getTransport();
    transport.bpm.value = state.bpm;
    transport.swing = 0;
    transport.swingSubdivision = '16n';

    this.masterBus = new Tone.Gain(1);
    this.punchFx = createPunchFx(Tone);
    this.masterGain = new Tone.Gain(state.master.volume);
    this.limiter = new Tone.Limiter(state.master.limiterCeiling);
    this.masterMeter = new Tone.Meter({ smoothing: 0.72 });
    this.waveformAnalyser = new Tone.Waveform(128);
    this.fftAnalyser = new Tone.FFT(64);

    const rawCtx = Tone.getContext().rawContext;
    this.masterPreMeter = createStereoMeter(rawCtx);
    this.masterStereoMeter = createStereoMeter(rawCtx);
    this.returnAStereoMeter = createStereoMeter(rawCtx);
    this.returnBStereoMeter = createStereoMeter(rawCtx);

    this.masterBus.connect(this.punchFx.input);
    this.punchFx.output.connect(this.masterGain);
    this.masterGain.connect(this.limiter);
    Tone.connect(this.masterGain, this.masterPreMeter.input);
    this.limiter.connect(this.masterMeter);
    Tone.connect(this.limiter, this.masterStereoMeter.input);
    this.limiter.connect(this.waveformAnalyser);
    this.limiter.connect(this.fftAnalyser);
    this.limiter.toDestination();

    // Audio-thread time-stretch for playlist clips (replaces main-thread GrainPlayer grains)
    this.stretch = new StretchBanks(rawCtx);

    // Performable tape machine between punch FX and master gain (spliced in once its worklet loads)
    this.tapeDeck = createTapeDeck(Tone, { onPrint: (buf) => this.onTapePrint(buf) });
    this.tapeDeck.attach(this.punchFx.output, this.masterGain);
    this.tapePrintStart = null;

    // Return buses
    this.sendABus = new Tone.Gain(1);
    this.sendBBus = new Tone.Gain(1);
    this.returnAGain = new Tone.Gain(state.returns.sendA.volume);
    this.returnBGain = new Tone.Gain(state.returns.sendB.volume);

    const delayDef = getDevice('delay');
    const verbDef = getDevice('verb');
    this.returnA = delayDef.createNode(Tone);
    this.returnB = verbDef.createNode(Tone);

    for (const [k, v] of Object.entries(state.returns.sendA.params)) this.returnA.setParam(k, v);
    for (const [k, v] of Object.entries(state.returns.sendB.params)) this.returnB.setParam(k, v);

    this.sendABus.connect(this.returnA.input);
    this.returnA.output.connect(this.returnAGain);
    this.returnAGain.connect(this.masterBus);
    Tone.connect(this.returnAGain, this.returnAStereoMeter.input);

    this.sendBBus.connect(this.returnB.input);
    this.returnB.output.connect(this.returnBGain);
    this.returnBGain.connect(this.masterBus);
    Tone.connect(this.returnBGain, this.returnBStereoMeter.input);

    // 8 Channels
    for (let i = 0; i < 8; i++) {
      const tr = state.tracks[i];
      const fader = new Tone.Gain(tr.volume);
      const panner = new Tone.Panner(tr.pan);
      const sendAGain = new Tone.Gain(tr.sendA);
      const sendBGain = new Tone.Gain(tr.sendB);
      const meter = new Tone.Meter({ smoothing: 0.72 });
      const stereoMeter = createStereoMeter(rawCtx);

      fader.connect(panner);
      panner.connect(this.masterBus);
      panner.connect(meter);
      Tone.connect(panner, stereoMeter.input);
      fader.connect(sendAGain);
      fader.connect(sendBGain);
      sendAGain.connect(this.sendABus);
      sendBGain.connect(this.sendBBus);

      const ch = {
        id: i,
        fader,
        panner,
        sendAGain,
        sendBGain,
        meter,
        stereoMeter,
        insertNodes: []
      };
      this.channels.push(ch);
      this.rebuildTrackChain(i);
    }

    // Ensure 909/808 drum banks are ready offline
    try {
      ensureFactoryDrumKits(Tone.getContext().rawContext);
    } catch {
      // Deferred until unlock
    }

    // Scheduler
    this.repeatId = transport.scheduleRepeat((time) => {
      this.onStep(time);
    }, '16n');

    store.subscribe((st, topic, payload) => {
      if (topic === 'mixer') {
        this.syncTrackMixer(payload.trackId);
      } else if (topic === 'dsp-param') {
        this.syncDeviceParam(payload.trackId, payload.slotIdx, payload.paramId, payload.value);
      } else if (topic === 'dsp-bypass' || topic === 'dsp-chain') {
        this.rebuildTrackChain(payload.trackId);
      } else if (topic === 'return-param') {
        const retNode = payload.returnKey === 'sendA' ? this.returnA : this.returnB;
        retNode?.setParam(payload.paramId, payload.value);
      } else if (topic === 'history-restore') {
        this.syncFullStateFromStore();
      }
    });
  }

  syncFullStateFromStore() {
    const st = store.getState();
    const transport = Tone.getTransport();
    transport.bpm.value = st.bpm;
    transport.swing = 0;

    for (let i = 0; i < 8; i++) {
      const ch = this.channels[i];
      const tr = st.tracks[i];
      if (!ch || !tr) continue;

      const needsRebuild =
        ch.insertNodes.length !== tr.inserts.length ||
        ch.insertNodes.some(
          (n, idx) =>
            n.slotId !== tr.inserts[idx].slotId ||
            n.deviceId !== tr.inserts[idx].deviceId ||
            n.bypass !== tr.inserts[idx].bypass
        );

      if (needsRebuild) {
        this.rebuildTrackChain(i);
      } else {
        tr.inserts.forEach((slot, idx) => {
          const entry = ch.insertNodes[idx];
          if (!entry) return;
          for (const [k, v] of Object.entries(slot.params)) {
            entry.node.setParam(k, v);
          }
        });
      }
      this.syncTrackMixer(i);
    }

    for (const [k, v] of Object.entries(st.returns.sendA.params)) this.returnA?.setParam(k, v);
    for (const [k, v] of Object.entries(st.returns.sendB.params)) this.returnB?.setParam(k, v);
    this.setReturnVolume('sendA', st.returns.sendA.volume);
    this.setReturnVolume('sendB', st.returns.sendB.volume);
    this.setMasterVolume(st.master.volume);
    this.setLimiterCeiling(st.master.limiterCeiling);
    store.emit('drum-pads');
  }

  async unlock() {
    if (!this.initialized) this.init();
    const st = store.getState();
    if (!st.audioUnlocked) {
      try {
        await Tone.start();
        if (Tone.getContext().state !== 'running') {
          await Tone.getContext().resume();
        }
        st.audioUnlocked = true;
        ensureFactoryDrumKits(Tone.getContext().rawContext);
        store.emit('audio-unlock', true);
      } catch (err) {
        console.warn('[engine] unlock warning', err);
      }
    }
  }

  rebuildTrackChain(trackId) {
    const ch = this.channels[trackId];
    const track = store.getState().tracks[trackId];
    if (!ch || !track) return;

    // Dispose old nodes cleanly
    for (const entry of ch.insertNodes) {
      try {
        entry.node.output.disconnect();
        entry.node.dispose();
      } catch {
        // ignore
      }
    }
    ch.insertNodes = [];

    for (let i = 0; i < track.inserts.length; i++) {
      const slot = track.inserts[i];
      const def = getDevice(slot.deviceId);
      if (!def) continue;
      const node = def.createNode(Tone);
      for (const [k, v] of Object.entries(slot.params)) {
        node.setParam(k, v);
      }
      ch.insertNodes.push({ slotId: slot.slotId, deviceId: slot.deviceId, bypass: slot.bypass, node });
    }

    // Wire active nodes left-to-right into channel fader
    const activeNodes = ch.insertNodes.filter((n, idx) => idx === 0 || !n.bypass);
    for (let i = 0; i < activeNodes.length; i++) {
      const curr = activeNodes[i];
      const next = activeNodes[i + 1];
      if (next) {
        curr.node.output.connect(next.node.input);
      } else {
        curr.node.output.connect(ch.fader);
      }
    }
    this.syncAllMixerMutes();
  }

  syncDeviceParam(trackId, slotIdx, paramId, value) {
    const ch = this.channels[trackId];
    const entry = ch?.insertNodes[slotIdx];
    entry?.node.setParam(paramId, value);
    if (entry?.deviceId === 'drum8' && (paramId === 'mode' || paramId === 'kit')) {
      store.emit('drum-pads', { trackId });
    }
  }

  getDrumNode(trackId) {
    const entry = this.channels[trackId]?.insertNodes[0];
    if (entry?.deviceId === 'drum8') return entry.node;
    return null;
  }

  getBrickchordNode(trackId) {
    const entry = this.channels[trackId]?.insertNodes[0];
    if (entry?.deviceId === 'brickchord') return entry.node;
    return null;
  }

  getDrumSources(trackId) {
    const node = this.getDrumNode(trackId);
    if (node?.getActiveSources) return node.getActiveSources();
    return [];
  }

  async importDrumPoolFiles(files) {
    await this.unlock();
    const rawCtx = Tone.getContext().rawContext;
    ensureFactoryDrumKits(rawCtx);
    const added = [];
    for (const file of Array.from(files || [])) {
      try {
        const ab = await file.arrayBuffer();
        const buf = await rawCtx.decodeAudioData(ab);
        added.push(addUserSampleBuffer(file.name, buf, 'USER'));
      } catch (err) {
        console.warn('[engine] failed decoding drum pool file', file.name, err);
      }
    }
    if (added.length > 0) store.emit('drum-pads');
    return added;
  }

  async loadSampleToPad(trackId, padIdx, file) {
    await this.unlock();
    const rawCtx = Tone.getContext().rawContext;
    ensureFactoryDrumKits(rawCtx);
    const ab = await file.arrayBuffer();
    const buf = await rawCtx.decodeAudioData(ab);
    const entry = addUserSampleBuffer(file.name, buf, 'USER');
    const node = this.getDrumNode(trackId);
    if (node) {
      node.setPadSample(padIdx, entry);
      if (store.getState().tracks[trackId]?.inserts[0]?.params.mode === 0) {
        store.setDeviceParam(trackId, 0, 'mode', 1);
      }
      store.emit('drum-pads', { trackId });
    }
    return entry;
  }

  async loadSampleToSampler(trackId, fileOrBuffer, labelName = null) {
    await this.unlock();
    const rawCtx = Tone.getContext().rawContext;
    let audioBuf = fileOrBuffer;
    let name = labelName || 'SAMPLER';
    if (fileOrBuffer && typeof fileOrBuffer.arrayBuffer === 'function') {
      const ab = await fileOrBuffer.arrayBuffer();
      audioBuf = await rawCtx.decodeAudioData(ab);
      name = fileOrBuffer.name.replace(/\.[^.]+$/, '').toUpperCase().slice(0, 10);
    }
    const st = store.getState();
    if (st.tracks[trackId]?.inserts[0]?.deviceId !== 'grain1') {
      store.addInsertDevice(trackId, 'grain1');
    }
    st.tracks[trackId].name = name;
    this.samplerBuffers.set(trackId, { id: `smp_t${trackId}`, name, buffer: audioBuf });
    this.channels[trackId]?.insertNodes[0]?.node?.loadBuffer?.(audioBuf);
    store.emit('track', trackId);
    return audioBuf;
  }

  async loadSampleToMpcChop(trackId, fileOrBuffer, labelName = null) {
    await this.unlock();
    const rawCtx = Tone.getContext().rawContext;
    ensureFactoryDrumKits(rawCtx);
    let audioBuf = fileOrBuffer;
    let name = labelName || 'CHOP';
    if (fileOrBuffer && typeof fileOrBuffer.arrayBuffer === 'function') {
      const ab = await fileOrBuffer.arrayBuffer();
      audioBuf = await rawCtx.decodeAudioData(ab);
      name = fileOrBuffer.name;
    }
    const entry = addUserSampleBuffer(name, audioBuf, 'USER');
    const st = store.getState();
    if (st.tracks[trackId]?.inserts[0]?.deviceId !== 'drum8') {
      store.addInsertDevice(trackId, 'drum8');
    }
    store.setDeviceParam(trackId, 0, 'mode', 1);
    const node = this.getDrumNode(trackId);
    if (node) {
      node.setPadSample(0, entry);
      node.chopPadAcrossPads(0, 8, 'TRANSIENTS');
      store.emit('drum-pads', { trackId });
    }
    return entry;
  }

  async startLabPreview(labItem) {
    await this.unlock();
    this.stopLabPreview();
    if (!labItem) return;

    const st = store.getState();
    if (st.isPlaying) {
      await this.togglePlay();
    }

    if (labItem.kind === 'pattern') {
      const def = getDevice(labItem.instrumentId || 'mono303');
      if (!def) return;
      const node = def.createNode(Tone);
      for (const [k, v] of Object.entries(labItem.instrumentParams || {})) {
        node.setParam(k, v);
      }
      node.output.connect(this.masterBus);

      let step = 0;
      let lastMidi = null;
      const len = Math.max(4, labItem.lengthSteps || 16);
      const stepMs = ((60 / st.bpm) / 4) * 1000;
      const stepSec = stepMs / 1000;

      const runStep = () => {
        const now = Tone.now() + 0.025;
        const notes = (labItem.notes || []).filter((n) => Math.round(n.step) === step);
        for (const note of notes) {
          const durSec = Math.max(0.04, (note.len || 1) * stepSec * 0.9);
          const vel = Math.max(0.05, Math.min(1, (note.vel || 100) / 127));
          if (note.slide && node.triggerSlide) {
            node.triggerSlide(lastMidi, note.midi, durSec, now, vel, { cutoffOffset: note.cutoff || 0 });
          } else {
            node.triggerNote?.(note.midi, durSec, now, vel, { cutoffOffset: note.cutoff || 0 });
          }
          lastMidi = note.midi;
        }
        step = (step + 1) % len;
      };

      runStep();
      const timer = setInterval(runStep, stepMs);
      this.labPreview = { id: labItem.id, timer, node, player: null };
      store.emit('lab-preview', labItem.id);
      return;
    }

    if (labItem.kind === 'audio' && labItem.audioRef) {
      const ac = st.audioClips[labItem.audioRef];
      if (!ac?.buffer) return;
      const player = new Tone.Player({ url: ac.buffer, loop: true }).connect(this.masterBus);
      player.start(Tone.now() + 0.02);
      this.labPreview = { id: labItem.id, timer: null, node: null, player };
      store.emit('lab-preview', labItem.id);
    }
  }

  stopLabPreview() {
    if (!this.labPreview) return;
    if (this.labPreview.timer) clearInterval(this.labPreview.timer);
    try {
      this.labPreview.node?.releaseAll?.(Tone.now());
      this.labPreview.node?.dispose?.();
    } catch {
      // ignore
    }
    try {
      this.labPreview.player?.stop();
      this.labPreview.player?.dispose();
    } catch {
      // ignore
    }
    this.labPreview = null;
    store.emit('lab-preview', null);
  }

  getLabPreviewId() {
    return this.labPreview?.id || null;
  }

  collectAllAudioBuffers() {
    const st = store.getState();
    const out = [];
    for (const [id, ac] of Object.entries(st.audioClips)) {
      if (ac.buffer) out.push({ id, kind: 'audio-clip', name: ac.name, buffer: ac.buffer });
    }
    for (const [trackId, sb] of this.samplerBuffers.entries()) {
      if (sb.buffer) out.push({ id: sb.id, kind: 'sampler', name: sb.name, trackId, buffer: sb.buffer });
    }
    for (const smp of getSamplePool()) {
      if (smp.bank === 'USER' && smp.buffer) {
        out.push({ id: smp.id, kind: 'drum-pool', name: smp.name, buffer: smp.buffer });
      }
    }
    return out;
  }

  applyRestoredSamples(decodedSamples) {
    for (const item of decodedSamples) {
      if (item.kind === 'sampler' && item.trackId != null) {
        this.samplerBuffers.set(item.trackId, { id: item.id, name: item.name, buffer: item.buffer });
        this.channels[item.trackId]?.insertNodes[0]?.node?.loadBuffer?.(item.buffer);
      }
    }
  }

  syncTrackMixer(trackId) {
    const st = store.getState();
    const tr = st.tracks[trackId];
    const ch = this.channels[trackId];
    if (!tr || !ch) return;
    const now = Tone.now();
    ch.panner.pan.setTargetAtTime(tr.pan, now, 0.015);
    ch.sendAGain.gain.setTargetAtTime(tr.sendA, now, 0.015);
    ch.sendBGain.gain.setTargetAtTime(tr.sendB, now, 0.015);
    this.syncAllMixerMutes();
  }

  syncAllMixerMutes() {
    const st = store.getState();
    const anySolo = st.tracks.some((t) => t.solo);
    const now = Tone.now();
    for (let i = 0; i < 8; i++) {
      const tr = st.tracks[i];
      const ch = this.channels[i];
      if (!ch) continue;
      const audible = anySolo ? tr.solo : !tr.mute;
      ch.fader.gain.setTargetAtTime(audible ? tr.volume : 0, now, 0.012);
    }
  }

  setReturnVolume(returnKey, volume) {
    const st = store.getState();
    st.returns[returnKey].volume = volume;
    const gain = returnKey === 'sendA' ? this.returnAGain : this.returnBGain;
    gain?.gain.setTargetAtTime(st.returns[returnKey].mute ? 0 : volume, Tone.now(), 0.015);
  }

  toggleReturnMute(returnKey) {
    const st = store.getState();
    st.returns[returnKey].mute = !st.returns[returnKey].mute;
    this.setReturnVolume(returnKey, st.returns[returnKey].volume);
  }

  setMasterVolume(vol) {
    const st = store.getState();
    st.master.volume = Math.max(0, Math.min(1.42, vol));
    this.masterGain?.gain.setTargetAtTime(st.master.volume, Tone.now(), 0.015);
  }

  setLimiterCeiling(db) {
    const st = store.getState();
    st.master.limiterCeiling = Math.max(-12, Math.min(0, db));
    if (this.limiter) {
      this.limiter.threshold.setTargetAtTime(st.master.limiterCeiling, Tone.now(), 0.015);
    }
  }

  setBpm(bpm) {
    const clamped = Math.max(40, Math.min(240, Math.round(bpm)));
    store.getState().bpm = clamped;
    Tone.getTransport().bpm.value = clamped;
    store.emit('transport', { bpm: clamped });
  }

  setSwing(swing) {
    const clamped = Math.max(0, Math.min(80, Math.round(swing)));
    const st = store.getState();
    store.setPatternSwing(st.activePatternId, clamped);
  }

  playMetronomeClick(time, isDownbeat = false) {
    if (!this.masterGain) return;
    try {
      const rawCtx = Tone.getContext().rawContext;
      const t = typeof time === 'number' ? Math.max(rawCtx.currentTime, time) : rawCtx.currentTime;
      const osc = rawCtx.createOscillator();
      const gain = rawCtx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(isDownbeat ? 1560 : 1040, t);
      osc.frequency.exponentialRampToValueAtTime(isDownbeat ? 820 : 560, t + 0.028);

      const amp = isDownbeat ? 0.22 : 0.13;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.linearRampToValueAtTime(amp, t + 0.002);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.045);

      osc.connect(gain);
      Tone.connect(gain, this.masterGain);
      osc.start(t);
      osc.stop(t + 0.055);
      osc.onended = () => {
        try {
          osc.disconnect();
          gain.disconnect();
        } catch {
          // ignore
        }
      };
    } catch {
      // ignore if locked
    }
  }

  cancelCountIn() {
    if (this.countInTimer != null) {
      clearInterval(this.countInTimer);
      this.countInTimer = null;
    }
    const st = store.getState();
    if (st.countInBeat !== 0) {
      st.countInBeat = 0;
      store.emit('transport', { countInBeat: 0 });
    }
  }

  async togglePlay() {
    await this.unlock();
    this.stopLabPreview();
    const st = store.getState();
    const transport = Tone.getTransport();
    if (this.countInTimer != null) {
      this.cancelCountIn();
      return;
    }
    if (this.jam) {
      this.stopJam(true);
      return;
    }
    if (st.isPlaying) {
      transport.stop();
      this.stopAllAudioClips();
      for (const ch of this.channels) {
        ch.insertNodes[0]?.node.releaseAll?.(Tone.immediate());
      }
      st.isPlaying = false;
      store.emit('transport', { isPlaying: false });
      return;
    }

    if (st.isRecording && st.countIn) {
      let beat = 1;
      const beatMs = (60 / Math.max(40, st.bpm)) * 1000;
      const tickCount = () => {
        if (!store.getState().countIn || !store.getState().isRecording) {
          this.cancelCountIn();
          return;
        }
        st.countInBeat = beat;
        this.playMetronomeClick(Tone.immediate(), beat === 1);
        store.emit('transport', { countInBeat: beat });
        if (beat >= 4) {
          clearInterval(this.countInTimer);
          this.countInTimer = null;
          setTimeout(() => {
            if (store.getState().countInBeat !== 4) return;
            st.countInBeat = 0;
            st.currentStep = this.getPlayStartStep();
            this.songResync = true;
            transport.start('+0.005');
            st.isPlaying = true;
            store.emit('transport', { isPlaying: true, countInBeat: 0 });
          }, beatMs);
        } else {
          beat++;
        }
      };
      tickCount();
      if (this.countInTimer == null && beat <= 4) {
        this.countInTimer = setInterval(tickCount, beatMs);
      }
      return;
    }

    st.currentStep = this.getPlayStartStep();
    this.songResync = true;
    transport.start('+0.005');
    st.isPlaying = true;
    store.emit('transport', { isPlaying: true });
  }

  /** SONG mode starts at the loop start when looping, otherwise bar 1. */
  getPlayStartStep() {
    const st = store.getState();
    return st.playMode === 'SONG' ? getSongRange(st).start : 0;
  }

  async toggleRecord() {
    await this.unlock();
    const st = store.getState();
    st.isRecording = !st.isRecording;
    store.emit('transport', { isRecording: st.isRecording });
  }

  scrubStep(delta) {
    const st = store.getState();
    const maxLen = st.playMode === 'PAT' ? st.patterns[st.activePatternId]?.length || 16 : getSongEnd(st);
    st.currentStep = ((st.currentStep + delta) % maxLen + maxLen) % maxLen;
    store.emit('step', st.currentStep);
  }

  previewNote(trackId, midi, vel = 0.85, slide = false) {
    const fire = () => {
      const ch = this.channels[trackId];
      const inst = ch?.insertNodes[0]?.node;
      if (!inst) return;
      const t = Tone.immediate();
      if (slide && inst.triggerSlide) {
        inst.triggerSlide(this.lastActiveMidiByTrack[trackId], midi, 0.18, t, vel, {});
      } else {
        inst.triggerNote?.(midi, 0.18, t, vel, {});
      }
      this.lastActiveMidiByTrack[trackId] = midi;

      // Live overdub recording when Transport is playing + Armed
      const st = store.getState();
      if (st.isPlaying && st.isRecording) {
        const pat = st.patterns[st.activePatternId];
        if (pat) {
          const patLen = pat.length || 16;
          const snap =
            st.recQuant === 0
              ? 0.25
              : st.recQuant > 0
                ? st.recQuant
                : st.gridSnapAuto
                  ? 1
                  : Math.max(0.25, st.gridSnap || 1);
          const rawStep = ((this.getAudibleStep() % patLen) + patLen) % patLen;
          const qStep = (Math.round(rawStep / snap) * snap) % patLen;
          const curNotes = store.getActiveNotes(trackId, st.activePatternId);
          const dup = curNotes.some((n) => Math.abs(n.step - qStep) < 0.05 && n.midi === midi);
          if (!dup) {
            const nextNotes = [
              ...curNotes,
              {
                id: nextId('n'),
                step: qStep,
                len: snap,
                midi,
                vel: Math.max(25, Math.min(127, Math.round(vel * 127))),
                prob: 100,
                slide: Boolean(slide),
                cutoff: 0
              }
            ];
            store.setActiveNotes(nextNotes, trackId, st.activePatternId, 'REC NOTE');
          }
        }
      }
    };
    if (store.getState().audioUnlocked) {
      fire();
    } else {
      this.unlock().then(fire);
    }
  }

  recordChordToPattern(trackId, midiNotes, durSteps = 4, vel = 0.85, advanceStep = false) {
    if (!midiNotes || midiNotes.length === 0) return false;
    const st = store.getState();
    const pat = st.patterns[st.activePatternId];
    if (!pat) return false;

    const patLen = pat.length || 16;
    const snap =
      st.recQuant === 0
        ? 0.25
        : st.recQuant > 0
          ? st.recQuant
          : st.gridSnapAuto
            ? 1
            : Math.max(0.25, st.gridSnap || 1);
    const rawStep = st.isPlaying
      ? ((this.getAudibleStep() % patLen) + patLen) % patLen
      : Math.floor(st.currentStep || 0) % patLen;
    const qStep = st.isPlaying
      ? (Math.round(rawStep / snap) * snap) % patLen
      : Math.max(0, rawStep);

    if (!st.isPlaying) {
      store.pushHistory('BRICKCHORD STAMP');
    }

    const curNotes = store.getActiveNotes(trackId, st.activePatternId);
    const uniqueMidi = [...new Set(midiNotes.map((m) => Math.round(m)))];
    const filtered = curNotes.filter(
      (n) => !(Math.abs(n.step - qStep) < 0.05 && uniqueMidi.includes(Math.round(n.midi)))
    );
    const noteLen = Math.max(1, Math.min(durSteps, patLen - qStep));
    const normVel = Math.max(25, Math.min(127, Math.round(vel * 127)));
    const added = uniqueMidi.map((midi) => ({
      id: nextId('n'),
      step: qStep,
      len: noteLen,
      midi,
      vel: normVel,
      prob: 100,
      slide: false,
      cutoff: 0
    }));

    store.setActiveNotes([...filtered, ...added], trackId, st.activePatternId, st.isPlaying ? 'REC CHORD' : null);
    if (!st.isPlaying && advanceStep) {
      st.currentStep = (qStep + durSteps) % patLen;
      store.emit('step', st.currentStep);
    }
    return true;
  }

  /* ------------------------------------------------------------------ *
   * JAM: loop a playlist range, count in one bar, capture pad chords as
   * takes (one per loop pass). On stop the last complete take becomes a
   * pattern clip on the jam track's lane; other takes go to the LAB.
   * ------------------------------------------------------------------ */

  isJamming() {
    return Boolean(this.jam);
  }

  async startJam(trackId) {
    await this.unlock();
    if (this.jam) {
      this.stopJam(true);
      return;
    }
    const st = store.getState();
    const transport = Tone.getTransport();
    if (st.isPlaying) {
      transport.stop();
      this.stopAllAudioClips();
      st.isPlaying = false;
    }
    this.cancelCountIn();

    const range = st.loop?.on && st.loop.end > st.loop.start ? { start: st.loop.start, end: st.loop.end } : { start: 0, end: 128 };
    store.setLoop({ on: true, start: range.start, end: range.end });
    st.playMode = 'SONG';
    st.currentStep = range.start;

    const len = range.end - range.start;
    this.jam = {
      trackId,
      start: range.start,
      len,
      phase: 'count',
      absNext: 0,
      stepLog: [],
      open: null,
      takes: new Map(),
      lastPos: 0
    };

    const rawCtx = Tone.getContext().rawContext;
    const beatSec = 60 / Math.max(40, st.bpm);
    const t0 = rawCtx.currentTime + 0.08;
    for (let i = 0; i < 4; i++) this.playMetronomeClick(t0 + i * beatSec, i === 0);
    const downbeat = t0 + 4 * beatSec;
    this.jam.downbeat = downbeat;
    this.jam.beatSec = beatSec;
    this.songResync = true;
    transport.start(downbeat);

    const setStatus = (patch) => {
      st.jam = { ...(st.jam || {}), ...patch };
      store.emit('jam', st.jam);
    };
    setStatus({ phase: 'count', count: 4, take: 1, bar: 0, bars: len / 16, takes: 0 });
    st.countInBeat = 4;
    store.emit('transport', { playMode: 'SONG', countInBeat: 4 });

    const msUntil = (t) => Math.max(0, (t - rawCtx.currentTime) * 1000);
    for (let i = 1; i < 4; i++) {
      this.jamTimers.push(
        setTimeout(() => {
          if (!this.jam) return;
          st.countInBeat = 4 - i;
          setStatus({ count: 4 - i });
          store.emit('transport', { countInBeat: 4 - i });
        }, msUntil(t0 + i * beatSec))
      );
    }
    this.jamTimers.push(
      setTimeout(() => {
        if (!this.jam) return;
        this.jam.phase = 'rec';
        st.countInBeat = 0;
        st.isPlaying = true;
        setStatus({ phase: 'rec', count: 0 });
        store.emit('transport', { isPlaying: true, countInBeat: 0 });
      }, msUntil(downbeat))
    );
  }

  logJamStep(songStep, time, stepDur) {
    const jam = this.jam;
    if (!jam) return;
    const abs = jam.absNext++;
    jam.stepDur = stepDur;
    jam.stepLog.push({ abs, time });
    if (jam.stepLog.length > 8) jam.stepLog.shift();

    // Held chord crossing the loop boundary: close it on this pass, re-open on the next
    if (abs > 0 && abs % jam.len === 0 && jam.open) {
      const held = jam.open;
      this.closeJamChord(abs);
      jam.open = { ...held, qStart: abs, rawStart: abs };
    }
    const st = store.getState();
    const pass = Math.floor(abs / jam.len);
    const bar = Math.floor((abs % jam.len) / 16);
    if (!st.jam || st.jam.take !== pass + 1 || st.jam.bar !== bar) {
      Tone.getDraw().schedule(() => {
        if (!this.jam) return;
        st.jam = { ...(st.jam || {}), take: pass + 1, bar, takes: this.countCompleteTakes(abs) };
        store.emit('jam', st.jam);
      }, time);
    }
  }

  /** Musical position (in steps since the jam downbeat) of what the player is hearing now. */
  jamPosNow() {
    const jam = this.jam;
    if (!jam || jam.stepLog.length === 0) return 0;
    const rawCtx = Tone.getContext().rawContext;
    const heard = rawCtx.currentTime - (rawCtx.outputLatency || rawCtx.baseLatency || 0);
    let ref = jam.stepLog[0];
    for (const e of jam.stepLog) if (e.time <= heard) ref = e;
    const pos = ref.abs + (heard - ref.time) / (jam.stepDur || 0.125);
    return Math.max(0, pos);
  }

  jamQuant() {
    const rq = store.getState().recQuant;
    return rq > 0 ? rq : rq === 0 ? 0.25 : 1;
  }

  jamChordOn(midiNotes, vel = 0.86) {
    const jam = this.jam;
    if (!jam || !midiNotes?.length) return;
    // Count-in presses only count as pickups within the final beat before the downbeat
    if (jam.stepLog.length === 0 && Tone.getContext().rawContext.currentTime < jam.downbeat - jam.beatSec) return;
    const pos = this.jamPosNow();
    if (jam.open) this.closeJamChord(pos);
    const q = this.jamQuant();
    jam.open = { notes: [...new Set(midiNotes.map((m) => Math.round(m)))], vel, qStart: Math.round(pos / q) * q, rawStart: pos };
  }

  jamChordOff() {
    if (!this.jam?.open) return;
    this.closeJamChord(this.jamPosNow());
  }

  closeJamChord(endPos) {
    const jam = this.jam;
    const open = jam?.open;
    if (!open) return;
    jam.open = null;
    const q = this.jamQuant();
    const pass = Math.floor(open.qStart / jam.len);
    const local = open.qStart - pass * jam.len;
    const qEnd = Math.round(endPos / q) * q;
    const len = Math.max(q, Math.min(jam.len - local, qEnd - open.qStart));
    if (!jam.takes.has(pass)) jam.takes.set(pass, []);
    const vel = Math.max(25, Math.min(127, Math.round(open.vel * 127)));
    for (const midi of open.notes) {
      jam.takes.get(pass).push({ id: nextId('n'), step: local, len, midi, vel, prob: 100, slide: false, cutoff: 0 });
    }
  }

  countCompleteTakes(absNow) {
    if (!this.jam) return 0;
    const done = Math.floor(absNow / this.jam.len);
    let n = 0;
    for (const [pass, notes] of this.jam.takes) if (pass < done && notes.length) n++;
    return n;
  }

  stopJam(commit = true) {
    const jam = this.jam;
    if (!jam) return;
    const st = store.getState();
    const endPos = this.jamPosNow();
    if (jam.open) this.closeJamChord(endPos);
    this.jamTimers.forEach(clearTimeout);
    this.jamTimers = [];
    this.jam = null;

    Tone.getTransport().stop();
    this.stopAllAudioClips();
    for (const ch of this.channels) ch.insertNodes[0]?.node.releaseAll?.(Tone.immediate());
    st.isPlaying = false;
    st.countInBeat = 0;
    st.jam = null;
    store.emit('transport', { isPlaying: false, countInBeat: 0 });
    store.emit('jam', null);

    if (!commit) return null;
    const passesDone = Math.floor(endPos / jam.len);
    const withNotes = [...jam.takes.entries()].filter(([, n]) => n.length).sort((a, b) => a[0] - b[0]);
    if (withNotes.length === 0) return null;
    const complete = withNotes.filter(([p]) => p < passesDone);
    const keeper = (complete.length ? complete : withNotes)[(complete.length ? complete : withNotes).length - 1];
    const others = withNotes.filter((t) => t !== keeper && (complete.length === 0 || t[0] < passesDone));
    return this.commitJamTakes(jam, keeper, others);
  }

  commitJamTakes(jam, keeper, others) {
    const st = store.getState();
    const tr = st.tracks[jam.trackId];
    const slot = tr?.inserts[0];
    const def = slot ? getDevice(slot.deviceId) : null;
    store.pushHistory('JAM TAKE');

    const used = new Set(st.arrClips.filter((c) => c.kind === 'pattern').map((c) => c.refId));
    const patId = Object.keys(st.patterns).find((id) => {
      const pat = st.patterns[id];
      return !used.has(id) && id !== st.activePatternId && Object.values(pat.notesByTrack).every((a) => !a?.length);
    });
    if (!patId) return null;
    const jamNo = st.arrClips.filter((c) => /^JAM/.test(st.patterns[c.refId]?.name || '')).length + 1;
    const pat = st.patterns[patId];
    pat.length = jam.len;
    pat.swing = 0;
    pat.name = `JAM${jamNo}`;
    pat.notesByTrack = { [jam.trackId]: keeper[1].map((n) => ({ ...n })) };

    // Earlier takes and clips this take replaces are kept in the LAB, never lost
    const lane = Math.max(0, Math.min(7, jam.trackId));
    const end = jam.start + jam.len;
    const replaced = st.arrClips.filter(
      (c) => c.lane === lane && c.kind === 'pattern' && c.startStep < end && c.startStep + c.lengthSteps > jam.start
    );
    const labBase = st.lab.length;
    const takeEntries = others.map(([pass, notes], i) => ({
      id: `LAB${String(labBase + i + 1).padStart(2, '0')}`,
      name: `JAM${jamNo} TAKE ${pass + 1} · ${tr?.name || 'INST'}`,
      createdAt: Date.now(),
      kind: 'pattern',
      refId: `JAM${jamNo}`,
      lengthSteps: jam.len,
      bpm: st.bpm,
      instrumentId: slot?.deviceId || 'brickchord',
      instrumentName: def?.meta.name || tr?.name || 'BRICKCHORD',
      instrumentParams: slot ? { ...slot.params } : {},
      notes: notes.map((n) => ({ ...n })),
      audioRef: null,
      autoClip: null
    }));
    st.lab.unshift(...takeEntries.reverse());
    for (const c of replaced) {
      const p = st.patterns[c.refId];
      const notes = (p?.notesByTrack[jam.trackId] || []).map((n) => ({ ...n }));
      if (notes.length) {
        st.lab.unshift({
          id: `LAB${String(st.lab.length + 1).padStart(2, '0')}`,
          name: `${p.name || c.refId} · REPLACED`,
          createdAt: Date.now(),
          kind: 'pattern',
          refId: c.refId,
          lengthSteps: p.length,
          bpm: st.bpm,
          instrumentId: slot?.deviceId || 'brickchord',
          instrumentName: def?.meta.name || 'INST',
          instrumentParams: slot ? { ...slot.params } : {},
          notes,
          audioRef: null,
          autoClip: null
        });
      }
    }
    st.arrClips = st.arrClips.filter((c) => !replaced.includes(c));
    const clip = { id: nextId('clip'), kind: 'pattern', refId: patId, lane, startStep: jam.start, lengthSteps: jam.len, trackOverride: null };
    st.arrClips.push(clip);
    st.selectedArrClipId = clip.id;
    st.currentStep = jam.start;
    store.emit('lab', { action: 'jam' });
    store.emit('pattern', { patId });
    store.emit('arr', { action: 'jam', clipId: clip.id });
    return { clip, patId, takes: others.length + 1 };
  }

  recordTiming(time) {
    const now = Tone.getContext().rawContext.currentTime;
    recordSlack(time - now, now);
  }

  /** Real-time health for the telemetry overlay. */
  getHealth() {
    const raw = Tone.getContext().rawContext;
    return {
      mode: getLatencyMode(),
      lookAheadMs: Math.round(Tone.getContext().lookAhead * 1000),
      sampleRate: raw.sampleRate,
      baseLatencyMs: raw.baseLatency != null ? +(raw.baseLatency * 1000).toFixed(1) : null,
      outputLatencyMs: raw.outputLatency != null ? +(raw.outputLatency * 1000).toFixed(1) : null,
      steps: timing.last,
      totalLate: timing.totalLate,
      totalSteps: timing.totalSteps,
      renderLoad: this.renderCapacity?.load ?? null,
      renderPeak: this.renderCapacity?.peak ?? null,
      underrunRatio: this.renderCapacity?.underruns ?? null,
      glitchEvents: playoutGlitches(raw),
      liveVoices: this.activeAudioSources.size
    };
  }

  logStep(step, time, stepDur) {
    const i = (this.stepLogHead % 16) * 3;
    this.stepLog[i] = step;
    this.stepLog[i + 1] = time;
    this.stepLog[i + 2] = stepDur;
    this.stepLogHead++;
    this.stepLogCount = Math.min(16, this.stepLogCount + 1);
    this.recordTiming(time);
  }

  /**
   * Fractional step the listener is hearing right now (output latency compensated).
   * st.currentStep runs ahead by the lookahead, so recording must use this instead.
   */
  getAudibleStep() {
    if (!this.stepLogCount) return store.getState().currentStep;
    const raw = Tone.getContext().rawContext;
    const heard = raw.currentTime - (raw.outputLatency || raw.baseLatency || 0);
    let best = -1;
    for (let k = 0; k < this.stepLogCount; k++) {
      const i = (((this.stepLogHead - 1 - k) % 16) + 16) % 16 * 3;
      if (this.stepLog[i + 1] <= heard) {
        best = i;
        break;
      }
    }
    if (best < 0) {
      // Everything logged is still in the future: we're just before the oldest entry
      const i = (((this.stepLogHead - this.stepLogCount) % 16) + 16) % 16 * 3;
      return Math.max(0, this.stepLog[i] - (this.stepLog[i + 1] - heard) / this.stepLog[i + 2]);
    }
    return this.stepLog[best] + (heard - this.stepLog[best + 1]) / this.stepLog[best + 2];
  }

  onStep(time) {
    const st = store.getState();
    const step = st.currentStep;
    const stepDur = (60 / st.bpm) / 4;
    this.logStep(step, time, stepDur);
    if ((step & 15) === 0) this.pruneAudioSources();

    const recLike = st.isRecording || Boolean(this.jam);
    if (step % 4 === 0 && (st.metronome === 'on' || (st.metronome === 'rec' && recLike))) {
      this.playMetronomeClick(time, step % 16 === 0);
    }

    if (st.playMode === 'PAT') {
      const pat = st.patterns[st.activePatternId];
      const patLen = pat ? pat.length : 16;
      const localStep = step % patLen;
      const patSwing = pat?.swing || 0;
      const swungTime = localStep % 2 === 1 ? time + (patSwing / 100) * (stepDur * 0.5) : time;

      if (pat) {
        for (const [tidStr, notes] of Object.entries(pat.notesByTrack)) {
          const tid = Number(tidStr);
          this.triggerNotesAtStep(tid, notes, localStep, stepDur, swungTime);
        }
      }
      st.currentStep = (step + 1) % patLen;
    } else {
      const range = getSongRange(st);
      const songStep = step < range.start || step >= range.end ? range.start : step;
      const resync = this.songResync;
      this.songResync = false;
      const jamTrack = this.jam ? this.jam.trackId : -1;
      if (this.jam) this.logJamStep(songStep, time, stepDur);

      for (const clip of st.arrClips) {
        if (songStep < clip.startStep || songStep >= clip.startStep + clip.lengthSteps) continue;

        if (clip.kind === 'pattern') {
          const pat = st.patterns[clip.refId];
          if (!pat) continue;
          const localStep = (songStep - clip.startStep) % pat.length;
          const clipSwing = clip.swing ?? pat.swing ?? 0;
          const swungTime = localStep % 2 === 1 ? time + (clipSwing / 100) * (stepDur * 0.5) : time;
          for (const [tidStr, notes] of Object.entries(pat.notesByTrack)) {
            const tid = clip.trackOverride != null ? clip.trackOverride : Number(tidStr);
            // While jamming, the jam track's sequenced parts are muted so the new take replaces them
            if (tid === jamTrack) continue;
            this.triggerNotesAtStep(tid, notes, localStep, stepDur, swungTime);
          }
        } else if (clip.kind === 'audio') {
          const audioClip = st.audioClips[clip.refId];
          if (audioClip && (songStep === clip.startStep || resync)) {
            this.triggerWarpedAudioClip(clip, audioClip, time, stepDur, songStep - clip.startStep);
          }
        } else if (clip.kind === 'auto') {
          const autoClip = st.autoClips[clip.refId];
          if (autoClip) {
            const normX = (songStep - clip.startStep) / Math.max(1, clip.lengthSteps - 1);
            const normY = evalAutoClip(autoClip, normX);
            this.applyAutomationValue(autoClip, normY);
          }
        }
      }

      let next = songStep + 1;
      if (next >= range.end) {
        next = range.start;
        // Loop/song wrap: cut audio exactly at the boundary, then re-sync clips spanning the start
        this.stopAllAudioClips(time + stepDur);
        this.songResync = true;
      }
      st.currentStep = next;
    }

    Tone.getDraw().schedule(() => {
      store.emit('step', st.currentStep);
    }, time);
  }

  triggerNotesAtStep(trackId, notes, localStep, stepDur, time) {
    const ch = this.channels[trackId];
    if (!ch || !ch.insertNodes[0] || ch.insertNodes[0].bypass) return;
    const inst = ch.insertNodes[0].node;
    if (!notes || notes.length === 0) return;

    for (const note of notes) {
      if (note.step < localStep - 0.001 || note.step >= localStep + 0.999) continue;
      const prob = note.prob ?? 100;
      if (prob < 100 && Math.random() * 100 > prob) continue;

      const frac = Math.max(0, note.step - localStep);
      const noteTime = time + frac * stepDur;
      const durSec = Math.max(0.04, (note.len || 1) * stepDur * 0.92);
      const vel = Math.max(0.05, Math.min(1, (note.vel || 100) / 127));
      const opts = { cutoffOffset: note.cutoff || 0 };

      if (note.slide && typeof inst.triggerSlide === 'function') {
        inst.triggerSlide(this.lastActiveMidiByTrack[trackId], note.midi, durSec, noteTime, vel, opts);
      } else if (typeof inst.triggerNote === 'function') {
        inst.triggerNote(note.midi, durSec, noteTime, vel, opts);
      }
      this.lastActiveMidiByTrack[trackId] = note.midi;
    }
  }

  /**
   * Plays one playlist placement of an audio clip.
   * Placement edits live on the arr clip: offsetSteps (trim start), gainDb, fadeInSteps,
   * fadeOutSteps, reverse. intoSteps > 0 starts mid-clip (loop/playhead re-sync).
   */
  triggerWarpedAudioClip(arrClip, audioClip, time, stepDur, intoSteps = 0, key = arrClip.id) {
    if (!audioClip.buffer) return;
    const laneTrack = Math.max(0, Math.min(7, arrClip.lane));
    const targetFader = this.channels[laneTrack]?.fader || this.masterBus;
    const rate = store.getState().bpm / Math.max(40, audioClip.detectedBpm || 128);
    const into = Math.max(0, intoSteps);
    const remainSteps = arrClip.lengthSteps - into;
    if (remainSteps <= 0) return;

    const offsetSec = ((arrClip.offsetSteps || 0) + into) * stepDur * rate;
    if (offsetSec >= audioClip.duration - 0.005) return;
    const playSec = Math.min(remainSteps * stepDur, (audioClip.duration - offsetSec) / rate);

    this.stopAudioSource(key);

    const gainLin = Math.pow(10, (arrClip.gainDb || 0) / 20);
    const fadeIn = (arrClip.fadeInSteps || 0) * stepDur;
    const fadeOut = Math.min(playSec, (arrClip.fadeOutSteps || 0) * stepDur);
    const intoSec = into * stepDur;
    const endT = time + playSec;

    const raw = Tone.getContext().rawContext;
    const source = arrClip.reverse ? getReversedBuffer(raw, audioClip.buffer) : audioClip.buffer;

    // Stretch modes: one message to the audio-thread stretcher (no main-thread grain scheduling)
    if (audioClip.warpMode !== 'RE-PITCH' && this.stretch?.ok) {
      const dest = targetFader.input || targetFader;
      const node = this.stretch.get(`${audioClip.id}|${arrClip.reverse ? 'r' : 'f'}|${laneTrack}`, source, dest);
      this.stretch.play(node, {
        id: key,
        when: time,
        offsetSec,
        durSec: playSec,
        rate,
        semitones: audioClip.pitch || 0,
        mode: audioClip.warpMode,
        grainSize: audioClip.grainSize,
        spray: audioClip.spray,
        gainLin,
        fadeInSec: fadeIn,
        fadeOutSec: fadeOut,
        intoSec: intoSec
      });
      this.activeAudioSources.set(key, { stretchNode: node, id: key, endT });
      return;
    }

    // RE-PITCH: native buffer source (tape-style speed change), no Tone wrapper
    const amp = new Tone.Gain(0).connect(targetFader);
    const g = amp.gain;
    if (fadeIn > 0 && intoSec < fadeIn) {
      g.setValueAtTime(gainLin * (intoSec / fadeIn), time);
      g.linearRampToValueAtTime(gainLin, time + (fadeIn - intoSec));
    } else {
      g.setValueAtTime(gainLin, time);
    }
    if (fadeOut > 0) {
      g.setValueAtTime(gainLin, Math.max(time, endT - fadeOut));
      g.linearRampToValueAtTime(0, endT);
    } else {
      // 4ms de-click
      g.setValueAtTime(gainLin, Math.max(time, endT - 0.004));
      g.linearRampToValueAtTime(0, endT);
    }

    const player = raw.createBufferSource();
    player.buffer = source;
    player.playbackRate.value = rate;
    Tone.connect(player, amp);
    try {
      player.start(time, offsetSec);
      player.stop(endT + 0.01);
      const entry = { player, amp };
      this.activeAudioSources.set(key, entry);
      player.onended = () => {
        if (this.activeAudioSources.get(key) === entry) this.activeAudioSources.delete(key);
        this.disposeAudioEntry(entry);
      };
    } catch {
      this.disposeAudioEntry({ player, amp });
    }
  }

  setTapePrint(on) {
    const st = store.getState();
    if (on) this.tapePrintStart = st.isPlaying && st.playMode === 'SONG' ? Math.floor(st.currentStep / 16) * 16 : null;
    this.tapeDeck?.setPrint(on);
  }

  /** A finished PRINT lands on the playlist as an un-warped audio clip at the bar it started. */
  onTapePrint(buffer) {
    const st = store.getState();
    const n = Object.values(st.audioClips).filter((a) => /^PRINT/.test(a.name)).length + 1;
    const ac = this.registerAudioBuffer(`PRINT ${n}`, buffer);
    ac.detectedBpm = st.bpm;
    ac.warpMode = 'RE-PITCH';
    const clip = st.arrClips[st.arrClips.length - 1];
    clip.lengthSteps = Math.max(1, Math.round((buffer.duration * st.bpm) / 15));
    clip.startStep = this.tapePrintStart ?? 0;
    const busy = (lane) =>
      st.arrClips.some((c) => c !== clip && c.lane === lane && c.startStep < clip.startStep + clip.lengthSteps && c.startStep + c.lengthSteps > clip.startStep);
    clip.lane = [7, 6, 5, 4, 3, 2, 1, 0].find((l) => !busy(l)) ?? 7;
    store.emit('arr', { action: 'tape-print', id: ac.id });
  }

  /** Audition a playlist placement immediately (sample editor). */
  previewArrClip(arrClip) {
    const st = store.getState();
    const audioClip = st.audioClips[arrClip.refId];
    if (!audioClip) return;
    this.pruneAudioSources();
    if (this.activeAudioSources.has('preview')) {
      this.stopAudioSource('preview');
      return;
    }
    const stepDur = (60 / st.bpm) / 4;
    this.triggerWarpedAudioClip(arrClip, audioClip, Tone.immediate() + 0.02, stepDur, 0, 'preview');
  }

  isPreviewingClip() {
    this.pruneAudioSources();
    return this.activeAudioSources.has('preview');
  }

  disposeAudioEntry(entry) {
    if (!entry || entry.disposed) return;
    entry.disposed = true;
    if (entry.stretchNode) return; // persistent bank node; nothing to free
    try {
      entry.player.disconnect();
    } catch {
      // ignore
    }
    try {
      entry.amp.dispose();
    } catch {
      // ignore
    }
  }

  stopAudioSource(key, time = null) {
    const entry = this.activeAudioSources.get(key);
    if (!entry) return;
    this.activeAudioSources.delete(key);
    if (entry.stretchNode) {
      this.stretch.stop(entry.stretchNode, entry.id, time ?? Tone.immediate());
      return;
    }
    try {
      if (time != null) {
        entry.amp.gain.cancelScheduledValues(time);
        entry.amp.gain.setValueAtTime(entry.amp.gain.getValueAtTime(time), time);
        entry.amp.gain.linearRampToValueAtTime(0, time + 0.004);
        entry.player.stop(time + 0.006);
        setTimeout(() => this.disposeAudioEntry(entry), Math.max(80, (time - Tone.immediate()) * 1000 + 120));
      } else {
        entry.player.stop();
        this.disposeAudioEntry(entry);
      }
    } catch {
      this.disposeAudioEntry(entry);
    }
  }

  /** Stretch voices end on the audio thread without a callback: drop finished entries. */
  pruneAudioSources() {
    const now = Tone.immediate();
    for (const [k, e] of this.activeAudioSources) if (e.stretchNode && e.endT < now) this.activeAudioSources.delete(k);
  }

  stopAllAudioClips(time = null) {
    for (const key of [...this.activeAudioSources.keys()]) {
      if (key === 'preview') continue;
      this.stopAudioSource(key, time);
    }
  }

  applyAutomationValue(autoClip, normY) {
    const st = store.getState();
    const tid = autoClip.targetTrackId;
    const slotIdx = autoClip.targetSlotIdx;
    const paramId = autoClip.targetParamId;
    const track = st.tracks[tid];
    if (!track) return;

    if (paramId === 'vol') {
      track.volume = normY;
      this.syncTrackMixer(tid);
      return;
    }

    const slot = track.inserts[slotIdx];
    if (!slot) return;
    const def = getDevice(slot.deviceId);
    const pMeta = def?.meta.params.find((p) => p.id === paramId);
    if (!pMeta) return;

    let val;
    if (pMeta.curve === 'exp' && pMeta.min > 0) {
      val = pMeta.min * Math.pow(pMeta.max / pMeta.min, normY);
    } else {
      val = pMeta.min + (pMeta.max - pMeta.min) * normY;
    }
    slot.params[paramId] = val;
    this.syncDeviceParam(tid, slotIdx, paramId, val);
  }

  async importAudioFile(file) {
    await this.unlock();
    const arrayBuf = await file.arrayBuffer();
    const rawCtx = Tone.getContext().rawContext;
    const audioBuf = await rawCtx.decodeAudioData(arrayBuf);
    return this.registerAudioBuffer(file.name.replace(/\.[^.]+$/, '').toUpperCase().slice(0, 10), audioBuf);
  }

  registerAudioBuffer(name, audioBuf) {
    const st = store.getState();
    const analysis = analyzeAudioBuffer(audioBuf);
    const idx = Object.keys(st.audioClips).length + 1;
    const id = `W${String(idx).padStart(2, '0')}`;
    store.pushHistory(`IMPORT ${name || id}`);
    store.registerAudioBufferRef(id, audioBuf);
    st.audioClips[id] = {
      id,
      name: name || id,
      buffer: audioBuf,
      detectedBpm: analysis.detectedBpm,
      transients: analysis.transients,
      peaks: analysis.peaks,
      duration: analysis.duration,
      warpMode: 'BEATS',
      grainSize: 0.09,
      spray: 20,
      pitch: 0
    };
    // Warped length in steps is tempo-independent: duration × detected BPM / 15
    const steps = Math.max(1, Math.min(256, Math.round((analysis.duration * Math.max(40, analysis.detectedBpm || 128)) / 15)));
    const arrClip = {
      id: nextId('clip'),
      kind: 'audio',
      refId: id,
      lane: 4,
      startStep: 0,
      lengthSteps: steps
    };
    st.arrClips.push(arrClip);
    st.selectedDockClip = { kind: 'audio', refId: id };
    st.selectedArrClipId = arrClip.id;
    store.emit('arr', { action: 'import-audio', id });
    return st.audioClips[id];
  }

  async startMicRecord() {
    await this.unlock();
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Microphone API unavailable');
    }
    this.micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.recordedChunks = [];
    this.mediaRecorder = new MediaRecorder(this.micStream);
    this.mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) this.recordedChunks.push(e.data);
    };
    this.mediaRecorder.start();
    return true;
  }

  async stopMicRecord() {
    if (!this.mediaRecorder) return null;
    return new Promise((resolve) => {
      this.mediaRecorder.onstop = async () => {
        try {
          const blob = new Blob(this.recordedChunks, { type: this.mediaRecorder.mimeType || 'audio/webm' });
          const ab = await blob.arrayBuffer();
          const rawCtx = Tone.getContext().rawContext;
          const audioBuf = await rawCtx.decodeAudioData(ab);
          const clip = this.registerAudioBuffer('MIC-REC', audioBuf);
          resolve(clip);
        } catch (err) {
          console.warn('[engine] mic decode failed', err);
          resolve(null);
        } finally {
          this.micStream?.getTracks().forEach((t) => t.stop());
          this.micStream = null;
          this.mediaRecorder = null;
        }
      };
      this.mediaRecorder.stop();
    });
  }

  getWaveform() {
    if (!this.waveformAnalyser) return new Float32Array(128);
    return this.waveformAnalyser.getValue();
  }

  getFFT() {
    if (!this.fftAnalyser) return new Float32Array(64);
    return this.fftAnalyser.getValue();
  }

  getTrackMeterInfo(trackId) {
    const sm = this.channels[trackId]?.stereoMeter;
    return sm ? sm.sample() : emptyMeterInfo();
  }

  getReturnMeterInfo(returnKey) {
    const sm = returnKey === 'sendA' ? this.returnAStereoMeter : returnKey === 'sendB' ? this.returnBStereoMeter : null;
    return sm ? sm.sample() : emptyMeterInfo();
  }

  getMasterMeterInfo() {
    const pre = this.masterPreMeter ? this.masterPreMeter.sample() : null;
    const post = this.masterStereoMeter ? this.masterStereoMeter.sample() : emptyMeterInfo();
    const rawGr = pre ? Math.max(0, pre.peakDb - post.peakDb) : 0;
    this.smoothedGrDb = rawGr > this.smoothedGrDb ? rawGr : this.smoothedGrDb * 0.85;
    return {
      ...post,
      grDb: this.smoothedGrDb
    };
  }

  getReturnNode(returnKey) {
    return returnKey === 'sendA' ? this.returnA : returnKey === 'sendB' ? this.returnB : null;
  }

  getTrackMeter(trackId) {
    const info = this.getTrackMeterInfo(trackId);
    return dbToMeterNorm(info.peakDb);
  }

  getReturnMeters() {
    return {
      sendA: dbToMeterNorm(this.getReturnMeterInfo('sendA').peakDb),
      sendB: dbToMeterNorm(this.getReturnMeterInfo('sendB').peakDb)
    };
  }

  getMasterMeter() {
    const info = this.getMasterMeterInfo();
    return dbToMeterNorm(info.peakDb);
  }

  getDeviceVisualizer(trackId, slotIdx) {
    const node = this.channels[trackId]?.insertNodes[slotIdx]?.node;
    return node?.getVisualizerData?.() || null;
  }

  setDeviceXY(trackId, slotIdx, x, y) {
    const node = this.channels[trackId]?.insertNodes[slotIdx]?.node;
    if (node?.setXY) {
      node.setXY(x, y);
      return true;
    }
    return false;
  }

  setPunchFx(x, y, hold = null) {
    return this.punchFx?.setXY(x, y, hold) || { x: 0, y: 0, hold: false, active: false, label: 'BYPASS' };
  }

  togglePunchHold() {
    return this.punchFx?.toggleHold() || false;
  }

  getPunchState() {
    return this.punchFx?.getState() || { x: 0, y: 0, hold: false, active: false, label: 'BYPASS' };
  }

  startDrone(rootMidi = 48) {
    if (!this.masterBus) return;
    this.stopDrone();
    const rawCtx = Tone.getContext().rawContext;
    const now = rawCtx.currentTime;
    const freq = 440 * Math.pow(2, (rootMidi - 69) / 12);

    const filter = rawCtx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 520;
    filter.Q.value = 1.4;

    const gain = rawCtx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(0.16, now + 0.45);

    const specs = [
      { type: 'sawtooth', mult: 1, det: -6, lvl: 0.36 },
      { type: 'sawtooth', mult: 1, det: 6, lvl: 0.36 },
      { type: 'triangle', mult: 1.5, det: 2, lvl: 0.24 },
      { type: 'sine', mult: 0.5, det: 0, lvl: 0.45 }
    ];
    const oscs = specs.map((sp) => {
      const osc = rawCtx.createOscillator();
      const g = rawCtx.createGain();
      osc.type = sp.type;
      osc.frequency.setValueAtTime(freq * sp.mult, now);
      if (sp.det) osc.detune.setValueAtTime(sp.det, now);
      g.gain.value = sp.lvl;
      osc.connect(g);
      g.connect(filter);
      osc.start(now);
      return osc;
    });

    filter.connect(gain);
    Tone.connect(gain, this.masterBus);
    this.droneState = {
      active: true,
      rootMidi,
      rx: this.droneState.rx,
      ry: this.droneState.ry,
      hold: this.droneState.hold,
      oscs,
      filter,
      gain
    };
    this.setDroneXY(this.droneState.rx, this.droneState.ry);
  }

  stopDrone() {
    const d = this.droneState;
    if (!d.active) return;
    try {
      const rawCtx = Tone.getContext().rawContext;
      const now = rawCtx.currentTime;
      d.gain?.gain.cancelScheduledValues(now);
      d.gain?.gain.setTargetAtTime(0.0001, now, 0.14);
      const oscs = d.oscs || [];
      const filter = d.filter;
      const gain = d.gain;
      setTimeout(() => {
        try {
          for (const o of oscs) {
            o.stop();
            o.disconnect();
          }
          filter?.disconnect();
          gain?.disconnect();
        } catch {
          // ignore
        }
      }, 450);
    } catch {
      // ignore
    }
    this.droneState = { ...d, active: false, oscs: [], filter: null, gain: null };
  }

  setDroneXY(rx = 0, ry = 0, toggleHold = null) {
    const d = this.droneState;
    if (toggleHold === 'toggle') {
      d.hold = !d.hold;
      return { ...d };
    }
    if (d.hold && toggleHold === null) return { ...d };
    d.rx = Math.max(-1, Math.min(1, rx || 0));
    d.ry = Math.max(-1, Math.min(1, ry || 0));
    if (d.active && d.filter && d.gain) {
      const now = Tone.getContext().rawContext.currentTime;
      const cut = 220 * Math.pow(8, (d.rx + 1) * 0.5);
      const lvl = 0.08 + (-d.ry * 0.5 + 0.5) * 0.18;
      d.filter.frequency.setTargetAtTime(cut, now, 0.03);
      d.filter.Q.setTargetAtTime(1 + Math.max(0, d.rx) * 4, now, 0.03);
      d.gain.gain.setTargetAtTime(Math.max(0.03, Math.min(0.28, lvl)), now, 0.04);
    }
    return { ...d };
  }

  getDroneState() {
    const d = this.droneState;
    return { active: d.active, rootMidi: d.rootMidi, rx: d.rx, ry: d.ry, hold: d.hold };
  }

  tickFps(now) {
    const dt = now - this.lastFrameTime;
    this.lastFrameTime = now;
    if (dt > 0 && dt < 500) {
      this.fps = this.fps * 0.9 + (1000 / dt) * 0.1;
    }
  }

  getTelemetry() {
    const raw = Tone.getContext().rawContext;
    const baseLat = raw?.baseLatency || 0.01;
    const outLat = raw?.outputLatency || 0.015;
    return {
      sampleRate: raw?.sampleRate || 44100,
      latencyMs: ((baseLat + outLat) * 1000).toFixed(1),
      state: Tone.getContext().state.toUpperCase(),
      fps: Math.round(this.fps),
      activeVoices: this.channels.reduce((acc, ch) => acc + ch.insertNodes.length, 0)
    };
  }
}

export const engine = new AudioEngine();
