import { dbToMeterNorm, engine } from '../audio/engine.js';
import { store } from '../state/store.js';
import { downloadProjectArchive, importProjectArchive, saveAutosave } from '../storage/project-archive.js';
import { attachLongPress } from './components/longpress.js';

let hiddenProjRsInput = null;
function openRsPicker(onFile) {
  if (!hiddenProjRsInput) {
    hiddenProjRsInput = document.createElement('input');
    hiddenProjRsInput.type = 'file';
    hiddenProjRsInput.accept = '.roomservice,.zip';
    hiddenProjRsInput.style.display = 'none';
    document.body.appendChild(hiddenProjRsInput);
  }
  hiddenProjRsInput.onchange = async () => {
    const file = hiddenProjRsInput.files?.[0];
    hiddenProjRsInput.value = '';
    if (file) await onFile(file);
  };
  hiddenProjRsInput.click();
}

function attachVerticalDrag(el, label, getVal, onDelta) {
  let dragging = false;
  let startY = 0;
  let startVal = 0;

  el.addEventListener('pointerdown', (e) => {
    engine.unlock();
    dragging = true;
    startY = e.clientY;
    startVal = getVal();
    store.beginGesture(label);
    el.setPointerCapture(e.pointerId);
  });

  el.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const dy = Math.round((startY - e.clientY) / 3);
    if (dy !== 0) {
      store.markGestureDirty();
      onDelta(startVal + dy);
    }
  });

  el.addEventListener('pointerup', () => {
    if (dragging) {
      dragging = false;
      store.commitGesture();
    }
  });

  el.addEventListener('pointercancel', () => {
    if (dragging) {
      dragging = false;
      store.commitGesture();
    }
  });
}

