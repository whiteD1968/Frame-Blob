// Frame/Blob — app
import { Viewer, VIEW_NAMES } from './viewer.js';
import { DEFAULTS, SCHEMA, PRESETS, MATERIALS } from './params.js';
import { buildPanel, el, modal, toast, ask, confirmBox } from './ui.js';
import { Library, Session, History, iterationSheet } from './store.js';
import { download, slug, exportSTL, exportOBJ, exportGLB, exportPNG, cutListCSV } from './exporters.js';
import { drawingToSVG, drawingToDXF } from './geom/drawing.js';
import { PRODUCTS, ROADMAP } from './ideas.js';
import { LatticeEditor } from './lattice.js';
import { latticeBounds, makeLattice, resampleLattice, normalisedDeltas, isIdentity, unwarpPoint, warpPoint } from './geom/ffd.js';

const $ = (s) => document.querySelector(s);
const STAGE_DISPLAY = new Set(['material', 'showFrame', 'showBlob', 'showCells', 'showSeeds', 'showGround', 'cut', 'contours', 'centerlines', 'drawScale', 'units', 'name',
  'lighting', 'exposure', 'frameShader', 'frameColor', 'xray', 'blobShader', 'blobOpacity', 'wire', 'wireColor', 'zebraFreq', 'ffdFalloff', 'ffdStrength', 'showLattice']);

// ------------------------------------------------------------------ state
const library = new Library();
const session = new Session();
const history = new History();
const P = { ...DEFAULTS, ...(fromHash() || session.last || {}) };
let committed = { ...P };
let last = null; // last geometry result
let editCells = false;
let editLattice = false;
let curL = null; // current lattice

// ------------------------------------------------------------------ geometry backend (worker w/ fallback)
let worker = null, engine = null, jobId = 0, busy = false, pending = null;
const waiters = new Map();
try {
  worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = (ev) => onResult(ev.data);
  worker.onerror = (e) => { console.warn('worker failed, falling back', e); worker = null; useMainThread(); };
} catch (e) { worker = null; }
async function useMainThread() {
  if (engine) return;
  const m = await import('./engine.js');
  engine = m.createEngine();
  busy = false;
  if (pending) { const p = pending; pending = null; send(p); }
}
if (!worker) useMainThread();

function send(job) {
  busy = true;
  const id = ++jobId;
  job.id = id;
  setBusy(true);
  if (worker) worker.postMessage(job);
  else if (engine) {
    setTimeout(() => {
      try {
        const out = job.type === 'run' ? engine.run(job.P, job.res) : engine.drawing(job.view, job.opts, job.show, job.lattice);
        onResult({ id, type: job.type, out, res: job.res });
      } catch (err) { onResult({ id, type: job.type, error: String(err.stack || err) }); }
    }, 0);
  } else { pending = job; }
  return id;
}

function request(job) {
  return new Promise((resolve, reject) => {
    const go = () => { const id = send(job); waiters.set(id, { resolve, reject }); };
    if (busy) queue.push(go); else go();
  });
}
const queue = [];

function onResult(msg) {
  busy = false;
  setBusy(false);
  const w = waiters.get(msg.id);
  if (msg.error) { console.error(msg.error); toast('Geometry error — see console'); }
  if (msg.type === 'run' && msg.out) {
    last = msg.out;
    last.__res = msg.res;
    viewer.setGeometry(msg.out);
    viewer.setDisplay(P);
    updateLattice();
    updateStats();
  }
  if (w) { waiters.delete(msg.id); msg.error ? w.reject(msg.error) : w.resolve(msg.out); }
  if (queue.length) { queue.shift()(); return; }
  if (pending) { const p = pending; pending = null; send(p); }
}

function rebuild(final) {
  const res = final ? P.res : Math.min(P.res, 56);
  const job = { type: 'run', P: { ...P }, res };
  if (busy) { pending = job; return; }
  send(job);
}

// ------------------------------------------------------------------ viewer
const viewer = new Viewer($('#viewport'));
viewer.setMaterial(P.material);
const lattice = new LatticeEditor(viewer, {
  getSettings: () => ({ falloff: P.ffdFalloff, strength: P.ffdStrength }),
  onChange: (L, final) => {
    viewer.applyWarp(true);
    if (final) {
      P.ffdDeltas = isIdentity(L) ? null : normalisedDeltas(L);
      commit('lattice deform');
      updateStats();
    }
  },
});

