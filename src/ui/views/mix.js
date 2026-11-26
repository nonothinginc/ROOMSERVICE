import { dbToMeterNorm, engine } from '../../audio/engine.js';
import { getDevice, getDevicesByCategory } from '../../device-registry.js';
import { store } from '../../state/store.js';
import { attachLongPress } from '../components/longpress.js';
import { createRotary } from '../components/rotary.js';

function gainToDbText(gain) {
  if (gain <= 0.004) return '-INF';
  const db = 20 * Math.log10(gain);
  return `${db >= 0 ? '+' : ''}${db.toFixed(1)}`;
}

function normToGain(norm) {
  const n = Math.max(0, Math.min(1, norm));
  if (n <= 0.008) return 0;
  if (n <= 0.87) {
    const db = -48 * Math.pow(1 - (n - 0.008) / (0.87 - 0.008), 1.45);
    return Math.pow(10, db / 20);
  }
  const db = ((n - 0.87) / (1 - 0.87)) * 3.0;
  return Math.pow(10, db / 20);
}

function gainToNorm(gain) {
  if (gain <= 0.004) return 0;
  const db = 20 * Math.log10(gain);
  if (db <= 0) {
    const ratio = Math.max(0, Math.min(1, -db / 48));
    return Math.max(0, 0.87 - Math.pow(ratio, 1 / 1.45) * (0.87 - 0.008));
  }
  return Math.min(1, 0.87 + (db / 3.0) * (1 - 0.87));
}

function createMeterState() {
  return {
    peakL: 0,
    peakR: 0,
    rmsL: 0,
    rmsR: 0,
    holdL: 0,
    holdR: 0,
    holdAtL: 0,
    holdAtR: 0,
    peakDbHold: -60,
    peakDbAt: 0,
    clipLatched: false,
    grHold: 0
  };
}

const METER_TICKS_DB = [0, -6, -12, -24];

function drawStudioMeter(canvas, info, mState, isMaster = false) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const rect = canvas.getBoundingClientRect();
  const cssW = rect.width || (isMaster ? 32 : 18);
  const cssH = rect.height || 180;
  const w = Math.max(12, Math.round(cssW * dpr));
  const h = Math.max(40, Math.round(cssH * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }

  const now = performance.now();
  const normPkL = dbToMeterNorm(info.peakDbL);
  const normPkR = dbToMeterNorm(info.peakDbR);
  const normRmL = dbToMeterNorm(info.rmsDbL);
  const normRmR = dbToMeterNorm(info.rmsDbR);

  // Fast attack, calibrated ballistic decay (~18 dB/s)
  mState.peakL = normPkL >= mState.peakL ? normPkL : Math.max(0, mState.peakL - 0.015);
  mState.peakR = normPkR >= mState.peakR ? normPkR : Math.max(0, mState.peakR - 0.015);
  mState.rmsL = normRmL >= mState.rmsL ? mState.rmsL + (normRmL - mState.rmsL) * 0.45 : Math.max(0, mState.rmsL - 0.01);
  mState.rmsR = normRmR >= mState.rmsR ? mState.rmsR + (normRmR - mState.rmsR) * 0.45 : Math.max(0, mState.rmsR - 0.01);

  if (normPkL >= mState.holdL) {
    mState.holdL = normPkL;
    mState.holdAtL = now;
  } else if (now - mState.holdAtL > 1200) {
    mState.holdL = Math.max(mState.peakL, mState.holdL - 0.012);
  }

  if (normPkR >= mState.holdR) {
    mState.holdR = normPkR;
    mState.holdAtR = now;
  } else if (now - mState.holdAtR > 1200) {
    mState.holdR = Math.max(mState.peakR, mState.holdR - 0.012);
  }

  if (info.peakDb >= mState.peakDbHold) {
    mState.peakDbHold = info.peakDb;
    mState.peakDbAt = now;
  } else if (now - mState.peakDbAt > 1400) {
    mState.peakDbHold = Math.max(info.peakDb, mState.peakDbHold - 0.35);
  }

  if (info.clip) mState.clipLatched = true;
  if (isMaster) {
    const gr = info.grDb || 0;
    mState.grHold = gr >= mState.grHold ? gr : Math.max(0, mState.grHold - 0.25);
  }

  const ctx = canvas.getContext('2d');
  const styles = getComputedStyle(document.documentElement);
  const bg = styles.getPropertyValue('--surface-recessed').trim() || styles.getPropertyValue('--bg').trim();
  const border = styles.getPropertyValue('--border').trim();
  const ink = styles.getPropertyValue('--ink').trim();
  const accent = styles.getPropertyValue('--accent').trim();
  const isLight = document.documentElement.getAttribute('data-theme') === 'light';
  const amber = isLight ? '#B87200' : '#E5A035';

  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = bg;
  ctx.beginPath();
  ctx.roundRect(0, 0, w, h, Math.round(3 * dpr));
  ctx.fill();

  const padY = Math.round(4 * dpr);
  const padX = Math.round(2 * dpr);
  const plotH = Math.max(20, h - padY * 2);

  // Calibrated dB gridlines aligned with IEC breakpoints
  ctx.strokeStyle = border;
  ctx.lineWidth = Math.max(1, Math.round(dpr));
  for (const db of METER_TICKS_DB) {
    const norm = dbToMeterNorm(db);
    const y = Math.round(padY + (1 - norm) * plotH) + 0.5;
    ctx.beginPath();
    ctx.moveTo(padX, y);
    ctx.lineTo(w - padX, y);
    ctx.stroke();
  }

  const drawZones = (x, colW, normTop, alpha) => {
    if (normTop <= 0.005) return;
    const norm12 = 0.60; // -12 dB
    const norm3 = 0.89; // -3 dB
    const zones = [
      { lo: 0, hi: norm12, color: ink },
      { lo: norm12, hi: norm3, color: amber },
      { lo: norm3, hi: 1.0, color: accent }
    ];
    ctx.save();
    ctx.globalAlpha = alpha;
    for (const z of zones) {
      const a = Math.max(z.lo, 0);
      const b = Math.min(z.hi, normTop);
      if (b <= a) continue;
      const yTop = padY + (1 - b) * plotH;
      const yBot = padY + (1 - a) * plotH;
      ctx.fillStyle = z.color;
      ctx.fillRect(x, yTop, colW, Math.max(1, yBot - yTop));
    }
    ctx.restore();
  };

  const drawChannelBar = (x, colW, peakN, rmsN, holdN) => {
    // Peak halo behind RMS body
    drawZones(x, colW, peakN, 0.36);
    // Solid RMS energy body
    drawZones(x, colW, rmsN, 0.94);
    // Crisp 2px peak-hold indicator
    if (holdN > 0.02) {
      const hy = Math.round(padY + (1 - Math.min(1, holdN)) * plotH);
      ctx.fillStyle = holdN >= 0.89 ? accent : holdN >= 0.60 ? amber : ink;
      ctx.fillRect(x, Math.max(padY, hy - Math.round(dpr)), colW, Math.max(2, Math.round(2 * dpr)));
    }
  };

  const gap = Math.max(2, Math.round(2 * dpr));
  if (isMaster) {
    const grW = Math.max(3, Math.round(4 * dpr));
    const barsW = w - padX * 2 - grW - gap * 2;
    const colW = Math.max(3, Math.floor(barsW / 2));
    drawChannelBar(padX, colW, mState.peakL, mState.rmsL, mState.holdL);
    drawChannelBar(padX + colW + gap, colW, mState.peakR, mState.rmsR, mState.holdR);

    // Top-down limiter Gain Reduction (GR) meter
    const grX = padX + colW * 2 + gap * 2;
    ctx.fillStyle = border;
    ctx.fillRect(grX, padY, grW, plotH);
    const grNorm = Math.min(1, mState.grHold / 12);
    if (grNorm > 0.01) {
      ctx.fillStyle = accent;
      ctx.fillRect(grX, padY, grW, Math.max(2, grNorm * plotH));
    }
  } else {
    const colW = Math.max(3, Math.floor((w - padX * 2 - gap) / 2));
    drawChannelBar(padX, colW, mState.peakL, mState.rmsL, mState.holdL);
    drawChannelBar(padX + colW + gap, colW, mState.peakR, mState.rmsR, mState.holdR);
  }
}

