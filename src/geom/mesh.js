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
  const idx = [];
  const quad = (a, b, c, d, flip) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    if (flip) idx.push(a, c, b, a, d, c); else idx.push(a, b, c, a, c, d);
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
  return { positions: new Float32Array(pos), indices: new Uint32Array(idx) };
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

// Full mesh from a field: nets → smoothing → normals (orientation self-checked)
export function polygonise(F, g, smoothIters) {
  const { positions, indices } = surfaceNets(F, g);
  const pos = taubin(positions, indices, smoothIters);
  const normals = gradientNormals(pos, F, g);
  // make winding agree with outward gradient
  if (indices.length >= 3) {
    let agree = 0;
    const tests = Math.min(indices.length / 3, 200);
    for (let t = 0; t < tests; t++) {
      const i = Math.floor((t / tests) * (indices.length / 3)) * 3;
      const a = 3 * indices[i], b = 3 * indices[i + 1], c = 3 * indices[i + 2];
      const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
      const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      agree += nx * normals[a] + ny * normals[a + 1] + nz * normals[a + 2] > 0 ? 1 : -1;
    }
    if (agree < 0) for (let i = 0; i < indices.length; i += 3) { const t = indices[i + 1]; indices[i + 1] = indices[i + 2]; indices[i + 2] = t; }
  }
  return { positions: pos, normals, indices };
}
