import { engine } from '../audio/engine.js';
import { store } from '../state/store.js';

const BTN = {
  A: 0,
  B: 1,
  X: 2,
  Y: 3,
  L1: 4,
  R1: 5,
  L2: 6,
  R2: 7,
  SELECT: 8,
  START: 9,
  L3: 10,
  R3: 11,
  UP: 12,
  DOWN: 13,
  LEFT: 14,
  RIGHT: 15
};

const DEADZONE = 0.15;
const LONG_PRESS_MS = 450;

function applyDeadzone(v) {
  if (Math.abs(v) < DEADZONE) return 0;
  const sign = Math.sign(v);
  return (sign * (Math.abs(v) - DEADZONE)) / (1 - DEADZONE);
}

class InputController {
  constructor() {
    this.prevButtons = new Array(16).fill(false);
    this.aHoldStart = 0;
    this.aLongFired = false;
    this.dpadRepeatAt = { UP: 0, DOWN: 0, LEFT: 0, RIGHT: 0 };

    this.keysDown = new Set();
    this.keyAHoldStart = 0;
    this.keyALongFired = false;

    this.handlers = new Set();
    this.diagState = {
      connected: false,
      id: 'KEYBOARD',
      buttons: new Array(16).fill(false),
      axes: [0, 0, 0, 0]
    };
  }

  onAction(fn) {
    this.handlers.add(fn);
    return () => this.handlers.delete(fn);
  }

  dispatch(action) {
    for (const fn of this.handlers) {
      try {
        fn(action);
      } catch (err) {
        console.error('[input] handler error', err);
      }
    }
  }

  getGamepadState() {
    return this.diagState;
  }

  isFineModifier() {
    return this.diagState.buttons[BTN.L2] || this.keysDown.has('ShiftLeft') || this.keysDown.has('ShiftRight');
  }

  init() {
    window.addEventListener('keydown', (e) => this.handleKeyDown(e));
    window.addEventListener('keyup', (e) => this.handleKeyUp(e));
  }

  handleKeyDown(e) {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT')) return;
    engine.unlock();
    const code = e.code;
    const isRepeat = this.keysDown.has(code);
    this.keysDown.add(code);

    if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Backspace'].includes(code)) {
      e.preventDefault();
    }

    if (isRepeat) return;

    const st = store.getState();

    // Undo / Redo keyboard shortcuts
    if ((e.metaKey || e.ctrlKey) && code === 'KeyZ') {
      e.preventDefault();
      if (e.shiftKey) store.redo();
      else store.undo();
      return;
    }
    if ((e.metaKey || e.ctrlKey) && code === 'KeyY') {
      e.preventDefault();
      store.redo();
      return;
    }

    // Global transport & theme shortcuts
    if (code === 'Space') {
      engine.togglePlay();
      return;
    }
    if (code === 'KeyR') {
      engine.toggleRecord();
      return;
    }
    if (code === 'KeyT') {
      store.toggleTheme();
      return;
    }
    if (code === 'Digit1') {
      store.setView('ROLL');
      return;
    }
    if (code === 'Digit2') {
      store.setView('ARR');
      return;
    }
    if (code === 'Digit3') {
      store.setView('MIX');
      return;
    }
    if (code === 'Digit4') {
      store.setView('DSP');
      return;
    }
    if (code === 'KeyQ') {
      store.cycleView(-1);
      return;
    }
    if (code === 'KeyE') {
      store.cycleView(1);
      return;
    }
    if (code === 'BracketLeft') {
      store.setSelectedTrack((st.selectedTrackId + 7) % 8);
      return;
    }
    if (code === 'BracketRight') {
      store.setSelectedTrack((st.selectedTrackId + 1) % 8);
      return;
    }

