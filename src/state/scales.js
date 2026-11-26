export const ROOT_NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export const SCALES = [
  { id: 'MIN', name: 'MINOR', intervals: [0, 2, 3, 5, 7, 8, 10] },
  { id: 'MAJ', name: 'MAJOR', intervals: [0, 2, 4, 5, 7, 9, 11] },
  { id: 'DOR', name: 'DORIAN', intervals: [0, 2, 3, 5, 7, 9, 10] },
  { id: 'PHR', name: 'PHRYGIAN', intervals: [0, 1, 3, 5, 7, 8, 10] },
  { id: 'LYD', name: 'LYDIAN', intervals: [0, 2, 4, 6, 7, 9, 11] },
  { id: 'MIX', name: 'MIXOLYDIAN', intervals: [0, 2, 4, 5, 7, 9, 10] },
  { id: 'LOC', name: 'LOCRIAN', intervals: [0, 1, 3, 5, 6, 8, 10] },
  { id: 'HMIN', name: 'HARM MIN', intervals: [0, 2, 3, 5, 7, 8, 11] },
  { id: 'MMIN', name: 'MEL MIN', intervals: [0, 2, 3, 5, 7, 9, 11] },
  { id: 'PENTA', name: 'MIN PENT', intervals: [0, 3, 5, 7, 10] },
  { id: 'BLUES', name: 'BLUES', intervals: [0, 3, 5, 6, 7, 10] },
  { id: 'HIRA', name: 'HIRAJOSHI', intervals: [0, 2, 3, 7, 8] },
  { id: 'WHOLE', name: 'WHOLE TONE', intervals: [0, 2, 4, 6, 8, 10] },
  { id: 'DIM', name: 'DIMINISHED', intervals: [0, 2, 3, 5, 6, 8, 9, 11] },
  { id: 'CHROM', name: 'CHROMATIC', intervals: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] }
];

export function getScale(scaleId) {
  return SCALES.find((s) => s.id === scaleId) || SCALES[0];
}

export function isMidiInScale(midi, rootIdx, scaleId) {
  const scale = getScale(scaleId);
  const pc = (((Math.round(midi) - rootIdx) % 12) + 12) % 12;
  return scale.intervals.includes(pc);
}

export function snapMidiToScale(midi, rootIdx, scaleId) {
  const m = Math.round(midi);
  if (isMidiInScale(m, rootIdx, scaleId)) return m;
  for (let d = 1; d <= 6; d++) {
    if (isMidiInScale(m + d, rootIdx, scaleId)) return m + d;
    if (isMidiInScale(m - d, rootIdx, scaleId)) return m - d;
  }
  return m;
}

export function midiToName(midi) {
  const m = Math.round(midi);
  const note = ROOT_NOTES[((m % 12) + 12) % 12];
  const oct = Math.floor(m / 12) - 1;
  return `${note}${oct}`;
}

export function getScaleNotesInRange(rootIdx, scaleId, minMidi, maxMidi) {
  const out = [];
  for (let m = minMidi; m <= maxMidi; m++) {
    if (isMidiInScale(m, rootIdx, scaleId)) out.push(m);
  }
  return out;
}

