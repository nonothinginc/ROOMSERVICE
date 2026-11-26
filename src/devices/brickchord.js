import {
  SCALE_NAMES,
  STRUM_PATTERNS,
  buildChord,
  voiceChord
} from '../audio/brickchord-theory.js';

export const PATCH_NAMES = ['JUNO', 'BRASS', 'PWM', 'PLUCK', 'FM', 'ORGAN'];
export const STYLE_NAMES = ['CHORD', 'FOLK', 'POP', 'HARP', 'ARP', 'REP'];
// Compact labels for the 256px DSP card segmented bars (full names stay in the CHORD deck)
const PATCH_SHORT = ['JNO', 'BRS', 'PWM', 'PLK', 'FM', 'ORG'];
const STYLE_SHORT = ['CHD', 'FLK', 'POP', 'HRP', 'ARP', 'REP'];

export const meta = {
  id: 'brickchord',
  name: 'BRICKCHORD',
  category: 'instrument',
  visualizer: 'brickchord',
  params: [
    {
      id: 'patch',
      label: 'PATCH',
      control: 'segmented',
      options: PATCH_SHORT,
      min: 0,
      max: 5,
      default: 0,
      step: 1,
      unit: ''
    },
    {
      id: 'style',
      label: 'STYLE',
      control: 'segmented',
      options: STYLE_SHORT,
      min: 0,
      max: 5,
      default: 0,
      step: 1,
      unit: ''
    },
    { id: 'cutoff', label: 'CUT', min: 180, max: 12000, default: 2400, step: 10, unit: 'Hz', curve: 'exp' },
    { id: 'res', label: 'RES', min: 0.5, max: 14, default: 1.8, step: 0.1, unit: 'Q' },
    { id: 'wet', label: 'WET', min: 0, max: 100, default: 28, step: 1, unit: '%' },
    { id: 'bass', label: 'BASS', min: 0, max: 100, default: 65, step: 1, unit: '%' }
  ],
  extendedParams: [
    { id: 'key', label: 'KEY', min: 0, max: 11, default: 0, step: 1, unit: '' },
    { id: 'scale', label: 'SCALE', min: 0, max: 3, default: 1, step: 1, unit: '' },
    { id: 'octave', label: 'OCT', min: -1, max: 1, default: 0, step: 1, unit: '' },
    { id: 'release', label: 'REL', min: 0.08, max: 2.4, default: 0.75, step: 0.02, unit: 's' },
    { id: 'detune', label: 'DET', min: 0, max: 35, default: 10, step: 1, unit: 'ct' },
    { id: 'strumMs', label: 'STRUM', min: 8, max: 65, default: 24, step: 1, unit: 'ms' },
    { id: 'arpOct', label: 'ARP OCT', min: 1, max: 3, default: 1, step: 1, unit: '' },
    { id: 'voicing', label: 'VOICE', min: 0, max: 2, default: 0, step: 1, unit: '' }
  ]
};

const REVERB_IR_CACHE = new WeakMap();

function getSharedReverbIR(rawCtx) {
  if (!rawCtx) return null;
  if (REVERB_IR_CACHE.has(rawCtx)) return REVERB_IR_CACHE.get(rawCtx);
  try {
    const sr = rawCtx.sampleRate || 44100;
    const len = Math.floor(sr * 1.65);
    const buf = rawCtx.createBuffer(2, len, sr);
    let lpL = 0;
    let lpR = 0;
    for (let c = 0; c < 2; c++) {
      const ch = buf.getChannelData(c);
      for (let i = 0; i < len; i++) {
        const t = i / len;
        const env = Math.pow(1 - t, 2.7) * (i < 96 ? i / 96 : 1);
        const n = Math.random() * 2 - 1;
        if (c === 0) {
          lpL = lpL * 0.62 + n * 0.38;
          ch[i] = lpL * env * 0.42;
        } else {
          lpR = lpR * 0.62 + n * 0.38;
          ch[i] = lpR * env * 0.42;
        }
      }
    }
    REVERB_IR_CACHE.set(rawCtx, buf);
    return buf;
  } catch {
    return null;
  }
}

