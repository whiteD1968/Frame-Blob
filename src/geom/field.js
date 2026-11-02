// Frame/Blob — signed distance fields on a regular grid
// Negative = inside. Fields are accumulated region-by-region with smooth unions,
// so cost scales with the number of struts / cells rather than grid × primitives.

const BIG = 1e4;

export function smin(a, b, k) {
  if (k <= 0) return a < b ? a : b;
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

export function makeGrid(bmin, bmax, res, pad) {
  const size = [bmax[0] - bmin[0] + 2 * pad, bmax[1] - bmin[1] + 2 * pad, bmax[2] - bmin[2] + 2 * pad];
  const h = Math.max(size[0], size[1], size[2]) / res;
  const dims = size.map((s) => Math.max(4, Math.ceil(s / h) + 3));
  const origin = [bmin[0] - pad - h, bmin[1] - pad - h, bmin[2] - pad - h];
  return { origin, h, dims, key: [origin.map((v) => v.toFixed(4)), h.toFixed(5), dims].join('|') };
}

export function emptyField(g) {
  const F = new Float32Array(g.dims[0] * g.dims[1] * g.dims[2]);
  F.fill(BIG);
  return F;
}

function range(g, mn, mx) {
  const [nx, ny, nz] = g.dims, h = g.h, o = g.origin;
  return [
    Math.max(0, Math.floor((mn[0] - o[0]) / h)), Math.min(nx - 1, Math.ceil((mx[0] - o[0]) / h)),
    Math.max(0, Math.floor((mn[1] - o[1]) / h)), Math.min(ny - 1, Math.ceil((mx[1] - o[1]) / h)),
    Math.max(0, Math.floor((mn[2] - o[2]) / h)), Math.min(nz - 1, Math.ceil((mx[2] - o[2]) / h)),
  ];
}

// ------------------------------------------------------------------ frame
// Struts are tapered capsules, nodes are spheres; everything is fused with a
// polynomial smooth-min so joints read as soft SubD-like fillets.
export function frameField(g, graph, P) {
  const F = emptyField(g);
  const [nx, ny] = g.dims, sxy = nx * ny, h = g.h, o = g.origin;
  const k = P.fillet;
  const radiusFor = (lvl) => (lvl === 1 ? P.radius : P.radius * P.subRadius);

  for (const e of graph.edges) {
    const A = graph.nodes[e.a], B = graph.nodes[e.b];
    const r = radiusFor(e.level);
    if (r <= 0) continue;
    const taper = e.sub ? 0 : P.taper; // wrapped cords: no per-segment taper (avoids beading)
    const ba = [B[0] - A[0], B[1] - A[1], B[2] - A[2]];
    const bb = ba[0] * ba[0] + ba[1] * ba[1] + ba[2] * ba[2] || 1e-9;
    const m = r * (1 + Math.max(0, -taper)) + k + 2 * h;
    const [x0, x1, y0, y1, z0, z1] = range(g,
      [Math.min(A[0], B[0]) - m, Math.min(A[1], B[1]) - m, Math.min(A[2], B[2]) - m],
      [Math.max(A[0], B[0]) + m, Math.max(A[1], B[1]) + m, Math.max(A[2], B[2]) + m]);
    for (let z = z0; z <= z1; z++) {
      const pz = o[2] + z * h - A[2];
      for (let y = y0; y <= y1; y++) {
        const py = o[1] + y * h - A[1];
        let idx = x0 + nx * y + sxy * z;
        for (let x = x0; x <= x1; x++, idx++) {
          const px = o[0] + x * h - A[0];
          let t = (px * ba[0] + py * ba[1] + pz * ba[2]) / bb;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const dx = px - ba[0] * t, dy = py - ba[1] * t, dz = pz - ba[2] * t;
          const rr = r * (1 - taper * 4 * t * (1 - t));
          const d = Math.sqrt(dx * dx + dy * dy + dz * dz) - rr;
          const cur = F[idx];
          F[idx] = k > 0 ? smin(cur, d, k) : (d < cur ? d : cur);
        }
      }
    }
  }
  // nodes
  if (P.nodeScale > 0) {
    graph.nodes.forEach((N, i) => {
      if (graph.valence[i] < 3) return;
      const r = P.radius * P.nodeScale;
      const m = r + k + 2 * h;
      const [x0, x1, y0, y1, z0, z1] = range(g, [N[0] - m, N[1] - m, N[2] - m], [N[0] + m, N[1] + m, N[2] + m]);
      for (let z = z0; z <= z1; z++) {
        const pz = o[2] + z * h - N[2];
        for (let y = y0; y <= y1; y++) {
          const py = o[1] + y * h - N[1];
          let idx = x0 + nx * y + sxy * z;
          for (let x = x0; x <= x1; x++, idx++) {
            const px = o[0] + x * h - N[0];
            const d = Math.sqrt(px * px + py * py + pz * pz) - r;
            F[idx] = k > 0 ? smin(F[idx], d, k) : Math.min(F[idx], d);
          }
        }
      }
    });
  }
  return F;
}

// ------------------------------------------------------------------ blobs
// Each cell becomes a "pillow": its convex polytope shrunk by `gap`, inset by a
// rounding radius R (roundness × inradius) and grown back with Euclidean
// rounding, then inflated. Pillows union with smooth-min (`merge`) =
// the metaball quality. The frame is subtracted with a clearance (`groove`)
// so the cushions pinch where struts pass — like cords tied around balloons.
export function blobField(g, cells, P, rand) {
  const B = emptyField(g);
  const [nx, ny] = g.dims, sxy = nx * ny, h = g.h, o = g.origin;
  const merge = P.merge;
  for (const c of cells) {
    if (!c.active || c.volume <= 0) continue;
    const ctr = c.centroid;
    const inflate = P.inflate * (1 + P.variance * (rand() * 2 - 1));
    const pls0 = c.faces.map((f) => {
      const isSkin = f.kind === 'B' || (f.kind === 'P' && f.pkind === 'B');
      return [f.n[0], f.n[1], f.n[2], f.d - P.gap + (isSkin ? P.skinPush : 0)];
    });
    // inradius about the centroid decides how round the pillow may get
    let inr = Infinity;
    for (const pl of pls0) inr = Math.min(inr, pl[3] - (pl[0] * ctr[0] + pl[1] * ctr[1] + pl[2] * ctr[2]));
    if (!(inr > 0)) continue;
    // rounding radius: roundness 1 ≈ fully round (sphere-like balloon)
    const R = Math.min(inr * 0.97, Math.max(0.01, P.roundness * inr));
    const pls = pls0.map((pl) => [pl[0], pl[1], pl[2], pl[3] - R]);
    const np = pls.length;
    const m = Math.max(inflate, 0) + Math.max(P.skinPush, 0) + merge + 2 * h;
    const [x0, x1, y0, y1, z0, z1] = range(g,
      [c.bbox.min[0] - m, c.bbox.min[1] - m, c.bbox.min[2] - m],
      [c.bbox.max[0] + m, c.bbox.max[1] + m, c.bbox.max[2] + m]);
    const skipD = merge + 3 * h + (P.grooveOn ? P.grooveSoft : 0);
    for (let z = z0; z <= z1; z++) {
      const pz = o[2] + z * h;
      for (let y = y0; y <= y1; y++) {
        const py = o[1] + y * h;
        let idx = x0 + nx * y + sxy * z;
        for (let x = x0; x <= x1; x++, idx++) {
          const px = o[0] + x * h;
          // Euclidean-ish distance to the inset polytope, then round by R and inflate
          let mx = -Infinity, pos = 0;
          for (let i = 0; i < np; i++) {
            const pl = pls[i];
            const v = pl[0] * px + pl[1] * py + pl[2] * pz - pl[3];
            if (v > mx) mx = v;
            if (v > 0) pos += v * v;
          }
          const d = (pos > 0 ? Math.sqrt(pos) : mx) - R - inflate;
          if (d > skipD) continue;
          const cur = B[idx];
          B[idx] = merge > 0 ? smin(cur, d, merge) : (d < cur ? d : cur);
        }
      }
    }
  }
  return B;
}

export function sampleField(F, g, x, y, z) {
  const [nx, ny, nz] = g.dims, sxy = nx * ny;
  let fx = (x - g.origin[0]) / g.h, fy = (y - g.origin[1]) / g.h, fz = (z - g.origin[2]) / g.h;
  fx = Math.min(Math.max(fx, 0), nx - 1.001); fy = Math.min(Math.max(fy, 0), ny - 1.001); fz = Math.min(Math.max(fz, 0), nz - 1.001);
  const ix = fx | 0, iy = fy | 0, iz = fz | 0;
  const tx = fx - ix, ty = fy - iy, tz = fz - iz;
  const i0 = ix + nx * iy + sxy * iz;
  const c000 = F[i0], c100 = F[i0 + 1], c010 = F[i0 + nx], c110 = F[i0 + nx + 1];
  const c001 = F[i0 + sxy], c101 = F[i0 + sxy + 1], c011 = F[i0 + sxy + nx], c111 = F[i0 + sxy + nx + 1];
  const c00 = c000 + (c100 - c000) * tx, c10 = c010 + (c110 - c010) * tx;
  const c01 = c001 + (c101 - c001) * tx, c11 = c011 + (c111 - c011) * tx;
  const c0 = c00 + (c10 - c00) * ty, c1 = c01 + (c11 - c01) * ty;
  return c0 + (c1 - c0) * tz;
}

// Frame pinches blob: smooth difference of (frame + clearance)
export function applyGroove(Braw, frameF, P) {
  const B = Braw.slice();
  if (!frameF || !P.grooveOn) return B;
  const kg = P.grooveSoft, cl = P.groove;
  for (let i = 0; i < B.length; i++) {
    const f = frameF[i];
    if (f > 1e3) continue;
    const a = B[i], b = -(f - cl);
    if (kg > 0) {
      const hh = Math.max(kg - Math.abs(a - b), 0) / kg;
      B[i] = Math.max(a, b) + hh * hh * kg * 0.25;
    } else B[i] = Math.max(a, b);
  }
  return B;
}

// Separable box blur (clamped) — a "shrink-wrap" copy of the blob field: cords projected onto
// it ride over the crevices between balloons like a taut string instead of diving into them.
export function blurField(F, g, r, passes = 2) {
  if (r < 1) return F;
  const [nx, ny, nz] = g.dims, st = [1, nx, nx * ny];
  let A = Float32Array.from(F, (v) => Math.min(v, 50 * g.h)), Bf = new Float32Array(A.length);
  for (let p = 0; p < passes; p++) for (let ax = 0; ax < 3; ax++) {
    const n = g.dims[ax], s = st[ax];
    const lines = A.length / n;
    const o1 = ax === 0 ? 1 : 0;
    for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
      const c = [x, y, z][ax];
      if (c !== 0) continue; // start of each line along ax
      const base = x + nx * y + nx * ny * z;
      let acc = 0, cnt = 0;
      for (let i = -r; i <= r; i++) { const j = Math.min(Math.max(i, 0), n - 1); acc += A[base + j * s]; cnt++; }
      for (let i = 0; i < n; i++) {
        Bf[base + i * s] = acc / cnt;
        const add = Math.min(i + r + 1, n - 1), rem = Math.max(i - r, 0);
        acc += A[base + add * s] - A[base + rem * s];
      }
    }
    [A, Bf] = [Bf, A];
  }
  return A;
}

