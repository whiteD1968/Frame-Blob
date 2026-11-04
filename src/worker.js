// Frame/Blob — geometry worker
import { createEngine } from './engine.js';

const engine = createEngine();

self.onmessage = (ev) => {
  const { id, type, P, res, view, opts, show, lattice } = ev.data;
  try {
    if (type === 'run') {
      const out = engine.run(P, res);
      const tr = [out.frame.positions.buffer, out.frame.normals.buffer, out.frame.indices.buffer,
        out.blob.positions.buffer, out.blob.normals.buffer, out.blob.indices.buffer, out.frame.wire.buffer, out.blob.wire.buffer, out.cellLines.buffer, out.subLines.buffer];
      self.postMessage({ id, type, out, res }, tr);
    } else if (type === 'quads') {
      self.postMessage({ id, type, out: engine.quads(ev.data.level, P) });
    } else if (type === 'printFrame' || type === 'printBlob') {
      const out = type === 'printFrame' ? engine.printFrame(P, ev.data.budget, ev.data.quality) : engine.printBlob();
      self.postMessage({ id, type, out }, out ? [out.positions.buffer, out.normals.buffer, out.indices.buffer] : []);
    } else if (type === 'drawing') {
      self.postMessage({ id, type, out: engine.drawing(view, opts, show, lattice) });
    }
  } catch (err) {
    self.postMessage({ id, type, error: String(err && err.stack || err) });
  }
};
