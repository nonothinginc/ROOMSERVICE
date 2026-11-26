import * as Tone from 'tone';
import { addUserSampleBuffer, ensureFactoryDrumKits } from '../audio/drum-kits.js';
import { buildZip, encodeAudioBufferToWav, parseZip } from './zip-wav.js';

const DB_NAME = 'roomservice-db';
const DB_VERSION = 1;
const STORE_NAME = 'autosave';
const AUTOSAVE_KEY = 'latest-session';

function openDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveAutosave(store) {
  try {
    const db = await openDb();
    const payload = store.exportSerializableState();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put({ ...payload, savedAt: Date.now() }, AUTOSAVE_KEY);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    // Ignore storage quota / private mode failures
  }
}

export async function loadAutosaveData() {
  try {
    const db = await openDb();
    const data = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(AUTOSAVE_KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return data;
  } catch {
    return null;
  }
}

export async function hasAutosave() {
  const data = await loadAutosaveData();
  if (!data || !data.project) return false;
  const hasNotes = Object.values(data.project.patterns || {}).some((p) =>
    Object.values(p.notesByTrack || {}).some((list) => list.length > 0)
  );
  return (
    hasNotes ||
    (data.project.arrClips?.length || 0) > 0 ||
    (data.lab?.length || 0) > 0 ||
    (data.sessionHistory?.length || 0) > 0
  );
}

export async function restoreAutosave(store) {
  const data = await loadAutosaveData();
  if (!data) return false;
  store.hydrateSerializedState(data.project, data.lab, data.sessionHistory);
  return true;
}

export function exportProjectArchive(engine, store) {
  const st = store.getState();
  const payload = store.exportSerializableState();
  const sampleBuffers = engine.collectAllAudioBuffers();

  const entries = [
    {
      name: 'manifest.json',
      data: JSON.stringify(
        {
          format: 'roomservice-archive',
          version: 1,
          name: st.projectName || 'UNTITLED',
          savedAt: new Date().toISOString(),
          bpm: st.bpm,
          sampleCount: sampleBuffers.length,
          labCount: st.lab.length,
          sessionCount: st.sessionHistory.length
        },
        null,
        2
      )
    },
    {
      name: 'project.json',
      data: JSON.stringify(payload.project)
    },
    {
      name: 'lab/lab.json',
      data: JSON.stringify(payload.lab)
    },
    {
      name: 'history/sessions.json',
      data: JSON.stringify(payload.sessionHistory)
    }
  ];

  const sampleIndex = [];
  for (const sb of sampleBuffers) {
    if (!sb.buffer) continue;
    const filename = `samples/${sb.id}.wav`;
    entries.push({
      name: filename,
      data: encodeAudioBufferToWav(sb.buffer)
    });
    sampleIndex.push({
      id: sb.id,
      kind: sb.kind,
      name: sb.name,
      trackId: sb.trackId ?? null,
      filename
    });
  }

  entries.push({
    name: 'samples/index.json',
    data: JSON.stringify(sampleIndex, null, 2)
  });

  const zipBytes = buildZip(entries);
  return new Blob([zipBytes], { type: 'application/zip' });
}

export async function downloadProjectArchive(engine, store) {
  const st = store.getState();
  store.saveSessionCheckpoint(`ARCHIVE ${st.projectName || 'UNTITLED'}`);
  const blob = exportProjectArchive(engine, store);
  const safeName = (st.projectName || 'UNTITLED').toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
  const fileName = `${safeName || 'roomservice'}.roomservice`;

  if (window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: fileName,
        types: [{ description: 'ROOMSERVICE Project', accept: { 'application/zip': ['.roomservice'] } }]
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      saveAutosave(store);
      return fileName;
    } catch {
      // Fall back to anchor download if cancelled or unsupported
    }
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  saveAutosave(store);
  return fileName;
}

export async function importProjectArchive(file, engine, store) {
  await engine.unlock();
  const ab = await file.arrayBuffer();
  const files = parseZip(ab);
  const dec = new TextDecoder();

  const projBytes = files.get('project.json');
  if (!projBytes) throw new Error('Missing project.json in archive');
  const projectData = JSON.parse(dec.decode(projBytes));

  const labBytes = files.get('lab/lab.json');
  const labData = labBytes ? JSON.parse(dec.decode(labBytes)) : [];

  const histBytes = files.get('history/sessions.json');
  const sessionData = histBytes ? JSON.parse(dec.decode(histBytes)) : [];

  const idxBytes = files.get('samples/index.json');
  const sampleIndex = idxBytes ? JSON.parse(dec.decode(idxBytes)) : [];

  const rawCtx = Tone.getContext().rawContext;
  ensureFactoryDrumKits(rawCtx);

  const decodedSamples = [];
  for (const item of sampleIndex) {
    const wavBytes = files.get(item.filename);
    if (!wavBytes) continue;
    try {
      const audioBuf = await rawCtx.decodeAudioData(wavBytes.buffer.slice(wavBytes.byteOffset, wavBytes.byteOffset + wavBytes.byteLength));
      decodedSamples.push({ ...item, buffer: audioBuf });
      if (item.kind === 'audio-clip') {
        store.registerAudioBufferRef(item.id, audioBuf);
      } else if (item.kind === 'drum-pool') {
        addUserSampleBuffer(item.name, audioBuf, 'USER');
      }
    } catch (err) {
      console.warn('[archive] failed decoding sample', item.filename, err);
    }
  }

  store.hydrateSerializedState(projectData, labData, sessionData);
  engine.applyRestoredSamples(decodedSamples);
  saveAutosave(store);
  return true;
}
