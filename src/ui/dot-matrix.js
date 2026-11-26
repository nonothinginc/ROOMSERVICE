import { engine } from '../audio/engine.js';
import { input } from '../input/gamepad.js';
import { store } from '../state/store.js';
import { attachLongPress } from './components/longpress.js';

const MODES = ['WAVE', 'GRAIN', 'RING'];

export function createDotMatrixDisplay() {
  const container = document.createElement('div');
  container.className = 'dot-cutout';

  const canvas = document.createElement('canvas');
  canvas.width = 88;
  canvas.height = 88;
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  canvas.style.display = 'block';
  container.appendChild(canvas);

  const ctx = canvas.getContext('2d');
  let modeIdx = 0;
  let overlayCanvas = null;
  let overlayCtx = null;
  let telemetryEls = null;
  let padCells = [];

  const particles = Array.from({ length: 28 }, () => ({
    a: Math.random() * Math.PI * 2,
    r: Math.random() * 0.85,
    s: 0.01 + Math.random() * 0.025
  }));

  container.addEventListener('click', () => {
    modeIdx = (modeIdx + 1) % MODES.length;
  });

  attachLongPress(container, () => {
    store.getState().detailOverlay = { type: 'dotmatrix' };
    store.emit('overlay', store.getState().detailOverlay);
  });

  function drawMatrix(targetCtx, width, height, gridSize, mode) {
    const styles = getComputedStyle(document.documentElement);
    const ledOn = styles.getPropertyValue('--led-on').trim() || '#F2F0EC';
    const ledOff = styles.getPropertyValue('--led-off').trim() || 'rgba(255,255,255,0.09)';
    const accent = styles.getPropertyValue('--accent').trim() || '#D71921';

    targetCtx.clearRect(0, 0, width, height);

    const wave = engine.getWaveform();
    const fft = engine.getFFT();
    const meter = engine.getMasterMeter();
    const isRec = store.getState().isRecording;

    const cx = width / 2;
    const cy = height / 2;
    const radius = width * 0.45;
    const step = (radius * 2) / (gridSize - 1);
    const dotR = Math.max(1.2, step * 0.28);

    // Update particle cloud
    for (const p of particles) {
      p.a += p.s * (1 + meter * 3);
      p.r = (p.r + 0.008 * (0.4 + meter * 2)) % 0.92;
    }

    for (let gy = 0; gy < gridSize; gy++) {
      for (let gx = 0; gx < gridSize; gx++) {
        const px = cx - radius + gx * step;
        const py = cy - radius + gy * step;
        const dx = (px - cx) / radius;
        const dy = (py - cy) / radius;
        const dist = Math.hypot(dx, dy);
        if (dist > 1.02) continue;

        let active = false;
        let isRed = false;

        if (mode === 'WAVE') {
          const wIdx = Math.min(wave.length - 1, Math.floor((gx / (gridSize - 1)) * (wave.length - 1)));
          const amp = Math.max(-1, Math.min(1, wave[wIdx] * 2.2));
          const targetY = -amp * 0.78;
          if (Math.abs(dy - targetY) < 1.8 / gridSize) {
            active = true;
            if (Math.abs(amp) > 0.65 || isRec) isRed = true;
          }
        } else if (mode === 'GRAIN') {
          for (const p of particles) {
            const pxn = Math.cos(p.a) * p.r;
            const pyn = Math.sin(p.a) * p.r;
            if (Math.hypot(dx - pxn, dy - pyn) < 2.2 / gridSize) {
              active = true;
              if (p.r > 0.62 && meter > 0.35) isRed = true;
              break;
            }
          }
        } else {
          // RING / FFT
          const ang = (Math.atan2(dy, dx) + Math.PI) / (Math.PI * 2);
          const fIdx = Math.min(fft.length - 1, Math.floor(ang * (fft.length - 1)));
          const fftNorm = Math.max(0, Math.min(1, (fft[fIdx] + 90) / 70));
          const ringDist = Math.abs(dist - (0.35 + meter * 0.48 + fftNorm * 0.15));
          if (ringDist < 1.6 / gridSize) {
            active = true;
            if (meter > 0.72 || isRec) isRed = true;
          }
        }

        if (dist < 0.12 && store.getState().isPlaying && (Math.floor(performance.now() / 240) % 2 === 0)) {
          active = true;
          isRed = true;
        }

        targetCtx.beginPath();
        targetCtx.arc(px, py, dotR, 0, Math.PI * 2);
        targetCtx.fillStyle = active ? (isRed ? accent : ledOn) : ledOff;
        targetCtx.fill();
      }
    }
  }

  function renderOverlayContent(containerEl) {
    const header = document.createElement('div');
    header.className = 'overlay-hdr';
    header.innerHTML = `<span>TELEMETRY</span>`;

    const modeBar = document.createElement('div');
    modeBar.style.display = 'flex';
    modeBar.style.gap = '6px';
    MODES.forEach((m, idx) => {
      const btn = document.createElement('button');
      btn.className = `ctx-chip ${modeIdx === idx ? 'active' : ''}`;
      btn.textContent = m;
      btn.onclick = () => {
        modeIdx = idx;
        modeBar.querySelectorAll('.ctx-chip').forEach((c, i) => c.classList.toggle('active', i === idx));
      };
      modeBar.appendChild(btn);
    });

    const closeBtn = document.createElement('button');
    closeBtn.className = 'ctx-chip';
    closeBtn.innerHTML = '<svg class="ico" viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8"/></svg>';
    closeBtn.title = 'Close [B]';
    closeBtn.classList.add('icon-only');
    closeBtn.onclick = () => {
      store.getState().detailOverlay = null;
      store.emit('overlay', null);
    };
    modeBar.appendChild(closeBtn);
    header.appendChild(modeBar);

    const body = document.createElement('div');
    body.className = 'overlay-body dm-overlay-grid';

    overlayCanvas = document.createElement('canvas');
    overlayCanvas.className = 'dm-overlay-canvas';
    overlayCanvas.width = 640;
    overlayCanvas.height = 640;
    overlayCtx = overlayCanvas.getContext('2d');

    const right = document.createElement('div');
    right.style.display = 'flex';
    right.style.flexDirection = 'column';
    right.style.gap = '10px';
    right.style.minWidth = '0';

    const telGrid = document.createElement('div');
    telGrid.className = 'telemetry-grid';
    telemetryEls = {};
    const fields = [
      ['AUDIO', 'state'],
      ['SR', 'sampleRate'],
      ['LATENCY', 'latencyMs'],
      ['FPS', 'fps'],
      ['NODES', 'activeVoices'],
      ['PAD', 'padId']
    ];
    for (const [label, key] of fields) {
      const cell = document.createElement('div');
      cell.className = 'tel-cell';
      cell.innerHTML = `<span class="k">${label}</span><span class="v">--</span>`;
      telGrid.appendChild(cell);
      telemetryEls[key] = cell.querySelector('.v');
    }

    const padGrid = document.createElement('div');
    padGrid.className = 'pad-diag-grid';
    const names = ['A', 'B', 'X', 'Y', 'L1', 'R1', 'L2', 'R2', 'SEL', 'STR', 'L3', 'R3', 'UP', 'DN', 'LT', 'RT'];
    padCells = names.map((n) => {
      const c = document.createElement('div');
      c.className = 'pad-cell';
      c.textContent = n;
      padGrid.appendChild(c);
      return c;
    });

    const axesEl = document.createElement('div');
    axesEl.className = 'tel-cell';
    axesEl.innerHTML = `<span class="k">ANALOG L/R</span><span class="v">0.00 / 0.00</span>`;
    telemetryEls.axes = axesEl.querySelector('.v');

    // Hardware Stick Calibration & Virtual-Stick Toggle
    const calBar = document.createElement('div');
    calBar.className = 'cal-bar';

    const zeroBtn = document.createElement('button');
    zeroBtn.className = 'ctx-chip';
    zeroBtn.textContent = 'ZERO CAL';
    zeroBtn.onclick = () => {
      input.calibrateZero();
      syncCalLabels();
    };

    const dzBtn = document.createElement('button');
    dzBtn.className = 'ctx-chip';
    dzBtn.onclick = () => {
      const cur = input.getCalibration().deadzone;
      const next = cur >= 0.25 ? 0.08 : +(cur + 0.04).toFixed(2);
      input.setDeadzone(next);
      syncCalLabels();
    };

    const modeBtn = document.createElement('button');
    modeBtn.className = 'ctx-chip';
    modeBtn.onclick = () => {
      input.cycleStickMode();
      syncCalLabels();
    };

    const resetBtn = document.createElement('button');
    resetBtn.className = 'ctx-chip';
    resetBtn.textContent = 'RESET';
    resetBtn.onclick = () => {
      input.resetCalibration();
      syncCalLabels();
    };

    function syncCalLabels() {
      const c = input.getCalibration();
      dzBtn.textContent = `DZ ${Math.round(c.deadzone * 100)}%`;
      modeBtn.textContent = `STICKS ${c.stickMode}`;
      modeBtn.classList.toggle('active', c.stickMode !== 'AUTO');
    }
    syncCalLabels();
    calBar.append(zeroBtn, dzBtn, modeBtn, resetBtn);

    right.appendChild(telGrid);
    right.appendChild(padGrid);
    right.appendChild(axesEl);
    right.appendChild(calBar);

    body.appendChild(overlayCanvas);
    body.appendChild(right);

    containerEl.appendChild(header);
    containerEl.appendChild(body);
  }

  const smoothAxes = [0, 0, 0, 0];

  function tick() {
    drawMatrix(ctx, canvas.width, canvas.height, 15, MODES[modeIdx]);

    if (store.getState().detailOverlay?.type === 'dotmatrix' && overlayCtx) {
      drawMatrix(overlayCtx, overlayCanvas.width, overlayCanvas.height, 41, MODES[modeIdx]);
      const tel = engine.getTelemetry();
      const pad = input.getGamepadState();
      for (let i = 0; i < 4; i++) {
        smoothAxes[i] += ((pad.axes[i] || 0) - smoothAxes[i]) * 0.25;
      }
      if (telemetryEls) {
        telemetryEls.state.textContent = tel.state;
        telemetryEls.sampleRate.textContent = `${tel.sampleRate}Hz`;
        telemetryEls.latencyMs.textContent = `${tel.latencyMs}ms`;
        telemetryEls.fps.textContent = `${tel.fps}`;
        telemetryEls.activeVoices.textContent = `${tel.activeVoices}`;
        telemetryEls.padId.textContent = pad.connected ? 'RG477V' : 'KEYS';
        telemetryEls.axes.textContent = `L(${smoothAxes[0].toFixed(2)},${smoothAxes[1].toFixed(2)}) R(${smoothAxes[2].toFixed(2)},${smoothAxes[3].toFixed(2)})`;
      }
      padCells.forEach((cell, i) => {
        cell.classList.toggle('on', Boolean(pad.buttons[i]));
      });
    } else {
      overlayCanvas = null;
      overlayCtx = null;
    }
  }

  return {
    el: container,
    tick,
    renderOverlayContent
  };
}
