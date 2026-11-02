// Frame/Blob — orthographic drawings from the SDF grids
// Plan / Front / Side: silhouette (projection), section cut, contours, strut centrelines.
// Output: SVG (vector, scaled) and DXF (LINE entities on named layers).

// ---------------------------------------------------------------- marching squares
export function marchingSquares(vals, nu, nv, iso = 0) {
  const segs = [];
  const pts = new Map();
  const ptKey = (type, i, j) => type + ':' + i + ':' + j;
  const at = (i, j) => vals[i + nu * j];
  const edgePt = (e, i, j) => {
    // e: 0 bottom,1 right,2 top,3 left of cell (i,j)
    let key, a, b, pa, pb;
    if (e === 0) { key = ptKey('h', i, j); pa = [i, j]; pb = [i + 1, j]; }
    else if (e === 1) { key = ptKey('v', i + 1, j); pa = [i + 1, j]; pb = [i + 1, j + 1]; }
    else if (e === 2) { key = ptKey('h', i, j + 1); pa = [i, j + 1]; pb = [i + 1, j + 1]; }
    else { key = ptKey('v', i, j); pa = [i, j]; pb = [i, j + 1]; }
    if (!pts.has(key)) {
      a = at(pa[0], pa[1]); b = at(pb[0], pb[1]);
      const t = (iso - a) / (b - a || 1e-12);
      pts.set(key, [pa[0] + (pb[0] - pa[0]) * t, pa[1] + (pb[1] - pa[1]) * t]);
    }
    return key;
  };
  const T = { 1: [[3, 0]], 2: [[0, 1]], 3: [[3, 1]], 4: [[1, 2]], 6: [[0, 2]], 7: [[3, 2]], 8: [[2, 3]], 9: [[0, 2]], 11: [[1, 2]], 12: [[1, 3]], 13: [[0, 1]], 14: [[3, 0]] };
  for (let j = 0; j < nv - 1; j++) for (let i = 0; i < nu - 1; i++) {
    const v0 = at(i, j), v1 = at(i + 1, j), v2 = at(i + 1, j + 1), v3 = at(i, j + 1);
    const c = (v0 < iso ? 1 : 0) | (v1 < iso ? 2 : 0) | (v2 < iso ? 4 : 0) | (v3 < iso ? 8 : 0);
    if (c === 0 || c === 15) continue;
    let list;
    if (c === 5 || c === 10) {
      const centerIn = (v0 + v1 + v2 + v3) / 4 < iso;
      if (c === 5) list = centerIn ? [[0, 1], [2, 3]] : [[3, 0], [1, 2]];
      else list = centerIn ? [[3, 0], [1, 2]] : [[0, 1], [2, 3]];
    } else list = T[c];
    for (const [ea, eb] of list) segs.push([edgePt(ea, i, j), edgePt(eb, i, j)]);
  }
  // join into polylines
  const adj = new Map();
  segs.forEach((s, k) => {
    for (const key of s) { if (!adj.has(key)) adj.set(key, []); adj.get(key).push(k); }
  });
  const used = new Uint8Array(segs.length);
  const lines = [];
  for (let k = 0; k < segs.length; k++) {
    if (used[k]) continue;
    used[k] = 1;
    const chain = [segs[k][0], segs[k][1]];
    for (const dir of [1, 0]) {
      for (;;) {
        const end = dir ? chain[chain.length - 1] : chain[0];
        const nxt = (adj.get(end) || []).find((s) => !used[s]);
        if (nxt === undefined) break;
        used[nxt] = 1;
        const other = segs[nxt][0] === end ? segs[nxt][1] : segs[nxt][0];
        if (dir) chain.push(other); else chain.unshift(other);
      }
    }
    const closed = chain.length > 2 && chain[0] === chain[chain.length - 1];
    lines.push({ pts: chain.map((key) => pts.get(key)), closed });
  }
  return lines;
}