export function createMixView() {
  const root = document.createElement('div');
  root.className = 'view-root';

  const shell = document.createElement('div');
  shell.className = 'mix-shell';

  const mainCol = document.createElement('div');
  mainCol.className = 'mix-main-col';

  const grid = document.createElement('div');
  grid.className = 'mix-grid';

  const scrollRail = document.createElement('div');
  scrollRail.className = 'mix-scroll-rail';
  const scrollThumb = document.createElement('div');
  scrollThumb.className = 'mix-scroll-thumb';
  scrollRail.appendChild(scrollThumb);

  mainCol.append(grid, scrollRail);

  const masterDock = document.createElement('div');
  masterDock.className = 'mix-master-dock';

  shell.append(mainCol, masterDock);
  root.appendChild(shell);

  const stripRefs = [];
  const meterStates = Array.from({ length: 11 }, () => createMeterState());
  let returnARef = null;
  let returnBRef = null;
  let masterRef = null;
  let glideRaf = 0;
  let lastRailKey = '';

  function updateScrollRail() {
    const sw = grid.scrollWidth;
    const cw = grid.clientWidth;
    const sl = grid.scrollLeft;
    const key = `${sw}:${cw}:${Math.round(sl)}`;
    if (key === lastRailKey) return;
    lastRailKey = key;

    if (cw <= 0 || sw <= cw + 2) {
      scrollRail.style.display = 'none';
      return;
    }
    scrollRail.style.display = 'block';
    const maxScroll = sw - cw;
    const thumbPct = Math.max(12, (cw / sw) * 100);
    const leftPct = (sl / maxScroll) * (100 - thumbPct);
    scrollThumb.style.width = `${thumbPct}%`;
    scrollThumb.style.left = `${leftPct}%`;
  }

  function stopGlide() {
    if (glideRaf) {
      cancelAnimationFrame(glideRaf);
      glideRaf = 0;
    }
  }

  function attachHeaderPan(hdrEl, onTap) {
    let panning = false;
    let moved = false;
    let startX = 0;
    let startScroll = 0;
    let lastX = 0;
    let lastTime = 0;
    let vx = 0;

    hdrEl.addEventListener('pointerdown', (e) => {
      if (e.button && e.button !== 0) return;
      stopGlide();
      panning = true;
      moved = false;
      startX = e.clientX;
      lastX = e.clientX;
      lastTime = performance.now();
      startScroll = grid.scrollLeft;
      vx = 0;
      hdrEl.setPointerCapture(e.pointerId);
    });

    hdrEl.addEventListener('pointermove', (e) => {
      if (!panning) return;
      const dx = e.clientX - startX;
      if (!moved && Math.abs(dx) > 6) {
        moved = true;
        grid.classList.add('is-panning');
        scrollRail.classList.add('active');
      }
      if (!moved) return;
      grid.scrollLeft = startScroll - dx;
      const now = performance.now();
      const dt = Math.max(1, now - lastTime);
      const instVx = (lastX - e.clientX) / dt;
      vx = vx * 0.55 + instVx * 0.45;
      lastX = e.clientX;
      lastTime = now;
      updateScrollRail();
    });

    function finishPan() {
      if (!panning) return;
      panning = false;
      grid.classList.remove('is-panning');
      scrollRail.classList.remove('active');
      if (!moved && onTap) {
        onTap();
        return;
      }
      if (moved && Math.abs(vx) > 0.08) {
        let vel = vx * 16;
        const stepGlide = () => {
          grid.scrollLeft += vel;
          vel *= 0.92;
          updateScrollRail();
          if (Math.abs(vel) > 0.35) {
            glideRaf = requestAnimationFrame(stepGlide);
          } else {
            glideRaf = 0;
          }
        };
        glideRaf = requestAnimationFrame(stepGlide);
      }
    }

    hdrEl.addEventListener('pointerup', finishPan);
    hdrEl.addEventListener('pointercancel', finishPan);
  }

  grid.addEventListener('scroll', updateScrollRail, { passive: true });
  window.addEventListener('resize', updateScrollRail);

  function attachFader(trackEl, label, getVal, setVal) {
    let dragging = false;
    function updateFromY(clientY) {
      const rect = trackEl.getBoundingClientRect();
      const norm = Math.max(0, Math.min(1, 1 - (clientY - rect.top) / rect.height));
      const val = normToGain(norm);
      if (Math.abs(val - getVal()) > 0.002) {
        store.markGestureDirty();
        setVal(val);
      }
    }
    trackEl.addEventListener('pointerdown', (e) => {
      engine.unlock();
      dragging = true;
      store.beginGesture(label);
      updateFromY(e.clientY);
      trackEl.setPointerCapture(e.pointerId);
    });
    trackEl.addEventListener('pointermove', (e) => {
      if (dragging) updateFromY(e.clientY);
    });
    trackEl.addEventListener('pointerup', () => {
      if (dragging) {
        dragging = false;
        store.commitGesture();
      }
    });
    trackEl.addEventListener('pointercancel', () => {
      if (dragging) {
        dragging = false;
        store.commitGesture();
      }
    });
  }

  function buildStrip({ code, name, isChannel, trackId, meterIdx, isMaster = false }) {
    const el = document.createElement('div');
    el.className = 'mix-strip';

    const statusDot = document.createElement('div');
    statusDot.className = 'mix-status-dot';
    el.appendChild(statusDot);

    const hdr = document.createElement('div');
    hdr.className = 'mix-hdr';
    hdr.innerHTML = `<span class="mix-code">${code}</span><span class="mix-name">${name}</span>`;

    if (isChannel) {
      el.addEventListener('pointerdown', () => {
        store.setSelectedTrack(trackId);
      });
      attachHeaderPan(hdr, () => {
        store.getState().detailOverlay = { type: 'mix-rename', trackId };
        store.emit('overlay', store.getState().detailOverlay);
      });
    } else if (!isMaster) {
      attachHeaderPan(hdr, null);
    } else {
      attachLongPress(hdr, () => {
        store.getState().detailOverlay = { type: 'mix', trackId: null };
        store.emit('overlay', store.getState().detailOverlay);
      });
    }

    const sends = document.createElement('div');
    sends.className = 'mix-sends';
    let sendARot = null;
    let sendBRot = null;
    let panRot = null;
    let extraRot = null;

    if (isChannel) {
      const tr = store.getState().tracks[trackId];
      sendARot = createRotary({
        param: { id: 'sendA', label: 'A', min: 0, max: 1, default: 0, step: 0.02, unit: '' },
        value: tr.sendA,
        size: 26,
        compact: true,
        onGestureStart: () => store.beginGesture(`${tr.code} SND A`),
        onGestureEnd: () => store.commitGesture(),
        onChange: (v) => store.setTrackParam(trackId, 'sendA', v)
      });
      sendBRot = createRotary({
        param: { id: 'sendB', label: 'B', min: 0, max: 1, default: 0, step: 0.02, unit: '' },
        value: tr.sendB,
        size: 26,
        compact: true,
        onGestureStart: () => store.beginGesture(`${tr.code} SND B`),
        onGestureEnd: () => store.commitGesture(),
        onChange: (v) => store.setTrackParam(trackId, 'sendB', v)
      });
      panRot = createRotary({
        param: { id: 'pan', label: 'P', min: -1, max: 1, default: 0, step: 0.02, unit: '' },
        value: tr.pan,
        size: 26,
        compact: true,
        onGestureStart: () => store.beginGesture(`${tr.code} PAN`),
        onGestureEnd: () => store.commitGesture(),
        onChange: (v) => store.setTrackParam(trackId, 'pan', v)
      });
      sends.append(sendARot.el, sendBRot.el, panRot.el);
    } else if (code === 'SND A' || code === 'SND B') {
      const key = code === 'SND A' ? 'sendA' : 'sendB';
      const ret = store.getState().returns[key];
      const pId = key === 'sendA' ? 'feedback' : 'decay';
      extraRot = createRotary({
        param: { id: pId, label: key === 'sendA' ? 'FDBK' : 'DEC', min: 0.1, max: 0.94, default: ret.params[pId], step: 0.02, unit: '' },
        value: ret.params[pId],
        size: 34,
        compact: true,
        onGestureStart: () => store.beginGesture(`${code} ${pId.toUpperCase()}`),
        onGestureEnd: () => store.commitGesture(),
        onChange: (v) => store.setReturnParam(key, pId, v)
      });
      sends.appendChild(extraRot.el);
    } else {
      extraRot = createRotary({
        param: { id: 'ceil', label: 'LIM', min: -12, max: 0, default: -0.5, step: 0.5, unit: 'dB' },
        value: store.getState().master.limiterCeiling,
        size: 34,
        compact: true,
        onGestureStart: () => store.beginGesture('LIM CEIL'),
        onGestureEnd: () => store.commitGesture(),
        onChange: (v) => {
          store.markGestureDirty();
          engine.setLimiterCeiling(v);
        }
      });
      sends.appendChild(extraRot.el);
    }
    el.appendChild(sends);

    // FX Access Button per channel / return strip
    let fxBtn = null;
    if (isChannel) {
      fxBtn = document.createElement('button');
      fxBtn.className = 'mix-fx-btn';
      fxBtn.title = 'Channel FX Chain';
      fxBtn.onclick = (e) => {
        e.stopPropagation();
        store.setSelectedTrack(trackId);
        store.getState().detailOverlay = { type: 'mix-fx', trackId };
        store.emit('overlay', store.getState().detailOverlay);
      };
      el.appendChild(fxBtn);
    } else if (code === 'SND A' || code === 'SND B') {
      const key = code === 'SND A' ? 'sendA' : 'sendB';
      fxBtn = document.createElement('button');
      fxBtn.className = 'mix-fx-btn';
      fxBtn.textContent = 'FX';
      fxBtn.onclick = (e) => {
        e.stopPropagation();
        store.getState().detailOverlay = { type: 'mix-return-fx', returnKey: key };
        store.emit('overlay', store.getState().detailOverlay);
      };
      el.appendChild(fxBtn);
    } else {
      const punchBtn = document.createElement('button');
      punchBtn.className = 'mix-fx-btn';
      punchBtn.textContent = 'PUNCH';
      punchBtn.title = 'Master Right-Stick Punch-In FX [R2+R-Stick]';
      punchBtn.onclick = (e) => {
        e.stopPropagation();
        store.getState().detailOverlay = { type: 'punch' };
        store.emit('overlay', store.getState().detailOverlay);
      };
      el.appendChild(punchBtn);
    }

    const ms = document.createElement('div');
    ms.className = 'mix-ms';
    let muteBtn = null;
    let soloBtn = null;
    if (isChannel) {
      muteBtn = document.createElement('button');
      muteBtn.className = 'ms-btn mute';
      muteBtn.textContent = 'M';
      muteBtn.onclick = (e) => {
        e.stopPropagation();
        const tr = store.getState().tracks[trackId];
        store.pushHistory(`${tr.code} MUTE`);
        store.setTrackParam(trackId, 'mute', !tr.mute);
      };
      soloBtn = document.createElement('button');
      soloBtn.className = 'ms-btn solo';
      soloBtn.textContent = 'S';
      soloBtn.onclick = (e) => {
        e.stopPropagation();
        const tr = store.getState().tracks[trackId];
        store.pushHistory(`${tr.code} SOLO`);
        store.setTrackParam(trackId, 'solo', !tr.solo);
      };
      ms.append(muteBtn, soloBtn);
    } else if (code === 'SND A' || code === 'SND B') {
      const key = code === 'SND A' ? 'sendA' : 'sendB';
      muteBtn = document.createElement('button');
      muteBtn.className = 'ms-btn mute';
      muteBtn.textContent = 'M';
      muteBtn.onclick = () => {
        store.pushHistory(`${code} MUTE`);
        engine.toggleReturnMute(key);
        sync();
      };
      ms.appendChild(muteBtn);
    } else {
      const tag = document.createElement('span');
      tag.className = 'mix-code';
      tag.textContent = 'MST BUS';
      ms.appendChild(tag);
    }
    el.appendChild(ms);

    // Interactive Peak dBFS / Clip Latch Readout
    const peakBadge = document.createElement('button');
    peakBadge.className = 'mix-peak-badge';
    peakBadge.textContent = '---';
    peakBadge.title = 'Tap to reset peak & clip';
    peakBadge.onclick = (e) => {
      e.stopPropagation();
      const msState = meterStates[meterIdx];
      if (msState) {
        msState.clipLatched = false;
        msState.peakDbHold = -60;
        msState.holdL = 0;
        msState.holdR = 0;
        msState.grHold = 0;
      }
      peakBadge.classList.remove('clip', 'warm');
      peakBadge.textContent = '---';
    };
    el.appendChild(peakBadge);

    const faderArea = document.createElement('div');
    faderArea.className = 'mix-fader-area';

    const scaleCol = document.createElement('div');
    scaleCol.className = 'fader-scale';
    ['0', '-6', '-12', '-24', '-48'].forEach((mark) => {
      const s = document.createElement('span');
      s.textContent = mark;
      scaleCol.appendChild(s);
    });

    const faderTrack = document.createElement('div');
    faderTrack.className = 'fader-track';
    const faderUnity = document.createElement('div');
    faderUnity.className = 'fader-unity-tick';
    const faderCap = document.createElement('div');
    faderCap.className = 'fader-cap';
    faderTrack.append(faderUnity, faderCap);

    const meterCanvas = document.createElement('canvas');
    meterCanvas.className = `meter-canvas ${isMaster ? 'is-stereo' : ''}`;
    meterCanvas.width = isMaster ? 32 : 18;
    meterCanvas.height = 200;
    faderArea.append(scaleCol, faderTrack, meterCanvas);
    el.appendChild(faderArea);

    const dbEl = document.createElement('div');
    dbEl.className = 'mix-db';
    dbEl.textContent = '0.0';
    el.appendChild(dbEl);
    el.appendChild(hdr);

    return {
      el,
      hdr,
      fxBtn,
      peakBadge,
      faderTrack,
      faderCap,
      meterCanvas,
      dbEl,
      muteBtn,
      soloBtn,
      sendARot,
      sendBRot,
      panRot,
      extraRot
    };
  }

  // 8 Channels
  for (let i = 0; i < 8; i++) {
    const tr = store.getState().tracks[i];
    const ref = buildStrip({ code: tr.code, name: tr.name, isChannel: true, trackId: i, meterIdx: i });
    attachFader(
      ref.faderTrack,
      `${tr.code} VOL`,
      () => store.getState().tracks[i].volume,
      (v) => store.setTrackParam(i, 'volume', v)
    );
    stripRefs.push(ref);
    grid.appendChild(ref.el);
  }

  const sep = document.createElement('div');
  sep.className = 'mix-sep';
  grid.appendChild(sep);

  returnARef = buildStrip({ code: 'SND A', name: 'DELAY', isChannel: false, meterIdx: 8 });
  attachFader(
    returnARef.faderTrack,
    'SND A VOL',
    () => store.getState().returns.sendA.volume,
    (v) => {
      engine.setReturnVolume('sendA', v);
      sync();
    }
  );
  grid.appendChild(returnARef.el);

  returnBRef = buildStrip({ code: 'SND B', name: 'VERB', isChannel: false, meterIdx: 9 });
  attachFader(
    returnBRef.faderTrack,
    'SND B VOL',
    () => store.getState().returns.sendB.volume,
    (v) => {
      engine.setReturnVolume('sendB', v);
      sync();
    }
  );
  grid.appendChild(returnBRef.el);

  masterRef = buildStrip({ code: 'MST', name: 'MASTER', isChannel: false, meterIdx: 10, isMaster: true });
  masterRef.el.classList.add('is-master');
  attachFader(
    masterRef.faderTrack,
    'MASTER VOL',
    () => store.getState().master.volume,
    (v) => {
      engine.setMasterVolume(v);
      sync();
    }
  );
  masterDock.appendChild(masterRef.el);

  function updateCap(ref, vol) {
    const pct = gainToNorm(vol);
    ref.faderCap.style.top = `${(1 - pct) * 86 + 7}%`;
    ref.dbEl.textContent = gainToDbText(vol);
  }

  function renderFxBadge(btn, tr) {
    if (!btn || !tr) return;
    const fxSlots = tr.inserts.slice(1);
    const activeCount = fxSlots.filter((s) => !s.bypass).length;
    btn.classList.toggle('has-fx', activeCount > 0);
    const pips = fxSlots
      .slice(0, 5)
      .map((s) => `<i class="${s.bypass ? 'byp' : 'on'}"></i>`)
      .join('');
    btn.innerHTML = `<span>FX${fxSlots.length}</span>${pips ? `<span class="fx-pips">${pips}</span>` : ''}`;
  }

  function sync() {
    const st = store.getState();
    for (let i = 0; i < 8; i++) {
      const tr = st.tracks[i];
      const ref = stripRefs[i];
      ref.el.classList.toggle('selected', st.selectedTrackId === i);
      ref.hdr.querySelector('.mix-name').textContent = tr.name;
      ref.muteBtn.classList.toggle('active', tr.mute);
      ref.soloBtn.classList.toggle('active', tr.solo);
      ref.sendARot?.setValue(tr.sendA);
      ref.sendBRot?.setValue(tr.sendB);
      ref.panRot?.setValue(tr.pan);
      renderFxBadge(ref.fxBtn, tr);
      updateCap(ref, tr.volume);
    }
    returnARef.muteBtn.classList.toggle('active', st.returns.sendA.mute);
    returnARef.extraRot?.setValue(st.returns.sendA.params.feedback);
    updateCap(returnARef, st.returns.sendA.volume);
    returnBRef.muteBtn.classList.toggle('active', st.returns.sendB.mute);
    returnBRef.extraRot?.setValue(st.returns.sendB.params.decay);
    updateCap(returnBRef, st.returns.sendB.volume);
    masterRef.extraRot?.setValue(st.master.limiterCeiling);
    updateCap(masterRef, st.master.volume);
    updateScrollRail();
  }

  store.subscribe(sync);
  sync();

  function handleAction(action) {
    const st = store.getState();
    if (st.view !== 'MIX' || st.detailOverlay) return;
    const tid = st.selectedTrackId;
    const tr = st.tracks[tid];

    if (action.type === 'DPAD') {
      if (action.dir === 'LEFT' || action.dir === 'RIGHT') {
        const nextId = (tid + (action.dir === 'LEFT' ? 7 : 1)) % 8;
        store.setSelectedTrack(nextId);
        stripRefs[nextId]?.el.scrollIntoView({ behavior: 'smooth', inline: 'nearest', block: 'nearest' });
      }
      if (action.dir === 'UP') {
        store.pushHistoryCoalesced(`mix-vol-${tid}`, `${tr.code} VOL`);
        store.setTrackParam(tid, 'volume', Math.min(1.15, tr.volume + 0.05));
      }
      if (action.dir === 'DOWN') {
        store.pushHistoryCoalesced(`mix-vol-${tid}`, `${tr.code} VOL`);
        store.setTrackParam(tid, 'volume', Math.max(0, tr.volume - 0.05));
      }
    } else if (action.type === 'A_TAP') {
      store.pushHistory(`${tr.code} MUTE`);
      store.setTrackParam(tid, 'mute', !tr.mute);
    } else if (action.type === 'A_HOLD') {
      st.detailOverlay = { type: 'mix-fx', trackId: tid };
      store.emit('overlay', st.detailOverlay);
    } else if (action.type === 'X') {
      store.pushHistory(`${tr.code} SOLO`);
      store.setTrackParam(tid, 'solo', !tr.solo);
    } else if (action.type === 'STICKS') {
      if (action.ry) {
        store.pushHistoryCoalesced(`mix-vol-${tid}`, `${tr.code} VOL`);
        const mult = action.fine ? 0.005 : 0.02;
        store.setTrackParam(tid, 'volume', Math.max(0, Math.min(1.15, tr.volume - action.ry * mult)));
      }
    }
  }

  function updatePeakBadge(badgeEl, mState, isMaster = false) {
    if (!badgeEl) return;
    if (mState.clipLatched) {
      badgeEl.classList.add('clip');
      badgeEl.classList.remove('warm');
      badgeEl.textContent = 'CLIP';
      return;
    }
    badgeEl.classList.remove('clip');
    if (isMaster && mState.grHold >= 0.4) {
      badgeEl.classList.add('warm');
      badgeEl.textContent = `GR-${mState.grHold.toFixed(1)}`;
      return;
    }
    const db = mState.peakDbHold;
    badgeEl.classList.toggle('warm', db >= -6);
    if (db <= -57) {
      badgeEl.textContent = '---';
    } else {
      badgeEl.textContent = `${db >= 0 ? '+' : ''}${db.toFixed(1)}`;
    }
  }

  function tick() {
    updateScrollRail();
    for (let i = 0; i < 8; i++) {
      const info = engine.getTrackMeterInfo(i);
      drawStudioMeter(stripRefs[i].meterCanvas, info, meterStates[i], false);
      updatePeakBadge(stripRefs[i].peakBadge, meterStates[i], false);
    }
    const infoA = engine.getReturnMeterInfo('sendA');
    drawStudioMeter(returnARef.meterCanvas, infoA, meterStates[8], false);
    updatePeakBadge(returnARef.peakBadge, meterStates[8], false);

    const infoB = engine.getReturnMeterInfo('sendB');
    drawStudioMeter(returnBRef.meterCanvas, infoB, meterStates[9], false);
    updatePeakBadge(returnBRef.peakBadge, meterStates[9], false);

    const infoM = engine.getMasterMeterInfo();
    drawStudioMeter(masterRef.meterCanvas, infoM, meterStates[10], true);
    updatePeakBadge(masterRef.peakBadge, meterStates[10], true);
  }

  function renderTrackRenameModal(modalEl) {
    const st = store.getState();
    const tid = st.detailOverlay?.trackId ?? st.selectedTrackId;
    const tr = st.tracks[tid];
    const close = () => {
      st.detailOverlay = null;
      store.emit('overlay', null);
    };
    if (!tr) {
      close();
      return;
    }

    const hdr = document.createElement('div');
    hdr.className = 'overlay-hdr';
    hdr.innerHTML = `<span>CH ${tr.code} <i class="oh-sub">TRACK LABEL</i></span>`;
    const closeBtn = document.createElement('button');
    closeBtn.className = 'ctx-chip';
    closeBtn.innerHTML = '<svg class="ico" viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8"/></svg>';
    closeBtn.title = 'Close [B]';
    closeBtn.classList.add('icon-only');
    closeBtn.onclick = close;
    hdr.appendChild(closeBtn);

    const body = document.createElement('div');
    body.className = 'overlay-body';

    const inputEl = document.createElement('input');
    inputEl.type = 'text';
    inputEl.className = 'hw-text-input';
    inputEl.maxLength = 12;
    inputEl.value = tr.name;
    inputEl.placeholder = `CH ${tr.code}`;

    const actions = document.createElement('div');
    actions.style.display = 'flex';
    actions.style.gap = '8px';
    actions.style.justifyContent = 'flex-end';

    const resetBtn = document.createElement('button');
    resetBtn.className = 'ctx-chip';
    resetBtn.textContent = 'RESET';
    resetBtn.onclick = () => {
      store.renameTrack(tid, '');
      close();
    };

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'ctx-chip';
    cancelBtn.textContent = 'CANCEL';
    cancelBtn.onclick = close;

    const saveBtn = document.createElement('button');
    saveBtn.className = 'ctx-chip solid';
    saveBtn.textContent = 'SAVE';
    const commit = () => {
      store.renameTrack(tid, inputEl.value);
      close();
    };
    saveBtn.onclick = commit;

    inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commit();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        close();
      }
    });

    actions.append(resetBtn, cancelBtn, saveBtn);
    body.append(inputEl, actions);
    modalEl.append(hdr, body);

    requestAnimationFrame(() => {
      inputEl.focus();
      inputEl.select();
    });
  }

  function renderChannelFxModal(modalEl) {
    const st = store.getState();
    const tid = st.detailOverlay?.trackId ?? st.selectedTrackId;
    const tr = st.tracks[tid];
    const close = () => {
      st.detailOverlay = null;
      store.emit('overlay', null);
    };
    if (!tr) {
      close();
      return;
    }

    function rebuild() {
      modalEl.innerHTML = '';
      const hdr = document.createElement('div');
      hdr.className = 'overlay-hdr';
      hdr.innerHTML = `<span>${tr.code} ${tr.name} <i class="oh-sub">FX RACK</i></span>`;

      const hdrRight = document.createElement('div');
      hdrRight.style.display = 'flex';
      hdrRight.style.gap = '6px';

      const openDspBtn = document.createElement('button');
      openDspBtn.className = 'ctx-chip solid';
      openDspBtn.textContent = 'DSP VIEW ↗';
      openDspBtn.onclick = () => {
        store.setSelectedTrack(tid);
        store.setView('DSP');
        close();
      };

      const closeBtn = document.createElement('button');
      closeBtn.className = 'ctx-chip';
      closeBtn.innerHTML = '<svg class="ico" viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8"/></svg>';
      closeBtn.title = 'Close [B]';
      closeBtn.classList.add('icon-only');
      closeBtn.onclick = close;

      hdrRight.append(openDspBtn, closeBtn);
      hdr.appendChild(hdrRight);

      const body = document.createElement('div');
      body.className = 'overlay-body';

      const chainHdr = document.createElement('div');
      chainHdr.className = 'menu-section-hdr';
      chainHdr.textContent = 'SIGNAL CHAIN';

      const chainList = document.createElement('div');
      chainList.className = 'clip-menu-list';

      tr.inserts.forEach((slot, slotIdx) => {
        const def = getDevice(slot.deviceId);
        if (!def) return;
        const row = document.createElement('div');
        row.className = `mix-fx-row ${slot.bypass ? 'bypassed' : ''}`;

        const tag = document.createElement('span');
        tag.className = 'mix-fx-tag';
        tag.textContent = slotIdx === 0 ? 'SRC' : `FX${slotIdx}`;

        const openBtn = document.createElement('button');
        openBtn.className = 'mix-fx-name-btn';
        openBtn.textContent = def.meta.name;
        openBtn.onclick = () => {
          store.setSelectedTrack(tid);
          st.selectedDeviceSlotIdx = slotIdx;
          st.detailOverlay =
            slot.deviceId === 'drum8'
              ? { type: 'mpc', trackId: tid }
              : slot.deviceId === 'brickchord'
                ? { type: 'brickchord', trackId: tid }
                : { type: 'dsp', trackId: tid, slotIdx };
          store.emit('overlay', st.detailOverlay);
        };

        row.append(tag, openBtn);

        if (slotIdx === 0) {
          if (slot.deviceId === 'drum8') {
            const mpcBtn = document.createElement('button');
            mpcBtn.className = 'ctx-chip active';
            mpcBtn.textContent = 'MPC';
            mpcBtn.onclick = () => {
              st.detailOverlay = { type: 'mpc', trackId: tid };
              store.emit('overlay', st.detailOverlay);
            };
            row.appendChild(mpcBtn);
          } else if (slot.deviceId === 'brickchord') {
            const padBtn = document.createElement('button');
            padBtn.className = 'ctx-chip active';
            padBtn.textContent = 'PAD';
            padBtn.onclick = () => {
              st.detailOverlay = { type: 'brickchord', trackId: tid };
              store.emit('overlay', st.detailOverlay);
            };
            row.appendChild(padBtn);
          } else if (['mono303', 'polyfm', 'grain1'].includes(slot.deviceId)) {
            const leadBtn = document.createElement('button');
            leadBtn.className = 'ctx-chip active';
            leadBtn.textContent = 'LEAD';
            leadBtn.onclick = () => {
              st.detailOverlay = { type: 'lead', trackId: tid };
              store.emit('overlay', st.detailOverlay);
            };
            row.appendChild(leadBtn);
          }
          const swapBtn = document.createElement('button');
          swapBtn.className = 'ctx-chip';
          swapBtn.textContent = 'SWAP';
          swapBtn.onclick = () => {
            store.setSelectedTrack(tid);
            st.detailOverlay = { type: 'inst-menu' };
            store.emit('overlay', st.detailOverlay);
          };
          row.appendChild(swapBtn);
        } else {
          if (slotIdx > 1) {
            const upBtn = document.createElement('button');
            upBtn.className = 'ctx-chip';
            upBtn.textContent = '↑';
            upBtn.title = 'Move Up';
            upBtn.onclick = () => {
              store.moveInsertDevice(tid, slotIdx, slotIdx - 1);
              rebuild();
            };
            row.appendChild(upBtn);
          }
          if (slotIdx < tr.inserts.length - 1) {
            const dnBtn = document.createElement('button');
            dnBtn.className = 'ctx-chip';
            dnBtn.textContent = '↓';
            dnBtn.title = 'Move Down';
            dnBtn.onclick = () => {
              store.moveInsertDevice(tid, slotIdx, slotIdx + 1);
              rebuild();
            };
            row.appendChild(dnBtn);
          }
          const bypBtn = document.createElement('button');
          bypBtn.className = `ctx-chip ${!slot.bypass ? 'active' : ''}`;
          bypBtn.textContent = slot.bypass ? 'BYP' : 'ON';
          bypBtn.onclick = () => {
            store.toggleDeviceBypass(tid, slotIdx);
            rebuild();
          };

          const delBtn = document.createElement('button');
          delBtn.className = 'ctx-chip';
          delBtn.textContent = '✕';
          delBtn.onclick = () => {
            store.removeInsertDevice(tid, slotIdx);
            rebuild();
          };
          row.append(bypBtn, delBtn);
        }

        chainList.appendChild(row);
      });

      const addHdr = document.createElement('div');
      addHdr.className = 'menu-section-hdr';
      addHdr.textContent = '+ ADD EFFECT';

      const fxGrid = document.createElement('div');
      fxGrid.className = 'inst-grid';
      for (const dev of getDevicesByCategory('effect')) {
        const b = document.createElement('button');
        b.className = 'ctx-chip';
        b.style.height = '34px';
        b.style.justifyContent = 'space-between';
        b.innerHTML = `<span>+ ${dev.meta.name}</span><span style="opacity:0.5">${dev.meta.params.length}P</span>`;
        b.onclick = () => {
          store.addInsertDevice(tid, dev.meta.id);
          rebuild();
        };
        fxGrid.appendChild(b);
      }

      body.append(chainHdr, chainList, addHdr, fxGrid);
      modalEl.append(hdr, body);
    }

    rebuild();
  }

  function renderReturnFxModal(modalEl) {
    const st = store.getState();
    const key = st.detailOverlay?.returnKey || 'sendA';
    const ret = st.returns[key];
    const def = getDevice(ret?.deviceId);
    const close = () => {
      st.detailOverlay = null;
      store.emit('overlay', null);
    };
    if (!ret || !def) {
      close();
      return;
    }

    const hdr = document.createElement('div');
    hdr.className = 'overlay-hdr';
    hdr.innerHTML = `<span>${key === 'sendA' ? 'SND A' : 'SND B'} <i class="oh-sub">${def.meta.name}</i></span>`;
    const closeBtn = document.createElement('button');
    closeBtn.className = 'ctx-chip';
    closeBtn.innerHTML = '<svg class="ico" viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8"/></svg>';
    closeBtn.title = 'Close [B]';
    closeBtn.classList.add('icon-only');
    closeBtn.onclick = close;
    hdr.appendChild(closeBtn);

    const body = document.createElement('div');
    body.className = 'overlay-body';

    const knobsRow = document.createElement('div');
    knobsRow.style.display = 'flex';
    knobsRow.style.flexWrap = 'wrap';
    knobsRow.style.justifyContent = 'space-around';
    knobsRow.style.gap = '12px';
    knobsRow.style.padding = '12px 0';

    for (const p of def.meta.params) {
      const rot = createRotary({
        param: p,
        value: ret.params[p.id],
        size: 54,
        onGestureStart: () => store.beginGesture(`${def.meta.name} ${p.label}`),
        onGestureEnd: () => store.commitGesture(),
        onChange: (v) => store.setReturnParam(key, p.id, v)
      });
      knobsRow.appendChild(rot.el);
    }

    body.appendChild(knobsRow);
    modalEl.append(hdr, body);
  }

  let punchCanvas = null;

  function drawPunchPad() {
    if (!punchCanvas) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = punchCanvas.getBoundingClientRect();
    const w = rect.width > 20 ? rect.width : punchCanvas.width;
    const h = rect.height > 20 ? rect.height : punchCanvas.height;
    const bw = Math.round(w * dpr);
    const bh = Math.round(h * dpr);
    if (punchCanvas.width !== bw || punchCanvas.height !== bh) {
      punchCanvas.width = bw;
      punchCanvas.height = bh;
    }

    const ctx = punchCanvas.getContext('2d');
    const styles = getComputedStyle(document.documentElement);
    const bg = styles.getPropertyValue('--bg').trim();
    const border = styles.getPropertyValue('--border').trim();
    const ink = styles.getPropertyValue('--ink').trim();
    const inkDim = styles.getPropertyValue('--ink-dim').trim();
    const accent = styles.getPropertyValue('--accent').trim();

    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);

    ctx.strokeStyle = border;
    ctx.lineWidth = 1;
    ctx.strokeRect(10.5, 10.5, w - 21, h - 21);
    ctx.beginPath();
    ctx.moveTo(w * 0.5, 10);
    ctx.lineTo(w * 0.5, h - 10);
    ctx.moveTo(10, h * 0.5);
    ctx.lineTo(w - 10, h * 0.5);
    ctx.stroke();

    ctx.fillStyle = inkDim;
    ctx.font = '700 11px "Geist Mono", monospace';
    ctx.textAlign = 'center';
    ctx.fillText('DUB ECHO', w * 0.5, 24);
    ctx.fillText('TAPE CRUSH', w * 0.5, h - 16);
    ctx.textAlign = 'left';
    ctx.fillText('LPF', 20, h * 0.5 - 6);
    ctx.textAlign = 'right';
    ctx.fillText('HPF', w - 20, h * 0.5 - 6);

    const ps = engine.getPunchState();
    const px = 10 + ((ps.x + 1) * 0.5) * (w - 20);
    const py = 10 + ((ps.y + 1) * 0.5) * (h - 20);

    ctx.strokeStyle = ps.active || ps.hold ? accent : inkDim;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(px, 10);
    ctx.lineTo(px, h - 10);
    ctx.moveTo(10, py);
    ctx.lineTo(w - 10, py);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = ps.active || ps.hold ? accent : ink;
    ctx.beginPath();
    ctx.arc(px, py, 9, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = ps.active ? accent : ink;
    ctx.font = '700 12px "Geist Mono", monospace';
    ctx.textAlign = 'left';
    ctx.fillText(ps.label, 20, 24);
    if (ps.hold) {
      ctx.fillStyle = accent;
      ctx.textAlign = 'right';
      ctx.fillText('HOLD', w - 20, 24);
    }
    ctx.restore();
  }

  function tickOverlay() {
    if (store.getState().detailOverlay?.type === 'punch' && punchCanvas) {
      drawPunchPad();
    } else {
      punchCanvas = null;
    }
  }

  function renderPunchFxOverlay(panelEl) {
    const st = store.getState();
    const hdr = document.createElement('div');
    hdr.className = 'overlay-hdr';
    hdr.innerHTML = `<span>MASTER <i class="oh-sub">PUNCH-IN FX [R2+R-STICK]</i></span>`;

    const actions = document.createElement('div');
    actions.style.display = 'flex';
    actions.style.gap = '6px';

    const holdBtn = document.createElement('button');
    holdBtn.className = `ctx-chip ${engine.getPunchState().hold ? 'active' : ''}`;
    holdBtn.textContent = 'HOLD [R3]';
    holdBtn.onclick = () => {
      const h = engine.togglePunchHold();
      holdBtn.classList.toggle('active', h);
    };

    const limBtn = document.createElement('button');
    limBtn.className = 'ctx-chip';
    limBtn.textContent = 'LIMITER';
    limBtn.onclick = () => {
      st.detailOverlay = { type: 'mix', trackId: null };
      store.emit('overlay', st.detailOverlay);
    };

    const closeBtn = document.createElement('button');
    closeBtn.className = 'ctx-chip';
    closeBtn.innerHTML = '<svg class="ico" viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8"/></svg>';
    closeBtn.title = 'Close [B]';
    closeBtn.classList.add('icon-only');
    closeBtn.onclick = () => {
      if (!engine.getPunchState().hold) engine.setPunchFx(0, 0);
      st.detailOverlay = null;
      store.emit('overlay', null);
    };

    actions.append(holdBtn, limBtn, closeBtn);
    hdr.appendChild(actions);

    const body = document.createElement('div');
    body.className = 'overlay-body';

    punchCanvas = document.createElement('canvas');
    punchCanvas.className = 'punch-xy-canvas';
    punchCanvas.width = 640;
    punchCanvas.height = 320;

    const updateFromPtr = (e) => {
      const r = punchCanvas.getBoundingClientRect();
      const x = Math.max(-1, Math.min(1, ((e.clientX - r.left) / Math.max(1, r.width)) * 2 - 1));
      const y = Math.max(-1, Math.min(1, ((e.clientY - r.top) / Math.max(1, r.height)) * 2 - 1));
      engine.setPunchFx(x, y, engine.getPunchState().hold ? true : null);
    };
    punchCanvas.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      engine.unlock();
      punchCanvas.setPointerCapture(e.pointerId);
      updateFromPtr(e);
    });
    punchCanvas.addEventListener('pointermove', (e) => {
      if (e.buttons) updateFromPtr(e);
    });
    const endPtr = () => {
      if (!engine.getPunchState().hold) engine.setPunchFx(0, 0);
    };
    punchCanvas.addEventListener('pointerup', endPtr);
    punchCanvas.addEventListener('pointercancel', endPtr);

    body.appendChild(punchCanvas);
    panelEl.append(hdr, body);
    drawPunchPad();
  }

  function renderDetailOverlay(panelEl) {
    const st = store.getState();
    const hdr = document.createElement('div');
    hdr.className = 'overlay-hdr';
    hdr.innerHTML = `<span>MASTER & CHANNEL METER <i class="oh-sub">BRICKWALL LIMITER</i></span>`;
    const close = document.createElement('button');
    close.className = 'ctx-chip';
    close.innerHTML = '<svg class="ico" viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8"/></svg>';
    close.title = 'Close [B]';
    close.classList.add('icon-only');
    close.onclick = () => {
      st.detailOverlay = null;
      store.emit('overlay', null);
    };
    hdr.appendChild(close);

    const body = document.createElement('div');
    body.className = 'overlay-body';
    const info = document.createElement('div');
    info.className = 'telemetry-grid';
    info.innerHTML = `
      <div class="tel-cell"><span class="k">MASTER GAIN</span><span class="v">${gainToDbText(st.master.volume)} dB</span></div>
      <div class="tel-cell"><span class="k">LIMITER CEIL</span><span class="v">${st.master.limiterCeiling.toFixed(1)} dB</span></div>
      <div class="tel-cell"><span class="k">ACTIVE TRACK</span><span class="v">${st.tracks[st.selectedTrackId].name}</span></div>
    `;
    const rot = createRotary({
      param: { id: 'ceil', label: 'CEILING', min: -12, max: 0, default: -0.5, step: 0.5, unit: 'dB' },
      value: st.master.limiterCeiling,
      size: 64,
      onChange: (v) => {
        engine.setLimiterCeiling(v);
        info.children[1].querySelector('.v').textContent = `${v.toFixed(1)} dB`;
      }
    });
    body.append(info, rot.el);
    panelEl.append(hdr, body);
  }

  return {
    el: root,
    tick,
    tickOverlay,
    handleAction,
    renderDetailOverlay,
    renderPunchFxOverlay,
    renderTrackRenameModal,
    renderChannelFxModal,
    renderReturnFxModal
  };
}
