import { getDefaultParams, getDevice } from '../device-registry.js';

let uidCounter = 1;
export function nextId(prefix = 'id') {
  return `${prefix}_${Date.now().toString(36)}_${uidCounter++}`;
}

function createTrack(index, name, instrumentId, extraFx = []) {
  const inserts = [
    {
      slotId: nextId('slot'),
      deviceId: instrumentId,
      bypass: false,
      params: getDefaultParams(instrumentId)
    },
    {
      slotId: nextId('slot'),
      deviceId: 'eq3',
      bypass: false,
      params: getDefaultParams('eq3')
    },
    {
      slotId: nextId('slot'),
      deviceId: 'comp',
      bypass: false,
      params: getDefaultParams('comp')
    },
    ...extraFx.map((fxId) => ({
      slotId: nextId('slot'),
      deviceId: fxId,
      bypass: false,
      params: getDefaultParams(fxId)
    }))
  ];

  return {
    id: index,
    code: String(index + 1).padStart(2, '0'),
    name,
    volume: 0.82,
    pan: 0,
    sendA: 0,
    sendB: 0,
    mute: false,
    solo: false,
    inserts
  };
}

function buildInitialPatterns() {
  const patterns = {};
  for (let i = 1; i <= 64; i++) {
    const id = `P${String(i).padStart(2, '0')}`;
    patterns[id] = {
      id,
      name: id,
      length: 16,
      swing: 0,
      notesByTrack: {}
    };
  }
  return patterns;
}

const initialTracks = [
  createTrack(0, 'MONO-303', 'mono303', ['drive', 'delay']),
  createTrack(1, 'DRUM-8', 'drum8', ['drive']),
  createTrack(2, 'POLY-FM', 'polyfm', ['verb']),
  createTrack(3, 'GRAIN-1', 'grain1', ['delay', 'verb']),
  createTrack(4, 'ACID-2', 'mono303'),
  createTrack(5, 'CHORD-2', 'polyfm'),
  createTrack(6, 'TEXT-2', 'grain1'),
  createTrack(7, 'PERC-2', 'drum8')
];

const initialState = {
  theme: 'dark',
  view: 'ROLL', // 'ROLL' | 'ARR' | 'MIX' | 'DSP'
  playMode: 'PAT', // 'PAT' | 'SONG'
  isPlaying: false,
  isRecording: false,
  audioUnlocked: false,
  bpm: 124,
  swing: 0,
  currentStep: 0,
  projectName: 'UNTITLED',
  hasSavedSession: false,

  selectedTrackId: 0,
  activePatternId: 'P01',
  ghostPatternId: null,
  gridSnap: 1,
  scaleRoot: 6, // F#
  scaleId: 'MIN',
  scaleLock: false,
  rollLane: 'VEL', // 'VEL' | 'PROB' | 'SLIDE' | 'CUT'
  rollLaneOpen: false,
  slideMode: false,

  selectedDockClip: { kind: 'pattern', refId: 'P01' },
  selectedArrClipId: null,
  arrFollow: true,
  selectedDeviceSlotIdx: 0,
  selectedParamIdx: 0,

  detailOverlay: { type: 'triage', step: 'root' },
  randomizerOpen: false,
  devicePickerOpen: false,

  randomizer: {
    mode: 'ACID',
    baseOctave: 2,
    octaveSpread: 2,
    euclidSteps: 16,
    euclidHits: 10,
    euclidRot: 0,
    density: 85,
    velJitter: 25,
    slidePct: 24,
    seed: 47701,
    seedLock: false
  },

  tracks: initialTracks,
  laneLabels: ['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8'],
  patterns: buildInitialPatterns(),
  audioClips: {},
  autoClips: {},
  arrClips: [],
  lab: [],
  sessionHistory: [],

  returns: {
    sendA: { deviceId: 'delay', volume: 0.78, mute: false, params: getDefaultParams('delay') },
    sendB: { deviceId: 'verb', volume: 0.72, mute: false, params: getDefaultParams('verb') }
  },
  master: {
    volume: 0.88,
    limiterCeiling: -0.5
  }
};

const MAX_HISTORY = 200;
const undoStack = [];
const redoStack = [];
let pendingGesture = null;
let lastCoalesce = { key: null, at: 0 };
const audioBufferPool = new Map();

