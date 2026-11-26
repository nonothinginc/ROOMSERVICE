import { engine } from '../audio/engine.js';
import { store } from '../state/store.js';

const ITEMS = [
  { id: 'ROLL', label: 'ROLL', kind: 'view' },
  { id: 'ARR', label: 'ARR', kind: 'view' },
  { id: 'MIX', label: 'MIX', kind: 'view' },
  { id: 'DSP', label: 'DSP', kind: 'view' },
  { id: 'MPC', label: 'MPC', kind: 'overlay' },
  { id: 'CHORD', label: 'CHORD', kind: 'overlay' },
  { id: 'LEAD', label: 'LEAD', kind: 'overlay' },
  { id: 'LAB', label: 'LAB', kind: 'overlay' }
];

function activateChoice(choice) {
  if (!choice) return;
  const st = store.getState();
  engine.unlock();

  if (choice.kind === 'view') {
    st.detailOverlay = null;
    st.randomizerOpen = false;
    st.devicePickerOpen = false;
    store.setView(choice.id);
    store.emit('overlay', null);
    return;
  }

  if (choice.id === 'LAB') {
    st.detailOverlay = { type: 'lab' };
    store.emit('overlay', st.detailOverlay);
    return;
  }

  if (choice.id === 'MPC') {
    const existing = st.tracks.find((t) => t.inserts[0]?.deviceId === 'drum8');
    const targetId = existing ? existing.id : st.selectedTrackId;
    if (!existing) {
      store.addInsertDevice(targetId, 'drum8');
    } else {
      store.setSelectedTrack(targetId);
    }
    store.setDeviceParam(targetId, 0, 'mode', 1);
    st.detailOverlay = { type: 'mpc', trackId: targetId };
    store.emit('overlay', st.detailOverlay);
    return;
  }

  if (choice.id === 'CHORD') {
    const existing = st.tracks.find((t) => t.inserts[0]?.deviceId === 'brickchord');
    const targetId = existing ? existing.id : st.selectedTrackId;
    if (!existing) {
      store.addInsertDevice(targetId, 'brickchord');
    } else {
      store.setSelectedTrack(targetId);
    }
    st.detailOverlay = { type: 'brickchord', trackId: targetId };
    store.emit('overlay', st.detailOverlay);
    return;
  }

  if (choice.id === 'LEAD') {
    const curDev = st.tracks[st.selectedTrackId]?.inserts[0]?.deviceId;
    if (!['mono303', 'polyfm', 'grain1'].includes(curDev)) {
      const synth = st.tracks.find((t) => ['mono303', 'polyfm', 'grain1'].includes(t.inserts[0]?.deviceId));
      if (synth) store.setSelectedTrack(synth.id);
      else store.addInsertDevice(st.selectedTrackId, 'mono303');
    }
    st.detailOverlay = { type: 'lead', trackId: store.getState().selectedTrackId };
    store.emit('overlay', st.detailOverlay);
  }
}

