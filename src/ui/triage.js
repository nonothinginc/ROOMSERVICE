import { KIT_NAMES } from '../audio/drum-kits.js';
import { engine } from '../audio/engine.js';
import { getDevicesByCategory } from '../device-registry.js';
import { ROOT_NOTES, generateRiff } from '../state/scales.js';
import { nextId, store } from '../state/store.js';
import { importProjectArchive, restoreAutosave } from '../storage/project-archive.js';

let hiddenFilePicker = null;
let hiddenRsPicker = null;

function ensureHiddenInput(accept, onFile) {
  if (!hiddenFilePicker) {
    hiddenFilePicker = document.createElement('input');
    hiddenFilePicker.type = 'file';
    hiddenFilePicker.style.display = 'none';
    document.body.appendChild(hiddenFilePicker);
  }
  hiddenFilePicker.accept = accept;
  hiddenFilePicker.onchange = async () => {
    const file = hiddenFilePicker.files?.[0];
    hiddenFilePicker.value = '';
    if (file) await onFile(file);
  };
  hiddenFilePicker.click();
}

function ensureRsInput(onFile) {
  if (!hiddenRsPicker) {
    hiddenRsPicker = document.createElement('input');
    hiddenRsPicker.type = 'file';
    hiddenRsPicker.accept = '.roomservice,.zip';
    hiddenRsPicker.style.display = 'none';
    document.body.appendChild(hiddenRsPicker);
  }
  hiddenRsPicker.onchange = async () => {
    const file = hiddenRsPicker.files?.[0];
    hiddenRsPicker.value = '';
    if (file) await onFile(file);
  };
  hiddenRsPicker.click();
}

const TILE_ICONS = {
  beat: `<svg width="28" height="28" viewBox="0 0 28 28" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="9" height="9"/><rect x="16" y="3" width="9" height="9"/><rect x="3" y="16" width="9" height="9"/><rect x="16" y="16" width="9" height="9"/></svg>`,
  melody: `<svg width="28" height="28" viewBox="0 0 28 28" fill="none" stroke="currentColor" stroke-width="1.5"><polyline points="2,18 8,18 8,9 15,9 15,15 21,15 21,7 26,7"/></svg>`,
  sample: `<svg width="28" height="28" viewBox="0 0 28 28" fill="none" stroke="currentColor" stroke-width="1.5"><line x1="4" y1="14" x2="4" y2="14"/><line x1="8" y1="9" x2="8" y2="19"/><line x1="12" y1="5" x2="12" y2="23"/><line x1="16" y1="8" x2="16" y2="20"/><line x1="20" y1="11" x2="20" y2="17"/><line x1="24" y1="6" x2="24" y2="22"/></svg>`,
  chords: `<svg width="28" height="28" viewBox="0 0 28 28" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="4" y="6" width="20" height="3"/><rect x="4" y="13" width="20" height="3"/><rect x="4" y="20" width="20" height="3"/></svg>`,
  seed: `<svg width="28" height="28" viewBox="0 0 28 28" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="14" cy="14" r="9"/><circle cx="14" cy="14" r="2" fill="currentColor"/><circle cx="14" cy="7" r="1.2" fill="currentColor"/><circle cx="21" cy="14" r="1.2" fill="currentColor"/><circle cx="14" cy="21" r="1.2" fill="currentColor"/><circle cx="7" cy="14" r="1.2" fill="currentColor"/></svg>`,
  blank: `<svg width="28" height="28" viewBox="0 0 28 28" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="4" y="4" width="20" height="20" stroke-dasharray="3 3"/></svg>`
};