function clonePatterns(patterns) {
  const out = {};
  for (const [pid, pat] of Object.entries(patterns)) {
    const clonedByTrack = {};
    for (const [tid, list] of Object.entries(pat.notesByTrack)) {
      if (list && list.length > 0) {
        clonedByTrack[tid] = list.map((n) => ({ ...n }));
      }
    }
    out[pid] = {
      id: pat.id,
      name: pat.name,
      length: pat.length,
      swing: pat.swing || 0,
      notesByTrack: clonedByTrack
    };
  }
  return out;
}

function captureSnapshot() {
  const st = initialState;
  const audioMeta = {};
  for (const [id, ac] of Object.entries(st.audioClips)) {
    if (ac.buffer && !audioBufferPool.has(id)) {
      audioBufferPool.set(id, ac.buffer);
    }
    audioMeta[id] = {
      id: ac.id,
      name: ac.name,
      detectedBpm: ac.detectedBpm,
      transients: [...(ac.transients || [])],
      peaks: [...(ac.peaks || [])],
      duration: ac.duration,
      warpMode: ac.warpMode,
      grainSize: ac.grainSize,
      spray: ac.spray,
      pitch: ac.pitch
    };
  }

  return {
    bpm: st.bpm,
    swing: st.swing,
    playMode: st.playMode,
    projectName: st.projectName,
    selectedTrackId: st.selectedTrackId,
    activePatternId: st.activePatternId,
    ghostPatternId: st.ghostPatternId,
    scaleRoot: st.scaleRoot,
    scaleId: st.scaleId,
    scaleLock: st.scaleLock,
    tracks: st.tracks.map((tr) => ({
      ...tr,
      inserts: tr.inserts.map((s) => ({ ...s, params: { ...s.params } }))
    })),
    laneLabels: [...st.laneLabels],
    patterns: clonePatterns(st.patterns),
    arrClips: st.arrClips.map((c) => ({ ...c })),
    autoClips: Object.fromEntries(
      Object.entries(st.autoClips).map(([id, ac]) => [
        id,
        { ...ac, points: ac.points.map((p) => ({ ...p })) }
      ])
    ),
    audioClips: audioMeta,
    lab: st.lab.map((item) => ({
      ...item,
      instrumentParams: item.instrumentParams ? { ...item.instrumentParams } : {},
      notes: item.notes ? item.notes.map((n) => ({ ...n })) : null,
      autoClip: item.autoClip ? { ...item.autoClip, points: item.autoClip.points.map((p) => ({ ...p })) } : null
    })),
    returns: {
      sendA: { ...st.returns.sendA, params: { ...st.returns.sendA.params } },
      sendB: { ...st.returns.sendB, params: { ...st.returns.sendB.params } }
    },
    master: { ...st.master }
  };
}

function applySnapshot(snap) {
  const st = initialState;
  st.bpm = snap.bpm;
  st.swing = snap.swing;
  st.playMode = snap.playMode;
  if (snap.projectName) st.projectName = snap.projectName;
  st.selectedTrackId = Math.max(0, Math.min(7, snap.selectedTrackId));
  st.activePatternId = snap.activePatternId;
  st.ghostPatternId = snap.ghostPatternId;
  st.scaleRoot = snap.scaleRoot;
  st.scaleId = snap.scaleId;
  st.scaleLock = snap.scaleLock;

  st.tracks = snap.tracks.map((tr) => ({
    ...tr,
    inserts: tr.inserts.map((s) => ({ ...s, params: { ...s.params } }))
  }));
  st.laneLabels = snap.laneLabels ? [...snap.laneLabels] : ['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8'];
  st.patterns = clonePatterns(snap.patterns);
  st.arrClips = snap.arrClips.map((c) => ({ ...c }));
  st.autoClips = Object.fromEntries(
    Object.entries(snap.autoClips || {}).map(([id, ac]) => [
      id,
      { ...ac, points: ac.points.map((p) => ({ ...p })) }
    ])
  );
  st.audioClips = Object.fromEntries(
    Object.entries(snap.audioClips || {}).map(([id, meta]) => [
      id,
      { ...meta, buffer: audioBufferPool.get(id) || null }
    ])
  );
  if (Array.isArray(snap.lab)) {
    st.lab = snap.lab.map((item) => ({
      ...item,
      instrumentParams: item.instrumentParams ? { ...item.instrumentParams } : {},
      notes: item.notes ? item.notes.map((n) => ({ ...n })) : null,
      autoClip: item.autoClip ? { ...item.autoClip, points: item.autoClip.points.map((p) => ({ ...p })) } : null
    }));
  }
  st.returns = {
    sendA: { ...snap.returns.sendA, params: { ...snap.returns.sendA.params } },
    sendB: { ...snap.returns.sendB, params: { ...snap.returns.sendB.params } }
  };
  st.master = { ...snap.master };
  if (st.selectedDeviceSlotIdx >= st.tracks[st.selectedTrackId].inserts.length) {
    st.selectedDeviceSlotIdx = 0;
  }
  store.emit('history-restore', snap);
}

