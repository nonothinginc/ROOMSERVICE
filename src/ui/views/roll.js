import { engine } from '../../audio/engine.js';
import { DRUM_VOICE_NAMES } from '../../devices/drum8.js';
import {
  ROOT_NOTES,
  SCALES,
  euclidean,
  generateRiff,
  getScaleNotesInRange,
  isMidiInScale,
  midiToName,
  snapMidiToScale
} from '../../state/scales.js';
import { nextId, store } from '../../state/store.js';
import { attachLongPress } from '../components/longpress.js';

const SNAP_OPTIONS = [
  { label: 'AUTO', val: 'AUTO' },
  { label: '1/64', val: 0.25 },
  { label: '1/32', val: 0.5 },
  { label: '1/16', val: 1 },
  { label: '1/8', val: 2 },
  { label: '1/4', val: 4 },
  { label: 'FREE', val: 0.125 }
];

const PAT_LENGTHS = [
  { steps: 4, label: '1B' },
  { steps: 8, label: '2B' },
  { steps: 16, label: '4B' },
  { steps: 32, label: '8B' },
  { steps: 64, label: '16B' }
];

const LANES = ['VEL', 'PROB', 'SLIDE', 'CUT'];
const RULER_H = 18;

export function createRollView() {
  const root = document.createElement('div');
  root.className = 'view-root';

  // Top context strip
  const strip = document.createElement('div');
  strip.className = 'ctx-strip';

  const trackChip = document.createElement('button');
  trackChip.className = 'ctx-chip solid';
  const openInstMenu = () => {
    const st = store.getState();
    st.detailOverlay = { type: 'inst-menu' };
    store.emit('overlay', st.detailOverlay);
  };
  trackChip.onclick = openInstMenu;
  attachLongPress(trackChip, openInstMenu);

  const scaleChip = document.createElement('button');
  scaleChip.className = 'ctx-chip';
  scaleChip.onclick = () => {
    const st = store.getState();
    st.scaleLock = !st.scaleLock;
    store.emit('roll-ctx');
  };

  const mpcChip = document.createElement('button');
  mpcChip.className = 'ctx-chip active';
  mpcChip.textContent = 'MPC';
  mpcChip.onclick = () => {
    const st = store.getState();
    st.detailOverlay = { type: 'mpc', trackId: st.selectedTrackId };
    store.emit('overlay', st.detailOverlay);
  };

  const lenChip = document.createElement('button');
  lenChip.className = 'ctx-chip';
  lenChip.title = 'Pattern Length (Beats / Steps)';
  lenChip.onclick = () => {
    const st = store.getState();
    const pat = st.patterns[st.activePatternId];
    if (!pat) return;
    const cycle = [16, 32, 64, 4, 8];
    const idx = cycle.indexOf(pat.length);
    const nextLen = cycle[(idx + 1) % cycle.length];
    store.pushHistory(`PAT LEN ${nextLen}`);
    pat.length = nextLen;
    if (zoomStepW != null && gridWrap.clientWidth > 0) {
      const kw = getKeyWidth();
      zoomStepW = Math.max(16, Math.min(148, (gridWrap.clientWidth - kw) / Math.min(nextLen, 16)));
      stepW = zoomStepW;
      scrollX = 0;
    }
    store.emit('notes');
    store.emit('roll-ctx');
  };

  const snapChip = document.createElement('button');
  snapChip.className = 'ctx-chip';
  snapChip.title = 'Grid Snap (AUTO adapts to pinch zoom)';
  snapChip.onclick = () => {
    const st = store.getState();
    const curKey = st.gridSnapAuto ? 'AUTO' : st.gridSnap;
    const idx = SNAP_OPTIONS.findIndex((o) => o.val === curKey);
    const next = SNAP_OPTIONS[(idx + 1) % SNAP_OPTIONS.length];
    if (next.val === 'AUTO') {
      st.gridSnapAuto = true;
    } else {
      st.gridSnapAuto = false;
      st.gridSnap = next.val;
    }
    store.emit('roll-ctx');
  };

  const laneChip = document.createElement('button');
  laneChip.className = 'ctx-chip';
  laneChip.onclick = () => {
    const st = store.getState();
    st.rollLaneOpen = !st.rollLaneOpen;
    store.emit('roll-lane', st.rollLane);
  };

  const rndChip = document.createElement('button');
  rndChip.className = 'ctx-chip';
  rndChip.textContent = 'RIFF';
  rndChip.onclick = () => {
    const st = store.getState();
    st.randomizerOpen = !st.randomizerOpen;
    store.emit('randomizer', st.randomizerOpen);
  };

  const patSwingChip = document.createElement('div');
  patSwingChip.className = 'hdr-num';
  patSwingChip.innerHTML = `<span class="lbl">SWG</span><span class="val">0%</span>`;
  patSwingChip.title = 'Drag up/down for Pattern Swing';
  let swgDrag = null;
  patSwingChip.addEventListener('pointerdown', (e) => {
    engine.unlock();
    const st = store.getState();
    const pat = st.patterns[st.activePatternId];
    swgDrag = { startY: e.clientY, startVal: pat?.swing || 0, pid: st.activePatternId };
    store.beginGesture(`${st.activePatternId} SWING`);
    patSwingChip.setPointerCapture(e.pointerId);
  });
  patSwingChip.addEventListener('pointermove', (e) => {
    if (!swgDrag) return;
    const dy = Math.round((swgDrag.startY - e.clientY) / 3);
    store.setPatternSwing(swgDrag.pid, swgDrag.startVal + dy);
  });
  const endSwgDrag = () => {
    if (swgDrag) {
      swgDrag = null;
      store.commitGesture();
    }
  };
  patSwingChip.addEventListener('pointerup', endSwgDrag);
  patSwingChip.addEventListener('pointercancel', endSwgDrag);

  const menuChip = document.createElement('button');
  menuChip.className = 'ctx-chip';
  menuChip.textContent = '⋯';
  menuChip.onclick = () => {
    const st = store.getState();
    st.detailOverlay = { type: 'roll' };
    store.emit('overlay', st.detailOverlay);
  };

  strip.append(
    trackChip,
    mpcChip,
    scaleChip,
    Object.assign(document.createElement('div'), { className: 'ctx-spacer' }),
    lenChip,
    snapChip,
    patSwingChip,
    laneChip,
    rndChip,
    menuChip
  );

  // Main Grid Canvas
  const gridWrap = document.createElement('div');
  gridWrap.className = 'canvas-wrap';
  const gridCanvas = document.createElement('canvas');
  gridWrap.appendChild(gridCanvas);
  const gridCtx = gridCanvas.getContext('2d');

  // Horizontal Scrollbar Rail
  const scrollRail = document.createElement('div');
  scrollRail.className = 'arr-scroll-rail roll-scroll-rail';
  const scrollThumb = document.createElement('div');
  scrollThumb.className = 'arr-scroll-thumb';
  scrollRail.appendChild(scrollThumb);

  // Bottom Lane (hidden by default for minimal clutter)
  const laneStrip = document.createElement('div');
  laneStrip.className = 'lane-strip';
  laneStrip.style.display = store.getState().rollLaneOpen ? 'flex' : 'none';

  const laneTabs = document.createElement('div');
  laneTabs.className = 'lane-tabs';
  const laneButtons = LANES.map((lane) => {
    const btn = document.createElement('button');
    btn.className = 'lane-tab';
    btn.textContent = lane;
    btn.onclick = () => {
      store.getState().rollLane = lane;
      store.emit('roll-lane', lane);
    };
    laneTabs.appendChild(btn);
    return { lane, btn };
  });

  const hideLaneBtn = document.createElement('button');
  hideLaneBtn.className = 'lane-tab';
  hideLaneBtn.textContent = '×';
  hideLaneBtn.title = 'Hide Lane';
  hideLaneBtn.onclick = () => {
    store.getState().rollLaneOpen = false;
    store.emit('roll-lane', store.getState().rollLane);
  };
  laneTabs.appendChild(hideLaneBtn);

  const laneWrap = document.createElement('div');
  laneWrap.className = 'canvas-wrap';
  const laneCanvas = document.createElement('canvas');
  laneWrap.appendChild(laneCanvas);
  const laneCtx = laneCanvas.getContext('2d');

  laneStrip.append(laneTabs, laneWrap);
  root.append(strip, gridWrap, scrollRail, laneStrip);

  // Viewport & zoom state
  let zoomStepW = null;
  let stepW = 46;
  let rowH = 26;
  let scrollX = 0; // in steps
  let topMidi = 58; // highest visible midi note
  let cursorStep = 0;
  let cursorMidi = 48;
  let selectedIds = new Set();

  // Multi-touch pinch state
  const activePointers = new Map();
  let pinchState = null;
  let wasPinching = false;

  function isDrumTrack() {
    const st = store.getState();
    const tr = st.tracks[st.selectedTrackId];
    return tr?.inserts[0]?.deviceId === 'drum8';
  }

  function getKeyWidth() {
    return isDrumTrack() ? 86 : 54;
  }

  function getEffectiveSnap() {
    const st = store.getState();
    if (st.gridSnapAuto) {
      if (stepW >= 82) return 0.25; // 1/64
      if (stepW >= 48) return 0.5;  // 1/32
      return 1;                     // 1/16
    }
    return st.gridSnap || 1;
  }

  function getMaxScrollX(w, patLen, kw) {
    const visSteps = Math.max(2, (w - kw) / Math.max(12, stepW));
    return Math.max(0, patLen - visSteps);
  }

  let lastRollRailKey = '';
  function updateRollScrollRail(w, patLen, kw) {
    const visSteps = Math.max(2, (w - kw) / Math.max(12, stepW));
    const maxS = Math.max(0, patLen - visSteps);
    const key = `${Math.round(w)}:${patLen}:${Math.round(stepW)}:${Math.round(scrollX * 10)}`;
    if (key === lastRollRailKey) return;
    lastRollRailKey = key;

    if (maxS <= 0.1) {
      scrollRail.style.display = 'none';
      return;
    }
    scrollRail.style.display = 'block';
    scrollX = Math.max(0, Math.min(maxS, scrollX));
    const thumbPct = Math.max(12, Math.min(100, (visSteps / patLen) * 100));
    const leftPct = (scrollX / maxS) * (100 - thumbPct);
    scrollThumb.style.width = `${thumbPct}%`;
    scrollThumb.style.left = `${leftPct}%`;
  }

  let railDrag = null;
  scrollRail.addEventListener('pointerdown', (e) => {
    const st = store.getState();
    const patLen = st.patterns[st.activePatternId]?.length || 16;
    const w = gridWrap.clientWidth || 640;
    const kw = getKeyWidth();
    const maxS = getMaxScrollX(w, patLen, kw);
    const rect = scrollRail.getBoundingClientRect();
    scrollRail.classList.add('active');
    const norm = Math.max(0, Math.min(1, (e.clientX - rect.left) / Math.max(1, rect.width)));
    scrollX = norm * maxS;
    railDrag = { startX: e.clientX, startScroll: scrollX, maxS, patLen, railW: Math.max(1, rect.width) };
    scrollRail.setPointerCapture(e.pointerId);
  });
  scrollRail.addEventListener('pointermove', (e) => {
    if (!railDrag) return;
    const dx = e.clientX - railDrag.startX;
    scrollX = Math.max(0, Math.min(railDrag.maxS, railDrag.startScroll + (dx / railDrag.railW) * railDrag.patLen));
  });
  const endRailDrag = () => {
    railDrag = null;
    scrollRail.classList.remove('active');
  };
  scrollRail.addEventListener('pointerup', endRailDrag);
  scrollRail.addEventListener('pointercancel', endRailDrag);

  function getDrumSources() {
    const st = store.getState();
    const sources = engine.getDrumSources(st.selectedTrackId);
    if (sources && sources.length > 0) return sources;
    return DRUM_VOICE_NAMES.map((name, index) => ({
      index,
      midi: 48 + index,
      label: `${String(index + 1).padStart(2, '0')} ${name}`
    }));
  }

  function getDrumLayout(gridHeight) {
    const sources = getDrumSources();
    const count = Math.max(1, sources.length);
    const availH = Math.max(60, gridHeight - RULER_H);
    const dRowH = Math.max(20, Math.min(52, Math.floor((availH - 12) / count)));
    const topY = RULER_H + Math.floor((availH - dRowH * count) / 2);
    return { sources, rowH: dRowH, topY };
  }

  // Long press for Roll detail overlay (only when single pointer not pinching/dragging)
  attachLongPress(
    gridWrap,
    () => {
      if (dragState?.moved || pinchState || activePointers.size > 1) return;
      const st = store.getState();
      st.detailOverlay = isDrumTrack() ? { type: 'mpc', trackId: st.selectedTrackId } : { type: 'roll' };
      store.emit('overlay', st.detailOverlay);
    },
    420,
    14
  );

  // Pointer interaction on piano roll
  let dragState = null;
  let lastNoteTap = { id: null, time: 0 };
  const DOUBLE_TAP_MS = 300;

  function resizeCanvases() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const gw = gridWrap.clientWidth;
    const gh = gridWrap.clientHeight;
    if (gw > 0 && gh > 0 && (gridCanvas.width !== gw * dpr || gridCanvas.height !== gh * dpr)) {
      gridCanvas.width = gw * dpr;
      gridCanvas.height = gh * dpr;
    }
    const lw = laneWrap.clientWidth;
    const lh = laneWrap.clientHeight;
    if (lw > 0 && lh > 0 && (laneCanvas.width !== lw * dpr || laneCanvas.height !== lh * dpr)) {
      laneCanvas.width = lw * dpr;
      laneCanvas.height = lh * dpr;
    }
  }

  function stepFromX(x) {
    return scrollX + (x - getKeyWidth()) / stepW;
  }

  function midiFromY(y, strict = false) {
    if (strict && y < RULER_H) return null;
    if (isDrumTrack()) {
      const layout = getDrumLayout(gridWrap.clientHeight);
      const idx = Math.floor((y - layout.topY) / layout.rowH);
      if (strict && (idx < 0 || idx >= layout.sources.length)) return null;
      const clamped = Math.max(0, Math.min(layout.sources.length - 1, idx));
      return layout.sources[clamped].midi;
    }
    return Math.floor(topMidi) - Math.floor((y - RULER_H) / rowH);
  }

  function stepWithHysteresis(currentIdx, targetPosInUnits, minIdx, maxIdx, deadband = 0.18) {
    let idx = currentIdx;
    while (targetPosInUnits < idx - deadband && idx > minIdx) idx--;
    while (targetPosInUnits > idx + 1 + deadband && idx < maxIdx) idx++;
    return Math.max(minIdx, Math.min(maxIdx, idx));
  }

  function getNoteRect(n, kw, drumLayout) {
    const x = kw + (n.step - scrollX) * stepW;
    const nw = Math.max(8, n.len * stepW);
    if (drumLayout) {
      const idx = drumLayout.sources.findIndex((s) => s.midi === Math.round(n.midi));
      if (idx === -1) return null;
      return { x, nw, y: drumLayout.topY + idx * drumLayout.rowH, rh: drumLayout.rowH };
    }
    return { x, nw, y: RULER_H + (Math.floor(topMidi) - n.midi) * rowH, rh: rowH };
  }

  function findNoteAt(notes, x, y) {
    if (y < RULER_H) return null;
    const kw = getKeyWidth();
    const drumLayout = isDrumTrack() ? getDrumLayout(gridWrap.clientHeight) : null;
    for (let i = notes.length - 1; i >= 0; i--) {
      const n = notes[i];
      const box = getNoteRect(n, kw, drumLayout);
      if (!box) continue;
      if (x >= box.x && x <= box.x + box.nw && y >= box.y && y <= box.y + box.rh) {
        const isResize = x >= box.x + box.nw - 10;
        return { note: n, isResize, box };
      }
    }
    return null;
  }

  function beginPinch(rect) {
    const pts = Array.from(activePointers.values());
    if (pts.length < 2) return;
    const p0 = pts[0];
    const p1 = pts[1];
    const dist = Math.max(16, Math.hypot(p1.x - p0.x, p1.y - p0.y));
    const midClientX = (p0.x + p1.x) * 0.5;
    const midClientY = (p0.y + p1.y) * 0.5;
    const localMidX = midClientX - rect.left;
    const kw = getKeyWidth();
    const anchorStep = scrollX + (localMidX - kw) / Math.max(12, stepW);

    dragState = null;
    store.commitGesture();
    wasPinching = true;
    pinchState = {
      startDist: dist,
      startStepW: stepW,
      startRowH: rowH,
      startMidX: midClientX,
      startMidY: midClientY,
      startTopMidi: topMidi,
      anchorStep,
      localMidX,
      w: rect.width
    };
  }

  gridCanvas.addEventListener('pointerdown', (e) => {
    engine.unlock();
    const rect = gridCanvas.getBoundingClientRect();
    activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (activePointers.size >= 2) {
      beginPinch(rect);
      return;
    }

    wasPinching = false;
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const st = store.getState();
    const kw = getKeyWidth();

    // Top Beat/Bar Ruler: tap to scrub playhead, drag to pan horizontally
    if (y < RULER_H && x >= kw) {
      dragState = {
        mode: 'ruler',
        startX: e.clientX,
        startScroll: scrollX,
        localX: x,
        kw,
        w: rect.width,
        moved: false
      };
      gridCanvas.setPointerCapture(e.pointerId);
      return;
    }

    // Piano / Drum key audition
    if (x < kw) {
      const m = midiFromY(y, true);
      if (m == null) return;
      engine.previewNote(st.selectedTrackId, m, 0.9, st.slideMode || e.shiftKey);
      if (!isDrumTrack()) {
        dragState = { mode: 'pan-y', startY: e.clientY, startTop: topMidi };
        gridCanvas.setPointerCapture(e.pointerId);
      }
      return;
    }

    const notes = store.getActiveNotes();
    const hit = findNoteAt(notes, x, y);

    if (hit) {
      if (e.button === 2 || e.altKey) {
        store.setActiveNotes(notes.filter((n) => n.id !== hit.note.id), undefined, undefined, 'DEL NOTE');
        selectedIds.delete(hit.note.id);
        return;
      }
      if (!selectedIds.has(hit.note.id)) {
        selectedIds = new Set([hit.note.id]);
      }
      cursorStep = hit.note.step;
      cursorMidi = hit.note.midi;
      store.beginGesture('EDIT NOTE');
      dragState = {
        mode: hit.isResize ? 'resize' : 'move',
        isNew: false,
        note: hit.note,
        startX: e.clientX,
        startY: e.clientY,
        grabOffsetY: y - hit.box.y,
        origStep: hit.note.step,
        origMidi: hit.note.midi,
        origLen: hit.note.len,
        moved: false
      };
      gridCanvas.setPointerCapture(e.pointerId);
      return;
    }

    lastNoteTap = { id: null, time: 0 };

    // Empty cell: draw new note at adaptive/selected snap
    let midi = midiFromY(y, true);
    if (midi == null) return;

    const snap = getEffectiveSnap();
    const patLen = st.patterns[st.activePatternId]?.length || 16;
    const rawStep = Math.floor(stepFromX(x) / snap) * snap;
    const step = Math.max(0, Math.min(patLen - snap, Number(rawStep.toFixed(4))));
    if (st.scaleLock && !isDrumTrack()) {
      midi = snapMidiToScale(midi, st.scaleRoot, st.scaleId);
    }

    store.beginGesture('DRAW NOTE');
    store.markGestureDirty();

    const newNote = {
      id: nextId('n'),
      step,
      len: snap,
      midi,
      vel: 104,
      prob: 100,
      slide: Boolean(st.slideMode || e.shiftKey),
      cutoff: 0
    };
    const updated = [...notes, newNote];
    store.setActiveNotes(updated);
    selectedIds = new Set([newNote.id]);
    cursorStep = step;
    cursorMidi = midi;
    engine.previewNote(st.selectedTrackId, midi, 0.85, newNote.slide);

    dragState = {
      mode: 'resize',
      isNew: true,
      note: newNote,
      startX: e.clientX,
      startY: e.clientY,
      origStep: step,
      origMidi: midi,
      origLen: snap,
      moved: false
    };
    gridCanvas.setPointerCapture(e.pointerId);
  });

  gridCanvas.addEventListener('pointermove', (e) => {
    if (activePointers.has(e.pointerId)) {
      activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    }

    if (pinchState && activePointers.size >= 2) {
      const pts = Array.from(activePointers.values());
      const p0 = pts[0];
      const p1 = pts[1];
      const dist = Math.max(16, Math.hypot(p1.x - p0.x, p1.y - p0.y));
      const midX = (p0.x + p1.x) * 0.5;
      const midY = (p0.y + p1.y) * 0.5;
      const rect = gridCanvas.getBoundingClientRect();
      const kw = getKeyWidth();
      const st = store.getState();
      const patLen = st.patterns[st.activePatternId]?.length || 16;

      const scale = dist / pinchState.startDist;
      const minStepW = Math.max(14, (rect.width - kw) / Math.max(16, patLen));
      zoomStepW = Math.max(minStepW, Math.min(148, pinchState.startStepW * scale));
      stepW = zoomStepW;

      // Keep anchor step directly under pinch midpoint & pan cleanly
      const localMidX = midX - rect.left;
      const maxS = getMaxScrollX(rect.width, patLen, kw);
      scrollX = Math.max(0, Math.min(maxS, pinchState.anchorStep - (localMidX - kw) / stepW));

      if (!isDrumTrack()) {
        const dy = midY - pinchState.startMidY;
        topMidi = Math.max(36, Math.min(96, pinchState.startTopMidi + Math.round(dy / rowH)));
      }
      syncStrip();
      return;
    }

    if (!dragState || wasPinching) return;
    const st = store.getState();
    const snap = getEffectiveSnap();
    const patLen = st.patterns[st.activePatternId]?.length || 16;

    if (dragState.mode === 'ruler') {
      const dx = e.clientX - dragState.startX;
      if (!dragState.moved && Math.abs(dx) > 5) dragState.moved = true;
      if (dragState.moved) {
        const maxS = getMaxScrollX(dragState.w, patLen, dragState.kw);
        scrollX = Math.max(0, Math.min(maxS, dragState.startScroll - dx / Math.max(12, stepW)));
      }
      return;
    }

    if (dragState.mode === 'pan-y') {
      const dy = Math.round((e.clientY - dragState.startY) / rowH);
      topMidi = Math.max(36, Math.min(96, dragState.startTop + dy));
      return;
    }

    const dx = e.clientX - dragState.startX;
    const dy = e.clientY - dragState.startY;
    if (!dragState.moved && Math.hypot(dx, dy) <= 6) return;
    dragState.moved = true;

    if (dragState.mode === 'resize') {
      const dSteps = Math.round(dx / stepW / snap) * snap;
      const nextLen = Math.max(snap, Math.min(patLen - dragState.note.step, Number((dragState.origLen + dSteps).toFixed(4))));
      if (Math.abs(nextLen - dragState.note.len) > 0.001) {
        dragState.note.len = nextLen;
        store.markGestureDirty();
        store.emit('notes');
      }
    } else if (dragState.mode === 'move') {
      const dSteps = Math.round(dx / stepW / snap) * snap;
      const nextStep = Math.max(0, Math.min(patLen - dragState.note.len, Number((dragState.origStep + dSteps).toFixed(4))));
      const rect = gridCanvas.getBoundingClientRect();
      const localY = e.clientY - rect.top;
      let nextMidi = dragState.note.midi;

      if (isDrumTrack()) {
        const layout = getDrumLayout(gridWrap.clientHeight);
        const curIdx = Math.max(0, layout.sources.findIndex((s) => s.midi === dragState.note.midi));
        const centerUnits = (localY - dragState.grabOffsetY + layout.rowH * 0.5 - layout.topY) / layout.rowH;
        const nextIdx = stepWithHysteresis(curIdx, centerUnits, 0, layout.sources.length - 1);
        nextMidi = layout.sources[nextIdx].midi;
      } else if (st.scaleLock) {
        const scalePool = getScaleNotesInRange(st.scaleRoot, st.scaleId, 24, 96);
        if (scalePool.length > 0) {
          let origScaleIdx = scalePool.findIndex((m) => m >= dragState.origMidi);
          if (origScaleIdx === -1) origScaleIdx = scalePool.length - 1;
          let curScaleIdx = scalePool.findIndex((m) => m >= dragState.note.midi);
          if (curScaleIdx === -1) curScaleIdx = scalePool.length - 1;
          const virtualRow = origScaleIdx - (e.clientY - dragState.startY) / rowH;
          const nextScaleIdx = stepWithHysteresis(curScaleIdx, virtualRow, 0, scalePool.length - 1);
          nextMidi = scalePool[nextScaleIdx];
        }
      } else {
        const topInt = Math.floor(topMidi);
        const curRowIdx = topInt - dragState.note.midi;
        const centerUnits = (localY - RULER_H - dragState.grabOffsetY + rowH * 0.5) / rowH;
        const nextRowIdx = stepWithHysteresis(curRowIdx, centerUnits, topInt - 96, topInt - 24);
        nextMidi = Math.max(24, Math.min(96, topInt - nextRowIdx));
      }

      if (Math.abs(nextStep - dragState.note.step) > 0.001 || nextMidi !== dragState.note.midi) {
        dragState.note.step = nextStep;
        cursorStep = nextStep;
        if (nextMidi !== dragState.note.midi) {
          dragState.note.midi = nextMidi;
          cursorMidi = nextMidi;
          engine.previewNote(st.selectedTrackId, nextMidi, 0.75, dragState.note.slide);
        }
        store.markGestureDirty();
        store.emit('notes');
      }
    }
  });

  gridCanvas.addEventListener('pointerup', (e) => {
    activePointers.delete(e.pointerId);
    if (pinchState) {
      if (activePointers.size < 2) {
        pinchState = null;
      }
      if (activePointers.size === 0) {
        wasPinching = false;
      }
      dragState = null;
      return;
    }
    if (wasPinching) {
      if (activePointers.size === 0) wasPinching = false;
      dragState = null;
      return;
    }

    const finished = dragState;
    dragState = null;

    if (finished?.mode === 'ruler') {
      if (!finished.moved) {
        const st = store.getState();
        const patLen = st.patterns[st.activePatternId]?.length || 16;
        const target = Math.max(0, Math.min(patLen - 1, Math.floor(scrollX + (finished.localX - finished.kw) / stepW)));
        st.currentStep = target;
        store.emit('step', target);
      }
      return;
    }

    if (finished && !finished.isNew && !finished.moved && finished.note) {
      const now = performance.now();
      if (lastNoteTap.id === finished.note.id && now - lastNoteTap.time <= DOUBLE_TAP_MS) {
        lastNoteTap = { id: null, time: 0 };
        store.commitGesture();
        const notes = store.getActiveNotes();
        store.setActiveNotes(
          notes.filter((n) => n.id !== finished.note.id),
          undefined,
          undefined,
          'DEL NOTE'
        );
        selectedIds.delete(finished.note.id);
        return;
      }
      lastNoteTap = { id: finished.note.id, time: now };
      if (finished.mode === 'move' && (e.shiftKey || store.getState().slideMode)) {
        finished.note.slide = !finished.note.slide;
        store.markGestureDirty();
        store.emit('notes');
      }
    } else if (finished?.moved) {
      lastNoteTap = { id: null, time: 0 };
    }
    store.commitGesture();
  });

  gridCanvas.addEventListener('pointercancel', (e) => {
    activePointers.delete(e.pointerId);
    if (activePointers.size < 2) pinchState = null;
    if (activePointers.size === 0) wasPinching = false;
    store.commitGesture();
    dragState = null;
  });

  gridCanvas.addEventListener('contextmenu', (e) => e.preventDefault());

  gridCanvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const st = store.getState();
      const patLen = st.patterns[st.activePatternId]?.length || 16;
      const kw = getKeyWidth();
      const w = gridWrap.clientWidth || 640;
      if (e.ctrlKey || e.metaKey) {
        const minStepW = Math.max(14, (w - kw) / Math.max(16, patLen));
        const rect = gridCanvas.getBoundingClientRect();
        const localX = e.clientX - rect.left;
        const anchorStep = scrollX + (localX - kw) / stepW;
        zoomStepW = Math.max(minStepW, Math.min(148, stepW - e.deltaY * 0.14));
        stepW = zoomStepW;
        const maxS = getMaxScrollX(w, patLen, kw);
        scrollX = Math.max(0, Math.min(maxS, anchorStep - (localX - kw) / stepW));
        syncStrip();
      } else {
        const maxS = getMaxScrollX(w, patLen, kw);
        scrollX = Math.max(0, Math.min(maxS, scrollX + e.deltaX / Math.max(12, stepW)));
        if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
          topMidi = Math.max(36, Math.min(96, topMidi - Math.sign(e.deltaY)));
        }
      }
    },
    { passive: false }
  );

  // Bottom Lane pointer edit
  let laneDragging = false;
  function editLaneAt(clientX, clientY) {
    const rect = laneCanvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const st = store.getState();
    const stepAtPointer = scrollX + x / stepW;
    const norm = Math.max(0, Math.min(1, 1 - y / rect.height));
    const notes = store.getActiveNotes();

    let target = notes.find((n) => stepAtPointer >= n.step - 0.25 && stepAtPointer <= n.step + Math.max(0.75, n.len));
    if (!target) return;

    if (st.rollLane === 'VEL') {
      target.vel = Math.max(15, Math.min(127, Math.round(norm * 127)));
    } else if (st.rollLane === 'PROB') {
      target.prob = Math.max(0, Math.min(100, Math.round(norm * 100)));
    } else if (st.rollLane === 'SLIDE') {
      target.slide = norm > 0.5;
    } else if (st.rollLane === 'CUT') {
      target.cutoff = Number(((norm - 0.5) * 2).toFixed(2));
    }
    store.markGestureDirty();
    store.emit('notes');
  }

  laneCanvas.addEventListener('pointerdown', (e) => {
    laneDragging = true;
    store.beginGesture(`EDIT ${store.getState().rollLane}`);
    editLaneAt(e.clientX, e.clientY);
    laneCanvas.setPointerCapture(e.pointerId);
  });
  laneCanvas.addEventListener('pointermove', (e) => {
    if (laneDragging) editLaneAt(e.clientX, e.clientY);
  });
  laneCanvas.addEventListener('pointerup', () => {
    if (laneDragging) {
      laneDragging = false;
      store.commitGesture();
    }
  });
  laneCanvas.addEventListener('pointercancel', () => {
    if (laneDragging) {
      laneDragging = false;
      store.commitGesture();
    }
  });

  function formatSnapChipText(st) {
    if (st.gridSnapAuto) {
      const eff = getEffectiveSnap();
      const lbl = eff === 0.25 ? '64' : eff === 0.5 ? '32' : '16';
      return `A·1/${lbl}`;
    }
    const opt = SNAP_OPTIONS.find((o) => o.val === st.gridSnap);
    return opt ? opt.label : '1/16';
  }

  function syncStrip() {
    const st = store.getState();
    const tr = st.tracks[st.selectedTrackId];
    const pat = st.patterns[st.activePatternId];
    const patLen = pat?.length || 16;
    const drumMode = isDrumTrack();
    trackChip.textContent = `${tr.code} ${tr.name} ▾`;

    mpcChip.style.display = drumMode ? 'inline-flex' : 'none';
    scaleChip.style.display = drumMode ? 'none' : 'inline-flex';

    if (drumMode) {
      const sources = getDrumSources();
      if (!sources.some((s) => s.midi === cursorMidi)) {
        cursorMidi = sources[0]?.midi ?? 48;
      }
    }

    const lenMeta = PAT_LENGTHS.find((l) => l.steps === patLen);
    lenChip.textContent = lenMeta ? lenMeta.label : `${patLen}S`;
    lenChip.classList.toggle('active', patLen !== 16);

    snapChip.textContent = formatSnapChipText(st);
    snapChip.classList.toggle('active', !st.gridSnapAuto || getEffectiveSnap() < 1);

    scaleChip.textContent = `${ROOT_NOTES[st.scaleRoot]} ${st.scaleId}`;
    scaleChip.classList.toggle('active', st.scaleLock);
    const patSwingVal = pat?.swing || 0;
    patSwingChip.querySelector('.val').textContent = `${patSwingVal}%`;
    patSwingChip.classList.toggle('active', patSwingVal > 0);
    laneChip.textContent = st.rollLaneOpen ? `LANE: ${st.rollLane}` : 'LANE';
    laneChip.classList.toggle('active', st.rollLaneOpen);
    laneStrip.style.display = st.rollLaneOpen ? 'flex' : 'none';
    rndChip.classList.toggle('active', st.randomizerOpen);

    for (const lb of laneButtons) {
      lb.btn.classList.toggle('active', st.rollLane === lb.lane);
    }
  }

  store.subscribe(syncStrip);
  syncStrip();

  function handleAction(action) {
    const st = store.getState();
    if (st.view !== 'ROLL' || st.detailOverlay || st.randomizerOpen) return;

    const pat = st.patterns[st.activePatternId];
    const patLen = pat?.length || 16;
    const notes = store.getActiveNotes();
    const snap = getEffectiveSnap();

    if (action.type === 'DPAD') {
      if (action.dir === 'LEFT') cursorStep = Math.max(0, cursorStep - snap);
      if (action.dir === 'RIGHT') cursorStep = Math.min(patLen - snap, cursorStep + snap);
      if (isDrumTrack()) {
        const sources = getDrumSources();
        const idx = Math.max(0, sources.findIndex((s) => s.midi === cursorMidi));
        if (action.dir === 'UP') cursorMidi = sources[Math.max(0, idx - 1)].midi;
        if (action.dir === 'DOWN') cursorMidi = sources[Math.min(sources.length - 1, idx + 1)].midi;
      } else {
        if (action.dir === 'UP') cursorMidi = Math.min(96, cursorMidi + 1);
        if (action.dir === 'DOWN') cursorMidi = Math.max(24, cursorMidi - 1);
        if (cursorMidi > topMidi - 1) topMidi = cursorMidi + 1;
        if (cursorMidi < topMidi - 14) topMidi = cursorMidi + 14;
      }
    } else if (action.type === 'A_TAP') {
      const existing = notes.find((n) => Math.abs(n.step - cursorStep) < 0.08 && n.midi === cursorMidi);
      if (existing) {
        if (action.l2 || st.slideMode) {
          store.pushHistory('SLIDE NOTE');
          existing.slide = !existing.slide;
          store.emit('notes');
        } else {
          selectedIds = new Set([existing.id]);
        }
      } else {
        const m = st.scaleLock && !isDrumTrack() ? snapMidiToScale(cursorMidi, st.scaleRoot, st.scaleId) : cursorMidi;
        const nn = {
          id: nextId('n'),
          step: cursorStep,
          len: snap,
          midi: m,
          vel: 106,
          prob: 100,
          slide: Boolean(action.l2 || st.slideMode),
          cutoff: 0
        };
        store.setActiveNotes([...notes, nn], undefined, undefined, 'DRAW NOTE');
        selectedIds = new Set([nn.id]);
        engine.previewNote(st.selectedTrackId, m, 0.85, nn.slide);
      }
    } else if (action.type === 'A_HOLD') {
      st.detailOverlay = { type: 'roll' };
      store.emit('overlay', st.detailOverlay);
    } else if (action.type === 'B') {
      const filtered = notes.filter((n) => !selectedIds.has(n.id) && !(Math.abs(n.step - cursorStep) < 0.08 && n.midi === cursorMidi));
      if (filtered.length !== notes.length) {
        store.setActiveNotes(filtered, undefined, undefined, 'DEL NOTE');
      }
      selectedIds.clear();
    } else if (action.type === 'X') {
      st.randomizerOpen = !st.randomizerOpen;
      store.emit('randomizer', st.randomizerOpen);
    } else if (action.type === 'Y') {
      if (!st.rollLaneOpen) {
        st.rollLaneOpen = true;
        st.rollLane = LANES[0];
      } else {
        const idx = LANES.indexOf(st.rollLane);
        if (idx === LANES.length - 1) {
          st.rollLaneOpen = false;
        } else {
          st.rollLane = LANES[idx + 1];
        }
      }
      store.emit('roll-lane', st.rollLane);
    } else if (action.type === 'STICKS') {
      const maxS = getMaxScrollX(gridWrap.clientWidth || 640, patLen, getKeyWidth());
      if (action.lx) scrollX = Math.max(0, Math.min(maxS, scrollX + action.lx * 0.4));
      if (action.ly) topMidi = Math.max(36, Math.min(96, topMidi - action.ly * 0.4));
      if (selectedIds.size > 0 && (action.rx || action.ry)) {
        store.pushHistoryCoalesced('roll-stick', 'EDIT NOTE');
        for (const n of notes) {
          if (!selectedIds.has(n.id)) continue;
          if (action.rx) n.len = Math.max(0.25, Math.min(16, n.len + action.rx * 0.1));
          if (action.ry) n.vel = Math.max(15, Math.min(127, Math.round(n.vel - action.ry * 3)));
        }
        store.emit('notes');
      }
    }
  }

  function tick() {
    resizeCanvases();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const st = store.getState();
    const styles = getComputedStyle(document.documentElement);
    const bg = styles.getPropertyValue('--bg').trim();
    const surface = styles.getPropertyValue('--surface').trim();
    const border = styles.getPropertyValue('--border').trim();
    const borderStrong = styles.getPropertyValue('--border-strong').trim();
    const ink = styles.getPropertyValue('--ink').trim();
    const inkDim = styles.getPropertyValue('--ink-dim').trim();
    const inkFaint = styles.getPropertyValue('--ink-faint').trim();
    const accent = styles.getPropertyValue('--accent').trim();
    const gridSub = styles.getPropertyValue('--grid-sub').trim();
    const gridBeat = styles.getPropertyValue('--grid-beat').trim();

    const w = gridCanvas.width / dpr;
    const h = gridCanvas.height / dpr;
    const pat = st.patterns[st.activePatternId];
    const patLen = pat?.length || 16;
    const drumMode = isDrumTrack();
    const kw = getKeyWidth();

    if (zoomStepW == null && w > kw + 20) {
      zoomStepW = Math.max(20, (w - kw) / Math.min(patLen, 16));
    }
    const minStepW = Math.max(14, (w - kw) / Math.max(16, patLen));
    stepW = Math.max(minStepW, Math.min(148, zoomStepW || 40));
    const maxS = getMaxScrollX(w, patLen, kw);
    scrollX = Math.max(0, Math.min(maxS, scrollX));
    updateRollScrollRail(w, patLen, kw);

    gridCtx.save();
    gridCtx.scale(dpr, dpr);
    gridCtx.fillStyle = bg;
    gridCtx.fillRect(0, 0, w, h);

    // Top 18px Beat/Bar Ruler
    gridCtx.fillStyle = surface;
    gridCtx.fillRect(0, 0, w, RULER_H);
    gridCtx.strokeStyle = border;
    gridCtx.lineWidth = 1;
    gridCtx.beginPath();
    gridCtx.moveTo(0, RULER_H + 0.5);
    gridCtx.lineTo(w, RULER_H + 0.5);
    gridCtx.stroke();

    gridCtx.fillStyle = inkDim;
    gridCtx.font = '700 8.5px Geist Mono, monospace';
    gridCtx.fillText(`${pat?.length || 16}S`, 6, 12.5);

    for (let s = 0; s < patLen; s += 4) {
      const rx = Math.round(kw + (s - scrollX) * stepW);
      if (rx < kw - 24 || rx > w) continue;
      const bar = Math.floor(s / 16) + 1;
      const beat = Math.floor((s % 16) / 4) + 1;
      gridCtx.fillStyle = beat === 1 ? ink : inkDim;
      gridCtx.fillText(`${bar}.${beat}`, Math.max(kw + 2, rx + 3), 12.5);
    }

    const drumLayout = drumMode ? getDrumLayout(h) : null;
    const flashMap = drumMode ? engine.getDrumNode(st.selectedTrackId)?.getPadInfo?.()?.padFlashAt : null;
    const now = performance.now();

    const drawVerticalGridLines = (topY, botY) => {
      for (let s = 0; s <= patLen; s++) {
        const x = Math.round(kw + (s - scrollX) * stepW) + 0.5;
        if (x >= kw && x <= w) {
          gridCtx.strokeStyle = s % 16 === 0 ? borderStrong : s % 4 === 0 ? gridBeat : gridSub;
          gridCtx.lineWidth = 1;
          gridCtx.beginPath();
          gridCtx.moveTo(x, s % 4 === 0 ? 4 : topY);
          gridCtx.lineTo(x, botY);
          gridCtx.stroke();
        }
        if (s < patLen && stepW >= 48) {
          const halfX = Math.round(kw + (s + 0.5 - scrollX) * stepW) + 0.5;
          if (halfX >= kw && halfX <= w) {
            gridCtx.save();
            gridCtx.setLineDash([2, 3]);
            gridCtx.strokeStyle = gridSub;
            gridCtx.beginPath();
            gridCtx.moveTo(halfX, topY);
            gridCtx.lineTo(halfX, botY);
            gridCtx.stroke();
            gridCtx.restore();
          }
        }
        if (s < patLen && stepW >= 82) {
          for (const q of [0.25, 0.75]) {
            const qx = Math.round(kw + (s + q - scrollX) * stepW) + 0.5;
            if (qx >= kw && qx <= w) {
              gridCtx.save();
              gridCtx.setLineDash([1, 3]);
              gridCtx.strokeStyle = gridSub;
              gridCtx.beginPath();
              gridCtx.moveTo(qx, topY);
              gridCtx.lineTo(qx, botY);
              gridCtx.stroke();
              gridCtx.restore();
            }
          }
        }
      }
    };

    if (drumLayout) {
      const { sources, rowH: dRowH, topY } = drumLayout;
      const blockH = sources.length * dRowH;

      sources.forEach((src, r) => {
        const y = topY + r * dRowH;
        if (r % 2 === 0) {
          gridCtx.fillStyle = gridSub;
          gridCtx.fillRect(kw, y, w - kw, dRowH);
        }
        gridCtx.strokeStyle = border;
        gridCtx.lineWidth = 1;
        gridCtx.beginPath();
        gridCtx.moveTo(kw, y + 0.5);
        gridCtx.lineTo(w, y + 0.5);
        gridCtx.stroke();

        const hitFlash = flashMap && now - (flashMap[src.index] || 0) < 120;
        gridCtx.fillStyle = surface;
        gridCtx.fillRect(0, y, kw - 1, dRowH - 1);
        gridCtx.strokeStyle = hitFlash ? accent : border;
        gridCtx.strokeRect(0.5, y + 0.5, kw - 1, dRowH - 1);

        gridCtx.save();
        gridCtx.beginPath();
        gridCtx.rect(2, y, kw - 6, dRowH);
        gridCtx.clip();
        gridCtx.fillStyle = hitFlash ? accent : ink;
        gridCtx.font = '700 9px Geist Mono, monospace';
        gridCtx.fillText(src.label, 6, y + dRowH / 2 + 3);
        gridCtx.restore();
      });

      gridCtx.strokeStyle = borderStrong;
      gridCtx.beginPath();
      gridCtx.moveTo(0, topY + 0.5);
      gridCtx.lineTo(w, topY + 0.5);
      gridCtx.moveTo(0, topY + blockH + 0.5);
      gridCtx.lineTo(w, topY + blockH + 0.5);
      gridCtx.stroke();

      drawVerticalGridLines(topY, topY + blockH);
    } else {
      const rows = Math.ceil((h - RULER_H) / rowH);
      const draggedMidi = dragState?.note ? Math.round(dragState.note.midi) : null;
      for (let r = 0; r < rows; r++) {
        const midi = Math.floor(topMidi) - r;
        const y = RULER_H + r * rowH;
        const pc = ((midi % 12) + 12) % 12;
        const isBlackKey = [1, 3, 6, 8, 10].includes(pc);
        const inScale = isMidiInScale(midi, st.scaleRoot, st.scaleId);
        const isActiveRow = draggedMidi === midi;

        if (inScale) {
          gridCtx.fillStyle = gridSub;
          gridCtx.fillRect(kw, y, w - kw, rowH);
        }
        gridCtx.strokeStyle = border;
        gridCtx.lineWidth = 1;
        gridCtx.beginPath();
        gridCtx.moveTo(kw, y + 0.5);
        gridCtx.lineTo(w, y + 0.5);
        gridCtx.stroke();

        gridCtx.fillStyle = isActiveRow ? accent : isBlackKey ? bg : surface;
        gridCtx.fillRect(0, y, kw - 1, rowH - 1);
        gridCtx.strokeStyle = isActiveRow ? accent : border;
        gridCtx.strokeRect(0.5, y + 0.5, kw - 1, rowH - 1);

        if (isActiveRow || pc === 0 || midi === Math.round(cursorMidi)) {
          gridCtx.fillStyle = isActiveRow ? '#F2F0EC' : pc === 0 ? ink : inkDim;
          gridCtx.font = '600 10px Geist Mono, monospace';
          gridCtx.fillText(midiToName(midi), 6, y + rowH / 2 + 3);
        }
      }

      drawVerticalGridLines(RULER_H, h);
    }

    // Ghost notes from ghostPatternId
    if (st.ghostPatternId && st.patterns[st.ghostPatternId]) {
      const gPat = st.patterns[st.ghostPatternId];
      gridCtx.save();
      gridCtx.setLineDash([3, 3]);
      gridCtx.strokeStyle = inkFaint;
      gridCtx.lineWidth = 1;
      for (const gList of Object.values(gPat.notesByTrack)) {
        for (const gn of gList) {
          const box = getNoteRect(gn, kw, drumLayout);
          if (!box || box.y < RULER_H - box.rh || box.y > h) continue;
          gridCtx.strokeRect(box.x + 1, box.y + 2, Math.max(6, box.nw - 2), box.rh - 4);
        }
      }
      gridCtx.restore();
    }

    // Active notes
    const notes = store.getActiveNotes();
    for (const n of notes) {
      const box = getNoteRect(n, kw, drumLayout);
      if (!box || box.y < RULER_H - box.rh || box.y > h) continue;

      const x = box.x;
      const nw = Math.max(8, box.nw - 2);
      const y = box.y + 1;
      const nh = box.rh - 3;

      const isSel = selectedIds.has(n.id);
      const alpha = 0.45 + ((n.vel || 100) / 127) * 0.55;

      gridCtx.globalAlpha = alpha;
      gridCtx.fillStyle = n.slide ? accent : ink;
      gridCtx.beginPath();
      gridCtx.roundRect(x + 1, y + 1, nw, nh, 3);
      gridCtx.fill();
      gridCtx.globalAlpha = 1;

      if (isSel) {
        gridCtx.strokeStyle = accent;
        gridCtx.lineWidth = 1.5;
        gridCtx.beginPath();
        gridCtx.roundRect(x + 0.5, y + 0.5, nw + 1, nh + 1, 3);
        gridCtx.stroke();
      }

      if (n.slide && !drumMode) {
        gridCtx.fillStyle = '#F2F0EC';
        gridCtx.font = '700 9px Geist Mono, monospace';
        gridCtx.fillText('↗', x + nw - 11, y + nh - 2);
      }
    }

    // D-Pad Cursor
    const curBox = getNoteRect({ step: cursorStep, len: getEffectiveSnap(), midi: cursorMidi }, kw, drumLayout);
    if (curBox && curBox.y >= RULER_H) {
      gridCtx.strokeStyle = borderStrong;
      gridCtx.lineWidth = 1;
      gridCtx.strokeRect(curBox.x + 0.5, curBox.y + 0.5, Math.max(8, curBox.nw) - 1, curBox.rh - 1);
    }

    // Playhead
    const playStep = st.currentStep % patLen;
    const px = kw + (playStep - scrollX) * stepW;
    if (px >= kw && px <= w) {
      const topY = drumLayout ? drumLayout.topY : RULER_H;
      const botY = drumLayout ? drumLayout.topY + drumLayout.sources.length * drumLayout.rowH : h;
      gridCtx.strokeStyle = accent;
      gridCtx.lineWidth = 1.5;
      gridCtx.beginPath();
      gridCtx.moveTo(px, 0);
      gridCtx.lineTo(px, botY);
      gridCtx.stroke();

      gridCtx.fillStyle = accent;
      gridCtx.beginPath();
      gridCtx.moveTo(px - 4, 0);
      gridCtx.lineTo(px + 4, 0);
      gridCtx.lineTo(px, 6);
      gridCtx.closePath();
      gridCtx.fill();
      if (topY > RULER_H) {
        gridCtx.fillRect(px - 0.5, RULER_H, 1, topY - RULER_H);
      }
    }

    gridCtx.restore();

    // Bottom Contextual Lane
    const lw = laneCanvas.width / dpr;
    const lh = laneCanvas.height / dpr;
    laneCtx.save();
    laneCtx.scale(dpr, dpr);
    laneCtx.fillStyle = surface;
    laneCtx.fillRect(0, 0, lw, lh);

    for (let s = 0; s <= patLen; s++) {
      const x = Math.round((s - scrollX) * stepW) + 0.5;
      if (x < 0 || x > lw) continue;
      laneCtx.strokeStyle = s % 4 === 0 ? gridBeat : gridSub;
      laneCtx.beginPath();
      laneCtx.moveTo(x, 0);
      laneCtx.lineTo(x, lh);
      laneCtx.stroke();
    }

    for (const n of notes) {
      const x = (n.step - scrollX) * stepW;
      const bw = Math.max(8, Math.min(18, stepW * 0.45));
      if (x + bw < 0 || x > lw) continue;

      let norm = 0.5;
      let label = '';
      if (st.rollLane === 'VEL') {
        norm = (n.vel || 100) / 127;
        label = String(n.vel);
      } else if (st.rollLane === 'PROB') {
        norm = (n.prob ?? 100) / 100;
        label = `${n.prob ?? 100}%`;
      } else if (st.rollLane === 'SLIDE') {
        norm = n.slide ? 0.9 : 0.15;
        label = n.slide ? 'SLD' : '---';
      } else if (st.rollLane === 'CUT') {
        norm = ((n.cutoff || 0) + 1) * 0.5;
        label = `${n.cutoff >= 0 ? '+' : ''}${Math.round((n.cutoff || 0) * 100)}`;
      }

      const barH = Math.max(4, norm * (lh - 18));
      laneCtx.fillStyle = n.slide || (st.rollLane === 'PROB' && (n.prob ?? 100) < 100) ? accent : ink;
      laneCtx.fillRect(x + 2, lh - barH - 2, bw, barH);
      laneCtx.fillStyle = inkDim;
      laneCtx.font = '600 8px Geist Mono, monospace';
      laneCtx.fillText(label, x + 2, 10);
    }

    laneCtx.restore();
  }

  function renderRandomizerModal(modalEl) {
    const st = store.getState();
    const r = st.randomizer;

    const hdr = document.createElement('div');
    hdr.className = 'overlay-hdr';
    hdr.innerHTML = `<span>RIFF MACHINE // EUCLIDEAN + SCALE</span>`;
    const close = document.createElement('button');
    close.className = 'ctx-chip';
    close.textContent = 'CLOSE [B]';
    close.onclick = () => {
      st.randomizerOpen = false;
      store.emit('randomizer', false);
    };
    hdr.appendChild(close);

    const body = document.createElement('div');
    body.className = 'overlay-body';

    const euclidWrap = document.createElement('div');
    euclidWrap.className = 'euclid-leds';

    function updateEuclidPreview() {
      const bits = euclidean(r.euclidSteps, r.euclidHits, r.euclidRot);
      euclidWrap.innerHTML = '';
      bits.forEach((b) => {
        const dot = document.createElement('div');
        dot.className = `euclid-led ${b ? 'on' : ''}`;
        euclidWrap.appendChild(dot);
      });
    }

    const grid = document.createElement('div');
    grid.className = 'rand-grid';

    function makeSelect(label, options, value, onChange) {
      const row = document.createElement('div');
      row.className = 'rand-row';
      row.innerHTML = `<span>${label}</span>`;
      const sel = document.createElement('select');
      sel.className = 'rand-select';
      for (const opt of options) {
        const o = document.createElement('option');
        o.value = String(opt.value);
        o.textContent = opt.label;
        if (String(opt.value) === String(value)) o.selected = true;
        sel.appendChild(o);
      }
      sel.onchange = () => onChange(sel.value);
      row.appendChild(sel);
      return row;
    }

    function makeRange(label, min, max, value, onChange) {
      const row = document.createElement('div');
      row.className = 'rand-row';
      const valSpan = document.createElement('span');
      valSpan.textContent = String(value);
      row.innerHTML = `<span>${label}</span>`;
      const inp = document.createElement('input');
      inp.type = 'range';
      inp.className = 'rand-range';
      inp.min = String(min);
      inp.max = String(max);
      inp.value = String(value);
      inp.oninput = () => {
        const v = Number(inp.value);
        valSpan.textContent = String(v);
        onChange(v);
      };
      row.append(inp, valSpan);
      return row;
    }

    grid.append(
      makeSelect(
        'ROOT',
        ROOT_NOTES.map((n, i) => ({ label: n, value: i })),
        st.scaleRoot,
        (v) => {
          st.scaleRoot = Number(v);
          store.emit('roll-ctx');
        }
      ),
      makeSelect(
        'SCALE',
        SCALES.map((s) => ({ label: s.name, value: s.id })),
        st.scaleId,
        (v) => {
          st.scaleId = v;
          store.emit('roll-ctx');
        }
      ),
      makeSelect(
        'MODE',
        ['ACID', 'WALK', 'ARP', 'CHORD'].map((m) => ({ label: m, value: m })),
        r.mode,
        (v) => {
          r.mode = v;
        }
      ),
      makeRange('OCTAVE', 1, 5, r.baseOctave, (v) => (r.baseOctave = v)),
      makeRange('SPREAD', 1, 3, r.octaveSpread, (v) => (r.octaveSpread = v)),
      makeRange('STEPS', 4, 32, r.euclidSteps, (v) => {
        r.euclidSteps = v;
        updateEuclidPreview();
      }),
      makeRange('HITS', 1, 32, r.euclidHits, (v) => {
        r.euclidHits = v;
        updateEuclidPreview();
      }),
      makeRange('ROTATE', 0, 16, r.euclidRot, (v) => {
        r.euclidRot = v;
        updateEuclidPreview();
      }),
      makeRange('DENSITY %', 15, 100, r.density, (v) => (r.density = v)),
      makeRange('VEL JIT %', 0, 100, r.velJitter, (v) => (r.velJitter = v)),
      makeRange('SLIDE %', 0, 80, r.slidePct, (v) => (r.slidePct = v))
    );

    const seedRow = document.createElement('div');
    seedRow.className = 'rand-row';
    seedRow.innerHTML = `<span>SEED ${r.seed}</span>`;
    const lockBtn = document.createElement('button');
    lockBtn.className = `ctx-chip ${r.seedLock ? 'active' : ''}`;
    lockBtn.textContent = r.seedLock ? 'LOCKED' : 'UNLOCKED';
    lockBtn.onclick = () => {
      r.seedLock = !r.seedLock;
      lockBtn.classList.toggle('active', r.seedLock);
      lockBtn.textContent = r.seedLock ? 'LOCKED' : 'UNLOCKED';
    };
    seedRow.appendChild(lockBtn);
    grid.appendChild(seedRow);

    const actions = document.createElement('div');
    actions.style.display = 'flex';
    actions.style.gap = '8px';
    actions.style.justifyContent = 'flex-end';

    const mutateBtn = document.createElement('button');
    mutateBtn.className = 'ctx-chip';
    mutateBtn.textContent = 'MUTATE 20%';
    mutateBtn.onclick = () => {
      const res = generateRiff({
        ...r,
        rootIdx: st.scaleRoot,
        scaleId: st.scaleId,
        lengthSteps: st.patterns[st.activePatternId]?.length || 16,
        seed: r.seedLock ? r.seed : Math.floor(Math.random() * 99999),
        prevNotes: store.getActiveNotes(),
        mutate: true,
        isDrum: isDrumTrack()
      });
      r.seed = res.seed;
      store.setActiveNotes(res.notes, undefined, undefined, 'MUTATE 20%');
    };

    const genBtn = document.createElement('button');
    genBtn.className = 'ctx-chip solid';
    genBtn.textContent = 'GENERATE RIFF';
    genBtn.onclick = () => {
      const nextSeed = r.seedLock ? r.seed : Math.floor(Math.random() * 99999);
      const res = generateRiff({
        ...r,
        rootIdx: st.scaleRoot,
        scaleId: st.scaleId,
        lengthSteps: st.patterns[st.activePatternId]?.length || 16,
        seed: nextSeed,
        isDrum: isDrumTrack()
      });
      r.seed = res.seed;
      seedRow.querySelector('span').textContent = `SEED ${r.seed}`;
      store.setActiveNotes(res.notes, undefined, undefined, 'RIFF GEN');
    };

    actions.append(mutateBtn, genBtn);
    updateEuclidPreview();
    body.append(euclidWrap, grid, actions);
    modalEl.append(hdr, body);
  }

  function renderDetailOverlay(panelEl) {
    const st = store.getState();
    const pat = st.patterns[st.activePatternId];
    const hdr = document.createElement('div');
    hdr.className = 'overlay-hdr';
    hdr.innerHTML = `<span>ROLL // GRID, LENGTH & SCALE</span>`;
    const close = document.createElement('button');
    close.className = 'ctx-chip';
    close.textContent = 'CLOSE [B]';
    close.onclick = () => {
      st.detailOverlay = null;
      store.emit('overlay', null);
    };
    hdr.appendChild(close);

    const body = document.createElement('div');
    body.className = 'overlay-body';

    const gridBar = document.createElement('div');
    gridBar.style.display = 'flex';
    gridBar.style.gap = '6px';
    gridBar.style.flexWrap = 'wrap';

    const snapBtn = document.createElement('button');
    snapBtn.className = 'ctx-chip';
    const updateSnapTxt = () => {
      snapBtn.textContent = `SNAP: ${formatSnapChipText(st)}`;
    };
    updateSnapTxt();
    snapBtn.onclick = () => {
      const curKey = st.gridSnapAuto ? 'AUTO' : st.gridSnap;
      const idx = SNAP_OPTIONS.findIndex((s) => s.val === curKey);
      const next = SNAP_OPTIONS[(idx + 1) % SNAP_OPTIONS.length];
      if (next.val === 'AUTO') {
        st.gridSnapAuto = true;
      } else {
        st.gridSnapAuto = false;
        st.gridSnap = next.val;
      }
      updateSnapTxt();
      store.emit('roll-ctx');
    };

    // Pattern Length pills (1B=4, 2B=8, 4B=16, 8B=32, 16B=64) + x2 DUP
    const lenBar = document.createElement('div');
    lenBar.style.display = 'flex';
    lenBar.style.gap = '4px';
    lenBar.style.flexWrap = 'wrap';
    PAT_LENGTHS.forEach(({ steps, label }) => {
      const lb = document.createElement('button');
      lb.className = `ctx-chip ${pat.length === steps ? 'active' : ''}`;
      lb.textContent = `${label} (${steps})`;
      lb.onclick = () => {
        store.pushHistory(`LEN ${label}`);
        pat.length = steps;
        lenBar.querySelectorAll('.ctx-chip').forEach((c) => c.classList.remove('active'));
        lb.classList.add('active');
        store.emit('notes');
        store.emit('roll-ctx');
      };
      lenBar.appendChild(lb);
    });

    const dupBtn = document.createElement('button');
    dupBtn.className = 'ctx-chip solid';
    dupBtn.textContent = '×2 DUP';
    dupBtn.onclick = () => {
      if (pat.length >= 64) return;
      const oldLen = pat.length;
      const nextLen = Math.min(64, oldLen * 2);
      store.pushHistory(`×2 PAT (${nextLen})`);
      pat.length = nextLen;
      for (const [tid, list] of Object.entries(pat.notesByTrack)) {
        const copies = list
          .filter((n) => n.step < oldLen)
          .map((n) => ({ ...n, id: nextId('n'), step: n.step + oldLen }))
          .filter((n) => n.step < nextLen);
        pat.notesByTrack[tid] = [...list, ...copies];
      }
      panelEl.innerHTML = '';
      renderDetailOverlay(panelEl);
      store.emit('notes');
      store.emit('roll-ctx');
    };
    lenBar.appendChild(dupBtn);

    const ghostBtn = document.createElement('button');
    ghostBtn.className = `ctx-chip ${st.ghostPatternId ? 'active' : ''}`;
    ghostBtn.textContent = `GHOST: ${st.ghostPatternId || 'OFF'}`;
    ghostBtn.onclick = () => {
      const order = ['NONE', 'P01', 'P02', 'P03', 'P04'];
      const idx = order.indexOf(st.ghostPatternId || 'NONE');
      const next = order[(idx + 1) % order.length];
      st.ghostPatternId = next === 'NONE' ? null : next;
      ghostBtn.textContent = `GHOST: ${st.ghostPatternId || 'OFF'}`;
      ghostBtn.classList.toggle('active', Boolean(st.ghostPatternId));
      store.emit('roll-ctx');
    };

    const slideBtn = document.createElement('button');
    slideBtn.className = `ctx-chip ${st.slideMode ? 'active' : ''}`;
    slideBtn.textContent = `SLIDE: ${st.slideMode ? 'ON' : 'OFF'}`;
    slideBtn.onclick = () => {
      st.slideMode = !st.slideMode;
      slideBtn.textContent = `SLIDE: ${st.slideMode ? 'ON' : 'OFF'}`;
      slideBtn.classList.toggle('active', st.slideMode);
      store.emit('roll-ctx');
    };

    const lockBtn = document.createElement('button');
    lockBtn.className = `ctx-chip ${st.scaleLock ? 'active' : ''}`;
    lockBtn.textContent = `SCALE LOCK: ${st.scaleLock ? 'ON' : 'OFF'}`;
    lockBtn.onclick = () => {
      st.scaleLock = !st.scaleLock;
      lockBtn.textContent = `SCALE LOCK: ${st.scaleLock ? 'ON' : 'OFF'}`;
      lockBtn.classList.toggle('active', st.scaleLock);
      store.emit('roll-ctx');
    };

    const zoomResetBtn = document.createElement('button');
    zoomResetBtn.className = 'ctx-chip';
    zoomResetBtn.textContent = 'FIT ZOOM';
    zoomResetBtn.onclick = () => {
      const kw = getKeyWidth();
      const w = gridWrap.clientWidth || 640;
      zoomStepW = Math.max(16, (w - kw) / Math.min(pat.length, 16));
      stepW = zoomStepW;
      scrollX = 0;
    };

    const labBtn = document.createElement('button');
    labBtn.className = 'ctx-chip';
    labBtn.textContent = '+LAB';
    labBtn.onclick = () => {
      store.archiveActivePatternToLab();
      st.detailOverlay = { type: 'lab' };
      store.emit('overlay', st.detailOverlay);
    };

    gridBar.append(snapBtn, zoomResetBtn, ghostBtn, slideBtn, lockBtn, labBtn);
    if (isDrumTrack()) {
      const dBtn = document.createElement('button');
      const curM = Math.round(st.tracks[st.selectedTrackId]?.inserts[0]?.params.mode || 0);
      dBtn.className = `ctx-chip ${curM === 1 ? 'active' : ''}`;
      dBtn.textContent = `DRUM: ${curM === 0 ? 'SYNTH' : 'RACK'}`;
      dBtn.onclick = () => {
        const nextM = Math.round(st.tracks[st.selectedTrackId]?.inserts[0]?.params.mode || 0) === 0 ? 1 : 0;
        store.pushHistory('DRUM MODE');
        store.setDeviceParam(st.selectedTrackId, 0, 'mode', nextM);
        dBtn.textContent = `DRUM: ${nextM === 0 ? 'SYNTH' : 'RACK'}`;
        dBtn.classList.toggle('active', nextM === 1);
      };
      gridBar.appendChild(dBtn);
    }
    body.append(gridBar, lenBar);

    const rootBar = document.createElement('div');
    rootBar.style.display = 'flex';
    rootBar.style.gap = '4px';
    rootBar.style.flexWrap = 'wrap';
    ROOT_NOTES.forEach((n, idx) => {
      const b = document.createElement('button');
      b.className = `ctx-chip ${st.scaleRoot === idx ? 'active' : ''}`;
      b.textContent = n;
      b.onclick = () => {
        st.scaleRoot = idx;
        store.emit('roll-ctx');
        rootBar.querySelectorAll('.ctx-chip').forEach((c, i) => c.classList.toggle('active', i === idx));
      };
      rootBar.appendChild(b);
    });

    const scaleBar = document.createElement('div');
    scaleBar.style.display = 'flex';
    scaleBar.style.gap = '4px';
    scaleBar.style.flexWrap = 'wrap';
    SCALES.forEach((sc) => {
      const b = document.createElement('button');
      b.className = `ctx-chip ${st.scaleId === sc.id ? 'active' : ''}`;
      b.textContent = sc.name;
      b.onclick = () => {
        st.scaleId = sc.id;
        store.emit('roll-ctx');
        scaleBar.querySelectorAll('.ctx-chip').forEach((c) => c.classList.toggle('active', c.textContent === sc.name));
      };
      scaleBar.appendChild(b);
    });

    const ops = document.createElement('div');
    ops.style.display = 'flex';
    ops.style.gap = '8px';
    ops.style.flexWrap = 'wrap';
    const quantizeBtn = document.createElement('button');
    quantizeBtn.className = 'ctx-chip';
    quantizeBtn.textContent = 'QUANTIZE TO SCALE';
    quantizeBtn.onclick = () => {
      const notes = store.getActiveNotes().map((n) => ({
        ...n,
        midi: snapMidiToScale(n.midi, st.scaleRoot, st.scaleId)
      }));
      store.setActiveNotes(notes, undefined, undefined, 'QUANTIZE');
    };

    const octUp = document.createElement('button');
    octUp.className = 'ctx-chip';
    octUp.textContent = '+1 OCTAVE';
    octUp.onclick = () => {
      store.setActiveNotes(store.getActiveNotes().map((n) => ({ ...n, midi: Math.min(96, n.midi + 12) })), undefined, undefined, '+1 OCTAVE');
    };

    const octDn = document.createElement('button');
    octDn.className = 'ctx-chip';
    octDn.textContent = '-1 OCTAVE';
    octDn.onclick = () => {
      store.setActiveNotes(store.getActiveNotes().map((n) => ({ ...n, midi: Math.max(24, n.midi - 12) })), undefined, undefined, '-1 OCTAVE');
    };

    const clearPat = document.createElement('button');
    clearPat.className = 'ctx-chip active';
    clearPat.textContent = 'CLEAR TRACK';
    clearPat.onclick = () => {
      store.setActiveNotes([], undefined, undefined, 'CLEAR TRACK');
    };

    ops.append(quantizeBtn, octUp, octDn, clearPat);
    body.append(rootBar, scaleBar, ops);
    panelEl.append(hdr, body);
  }

  return {
    el: root,
    tick,
    handleAction,
    renderRandomizerModal,
    renderDetailOverlay
  };
}
