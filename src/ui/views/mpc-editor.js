import { KIT_NAMES, getSamplePool } from '../../audio/drum-kits.js';
import { engine } from '../../audio/engine.js';
import { getDevice } from '../../device-registry.js';
import { store } from '../../state/store.js';
import { createRotary } from '../components/rotary.js';

let liveRefs = null;

export function tickMpcOverlay() {
  if (!liveRefs) return;
  const st = store.getState();
  if (st.detailOverlay?.type !== 'mpc') {
    liveRefs = null;
    return;
  }

  const node = engine.getDrumNode(liveRefs.trackId);
  if (!node?.getPadInfo) return;
  const info = node.getPadInfo();
  const now = performance.now();

  liveRefs.padEls.forEach((padEl, idx) => {
    const flash = info.padFlashAt[idx] || 0;
    padEl.classList.toggle('hit', now - flash < 140);
  });

  if (info.mode === 0 && liveRefs.chopCanvas) {
    drawSynthViz(liveRefs.chopCanvas, node.getMeter?.() || 0);
  }
}

function drawSynthViz(canvas, meterVal) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  const styles = getComputedStyle(document.documentElement);
  const bg = styles.getPropertyValue('--bg').trim();
  const border = styles.getPropertyValue('--border').trim();
  const ink = styles.getPropertyValue('--ink').trim();
  const accent = styles.getPropertyValue('--accent').trim();

  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);

  ctx.strokeStyle = border;
  ctx.beginPath();
  ctx.moveTo(0, h / 2);
  ctx.lineTo(w, h / 2);
  ctx.stroke();

  const wave = engine.getWaveform();
  ctx.strokeStyle = meterVal > 0.65 ? accent : ink;
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (let i = 0; i < wave.length; i++) {
    const x = (i / (wave.length - 1)) * w;
    const y = h / 2 - wave[i] * (h * 0.42);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

function drawPadWaveform(canvas, pad) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  const styles = getComputedStyle(document.documentElement);
  const bg = styles.getPropertyValue('--bg').trim();
  const border = styles.getPropertyValue('--border').trim();
  const ink = styles.getPropertyValue('--ink').trim();
  const inkDim = styles.getPropertyValue('--ink-dim').trim();
  const inkFaint = styles.getPropertyValue('--ink-faint').trim();
  const accent = styles.getPropertyValue('--accent').trim();

  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);

  ctx.strokeStyle = border;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, h / 2);
  ctx.lineTo(w, h / 2);
  ctx.stroke();

  if (!pad || !pad.active || !pad.peaks?.length) {
    ctx.strokeStyle = border;
    ctx.beginPath();
    ctx.roundRect(10, 10, w - 20, h - 20, 6);
    ctx.stroke();
    return;
  }

  const sx = pad.startNorm * w;
  const ex = pad.endNorm * w;

  const peaks = pad.peaks;
  for (let i = 0; i < peaks.length; i++) {
    const px = (i / (peaks.length - 1)) * w;
    const inside = px >= sx && px <= ex;
    const ph = Math.max(1.5, peaks[i] * (h * 0.42));
    ctx.strokeStyle = inside ? ink : inkFaint;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(px, h / 2 - ph);
    ctx.lineTo(px, h / 2 + ph);
    ctx.stroke();
  }

  ctx.save();
  ctx.globalAlpha = 0.08;
  ctx.fillStyle = ink;
  ctx.fillRect(sx, 6, Math.max(2, ex - sx), h - 12);
  ctx.restore();

  ctx.strokeStyle = accent;
  ctx.lineWidth = 1.5;
  ctx.strokeRect(sx, 6, Math.max(2, ex - sx), h - 12);

  ctx.fillStyle = accent;
  ctx.beginPath();
  ctx.arc(sx, 6, 4, 0, Math.PI * 2);
  ctx.arc(ex, h - 6, 4, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = inkDim;
  ctx.font = '600 10px Geist Mono, monospace';
  ctx.fillText(`S ${(pad.startNorm * 100).toFixed(0)}%`, 8, 16);
  ctx.fillText(`E ${(pad.endNorm * 100).toFixed(0)}%`, w - 48, 16);
}

