/**
 * LIBRARY overlay: browse, audition and route samples.
 * Opened from the rail (generic), MPC (target = pad) or ARR (target = playlist at step/lane).
 * Gamepad: ↑↓ select (auto-preview) · ←→ category · A send · X preview · Y favourite · B close.
 */
import { CATEGORIES, midiToNote } from '../library/classify.js';
import { library, libraryState } from '../library/library.js';
import { store } from '../state/store.js';

const ICON_X = '<svg class="ico" viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8"/></svg>';
const ICON_STAR = '<svg class="ico" viewBox="0 0 16 16"><path d="m8 2.5 1.7 3.5 3.8.5-2.8 2.6.7 3.8L8 11.1l-3.4 1.8.7-3.8-2.8-2.6 3.8-.5z"/></svg>';

const ui = {
  cat: 'ALL',
  packId: null,
  selectedId: null,
  scrollTop: 0
};

let refs = null;

function visibleSamples() {
  return libraryState.samples.filter((s) => {
    if (ui.packId && s.packId !== ui.packId) return false;
    if (ui.cat === 'ALL') return true;
    if (ui.cat === 'FAV') return s.fav;
    return s.category === ui.cat;
  });
}

function categoryList() {
  const counts = library.categoryCounts(ui.packId);
  const favs = libraryState.samples.filter((s) => s.fav && (!ui.packId || s.packId === ui.packId)).length;
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const list = [{ id: 'ALL', label: 'ALL', n: total }];
  if (favs) list.push({ id: 'FAV', label: '★', n: favs });
  for (const c of CATEGORIES) if (counts[c.id]) list.push({ id: c.id, label: c.label, n: counts[c.id] });
  return list;
}

function metaText(s) {
  if (s.kind === 'loop' && s.bpm) return `${Math.round(s.bpm)}  ${s.beats ? `${s.beats}B` : ''}`.trim();
  if (s.root != null) return midiToNote(s.root);
  if (s.key) return s.key;
  return `${s.duration < 1 ? s.duration.toFixed(2) : s.duration.toFixed(1)}s`;
}

function waveSvg(peaks) {
  if (!peaks?.length) return '';
  const n = peaks.length;
  let d = '';
  for (let i = 0; i < n; i++) {
    const h = Math.max(0.6, (peaks[i] / 255) * 9);
    d += `M${i + 0.5} ${10 - h}V${10 + h}`;
  }
  return `<svg class="lib-wave" viewBox="0 0 ${n} 20" preserveAspectRatio="none"><path d="${d}"/></svg>`;
}

/** Context-aware routing options; the first is the primary (solid) action. */
function actionsFor(s, target) {
  const opts = [];
  const add = (kind, label) => opts.push({ kind, label });
  if (target?.kind === 'pad') add('pad', `PAD ${String((target.padIdx ?? 0) + 1).padStart(2, '0')}`);
  if (target?.kind === 'playlist') add('playlist', 'PLAYLIST');
  if (s.category === 'BREAK') add('chop', 'CHOP');
  if (s.kind === 'loop') add('playlist', 'PLAYLIST');
  if (s.kind === 'hit' || s.category === 'DRUM') add('pad', 'PAD');
  if (s.kind === 'pitched') add('sampler', 'SAMPLER');
  add('playlist', 'PLAYLIST');
  add('pad', 'PAD');
  add('sampler', 'SAMPLER');
  const seen = new Set();
  return opts.filter((o) => (seen.has(o.kind) ? false : seen.add(o.kind))).slice(0, 4);
}

async function send(kind) {
  const st = store.getState();
  const s = libraryState.samples.find((x) => x.id === ui.selectedId);
  if (!s) return;
  const t = st.detailOverlay?.target || {};
  const target = { kind };
  if (kind === 'pad' || kind === 'chop') {
    if (t.trackId != null) target.trackId = t.trackId;
    if (t.padIdx != null) target.padIdx = t.padIdx;
  }
  if (kind === 'playlist') {
    if (t.step != null) target.step = t.step;
    if (t.lane != null) target.lane = t.lane;
  }
  library.stopAudition();
  const res = await library.send(s.id, target);
  if (!res) return;
  // Hand back to where the sample now lives
  if (res.kind === 'playlist') {
    st.detailOverlay = null;
    store.setView('ARR');
    store.emit('overlay', null);
  } else if (res.kind === 'pad' || res.kind === 'chop') {
    st.detailOverlay = { type: 'mpc', trackId: res.trackId };
    store.emit('overlay', st.detailOverlay);
  } else if (res.kind === 'sampler') {
    st.detailOverlay = null;
    store.setSelectedTrack(res.trackId);
    store.setView('DSP');
    store.emit('overlay', null);
  }
}

function select(id, preview = true) {
  ui.selectedId = id;
  if (preview && id) library.audition(id);
  renderList();
  renderFooter();
  const row = refs?.list.querySelector(`[data-id="${CSS.escape(id)}"]`);
  row?.scrollIntoView({ block: 'nearest' });
}

