// Frame/Blob — Naive Surface Nets + Taubin smoothing + field-gradient normals
import { sampleField } from './field.js';

const CORNERS = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]];
const EDGES = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];

// Per-mask surface patches. Inside corners connect through cube edges only (diagonal inside corners
// on a face stay separate); outside corners connect through edges AND across such ambiguous faces.
// A patch = (inside component, outside component) pair; one vertex per patch makes the quad mesh a
// clean 2-manifold, and neighbouring voxels agree because the face rule is symmetric.
const FACES = [[0, 1, 3, 2], [4, 5, 7, 6], [0, 1, 5, 4], [2, 3, 7, 6], [0, 2, 6, 4], [1, 3, 7, 5]];
const PATCH = (() => {
  const tab = new Int8Array(256 * 64).fill(-1), cnt = new Uint8Array(256);
  for (let m = 1; m < 255; m++) {
    const par = [0, 1, 2, 3, 4, 5, 6, 7];
    const find = (x) => (par[x] === x ? x : (par[x] = find(par[x])));
    const uni = (a, b) => (par[find(a)] = find(b));
    const ins = (c) => (m >> c) & 1;
    for (const [a, b] of EDGES) if (ins(a) === ins(b)) uni(a, b);
    for (const [c0, c1, c2, c3] of FACES) {
      // ambiguous face: c0,c2 one sign, c1,c3 the other → join the OUTSIDE diagonal
      if (ins(c0) === ins(c2) && ins(c1) === ins(c3) && ins(c0) !== ins(c1)) {
        if (!ins(c0)) uni(c0, c2); else uni(c1, c3);
      }
    }
    const ids = new Map();
    for (const [a, b] of EDGES) {
      if (ins(a) === ins(b)) continue;
      const i = ins(a) ? a : b, o = ins(a) ? b : a;
      const key = find(i) * 8 + find(o);
      if (!ids.has(key)) ids.set(key, ids.size);
      tab[m * 64 + i * 8 + o] = ids.get(key);
    }
    cnt[m] = ids.size;
  }
  return { tab, cnt };
})();

