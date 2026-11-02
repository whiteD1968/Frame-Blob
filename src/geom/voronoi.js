// Frame/Blob — 3D Voronoi by convex clipping
// Coordinates are Z-up. Units are "model units" (mm by default).
//
// A polyhedron is { faces: [{ verts:[[x,y,z],...], n:[..], d, kind, nb }] }
//   kind: 'B' boundary skin, 'C' wall shared with neighbour cell nb, 'P' parent-cell face (subdivision), 'X' scratch
// Plane convention: a point p is inside when dot(n,p) <= d.

export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const len = (a) => Math.hypot(a[0], a[1], a[2]);
export const norm = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
export const dist2 = (a, b) => { const x = a[0] - b[0], y = a[1] - b[1], z = a[2] - b[2]; return x * x + y * y + z * z; };

export function mulberry32(seed) {
  let a = (seed >>> 0) || 1;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- boundary
function fibonacciDirs(n) {
  const out = [];
  const ga = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const z = 1 - (2 * (i + 0.5)) / n;
    const r = Math.sqrt(1 - z * z);
    out.push([Math.cos(ga * i) * r, Math.sin(ga * i) * r, z]);
  }
  return out;
}

export function makeBoundary(P) {
  const X = P.sizeX / 2, Y = P.sizeY / 2, H = P.sizeZ;
  const planes = [];
  let bmin, bmax;
  const type = P.boundary;
  if (type === 'box') {
    planes.push({ n: [1, 0, 0], d: X }, { n: [-1, 0, 0], d: X }, { n: [0, 1, 0], d: Y }, { n: [0, -1, 0], d: Y },
      { n: [0, 0, 1], d: H }, { n: [0, 0, -1], d: 0 });
    bmin = [-X, -Y, 0]; bmax = [X, Y, H];
  } else if (type === 'ellipsoid' || type === 'dome') {
    const a = X, b = Y, c = type === 'dome' ? H : H / 2, cz = type === 'dome' ? 0 : H / 2;
    for (const u of fibonacciDirs(type === 'dome' ? 110 : 64)) {
      if (type === 'dome' && u[2] < -0.05) continue;
      const q = [a * u[0], b * u[1], c * u[2] + cz];
      const n = norm([u[0] / a, u[1] / b, u[2] / c]);
      planes.push({ n, d: dot(n, q) });
    }
    if (type === 'dome') planes.push({ n: [0, 0, -1], d: 0 });
    bmin = [-X, -Y, 0]; bmax = [X, Y, H];
  } else { // cylinder (elliptic)
    const seg = 36;
    for (let i = 0; i < seg; i++) {
      const t = (i / seg) * Math.PI * 2;
      const q = [X * Math.cos(t), Y * Math.sin(t), 0];
      const n = norm([Math.cos(t) / X, Math.sin(t) / Y, 0]);
      planes.push({ n, d: dot(n, q) });
    }
    planes.push({ n: [0, 0, 1], d: H }, { n: [0, 0, -1], d: 0 });
    bmin = [-X, -Y, 0]; bmax = [X, Y, H];
  }
  planes.forEach((p, i) => (p.id = i));
  const inside = (p, eps = 0) => planes.every((pl) => dot(pl.n, p) <= pl.d - eps);
  return { type, planes, bmin, bmax, inside };
}

// ---------------------------------------------------------------- polyhedron ops
function boxPoly(mn, mx, kind = 'X') {
  const [x0, y0, z0] = mn, [x1, y1, z1] = mx;
  const v = (x, y, z) => [x, y, z];
  const F = (verts, n, d) => ({ verts, n, d, kind, nb: -1 });
  return {
    faces: [
      F([v(x1, y0, z0), v(x1, y1, z0), v(x1, y1, z1), v(x1, y0, z1)], [1, 0, 0], x1),
      F([v(x0, y0, z0), v(x0, y0, z1), v(x0, y1, z1), v(x0, y1, z0)], [-1, 0, 0], -x0),
      F([v(x0, y1, z0), v(x0, y1, z1), v(x1, y1, z1), v(x1, y1, z0)], [0, 1, 0], y1),
      F([v(x0, y0, z0), v(x1, y0, z0), v(x1, y0, z1), v(x0, y0, z1)], [0, -1, 0], -y0),
      F([v(x0, y0, z1), v(x1, y0, z1), v(x1, y1, z1), v(x0, y1, z1)], [0, 0, 1], z1),
      F([v(x0, y0, z0), v(x0, y1, z0), v(x1, y1, z0), v(x1, y0, z0)], [0, 0, -1], -z0),
    ],
  };
}