export function createModeWheel() {
  const backdrop = document.createElement('div');
  backdrop.className = 'mode-wheel-backdrop';
  backdrop.style.display = 'none';

  const canvas = document.createElement('canvas');
  canvas.className = 'mode-wheel-canvas';
  canvas.width = 440;
  canvas.height = 440;
  backdrop.appendChild(canvas);

  const ctx = canvas.getContext('2d');
  let isOpen = false;
  let alpha = 0;
  let selectedIdx = 0;
  let stickX = 0;
  let stickY = 0;
  const smoothScale = ITEMS.map(() => 0);

  function findInitialIdx() {
    const st = store.getState();
    if (st.detailOverlay?.type === 'mpc') return 4;
    if (st.detailOverlay?.type === 'brickchord') return 5;
    if (st.detailOverlay?.type === 'lead') return 6;
    if (st.detailOverlay?.type === 'lab') return 7;
    const idx = ITEMS.findIndex((it) => it.id === st.view);
    return idx >= 0 ? idx : 0;
  }

  function open() {
    isOpen = true;
    selectedIdx = findInitialIdx();
    stickX = 0;
    stickY = 0;
    backdrop.style.display = 'flex';
  }

  function close(commit = true) {
    if (!isOpen) return;
    isOpen = false;
    backdrop.style.display = 'none';
    if (commit) {
      activateChoice(ITEMS[selectedIdx]);
    }
  }

  function updateStick(lx, ly) {
    if (!isOpen) return;
    stickX = lx;
    stickY = ly;
    const mag = Math.hypot(lx, ly);
    if (mag >= 0.34) {
      // Clockwise from North (-ly) matching ITEMS layout
      const deg = (((Math.atan2(lx, -ly) * 180) / Math.PI) + 360) % 360;
      selectedIdx = Math.round(deg / (360 / ITEMS.length)) % ITEMS.length;
    }
  }

  backdrop.addEventListener('pointerdown', (e) => {
    if (e.target === backdrop) {
      close(false);
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const cx = rect.left + rect.width * 0.5;
    const cy = rect.top + rect.height * 0.5;
    const dx = e.clientX - cx;
    const dy = e.clientY - cy;
    const dist = Math.hypot(dx, dy);
    if (dist < rect.width * 0.14) {
      close(false);
      return;
    }
    const deg = (((Math.atan2(dx, -dy) * 180) / Math.PI) + 360) % 360;
    selectedIdx = Math.round(deg / (360 / ITEMS.length)) % ITEMS.length;
    close(true);
  });

  function tick() {
    alpha += ((isOpen ? 1 : 0) - alpha) * 0.24;
    if (!isOpen && alpha < 0.02) {
      backdrop.style.display = 'none';
      return;
    }

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = canvas.getBoundingClientRect();
    const css = rect.width > 40 ? rect.width : 340;
    const pxSize = Math.round(css * dpr);
    if (canvas.width !== pxSize || canvas.height !== pxSize) {
      canvas.width = pxSize;
      canvas.height = pxSize;
    }

    const styles = getComputedStyle(document.documentElement);
    const surface = styles.getPropertyValue('--surface').trim();
    const borderStrong = styles.getPropertyValue('--border-strong').trim();
    const ink = styles.getPropertyValue('--ink').trim();
    const inkDim = styles.getPropertyValue('--ink-dim').trim();
    const accent = styles.getPropertyValue('--accent').trim();

    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, css, css);

    const cx = css * 0.5;
    const cy = css * 0.5;
    const rad = css * 0.34 * (0.85 + 0.15 * alpha);

    ctx.strokeStyle = borderStrong;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, rad, 0, Math.PI * 2);
    ctx.stroke();

    ITEMS.forEach((item, i) => {
      const sel = i === selectedIdx;
      smoothScale[i] += ((sel ? 1 : 0) - smoothScale[i]) * 0.28;
      const s = smoothScale[i];
      const ang = -Math.PI / 2 + (i * Math.PI * 2) / ITEMS.length;
      const ix = cx + Math.cos(ang) * rad;
      const iy = cy + Math.sin(ang) * rad;
      const nodeR = css * (0.088 + 0.018 * s);

      ctx.fillStyle = sel ? accent : surface;
      ctx.strokeStyle = sel ? accent : borderStrong;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(ix, iy, nodeR, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = sel ? '#F2F0EC' : ink;
      ctx.font = `700 ${Math.round(css * 0.032)}px "Geist Mono", monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(item.label, ix, iy);
    });

    // Center crosshair + active stick indicator
    ctx.fillStyle = surface;
    ctx.strokeStyle = borderStrong;
    ctx.beginPath();
    ctx.arc(cx, cy, css * 0.09, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.arc(cx + stickX * (css * 0.065), cy + stickY * (css * 0.065), 5, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = inkDim;
    ctx.font = `700 ${Math.round(css * 0.028)}px "Geist Mono", monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(ITEMS[selectedIdx]?.id || '', cx, cy + css * 0.145);

    ctx.restore();
  }

  return {
    el: backdrop,
    isOpen: () => isOpen,
    open,
    close,
    toggle: () => (isOpen ? close(true) : open()),
    updateStick,
    tick
  };
}
