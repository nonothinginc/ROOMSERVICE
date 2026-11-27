/**
 * Sample classification: path/name heuristics first (pack authors encode the truth there),
 * audio analysis second (tempo for unlabeled loops, root note for pitched one-shots).
 */
import { analyzeAudioBuffer } from '../audio/bpm-detector.js';

/** Library categories, in browser order. `kind` drives routing defaults. */
export const CATEGORIES = [
  { id: 'BREAK', label: 'BREAKS', kind: 'loop' },
  { id: 'LOOP', label: 'LOOPS', kind: 'loop' },
  { id: 'DRUM', label: 'DRUMS', kind: 'hit' },
  { id: 'BASS', label: 'BASS', kind: 'pitched' },
  { id: 'STAB', label: 'STABS', kind: 'pitched' },
  { id: 'LEAD', label: 'LEADS', kind: 'pitched' },
  { id: 'RIFF', label: 'RIFFS', kind: 'pitched' },
  { id: 'PAD', label: 'PADS', kind: 'pitched' },
  { id: 'STRING', label: 'STRINGS', kind: 'pitched' },
  { id: 'VOX', label: 'VOX', kind: 'pitched' },
  { id: 'FX', label: 'FX', kind: 'hit' },
  { id: 'OTHER', label: 'OTHER', kind: 'hit' }
];