export function surfaceNets(F, g) {
  const [nx, ny, nz] = g.dims, sxy = nx * ny, h = g.h, o = g.origin;
  const vstart = new Int32Array(nx * ny * nz).fill(-1);
  const masks = new Uint8Array(nx * ny * nz);
  const pos = [];
  const off = CORNERS.map((c) => c[0] + c[1] * nx + c[2] * sxy);
  const v = new Float64Array(8);
  let acc = new Float64Array(4 * 6); // per patch (x, y, z, n)
  for (let z = 0; z < nz - 1; z++) for (let y = 0; y < ny - 1; y++) {
    let base = nx * y + sxy * z;
    for (let x = 0; x < nx - 1; x++, base++) {
      let mask = 0;
      for (let c = 0; c < 8; c++) { v[c] = F[base + off[c]]; if (v[c] < 0) mask |= 1 << c; }
      if (mask === 0 || mask === 255) continue;
      masks[base] = mask;
      const nc = PATCH.cnt[mask];
      if (acc.length < 4 * nc) acc = new Float64Array(4 * nc);
      acc.fill(0);
      for (const [a, b] of EDGES) {
        const ia = (mask >> a) & 1, ib = (mask >> b) & 1;
        if (ia === ib) continue;
        const k = PATCH.tab[mask * 64 + (ia ? a * 8 + b : b * 8 + a)];
        const t = v[a] / (v[a] - v[b]);
        const A = CORNERS[a], B = CORNERS[b];
        acc[4 * k] += A[0] + (B[0] - A[0]) * t; acc[4 * k + 1] += A[1] + (B[1] - A[1]) * t; acc[4 * k + 2] += A[2] + (B[2] - A[2]) * t; acc[4 * k + 3]++;
      }
      vstart[base] = pos.length / 3;
      for (let k = 0; k < nc; k++) {
        const n = acc[4 * k + 3] || 1;
        pos.push(o[0] + h * (x + acc[4 * k] / n), o[1] + h * (y + acc[4 * k + 1] / n), o[2] + h * (z + acc[4 * k + 2] / n));
      }
    }
  }
  const qd = [];
  // vertex of cube `cb` (min corner cx,cy,cz) for the patch crossing grid edge inside (ax,ay,az) → outside (bx,by,bz)
  const vert = (cb, cx, cy, cz, ax, ay, az, bx, by, bz) => {
    if (cb < 0 || vstart[cb] < 0) return -1;
    const ci = (ax - cx) + 2 * (ay - cy) + 4 * (az - cz), co = (bx - cx) + 2 * (by - cy) + 4 * (bz - cz);
    const l = PATCH.tab[masks[cb] * 64 + ci * 8 + co];
    return l < 0 ? -1 : vstart[cb] + l;
  };
  const emit = (q, flip) => {
    if (q[0] < 0 || q[1] < 0 || q[2] < 0 || q[3] < 0) return;
    if (flip) qd.push(q[0], q[3], q[2], q[1]); else qd.push(q[0], q[1], q[2], q[3]);
  };
  for (let z = 1; z < nz - 1; z++) for (let y = 1; y < ny - 1; y++) {
    let base = 1 + nx * y + sxy * z;
    for (let x = 1; x < nx - 1; x++, base++) {
      const a0 = F[base] < 0;
      // x-edge: cubes (y-1,z-1) (y,z-1) (y,z) (y-1,z)
      if (a0 !== (F[base + 1] < 0)) {
        const ax = a0 ? x : x + 1, bx = a0 ? x + 1 : x;
        emit([vert(base - nx - sxy, x, y - 1, z - 1, ax, y, z, bx, y, z), vert(base - sxy, x, y, z - 1, ax, y, z, bx, y, z), vert(base, x, y, z, ax, y, z, bx, y, z), vert(base - nx, x, y - 1, z, ax, y, z, bx, y, z)], !a0);
      }
      // y-edge: cubes (z-1,x-1) (z,x-1) (z,x) (z-1,x)
      if (a0 !== (F[base + nx] < 0)) {
        const ay = a0 ? y : y + 1, by = a0 ? y + 1 : y;
        emit([vert(base - sxy - 1, x - 1, y, z - 1, x, ay, z, x, by, z), vert(base - 1, x - 1, y, z, x, ay, z, x, by, z), vert(base, x, y, z, x, ay, z, x, by, z), vert(base - sxy, x, y, z - 1, x, ay, z, x, by, z)], !a0);
      }
      // z-edge: cubes (x-1,y-1) (x,y-1) (x,y) (x-1,y)
      if (a0 !== (F[base + sxy] < 0)) {
        const az = a0 ? z : z + 1, bz = a0 ? z + 1 : z;
        emit([vert(base - 1 - nx, x - 1, y - 1, z, x, y, az, x, y, bz), vert(base - nx, x, y - 1, z, x, y, az, x, y, bz), vert(base, x, y, z, x, y, az, x, y, bz), vert(base - 1, x - 1, y, z, x, y, az, x, y, bz)], !a0);
      }
    }
  }
  return { positions: new Float32Array(pos), quads: new Uint32Array(qd) };
}

export function quadsToTris(Q) {
  const T = new Uint32Array((Q.length / 4) * 6);
  for (let i = 0, j = 0; i < Q.length; i += 4, j += 6) {
    T[j] = Q[i]; T[j + 1] = Q[i + 1]; T[j + 2] = Q[i + 2];
    T[j + 3] = Q[i]; T[j + 4] = Q[i + 2]; T[j + 5] = Q[i + 3];
  }
  return T;
}

// Unique quad edges (for a SubD-style wire overlay). Consistently oriented
// manifold meshes list every interior edge once as (a,b) and once as (b,a).
export function quadEdges(Q) {
  const out = [];
  for (let i = 0; i < Q.length; i += 4) {
    for (let k = 0; k < 4; k++) {
      const a = Q[i + k], b = Q[i + ((k + 1) & 3)];
      if (a < b) out.push(a, b);
    }
  }
  return new Uint32Array(out);
}

/**
 * Catmull–Clark subdivision on a quad mesh (typed arrays).
 * Rules follow Minimal_Surface_Atlas_3/src/catmullClark.ts:
 *  face point = average of face; edge point = avg(ends + adjacent face points) (midpoint on boundary);
 *  interior vertex = (F + 2R + (n-3)P) / n ; boundary vertex = (6P + Σ boundary neighbours) / (6 + k)
 */
