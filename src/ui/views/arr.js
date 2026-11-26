import { engine } from '../../audio/engine.js';
import { input } from '../../input/gamepad.js';
import { getDevice } from '../../device-registry.js';
import { SONG_MAX_STEPS, getSongEnd, nextId, store } from '../../state/store.js';
import { attachLongPress } from '../components/longpress.js';
import { createRotary } from '../components/rotary.js';

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

  // Horizontal Scrollbar Rail
  const scrollRail = document.createElement('div');
  scrollRail.className = 'arr-scroll-rail';
  const scrollThumb = document.createElement('div');
  scrollThumb.className = 'arr-scroll-thumb';
  scrollRail.appendChild(scrollThumb);

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

  root.append(dock, canvasWrap, scrollRail, fileInput);

  let scrollX = 0;
  let stepW = 12;
  let laneH = 44;
  let cursorLane = 0;
  let cursorStep = 0;
  let micRecording = false;
  let dragClip = null;
  let dragAction = null; // 'pan' | 'ruler' | 'empty-tap' | 'pinch-pan'
  let isUserPanning = false;
  let longPressFired = false;
  let pendingTap = null;
  const activePointers = new Map();

  const RULER_H = 28;
  const DOUBLE_TAP_MS = 260;

  function getLaneHeaderW(w) {
    return w < 520 ? 74 : 112;
  }

  /** Scrollable extent: song + 8 bars of runway (and the loop), capped at 64 bars. */
  function getTimelineSteps() {
    const st = store.getState();
    const end = Math.max(getSongEnd(st) + 128, st.loop?.end ? st.loop.end + 64 : 0, 256);
    return Math.min(SONG_MAX_STEPS, Math.ceil(end / 16) * 16);
  }

  function getMaxScrollX(w) {
    const headerW = getLaneHeaderW(w);
    const visSteps = Math.max(8, (w - headerW) / Math.max(4, stepW));
    return Math.max(0, getTimelineSteps() - visSteps);
  }

  function updateArrScrollRail(w) {
    const headerW = getLaneHeaderW(w);
    const visSteps = Math.max(8, (w - headerW) / Math.max(4, stepW));
    const total = getTimelineSteps();
    const maxS = Math.max(0, total - visSteps);
    if (maxS <= 0.5) {
      scrollThumb.style.width = '100%';
      scrollThumb.style.left = '0%';
      return;
    }
    scrollX = Math.max(0, Math.min(maxS, scrollX));
    const thumbPct = Math.max(10, Math.min(100, (visSteps / total) * 100));
    const leftPct = (scrollX / maxS) * (100 - thumbPct);
    scrollThumb.style.width = `${thumbPct}%`;
    scrollThumb.style.left = `${leftPct}%`;
  }

  let railDrag = null;
  scrollRail.addEventListener('pointerdown', (e) => {
    const rect = scrollRail.getBoundingClientRect();
    const w = canvasWrap.clientWidth || rect.width;
    const maxS = getMaxScrollX(w);
    isUserPanning = true;
    scrollRail.classList.add('active');
    const norm = Math.max(0, Math.min(1, (e.clientX - rect.left) / Math.max(1, rect.width)));
    scrollX = norm * maxS;
    railDrag = { startX: e.clientX, startScroll: scrollX, maxS, railW: Math.max(1, rect.width) };
    scrollRail.setPointerCapture(e.pointerId);
  });
  scrollRail.addEventListener('pointermove', (e) => {
    if (!railDrag) return;
    const dx = e.clientX - railDrag.startX;
    scrollX = Math.max(0, Math.min(railDrag.maxS, railDrag.startScroll + (dx / railDrag.railW) * getTimelineSteps()));
  });
  const endRailDrag = () => {
    railDrag = null;
    isUserPanning = false;
    scrollRail.classList.remove('active');
  };
  scrollRail.addEventListener('pointerup', endRailDrag);
  scrollRail.addEventListener('pointercancel', endRailDrag);

  /** Full sample length in timeline steps (tempo-independent under warp). */
  function getAudioSteps(clip) {
    const ac = store.getState().audioClips[clip.refId];
    if (!ac) return clip.lengthSteps;
    return (ac.duration * Math.max(40, ac.detectedBpm || 128)) / 15;
  }

  function stepAtX(x, headerW) {
    return scrollX + (x - headerW) / stepW;
  }

  function loopEdgeHit(x, headerW) {
    const lp = store.getState().loop;
    if (!lp?.on) return null;
    const xs = headerW + (lp.start - scrollX) * stepW;
    const xe = headerW + (lp.end - scrollX) * stepW;
    const grab = 18;
    if (Math.abs(x - xe) <= grab) return 'loop-end';
    if (Math.abs(x - xs) <= grab) return 'loop-start';
    if (x > xs && x < xe) return 'loop-move';
    return null;
  }

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
      st.detailOverlay = { type: 'audio', audioId: clip.refId, clipId: clip.id };
      store.emit('overlay', st.detailOverlay);
    }
  }

  /** Split an arr clip at an absolute step; audio halves keep their place in the sample. */
  function splitClipAt(clip, atStep) {
    const st = store.getState();
    const cut = Math.round(atStep);
    if (cut <= clip.startStep || cut >= clip.startStep + clip.lengthSteps) return null;
    store.pushHistory(`SPLIT ${clip.refId}`);
    const leftLen = cut - clip.startStep;
    const right = {
      ...clip,
      id: nextId('clip'),
      startStep: cut,
      lengthSteps: clip.lengthSteps - leftLen,
      fadeInSteps: 0
    };
    // offsetSteps counts in playback direction (reverse included), so the right half continues where the left stops
    if (clip.kind === 'audio') right.offsetSteps = (clip.offsetSteps || 0) + leftLen;
    clip.lengthSteps = leftLen;
    clip.fadeOutSteps = 0;
    st.arrClips.push(right);
    st.selectedArrClipId = right.id;
    store.emit('arr');
    return right;
  }

  attachLongPress(
    canvasWrap,
    (e) => {
      if (dragClip?.moved || dragAction?.moved || activePointers.size > 1) return;
      clearPendingTap();
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const headerW = getLaneHeaderW(rect.width);
      const st = store.getState();
      const lane = Math.max(0, Math.min(7, Math.floor(Math.max(0, y - RULER_H) / laneH)));

      longPressFired = true;
      dragClip = null;
      dragAction = null;

      if (y < RULER_H) {
        if (x < headerW) return;
        const bar = Math.max(0, Math.floor(stepAtX(x, headerW) / 16));
        store.setLoop({ on: true, start: bar * 16, end: bar * 16 + 16 }, 'LOOP');
        dragAction = { type: 'loop-draw', anchorBar: bar, headerW, startX: e.clientX, moved: true };
        navigator.vibrate?.(8);
        return;
      }

      if (x < headerW) {
        st.detailOverlay = { type: 'lane-label', lane };
        store.emit('overlay', st.detailOverlay);
        return;
      }

      const hit = [...st.arrClips]
        .reverse()
        .find((c) => {
          if (c.lane !== lane) return false;
          const cx = headerW + (c.startStep - scrollX) * stepW;
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
    },
    380,
    14
  );

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
      const patName = st.patterns[pid]?.name;
      btn.className = `ctx-chip ${active ? 'active' : ''}`;
      btn.textContent = patName && patName !== pid ? `${pid}·${patName}` : pid;
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

    const renameDockBtn = document.createElement('button');
    renameDockBtn.className = 'ctx-chip';
    renameDockBtn.textContent = '✎';
    renameDockBtn.title = 'Rename Selected Clip or Pattern';
    renameDockBtn.onclick = () => {
      const selClip = st.arrClips.find((c) => c.id === st.selectedArrClipId);
      if (selClip) {
        st.detailOverlay = { type: 'clip-rename', clipId: selClip.id };
      } else {
        st.detailOverlay = { type: 'pattern-rename', patId: st.activePatternId };
      }
      store.emit('overlay', st.detailOverlay);
    };
    dock.appendChild(renameDockBtn);

    if (st.selectedArrClipId && st.arrClips.some((c) => c.id === st.selectedArrClipId)) {
      const clipMenuBtn = document.createElement('button');
      clipMenuBtn.className = 'ctx-chip';
      clipMenuBtn.textContent = '⋯';
      clipMenuBtn.title = 'Clip Options';
      clipMenuBtn.onclick = () => {
        st.detailOverlay = { type: 'clip-menu', clipId: st.selectedArrClipId };
        store.emit('overlay', st.detailOverlay);
      };
      dock.appendChild(clipMenuBtn);
    }

    const loopBtn = document.createElement('button');
    loopBtn.className = `ctx-chip loop-chip ${st.loop?.on ? 'active' : ''}`;
    loopBtn.title = 'Loop (long-press the ruler to draw, drag its edges to resize)';
    loopBtn.innerHTML = '<svg class="ico" viewBox="0 0 16 16"><path d="M3 9.5V8a3 3 0 0 1 3-3h7"/><path d="m11 3 2 2-2 2"/><path d="M13 6.5V8a3 3 0 0 1-3 3H3"/><path d="m5 13-2-2 2-2"/></svg>';
    const loopRange = document.createElement('span');
    loopRange.className = 'chip-sub';
    loopRange.textContent = `${st.loop.start / 16 + 1}–${st.loop.end / 16}`;
    loopBtn.appendChild(loopRange);
    loopBtn.onclick = () => {
      store.setLoop({ on: !st.loop.on });
      if (st.loop.on) {
        // Bring the loop into view when switching it on
        const w = canvasWrap.clientWidth || 640;
        const vis = (w - getLaneHeaderW(w)) / Math.max(4, stepW);
        if (st.loop.start < scrollX || st.loop.start > scrollX + vis * 0.8) scrollX = Math.max(0, st.loop.start - 4);
      }
    };
    dock.appendChild(loopBtn);

    const followBtn = document.createElement('button');
    followBtn.className = `ctx-chip ${st.arrFollow ? 'active' : ''}`;
    followBtn.textContent = 'FOLLOW';
    followBtn.title = 'Follow Playhead';
    followBtn.onclick = () => {
      st.arrFollow = !st.arrFollow;
      followBtn.classList.toggle('active', st.arrFollow);
    };
    dock.appendChild(followBtn);

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
    if (['arr', 'pattern', 'transport', 'view', 'history-restore', 'loop'].includes(topic)) renderBars();
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
    activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    longPressFired = false;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const headerW = getLaneHeaderW(rect.width);
    const st = store.getState();

    // Multi-finger pan
    if (activePointers.size >= 2) {
      dragClip = null;
      isUserPanning = true;
      dragAction = { type: 'pan', startX: e.clientX, startScroll: scrollX, moved: true, w: rect.width };
      return;
    }

    // Top Ruler tap/drag -> pan or scrub playhead
    if (y < RULER_H && x >= headerW) {
      const loopHit = loopEdgeHit(x, headerW);
      dragAction = {
        type: 'ruler',
        loopHit,
        startX: e.clientX,
        startScroll: scrollX,
        moved: false,
        localX: x,
        headerW,
        w: rect.width,
        origLoop: { ...st.loop }
      };
      canvas.setPointerCapture(e.pointerId);
      return;
    }

    if (x < headerW && y >= RULER_H) {
      const lane = Math.max(0, Math.min(7, Math.floor((y - RULER_H) / laneH)));
      dragAction = { type: 'lane-tap', lane, startX: e.clientX, startY: e.clientY, moved: false };
      canvas.setPointerCapture(e.pointerId);
      return;
    }
    if (x < headerW) return;
    const lane = Math.max(0, Math.min(7, Math.floor(Math.max(0, y - RULER_H) / laneH)));
    const step = Math.max(0, Math.min(SONG_MAX_STEPS - 4, Math.floor((scrollX + (x - headerW) / stepW) / 4) * 4));
    cursorLane = lane;
    cursorStep = step;

    const hit = [...st.arrClips]
      .reverse()
      .find((c) => {
        if (c.lane !== lane) return false;
        const cx = headerW + (c.startStep - scrollX) * stepW;
        const cw = Math.max(12, c.lengthSteps * stepW);
        return x >= cx && x <= cx + cw;
      });

    if (hit) {
      if (pendingTap && pendingTap.clipId !== hit.id) {
        clearPendingTap();
      }
      st.selectedArrClipId = hit.id;
      const cx = headerW + (hit.startStep - scrollX) * stepW;
      const cw = Math.max(12, hit.lengthSteps * stepW);
      // Edge grab zones scale with clip width so short clips stay movable
      const edge = Math.min(16, cw * 0.28);
      const isResize = x >= cx + cw - edge;
      const isTrimStart = hit.kind === 'audio' && x <= cx + edge;
      store.beginGesture(`EDIT ${hit.refId}`);
      dragClip = {
        clip: hit,
        isNew: false,
        moved: false,
        mode: isResize ? 'resize' : isTrimStart ? 'trim-start' : 'move',
        startX: e.clientX,
        startY: e.clientY,
        origStart: hit.startStep,
        origLane: hit.lane,
        origLen: hit.lengthSteps,
        origOffset: hit.offsetSteps || 0
      };
      canvas.setPointerCapture(e.pointerId);
      renderBars();
      return;
    }

    // Empty timeline: drag pans horizontally, quick tap paints dock clip on pointerup
    clearPendingTap();
    dragAction = {
      type: 'empty',
      startX: e.clientX,
      startY: e.clientY,
      startScroll: scrollX,
      moved: false,
      lane,
      step,
      w: rect.width
    };
    canvas.setPointerCapture(e.pointerId);
  });

  canvas.addEventListener('pointermove', (e) => {
    if (activePointers.has(e.pointerId)) {
      activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    }

    if (dragAction) {
      const dx = e.clientX - dragAction.startX;
      const dy = e.clientY - (dragAction.startY ?? e.clientY);
      if (dragAction.type === 'lane-tap') {
        if (!dragAction.moved && Math.hypot(dx, dy) > 8) dragAction.moved = true;
        return;
      }
      if (dragAction.type === 'loop-draw') {
        const rect = canvas.getBoundingClientRect();
        const bar = Math.max(0, Math.floor(stepAtX(e.clientX - rect.left, dragAction.headerW) / 16));
        const a = dragAction.anchorBar;
        const st = store.getState();
        st.loop = { on: true, start: Math.min(a, bar) * 16, end: (Math.max(a, bar) + 1) * 16 };
        store.emit('loop', st.loop);
        return;
      }
      if (dragAction.type === 'ruler' && dragAction.loopHit) {
        if (!dragAction.moved && Math.abs(dx) > 6) {
          dragAction.moved = true;
          store.pushHistory('LOOP');
        }
        if (!dragAction.moved) return;
        const st = store.getState();
        const o = dragAction.origLoop;
        const dBars = Math.round(dx / stepW / 16) * 16;
        let { start, end } = o;
        if (dragAction.loopHit === 'loop-start') start = Math.max(0, Math.min(o.end - 16, o.start + dBars));
        else if (dragAction.loopHit === 'loop-end') end = Math.max(o.start + 16, Math.min(SONG_MAX_STEPS, o.end + dBars));
        else {
          const shift = Math.max(-o.start, Math.min(SONG_MAX_STEPS - o.end, dBars));
          start = o.start + shift;
          end = o.end + shift;
        }
        if (start !== st.loop.start || end !== st.loop.end) {
          st.loop = { ...st.loop, start, end };
          store.emit('loop', st.loop);
        }
        return;
      }
      if (!dragAction.moved && Math.hypot(dx, dy) > 6) {
        dragAction.moved = true;
        isUserPanning = true;
      }
      if (dragAction.moved) {
        const maxS = getMaxScrollX(dragAction.w);
        scrollX = Math.max(0, Math.min(maxS, dragAction.startScroll - dx / Math.max(4, stepW)));
      }
      return;
    }

    if (!dragClip) return;
    const dx = e.clientX - dragClip.startX;
    const dy = e.clientY - dragClip.startY;
    if (!dragClip.moved && Math.hypot(dx, dy) <= 14) return;
    dragClip.moved = true;
    clearPendingTap();
    const isAudio = dragClip.clip.kind === 'audio';
    // Audio trims snap to 1/16, everything else to beats
    const dSteps = isAudio && dragClip.mode !== 'move' ? Math.round(dx / stepW) : Math.round(dx / stepW / 4) * 4;
    if (dragClip.mode === 'resize') {
      const minLen = isAudio ? 1 : 4;
      const maxLen = isAudio
        ? Math.max(1, Math.floor(getAudioSteps(dragClip.clip) - (dragClip.clip.offsetSteps || 0)))
        : SONG_MAX_STEPS - dragClip.clip.startStep;
      const nextLen = Math.max(minLen, Math.min(maxLen, SONG_MAX_STEPS - dragClip.clip.startStep, dragClip.origLen + dSteps));
      if (nextLen !== dragClip.clip.lengthSteps) {
        dragClip.clip.lengthSteps = nextLen;
        store.markGestureDirty();
      }
    } else if (dragClip.mode === 'trim-start') {
      const d = Math.max(-dragClip.origOffset, -dragClip.origStart, Math.min(dragClip.origLen - 1, dSteps));
      if (dragClip.clip.startStep !== dragClip.origStart + d) {
        dragClip.clip.startStep = dragClip.origStart + d;
        dragClip.clip.lengthSteps = dragClip.origLen - d;
        dragClip.clip.offsetSteps = dragClip.origOffset + d;
        store.markGestureDirty();
      }
    } else {
      const nextStart = Math.max(0, Math.min(SONG_MAX_STEPS - dragClip.clip.lengthSteps, dragClip.origStart + dSteps));
      const nextLane = Math.max(0, Math.min(7, dragClip.origLane + Math.round(dy / laneH)));
      if (nextStart !== dragClip.clip.startStep || nextLane !== dragClip.clip.lane) {
        dragClip.clip.startStep = nextStart;
        dragClip.clip.lane = nextLane;
        store.markGestureDirty();
      }
    }
  });

  canvas.addEventListener('pointerup', (e) => {
    activePointers.delete(e.pointerId);
    const finishedAction = dragAction;
    dragAction = null;
    isUserPanning = false;

    if (finishedAction && !longPressFired) {
      if (finishedAction.type === 'lane-tap' && !finishedAction.moved) {
        const st = store.getState();
        st.detailOverlay = { type: 'lane-label', lane: finishedAction.lane };
        store.emit('overlay', st.detailOverlay);
      } else if (finishedAction.type === 'ruler' && !finishedAction.moved) {
        const st = store.getState();
        const targetStep = Math.max(0, Math.min(SONG_MAX_STEPS - 1, Math.round(scrollX + (finishedAction.localX - finishedAction.headerW) / stepW)));
        st.currentStep = targetStep;
        store.emit('step', targetStep);
      } else if (finishedAction.type === 'empty' && !finishedAction.moved) {
        const st = store.getState();
        const dockClip = st.selectedDockClip || { kind: 'pattern', refId: st.activePatternId };
        const defaultLen =
          dockClip.kind === 'pattern'
            ? st.patterns[dockClip.refId]?.length || 16
            : dockClip.kind === 'audio'
            ? Math.max(16, Math.round((st.audioClips[dockClip.refId]?.duration || 2) * (st.bpm / 60) * 4))
            : 32;
        store.pushHistory(`PAINT ${dockClip.refId}`);
        const created = {
          id: nextId('clip'),
          kind: dockClip.kind,
          refId: dockClip.refId,
          lane: finishedAction.lane,
          startStep: finishedAction.step,
          lengthSteps: defaultLen,
          trackOverride: null
        };
        st.arrClips.push(created);
        st.selectedArrClipId = created.id;
        renderBars();
      }
      longPressFired = false;
      return;
    }

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

  canvas.addEventListener('pointercancel', (e) => {
    activePointers.delete(e.pointerId);
    store.commitGesture();
    dragClip = null;
    dragAction = null;
    isUserPanning = false;
    longPressFired = false;
  });

  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const maxS = getMaxScrollX(canvasWrap.clientWidth || 640);
      const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      scrollX = Math.max(0, Math.min(maxS, scrollX + delta / Math.max(4, stepW)));
    },
    { passive: false }
  );

  function handleAction(action) {
    const st = store.getState();
    if (st.view !== 'ARR' || st.detailOverlay) return;

    if (action.type === 'SELECT') {
      store.setLoop({ on: !st.loop.on });
      return;
    }
    if (action.type === 'DPAD' && action.select) {
      // SELECT + ←/→ resizes the loop end, SELECT + ↑/↓ slides the whole loop, one bar at a time
      const lp = st.loop;
      if (action.dir === 'LEFT') store.setLoop({ on: true, end: Math.max(lp.start + 16, lp.end - 16) });
      if (action.dir === 'RIGHT') store.setLoop({ on: true, end: lp.end + 16 });
      if (action.dir === 'UP' && lp.start >= 16) store.setLoop({ on: true, start: lp.start - 16, end: lp.end - 16 });
      if (action.dir === 'DOWN') store.setLoop({ on: true, start: lp.start + 16, end: lp.end + 16 });
      return;
    }
    if (action.type === 'DPAD') {
      if (action.dir === 'UP') cursorLane = Math.max(0, cursorLane - 1);
      if (action.dir === 'DOWN') cursorLane = Math.min(7, cursorLane + 1);
      if (action.dir === 'LEFT') cursorStep = Math.max(0, cursorStep - 4);
      if (action.dir === 'RIGHT') cursorStep = Math.min(SONG_MAX_STEPS - 4, cursorStep + 4);
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
      if (action.lx) scrollX = Math.max(0, Math.min(getMaxScrollX(canvasWrap.clientWidth || 640), scrollX + action.lx * 0.8));
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
    const fill = styles.getPropertyValue('--fill').trim();
    const fillStrong = styles.getPropertyValue('--fill-strong').trim();
    const inkFaint = styles.getPropertyValue('--ink-faint').trim();
    const clipFill = styles.getPropertyValue('--clip').trim() || surfaceElev;
    const clipSel = styles.getPropertyValue('--clip-sel').trim() || surfaceElev;

    const headerW = getLaneHeaderW(w);
    laneH = Math.max(32, Math.floor((h - RULER_H) / 8));
    stepW = Math.max(7, (w - headerW) / (w < 680 ? 48 : 80));

    const visSteps = Math.max(8, (w - headerW) / stepW);
    const timelineSteps = getTimelineSteps();
    const maxS = Math.max(0, timelineSteps - visSteps);
    const playStep = st.playMode === 'SONG' ? st.currentStep : 0;

    if (st.isPlaying && st.playMode === 'SONG' && st.arrFollow && !isUserPanning && !dragClip) {
      if (playStep < scrollX + visSteps * 0.12) {
        scrollX = Math.max(0, playStep - visSteps * 0.15);
      } else if (playStep > scrollX + visSteps * 0.85) {
        scrollX = Math.min(maxS, playStep - visSteps * 0.35);
      }
    }
    scrollX = Math.max(0, Math.min(maxS, scrollX));
    updateArrScrollRail(w);

    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);

    // Top bar ruler
    ctx.fillStyle = surface;
    ctx.fillRect(0, 0, w, RULER_H);
    ctx.strokeStyle = border;
    ctx.beginPath();
    ctx.moveTo(0, RULER_H + 0.5);
    ctx.lineTo(w, RULER_H + 0.5);
    ctx.stroke();

    // Lanes
    for (let l = 0; l < 8; l++) {
      const y = RULER_H + l * laneH;
      const customLane = st.laneLabels?.[l];
      const tr = st.tracks[l];
      const isDefaultLane = !customLane || customLane === `L${l + 1}`;
      const label = isDefaultLane ? (tr ? `${tr.code} ${tr.name}` : `L${l + 1}`) : customLane;
      const hasClip = st.arrClips.some((c) => c.lane === l);
      const isCustom = !isDefaultLane || Boolean(tr?.customName);
      ctx.fillStyle = surface;
      ctx.fillRect(0, y, headerW - 1, laneH - 1);
      ctx.strokeStyle = border;
      ctx.beginPath();
      ctx.moveTo(0, y + laneH + 0.5);
      ctx.lineTo(w, y + laneH + 0.5);
      ctx.stroke();

      // Status dot
      ctx.beginPath();
      ctx.arc(10, y + laneH / 2, 2.5, 0, Math.PI * 2);
      ctx.fillStyle = hasClip || isCustom ? ink : inkDim;
      ctx.fill();

      ctx.save();
      ctx.beginPath();
      ctx.rect(16, y, headerW - 18, laneH);
      ctx.clip();
      ctx.fillStyle = isCustom || hasClip ? ink : inkDim;
      ctx.font = '600 9.5px Geist Mono, monospace';
      ctx.fillText(label, 18, y + laneH / 2 + 3.5);
      ctx.restore();
    }

    ctx.strokeStyle = border;
    ctx.beginPath();
    ctx.moveTo(headerW - 0.5, 0);
    ctx.lineTo(headerW - 0.5, h);
    ctx.stroke();

    // Bar markers (every 16 steps = 1 bar)
    const firstS = Math.max(0, Math.floor(scrollX / 4) * 4);
    const lastS = Math.min(timelineSteps, Math.ceil((scrollX + visSteps) / 4) * 4);
    for (let s = firstS; s <= lastS; s += 4) {
      const x = Math.round(headerW + (s - scrollX) * stepW) + 0.5;
      if (x < headerW || x > w) continue;
      ctx.strokeStyle = s % 16 === 0 ? gridBeat : gridSub;
      ctx.beginPath();
      ctx.moveTo(x, s % 16 === 0 ? 4 : RULER_H);
      ctx.lineTo(x, h);
      ctx.stroke();
      if (s % 16 === 0 && s < timelineSteps) {
        ctx.fillStyle = inkDim;
        ctx.font = '500 9px Geist Mono, monospace';
        ctx.fillText(`${s / 16 + 1}`, x + 5, 15);
      }
    }

    // Loop brace: band in the ruler, hairlines through the lanes
    const lp = st.loop;
    if (lp) {
      const lx0 = headerW + (lp.start - scrollX) * stepW;
      const lx1 = headerW + (lp.end - scrollX) * stepW;
      const bx0 = Math.max(headerW, lx0);
      const bx1 = Math.min(w, lx1);
      if (bx1 > bx0) {
        if (lp.on) {
          ctx.fillStyle = fillStrong;
          ctx.fillRect(bx0, 0, bx1 - bx0, RULER_H);
          ctx.fillStyle = ink;
          ctx.fillRect(bx0, RULER_H - 3, bx1 - bx0, 3);
          ctx.fillStyle = gridSub;
          ctx.fillRect(bx0, RULER_H, bx1 - bx0, h - RULER_H);
        } else {
          ctx.fillStyle = inkFaint;
          ctx.fillRect(bx0, RULER_H - 2, bx1 - bx0, 2);
        }
      }
      if (lp.on) {
        ctx.fillStyle = ink;
        for (const ex of [lx0, lx1]) {
          if (ex < headerW - 1 || ex > w + 1) continue;
          ctx.fillRect(Math.round(ex) - 1, 4, 2, RULER_H - 4);
          ctx.fillStyle = inkFaint;
          ctx.fillRect(Math.round(ex), RULER_H, 1, h - RULER_H);
          ctx.fillStyle = ink;
        }
      }
    }

    // Clips
    for (const clip of st.arrClips) {
      const x = headerW + (clip.startStep - scrollX) * stepW;
      const cw = Math.max(12, clip.lengthSteps * stepW - 2);
      if (x + cw < headerW || x > w) continue;
      const drawX = Math.max(headerW, x);
      const drawW = Math.max(4, x + cw - drawX);
      const y = RULER_H + clip.lane * laneH + 4;
      const ch = laneH - 8;
      const isSel = st.selectedArrClipId === clip.id;

      ctx.fillStyle = isSel ? clipSel : clipFill;
      ctx.beginPath();
      ctx.roundRect(drawX, y, drawW, ch, 3);
      ctx.fill();
      if (isSel) {
        ctx.strokeStyle = ink;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.roundRect(drawX + 0.5, y + 0.5, drawW - 1, ch - 1, 3);
        ctx.stroke();
      }

      const clipLabel =
        clip.name ||
        (clip.kind === 'pattern'
          ? st.patterns[clip.refId]?.name
          : clip.kind === 'audio'
          ? st.audioClips[clip.refId]?.name
          : st.autoClips[clip.refId]?.name) ||
        clip.refId;
      const clipSwing = clip.kind === 'pattern' ? (clip.swing ?? st.patterns[clip.refId]?.swing ?? 0) : 0;
      const fullTag = clipSwing > 0 ? `${clipLabel} ·${clipSwing}%` : clipLabel;

      ctx.save();
      ctx.beginPath();
      ctx.rect(drawX + 3, y + 1, Math.max(0, drawW - 6), ch - 2);
      ctx.clip();
      ctx.fillStyle = ink;
      ctx.font = '500 10px Geist Mono, monospace';
      ctx.fillText(fullTag, drawX + 6, y + 12);

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
        if (ac?.peaks?.length) {
          // Only the trimmed window of the sample, in playback direction, scaled by clip gain
          const total = getAudioSteps(clip);
          const off = clip.offsetSteps || 0;
          const gainLin = Math.min(2, Math.pow(10, (clip.gainDb || 0) / 20));
          const n = ac.peaks.length;
          const midY = y + ch * 0.6;
          const amp = ch * 0.33 * gainLin;
          ctx.fillStyle = inkDim;
          const cols = Math.max(1, Math.floor(cw / 2));
          for (let c = 0; c < cols; c++) {
            const stepPos = off + (c / cols) * clip.lengthSteps;
            let idx = Math.floor((stepPos / total) * n);
            if (clip.reverse) idx = n - 1 - idx;
            if (idx < 0 || idx >= n) continue;
            const ph = Math.max(0.5, Math.min(ch * 0.4, ac.peaks[idx] * amp));
            ctx.fillRect(x + c * 2, midY - ph, 1, ph * 2);
          }
          // Fade ramps
          const fi = (clip.fadeInSteps || 0) * stepW;
          const fo = (clip.fadeOutSteps || 0) * stepW;
          ctx.strokeStyle = ink;
          ctx.lineWidth = 1;
          if (fi > 1) {
            ctx.beginPath();
            ctx.moveTo(x, y + ch);
            ctx.lineTo(x + fi, y + 16);
            ctx.stroke();
          }
          if (fo > 1) {
            ctx.beginPath();
            ctx.moveTo(x + cw - fo, y + 16);
            ctx.lineTo(x + cw, y + ch);
            ctx.stroke();
          }
          if (isSel) {
            // Trim grips
            ctx.fillStyle = ink;
            ctx.fillRect(x + 1, y + ch / 2 - 7, 2, 14);
            ctx.fillRect(x + cw - 3, y + ch / 2 - 7, 2, 14);
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
      ctx.restore();
    }

    // D-Pad cursor: only when a hardware pad is connected (otherwise it reads as a phantom clip)
    const curX = headerW + (cursorStep - scrollX) * stepW;
    const curY = RULER_H + cursorLane * laneH;
    if (input.getGamepadState().connected && curX >= headerW && curX < w) {
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = borderStrong;
      ctx.strokeRect(curX + 0.5, curY + 0.5, stepW * 4, laneH);
      ctx.setLineDash([]);
    }

    // Song playhead
    const px = headerW + (playStep - scrollX) * stepW;
    if (px >= headerW && px <= w) {
      ctx.strokeStyle = accent;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(px, 0);
      ctx.lineTo(px, h);
      ctx.stroke();

      ctx.fillStyle = accent;
      ctx.beginPath();
      ctx.moveTo(px - 4.5, 0);
      ctx.lineTo(px + 4.5, 0);
      ctx.lineTo(px, 7);
      ctx.closePath();
      ctx.fill();
    }

    ctx.restore();
  }

  function renderDetailOverlay(panelEl) {
    const st = store.getState();
    const ov = st.detailOverlay;
    const hdr = document.createElement('div');
    hdr.className = 'overlay-hdr';

    const closeBtn = document.createElement('button');
    closeBtn.className = 'ctx-chip';
    closeBtn.innerHTML = '<svg class="ico" viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8"/></svg>';
    closeBtn.title = 'Close [B]';
    closeBtn.classList.add('icon-only');
    closeBtn.onclick = () => {
      st.detailOverlay = null;
      store.emit('overlay', null);
    };

    if (ov.type === 'auto') {
      const ac = st.autoClips[ov.autoId];
      hdr.innerHTML = `<span>AUTOMATION <i class="oh-sub">${ac.id}</i></span>`;
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
        volOpt.textContent = 'MIX · VOLUME';
        paramSel.appendChild(volOpt);
        tr.inserts.forEach((slot, sIdx) => {
          const def = getDevice(slot.deviceId);
          def?.meta.params.forEach((p) => {
            const o = document.createElement('option');
            o.value = `${sIdx}:${p.id}`;
            o.textContent = `${def.meta.name} · ${p.label}`;
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
      renderSampleEditor(panelEl, hdr, closeBtn, ov);
      return;
    }

    hdr.innerHTML = `<span>SONG</span>`;
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


  /**
   * Sample editor for one playlist placement of an audio clip.
   * Waveform shows the whole sample; the clip's window is bright. Drag the window edges to trim,
   * the top grips to fade, the window body to slip the audio under the clip.
   */
  function renderSampleEditor(panelEl, hdr, closeBtn, ov) {
    const st = store.getState();
    const ac = st.audioClips[ov.audioId];
    const clip = st.arrClips.find((c) => c.id === ov.clipId) || st.arrClips.find((c) => c.kind === 'audio' && c.refId === ov.audioId);
    if (!ac || !clip) {
      hdr.innerHTML = '<span>SAMPLE</span>';
      hdr.appendChild(closeBtn);
      panelEl.append(hdr);
      return;
    }

    const title = document.createElement('span');
    title.textContent = 'SAMPLE ';
    const sub = document.createElement('i');
    sub.className = 'oh-sub';
    sub.textContent = ac.name || ac.id;
    title.appendChild(sub);

    const actions = document.createElement('div');
    actions.className = 'oh-actions';
    const playBtn = document.createElement('button');
    playBtn.className = 'ctx-chip icon-only';
    playBtn.title = 'Preview clip';
    const icoPlay = '<svg class="ico" viewBox="0 0 16 16"><path d="M5 3.2v9.6c0 .4.4.6.7.4l7.2-4.8a.5.5 0 0 0 0-.8L5.7 2.8c-.3-.2-.7 0-.7.4z" fill="currentColor" stroke="none"/></svg>';
    const icoStop = '<svg class="ico" viewBox="0 0 16 16"><rect x="4" y="4" width="8" height="8" rx="1" fill="currentColor" stroke="none"/></svg>';
    playBtn.innerHTML = icoPlay;
    let previewTimer = null;
    playBtn.onclick = () => {
      engine.unlock();
      engine.previewArrClip(clip);
      clearTimeout(previewTimer);
      const on = engine.isPreviewingClip();
      playBtn.innerHTML = on ? icoStop : icoPlay;
      if (on) {
        const sec = clip.lengthSteps * (15 / store.getState().bpm) + 0.1;
        previewTimer = setTimeout(() => {
          if (playBtn.isConnected) playBtn.innerHTML = engine.isPreviewingClip() ? icoStop : icoPlay;
        }, sec * 1000);
      }
    };
    actions.append(playBtn, closeBtn);
    hdr.innerHTML = '';
    hdr.append(title, actions);

    const body = document.createElement('div');
    body.className = 'overlay-body smp-body';

    const wave = document.createElement('canvas');
    wave.className = 'smp-wave';
    const wctx = wave.getContext('2d');

    const total = () => getAudioSteps(clip);
    const geom = () => {
      const r = wave.getBoundingClientRect();
      const pad = 10;
      const W = Math.max(40, r.width - pad * 2);
      const sx = (steps) => pad + (steps / total()) * W;
      return { r, pad, W, sx, toSteps: (px) => ((px - pad) / W) * total() };
    };

    function draw() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const r = wave.getBoundingClientRect();
      if (r.width < 10) return;
      if (wave.width !== Math.round(r.width * dpr) || wave.height !== Math.round(r.height * dpr)) {
        wave.width = Math.round(r.width * dpr);
        wave.height = Math.round(r.height * dpr);
      }
      const cs = getComputedStyle(document.documentElement);
      const c = (v) => cs.getPropertyValue(v).trim();
      const w = r.width;
      const h = r.height;
      const { sx } = geom();
      wctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      wctx.fillStyle = c('--surface');
      wctx.fillRect(0, 0, w, h);

      // Beat grid
      const tot = total();
      for (let b = 0; b <= tot; b += 4) {
        wctx.fillStyle = b % 16 === 0 ? c('--grid-beat') : c('--grid-sub');
        wctx.fillRect(Math.round(sx(b)), 0, 1, h);
      }

      const off = clip.offsetSteps || 0;
      const x0 = sx(off);
      const x1 = sx(off + clip.lengthSteps);
      const n = ac.peaks?.length || 0;
      const mid = h * 0.56;
      const gainLin = Math.min(2, Math.pow(10, (clip.gainDb || 0) / 20));
      for (let px = 10; px < w - 10; px += 2) {
        const stepPos = geom().toSteps(px);
        let idx = Math.floor((stepPos / tot) * n);
        if (clip.reverse) idx = n - 1 - idx;
        if (idx < 0 || idx >= n) continue;
        const inside = px >= x0 && px <= x1;
        const ph = Math.max(0.5, Math.min(h * 0.4, ac.peaks[idx] * h * 0.36 * (inside ? gainLin : 1)));
        wctx.fillStyle = inside ? c('--ink') : c('--ink-faint');
        wctx.fillRect(px, mid - ph, 1, ph * 2);
      }

      // Window frame + grips
      wctx.fillStyle = c('--ink');
      wctx.fillRect(Math.round(x0) - 1, 0, 2, h);
      wctx.fillRect(Math.round(x1) - 1, 0, 2, h);
      wctx.fillRect(Math.round(x0) - 1, h - 22, 8, 22);
      wctx.fillRect(Math.round(x1) - 7, h - 22, 8, 22);

      // Fades
      const fi = sx(off + (clip.fadeInSteps || 0)) - x0;
      const fo = x1 - sx(off + clip.lengthSteps - (clip.fadeOutSteps || 0));
      wctx.strokeStyle = c('--ink');
      wctx.lineWidth = 1;
      wctx.beginPath();
      wctx.moveTo(x0, h - 1);
      wctx.lineTo(x0 + fi, 14);
      wctx.lineTo(x1 - fo, 14);
      wctx.lineTo(x1, h - 1);
      wctx.stroke();
      wctx.fillStyle = c('--ink');
      for (const fx of [x0 + fi, x1 - fo]) {
        wctx.beginPath();
        wctx.arc(fx, 14, 5, 0, Math.PI * 2);
        wctx.fill();
      }

      // Readout
      wctx.fillStyle = c('--ink-dim');
      wctx.font = '500 10px Geist Mono, monospace';
      wctx.textAlign = 'right';
      const beats = (clip.lengthSteps / 4).toFixed(clip.lengthSteps % 4 ? 2 : 0);
      wctx.fillText(`${beats} BEATS  ${(clip.gainDb || 0) >= 0 ? '+' : ''}${(clip.gainDb || 0).toFixed(1)} dB${clip.reverse ? '  REV' : ''}`, w - 14, h - 30);
      wctx.textAlign = 'left';
    }

    let drag = null;
    wave.addEventListener('pointerdown', (e) => {
      const { r, sx, toSteps } = geom();
      const x = e.clientX - r.left;
      const y = e.clientY - r.top;
      const off = clip.offsetSteps || 0;
      const x0 = sx(off);
      const x1 = sx(off + clip.lengthSteps);
      const fiX = sx(off + (clip.fadeInSteps || 0));
      const foX = sx(off + clip.lengthSteps - (clip.fadeOutSteps || 0));
      let mode = null;
      if (y < 34 && Math.abs(x - fiX) < 18) mode = 'fade-in';
      else if (y < 34 && Math.abs(x - foX) < 18) mode = 'fade-out';
      else if (Math.abs(x - x0) < 18) mode = 'start';
      else if (Math.abs(x - x1) < 18) mode = 'end';
      else if (x > x0 && x < x1) mode = 'slip';
      if (!mode) return;
      store.beginGesture(`SAMPLE ${mode.toUpperCase()}`);
      drag = { mode, x0: toSteps(x), orig: { ...clip } };
      wave.setPointerCapture(e.pointerId);
    });
    wave.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const { r, toSteps } = geom();
      const d = Math.round(toSteps(e.clientX - r.left) - drag.x0);
      const o = drag.orig;
      const off0 = o.offsetSteps || 0;
      const tot = Math.floor(total());
      if (drag.mode === 'start') {
        const dd = Math.max(-off0, -o.startStep, Math.min(o.lengthSteps - 1, d));
        clip.offsetSteps = off0 + dd;
        clip.startStep = o.startStep + dd;
        clip.lengthSteps = o.lengthSteps - dd;
      } else if (drag.mode === 'end') {
        clip.lengthSteps = Math.max(1, Math.min(tot - off0, o.lengthSteps + d));
      } else if (drag.mode === 'slip') {
        clip.offsetSteps = Math.max(0, Math.min(tot - o.lengthSteps, off0 + d));
      } else if (drag.mode === 'fade-in') {
        clip.fadeInSteps = Math.max(0, Math.min(clip.lengthSteps - (clip.fadeOutSteps || 0), (o.fadeInSteps || 0) + d));
      } else if (drag.mode === 'fade-out') {
        clip.fadeOutSteps = Math.max(0, Math.min(clip.lengthSteps - (clip.fadeInSteps || 0), (o.fadeOutSteps || 0) - d));
      }
      clip.fadeInSteps = Math.min(clip.fadeInSteps || 0, clip.lengthSteps);
      clip.fadeOutSteps = Math.min(clip.fadeOutSteps || 0, clip.lengthSteps - (clip.fadeInSteps || 0));
      store.markGestureDirty();
      draw();
    });
    const endDrag = () => {
      if (!drag) return;
      drag = null;
      store.commitGesture();
      store.emit('arr');
    };
    wave.addEventListener('pointerup', endDrag);
    wave.addEventListener('pointercancel', endDrag);

    // Controls
    const ctrl = document.createElement('div');
    ctrl.className = 'smp-ctrl';

    const gainRot = createRotary({
      param: { id: 'gain', label: 'GAIN', min: -24, max: 12, default: 0, step: 0.5, unit: 'dB' },
      value: clip.gainDb || 0,
      size: 38,
      onGestureStart: () => store.beginGesture('CLIP GAIN'),
      onGestureEnd: () => store.commitGesture(),
      onChange: (v) => {
        clip.gainDb = v;
        store.markGestureDirty();
        draw();
      }
    });
    const pitchRot = createRotary({
      param: { id: 'pitch', label: 'PITCH', min: -12, max: 12, default: 0, step: 1, unit: 'st' },
      value: ac.pitch || 0,
      size: 38,
      onGestureStart: () => store.beginGesture('SAMPLE PITCH'),
      onGestureEnd: () => store.commitGesture(),
      onChange: (v) => {
        ac.pitch = v;
        store.markGestureDirty();
      }
    });

    const tools = document.createElement('div');
    tools.className = 'smp-tools';
    const mkChip = (label, title, fn, cls = '') => {
      const b = document.createElement('button');
      b.className = `ctx-chip ${cls}`.trim();
      b.textContent = label;
      b.title = title;
      b.onclick = fn;
      tools.appendChild(b);
      return b;
    };
    const revBtn = mkChip('REV', 'Reverse', () => {
      store.pushHistory('REVERSE');
      const tot = total();
      // Keep the same slice of audio, now played backwards
      clip.offsetSteps = Math.max(0, Math.round(tot - (clip.offsetSteps || 0) - clip.lengthSteps));
      clip.reverse = !clip.reverse;
      revBtn.classList.toggle('active', clip.reverse);
      [clip.fadeInSteps, clip.fadeOutSteps] = [clip.fadeOutSteps || 0, clip.fadeInSteps || 0];
      draw();
      store.emit('arr');
    }, clip.reverse ? 'active' : '');
    mkChip('SPLIT', 'Split at playhead (or middle)', () => {
      const ph = store.getState().currentStep;
      const inside = ph > clip.startStep && ph < clip.startStep + clip.lengthSteps;
      splitClipAt(clip, inside ? ph : clip.startStep + Math.floor(clip.lengthSteps / 2));
      draw();
    });
    mkChip('FIT', 'Reset trims to the whole sample', () => {
      store.pushHistory('FIT SAMPLE');
      clip.offsetSteps = 0;
      clip.lengthSteps = Math.max(1, Math.min(SONG_MAX_STEPS - clip.startStep, Math.round(total())));
      clip.fadeInSteps = 0;
      clip.fadeOutSteps = 0;
      draw();
      store.emit('arr');
    });

    const warp = document.createElement('div');
    warp.className = 'dsp-seg-bar smp-warp';
    warp.style.gridTemplateColumns = `repeat(${WARP_MODES.length}, 1fr)`;
    WARP_MODES.forEach((m) => {
      const b = document.createElement('button');
      b.className = `dsp-seg-btn ${ac.warpMode === m ? 'active' : ''}`;
      b.textContent = m === 'RE-PITCH' ? 'REPITCH' : m;
      b.onclick = () => {
        store.pushHistory(`WARP ${m}`);
        ac.warpMode = m;
        warp.querySelectorAll('.dsp-seg-btn').forEach((x) => x.classList.toggle('active', x === b));
        renderBars();
      };
      warp.appendChild(b);
    });

    const right = document.createElement('div');
    right.className = 'smp-right';
    right.append(warp, tools);
    ctrl.append(gainRot.el, pitchRot.el, right);
    body.append(wave, ctrl);
    panelEl.append(hdr, body);

    const ro = new ResizeObserver(() => {
      if (!wave.isConnected) {
        ro.disconnect();
        return;
      }
      draw();
    });
    ro.observe(wave);
    requestAnimationFrame(draw);
  }

  function renderLaneLabelModal(modalEl) {
    const st = store.getState();
    const lane = st.detailOverlay?.lane ?? 0;
    const defLabel = `L${lane + 1}`;
    const curLabel = st.laneLabels?.[lane] || defLabel;

    const hdr = document.createElement('div');
    hdr.className = 'overlay-hdr';
    hdr.innerHTML = `<span>TRACK ${String(lane + 1).padStart(2, '0')} <i class="oh-sub">LABEL</i></span>`;

    const closeBtn = document.createElement('button');
    closeBtn.className = 'ctx-chip';
    closeBtn.innerHTML = '<svg class="ico" viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8"/></svg>';
    closeBtn.title = 'Close [B]';
    closeBtn.classList.add('icon-only');
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
    closeBtn.innerHTML = '<svg class="ico" viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8"/></svg>';
    closeBtn.title = 'Close [B]';
    closeBtn.classList.add('icon-only');
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

    list.appendChild(
      makeBtn('RENAME CLIP', () => {
        st.detailOverlay = { type: 'clip-rename', clipId: clip.id };
        store.emit('overlay', st.detailOverlay);
      })
    );

    if (clip.kind === 'pattern') {
      const curSwing = clip.swing ?? st.patterns[clip.refId]?.swing ?? 0;
      const swingRow = document.createElement('div');
      swingRow.className = 'rand-row';
      const valSpan = document.createElement('span');
      valSpan.textContent = `${curSwing}%`;
      swingRow.innerHTML = `<span>SWING</span>`;
      const rangeInp = document.createElement('input');
      rangeInp.type = 'range';
      rangeInp.className = 'rand-range';
      rangeInp.min = '0';
      rangeInp.max = '80';
      rangeInp.value = String(curSwing);
      rangeInp.oninput = () => {
        const v = Number(rangeInp.value);
        valSpan.textContent = `${v}%`;
        store.setClipSwing(clip.id, v);
      };
      swingRow.append(rangeInp, valSpan);
      list.appendChild(swingRow);
    }

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
      makeBtn('SPLIT', () => {
        const ph = st.currentStep;
        const inside = ph > clip.startStep && ph < clip.startStep + clip.lengthSteps;
        const at = inside ? ph : clip.startStep + Math.floor(clip.lengthSteps / 2 / (clip.kind === 'audio' ? 1 : 4)) * (clip.kind === 'audio' ? 1 : 4);
        splitClipAt(clip, at);
        close();
      })
    );

    list.appendChild(
      makeBtn('DUPLICATE', () => {
        store.pushHistory(`DUP ${clip.refId}`);
        const copy = { ...clip, id: nextId('clip'), startStep: Math.min(SONG_MAX_STEPS - clip.lengthSteps, clip.startStep + clip.lengthSteps) };
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
    hdr.innerHTML = `<span>ADD CLIP</span>`;
    const closeBtn = document.createElement('button');
    closeBtn.className = 'ctx-chip';
    closeBtn.innerHTML = '<svg class="ico" viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8"/></svg>';
    closeBtn.title = 'Close [B]';
    closeBtn.classList.add('icon-only');
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
      makeBtn('LIBRARY', () => {
        const step = st.playMode === 'SONG' ? Math.floor(st.currentStep / 16) * 16 : 0;
        st.detailOverlay = { type: 'library', target: { kind: 'playlist', step } };
        store.emit('overlay', st.detailOverlay);
      }),
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

  function renderClipRenameModal(modalEl) {
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

    const curName =
      clip.name ||
      (clip.kind === 'pattern' ? st.patterns[clip.refId]?.name : clip.kind === 'audio' ? st.audioClips[clip.refId]?.name : st.autoClips[clip.refId]?.name) ||
      clip.refId;

    const hdr = document.createElement('div');
    hdr.className = 'overlay-hdr';
    hdr.innerHTML = `<span>${clip.refId} <i class="oh-sub">RENAME</i></span>`;
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
    inputEl.maxLength = 16;
    inputEl.value = curName === clip.refId ? '' : curName;
    inputEl.placeholder = clip.refId;

    const actions = document.createElement('div');
    actions.style.display = 'flex';
    actions.style.gap = '8px';
    actions.style.justifyContent = 'flex-end';

    const resetBtn = document.createElement('button');
    resetBtn.className = 'ctx-chip';
    resetBtn.textContent = 'RESET';
    resetBtn.onclick = () => {
      store.renameClip(clip.id, '');
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
      store.renameClip(clip.id, inputEl.value);
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

  function renderPatternRenameModal(modalEl) {
    const st = store.getState();
    const patId = st.detailOverlay?.patId || st.activePatternId;
    const pat = st.patterns[patId];
    const close = () => {
      st.detailOverlay = null;
      store.emit('overlay', null);
    };
    if (!pat) {
      close();
      return;
    }

    const hdr = document.createElement('div');
    hdr.className = 'overlay-hdr';
    hdr.innerHTML = `<span>${patId} <i class="oh-sub">PATTERN NAME</i></span>`;
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
    inputEl.maxLength = 16;
    inputEl.value = pat.name === patId ? '' : pat.name;
    inputEl.placeholder = patId;

    const actions = document.createElement('div');
    actions.style.display = 'flex';
    actions.style.gap = '8px';
    actions.style.justifyContent = 'flex-end';

    const resetBtn = document.createElement('button');
    resetBtn.className = 'ctx-chip';
    resetBtn.textContent = 'RESET';
    resetBtn.onclick = () => {
      store.renamePattern(patId, '');
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
      store.renamePattern(patId, inputEl.value);
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

  return {
    el: root,
    tick,
    handleAction,
    renderDetailOverlay,
    renderLaneLabelModal,
    renderClipRenameModal,
    renderPatternRenameModal,
    renderClipMenuModal,
    renderArrAddModal
  };
}
