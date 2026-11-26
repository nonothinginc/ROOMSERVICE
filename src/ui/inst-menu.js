import { engine } from '../audio/engine.js';
import { getDevicesByCategory } from '../device-registry.js';
import { store } from '../state/store.js';

let hiddenSamplerInput = null;

function pickSamplerFile(onFile) {
  if (!hiddenSamplerInput) {
    hiddenSamplerInput = document.createElement('input');
    hiddenSamplerInput.type = 'file';
    hiddenSamplerInput.accept = 'audio/*,.wav,.mp3,.ogg,.flac,.m4a';
    hiddenSamplerInput.style.display = 'none';
    document.body.appendChild(hiddenSamplerInput);
  }
  hiddenSamplerInput.onchange = async () => {
    const file = hiddenSamplerInput.files?.[0];
    hiddenSamplerInput.value = '';
    if (file) await onFile(file);
  };
  hiddenSamplerInput.click();
}

export function renderInstMenuModal(modalEl) {
  const st = store.getState();
  let mode = 'SWAP'; // 'SWAP' | 'ADD'

  const close = () => {
    st.detailOverlay = null;
    store.emit('overlay', null);
  };

  function rebuild() {
    modalEl.innerHTML = '';

    const hdr = document.createElement('div');
    hdr.className = 'overlay-hdr';
    hdr.innerHTML = `<span>INSTRUMENTS</span>`;

    const hdrRight = document.createElement('div');
    hdrRight.style.display = 'flex';
    hdrRight.style.gap = '6px';

    const swapBtn = document.createElement('button');
    swapBtn.className = `ctx-chip ${mode === 'SWAP' ? 'active' : ''}`;
    swapBtn.textContent = 'SWAP';
    swapBtn.onclick = () => {
      mode = 'SWAP';
      rebuild();
    };

    const addBtn = document.createElement('button');
    addBtn.className = `ctx-chip ${mode === 'ADD' ? 'active' : ''}`;
    addBtn.textContent = '+ NEW TRACK';
    addBtn.onclick = () => {
      mode = 'ADD';
      rebuild();
    };

    const renameBtn = document.createElement('button');
    renameBtn.className = 'ctx-chip';
    renameBtn.textContent = '✎ RENAME';
    renameBtn.onclick = () => {
      st.detailOverlay = { type: 'mix-rename', trackId: st.selectedTrackId };
      store.emit('overlay', st.detailOverlay);
    };

    const closeBtn = document.createElement('button');
    closeBtn.className = 'ctx-chip';
    closeBtn.textContent = 'CLOSE [B]';
    closeBtn.onclick = close;

    hdrRight.append(swapBtn, addBtn, renameBtn, closeBtn);
    hdr.appendChild(hdrRight);

    const body = document.createElement('div');
    body.className = 'overlay-body';

    // Section 1: Tracks 01..08
    const trkHdr = document.createElement('div');
    trkHdr.className = 'menu-section-hdr';
    trkHdr.textContent = 'TRACKS';

    const trkGrid = document.createElement('div');
    trkGrid.className = 'inst-grid';
    st.tracks.forEach((tr) => {
      const btn = document.createElement('button');
      btn.className = `ctx-chip ${st.selectedTrackId === tr.id ? 'active' : ''}`;
      btn.style.height = '34px';
      btn.style.justifyContent = 'space-between';
      btn.innerHTML = `<span>${tr.code} ${tr.name}</span>`;
      btn.onclick = () => {
        store.setSelectedTrack(tr.id);
        close();
      };
      trkGrid.appendChild(btn);
    });

    // Section 2: Available Instruments + Sampler + MPC
    const instHdr = document.createElement('div');
    instHdr.className = 'menu-section-hdr';
    instHdr.textContent = mode === 'SWAP' ? 'SWAP CURRENT TRACK' : '+ ADD TO NEXT TRACK';

    const instGrid = document.createElement('div');
    instGrid.className = 'inst-grid';

    const instruments = getDevicesByCategory('instrument');
    const curInstId = st.tracks[st.selectedTrackId]?.inserts[0]?.deviceId;

    for (const dev of instruments) {
      const btn = document.createElement('button');
      const isCurrent = mode === 'SWAP' && curInstId === dev.meta.id;
      btn.className = `ctx-chip ${isCurrent ? 'active' : ''}`;
      btn.style.height = '38px';
      btn.style.justifyContent = 'space-between';
      btn.innerHTML = `<span>${dev.meta.name}</span><span style="opacity:0.5">${dev.meta.visualizer?.slice(0, 4).toUpperCase() || 'DSP'}</span>`;
      btn.onclick = () => {
        if (mode === 'SWAP') {
          store.addInsertDevice(st.selectedTrackId, dev.meta.id);
        } else {
          store.addInstrumentTrack(dev.meta.id);
        }
        close();
      };
      instGrid.appendChild(btn);
    }

    // + SAMPLER
    const samplerBtn = document.createElement('button');
    samplerBtn.className = 'ctx-chip solid';
    samplerBtn.style.height = '38px';
    samplerBtn.style.justifyContent = 'space-between';
    samplerBtn.innerHTML = `<span>+ SAMPLER</span><span>WAV</span>`;
    samplerBtn.onclick = () => {
      pickSamplerFile(async (file) => {
        const targetId = mode === 'ADD' ? store.addInstrumentTrack('grain1') : st.selectedTrackId;
        await engine.loadSampleToSampler(targetId, file);
        close();
      });
    };

    // + MPC RACK
    const mpcBtn = document.createElement('button');
    mpcBtn.className = 'ctx-chip';
    mpcBtn.style.height = '38px';
    mpcBtn.style.justifyContent = 'space-between';
    mpcBtn.innerHTML = `<span>+ MPC RACK</span><span>16 PAD</span>`;
    mpcBtn.onclick = () => {
      const targetId = mode === 'ADD' ? store.addInstrumentTrack('drum8') : st.selectedTrackId;
      if (st.tracks[targetId]?.inserts[0]?.deviceId !== 'drum8') {
        store.addInsertDevice(targetId, 'drum8');
      }
      store.setDeviceParam(targetId, 0, 'mode', 1);
      st.detailOverlay = { type: 'mpc', trackId: targetId };
      store.emit('overlay', st.detailOverlay);
    };

    instGrid.append(samplerBtn, mpcBtn);
    body.append(trkHdr, trkGrid, instHdr, instGrid);
    modalEl.append(hdr, body);
  }

  rebuild();
}