    // ABXY + DPad fallbacks
    if (code === 'Enter' || code === 'KeyZ') {
      this.keyAHoldStart = performance.now();
      this.keyALongFired = false;
      return;
    }
    if (code === 'Escape' || code === 'Backspace') {
      this.handleB();
      return;
    }
    if (code === 'KeyX') {
      this.dispatch({ type: 'X' });
      return;
    }
    if (code === 'KeyY' || code === 'KeyC') {
      this.dispatch({ type: 'Y' });
      return;
    }
    if (code === 'ArrowUp') this.dispatch({ type: 'DPAD', dir: 'UP', fine: e.shiftKey });
    if (code === 'ArrowDown') this.dispatch({ type: 'DPAD', dir: 'DOWN', fine: e.shiftKey });
    if (code === 'ArrowLeft') this.dispatch({ type: 'DPAD', dir: 'LEFT', fine: e.shiftKey });
    if (code === 'ArrowRight') this.dispatch({ type: 'DPAD', dir: 'RIGHT', fine: e.shiftKey });
  }

  handleKeyUp(e) {
    const code = e.code;
    this.keysDown.delete(code);
    if (code === 'Enter' || code === 'KeyZ') {
      if (this.keyAHoldStart > 0 && !this.keyALongFired) {
        this.dispatch({ type: 'A_TAP', l2: this.isFineModifier() });
      }
      this.keyAHoldStart = 0;
      this.keyALongFired = false;
    }
  }

  handleB() {
    const st = store.getState();
    if (st.detailOverlay) {
      st.detailOverlay = null;
      store.emit('overlay', null);
      return;
    }
    if (st.randomizerOpen) {
      st.randomizerOpen = false;
      store.emit('randomizer', false);
      return;
    }
    if (st.devicePickerOpen) {
      st.devicePickerOpen = false;
      store.emit('device-picker', false);
      return;
    }
    this.dispatch({ type: 'B' });
  }

  poll(now) {
    // Keyboard A long-press
    if (this.keyAHoldStart > 0 && !this.keyALongFired && now - this.keyAHoldStart >= LONG_PRESS_MS) {
      this.keyALongFired = true;
      this.dispatch({ type: 'A_HOLD' });
    }

    // Keyboard virtual sticks (WASD / IJKL)
    let kbLx = (this.keysDown.has('KeyD') ? 1 : 0) - (this.keysDown.has('KeyA') ? 1 : 0);
    let kbLy = (this.keysDown.has('KeyS') ? 1 : 0) - (this.keysDown.has('KeyW') ? 1 : 0);
    let kbRx = (this.keysDown.has('KeyL') ? 1 : 0) - (this.keysDown.has('KeyJ') ? 1 : 0);
    let kbRy = (this.keysDown.has('KeyK') ? 1 : 0) - (this.keysDown.has('KeyI') ? 1 : 0);

    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const pad = Array.from(pads).find((p) => p && p.connected) || null;

    if (!pad) {
      this.diagState.connected = false;
      this.diagState.id = 'KEYBOARD FALLBACK';
      this.diagState.axes = [kbLx, kbLy, kbRx, kbRy];
      this.diagState.buttons.fill(false);
      this.diagState.buttons[BTN.L2] = this.keysDown.has('ShiftLeft') || this.keysDown.has('ShiftRight');

      if (kbLx || kbLy || kbRx || kbRy) {
        this.dispatch({
          type: 'STICKS',
          lx: kbLx,
          ly: kbLy,
          rx: kbRx,
          ry: kbRy,
          fine: this.isFineModifier()
        });
      }
      return;
    }

    this.diagState.connected = true;
    this.diagState.id = (pad.id || 'RG477V PAD').slice(0, 22).toUpperCase();

    const cur = new Array(16).fill(false);
    for (let i = 0; i < 16; i++) {
      const b = pad.buttons[i];
      cur[i] = Boolean(b && (b.pressed || b.value > 0.5));
      this.diagState.buttons[i] = cur[i];
    }

    const anyPressed = cur.some((v, idx) => v && !this.prevButtons[idx]);
    if (anyPressed) engine.unlock();

    const l2 = cur[BTN.L2];
    const r2 = cur[BTN.R2];

    const justPressed = (idx) => cur[idx] && !this.prevButtons[idx];
    const justReleased = (idx) => !cur[idx] && this.prevButtons[idx];

    // Combo: L2 + Select => Theme toggle
    if (l2 && justPressed(BTN.SELECT)) {
      store.toggleTheme();
    }

    // Combo: R2 + Start => Play/Stop
    if (r2 && justPressed(BTN.START)) {
      engine.togglePlay();
    } else if (!r2 && justPressed(BTN.START)) {
      engine.togglePlay();
    }

    // Combo: R2 + Select => Record
    if (r2 && justPressed(BTN.SELECT)) {
      engine.toggleRecord();
    }

    // L1 / R1 => Cycle Views
    if (justPressed(BTN.L1)) store.cycleView(-1);
    if (justPressed(BTN.R1)) store.cycleView(1);

    // A button (tap vs 450ms hold)
    if (justPressed(BTN.A)) {
      this.aHoldStart = now;
      this.aLongFired = false;
    }
    if (cur[BTN.A] && this.aHoldStart > 0 && !this.aLongFired && now - this.aHoldStart >= LONG_PRESS_MS) {
      this.aLongFired = true;
      this.dispatch({ type: 'A_HOLD' });
    }
    if (justReleased(BTN.A)) {
      if (!this.aLongFired && this.aHoldStart > 0) {
        this.dispatch({ type: 'A_TAP', l2 });
      }
      this.aHoldStart = 0;
      this.aLongFired = false;
    }

    if (justPressed(BTN.B)) {
      if (l2) store.undo();
      else this.handleB();
    }
    if (justPressed(BTN.X)) this.dispatch({ type: 'X' });
    if (justPressed(BTN.Y)) {
      if (l2) store.redo();
      else this.dispatch({ type: 'Y' });
    }

    // D-Pad with repeat
    const dirs = [
      ['UP', BTN.UP],
      ['DOWN', BTN.DOWN],
      ['LEFT', BTN.LEFT],
      ['RIGHT', BTN.RIGHT]
    ];
    for (const [dir, idx] of dirs) {
      if (justPressed(idx)) {
        if (r2 && (dir === 'LEFT' || dir === 'RIGHT')) {
          engine.scrubStep(dir === 'LEFT' ? -1 : 1);
        } else {
          this.dispatch({ type: 'DPAD', dir, fine: l2 });
        }
        this.dpadRepeatAt[dir] = now + 260;
      } else if (cur[idx] && now >= this.dpadRepeatAt[dir]) {
        if (r2 && (dir === 'LEFT' || dir === 'RIGHT')) {
          engine.scrubStep(dir === 'LEFT' ? -1 : 1);
        } else {
          this.dispatch({ type: 'DPAD', dir, fine: l2 });
        }
        this.dpadRepeatAt[dir] = now + 75;
      }
    }

    const lx = applyDeadzone(pad.axes[0] || 0) || kbLx;
    const ly = applyDeadzone(pad.axes[1] || 0) || kbLy;
    const rx = applyDeadzone(pad.axes[2] || 0) || kbRx;
    const ry = applyDeadzone(pad.axes[3] || 0) || kbRy;
    this.diagState.axes = [lx, ly, rx, ry];

    if (lx !== 0 || ly !== 0 || rx !== 0 || ry !== 0) {
      this.dispatch({ type: 'STICKS', lx, ly, rx, ry, fine: l2 });
    }

    for (let i = 0; i < 16; i++) this.prevButtons[i] = cur[i];
  }
}

export const input = new InputController();
