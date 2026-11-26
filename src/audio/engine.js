import * as Tone from 'tone';
import { getDevice } from '../device-registry.js';
import { nextId, store } from '../state/store.js';
import { analyzeAudioBuffer } from './bpm-detector.js';
import { addUserSampleBuffer, ensureFactoryDrumKits, getSamplePool } from './drum-kits.js';

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
    this.masterGain = null;
    this.limiter = null;
    this.masterMeter = null;
    this.waveformAnalyser = null;
    this.fftAnalyser = null;
    this.repeatId = null;

    this.activeAudioSources = new Map();
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
      Tone.setContext(new Tone.Context({ latencyHint: 'interactive', lookAhead: 0.02, updateInterval: 0.015 }));
    } catch {
      try {
        const curCtx = Tone.getContext();
        curCtx.lookAhead = 0.02;
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
    this.masterGain = new Tone.Gain(state.master.volume);
    this.limiter = new Tone.Limiter(state.master.limiterCeiling);
    this.masterMeter = new Tone.Meter({ smoothing: 0.72 });
    this.waveformAnalyser = new Tone.Waveform(128);
    this.fftAnalyser = new Tone.FFT(64);

    this.masterBus.connect(this.masterGain);
    this.masterGain.connect(this.limiter);
    this.limiter.connect(this.masterMeter);
    this.limiter.connect(this.waveformAnalyser);
    this.limiter.connect(this.fftAnalyser);
    this.limiter.toDestination();

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

    this.sendBBus.connect(this.returnB.input);
    this.returnB.output.connect(this.returnBGain);
    this.returnBGain.connect(this.masterBus);

    // 8 Channels
    for (let i = 0; i < 8; i++) {
      const tr = state.tracks[i];
      const fader = new Tone.Gain(tr.volume);
      const panner = new Tone.Panner(tr.pan);
      const sendAGain = new Tone.Gain(tr.sendA);
      const sendBGain = new Tone.Gain(tr.sendB);
      const meter = new Tone.Meter({ smoothing: 0.72 });

      fader.connect(panner);
      panner.connect(this.masterBus);
      panner.connect(meter);
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
    st.master.volume = Math.max(0, Math.min(1.25, vol));
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

  async togglePlay() {
    await this.unlock();
    this.stopLabPreview();
    const st = store.getState();
    const transport = Tone.getTransport();
    if (st.isPlaying) {
      transport.stop();
      this.stopAllAudioClips();
      for (const ch of this.channels) {
        ch.insertNodes[0]?.node.releaseAll?.(Tone.immediate());
      }
      st.isPlaying = false;
    } else {
      st.currentStep = 0;
      transport.start('+0.005');
      st.isPlaying = true;
    }
    store.emit('transport', { isPlaying: st.isPlaying });
  }

  async toggleRecord() {
    await this.unlock();
    const st = store.getState();
    st.isRecording = !st.isRecording;
    store.emit('transport', { isRecording: st.isRecording });
  }

  scrubStep(delta) {
    const st = store.getState();
    const maxLen = st.playMode === 'PAT' ? st.patterns[st.activePatternId]?.length || 16 : 128;
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
    };
    if (store.getState().audioUnlocked) {
      fire();
    } else {
      this.unlock().then(fire);
    }
  }

  onStep(time) {
    const st = store.getState();
    const step = st.currentStep;
    const stepDur = (60 / st.bpm) / 4;

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
      const songLength = 128;
      const songStep = step % songLength;

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
            this.triggerNotesAtStep(tid, notes, localStep, stepDur, swungTime);
          }
        } else if (clip.kind === 'audio') {
          const audioClip = st.audioClips[clip.refId];
          if (audioClip && songStep === clip.startStep) {
            this.triggerWarpedAudioClip(clip, audioClip, time, stepDur);
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
      st.currentStep = (songStep + 1) % songLength;
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
      if (Math.round(note.step) !== localStep) continue;
      const prob = note.prob ?? 100;
      if (prob < 100 && Math.random() * 100 > prob) continue;

      const durSec = Math.max(0.04, (note.len || 1) * stepDur * 0.92);
      const vel = Math.max(0.05, Math.min(1, (note.vel || 100) / 127));
      const opts = { cutoffOffset: note.cutoff || 0 };

      if (note.slide && typeof inst.triggerSlide === 'function') {
        inst.triggerSlide(this.lastActiveMidiByTrack[trackId], note.midi, durSec, time, vel, opts);
      } else if (typeof inst.triggerNote === 'function') {
        inst.triggerNote(note.midi, durSec, time, vel, opts);
      }
      this.lastActiveMidiByTrack[trackId] = note.midi;
    }
  }

  triggerWarpedAudioClip(arrClip, audioClip, time, stepDur) {
    if (!audioClip.buffer) return;
    const laneTrack = Math.max(0, Math.min(7, arrClip.lane));
    const targetFader = this.channels[laneTrack]?.fader || this.masterBus;
    const rate = store.getState().bpm / Math.max(40, audioClip.detectedBpm || 128);
    const playDur = arrClip.lengthSteps * stepDur;

    // Stop previous instance of same clip
    const existing = this.activeAudioSources.get(arrClip.id);
    if (existing) {
      try {
        existing.stop();
        existing.dispose();
      } catch {
        // ignore
      }
    }

    let player;
    if (audioClip.warpMode === 'RE-PITCH') {
      player = new Tone.Player({ url: audioClip.buffer, playbackRate: rate }).connect(targetFader);
    } else {
      const isTexture = audioClip.warpMode === 'TEXTURE';
      const isTones = audioClip.warpMode === 'TONES';
      player = new Tone.GrainPlayer({
        url: audioClip.buffer,
        playbackRate: rate,
        grainSize: isTexture ? audioClip.grainSize || 0.14 : isTones ? 0.12 : 0.055,
        overlap: isTexture ? 0.08 : isTones ? 0.06 : 0.018,
        detune: (audioClip.pitch || 0) * 100
      }).connect(targetFader);
    }

    try {
      player.start(time, 0, Math.min(playDur, audioClip.duration / rate + 0.5));
      this.activeAudioSources.set(arrClip.id, player);
    } catch {
      // ignore
    }
  }

  stopAllAudioClips() {
    for (const player of this.activeAudioSources.values()) {
      try {
        player.stop();
        player.dispose();
      } catch {
        // ignore
      }
    }
    this.activeAudioSources.clear();
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
    const steps = Math.max(8, Math.min(64, Math.round((analysis.duration * (st.bpm / 60)) * 4)));
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

  getTrackMeter(trackId) {
    const m = this.channels[trackId]?.meter;
    if (!m) return 0;
    const db = m.getValue();
    return Math.max(0, Math.min(1, (db + 60) / 60));
  }

  getReturnMeters() {
    return {
      sendA: this.returnA?.getMeter?.() || 0,
      sendB: this.returnB?.getMeter?.() || 0
    };
  }

  getMasterMeter() {
    if (!this.masterMeter) return 0;
    const db = this.masterMeter.getValue();
    return Math.max(0, Math.min(1, (db + 60) / 60));
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
