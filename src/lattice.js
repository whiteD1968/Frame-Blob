// Frame/Blob — lattice editor (interaction model from Minimal_Surface_Atlas_3):
//   LMB select · Shift+LMB add/toggle · Ctrl+LMB remove · LMB-drag marquee (Ctrl = deselect box)
//   gizmo moves / rotates / scales the selection about its average · falloff radius + strength
//   RMB orbit · MMB pan while editing
import * as THREE from 'three';
import { TransformControls } from 'three/addons/TransformControls.js';
import { restPoint, ffdIndex, influenceWeights } from './geom/ffd.js';

const COL = { pt: new THREE.Color(0x6f746f), sel: new THREE.Color(0xc0392b), hover: new THREE.Color(0x111111) };

export class LatticeEditor {
  constructor(viewer, { onChange, getSettings }) {
    this.v = viewer;
    this.onChange = onChange;
    this.getSettings = getSettings;
    this.L = null;
    this.sel = new Set();
    this.enabled = false;
    this.visible = false;
    this.group = new THREE.Group();
    this.group.renderOrder = 40;
    viewer.scene.add(this.group);
    this.lines = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0x777777, transparent: true, opacity: 0.7, depthTest: false }));
    this.lines.renderOrder = 40;
    this.points = null;
    this.group.add(this.lines);

    this.anchor = new THREE.Object3D();
    viewer.scene.add(this.anchor);
    this.gizmo = new TransformControls(viewer.camera, viewer.renderer.domElement);
    this.gizmo.setSize(0.8);
    this.gizmo.attach(this.anchor);
    this.helper = this.gizmo.getHelper();
    this.helper.visible = false;
    this.gizmo.enabled = false;
    viewer.scene.add(this.helper);
    this.gizmo.addEventListener('change', () => viewer.invalidate());
    this.gizmo.addEventListener('dragging-changed', (e) => {
      for (const c of Object.values(viewer.controls)) c.enabled = !e.value && c === viewer.controls[viewer.view];
      if (e.value) this._beginDrag(); else this._endDrag();
    });
    this.gizmo.addEventListener('objectChange', () => this._drag());
    viewer.onViewChange(() => { this.gizmo.camera = viewer.camera; viewer.invalidate(); });

    this.marquee = document.createElement('div');
    this.marquee.className = 'lattice-marquee';
    this.marquee.hidden = true;
    viewer.container.appendChild(this.marquee);
    const el = viewer.renderer.domElement;
    el.addEventListener('pointerdown', (e) => this._down(e));
    window.addEventListener('pointermove', (e) => this._move(e));
    window.addEventListener('pointerup', (e) => this._up(e));
  }

  // -------------------------------------------------------------- state
  setLattice(L) {
    const changedShape = !this.L || this.L.c.join() !== L.c.join();
    this.L = L;
    if (changedShape) this.sel.clear();
    this._rebuild();
  }

  setVisible(v) { this.visible = v; this.group.visible = v; this._syncGizmo(); this.v.invalidate(); }

  setEnabled(on) {
    this.enabled = on;
    this.setVisible(on || this.visible);
    for (const c of Object.values(this.v.controls)) {
      c.mouseButtons = on
        ? { LEFT: null, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE }
        : { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
    }
    this._syncGizmo();
  }

  setMode(m) { this.gizmo.setMode(m); this.v.invalidate(); }

  pos(idx) {
    const L = this.L, c = L.c;
    const i = idx % c[0], j = Math.floor(idx / c[0]) % c[1], k = Math.floor(idx / (c[0] * c[1]));
    const r = restPoint(L, i, j, k);
    return new THREE.Vector3(r[0] + L.D[3 * idx], r[1] + L.D[3 * idx + 1], r[2] + L.D[3 * idx + 2]);
  }
  count() { return this.L ? this.L.c[0] * this.L.c[1] * this.L.c[2] : 0; }

  selectAll() { for (let i = 0; i < this.count(); i++) this.sel.add(i); this._refresh(); }
  clear() { this.sel.clear(); this._refresh(); }

  // -------------------------------------------------------------- visuals
  _rebuild() {
    if (this.points) { this.group.remove(this.points); this.points.geometry.dispose(); }
    const n = this.count();
    const r = this.v.bounds.getSize(new THREE.Vector3()).length() * 0.007 || 1;
    this.points = new THREE.InstancedMesh(new THREE.SphereGeometry(r, 12, 8), new THREE.MeshBasicMaterial({ depthTest: false, transparent: true }), Math.max(n, 1));
    this.points.renderOrder = 41;
    this.points.count = n;
    this.group.add(this.points);
    this._refresh();
  }

  _refresh() {
    if (!this.L) return;
    const L = this.L, c = L.c, m = new THREE.Matrix4(), n = this.count();
    for (let i = 0; i < n; i++) {
      m.makeTranslation(this.pos(i));
      this.points.setMatrixAt(i, m);
      this.points.setColorAt(i, this.sel.has(i) ? COL.sel : i === this.hover ? COL.hover : COL.pt);
    }
    this.points.instanceMatrix.needsUpdate = true;
    if (this.points.instanceColor) this.points.instanceColor.needsUpdate = true;
    const seg = [];
    const push = (a, b) => { const p = this.pos(a), q = this.pos(b); seg.push(p.x, p.y, p.z, q.x, q.y, q.z); };
    for (let k = 0; k < c[2]; k++) for (let j = 0; j < c[1]; j++) for (let i = 0; i < c[0]; i++) {
      const id = ffdIndex(L, i, j, k);
      if (i + 1 < c[0]) push(id, ffdIndex(L, i + 1, j, k));
      if (j + 1 < c[1]) push(id, ffdIndex(L, i, j + 1, k));
      if (k + 1 < c[2]) push(id, ffdIndex(L, i, j, k + 1));
    }
    this.lines.geometry.dispose();
    this.lines.geometry = new THREE.BufferGeometry();
    this.lines.geometry.setAttribute('position', new THREE.Float32BufferAttribute(seg, 3));
    if (!this._dragging) this._syncGizmo();
    this.v.invalidate();
  }

  _syncGizmo() {
    const show = this.enabled && this.sel.size > 0;
    this.helper.visible = show;
    this.gizmo.enabled = show;
    if (show) {
      const avg = new THREE.Vector3();
      for (const i of this.sel) avg.add(this.pos(i));
      avg.multiplyScalar(1 / this.sel.size);
      this.anchor.position.copy(avg);
      this.anchor.quaternion.identity();
      this.anchor.scale.set(1, 1, 1);
      this.anchor.updateMatrixWorld(true);
    }
    this.v.invalidate();
  }

  // -------------------------------------------------------------- gizmo drag (Atlas begin/update/finishLatticeTransformDrag)
  _beginDrag() {
    if (!this.L || !this.sel.size) return;
    this._dragging = true;
    this.anchor.updateMatrixWorld(true);
    const s = this.getSettings();
    const diag = Math.hypot(...this.L.size);
    this.start = {
      inv: this.anchor.matrixWorld.clone().invert(),
      D: this.L.D.slice(),
      P: Array.from({ length: this.count() }, (_, i) => this.pos(i)),
      W: influenceWeights(this.L, this.sel, s.falloff * diag, s.strength),
    };
  }
  _drag() {
    if (!this._dragging || !this.start) return;
    this.anchor.updateMatrixWorld(true);
    const M = this.start.inv.clone().premultiply(this.anchor.matrixWorld);
    const L = this.L;
    for (let i = 0; i < this.count(); i++) {
      const w = this.start.W[i];
      const p0 = this.start.P[i];
      const t = w > 0 ? p0.clone().applyMatrix4(M) : p0;
      const p = p0.clone().lerp(t, w);
      L.D[3 * i] = this.start.D[3 * i] + (p.x - p0.x);
      L.D[3 * i + 1] = this.start.D[3 * i + 1] + (p.y - p0.y);
      L.D[3 * i + 2] = this.start.D[3 * i + 2] + (p.z - p0.z);
    }
    this._refresh();
    this.onChange(L, false);
  }
  _endDrag() {
    if (!this._dragging) return;
    this._dragging = false;
    this.start = null;
    this._syncGizmo();
    this.onChange(this.L, true);
  }

  // -------------------------------------------------------------- picking + marquee
  _screen(clientX, clientY) {
    const v = this.v.viewAt(clientX, clientY);
    return v;
  }
  _project(i, v) {
    const p = this.pos(i).project(v.cam);
    return [v.rect.left + v.x + (p.x * 0.5 + 0.5) * v.w, v.rect.top + v.y + (-p.y * 0.5 + 0.5) * v.h, p.z];
  }
  _nearest(e, px = 12) {
    const v = this._screen(e.clientX, e.clientY);
    let best = -1, bd = px * px;
    for (let i = 0; i < this.count(); i++) {
      const [x, y, z] = this._project(i, v);
      if (z > 1) continue;
      const d = (x - e.clientX) ** 2 + (y - e.clientY) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }
  _down(e) {
    if (!this.enabled || e.button !== 0 || !this.L) return;
    if (this.gizmo.axis) return; // gizmo handle hovered: let TransformControls drag
    const hit = this._nearest(e);
    if (hit >= 0) {
      if (e.ctrlKey || e.metaKey) this.sel.delete(hit);
      else if (e.shiftKey) this.sel.has(hit) ? this.sel.delete(hit) : this.sel.add(hit);
      else { this.sel.clear(); this.sel.add(hit); }
      this._refresh();
      return;
    }
    this.mq = { x0: e.clientX, y0: e.clientY, mode: e.ctrlKey || e.metaKey ? 'remove' : e.shiftKey ? 'add' : 'replace', moved: false };
  }
  _move(e) {
    if (this.enabled && !this.mq && !this._dragging && this.L) {
      const h = this._nearest(e, 10);
      if (h !== this.hover) { this.hover = h; this._refresh(); }
    }
    if (!this.mq) return;
    const dx = e.clientX - this.mq.x0, dy = e.clientY - this.mq.y0;
    if (!this.mq.moved && Math.hypot(dx, dy) < 4) return;
    this.mq.moved = true;
    const r = this.v.container.getBoundingClientRect();
    Object.assign(this.marquee.style, {
      left: Math.min(e.clientX, this.mq.x0) - r.left + 'px', top: Math.min(e.clientY, this.mq.y0) - r.top + 'px',
      width: Math.abs(dx) + 'px', height: Math.abs(dy) + 'px',
    });
    this.marquee.classList.toggle('remove', this.mq.mode === 'remove');
    this.marquee.hidden = false;
  }
  _up(e) {
    if (!this.mq) return;
    const mq = this.mq; this.mq = null;
    this.marquee.hidden = true;
    if (!mq.moved) { if (mq.mode === 'replace') this.clear(); return; }
    const x0 = Math.min(mq.x0, e.clientX), x1 = Math.max(mq.x0, e.clientX), y0 = Math.min(mq.y0, e.clientY), y1 = Math.max(mq.y0, e.clientY);
    const v = this._screen(mq.x0, mq.y0);
    if (mq.mode === 'replace') this.sel.clear();
    for (let i = 0; i < this.count(); i++) {
      const [x, y, z] = this._project(i, v);
      if (z > 1 || x < x0 || x > x1 || y < y0 || y > y1) continue;
      if (mq.mode === 'remove') this.sel.delete(i); else this.sel.add(i);
    }
    this._refresh();
  }
}
