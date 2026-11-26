/**
 * TAPE: performable master tape machine.
 * Hold to manipulate, release to slip back to the live mix.
 *
 * Touch: STOP / REV / BACK / LOOP hold-pads · drag a reel to scrub · VARI fader (springs to 1×)
 * Gamepad: A stop · B rev · Y back · X loop · L1/R1 loop size · R-stick X varispeed ·
 *          L-stick X scrub · R2 print · SELECT+B close
 */
import { engine } from '../../audio/engine.js';
import { PEAK_BLOCK } from '../../audio/tape-deck.js';
import { BTN } from '../../input/gamepad.js';
import { store } from '../../state/store.js';
import { createRotary } from '../components/rotary.js';
import { SCREEN, drawTransport } from '../tape-art.js';

const LOOP_SIZES = [
  { label: '1/16', beats: 0.25 },
  { label: '1/8', beats: 0.5 },
  { label: '1/4', beats: 1 },
  { label: '1/2', beats: 2 },
  { label: '1', beats: 4 }
];
const TAPE_PX_PER_SEC = 34; // visual tape speed at 1×
const ICON_X = '<svg class="ico" viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8"/></svg>';

let refs = null;

function deck() {
  return engine.tapeDeck;
}

function loopSeconds() {
  const beats = LOOP_SIZES[refs?.loopIdx ?? 2].beats;
  return (beats * 60) / Math.max(40, store.getState().bpm);
}

/** Held-gesture stack: the most recent held control wins; releasing all slips back to live. */
function press(id, mode, opts = {}) {
  if (!refs || !deck()?.telemetry.ready) return;
  engine.unlock();
  refs.held = refs.held.filter((h) => h.id !== id);
  refs.held.push({ id, mode, opts });
  deck().setMode(mode, opts);
  syncPads();
}

function release(id) {
  if (!refs) return;
  refs.held = refs.held.filter((h) => h.id !== id);
  const top = refs.held[refs.held.length - 1];
  if (top) deck().setMode(top.mode, top.opts);
  else deck()?.setMode('live');
  syncPads();
}

function syncPads() {
  if (!refs) return;
  const active = new Set(refs.held.map((h) => h.id));
  for (const [id, el] of Object.entries(refs.pads)) el.classList.toggle('active', active.has(id));
  refs.loopBtns.forEach((b, i) => b.classList.toggle('active', i === refs.loopIdx));
}

function makePad(id, label, hint, mode, getOpts = () => ({})) {
  const b = document.createElement('button');
  b.className = 'tape-pad';
  b.innerHTML = `<span class="tape-pad-lbl">${label}</span><span class="pill-hint">${hint}</span>`;
  b.title = `${label} (hold) [${hint}]`;
  b.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    b.setPointerCapture(e.pointerId);
    press(id, mode, getOpts());
  });
  const up = () => release(id);
  b.addEventListener('pointerup', up);
  b.addEventListener('pointercancel', up);
  return b;
}