const EPS = 1e-7;

export function clipPoly(poly, n, d, kind, nb) {
  // quick test
  let anyOut = false;
  for (const f of poly.faces) {
    for (const v of f.verts) if (dot(n, v) - d > EPS) { anyOut = true; break; }
    if (anyOut) break;
  }
  if (!anyOut) return poly;

  const faces = [];
  const cut = [];
  for (const f of poly.faces) {
    const vs = f.verts, m = vs.length;
    const ds = vs.map((v) => dot(n, v) - d);
    const out = [];
    for (let i = 0; i < m; i++) {
      const a = vs[i], b = vs[(i + 1) % m], da = ds[i], db = ds[(i + 1) % m];
      if (da <= EPS) out.push(a);
      if (Math.abs(da) <= EPS) cut.push(a);
      if ((da < -EPS && db > EPS) || (da > EPS && db < -EPS)) {
        const t = da / (da - db);
        const p = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
        out.push(p); cut.push(p);
      }
    }
    if (out.length >= 3) faces.push({ verts: out, n: f.n, d: f.d, kind: f.kind, nb: f.nb });
  }
  // cap face
  const uniq = [];
  for (const p of cut) if (!uniq.some((q) => dist2(p, q) < 1e-12)) uniq.push(p);
  if (uniq.length >= 3) {
    const c = uniq.reduce((s, p) => add(s, p), [0, 0, 0]).map((x) => x / uniq.length);
    const ref = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    const u = norm(cross(n, ref)), w = cross(n, u);
    uniq.sort((p, q) => {
      const a = sub(p, c), b = sub(q, c);
      return Math.atan2(dot(a, w), dot(a, u)) - Math.atan2(dot(b, w), dot(b, u));
    });
    faces.push({ verts: uniq, n, d, kind, nb });
  }
  return { faces };
}

function polyMaxR2(poly, s) {
  let m = 0;
  for (const f of poly.faces) for (const v of f.verts) m = Math.max(m, dist2(v, s));
  return m;
}

export function polyCentroidVolume(poly) {
  // fan-tetrahedralise from vertex average
  let c0 = [0, 0, 0], k = 0;
  for (const f of poly.faces) for (const v of f.verts) { c0 = add(c0, v); k++; }
  c0 = scale(c0, 1 / Math.max(k, 1));
  let vol = 0, cx = 0, cy = 0, cz = 0;
  for (const f of poly.faces) {
    const v0 = f.verts[0];
    for (let i = 1; i < f.verts.length - 1; i++) {
      const a = f.verts[i], b = f.verts[i + 1];
      const tv = Math.abs(dot(sub(v0, c0), cross(sub(a, c0), sub(b, c0)))) / 6;
      vol += tv;
      cx += tv * (c0[0] + v0[0] + a[0] + b[0]) / 4;
      cy += tv * (c0[1] + v0[1] + a[1] + b[1]) / 4;
      cz += tv * (c0[2] + v0[2] + a[2] + b[2]) / 4;
    }
  }
  if (vol <= 0) return { centroid: c0, volume: 0 };
  return { centroid: [cx / vol, cy / vol, cz / vol], volume: vol };
}

function polyBBox(poly) {
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (const f of poly.faces) for (const v of f.verts) for (let k = 0; k < 3; k++) {
    if (v[k] < mn[k]) mn[k] = v[k];
    if (v[k] > mx[k]) mx[k] = v[k];
  }
  return { min: mn, max: mx };
}

// Base polyhedron for a boundary
export function boundaryPoly(bnd) {
  const c = scale(add(bnd.bmin, bnd.bmax), 0.5);
  const half = scale(sub(bnd.bmax, bnd.bmin), 0.75);
  let poly = boxPoly(sub(c, half), add(c, half));
  for (const pl of bnd.planes) poly = clipPoly(poly, pl.n, pl.d, 'B', pl.id);
  return poly;
}

