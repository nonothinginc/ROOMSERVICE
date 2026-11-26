import './styles/main.css';
import { engine } from './audio/engine.js';
import { input } from './input/gamepad.js';
import { getSongEnd, store } from './state/store.js';
import { hasAutosave, saveAutosave } from './storage/project-archive.js';
import { createDotMatrixDisplay } from './ui/dot-matrix.js';
import { createHeader, createLeftRail, createRightRail, renderHistoryOverlay, renderProjectModal } from './ui/header.js';
import { renderInstMenuModal } from './ui/inst-menu.js';
import { renderLabOverlay } from './ui/lab.js';
import { closeLibrary, handleLibraryAction, renderLibraryOverlay } from './ui/library-view.js';
import { library } from './library/library.js';
import { createModeWheel } from './ui/mode-wheel.js';
import { renderTriageModal } from './ui/triage.js';
import { createArrView } from './ui/views/arr.js';
import { handleBrickchordRawPad, renderBrickchordOverlay, tickBrickchordOverlay } from './ui/views/brickchord-pad.js';
import { createDspView } from './ui/views/dsp.js';
import { handleLeadRawPad, renderLeadOverlay, tickLeadOverlay } from './ui/views/lead-pad.js';
import { createMixView } from './ui/views/mix.js';
import { renderMpcEditor, tickMpcOverlay } from './ui/views/mpc-editor.js';
import { handleTapeRawPad, renderTapeDeckOverlay, tickTapeDeckOverlay } from './ui/views/tape-deck-view.js';
import { createRollView } from './ui/views/roll.js';