export function renderTapeDeckOverlay(panelEl) {
  panelEl.innerHTML = '';
  panelEl.classList.add('tape-panel');
  const st = store.getState();

  const hdr = document.createElement('div');
  hdr.className = 'overlay-hdr';
  const title = document.createElement('span');
  title.innerHTML = 'TAPE <i class="oh-sub">MASTER</i>';
  const actions = document.createElement('div');
  actions.className = 'oh-actions';

  const printBtn = document.createElement('button');
  printBtn.className = 'ctx-chip tape-print';
  printBtn.title = 'Print the deck output to a playlist clip [R2]';
  printBtn.innerHTML = '<span class="rec-dot"></span><span class="tape-print-lbl">PRINT</span>';
  printBtn.onclick = () => togglePrint();

  const closeBtn = document.createElement('button');
  closeBtn.className = 'ctx-chip icon-only';
  closeBtn.innerHTML = ICON_X;
  closeBtn.title = 'Close [SEL+B]';
  closeBtn.onclick = () => {
    st.detailOverlay = null;
    store.emit('overlay', null);
  };
  actions.append(printBtn, closeBtn);
  hdr.append(title, actions);

  const body = document.createElement('div');
  body.className = 'tape-body';

  const screen = document.createElement('div');
  screen.className = 'tape-screen';
  const canvas = document.createElement('canvas');
  screen.appendChild(canvas);

  // Vertical varispeed fader: centre = 1×, top = 2×, bottom = stop. Springs back on release.
  const vari = document.createElement('div');
  vari.className = 'tape-vari';
  vari.innerHTML = '<span class="tape-vari-lbl">2×</span><div class="tape-vari-track"><i class="tape-vari-unity"></i><b class="tape-vari-cap"></b></div><span class="tape-vari-lbl">0</span>';
  const track = vari.querySelector('.tape-vari-track');
  const cap = vari.querySelector('.tape-vari-cap');
  const setCap = (speed) => {
    cap.style.top = `${(1 - speed / 2) * 100}%`;
  };
  setCap(1);
  const variFrom = (e) => {
    const r = track.getBoundingClientRect();
    const t = Math.max(0, Math.min(1, (e.clientY - r.top) / r.height));
    return Math.round((1 - t) * 2 * 50) / 50;
  };
  track.addEventListener('pointerdown', (e) => {
    track.setPointerCapture(e.pointerId);
    const sp = variFrom(e);
    setCap(sp);
    press('vari', 'vari', { speed: sp });
  });
  track.addEventListener('pointermove', (e) => {
    if (!refs?.held.some((h) => h.id === 'vari')) return;
    const sp = variFrom(e);
    setCap(sp);
    deck().setSpeed(sp);
    refs.held.find((h) => h.id === 'vari').opts.speed = sp;
  });
  const variUp = () => {
    setCap(1);
    release('vari');
  };
  track.addEventListener('pointerup', variUp);
  track.addEventListener('pointercancel', variUp);

  const ctrl = document.createElement('div');
  ctrl.className = 'tape-ctrl';
  const pads = {
    stop: makePad('stop', 'STOP', 'A', 'stop'),
    rev: makePad('rev', 'REV', 'B', 'rev'),
    back: makePad('back', 'BACK', 'Y', 'back'),
    loop: makePad('loop', 'LOOP', 'X', 'loop', () => ({ seconds: loopSeconds() }))
  };
  const padRow = document.createElement('div');
  padRow.className = 'tape-pads';
  padRow.append(pads.stop, pads.rev, pads.back, pads.loop);

  const side = document.createElement('div');
  side.className = 'tape-side';
  const loopSeg = document.createElement('div');
  loopSeg.className = 'dsp-seg-bar tape-loop-seg';
  loopSeg.style.gridTemplateColumns = `repeat(${LOOP_SIZES.length}, 1fr)`;
  const loopBtns = LOOP_SIZES.map((sz, i) => {
    const b = document.createElement('button');
    b.className = 'dsp-seg-btn';
    b.textContent = sz.label;
    b.onclick = () => {
      refs.loopIdx = i;
      syncPads();
    };
    loopSeg.appendChild(b);
    return b;
  });
  const knobs = document.createElement('div');
  knobs.className = 'tape-knobs';
  const tone = deck()?.getTone?.() || { age: 0, drive: 0 };
  const ageRot = createRotary({
    param: { id: 'age', label: 'AGE', min: 0, max: 100, default: 0, step: 1, unit: '%' },
    value: Math.round(tone.age * 100),
    size: 34,
    onChange: (v) => deck()?.setTone({ age: v / 100 })
  });
  const driveRot = createRotary({
    param: { id: 'drive', label: 'DRIVE', min: 0, max: 100, default: 0, step: 1, unit: '%' },
    value: Math.round(tone.drive * 100),
    size: 34,
    onChange: (v) => deck()?.setTone({ drive: v / 100 })
  });
  knobs.append(ageRot.el, driveRot.el);
  side.append(loopSeg, knobs);
  ctrl.append(padRow, side);

  body.append(screen, vari, ctrl);
  panelEl.append(hdr, body);

  refs = {
    canvas,
    ctx: canvas.getContext('2d'),
    printBtn,
    pads,
    loopBtns,
    loopIdx: refs?.loopIdx ?? 2,
    held: [],
    angleL: refs?.angleL ?? 0,
    angleR: refs?.angleR ?? 0,
    roller: 0,
    lastT: performance.now(),
    scrub: null,
    geo: null,
    stick: { scrub: false, vari: false }
  };
  syncPads();

  // Drag a reel to scrub: angular velocity of the finger around the hub drives tape speed
  canvas.addEventListener('pointerdown', (e) => {
    const g = refs.geo;
    if (!g) return;
    const r = canvas.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    const onL = Math.hypot(x - g.lx, y - g.cy) < g.R * 1.05;
    const onR = Math.hypot(x - g.rx, y - g.cy) < g.R * 1.05;
    if (!onL && !onR) return;
    canvas.setPointerCapture(e.pointerId);
    const cx = onL ? g.lx : g.rx;
    refs.scrub = { cx, cy: g.cy, packR: onL ? g.packRL : g.packRR, a: Math.atan2(y - g.cy, x - cx), t: performance.now(), speed: 0 };
    press('scrub', 'scrub');
  });
  canvas.addEventListener('pointermove', (e) => {
    const s = refs?.scrub;
    if (!s) return;
    const r = canvas.getBoundingClientRect();
    const a = Math.atan2(e.clientY - r.top - s.cy, e.clientX - r.left - s.cx);
    let da = a - s.a;
    if (da > Math.PI) da -= Math.PI * 2;
    if (da < -Math.PI) da += Math.PI * 2;
    const now = performance.now();
    const dt = Math.max(0.004, (now - s.t) / 1000);
    // Clockwise = forward. ω at 1× = TAPE_PX_PER_SEC / packR
    const speed = Math.max(-4, Math.min(4, (da / dt) / (TAPE_PX_PER_SEC / Math.max(8, s.packR))));
    s.speed = s.speed * 0.6 + speed * 0.4;
    s.a = a;
    s.t = now;
    deck().scrub(s.speed);
  });
  const scrubUp = () => {
    if (!refs?.scrub) return;
    refs.scrub = null;
    release('scrub');
  };
  canvas.addEventListener('pointerup', scrubUp);
  canvas.addEventListener('pointercancel', scrubUp);
}