export function catmullClark(V, Q, levels) {
  for (let L = 0; L < levels; L++) ({ V, Q } = ccOnce(V, Q));
  return { V, Q };
}

function ccOnce(V, Q) {
  const n = V.length / 3, m = Q.length / 4;
  // face points
  const FP = new Float64Array(m * 3);
  for (let f = 0; f < m; f++) {
    for (let k = 0; k < 4; k++) { const v = Q[4 * f + k] * 3; FP[3 * f] += V[v]; FP[3 * f + 1] += V[v + 1]; FP[3 * f + 2] += V[v + 2]; }
    FP[3 * f] *= 0.25; FP[3 * f + 1] *= 0.25; FP[3 * f + 2] *= 0.25;
  }
  // edges
  const emap = new Map();
  const eA = [], eB = [], eFc = [], eFs = []; // face count, face-point sums (flattened later)
  const eFsum = [];
  const QE = new Uint32Array(m * 4); // edge index per quad side (k: v[k]→v[k+1])
  for (let f = 0; f < m; f++) for (let k = 0; k < 4; k++) {
    const a = Q[4 * f + k], b = Q[4 * f + ((k + 1) & 3)];
    const lo = a < b ? a : b, hi = a < b ? b : a;
    const key = lo * n + hi;
    let e = emap.get(key);
    if (e === undefined) { e = eA.length; emap.set(key, e); eA.push(lo); eB.push(hi); eFc.push(0); eFsum.push(0, 0, 0); }
    eFc[e]++;
    eFsum[3 * e] += FP[3 * f]; eFsum[3 * e + 1] += FP[3 * f + 1]; eFsum[3 * e + 2] += FP[3 * f + 2];
    QE[4 * f + k] = e;
  }
  const E = eA.length;
  // per-vertex accumulators
  const fSum = new Float64Array(n * 3), fCnt = new Uint32Array(n);
  const rSum = new Float64Array(n * 3), rCnt = new Uint32Array(n);
  const bSum = new Float64Array(n * 3), bCnt = new Uint32Array(n);
  for (let f = 0; f < m; f++) for (let k = 0; k < 4; k++) {
    const v = Q[4 * f + k];
    fSum[3 * v] += FP[3 * f]; fSum[3 * v + 1] += FP[3 * f + 1]; fSum[3 * v + 2] += FP[3 * f + 2]; fCnt[v]++;
  }
  for (let e = 0; e < E; e++) {
    const a = eA[e], b = eB[e];
    const mx = (V[3 * a] + V[3 * b]) / 2, my = (V[3 * a + 1] + V[3 * b + 1]) / 2, mz = (V[3 * a + 2] + V[3 * b + 2]) / 2;
    for (const v of [a, b]) { rSum[3 * v] += mx; rSum[3 * v + 1] += my; rSum[3 * v + 2] += mz; rCnt[v]++; }
    if (eFc[e] === 1) {
      bSum[3 * a] += V[3 * b]; bSum[3 * a + 1] += V[3 * b + 1]; bSum[3 * a + 2] += V[3 * b + 2]; bCnt[a]++;
      bSum[3 * b] += V[3 * a]; bSum[3 * b + 1] += V[3 * a + 1]; bSum[3 * b + 2] += V[3 * a + 2]; bCnt[b]++;
    }
  }
  const N = n + E + m;
  const out = new Float32Array(N * 3);
  for (let v = 0; v < n; v++) {
    const px = V[3 * v], py = V[3 * v + 1], pz = V[3 * v + 2];
    if (!fCnt[v] || !rCnt[v]) { out[3 * v] = px; out[3 * v + 1] = py; out[3 * v + 2] = pz; continue; }
    if (bCnt[v]) {
      const w = 1 / (6 + bCnt[v]);
      out[3 * v] = (6 * px + bSum[3 * v]) * w; out[3 * v + 1] = (6 * py + bSum[3 * v + 1]) * w; out[3 * v + 2] = (6 * pz + bSum[3 * v + 2]) * w;
      continue;
    }
    const val = fCnt[v];
    for (let c = 0; c < 3; c++) {
      const F = fSum[3 * v + c] / fCnt[v], R = rSum[3 * v + c] / rCnt[v], Pc = V[3 * v + c];
      out[3 * v + c] = (F + 2 * R + (val - 3) * Pc) / val;
    }
  }
  for (let e = 0; e < E; e++) {
    const a = eA[e], b = eB[e], o = 3 * (n + e), c = eFc[e];
    if (c >= 2) {
      const w = 1 / (2 + c);
      for (let k = 0; k < 3; k++) out[o + k] = (V[3 * a + k] + V[3 * b + k] + eFsum[3 * e + k]) * w;
    } else for (let k = 0; k < 3; k++) out[o + k] = (V[3 * a + k] + V[3 * b + k]) / 2;
  }
  for (let f = 0; f < m; f++) { const o = 3 * (n + E + f); out[o] = FP[3 * f]; out[o + 1] = FP[3 * f + 1]; out[o + 2] = FP[3 * f + 2]; }
  // new quads (same winding as Atlas: [v, e(v→next), f, e(prev→v)])
  const NQ = new Uint32Array(m * 16);
  for (let f = 0; f < m; f++) {
    const fp = n + E + f;
    for (let k = 0; k < 4; k++) {
      const v = Q[4 * f + k];
      const eNext = n + QE[4 * f + k];
      const ePrev = n + QE[4 * f + ((k + 3) & 3)];
      const o = 16 * f + 4 * k;
      NQ[o] = v; NQ[o + 1] = eNext; NQ[o + 2] = fp; NQ[o + 3] = ePrev;
    }
  }
  return { V: out, Q: NQ };
}