// ------------------------------------------------------------------ panel
const panel = buildPanel($('#panel'), SCHEMA, P, (key, value, final) => setParam(key, value, final));

function setParam(key, value, final) {
  if (key[0] === '@') { action(key.slice(1)); return; }
  if (key === 'ffdX' || key === 'ffdY' || key === 'ffdZ') {
    const old = curL;
    P[key] = value;
    if (old && last) {
      const nl = resampleLattice(old, makeLattice(latticeBounds(last.stats, P), { ...P, ffdDeltas: null }));
      P.ffdDeltas = isIdentity(nl) ? null : normalisedDeltas(nl);
    }
    updateLattice();
    if (final) commit();
    return;
  }
  P[key] = value;
  if (key === 'showLattice') lattice.setVisible(P.showLattice || editLattice);
  if (['lattice', 'blobSource', 'meshMode', 'blobShader', 'frameTopology', 'outerEdges', 'wrap'].includes(key)) panel.sync();
  if (STAGE_DISPLAY.has(key)) { viewer.setDisplay(P); if (final) commit(); syncTop(); return; }
  // changing the cell structure invalidates manual toggles
  if (final && ['lattice', 'count', 'nx', 'ny', 'nz', 'seed', 'boundary', 'relax', 'jitter', 'gradient', 'gradAxis'].includes(key) && P.disabled.length) {
    P.disabled = [];
  }
  rebuild(final);
  if (final) commit();
}

function action(a) {
  if (a === 'latticeEdit') toggleLattice();
  if (a === 'latticeReset') { P.ffdDeltas = null; updateLattice(); commit('lattice reset'); toast('Lattice reset'); }
}

// ------------------------------------------------------------------ lattice (FFD)
function updateLattice() {
  if (!last) return;
  curL = makeLattice(latticeBounds(last.stats, P), P);
  viewer.setLattice(curL);
  lattice.setLattice(curL);
  lattice.setVisible(P.showLattice || editLattice);
}
function toggleLattice(force) {
  editLattice = force ?? !editLattice;
  if (editLattice && editCells) { editCells = false; }
  lattice.setEnabled(editLattice);
  lattice.setVisible(P.showLattice || editLattice);
  $('#latbar').classList.toggle('on', editLattice);
  syncTop();
  if (editLattice) toast('Lattice: click / Shift / Ctrl / drag-box to select · RMB orbit · MMB pan');
}
function setLatMode(m) {
  lattice.setMode(m);
  document.querySelectorAll('#latbar [data-mode]').forEach((b) => b.classList.toggle('on', b.dataset.mode === m));
}

function commit(action) {
  const diffs = [];
  for (const k of Object.keys(P)) {
    if (JSON.stringify(P[k]) !== JSON.stringify(committed[k])) diffs.push(`${k}: ${short(committed[k])} → ${short(P[k])}`);
  }
  if (!diffs.length && !action) return;
  session.add(action || 'edit', diffs.join(', '));
  history.push(P);
  committed = { ...P };
  session.last = { ...P };
  session.persist();
  renderLog();
}
const short = (v) => (Array.isArray(v) ? `[${v.length}]` : typeof v === 'number' ? +v.toFixed(3) : String(v));

function applyState(state, action) {
  for (const k of Object.keys(P)) delete P[k];
  Object.assign(P, DEFAULTS, state);
  panel.sync();
  viewer.wantFit = true;
  viewer.setMaterial(P.material);
  viewer.setDisplay(P);
  syncTop();
  rebuild(true);
  if (action) commit(action);
}


// ------------------------------------------------------------------ top bar
function syncTop() {
  document.querySelectorAll('[data-view]').forEach((b) => b.classList.toggle('on', (b.dataset.view === 'quad' ? viewer.quad : !viewer.quad && viewer.view === b.dataset.view)));
  document.querySelectorAll('[data-toggle]').forEach((b) => b.classList.toggle('on', !!P[b.dataset.toggle]));
  $('#material').value = P.material;
  $('#name').value = P.name;
  $('#editCells').classList.toggle('on', editCells);
  $('#editLattice').classList.toggle('on', editLattice);
  $('#viewport').classList.toggle('editing', editCells);
}

