// Brickchord music theory, scale chords, smooth voice-leading & 8-way stick bends
// Ported and adapted from michaeltietjen/brickchord (MIT)

export const NOTE_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
export const FLAT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];

export const SCALES = {
  Major: [0, 2, 4, 5, 7, 9, 11],
  Minor: [0, 2, 3, 5, 7, 8, 10],
  Dorian: [0, 2, 3, 5, 7, 9, 10],
  Mixolydian: [0, 2, 4, 5, 7, 9, 10]
};

export const SCALE_NAMES = ['Major', 'Minor', 'Dorian', 'Mixolydian'];
export const SCALE_SHORT = ['MAJ', 'MIN', 'DOR', 'MIXO'];
export const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];
export const MOD_KEYS = ['flip', 'seventh', 'sus', 'ninth', 'sus2', 'dim', 'aug', 'maj7'];

const PARENT_MAJOR = {
  Major: 0,
  Minor: 3,
  Dorian: 10,
  Phrygian: 8,
  Lydian: 7,
  Mixolydian: 5,
  Locrian: 1
};

export const STICK_SECTORS = {
  0: 'ninth',
  1: 'maj7',
  2: 'seventh',
  3: 'sus2',
  4: 'sus',
  5: 'dim',
  6: 'flip',
  7: 'aug'
};

export const STICK_LABELS = {
  ninth: '9',
  maj7: 'MAJ7',
  seventh: '7',
  sus2: 'SUS2',
  sus: 'SUS4',
  dim: 'DIM',
  flip: 'FLIP',
  aug: 'AUG'
};

export const STRUM_PATTERNS = {
  FOLK: 'D.DU.UDU',
  POP: 'D.D.UDUd'
};

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

export function noteName(pc, key = null, scale = 'Major') {
  const idx = ((pc % 12) + 12) % 12;
  if (key !== null && key !== undefined) {
    const parent = (key + (PARENT_MAJOR[scale] ?? 0)) % 12;
    if (parent === 5 || parent === 10 || parent === 3 || parent === 8 || parent === 1 || parent === 6) {
      return FLAT_NAMES[idx];
    }
  }
  return NOTE_NAMES[idx];
}

export function chordName(pc, ivals, sus = false, sus2 = false, key = null, scale = 'Major') {
  const mod12 = new Set(ivals.map((i) => ((i % 12) + 12) % 12));
  const third = mod12.has(3) && !sus ? 3 : mod12.has(4) ? 4 : null;
  const fifth = mod12.has(6) ? 6 : mod12.has(8) ? 8 : 7;
  const has7 = mod12.has(10) || mod12.has(11);
  const maj7 = mod12.has(11);
  const has9 = mod12.has(2) && !sus2;
  const n = noteName(pc, key, scale);

  if (sus2) {
    return n + (maj7 ? 'maj7sus2' : has7 ? '7sus2' : 'sus2');
  }
  if (sus) {
    let q = has7 ? '7sus4' : 'sus4';
    if (has9) q = '9sus4';
    return n + q;
  }
  if (third === 4 && fifth === 8) {
    return n + (maj7 ? 'augMaj7' : has7 ? 'aug7' : 'aug');
  }
  if (third === 3 && fifth === 6) {
    return n + (has7 ? (maj7 ? 'mMaj7b5' : 'm7b5') : 'dim');
  }
  const base = third === 3 ? 'm' : '';
  if (has9) {
    if (base === '') return n + (maj7 ? 'maj9' : '9');
    return n + (maj7 ? 'mMaj9' : 'm9');
  }
  if (has7) {
    if (base === 'm') return n + (maj7 ? 'mMaj7' : 'm7');
    return n + (maj7 ? 'maj7' : '7');
  }
  return n + base;
}

export function romanFor(degree, ivals) {
  let r = ROMAN[degree % 7];
  const s = new Set(ivals.map((i) => ((i % 12) + 12) % 12));
  if (s.has(3) && !s.has(4)) r = r.toLowerCase();
  if (s.has(6) && !s.has(7)) r += '°';
  if (s.has(8) && !s.has(7)) r += '+';
  return r;
}