export function renderHistoryOverlay(panelEl) {
  const st = store.getState();
  let tab = st.detailOverlay?.tab || 'UNDO';

  function rebuild() {
    panelEl.innerHTML = '';
    const info = store.getHistoryInfo();

    const hdr = document.createElement('div');
    hdr.className = 'overlay-hdr';
    hdr.innerHTML = `<span>MEMORY // ${tab === 'UNDO' ? `${info.undoCount} STEPS` : `${st.sessionHistory.length} SESSIONS`}</span>`;

    const actions = document.createElement('div');
    actions.style.display = 'flex';
    actions.style.gap = '6px';

    const undoTabBtn = document.createElement('button');
    undoTabBtn.className = `ctx-chip ${tab === 'UNDO' ? 'active' : ''}`;
    undoTabBtn.textContent = 'UNDO';
    undoTabBtn.onclick = () => {
      tab = 'UNDO';
      rebuild();
    };

    const sessTabBtn = document.createElement('button');
    sessTabBtn.className = `ctx-chip ${tab === 'SESSIONS' ? 'active' : ''}`;
    sessTabBtn.textContent = `SESSIONS (${st.sessionHistory.length})`;
    sessTabBtn.onclick = () => {
      tab = 'SESSIONS';
      rebuild();
    };

    const closeBtn = document.createElement('button');
    closeBtn.className = 'ctx-chip';
    closeBtn.textContent = 'CLOSE [B]';
    closeBtn.onclick = () => {
      st.detailOverlay = null;
      store.emit('overlay', null);
    };

    actions.append(undoTabBtn, sessTabBtn, closeBtn);
    hdr.appendChild(actions);

    const body = document.createElement('div');
    body.className = 'overlay-body';

    if (tab === 'UNDO') {
      const topOps = document.createElement('div');
      topOps.style.display = 'flex';
      topOps.style.gap = '6px';

      const undoBtn = document.createElement('button');
      undoBtn.className = 'ctx-chip';
      undoBtn.textContent = `UNDO (${info.undoCount})`;
      undoBtn.disabled = info.undoCount === 0;
      undoBtn.onclick = () => {
        store.undo();
        rebuild();
      };

      const redoBtn = document.createElement('button');
      redoBtn.className = 'ctx-chip';
      redoBtn.textContent = `REDO (${info.redoCount})`;
      redoBtn.disabled = info.redoCount === 0;
      redoBtn.onclick = () => {
        store.redo();
        rebuild();
      };

      topOps.append(undoBtn, redoBtn);
      body.appendChild(topOps);

      const list = document.createElement('div');
      list.className = 'history-list';

      if (info.undoStack.length === 0 && info.redoStack.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'tel-cell';
        empty.innerHTML = `<span class="k">UNDO</span><span class="v">NO EDITS YET</span>`;
        list.appendChild(empty);
      } else {
        for (let i = info.redoStack.length - 1; i >= 0; i--) {
          const entry = info.redoStack[i];
          const row = document.createElement('button');
          row.className = 'history-item future';
          row.innerHTML = `<span>REDO: ${entry.label}</span><span>+${info.redoStack.length - i}</span>`;
          row.onclick = () => {
            const steps = info.redoStack.length - i;
            for (let s = 0; s < steps; s++) store.redo();
            rebuild();
          };
          list.appendChild(row);
        }

        const nowRow = document.createElement('div');
        nowRow.className = 'history-item current';
        nowRow.innerHTML = `<span>● CURRENT STATE</span><span>NOW</span>`;
        list.appendChild(nowRow);

        for (let i = info.undoStack.length - 1; i >= 0; i--) {
          const entry = info.undoStack[i];
          const row = document.createElement('button');
          row.className = 'history-item';
          row.innerHTML = `<span>${entry.label}</span><span>-${info.undoStack.length - i}</span>`;
          row.onclick = () => {
            store.jumpToHistory(i);
            rebuild();
          };
          list.appendChild(row);
        }
      }
      body.appendChild(list);
    } else {
      const topOps = document.createElement('div');
      topOps.style.display = 'flex';
      topOps.style.gap = '6px';

      const snapBtn = document.createElement('button');
      snapBtn.className = 'ctx-chip solid';
      snapBtn.textContent = '+ CHECKPOINT';
      snapBtn.onclick = () => {
        store.saveSessionCheckpoint(`SNAP ${st.sessionHistory.length + 1}`);
        saveAutosave(store);
        rebuild();
      };

      const saveRsBtn = document.createElement('button');
      saveRsBtn.className = 'ctx-chip';
      saveRsBtn.textContent = 'EXPORT .RS';
      saveRsBtn.onclick = async () => {
        await downloadProjectArchive(engine, store);
        rebuild();
      };

      topOps.append(snapBtn, saveRsBtn);
      body.appendChild(topOps);

      const list = document.createElement('div');
      list.className = 'history-list';

      if (st.sessionHistory.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'tel-cell';
        empty.innerHTML = `<span class="k">SESSIONS</span><span class="v">TAP + CHECKPOINT TO SAVE STATE</span>`;
        list.appendChild(empty);
      } else {
        for (const ses of st.sessionHistory) {
          const row = document.createElement('button');
          row.className = 'history-item';
          const dt = new Date(ses.savedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
          row.innerHTML = `<span>${ses.label} // ${ses.bpm} BPM</span><span>${dt} · LAB ${ses.labCount || 0}</span>`;
          row.onclick = () => {
            store.restoreSessionCheckpoint(ses.id);
            rebuild();
          };
          list.appendChild(row);
        }
      }
      body.appendChild(list);
    }

    panelEl.append(hdr, body);
  }

  rebuild();
}

export function renderProjectModal(modalEl) {
  const st = store.getState();
  const close = () => {
    st.detailOverlay = null;
    store.emit('overlay', null);
  };

  const hdr = document.createElement('div');
  hdr.className = 'overlay-hdr';
  hdr.innerHTML = `<span>PROJECT // ${st.projectName || 'UNTITLED'}</span>`;
  const closeBtn = document.createElement('button');
  closeBtn.className = 'ctx-chip';
  closeBtn.textContent = 'CLOSE [B]';
  closeBtn.onclick = close;
  hdr.appendChild(closeBtn);

  const body = document.createElement('div');
  body.className = 'overlay-body';

  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.className = 'hw-text-input';
  nameInput.maxLength = 20;
  nameInput.value = st.projectName || 'UNTITLED';
  nameInput.onchange = () => {
    st.projectName = nameInput.value.trim().toUpperCase() || 'UNTITLED';
  };

  const list = document.createElement('div');
  list.className = 'clip-menu-list';

  const makeBtn = (label, fn, cls = '') => {
    const b = document.createElement('button');
    b.className = `clip-menu-btn ${cls}`.trim();
    b.textContent = label;
    b.onclick = fn;
    return b;
  };

  list.append(
    makeBtn('SAVE .ROOMSERVICE (ZIP)', async () => {
      st.projectName = nameInput.value.trim().toUpperCase() || 'UNTITLED';
      await downloadProjectArchive(engine, store);
      close();
    }),
    makeBtn('OPEN .ROOMSERVICE', () => {
      openRsPicker(async (file) => {
        await importProjectArchive(file, engine, store);
        close();
      });
    }),
    makeBtn('+ SAVE CHECKPOINT', () => {
      st.projectName = nameInput.value.trim().toUpperCase() || 'UNTITLED';
      store.saveSessionCheckpoint(st.projectName);
      saveAutosave(store);
      close();
    }),
    makeBtn('SESSION HISTORY', () => {
      st.detailOverlay = { type: 'history', tab: 'SESSIONS' };
      store.emit('overlay', st.detailOverlay);
    }),
    makeBtn('OPEN LAB VAULT', () => {
      st.detailOverlay = { type: 'lab' };
      store.emit('overlay', st.detailOverlay);
    }),
    makeBtn(
      'NEW PROJECT (TRIAGE)',
      () => {
        st.detailOverlay = { type: 'triage', step: 'root' };
        store.emit('overlay', st.detailOverlay);
      },
      'danger'
    )
  );

  body.append(nameInput, list);
  modalEl.append(hdr, body);
}

const RAIL_ICONS = {
  ROLL: `<svg viewBox="0 0 20 20"><circle cx="5" cy="5" r="1.2" fill="currentColor" stroke="none"/><circle cx="10" cy="5" r="1.2" fill="currentColor" stroke="none"/><circle cx="15" cy="5" r="1.2" fill="currentColor" stroke="none"/><circle cx="5" cy="10" r="1.2" fill="currentColor" stroke="none"/><circle cx="10" cy="10" r="1.2" fill="currentColor" stroke="none"/><circle cx="15" cy="10" r="1.2" fill="currentColor" stroke="none"/><circle cx="5" cy="15" r="1.2" fill="currentColor" stroke="none"/><circle cx="10" cy="15" r="1.2" fill="currentColor" stroke="none"/><circle cx="15" cy="15" r="1.2" fill="currentColor" stroke="none"/></svg>`,
  ARR: `<svg viewBox="0 0 20 20"><line x1="3" y1="5" x2="13" y2="5"/><line x1="7" y1="10" x2="17" y2="10"/><line x1="4" y1="15" x2="11" y2="15"/></svg>`,
  MIX: `<svg viewBox="0 0 20 20"><line x1="5" y1="16" x2="5" y2="9"/><line x1="10" y1="16" x2="10" y2="4"/><line x1="15" y1="16" x2="15" y2="11"/></svg>`,
  DSP: `<svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="6"/><circle cx="10" cy="10" r="1.5" fill="currentColor" stroke="none"/></svg>`,
  LAB: `<svg viewBox="0 0 20 20"><path d="M5 4h10v12l-5-3-5 3z"/></svg>`,
  PROJECT: `<svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="3"/><path d="M10 3v2M10 15v2M3 10h2M15 10h2M5.1 5.1l1.4 1.4M13.5 13.5l1.4 1.4M14.9 5.1l-1.4 1.4M6.5 13.5l-1.4 1.4"/></svg>`
};

export function createLeftRail() {
  const rail = document.createElement('aside');
  rail.className = 'hw-left-rail';

  const topGroup = document.createElement('div');
  topGroup.className = 'rail-nav-group';

  const viewBtns = ['ROLL', 'ARR', 'MIX', 'DSP'].map((name) => {
    const btn = document.createElement('button');
    btn.className = 'rail-btn';
    btn.title = name;
    btn.innerHTML = RAIL_ICONS[name];
    btn.onclick = () => {
      engine.unlock();
      store.setView(name);
    };
    topGroup.appendChild(btn);
    return { name, btn };
  });

  const labBtn = document.createElement('button');
  labBtn.className = 'rail-btn';
  labBtn.title = 'LAB VAULT';
  labBtn.innerHTML = RAIL_ICONS.LAB;
  const labDot = document.createElement('span');
  labDot.className = 'rail-badge-dot';
  labDot.style.display = 'none';
  labBtn.appendChild(labDot);
  labBtn.onclick = () => {
    engine.unlock();
    const st = store.getState();
    st.detailOverlay = { type: 'lab' };
    store.emit('overlay', st.detailOverlay);
  };
  topGroup.appendChild(labBtn);

  const botGroup = document.createElement('div');
  botGroup.className = 'rail-nav-group';

  const projBtn = document.createElement('button');
  projBtn.className = 'rail-btn';
  projBtn.title = 'PROJECT / ARCHIVE';
  projBtn.innerHTML = RAIL_ICONS.PROJECT;
  projBtn.onclick = () => {
    engine.unlock();
    const st = store.getState();
    st.detailOverlay = { type: 'project' };
    store.emit('overlay', st.detailOverlay);
  };
  botGroup.appendChild(projBtn);

  rail.append(topGroup, botGroup);

  function sync() {
    const st = store.getState();
    for (const v of viewBtns) {
      v.btn.classList.toggle('active', st.view === v.name && !st.detailOverlay);
    }
    labBtn.classList.toggle('active', st.detailOverlay?.type === 'lab');
    labDot.style.display = st.lab.length > 0 ? 'block' : 'none';
    projBtn.classList.toggle('active', st.detailOverlay?.type === 'project' || st.detailOverlay?.type === 'history');
  }

  store.subscribe(sync);
  sync();

  return { el: rail, sync };
}

export function createRightRail(dotMatrix) {
  const rail = document.createElement('aside');
  rail.className = 'hw-right-rail';

  const topSlot = document.createElement('div');
  topSlot.className = 'right-rail-top';
  topSlot.appendChild(dotMatrix.el);

  const meterCanvas = document.createElement('canvas');
  meterCanvas.className = 'right-master-meter';

  const themeBtn = document.createElement('button');
  themeBtn.className = 'theme-dot';
  themeBtn.title = 'L2 + Select';
  themeBtn.onclick = () => store.toggleTheme();

  rail.append(topSlot, meterCanvas, themeBtn);

  const ctx = meterCanvas.getContext('2d');
  let peakL = 0;
  let peakR = 0;

  function tick() {
    if (rail.offsetParent === null) return;
    const rect = meterCanvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(18, Math.round(rect.width * dpr));
    const h = Math.max(40, Math.round(rect.height * dpr));
    if (meterCanvas.width !== w || meterCanvas.height !== h) {
      meterCanvas.width = w;
      meterCanvas.height = h;
    }

    const info = engine.getMasterMeterInfo();
    const normL = dbToMeterNorm(info.peakDbL);
    const normR = dbToMeterNorm(info.peakDbR);
    peakL = Math.max(normL, peakL * 0.9);
    peakR = Math.max(normR, peakR * 0.9);

    const style = getComputedStyle(document.documentElement);
    const ink = style.getPropertyValue('--ink').trim();
    const recessed = style.getPropertyValue('--surface-recessed').trim() || style.getPropertyValue('--bg').trim();
    const accent = style.getPropertyValue('--accent').trim();

    ctx.clearRect(0, 0, w, h);
    const barW = Math.max(3, Math.round(4 * dpr));
    const gap = Math.round(4 * dpr);
    const totalW = barW * 2 + gap;
    const x0 = Math.round((w - totalW) / 2);
    const padY = Math.round(4 * dpr);
    const barH = h - padY * 2;
    const radius = Math.round(2 * dpr);

    const drawBar = (x, norm) => {
      ctx.fillStyle = recessed;
      ctx.beginPath();
      ctx.roundRect(x, padY, barW, barH, radius);
      ctx.fill();

      const fillH = Math.max(Math.round(3 * dpr), Math.round(barH * Math.min(1, norm)));
      ctx.fillStyle = norm > 0.88 ? accent : ink;
      ctx.beginPath();
      ctx.roundRect(x, padY + barH - fillH, barW, fillH, radius);
      ctx.fill();
    };

    drawBar(x0, peakL);
    drawBar(x0 + barW + gap, peakR);
  }

  return { el: rail, topSlot, tick };
}

export function createHeader() {
  const hdr = document.createElement('header');
  hdr.className = 'hw-header';

  // Left
  const left = document.createElement('div');
  left.className = 'hdr-left';

  const brand = document.createElement('span');
  brand.className = 'brand';
  brand.textContent = 'ROOMSERVICE';
  brand.onclick = () => {
    store.getState().detailOverlay = { type: 'project' };
    store.emit('overlay', store.getState().detailOverlay);
  };

  const patBadge = document.createElement('div');
  patBadge.className = 'badge';
  patBadge.onclick = () => {
    const st = store.getState();
    const num = parseInt(st.activePatternId.slice(1), 10);
    const next = `P${String((num % 8) + 1).padStart(2, '0')}`;
    store.setActivePattern(next);
  };

  const modeBtn = document.createElement('button');
  modeBtn.className = 'hdr-btn';
  modeBtn.onclick = () => {
    const st = store.getState();
    st.playMode = st.playMode === 'PAT' ? 'SONG' : 'PAT';
    store.emit('transport', { playMode: st.playMode });
  };

  left.append(brand, patBadge, modeBtn);

  // Center Transport + Timing
  const center = document.createElement('div');
  center.className = 'hdr-center';

  const stopBtn = document.createElement('button');
  stopBtn.className = 'hdr-btn';
  stopBtn.textContent = '■';
  stopBtn.onclick = () => {
    if (store.getState().isPlaying) engine.togglePlay();
  };

  const playBtn = document.createElement('button');
  playBtn.className = 'hdr-btn play';
  playBtn.textContent = '▶';
  playBtn.onclick = () => engine.togglePlay();

  const recBtn = document.createElement('button');
  recBtn.className = 'hdr-btn rec';
  recBtn.textContent = '●';
  recBtn.onclick = () => engine.toggleRecord();

  const bpmBox = document.createElement('div');
  bpmBox.className = 'hdr-num';
  bpmBox.innerHTML = `<span class="lbl">BPM</span><span class="val">132</span>`;
  attachVerticalDrag(bpmBox, 'BPM', () => store.getState().bpm, (v) => engine.setBpm(v));

  center.append(stopBtn, playBtn, recBtn, bpmBox);

  // Right
  const right = document.createElement('div');
  right.className = 'hdr-right';

  const undoBtn = document.createElement('button');
  undoBtn.className = 'hdr-btn undo-btn';
  undoBtn.textContent = '↶';
  undoBtn.title = 'Undo (Hold for History)';
  undoBtn.onclick = () => store.undo();
  attachLongPress(undoBtn, () => {
    store.getState().detailOverlay = { type: 'history' };
    store.emit('overlay', store.getState().detailOverlay);
  });

  const redoBtn = document.createElement('button');
  redoBtn.className = 'hdr-btn redo-btn';
  redoBtn.textContent = '↷';
  redoBtn.title = 'Redo';
  redoBtn.onclick = () => store.redo();

  const mobileDotSlot = document.createElement('div');
  mobileDotSlot.className = 'hdr-dot-slot';

  right.append(undoBtn, redoBtn, mobileDotSlot);

  hdr.append(left, center, right);

  function sync() {
    const st = store.getState();
    const hist = store.getHistoryInfo();
    undoBtn.classList.toggle('is-empty', hist.undoCount === 0);
    redoBtn.classList.toggle('is-empty', hist.redoCount === 0);
    recBtn.classList.toggle('active', st.isRecording);
    playBtn.classList.toggle('active', st.isPlaying);
    playBtn.textContent = st.isPlaying ? '❚❚' : '▶';
    modeBtn.textContent = st.playMode;
    modeBtn.classList.toggle('active', st.playMode === 'SONG');
    bpmBox.querySelector('.val').textContent = String(st.bpm);
    patBadge.textContent = st.activePatternId;
  }

  store.subscribe(sync);
  sync();

  return { el: hdr, mobileDotSlot, sync };
}