function buildTop() {
  const views = [['persp', 'Persp', '1'], ['axon', 'Axon', '2'], ['plan', 'Plan', '3'], ['front', 'Front', '4'], ['side', 'Side', '5'], ['quad', 'Quad', 'Q']];
  $('#views').append(...views.map(([v, t, k]) => el('button', { 'data-view': v, title: `${t} (${k})`, onclick: () => { viewer.setView(v, v !== 'quad' && v === viewer.view); syncTop(); } }, t)));
  $('#views').append(el('button', { title: 'Zoom to fit (F)', onclick: () => viewer.fitAll() }, '⤢'));
  const toggles = [['showFrame', 'Frame'], ['showBlob', 'Blob'], ['showCells', 'Cells'], ['showSeeds', 'Seeds'], ['showGround', 'Ground']];
  $('#toggles').append(...toggles.map(([k, t]) => el('button', { 'data-toggle': k, onclick: () => setParam(k, !P[k], true) }, t)));
  const ms = $('#material');
  for (const [k, v] of Object.entries(MATERIALS)) ms.append(el('option', { value: k }, v));
  ms.onchange = () => setParam('material', ms.value, true);
  $('#name').onchange = (e) => setParam('name', e.target.value || 'Untitled study', true);
  $('#editLattice').onclick = () => toggleLattice();
  document.querySelectorAll('#latbar [data-mode]').forEach((b) => (b.onclick = () => setLatMode(b.dataset.mode)));
  $('#latAll').onclick = () => lattice.selectAll();
  $('#latReset').onclick = () => action('latticeReset');
  $('#latDone').onclick = () => toggleLattice(false);
  $('#editCells').onclick = () => { editCells = !editCells; if (editCells && editLattice) toggleLattice(false); syncTop(); toast(editCells ? 'Edit cells: click a cushion/strut to toggle its cell' : 'Edit cells off'); };
  $('#undo').onclick = undo; $('#redo').onclick = redo;
  $('#snap').onclick = snapshot;
  $('#save').onclick = saveToLibrary;
  $('#vary').onclick = variations;
  $('#drawings').onclick = () => drawingsModal('plan');
  $('#reset').onclick = async () => { if (await confirmBox('Reset all parameters to defaults?', 'Reset')) applyState({ ...DEFAULTS }, 'reset'); };

  const menu = $('#exportMenu');
  const items = [
    ['3D print / model', null],
    ['STL · frame only', () => exportSTL(viewer, 'frame', P.name)],
    ['STL · blob only', () => exportSTL(viewer, 'blob', P.name)],
    ['STL · frame + blob', () => exportSTL(viewer, 'both', P.name)],
    ['OBJ · both (separate objects)', () => exportOBJ(viewer, P.name)],
    ['GLB · with materials', () => exportGLB(viewer, P.name)],
    ['Drawings', null],
    ['Plan / elevations (SVG · DXF)…', () => drawingsModal('plan')],
    ['PNG · current view (2×)', () => exportPNG(viewer, P.name, viewer.quad ? 'quad' : viewer.view)],
    ['Data', null],
    ['Cut list · struts & nodes (CSV)', () => last && download(`${slug(P.name)}-cutlist.csv`, cutListCSV(warpedGraph(), P), 'text/csv')],
    ['Design parameters (JSON)', () => download(`${slug(P.name)}.frameblob.json`, JSON.stringify({ app: 'frame-blob', params: P }, null, 1), 'application/json')],
    ['Iteration sheet (PNG)', exportSheet],
    ['Process log (JSON)', () => download(`frameblob-process-${Date.now()}.json`, session.exportJSON(), 'application/json')],
    ['Share link (copy URL)', shareLink],
  ];
  for (const [t, fn] of items) {
    if (!fn) { menu.append(el('div', { class: 'mh' }, t)); continue; }
    menu.append(el('button', { onclick: async () => { menu.classList.remove('open'); try { if (t.startsWith('STL') || t.startsWith('OBJ') || t.startsWith('GLB')) await ensureFullGeo(); await fn(); session.add('export', t); renderLog(); } catch (e) { console.error(e); toast('Export failed'); } } }, t));
  }
  $('#exportBtn').onclick = (e) => { e.stopPropagation(); menu.classList.toggle('open'); };
  document.addEventListener('click', () => menu.classList.remove('open'));

  const imp = $('#importFile');
  $('#openBtn').onclick = () => imp.click();
  imp.onchange = async () => {
    const f = imp.files[0]; if (!f) return;
    const txt = await f.text(); imp.value = '';
    try {
      const d = JSON.parse(txt);
      if (d.params) { applyState(d.params, 'open file'); toast('Design loaded'); }
      else if (d.items) { const n = library.importJSON(txt); renderLibrary(); toast(`Imported ${n} library items`); }
      else toast('Unrecognised file');
    } catch { toast('Could not read file'); }
  };
}