function midiToFreq(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

export function createNode(Tone) {
  const rawCtx = Tone.getContext().rawContext;
  const input = new Tone.Gain(1);
  const output = new Tone.Gain(0.85);

  // Main synth summing -> resonant lowpass -> dry / wet split -> outSum
  const chordSum = rawCtx.createGain();
  chordSum.gain.value = 0.85;

  const bassSum = rawCtx.createGain();
  bassSum.gain.value = 0.65;
  const bassLp = rawCtx.createBiquadFilter();
  bassLp.type = 'lowpass';
  bassLp.frequency.value = 340;
  bassLp.Q.value = 1.1;

  const mainFilter = rawCtx.createBiquadFilter();
  mainFilter.type = 'lowpass';
  mainFilter.frequency.value = 2400;
  mainFilter.Q.value = 1.8;

  const dryGain = rawCtx.createGain();
  dryGain.gain.value = 0.82;

  const wetSend = rawCtx.createGain();
  wetSend.gain.value = 1.0;

  const wetGain = rawCtx.createGain();
  wetGain.gain.value = 0.28;

  // Stereo ping-pong delay + lush convolution reverb
  const dlyL = rawCtx.createDelay(1.0);
  const dlyR = rawCtx.createDelay(1.0);
  dlyL.delayTime.value = 0.24;
  dlyR.delayTime.value = 0.36;
  const dlyFbL = rawCtx.createGain();
  const dlyFbR = rawCtx.createGain();
  dlyFbL.gain.value = 0.32;
  dlyFbR.gain.value = 0.32;
  const dlyMerge = rawCtx.createChannelMerger(2);
  const dlyLevel = rawCtx.createGain();
  dlyLevel.gain.value = 0.42;

  wetSend.connect(dlyL);
  dlyL.connect(dlyFbL);
  dlyFbL.connect(dlyR);
  dlyR.connect(dlyFbR);
  dlyFbR.connect(dlyL);
  dlyL.connect(dlyMerge, 0, 0);
  dlyR.connect(dlyMerge, 0, 1);
  dlyMerge.connect(dlyLevel);
  dlyLevel.connect(wetGain);

  let convolver = null;
  const revLevel = rawCtx.createGain();
  revLevel.gain.value = 0.72;
  const ir = getSharedReverbIR(rawCtx);
  if (ir && rawCtx.createConvolver) {
    try {
      convolver = rawCtx.createConvolver();
      convolver.buffer = ir;
      wetSend.connect(convolver);
      convolver.connect(revLevel);
      revLevel.connect(wetGain);
    } catch {
      convolver = null;
    }
  }

  const outSum = rawCtx.createGain();
  outSum.gain.value = 0.92;
  const scopeAnalyser = rawCtx.createAnalyser();
  scopeAnalyser.fftSize = 256;
  scopeAnalyser.smoothingTimeConstant = 0.55;
  const scopeBuf = new Float32Array(256);

  chordSum.connect(mainFilter);
  mainFilter.connect(dryGain);
  mainFilter.connect(wetSend);
  dryGain.connect(outSum);
  wetGain.connect(outSum);

  bassSum.connect(bassLp);
  bassLp.connect(outSum);

  outSum.connect(scopeAnalyser);
  Tone.connect(outSum, output);

  const state = {
    patch: 0,
    style: 0,
    cutoff: 2400,
    res: 1.8,
    wet: 28,
    bass: 65,
    key: 0,
    scale: 1,
    octave: 0,
    release: 0.75,
    detune: 10,
    strumMs: 24,
    arpOct: 1,
    voicing: 0
  };

  let stickRx = 0;
  let stickRy = 0;
  let fxHold = false;
  let latch = false;

  let prevUpper = null;
  let held = false;
  let curDegree = null;
  let curMods = {};
  let curBendMod = null;
  let curChordInfo = null;
  let curVoiced = null;
  let lastChord = null;
  let activeVoices = [];
  let activeBassVoice = null;
  let patternTimer = null;
  let patternStep = 0;
  let arpDir = 1;
  let arpIdx = 0;
  let lastMonotonicTime = -1;

  function safeTime(t) {
    const now = rawCtx.currentTime;
    const base = typeof t === 'number' && Number.isFinite(t) ? t : now;
    const res = Math.max(base, now, lastMonotonicTime + 0.0002);
    lastMonotonicTime = res;
    return res;
  }

  function applyFilterAndWet(now = rawCtx.currentTime) {
    const effCut = clamp(state.cutoff * Math.pow(2, stickRx * 2.5), 140, 15000);
    // Up (-1) opens wet & softens Q; Down (+1) dries wet & tightens Q
    const wetOffset = -stickRy * 52;
    const effWet = clamp(state.wet + wetOffset, 0, 100) / 100;
    const effRes = clamp(state.res + Math.max(0, stickRy) * 5.2, 0.5, 16);

    mainFilter.frequency.setTargetAtTime(effCut, now, 0.018);
    mainFilter.Q.setTargetAtTime(effRes, now, 0.02);
    wetGain.gain.setTargetAtTime(effWet * 1.15, now, 0.025);
    dryGain.gain.setTargetAtTime(1 - effWet * 0.35, now, 0.025);
    bassSum.gain.setTargetAtTime((state.bass / 100) * 0.85, now, 0.02);
  }

  function getPatchSpec(patchIdx) {
    const det = state.detune;
    switch (Math.round(patchIdx)) {
      case 1: // BRASS
        return {
          oscs: [
            { type: 'sawtooth', det: -det * 0.7, oct: 0, lvl: 0.45 },
            { type: 'sawtooth', det: det * 0.7, oct: 0, lvl: 0.45 }
          ],
          a: 0.045,
          d: 0.35,
          s: 0.72,
          fMult: 3.4,
          fd: 0.42
        };
      case 2: // PWM SHIMMER
        return {
          oscs: [
            { type: 'square', det: -det * 1.25, oct: 0, lvl: 0.34 },
            { type: 'sawtooth', det: det * 1.25, oct: 0, lvl: 0.34 },
            { type: 'triangle', det: 0, oct: 1, lvl: 0.22 }
          ],
          a: 0.24,
          d: 0.7,
          s: 0.84,
          fMult: 1.9,
          fd: 0.9
        };
      case 3: // PLUCK
        return {
          oscs: [
            { type: 'triangle', det: -det * 0.3, oct: 0, lvl: 0.5 },
            { type: 'sawtooth', det: det * 0.4, oct: 0, lvl: 0.38 }
          ],
          a: 0.004,
          d: 0.38,
          s: 0.06,
          fMult: 4.5,
          fd: 0.22
        };
      case 4: // FM KEYS
        return {
          fm: true,
          ratio: 2.0,
          modIdx: 3.2,
          a: 0.005,
          d: 0.65,
          s: 0.28
        };
      case 5: // ORGAN
        return {
          oscs: [
            { type: 'sine', det: 0, oct: -1, lvl: 0.34 },
            { type: 'sine', det: 0, oct: 0, lvl: 0.44 },
            { type: 'sine', det: 2, oct: 1, lvl: 0.24 },
            { type: 'triangle', det: -2, oct: 0, lvl: 0.22 }
          ],
          a: 0.012,
          d: 0.15,
          s: 0.92,
          fMult: 1.4,
          fd: 0.25
        };
      case 0:
      default: // JUNO PAD
        return {
          oscs: [
            { type: 'sawtooth', det: -det, oct: 0, lvl: 0.38 },
            { type: 'sawtooth', det: det, oct: 0, lvl: 0.38 },
            { type: 'square', det: 0, oct: -1, lvl: 0.22 }
          ],
          a: 0.09,
          d: 0.65,
          s: 0.78,
          fMult: 2.5,
          fd: 0.85
        };
    }
  }

  function spawnVoice(midi, startTime, durSec = null, vel = 0.82, patchOverride = null) {
    const spec = getPatchSpec(patchOverride ?? state.patch);
    const baseFreq = midiToFreq(midi);
    const vGain = rawCtx.createGain();
    const peak = clamp(vel, 0.05, 1) * 0.24;

    vGain.gain.setValueAtTime(0.0001, startTime);
    vGain.gain.linearRampToValueAtTime(peak, startTime + Math.max(0.003, spec.a || 0.01));
    const sustainLevel = Math.max(0.0001, peak * (spec.s ?? 0.75));
    vGain.gain.exponentialRampToValueAtTime(sustainLevel, startTime + Math.max(0.02, (spec.a || 0.01) + (spec.d || 0.4)));

    const oscs = [];
    let voiceFilter = null;

    if (spec.fm) {
      const car = rawCtx.createOscillator();
      car.type = 'sine';
      car.frequency.setValueAtTime(baseFreq, startTime);

      const mod = rawCtx.createOscillator();
      mod.type = 'sine';
      mod.frequency.setValueAtTime(baseFreq * (spec.ratio || 2), startTime);

      const modGain = rawCtx.createGain();
      const depth = baseFreq * (spec.modIdx || 3.0) * (0.4 + vel * 0.6);
      modGain.gain.setValueAtTime(depth, startTime);
      modGain.gain.exponentialRampToValueAtTime(Math.max(1, depth * 0.12), startTime + 0.45);

      mod.connect(modGain);
      modGain.connect(car.frequency);
      car.connect(vGain);
      car.start(startTime);
      mod.start(startTime);
      oscs.push(car, mod);
    } else {
      voiceFilter = rawCtx.createBiquadFilter();
      voiceFilter.type = 'lowpass';
      const fBase = clamp(state.cutoff * 1.15, 320, 12000);
      const fPeak = clamp(fBase * (spec.fMult || 2.0), 400, 14000);
      voiceFilter.frequency.setValueAtTime(fPeak, startTime);
      voiceFilter.frequency.exponentialRampToValueAtTime(fBase, startTime + (spec.fd || 0.45));
      voiceFilter.Q.value = 0.9;

      for (const o of spec.oscs) {
        const osc = rawCtx.createOscillator();
        osc.type = o.type;
        osc.frequency.setValueAtTime(baseFreq * Math.pow(2, o.oct || 0), startTime);
        if (o.det) osc.detune.setValueAtTime(o.det, startTime);
        const og = rawCtx.createGain();
        og.gain.value = o.lvl;
        osc.connect(og);
        og.connect(voiceFilter);
        osc.start(startTime);
        oscs.push(osc);
      }
      voiceFilter.connect(vGain);
    }

    vGain.connect(chordSum);

    let stopped = false;
    const stopAt = (relTime, quick = false) => {
      if (stopped) return;
      stopped = true;
      const t = Math.max(rawCtx.currentTime, relTime);
      const rel = quick ? 0.045 : Math.max(0.05, state.release);
      try {
        vGain.gain.cancelScheduledValues(t);
        vGain.gain.setValueAtTime(Math.max(0.0001, vGain.gain.value || peak * 0.5), t);
        vGain.gain.exponentialRampToValueAtTime(0.0001, t + rel);
        const killAt = t + rel + 0.03;
        for (const osc of oscs) osc.stop(killAt);
        setTimeout(() => {
          try {
            vGain.disconnect();
            voiceFilter?.disconnect();
          } catch {
            // ignore
          }
        }, Math.ceil((killAt - rawCtx.currentTime + 0.05) * 1000));
      } catch {
        // ignore
      }
    };

    if (durSec != null && Number.isFinite(durSec)) {
      stopAt(startTime + Math.max(0.04, durSec), false);
    }

    return { midi, stopAt };
  }

  function spawnBass(midi, startTime, durSec = null, vel = 0.85) {
    if (state.bass <= 1) return null;
    const freq = midiToFreq(midi);
    const bGain = rawCtx.createGain();
    const peak = clamp(vel, 0.1, 1) * 0.42;

    bGain.gain.setValueAtTime(0.0001, startTime);
    bGain.gain.linearRampToValueAtTime(peak, startTime + 0.008);
    bGain.gain.exponentialRampToValueAtTime(peak * 0.78, startTime + 0.18);

    const tri = rawCtx.createOscillator();
    tri.type = 'triangle';
    tri.frequency.setValueAtTime(freq, startTime);

    const sub = rawCtx.createOscillator();
    sub.type = 'sine';
    sub.frequency.setValueAtTime(freq * 0.5, startTime);

    const subG = rawCtx.createGain();
    subG.gain.value = 0.55;

    tri.connect(bGain);
    sub.connect(subG);
    subG.connect(bGain);
    bGain.connect(bassSum);

    tri.start(startTime);
    sub.start(startTime);

    let stopped = false;
    const stopAt = (relTime, quick = false) => {
      if (stopped) return;
      stopped = true;
      const t = Math.max(rawCtx.currentTime, relTime);
      const rel = quick ? 0.04 : Math.max(0.05, Math.min(0.6, state.release));
      try {
        bGain.gain.cancelScheduledValues(t);
        bGain.gain.setValueAtTime(Math.max(0.0001, bGain.gain.value || peak * 0.5), t);
        bGain.gain.exponentialRampToValueAtTime(0.0001, t + rel);
        const killAt = t + rel + 0.03;
        tri.stop(killAt);
        sub.stop(killAt);
        setTimeout(() => {
          try {
            bGain.disconnect();
          } catch {
            // ignore
          }
        }, Math.ceil((killAt - rawCtx.currentTime + 0.05) * 1000));
      } catch {
        // ignore
      }
    };

    if (durSec != null && Number.isFinite(durSec)) {
      stopAt(startTime + Math.max(0.04, durSec), false);
    }

    return { midi, stopAt };
  }

  function releaseHeldVoices(quick = false) {
    const now = rawCtx.currentTime;
    for (const v of activeVoices) v.stopAt(now, quick);
    activeVoices = [];
    if (activeBassVoice) {
      activeBassVoice.stopAt(now, quick);
      activeBassVoice = null;
    }
  }

  function clearPatternTimer() {
    if (patternTimer != null) {
      clearInterval(patternTimer);
      patternTimer = null;
    }
  }

  function mergeMods(baseMods = {}, bendMod = null) {
    const m = { ...baseMods };
    if (bendMod) m[bendMod] = true;
    return m;
  }

  function getBpm() {
    try {
      return clamp(Tone.getTransport().bpm.value || 120, 40, 240);
    } catch {
      return 120;
    }
  }

  function strumNotes(notes, dirDown = true, vel = 0.82, gateSec = 0.35) {
    const now = rawCtx.currentTime;
    const ordered = dirDown ? [...notes] : [...notes].reverse();
    const dt = (state.strumMs || 24) / 1000;
    ordered.forEach((m, i) => {
      const t = now + i * dt;
      activeVoices.push(spawnVoice(m, t, gateSec, vel));
    });
  }

  function startStylePerformance(vel = 0.85) {
    clearPatternTimer();
    releaseHeldVoices(true);
    if (!curVoiced) return;

    const styleIdx = Math.round(state.style);
    const now = rawCtx.currentTime;
    const upper = curVoiced.upper;
    const bass = curVoiced.bass;

    if (bass != null) {
      activeBassVoice = spawnBass(bass, now, styleIdx === 0 ? null : 0.4, vel);
    }

    if (styleIdx === 0) {
      // CHORD
      upper.forEach((m, idx) => {
        activeVoices.push(spawnVoice(m, now + idx * 0.005, null, vel));
      });
      return;
    }

    const bpm = getBpm();
    const eighthMs = ((60 / bpm) / 2) * 1000;
    const sixteenthMs = eighthMs / 2;
    patternStep = 0;
    arpDir = 1;
    arpIdx = 0;

    if (styleIdx === 1 || styleIdx === 2) {
      // FOLK / POP 8th-note strum patterns
      const pat = styleIdx === 1 ? STRUM_PATTERNS.FOLK : STRUM_PATTERNS.POP;
      const runStrumStep = () => {
        if (!curVoiced || (!held && !latch)) return;
        const ch = pat[patternStep % pat.length];
        patternStep++;
        if (ch === '.') return;
        const isDown = ch === 'D' || ch === 'd';
        const vScale = ch === 'd' ? 0.62 : 0.92;
        if (patternStep === 1 && curVoiced.bass != null) {
          activeBassVoice?.stopAt(rawCtx.currentTime, true);
          activeBassVoice = spawnBass(curVoiced.bass, rawCtx.currentTime, 0.38, vel * vScale);
        }
        strumNotes(curVoiced.upper, isDown, vel * vScale, (eighthMs / 1000) * 1.45);
      };
      runStrumStep();
      patternTimer = setInterval(runStrumStep, eighthMs);
      return;
    }

    if (styleIdx === 3) {
      // HARP (rolling upward cascades every 16th)
      const seq = [curVoiced.bass, ...upper, ...upper.map((n) => clamp(n + 12, 48, 102))];
      const runHarpStep = () => {
        if (!curVoiced || (!held && !latch)) return;
        const m = seq[patternStep % seq.length];
        patternStep++;
        activeVoices.push(spawnVoice(m, rawCtx.currentTime, (sixteenthMs / 1000) * 2.8, vel * 0.84));
      };
      runHarpStep();
      patternTimer = setInterval(runHarpStep, sixteenthMs);
      return;
    }

    if (styleIdx === 4) {
      // ARP (up-down across arpOct octaves)
      const buildArpNotes = () => {
        const out = [];
        const octs = clamp(Math.round(state.arpOct || 1), 1, 3);
        for (let o = 0; o < octs; o++) {
          for (const m of curVoiced.upper) out.push(clamp(m + o * 12, 43, 102));
        }
        return out.length ? out : [60];
      };
      const runArpStep = () => {
        if (!curVoiced || (!held && !latch)) return;
        const pool = buildArpNotes();
        if (arpIdx >= pool.length) {
          arpIdx = Math.max(0, pool.length - 2);
          arpDir = -1;
        } else if (arpIdx < 0) {
          arpIdx = Math.min(pool.length - 1, 1);
          arpDir = 1;
        }
        const m = pool[arpIdx] ?? pool[0];
        arpIdx += arpDir;
        if (patternStep % (pool.length * 2) === 0 && curVoiced.bass != null) {
          activeBassVoice?.stopAt(rawCtx.currentTime, true);
          activeBassVoice = spawnBass(curVoiced.bass, rawCtx.currentTime, 0.3, vel * 0.85);
        }
        patternStep++;
        activeVoices.push(spawnVoice(m, rawCtx.currentTime, (sixteenthMs / 1000) * 1.4, vel * 0.88));
      };
      runArpStep();
      patternTimer = setInterval(runArpStep, sixteenthMs);
      return;
    }

    // 5: REP (8th-note rhythmic pulse)
    const runRepStep = () => {
      if (!curVoiced || (!held && !latch)) return;
      const t = rawCtx.currentTime;
      const gate = (eighthMs / 1000) * 0.72;
      if (curVoiced.bass != null) {
        activeBassVoice?.stopAt(t, true);
        activeBassVoice = spawnBass(curVoiced.bass, t, gate, vel * 0.88);
      }
      curVoiced.upper.forEach((m, i) => {
        activeVoices.push(spawnVoice(m, t + i * 0.004, gate, vel * 0.82));
      });
    };
    runRepStep();
    patternTimer = setInterval(runRepStep, eighthMs);
  }

  function playChord(degree, mods = {}, bendMod = null, vel = 0.86) {
    held = true;
    curDegree = ((degree % 7) + 7) % 7;
    curMods = { ...mods };
    curBendMod = bendMod;
    const scaleName = SCALE_NAMES[Math.round(state.scale)] || 'Minor';
    const effMods = mergeMods(curMods, curBendMod);
    curChordInfo = buildChord(Math.round(state.key), scaleName, curDegree, effMods);
    curVoiced = voiceChord(
      curChordInfo.pcRoot,
      curChordInfo.ivals,
      prevUpper,
      state.octave,
      Math.round(state.voicing)
    );
    prevUpper = curVoiced.upperRaw;
    lastChord = {
      degree: curDegree,
      mods: { ...curMods },
      bendMod: curBendMod,
      name: curChordInfo.name,
      roman: curChordInfo.roman,
      notes: [...curVoiced.notes],
      bass: curVoiced.bass,
      upper: [...curVoiced.upper]
    };
    startStylePerformance(vel);
    return lastChord;
  }

  function revoiceChord(mods = null, bendMod = undefined) {
    if (mods != null) curMods = { ...mods };
    if (bendMod !== undefined) curBendMod = bendMod;
    if (curDegree == null || (!held && !latch)) return null;
    return playChord(curDegree, curMods, curBendMod, 0.84);
  }

  function releaseChord(force = false) {
    held = false;
    if (!force && latch) return;
    clearPatternTimer();
    releaseHeldVoices(false);
    if (force) {
      latch = false;
    }
  }

  function setLatch(on) {
    latch = Boolean(on);
    if (!latch && !held) {
      clearPatternTimer();
      releaseHeldVoices(false);
    }
    return latch;
  }

  function setFxStick(rx, ry, toggleHold = null) {
    if (toggleHold === 'toggle') {
      fxHold = !fxHold;
      return { rx: stickRx, ry: stickRy, fxHold };
    }
    if (typeof toggleHold === 'boolean') {
      fxHold = toggleHold;
    }
    if (!fxHold || typeof toggleHold === 'boolean') {
      stickRx = clamp(rx || 0, -1, 1);
      stickRy = clamp(ry || 0, -1, 1);
      applyFilterAndWet();
    }
    return { rx: stickRx, ry: stickRy, fxHold };
  }

  function setParam(id, value) {
    if (!(id in state)) return;
    state[id] = value;
    const now = rawCtx.currentTime;
    if (id === 'cutoff' || id === 'res' || id === 'wet' || id === 'bass') {
      applyFilterAndWet(now);
    } else if (id === 'style' && (held || latch) && curDegree != null) {
      startStylePerformance(0.84);
    } else if ((id === 'key' || id === 'scale' || id === 'octave' || id === 'voicing') && (held || latch) && curDegree != null) {
      playChord(curDegree, curMods, curBendMod, 0.84);
    }
  }

  function triggerNote(midi, durSec = 0.25, time, vel = 0.8) {
    const t = safeTime(time);
    if (midi < 48 && state.bass > 5) {
      spawnBass(midi, t, Math.max(0.05, durSec), vel);
    } else {
      spawnVoice(midi, t, Math.max(0.05, durSec), vel);
    }
  }

  function releaseAll() {
    latch = false;
    releaseChord(true);
  }

  function getScope() {
    scopeAnalyser.getFloatTimeDomainData(scopeBuf);
    return scopeBuf;
  }

  function getMeter() {
    const buf = getScope();
    let sq = 0;
    for (let i = 0; i < buf.length; i++) sq += buf[i] * buf[i];
    return Math.min(1, Math.sqrt(sq / buf.length) * 3.2);
  }

  function getLiveState() {
    const isSounding = held || latch;
    const scaleIdx = Math.round(state.scale);
    return {
      active: isSounding,
      held,
      latch,
      fxHold,
      rx: stickRx,
      ry: stickRy,
      degree: isSounding ? curDegree : lastChord?.degree ?? null,
      chordName: isSounding ? (curChordInfo?.name || '—') : (lastChord?.name || '—'),
      roman: isSounding ? (curChordInfo?.roman || '') : (lastChord?.roman || ''),
      notes: isSounding ? (curVoiced?.notes || []) : [],
      bass: isSounding ? curVoiced?.bass : null,
      upper: isSounding ? (curVoiced?.upper || []) : [],
      lastNotes: lastChord?.notes || [],
      bendMod: curBendMod,
      mods: { ...curMods },
      patchIdx: Math.round(state.patch),
      styleIdx: Math.round(state.style),
      key: Math.round(state.key),
      scaleIdx,
      scaleName: SCALE_NAMES[scaleIdx] || 'Minor',
      octave: Math.round(state.octave),
      voicing: Math.round(state.voicing),
      cutoff: state.cutoff,
      res: state.res,
      wet: state.wet,
      bassLvl: state.bass,
      scope: getScope()
    };
  }

  function getVisualizerData() {
    const live = getLiveState();
    return {
      type: 'brickchord',
      ...live
    };
  }

  function dispose() {
    clearPatternTimer();
    releaseHeldVoices(true);
    try {
      chordSum.disconnect();
      mainFilter.disconnect();
      dryGain.disconnect();
      wetSend.disconnect();
      wetGain.disconnect();
      dlyL.disconnect();
      dlyR.disconnect();
      dlyFbL.disconnect();
      dlyFbR.disconnect();
      dlyMerge.disconnect();
      dlyLevel.disconnect();
      convolver?.disconnect();
      revLevel.disconnect();
      bassSum.disconnect();
      bassLp.disconnect();
      outSum.disconnect();
      scopeAnalyser.disconnect();
      input.dispose();
      output.dispose();
    } catch {
      // ignore
    }
  }

  applyFilterAndWet();

  return {
    input,
    output,
    setParam,
    triggerNote,
    releaseAll,
    playChord,
    revoiceChord,
    releaseChord,
    setLatch,
    setFxStick,
    getLiveState,
    getVisualizerData,
    getMeter,
    dispose
  };
}
