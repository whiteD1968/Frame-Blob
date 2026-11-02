// Frame/Blob — file exports
import * as THREE from 'three';
import { STLExporter } from 'three/addons/STLExporter.js';
import { OBJExporter } from 'three/addons/OBJExporter.js';
import { GLTFExporter } from 'three/addons/GLTFExporter.js';
import { mergeGeometries } from 'three/addons/BufferGeometryUtils.js';

export function download(name, data, mime = 'application/octet-stream') {
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
  new GLTFExporter().parse(g, (res) => download(`${slug(name)}.glb`, res, 'model/gltf-binary'), (e) => alert('GLB export failed: ' + e), { binary: true });
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