// Wrap: project skin nodes + subdivided skin struts onto the blob surface,
// so the frame reads as cords tied around the cushions.
export function wrapGraph(graph, B, g, bnd, P) {
  const tol = g.h * 0.25;
  const onSkin = (p) => bnd.planes.some((pl) => Math.abs(pl.n[0] * p[0] + pl.n[1] * p[1] + pl.n[2] * p[2] - pl.d) < tol);
  const maxMove = Math.max(P.inflate, 0) + Math.max(P.skinPush, 0) + P.merge + 4 * g.h;
  const e = g.h * 0.5;
  const lift = (P.cordLift ?? 0.5) * P.radius; // cord centre sits this far outside the cushion surface
  const project = (p0) => {
    let p = p0.slice();
    for (let it = 0; it < 10; it++) {
      const b = sampleField(B, g, p[0], p[1], p[2]) - lift;
      if (Math.abs(b) < 0.02 * g.h) break;
      const gx = (sampleField(B, g, p[0] + e, p[1], p[2]) - sampleField(B, g, p[0] - e, p[1], p[2])) / (2 * e);
      const gy = (sampleField(B, g, p[0], p[1] + e, p[2]) - sampleField(B, g, p[0], p[1] - e, p[2])) / (2 * e);
      const gz = (sampleField(B, g, p[0], p[1], p[2] + e) - sampleField(B, g, p[0], p[1], p[2] - e)) / (2 * e);
      const gg = gx * gx + gy * gy + gz * gz;
      if (gg < 1e-6) break;
      const s = Math.max(-g.h * 3, Math.min(g.h * 3, b / gg));
      p = [p[0] - gx * s, p[1] - gy * s, p[2] - gz * s];
    }
    const d = Math.hypot(p[0] - p0[0], p[1] - p0[1], p[2] - p0[2]);
    if (d > maxMove || !isFinite(d)) return p0;
    const w = P.wrap;
    return [p0[0] + (p[0] - p0[0]) * w, p0[1] + (p[1] - p0[1]) * w, p0[2] + (p[2] - p0[2]) * w];
  };
  const skin = graph.skinNode || graph.nodes.map(onSkin);
  const nodes = graph.nodes.map((n, i) => (skin[i] ? project(n) : n));
  const valence = graph.valence.slice();
  const edges = [];
  const seg = Math.max(g.h * 2.5, 1e-3);
  graph.edges.forEach((ed, ei) => {
    const A = graph.nodes[ed.a], Bn = graph.nodes[ed.b];
    const mid = [(A[0] + Bn[0]) / 2, (A[1] + Bn[1]) / 2, (A[2] + Bn[2]) / 2];
    const skinEdge = graph.skinEdge ? graph.skinEdge[ei] : (skin[ed.a] && skin[ed.b] && onSkin(mid));
    if (!skinEdge) { edges.push(ed); return; }
    const k = Math.max(1, Math.ceil(ed.length / seg));
    let prev = ed.a;
    for (let i = 1; i < k; i++) {
      const t = i / k;
      const q = project([A[0] + (Bn[0] - A[0]) * t, A[1] + (Bn[1] - A[1]) * t, A[2] + (Bn[2] - A[2]) * t]);
      const id = nodes.length;
      nodes.push(q); valence.push(2);
      edges.push({ a: prev, b: id, level: ed.level, length: 0, sub: true });
      prev = id;
    }
    edges.push({ a: prev, b: ed.b, level: ed.level, length: 0, sub: true });
  });
  // relax the projected cords along their length and re-project (taut, calm curves)
  const nb = nodes.map(() => []);
  for (const e of edges) { nb[e.a].push(e.b); nb[e.b].push(e.a); }
  for (let it = 0; it < 4; it++) {
    const Q = nodes.map((p) => p);
    for (let i = graph.nodes.length; i < nodes.length; i++) {
      if (nb[i].length !== 2) continue;
      const a = nodes[nb[i][0]], b = nodes[nb[i][1]], p = nodes[i];
      Q[i] = project([0.5 * p[0] + 0.25 * (a[0] + b[0]), 0.5 * p[1] + 0.25 * (a[1] + b[1]), 0.5 * p[2] + 0.25 * (a[2] + b[2])]);
    }
    for (let i = graph.nodes.length; i < nodes.length; i++) nodes[i] = Q[i];
  }
  return { nodes, edges, valence };
}
