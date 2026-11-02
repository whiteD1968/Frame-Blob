// Frame/Blob — lattice free-form deformation (FFD)
// Ported from Minimal_Surface_Atlas_3 (trilinear lattice sampling, falloff weights,
// deformation preserved across division changes) and adapted to a displacement
// formulation so geometry outside the lattice box extrapolates instead of clamping.
//
// Lattice description (plain object, safe to post to a worker):
//   { min:[x,y,z], size:[sx,sy,sz], c:[cx,cy,cz] (point counts), D: Float32Array(cx*cy*cz*3) displacements }

export const ffdIndex = (L, i, j, k) => i + L.c[0] * (j + L.c[1] * k);

export function latticeBounds(stats, P) {
  const pad = Math.max(P.inflate, 0) + Math.max(P.skinPush, 0) + P.merge * 0.5 + P.radius * 2;
  const min = stats.bmin.map((v) => v - pad);
  const max = stats.bmax.map((v, i) => v + pad);
  return { min, size: max.map((v, i) => v - min[i]) };
}

export function restPoint(L, i, j, k) {
  return [
    L.min[0] + (L.c[0] > 1 ? (L.size[0] * i) / (L.c[0] - 1) : L.size[0] / 2),
    L.min[1] + (L.c[1] > 1 ? (L.size[1] * j) / (L.c[1] - 1) : L.size[1] / 2),
    L.min[2] + (L.c[2] > 1 ? (L.size[2] * k) / (L.c[2] - 1) : L.size[2] / 2),
  ];
}

// Build a lattice from params. P.ffdDeltas holds displacements normalised by lattice size,
// so the deformation scales when the model's bounds change (as in Atlas' scaleLatticeDeltaToBounds).
export function makeLattice(bounds, P) {
  const c = [P.ffdX + 1, P.ffdY + 1, P.ffdZ + 1];
  const n = c[0] * c[1] * c[2];
  const D = new Float32Array(n * 3);
  const d = P.ffdDeltas;
  if (d && d.length === n * 3) {
    for (let i = 0; i < n; i++) for (let a = 0; a < 3; a++) D[3 * i + a] = d[3 * i + a] * bounds.size[a];
  }
  return { min: bounds.min.slice(), size: bounds.size.slice(), c, D };
}

export function isIdentity(L) {
  if (!L) return true;
  for (let i = 0; i < L.D.length; i++) if (Math.abs(L.D[i]) > 1e-9) return false;
  return true;
}

export function normalisedDeltas(L) {
  const out = new Array(L.D.length);
  for (let i = 0; i < L.D.length; i++) out[i] = +(L.D[i] / (L.size[i % 3] || 1)).toFixed(6);
  return out;
}

function axis(L, a, x) {
  const n = L.c[a];
  if (n <= 1 || L.size[a] <= 1e-9) return [0, 0, 0];
  let t = (x - L.min[a]) / L.size[a];
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const g = t * (n - 1);
  const i0 = Math.min(Math.floor(g), n - 2);
  return [i0, i0 + 1, g - i0];
}

// trilinear displacement at p (writes into out)
export function displacement(L, x, y, z, out) {
  const [i0, i1, ax] = axis(L, 0, x), [j0, j1, ay] = axis(L, 1, y), [k0, k1, az] = axis(L, 2, z);
  const D = L.D, cx = L.c[0], cxy = L.c[0] * L.c[1];
  const w = [(1 - ax) * (1 - ay) * (1 - az), ax * (1 - ay) * (1 - az), (1 - ax) * ay * (1 - az), ax * ay * (1 - az),
    (1 - ax) * (1 - ay) * az, ax * (1 - ay) * az, (1 - ax) * ay * az, ax * ay * az];
  const id = [i0 + cx * j0 + cxy * k0, i1 + cx * j0 + cxy * k0, i0 + cx * j1 + cxy * k0, i1 + cx * j1 + cxy * k0,
    i0 + cx * j0 + cxy * k1, i1 + cx * j0 + cxy * k1, i0 + cx * j1 + cxy * k1, i1 + cx * j1 + cxy * k1];
  let dx = 0, dy = 0, dz = 0;
  for (let q = 0; q < 8; q++) { const o = 3 * id[q], ww = w[q]; dx += D[o] * ww; dy += D[o + 1] * ww; dz += D[o + 2] * ww; }
  out[0] = dx; out[1] = dy; out[2] = dz;
  return out;
}