// Voronoi cells of `seeds` clipped to `basePoly`.
export function computeCells(seeds, basePoly) {
  const N = seeds.length;
  const cells = [];
  for (let i = 0; i < N; i++) {
    const s = seeds[i];
    const order = [];
    for (let j = 0; j < N; j++) if (j !== i) order.push([dist2(s, seeds[j]), j]);
    order.sort((a, b) => a[0] - b[0]);
    let poly = basePoly;
    let R2 = polyMaxR2(poly, s);
    for (const [d2, j] of order) {
      if (d2 > 4 * R2 + 1e-9) break;
      if (d2 < 1e-12) continue; // coincident seeds
      const t = seeds[j];
      const n = norm(sub(t, s));
      const d = dot(n, scale(add(s, t), 0.5));
      const np = clipPoly(poly, n, d, 'C', j);
      if (np !== poly) { poly = np; R2 = polyMaxR2(poly, s); }
      if (!poly.faces.length) break;
    }
    const { centroid, volume } = polyCentroidVolume(poly);
    cells.push({ index: i, seed: s, faces: poly.faces, centroid, volume, bbox: polyBBox(poly) });
  }
  return cells;
}

// ---------------------------------------------------------------- seeds / lattices
function remap(t, g) { // density gradient on normalised coordinate
  if (!g) return t;
  const e = Math.pow(2, g * 1.6);
  return Math.pow(Math.min(Math.max(t, 0), 1), e);
}

export function makeSeeds(P, bnd) {
  const rnd = mulberry32(P.seed * 9973 + 17);
  const mn = bnd.bmin, mx = bnd.bmax, sz = sub(mx, mn);
  const ax = { x: 0, y: 1, z: 2 }[P.gradAxis] ?? 2;
  const toWorld = (u) => {
    const uu = u.slice();
    uu[ax] = remap(uu[ax], P.gradient);
    return [mn[0] + uu[0] * sz[0], mn[1] + uu[1] * sz[1], mn[2] + uu[2] * sz[2]];
  };
  const pts = [];
  const L = P.lattice;
  const inset = 0.002;
  if (L === 'random') {
    let guard = 0;
    while (pts.length < P.count && guard++ < P.count * 400) {
      const p = toWorld([rnd(), rnd(), rnd()]);
      if (bnd.inside(p, inset * len(sz))) pts.push(p);
    }
  } else {
    const nx = P.nx, ny = P.ny, nz = P.nz;
    const raw = [];
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      let u = (i + 0.5) / nx, v = (j + 0.5) / ny, w = (k + 0.5) / nz;
      if (L === 'hex' || L === 'stagger') {
        if (j % 2) u += 0.5 / nx;
        if (L === 'stagger' && k % 2) { u += 0.25 / nx; v += 0.5 / ny; }
        u = (u - 0.5) * (nx / (nx + 0.5)) + 0.5;
      }
      raw.push([u, v, w, 1 / nx, 1 / ny, 1 / nz]);
      if (L === 'bcc' && i < nx - 1 && j < ny - 1 && k < nz - 1) {
        raw.push([(i + 1) / nx, (j + 1) / ny, (k + 1) / nz, 1 / nx, 1 / ny, 1 / nz]);
      }
    }
    for (const r of raw) {
      const u = [
        r[0] + (rnd() - 0.5) * P.jitter * r[3],
        r[1] + (rnd() - 0.5) * P.jitter * r[4],
        r[2] + (rnd() - 0.5) * P.jitter * r[5],
      ];
      const p = toWorld(u);
      if (bnd.inside(p, inset * len(sz))) pts.push(p);
    }
  }
  return pts;
}

// Seeds inside a convex polyhedron (for subdivision)
function seedsInPoly(poly, bbox, k, rnd) {
  const pts = [];
  let guard = 0;
  const inside = (p) => poly.faces.every((f) => dot(f.n, p) <= f.d - 1e-6);
  while (pts.length < k && guard++ < k * 500) {
    const p = [0, 1, 2].map((a) => bbox.min[a] + rnd() * (bbox.max[a] - bbox.min[a]));
    if (inside(p)) pts.push(p);
  }
  return pts;
}

export function relaxSeeds(seeds, basePoly, iters) {
  let s = seeds;
  let cells = null;
  for (let it = 0; it < iters; it++) {
    cells = computeCells(s, basePoly);
    s = cells.map((c) => (c.volume > 0 ? c.centroid : c.seed));
  }
  return s;
}

