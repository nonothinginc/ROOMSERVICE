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

const DEADZONE_DEFAULT = 0.15;
const LONG_PRESS_MS = 450;
const CAL_KEY = 'roomservice_pad_cal_v1';
const STICK_MODES = ['AUTO', 'ANALOG', 'VIRTUAL'];

function loadCal() {
  try {
    const raw = localStorage.getItem(CAL_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      return {
        deadzone: Math.max(0.05, Math.min(0.35, Number(p.deadzone) || DEADZONE_DEFAULT)),
        offsets: Array.isArray(p.offsets) && p.offsets.length === 4 ? p.offsets.map(Number) : [0, 0, 0, 0],
        stickMode: STICK_MODES.includes(p.stickMode) ? p.stickMode : 'AUTO'
      };
    }
  } catch {
    // ignore
  }
  return { deadzone: DEADZONE_DEFAULT, offsets: [0, 0, 0, 0], stickMode: 'AUTO' };
}

function saveCal(cal) {
  try {
    localStorage.setItem(CAL_KEY, JSON.stringify(cal));
  } catch {
    // ignore
  }
}

function applyCalAxis(rawVal, offset, dz) {
  const v = Math.max(-1, Math.min(1, (rawVal || 0) - (offset || 0)));
  if (Math.abs(v) < dz) return 0;
  const sign = Math.sign(v);
  return (sign * (Math.abs(v) - dz)) / (1 - dz);
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
    this.rawPadListeners = new Set();
    this.wheelListeners = new Set();
    this.cal = loadCal();
    this.rawAxes = [0, 0, 0, 0];
    this.r2PunchActive = false;
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

  onRawPad(fn) {
    this.rawPadListeners.add(fn);
    return () => this.rawPadListeners.delete(fn);
  }

  onWheel(fn) {
    this.wheelListeners.add(fn);
    return () => this.wheelListeners.delete(fn);
  }

  emitWheel(ev) {
    for (const fn of this.wheelListeners) {
      try {
        fn(ev);
      } catch (err) {
        console.error('[input] wheel handler error', err);
      }
    }
  }

  getCalibration() {
    return { ...this.cal, offsets: [...this.cal.offsets] };
  }

  setDeadzone(dz) {
    this.cal.deadzone = Math.max(0.05, Math.min(0.35, Number(dz) || DEADZONE_DEFAULT));
    saveCal(this.cal);
  }

  cycleStickMode() {
    const i = STICK_MODES.indexOf(this.cal.stickMode);
    this.cal.stickMode = STICK_MODES[(i + 1) % STICK_MODES.length];
    saveCal(this.cal);
    return this.cal.stickMode;
  }

  calibrateZero() {
    this.cal.offsets = [...this.rawAxes];
    saveCal(this.cal);
  }

  resetCalibration() {
    this.cal = { deadzone: DEADZONE_DEFAULT, offsets: [0, 0, 0, 0], stickMode: 'AUTO' };
    saveCal(this.cal);
  }

  dispatchRawPad(payload) {
    for (const fn of this.rawPadListeners) {
      try {
        fn(payload);
      } catch (err) {
        console.error('[input] rawPad handler error', err);
      }
    }
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
    // A key released while the page is hidden/unfocused never fires keyup; drop stale holds
    window.addEventListener('blur', () => this.keysDown.clear());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.keysDown.clear();
    });
  }

  handleKeyDown(e) {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT')) return;
    engine.unlock();
    const code = e.code;
    const isRepeat = this.keysDown.has(code);
    this.keysDown.add(code);

    if (['Space', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Backspace'].includes(code)) {
      e.preventDefault();
    }

    if (isRepeat) return;

    const st = store.getState();

    if (code === 'Tab') {
      this.emitWheel({ type: 'TOGGLE' });
      return;
    }

    // Brickchord / Lead live keyboard mode when performance overlay is active
    if (st.detailOverlay?.type === 'brickchord' || st.detailOverlay?.type === 'lead') {
      if (code === 'Space') {
        engine.togglePlay();
        return;
      }
      if (code === 'KeyT') {
        store.toggleTheme();
        return;
      }
      if (code === 'Escape' || code === 'Backspace') {
        st.detailOverlay = null;
        store.emit('overlay', null);
        return;
      }
      return;
    }

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

      const ovType = store.getState().detailOverlay?.type;
      if (ovType === 'brickchord' || ovType === 'lead') {
        const kbBtns = new Array(16).fill(false);
        kbBtns[BTN.LEFT] = this.keysDown.has('Digit1');
        kbBtns[BTN.UP] = this.keysDown.has('Digit2');
        kbBtns[BTN.RIGHT] = this.keysDown.has('Digit3');
        kbBtns[BTN.DOWN] = this.keysDown.has('Digit4');
        kbBtns[BTN.X] = this.keysDown.has('Digit5');
        kbBtns[BTN.A] = this.keysDown.has('Digit6');
        kbBtns[BTN.B] = this.keysDown.has('Digit7');
        kbBtns[BTN.Y] = this.keysDown.has('ShiftLeft') || this.keysDown.has('ShiftRight');
        kbBtns[BTN.L1] = this.keysDown.has('KeyQ');
        kbBtns[BTN.R1] = this.keysDown.has('KeyE');
        kbBtns[BTN.L2] = this.keysDown.has('KeyZ');
        kbBtns[BTN.R2] = this.keysDown.has('KeyC');
        this.dispatchRawPad({
          buttons: kbBtns,
          prevButtons: [...this.prevButtons],
          axes: [kbLx, kbLy, kbRx, kbRy],
          now
        });
        this.prevButtons = kbBtns;
        return;
      }

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

    // Raw performance passthrough when Brickchord / Lead RG477V overlay is open
    const activeSt = store.getState();
    const rawOverlayType = activeSt.detailOverlay?.type;
    if (rawOverlayType === 'brickchord' || rawOverlayType === 'lead') {
      if (justPressed(BTN.START)) {
        engine.togglePlay();
      }
      // Exit cleanly with SELECT + B so plain B stays usable as a music pad!
      if (cur[BTN.SELECT] && justPressed(BTN.B)) {
        activeSt.detailOverlay = null;
        store.emit('overlay', null);
        for (let i = 0; i < 16; i++) this.prevButtons[i] = cur[i];
        return;
      }

      this.rawAxes = [pad.axes[0] || 0, pad.axes[1] || 0, pad.axes[2] || 0, pad.axes[3] || 0];
      const dz = this.cal.deadzone;
      const useVirtual = this.cal.stickMode === 'VIRTUAL' || (this.cal.stickMode === 'AUTO' && pad.axes.length < 2);
      const virtLx = useVirtual && l2 ? (cur[BTN.RIGHT] ? 1 : 0) - (cur[BTN.LEFT] ? 1 : 0) : 0;
      const virtLy = useVirtual && l2 ? (cur[BTN.DOWN] ? 1 : 0) - (cur[BTN.UP] ? 1 : 0) : 0;

      const rawLx = applyCalAxis(pad.axes[0], this.cal.offsets[0], dz) || virtLx || kbLx;
      const rawLy = applyCalAxis(pad.axes[1], this.cal.offsets[1], dz) || virtLy || kbLy;
      const rawRx = applyCalAxis(pad.axes[2], this.cal.offsets[2], dz) || kbRx;
      const rawRy = applyCalAxis(pad.axes[3], this.cal.offsets[3], dz) || kbRy;
      this.diagState.axes = [rawLx, rawLy, rawRx, rawRy];

      this.dispatchRawPad({
        buttons: [...cur],
        prevButtons: [...this.prevButtons],
        axes: [rawLx, rawLy, rawRx, rawRy],
        now
      });
      for (let i = 0; i < 16; i++) this.prevButtons[i] = cur[i];
      return;
    }

    // L3 Hold -> Radial Mode Wheel (tilt Left Stick, release L3 to jump)
    if (justPressed(BTN.L3)) {
      this.emitWheel({ type: 'OPEN' });
    }
    if (cur[BTN.L3]) {
      const dz = this.cal.deadzone;
      const lxWheel = applyCalAxis(pad.axes[0], this.cal.offsets[0], dz) || (cur[BTN.RIGHT] ? 1 : 0) - (cur[BTN.LEFT] ? 1 : 0) || kbLx;
      const lyWheel = applyCalAxis(pad.axes[1], this.cal.offsets[1], dz) || (cur[BTN.DOWN] ? 1 : 0) - (cur[BTN.UP] ? 1 : 0) || kbLy;
      this.emitWheel({ type: 'STICK', lx: lxWheel, ly: lyWheel });
      for (let i = 0; i < 16; i++) this.prevButtons[i] = cur[i];
      return;
    }
    if (justReleased(BTN.L3)) {
      this.emitWheel({ type: 'CLOSE', commit: true });
      for (let i = 0; i < 16; i++) this.prevButtons[i] = cur[i];
      return;
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

    this.rawAxes = [pad.axes[0] || 0, pad.axes[1] || 0, pad.axes[2] || 0, pad.axes[3] || 0];
    const dz = this.cal.deadzone;
    const useVirtual = this.cal.stickMode === 'VIRTUAL' || (this.cal.stickMode === 'AUTO' && pad.axes.length < 2);
    const virtLx = useVirtual && l2 ? (cur[BTN.RIGHT] ? 1 : 0) - (cur[BTN.LEFT] ? 1 : 0) : 0;
    const virtLy = useVirtual && l2 ? (cur[BTN.DOWN] ? 1 : 0) - (cur[BTN.UP] ? 1 : 0) : 0;

    const lx = applyCalAxis(pad.axes[0], this.cal.offsets[0], dz) || virtLx || kbLx;
    const ly = applyCalAxis(pad.axes[1], this.cal.offsets[1], dz) || virtLy || kbLy;
    const rx = applyCalAxis(pad.axes[2], this.cal.offsets[2], dz) || kbRx;
    const ry = applyCalAxis(pad.axes[3], this.cal.offsets[3], dz) || kbRy;
    this.diagState.axes = [lx, ly, rx, ry];

    // R2 + Right Stick => Momentary Master Punch-In Performance FX (R2 + R3 holds!)
    if (r2) {
      if (justPressed(BTN.R3)) {
        engine.togglePunchHold();
      }
      if (rx !== 0 || ry !== 0 || this.r2PunchActive) {
        engine.setPunchFx(rx, ry);
        this.r2PunchActive = true;
      }
    } else if (this.r2PunchActive) {
      engine.setPunchFx(0, 0);
      this.r2PunchActive = false;
    }

    if (lx !== 0 || ly !== 0 || (!r2 && (rx !== 0 || ry !== 0))) {
      this.dispatch({ type: 'STICKS', lx, ly, rx: r2 ? 0 : rx, ry: r2 ? 0 : ry, fine: l2 });
    }

    for (let i = 0; i < 16; i++) this.prevButtons[i] = cur[i];
  }
}

export const input = new InputController();