function warpedGraph() {
  const g = last.graph;
  if (!curL || isIdentity(curL)) return g;
  const nodes = g.nodes.map((n) => warpPoint(curL, n));
  const edges = g.edges.map((e) => ({ ...e, length: Math.hypot(...[0, 1, 2].map((k) => nodes[e.a][k] - nodes[e.b][k])) }));
  return { nodes, edges, valence: g.valence };
}

async function ensureFullGeo() {
  if (last && last.__res === P.res) return;
  await request({ type: 'run', P: { ...P }, res: P.res });
}

// ------------------------------------------------------------------ status
function setBusy(b) { $('#busy').classList.toggle('on', b); }
function updateStats() {
  if (!last) return;
  const s = last.stats, u = P.units;
  const vol = (v) => (u === 'mm' ? (v / 1e6).toFixed(2) + ' L' : u === 'cm' ? (v / 1e3).toFixed(2) + ' L' : v.toFixed(3) + ' m³');
  const T = last.timings;
  const size = s.bmax.map((v, i) => (v - s.bmin[i]).toFixed(0)).join(' × ');
  $('#stats').innerHTML = [
    `<b>${s.active}</b>/${s.cells} cells${s.subCells ? ` · ${s.subCells} sub` : ''}`,
    `<b>${s.struts}</b> ${s.cords ? 'cord segments' : 'struts'} · ${s.nodes} nodes`,
    `strut length <b>${(s.strutLength / (u === 'mm' ? 1000 : u === 'cm' ? 100 : 1)).toFixed(2)} m</b>`,
    `blob <b>${vol(s.blobVolume)}</b>`,
    `frame <b>${vol(s.frameVolume)}</b>`,
    `envelope ${size} ${u}`,
    `${((s.frameTris + s.blobTris) / 1000).toFixed(0)}k tris${s.subdLevels ? ` · SubD ${s.subdLevels}` : ''}${curL && !isIdentity(curL) ? ' · lattice on' : ''}`,
    `<span class="dim">${Math.round(T.cells + T.frame + T.blob + T.mesh)} ms · grid ${s.grid}</span>`,
  ].join('<i></i>') + (s.voxel && !s.cords && P.radius < s.voxel * 0.8 && P.showFrame ? `<i></i><span class="warn">struts thinner than voxel (${s.voxel.toFixed(1)}) — raise Mesh › Resolution</span>` : '');
}

// ------------------------------------------------------------------ undo / redo
function undo() { const s = history.undo(); if (s) { applyState(s); committed = { ...P }; session.add('undo'); renderLog(); } }
function redo() { const s = history.redo(); if (s) { applyState(s); committed = { ...P }; session.add('redo'); renderLog(); } }

// ------------------------------------------------------------------ cell editing
let downAt = null;
$('#viewport').addEventListener('pointerdown', (e) => { downAt = [e.clientX, e.clientY]; });
$('#viewport').addEventListener('pointerup', (e) => {
  if (!editCells || !downAt || !last) return;
  if (Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 4) return;
  const hit = viewer.pick(e);
  if (!hit) return;
  const q = curL && !isIdentity(curL) ? unwarpPoint(curL, [hit.x, hit.y, hit.z]) : [hit.x, hit.y, hit.z];
  const p = { x: q[0], y: q[1], z: q[2] };
  let best = -1, bd = Infinity;
  for (const c of last.cells) {
    const d = (c.seed[0] - p.x) ** 2 + (c.seed[1] - p.y) ** 2 + (c.seed[2] - p.z) ** 2;
    if (d < bd) { bd = d; best = c.index; }
  }
  if (best < 0) return;
  const set = new Set(P.disabled);
  set.has(best) ? set.delete(best) : set.add(best);
  P.disabled = [...set];
  viewer.flash(hit, Math.max(P.radius * 2, 3));
  rebuild(true);
  commit('toggle cell ' + best);
});

