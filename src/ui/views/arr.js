import { engine } from '../../audio/engine.js';
import { getDevice } from '../../device-registry.js';
import { nextId, store } from '../../state/store.js';
import { attachLongPress } from '../components/longpress.js';

const WARP_MODES = ['BEATS', 'TONES', 'TEXTURE', 'RE-PITCH'];

export function createArrView() {
  const root = document.createElement('div');
  root.className = 'view-root';

  // Top Clip Dock
  const dock = document.createElement('div');
  dock.className = 'ctx-strip';

  // Timeline Canvas
  const canvasWrap = document.createElement('div');
  canvasWrap.className = 'canvas-wrap';
  const canvas = document.createElement('canvas');
  canvasWrap.appendChild(canvas);
  const ctx = canvas.getContext('2d');

  // Hidden file input fallback
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = 'audio/*,.wav,.mp3,.ogg,.flac';
  fileInput.multiple = true;
  fileInput.style.display = 'none';
  fileInput.onchange = async () => {
    for (const file of Array.from(fileInput.files || [])) {
      await engine.importAudioFile(file);
    }
    fileInput.value = '';
  };

  root.append(dock, canvasWrap, fileInput);

  let scrollX = 0;
  let stepW = 9;
  let laneH = 44;
  let cursorLane = 0;
  let cursorStep = 0;
  let micRecording = false;
  let dragClip = null;
  let longPressFired = false;
  let pendingTap = null;

  const LANE_HEADER_W = 116;
  const DOUBLE_TAP_MS = 260;

  function clearPendingTap() {
    if (pendingTap) {
      clearTimeout(pendingTap.timer);
      pendingTap = null;
    }
  }

  function deleteClipById(clipId) {
    const st = store.getState();
    const clip = st.arrClips.find((c) => c.id === clipId);
    if (!clip) return;
    store.pushHistory(`DEL ${clip.refId}`);
    st.arrClips = st.arrClips.filter((c) => c.id !== clipId);
    if (st.selectedArrClipId === clipId) st.selectedArrClipId = null;
    store.emit('arr');
  }

  function openClipEditor(clip) {
    if (!clip) return;
    const st = store.getState();
    st.selectedArrClipId = clip.id;
    if (clip.kind === 'pattern') {
      store.setActivePattern(clip.refId);
      const pat = st.patterns[clip.refId];
      if (clip.trackOverride != null) {
        store.setSelectedTrack(clip.trackOverride);
      } else if (pat) {
        const curNotes = pat.notesByTrack[st.selectedTrackId];
        if (!curNotes || curNotes.length === 0) {
          const firstPopulated = Object.keys(pat.notesByTrack).find((tid) => pat.notesByTrack[tid]?.length > 0);
          if (firstPopulated != null) store.setSelectedTrack(Number(firstPopulated));
        }
      }
      store.setView('ROLL');
    } else if (clip.kind === 'auto') {
      st.detailOverlay = { type: 'auto', autoId: clip.refId };
      store.emit('overlay', st.detailOverlay);
    } else if (clip.kind === 'audio') {
      st.detailOverlay = { type: 'audio', audioId: clip.refId };
      store.emit('overlay', st.detailOverlay);
    }
  }

  attachLongPress(canvasWrap, (e) => {
    if (dragClip?.moved) return;
    clearPendingTap();
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const st = store.getState();
    const lane = Math.max(0, Math.min(7, Math.floor(y / laneH)));

    longPressFired = true;
    dragClip = null;

    if (x < LANE_HEADER_W) {
      st.detailOverlay = { type: 'lane-label', lane };
      store.emit('overlay', st.detailOverlay);
      return;
    }

    const hit = [...st.arrClips]
      .reverse()
      .find((c) => {
        if (c.lane !== lane) return false;
        const cx = LANE_HEADER_W + (c.startStep - scrollX) * stepW;
        const cw = Math.max(12, c.lengthSteps * stepW);
        return x >= cx && x <= cx + cw;
      });

    if (hit) {
      if (pendingTap && pendingTap.clipId !== hit.id) {
        clearPendingTap();
      }
      st.selectedArrClipId = hit.id;
      st.detailOverlay = { type: 'clip-menu', clipId: hit.id };
      store.emit('overlay', st.detailOverlay);
    } else {
      st.detailOverlay = { type: 'arr' };
      store.emit('overlay', st.detailOverlay);
    }
  });

  async function triggerImport() {
    await engine.unlock();
    if (window.showOpenFilePicker) {
      try {
        const handles = await window.showOpenFilePicker({
          multiple: true,
          types: [{ description: 'Audio', accept: { 'audio/*': ['.wav', '.mp3', '.ogg', '.flac', '.m4a'] } }]
        });
        for (const h of handles) {
          const f = await h.getFile();
          await engine.importAudioFile(f);
        }
        return;
      } catch {
        // User cancelled or blocked, fall back to input
      }
    }
    fileInput.click();
  }

  async function toggleMic() {
    if (!micRecording) {
      try {
        await engine.startMicRecord();
        micRecording = true;
        renderBars();
      } catch {
        micRecording = false;
      }
    } else {
      micRecording = false;
      await engine.stopMicRecord();
      renderBars();
    }
  }

  // Drag-and-drop audio import
  canvasWrap.addEventListener('dragover', (e) => {
    e.preventDefault();
  });
  canvasWrap.addEventListener('drop', async (e) => {
    e.preventDefault();
    for (const file of Array.from(e.dataTransfer?.files || [])) {
      if (file.type.startsWith('audio/') || /\.(wav|mp3|ogg|flac)$/i.test(file.name)) {
        await engine.importAudioFile(file);
      }
    }
  });

  function renderBars() {
    const st = store.getState();
    dock.innerHTML = '';

    // Show active/populated patterns + P01..P04 minimum
    const patIds = Object.keys(st.patterns).filter((id, idx) => {
      if (idx < 4 || id === st.activePatternId) return true;
      return Object.values(st.patterns[id].notesByTrack).some((a) => a.length > 0);
    });

    for (const pid of patIds) {
      const btn = document.createElement('button');
      const active = st.selectedDockClip?.kind === 'pattern' && st.selectedDockClip.refId === pid;
      btn.className = `ctx-chip ${active ? 'active' : ''}`;
      btn.textContent = pid;
      btn.onclick = () => {
        st.selectedDockClip = { kind: 'pattern', refId: pid };
        store.setActivePattern(pid);
        renderBars();
      };
      dock.appendChild(btn);
    }

    for (const aid of Object.keys(st.audioClips)) {
      const ac = st.audioClips[aid];
      const btn = document.createElement('button');
      const active = st.selectedDockClip?.kind === 'audio' && st.selectedDockClip.refId === aid;
      btn.className = `ctx-chip ${active ? 'active' : ''}`;
      btn.textContent = `${aid} ${ac.detectedBpm}B`;
      btn.onclick = () => {
        st.selectedDockClip = { kind: 'audio', refId: aid };
        renderBars();
      };
      dock.appendChild(btn);
    }

    for (const autoid of Object.keys(st.autoClips)) {
      const btn = document.createElement('button');
      const active = st.selectedDockClip?.kind === 'auto' && st.selectedDockClip.refId === autoid;
      btn.className = `ctx-chip ${active ? 'active' : ''}`;
      btn.textContent = autoid;
      btn.onclick = () => {
        st.selectedDockClip = { kind: 'auto', refId: autoid };
        renderBars();
      };
      dock.appendChild(btn);
    }

    const sp = document.createElement('div');
    sp.className = 'ctx-spacer';
    dock.appendChild(sp);

    const addBtn = document.createElement('button');
    addBtn.className = `ctx-chip solid ${micRecording ? 'active' : ''}`;
    addBtn.textContent = micRecording ? '■ STOP MIC' : '+';
    addBtn.onclick = () => {
      if (micRecording) {
        toggleMic();
        return;
      }
      st.detailOverlay = { type: 'arr-add' };
      store.emit('overlay', st.detailOverlay);
    };
    dock.appendChild(addBtn);
  }

  store.subscribe((_, topic) => {
    if (['arr', 'pattern', 'transport', 'view', 'history-restore'].includes(topic)) renderBars();
  });
  renderBars();

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = canvasWrap.clientWidth;
    const h = canvasWrap.clientHeight;
    if (w > 0 && h > 0 && (canvas.width !== w * dpr || canvas.height !== h * dpr)) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
    }
  }

  canvas.addEventListener('pointerdown', (e) => {
    engine.unlock();
    longPressFired = false;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const st = store.getState();

    if (x < LANE_HEADER_W) return;
    const lane = Math.max(0, Math.min(7, Math.floor(y / laneH)));
    const step = Math.max(0, Math.floor((scrollX + (x - LANE_HEADER_W) / stepW) / 4) * 4);
    cursorLane = lane;
    cursorStep = step;

    const hit = [...st.arrClips]
      .reverse()
      .find((c) => {
        if (c.lane !== lane) return false;
        const cx = LANE_HEADER_W + (c.startStep - scrollX) * stepW;
        const cw = Math.max(12, c.lengthSteps * stepW);
        return x >= cx && x <= cx + cw;
      });

    if (hit) {
      if (pendingTap && pendingTap.clipId !== hit.id) {
        clearPendingTap();
      }
      st.selectedArrClipId = hit.id;
      const cx = LANE_HEADER_W + (hit.startStep - scrollX) * stepW;
      const cw = Math.max(12, hit.lengthSteps * stepW);
      const isResize = x >= cx + cw - 12;
      store.beginGesture(`EDIT ${hit.refId}`);
      dragClip = {
        clip: hit,
        isNew: false,
        moved: false,
        mode: isResize ? 'resize' : 'move',
        startX: e.clientX,
        startY: e.clientY,
        origStart: hit.startStep,
        origLane: hit.lane,
        origLen: hit.lengthSteps
      };
      canvas.setPointerCapture(e.pointerId);
      renderBars();
      return;
    }

    // Paint selected dock clip
    clearPendingTap();
    const dockClip = st.selectedDockClip || { kind: 'pattern', refId: st.activePatternId };
    const defaultLen =
      dockClip.kind === 'pattern'
        ? st.patterns[dockClip.refId]?.length || 16
        : dockClip.kind === 'audio'
        ? Math.max(16, Math.round((st.audioClips[dockClip.refId]?.duration || 2) * (st.bpm / 60) * 4))
        : 32;

    store.beginGesture(`PAINT ${dockClip.refId}`);
    store.markGestureDirty();

    const created = {
      id: nextId('clip'),
      kind: dockClip.kind,
      refId: dockClip.refId,
      lane,
      startStep: step,
      lengthSteps: defaultLen,
      trackOverride: null
    };
    st.arrClips.push(created);
    st.selectedArrClipId = created.id;
    dragClip = {
      clip: created,
      isNew: true,
      moved: false,
      mode: 'move',
      startX: e.clientX,
      startY: e.clientY,
      origStart: step,
      origLane: lane,
      origLen: defaultLen
    };
    canvas.setPointerCapture(e.pointerId);
    renderBars();
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!dragClip) return;
    const dx = e.clientX - dragClip.startX;
    const dy = e.clientY - dragClip.startY;
    if (!dragClip.moved && Math.hypot(dx, dy) <= 6) return;
    dragClip.moved = true;
    clearPendingTap();
    const dSteps = Math.round(dx / stepW / 4) * 4;
    if (dragClip.mode === 'resize') {
      const nextLen = Math.max(4, Math.min(128 - dragClip.clip.startStep, dragClip.origLen + dSteps));
      if (nextLen !== dragClip.clip.lengthSteps) {
        dragClip.clip.lengthSteps = nextLen;
        store.markGestureDirty();
      }
    } else {
      const nextStart = Math.max(0, Math.min(128 - dragClip.clip.lengthSteps, dragClip.origStart + dSteps));
      const nextLane = Math.max(0, Math.min(7, dragClip.origLane + Math.round(dy / laneH)));
      if (nextStart !== dragClip.clip.startStep || nextLane !== dragClip.clip.lane) {
        dragClip.clip.startStep = nextStart;
        dragClip.clip.lane = nextLane;
        store.markGestureDirty();
      }
    }
  });

  canvas.addEventListener('pointerup', () => {
    const finished = dragClip;
    dragClip = null;
    store.commitGesture();
    if (finished && !finished.isNew && !finished.moved && !longPressFired) {
      if (pendingTap && pendingTap.clipId === finished.clip.id) {
        clearPendingTap();
        deleteClipById(finished.clip.id);
      } else {
        clearPendingTap();
        pendingTap = {
          clipId: finished.clip.id,
          timer: setTimeout(() => {
            pendingTap = null;
            openClipEditor(finished.clip);
          }, DOUBLE_TAP_MS)
        };
      }
    }
    longPressFired = false;
  });

  canvas.addEventListener('pointercancel', () => {
    store.commitGesture();
    dragClip = null;
    longPressFired = false;
  });

  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      scrollX = Math.max(0, Math.min(96, scrollX + e.deltaX / stepW));
    },
    { passive: false }
  );

  function handleAction(action) {
    const st = store.getState();
    if (st.view !== 'ARR' || st.detailOverlay) return;

    if (action.type === 'DPAD') {
      if (action.dir === 'UP') cursorLane = Math.max(0, cursorLane - 1);
      if (action.dir === 'DOWN') cursorLane = Math.min(7, cursorLane + 1);
      if (action.dir === 'LEFT') cursorStep = Math.max(0, cursorStep - 4);
      if (action.dir === 'RIGHT') cursorStep = Math.min(124, cursorStep + 4);
    } else if (action.type === 'A_TAP') {
      const hit = st.arrClips.find(
        (c) => c.lane === cursorLane && cursorStep >= c.startStep && cursorStep < c.startStep + c.lengthSteps
      );
      if (hit) {
        if (st.selectedArrClipId === hit.id) {
          openClipEditor(hit);
          return;
        }
        st.selectedArrClipId = hit.id;
      } else {
        const dockClip = st.selectedDockClip || { kind: 'pattern', refId: st.activePatternId };
        store.pushHistory(`PAINT ${dockClip.refId}`);
        const nc = {
          id: nextId('clip'),
          kind: dockClip.kind,
          refId: dockClip.refId,
          lane: cursorLane,
          startStep: cursorStep,
          lengthSteps: 16,
          trackOverride: null
        };
        st.arrClips.push(nc);
        st.selectedArrClipId = nc.id;
      }
      renderBars();
    } else if (action.type === 'A_HOLD') {
      const sel = st.arrClips.find((c) => c.id === st.selectedArrClipId);
      if (sel) st.detailOverlay = { type: 'clip-menu', clipId: sel.id };
      else st.detailOverlay = { type: 'arr' };
      store.emit('overlay', st.detailOverlay);
    } else if (action.type === 'B' && st.selectedArrClipId) {
      store.pushHistory('DEL CLIP');
      st.arrClips = st.arrClips.filter((c) => c.id !== st.selectedArrClipId);
      st.selectedArrClipId = null;
      renderBars();
    } else if (action.type === 'X' && st.selectedArrClipId) {
      store.makePatternUnique(st.selectedArrClipId);
    } else if (action.type === 'Y') {
      store.createAutomationClip(st.selectedTrackId, 0, 'cutoff');
    } else if (action.type === 'STICKS') {
      if (action.lx) scrollX = Math.max(0, Math.min(96, scrollX + action.lx * 0.8));
    }
  }

  function tick() {
    resize();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = canvas.width / dpr;
    const h = canvas.height / dpr;
    const st = store.getState();
    const styles = getComputedStyle(document.documentElement);
    const bg = styles.getPropertyValue('--bg').trim();
    const surface = styles.getPropertyValue('--surface').trim();
    const surfaceElev = styles.getPropertyValue('--surface-elev').trim();
    const border = styles.getPropertyValue('--border').trim();
    const borderStrong = styles.getPropertyValue('--border-strong').trim();
    const ink = styles.getPropertyValue('--ink').trim();
    const inkDim = styles.getPropertyValue('--ink-dim').trim();
    const accent = styles.getPropertyValue('--accent').trim();
    const gridSub = styles.getPropertyValue('--grid-sub').trim();
    const gridBeat = styles.getPropertyValue('--grid-beat').trim();

    laneH = Math.max(36, Math.floor(h / 8));
    stepW = Math.max(6, (w - LANE_HEADER_W) / 128);

    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);

    // Lanes
    for (let l = 0; l < 8; l++) {
      const y = l * laneH;
      const label = st.laneLabels?.[l] || `L${l + 1}`;
      const isCustom = label !== `L${l + 1}`;
      const hasClip = st.arrClips.some((c) => c.lane === l);
      ctx.fillStyle = surface;
      ctx.fillRect(0, y, LANE_HEADER_W - 1, laneH - 1);
      ctx.strokeStyle = border;
      ctx.beginPath();
      ctx.moveTo(0, y + laneH + 0.5);
      ctx.lineTo(w, y + laneH + 0.5);
      ctx.stroke();

      // Status dot
      ctx.beginPath();
      ctx.arc(14, y + laneH / 2, 3, 0, Math.PI * 2);
      ctx.fillStyle = hasClip || isCustom ? ink : inkDim;
      ctx.fill();

      ctx.save();
      ctx.beginPath();
      ctx.rect(22, y, LANE_HEADER_W - 26, laneH);
      ctx.clip();
      ctx.fillStyle = isCustom || hasClip ? ink : inkDim;
      ctx.font = '600 10px Geist Mono, monospace';
      ctx.fillText(label, 24, y + laneH / 2 + 3.5);
      ctx.restore();
    }

    ctx.strokeStyle = border;
    ctx.beginPath();
    ctx.moveTo(LANE_HEADER_W - 0.5, 0);
    ctx.lineTo(LANE_HEADER_W - 0.5, h);
    ctx.stroke();

    // Bar markers (every 16 steps = 1 bar)
    for (let s = 0; s <= 128; s += 4) {
      const x = Math.round(LANE_HEADER_W + (s - scrollX) * stepW) + 0.5;
      if (x < LANE_HEADER_W || x > w) continue;
      ctx.strokeStyle = s % 16 === 0 ? gridBeat : gridSub;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
      if (s % 16 === 0 && s < 128) {
        ctx.fillStyle = inkDim;
        ctx.font = '600 9px Geist Mono, monospace';
        ctx.fillText(`B${s / 16 + 1}`, x + 3, 10);
      }
    }

    // Clips
    for (const clip of st.arrClips) {
      const x = LANE_HEADER_W + (clip.startStep - scrollX) * stepW;
      const cw = Math.max(12, clip.lengthSteps * stepW - 2);
      const y = clip.lane * laneH + 4;
      const ch = laneH - 8;
      const isSel = st.selectedArrClipId === clip.id;

      ctx.fillStyle = surfaceElev;
      ctx.beginPath();
      ctx.roundRect(x, y, cw, ch, 5);
      ctx.fill();
      ctx.strokeStyle = isSel ? accent : borderStrong;
      ctx.lineWidth = isSel ? 1.5 : 1;
      ctx.beginPath();
      ctx.roundRect(x + 0.5, y + 0.5, cw, ch, 5);
      ctx.stroke();

      ctx.fillStyle = isSel ? accent : ink;
      ctx.font = '600 10px Geist Mono, monospace';
      ctx.fillText(clip.refId, x + 6, y + 12);

      if (clip.kind === 'pattern') {
        const pat = st.patterns[clip.refId];
        if (pat) {
          ctx.fillStyle = inkDim;
          const allNotes = Object.values(pat.notesByTrack).flat();
          for (const n of allNotes) {
            const nx = x + (n.step / Math.max(1, pat.length)) * cw;
            const ny = y + ch - 4 - ((n.midi - 24) / 72) * (ch - 18);
            ctx.fillRect(nx, ny, Math.max(2, cw / pat.length), 2);
          }
        }
      } else if (clip.kind === 'audio') {
        const ac = st.audioClips[clip.refId];
        if (ac?.peaks) {
          ctx.fillStyle = inkDim;
          const midY = y + ch * 0.6;
          for (let i = 0; i < ac.peaks.length; i++) {
            const px = x + 4 + (i / ac.peaks.length) * (cw - 8);
            const ph = ac.peaks[i] * (ch * 0.35);
            ctx.fillRect(px, midY - ph, 1, ph * 2);
          }
        }
      } else if (clip.kind === 'auto') {
        const aut = st.autoClips[clip.refId];
        if (aut?.points?.length) {
          ctx.strokeStyle = accent;
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          aut.points.forEach((pt, idx) => {
            const px = x + 4 + pt.x * (cw - 8);
            const py = y + ch - 4 - pt.y * (ch - 14);
            if (idx === 0) ctx.moveTo(px, py);
            else ctx.lineTo(px, py);
          });
          ctx.stroke();
        }
      }
    }

    // D-Pad cursor
    const curX = LANE_HEADER_W + (cursorStep - scrollX) * stepW;
    const curY = cursorLane * laneH;
    ctx.strokeStyle = borderStrong;
    ctx.strokeRect(curX + 0.5, curY + 0.5, stepW * 4, laneH);

    // Song playhead
    const playStep = st.playMode === 'SONG' ? st.currentStep % 128 : 0;
    const px = LANE_HEADER_W + (playStep - scrollX) * stepW;
    ctx.strokeStyle = accent;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(px, 0);
    ctx.lineTo(px, h);
    ctx.stroke();

    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.moveTo(px - 4, 0);
    ctx.lineTo(px + 4, 0);
    ctx.lineTo(px, 6);
    ctx.closePath();
    ctx.fill();

    ctx.restore();
  }

  function renderDetailOverlay(panelEl) {
    const st = store.getState();
    const ov = st.detailOverlay;
    const hdr = document.createElement('div');
    hdr.className = 'overlay-hdr';

    const closeBtn = document.createElement('button');
    closeBtn.className = 'ctx-chip';
    closeBtn.textContent = 'CLOSE [B]';
    closeBtn.onclick = () => {
      st.detailOverlay = null;
      store.emit('overlay', null);
    };

    if (ov.type === 'auto') {
      const ac = st.autoClips[ov.autoId];
      hdr.innerHTML = `<span>AUTOMATION // ${ac.id}</span>`;
      hdr.appendChild(closeBtn);

      const body = document.createElement('div');
      body.className = 'overlay-body';

      const targetRow = document.createElement('div');
      targetRow.style.display = 'flex';
      targetRow.style.gap = '8px';

      const trkSel = document.createElement('select');
      trkSel.className = 'rand-select';
      st.tracks.forEach((tr) => {
        const o = document.createElement('option');
        o.value = String(tr.id);
        o.textContent = `${tr.code} ${tr.name}`;
        if (tr.id === ac.targetTrackId) o.selected = true;
        trkSel.appendChild(o);
      });

      const paramSel = document.createElement('select');
      paramSel.className = 'rand-select';

      function fillParams() {
        paramSel.innerHTML = '';
        const tr = st.tracks[ac.targetTrackId];
        const volOpt = document.createElement('option');
        volOpt.value = '0:vol';
        volOpt.textContent = 'MIX // VOLUME';
        paramSel.appendChild(volOpt);
        tr.inserts.forEach((slot, sIdx) => {
          const def = getDevice(slot.deviceId);
          def?.meta.params.forEach((p) => {
            const o = document.createElement('option');
            o.value = `${sIdx}:${p.id}`;
            o.textContent = `${def.meta.name} // ${p.label}`;
            if (ac.targetSlotIdx === sIdx && ac.targetParamId === p.id) o.selected = true;
            paramSel.appendChild(o);
          });
        });
      }
      fillParams();

      trkSel.onchange = () => {
        ac.targetTrackId = Number(trkSel.value);
        fillParams();
      };
      paramSel.onchange = () => {
        const [sIdx, pid] = paramSel.value.split(':');
        ac.targetSlotIdx = Number(sIdx);
        ac.targetParamId = pid;
      };

      targetRow.append(trkSel, paramSel);

      const cWrap = document.createElement('div');
      cWrap.className = 'canvas-wrap';
      cWrap.style.border = '1px solid var(--border)';
      const acCanvas = document.createElement('canvas');
      acCanvas.width = 900;
      acCanvas.height = 360;
      cWrap.appendChild(acCanvas);
      const actx = acCanvas.getContext('2d');

      let activePt = null;
      function drawAuto() {
        const styles = getComputedStyle(document.documentElement);
        actx.fillStyle = styles.getPropertyValue('--bg').trim();
        actx.fillRect(0, 0, acCanvas.width, acCanvas.height);
        actx.strokeStyle = styles.getPropertyValue('--accent').trim();
        actx.lineWidth = 3;
        actx.beginPath();
        ac.points.forEach((p, i) => {
          const x = p.x * acCanvas.width;
          const y = (1 - p.y) * acCanvas.height;
          if (i === 0) actx.moveTo(x, y);
          else actx.lineTo(x, y);
        });
        actx.stroke();

        actx.fillStyle = styles.getPropertyValue('--ink').trim();
        for (const p of ac.points) {
          actx.beginPath();
          actx.arc(p.x * acCanvas.width, (1 - p.y) * acCanvas.height, 8, 0, Math.PI * 2);
          actx.fill();
        }
      }
      drawAuto();

      acCanvas.addEventListener('pointerdown', (e) => {
        const rect = acCanvas.getBoundingClientRect();
        const nx = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        const ny = Math.max(0, Math.min(1, 1 - (e.clientY - rect.top) / rect.height));
        store.beginGesture(`AUTO ${ac.id}`);
        activePt = ac.points.find((p) => Math.hypot(p.x - nx, p.y - ny) < 0.05);
        if (!activePt) {
          activePt = { x: nx, y: ny };
          ac.points.push(activePt);
          ac.points.sort((a, b) => a.x - b.x);
          store.markGestureDirty();
        }
        drawAuto();
      });
      acCanvas.addEventListener('pointermove', (e) => {
        if (!activePt) return;
        const rect = acCanvas.getBoundingClientRect();
        activePt.x = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        activePt.y = Math.max(0, Math.min(1, 1 - (e.clientY - rect.top) / rect.height));
        ac.points.sort((a, b) => a.x - b.x);
        store.markGestureDirty();
        drawAuto();
      });
      acCanvas.addEventListener('pointerup', () => {
        store.commitGesture();
        activePt = null;
      });
      acCanvas.addEventListener('pointercancel', () => {
        store.commitGesture();
        activePt = null;
      });

      body.append(targetRow, cWrap);
      panelEl.append(hdr, body);
      return;
    }

    if (ov.type === 'audio') {
      const ac = st.audioClips[ov.audioId];
      hdr.innerHTML = `<span>WARP INSPECTOR // ${ac.id} (${ac.name})</span>`;
      hdr.appendChild(closeBtn);
      const body = document.createElement('div');
      body.className = 'overlay-body';

      const info = document.createElement('div');
      info.className = 'telemetry-grid';
      info.innerHTML = `
        <div class="tel-cell"><span class="k">DETECTED BPM</span><span class="v">${ac.detectedBpm}</span></div>
        <div class="tel-cell"><span class="k">PROJECT BPM</span><span class="v">${st.bpm}</span></div>
        <div class="tel-cell"><span class="k">TRANSIENTS</span><span class="v">${ac.transients.length}</span></div>
      `;

      const modes = document.createElement('div');
      modes.style.display = 'flex';
      modes.style.gap = '6px';
      WARP_MODES.forEach((m) => {
        const b = document.createElement('button');
        b.className = `ctx-chip ${ac.warpMode === m ? 'active' : ''}`;
        b.textContent = m;
        b.onclick = () => {
          ac.warpMode = m;
          modes.querySelectorAll('.ctx-chip').forEach((c) => c.classList.toggle('active', c.textContent === m));
          renderBars();
        };
        modes.appendChild(b);
      });

      const wCanvas = document.createElement('canvas');
      wCanvas.width = 960;
      wCanvas.height = 240;
      wCanvas.style.width = '100%';
      wCanvas.style.height = '240px';
      wCanvas.style.border = '1px solid var(--border)';
      const wctx = wCanvas.getContext('2d');
      const styles = getComputedStyle(document.documentElement);
      wctx.fillStyle = styles.getPropertyValue('--bg').trim();
      wctx.fillRect(0, 0, wCanvas.width, wCanvas.height);
      wctx.fillStyle = styles.getPropertyValue('--ink').trim();
      ac.peaks.forEach((pk, i) => {
        const x = (i / ac.peaks.length) * wCanvas.width;
        const ph = pk * 100;
        wctx.fillRect(x, 120 - ph, 3, ph * 2);
      });
      wctx.strokeStyle = styles.getPropertyValue('--accent').trim();
      ac.transients.forEach((tr) => {
        const x = (tr / Math.max(0.1, ac.duration)) * wCanvas.width;
        wctx.beginPath();
        wctx.moveTo(x, 0);
        wctx.lineTo(x, 240);
        wctx.stroke();
      });

      body.append(info, modes, wCanvas);
      panelEl.append(hdr, body);
      return;
    }

    hdr.innerHTML = `<span>PLAYLIST // SONG OVERVIEW</span>`;
    hdr.appendChild(closeBtn);
    const body = document.createElement('div');
    body.className = 'overlay-body';
    body.innerHTML = `
      <div class="telemetry-grid">
        <div class="tel-cell"><span class="k">ARR CLIPS</span><span class="v">${st.arrClips.length}</span></div>
        <div class="tel-cell"><span class="k">AUDIO CLIPS</span><span class="v">${Object.keys(st.audioClips).length}</span></div>
        <div class="tel-cell"><span class="k">AUTO CLIPS</span><span class="v">${Object.keys(st.autoClips).length}</span></div>
      </div>
    `;
    panelEl.append(hdr, body);
  }

  function renderLaneLabelModal(modalEl) {
    const st = store.getState();
    const lane = st.detailOverlay?.lane ?? 0;
    const defLabel = `L${lane + 1}`;
    const curLabel = st.laneLabels?.[lane] || defLabel;

    const hdr = document.createElement('div');
    hdr.className = 'overlay-hdr';
    hdr.innerHTML = `<span>TRACK ${String(lane + 1).padStart(2, '0')} // LABEL</span>`;

    const closeBtn = document.createElement('button');
    closeBtn.className = 'ctx-chip';
    closeBtn.textContent = 'CLOSE [B]';
    closeBtn.onclick = () => {
      st.detailOverlay = null;
      store.emit('overlay', null);
    };
    hdr.appendChild(closeBtn);

    const body = document.createElement('div');
    body.className = 'overlay-body';

    const inputEl = document.createElement('input');
    inputEl.type = 'text';
    inputEl.className = 'hw-text-input';
    inputEl.maxLength = 12;
    inputEl.value = curLabel === defLabel ? '' : curLabel;
    inputEl.placeholder = defLabel;

    const actions = document.createElement('div');
    actions.style.display = 'flex';
    actions.style.gap = '8px';
    actions.style.justifyContent = 'flex-end';

    const resetBtn = document.createElement('button');
    resetBtn.className = 'ctx-chip';
    resetBtn.textContent = 'RESET';
    resetBtn.onclick = () => {
      store.setLaneLabel(lane, defLabel);
      st.detailOverlay = null;
      store.emit('overlay', null);
    };

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'ctx-chip';
    cancelBtn.textContent = 'CANCEL';
    cancelBtn.onclick = () => {
      st.detailOverlay = null;
      store.emit('overlay', null);
    };

    const saveBtn = document.createElement('button');
    saveBtn.className = 'ctx-chip solid';
    saveBtn.textContent = 'SAVE';
    const commit = () => {
      store.setLaneLabel(lane, inputEl.value);
      st.detailOverlay = null;
      store.emit('overlay', null);
    };
    saveBtn.onclick = commit;

    inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commit();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        st.detailOverlay = null;
        store.emit('overlay', null);
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

  function renderClipMenuModal(modalEl) {
    const st = store.getState();
    const clip = st.arrClips.find((c) => c.id === st.detailOverlay?.clipId);
    const close = () => {
      st.detailOverlay = null;
      store.emit('overlay', null);
    };
    if (!clip) {
      close();
      return;
    }

    const laneLabel = st.laneLabels?.[clip.lane] || `L${clip.lane + 1}`;
    const hdr = document.createElement('div');
    hdr.className = 'overlay-hdr';
    hdr.innerHTML = `<span>${clip.refId} @ ${laneLabel}</span>`;
    const closeBtn = document.createElement('button');
    closeBtn.className = 'ctx-chip';
    closeBtn.textContent = 'CLOSE [B]';
    closeBtn.onclick = close;
    hdr.appendChild(closeBtn);

    const body = document.createElement('div');
    body.className = 'overlay-body';
    const list = document.createElement('div');
    list.className = 'clip-menu-list';

    const makeBtn = (label, onClick, cls = '') => {
      const btn = document.createElement('button');
      btn.className = `clip-menu-btn ${cls}`.trim();
      btn.textContent = label;
      btn.onclick = onClick;
      return btn;
    };

    list.appendChild(
      makeBtn('OPEN EDITOR', () => {
        close();
        openClipEditor(clip);
      })
    );

    if (clip.kind === 'audio') {
      const ac = st.audioClips[clip.refId];
      if (ac) {
        const warpRow = document.createElement('div');
        warpRow.style.display = 'flex';
        warpRow.style.gap = '4px';
        warpRow.style.justifyContent = 'space-between';
        for (const wm of WARP_MODES) {
          const wb = document.createElement('button');
          wb.className = `ctx-chip ${ac.warpMode === wm ? 'active' : ''}`;
          wb.style.flex = '1';
          wb.style.justifyContent = 'center';
          wb.textContent = wm;
          wb.onclick = () => {
            store.pushHistory(`WARP ${wm}`);
            ac.warpMode = wm;
            warpRow.querySelectorAll('.ctx-chip').forEach((c) => c.classList.toggle('active', c.textContent === wm));
            renderBars();
          };
          warpRow.appendChild(wb);
        }
        list.appendChild(warpRow);
      }
    }

    list.appendChild(
      makeBtn('SLICE', () => {
        if (clip.lengthSteps >= 8) {
          store.pushHistory(`SLICE ${clip.refId}`);
          const half = Math.floor(clip.lengthSteps / 2);
          clip.lengthSteps = half;
          st.arrClips.push({ ...clip, id: nextId('clip'), startStep: clip.startStep + half, lengthSteps: half });
          store.emit('arr');
        }
        close();
      })
    );

    list.appendChild(
      makeBtn('DUPLICATE', () => {
        store.pushHistory(`DUP ${clip.refId}`);
        const copy = { ...clip, id: nextId('clip'), startStep: Math.min(112, clip.startStep + clip.lengthSteps) };
        st.arrClips.push(copy);
        st.selectedArrClipId = copy.id;
        store.emit('arr');
        close();
      })
    );

    if (clip.kind === 'pattern' || clip.kind === 'auto') {
      list.appendChild(
        makeBtn('MAKE UNIQUE', () => {
          store.makePatternUnique(clip.id);
          close();
        })
      );
    }

    list.appendChild(
      makeBtn('+LAB (STASH & HIDE)', () => {
        store.archiveClipToLab(clip.id, true);
        close();
      })
    );

    list.appendChild(
      makeBtn(
        'DELETE',
        () => {
          deleteClipById(clip.id);
          close();
        },
        'danger'
      )
    );

    body.appendChild(list);
    modalEl.append(hdr, body);
  }

  function renderArrAddModal(modalEl) {
    const st = store.getState();
    const close = () => {
      st.detailOverlay = null;
      store.emit('overlay', null);
    };

    const hdr = document.createElement('div');
    hdr.className = 'overlay-hdr';
    hdr.innerHTML = `<span>PLAYLIST // ADD</span>`;
    const closeBtn = document.createElement('button');
    closeBtn.className = 'ctx-chip';
    closeBtn.textContent = 'CLOSE [B]';
    closeBtn.onclick = close;
    hdr.appendChild(closeBtn);

    const body = document.createElement('div');
    body.className = 'overlay-body';
    const list = document.createElement('div');
    list.className = 'clip-menu-list';

    const makeBtn = (label, fn) => {
      const b = document.createElement('button');
      b.className = 'clip-menu-btn';
      b.textContent = label;
      b.onclick = fn;
      return b;
    };

    list.append(
      makeBtn('+ NEW PATTERN', () => {
        let nextPat = 'P01';
        for (let i = 1; i <= 64; i++) {
          const pid = `P${String(i).padStart(2, '0')}`;
          const used = Object.values(st.patterns[pid].notesByTrack).some((a) => a.length > 0);
          if (!used) {
            nextPat = pid;
            break;
          }
        }
        store.setActivePattern(nextPat);
        close();
      }),
      makeBtn('+ IMPORT AUDIO (WAV/MP3)', () => {
        close();
        triggerImport();
      }),
      makeBtn(micRecording ? '■ STOP MIC' : '● RECORD MIC', () => {
        close();
        toggleMic();
      }),
      makeBtn('+ AUTOMATION CLIP', () => {
        store.createAutomationClip(st.selectedTrackId, 0, 'cutoff');
        close();
      })
    );

    body.appendChild(list);
    modalEl.append(hdr, body);
  }

  return {
    el: root,
    tick,
    handleAction,
    renderDetailOverlay,
    renderLaneLabelModal,
    renderClipMenuModal,
    renderArrAddModal
  };
}