function togglePrint() {
  const t = deck()?.telemetry;
  if (!t?.ready) return;
  engine.unlock();
  engine.setTapePrint(!t.printing);
}

export function tickTapeDeckOverlay() {
  if (!refs) return;
  const st = store.getState();
  if (st.detailOverlay?.type !== 'tape') {
    // Leaving the deck always returns the master to live
    if (refs.held.length) deck()?.setMode('live');
    refs = null;
    return;
  }
  const t = deck()?.telemetry;
  const { canvas, ctx } = refs;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (w < 10 || h < 10) return;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const now = performance.now();
  const dt = Math.min(0.05, (now - refs.lastT) / 1000);
  refs.lastT = now;

  const v = t?.ready ? t.v : st.isPlaying ? 1 : 0;
  // Transport visibly rests when the song is stopped and nothing is held
  const moving = st.isPlaying || refs.held.length ? v : 0;
  const sr = t?.sampleRate || 48000;
  const posSec = t?.ready ? t.rp / sr : 0;
  // Pack sizes ping-pong over a 3-minute "reel" so they change through a session
  const ph = (posSec / 180) % 2;
  const frac = ph < 1 ? ph : 2 - ph;
  const packL = 0.92 - frac * 0.78;
  const packR = 0.14 + frac * 0.78;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = SCREEN.bg;
  ctx.fillRect(0, 0, w, h);

  const stripH = Math.max(46, h * 0.2);
  const transH = h - stripH - 26;
  const geo = drawTransport(ctx, 10, 22, w - 20, transH, {
    angleL: refs.angleL,
    angleR: refs.angleR,
    packL,
    packR,
    speed: moving,
    rollerAngle: refs.roller,
    headActive: Boolean(t?.printing)
  });
  // Angular velocity = tape speed / pack radius (small pack spins faster)
  refs.angleL += (moving * TAPE_PX_PER_SEC * dt) / Math.max(8, geo.packRL);
  refs.angleR += (moving * TAPE_PX_PER_SEC * dt) / Math.max(8, geo.packRR);
  refs.roller += (moving * TAPE_PX_PER_SEC * dt) / 3;
  refs.geo = geo;

  // Top readouts
  ctx.font = '500 10px Geist Mono, monospace';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = SCREEN.dim;
  ctx.textAlign = 'left';
  const behind = t?.ready ? Math.max(0, (t.wp - t.rp) / sr) : 0;
  const modeLbl = t?.ready ? (t.mode === 'loop' ? `LOOP ${LOOP_SIZES[refs.loopIdx].label}` : t.mode === 'live' ? 'LIVE' : t.mode.toUpperCase()) : '—';
  ctx.fillText(modeLbl, 12, 12);
  ctx.textAlign = 'right';
  ctx.fillStyle = Math.abs(v - 1) > 0.01 && t?.mode !== 'live' ? SCREEN.ink : SCREEN.dim;
  ctx.fillText(`${v.toFixed(2)}×`, w - 12, 12);
  ctx.textAlign = 'center';
  if (behind > 0.05 && t?.mode !== 'live') {
    ctx.fillStyle = SCREEN.dim;
    ctx.fillText(`−${behind.toFixed(2)}s`, w / 2, 12);
  }
  if (t?.printing) {
    ctx.fillStyle = SCREEN.accent;
    ctx.fillText(`● ${(t.printFrames / sr).toFixed(1)}s`, w / 2, 12);
  }

  // Tape strip: waveform passing the head (centre), ~4 s window
  const sy = h - stripH - 4;
  ctx.fillStyle = '#111113';
  ctx.fillRect(10, sy, w - 20, stripH);
  const mid = sy + stripH / 2;
  const span = 4 * sr;
  const pxPerSample = (w - 20) / span;
  if (t?.ready) {
    const headX = w / 2;
    const startS = t.rp - span / 2;
    const step = 2;
    for (let px = 10; px < w - 10; px += step) {
      const sAbs = startS + (px - 10) / pxPerSample;
      const blk = Math.floor(sAbs / PEAK_BLOCK);
      const pk = deck().peakAt(blk);
      if (pk <= 0) continue;
      const hh = Math.max(0.5, pk * (stripH * 0.46));
      ctx.fillStyle = sAbs > t.rp ? SCREEN.faint : SCREEN.ink;
      ctx.fillRect(px, mid - hh, 1, hh * 2);
    }
    // Loop window
    if (t.mode === 'loop' && t.loopLen > 0) {
      const lx0 = headX + (t.loopA - t.rp) * pxPerSample;
      const lx1 = lx0 + t.loopLen * pxPerSample;
      ctx.fillStyle = 'rgba(237,235,230,0.07)';
      ctx.fillRect(Math.max(10, lx0), sy, Math.min(w - 10, lx1) - Math.max(10, lx0), stripH);
      ctx.fillStyle = SCREEN.ink;
      ctx.fillRect(lx0, sy, 1, stripH);
      ctx.fillRect(lx1, sy, 1, stripH);
    }
    // Live write head (shows how far behind the tape is)
    const wx = headX + (t.wp - t.rp) * pxPerSample;
    if (wx < w - 10 && wx > headX + 2) {
      ctx.fillStyle = SCREEN.accent;
      ctx.fillRect(wx, sy, 1, stripH);
    }
    // Play head
    ctx.fillStyle = SCREEN.accent;
    ctx.fillRect(headX - 0.5, sy - 4, 1.5, stripH + 8);
  } else {
    ctx.fillStyle = SCREEN.dim;
    ctx.textAlign = 'center';
    ctx.fillText('LOADING', w / 2, mid);
  }

  // Print button state
  const printing = Boolean(t?.printing);
  refs.printBtn.classList.toggle('active', printing);
}

