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
  { id: 'TAPE', label: 'TAPE', kind: 'overlay' }
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

  if (choice.id === 'TAPE') {
    st.detailOverlay = { type: 'tape' };
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
    if (st.detailOverlay?.type === 'tape') return 7;
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
    const bg = styles.getPropertyValue('--bg').trim();
    const border = styles.getPropertyValue('--border').trim();
    const ink = styles.getPropertyValue('--ink').trim();
    const inkDim = styles.getPropertyValue('--ink-dim').trim();
    const accent = styles.getPropertyValue('--accent').trim();
    const font = styles.getPropertyValue('--font').trim() || 'monospace';

    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, css, css);
    ctx.globalAlpha = Math.min(1, alpha * 1.2);

    const cx = css * 0.5;
    const cy = css * 0.5;
    const rad = css * 0.36 * (0.94 + 0.06 * alpha);
    const step = (Math.PI * 2) / ITEMS.length;

    // Hairline ring + sector ticks
    ctx.strokeStyle = border;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, rad * 0.62, 0, Math.PI * 2);
    ctx.stroke();
    for (let i = 0; i < ITEMS.length; i++) {
      const a = -Math.PI / 2 + i * step + step / 2;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * rad * 0.62, cy + Math.sin(a) * rad * 0.62);
      ctx.lineTo(cx + Math.cos(a) * rad * 0.68, cy + Math.sin(a) * rad * 0.68);
      ctx.stroke();
    }

    // Selected-sector accent arc
    const selA = -Math.PI / 2 + selectedIdx * step;
    ctx.strokeStyle = accent;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, rad * 0.62, selA - step * 0.32, selA + step * 0.32);
    ctx.stroke();

    ctx.font = `500 ${Math.max(10, Math.round(css * 0.036))}px ${font}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ITEMS.forEach((item, i) => {
      const sel = i === selectedIdx;
      smoothScale[i] += ((sel ? 1 : 0) - smoothScale[i]) * 0.3;
      const s = smoothScale[i];
      const ang = -Math.PI / 2 + i * step;
      const ix = cx + Math.cos(ang) * rad;
      const iy = cy + Math.sin(ang) * rad;
      if (s > 0.02) {
        const r = css * 0.085 * (0.7 + 0.3 * s);
        ctx.globalAlpha = Math.min(1, alpha * 1.2) * s;
        ctx.fillStyle = ink;
        ctx.beginPath();
        ctx.arc(ix, iy, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = Math.min(1, alpha * 1.2);
      }
      ctx.fillStyle = sel ? bg : inkDim;
      ctx.fillText(item.label, ix, iy + 0.5);
    });

    // Center stick puck
    ctx.fillStyle = ink;
    ctx.beginPath();
    ctx.arc(cx + stickX * rad * 0.42, cy + stickY * rad * 0.42, 3.5, 0, Math.PI * 2);
    ctx.fill();

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