export function taubin(positions, indices, iters, lambda = 0.55, mu = -0.58) {
  if (!iters) return positions;
  const n = positions.length / 3;
  // adjacency (CSR)
  const deg = new Uint32Array(n);
  for (let i = 0; i < indices.length; i += 3) {
    deg[indices[i]] += 2; deg[indices[i + 1]] += 2; deg[indices[i + 2]] += 2;
  }
  const start = new Uint32Array(n + 1);
  for (let i = 0; i < n; i++) start[i + 1] = start[i] + deg[i];
  const nbr = new Uint32Array(start[n]);
  const fill = start.slice(0, n);
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i], b = indices[i + 1], c = indices[i + 2];
    nbr[fill[a]++] = b; nbr[fill[a]++] = c;
    nbr[fill[b]++] = a; nbr[fill[b]++] = c;
    nbr[fill[c]++] = a; nbr[fill[c]++] = b;
  }
  let P = positions, Q = new Float32Array(positions.length);
  const step = (src, dst, f) => {
    for (let i = 0; i < n; i++) {
      const s = start[i], e = start[i + 1];
      if (e === s) { dst[3 * i] = src[3 * i]; dst[3 * i + 1] = src[3 * i + 1]; dst[3 * i + 2] = src[3 * i + 2]; continue; }
      let x = 0, y = 0, z = 0;
      for (let k = s; k < e; k++) { const j = nbr[k]; x += src[3 * j]; y += src[3 * j + 1]; z += src[3 * j + 2]; }
      const c = e - s;
      dst[3 * i] = src[3 * i] + f * (x / c - src[3 * i]);
      dst[3 * i + 1] = src[3 * i + 1] + f * (y / c - src[3 * i + 1]);
      dst[3 * i + 2] = src[3 * i + 2] + f * (z / c - src[3 * i + 2]);
    }
  };
  P = new Float32Array(positions);
  for (let it = 0; it < iters; it++) { step(P, Q, lambda); step(Q, P, mu); }
  return P;
}

export function gradientNormals(positions, F, g) {
  const n = positions.length / 3, N = new Float32Array(positions.length), e = g.h * 0.5;
  for (let i = 0; i < n; i++) {
    const x = positions[3 * i], y = positions[3 * i + 1], z = positions[3 * i + 2];
    let gx = sampleField(F, g, x + e, y, z) - sampleField(F, g, x - e, y, z);
    let gy = sampleField(F, g, x, y + e, z) - sampleField(F, g, x, y - e, z);
    let gz = sampleField(F, g, x, y, z + e) - sampleField(F, g, x, y, z - e);
    const l = Math.hypot(gx, gy, gz) || 1;
    N[3 * i] = gx / l; N[3 * i + 1] = gy / l; N[3 * i + 2] = gz / l;
  }
  return N;
}

