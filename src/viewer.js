// Frame/Blob — viewport: cameras (persp / axon / plan / front / side / quad), studio lighting,
// shader stack, wire overlays, X-ray frame, lattice-warped display, picking
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/RoomEnvironment.js';
import { studioEnvironment, studioRig, placeRig, FadingGrid, FOIL, MATTE, styledMaterial, IRI_UNIFORMS,
  fresnelMaterial, zebraMaterial, ghostMaterial, backfaceMaterial, cavityMaterial } from './shaders.js';
import { warpPositions, isIdentity } from './geom/ffd.js';

THREE.Object3D.DEFAULT_UP.set(0, 0, 1);

export const VIEW_NAMES = ['persp', 'axon', 'plan', 'front', 'side'];
const VIEW_DIRS = {
  persp: new THREE.Vector3(1.15, -1.6, 0.85),
  axon: new THREE.Vector3(1, -1, 1),
  plan: new THREE.Vector3(0, 0, 1),
  front: new THREE.Vector3(0, -1, 0),
  side: new THREE.Vector3(1, 0, 0),
};

function makeFabricTexture() {
  const s = 256, c = document.createElement('canvas');
  c.width = c.height = s;
  const g = c.getContext('2d');
  const img = g.createImageData(s, s);
  for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
    const w = (Math.sin(x * 1.6) * 0.5 + 0.5) * (y % 4 < 2 ? 1 : 0.6) + (Math.sin(y * 1.6) * 0.5 + 0.5) * (x % 4 < 2 ? 0.6 : 1);
    const v = 128 + (w - 0.8) * 50 + (Math.random() - 0.5) * 18;
    const i = (y * s + x) * 4;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v; img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

export class Viewer {
  constructor(container) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.12;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.environmentRotation.set(Math.PI / 2, 0, 0); // Y-up environments → Z-up world
    this.envs = {};

    this.rig = studioRig();
    this.scene.add(this.rig);

    this.ground = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShadowMaterial({ opacity: 0.16 }));
    this.ground.receiveShadow = true;
    this.scene.add(this.ground);
    this.grid = new FadingGrid();
    this.scene.add(this.grid.mesh);

    this.group = new THREE.Group();
    this.scene.add(this.group);

    this.fabricTex = makeFabricTexture();
    this.frameMesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial());
    this.blobMesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial());
    this.frameXray = new THREE.Mesh(this.frameMesh.geometry, fresnelMaterial({ xray: true, color: 0x1d6f8a, rim: 0x9fe6ff }));
    this.frameXray.renderOrder = 20;
    this.frameMesh.renderOrder = 1;
    this.wireMat = new THREE.LineBasicMaterial({ color: 0x3a3f3a, transparent: true, opacity: 0.35, depthWrite: false });
    this.frameWire = new THREE.LineSegments(new THREE.BufferGeometry(), this.wireMat);
    this.blobWire = new THREE.LineSegments(new THREE.BufferGeometry(), this.wireMat);
    this.frameWire.renderOrder = this.blobWire.renderOrder = 5;
    for (const m of [this.frameMesh, this.blobMesh]) { m.castShadow = true; m.receiveShadow = true; }
    this.cellLines = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xc0392b, transparent: true, opacity: 0.55 }));
    this.subLines = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0x2b6cc0, transparent: true, opacity: 0.4 }));
    this.seedPts = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ color: 0xc0392b, size: 6, sizeAttenuation: false }));
    this.offPts = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ color: 0x888888, size: 5, sizeAttenuation: false }));
    this.highlight = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), new THREE.MeshBasicMaterial({ color: 0xc0392b, transparent: true, opacity: 0.85, depthTest: false }));
    this.highlight.visible = false;
    this.highlight.renderOrder = 30;
    this.group.add(this.blobMesh, this.frameMesh, this.frameXray, this.blobWire, this.frameWire, this.cellLines, this.subLines, this.seedPts, this.offPts, this.highlight);

    // cameras
    this.cams = {
      persp: new THREE.PerspectiveCamera(32, 1, 0.5, 50000),
      axon: new THREE.OrthographicCamera(-1, 1, 1, -1, -50000, 50000),
      plan: new THREE.OrthographicCamera(-1, 1, 1, -1, -50000, 50000),
      front: new THREE.OrthographicCamera(-1, 1, 1, -1, -50000, 50000),
      side: new THREE.OrthographicCamera(-1, 1, 1, -1, -50000, 50000),
    };
    this.cams.plan.up.set(0, 1, 0);
    this.controls = {};
    this.dirty = true;
    for (const n of VIEW_NAMES) {
      const c = new OrbitControls(this.cams[n], this.renderer.domElement);
      c.enableDamping = true; c.dampingFactor = 0.12;
      c.screenSpacePanning = true;
      if (n === 'plan' || n === 'front' || n === 'side') c.enableRotate = false;
      c.enabled = false;
      c.addEventListener('change', () => (this.dirty = true));
      this.controls[n] = c;
    }
    this.view = 'persp';
    this.quad = false;
    this.listeners = new Set();
    this.bounds = new THREE.Box3(new THREE.Vector3(-80, -80, 0), new THREE.Vector3(80, 80, 130));
    this.lattice = null;
    this.rest = null;
    this.setView('persp', true);

    this.renderer.domElement.addEventListener('pointerdown', (e) => this._quadPointer(e), { capture: true });
    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    const loop = () => {
      requestAnimationFrame(loop);
      for (const n of VIEW_NAMES) if (this.controls[n].enabled) this.controls[n].update();
      if (this.dirty) { this.dirty = false; this.render(); }
    };
    loop();
  }

  invalidate() { this.dirty = true; }
  get camera() { return this.cams[this.view]; }
  onViewChange(fn) { this.listeners.add(fn); }

  resize() {
    this.dirty = true;
    const w = this.container.clientWidth, h = this.container.clientHeight;
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = w + 'px';
    this.renderer.domElement.style.height = h + 'px';
    this._updateFrustums();
  }

  _aspectFor() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    return this.quad ? (w / 2) / (h / 2) : w / Math.max(h, 1);
  }

  _updateFrustums() {
    for (const n of VIEW_NAMES) {
      const cam = this.cams[n], a = this._aspectFor(n);
      if (cam.isPerspectiveCamera) cam.aspect = a;
      else {
        const hh = cam.userData.half || 100;
        cam.left = -hh * a; cam.right = hh * a; cam.top = hh; cam.bottom = -hh;
      }
      cam.updateProjectionMatrix();
    }
  }

  fit(name, keepDir = false) {
    this.dirty = true;
    const cam = this.cams[name], ctl = this.controls[name];
    const c = this.bounds.getCenter(new THREE.Vector3());
    const size = this.bounds.getSize(new THREE.Vector3());
    const r = size.length() / 2 || 100;
    let dir = VIEW_DIRS[name].clone().normalize();
    if (keepDir && name !== 'plan' && name !== 'front' && name !== 'side') dir = cam.position.clone().sub(ctl.target).normalize();
    if (cam.isPerspectiveCamera) {
      const dist = r / Math.sin(THREE.MathUtils.degToRad(cam.fov / 2)) * 1.05;
      cam.position.copy(c).addScaledVector(dir, dist);
      cam.near = dist / 100; cam.far = dist * 100;
    } else {
      cam.position.copy(c).addScaledVector(dir, r * 4);
      let half;
      if (name === 'plan') half = Math.max(size.y, size.x / this._aspectFor(name)) * 0.62;
      else if (name === 'front') half = Math.max(size.z, size.x / this._aspectFor(name)) * 0.62;
      else if (name === 'side') half = Math.max(size.z, size.y / this._aspectFor(name)) * 0.62;
      else half = r * 1.0;
      cam.userData.half = half; cam.zoom = 1;
    }
    if (name === 'plan') cam.up.set(0, 1, 0); else cam.up.set(0, 0, 1);
    cam.lookAt(c);
    ctl.target.copy(c);
    cam.updateProjectionMatrix();
    this._updateFrustums();
    ctl.update();
  }

  setView(name, refit = false) {
    this.dirty = true;
    if (name === 'quad') { this.quad = !this.quad; this._updateFrustums(); this.fitAll(); this._activate(this.view); return; }
    const wasQuad = this.quad;
    this.quad = false;
    this.view = name;
    this._updateFrustums();
    if (wasQuad) refit = true;
    if (refit || !this._fitted?.[name]) { this.fit(name); (this._fitted ||= {})[name] = true; }
    this._activate(name);
  }

  _activate(name) {
    for (const n of VIEW_NAMES) this.controls[n].enabled = n === name;
    for (const fn of this.listeners) fn(name);
  }

  _quadLayout() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    const hw = w / 2, hh = h / 2;
    return [['persp', 0, hh, hw, hh], ['axon', hw, hh, hw, hh], ['plan', 0, 0, hw, hh], ['front', hw, 0, hw, hh]];
  }

  _quadPointer(e) {
    if (!this.quad) return;
    const r = this.renderer.domElement.getBoundingClientRect();
    const x = e.clientX - r.left, y = r.bottom - e.clientY;
    for (const [n, qx, qy, qw, qh] of this._quadLayout()) {
      if (x >= qx && x < qx + qw && y >= qy && y < qy + qh) { if (this.view !== n) { this.view = n; this._activate(n); } break; }
    }
  }

  // viewport rect + camera under a client point
  viewAt(clientX, clientY) {
    const r = this.renderer.domElement.getBoundingClientRect();
    const x = clientX - r.left, y = clientY - r.top;
    if (this.quad) {
      for (const [n, qx, qy, qw, qh] of this._quadLayout()) {
        const top = r.height - qy - qh;
        if (x >= qx && x < qx + qw && y >= top && y < top + qh) return { cam: this.cams[n], x: qx, y: top, w: qw, h: qh, rect: r };
      }
    }
    return { cam: this.cams[this.view], x: 0, y: 0, w: r.width, h: r.height, rect: r };
  }

  fitAll() { for (const n of VIEW_NAMES) this.fit(n, true); }

  render() {
    const R = this.renderer;
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!this.quad) {
      R.setScissorTest(false);
      R.setViewport(0, 0, w, h);
      R.render(this.scene, this.cams[this.view]);
      return;
    }
    R.setScissorTest(true);
    for (const [n, x, y, qw, qh] of this._quadLayout()) {
      R.setViewport(x, y, qw, qh);
      R.setScissor(x, y, qw, qh);
      R.render(this.scene, this.cams[n]);
    }
    R.setScissorTest(false);
  }

  // ------------------------------------------------------------ geometry (+ lattice warp)
  setGeometry(out) {
    this.dirty = true;
    this.rest = out;
    const mk = (m) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(m.positions), 3));
      g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(m.normals), 3));
      g.setIndex(new THREE.BufferAttribute(m.indices, 1));
      const p = m.positions, uv = new Float32Array((p.length / 3) * 2);
      for (let i = 0, j = 0; i < p.length; i += 3, j += 2) { uv[j] = (p[i] + p[i + 2] * 0.7) / 6; uv[j + 1] = (p[i + 1] + p[i + 2] * 0.7) / 6; }
      g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
      return g;
    };
    const wireGeo = (geo, wire) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', geo.attributes.position); // shared: warps along with the mesh
      if (wire) g.setIndex(new THREE.BufferAttribute(wire, 1));
      return g;
    };
    this.frameMesh.geometry.dispose(); this.frameMesh.geometry = mk(out.frame);
    this.blobMesh.geometry.dispose(); this.blobMesh.geometry = mk(out.blob);
    this.frameXray.geometry = this.frameMesh.geometry;
    this.frameWire.geometry.dispose(); this.frameWire.geometry = wireGeo(this.frameMesh.geometry, out.frame.wire);
    this.blobWire.geometry.dispose(); this.blobWire.geometry = wireGeo(this.blobMesh.geometry, out.blob.wire);

    const lg = (arr) => { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(arr), 3)); return g; };
    this.cellLines.geometry.dispose(); this.cellLines.geometry = lg(out.cellLines);
    this.subLines.geometry.dispose(); this.subLines.geometry = lg(out.subLines);
    const on = [], off = [];
    for (const c of out.cells) (c.active ? on : off).push(...c.seed);
    this.restAux = { cellLines: out.cellLines, subLines: out.subLines, on: new Float32Array(on), off: new Float32Array(off) };
    this.seedPts.geometry.dispose(); this.seedPts.geometry = lg(on);
    this.offPts.geometry.dispose(); this.offPts.geometry = lg(off);
    this.applyWarp(false);
    const first = !this._hasGeo;
    this._hasGeo = true;
    if (first || this.wantFit) { this.wantFit = false; for (const n of VIEW_NAMES) this.fit(n, !first); }
  }

  setLattice(L) { this.lattice = L; this.applyWarp(true); }

  // Deform display meshes with the lattice (cheap: per-vertex trilinear) — Atlas applyLatticeDeformation
  applyWarp(fast = true) {
    if (!this.rest) return;
    this.dirty = true;
    const L = this.lattice, warped = L && !isIdentity(L);
    const upd = (mesh, src) => {
      const g = mesh.geometry, pa = g.attributes.position;
      if (warped) pa.array.set(warpPositions(L, src.positions)); else pa.array.set(src.positions);
      pa.needsUpdate = true;
      if (warped) g.computeVertexNormals();
      else { g.attributes.normal.array.set(src.normals); g.attributes.normal.needsUpdate = true; }
      g.computeBoundingBox(); g.computeBoundingSphere();
    };
    upd(this.frameMesh, this.rest.frame);
    upd(this.blobMesh, this.rest.blob);
    const aux = (obj, arr) => { const a = obj.geometry.attributes.position; if (!a) return; a.array.set(warped ? warpPositions(L, arr) : arr); a.needsUpdate = true; obj.geometry.computeBoundingSphere(); };
    if (this.restAux) {
      aux(this.cellLines, this.restAux.cellLines); aux(this.subLines, this.restAux.subLines);
      aux(this.seedPts, this.restAux.on); aux(this.offPts, this.restAux.off);
    }
    const b = new THREE.Box3();
    if (this.rest.blob.positions.length) b.union(this.blobMesh.geometry.boundingBox);
    if (this.rest.frame.positions.length) b.union(this.frameMesh.geometry.boundingBox);
    if (b.isEmpty()) b.set(new THREE.Vector3(...this.rest.stats.bmin), new THREE.Vector3(...this.rest.stats.bmax));
    this.bounds.copy(b);
    if (!fast) this._placeGroundAndLight();
  }

  _placeGroundAndLight() {
    const b = this.bounds, c = b.getCenter(new THREE.Vector3()), s = b.getSize(new THREE.Vector3());
    const r = s.length();
    this.ground.position.set(c.x, c.y, b.min.z - 0.01);
    this.ground.scale.set(r * 6, r * 6, 1);
    placeRig(this.rig, c, r);
    this.grid.configure(r, b.min.z - 0.02, this._dark);
    IRI_UNIFORMS.uIriScale.value = 4 / Math.max(r, 1e-3);
  }

  // ------------------------------------------------------------ display / shaders / lighting
  setMaterial() { this._lookKey = null; this.dirty = true; }

  setDisplay(P) {
    this.dirty = true;
    this.frameMesh.visible = P.showFrame;
    this.blobMesh.visible = P.showBlob;
    this.frameXray.visible = P.showFrame && !!P.xray;
    const wire = P.wire || 'off';
    this.blobWire.visible = P.showBlob && (wire === 'blob' || wire === 'both' || (wire === 'off' && P.material === 'diagram'));
    this.frameWire.visible = P.showFrame && (wire === 'frame' || wire === 'both');
    this.wireMat.color.set(P.wireColor || '#3a3f3a');
    this.wireMat.opacity = P.material === 'diagram' && wire === 'off' ? 0.08 : 0.4;
    this.cellLines.visible = P.showCells;
    this.subLines.visible = P.showCells;
    this.seedPts.visible = P.showSeeds;
    this.offPts.visible = P.showSeeds;
    this.ground.visible = P.showGround;
    this.grid.mesh.visible = P.showGround;
    this.renderer.toneMappingExposure = P.exposure ?? 1.12;
    const key = JSON.stringify([P.material, P.frameShader, P.blobShader, P.frameColor, P.blobOpacity, P.lighting, P.zebraFreq]);
    if (this._lookKey !== key) { this._lookKey = key; this._applyLook(P); }
  }

  _env(kind) {
    if (!this.envs[kind]) {
      if (kind === 'room') { const pm = new THREE.PMREMGenerator(this.renderer); this.envs.room = pm.fromScene(new RoomEnvironment(), 0.04).texture; pm.dispose(); }
      else this.envs[kind] = studioEnvironment(this.renderer, { dark: kind === 'dark' });
    }
    return this.envs[kind];
  }

  _applyLook(P) {
    const name = P.material;
    const lighting = P.lighting || 'studio';
    const dark = name === 'diagram' || lighting === 'dark';
    this._dark = dark;
    document.body.classList.toggle('dark', dark);
    this.scene.environment = this._env(lighting);
    this.scene.environmentIntensity = lighting === 'room' ? 0.9 : 1.0;
    // light rig levels per lighting mode
    const L = this.rig.userData;
    const lv = lighting === 'room' ? [1.6, 0, 0, 0, 0, 0, 0.35] : lighting === 'dark' ? [2.4, 0.2, 2.6, 0.4, 0.5, 0.6, 0.15] : [3.6, 0.52, 0.46, 0.74, 1.1, 1.26, 0.62];
    L.lights.forEach((l, i) => (l.intensity = lv[i]));
    L.hemi.intensity = lv[6];

    // preset materials
    let blob, frame;
    switch (name) {
      case 'frosted-cord':
        blob = new THREE.MeshPhysicalMaterial({ color: 0xe4e7e8, roughness: 0.5, transmission: 0.55, thickness: 12, ior: 1.45, attenuationColor: new THREE.Color(0xd9dfe2), attenuationDistance: 30, clearcoat: 0.4, clearcoatRoughness: 0.4 });
        frame = new THREE.MeshStandardMaterial({ color: 0x141414, roughness: 0.55 });
        break;
      case 'etfe-steel':
        blob = new THREE.MeshPhysicalMaterial({ color: 0xeef3f7, roughness: 0.32, iridescence: 0.55, iridescenceIOR: 1.35, iridescenceThicknessRange: [200, 600], clearcoat: 1, clearcoatRoughness: 0.15, sheen: 0.3, sheenColor: new THREE.Color(0xdfe8ff) });
        frame = new THREE.MeshStandardMaterial({ color: 0xb9bcc0, roughness: 0.28, metalness: 1.0 });
        break;
      case 'plaster':
        blob = new THREE.MeshStandardMaterial({ color: 0xf2f0ec, roughness: 0.92 });
        frame = new THREE.MeshStandardMaterial({ color: 0xe6e3dd, roughness: 0.85 });
        break;
      case 'clay':
        blob = new THREE.MeshStandardMaterial({ color: 0xc9825f, roughness: 0.85 });
        frame = new THREE.MeshStandardMaterial({ color: 0x5b4636, roughness: 0.6 });
        break;
      case 'foil':
        blob = styledMaterial(FOIL);
        frame = new THREE.MeshStandardMaterial({ color: 0x2a2d2c, roughness: 0.35, metalness: 0.6 });
        break;
      case 'diagram':
        blob = new THREE.MeshStandardMaterial({ color: 0x9a9a9a, roughness: 0.35, metalness: 0.1, transparent: true, opacity: 0.9 });
        frame = new THREE.MeshStandardMaterial({ color: 0xf5f5f5, roughness: 0.3, emissive: 0x222222 });
        break;
      default: // fabric-glass
        blob = new THREE.MeshPhysicalMaterial({ color: 0xf7f7f5, roughness: 0.88, sheen: 1, sheenRoughness: 0.55, sheenColor: new THREE.Color(0xffffff), bumpMap: this.fabricTex, bumpScale: 0.35 });
        frame = new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.03, transmission: 1, thickness: 3, ior: 1.5, dispersion: 2, attenuationColor: new THREE.Color(0xc8dcdc), attenuationDistance: 8, specularIntensity: 1 });
    }
    // shader overrides
    const fc = new THREE.Color(P.frameColor || '#2b3a40');
    switch (P.frameShader) {
      case 'fresnel': frame = fresnelMaterial({ color: fc, rim: 0xffffff }); break;
      case 'solid': frame = new THREE.MeshStandardMaterial({ color: fc, roughness: 0.5 }); break;
      case 'foil': frame = styledMaterial(FOIL, fc); break;
      case 'glass': frame = new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.04, transmission: 1, thickness: 4, ior: 1.5, attenuationColor: fc, attenuationDistance: 6, specularIntensity: 1 }); break;
      default: break; // 'preset'
    }
    switch (P.blobShader) {
      case 'foil': blob = styledMaterial(FOIL); break;
      case 'matte': blob = styledMaterial(MATTE); break;
      case 'ghost': blob = ghostMaterial({ opacity: 0.3 }); break;
      case 'zebra': blob = zebraMaterial({ freq: P.zebraFreq || 14 }); break;
      case 'cavity': blob = cavityMaterial(); break;
      case 'normals': blob = new THREE.MeshNormalMaterial(); break;
      case 'backfaces': blob = backfaceMaterial(); frame = backfaceMaterial(); break;
      default: break;
    }
    const op = P.blobOpacity ?? 1;
    if (op < 1 && !blob.isShaderMaterial) { blob.transparent = true; blob.opacity = op; blob.depthWrite = false; }
    if (blob.bumpMap) blob.bumpMap.repeat.set(1, 1);
    this.blobMesh.material.dispose(); this.blobMesh.material = blob;
    this.frameMesh.material.dispose(); this.frameMesh.material = frame;
    this.blobMesh.castShadow = !(blob.transparent && op < 0.6) && P.blobShader !== 'ghost';
    this.ground.material.opacity = dark ? 0.4 : 0.16;
    this.grid.configure(this.bounds.getSize(new THREE.Vector3()).length(), this.bounds.min.z - 0.02, dark);
  }

  // ------------------------------------------------------------ picking
  pick(e) {
    const v = this.viewAt(e.clientX, e.clientY);
    const x = e.clientX - v.rect.left, y = e.clientY - v.rect.top;
    const ndc = new THREE.Vector2(((x - v.x) / v.w) * 2 - 1, -((y - v.y) / v.h) * 2 + 1);
    const rc = new THREE.Raycaster();
    rc.setFromCamera(ndc, v.cam);
    const targets = [this.blobMesh, this.frameMesh].filter((m) => m.visible);
    const hit = rc.intersectObjects(targets, false)[0];
    return hit ? hit.point : null;
  }

  flash(p, r) {
    this.highlight.position.copy(p);
    this.highlight.scale.setScalar(r);
    this.highlight.visible = true; this.dirty = true;
    clearTimeout(this._ft);
    this._ft = setTimeout(() => { this.highlight.visible = false; this.dirty = true; }, 450);
  }

  // ------------------------------------------------------------ capture
  capture(maxW = 360, type = 'image/jpeg') {
    this.render();
    const src = this.renderer.domElement;
    const s = Math.min(1, maxW / src.width);
    const c = document.createElement('canvas');
    c.width = Math.round(src.width * s); c.height = Math.round(src.height * s);
    const g = c.getContext('2d');
    g.fillStyle = this._dark ? '#0d0d0d' : '#dcdcd8';
    g.fillRect(0, 0, c.width, c.height);
    g.drawImage(src, 0, 0, c.width, c.height);
    return c.toDataURL(type, 0.85);
  }

  captureHiRes(scale = 2) {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    const pr = this.renderer.getPixelRatio();
    scale = Math.min(scale, 4096 / (w * pr));
    this.renderer.setPixelRatio(pr * scale);
    this.renderer.setSize(w, h, false);
    this.render();
    const c = document.createElement('canvas');
    const src = this.renderer.domElement;
    c.width = src.width; c.height = src.height;
    const g = c.getContext('2d');
    g.fillStyle = this._dark ? '#0d0d0d' : '#dcdcd8';
    g.fillRect(0, 0, c.width, c.height);
    g.drawImage(src, 0, 0);
    this.renderer.setPixelRatio(pr);
    this.resize();
    return c;
  }
}