export function warpPoint(L, p) {
  const d = displacement(L, p[0], p[1], p[2], [0, 0, 0]);
  return [p[0] + d[0], p[1] + d[1], p[2] + d[2]];
}

export function warpPositions(L, src) {
  const out = new Float32Array(src.length), d = [0, 0, 0];
  for (let i = 0; i < src.length; i += 3) {
    displacement(L, src[i], src[i + 1], src[i + 2], d);
    out[i] = src[i] + d[0]; out[i + 1] = src[i + 1] + d[1]; out[i + 2] = src[i + 2] + d[2];
  }
  return out;
}

// Inverse warp by Newton iteration (numeric Jacobian). Used for drawings and picking.
export function unwarpPoint(L, p, iters = 10) {
  let q = [p[0], p[1], p[2]];
  const d = [0, 0, 0], d1 = [0, 0, 0];
  const h = Math.max(L.size[0], L.size[1], L.size[2]) * 1e-4;
  for (let it = 0; it < iters; it++) {
    displacement(L, q[0], q[1], q[2], d);
    const r = [q[0] + d[0] - p[0], q[1] + d[1] - p[1], q[2] + d[2] - p[2]];
    if (Math.abs(r[0]) + Math.abs(r[1]) + Math.abs(r[2]) < h * 0.01) break;
    const J = [];
    for (let a = 0; a < 3; a++) {
      const qq = q.slice(); qq[a] += h;
      displacement(L, qq[0], qq[1], qq[2], d1);
      J.push([(d1[0] - d[0]) / h + (a === 0 ? 1 : 0), (d1[1] - d[1]) / h + (a === 1 ? 1 : 0), (d1[2] - d[2]) / h + (a === 2 ? 1 : 0)]);
    }
    // J columns are ∂f/∂q_a ; solve J·δ = r (Cramer)
    const [c0, c1, c2] = J;
    const det = c0[0] * (c1[1] * c2[2] - c1[2] * c2[1]) - c1[0] * (c0[1] * c2[2] - c0[2] * c2[1]) + c2[0] * (c0[1] * c1[2] - c0[2] * c1[1]);
    if (Math.abs(det) < 1e-12) break;
    const sol = (col, rr) => {
      const m = [c0, c1, c2].map((c, i) => (i === col ? rr : c));
      return (m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[1][0] * (m[0][1] * m[2][2] - m[0][2] * m[2][1]) + m[2][0] * (m[0][1] * m[1][2] - m[0][2] * m[1][1])) / det;
    };
    q = [q[0] - sol(0, r), q[1] - sol(1, r), q[2] - sol(2, r)];
  }
  return q;
}

// Atlas' preserveLatticeDeformation: resample an old lattice at the new rest points.
export function resampleLattice(oldL, newL) {
  const out = newL.D;
  const d = [0, 0, 0];
  for (let k = 0; k < newL.c[2]; k++) for (let j = 0; j < newL.c[1]; j++) for (let i = 0; i < newL.c[0]; i++) {
    const r = restPoint(newL, i, j, k);
    displacement(oldL, r[0], r[1], r[2], d);
    const o = 3 * ffdIndex(newL, i, j, k);
    out[o] = d[0]; out[o + 1] = d[1]; out[o + 2] = d[2];
  }
  return newL;
}

// Atlas' buildLatticeInfluenceWeights: selected = 1, others smoothstep by distance to nearest selected.
export function influenceWeights(L, selected, radius, strength) {
  const n = L.c[0] * L.c[1] * L.c[2];
  const w = new Float32Array(n);
  const sel = [...selected];
  const pos = (idx) => {
    const i = idx % L.c[0], j = Math.floor(idx / L.c[0]) % L.c[1], k = Math.floor(idx / (L.c[0] * L.c[1]));
    const r = restPoint(L, i, j, k);
    return [r[0] + L.D[3 * idx], r[1] + L.D[3 * idx + 1], r[2] + L.D[3 * idx + 2]];
  };
  const sp = sel.map(pos);
  for (let idx = 0; idx < n; idx++) {
    if (selected.has(idx)) { w[idx] = 1; continue; }
    if (radius <= 0 || strength <= 0) continue;
    const p = pos(idx);
    let dmin = Infinity;
    for (const s of sp) dmin = Math.min(dmin, Math.hypot(p[0] - s[0], p[1] - s[1], p[2] - s[2]));
    const t = Math.min(Math.max(dmin / radius, 0), 1);
    w[idx] = Math.min(Math.max((1 - t * t * (3 - 2 * t)) * strength, 0), 1);
  }
  return w;
}
