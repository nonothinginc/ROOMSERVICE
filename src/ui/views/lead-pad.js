import { engine } from '../../audio/engine.js';
import { ROOT_NOTES, SCALES, midiToName } from '../../state/scales.js';
import { store } from '../../state/store.js';

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
  { deg: 0, btnIdx: BTN.LEFT, glyph: '←' },
  { deg: 1, btnIdx: BTN.UP, glyph: '↑' },
  { deg: 2, btnIdx: BTN.RIGHT, glyph: '→' },
  { deg: 3, btnIdx: BTN.DOWN, glyph: '↓' },
  { deg: 4, btnIdx: BTN.X, glyph: 'X' },
  { deg: 5, btnIdx: BTN.A, glyph: 'A' },
  { deg: 6, btnIdx: BTN.B, glyph: 'B' }
];

const SCALE_KEYS = Object.keys(SCALES);
const GLIDE_MODES = ['OFF', '45ms', '90ms'];

let liveRefs = null;

function getScaleMidi(degree, octShift = 0) {
  const st = store.getState();
  const sc = SCALES[st.scaleId] || SCALES.MIN;
  const interval = sc[degree % sc.length] + 12 * Math.floor(degree / sc.length);
  const baseOct = (liveRefs?.baseOctave ?? 3) + octShift;
  return Math.max(24, Math.min(96, 12 * (baseOct + 1) + st.scaleRoot + interval));
}

