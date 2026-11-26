import {
  NOTE_NAMES,
  SCALE_NAMES,
  SCALE_SHORT,
  STICK_LABELS,
  STICK_SECTORS,
  buildChord,
  stickSectorFromXY
} from '../../audio/brickchord-theory.js';
import { engine } from '../../audio/engine.js';
import { PATCH_NAMES, STYLE_NAMES } from '../../devices/brickchord.js';
import { store } from '../../state/store.js';

function setPillLabel(el, label) {
  const m = /^(.*?) \[(.+)\]$/.exec(label);
  el.textContent = m ? m[1] : label;
  if (m) {
    const k = document.createElement('span');
    k.className = 'pill-hint';
    k.textContent = m[2];
    el.appendChild(k);
    el.title = `${m[1]} [${m[2]}]`;
  }
}

const BTN = {
  A: 0,
  B: 1,
  X: 2,
  Y: 3,
  L1: 4,
  R1: 5,
  L2: 6,
  R2: 7,
  SELECT: 8,
  START: 9,
  L3: 10,
  R3: 11,
  UP: 12,
  DOWN: 13,
  LEFT: 14,
  RIGHT: 15
};

const PAD_ORDER = [
  { degree: 0, btnIdx: BTN.LEFT, glyph: '←' },
  { degree: 1, btnIdx: BTN.UP, glyph: '↑' },
  { degree: 2, btnIdx: BTN.RIGHT, glyph: '→' },
  { degree: 3, btnIdx: BTN.DOWN, glyph: '↓' },
  { degree: 4, btnIdx: BTN.X, glyph: 'X' },
  { degree: 5, btnIdx: BTN.A, glyph: 'A' },
  { degree: 6, btnIdx: BTN.B, glyph: 'B' }
];

let liveRefs = null;

function getParams(trackId) {
  return store.getState().tracks[trackId]?.inserts[0]?.params || {};
}