// Ordered: first match wins. Tested against the lower-cased "folder/file" path.
const RULES = [
  ['VOX', /\b(vox|vocals?|voices?|acapellas?|shouts?|chants?|spoken|mc)\b/],
  ['RIFF', /\b(riffs?|arps|hits|brass|horns?|strums?)\b/],
  ['BREAK', /\b(break|breaks|amen|think|funky drummer|apache|breakbeat)\b/],
  ['FX', /\b(fx|sfx|risers?|sweeps?|impacts?|noise|uplifter|downlifter|reverse|siren)\b/],
  ['STAB', /\b(stab|stabs|hoover|rave)\b/],
  ['BASS', /\b(bass|sub|reese|808 bass)\b/],
  ['PAD', /\b(pad|pads|chord|chords|atmos|atmosphere)\b/],
  ['STRING', /\b(string|strings|violin|cello|orchestra)\b/],
  ['LEAD', /\b(lead|leads|synth|arp|pluck|bell|keys|piano)\b/],
  ['DRUM', /\b(kick|bd|snare|sd|clap|hat|hh|ch|oh|cymbal|crash|ride|tom|rim|perc|shaker|cowbell|clave|conga|bongo hit)\b/],
  ['LOOP', /\b(loop|loops|groove|beat|top|tops|bongo)\b/]
];

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export function midiToNote(midi) {
  if (midi == null) return '';
  return `${NOTE_NAMES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;
}

/** Natural sort key so "Loop 10" sorts after "Loop 9". */
export function naturalCompare(a, b) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

export function cleanName(fileName) {
  return fileName
    .replace(/\.[^.]+$/, '')
    // Camelot key suffix ("Angles Break - 4A"): the key is shown separately
    .replace(/\s*-\s*(1[0-2]|[1-9])[AB]$/i, '')
    .replace(/[_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Compact, still-unique label for clips/pads: drops tempo, abbreviates take words. */
export function shortLabel(name, max = 18) {
  return name
    .replace(/\s*-?\s*\d{2,3}(?:\.\d+)?\s*bpm\b/gi, '')
    .replace(/\s*-\s*(1[0-2]|[1-9])[AB]\s*$/i, '')
    .replace(/\b(version|loop|edit|take|var(?:iation)?)\s*(\d+)/gi, (m, w, n, off) => (off === 0 ? m : `${w[0]}${n}`))
    .replace(/\s+[-–]+\s+|\s+[-–]+|[-–]+\s+|_+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase()
    .slice(0, max)
    .trim();
}

function bpmFromPath(path) {
  const m = /(\d{2,3}(?:\.\d+)?)\s*-?\s*bpm/i.exec(path) || /bpm\s*-?\s*(\d{2,3})/i.exec(path);
  if (!m) return null;
  const v = Number(m[1]);
  return v >= 60 && v <= 200 ? v : null;
}

// Camelot wheel codes used by DJ tools ("8A" = A minor, "8B" = C major)
const CAMELOT_A = ['G#m', 'D#m', 'A#m', 'Fm', 'Cm', 'Gm', 'Dm', 'Am', 'Em', 'Bm', 'F#m', 'C#m'];
const CAMELOT_B = ['B', 'F#', 'C#', 'G#', 'D#', 'A#', 'F', 'C', 'G', 'D', 'A', 'E'];

function keyFromCamelot(name) {
  const m = /(?:^|[\s_\-(])(1[0-2]|[1-9])([AB])(?=$|[\s_\-).])/.exec(name);
  if (!m) return null;
  const i = Number(m[1]) - 1;
  return m[2] === 'A' ? CAMELOT_A[i] : CAMELOT_B[i];
}

function keyFromName(name) {
  // " Am ", "- F#m", "(C)", "_Gmin" — conservative: needs a separator on both sides
  const m = /(?:^|[\s_\-(])([A-G](?:#|b)?)(m|min|maj)?(?=$|[\s_\-)])/.exec(name);
  if (!m) return null;
  return `${m[1]}${m[2] && m[2] !== 'maj' ? 'm' : ''}`;
}

/**
 * Loops are cut to whole bars, so tempo = bars × 240 / duration for some bar count.
 * Pick the bar count whose tempo is most plausible: breaks favour 150–180 BPM (jungle / d&b),
 * otherwise the candidate nearest the transient detector's estimate (octave-folded).
 */
function tempoFromBars(duration, category, detected) {
  const cands = [0.5, 1, 2, 4, 8, 16]
    .map((bars) => ({ bars, bpm: (bars * 240) / duration }))
    .filter((c) => c.bpm >= 70 && c.bpm <= 190);
  if (!cands.length) return detected || null;
  if (category === 'BREAK') {
    const jungle = cands.filter((c) => c.bpm >= 150 && c.bpm <= 180 && c.bars >= 1);
    if (jungle.length) return Math.round(jungle[0].bpm * 10) / 10;
  }
  if (detected) {
    const dist = (c) => Math.min(...[detected / 2, detected, detected * 2].map((d) => Math.abs(Math.log2(c.bpm / d))));
    cands.sort((a, b) => dist(a) - dist(b) || (a.bars >= 1 ? -1 : 1));
  }
  return Math.round(cands[0].bpm * 10) / 10;
}

/** Nearest musically sane loop length in beats for a duration at a tempo. */
function snapBeats(durationSec, bpm) {
  const raw = (durationSec * bpm) / 60;
  const candidates = [1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 64];
  let best = Math.max(1, Math.round(raw));
  let err = Infinity;
  for (const c of candidates) {
    const e = Math.abs(c - raw) / c;
    if (e < err) {
      err = e;
      best = c;
    }
  }
  return err < 0.08 ? best : Math.max(1, Math.round(raw));
}

/**
 * Autocorrelation pitch estimate on the loudest 4096-sample window.
 * Returns a MIDI note or null when the signal is not clearly periodic.
 */
export function detectRootMidi(buffer) {
  const sr = buffer.sampleRate;
  const ch = buffer.getChannelData(0);
  const N = 4096;
  if (ch.length < N * 2) return null;
  // Skip the attack transient: analyse from the loudest point + 50ms
  let peakIdx = 0;
  let peak = 0;
  const scan = Math.min(ch.length - N, Math.floor(sr * 1.5));
  for (let i = 0; i < scan; i += 32) {
    const v = Math.abs(ch[i]);
    if (v > peak) {
      peak = v;
      peakIdx = i;
    }
  }
  if (peak < 0.02) return null;
  const start = Math.min(ch.length - N, peakIdx + Math.floor(sr * 0.05));
  const minLag = Math.floor(sr / 1000);
  const maxLag = Math.floor(sr / 35);
  let energy = 0;
  for (let i = 0; i < N; i++) energy += ch[start + i] * ch[start + i];
  if (energy <= 0) return null;
  let bestLag = 0;
  let best = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0;
    for (let i = 0; i < N - lag; i += 2) sum += ch[start + i] * ch[start + i + lag];
    if (sum > best) {
      best = sum;
      bestLag = lag;
    }
  }
  const clarity = (best * 2) / energy;
  if (!bestLag || clarity < 0.45) return null;
  const hz = sr / bestLag;
  const midi = Math.round(69 + 12 * Math.log2(hz / 440));
  return midi >= 16 && midi <= 108 ? midi : null;
}

/**
 * @param {string} path  full path inside the pack ("Breaks/Break 1 - 135BPM/Loop 1.wav")
 * @param {AudioBuffer} buffer decoded audio
 */
export function classifySample(path, buffer) {
  // Judge by parent folder + file name only: a pack root like "Drum & Bass Vol 1" must not
  // turn every file into BASS. Tempo can still come from anywhere in the path.
  const tail = path.split('/').slice(-2).join('/');
  const lower = tail.toLowerCase().replace(/[_\-]+/g, ' ');
  const fileName = path.split('/').pop();
  const duration = buffer.duration;

  let category = 'OTHER';
  for (const [cat, re] of RULES) {
    if (re.test(lower)) {
      category = cat;
      break;
    }
  }

  let bpm = bpmFromPath(path);
  const catDef = CATEGORIES.find((c) => c.id === category);
  let kind = catDef?.kind || 'hit';

  // Anything with a tempo in its name, or long + rhythmic, is a loop
  if (bpm && duration > 0.9) kind = 'loop';
  if (!bpm && (category === 'BREAK' || category === 'LOOP') && duration > 0.9) {
    bpm = tempoFromBars(duration, category, analyzeAudioBuffer(buffer)?.detectedBpm);
    kind = 'loop';
  }
  // Very short "breaks"/"loops" are really one-shots (a single hit cut from a break)
  if ((category === 'BREAK' || category === 'LOOP') && duration <= 0.9 && !bpmFromPath(path)) kind = 'hit';
  if (category === 'OTHER' && kind === 'loop') category = 'LOOP';
  if (category === 'OTHER' && duration < 1.2) category = 'DRUM';

  const beats = kind === 'loop' && bpm ? snapBeats(duration, bpm) : null;
  // Chords (pads) have no single root worth showing; single-note material does
  const root = kind === 'pitched' && category !== 'PAD' && duration > 0.15 ? detectRootMidi(buffer) : null;
  const base = fileName.replace(/\.[^.]+$/, '');
  const key = keyFromCamelot(base) || keyFromName(base);

  return { category, kind, bpm, beats, root, key, duration };
}