function drawBendHud(canvas, stickVec, bg, border, ink, inkDim, accent) {
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
  const cy = h * 0.54;
  const r = Math.min(w, h) * 0.34;
  ctx.strokeStyle = border;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.moveTo(cx - r, cy);
  ctx.lineTo(cx + r, cy);
  ctx.moveTo(cx, cy - r);
  ctx.lineTo(cx, cy + r);
  ctx.stroke();

  const active = Math.hypot(stickVec.x, stickVec.y) > 0.14;
  ctx.fillStyle = active ? accent : ink;
  ctx.beginPath();
  ctx.arc(cx + stickVec.x * r * 0.85, cy + stickVec.y * r * 0.85, 6, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = inkDim;
  ctx.font = '700 9px "Geist Mono", monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText('L-MOD', 8, 6);
  ctx.textAlign = 'center';
  ctx.fillText('BEND', cx, h - 14);
  ctx.restore();
}

function drawLeadScope(canvas, noteName, glideLabel, droneOn, bg, border, ink, inkDim, accent) {
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

  const st = store.getState();
  ctx.fillStyle = inkDim;
  ctx.font = '700 10px "Geist Mono", monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(`${ROOT_NOTES[st.scaleRoot]} ${st.scaleId} // GLIDE ${glideLabel}`, 10, 8);
  if (droneOn) {
    ctx.fillStyle = accent;
    ctx.textAlign = 'right';
    ctx.fillText('DRONE ON', w - 10, 8);
  }

  ctx.fillStyle = noteName && noteName !== '—' ? ink : inkDim;
  ctx.font = `700 ${Math.min(34, Math.max(22, Math.round(h * 0.24)))}px "Geist Mono", monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(noteName || '—', w * 0.5, h * 0.40);

  const wave = engine.getWaveform();
  if (wave?.length > 4) {
    const syMid = h * 0.74;
    const amp = h * 0.16;
    ctx.strokeStyle = noteName && noteName !== '—' ? accent : inkDim;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    const step = Math.max(1, Math.floor(wave.length / 80));
    let started = false;
    for (let i = 0; i < wave.length; i += step) {
      const px = 10 + (i / (wave.length - 1)) * (w - 20);
      const py = syMid - wave[i] * amp;
      if (!started) {
        ctx.moveTo(px, py);
        started = true;
      } else {
        ctx.lineTo(px, py);
      }
    }
    ctx.stroke();
  }
  ctx.restore();
}

function drawDronePad(canvas, drone, bg, border, ink, inkDim, accent) {
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

  const gx = 14;
  const gy = 22;
  const gw = w - 28;
  const gh = h - gy - 12;
  ctx.strokeStyle = border;
  ctx.strokeRect(gx + 0.5, gy + 0.5, gw, gh);
  ctx.beginPath();
  ctx.moveTo(gx + gw * 0.5, gy);
  ctx.lineTo(gx + gw * 0.5, gy + gh);
  ctx.moveTo(gx, gy + gh * 0.5);
  ctx.lineTo(gx + gw, gy + gh * 0.5);
  ctx.stroke();

  const px = gx + ((drone.rx + 1) * 0.5) * gw;
  const py = gy + ((drone.ry + 1) * 0.5) * gh;
  ctx.fillStyle = drone.active || drone.hold ? accent : ink;
  ctx.beginPath();
  ctx.arc(px, py, 6, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = inkDim;
  ctx.font = '700 9px "Geist Mono", monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText('R-DRONE CUT/LVL', 8, 6);
  if (drone.hold) {
    ctx.fillStyle = accent;
    ctx.textAlign = 'right';
    ctx.fillText('HOLD', w - 8, 6);
  }
  ctx.restore();
}

function triggerDegree(deg) {
  if (!liveRefs) return;
  const octShift = (liveRefs.octUp ? 1 : 0) - (liveRefs.octDown ? 1 : 0);
  const midi = getScaleMidi(deg, octShift);
  const doSlide = liveRefs.slideHold || liveRefs.glideIdx > 0;
  engine.previewNote(liveRefs.trackId, midi, 0.88, doSlide);
  liveRefs.activeDeg = deg;
  liveRefs.lastNoteName = midiToName(midi);
  liveRefs.updatePads();
}

export function handleLeadRawPad(pad) {
  if (!liveRefs) return;
  const st = store.getState();
  if (st.detailOverlay?.type !== 'lead') return;
  const { buttons, prevButtons, axes } = pad;
  const justPressed = (i) => buttons[i] && !prevButtons[i];

  if (buttons[BTN.SELECT]) {
    if (justPressed(BTN.LEFT) || justPressed(BTN.RIGHT)) {
      st.scaleRoot = (((st.scaleRoot + (justPressed(BTN.RIGHT) ? 1 : -1)) % 12) + 12) % 12;
      liveRefs.syncTop();
      liveRefs.updatePads();
    }
    if (justPressed(BTN.Y)) {
      const idx = SCALE_KEYS.indexOf(st.scaleId);
      st.scaleId = SCALE_KEYS[(idx + 1) % SCALE_KEYS.length];
      liveRefs.syncTop();
      liveRefs.updatePads();
    }
    if (justPressed(BTN.UP) || justPressed(BTN.DOWN)) {
      liveRefs.baseOctave = Math.max(1, Math.min(5, liveRefs.baseOctave + (justPressed(BTN.UP) ? 1 : -1)));
      liveRefs.syncTop();
      liveRefs.updatePads();
    }
    return;
  }

  liveRefs.octDown = Boolean(buttons[BTN.L1]);
  liveRefs.octUp = Boolean(buttons[BTN.R1]);
  liveRefs.slideHold = Boolean(buttons[BTN.Y]);

  if (justPressed(BTN.L2)) {
    const d = engine.getDroneState();
    if (d.active) engine.stopDrone();
    else engine.startDrone(36 + st.scaleRoot);
    liveRefs.syncTop();
  }
  if (justPressed(BTN.L3)) {
    liveRefs.glideIdx = (liveRefs.glideIdx + 1) % GLIDE_MODES.length;
    liveRefs.syncTop();
  }
  if (justPressed(BTN.R3)) {
    engine.setDroneXY(0, 0, 'toggle');
    liveRefs.syncTop();
  }

  const [lx, ly, rx, ry] = axes;
  liveRefs.padStick = { x: lx, y: ly };
  if (Math.hypot(lx, ly) > 0.25) {
    engine.setDeviceXY(liveRefs.trackId, 0, lx, ly);
  }
  if (!liveRefs.touchDroneDrag) {
    const cleanRx = Math.abs(rx) < 0.08 ? 0 : rx;
    const cleanRy = Math.abs(ry) < 0.08 ? 0 : ry;
    engine.setDroneXY(cleanRx, cleanRy);
  }

  for (const { deg, btnIdx } of PAD_ORDER) {
    if (justPressed(btnIdx)) triggerDegree(deg);
  }
  const anyHeld = PAD_ORDER.some(({ btnIdx }) => buttons[btnIdx]);
  if (!anyHeld && liveRefs.touchHeldDeg == null) {
    liveRefs.activeDeg = null;
    liveRefs.updatePads();
  }
}

export function tickLeadOverlay() {
  if (!liveRefs) return;
  const st = store.getState();
  if (st.detailOverlay?.type !== 'lead') {
    engine.stopDrone();
    liveRefs = null;
    return;
  }
  const styles = getComputedStyle(document.documentElement);
  const bg = styles.getPropertyValue('--bg').trim();
  const border = styles.getPropertyValue('--border').trim();
  const ink = styles.getPropertyValue('--ink').trim();
  const inkDim = styles.getPropertyValue('--ink-dim').trim();
  const accent = styles.getPropertyValue('--accent').trim();

  const drone = engine.getDroneState();
  drawBendHud(liveRefs.bendCanvas, liveRefs.padStick, bg, border, ink, inkDim, accent);
  drawLeadScope(liveRefs.hudCanvas, liveRefs.lastNoteName, GLIDE_MODES[liveRefs.glideIdx], drone.active, bg, border, ink, inkDim, accent);
  drawDronePad(liveRefs.droneCanvas, drone, bg, border, ink, inkDim, accent);
}

export function renderLeadOverlay(panelEl, trackId) {
  const st = store.getState();
  const tr = st.tracks[trackId];
  if (!tr) return;

  panelEl.innerHTML = '';
  const root = document.createElement('div');
  root.className = 'bc-shell';

  const hdr = document.createElement('div');
  hdr.className = 'overlay-hdr bc-hdr';

  const left = document.createElement('div');
  left.className = 'bc-hdr-group';
  const title = document.createElement('span');
  title.className = 'bc-title';
  title.textContent = `${tr.code} ${tr.name} // LEAD`;

  const keyBtn = document.createElement('button');
  keyBtn.className = 'ctx-chip';
  keyBtn.onclick = () => {
    st.scaleRoot = (st.scaleRoot + 1) % 12;
    if (engine.getDroneState().active) engine.startDrone(36 + st.scaleRoot);
    syncTop();
    updatePads();
  };

  const scaleBtn = document.createElement('button');
  scaleBtn.className = 'ctx-chip';
  scaleBtn.onclick = () => {
    const i = SCALE_KEYS.indexOf(st.scaleId);
    st.scaleId = SCALE_KEYS[(i + 1) % SCALE_KEYS.length];
    syncTop();
    updatePads();
  };

  const octBtn = document.createElement('button');
  octBtn.className = 'ctx-chip';
  octBtn.onclick = () => {
    liveRefs.baseOctave = liveRefs.baseOctave >= 5 ? 1 : liveRefs.baseOctave + 1;
    syncTop();
    updatePads();
  };

  left.append(title, keyBtn, scaleBtn, octBtn);

  const right = document.createElement('div');
  right.className = 'bc-hdr-group';

  const glideBtn = document.createElement('button');
  glideBtn.className = 'ctx-chip';
  glideBtn.onclick = () => {
    liveRefs.glideIdx = (liveRefs.glideIdx + 1) % GLIDE_MODES.length;
    syncTop();
  };

  const droneBtn = document.createElement('button');
  droneBtn.className = 'ctx-chip';
  droneBtn.onclick = () => {
    engine.unlock();
    if (engine.getDroneState().active) engine.stopDrone();
    else engine.startDrone(36 + store.getState().scaleRoot);
    syncTop();
  };

  const recBtn = document.createElement('button');
  recBtn.className = 'ctx-chip';
  recBtn.onclick = async () => {
    await engine.toggleRecord();
    syncTop();
  };

  const closeBtn = document.createElement('button');
  closeBtn.className = 'ctx-chip';
  closeBtn.textContent = 'CLOSE [SEL+B]';
  closeBtn.onclick = () => {
    engine.stopDrone();
    st.detailOverlay = null;
    store.emit('overlay', null);
  };

  right.append(glideBtn, droneBtn, recBtn, closeBtn);
  hdr.append(left, right);

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

  const droneCanvas = document.createElement('canvas');
  droneCanvas.className = 'bc-hud-canvas';
  droneCanvas.width = 220;
  droneCanvas.height = 170;
  stage.append(bendCanvas, hudCanvas, droneCanvas);

  const setXYFromEvent = (canvas, e, fn) => {
    const r = canvas.getBoundingClientRect();
    const nx = Math.max(-1, Math.min(1, ((e.clientX - r.left) / Math.max(1, r.width)) * 2 - 1));
    const ny = Math.max(-1, Math.min(1, ((e.clientY - r.top) / Math.max(1, r.height)) * 2 - 1));
    fn(nx, ny);
  };

  bendCanvas.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    bendCanvas.setPointerCapture(e.pointerId);
    setXYFromEvent(bendCanvas, e, (x, y) => {
      liveRefs.padStick = { x, y };
      engine.setDeviceXY(trackId, 0, x, y);
    });
  });
  bendCanvas.addEventListener('pointermove', (e) => {
    if (e.buttons) {
      setXYFromEvent(bendCanvas, e, (x, y) => {
        liveRefs.padStick = { x, y };
        engine.setDeviceXY(trackId, 0, x, y);
      });
    }
  });
  bendCanvas.addEventListener('pointerup', () => {
    if (liveRefs) liveRefs.padStick = { x: 0, y: 0 };
  });

  droneCanvas.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    liveRefs.touchDroneDrag = true;
    droneCanvas.setPointerCapture(e.pointerId);
    setXYFromEvent(droneCanvas, e, (x, y) => engine.setDroneXY(x, y, true));
  });
  droneCanvas.addEventListener('pointermove', (e) => {
    if (liveRefs?.touchDroneDrag) {
      setXYFromEvent(droneCanvas, e, (x, y) => engine.setDroneXY(x, y, true));
    }
  });
  droneCanvas.addEventListener('pointerup', () => {
    if (liveRefs) liveRefs.touchDroneDrag = false;
  });

  const deck = document.createElement('div');
  deck.className = 'bc-deck';
  const leftCluster = document.createElement('div');
  leftCluster.className = 'bc-pad-cluster bc-dpad-grid';
  const modCol = document.createElement('div');
  modCol.className = 'bc-mod-col';
  const rightCluster = document.createElement('div');
  rightCluster.className = 'bc-pad-cluster bc-face-grid';

  const padBtns = PAD_ORDER.map((item, i) => {
    const btn = document.createElement('button');
    btn.className = `bc-pad ${i < 4 ? 'bc-dpad-' + item.deg : 'bc-face-' + item.deg}`;
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      btn.setPointerCapture(e.pointerId);
      liveRefs.touchHeldDeg = item.deg;
      triggerDegree(item.deg);
    });
    const rel = () => {
      if (liveRefs && liveRefs.touchHeldDeg === item.deg) {
        liveRefs.touchHeldDeg = null;
        liveRefs.activeDeg = null;
        updatePads();
      }
    };
    btn.addEventListener('pointerup', rel);
    btn.addEventListener('pointercancel', rel);
    if (i < 4) leftCluster.appendChild(btn);
    else rightCluster.appendChild(btn);
    return { ...item, el: btn };
  });

  const slideBtn = document.createElement('button');
  slideBtn.className = 'bc-mod-pill';
  slideBtn.textContent = 'SLIDE [Y]';
  slideBtn.onclick = () => {
    liveRefs.slideHold = !liveRefs.slideHold;
    slideBtn.classList.toggle('active', liveRefs.slideHold);
  };

  const octUpBtn = document.createElement('button');
  octUpBtn.className = 'bc-mod-pill';
  octUpBtn.textContent = 'OCT+ [R1]';
  octUpBtn.onclick = () => {
    liveRefs.baseOctave = Math.min(5, liveRefs.baseOctave + 1);
    syncTop();
    updatePads();
  };

  const octDnBtn = document.createElement('button');
  octDnBtn.className = 'bc-mod-pill';
  octDnBtn.textContent = 'OCT- [L1]';
  octDnBtn.onclick = () => {
    liveRefs.baseOctave = Math.max(1, liveRefs.baseOctave - 1);
    syncTop();
    updatePads();
  };

  const holdDroneBtn = document.createElement('button');
  holdDroneBtn.className = 'bc-mod-pill';
  holdDroneBtn.textContent = 'HOLD [R3]';
  holdDroneBtn.onclick = () => {
    engine.setDroneXY(0, 0, 'toggle');
    syncTop();
  };

  modCol.append(slideBtn, octUpBtn, octDnBtn, holdDroneBtn);
  deck.append(leftCluster, modCol, rightCluster);
  root.append(hdr, stage, deck);
  panelEl.appendChild(root);

  function syncTop() {
    const s = store.getState();
    const d = engine.getDroneState();
    keyBtn.textContent = `KEY ${ROOT_NOTES[s.scaleRoot]}`;
    scaleBtn.textContent = s.scaleId;
    octBtn.textContent = `OCT ${liveRefs.baseOctave}`;
    glideBtn.textContent = `GLIDE ${GLIDE_MODES[liveRefs.glideIdx]}`;
    glideBtn.classList.toggle('active', liveRefs.glideIdx > 0);
    droneBtn.textContent = `DRONE ${d.active ? 'ON' : 'OFF'}`;
    droneBtn.classList.toggle('active', d.active);
    recBtn.textContent = s.isRecording ? '● REC' : '○ REC';
    recBtn.classList.toggle('active', s.isRecording);
    holdDroneBtn.classList.toggle('active', d.hold);
  }

  function updatePads() {
    const octShift = (liveRefs.octUp ? 1 : 0) - (liveRefs.octDown ? 1 : 0);
    padBtns.forEach(({ deg, glyph, el }) => {
      const m = getScaleMidi(deg, octShift);
      el.classList.toggle('active', liveRefs.activeDeg === deg);
      el.innerHTML = `<div class="bc-pad-top"><span>${deg + 1}</span><span>${glyph}</span></div><div class="bc-pad-name">${midiToName(m)}</div>`;
    });
  }

  liveRefs = {
    trackId,
    baseOctave: 3,
    glideIdx: 0,
    slideHold: false,
    octUp: false,
    octDown: false,
    activeDeg: null,
    touchHeldDeg: null,
    lastNoteName: '—',
    padStick: { x: 0, y: 0 },
    touchDroneDrag: false,
    bendCanvas,
    hudCanvas,
    droneCanvas,
    syncTop,
    updatePads
  };

  syncTop();
  updatePads();
  tickLeadOverlay();
}