// ---------------------------------------------------------------- slicing / projection
const VIEWS = {
  plan: { axis: 2, u: 0, v: 1, flipDepth: false, label: 'PLAN' },
  front: { axis: 1, u: 0, v: 2, label: 'FRONT ELEVATION' },
  side: { axis: 0, u: 1, v: 2, label: 'SIDE ELEVATION' },
};

function strides(g) { return [1, g.dims[0], g.dims[0] * g.dims[1]]; }

function project(F, g, view) {
  const V = VIEWS[view], st = strides(g);
  const nu = g.dims[V.u], nv = g.dims[V.v], nw = g.dims[V.axis];
  const out = new Float32Array(nu * nv);
  for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
    let m = Infinity;
    const b = i * st[V.u] + j * st[V.v];
    for (let w = 0; w < nw; w++) { const x = F[b + w * st[V.axis]]; if (x < m) m = x; }
    out[i + nu * j] = m;
  }
  return { vals: out, nu, nv };
}

function slice(F, g, view, coord) {
  const V = VIEWS[view], st = strides(g);
  const nu = g.dims[V.u], nv = g.dims[V.v];
  let f = (coord - g.origin[V.axis]) / g.h;
  f = Math.min(Math.max(f, 0), g.dims[V.axis] - 1.001);
  const w0 = Math.floor(f), t = f - w0;
  const out = new Float32Array(nu * nv);
  for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
    const b = i * st[V.u] + j * st[V.v];
    const a = F[b + w0 * st[V.axis]], c = F[b + (w0 + 1) * st[V.axis]];
    out[i + nu * j] = a + (c - a) * t;
  }
  return { vals: out, nu, nv };
}

function toWorld(lines, g, view) {
  const V = VIEWS[view];
  return lines.map((l) => ({
    closed: l.closed,
    pts: l.pts.map(([i, j]) => [g.origin[V.u] + i * g.h, g.origin[V.v] + j * g.h]),
  }));
}

/**
 * Compute vector linework for a view.
 * opts: { cut: 0..1 (plan section height / elevation depth fraction), contours: n, centerlines: bool }
 */
export function computeDrawing(state, view, opts) {
  const { grid: g, blobF, frameF, graph, bounds, show } = state;
  const V = VIEWS[view];
  const layers = { BLOB_OUTLINE: [], FRAME_OUTLINE: [], BLOB_SECTION: [], FRAME_SECTION: [], CONTOURS: [], CENTERLINES: [] };
  if (blobF && show.blob) layers.BLOB_OUTLINE = toWorld(marchingSquares(project(blobF, g, view).vals, g.dims[V.u], g.dims[V.v]), g, view);
  if (frameF && show.frame) layers.FRAME_OUTLINE = toWorld(marchingSquares(project(frameF, g, view).vals, g.dims[V.u], g.dims[V.v]), g, view);

  const lo = bounds.min[V.axis], hi = bounds.max[V.axis];
  if (opts.cut != null && opts.cut > 0 && opts.cut < 1) {
    const c = lo + (hi - lo) * opts.cut;
    if (blobF && show.blob) layers.BLOB_SECTION = toWorld(marchingSquares(slice(blobF, g, view, c).vals, g.dims[V.u], g.dims[V.v]), g, view);
    if (frameF && show.frame) layers.FRAME_SECTION = toWorld(marchingSquares(slice(frameF, g, view, c).vals, g.dims[V.u], g.dims[V.v]), g, view);
  }
  if (opts.contours > 0 && blobF && show.blob) {
    for (let k = 1; k <= opts.contours; k++) {
      const c = lo + ((hi - lo) * k) / (opts.contours + 1);
      layers.CONTOURS.push(...toWorld(marchingSquares(slice(blobF, g, view, c).vals, g.dims[V.u], g.dims[V.v]), g, view));
    }
  }
  if (opts.centerlines && graph) {
    for (const e of graph.edges) {
      const A = graph.nodes[e.a], B = graph.nodes[e.b];
      layers.CENTERLINES.push({ closed: false, level: e.level, pts: [[A[V.u], A[V.v]], [B[V.u], B[V.v]]] });
    }
  }
  return { view, label: V.label, layers };
}