function renderCats() {
  const { cats } = refs;
  cats.innerHTML = '';
  for (const c of categoryList()) {
    const b = document.createElement('button');
    b.className = `lib-cat ${ui.cat === c.id ? 'active' : ''}`;
    b.innerHTML = `<span>${c.label}</span><span class="n">${c.n}</span>`;
    b.onclick = () => {
      ui.cat = c.id;
      renderCats();
      renderList();
    };
    cats.appendChild(b);
  }
  if (libraryState.packs.length > 1 || ui.packId) {
    const hdr = document.createElement('div');
    hdr.className = 'lib-cat-hdr';
    hdr.textContent = 'PACKS';
    cats.appendChild(hdr);
    for (const p of libraryState.packs) {
      const b = document.createElement('button');
      b.className = `lib-cat pack ${ui.packId === p.id ? 'active' : ''}`;
      const name = document.createElement('span');
      name.textContent = p.name;
      const n = document.createElement('span');
      n.className = 'n';
      n.textContent = String(p.count);
      b.append(name, n);
      b.onclick = () => {
        ui.packId = ui.packId === p.id ? null : p.id;
        ui.cat = 'ALL';
        renderCats();
        renderList();
      };
      cats.appendChild(b);
    }
  }
}

function renderList() {
  if (!refs) return;
  const { list } = refs;
  const rows = visibleSamples();
  list.innerHTML = '';
  if (libraryState.importing) {
    const imp = libraryState.importing;
    const box = document.createElement('div');
    box.className = 'lib-empty';
    const pct = imp.total ? Math.round((imp.done / imp.total) * 100) : 0;
    box.innerHTML = `<div class="lib-progress"><i style="width:${pct}%"></i></div><div class="lib-imp-n">${imp.done} / ${imp.total}</div>`;
    const cur = document.createElement('div');
    cur.className = 'lib-imp-file';
    cur.textContent = imp.current || imp.name;
    box.appendChild(cur);
    list.appendChild(box);
    return;
  }
  if (!rows.length) {
    const box = document.createElement('div');
    box.className = 'lib-empty';
    const b = document.createElement('button');
    b.className = 'ctx-chip solid lib-import-big';
    b.textContent = 'IMPORT PACK';
    b.onclick = () => refs.fileInput.click();
    const hint = document.createElement('div');
    hint.className = 'lib-hint';
    hint.textContent = 'ZIP · WAV · AIFF · MP3 · FLAC';
    box.append(b, hint);
    list.appendChild(box);
    return;
  }
  const frag = document.createDocumentFragment();
  for (const s of rows) {
    const row = document.createElement('button');
    row.className = `lib-row ${ui.selectedId === s.id ? 'sel' : ''} ${libraryState.auditionId === s.id ? 'playing' : ''}`;
    row.dataset.id = s.id;
    row.innerHTML = `<span class="lib-play"></span>${waveSvg(s.peaks)}<span class="lib-name"></span><span class="lib-meta">${metaText(s)}</span><span class="lib-fav ${s.fav ? 'on' : ''}">${ICON_STAR}</span>`;
    row.querySelector('.lib-name').textContent = s.name;
    let lastTap = 0;
    row.addEventListener('click', (e) => {
      if (e.target.closest('.lib-fav')) {
        library.toggleFav(s.id);
        return;
      }
      const now = performance.now();
      if (ui.selectedId === s.id && now - lastTap < 300) {
        const first = actionsFor(s, store.getState().detailOverlay?.target)[0];
        send(first.kind);
        return;
      }
      lastTap = now;
      if (ui.selectedId === s.id) library.audition(s.id);
      else select(s.id);
    });
    frag.appendChild(row);
  }
  list.appendChild(frag);
}

function renderFooter() {
  if (!refs) return;
  const { footer } = refs;
  footer.innerHTML = '';
  const s = libraryState.samples.find((x) => x.id === ui.selectedId);
  if (!s) {
    footer.classList.remove('on');
    return;
  }
  footer.classList.add('on');
  const info = document.createElement('div');
  info.className = 'lib-foot-info';
  const nm = document.createElement('span');
  nm.className = 'lib-foot-name';
  nm.textContent = s.name;
  const sub = document.createElement('span');
  sub.className = 'lib-foot-sub';
  const cat = CATEGORIES.find((c) => c.id === s.category)?.label || s.category;
  sub.textContent = `${cat}  ${metaText(s)}`;
  info.append(nm, sub);
  footer.appendChild(info);
  const target = store.getState().detailOverlay?.target;
  actionsFor(s, target).forEach((a, i) => {
    const b = document.createElement('button');
    b.className = `ctx-chip ${i === 0 ? 'solid' : ''}`;
    b.textContent = a.label;
    if (i === 0) b.title = 'A';
    b.onclick = () => send(a.kind);
    footer.appendChild(b);
  });
}

