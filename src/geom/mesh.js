// Frame/Blob — Naive Surface Nets + Taubin smoothing + field-gradient normals
import { sampleField } from './field.js';

const CORNERS = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]];
const EDGES = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];

export function surfaceNets(F, g) {
  const [nx, ny, nz] = g.dims, sxy = nx * ny, h = g.h, o = g.origin;
  const vidx = new Int32Array(nx * ny * nz).fill(-1);
  const pos = [];
  const off = CORNERS.map((c) => c[0] + c[1] * nx + c[2] * sxy);
  const v = new Float64Array(8);
  for (let z = 0; z < nz - 1; z++) for (let y = 0; y < ny - 1; y++) {
    let base = nx * y + sxy * z;
    for (let x = 0; x < nx - 1; x++, base++) {
      let mask = 0;
      for (let c = 0; c < 8; c++) { v[c] = F[base + off[c]]; if (v[c] < 0) mask |= 1 << c; }
      if (mask === 0 || mask === 255) continue;
      let sx = 0, sy = 0, sz = 0, cnt = 0;
      for (const [a, b] of EDGES) {
        if (((mask >> a) & 1) === ((mask >> b) & 1)) continue;
        const t = v[a] / (v[a] - v[b]);
        const A = CORNERS[a], B = CORNERS[b];
        sx += A[0] + (B[0] - A[0]) * t; sy += A[1] + (B[1] - A[1]) * t; sz += A[2] + (B[2] - A[2]) * t; cnt++;
      }
      vidx[base] = pos.length / 3;
      pos.push(o[0] + h * (x + sx / cnt), o[1] + h * (y + sy / cnt), o[2] + h * (z + sz / cnt));
    }
  }
  const qd = [];
  const quad = (a, b, c, d, flip) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    if (flip) qd.push(a, d, c, b); else qd.push(a, b, c, d);
  };
  for (let z = 1; z < nz - 1; z++) for (let y = 1; y < ny - 1; y++) {
    let base = 1 + nx * y + sxy * z;
    for (let x = 1; x < nx - 1; x++, base++) {
      const a0 = F[base] < 0;
      if (a0 !== (F[base + 1] < 0)) quad(vidx[base - nx - sxy], vidx[base - sxy], vidx[base], vidx[base - nx], !a0);
      if (a0 !== (F[base + nx] < 0)) quad(vidx[base - sxy - 1], vidx[base - 1], vidx[base], vidx[base - sxy], !a0);
      if (a0 !== (F[base + sxy] < 0)) quad(vidx[base - 1 - nx], vidx[base - nx], vidx[base], vidx[base - 1], !a0);
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
  let levels = 0;
  if (o.mode === 'subd') {
    // light pre-relax removes voxel stair-steps, then true SubD smoothing
    if (o.smooth) pos = taubin(pos, quadsToTris(Q), Math.min(o.smooth, 2));
    levels = o.levels | 0;
    const maxQ = o.maxQuads || 1.2e6;
    while (levels > 0 && (Q.length / 4) * Math.pow(4, levels) > maxQ) levels--;
    if (levels) ({ V: pos, Q } = catmullClark(pos, Q, levels));
  } else {
    pos = taubin(pos, quadsToTris(Q), o.smooth);
  }
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
    if (agree < 0) for (let i = 0; i < Q.length; i += 4) { const t = Q[i + 1]; Q[i + 1] = Q[i + 3]; Q[i + 3] = t; }
  }
  return { positions: pos, normals, indices: quadsToTris(Q), wire: quadEdges(Q), levels };
}