// ------------------------------------------------------------------ snapshots / process
function caption() {
  const src = { cells: 'cells', subcells: 'sub-cells', independent: 'independent' }[P.blobSource];
  const lat = P.lattice === 'random' ? `${P.count} cells` : `${P.lattice} ${P.nx}·${P.ny}·${P.nz}`;
  return `${P.boundary} · ${lat} · inflate ${+P.inflate.toFixed(1)} · merge ${+P.merge.toFixed(1)} · ${src}`;
}
function snapshot() {
  const n = session.snapshot({ thumb: viewer.capture(420), params: { ...P }, caption: caption(), view: viewer.view });
  renderProcess();
  toast(`Iteration ${n} captured`);
}
async function exportSheet() {
  if (!session.snaps.length) { toast('No snapshots yet — press S to capture iterations'); return; }
  const c = await iterationSheet(session.snaps, { title: `FRAME/BLOB — ${P.name}`, dark: P.material === 'diagram' });
  c.toBlob((b) => download(`${slug(P.name)}-iterations.png`, b, 'image/png'));
}

function renderProcess() {
  const g = $('#snaps');
  g.innerHTML = '';
  if (!session.snaps.length) g.append(el('div', { class: 'empty' }, 'No iterations yet. Press ', el('kbd', {}, 'S'), ' or ◉ to capture the current state.'));
  [...session.snaps].reverse().forEach((s) => {
    g.append(el('div', { class: 'snap', title: s.caption },
      el('img', { src: s.thumb, onclick: () => { applyState(s.params, `restore iteration ${s.n}`); toast(`Restored iteration ${s.n}`); } }),
      el('div', { class: 'cap' }, el('b', {}, `Iteration ${s.n}`), el('button', { class: 'mini', title: 'Save to library', onclick: () => { library.add({ name: `${P.name} · it.${s.n}`, params: s.params, thumb: s.thumb, stats: null }); renderLibrary(); toast('Saved to library'); } }, '★'))));
  });
  renderLog();
}
function renderLog() {
  const L = $('#log');
  if (!L) return;
  L.innerHTML = '';
  const items = session.log.slice(-200).reverse();
  for (const e of items) {
    const t = new Date(e.t);
    L.append(el('div', { class: 'le' }, el('span', { class: 'lt' }, t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })), el('span', { class: 'la' }, e.action), el('span', { class: 'ld' }, e.detail || '')));
  }
}