function drawBendCompass(canvas, live, touchVec, bg, border, ink, inkDim, accent) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const rect = canvas.getBoundingClientRect();
  const w = rect.width > 20 ? rect.width : canvas.width;
  const h = rect.height > 20 ? rect.height : canvas.height;
  const bw = Math.round(w * dpr);
  const bh = Math.round(h * dpr);
  if (canvas.width !== bw || canvas.height !== bh) {
    canvas.width = bw;
    canvas.height = bh;
  }

  const ctx = canvas.getContext('2d');
  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);

  const cx = w * 0.5;
  const cy = h * 0.52;
  const rad = Math.min(w, h) * 0.34;

  // Outer compass ring
  ctx.strokeStyle = border;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(cx, cy, rad, 0, Math.PI * 2);
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(cx, cy, rad * 0.36, 0, Math.PI * 2);
  ctx.stroke();

  // 8 radial sector labels
  for (let sec = 0; sec < 8; sec++) {
    const mod = STICK_SECTORS[sec];
    const lbl = STICK_LABELS[mod];
    const ang = (sec * 45 * Math.PI) / 180;
    const active = live.bendMod === mod;
    const rPos = rad * (active ? 1.16 : 1.08);
    const lx = cx + Math.cos(ang) * rPos;
    const ly = cy - Math.sin(ang) * rPos;
    ctx.fillStyle = active ? accent : inkDim;
    ctx.font = `${active ? '700' : '600'} 9.5px "Geist Mono", monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(lbl, lx, ly);
  }

  // Stick dot
  const sx = touchVec.x;
  const sy = touchVec.y;
  const px = cx + sx * (rad * 0.86);
  const py = cy + sy * (rad * 0.86);
  ctx.strokeStyle = live.bendMod ? accent : inkDim;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(px, py);
  ctx.stroke();

  ctx.fillStyle = live.bendMod ? accent : ink;
  ctx.beginPath();
  ctx.arc(px, py, 5, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = inkDim;
  ctx.font = '700 9px "Geist Mono", monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText('L-BEND', 8, 6);
  ctx.restore();
}

function drawChordHud(canvas, live, bg, surface, border, ink, inkDim, accent) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const rect = canvas.getBoundingClientRect();
  const w = rect.width > 20 ? rect.width : canvas.width;
  const h = rect.height > 20 ? rect.height : canvas.height;
  const bw = Math.round(w * dpr);
  const bh = Math.round(h * dpr);
  if (canvas.width !== bw || canvas.height !== bh) {
    canvas.width = bw;
    canvas.height = bh;
  }

  const ctx = canvas.getContext('2d');
  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);

  // Top key/scale & Roman tag
  const keyName = NOTE_NAMES[live.key] || 'C';
  const scaleTag = SCALE_SHORT[live.scaleIdx] || 'MIN';
  ctx.fillStyle = inkDim;
  ctx.font = '700 10px "Geist Mono", monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(`${keyName} ${scaleTag}  OCT ${live.octave >= 0 ? '+' : ''}${live.octave}`, 10, 8);

  if (live.roman) {
    ctx.fillStyle = live.active ? accent : inkDim;
    ctx.textAlign = 'right';
    ctx.fillText(live.roman, w - 10, 8);
  }

  // Big chord readout
  ctx.fillStyle = live.active ? ink : inkDim;
  ctx.font = `700 ${Math.min(34, Math.max(22, Math.round(h * 0.24)))}px "Geist Mono", monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(live.chordName || '—', w * 0.5, h * 0.34);

  // Live oscilloscope
  const scope = live.scope || [];
  if (scope.length > 4) {
    const syMid = h * 0.62;
    const amp = h * 0.14;
    ctx.strokeStyle = live.active ? accent : inkDim;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    const step = Math.max(1, Math.floor(scope.length / 96));
    let started = false;
    for (let i = 0; i < scope.length; i += step) {
      const x = 10 + (i / (scope.length - 1)) * (w - 20);
      const y = syMid - scope[i] * amp;
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.stroke();
  }

  // Mini active voicing pitch strip (C2..C6 -> MIDI 36..84)
  const noteSet = new Set(live.upper || []);
  const bassMidi = live.bass;
  const barY = h - 22;
  const barH = 14;
  const totalNotes = 48;
  const kx = 10;
  const kw = (w - 20) / totalNotes;

  for (let i = 0; i < totalNotes; i++) {
    const midi = 36 + i;
    const isBass = bassMidi === midi;
    const isUpper = noteSet.has(midi);
    const pc = midi % 12;
    const isBlack = [1, 3, 6, 8, 10].includes(pc);

    ctx.fillStyle = isBass ? accent : isUpper ? ink : isBlack ? bg : surface;
    ctx.strokeStyle = border;
    ctx.fillRect(kx + i * kw, barY, Math.max(1.5, kw - 0.8), barH);
    if (!isBass && !isUpper && !isBlack) {
      ctx.strokeRect(kx + i * kw, barY, Math.max(1.5, kw - 0.8), barH);
    }
  }
  ctx.restore();
}

function drawFxPad(canvas, live, bg, border, ink, inkDim, accent) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const rect = canvas.getBoundingClientRect();
  const w = rect.width > 20 ? rect.width : canvas.width;
  const h = rect.height > 20 ? rect.height : canvas.height;
  const bw = Math.round(w * dpr);
  const bh = Math.round(h * dpr);
  if (canvas.width !== bw || canvas.height !== bh) {
    canvas.width = bw;
    canvas.height = bh;
  }

  const ctx = canvas.getContext('2d');
  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);

  const pad = 16;
  const gx = pad;
  const gy = 22;
  const gw = w - pad * 2;
  const gh = h - gy - 14;

  ctx.strokeStyle = border;
  ctx.lineWidth = 1;
  ctx.strokeRect(gx + 0.5, gy + 0.5, gw, gh);
  ctx.beginPath();
  ctx.moveTo(gx + gw * 0.5, gy);
  ctx.lineTo(gx + gw * 0.5, gy + gh);
  ctx.moveTo(gx, gy + gh * 0.5);
  ctx.lineTo(gx + gw, gy + gh * 0.5);
  ctx.stroke();

  const px = gx + ((live.rx + 1) * 0.5) * gw;
  const py = gy + ((live.ry + 1) * 0.5) * gh;

  ctx.strokeStyle = live.fxHold ? accent : inkDim;
  ctx.setLineDash([2, 2]);
  ctx.beginPath();
  ctx.moveTo(px, gy);
  ctx.lineTo(px, gy + gh);
  ctx.moveTo(gx, py);
  ctx.lineTo(gx + gw, py);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.fillStyle = live.fxHold || Math.hypot(live.rx, live.ry) > 0.12 ? accent : ink;
  ctx.beginPath();
  ctx.arc(px, py, 6, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = inkDim;
  ctx.font = '700 9px "Geist Mono", monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText('R-FX CUT/WET', 8, 6);
  if (live.fxHold) {
    ctx.fillStyle = accent;
    ctx.textAlign = 'right';
    ctx.fillText('HOLD', w - 8, 6);
  }
  ctx.restore();
}

