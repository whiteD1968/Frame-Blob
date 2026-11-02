// Frame/Blob — file exports
import * as THREE from 'three';
import { STLExporter } from 'three/addons/STLExporter.js';
import { OBJExporter } from 'three/addons/OBJExporter.js';
import { GLTFExporter } from 'three/addons/GLTFExporter.js';
import { mergeGeometries } from 'three/addons/BufferGeometryUtils.js';

// Minimal store-only ZIP (used where a host only accepts certain extensions)
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(u8) { let c = 0xffffffff; for (let i = 0; i < u8.length; i++) c = CRC[(c ^ u8[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
export async function zipOne(name, data) {
  const u8 = new Uint8Array(data instanceof Blob ? await data.arrayBuffer() : typeof data === 'string' ? new TextEncoder().encode(data) : data instanceof ArrayBuffer ? data : data.buffer);
  const nm = new TextEncoder().encode(name), crc = crc32(u8), n = u8.length;
  const lh = new DataView(new ArrayBuffer(30));
  [[0, 0x04034b50, 4], [4, 20, 2], [6, 0, 2], [8, 0, 2], [10, 0, 2], [12, 0, 2], [14, crc, 4], [18, n, 4], [22, n, 4], [26, nm.length, 2], [28, 0, 2]].forEach(([o, v, l]) => (l === 4 ? lh.setUint32(o, v, true) : lh.setUint16(o, v, true)));
  const ch = new DataView(new ArrayBuffer(46));
  [[0, 0x02014b50, 4], [4, 20, 2], [6, 20, 2], [8, 0, 2], [10, 0, 2], [12, 0, 2], [14, 0, 2], [16, crc, 4], [20, n, 4], [24, n, 4], [28, nm.length, 2], [30, 0, 2], [32, 0, 2], [34, 0, 2], [36, 0, 2], [38, 0, 4], [42, 0, 4]].forEach(([o, v, l]) => (l === 4 ? ch.setUint32(o, v, true) : ch.setUint16(o, v, true)));
  const cdOff = 30 + nm.length + n, cdLen = 46 + nm.length;
  const eo = new DataView(new ArrayBuffer(22));
  [[0, 0x06054b50, 4], [4, 0, 2], [6, 0, 2], [8, 1, 2], [10, 1, 2], [12, cdLen, 4], [16, cdOff, 4], [20, 0, 2]].forEach(([o, v, l]) => (l === 4 ? eo.setUint32(o, v, true) : eo.setUint16(o, v, true)));
  return new Blob([lh, nm, u8, ch, nm, eo], { type: 'application/zip' });
}

// Hosted preview (claude.ai artifact) saves through the host; elsewhere a plain <a download>.
const HOST_OK = new Set('gif png jpg jpeg webp txt json md csv html svg pdf zip'.split(' '));
let hostDl;
function hostDownloads() {
  if (hostDl !== undefined) return hostDl;
  hostDl = window.claude && typeof window.claude.use === 'function' ? window.claude.use('downloads').catch(() => null) : Promise.resolve(null);
  return hostDl;
}
if (window.claude) hostDownloads();

export async function download(name, data, mime = 'application/octet-stream') {
  const dl = await hostDownloads();
  if (dl) {
    const ext = name.split('.').pop().toLowerCase();
    let fname = name, payload = data instanceof Blob ? data : typeof data === 'string' ? data : new Blob([data], { type: mime });
    if (!HOST_OK.has(ext)) { payload = await zipOne(name, payload); fname = name + '.zip'; }
    try { await dl.save({ filename: fname, data: payload }); } catch (e) { if (e && e.code !== 'declined') console.warn('download', e); }
    return;
  }
  const blob = data instanceof Blob ? data : new Blob([data], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function slug(s) {
  return (s || 'frame-blob').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'frame-blob';
}

function meshFor(geom, name) {
  const m = new THREE.Mesh(geom.clone(), new THREE.MeshStandardMaterial());
  m.name = name;
  return m;
}

export function exportSTL(viewer, which, name) {
  const ex = new STLExporter();
  const parts = [];
  if (which === 'frame' || which === 'both') parts.push(viewer.frameMesh.geometry);
  if (which === 'blob' || which === 'both') parts.push(viewer.blobMesh.geometry);
  const geo = parts.length > 1 ? mergeGeometries(parts) : parts[0].clone();
  const data = ex.parse(new THREE.Mesh(geo), { binary: true });
  download(`${slug(name)}-${which}.stl`, data, 'model/stl');
}

export function exportOBJ(viewer, name) {
  const g = new THREE.Group();
  g.add(meshFor(viewer.frameMesh.geometry, 'frame'), meshFor(viewer.blobMesh.geometry, 'blob'));
  download(`${slug(name)}.obj`, new OBJExporter().parse(g), 'text/plain');
}

export function exportGLB(viewer, name) {
  const g = new THREE.Group();
  // plain PBR copies (texture maps stripped: keeps files small and exporters fast)
  const plain = (m) => new THREE.MeshPhysicalMaterial({
    color: m.color, roughness: m.roughness, metalness: m.metalness,
    transmission: m.transmission || 0, ior: m.ior || 1.5, thickness: m.thickness || 0,
    clearcoat: m.clearcoat || 0, sheen: m.sheen || 0, transparent: m.transparent, opacity: m.opacity,
  });
  const f = new THREE.Mesh(viewer.frameMesh.geometry.clone(), plain(viewer.frameMesh.material)); f.name = 'frame';
  const b = new THREE.Mesh(viewer.blobMesh.geometry.clone(), plain(viewer.blobMesh.material)); b.name = 'blob';
  f.geometry.deleteAttribute('uv'); b.geometry.deleteAttribute('uv');
  g.add(f, b);
  // GLB is Y-up: rotate Z-up model
  g.rotation.x = -Math.PI / 2;
  g.updateMatrixWorld(true);
  new GLTFExporter().parse(g, (res) => download(`${slug(name)}.glb`, res, 'model/gltf-binary'), (e) => console.error('GLB export failed', e), { binary: true });
}

export function exportPNG(viewer, name, view) {
  const c = viewer.captureHiRes(2);
  c.toBlob((b) => download(`${slug(name)}-${view}.png`, b, 'image/png'), 'image/png');
}

export function cutListCSV(graph, P) {
  const rows = ['type,id,level,a,b,length,radius,x,y,z,valence'];
  graph.edges.forEach((e, i) => {
    const r = e.level === 1 ? P.radius : P.radius * P.subRadius;
    rows.push(`strut,S${i + 1},${e.level === 1 ? 'primary' : 'secondary'},N${e.a + 1},N${e.b + 1},${e.length.toFixed(2)},${r.toFixed(2)},,,,`);
  });
  graph.nodes.forEach((n, i) => {
    rows.push(`node,N${i + 1},,,,,,${n[0].toFixed(2)},${n[1].toFixed(2)},${n[2].toFixed(2)},${graph.valence[i]}`);
  });
  // summary of distinct lengths (rounded) — useful for kit-of-parts
  const bins = new Map();
  for (const e of graph.edges) { const k = Math.round(e.length); bins.set(k, (bins.get(k) || 0) + 1); }
  rows.push('');
  rows.push('summary,length_rounded,count');
  [...bins.entries()].sort((a, b) => a[0] - b[0]).forEach(([k, v]) => rows.push(`bin,${k},${v}`));
  return rows.join('\n');
}