/** Raw gamepad passthrough while the TAPE overlay is open. */
export function handleTapeRawPad(pad) {
  if (!refs) return;
  const { buttons, prevButtons, axes } = pad;
  const jp = (i) => buttons[i] && !prevButtons[i];
  const jr = (i) => !buttons[i] && prevButtons[i];
  const map = [
    [BTN.A, 'stop', 'stop'],
    [BTN.B, 'rev', 'rev'],
    [BTN.Y, 'back', 'back'],
    [BTN.X, 'loop', 'loop']
  ];
  if (buttons[BTN.SELECT]) return;
  for (const [btn, id, mode] of map) {
    if (jp(btn)) press(id, mode, mode === 'loop' ? { seconds: loopSeconds() } : {});
    if (jr(btn)) release(id);
  }
  if (jp(BTN.L1)) {
    refs.loopIdx = Math.max(0, refs.loopIdx - 1);
    syncPads();
  }
  if (jp(BTN.R1)) {
    refs.loopIdx = Math.min(LOOP_SIZES.length - 1, refs.loopIdx + 1);
    syncPads();
  }
  if (jp(BTN.R2)) togglePrint();

  const [lx, , rx] = axes;
  const dz = 0.18;
  // Right stick X: varispeed around 1× while deflected
  if (Math.abs(rx) > dz) {
    const sp = Math.max(0, Math.min(2, 1 + rx));
    if (!refs.stick.vari) {
      refs.stick.vari = true;
      press('pad-vari', 'vari', { speed: sp });
    } else deck().setSpeed(sp);
  } else if (refs.stick.vari) {
    refs.stick.vari = false;
    release('pad-vari');
  }
  // Left stick X: scrub (hand on the reel)
  if (Math.abs(lx) > dz) {
    if (!refs.stick.scrub) {
      refs.stick.scrub = true;
      press('pad-scrub', 'scrub');
    }
    deck().scrub(lx * 3);
  } else if (refs.stick.scrub) {
    refs.stick.scrub = false;
    release('pad-scrub');
  }
}