function getEffectiveMods() {
  if (!liveRefs) return {};
  const m = {};
  if (liveRefs.touchMods.flip || liveRefs.padMods.flip) m.flip = true;
  if (liveRefs.touchMods.seventh || liveRefs.padMods.seventh) m.seventh = true;
  if (liveRefs.touchMods.sus || liveRefs.padMods.sus) m.sus = true;
  if (liveRefs.touchMods.ninth || liveRefs.padMods.ninth || (m.seventh && m.sus)) m.ninth = true;
  return m;
}

function updatePadLabels() {
  if (!liveRefs) return;
  const p = getParams(liveRefs.trackId);
  const key = Math.round(p.key ?? 0);
  const scaleName = SCALE_NAMES[Math.round(p.scale ?? 1)] || 'Minor';
  const mods = getEffectiveMods();
  const bend = liveRefs.touchBend || liveRefs.padBend;
  const effMods = bend ? { ...mods, [bend]: true } : mods;

  liveRefs.chordButtons.forEach(({ degree, glyph, el }) => {
    const info = buildChord(key, scaleName, degree, effMods);
    const active = liveRefs.activeDegree === degree && (liveRefs.isSounding || liveRefs.node?.getLiveState()?.active);
    el.classList.toggle('active', Boolean(active));
    el.innerHTML = `
      <div class="bc-pad-top"><span>${info.roman}</span><span>${glyph}</span></div>
      <div class="bc-pad-name">${info.name}</div>
    `;
  });

  liveRefs.modPills.forEach(({ key: modKey, el }) => {
    el.classList.toggle('active', Boolean(mods[modKey]));
  });
}

function revoiceLive(mods, bend) {
  const chord = liveRefs?.node?.revoiceChord(mods, bend);
  if (chord?.notes?.length && engine.isJamming()) engine.jamChordOn(chord.notes, 0.84);
  return chord;
}

function triggerDegree(degree, fromTouch = false) {
  if (!liveRefs) return;
  const { node, trackId } = liveRefs;
  if (!node) return;
  engine.unlock();
  const mods = getEffectiveMods();
  const bend = liveRefs.touchBend || liveRefs.padBend;
  const chord = node.playChord(degree, mods, bend, 0.86);
  liveRefs.activeDegree = degree;
  liveRefs.isSounding = true;
  if (fromTouch) liveRefs.touchHeldDegree = degree;

  const st = store.getState();
  if (engine.isJamming()) {
    if (chord?.notes?.length) engine.jamChordOn(chord.notes, 0.86);
  } else if (st.isPlaying && st.isRecording && chord?.notes?.length) {
    engine.recordChordToPattern(trackId, chord.notes, 4, 0.86, false);
  }
  updatePadLabels();
}

function releaseCurrentChord() {
  if (!liveRefs?.node) return;
  liveRefs.node.releaseChord(false);
  liveRefs.isSounding = liveRefs.node.getLiveState().latch;
  if (!liveRefs.isSounding) engine.jamChordOff();
  if (!liveRefs.isSounding) liveRefs.activeDegree = null;
  updatePadLabels();
}

