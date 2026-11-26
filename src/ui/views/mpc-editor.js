import { KIT_NAMES, getSamplePool } from '../../audio/drum-kits.js';
import { engine } from '../../audio/engine.js';
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

  // Crisp needle waveform (matching reference image 2/3)
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

  // High-contrast selection box overlay
  ctx.save();
  ctx.globalAlpha = 0.08;
  ctx.fillStyle = ink;
  ctx.fillRect(sx, 6, Math.max(2, ex - sx), h - 12);
  ctx.restore();

  ctx.strokeStyle = accent;
  ctx.lineWidth = 1.5;
  ctx.strokeRect(sx, 6, Math.max(2, ex - sx), h - 12);

  // Chop corner dots
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
  let inspectorTab = 'SLICE';

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

    // Header
    const hdr = document.createElement('div');
    hdr.className = 'overlay-hdr';
    const title = document.createElement('span');
    title.textContent = `${tr.code} ${tr.name} // MPC`;

    const hdrRight = document.createElement('div');
    hdrRight.style.display = 'flex';
    hdrRight.style.gap = '6px';
    hdrRight.style.alignItems = 'center';
    hdrRight.style.flexWrap = 'wrap';

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

    if (isRack) {
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

      const addPoolBtn = document.createElement('button');
      addPoolBtn.className = 'ctx-chip solid';
      addPoolBtn.textContent = `+ POOL (${pool.length})`;
      addPoolBtn.onclick = () => poolFileInput.click();
      hdrRight.appendChild(addPoolBtn);
    }

    const closeBtn = document.createElement('button');
    closeBtn.className = 'ctx-chip';
    closeBtn.textContent = 'CLOSE [B]';
    closeBtn.onclick = close;
    hdrRight.appendChild(closeBtn);

    hdr.append(title, hdrRight);

    // Body
    const body = document.createElement('div');
    body.className = 'overlay-body mpc-layout';

    // Left: 4x4 Wireframe MPC Pad Grid (classic MPC layout: 13-16 top, 01-04 bottom)
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
      const bankTag = !isRack ? (idx < 8 ? 'SYN' : '--') : pad.active ? pad.bank : '--';
      const label = !isRack ? (idx < 8 ? pad.name.replace(/^(909|808)\s+/, '') : '--') : pad.active ? pad.name : 'EMPTY';

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

    // Right: Chopper + Pad Controls
    const inspector = document.createElement('div');
    inspector.className = 'mpc-inspector';

    const curPad = info.pads[selectedPad];
    const chopCanvas = document.createElement('canvas');
    chopCanvas.className = 'mpc-chop-canvas';
    chopCanvas.width = 640;
    chopCanvas.height = 180;

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

    if (isRack) {
      const segBar = document.createElement('div');
      segBar.className = 'mpc-seg-bar';
      ['SLICE', 'ZONE', 'MAP'].forEach((tName) => {
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

      const actionRow = document.createElement('div');
      actionRow.style.display = 'flex';
      actionRow.style.flexWrap = 'wrap';
      actionRow.style.gap = '6px';

      const loadBtn = document.createElement('button');
      loadBtn.className = 'ctx-chip solid';
      loadBtn.textContent = 'LOAD WAV';
      loadBtn.onclick = () => padFileInput.click();

      const poolBtn = document.createElement('button');
      poolBtn.className = `ctx-chip ${poolPickerOpen ? 'active' : ''}`;
      poolBtn.textContent = 'POOL';
      poolBtn.onclick = () => {
        poolPickerOpen = !poolPickerOpen;
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

      const clrBtn = document.createElement('button');
      clrBtn.className = 'ctx-chip';
      clrBtn.textContent = 'CLR PAD';
      clrBtn.onclick = () => {
        node.clearPad(selectedPad);
        store.emit('drum-pads', { trackId });
        rebuild();
      };

      if (inspectorTab === 'SLICE') {
        actionRow.append(slice8Btn, slice16Btn, transBtn, rndPadBtn, poolBtn);
      } else if (inspectorTab === 'ZONE') {
        actionRow.append(loadBtn, revBtn, chkBtn, clrBtn);
      } else {
        const midiPill = document.createElement('span');
        midiPill.className = 'ctx-chip';
        midiPill.textContent = `MIDI ${48 + selectedPad} · ${curPad.active ? curPad.bank : 'EMPTY'}`;
        actionRow.append(midiPill, loadBtn, poolBtn, clrBtn);
      }
      inspector.appendChild(actionRow);

      if (poolPickerOpen || inspectorTab === 'MAP') {
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
    }

    // Bottom Rotary Row
    const knobRow = document.createElement('div');
    knobRow.className = 'mpc-knobs';
    const slotParams = tr.inserts[0].params;

    if (isRack) {
      const padTuneRot = createRotary({
        param: { id: 'padTune', label: 'P.TUNE', min: -24, max: 24, default: 0, step: 0.5, unit: 'st' },
        value: curPad.tune,
        size: 46,
        onChange: (v) => node.updatePad(selectedPad, { tune: v })
      });
      const padGainRot = createRotary({
        param: { id: 'padGain', label: 'P.GAIN', min: 0.1, max: 1.5, default: 1.0, step: 0.05, unit: 'x' },
        value: curPad.gain,
        size: 46,
        onChange: (v) => node.updatePad(selectedPad, { gain: v })
      });
      const startRot = createRotary({
        param: { id: 'startPct', label: 'START', min: 0, max: 95, default: 0, step: 1, unit: '%' },
        value: Math.round(curPad.startNorm * 100),
        size: 46,
        onChange: (v) => {
          node.updatePad(selectedPad, { startNorm: Math.min(curPad.endNorm - 0.02, v / 100) });
          drawPadWaveform(chopCanvas, curPad);
        }
      });
      const endRot = createRotary({
        param: { id: 'endPct', label: 'END', min: 5, max: 100, default: 100, step: 1, unit: '%' },
        value: Math.round(curPad.endNorm * 100),
        size: 46,
        onChange: (v) => {
          node.updatePad(selectedPad, { endNorm: Math.max(curPad.startNorm + 0.02, v / 100) });
          drawPadWaveform(chopCanvas, curPad);
        }
      });
      const toneRot = createRotary({
        param: { id: 'tone', label: 'TONE', min: 400, max: 14000, default: 9500, step: 50, unit: 'Hz', curve: 'exp' },
        value: slotParams.tone,
        size: 46,
        onChange: (v) => store.setDeviceParam(trackId, 0, 'tone', v)
      });
      const drvRot = createRotary({
        param: { id: 'drive', label: 'DRV', min: 0, max: 100, default: 18, step: 1, unit: '%' },
        value: slotParams.drive,
        size: 46,
        onChange: (v) => store.setDeviceParam(trackId, 0, 'drive', v)
      });
      knobRow.append(padTuneRot.el, padGainRot.el, startRot.el, endRot.el, toneRot.el, drvRot.el);
    } else {
      const synthParams = [
        { id: 'tune', label: 'TUNE', min: -12, max: 12, default: 0, step: 0.5, unit: 'st' },
        { id: 'decay', label: 'DEC', min: 0.2, max: 2.0, default: 1.0, step: 0.05, unit: 'x' },
        { id: 'tone', label: 'TONE', min: 400, max: 14000, default: 9500, step: 50, unit: 'Hz', curve: 'exp' },
        { id: 'drive', label: 'DRV', min: 0, max: 100, default: 18, step: 1, unit: '%' }
      ];
      for (const p of synthParams) {
        const rot = createRotary({
          param: p,
          value: slotParams[p.id],
          size: 48,
          onGestureStart: () => store.beginGesture(`DRUM-8 ${p.label}`),
          onGestureEnd: () => store.commitGesture(),
          onChange: (v) => store.setDeviceParam(trackId, 0, p.id, v)
        });
        knobRow.appendChild(rot.el);
      }
    }

    inspector.appendChild(knobRow);
    body.append(padGrid, inspector, padFileInput, poolFileInput);
    panelEl.append(hdr, body);

    liveRefs = { trackId, padEls, chopCanvas };
  }

  rebuild();
}