export function renderMpcEditor(panelEl, trackId) {
  const st = store.getState();
  const tr = st.tracks[trackId];
  const node = engine.getDrumNode(trackId);
  if (!tr || !node) return;

  let selectedPad = 0;
  let poolPickerOpen = false;
  let inspectorTab = 'MOD';

  const padFileInput = document.createElement('input');
  padFileInput.type = 'file';
  padFileInput.accept = 'audio/*,.wav,.mp3,.ogg,.flac';
  padFileInput.style.display = 'none';
  padFileInput.onchange = async () => {
    const file = padFileInput.files?.[0];
    if (file) {
      await engine.loadSampleToPad(trackId, selectedPad, file);
      rebuild();
    }
    padFileInput.value = '';
  };

  const poolFileInput = document.createElement('input');
  poolFileInput.type = 'file';
  poolFileInput.accept = 'audio/*,.wav,.mp3,.ogg,.flac';
  poolFileInput.multiple = true;
  poolFileInput.style.display = 'none';
  poolFileInput.onchange = async () => {
    if (poolFileInput.files?.length) {
      await engine.importDrumPoolFiles(poolFileInput.files);
      rebuild();
    }
    poolFileInput.value = '';
  };

  function close() {
    liveRefs = null;
    st.detailOverlay = null;
    store.emit('overlay', null);
  }

  function rebuild() {
    panelEl.innerHTML = '';
    const info = node.getPadInfo();
    const isRack = info.mode === 1;
    const pool = getSamplePool();
    const tabs = isRack ? ['MOD', 'SLICE', 'MAP', 'GLOBAL'] : ['MOD', 'GLOBAL'];
    if (!tabs.includes(inspectorTab)) inspectorTab = 'MOD';

    // Header
    const hdr = document.createElement('div');
    hdr.className = 'overlay-hdr';
    const title = document.createElement('span');
    title.textContent = `${tr.code} ${tr.name} MPC`;

    const hdrRight = document.createElement('div');
    hdrRight.className = 'oh-actions';

    const synthBtn = document.createElement('button');
    synthBtn.className = `ctx-chip ${!isRack ? 'active' : ''}`;
    synthBtn.textContent = 'SYNTH';
    synthBtn.onclick = () => {
      store.pushHistory('DRUM SYNTH');
      store.setDeviceParam(trackId, 0, 'mode', 0);
      rebuild();
    };

    const rackBtn = document.createElement('button');
    rackBtn.className = `ctx-chip ${isRack ? 'active' : ''}`;
    rackBtn.textContent = 'RACK';
    rackBtn.onclick = () => {
      store.pushHistory('DRUM RACK');
      store.setDeviceParam(trackId, 0, 'mode', 1);
      rebuild();
    };

    hdrRight.append(synthBtn, rackBtn);

    const sep = document.createElement('div');
    sep.className = 'ctx-sep';
    hdrRight.appendChild(sep);

    KIT_NAMES.forEach((kName, kIdx) => {
      const kb = document.createElement('button');
      kb.className = `ctx-chip ${info.kit === kIdx ? 'active' : ''}`;
      kb.textContent = kName;
      kb.onclick = () => {
        store.pushHistory(`KIT ${kName}`);
        store.setDeviceParam(trackId, 0, 'kit', kIdx);
        if (kIdx >= 2) node.rerollKit();
        store.emit('drum-pads', { trackId });
        rebuild();
      };
      hdrRight.appendChild(kb);
    });

    if (info.kit >= 2) {
      const reroll = document.createElement('button');
      reroll.className = 'ctx-chip';
      reroll.textContent = 'REROLL';
      reroll.onclick = () => {
        node.rerollKit();
        store.emit('drum-pads', { trackId });
        rebuild();
      };
      hdrRight.appendChild(reroll);
    }

    if (isRack) {
      const addPoolBtn = document.createElement('button');
      addPoolBtn.className = 'ctx-chip solid';
      addPoolBtn.textContent = `+ POOL (${pool.length})`;
      addPoolBtn.onclick = () => poolFileInput.click();
      hdrRight.appendChild(addPoolBtn);
    }

    const closeBtn = document.createElement('button');
    closeBtn.className = 'ctx-chip';
    closeBtn.innerHTML = '<svg class="ico" viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8"/></svg>';
    closeBtn.title = 'Close [B]';
    closeBtn.classList.add('icon-only');
    closeBtn.onclick = close;
    hdrRight.appendChild(closeBtn);

    hdr.append(title, hdrRight);

    // Body
    const body = document.createElement('div');
    body.className = 'overlay-body mpc-layout';

    // Left: 4x4 Wireframe MPC Pad Grid (13-16 top, 01-04 bottom)
    const padGrid = document.createElement('div');
    padGrid.className = 'mpc-pad-grid';
    const padEls = new Array(16);

    const mpcOrder = [
      12, 13, 14, 15,
      8, 9, 10, 11,
      4, 5, 6, 7,
      0, 1, 2, 3
    ];

    for (const idx of mpcOrder) {
      const pad = info.pads[idx];
      const padBtn = document.createElement('button');
      const isActive = !isRack ? idx < 8 : pad.active;
      padBtn.className = `mpc-pad ${selectedPad === idx ? 'selected' : ''} ${!isActive ? 'empty' : ''}`;

      const numStr = String(idx + 1).padStart(2, '0');
      const synCircuit = info.synthVoiceCircuit?.[idx] === 1 ? 'VA808' : 'VA909';
      const bankTag = !isRack ? (idx < 8 ? synCircuit : '') : pad.active ? pad.bank : '';
      const label = isActive ? String(pad.name || '').replace(/^(909|808)\s+/, '') : '';

      padBtn.innerHTML = `
        <div class="mpc-pad-top"><span>${numStr}</span><span>${bankTag}</span></div>
        <div class="mpc-pad-name">${label}</div>
      `;

      padBtn.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        engine.unlock();
        selectedPad = idx;
        if (isActive) {
          engine.previewNote(trackId, 48 + idx, 0.92);
        }
        rebuild();
      });

      padEls[idx] = padBtn;
      padGrid.appendChild(padBtn);
    }

    // Right: Waveform/Viz + Tabs + Pad Modulation / Global Bus Controls
    const inspector = document.createElement('div');
    inspector.className = 'mpc-inspector';

    const curPad = info.pads[selectedPad];
    const chopCanvas = document.createElement('canvas');
    chopCanvas.className = 'mpc-chop-canvas';
    chopCanvas.width = 640;
    chopCanvas.height = 160;

    if (isRack) {
      drawPadWaveform(chopCanvas, curPad);

      let chopDrag = null;
      chopCanvas.addEventListener('pointerdown', (e) => {
        if (!curPad.active || !curPad.buffer) return;
        const rect = chopCanvas.getBoundingClientRect();
        const normX = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        const dStart = Math.abs(normX - curPad.startNorm);
        const dEnd = Math.abs(normX - curPad.endNorm);
        if (dStart < 0.06 && dStart <= dEnd) {
          chopDrag = { mode: 'start' };
        } else if (dEnd < 0.06) {
          chopDrag = { mode: 'end' };
        } else {
          chopDrag = { mode: 'window', offset: normX - curPad.startNorm, span: curPad.endNorm - curPad.startNorm };
        }
        chopCanvas.setPointerCapture(e.pointerId);
      });

      chopCanvas.addEventListener('pointermove', (e) => {
        if (!chopDrag) return;
        const rect = chopCanvas.getBoundingClientRect();
        const normX = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        if (chopDrag.mode === 'start') {
          curPad.startNorm = Math.min(curPad.endNorm - 0.02, normX);
        } else if (chopDrag.mode === 'end') {
          curPad.endNorm = Math.max(curPad.startNorm + 0.02, normX);
        } else {
          const nextS = Math.max(0, Math.min(1 - chopDrag.span, normX - chopDrag.offset));
          curPad.startNorm = nextS;
          curPad.endNorm = nextS + chopDrag.span;
        }
        drawPadWaveform(chopCanvas, curPad);
      });

      chopCanvas.addEventListener('pointerup', () => {
        if (chopDrag) {
          chopDrag = null;
          engine.previewNote(trackId, 48 + selectedPad, 0.9);
          rebuild();
        }
      });
    } else {
      drawSynthViz(chopCanvas, node.getMeter?.() || 0);
    }

    inspector.appendChild(chopCanvas);

    // Segmented Tab Bar
    const segBar = document.createElement('div');
    segBar.className = 'mpc-seg-bar';
    segBar.style.gridTemplateColumns = `repeat(${tabs.length}, 1fr)`;
    tabs.forEach((tName) => {
      const sb = document.createElement('button');
      sb.className = `mpc-seg-btn ${inspectorTab === tName ? 'active' : ''}`;
      sb.textContent = tName;
      sb.onclick = () => {
        inspectorTab = tName;
        rebuild();
      };
      segBar.appendChild(sb);
    });
    inspector.appendChild(segBar);

    const slotParams = tr.inserts[0].params;

    if (inspectorTab === 'MOD') {
      const modStrip = document.createElement('div');
      modStrip.style.display = 'flex';
      modStrip.style.flexWrap = 'wrap';
      modStrip.style.gap = '6px';
      modStrip.style.alignItems = 'center';

      const padBadge = document.createElement('span');
      padBadge.className = 'ctx-chip solid';
      padBadge.textContent = `P${String(selectedPad + 1).padStart(2, '0')} ${curPad.name}`;
      modStrip.appendChild(padBadge);

      const fTypes = [
        { id: 'lowpass', lbl: 'LP' },
        { id: 'highpass', lbl: 'HP' },
        { id: 'bandpass', lbl: 'BP' }
      ];
      for (const ft of fTypes) {
        const fb = document.createElement('button');
        fb.className = `ctx-chip ${(curPad.filterType || 'lowpass') === ft.id ? 'active' : ''}`;
        fb.textContent = ft.lbl;
        fb.onclick = () => {
          node.updatePad(selectedPad, { filterType: ft.id });
          engine.previewNote(trackId, 48 + selectedPad, 0.9);
          rebuild();
        };
        modStrip.appendChild(fb);
      }

      if (isRack) {
        const revBtn = document.createElement('button');
        revBtn.className = `ctx-chip ${curPad.reverse ? 'active' : ''}`;
        revBtn.textContent = 'REV';
        revBtn.onclick = () => {
          node.updatePad(selectedPad, { reverse: !curPad.reverse });
          engine.previewNote(trackId, 48 + selectedPad, 0.9);
          rebuild();
        };

        const chkBtn = document.createElement('button');
        chkBtn.className = `ctx-chip ${curPad.chokeGroup > 0 ? 'active' : ''}`;
        chkBtn.textContent = `CHK ${curPad.chokeGroup || 'OFF'}`;
        chkBtn.onclick = () => {
          node.updatePad(selectedPad, { chokeGroup: (curPad.chokeGroup + 1) % 4 });
          rebuild();
        };
        modStrip.append(revBtn, chkBtn);
      }

      const rstBtn = document.createElement('button');
      rstBtn.className = 'ctx-chip';
      rstBtn.textContent = 'RST';
      rstBtn.onclick = () => {
        node.resetPadMod(selectedPad);
        engine.previewNote(trackId, 48 + selectedPad, 0.9);
        rebuild();
      };
      modStrip.appendChild(rstBtn);
      inspector.appendChild(modStrip);

      const modGrid = document.createElement('div');
      modGrid.className = 'mpc-knobs mpc-knobs-grid';

      const padModParams = [
        { id: 'tune', label: 'P.TUNE', min: -24, max: 24, default: 0, step: 0.5, unit: 'st' },
        { id: 'pitchEnv', label: 'P.ENV', min: -24, max: 24, default: 0, step: 1, unit: 'st' },
        { id: 'attack', label: 'ATK', min: 0, max: 120, default: 0, step: 1, unit: 'ms' },
        { id: 'decay', label: 'DEC', min: 0.05, max: 2.0, default: 1.0, step: 0.05, unit: 'x' },
        { id: 'cutoff', label: 'CUT', min: 120, max: 18000, default: 18000, step: 50, unit: 'Hz', curve: 'exp' },
        { id: 'res', label: 'RES', min: 0.5, max: 14, default: 0.7, step: 0.2, unit: 'Q' },
        { id: 'drive', label: 'DRV', min: 0, max: 100, default: 0, step: 1, unit: '%' },
        { id: 'pan', label: 'PAN', min: -1, max: 1, default: 0, step: 0.05, unit: '' },
        { id: 'gain', label: 'LVL', min: 0.1, max: 1.5, default: 1.0, step: 0.05, unit: 'x' }
      ];

      for (const p of padModParams) {
        const rot = createRotary({
          param: p,
          value: curPad[p.id] ?? p.default,
          size: 40,
          onChange: (v) => node.updatePad(selectedPad, { [p.id]: v })
        });
        modGrid.appendChild(rot.el);
      }
      inspector.appendChild(modGrid);
    } else if (inspectorTab === 'SLICE' && isRack) {
      const actionRow = document.createElement('div');
      actionRow.style.display = 'flex';
      actionRow.style.flexWrap = 'wrap';
      actionRow.style.gap = '6px';

      const ensureSliceablePad = () => {
        if (curPad.active && curPad.buffer) return true;
        padFileInput.click();
        return false;
      };

      const slice8Btn = document.createElement('button');
      slice8Btn.className = 'ctx-chip';
      slice8Btn.textContent = 'SLICE 8';
      slice8Btn.onclick = () => {
        if (!ensureSliceablePad()) return;
        node.chopPadAcrossPads(selectedPad, 8, 'EQUAL');
        store.emit('drum-pads', { trackId });
        rebuild();
      };

      const slice16Btn = document.createElement('button');
      slice16Btn.className = 'ctx-chip';
      slice16Btn.textContent = 'SLICE 16';
      slice16Btn.onclick = () => {
        if (!ensureSliceablePad()) return;
        node.chopPadAcrossPads(selectedPad, 16, 'EQUAL');
        store.emit('drum-pads', { trackId });
        rebuild();
      };

      const transBtn = document.createElement('button');
      transBtn.className = 'ctx-chip';
      transBtn.textContent = 'TRANSIENT';
      transBtn.onclick = () => {
        if (!ensureSliceablePad()) return;
        node.chopPadAcrossPads(selectedPad, 8, 'TRANSIENTS');
        store.emit('drum-pads', { trackId });
        rebuild();
      };

      const rndPadBtn = document.createElement('button');
      rndPadBtn.className = 'ctx-chip';
      rndPadBtn.textContent = 'RND PAD';
      rndPadBtn.onclick = () => {
        if (pool.length === 0) return;
        const userOnly = pool.filter((s) => s.bank === 'USER');
        const src = userOnly.length > 0 && Math.random() < 0.7 ? userOnly : pool;
        const pick = src[Math.floor(Math.random() * src.length)];
        node.setPadSample(selectedPad, pick);
        store.emit('drum-pads', { trackId });
        engine.previewNote(trackId, 48 + selectedPad, 0.9);
        rebuild();
      };

      const poolBtn = document.createElement('button');
      poolBtn.className = `ctx-chip ${poolPickerOpen ? 'active' : ''}`;
      poolBtn.textContent = 'POOL';
      poolBtn.onclick = () => {
        poolPickerOpen = !poolPickerOpen;
        rebuild();
      };

      actionRow.append(slice8Btn, slice16Btn, transBtn, rndPadBtn, poolBtn);
      inspector.appendChild(actionRow);

      if (poolPickerOpen) {
        const poolBox = document.createElement('div');
        poolBox.className = 'mpc-pool-strip';
        for (const smp of pool) {
          const b = document.createElement('button');
          b.className = `ctx-chip ${curPad.sampleId === smp.id ? 'active' : ''}`;
          b.textContent = `${smp.bank} ${smp.name}`;
          b.onclick = () => {
            node.setPadSample(selectedPad, smp);
            store.emit('drum-pads', { trackId });
            engine.previewNote(trackId, 48 + selectedPad, 0.9);
            rebuild();
          };
          poolBox.appendChild(b);
        }
        inspector.appendChild(poolBox);
      }

      const knobRow = document.createElement('div');
      knobRow.className = 'mpc-knobs';
      const startRot = createRotary({
        param: { id: 'startPct', label: 'START', min: 0, max: 95, default: 0, step: 1, unit: '%' },
        value: Math.round(curPad.startNorm * 100),
        size: 44,
        onChange: (v) => {
          node.updatePad(selectedPad, { startNorm: Math.min(curPad.endNorm - 0.02, v / 100) });
          drawPadWaveform(chopCanvas, curPad);
        }
      });
      const endRot = createRotary({
        param: { id: 'endPct', label: 'END', min: 5, max: 100, default: 100, step: 1, unit: '%' },
        value: Math.round(curPad.endNorm * 100),
        size: 44,
        onChange: (v) => {
          node.updatePad(selectedPad, { endNorm: Math.max(curPad.startNorm + 0.02, v / 100) });
          drawPadWaveform(chopCanvas, curPad);
        }
      });
      const padTuneRot = createRotary({
        param: { id: 'padTune', label: 'P.TUNE', min: -24, max: 24, default: 0, step: 0.5, unit: 'st' },
        value: curPad.tune,
        size: 44,
        onChange: (v) => node.updatePad(selectedPad, { tune: v })
      });
      const padGainRot = createRotary({
        param: { id: 'padGain', label: 'P.GAIN', min: 0.1, max: 1.5, default: 1.0, step: 0.05, unit: 'x' },
        value: curPad.gain,
        size: 44,
        onChange: (v) => node.updatePad(selectedPad, { gain: v })
      });
      knobRow.append(startRot.el, endRot.el, padTuneRot.el, padGainRot.el);
      inspector.appendChild(knobRow);
    } else if (inspectorTab === 'MAP' && isRack) {
      const actionRow = document.createElement('div');
      actionRow.style.display = 'flex';
      actionRow.style.flexWrap = 'wrap';
      actionRow.style.gap = '6px';

      const midiPill = document.createElement('span');
      midiPill.className = 'ctx-chip';
      midiPill.textContent = `MIDI ${48 + selectedPad} · ${curPad.active ? curPad.bank : 'EMPTY'}`;

      const loadBtn = document.createElement('button');
      loadBtn.className = 'ctx-chip solid';
      loadBtn.textContent = 'LOAD WAV';
      loadBtn.onclick = () => padFileInput.click();

      const clrBtn = document.createElement('button');
      clrBtn.className = 'ctx-chip';
      clrBtn.textContent = 'CLR PAD';
      clrBtn.onclick = () => {
        node.clearPad(selectedPad);
        store.emit('drum-pads', { trackId });
        rebuild();
      };

      actionRow.append(midiPill, loadBtn, clrBtn);
      inspector.appendChild(actionRow);

      const poolBox = document.createElement('div');
      poolBox.className = 'mpc-pool-strip';
      for (const smp of pool) {
        const b = document.createElement('button');
        b.className = `ctx-chip ${curPad.sampleId === smp.id ? 'active' : ''}`;
        b.textContent = `${smp.bank} ${smp.name}`;
        b.onclick = () => {
          node.setPadSample(selectedPad, smp);
          store.emit('drum-pads', { trackId });
          engine.previewNote(trackId, 48 + selectedPad, 0.9);
          rebuild();
        };
        poolBox.appendChild(b);
      }
      inspector.appendChild(poolBox);
    } else {
      // GLOBAL Drum Bus Sculpting (Both Synth & Rack)
      const drumDef = getDevice('drum8');
      const allGlobal = [
        ...(drumDef?.meta.params || []).filter((p) => p.control !== 'segmented'),
        ...(drumDef?.meta.extendedParams || [])
      ];

      const globalGrid = document.createElement('div');
      globalGrid.className = 'mpc-knobs mpc-knobs-grid';
      for (const p of allGlobal) {
        const rot = createRotary({
          param: p,
          value: slotParams[p.id] ?? p.default,
          size: 40,
          onGestureStart: () => store.beginGesture(`DRUM-8 ${p.label}`),
          onGestureEnd: () => store.commitGesture(),
          onChange: (v) => store.setDeviceParam(trackId, 0, p.id, v)
        });
        globalGrid.appendChild(rot.el);
      }
      inspector.appendChild(globalGrid);
    }

    body.append(padGrid, inspector, padFileInput, poolFileInput);
    panelEl.append(hdr, body);

    liveRefs = { trackId, padEls, chopCanvas };
  }

  rebuild();
}