// ---------------------------------------------------------------- edges & graph
class Welder {
  constructor(tol) { this.tol = tol; this.map = new Map(); this.pts = []; }
  key(i, j, k) { return i + ',' + j + ',' + k; }
  add(p) {
    const t = this.tol;
    const i = Math.round(p[0] / t), j = Math.round(p[1] / t), k = Math.round(p[2] / t);
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let c = -1; c <= 1; c++) {
      const l = this.map.get(this.key(i + a, j + b, k + c));
      if (l) for (const id of l) if (dist2(this.pts[id], p) <= t * t) return id;
    }
    const id = this.pts.length;
    this.pts.push(p);
    const kk = this.key(i, j, k);
    if (!this.map.has(kk)) this.map.set(kk, []);
    this.map.get(kk).push(id);
    return id;
  }
}

/**
 * Build a strut graph from cells.
 * opts.level   : 1 primary, 2 secondary
 * opts.include : (face) => boolean   which faces contribute edges
 * opts.cellOk  : (cell) => boolean   which cells participate
 */
export function buildGraph(groups, tol, seamOnly = false, creaseDeg = 40) {
  const W = new Welder(tol);
  const edges = new Map();
  for (const g of groups) {
    for (const cell of g.cells) {
      if (g.cellOk && !g.cellOk(cell)) continue;
      for (const f of cell.faces) {
        if (!g.include(f, cell)) continue;
        const vs = f.verts;
        for (let i = 0; i < vs.length; i++) {
          const a = W.add(vs[i]), b = W.add(vs[(i + 1) % vs.length]);
          if (a === b) continue;
          const key = a < b ? a + '_' + b : b + '_' + a;
          let e = edges.get(key);
          if (!e) { e = { a: Math.min(a, b), b: Math.max(a, b), level: g.level, cells: new Set(), normals: [] }; edges.set(key, e); }
          e.level = Math.min(e.level, g.level);
          e.cells.add(g.level * 100000 + cell.index);
          if (seamOnly) e.normals.push(f.n);
        }
      }
    }
  }
  // seam mode: keep only edges where faces of two different cells meet
  // ...or where the outer surface folds sharply (box edges, cylinder rims) — not shallow facet joints
  const cosC = Math.cos((creaseDeg * Math.PI) / 180);
  const crease = (e) => {
    for (let i = 0; i < e.normals.length; i++) for (let j = i + 1; j < e.normals.length; j++) if (dot(e.normals[i], e.normals[j]) < cosC) return true;
    return false;
  };
  const kept = seamOnly ? [...edges.values()].filter((e) => e.cells.size >= 2 || (creaseDeg < 180 && crease(e))) : [...edges.values()];
  const list = kept.map((e) => ({ a: e.a, b: e.b, level: e.level, length: Math.sqrt(dist2(W.pts[e.a], W.pts[e.b])) }));
  const valence = new Array(W.pts.length).fill(0);
  for (const e of list) { valence[e.a]++; valence[e.b]++; }
  return { nodes: W.pts, edges: list, valence };
}