export function renderLibraryOverlay(panelEl) {
  panelEl.innerHTML = '';
  library.init();
  const st = store.getState();

  const hdr = document.createElement('div');
  hdr.className = 'overlay-hdr';
  const title = document.createElement('span');
  title.innerHTML = `LIBRARY <i class="oh-sub">${libraryState.samples.length || ''}</i>`;
  const actions = document.createElement('div');
  actions.className = 'oh-actions';

  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.multiple = true;
  fileInput.accept = '.zip,application/zip,audio/*,.wav,.aif,.aiff,.mp3,.flac,.ogg,.m4a';
  fileInput.style.display = 'none';
  fileInput.onchange = async () => {
    const files = fileInput.files;
    if (files?.length) {
      ui.cat = 'ALL';
      ui.packId = null;
      await library.importFiles(files);
    }
    fileInput.value = '';
  };

  const importBtn = document.createElement('button');
  importBtn.className = 'ctx-chip';
  importBtn.textContent = 'IMPORT';
  importBtn.onclick = () => fileInput.click();

  const delBtn = document.createElement('button');
  delBtn.className = 'ctx-chip';
  delBtn.textContent = 'REMOVE PACK';
  delBtn.title = 'Hold to remove the selected pack from this device';

  const closeBtn = document.createElement('button');
  closeBtn.className = 'ctx-chip icon-only';
  closeBtn.innerHTML = ICON_X;
  closeBtn.title = 'Close [B]';
  closeBtn.onclick = () => {
    library.stopAudition();
    st.detailOverlay = null;
    store.emit('overlay', null);
  };
  actions.append(delBtn, importBtn, closeBtn);
  hdr.append(title, actions);

  const body = document.createElement('div');
  body.className = 'lib-body';
  const cats = document.createElement('div');
  cats.className = 'lib-cats';
  const list = document.createElement('div');
  list.className = 'lib-list';
  body.append(cats, list);

  const footer = document.createElement('div');
  footer.className = 'lib-foot';

  panelEl.append(hdr, body, footer, fileInput);
  refs = { cats, list, footer, fileInput, title, delBtn };

  // Remove pack needs a deliberate 600ms hold (no modal confirm on a handheld)
  let holdT = null;
  delBtn.addEventListener('pointerdown', () => {
    if (!ui.packId) return;
    delBtn.classList.add('arming');
    holdT = setTimeout(async () => {
      delBtn.classList.remove('arming');
      const id = ui.packId;
      ui.packId = null;
      ui.selectedId = null;
      await library.removePack(id);
    }, 600);
  });
  const cancelHold = () => {
    clearTimeout(holdT);
    delBtn.classList.remove('arming');
  };
  delBtn.addEventListener('pointerup', cancelHold);
  delBtn.addEventListener('pointerleave', cancelHold);

  // The panel is attached to the DOM after this function returns, so the first sync
  // must not depend on isConnected; later syncs stop once the panel has been removed.
  let wasConnected = false;
  const sync = () => {
    if (!refs || refs.list !== list) return;
    title.innerHTML = `LIBRARY <i class="oh-sub">${libraryState.samples.length || ''}</i>`;
    delBtn.style.display = ui.packId ? '' : 'none';
    renderCats();
    renderList();
    renderFooter();
  };
  const off = library.onChange(() => {
    if (list.isConnected) wasConnected = true;
    else if (wasConnected || refs?.list !== list) {
      off();
      return;
    }
    sync();
  });
  sync();
}

/** Gamepad / keyboard actions while the library overlay is open. */
export function handleLibraryAction(action) {
  if (!refs?.list.isConnected) return false;

  const rows = visibleSamples();
  const idx = rows.findIndex((s) => s.id === ui.selectedId);
  if (action.type === 'DPAD') {
    if (action.dir === 'UP' || action.dir === 'DOWN') {
      if (!rows.length) return true;
      const next = idx < 0 ? 0 : Math.max(0, Math.min(rows.length - 1, idx + (action.dir === 'DOWN' ? 1 : -1)));
      select(rows[next].id);
    } else {
      const cats = categoryList();
      const ci = Math.max(0, cats.findIndex((c) => c.id === ui.cat));
      ui.cat = cats[(ci + (action.dir === 'RIGHT' ? 1 : -1) + cats.length) % cats.length].id;
      renderCats();
      renderList();
    }
    return true;
  }
  const sel = rows[idx];
  if (action.type === 'A_TAP' && sel) {
    send(actionsFor(sel, store.getState().detailOverlay?.target)[0].kind);
    return true;
  }
  if (action.type === 'X' && sel) {
    library.audition(sel.id);
    return true;
  }
  if (action.type === 'Y' && sel) {
    library.toggleFav(sel.id);
    return true;
  }
  return false;
}

export function closeLibrary() {
  library.stopAudition();
}