export function handleBrickchordRawPad(pad) {
  if (!liveRefs) return;
  const st = store.getState();
  if (st.detailOverlay?.type !== 'brickchord') return;

  const { buttons, prevButtons, axes } = pad;
  const node = engine.getBrickchordNode(liveRefs.trackId);
  if (!node) return;
  liveRefs.node = node;

  const justPressed = (i) => buttons[i] && !prevButtons[i];
  const justReleased = (i) => !buttons[i] && prevButtons[i];
  const selectHeld = buttons[BTN.SELECT];

  // SELECT + START: jam over the playlist loop
  if (selectHeld && justPressed(BTN.START)) {
    engine.startJam(liveRefs.trackId);
    return;
  }

  // SELECT combos: adjust key, scale, octave without playing chords
  if (selectHeld) {
    const p = getParams(liveRefs.trackId);
    if (justPressed(BTN.LEFT) || justPressed(BTN.RIGHT)) {
      const nextKey = (((p.key ?? 0) + (justPressed(BTN.RIGHT) ? 1 : -1)) % 12 + 12) % 12;
      store.setDeviceParam(liveRefs.trackId, 0, 'key', nextKey);
      liveRefs.syncTopBar();
    }
    if (justPressed(BTN.UP) || justPressed(BTN.DOWN)) {
      const nextOct = Math.max(-1, Math.min(1, Math.round((p.octave ?? 0) + (justPressed(BTN.UP) ? 1 : -1))));
      store.setDeviceParam(liveRefs.trackId, 0, 'octave', nextOct);
      liveRefs.syncTopBar();
    }
    if (justPressed(BTN.Y)) {
      const nextScale = (Math.round(p.scale ?? 1) + 1) % 4;
      store.setDeviceParam(liveRefs.trackId, 0, 'scale', nextScale);
      liveRefs.syncTopBar();
    }
    return;
  }

  // Modifiers (held): Y=flip, L1=7th, R1=sus4, L1+R1=9th
  const prevModStr = JSON.stringify(liveRefs.padMods);
  liveRefs.padMods.flip = Boolean(buttons[BTN.Y]);
  liveRefs.padMods.seventh = Boolean(buttons[BTN.L1]);
  liveRefs.padMods.sus = Boolean(buttons[BTN.R1]);
  liveRefs.padMods.ninth = Boolean(buttons[BTN.L1] && buttons[BTN.R1]);

  // Left Stick: 8-way bend
  const [lx, ly, rx, ry] = axes;
  liveRefs.padStickVec = { x: lx, y: ly };
  const bendInfo = stickSectorFromXY(lx, ly, 0.36);
  const nextBend = bendInfo ? bendInfo.mod : null;
  const bendChanged = nextBend !== liveRefs.padBend;
  liveRefs.padBend = nextBend;

  // L2: toggle LATCH
  if (justPressed(BTN.L2)) {
    const live = node.getLiveState();
    node.setLatch(!live.latch);
    if (live.latch && !PAD_ORDER.some(({ btnIdx }) => buttons[btnIdx])) engine.jamChordOff();
    liveRefs.syncTopBar();
  }

  // L3: cycle PLAY STYLE
  if (justPressed(BTN.L3)) {
    const p = getParams(liveRefs.trackId);
    const nextStyle = (Math.round(p.style ?? 0) + 1) % STYLE_NAMES.length;
    store.setDeviceParam(liveRefs.trackId, 0, 'style', nextStyle);
    liveRefs.syncSegBars();
  }

  // R3: toggle FX HOLD
  if (justPressed(BTN.R3)) {
    node.setFxStick(rx, ry, 'toggle');
    liveRefs.syncTopBar();
  }

  // R2: Stamp current/last chord directly into active pattern
  if (justPressed(BTN.R2)) {
    const live = node.getLiveState();
    const notesToStamp = live.notes?.length ? live.notes : live.lastNotes;
    if (notesToStamp?.length) {
      engine.recordChordToPattern(liveRefs.trackId, notesToStamp, 4, 0.88, !st.isPlaying);
      liveRefs.flashStamp();
    }
  }

  // Right Stick: FX Filter / Wet control (unless HOLD active)
  const fxDeadzone = 0.08;
  const cleanRx = Math.abs(rx) < fxDeadzone ? 0 : rx;
  const cleanRy = Math.abs(ry) < fxDeadzone ? 0 : ry;
  if (!liveRefs.touchFxDragging) {
    node.setFxStick(cleanRx, cleanRy);
  }

  // Check chord button triggers & releases
  let triggeredNew = false;
  for (const { degree, btnIdx } of PAD_ORDER) {
    if (justPressed(btnIdx)) {
      triggerDegree(degree, false);
      triggeredNew = true;
    }
  }

  if (!triggeredNew && (bendChanged || JSON.stringify(liveRefs.padMods) !== prevModStr)) {
    const live = node.getLiveState();
    if (live.active) {
      revoiceLive(getEffectiveMods(), liveRefs.touchBend || liveRefs.padBend);
    }
    updatePadLabels();
  }

  // Release chord when all hardware chord buttons released
  const anyChordHeld = PAD_ORDER.some(({ btnIdx }) => buttons[btnIdx]) || liveRefs.touchHeldDegree !== null;
  const anyReleased = PAD_ORDER.some(({ btnIdx }) => justReleased(btnIdx));
  if (anyReleased && !anyChordHeld) {
    releaseCurrentChord();
  }
}

