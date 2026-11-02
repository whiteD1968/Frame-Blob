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