// ---------------------------------------------------------------- swept cords
// Decompose a strut graph into chains between junctions (valence ≠ 2), run a Catmull–Rom spline
// through each chain and sweep a circular section with parallel-transport frames. Junctions get
// spheres. Exact radius at any resolution: used for thin cords, where voxels would break them.
export function cordMesh(graph, radiusFor, { sides = 10, step = 1, nodeScale = 1 } = {}) {
  const N = graph.nodes, nb = N.map(() => []);
  graph.edges.forEach((e, i) => { nb[e.a].push([e.b, i]); nb[e.b].push([e.a, i]); });
  const used = new Uint8Array(graph.edges.length);
  const chains = [];
  const walk = (start, first) => {
    const pts = [start]; let prev = start, [cur, ei] = first; used[ei] = 1;
    const level = graph.edges[ei].level;
    while (true) {
      pts.push(cur);
      if (nb[cur].length !== 2 || cur === start) break;
      const nx = nb[cur].find(([n, j]) => !used[j]);
      if (!nx) break;
      used[nx[1]] = 1; prev = cur; [cur] = nx;
    }
    chains.push({ pts, level, closed: pts[0] === pts[pts.length - 1] });
  };
  N.forEach((_, i) => { if (nb[i].length !== 2) for (const f of nb[i]) if (!used[f[1]]) walk(i, f); });
  N.forEach((_, i) => { for (const f of nb[i]) if (!used[f[1]]) walk(i, f); }); // closed loops
  const P = [], Nm = [], I = [];
  const crs = (p0, p1, p2, p3, t) => {
    const t2 = t * t, t3 = t2 * t;
    return [0, 1, 2].map((k) => 0.5 * (2 * p1[k] + (-p0[k] + p2[k]) * t + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * t2 + (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * t3));
  };
  for (const ch of chains) {
    const r = radiusFor(ch.level);
    if (r <= 0 || ch.pts.length < 2) continue;
    const c = ch.pts.map((i) => N[i]);
    // sample spline
    const S = [];
    for (let i = 0; i < c.length - 1; i++) {
      const p0 = c[Math.max(i - 1, 0)], p1 = c[i], p2 = c[i + 1], p3 = c[Math.min(i + 2, c.length - 1)];
      const L = Math.hypot(p2[0] - p1[0], p2[1] - p1[1], p2[2] - p1[2]);
      const n = Math.max(1, Math.ceil(L / (step * r * 1.5)));
      for (let s = 0; s < n; s++) S.push(crs(p0, p1, p2, p3, s / n));
    }
    S.push(c[c.length - 1]);
    if (S.length < 2) continue;
    // parallel transport frames
    const T = S.map((p, i) => { const a = S[Math.max(i - 1, 0)], b = S[Math.min(i + 1, S.length - 1)]; const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]; const l = Math.hypot(...d) || 1; return d.map((x) => x / l); });
    let n0 = Math.abs(T[0][2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
    let u = cross3(T[0], n0); u = nrm(u); let w = cross3(T[0], u);
    const base = P.length / 3;
    for (let i = 0; i < S.length; i++) {
      if (i > 0) { // transport u
        const t = T[i];
        const d = u[0] * t[0] + u[1] * t[1] + u[2] * t[2];
        u = nrm([u[0] - d * t[0], u[1] - d * t[1], u[2] - d * t[2]]);
        w = cross3(t, u);
      }
      for (let k = 0; k < sides; k++) {
        const a = (k / sides) * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
        const nn = [u[0] * ca + w[0] * sa, u[1] * ca + w[1] * sa, u[2] * ca + w[2] * sa];
        P.push(S[i][0] + nn[0] * r, S[i][1] + nn[1] * r, S[i][2] + nn[2] * r);
        Nm.push(...nn);
      }
    }
    for (let i = 0; i < S.length - 1; i++) for (let k = 0; k < sides; k++) {
      const a = base + i * sides + k, b = base + i * sides + ((k + 1) % sides), c2 = a + sides, d = b + sides;
      I.push(a, b, c2, b, d, c2); // outward winding (u, w=T×u right-handed)
    }
  }
  // junction spheres
  const sph = sphere(8, 12);
  N.forEach((p, i) => {
    if (nb[i].length === 2 || !nb[i].length) return;
    const lvl = Math.min(...nb[i].map(([, j]) => graph.edges[j].level));
    const r = radiusFor(lvl) * Math.max(1.02, nodeScale);
    const base = P.length / 3;
    for (let k = 0; k < sph.p.length; k += 3) { P.push(p[0] + sph.p[k] * r, p[1] + sph.p[k + 1] * r, p[2] + sph.p[k + 2] * r); Nm.push(sph.p[k], sph.p[k + 1], sph.p[k + 2]); }
    for (const t of sph.i) I.push(base + t);
  });
  const indices = new Uint32Array(I);
  return { positions: new Float32Array(P), normals: new Float32Array(Nm), indices, wire: new Uint32Array(0), levels: 0 };
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