export function tickBrickchordOverlay() {
  if (!liveRefs) return;
  const st = store.getState();
  if (st.detailOverlay?.type !== 'brickchord') {
    liveRefs.node?.releaseChord?.(false);
    if (engine.isJamming()) engine.stopJam(true);
    liveRefs = null;
    return;
  }

  const node = engine.getBrickchordNode(liveRefs.trackId);
  if (!node) return;
  liveRefs.node = node;
  const live = node.getLiveState();

  const styles = getComputedStyle(document.documentElement);
  const bg = styles.getPropertyValue('--bg').trim();
  const surface = styles.getPropertyValue('--surface').trim();
  const border = styles.getPropertyValue('--border').trim();
  const ink = styles.getPropertyValue('--ink').trim();
  const inkDim = styles.getPropertyValue('--ink-dim').trim();
  const accent = styles.getPropertyValue('--accent').trim();

  const bendVec = liveRefs.touchBendDragging ? liveRefs.touchStickVec : liveRefs.padStickVec;
  drawBendCompass(liveRefs.bendCanvas, live, bendVec, bg, border, ink, inkDim, accent);
  drawChordHud(liveRefs.hudCanvas, live, bg, surface, border, ink, inkDim, accent);
  drawFxPad(liveRefs.fxCanvas, live, bg, border, ink, inkDim, accent);
}

