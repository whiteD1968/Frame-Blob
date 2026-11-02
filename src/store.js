// Frame/Blob — persistence: library of saved versions, process log, snapshots, undo history
const LIB_KEY = 'frameblob.library.v1';
const SES_KEY = 'frameblob.session.v1';

function load(key, fallback) {
  try { const s = localStorage.getItem(key); return s ? JSON.parse(s) : fallback; } catch { return fallback; }
}
function save(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); return true; } catch (e) { console.warn('storage full?', e); return false; }
}

export const uid = () => Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);

export class Library {
  constructor() { this.items = load(LIB_KEY, []); }
  persist() { return save(LIB_KEY, this.items); }
  add(entry) { this.items.unshift({ id: uid(), date: new Date().toISOString(), tags: [], notes: '', ...entry }); return this.persist(); }
  update(id, patch) { const it = this.items.find((x) => x.id === id); if (it) Object.assign(it, patch); this.persist(); }
  remove(id) { this.items = this.items.filter((x) => x.id !== id); this.persist(); }
  exportJSON() { return JSON.stringify({ app: 'frame-blob', version: 1, items: this.items }, null, 1); }
  importJSON(text) {
    const d = JSON.parse(text);
    const items = Array.isArray(d) ? d : d.items || [];
    const ids = new Set(this.items.map((x) => x.id));
    let n = 0;
    for (const it of items) { if (!it.params) continue; if (ids.has(it.id)) it.id = uid(); this.items.push(it); n++; }
    this.persist();
    return n;
  }
}

export class Session {
  constructor() {
    const s = load(SES_KEY, null);
    this.log = s?.log || [];
    this.snaps = s?.snaps || [];
    this.last = s?.last || null;
    this.started = s?.started || new Date().toISOString();
  }
  persist() {
    // keep it bounded
    if (this.log.length > 2000) this.log = this.log.slice(-2000);
    if (!save(SES_KEY, { log: this.log, snaps: this.snaps, last: this.last, started: this.started })) {
      // storage full: drop oldest snapshot thumbs
      this.snaps = this.snaps.slice(-30);
      save(SES_KEY, { log: this.log, snaps: this.snaps, last: this.last, started: this.started });
    }
  }
  add(action, detail = '', extra = {}) {
    this.log.push({ t: new Date().toISOString(), action, detail, ...extra });
    this.persist();
  }
  snapshot(entry) {
    const n = this.snaps.length + 1;
    this.snaps.push({ id: uid(), n, t: new Date().toISOString(), ...entry });
    this.add('snapshot', `Iteration ${n}`, { snap: n });
    return n;
  }
  clear() { this.log = []; this.snaps = []; this.started = new Date().toISOString(); this.persist(); }
  exportJSON() { return JSON.stringify({ app: 'frame-blob', kind: 'process', started: this.started, log: this.log, snaps: this.snaps }, null, 1); }
}

export class History {
  constructor(limit = 200) { this.stack = []; this.i = -1; this.limit = limit; }
  push(state) {
    const s = JSON.stringify(state);
    if (this.stack[this.i] === s) return;
    this.stack = this.stack.slice(0, this.i + 1);
    this.stack.push(s);
    if (this.stack.length > this.limit) this.stack.shift();
    this.i = this.stack.length - 1;
  }
  undo() { if (this.i > 0) { this.i--; return JSON.parse(this.stack[this.i]); } return null; }
  redo() { if (this.i < this.stack.length - 1) { this.i++; return JSON.parse(this.stack[this.i]); } return null; }
}

// Iteration sheet: grid of snapshots with captions (like a process plate)
export async function iterationSheet(snaps, { title = 'FRAME/BLOB — process', dark = false, cols = 5 } = {}) {
  const cw = 360, ch = 270, pad = 28, capH = 46, head = 90;
  const rows = Math.ceil(snaps.length / cols) || 1;
  const c = document.createElement('canvas');
  c.width = pad + cols * (cw + pad);
  c.height = head + rows * (ch + capH + pad) + pad;
  const g = c.getContext('2d');
  g.fillStyle = dark ? '#000' : '#f4f3f0'; g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = dark ? '#eee' : '#111';
  g.font = '600 30px Helvetica, Arial, sans-serif';
  g.fillText(title, pad, 52);
  g.font = '15px Helvetica, Arial, sans-serif';
  g.fillStyle = dark ? '#888' : '#666';
  g.fillText(`${snaps.length} iterations · ${new Date().toLocaleDateString()}`, pad, 76);
  const imgs = await Promise.all(snaps.map((s) => new Promise((res) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => res(null); im.src = s.thumb; })));
  snaps.forEach((s, k) => {
    const x = pad + (k % cols) * (cw + pad), y = head + Math.floor(k / cols) * (ch + capH + pad);
    const im = imgs[k];
    if (im) {
      const sc = Math.min(cw / im.width, ch / im.height);
      const w = im.width * sc, h = im.height * sc;
      g.drawImage(im, x + (cw - w) / 2, y + (ch - h) / 2, w, h);
    }
    g.textAlign = 'center';
    g.fillStyle = dark ? '#ddd' : '#111';
    g.font = 'italic 600 16px Georgia, serif';
    g.fillText(`Iteration ${s.n}`, x + cw / 2, y + ch + 20);
    g.fillStyle = dark ? '#777' : '#777';
    g.font = 'italic 12px Georgia, serif';
    g.fillText(s.caption || '', x + cw / 2, y + ch + 38);
    g.textAlign = 'left';
  });
  return c;
}
