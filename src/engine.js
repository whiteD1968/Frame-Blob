// Frame/Blob — cached geometry pipeline (runs in a worker, or on the main thread as fallback)
import { buildCells, buildBlobCells, mulberry32 } from './geom/voronoi.js';
import { makeGrid, frameField, blobField, applyGroove, wrapGraph, blurField } from './geom/field.js';
import { polygonise, meshVolume, meshArea, cordMesh } from './geom/mesh.js';
import { computeDrawing } from './geom/drawing.js';
import { isIdentity, warpPoint, unwarpPoint } from './geom/ffd.js';
import { sampleField } from './geom/field.js';

// Resample both fields on a grid covering the deformed model (inverse warp + trilinear lookup)
function warpFields(g, fields, L) {
  const span = g.dims.map((d) => (d - 1) * g.h);
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  const S = 10;
  for (let a = 0; a <= S; a++) for (let b = 0; b <= S; b++) for (let c = 0; c <= S; c++) {
    const w = warpPoint(L, [g.origin[0] + (span[0] * a) / S, g.origin[1] + (span[1] * b) / S, g.origin[2] + (span[2] * c) / S]);
    for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], w[k]); mx[k] = Math.max(mx[k], w[k]); }
  }
  let h = g.h;
  const vol = () => ((mx[0] - mn[0]) / h + 1) * ((mx[1] - mn[1]) / h + 1) * ((mx[2] - mn[2]) / h + 1);
  while (vol() > 2.5e6) h *= 1.15;
  const dims = [0, 1, 2].map((k) => Math.ceil((mx[k] - mn[k]) / h) + 1);
  const g2 = { origin: mn, h, dims };
  const outs = fields.map(() => new Float32Array(dims[0] * dims[1] * dims[2]));
  let idx = 0;
  for (let z = 0; z < dims[2]; z++) for (let y = 0; y < dims[1]; y++) {
    let guess = null;
    for (let x = 0; x < dims[0]; x++, idx++) {
      const p = [mn[0] + x * h, mn[1] + y * h, mn[2] + z * h];
      const q = unwarpPoint(L, p, guess ? 4 : 10);
      guess = q;
      const inside = q[0] >= g.origin[0] && q[1] >= g.origin[1] && q[2] >= g.origin[2] &&
        q[0] <= g.origin[0] + span[0] && q[1] <= g.origin[1] + span[1] && q[2] <= g.origin[2] + span[2];
      for (let f = 0; f < fields.length; f++) outs[f][idx] = inside ? sampleField(fields[f], g, q[0], q[1], q[2]) : 1e4;
    }
  }
  return { g: g2, outs };
}

const CELL_KEYS = ['boundary', 'sizeX', 'sizeY', 'sizeZ', 'lattice', 'count', 'nx', 'ny', 'nz', 'jitter', 'gradient', 'gradAxis',
  'relax', 'seed', 'cull', 'disabled', 'subdiv', 'subSeed', 'subRelax', 'frameScope', 'skinEdges', 'frameTopology', 'cordSmooth', 'outerEdges', 'creaseAngle'];
const BLOBCELL_KEYS = ['boundary', 'sizeX', 'sizeY', 'sizeZ', 'blobSource', 'blobLattice', 'blobCount', 'blobSeed', 'blobRelax', 'nx', 'ny', 'nz', 'gradAxis'];
const FRAME_KEYS = ['radius', 'nodeScale', 'taper', 'fillet', 'subRadius', 'wrap', 'cordTaut', 'cordLift'];
const BLOB_KEYS = ['inflate', 'roundness', 'gap', 'merge', 'variance', 'skinPush', 'blobSource'];
const GROOVE_KEYS = ['grooveOn', 'groove', 'grooveSoft'];

const pick = (P, keys) => JSON.stringify(keys.map((k) => P[k]));

function cellEdgeLines(cells, onlyActive) {
  const out = [];
  for (const c of cells) {
    if (onlyActive && !c.active) continue;
    for (const f of c.faces) {
      const v = f.verts;
      for (let i = 0; i < v.length; i++) {
        const a = v[i], b = v[(i + 1) % v.length];
        out.push(a[0], a[1], a[2], b[0], b[1], b[2]);
      }
    }
  }
  return new Float32Array(out);
}