// ------------------------------------------------------------------ library
async function saveToLibrary() {
  const name = await ask('Save to library as', P.name, { ok: 'Save' });
  if (name == null) return;
  P.name = name || P.name; syncTop();
  const ok = library.add({ name: P.name, params: { ...P }, thumb: viewer.capture(420), stats: last?.stats ? { cells: last.stats.active, struts: last.stats.struts, blobVolume: last.stats.blobVolume } : null });
  session.add('save', P.name);
  renderLibrary(); renderLog();
  toast(ok ? 'Saved to library' : 'Library storage is full — export & clear some items');
  showTab('library');
}
function renderLibrary() {
  const g = $('#lib');
  g.innerHTML = '';
  const q = ($('#libSearch')?.value || '').toLowerCase();
  const items = library.items.filter((x) => !q || x.name.toLowerCase().includes(q) || (x.tags || []).join(' ').includes(q));
  if (!items.length) g.append(el('div', { class: 'empty' }, library.items.length ? 'No matches.' : 'Library is empty. Save good versions with ★ (Ctrl+S).'));
  for (const it of items) {
    g.append(el('div', { class: 'card' },
      el('img', { src: it.thumb, onclick: () => { applyState(it.params, `load "${it.name}"`); toast(`Loaded ${it.name}`); } }),
      el('div', { class: 'meta' },
        el('div', { class: 'nm', title: it.name }, it.name),
        el('div', { class: 'dt' }, new Date(it.date).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })),
        el('div', { class: 'acts' },
          el('button', { class: 'mini', title: 'Rename', onclick: async () => { const n = await ask('Rename', it.name); if (n) { library.update(it.id, { name: n }); renderLibrary(); } } }, '✎'),
          el('button', { class: 'mini', title: 'Notes / tags', onclick: async () => { const n = await ask('Tags (comma separated)', (it.tags || []).join(', ')); if (n != null) { library.update(it.id, { tags: n.split(',').map((s) => s.trim()).filter(Boolean) }); renderLibrary(); } } }, '#'),
          el('button', { class: 'mini', title: 'Download design JSON', onclick: () => download(`${slug(it.name)}.frameblob.json`, JSON.stringify({ app: 'frame-blob', params: it.params }, null, 1)) }, '↓'),
          el('button', { class: 'mini danger', title: 'Delete', onclick: async () => { if (await confirmBox(`Delete "${it.name}"?`, 'Delete')) { library.remove(it.id); renderLibrary(); } } }, '✕'))),
      (it.tags || []).length ? el('div', { class: 'tags' }, ...(it.tags || []).map((t) => el('span', {}, t))) : null));
  }
}

// ------------------------------------------------------------------ ideas / presets
function renderIdeas() {
  const g = $('#ideas');
  g.innerHTML = '';
  g.append(el('div', { class: 'h' }, 'Presets'));
  g.append(el('div', { class: 'presets' }, ...PRESETS.map((pr) => el('button', { onclick: () => { applyState({ ...DEFAULTS, ...pr.p, name: pr.name }, `preset "${pr.name}"`); } }, pr.name))));
  g.append(el('div', { class: 'h' }, 'Architectural products'));
  for (const it of PRODUCTS) {
    g.append(el('div', { class: 'idea' },
      el('div', { class: 't' }, it.title),
      el('p', {}, it.text),
      el('p', { class: 'out' }, it.out),
      el('button', { class: 'mini wide', onclick: () => { const pr = PRESETS[it.preset]; applyState({ ...DEFAULTS, ...pr.p, name: it.title }, `idea "${it.title}"`); } }, 'Start from preset →')));
  }
  g.append(el('div', { class: 'h' }, 'Roadmap · proposed tools'));
  g.append(el('ol', { class: 'road' }, ...ROADMAP.map((r) => el('li', {}, r))));
}

function showTab(name) {
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('on', t.id === 'tab-' + name));
}

// ------------------------------------------------------------------ drawings modal
async function drawingsModal(view) {
  await ensureFullGeo();
  let cur = view;
  const prev = el('div', { class: 'draw-prev' }, 'Computing…');
  const tabs = el('div', { class: 'seg' }, ...['plan', 'front', 'side'].map((v) => el('button', { 'data-v': v, onclick: () => { cur = v; refresh(); } }, v[0].toUpperCase() + v.slice(1))));
  const ctl = (key, label, min, max, step) => {
    const i = el('input', { type: 'range', min, max, step, value: P[key] });
    const o = el('span', { class: 'val' }, String(P[key]));
    i.oninput = () => (o.textContent = i.value);
    i.onchange = () => { P[key] = +i.value; commit(); refresh(); };
    return el('label', { class: 'dctl' }, label, i, o);
  };
  const cl = el('input', { type: 'checkbox' }); cl.checked = P.centerlines;
  cl.onchange = () => { P.centerlines = cl.checked; commit(); refresh(); };
  let svg = '', dxf = '';
  const bar = el('div', { class: 'draw-bar' }, tabs,
    ctl('cut', 'Section cut', 0, 1, 0.01), ctl('contours', 'Contours', 0, 30, 1), ctl('drawScale', 'Scale 1:', 1, 500, 1),
    el('label', { class: 'dctl' }, cl, 'Centrelines'),
    el('span', { class: 'grow' }),
    el('button', { class: 'pri', onclick: () => { download(`${slug(P.name)}-${cur}.svg`, svg, 'image/svg+xml'); session.add('export', `SVG ${cur}`); } }, 'SVG'),
    el('button', { class: 'pri', onclick: () => { download(`${slug(P.name)}-${cur}.dxf`, dxf, 'application/dxf'); session.add('export', `DXF ${cur}`); } }, 'DXF'));
  modal('Drawings', el('div', {}, bar, prev), { wide: true });
  async function refresh() {
    tabs.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === cur));
    prev.textContent = 'Computing…';
    const opts = { cut: cur === 'plan' ? P.cut : P.cut > 0 ? P.cut : null, contours: P.contours, centerlines: P.centerlines, useModelBounds: true };
    const d = await request({ type: 'drawing', view: cur, opts, show: { blob: P.showBlob, frame: P.showFrame, centerlines: P.centerlines }, lattice: curL && !isIdentity(curL) ? curL : null });
    if (!d) { prev.textContent = 'No geometry'; return; }
    const s = last.stats;
    const meta = { name: P.name, date: new Date().toLocaleDateString(), scale: P.drawScale, units: P.units, cutLabel: P.cut > 0 ? `cut @ ${(P.cut * 100).toFixed(0)}%` : '', stats: `${s.active} cells · ${s.struts} struts · ${s.nodes} nodes` };
    svg = drawingToSVG(d, meta);
    dxf = drawingToDXF(d, meta);
    prev.innerHTML = svg.replace(/^<\?xml[^>]*>/, '').replace(/width="[^"]*mm" height="[^"]*mm"/, 'width="100%" height="100%"');
  }
  refresh();
}