// ---------------------------------------------------------------- SVG
const STYLE = {
  BLOB_OUTLINE: { stroke: '#111', w: 1.0, fill: 'none' },
  FRAME_OUTLINE: { stroke: '#111', w: 0.6, fill: 'none' },
  BLOB_SECTION: { stroke: '#000', w: 1.6, fill: '#e9e6df' },
  FRAME_SECTION: { stroke: '#000', w: 0.8, fill: '#111' },
  CONTOURS: { stroke: '#8a8a8a', w: 0.35, fill: 'none' },
  CENTERLINES: { stroke: '#c0392b', w: 0.35, fill: 'none', dash: '4 2' },
};

function bboxOf(drw) {
  const mn = [Infinity, Infinity], mx = [-Infinity, -Infinity];
  for (const L of Object.values(drw.layers)) for (const l of L) for (const p of l.pts) {
    mn[0] = Math.min(mn[0], p[0]); mn[1] = Math.min(mn[1], p[1]);
    mx[0] = Math.max(mx[0], p[0]); mx[1] = Math.max(mx[1], p[1]);
  }
  if (!isFinite(mn[0])) return { mn: [0, 0], mx: [1, 1] };
  return { mn, mx };
}

export function drawingToSVG(drw, meta) {
  const { mn, mx } = bboxOf(drw);
  const W = mx[0] - mn[0], H = mx[1] - mn[1];
  const m = Math.max(W, H) * 0.12;
  const titleH = Math.max(W, H) * 0.12;
  const vbX = mn[0] - m, vbY = -mx[1] - m, vbW = W + 2 * m, vbH = H + 2 * m + titleH;
  const unitScale = { mm: 1, cm: 10, m: 1000 }[meta.units] || 1; // model unit → mm
  const paperW = (vbW * unitScale) / meta.scale, paperH = (vbH * unitScale) / meta.scale;
  const lw = Math.max(W, H) / 500; // base line weight in model units
  const path = (l) => 'M' + l.pts.map((p) => p[0].toFixed(3) + ' ' + (-p[1]).toFixed(3)).join('L') + (l.closed ? 'Z' : '');
  const order = ['CONTOURS', 'BLOB_OUTLINE', 'FRAME_OUTLINE', 'CENTERLINES', 'BLOB_SECTION', 'FRAME_SECTION'];
  let body = '';
  for (const name of order) {
    const L = drw.layers[name];
    if (!L.length) continue;
    const s = STYLE[name];
    const isFill = s.fill !== 'none';
    const d = L.map(path).join(' ');
    body += `<g id="${name}" inkscape:groupmode="layer" inkscape:label="${name}">` +
      `<path d="${d}" fill="${s.fill}" fill-rule="evenodd" stroke="${s.stroke}" stroke-width="${(s.w * lw).toFixed(4)}" stroke-linejoin="round" stroke-linecap="round"${s.dash ? ` stroke-dasharray="${s.dash.split(' ').map((x) => (x * lw).toFixed(3)).join(' ')}"` : ''}${isFill ? '' : ''}/></g>\n`;
  }
  // scale bar
  const nice = (x) => { const p = Math.pow(10, Math.floor(Math.log10(x))); for (const k of [1, 2, 5, 10]) if (k * p >= x) return k * p; return 10 * p; };
  const sb = nice(W / 5);
  const sbx = mn[0], sby = -mn[1] + m * 0.55;
  let bar = `<g id="SCALEBAR" font-family="Helvetica, Arial, sans-serif" font-size="${(lw * 9).toFixed(3)}">`;
  for (let i = 0; i < 4; i++) bar += `<rect x="${(sbx + (i * sb) / 4).toFixed(3)}" y="${sby.toFixed(3)}" width="${(sb / 4).toFixed(3)}" height="${(lw * 3).toFixed(3)}" fill="${i % 2 ? '#fff' : '#111'}" stroke="#111" stroke-width="${(lw * 0.4).toFixed(3)}"/>`;
  bar += `<text x="${sbx.toFixed(3)}" y="${(sby + lw * 12).toFixed(3)}">0</text><text x="${(sbx + sb).toFixed(3)}" y="${(sby + lw * 12).toFixed(3)}" text-anchor="middle">${sb} ${meta.units}</text></g>`;
  const ty = -mn[1] + m + titleH * 0.55;
  const title = `<g id="TITLE" font-family="Helvetica, Arial, sans-serif" fill="#111">
<line x1="${vbX + m * 0.5}" y1="${(ty - titleH * 0.35).toFixed(3)}" x2="${vbX + vbW - m * 0.5}" y2="${(ty - titleH * 0.35).toFixed(3)}" stroke="#111" stroke-width="${(lw * 0.5).toFixed(3)}"/>
<text x="${vbX + m * 0.5}" y="${ty.toFixed(3)}" font-size="${(lw * 14).toFixed(3)}" font-weight="700" letter-spacing="${(lw * 1).toFixed(3)}">${esc(drw.label)}${meta.cutLabel ? ' — ' + esc(meta.cutLabel) : ''}</text>
<text x="${vbX + m * 0.5}" y="${(ty + lw * 14).toFixed(3)}" font-size="${(lw * 9).toFixed(3)}">${esc(meta.name)} · FRAME/BLOB · ${esc(meta.date)}</text>
<text x="${vbX + vbW - m * 0.5}" y="${ty.toFixed(3)}" font-size="${(lw * 11).toFixed(3)}" text-anchor="end">1:${meta.scale}</text>
<text x="${vbX + vbW - m * 0.5}" y="${(ty + lw * 14).toFixed(3)}" font-size="${(lw * 8).toFixed(3)}" text-anchor="end">${esc(meta.stats || '')}</text></g>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" width="${paperW.toFixed(2)}mm" height="${paperH.toFixed(2)}mm" viewBox="${vbX.toFixed(3)} ${vbY.toFixed(3)} ${vbW.toFixed(3)} ${vbH.toFixed(3)}">
<rect x="${vbX}" y="${vbY}" width="${vbW}" height="${vbH}" fill="#fff"/>
${body}${bar}
${title}
</svg>`;
}