// ---------------------------------------------------------------- full pipeline (cells stage)
export function buildCells(P) {
  const bnd = makeBoundary(P);
  const base = boundaryPoly(bnd);
  let seeds = makeSeeds(P, bnd);
  if (seeds.length < 1) seeds = [scale(add(bnd.bmin, bnd.bmax), 0.5)];
  if (P.relax > 0) seeds = relaxSeeds(seeds, base, P.relax);
  const cells = computeCells(seeds, base);

  // activity: random cull + manual toggles
  const rc = mulberry32(P.seed * 31 + 7 + Math.round(P.cull * 1000));
  const disabled = new Set(P.disabled || []);
  for (const c of cells) {
    const culled = rc() < P.cull;
    // manual toggle flips the procedural state (so a culled cell can be revived by clicking it)
    c.active = !culled !== disabled.has(c.index);
  }

  // subdivision
  let subCells = [];
  if (P.subdiv > 0) {
    const rs = mulberry32(P.subSeed * 7919 + 3);
    for (const c of cells) {
      if (!c.active) continue;
      const parent = { faces: c.faces.map((f) => ({ ...f, kind: 'P', pkind: f.kind, nb: f.nb })) };
      let ss = seedsInPoly(parent, c.bbox, P.subdiv + 1, rs);
      if (ss.length < 2) continue;
      if (P.subRelax > 0) ss = relaxSeeds(ss, parent, P.subRelax);
      const sc = computeCells(ss, parent);
      sc.forEach((s, k) => { s.parent = c.index; s.index = c.index * 1000 + k; s.active = true; });
      subCells.push(...sc);
    }
  }

  const sizeRef = len(sub(bnd.bmax, bnd.bmin));
  const tol = sizeRef * 1e-5;
  const topo = P.frameTopology || 'walls';
  let graph;
  if (topo === 'surface') {
    // Only the seams between neighbouring cushions on the outer surface of the (active) cluster:
    // skin faces, plus walls exposed by culled neighbours. Facet edges within one cell are dropped.
    const byIndex = new Map(cells.map((c) => [c.index, c]));
    const exposed = (f) => f.kind === 'B' || (f.kind === 'C' && !(byIndex.get(f.nb)?.active));
    const groups = [{ level: 1, cells, cellOk: (c) => c.active, include: exposed }];
    if (subCells.length) {
      groups.push({ level: 2, cells: subCells, include: (f) => f.kind === 'P' && (f.pkind === 'B' || (f.pkind === 'C' && !(byIndex.get(f.nb)?.active))) });
    }
    graph = buildGraph(groups, tol, true, P.outerEdges === false ? 180 : (P.creaseAngle ?? 40));
  } else {
    const cellOk = P.frameScope === 'active' ? (c) => c.active : null;
    const groups = [{
      level: 1, cells,
      cellOk,
      include: (f) => (f.kind === 'C' ? true : f.kind === 'B' ? (P.skinEdges || topo === 'cage') : false),
    }];
    if (subCells.length) groups.push({ level: 2, cells: subCells, include: (f) => f.kind === 'C' });
    graph = buildGraph(groups, tol);
  }
  // skin flags (before smoothing moves nodes off the boundary planes)
  const onSkin = (p) => bnd.planes.some((pl) => Math.abs(dot(pl.n, p) - pl.d) < tol * 20);
  graph.skinNode = graph.nodes.map((n) => topo === 'surface' || onSkin(n));
  graph.skinEdge = graph.edges.map((e) => topo === 'surface' || (graph.skinNode[e.a] && graph.skinNode[e.b] &&
    onSkin(scale(add(graph.nodes[e.a], graph.nodes[e.b]), 0.5))));
  if (P.cordSmooth > 0) smoothCords(graph, P.cordSmooth);
  return { boundary: bnd, seeds, cells, subCells, graph };
}

// Independent blob cells (own seed field, same boundary)
export function buildBlobCells(P, bnd) {
  const base = boundaryPoly(bnd);
  const Q = { ...P, lattice: P.blobLattice, count: P.blobCount, seed: P.blobSeed, jitter: P.blobJitter ?? 0.6, gradient: 0 };
  let seeds = makeSeeds(Q, bnd);
  if (P.blobRelax > 0) seeds = relaxSeeds(seeds, base, P.blobRelax);
  const cells = computeCells(seeds, base);
  cells.forEach((c) => (c.active = true));
  return cells;
}

// Relax chains of valence-2 nodes (Laplacian), keeping junctions fixed: faceted seams become calm curves.
function smoothCords(graph, iters) {
  const nb = graph.nodes.map(() => []);
  for (const e of graph.edges) { nb[e.a].push(e.b); nb[e.b].push(e.a); }
  let P = graph.nodes.map((p) => p.slice());
  for (let it = 0; it < iters * 4; it++) {
    const Q = P.map((p) => p.slice());
    for (let i = 0; i < P.length; i++) {
      if (nb[i].length !== 2) continue;
      const a = P[nb[i][0]], b = P[nb[i][1]];
      for (let k = 0; k < 3; k++) Q[i][k] = 0.5 * P[i][k] + 0.25 * (a[k] + b[k]);
    }
    P = Q;
  }
  graph.nodes = P;
  for (const e of graph.edges) e.length = Math.sqrt(dist2(P[e.a], P[e.b]));
}