export function createEngine() {
  const C = {};

  function run(P, res) {
    const T = {};
    let t0 = performance.now();
    const cellsKey = pick(P, CELL_KEYS);
    if (C.cellsKey !== cellsKey) {
      C.S = buildCells(P);
      C.cellsKey = cellsKey;
      C.cellLines = null;
    }
    const S = C.S;
    T.cells = performance.now() - t0;

    // which cells inflate?
    let blobCells = S.cells;
    if (P.blobSource === 'subcells' && S.subCells.length) blobCells = S.subCells;
    if (P.blobSource === 'independent') {
      const k = pick(P, BLOBCELL_KEYS);
      if (C.bcKey !== k) { C.blobCells = buildBlobCells(P, S.boundary); C.bcKey = k; }
      blobCells = C.blobCells;
    }

    const pad = Math.max(P.inflate, 0) + Math.max(P.skinPush, 0) + P.merge + P.radius * Math.max(P.nodeScale, 1) + P.fillet + P.groove + 2;
    const grid = makeGrid(S.boundary.bmin, S.boundary.bmax, res, pad);

    // 1. raw inflated field (independent of the frame)
    t0 = performance.now();
    const rawKey = grid.key + cellsKey + pick(P, BLOB_KEYS) + (P.blobSource === 'independent' ? C.bcKey : '') + P.seed;
    if (C.rawKey !== rawKey) {
      C.Braw = blobField(grid, blobCells, P, mulberry32(P.seed * 13 + 101));
      C.rawKey = rawKey;
    }
    T.blob = performance.now() - t0;

    // 2. frame (optionally wrapped onto the raw blob surface)
    t0 = performance.now();
    const frameKey = grid.key + cellsKey + pick(P, FRAME_KEYS) + (P.wrap > 0 ? rawKey : '');
    if (C.frameKey !== frameKey) {
      if (P.wrap > 0) {
        const r = Math.round((P.cordTaut ?? 3) * 1);
        const Bw = r > 0 ? blurField(C.Braw, grid, r, 2) : C.Braw;
        C.frameGraph = wrapGraph(S.graph, Bw, grid, S.boundary, P);
      } else C.frameGraph = S.graph;
      C.F = frameField(grid, C.frameGraph, P);
      C.frameKey = frameKey; C.frameMesh = null;
    }
    T.frame = performance.now() - t0;

    // 3. frame pinches blob
    t0 = performance.now();
    const blobKey = rawKey + frameKey + pick(P, GROOVE_KEYS);
    if (C.blobKey !== blobKey) {
      C.B = applyGroove(C.Braw, C.F, P);
      C.blobKey = blobKey; C.blobMesh = null;
    }
    T.blob += performance.now() - t0;

    t0 = performance.now();
    const meshKey = pick(P, ['smooth', 'meshMode', 'subdLevels']);
    const mopts = { smooth: P.smooth, mode: P.meshMode || 'voxel', levels: P.subdLevels || 0 };
    // thin struts → swept cords (exact radius); otherwise SDF frame (filleted, watertight)
    const fm0 = P.frameMesh || 'auto';
    const useCords = fm0 === 'cords' || (fm0 === 'auto' && (P.radius < grid.h * 1.2 || (P.frameTopology === 'surface' && P.wrap > 0)));
    const fKey = meshKey + useCords + C.frameKey;
    if (!C.frameMesh || C.frameMeshKey !== fKey) {
      C.frameMesh = useCords
        ? cordMesh(C.frameGraph, (lvl) => (lvl === 1 ? P.radius : P.radius * P.subRadius), { nodeScale: P.nodeScale })
        : polygonise(C.F, grid, mopts);
    }
    C.cords = useCords;
    if (!C.blobMesh || C.blobMeshKey !== meshKey) { C.blobMesh = polygonise(C.B, grid, mopts); }
    C.frameMeshKey = fKey; C.blobMeshKey = meshKey;
    T.mesh = performance.now() - t0;
    C.grid = grid;

    if (!C.cellLines) {
      C.cellLines = cellEdgeLines(S.cells, false);
      C.subLines = cellEdgeLines(S.subCells, false);
    }

    const fm = C.frameMesh, bm = C.blobMesh;
    const strutLen = S.graph.edges.reduce((s, e) => s + e.length, 0);
    const stats = {
      cells: S.cells.length,
      active: S.cells.filter((c) => c.active).length,
      subCells: S.subCells.length,
      blobCells: blobCells.filter((c) => c.active).length,
      struts: S.graph.edges.length,
      nodes: S.graph.nodes.length,
      strutLength: strutLen,
      frameVolume: Math.abs(meshVolume(fm.positions, fm.indices)),
      blobVolume: Math.abs(meshVolume(bm.positions, bm.indices)),
      blobArea: meshArea(bm.positions, bm.indices),
      frameTris: fm.indices.length / 3,
      blobTris: bm.indices.length / 3,
      bmin: S.boundary.bmin, bmax: S.boundary.bmax,
      grid: grid.dims.join('×'),
      voxel: grid.h,
      cords: C.cords,
      subdLevels: Math.max(fm.levels, bm.levels),
    };
    return {
      frame: { positions: fm.positions.slice(), normals: fm.normals.slice(), indices: fm.indices.slice(), wire: fm.wire.slice() },
      blob: { positions: bm.positions.slice(), normals: bm.normals.slice(), indices: bm.indices.slice(), wire: bm.wire.slice() },
      seeds: S.seeds,
      cells: S.cells.map((c) => ({ index: c.index, seed: c.seed, active: c.active, centroid: c.centroid, volume: c.volume })),
      blobSeeds: blobCells.map((c) => c.seed),
      cellLines: C.cellLines.slice(),
      subLines: C.subLines.slice(),
      graph: { nodes: S.graph.nodes, edges: S.graph.edges, valence: S.graph.valence },
      stats, timings: T,
    };
  }

  function drawing(view, opts, show, lattice) {
    if (!C.grid) return null;
    const S = C.S;
    let g = C.grid, B = C.B, F = C.F, graph = show.centerlines ? S.graph : null;
    let realBounds = { min: S.boundary.bmin, max: S.boundary.bmax };
    if (lattice && !isIdentity(lattice)) {
      const key = JSON.stringify([C.blobKey, C.frameKey, Array.from(lattice.D), lattice.c, lattice.min, lattice.size]);
      if (C.warpKey !== key) { C.warped = warpFields(g, [B, F], lattice); C.warpKey = key; }
      g = C.warped.g; [B, F] = C.warped.outs;
      if (graph) graph = { ...graph, nodes: graph.nodes.map((n) => warpPoint(lattice, n)) };
      const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
      for (const a of [S.boundary.bmin[0], S.boundary.bmax[0]]) for (const b of [S.boundary.bmin[1], S.boundary.bmax[1]]) for (const c of [S.boundary.bmin[2], S.boundary.bmax[2]]) {
        const w = warpPoint(lattice, [a, b, c]);
        for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], w[k]); mx[k] = Math.max(mx[k], w[k]); }
      }
      realBounds = { min: mn, max: mx };
    }
    return computeDrawing({ grid: g, blobF: B, frameF: F, graph, bounds: realBounds, show }, view, opts);
  }

  return { run, drawing };
}
