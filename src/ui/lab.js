import { engine } from '../audio/engine.js';
import { store } from '../state/store.js';

function drawLabPreview(canvas, item) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  const styles = getComputedStyle(document.documentElement);
  const bg = styles.getPropertyValue('--bg').trim();
  const ink = styles.getPropertyValue('--ink').trim();
  const accent = styles.getPropertyValue('--accent').trim();
  const border = styles.getPropertyValue('--border').trim();

  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);

  ctx.strokeStyle = border;
  ctx.strokeRect(0.5, 0.5, w - 1, h - 1);

  if (item.kind === 'pattern' && item.notes?.length) {
    const len = Math.max(16, item.lengthSteps || 16);
    const midis = item.notes.map((n) => n.midi);
    const minM = Math.min(...midis) - 2;
    const maxM = Math.max(...midis) + 2;
    const span = Math.max(6, maxM - minM);

    for (const n of item.notes) {
      const x = (n.step / len) * (w - 8) + 4;
      const nw = Math.max(4, ((n.len || 1) / len) * (w - 8) - 2);
      const y = h - 6 - ((n.midi - minM) / span) * (h - 12);
      ctx.fillStyle = n.slide ? accent : ink;
      ctx.fillRect(x, y, nw, 4);
    }
  } else if (item.kind === 'audio') {
    const ac = store.getState().audioClips[item.audioRef];
    if (ac?.peaks?.length) {
      ctx.fillStyle = ink;
      ac.peaks.forEach((pk, i) => {
        const x = (i / ac.peaks.length) * w;
        const ph = pk * (h * 0.4);
        ctx.fillRect(x, h / 2 - ph, 2, ph * 2);
      });
    }
  } else if (item.kind === 'auto' && item.autoClip?.points?.length) {
    ctx.strokeStyle = accent;
    ctx.lineWidth = 2;
    ctx.beginPath();
    item.autoClip.points.forEach((p, idx) => {
      const x = p.x * w;
      const y = (1 - p.y) * h;
      if (idx === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }
}

export function renderLabOverlay(panelEl) {
  const st = store.getState();

  function close() {
    engine.stopLabPreview();
    st.detailOverlay = null;
    store.emit('overlay', null);
  }

  function rebuild() {
    if (st.detailOverlay?.type !== 'lab') return;
    panelEl.innerHTML = '';

    const hdr = document.createElement('div');
    hdr.className = 'overlay-hdr';
    hdr.innerHTML = `<span>LAB <i class="oh-sub">${st.lab.length} ARCHIVED</i></span>`;

    const hdrRight = document.createElement('div');
    hdrRight.style.display = 'flex';
    hdrRight.style.gap = '6px';

    const stashBtn = document.createElement('button');
    stashBtn.className = 'ctx-chip';
    stashBtn.textContent = '+ STASH PAT';
    stashBtn.onclick = () => {
      store.archiveActivePatternToLab();
      rebuild();
    };

    const closeBtn = document.createElement('button');
    closeBtn.className = 'ctx-chip';
    closeBtn.innerHTML = '<svg class="ico" viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8"/></svg>';
    closeBtn.title = 'Close [B]';
    closeBtn.classList.add('icon-only');
    closeBtn.onclick = close;

    hdrRight.append(stashBtn, closeBtn);
    hdr.appendChild(hdrRight);

    const body = document.createElement('div');
    body.className = 'overlay-body';

    if (st.lab.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'tel-cell';
      empty.innerHTML = `<span class="k">VAULT</span><span class="v">EMPTY — LONG PRESS CLIP → +LAB</span>`;
      body.appendChild(empty);
      panelEl.append(hdr, body);
      return;
    }

    const grid = document.createElement('div');
    grid.className = 'lab-grid';
    const previewId = engine.getLabPreviewId();

    for (const item of st.lab) {
      const card = document.createElement('div');
      const isPlaying = previewId === item.id;
      card.className = `lab-card ${isPlaying ? 'playing' : ''}`;

      const top = document.createElement('div');
      top.className = 'lab-card-top';
      top.innerHTML = `
        <span>${item.id} · ${item.refId}</span>
        <span class="ctx-chip">${item.instrumentName || item.kind.toUpperCase()}</span>
      `;

      const canvas = document.createElement('canvas');
      canvas.width = 360;
      canvas.height = 68;
      canvas.className = 'lab-preview-canvas';
      drawLabPreview(canvas, item);

      const metaRow = document.createElement('div');
      metaRow.className = 'lab-meta';
      const countStr = item.kind === 'pattern' ? `${item.notes?.length || 0}N` : `${item.lengthSteps}S`;
      metaRow.innerHTML = `<span>${item.bpm} BPM</span><span>${countStr}</span>`;

      const actions = document.createElement('div');
      actions.className = 'lab-actions';

      if (item.kind !== 'auto') {
        const soloBtn = document.createElement('button');
        soloBtn.className = `ctx-chip ${isPlaying ? 'active' : ''}`;
        soloBtn.textContent = isPlaying ? '■ STOP' : '▶ SOLO';
        soloBtn.onclick = async () => {
          if (engine.getLabPreviewId() === item.id) {
            engine.stopLabPreview();
          } else {
            await engine.startLabPreview(item);
          }
          rebuild();
        };
        actions.appendChild(soloBtn);
      }

      const curBtn = document.createElement('button');
      curBtn.className = 'ctx-chip';
      curBtn.textContent = item.kind === 'pattern' ? '→ CUR CH' : '→ ARR';
      curBtn.onclick = () => {
        engine.stopLabPreview();
        store.assignLabToTrack(item.id, 'current');
      };
      actions.appendChild(curBtn);

      if (item.kind === 'pattern') {
        const newBtn = document.createElement('button');
        newBtn.className = 'ctx-chip solid';
        newBtn.textContent = '+ NEW CH';
        newBtn.onclick = () => {
          engine.stopLabPreview();
          store.assignLabToTrack(item.id, 'new');
        };
        actions.appendChild(newBtn);
      }

      const delBtn = document.createElement('button');
      delBtn.className = 'ctx-chip';
      delBtn.textContent = 'DEL';
      delBtn.onclick = () => {
        if (engine.getLabPreviewId() === item.id) engine.stopLabPreview();
        store.removeLabItem(item.id);
        rebuild();
      };
      actions.appendChild(delBtn);

      card.append(top, canvas, metaRow, actions);
      grid.appendChild(card);
    }

    body.appendChild(grid);
    panelEl.append(hdr, body);
  }

  rebuild();
}