export function renderBrickchordOverlay(panelEl, trackId) {
  const st = store.getState();
  const tr = st.tracks[trackId];
  let node = engine.getBrickchordNode(trackId);
  if (!tr || !node) return;

  panelEl.innerHTML = '';
  const root = document.createElement('div');
  root.className = 'bc-shell';

  // Top Header Bar
  const hdr = document.createElement('div');
  hdr.className = 'overlay-hdr bc-hdr';

  const hdrLeft = document.createElement('div');
  hdrLeft.className = 'bc-hdr-group';

  const titleEl = document.createElement('span');
  titleEl.className = 'bc-title';
  titleEl.textContent = `${tr.code} BRICKCHORD`;

  const keyBtn = document.createElement('button');
  keyBtn.className = 'ctx-chip';
  keyBtn.title = 'Key';
  keyBtn.onclick = () => {
    const p = getParams(trackId);
    store.setDeviceParam(trackId, 0, 'key', ((p.key ?? 0) + 1) % 12);
    syncTopBar();
    updatePadLabels();
  };

  const scaleBtn = document.createElement('button');
  scaleBtn.className = 'ctx-chip';
  scaleBtn.onclick = () => {
    const p = getParams(trackId);
    store.setDeviceParam(trackId, 0, 'scale', ((p.scale ?? 1) + 1) % SCALE_NAMES.length);
    syncTopBar();
    updatePadLabels();
  };

  const octBtn = document.createElement('button');
  octBtn.className = 'ctx-chip';
  octBtn.onclick = () => {
    const p = getParams(trackId);
    const cur = Math.round(p.octave ?? 0);
    const next = cur >= 1 ? -1 : cur + 1;
    store.setDeviceParam(trackId, 0, 'octave', next);
    syncTopBar();
  };

  hdrLeft.append(titleEl, keyBtn, scaleBtn, octBtn);

  const hdrRight = document.createElement('div');
  hdrRight.className = 'bc-hdr-group';

  const bassBtn = document.createElement('button');
  bassBtn.className = 'ctx-chip';
  bassBtn.onclick = () => {
    const p = getParams(trackId);
    store.setDeviceParam(trackId, 0, 'bass', (p.bass ?? 65) > 5 ? 0 : 72);
    syncTopBar();
  };

  const latchBtn = document.createElement('button');
  latchBtn.className = 'ctx-chip';
  latchBtn.onclick = () => {
    const n = engine.getBrickchordNode(trackId);
    if (!n) return;
    n.setLatch(!n.getLiveState().latch);
    syncTopBar();
    updatePadLabels();
  };

  const recBtn = document.createElement('button');
  recBtn.className = 'ctx-chip icon-only rec-chip';
  recBtn.title = 'Record';
  recBtn.innerHTML = '<svg class="ico" viewBox="0 0 16 16"><circle cx="8" cy="8" r="4.25" fill="currentColor" stroke="none"/></svg>';
  recBtn.onclick = async () => {
    await engine.toggleRecord();
    syncTopBar();
  };

  const jamBtn = document.createElement('button');
  jamBtn.className = 'ctx-chip jam-chip';
  jamBtn.textContent = 'JAM';
  jamBtn.title = 'Jam over the playlist loop [SELECT+START]';
  jamBtn.onclick = () => engine.startJam(trackId);

  const stampBtn = document.createElement('button');
  stampBtn.className = 'ctx-chip solid';
  stampBtn.textContent = 'STAMP';
  stampBtn.title = 'Stamp chord to pattern [R2]';
  stampBtn.onclick = () => {
    const n = engine.getBrickchordNode(trackId);
    const live = n?.getLiveState();
    const notes = live?.notes?.length ? live.notes : live?.lastNotes;
    if (notes?.length) {
      engine.recordChordToPattern(trackId, notes, 4, 0.88, !store.getState().isPlaying);
      flashStamp();
    }
  };

  const dspBtn = document.createElement('button');
  dspBtn.className = 'ctx-chip';
  dspBtn.textContent = 'DSP';
  dspBtn.onclick = () => {
    st.detailOverlay = { type: 'dsp', trackId, slotIdx: 0 };
    store.emit('overlay', st.detailOverlay);
  };

  const closeBtn = document.createElement('button');
  closeBtn.className = 'ctx-chip';
  closeBtn.innerHTML = '<svg class="ico" viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8"/></svg>';
  closeBtn.title = 'Close [SEL+B]';
  closeBtn.classList.add('icon-only');
  closeBtn.onclick = () => {
    engine.getBrickchordNode(trackId)?.releaseChord?.(true);
    if (engine.isJamming()) engine.stopJam(true);
    st.detailOverlay = null;
    store.emit('overlay', null);
  };

  hdrRight.append(bassBtn, latchBtn, jamBtn, recBtn, stampBtn, dspBtn, closeBtn);
  hdr.append(hdrLeft, hdrRight);

  // Patch & Style Segmented Strips
  const segWrap = document.createElement('div');
  segWrap.className = 'bc-seg-strip';

  const patchBar = document.createElement('div');
  patchBar.className = 'bc-seg-bar';
  const patchBtns = PATCH_NAMES.map((name, idx) => {
    const b = document.createElement('button');
    b.className = 'dsp-seg-btn';
    b.textContent = name;
    b.onclick = () => {
      engine.unlock();
      store.setDeviceParam(trackId, 0, 'patch', idx);
      syncSegBars();
    };
    patchBar.appendChild(b);
    return b;
  });

  const styleBar = document.createElement('div');
  styleBar.className = 'bc-seg-bar';
  const styleBtns = STYLE_NAMES.map((name, idx) => {
    const b = document.createElement('button');
    b.className = 'dsp-seg-btn';
    b.textContent = name;
    b.onclick = () => {
      engine.unlock();
      store.setDeviceParam(trackId, 0, 'style', idx);
      syncSegBars();
    };
    styleBar.appendChild(b);
    return b;
  });

  segWrap.append(patchBar, styleBar);

  // Middle Telemetry & Virtual Analog Stick Stage
  const stage = document.createElement('div');
  stage.className = 'bc-stage';

  const bendCanvas = document.createElement('canvas');
  bendCanvas.className = 'bc-hud-canvas';
  bendCanvas.width = 220;
  bendCanvas.height = 170;

  const hudCanvas = document.createElement('canvas');
  hudCanvas.className = 'bc-hud-canvas bc-hud-main';
  hudCanvas.width = 420;
  hudCanvas.height = 170;

  const fxCanvas = document.createElement('canvas');
  fxCanvas.className = 'bc-hud-canvas';
  fxCanvas.width = 220;
  fxCanvas.height = 170;

  const hudWrap = document.createElement('div');
  hudWrap.className = 'bc-hud-main bc-hud-wrap';
  hudCanvas.classList.remove('bc-hud-main');
  const jamLayer = document.createElement('div');
  jamLayer.className = 'bc-jam';
  hudWrap.append(hudCanvas, jamLayer);
  stage.append(bendCanvas, hudWrap, fxCanvas);

  function syncJam() {
    const j = store.getState().jam;
    jamBtn.classList.toggle('active', Boolean(j));
    jamLayer.classList.toggle('on', Boolean(j));
    if (!j) {
      jamLayer.innerHTML = '';
      return;
    }
    if (j.phase === 'count') {
      jamLayer.innerHTML = `<div class="bc-jam-count">${j.count}</div>`;
      return;
    }
    const cells = Array.from({ length: j.bars }, (_, i) => `<i class="${i < j.bar ? 'done' : i === j.bar ? 'now' : ''}"></i>`).join('');
    jamLayer.innerHTML = `<div class="bc-jam-top"><span class="rec-dot"></span><span>TAKE ${j.take}</span><span class="dim">${j.takes ? `${j.takes} KEPT` : ''}</span></div><div class="bc-jam-bars">${cells}</div>`;
  }
  const unsubJam = store.subscribe((_, topic) => {
    if (!jamLayer.isConnected) {
      unsubJam?.();
      return;
    }
    if (topic === 'jam') syncJam();
  });
  syncJam();

  // Touch-drag handlers for Bend Canvas (Left Virtual Stick)
  const updateBendFromPointer = (e) => {
    const rect = bendCanvas.getBoundingClientRect();
    const nx = ((e.clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1;
    const ny = ((e.clientY - rect.top) / Math.max(1, rect.height)) * 2 - 1;
    const mag = Math.hypot(nx, ny);
    const scale = mag > 1 ? 1 / mag : 1;
    liveRefs.touchStickVec = { x: nx * scale, y: ny * scale };
    const info = stickSectorFromXY(nx * scale, ny * scale, 0.25);
    const nextBend = info ? info.mod : null;
    if (nextBend !== liveRefs.touchBend) {
      liveRefs.touchBend = nextBend;
      if (liveRefs.node?.getLiveState().active) {
        revoiceLive(getEffectiveMods(), liveRefs.touchBend || liveRefs.padBend);
      }
      updatePadLabels();
    }
  };
  bendCanvas.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    liveRefs.touchBendDragging = true;
    bendCanvas.setPointerCapture(e.pointerId);
    updateBendFromPointer(e);
  });
  bendCanvas.addEventListener('pointermove', (e) => {
    if (liveRefs?.touchBendDragging) updateBendFromPointer(e);
  });
  const endBendDrag = () => {
    if (!liveRefs) return;
    liveRefs.touchBendDragging = false;
    liveRefs.touchStickVec = { x: 0, y: 0 };
    if (liveRefs.touchBend) {
      liveRefs.touchBend = null;
      if (liveRefs.node?.getLiveState().active) {
        revoiceLive(getEffectiveMods(), liveRefs.padBend);
      }
      updatePadLabels();
    }
  };
  bendCanvas.addEventListener('pointerup', endBendDrag);
  bendCanvas.addEventListener('pointercancel', endBendDrag);

  // Touch-drag handlers for FX XY Canvas (Right Virtual Stick)
  const updateFxFromPointer = (e) => {
    const rect = fxCanvas.getBoundingClientRect();
    const rx = Math.max(-1, Math.min(1, ((e.clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1));
    const ry = Math.max(-1, Math.min(1, ((e.clientY - rect.top) / Math.max(1, rect.height)) * 2 - 1));
    liveRefs.node?.setFxStick(rx, ry, liveRefs.node?.getLiveState().fxHold ? true : false);
  };
  fxCanvas.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    liveRefs.touchFxDragging = true;
    fxCanvas.setPointerCapture(e.pointerId);
    updateFxFromPointer(e);
  });
  fxCanvas.addEventListener('pointermove', (e) => {
    if (liveRefs?.touchFxDragging) updateFxFromPointer(e);
  });
  const endFxDrag = () => {
    if (!liveRefs) return;
    liveRefs.touchFxDragging = false;
    if (!liveRefs.node?.getLiveState().fxHold) {
      liveRefs.node?.setFxStick(0, 0, false);
    }
  };
  fxCanvas.addEventListener('pointerup', endFxDrag);
  fxCanvas.addEventListener('pointercancel', endFxDrag);

  // Bottom Tactile Performance Deck (D-Pad I..IV | Modifiers | Face V..vii°)
  const deck = document.createElement('div');
  deck.className = 'bc-deck';

  const leftCluster = document.createElement('div');
  leftCluster.className = 'bc-pad-cluster bc-dpad-grid';

  const modCol = document.createElement('div');
  modCol.className = 'bc-mod-col';

  const rightCluster = document.createElement('div');
  rightCluster.className = 'bc-pad-cluster bc-face-grid';

  const chordButtons = PAD_ORDER.map((item, i) => {
    const btn = document.createElement('button');
    btn.className = `bc-pad ${i < 4 ? 'bc-dpad-' + item.degree : 'bc-face-' + item.degree}`;
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      btn.setPointerCapture(e.pointerId);
      triggerDegree(item.degree, true);
    });
    const endTouch = () => {
      if (liveRefs && liveRefs.touchHeldDegree === item.degree) {
        liveRefs.touchHeldDegree = null;
        releaseCurrentChord();
      }
    };
    btn.addEventListener('pointerup', endTouch);
    btn.addEventListener('pointercancel', endTouch);
    if (i < 4) leftCluster.appendChild(btn);
    else rightCluster.appendChild(btn);
    return { ...item, el: btn };
  });

  const modSpecs = [
    { key: 'flip', label: 'FLIP [Y]' },
    { key: 'seventh', label: '7TH [L1]' },
    { key: 'sus', label: 'SUS4 [R1]' },
    { key: 'ninth', label: '9TH [L1+R1]' }
  ];

  const modPills = modSpecs.map(({ key, label }) => {
    const pill = document.createElement('button');
    pill.className = 'bc-mod-pill';
    setPillLabel(pill, label);
    pill.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      if (!liveRefs) return;
      liveRefs.touchMods[key] = !liveRefs.touchMods[key];
      if (liveRefs.node?.getLiveState().active) {
        revoiceLive(getEffectiveMods(), liveRefs.touchBend || liveRefs.padBend);
      }
      updatePadLabels();
    });
    modCol.appendChild(pill);
    return { key, el: pill };
  });

  const fxHoldBtn = document.createElement('button');
  fxHoldBtn.className = 'bc-mod-pill';
  setPillLabel(fxHoldBtn, 'FX HOLD [R3]');
  fxHoldBtn.onclick = () => {
    liveRefs?.node?.setFxStick(0, 0, 'toggle');
    syncTopBar();
  };
  modCol.appendChild(fxHoldBtn);

  deck.append(leftCluster, modCol, rightCluster);
  root.append(hdr, segWrap, stage, deck);
  panelEl.appendChild(root);

  function syncTopBar() {
    const p = getParams(trackId);
    const curState = store.getState();
    const live = engine.getBrickchordNode(trackId)?.getLiveState() || {};
    keyBtn.textContent = NOTE_NAMES[Math.round(p.key ?? 0)];
    scaleBtn.textContent = SCALE_SHORT[Math.round(p.scale ?? 1)] || 'MIN';
    const oct = Math.round(p.octave ?? 0);
    octBtn.textContent = `${oct >= 0 ? '+' : ''}${oct}`;
    const bassOn = (p.bass ?? 65) > 5;
    bassBtn.textContent = 'BASS';
    bassBtn.classList.toggle('active', bassOn);
    latchBtn.textContent = 'LATCH';
    latchBtn.classList.toggle('active', Boolean(live.latch));
    recBtn.classList.toggle('rec-on', Boolean(curState.isRecording));
    fxHoldBtn.classList.toggle('active', Boolean(live.fxHold));
  }

  function syncSegBars() {
    const p = getParams(trackId);
    const patchIdx = Math.round(p.patch ?? 0);
    const styleIdx = Math.round(p.style ?? 0);
    patchBtns.forEach((b, i) => b.classList.toggle('active', i === patchIdx));
    styleBtns.forEach((b, i) => b.classList.toggle('active', i === styleIdx));
  }

  function flashStamp() {
    stampBtn.classList.add('active');
    stampBtn.textContent = 'STAMP';
    setTimeout(() => {
      if (stampBtn.isConnected) {
        stampBtn.classList.remove('active');
        stampBtn.textContent = 'STAMP';
      }
    }, 220);
  }

  liveRefs = {
    trackId,
    node,
    bendCanvas,
    hudCanvas,
    fxCanvas,
    chordButtons,
    modPills,
    activeDegree: null,
    isSounding: false,
    touchHeldDegree: null,
    touchMods: { flip: false, seventh: false, sus: false, ninth: false },
    padMods: { flip: false, seventh: false, sus: false, ninth: false },
    touchBend: null,
    padBend: null,
    touchBendDragging: false,
    touchFxDragging: false,
    touchStickVec: { x: 0, y: 0 },
    padStickVec: { x: 0, y: 0 },
    syncTopBar,
    syncSegBars,
    flashStamp
  };

  syncTopBar();
  syncSegBars();
  updatePadLabels();
  tickBrickchordOverlay();
}