// ------------------------------------------------------------------ variations
async function variations() {
  const base = { ...P };
  const grid = el('div', { class: 'var-grid' });
  const amount = el('input', { type: 'range', min: 0, max: 1, step: 0.05, value: 0.35 });
  const mode = el('select', {}, el('option', { value: 'seed' }, 'Seed only'), el('option', { value: 'form' }, 'Seed + form'), el('option', { value: 'lattice' }, 'Lattice + form'));
  mode.value = 'form';
  const go = el('button', { class: 'pri' }, 'Generate 8');
  let stop = false;
  const m = modal('Variations', el('div', {}, el('div', { class: 'draw-bar' }, el('label', { class: 'dctl' }, 'Vary', mode), el('label', { class: 'dctl' }, 'Amount', amount), el('span', { class: 'grow' }), go), grid), { wide: true, onClose: () => { stop = true; applyCurrent(); } });
  function applyCurrent() { rebuild(true); }
  const rnd = (a, b) => a + Math.random() * (b - a);
  const mutate = () => {
    const q = { ...base, seed: 1 + Math.floor(Math.random() * 9999), disabled: [] };
    const a = +amount.value;
    if (mode.value !== 'seed') {
      const jig = (k, lo, hi) => { q[k] = Math.min(hi, Math.max(lo, base[k] + (Math.random() * 2 - 1) * a * (hi - lo) * 0.35)); };
      jig('inflate', 0, 30); jig('merge', 0, 20); jig('roundness', 0.1, 1.6); jig('skinPush', -2, 30); jig('radius', 0.4, 8); jig('taper', -0.6, 0.6); jig('gap', -2, 8); jig('variance', 0, 0.5);
      for (const k of ['inflate', 'merge', 'roundness', 'skinPush', 'radius', 'taper', 'gap', 'variance']) q[k] = +q[k].toFixed(2);
    }
    if (mode.value === 'lattice') {
      q.count = Math.max(3, Math.round(base.count * rnd(0.5, 1.6)));
      q.relax = Math.round(rnd(0, 6));
      q.subdiv = Math.random() < 0.3 ? Math.round(rnd(1, 4)) : 0;
      q.blobSource = Math.random() < 0.25 ? 'independent' : base.blobSource;
      if (q.blobSource === 'subcells' && !q.subdiv) q.blobSource = 'cells';
    }
    return q;
  };
  go.onclick = async () => {
    stop = false; grid.innerHTML = '';
    go.disabled = true;
    for (let i = 0; i < 8 && !stop; i++) {
      const q = mutate();
      const slot = el('div', { class: 'var' }, el('div', { class: 'ph' }, '…'));
      grid.append(slot);
      const out = await request({ type: 'run', P: q, res: Math.min(P.res, 64) });
      if (stop) break;
      viewer.setGeometry(out); viewer.setDisplay(q);
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const thumb = viewer.capture(360);
      slot.innerHTML = '';
      slot.append(el('img', { src: thumb, onclick: () => { stop = true; m.close(); applyState(q, 'adopt variation'); toast('Variation adopted'); } }),
        el('div', { class: 'cap' }, `seed ${q.seed} · inf ${q.inflate} · mrg ${q.merge}`,
          el('button', { class: 'mini', title: 'Save to library', onclick: () => { library.add({ name: `${base.name} · var ${q.seed}`, params: q, thumb }); renderLibrary(); toast('Saved'); } }, '★')));
    }
    go.disabled = false;
    viewer.setDisplay(P);
    if (!stop) { const out = await request({ type: 'run', P: { ...P }, res: P.res }); viewer.setGeometry(out); }
  };
  go.onclick();
}

