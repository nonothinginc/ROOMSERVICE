function makeDriveCurve(amount = 0) {
  const n = 256;
  const curve = new Float32Array(n);
  const k = 1 + amount * 18;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = ((1 + k) * x) / (1 + k * Math.abs(x));
  }
  return curve;
}

const CRUSH_CURVES = Array.from({ length: 6 }, (_, i) => makeDriveCurve(i / 5));

export function createPunchFx(Tone) {
  const rawCtx = Tone.getContext().rawContext;
  const input = new Tone.Gain(1);
  const output = new Tone.Gain(1);

  const lpf = rawCtx.createBiquadFilter();
  lpf.type = 'lowpass';
  lpf.frequency.value = 18000;
  lpf.Q.value = 0.8;

  const hpf = rawCtx.createBiquadFilter();
  hpf.type = 'highpass';
  hpf.frequency.value = 20;
  hpf.Q.value = 0.8;

  const shaper = rawCtx.createWaveShaper();
  shaper.oversample = '2x';
  shaper.curve = CRUSH_CURVES[0];

  const dryGain = rawCtx.createGain();
  dryGain.gain.value = 1;

  const delay = rawCtx.createDelay(1.0);
  delay.delayTime.value = 0.1875;
  const dlyFb = rawCtx.createGain();
  dlyFb.gain.value = 0;
  const dlyWet = rawCtx.createGain();
  dlyWet.gain.value = 0;

  const crushDry = rawCtx.createGain();
  crushDry.gain.value = 1;
  const crushWet = rawCtx.createGain();
  crushWet.gain.value = 0;

  const sum = rawCtx.createGain();
  sum.gain.value = 1;

  Tone.connect(input, lpf);
  lpf.connect(hpf);

  // Split 1: Clean filter output + bit/tape crunch blend
  hpf.connect(crushDry);
  hpf.connect(shaper);
  shaper.connect(crushWet);
  crushDry.connect(dryGain);
  crushWet.connect(dryGain);
  dryGain.connect(sum);

  // Split 2: Dub stutter / wash delay
  hpf.connect(delay);
  delay.connect(dlyFb);
  dlyFb.connect(delay);
  delay.connect(dlyWet);
  dlyWet.connect(sum);

  Tone.connect(sum, output);

  let curX = 0;
  let curY = 0;
  let hold = false;

  function apply() {
    const now = rawCtx.currentTime;
    const mag = Math.hypot(curX, curY);
    if (mag < 0.08) {
      lpf.frequency.setTargetAtTime(18000, now, 0.02);
      lpf.Q.setTargetAtTime(0.8, now, 0.02);
      hpf.frequency.setTargetAtTime(20, now, 0.02);
      hpf.Q.setTargetAtTime(0.8, now, 0.02);
      dlyWet.gain.setTargetAtTime(0, now, 0.02);
      dlyFb.gain.setTargetAtTime(0, now, 0.02);
      crushWet.gain.setTargetAtTime(0, now, 0.02);
      crushDry.gain.setTargetAtTime(1, now, 0.02);
      return;
    }

    // X < 0 -> LPF sweep down, X > 0 -> HPF sweep up
    if (curX < -0.08) {
      const amt = Math.min(1, (-curX - 0.08) / 0.92);
      const cut = 18000 * Math.pow(240 / 18000, amt);
      lpf.frequency.setTargetAtTime(cut, now, 0.015);
      lpf.Q.setTargetAtTime(1 + amt * 5.5, now, 0.015);
      hpf.frequency.setTargetAtTime(20, now, 0.015);
      hpf.Q.setTargetAtTime(0.8, now, 0.015);
    } else if (curX > 0.08) {
      const amt = Math.min(1, (curX - 0.08) / 0.92);
      const cut = 20 * Math.pow(3800 / 20, amt);
      hpf.frequency.setTargetAtTime(cut, now, 0.015);
      hpf.Q.setTargetAtTime(1 + amt * 5.5, now, 0.015);
      lpf.frequency.setTargetAtTime(18000, now, 0.015);
      lpf.Q.setTargetAtTime(0.8, now, 0.015);
    } else {
      lpf.frequency.setTargetAtTime(18000, now, 0.02);
      hpf.frequency.setTargetAtTime(20, now, 0.02);
      lpf.Q.setTargetAtTime(0.8, now, 0.02);
      hpf.Q.setTargetAtTime(0.8, now, 0.02);
    }

    // Y < 0 (UP) -> Tempo-synced Dub Stutter / Echo Wash
    if (curY < -0.08) {
      const amt = Math.min(1, (-curY - 0.08) / 0.92);
      let bpm = 124;
      try {
        bpm = Math.max(40, Math.min(240, Tone.getTransport().bpm.value || 124));
      } catch {
        bpm = 124;
      }
      const dlySec = amt > 0.65 ? (60 / bpm) / 4 : (60 / bpm) * 0.75;
      delay.delayTime.setTargetAtTime(Math.max(0.03, Math.min(0.9, dlySec)), now, 0.025);
      dlyWet.gain.setTargetAtTime(amt * 0.85, now, 0.02);
      dlyFb.gain.setTargetAtTime(0.22 + amt * 0.58, now, 0.02);
    } else {
      dlyWet.gain.setTargetAtTime(0, now, 0.025);
      dlyFb.gain.setTargetAtTime(0, now, 0.025);
    }

    // Y > 0 (DOWN) -> Asymmetric Tape Crush + Warmth
    if (curY > 0.08) {
      const amt = Math.min(1, (curY - 0.08) / 0.92);
      const idx = Math.min(CRUSH_CURVES.length - 1, Math.max(1, Math.round(amt * (CRUSH_CURVES.length - 1))));
      shaper.curve = CRUSH_CURVES[idx];
      crushWet.gain.setTargetAtTime(amt * 0.9, now, 0.018);
      crushDry.gain.setTargetAtTime(1 - amt * 0.72, now, 0.018);
      if (curX >= -0.08) {
        lpf.frequency.setTargetAtTime(18000 - amt * 13500, now, 0.02);
      }
    } else {
      crushWet.gain.setTargetAtTime(0, now, 0.02);
      crushDry.gain.setTargetAtTime(1, now, 0.02);
    }
  }

  function setXY(x, y, forceHold = null) {
    if (typeof forceHold === 'boolean') hold = forceHold;
    if (hold && forceHold === null) return getState();
    curX = Math.max(-1, Math.min(1, x || 0));
    curY = Math.max(-1, Math.min(1, y || 0));
    apply();
    return getState();
  }

  function toggleHold() {
    hold = !hold;
    if (!hold && Math.hypot(curX, curY) < 0.08) {
      apply();
    }
    return hold;
  }

  function getState() {
    const active = Math.hypot(curX, curY) >= 0.08;
    let label = 'BYPASS';
    if (active) {
      if (Math.abs(curX) >= Math.abs(curY)) label = curX < 0 ? 'LPF SWEEP' : 'HPF SWEEP';
      else label = curY < 0 ? 'DUB ECHO' : 'CRUSH';
    }
    return { x: curX, y: curY, hold, active, label };
  }

  function dispose() {
    try {
      lpf.disconnect();
      hpf.disconnect();
      shaper.disconnect();
      delay.disconnect();
      dlyFb.disconnect();
      dlyWet.disconnect();
      dryGain.disconnect();
      crushDry.disconnect();
      crushWet.disconnect();
      sum.disconnect();
      input.dispose();
      output.dispose();
    } catch {
      // ignore
    }
  }

  return { input, output, setXY, toggleHold, getState, dispose };
}
