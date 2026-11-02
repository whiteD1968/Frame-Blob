// Frame/Blob — small, dependency-free parameter panel
export function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k === 'style') e.style.cssText = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null) e.append(k.nodeType ? k : document.createTextNode(k));
  return e;
}

const fmt = (v, step) => {
  const d = step >= 1 ? 0 : step >= 0.1 ? 1 : 2;
  return Number(v).toFixed(d);
};

/**
 * onChange(key, value, final)
 */
export function buildPanel(root, schema, P, onChange) {
  const rows = [];
  root.innerHTML = '';
  for (const sec of schema) {
    const body = el('div', { class: 'sec-body' });
    const head = el('button', { class: 'sec-head' + (sec.open ? ' open' : ''), onclick: () => head.classList.toggle('open') },
      el('span', { class: 'caret' }), sec.title);
    root.append(el('section', { class: 'sec' }, head, body));
    for (const it of sec.items) {
      const label = it.label || it.key.charAt(0).toUpperCase() + it.key.slice(1);
      let row;
      if (it.type === 'select') {
        const sel = el('select', { onchange: () => onChange(it.key, sel.value, true) },
          ...Object.entries(it.options).map(([v, t]) => el('option', { value: v }, t)));
        row = el('div', { class: 'row' }, el('label', {}, label), sel);
        row._sync = () => (sel.value = P[it.key]);
      } else if (it.type === 'bool') {
        const cb = el('input', { type: 'checkbox', onchange: () => onChange(it.key, cb.checked, true) });
        row = el('div', { class: 'row bool' }, el('label', {}, label), el('label', { class: 'switch' }, cb, el('span')));
        row._sync = () => (cb.checked = !!P[it.key]);
      } else {
        const rng = el('input', { type: 'range', min: it.min, max: it.max, step: it.step });
        const num = el('input', { type: 'number', min: it.min, max: it.max, step: it.step, class: 'num' });
        rng.addEventListener('input', () => { num.value = fmt(rng.value, it.step); onChange(it.key, +rng.value, false); });
        rng.addEventListener('change', () => onChange(it.key, +rng.value, true));
        num.addEventListener('change', () => { rng.value = num.value; onChange(it.key, +num.value, true); });
        // drag on number for scrubbing
        let sx = null, sv = 0;
        num.addEventListener('pointerdown', (e) => { if (e.altKey) { sx = e.clientX; sv = +num.value; num.setPointerCapture(e.pointerId); e.preventDefault(); } });
        num.addEventListener('pointermove', (e) => {
          if (sx == null) return;
          let v = sv + ((e.clientX - sx) * (it.max - it.min)) / 400;
          v = Math.min(it.max, Math.max(it.min, Math.round(v / it.step) * it.step));
          num.value = fmt(v, it.step); rng.value = v; onChange(it.key, v, false);
        });
        num.addEventListener('pointerup', () => { if (sx != null) { sx = null; onChange(it.key, +num.value, true); } });
        const kids = [el('label', { title: it.note || '' }, label), rng, num];
        if (it.dice) kids.push(el('button', { class: 'dice', title: 'Randomise', onclick: () => { const v = 1 + Math.floor(Math.random() * it.max); onChange(it.key, v, true); } }, '⚄'));
        row = el('div', { class: 'row slider' + (it.dice ? ' has-dice' : '') }, ...kids);
        row._sync = () => { rng.value = P[it.key]; num.value = fmt(P[it.key], it.step); };
      }
      if (it.note) row.append(el('div', { class: 'note' }, it.note));
      row._show = it.show;
      body.append(row);
      rows.push(row);
    }
  }
  const sync = () => {
    for (const r of rows) {
      r._sync();
      if (r._show) r.style.display = r._show(P) ? '' : 'none';
    }
  };
  sync();
  return { sync };
}

export function modal(title, content, { wide = false, onClose } = {}) {
  const close = () => { wrap.remove(); onClose && onClose(); };
  const wrap = el('div', { class: 'modal-wrap', onclick: (e) => { if (e.target === wrap) close(); } },
    el('div', { class: 'modal' + (wide ? ' wide' : '') },
      el('div', { class: 'modal-head' }, el('h3', {}, title), el('button', { class: 'x', onclick: close }, '×')),
      el('div', { class: 'modal-body' }, content)));
  document.body.append(wrap);
  return { close, wrap };
}

export function toast(msg, ms = 1800) {
  const t = el('div', { class: 'toast' }, msg);
  document.body.append(t);
  requestAnimationFrame(() => t.classList.add('on'));
  setTimeout(() => { t.classList.remove('on'); setTimeout(() => t.remove(), 300); }, ms);
}

// In-page replacements for prompt / confirm (sandboxed hosts block the native ones)
export function ask(title, value = '', { ok = 'OK', multiline = false } = {}) {
  return new Promise((resolve) => {
    const inp = el(multiline ? 'textarea' : 'input', { class: 'ask-in', value });
    if (multiline) inp.value = value;
    let done = false;
    const finish = (v) => { if (done) return; done = true; m.close(); resolve(v); };
    const m = modal(title, el('div', { class: 'ask' }, inp,
      el('div', { class: 'ask-btns' }, el('button', { class: 'mini', onclick: () => finish(null) }, 'Cancel'), el('button', { class: 'pri', onclick: () => finish(inp.value) }, ok))),
      { onClose: () => finish(null) });
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !multiline) finish(inp.value); if (e.key === 'Escape') finish(null); });
    setTimeout(() => { inp.focus(); inp.select && inp.select(); }, 20);
  });
}
export function confirmBox(msg, ok = 'OK') {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (done) return; done = true; m.close(); resolve(v); };
    const m = modal('Confirm', el('div', { class: 'ask' }, el('p', {}, msg),
      el('div', { class: 'ask-btns' }, el('button', { class: 'mini', onclick: () => finish(false) }, 'Cancel'), el('button', { class: 'pri', onclick: () => finish(true) }, ok))),
      { onClose: () => finish(false) });
  });
}