export function meshVolume(positions, indices) {
  let v = 0;
  for (let i = 0; i < indices.length; i += 3) {
    const a = 3 * indices[i], b = 3 * indices[i + 1], c = 3 * indices[i + 2];
    const ax = positions[a], ay = positions[a + 1], az = positions[a + 2];
    const bx = positions[b], by = positions[b + 1], bz = positions[b + 2];
    const cx = positions[c], cy = positions[c + 1], cz = positions[c + 2];
    v += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  }
  return v / 6;
}

export function meshArea(positions, indices) {
  let s = 0;
  for (let i = 0; i < indices.length; i += 3) {
    const a = 3 * indices[i], b = 3 * indices[i + 1], c = 3 * indices[i + 2];
    const ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a], vy = positions[c + 1] - positions[a + 1], vz = positions[c + 2] - positions[a + 2];
    s += 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
  }
  return s;
}

// Full mesh from a field: nets → (Taubin | Catmull–Clark) → normals (orientation self-checked)
// opts: { smooth, mode: 'voxel'|'subd', levels, maxQuads }
export function polygonise(F, g, opts) {
  const o = typeof opts === 'number' ? { smooth: opts, mode: 'voxel', levels: 0 } : opts;
  let { positions, quads } = surfaceNets(F, g);
  let pos = positions, Q = quads;
  let levels = 0, cage;
  if (o.mode === 'subd') {
    // light pre-relax removes voxel stair-steps, then true SubD smoothing
    if (o.smooth) pos = taubin(pos, quadsToTris(Q), Math.min(o.smooth, 2));
    cage = { positions: pos, quads: Q };
    levels = o.levels | 0;
    const maxQ = o.maxQuads || 1.2e6;
    while (levels > 0 && (Q.length / 4) * Math.pow(4, levels) > maxQ) levels--;
    if (levels) ({ V: pos, Q } = catmullClark(pos, Q, levels));
  } else {
    pos = taubin(pos, quadsToTris(Q), o.smooth);
  }
  if (!cage) cage = { positions: pos, quads: Q };
  const normals = gradientNormals(pos, F, g);
  // make winding agree with outward gradient
  if (Q.length >= 4) {
    let agree = 0;
    const tests = Math.min(Q.length / 4, 200);
    for (let t = 0; t < tests; t++) {
      const i = Math.floor((t / tests) * (Q.length / 4)) * 4;
      const a = 3 * Q[i], b = 3 * Q[i + 1], c = 3 * Q[i + 2];
      const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
      const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      agree += nx * normals[a] + ny * normals[a + 1] + nz * normals[a + 2] > 0 ? 1 : -1;
    }
    const flip = (A) => { for (let i = 0; i < A.length; i += 4) { const t = A[i + 1]; A[i + 1] = A[i + 3]; A[i + 3] = t; } };
    if (agree < 0) { flip(Q); if (cage.quads !== Q) flip(cage.quads); }
  }
  return { positions: pos, normals, indices: quadsToTris(Q), wire: quadEdges(Q), levels, quads: Q, cage };
}