function recordEntry(label, snapshot) {
  undoStack.push({ label, ts: Date.now(), snapshot });
  if (undoStack.length > MAX_HISTORY) undoStack.shift();
  redoStack.length = 0;
  store.emit('history', { undoCount: undoStack.length, redoCount: redoStack.length });
}

const listeners = new Set();

export const store = {
  getState() {
    return initialState;
  },

  registerAudioBufferRef(id, buf) {
    if (id && buf) audioBufferPool.set(id, buf);
  },

  pushHistory(label = 'EDIT') {
    if (pendingGesture) {
      pendingGesture.dirty = true;
      return;
    }
    recordEntry(label, captureSnapshot());
  },

  beginGesture(label = 'EDIT') {
    pendingGesture = { label, snapshot: captureSnapshot(), dirty: false };
  },

  markGestureDirty() {
    if (pendingGesture) pendingGesture.dirty = true;
  },

  commitGesture() {
    if (!pendingGesture) return;
    const g = pendingGesture;
    pendingGesture = null;
    if (g.dirty) {
      recordEntry(g.label, g.snapshot);
    }
  },

  pushHistoryCoalesced(key, label, windowMs = 650) {
    const now = performance.now();
    if (lastCoalesce.key !== key || now - lastCoalesce.at > windowMs) {
      recordEntry(label, captureSnapshot());
    }
    lastCoalesce.key = key;
    lastCoalesce.at = now;
  },

  undo() {
    if (undoStack.length === 0) return false;
    pendingGesture = null;
    const entry = undoStack.pop();
    redoStack.push({ label: entry.label, ts: Date.now(), snapshot: captureSnapshot() });
    applySnapshot(entry.snapshot);
    this.emit('history', { undoCount: undoStack.length, redoCount: redoStack.length });
    return true;
  },

  redo() {
    if (redoStack.length === 0) return false;
    pendingGesture = null;
    const entry = redoStack.pop();
    undoStack.push({ label: entry.label, ts: Date.now(), snapshot: captureSnapshot() });
    applySnapshot(entry.snapshot);
    this.emit('history', { undoCount: undoStack.length, redoCount: redoStack.length });
    return true;
  },

  jumpToHistory(index) {
    if (index < 0 || index >= undoStack.length) return false;
    pendingGesture = null;
    while (undoStack.length - 1 > index) {
      const top = undoStack.pop();
      redoStack.push({ label: top.label, ts: Date.now(), snapshot: captureSnapshot() });
      applySnapshot(top.snapshot);
    }
    const target = undoStack.pop();
    redoStack.push({ label: target.label, ts: Date.now(), snapshot: captureSnapshot() });
    applySnapshot(target.snapshot);
    this.emit('history', { undoCount: undoStack.length, redoCount: redoStack.length });
    return true;
  },

  getHistoryInfo() {
    return {
      undoCount: undoStack.length,
      redoCount: redoStack.length,
      undoStack,
      redoStack
    };
  },

  subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },

  emit(topic = 'state', payload = null) {
    for (const fn of listeners) {
      try {
        fn(initialState, topic, payload);
      } catch (err) {
        console.error('[store] listener error', err);
      }
    }
  },

  setTheme(theme) {
    initialState.theme = theme === 'light' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', initialState.theme);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', initialState.theme === 'dark' ? '#0D0D0F' : '#F4F4F2');
    this.emit('theme', initialState.theme);
  },

  toggleTheme() {
    this.setTheme(initialState.theme === 'dark' ? 'light' : 'dark');
  },

  setView(view) {
    if (!['ROLL', 'ARR', 'MIX', 'DSP'].includes(view)) return;
    initialState.view = view;
    this.emit('view', view);
  },

  cycleView(dir = 1) {
    const order = ['ROLL', 'ARR', 'MIX', 'DSP'];
    const idx = order.indexOf(initialState.view);
    const next = order[(idx + dir + order.length) % order.length];
    this.setView(next);
  },

  setSelectedTrack(trackId) {
    const id = Math.max(0, Math.min(7, trackId));
    initialState.selectedTrackId = id;
    const track = initialState.tracks[id];
    if (initialState.selectedDeviceSlotIdx >= track.inserts.length) {
      initialState.selectedDeviceSlotIdx = 0;
    }
    this.emit('track', id);
  },

  setLaneLabel(laneIdx, rawLabel) {
    if (laneIdx < 0 || laneIdx >= 8) return;
    const cleaned = String(rawLabel || '').trim().toUpperCase().slice(0, 12);
    const nextLabel = cleaned || `L${laneIdx + 1}`;
    if (initialState.laneLabels[laneIdx] === nextLabel) return;
    this.pushHistory(`LABEL L${laneIdx + 1}`);
    initialState.laneLabels[laneIdx] = nextLabel;
    this.emit('arr', { action: 'lane-label', laneIdx });
  },

  renameTrack(trackId, rawName) {
    const track = initialState.tracks[trackId];
    if (!track) return;
    const cleaned = String(rawName || '').trim().toUpperCase().slice(0, 12);
    const defName = getDevice(track.inserts?.[0]?.deviceId)?.meta.name || `CH ${track.code}`;
    const nextName = cleaned || defName;
    if (track.name === nextName) return;
    this.pushHistory(`NAME ${track.code}`);
    track.name = nextName;
    this.emit('track', trackId);
    this.emit('mixer', { trackId });
  },

  renameClip(clipId, rawName) {
    const clip = initialState.arrClips.find((c) => c.id === clipId);
    if (!clip) return;
    const cleaned = String(rawName || '').trim().toUpperCase().slice(0, 16);
    this.pushHistory(`RENAME ${clip.refId}`);
    if (cleaned) {
      clip.name = cleaned;
    } else {
      delete clip.name;
    }
    if (clip.kind === 'pattern' && initialState.patterns[clip.refId]) {
      initialState.patterns[clip.refId].name = cleaned || clip.refId;
    } else if (clip.kind === 'audio' && initialState.audioClips[clip.refId]) {
      initialState.audioClips[clip.refId].name = cleaned || clip.refId;
    } else if (clip.kind === 'auto' && initialState.autoClips[clip.refId]) {
      initialState.autoClips[clip.refId].name = cleaned || clip.refId;
    }
    this.emit('arr', { action: 'rename', clipId });
    this.emit('pattern', clip.refId);
  },

  setPatternSwing(patId, swing) {
    const pat = initialState.patterns[patId];
    if (!pat) return;
    const clamped = Math.max(0, Math.min(80, Math.round(swing)));
    pat.swing = clamped;
    this.markGestureDirty();
    this.emit('pattern', patId);
    this.emit('roll-ctx');
  },

  setClipSwing(clipId, swing) {
    const clip = initialState.arrClips.find((c) => c.id === clipId);
    if (!clip) return;
    const clamped = Math.max(0, Math.min(80, Math.round(swing)));
    clip.swing = clamped;
    if (clip.kind === 'pattern' && initialState.patterns[clip.refId]) {
      initialState.patterns[clip.refId].swing = clamped;
    }
    this.markGestureDirty();
    this.emit('arr', { action: 'swing', clipId });
    this.emit('roll-ctx');
  },

  setActivePattern(patId) {
    if (!initialState.patterns[patId]) return;
    initialState.activePatternId = patId;
    initialState.selectedDockClip = { kind: 'pattern', refId: patId };
    this.emit('pattern', patId);
  },

  getActiveNotes(trackId = initialState.selectedTrackId, patternId = initialState.activePatternId) {
    const pat = initialState.patterns[patternId];
    if (!pat) return [];
    if (!pat.notesByTrack[trackId]) pat.notesByTrack[trackId] = [];
    return pat.notesByTrack[trackId];
  },

  setActiveNotes(notes, trackId = initialState.selectedTrackId, patternId = initialState.activePatternId, historyLabel = null) {
    const pat = initialState.patterns[patternId];
    if (!pat) return;
    if (historyLabel) this.pushHistory(historyLabel);
    pat.notesByTrack[trackId] = notes;
    this.emit('notes', { patternId, trackId });
  },

  setTrackParam(trackId, key, value) {
    const track = initialState.tracks[trackId];
    if (!track) return;
    track[key] = value;
    this.markGestureDirty();
    this.emit('mixer', { trackId, key, value });
  },

  setDeviceParam(trackId, slotIdx, paramId, value) {
    const track = initialState.tracks[trackId];
    if (!track || !track.inserts[slotIdx]) return;
    const slot = track.inserts[slotIdx];
    const def = getDevice(slot.deviceId);
    const pMeta = def?.meta.params.find((p) => p.id === paramId);
    let clamped = value;
    if (pMeta) {
      clamped = Math.max(pMeta.min, Math.min(pMeta.max, value));
      if (pMeta.step >= 1) clamped = Math.round(clamped / pMeta.step) * pMeta.step;
    }
    slot.params[paramId] = clamped;
    this.markGestureDirty();
    this.emit('dsp-param', { trackId, slotIdx, paramId, value: clamped });
  },

  toggleDeviceBypass(trackId, slotIdx) {
    const track = initialState.tracks[trackId];
    if (!track || !track.inserts[slotIdx]) return;
    const def = getDevice(track.inserts[slotIdx].deviceId);
    this.pushHistory(`BYP ${def?.meta.name || 'FX'}`);
    track.inserts[slotIdx].bypass = !track.inserts[slotIdx].bypass;
    this.emit('dsp-bypass', { trackId, slotIdx, bypass: track.inserts[slotIdx].bypass });
  },

  addInsertDevice(trackId, deviceId) {
    const track = initialState.tracks[trackId];
    const def = getDevice(deviceId);
    if (!track || !def) return;
    this.pushHistory(`ADD ${def.meta.name}`);
    if (def.meta.category === 'instrument') {
      track.inserts[0] = {
        slotId: nextId('slot'),
        deviceId,
        bypass: false,
        params: getDefaultParams(deviceId)
      };
      track.name = def.meta.name;
    } else {
      track.inserts.push({
        slotId: nextId('slot'),
        deviceId,
        bypass: false,
        params: getDefaultParams(deviceId)
      });
    }
    this.emit('dsp-chain', { trackId });
  },

  removeInsertDevice(trackId, slotIdx) {
    const track = initialState.tracks[trackId];
    if (!track || slotIdx <= 0 || slotIdx >= track.inserts.length) return;
    const def = getDevice(track.inserts[slotIdx].deviceId);
    this.pushHistory(`DEL ${def?.meta.name || 'FX'}`);
    track.inserts.splice(slotIdx, 1);
    if (initialState.selectedDeviceSlotIdx >= track.inserts.length) {
      initialState.selectedDeviceSlotIdx = track.inserts.length - 1;
    }
    this.emit('dsp-chain', { trackId });
  },

  setReturnParam(returnKey, paramId, value) {
    const ret = initialState.returns[returnKey];
    if (!ret) return;
    ret.params[paramId] = value;
    this.markGestureDirty();
    this.emit('return-param', { returnKey, paramId, value });
  },

  makePatternUnique(arrClipId) {
    const clip = initialState.arrClips.find((c) => c.id === arrClipId);
    if (!clip) return null;
    if (clip.kind === 'pattern') {
      const used = new Set(initialState.arrClips.filter((c) => c.kind === 'pattern').map((c) => c.refId));
      let nextPatId = null;
      for (let i = 1; i <= 64; i++) {
        const id = `P${String(i).padStart(2, '0')}`;
        const pat = initialState.patterns[id];
        const hasNotes = Object.values(pat.notesByTrack).some((arr) => arr.length > 0);
        if (!used.has(id) && !hasNotes) {
          nextPatId = id;
          break;
        }
      }
      if (!nextPatId) return null;
      this.pushHistory(`UNIQUE ${clip.refId}`);
      const src = initialState.patterns[clip.refId];
      const clonedByTrack = {};
      for (const [tid, list] of Object.entries(src.notesByTrack)) {
        clonedByTrack[tid] = list.map((n) => ({ ...n, id: nextId('n') }));
      }
      initialState.patterns[nextPatId] = {
        id: nextPatId,
        name: nextPatId,
        length: src.length,
        swing: src.swing || 0,
        notesByTrack: clonedByTrack
      };
      clip.refId = nextPatId;
      initialState.activePatternId = nextPatId;
      this.emit('arr', { action: 'unique', clip });
      return nextPatId;
    }
    if (clip.kind === 'auto') {
      const idx = Object.keys(initialState.autoClips).length + 1;
      const newId = `A${String(idx).padStart(2, '0')}`;
      const src = initialState.autoClips[clip.refId];
      if (!src) return null;
      this.pushHistory(`UNIQUE ${clip.refId}`);
      initialState.autoClips[newId] = {
        ...src,
        id: newId,
        name: newId,
        points: src.points.map((p) => ({ ...p }))
      };
      clip.refId = newId;
      this.emit('arr', { action: 'unique', clip });
      return newId;
    }
    return null;
  },

  createAutomationClip(trackId = initialState.selectedTrackId, slotIdx = 0, paramId = 'cutoff') {
    this.pushHistory('CREATE AUTO');
    const idx = Object.keys(initialState.autoClips).length + 1;
    const id = `A${String(idx).padStart(2, '0')}`;
    const track = initialState.tracks[trackId];
    const slot = track?.inserts[slotIdx] || track?.inserts[0];
    const def = slot ? getDevice(slot.deviceId) : null;
    const validParam = def?.meta.params.find((p) => p.id === paramId) || def?.meta.params[0];

    initialState.autoClips[id] = {
      id,
      name: id,
      targetTrackId: trackId,
      targetSlotIdx: slotIdx,
      targetParamId: validParam ? validParam.id : 'vol',
      points: [
        { x: 0, y: 0.2 },
        { x: 0.5, y: 0.85 },
        { x: 1, y: 0.35 }
      ]
    };

    const arrClip = {
      id: nextId('clip'),
      kind: 'auto',
      refId: id,
      lane: Math.min(7, trackId + 4),
      startStep: 0,
      lengthSteps: 32
    };
    initialState.arrClips.push(arrClip);
    initialState.selectedDockClip = { kind: 'auto', refId: id };
    initialState.selectedArrClipId = arrClip.id;
    this.emit('arr', { action: 'create-auto', id });
    return arrClip;
  },

  resetProjectBlank(firstInstrumentId = null) {
    this.pushHistory('NEW PROJECT');
    const st = initialState;
    for (let i = 1; i <= 64; i++) {
      const id = `P${String(i).padStart(2, '0')}`;
      st.patterns[id] = { id, name: id, length: 16, swing: 0, notesByTrack: {} };
    }
    for (const tr of st.tracks) {
      tr.sendA = 0;
      tr.sendB = 0;
    }
    st.arrClips = [];
    st.autoClips = {};
    st.audioClips = {};
    st.laneLabels = ['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8'];
    st.activePatternId = 'P01';
    st.ghostPatternId = null;
    st.selectedDockClip = { kind: 'pattern', refId: 'P01' };
    st.selectedArrClipId = null;
    st.playMode = 'PAT';
    st.selectedTrackId = 0;
    st.selectedDeviceSlotIdx = 0;
    st.currentStep = 0;

    if (firstInstrumentId && getDevice(firstInstrumentId)) {
      const def = getDevice(firstInstrumentId);
      st.tracks[0].inserts[0] = {
        slotId: nextId('slot'),
        deviceId: firstInstrumentId,
        bypass: false,
        params: getDefaultParams(firstInstrumentId)
      };
      st.tracks[0].name = def.meta.name;
    }
    this.emit('history-restore');
  },

  addInstrumentTrack(deviceId) {
    const st = initialState;
    const def = getDevice(deviceId);
    if (!def) return st.selectedTrackId;
    const usedTracks = new Set();
    for (const pat of Object.values(st.patterns)) {
      for (const [tid, list] of Object.entries(pat.notesByTrack)) {
        if (list && list.length > 0) usedTracks.add(Number(tid));
      }
    }
    let targetId = -1;
    for (let i = 0; i < 8; i++) {
      if (!usedTracks.has(i)) {
        targetId = i;
        break;
      }
    }
    if (targetId === -1) targetId = (st.selectedTrackId + 1) % 8;
    this.addInsertDevice(targetId, deviceId);
    this.setSelectedTrack(targetId);
    return targetId;
  },

  archiveClipToLab(arrClipId, removeFromTimeline = true) {
    const st = initialState;
    const clip = st.arrClips.find((c) => c.id === arrClipId);
    if (!clip) return null;
    this.pushHistory(`+LAB ${clip.refId}`);

    const labNum = st.lab.length + 1;
    const labId = `LAB${String(labNum).padStart(2, '0')}`;
    let entry = null;

    if (clip.kind === 'pattern') {
      const pat = st.patterns[clip.refId];
      let srcTrackId = clip.trackOverride ?? st.selectedTrackId;
      if (pat && (!pat.notesByTrack[srcTrackId] || pat.notesByTrack[srcTrackId].length === 0)) {
        const firstPop = Object.keys(pat.notesByTrack).find((tid) => pat.notesByTrack[tid]?.length > 0);
        if (firstPop != null) srcTrackId = Number(firstPop);
      }
      const tr = st.tracks[srcTrackId];
      const instSlot = tr?.inserts[0];
      const def = instSlot ? getDevice(instSlot.deviceId) : null;
      const notes = (pat?.notesByTrack[srcTrackId] || []).map((n) => ({ ...n, id: nextId('n') }));

      entry = {
        id: labId,
        name: `${clip.refId} // ${tr?.name || 'INST'}`,
        createdAt: Date.now(),
        kind: 'pattern',
        refId: clip.refId,
        lengthSteps: pat?.length || 16,
        bpm: st.bpm,
        instrumentId: instSlot?.deviceId || 'mono303',
        instrumentName: def?.meta.name || tr?.name || 'MONO-303',
        instrumentParams: instSlot ? { ...instSlot.params } : {},
        notes,
        audioRef: null,
        autoClip: null
      };
    } else if (clip.kind === 'audio') {
      const ac = st.audioClips[clip.refId];
      entry = {
        id: labId,
        name: `${clip.refId} // ${ac?.name || 'AUDIO'}`,
        createdAt: Date.now(),
        kind: 'audio',
        refId: clip.refId,
        lengthSteps: clip.lengthSteps,
        bpm: st.bpm,
        instrumentId: 'grain1',
        instrumentName: 'AUDIO',
        instrumentParams: {},
        notes: null,
        audioRef: clip.refId,
        autoClip: null
      };
    } else if (clip.kind === 'auto') {
      const aut = st.autoClips[clip.refId];
      entry = {
        id: labId,
        name: `${clip.refId} // AUTO`,
        createdAt: Date.now(),
        kind: 'auto',
        refId: clip.refId,
        lengthSteps: clip.lengthSteps,
        bpm: st.bpm,
        instrumentId: null,
        instrumentName: 'AUTO',
        instrumentParams: {},
        notes: null,
        audioRef: null,
        autoClip: aut ? { ...aut, points: aut.points.map((p) => ({ ...p })) } : null
      };
    }

    if (!entry) return null;
    st.lab.unshift(entry);
    if (removeFromTimeline) {
      st.arrClips = st.arrClips.filter((c) => c.id !== arrClipId);
      if (st.selectedArrClipId === arrClipId) st.selectedArrClipId = null;
    }
    this.emit('lab', { action: 'add', entry });
    this.emit('arr', { action: 'lab-hide', clipId: arrClipId });
    return entry;
  },

  archiveActivePatternToLab() {
    const st = initialState;
    const tid = st.selectedTrackId;
    const tr = st.tracks[tid];
    const pat = st.patterns[st.activePatternId];
    const notes = pat?.notesByTrack[tid] || [];
    if (notes.length === 0) return null;
    this.pushHistory(`+LAB ${st.activePatternId}`);
    const instSlot = tr.inserts[0];
    const def = instSlot ? getDevice(instSlot.deviceId) : null;
    const labId = `LAB${String(st.lab.length + 1).padStart(2, '0')}`;
    const entry = {
      id: labId,
      name: `${st.activePatternId} // ${tr.name}`,
      createdAt: Date.now(),
      kind: 'pattern',
      refId: st.activePatternId,
      lengthSteps: pat.length || 16,
      bpm: st.bpm,
      instrumentId: instSlot.deviceId,
      instrumentName: def?.meta.name || tr.name,
      instrumentParams: { ...instSlot.params },
      notes: notes.map((n) => ({ ...n, id: nextId('n') })),
      audioRef: null,
      autoClip: null
    };
    st.lab.unshift(entry);
    this.emit('lab', { action: 'add', entry });
    return entry;
  },

  removeLabItem(labId) {
    this.pushHistory('DEL LAB');
    initialState.lab = initialState.lab.filter((item) => item.id !== labId);
    this.emit('lab', { action: 'remove', labId });
  },

  assignLabToTrack(labId, targetMode = 'current') {
    const st = initialState;
    const item = st.lab.find((x) => x.id === labId);
    if (!item) return false;
    this.pushHistory(`LAB -> ${targetMode.toUpperCase()}`);

    if (item.kind === 'pattern') {
      if (targetMode === 'new') {
        const targetTid = this.addInstrumentTrack(item.instrumentId || 'mono303');
        const tr = st.tracks[targetTid];
        if (tr.inserts[0] && item.instrumentParams) {
          tr.inserts[0].params = { ...tr.inserts[0].params, ...item.instrumentParams };
        }
        // Find an empty pattern or reuse active
        let targetPatId = st.activePatternId;
        for (let i = 1; i <= 64; i++) {
          const pid = `P${String(i).padStart(2, '0')}`;
          const hasNotes = Object.values(st.patterns[pid].notesByTrack).some((a) => a.length > 0);
          if (!hasNotes) {
            targetPatId = pid;
            break;
          }
        }
        st.patterns[targetPatId].length = item.lengthSteps || 16;
        st.patterns[targetPatId].notesByTrack[targetTid] = (item.notes || []).map((n) => ({ ...n, id: nextId('n') }));
        st.activePatternId = targetPatId;
        st.selectedDockClip = { kind: 'pattern', refId: targetPatId };
        this.emit('history-restore');
      } else {
        const tid = st.selectedTrackId;
        const pid = st.activePatternId;
        st.patterns[pid].length = item.lengthSteps || 16;
        st.patterns[pid].notesByTrack[tid] = (item.notes || []).map((n) => ({ ...n, id: nextId('n') }));
        this.emit('notes', { patternId: pid, trackId: tid });
      }
      st.detailOverlay = null;
      this.emit('overlay', null);
      this.setView('ROLL');
      return true;
    }

    if (item.kind === 'audio' && item.audioRef && st.audioClips[item.audioRef]) {
      const clip = {
        id: nextId('clip'),
        kind: 'audio',
        refId: item.audioRef,
        lane: 4,
        startStep: 0,
        lengthSteps: item.lengthSteps || 32
      };
      st.arrClips.push(clip);
      st.selectedArrClipId = clip.id;
      st.detailOverlay = null;
      this.emit('overlay', null);
      this.emit('arr');
      this.setView('ARR');
      return true;
    }

    if (item.kind === 'auto' && item.autoClip) {
      const id = item.autoClip.id;
      st.autoClips[id] = { ...item.autoClip, points: item.autoClip.points.map((p) => ({ ...p })) };
      const clip = {
        id: nextId('clip'),
        kind: 'auto',
        refId: id,
        lane: 5,
        startStep: 0,
        lengthSteps: item.lengthSteps || 32
      };
      st.arrClips.push(clip);
      st.selectedArrClipId = clip.id;
      st.detailOverlay = null;
      this.emit('overlay', null);
      this.emit('arr');
      this.setView('ARR');
      return true;
    }

    return false;
  },

  saveSessionCheckpoint(label = 'SESSION') {
    const st = initialState;
    const entry = {
      id: nextId('ses'),
      label,
      savedAt: Date.now(),
      bpm: st.bpm,
      labCount: st.lab.length,
      snapshot: captureSnapshot()
    };
    st.sessionHistory.unshift(entry);
    if (st.sessionHistory.length > 50) st.sessionHistory.pop();
    this.emit('history', { undoCount: undoStack.length, redoCount: redoStack.length });
    return entry;
  },

  restoreSessionCheckpoint(id) {
    const st = initialState;
    const entry = st.sessionHistory.find((s) => s.id === id);
    if (!entry || !entry.snapshot) return false;
    this.pushHistory(`RESTORE ${entry.label}`);
    applySnapshot(entry.snapshot);
    return true;
  },

  exportSerializableState() {
    const snap = captureSnapshot();
    const { lab, ...project } = snap;
    return {
      project,
      lab,
      sessionHistory: initialState.sessionHistory.map((s) => ({ ...s }))
    };
  },

  hydrateSerializedState(projectData, labData = [], sessionData = []) {
    if (projectData) {
      applySnapshot({ ...projectData, lab: labData });
    }
    if (Array.isArray(sessionData)) {
      initialState.sessionHistory = sessionData;
    }
    initialState.hasSavedSession = true;
    this.emit('history', { undoCount: undoStack.length, redoCount: redoStack.length });
    this.emit('lab');
  }
};
