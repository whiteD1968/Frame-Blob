// Frame/Blob — cached geometry pipeline (runs in a worker, or on the main thread as fallback)
import { buildCells, buildBlobCells, mulberry32 } from './geom/voronoi.js';
import { makeGrid, frameField, blobField, applyGroove, wrapGraph } from './geom/field.js';
import { polygonise, meshVolume, meshArea } from './geom/mesh.js';
import { computeDrawing } from './geom/drawing.js';

const CELL_KEYS = ['boundary', 'sizeX', 'sizeY', 'sizeZ', 'lattice', 'count', 'nx', 'ny', 'nz', 'jitter', 'gradient', 'gradAxis',
  'relax', 'seed', 'cull', 'disabled', 'subdiv', 'subSeed', 'subRelax', 'frameScope', 'skinEdges'];
const BLOBCELL_KEYS = ['boundary', 'sizeX', 'sizeY', 'sizeZ', 'blobSource', 'blobLattice', 'blobCount', 'blobSeed', 'blobRelax', 'nx', 'ny', 'nz', 'gradAxis'];
const FRAME_KEYS = ['radius', 'nodeScale', 'taper', 'fillet', 'subRadius', 'wrap'];
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
      C.frameGraph = P.wrap > 0 ? wrapGraph(S.graph, C.Braw, grid, S.boundary, P) : S.graph;
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
    if (!C.frameMesh || C.frameSmooth !== P.smooth) { C.frameMesh = polygonise(C.F, grid, P.smooth); }
    if (!C.blobMesh || C.blobSmooth !== P.smooth) { C.blobMesh = polygonise(C.B, grid, P.smooth); }
    C.frameSmooth = C.blobSmooth = P.smooth;
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
    };
    return {
      frame: { positions: fm.positions.slice(), normals: fm.normals.slice(), indices: fm.indices.slice() },
      blob: { positions: bm.positions.slice(), normals: bm.normals.slice(), indices: bm.indices.slice() },
      seeds: S.seeds,
      cells: S.cells.map((c) => ({ index: c.index, seed: c.seed, active: c.active, centroid: c.centroid, volume: c.volume })),
      blobSeeds: blobCells.map((c) => c.seed),
      cellLines: C.cellLines.slice(),
      subLines: C.subLines.slice(),
      graph: { nodes: S.graph.nodes, edges: S.graph.edges, valence: S.graph.valence },
      stats, timings: T,
    };
  }

  function drawing(view, opts, show) {
    if (!C.grid) return null;
    const S = C.S;
    // bounds of actual geometry (boundary bbox grown by pad)
    const g = C.grid;
    const bounds = { min: g.origin, max: g.origin.map((o, i) => o + g.h * (g.dims[i] - 1)) };
    const realBounds = { min: S.boundary.bmin, max: S.boundary.bmax };
    return computeDrawing({ grid: g, blobF: C.B, frameF: C.F, graph: show.centerlines ? S.graph : null, bounds: opts.useModelBounds ? realBounds : bounds, show }, view, opts);
  }

  return { run, drawing };
}