export function euclidean(steps, hits, rotation = 0) {
  const s = Math.max(1, Math.min(64, Math.round(steps)));
  const h = Math.max(0, Math.min(s, Math.round(hits)));
  if (h === 0) return new Array(s).fill(0);
  if (h === s) return new Array(s).fill(1);

  let pattern = [];
  let counts = [];
  let remainders = [];
  let divisor = s - h;
  remainders.push(h);
  let level = 0;

  while (true) {
    counts.push(Math.floor(divisor / remainders[level]));
    remainders.push(divisor % remainders[level]);
    divisor = remainders[level];
    level++;
    if (remainders[level] <= 1) break;
  }
  counts.push(divisor);

  function build(lvl) {
    if (lvl === -1) {
      pattern.push(0);
    } else if (lvl === -2) {
      pattern.push(1);
    } else {
      for (let i = 0; i < counts[lvl]; i++) build(lvl - 1);
      if (remainders[lvl] !== 0) build(lvl - 2);
    }
  }
  build(level);

  const firstOne = pattern.indexOf(1);
  if (firstOne > 0) {
    pattern = pattern.slice(firstOne).concat(pattern.slice(0, firstOne));
  }
  const rot = ((Math.round(rotation) % s) + s) % s;
  if (rot !== 0) {
    pattern = pattern.slice(s - rot).concat(pattern.slice(0, s - rot));
  }
  return pattern;
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function generateRiff(opts) {
  const {
    rootIdx = 6,
    scaleId = 'MIN',
    mode = 'ACID',
    baseOctave = 2,
    octaveSpread = 2,
    lengthSteps = 16,
    euclidSteps = 16,
    euclidHits = 9,
    euclidRot = 0,
    density = 85,
    velJitter = 25,
    slidePct = 20,
    seed = Math.floor(Math.random() * 99999),
    prevNotes = [],
    mutate = false,
    isDrum = false
  } = opts;

  const rng = mulberry32(seed);
  const scalePool = isDrum
    ? [48, 49, 50, 51, 52, 53, 54, 55]
    : getScaleNotesInRange(
        rootIdx,
        scaleId,
        (baseOctave + 1) * 12,
        (baseOctave + 1 + Math.max(1, octaveSpread)) * 12 - 1
      );

  if (mutate && prevNotes.length > 0) {
    const next = prevNotes.map((n) => {
      const clone = { ...n };
      if (rng() < 0.2) {
        if (rng() < 0.5 && scalePool.length > 0) {
          clone.midi = scalePool[Math.floor(rng() * scalePool.length)];
        } else {
          clone.vel = Math.max(25, Math.min(127, Math.round(clone.vel + (rng() - 0.5) * 40)));
        }
        if (!isDrum && rng() < 0.35) clone.slide = !clone.slide;
      }
      return clone;
    });
    return { notes: next, seed };
  }

  const pulse = euclidean(euclidSteps, euclidHits, euclidRot);
  const notes = [];
  let cursorIdx = Math.floor(scalePool.length * 0.25);

  for (let step = 0; step < lengthSteps; step++) {
    const pBit = pulse[step % pulse.length];
    if (!pBit) continue;
    if (rng() * 100 > density) continue;

    let midi;
    if (isDrum) {
      const idx = step % 4 === 0 ? 0 : step % 4 === 2 ? 1 : Math.floor(rng() * 6) + 2;
      midi = 48 + idx;
    } else if (mode === 'ARP') {
      cursorIdx = (cursorIdx + 1) % scalePool.length;
      midi = scalePool[cursorIdx];
    } else if (mode === 'WALK') {
      const delta = Math.floor(rng() * 5) - 2;
      cursorIdx = Math.max(0, Math.min(scalePool.length - 1, cursorIdx + delta));
      midi = scalePool[cursorIdx];
    } else if (mode === 'CHORD') {
      const rootPos = Math.floor(rng() * Math.max(1, scalePool.length - 4));
      const chordOffsets = [0, 2, 4];
      for (const off of chordOffsets) {
        const m = scalePool[Math.min(scalePool.length - 1, rootPos + off)];
        notes.push({
          id: `n_${step}_${m}_${Math.floor(rng() * 1e6)}`,
          step,
          len: Math.min(4, lengthSteps - step),
          midi: m,
          vel: Math.max(30, Math.min(127, Math.round(96 + (rng() - 0.5) * velJitter * 1.2))),
          prob: 100,
          slide: false,
          cutoff: 0
        });
      }
      continue;
    } else {
      // ACID
      if (step % 4 === 0) {
        cursorIdx = Math.floor(rng() * Math.min(4, scalePool.length));
      } else {
        cursorIdx = Math.floor(rng() * scalePool.length);
      }
      midi = scalePool[cursorIdx];
    }

    const len = isDrum ? 1 : mode === 'ACID' && rng() < 0.28 ? 2 : 1;
    const baseVel = step % 4 === 0 ? 114 : 92;
    const vel = Math.max(25, Math.min(127, Math.round(baseVel + (rng() - 0.5) * velJitter * 1.4)));
    const slide = !isDrum && rng() * 100 < slidePct;
    const cutoff = Number(((rng() - 0.5) * 0.6).toFixed(2));

    notes.push({
      id: `n_${step}_${midi}_${Math.floor(rng() * 1e6)}`,
      step,
      len: Math.min(len, lengthSteps - step),
      midi,
      vel,
      prob: 100,
      slide,
      cutoff
    });
  }

  return { notes, seed };
}