// ------------------------------------------------------------------ share link
function toHash(p) { return '#d=' + btoa(unescape(encodeURIComponent(JSON.stringify(p)))); }
function fromHash() {
  const m = location.hash.match(/#d=(.+)$/);
  if (!m) return null;
  try { return JSON.parse(decodeURIComponent(escape(atob(m[1])))); } catch { return null; }
}
async function shareLink() {
  const url = location.href.split('#')[0] + toHash(P);
  try { await navigator.clipboard.writeText(url); toast('Share link copied'); } catch { ask('Copy this link', url); }
}

// ------------------------------------------------------------------ keyboard
window.addEventListener('keydown', (e) => {
  if (e.target.matches('input, select, textarea')) return;
  const k = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if ((e.ctrlKey || e.metaKey) && k === 'y') { e.preventDefault(); redo(); return; }
  if ((e.ctrlKey || e.metaKey) && k === 's') { e.preventDefault(); saveToLibrary(); return; }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (editLattice) {
    if (k === 'w') { setLatMode('translate'); return; }
    if (k === 'r') { setLatMode('rotate'); return; }
    if (k === 't') { setLatMode('scale'); return; }
    if (k === 'a') { lattice.selectAll(); return; }
    if (k === 'escape') { if (lattice.sel.size) lattice.clear(); else toggleLattice(false); return; }
  }
  if (k === 'l') { toggleLattice(); return; }
  if (k === 'x') { setParam('xray', !P.xray, true); panel.sync(); return; }
  const map = { 1: 'persp', 2: 'axon', 3: 'plan', 4: 'front', 5: 'side' };
  if (map[k]) { viewer.setView(map[k]); syncTop(); }
  else if (k === 'q') { viewer.setView('quad'); syncTop(); }
  else if (k === 'f') viewer.fitAll();
  else if (k === 's') snapshot();
  else if (k === 'e') $('#editCells').click();
  else if (k === 'escape' && editLattice) toggleLattice(false);
  else if (k === 'v') variations();
  else if (k === 'd') drawingsModal('plan');
});

// ------------------------------------------------------------------ boot
document.querySelectorAll('.tabs button').forEach((b) => (b.onclick = () => showTab(b.dataset.tab)));
$('#libSearch').oninput = renderLibrary;
$('#libExport').onclick = () => download(`frameblob-library-${new Date().toISOString().slice(0, 10)}.json`, library.exportJSON(), 'application/json');
$('#libImport').onclick = () => $('#importFile').click();
$('#procSheet').onclick = exportSheet;
$('#procLog').onclick = () => download(`frameblob-process-${Date.now()}.json`, session.exportJSON(), 'application/json');
$('#procClear').onclick = async () => { if (await confirmBox('Clear process log and snapshots?', 'Clear')) { session.clear(); renderProcess(); } };
$('#procSnap').onclick = snapshot;
$('#collapse').onclick = () => document.body.classList.toggle('drawer-closed');
buildTop();
syncTop();
renderLibrary(); renderProcess(); renderIdeas();
history.push(P);
session.add('open', P.name);
rebuild(true);
window.FB = { get P() { return P; }, viewer, lattice, get L() { return curL; }, get last() { return last; }, setParam, applyState, toggleLattice };