export function buildChord(key, scaleName, degree, mods = {}) {
  const sc = SCALES[scaleName] || SCALES.Minor;
  const tone = (i) => sc[(degree + i) % 7] + 12 * Math.floor((degree + i) / 7);

  const root = tone(0);
  let third = tone(2) - root;
  let fifth = tone(4) - root;
  let sev = tone(6) - root;

  if (mods.flip) {
    third = third === 4 ? 3 : 4;
    if (fifth === 6) fifth = 7;
    if (sev === 11 || third === 3) sev = 10;
  }
  if (mods.dim) {
    third = 3;
    fifth = 6;
    sev = 10;
  }
  if (mods.aug) {
    third = 4;
    fifth = 8;
  }
  if (mods.maj7) {
    sev = 11;
  }

  const ivals = [0, third, fifth];
  const sus = Boolean(mods.sus);
  const sus2 = Boolean(mods.sus2) && !sus;
  if (sus) ivals[1] = 5;
  else if (sus2) ivals[1] = 2;

  if (mods.seventh || mods.ninth || mods.maj7) ivals.push(sev);
  if (mods.ninth) ivals.push(14);

  const pcRoot = ((key + root) % 12 + 12) % 12;
  return {
    pcRoot,
    ivals,
    sus,
    sus2,
    name: chordName(pcRoot, ivals, sus, sus2, key, scaleName),
    roman: romanFor(degree, ivals)
  };
}

export function voiceChord(pcRoot, ivals, prevUpper = null, octave = 0, voicingMode = 0) {
  let bass = 36 + pcRoot;
  if (bass < 40) bass += 12;

  const center = prevUpper && prevUpper.length > 0
    ? prevUpper.reduce((a, b) => a + b, 0) / prevUpper.length
    : 64;

  const upperRaw = [];
  for (const iv of ivals) {
    const pc = ((pcRoot + iv) % 12 + 12) % 12;
    let best = pc + 60;
    let bestScore = Infinity;
    for (let o = 3; o <= 7; o++) {
      const m = pc + 12 * o;
      const d = Math.abs(m - center);
      if (d < bestScore || (d === bestScore && m < best)) {
        bestScore = d;
        best = m;
      }
    }
    best = clamp(best, 55, 79);
    if (!upperRaw.includes(best)) upperRaw.push(best);
  }
  upperRaw.sort((a, b) => a - b);

  const octShift = clamp(Math.round(octave), -1, 1) * 12;
  const shiftedBass = clamp(bass + octShift, 28, 72);
  const upper = upperRaw.map((m) => clamp(m + octShift, 43, 96));

  if (voicingMode === 1 && upper.length >= 3) {
    // OPEN spread: raise middle tone +12
    const mid = Math.floor(upper.length / 2);
    upper[mid] = clamp(upper[mid] + 12, 48, 100);
    upper.sort((a, b) => a - b);
  } else if (voicingMode === 2 && upper.length >= 3) {
    // DROP 2: drop second-highest tone -12
    const dropIdx = upper.length - 2;
    const dropped = upper[dropIdx] - 12;
    if (dropped > shiftedBass + 3) {
      upper[dropIdx] = dropped;
      upper.sort((a, b) => a - b);
    }
  }

  return {
    bass: shiftedBass,
    upperRaw,
    upper,
    notes: [shiftedBass, ...upper]
  };
}

export function stickSectorFromXY(lx, ly, deadzone = 0.36) {
  const mag = Math.hypot(lx, ly);
  if (mag < deadzone) return null;
  // Gamepad API Y axis: -1 is Up, +1 is Down -> negate ly for standard math angle
  const deg = (Math.atan2(-ly, lx) * 180) / Math.PI;
  const sector = ((Math.round(deg / 45) % 8) + 8) % 8;
  const mod = STICK_SECTORS[sector];
  return {
    sector,
    mod,
    label: STICK_LABELS[mod],
    mag: Math.min(1, mag)
  };
}