export function renderTriageModal(modalEl) {
  const st = store.getState();
  const ov = st.detailOverlay || { type: 'triage', step: 'root' };
  let micRecording = false;
  let beatGroove = true;

  function closeTriage() {
    st.detailOverlay = null;
    store.emit('overlay', null);
  }

  function goStep(step, extra = {}) {
    st.detailOverlay = { ...ov, type: 'triage', step, ...extra };
    store.emit('overlay', st.detailOverlay);
  }

  const hdr = document.createElement('div');
  hdr.className = 'overlay-hdr';

  const hdrRight = document.createElement('div');
  hdrRight.style.display = 'flex';
  hdrRight.style.gap = '6px';

  if (ov.step && ov.step !== 'root') {
    const back = document.createElement('button');
    back.className = 'ctx-chip';
    back.textContent = '← BACK';
    back.onclick = () => goStep('root');
    hdrRight.appendChild(back);
  } else {
    const openRs = document.createElement('button');
    openRs.className = 'ctx-chip';
    openRs.textContent = 'OPEN .RS';
    openRs.onclick = () => {
      ensureRsInput(async (file) => {
        try {
          await importProjectArchive(file, engine, store);
          closeTriage();
        } catch (err) {
          console.warn('[triage] archive load failed', err);
        }
      });
    };
    hdrRight.appendChild(openRs);

    if (st.hasSavedSession) {
      const resumeBtn = document.createElement('button');
      resumeBtn.className = 'ctx-chip active';
      resumeBtn.textContent = 'RESUME';
      resumeBtn.onclick = async () => {
        await engine.unlock();
        await restoreAutosave(store);
        closeTriage();
      };
      hdrRight.appendChild(resumeBtn);
    }
  }

  const body = document.createElement('div');
  body.className = 'overlay-body';

  if (!ov.step || ov.step === 'root') {
    hdr.innerHTML = `<span>ROOMSERVICE</span>`;
    hdr.appendChild(hdrRight);

    const grid = document.createElement('div');
    grid.className = 'triage-grid-6';

    const tiles = [
      { code: '01', name: 'BEAT', icon: TILE_ICONS.beat, fn: () => goStep('beat-kit') },
      { code: '02', name: 'MELODY', icon: TILE_ICONS.melody, fn: () => goStep('melody-inst') },
      { code: '03', name: 'SAMPLE', icon: TILE_ICONS.sample, fn: () => goStep('sample-src') },
      { code: '04', name: 'CHORDS', icon: TILE_ICONS.chords, fn: () => goStep('chords-scale') },
      {
        code: '05',
        name: 'SEED',
        icon: TILE_ICONS.seed,
        fn: async () => {
          await engine.unlock();
          const bpm = 114 + Math.floor(Math.random() * 24);
          const root = Math.floor(Math.random() * 12);
          const scales = ['MIN', 'DOR', 'PHR', 'HIRA', 'PENTA'];
          const scaleId = scales[Math.floor(Math.random() * scales.length)];

          store.resetProjectBlank('drum8');
          engine.setBpm(bpm);
          st.scaleRoot = root;
          st.scaleId = scaleId;

          store.setDeviceParam(0, 0, 'mode', 1);
          store.setDeviceParam(0, 0, 'kit', Math.floor(Math.random() * 4));
          store.addInsertDevice(1, 'mono303');
          store.addInsertDevice(2, 'polyfm');

          const drums = generateRiff({ isDrum: true, lengthSteps: 16, euclidSteps: 16, euclidHits: 11, density: 95 });
          const bass = generateRiff({ rootIdx: root, scaleId, mode: 'ACID', baseOctave: 2, octaveSpread: 1, euclidSteps: 16, euclidHits: 10, slidePct: 30 });
          const chords = generateRiff({ rootIdx: root, scaleId, mode: 'CHORD', baseOctave: 3, octaveSpread: 2, euclidSteps: 16, euclidHits: 3, density: 100 });

          st.patterns.P01.notesByTrack[0] = drums.notes;
          st.patterns.P01.notesByTrack[1] = bass.notes;
          st.patterns.P01.notesByTrack[2] = chords.notes;
          st.arrClips.push(
            { id: nextId('clip'), kind: 'pattern', refId: 'P01', lane: 0, startStep: 0, lengthSteps: 64, trackOverride: null }
          );

          store.setSelectedTrack(1);
          store.setActivePattern('P01');
          store.setView('ROLL');
          closeTriage();
          if (!st.isPlaying) engine.togglePlay();
        }
      },
      {
        code: '06',
        name: 'BLANK',
        icon: TILE_ICONS.blank,
        fn: async () => {
          await engine.unlock();
          store.resetProjectBlank();
          store.setView('ROLL');
          closeTriage();
        }
      }
    ];

    for (const t of tiles) {
      const btn = document.createElement('button');
      btn.className = 'triage-card';
      btn.innerHTML = `
        <div class="triage-top"><span>${t.code}</span></div>
        <div class="triage-icon">${t.icon}</div>
        <div class="triage-name">${t.name}</div>
      `;
      btn.onclick = t.fn;
      grid.appendChild(btn);
    }

    body.appendChild(grid);
  } else if (ov.step === 'beat-kit') {
    hdr.innerHTML = `<span>BEAT <i class="oh-sub">KIT</i></span>`;
    const grooveBtn = document.createElement('button');
    grooveBtn.className = `ctx-chip ${beatGroove ? 'active' : ''}`;
    grooveBtn.textContent = beatGroove ? 'GROOVE: ON' : 'GROOVE: OFF';
    grooveBtn.onclick = () => {
      beatGroove = !beatGroove;
      grooveBtn.classList.toggle('active', beatGroove);
      grooveBtn.textContent = beatGroove ? 'GROOVE: ON' : 'GROOVE: OFF';
    };
    hdrRight.prepend(grooveBtn);
    hdr.appendChild(hdrRight);

    const grid = document.createElement('div');
    grid.className = 'triage-grid-6';

    const kits = [
      { code: '01', name: 'SYNTH', mode: 0, kit: 0 },
      { code: '02', name: '909', mode: 1, kit: 0 },
      { code: '03', name: '808', mode: 1, kit: 1 },
      { code: '04', name: 'RAND', mode: 1, kit: 2 },
      { code: '05', name: 'COMBO', mode: 1, kit: 3 }
    ];

    for (const k of kits) {
      const btn = document.createElement('button');
      btn.className = 'triage-card';
      btn.innerHTML = `
        <div class="triage-top"><span>${k.code}</span></div>
        <div class="triage-icon">${TILE_ICONS.beat}</div>
        <div class="triage-name">${k.name}</div>
      `;
      btn.onclick = async () => {
        await engine.unlock();
        store.resetProjectBlank('drum8');
        store.setDeviceParam(0, 0, 'mode', k.mode);
        store.setDeviceParam(0, 0, 'kit', k.kit);
        if (k.kit >= 2) engine.getDrumNode(0)?.rerollKit();
        if (beatGroove) {
          const res = generateRiff({ isDrum: true, lengthSteps: 16, euclidSteps: 16, euclidHits: 11, density: 95 });
          store.setActiveNotes(res.notes, 0, 'P01');
        }
        store.emit('drum-pads');
        store.setView('ROLL');
        closeTriage();
        if (beatGroove && !st.isPlaying) engine.togglePlay();
      };
      grid.appendChild(btn);
    }

    body.appendChild(grid);
  } else if (ov.step === 'melody-inst') {
    hdr.innerHTML = `<span>MELODY <i class="oh-sub">INSTRUMENT</i></span>`;
    hdr.appendChild(hdrRight);

    const instruments = getDevicesByCategory('instrument');
    const grid = document.createElement('div');
    grid.className = 'triage-grid-2';

    instruments.forEach((dev, i) => {
      const btn = document.createElement('button');
      btn.className = 'triage-card';
      btn.innerHTML = `
        <div class="triage-top"><span>0${i + 1}</span><span>${dev.meta.visualizer?.toUpperCase() || 'DSP'}</span></div>
        <div class="triage-name">${dev.meta.name}</div>
      `;
      btn.onclick = async () => {
        await engine.unlock();
        store.resetProjectBlank(dev.meta.id);
        const modeMap = { mono303: 'ACID', polyfm: 'ARP', grain1: 'WALK', brickchord: 'CHORD' };
        const res = generateRiff({
          rootIdx: st.scaleRoot,
          scaleId: st.scaleId,
          mode: modeMap[dev.meta.id] || 'ACID',
          baseOctave: dev.meta.id === 'mono303' ? 2 : 3,
          octaveSpread: 2,
          lengthSteps: 16,
          euclidSteps: 16,
          euclidHits: 10,
          slidePct: dev.meta.id === 'mono303' ? 28 : 0,
          isDrum: dev.meta.id === 'drum8'
        });
        store.setActiveNotes(res.notes, 0, 'P01');
        store.setView('ROLL');
        closeTriage();
        if (!st.isPlaying) engine.togglePlay();
      };
      grid.appendChild(btn);
    });

    body.appendChild(grid);
  } else if (ov.step === 'chords-scale') {
    hdr.innerHTML = `<span>CHORDS <i class="oh-sub">SCALE</i></span>`;
    hdr.appendChild(hdrRight);

    const presets = [
      { code: '01', name: 'F# MIN', root: 6, scale: 'MIN' },
      { code: '02', name: 'C DOR', root: 0, scale: 'DOR' },
      { code: '03', name: 'D PHR', root: 2, scale: 'PHR' },
      { code: '04', name: 'A HIRA', root: 9, scale: 'HIRA' },
      { code: '05', name: 'G LYD', root: 7, scale: 'LYD' },
      { code: '06', name: 'RANDOM', root: -1, scale: 'MIN' }
    ];

    const grid = document.createElement('div');
    grid.className = 'triage-grid-6';

    for (const p of presets) {
      const btn = document.createElement('button');
      btn.className = 'triage-card';
      btn.innerHTML = `
        <div class="triage-top"><span>${p.code}</span></div>
        <div class="triage-icon">${TILE_ICONS.chords}</div>
        <div class="triage-name">${p.name}</div>
      `;
      btn.onclick = async () => {
        await engine.unlock();
        const root = p.root === -1 ? Math.floor(Math.random() * 12) : p.root;
        store.resetProjectBlank('brickchord');
        st.scaleRoot = root;
        st.scaleId = p.scale;
        const bcScaleMap = { MIN: 1, DOR: 2, PHR: 1, HIRA: 1, LYD: 0 };
        store.setDeviceParam(0, 0, 'key', root);
        store.setDeviceParam(0, 0, 'scale', bcScaleMap[p.scale] ?? 1);
        const res = generateRiff({
          rootIdx: root,
          scaleId: p.scale,
          mode: 'CHORD',
          baseOctave: 3,
          octaveSpread: 2,
          lengthSteps: 16,
          euclidSteps: 16,
          euclidHits: 3,
          density: 100
        });
        store.setActiveNotes(res.notes, 0, 'P01');
        store.setView('ROLL');
        closeTriage();
        if (!st.isPlaying) engine.togglePlay();
      };
      grid.appendChild(btn);
    }

    body.appendChild(grid);
  } else if (ov.step === 'sample-src') {
    hdr.innerHTML = `<span>SAMPLE <i class="oh-sub">SOURCE</i></span>`;
    hdr.appendChild(hdrRight);

    const grid = document.createElement('div');
    grid.className = 'triage-grid-2';

    const fileBtn = document.createElement('button');
    fileBtn.className = 'triage-card';
    fileBtn.innerHTML = `
      <div class="triage-top"><span>01</span></div>
      <div class="triage-icon">${TILE_ICONS.sample}</div>
      <div class="triage-name">FILE BROWSER</div>
    `;
    fileBtn.onclick = () => {
      ensureHiddenInput('audio/*,.wav,.mp3,.ogg,.flac,.m4a', async (file) => {
        await engine.unlock();
        const ab = await file.arrayBuffer();
        const rawCtx = (await import('tone')).getContext().rawContext;
        const buf = await rawCtx.decodeAudioData(ab);
        goStep('sample-dest', { sampleName: file.name, sampleBuffer: buf });
      });
    };

    const micBtn = document.createElement('button');
    micBtn.className = 'triage-card';
    const renderMicTile = () => {
      micBtn.classList.toggle('rec', micRecording);
      micBtn.innerHTML = `
        <div class="triage-top"><span>02</span><span>${micRecording ? 'LIVE' : 'IN'}</span></div>
        <div class="triage-icon">${TILE_ICONS.sample}</div>
        <div class="triage-name">${micRecording ? '■ STOP MIC' : '● MIC INPUT'}</div>
      `;
    };
    renderMicTile();

    micBtn.onclick = async () => {
      if (!micRecording) {
        try {
          await engine.startMicRecord();
          micRecording = true;
          renderMicTile();
        } catch {
          micRecording = false;
        }
      } else {
        micRecording = false;
        const clip = await engine.stopMicRecord();
        if (clip?.buffer) {
          goStep('sample-dest', { sampleName: clip.name, sampleBuffer: clip.buffer });
        }
      }
    };

    grid.append(fileBtn, micBtn);
    body.appendChild(grid);
  } else if (ov.step === 'sample-dest') {
    hdr.innerHTML = `<span>SAMPLE <i class="oh-sub">MODE</i></span>`;
    hdr.appendChild(hdrRight);

    const grid = document.createElement('div');
    grid.className = 'triage-grid-6';

    const dests = [
      {
        code: '01',
        name: 'WARP LOOP',
        fn: async () => {
          store.resetProjectBlank();
          if (ov.sampleBuffer) {
            engine.registerAudioBuffer(ov.sampleName, ov.sampleBuffer);
          }
          st.playMode = 'SONG';
          store.setView('ARR');
          closeTriage();
        }
      },
      {
        code: '02',
        name: 'CHOP MPC',
        fn: async () => {
          store.resetProjectBlank('drum8');
          if (ov.sampleBuffer) {
            await engine.loadSampleToMpcChop(0, ov.sampleBuffer, ov.sampleName);
          }
          st.detailOverlay = { type: 'mpc', trackId: 0 };
          store.emit('overlay', st.detailOverlay);
        }
      },
      {
        code: '03',
        name: 'SAMPLER',
        fn: async () => {
          store.resetProjectBlank('grain1');
          if (ov.sampleBuffer) {
            await engine.loadSampleToSampler(0, ov.sampleBuffer, ov.sampleName);
          }
          store.setView('ROLL');
          closeTriage();
        }
      }
    ];

    for (const d of dests) {
      const btn = document.createElement('button');
      btn.className = 'triage-card';
      btn.innerHTML = `
        <div class="triage-top"><span>${d.code}</span></div>
        <div class="triage-icon">${TILE_ICONS.sample}</div>
        <div class="triage-name">${d.name}</div>
      `;
      btn.onclick = d.fn;
      grid.appendChild(btn);
    }

    body.appendChild(grid);
  }

  modalEl.append(hdr, body);
}
