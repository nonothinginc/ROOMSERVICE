import { engine } from '../../audio/engine.js';
import { store } from '../../state/store.js';
import { attachLongPress } from '../components/longpress.js';
import { createRotary } from '../components/rotary.js';

function gainToDbText(gain) {
  if (gain <= 0.001) return '-INF';
  const db = 20 * Math.log10(gain);
  return `${db >= 0 ? '+' : ''}${db.toFixed(1)}`;
}

function drawSegmentedMeter(canvas, levelL, levelR = null, peakHold = { l: 0, r: 0 }) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  const styles = getComputedStyle(document.documentElement);
  const bg = styles.getPropertyValue('--surface-recessed').trim() || styles.getPropertyValue('--bg').trim();
  const offCol = styles.getPropertyValue('--border').trim();
  const ink = styles.getPropertyValue('--ink').trim();
  const accent = styles.getPropertyValue('--accent').trim();

  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = bg;
  ctx.beginPath();
  ctx.roundRect(0, 0, w, h, 3);
  ctx.fill();

  const segs = 18;
  const padY = 4;
  const padX = 2;
  const slotH = (h - padY * 2) / segs;
  const barH = Math.max(2, slotH - 2);
  const isStereo = levelR !== null;

  peakHold.l = Math.max(levelL, peakHold.l * 0.965);
  if (isStereo) {
    peakHold.r = Math.max(levelR, peakHold.r * 0.965);
  }

  const drawCol = (x, colW, val, holdVal) => {
    const activeCount = Math.round(Math.max(0, Math.min(1, val)) * segs);
    const holdIdx = holdVal > 0.04 ? Math.min(segs - 1, Math.floor(Math.min(1, holdVal) * segs)) : -1;
    for (let i = 0; i < segs; i++) {
      const y = h - padY - (i + 1) * slotH + 1;
      const isHot = i >= segs - 4;
      const isLit = i < activeCount || i === holdIdx;
      ctx.fillStyle = isLit ? (isHot ? accent : ink) : offCol;
      ctx.beginPath();
      ctx.roundRect(x, y, colW, barH, 1.5);
      ctx.fill();
    }
  };

  if (isStereo) {
    const gap = 3;
    const colW = Math.max(4, Math.floor((w - padX * 2 - gap) / 2));
    drawCol(padX, colW, levelL, peakHold.l);
    drawCol(padX + colW + gap, colW, levelR, peakHold.r);
  } else {
    const colW = Math.max(4, w - padX * 2);
    drawCol(padX, colW, levelL, peakHold.l);
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
  const meterPeaks = Array.from({ length: 11 }, () => ({ l: 0, r: 0 }));
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
      if (!moved && Math.abs(dx) > 5) {
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
      const val = norm * 1.15;
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

  function buildStrip({ code, name, isChannel, trackId, isMaster = false }) {
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
    }

    attachLongPress(hdr, () => {
      if (isChannel) {
        store.getState().detailOverlay = { type: 'mix-rename', trackId };
      } else {
        store.getState().detailOverlay = { type: 'mix', trackId: null };
      }
      store.emit('overlay', store.getState().detailOverlay);
    });

    const sends = document.createElement('div');
    sends.className = 'mix-sends';
    let sendARot = null;
    let sendBRot = null;
    let extraRot = null;

    if (isChannel) {
      const tr = store.getState().tracks[trackId];
      sendARot = createRotary({
        param: { id: 'sendA', label: 'A', min: 0, max: 1, default: 0, step: 0.02, unit: '' },
        value: tr.sendA,
        size: 30,
        compact: true,
        onGestureStart: () => store.beginGesture(`${tr.code} SND A`),
        onGestureEnd: () => store.commitGesture(),
        onChange: (v) => store.setTrackParam(trackId, 'sendA', v)
      });
      sendBRot = createRotary({
        param: { id: 'sendB', label: 'B', min: 0, max: 1, default: 0, step: 0.02, unit: '' },
        value: tr.sendB,
        size: 30,
        compact: true,
        onGestureStart: () => store.beginGesture(`${tr.code} SND B`),
        onGestureEnd: () => store.commitGesture(),
        onChange: (v) => store.setTrackParam(trackId, 'sendB', v)
      });
      sends.append(sendARot.el, sendBRot.el);
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
      tag.textContent = '0 dB LIM';
      ms.appendChild(tag);
    }
    el.appendChild(ms);

    const faderArea = document.createElement('div');
    faderArea.className = 'mix-fader-area';

    const scaleCol = document.createElement('div');
    scaleCol.className = 'fader-scale';
    ['+6', '0', '-6', '-12', '-24', '-∞'].forEach((mark) => {
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
    meterCanvas.width = isMaster ? 26 : 16;
    meterCanvas.height = 240;
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
      faderTrack,
      faderCap,
      meterCanvas,
      dbEl,
      muteBtn,
      soloBtn,
      sendARot,
      sendBRot,
      extraRot
    };
  }

  // 8 Channels
  for (let i = 0; i < 8; i++) {
    const tr = store.getState().tracks[i];
    const ref = buildStrip({ code: tr.code, name: tr.name, isChannel: true, trackId: i });
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

  returnARef = buildStrip({ code: 'SND A', name: 'DELAY', isChannel: false });
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

  returnBRef = buildStrip({ code: 'SND B', name: 'VERB', isChannel: false });
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

  masterRef = buildStrip({ code: 'MST', name: 'MASTER', isChannel: false, isMaster: true });
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
    const pct = Math.max(0, Math.min(1, vol / 1.15));
    ref.faderCap.style.top = `${(1 - pct) * 86 + 7}%`;
    ref.dbEl.textContent = gainToDbText(vol);
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
      st.detailOverlay = { type: 'mix', trackId: tid };
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

  function tick() {
    updateScrollRail();
    for (let i = 0; i < 8; i++) {
      drawSegmentedMeter(stripRefs[i].meterCanvas, engine.getTrackMeter(i), null, meterPeaks[i]);
    }
    const retM = engine.getReturnMeters();
    drawSegmentedMeter(returnARef.meterCanvas, retM.sendA, null, meterPeaks[8]);
    drawSegmentedMeter(returnBRef.meterCanvas, retM.sendB, null, meterPeaks[9]);
    const mstLevel = engine.getMasterMeter();
    drawSegmentedMeter(masterRef.meterCanvas, mstLevel, Math.min(1, mstLevel * 0.96), meterPeaks[10]);
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
    hdr.innerHTML = `<span>CH ${tr.code} // TRACK LABEL</span>`;
    const closeBtn = document.createElement('button');
    closeBtn.className = 'ctx-chip';
    closeBtn.textContent = 'CLOSE [B]';
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

  function renderDetailOverlay(panelEl) {
    const st = store.getState();
    const hdr = document.createElement('div');
    hdr.className = 'overlay-hdr';
    hdr.innerHTML = `<span>MASTER & CHANNEL METER // BRICKWALL LIMITER</span>`;
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
    handleAction,
    renderDetailOverlay,
    renderTrackRenameModal
  };
}