// ---------------------------------------------------------------- swept cords
// Decompose a strut graph into chains between junctions (valence ≠ 2), run a Catmull–Rom spline
// through each chain and sweep a circular section with parallel-transport frames. Junctions get
// spheres. Exact radius at any resolution: used for thin cords, where voxels would break them.
// Spline-sampled cord chains + junction list (shared by the tube mesh and the print-ready fused frame)
export function cordChains(graph, radiusFor, { step = 1, nodeScale = 1 } = {}) {
  const N = graph.nodes, nb = N.map(() => []);
  graph.edges.forEach((e, i) => { nb[e.a].push([e.b, i]); nb[e.b].push([e.a, i]); });
  const used = new Uint8Array(graph.edges.length);
  const raw = [];
  const walk = (start, first) => {
    const pts = [start]; let [cur, ei] = first; used[ei] = 1;
    const level = graph.edges[ei].level;
    while (true) {
      pts.push(cur);
      if (nb[cur].length !== 2 || cur === start) break;
      const nx = nb[cur].find(([, j]) => !used[j]);
      if (!nx) break;
      used[nx[1]] = 1; [cur] = nx;
    }
    raw.push({ pts, level });
  };
  N.forEach((_, i) => { if (nb[i].length !== 2) for (const f of nb[i]) if (!used[f[1]]) walk(i, f); });
  N.forEach((_, i) => { for (const f of nb[i]) if (!used[f[1]]) walk(i, f); }); // closed loops
  const crs = (p0, p1, p2, p3, t) => {
    const t2 = t * t, t3 = t2 * t;
    return [0, 1, 2].map((k) => 0.5 * (2 * p1[k] + (-p0[k] + p2[k]) * t + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * t2 + (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * t3));
  };
  const chains = [];
  for (const ch of raw) {
    const r = radiusFor(ch.level);
    if (r <= 0 || ch.pts.length < 2) continue;
    const c = ch.pts.map((i) => N[i]);
    const S = [];
    for (let i = 0; i < c.length - 1; i++) {
      const p0 = c[Math.max(i - 1, 0)], p1 = c[i], p2 = c[i + 1], p3 = c[Math.min(i + 2, c.length - 1)];
      const L = Math.hypot(p2[0] - p1[0], p2[1] - p1[1], p2[2] - p1[2]);
      const n = Math.max(1, Math.ceil(L / (step * r * 1.5)));
      for (let s2 = 0; s2 < n; s2++) S.push(crs(p0, p1, p2, p3, s2 / n));
    }
    S.push(c[c.length - 1]);
    if (S.length >= 2) chains.push({ S, r, level: ch.level });
  }
  const junctions = [];
  N.forEach((p, i) => {
    if (nb[i].length === 2 || !nb[i].length) return;
    const lvl = Math.min(...nb[i].map(([, j]) => graph.edges[j].level));
    junctions.push({ p, r: radiusFor(lvl) * Math.max(1.02, nodeScale), level: lvl, valence: nb[i].length });
  });
  return { chains, junctions };
}

// Swept tube cords: parallel-transport frames along each spline chain, spheres at junctions.
// Tubes are quads (for SubD export); sphere caps are triangles.
export function cordMesh(graph, radiusFor, { sides = 10, step = 1, nodeScale = 1 } = {}) {
  const { chains, junctions } = cordChains(graph, radiusFor, { step, nodeScale });
  const P = [], Nm = [], I = [], QD = [];
  for (const { S, r } of chains) {
    const T = S.map((p, i) => { const a = S[Math.max(i - 1, 0)], b = S[Math.min(i + 1, S.length - 1)]; const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]; const l = Math.hypot(...d) || 1; return d.map((x) => x / l); });
    const n0 = Math.abs(T[0][2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
    let u = nrm(cross3(T[0], n0)), w = cross3(T[0], u);
    const base = P.length / 3;
    for (let i = 0; i < S.length; i++) {
      if (i > 0) {
        const t = T[i];
        const d = u[0] * t[0] + u[1] * t[1] + u[2] * t[2];
        u = nrm([u[0] - d * t[0], u[1] - d * t[1], u[2] - d * t[2]]);
        w = cross3(t, u);
      }
      for (let k = 0; k < sides; k++) {
        const an = (k / sides) * Math.PI * 2, ca = Math.cos(an), sa = Math.sin(an);
        const nn = [u[0] * ca + w[0] * sa, u[1] * ca + w[1] * sa, u[2] * ca + w[2] * sa];
        P.push(S[i][0] + nn[0] * r, S[i][1] + nn[1] * r, S[i][2] + nn[2] * r);
        Nm.push(...nn);
      }
    }
    for (let i = 0; i < S.length - 1; i++) for (let k = 0; k < sides; k++) {
      const a = base + i * sides + k, b = base + i * sides + ((k + 1) % sides), c2 = a + sides, d = b + sides;
      I.push(a, b, c2, b, d, c2); // outward winding (u, w=T×u right-handed)
      QD.push(a, b, d, c2);
    }
  }
  const sph = sphere(8, 12);
  const TR = [];
  for (const { p, r } of junctions) {
    const base = P.length / 3;
    for (let k = 0; k < sph.p.length; k += 3) { P.push(p[0] + sph.p[k] * r, p[1] + sph.p[k + 1] * r, p[2] + sph.p[k + 2] * r); Nm.push(sph.p[k], sph.p[k + 1], sph.p[k + 2]); }
    for (const t of sph.i) { I.push(base + t); TR.push(base + t); }
  }
  const positions = new Float32Array(P);
  return { positions, normals: new Float32Array(Nm), indices: new Uint32Array(I), wire: new Uint32Array(0), levels: 0,
    quads: new Uint32Array(QD), tris: new Uint32Array(TR), cage: { positions, quads: new Uint32Array(QD), tris: new Uint32Array(TR) } };
}
const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const nrm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
function sphere(rings, segs) {
  const p = [], i = [];
  for (let y = 0; y <= rings; y++) for (let x = 0; x <= segs; x++) {
    const th = (y / rings) * Math.PI, ph = (x / segs) * Math.PI * 2;
    p.push(Math.sin(th) * Math.cos(ph), Math.sin(th) * Math.sin(ph), Math.cos(th));
  }
  for (let y = 0; y < rings; y++) for (let x = 0; x < segs; x++) {
    const a = y * (segs + 1) + x, b = a + segs + 1;
    i.push(a, b, a + 1, a + 1, b, b + 1);
  }
  return { p, i };
}

// ---------------------------------------------------------------- marching tetrahedra (print meshes)
// Six tetrahedra per voxel around the 0–7 diagonal: neighbouring voxels share face diagonals, so the
// result has no ambiguous cases — always a closed 2-manifold. Used for print-ready STL.
const TETS = [[0, 1, 3, 7], [0, 3, 2, 7], [0, 2, 6, 7], [0, 6, 4, 7], [0, 4, 5, 7], [0, 5, 1, 7]];
export function marchingTets(F, g, smooth = 2) {
  const [nx, ny, nz] = g.dims, sxy = nx * ny, h = g.h, o = g.origin;
  const off = CORNERS.map((c) => c[0] + c[1] * nx + c[2] * sxy);
  const vmap = new Map();
  const pos = [], tri = [];
  const vid = (ia, ib) => {
    const lo = ia < ib ? ia : ib, hi = ia < ib ? ib : ia;
    const key = lo * 8 + (hi - lo === 1 ? 0 : hi - lo === nx ? 1 : hi - lo === sxy ? 2 : hi - lo === nx + 1 ? 3 : hi - lo === sxy + 1 ? 4 : hi - lo === sxy + nx ? 5 : 6);
    let v = vmap.get(key);
    if (v !== undefined) return v;
    const fa = F[ia], fb = F[ib], t = fa / (fa - fb);
    const ax = ia % nx, ay = Math.floor(ia / nx) % ny, az = Math.floor(ia / sxy);
    const bx = ib % nx, by = Math.floor(ib / nx) % ny, bz = Math.floor(ib / sxy);
    v = pos.length / 3;
    pos.push(o[0] + h * (ax + (bx - ax) * t), o[1] + h * (ay + (by - ay) * t), o[2] + h * (az + (bz - az) * t));
    vmap.set(key, v);
    return v;
  };
  const cv = new Float64Array(8), ci = new Float64Array(8);
  for (let z = 0; z < nz - 1; z++) for (let y = 0; y < ny - 1; y++) {
    let base = nx * y + sxy * z;
    for (let x = 0; x < nx - 1; x++, base++) {
      let mask = 0;
      for (let c = 0; c < 8; c++) { ci[c] = base + off[c]; cv[c] = F[ci[c]]; if (cv[c] < 0) mask |= 1 << c; }
      if (mask === 0 || mask === 255) continue;
      for (const T of TETS) {
        const ins = [], out = [];
        for (const c of T) (cv[c] < 0 ? ins : out).push(c);
        if (!ins.length || !out.length) continue;
        // outward reference: from inside corners towards outside corners
        const dir = [0, 0, 0];
        for (const c of out) for (let k = 0; k < 3; k++) dir[k] += CORNERS[c][k] / out.length;
        for (const c of ins) for (let k = 0; k < 3; k++) dir[k] -= CORNERS[c][k] / ins.length;
        const emit = (a, b, c) => {
          const A = 3 * a, B = 3 * b, Cc = 3 * c;
          const ux = pos[B] - pos[A], uy = pos[B + 1] - pos[A + 1], uz = pos[B + 2] - pos[A + 2];
          const vx = pos[Cc] - pos[A], vy = pos[Cc + 1] - pos[A + 1], vz = pos[Cc + 2] - pos[A + 2];
          const d = (uy * vz - uz * vy) * dir[0] + (uz * vx - ux * vz) * dir[1] + (ux * vy - uy * vx) * dir[2];
          if (a === b || b === c || a === c) return;
          if (d >= 0) tri.push(a, b, c); else tri.push(a, c, b);
        };
        if (ins.length === 1 || out.length === 1) {
          const lone = ins.length === 1 ? ins[0] : out[0], rest = ins.length === 1 ? out : ins;
          emit(vid(ci[lone], ci[rest[0]]), vid(ci[lone], ci[rest[1]]), vid(ci[lone], ci[rest[2]]));
        } else {
          const [a, b] = ins, [c, d] = out;
          const p = vid(ci[a], ci[c]), q = vid(ci[a], ci[d]), r = vid(ci[b], ci[d]), s = vid(ci[b], ci[c]);
          emit(p, q, r); emit(p, r, s);
        }
      }
    }
  }
  const indices = new Uint32Array(tri);
  const positions = taubin(new Float32Array(pos), indices, smooth);
  return { positions, normals: gradientNormals(positions, F, g), indices };
}

// ---------------------------------------------------------------- clean quad cage (SubD export)
export function nonManifoldEdges(Q) {
  const E = new Map();
  for (let i = 0; i < Q.length; i += 4) for (let j = 0; j < 4; j++) {
    const a = Q[i + j], b = Q[i + ((j + 1) & 3)];
    const k = a < b ? a * 1e7 + b : b * 1e7 + a;
    E.set(k, (E.get(k) || 0) + 1);
  }
  let bad = 0;
  for (const c of E.values()) if (c !== 2) bad++;
  return bad;
}

// Surface-nets cage on the smallest inward offset (fraction of a voxel) that is a clean 2-manifold:
// voxels where two sheets nearly touch (pinched creases) otherwise become 4-quad edges.
export function cleanCage(F, g, { smooth = 2, levels = 0 } = {}) {
  let best = null;
  for (const d of [0, 0.2, 0.35, 0.5, 0.75]) {
    const Fd = d ? F.map((x) => x + d * g.h) : F;
    const { positions, quads } = surfaceNets(Fd, g);
    const bad = nonManifoldEdges(quads);
    if (!best || bad < best.bad) best = { positions, quads, bad, offset: d, Fd };
    if (bad === 0) break;
  }
  let pos = smooth ? taubin(best.positions, quadsToTris(best.quads), Math.min(smooth, 2)) : best.positions;
  let Q = best.quads;
  // orient outward
  const normals = gradientNormals(pos, best.Fd, g);
  let agree = 0;
  for (let t = 0, n = Math.min(Q.length / 4, 200); t < n; t++) {
    const i = Math.floor((t / n) * (Q.length / 4)) * 4;
    const a = 3 * Q[i], b = 3 * Q[i + 1], c = 3 * Q[i + 2];
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
    agree += (uy * vz - uz * vy) * normals[a] + (uz * vx - ux * vz) * normals[a + 1] + (ux * vy - uy * vx) * normals[a + 2] > 0 ? 1 : -1;
  }
  if (agree < 0) for (let i = 0; i < Q.length; i += 4) { const t = Q[i + 1]; Q[i + 1] = Q[i + 3]; Q[i + 3] = t; }
  if (levels) ({ V: pos, Q } = catmullClark(pos, Q, levels));
  return { positions: pos, quads: Q, tris: new Uint32Array(0), bad: best.bad, offset: best.offset };
}