function boot() {
  engine.init();
  input.init();
  // Library metadata loads in the background (IndexedDB), audio decodes on demand
  library.init();

  const unlockOnce = () => {
    engine.unlock();
    window.removeEventListener('pointerdown', unlockOnce);
  };
  window.addEventListener('pointerdown', unlockOnce, { passive: true });

  const appRoot = document.getElementById('app');
  const chassis = document.createElement('div');
  chassis.className = 'chassis';

  const dotMatrix = createDotMatrixDisplay();
  const leftRail = createLeftRail();
  const centerCol = document.createElement('div');
  centerCol.className = 'hw-center-col';
  const header = createHeader();
  const rightRail = createRightRail(dotMatrix);

  const stage = document.createElement('main');
  stage.className = 'stage';

  const views = {
    ROLL: createRollView(),
    ARR: createArrView(),
    MIX: createMixView(),
    DSP: createDspView()
  };

  const overlayRoot = document.createElement('div');
  overlayRoot.className = 'overlay-backdrop';
  overlayRoot.style.display = 'none';

  const modeWheel = createModeWheel();

  centerCol.append(header.el, stage);
  chassis.append(leftRail.el, centerCol, rightRail.el, overlayRoot, modeWheel.el);
  appRoot.appendChild(chassis);

  const mobileMq = window.matchMedia('(max-width: 560px)');
  const syncDotMatrixMount = () => {
    if (mobileMq.matches) {
      if (dotMatrix.el.parentElement !== header.mobileDotSlot) {
        header.mobileDotSlot.appendChild(dotMatrix.el);
      }
    } else if (dotMatrix.el.parentElement !== rightRail.topSlot) {
      rightRail.topSlot.appendChild(dotMatrix.el);
    }
  };
  mobileMq.addEventListener('change', syncDotMatrixMount);
  syncDotMatrixMount();

  function mountActiveView() {
    const st = store.getState();
    stage.innerHTML = '';
    stage.appendChild(views[st.view].el);
  }

  function renderModalsAndOverlays() {
    const st = store.getState();
    if (st.detailOverlay?.type !== 'lab') {
      engine.stopLabPreview();
    }
    if (st.detailOverlay?.type !== 'library') {
      closeLibrary();
    }
    overlayRoot.innerHTML = '';

    if (st.detailOverlay) {
      overlayRoot.style.display = 'flex';
      if (st.detailOverlay.type === 'triage') {
        const modal = document.createElement('div');
        modal.className = 'overlay-modal triage-modal';
        renderTriageModal(modal);
        overlayRoot.appendChild(modal);
        return;
      }
      if (st.detailOverlay.type === 'inst-menu') {
        const modal = document.createElement('div');
        modal.className = 'overlay-modal inst-menu-modal';
        renderInstMenuModal(modal);
        overlayRoot.appendChild(modal);
        return;
      }
      if (st.detailOverlay.type === 'project') {
        const modal = document.createElement('div');
        modal.className = 'overlay-modal clip-menu-modal';
        renderProjectModal(modal);
        overlayRoot.appendChild(modal);
        return;
      }
      if (st.detailOverlay.type === 'arr-add') {
        const modal = document.createElement('div');
        modal.className = 'overlay-modal clip-menu-modal';
        views.ARR.renderArrAddModal(modal);
        overlayRoot.appendChild(modal);
        return;
      }
      if (st.detailOverlay.type === 'lane-label') {
        const modal = document.createElement('div');
        modal.className = 'overlay-modal lane-label-modal';
        views.ARR.renderLaneLabelModal(modal);
        overlayRoot.appendChild(modal);
        return;
      }
      if (st.detailOverlay.type === 'clip-rename') {
        const modal = document.createElement('div');
        modal.className = 'overlay-modal lane-label-modal';
        views.ARR.renderClipRenameModal(modal);
        overlayRoot.appendChild(modal);
        return;
      }
      if (st.detailOverlay.type === 'pattern-rename') {
        const modal = document.createElement('div');
        modal.className = 'overlay-modal lane-label-modal';
        views.ARR.renderPatternRenameModal(modal);
        overlayRoot.appendChild(modal);
        return;
      }
      if (st.detailOverlay.type === 'mix-rename') {
        const modal = document.createElement('div');
        modal.className = 'overlay-modal lane-label-modal';
        views.MIX.renderTrackRenameModal(modal);
        overlayRoot.appendChild(modal);
        return;
      }
      if (st.detailOverlay.type === 'mix-fx') {
        const modal = document.createElement('div');
        modal.className = 'overlay-modal inst-menu-modal';
        views.MIX.renderChannelFxModal(modal);
        overlayRoot.appendChild(modal);
        return;
      }
      if (st.detailOverlay.type === 'mix-return-fx') {
        const modal = document.createElement('div');
        modal.className = 'overlay-modal clip-menu-modal';
        views.MIX.renderReturnFxModal(modal);
        overlayRoot.appendChild(modal);
        return;
      }
      if (st.detailOverlay.type === 'clip-menu') {
        const modal = document.createElement('div');
        modal.className = 'overlay-modal clip-menu-modal';
        views.ARR.renderClipMenuModal(modal);
        overlayRoot.appendChild(modal);
        return;
      }
      const panel = document.createElement('div');
      panel.className = 'overlay-panel';
      if (st.detailOverlay.type === 'dotmatrix') {
        dotMatrix.renderOverlayContent(panel);
      } else if (st.detailOverlay.type === 'history') {
        renderHistoryOverlay(panel);
      } else if (st.detailOverlay.type === 'lab') {
        renderLabOverlay(panel);
      } else if (st.detailOverlay.type === 'tape') {
        renderTapeDeckOverlay(panel);
      } else if (st.detailOverlay.type === 'library') {
        panel.classList.add('lib-panel');
        renderLibraryOverlay(panel);
      } else if (st.detailOverlay.type === 'roll') {
        views.ROLL.renderDetailOverlay(panel);
      } else if (st.detailOverlay.type === 'arr' || st.detailOverlay.type === 'auto' || st.detailOverlay.type === 'audio') {
        views.ARR.renderDetailOverlay(panel);
      } else if (st.detailOverlay.type === 'mix') {
        views.MIX.renderDetailOverlay(panel);
      } else if (st.detailOverlay.type === 'punch') {
        views.MIX.renderPunchFxOverlay(panel);
      } else if (st.detailOverlay.type === 'dsp') {
        views.DSP.renderDetailOverlay(panel);
      } else if (st.detailOverlay.type === 'mpc') {
        renderMpcEditor(panel, st.detailOverlay.trackId);
      } else if (st.detailOverlay.type === 'brickchord') {
        panel.classList.add('bc-panel');
        renderBrickchordOverlay(panel, st.detailOverlay.trackId);
      } else if (st.detailOverlay.type === 'lead') {
        panel.classList.add('bc-panel');
        renderLeadOverlay(panel, st.detailOverlay.trackId);
      }
      overlayRoot.appendChild(panel);
      return;
    }

    if (st.randomizerOpen) {
      overlayRoot.style.display = 'flex';
      const modal = document.createElement('div');
      modal.className = 'overlay-modal';
      views.ROLL.renderRandomizerModal(modal);
      overlayRoot.appendChild(modal);
      return;
    }

    if (st.devicePickerOpen) {
      overlayRoot.style.display = 'flex';
      const modal = document.createElement('div');
      modal.className = 'overlay-modal';
      views.DSP.renderDevicePickerModal(modal);
      overlayRoot.appendChild(modal);
      return;
    }

    overlayRoot.style.display = 'none';
  }

  overlayRoot.addEventListener('pointerdown', (e) => {
    if (e.target === overlayRoot) {
      const st = store.getState();
      st.detailOverlay = null;
      st.randomizerOpen = false;
      st.devicePickerOpen = false;
      renderModalsAndOverlays();
    }
  });

  let autosaveTimer = null;
  store.subscribe((_, topic) => {
    if (topic === 'view') mountActiveView();
    if (topic === 'overlay' || topic === 'randomizer' || topic === 'device-picker') {
      renderModalsAndOverlays();
    }
    if (['notes', 'arr', 'lab', 'mixer', 'dsp-param', 'dsp-chain', 'dsp-bypass', 'history-restore'].includes(topic)) {
      clearTimeout(autosaveTimer);
      autosaveTimer = setTimeout(() => {
        saveAutosave(store);
      }, 900);
    }
  });

  input.onAction((action) => {
    const st = store.getState();
    if (st.detailOverlay?.type === 'library') {
      handleLibraryAction(action);
      return;
    }
    views[st.view]?.handleAction?.(action);
  });

  input.onRawPad((pad) => {
    const t = store.getState().detailOverlay?.type;
    if (t === 'brickchord') handleBrickchordRawPad(pad);
    else if (t === 'lead') handleLeadRawPad(pad);
    else if (t === 'tape') handleTapeRawPad(pad);
  });

  input.onWheel((ev) => {
    if (ev.type === 'OPEN') modeWheel.open();
    else if (ev.type === 'CLOSE') modeWheel.close(ev.commit);
    else if (ev.type === 'STICK') modeWheel.updateStick(ev.lx, ev.ly);
    else if (ev.type === 'TOGGLE') modeWheel.toggle();
  });

  mountActiveView();
  renderModalsAndOverlays();

  hasAutosave().then((exists) => {
    const st = store.getState();
    st.hasSavedSession = exists;
    if (exists && st.detailOverlay?.type === 'triage' && st.detailOverlay.step === 'root') {
      renderModalsAndOverlays();
    }
  });

  // Unified 120fps render & input polling loop
  function frame(now) {
    input.poll(now);
    engine.tickFps(now);
    dotMatrix.tick();
    rightRail.tick();
    modeWheel.tick();
    tickMpcOverlay();
    tickBrickchordOverlay();
    tickLeadOverlay();
    tickTapeDeckOverlay();
    views.DSP.tickOverlay?.();
    views.MIX.tickOverlay?.();
    const activeView = views[store.getState().view];
    activeView?.tick?.();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // Dev-only handle for automated UI/audio tests (tools/*.mjs); stripped from production builds
  if (import.meta.env.DEV) window.__rs = { engine, store, getSongEnd };

  if (import.meta.env.PROD && 'serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

boot();