function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

// ---------------------------------------------------------------- DXF (R12, LINE entities)
export function drawingToDXF(drw, meta) {
  const colors = { BLOB_OUTLINE: 7, FRAME_OUTLINE: 8, BLOB_SECTION: 1, FRAME_SECTION: 5, CONTOURS: 9, CENTERLINES: 3 };
  const insUnits = { mm: 4, cm: 5, m: 6 }[meta.units] || 4;
  let s = `0\nSECTION\n2\nHEADER\n9\n$ACADVER\n1\nAC1009\n9\n$INSUNITS\n70\n${insUnits}\n0\nENDSEC\n`;
  s += '0\nSECTION\n2\nTABLES\n0\nTABLE\n2\nLAYER\n70\n' + Object.keys(colors).length + '\n';
  for (const [name, c] of Object.entries(colors)) s += `0\nLAYER\n2\n${name}\n70\n0\n62\n${c}\n6\nCONTINUOUS\n`;
  s += '0\nENDTAB\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n';
  for (const [name, L] of Object.entries(drw.layers)) {
    for (const l of L) {
      const p = l.pts;
      const n = l.closed ? p.length - 1 : p.length - 1;
      for (let i = 0; i < n; i++) {
        const a = p[i], b = p[i + 1];
        s += `0\nLINE\n8\n${name}\n10\n${a[0].toFixed(4)}\n20\n${a[1].toFixed(4)}\n30\n0\n11\n${b[0].toFixed(4)}\n21\n${b[1].toFixed(4)}\n31\n0\n`;
      }
    }
  }
  s += '0\nENDSEC\n0\nEOF\n';
  return s;
}
