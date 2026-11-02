// Frame/Blob — GL shaders, studio environment and fading grid
// Studio environment, foil/iridescence injection and the infinite fading grid are
// ported from Minimal_Surface_Atlas_3 (main.ts / infiniteGrid.ts) and adapted to Z-up + mm scale.
import * as THREE from 'three';

// ---------------------------------------------------------------- studio reflection environment
function softbox(ctx, width, x, y, w, h, color, blur) {
  for (const off of [-width, 0, width]) {
    ctx.save(); ctx.shadowColor = color; ctx.shadowBlur = blur; ctx.fillStyle = color;
    ctx.fillRect(x + off - w / 2, y - h / 2, w, h); ctx.restore();
  }
}
export function studioEnvironment(renderer, { dark = false } = {}) {
  const pm = new THREE.PMREMGenerator(renderer);
  const c = document.createElement('canvas');
  c.width = 1024; c.height = 512;
  const g = c.getContext('2d'), W = c.width, H = c.height;
  const grad = g.createLinearGradient(0, 0, 0, H);
  if (dark) {
    grad.addColorStop(0, '#2a2c2b'); grad.addColorStop(0.5, '#121312'); grad.addColorStop(1, '#050505');
  } else {
    grad.addColorStop(0, '#ffffff'); grad.addColorStop(0.22, '#eef1e9'); grad.addColorStop(0.5, '#c3cbbb');
    grad.addColorStop(0.76, '#909d92'); grad.addColorStop(1, '#666a66');
  }
  g.fillStyle = grad; g.fillRect(0, 0, W, H);
  const k = dark ? 0.85 : 1;
  softbox(g, W, W * 0.5, H * 0.18, W * 0.66, H * 0.09, `rgba(255,255,255,${0.92 * k})`, 42);
  softbox(g, W, W * 0.18, H * 0.54, W * 0.11, H * 0.72, `rgba(229,238,221,${0.72 * k})`, 48);
  softbox(g, W, W * 0.84, H * 0.48, W * 0.12, H * 0.66, `rgba(175,188,169,${0.56 * k})`, 48);
  softbox(g, W, W * 0.5, H * 0.82, W * 0.42, H * 0.1, `rgba(255,255,255,${0.36 * k})`, 34);
  g.fillStyle = 'rgba(84,91,86,0.12)'; g.fillRect(W * 0.46, 0, W * 0.08, H);
  g.fillStyle = 'rgba(255,255,255,0.3)';
  g.fillRect(W * 0.02, H * 0.35, W * 0.96, H * 0.018);
  g.fillRect(W * 0.02, H * 0.67, W * 0.96, H * 0.012);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.mapping = THREE.EquirectangularReflectionMapping;
  const target = pm.fromEquirectangular(tex);
  tex.dispose(); pm.dispose();
  return target.texture;
}

// Atlas studio rig (Y-up positions converted to Z-up: (x, y, z) → (x, -z, y)), scaled to the model radius
export function studioRig() {
  const g = new THREE.Group();
  const yz = (x, y, z) => new THREE.Vector3(x, -z, y);
  const hemi = new THREE.HemisphereLight(0xffffff, 0xb5beb0, 0.62);
  hemi.position.set(0, 0, 1);
  const key = new THREE.DirectionalLight(0xffffff, 3.6); key.userData.dir = yz(-8, 13, 7);
  const fill = new THREE.DirectionalLight(0xdde3d6, 0.52); fill.userData.dir = yz(9, 5, -10);
  const rim = new THREE.DirectionalLight(0xffffff, 0.46); rim.userData.dir = yz(7, 4, -9);
  const mag = new THREE.PointLight(0xe7d9dc, 0.74, 0, 2); mag.userData.dir = yz(-7.5, 4.5, 4.8);
  const cyan = new THREE.PointLight(0xdde3d6, 1.1, 0, 2); cyan.userData.dir = yz(6.5, 2.4, 7.5);
  const amber = new THREE.PointLight(0xf4f1e6, 1.26, 0, 2); amber.userData.dir = yz(7.8, 5.2, -4.8);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.bias = -0.0002; key.shadow.normalBias = 0.024;
  g.add(hemi, key, key.target, fill, rim, mag, cyan, amber);
  g.userData = { key, lights: [key, fill, rim, mag, cyan, amber], points: [mag, cyan, amber], hemi };
  return g;
}
export function placeRig(rig, center, r) {
  const s = r / 7; // Atlas rig was built around a ~7-unit scene
  for (const l of rig.userData.lights) {
    l.position.copy(center).addScaledVector(l.userData.dir, s);
    if (l.isDirectionalLight) l.target.position.copy(center);
    if (l.isPointLight) { l.distance = r * 6; l.decay = 0; }
  }
  rig.userData.key.target.updateMatrixWorld();
  const sc = rig.userData.key.shadow.camera;
  sc.left = -r; sc.right = r; sc.top = r; sc.bottom = -r; sc.near = r * 0.05; sc.far = r * 6;
  sc.updateProjectionMatrix();
}

// ---------------------------------------------------------------- infinite fading grid (Z-up)
const GRID_VS = /* glsl */ `
varying vec3 localPosition;
varying vec4 worldPosition;
uniform vec3 worldCamProjPosition;
uniform vec3 worldPlanePosition;
uniform float fadeDistance;
void main() {
  localPosition = position.xyz * (1.0 + fadeDistance);
  worldPosition = modelMatrix * vec4(localPosition, 1.0);
  worldPosition.xyz += (worldCamProjPosition - worldPlanePosition);
  localPosition = (inverse(modelMatrix) * worldPosition).xyz;
  gl_Position = projectionMatrix * viewMatrix * worldPosition;
}`;
const GRID_FS = /* glsl */ `
varying vec3 localPosition;
varying vec4 worldPosition;
uniform vec3 worldCamProjPosition;
uniform float cellSize, sectionSize, fadeDistance, fadeStrength, cellThickness, sectionThickness, opacity;
uniform vec3 cellColor, sectionColor;
float getGrid(float size, float thickness) {
  vec2 r = localPosition.xy / size;
  vec2 grid = abs(fract(r - 0.5) - 0.5) / fwidth(r);
  float line = min(grid.x, grid.y) + 1.0 - thickness;
  return 1.0 - min(line, 1.0);
}
void main() {
  float g1 = getGrid(cellSize, cellThickness);
  float g2 = getGrid(sectionSize, sectionThickness);
  float dist = distance(worldCamProjPosition, worldPosition.xyz);
  float d = 1.0 - min(dist / fadeDistance, 1.0);
  vec3 color = mix(cellColor, sectionColor, min(1.0, sectionThickness * g2));
  gl_FragColor = vec4(color, (g1 + g2) * pow(d, fadeStrength) * opacity);
  gl_FragColor.a = mix(0.75 * gl_FragColor.a, gl_FragColor.a, g2);
  if (gl_FragColor.a <= 0.0) discard;
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;
export class FadingGrid {
  constructor() {
    this.material = new THREE.ShaderMaterial({
      transparent: true, side: THREE.DoubleSide, depthWrite: false,
      uniforms: {
        cellSize: { value: 10 }, sectionSize: { value: 50 }, fadeDistance: { value: 800 }, fadeStrength: { value: 1.35 },
        cellThickness: { value: 0.46 }, sectionThickness: { value: 1.02 }, opacity: { value: 0.96 },
        cellColor: { value: new THREE.Color('#bfc4bb') }, sectionColor: { value: new THREE.Color('#9fa89b') },
        worldCamProjPosition: { value: new THREE.Vector3() }, worldPlanePosition: { value: new THREE.Vector3() },
      },
      vertexShader: GRID_VS, fragmentShader: GRID_FS,
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -50;
    this.mesh.onBeforeRender = (r, s, cam) => this.update(cam);
  }
  configure(r, z, dark) {
    const step = Math.pow(10, Math.floor(Math.log10(Math.max(r, 1e-3) / 3)));
    const u = this.material.uniforms;
    u.cellSize.value = step; u.sectionSize.value = step * 5; u.fadeDistance.value = r * 7;
    u.cellColor.value.set(dark ? '#2c2e2c' : '#bfc4bb'); u.sectionColor.value.set(dark ? '#444844' : '#9fa89b');
    this.mesh.position.set(0, 0, z);
  }
  update(cam) {
    const u = this.material.uniforms;
    u.worldCamProjPosition.value.set(cam.position.x, cam.position.y, this.mesh.position.z);
    u.worldPlanePosition.value.copy(this.mesh.position);
  }
}

// ---------------------------------------------------------------- foil + iridescence (Atlas)
export const FOIL = { color: 0xdde3d6, metalness: 0.28, roughness: 0.48, clearcoat: 1, clearcoatRoughness: 0.28, envMapIntensity: 1.08,
  iridescence: 0.36, iridescenceIOR: 1.22, iridescenceThicknessRange: [120, 360], reflectivity: 0.74, specularIntensity: 0.62,
  sheen: 0.18, sheenRoughness: 0.62, sheenColor: 0xf3f5ee, egg: 0.42, eggFreq: 0.82 };
export const MATTE = { color: 0xc7d0c1, metalness: 0.04, roughness: 0.86, clearcoat: 0, clearcoatRoughness: 0, envMapIntensity: 0.35,
  iridescence: 0.18, iridescenceIOR: 1.22, iridescenceThicknessRange: [140, 460], reflectivity: 0.18, specularIntensity: 0.22,
  sheen: 0, sheenRoughness: 1, sheenColor: 0xf7f8f4, egg: 0.0, eggFreq: 0.9 };

export function styledMaterial(style, color) {
  const m = new THREE.MeshPhysicalMaterial({
    color: color ?? style.color, metalness: style.metalness, roughness: style.roughness, clearcoat: style.clearcoat,
    clearcoatRoughness: style.clearcoatRoughness, envMapIntensity: style.envMapIntensity, iridescence: style.iridescence,
    iridescenceIOR: style.iridescenceIOR, iridescenceThicknessRange: style.iridescenceThicknessRange, reflectivity: style.reflectivity,
    specularIntensity: style.specularIntensity, sheen: style.sheen, sheenRoughness: style.sheenRoughness, sheenColor: new THREE.Color(style.sheenColor),
  });
  if (style.egg > 0) installIridescence(m, style.egg, style.eggFreq);
  return m;
}

export const IRI_UNIFORMS = { uIriScale: { value: 0.02 } }; // world → Atlas units (set from model size)

export function installIridescence(material, strength, frequency) {
  material.customProgramCacheKey = () => 'frameblob-foil-iridescence-v1';
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uEggIridescence = { value: strength };
    shader.uniforms.uEggIridescenceFrequency = { value: frequency };
    shader.uniforms.uIriScale = IRI_UNIFORMS.uIriScale;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
varying vec3 vIriP;
varying vec3 vIriN;`)
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
vIriP = worldPosition.xyz;
vIriN = normalize( mat3( modelMatrix ) * objectNormal );`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
uniform float uEggIridescence;
uniform float uEggIridescenceFrequency;
uniform float uIriScale;
varying vec3 vIriP;
varying vec3 vIriN;
float iriHash(vec3 p) { p = fract(p * 0.1031); p += dot(p, p.yzx + 19.19); return fract((p.x + p.y) * p.z); }
float iriNoise(vec3 p) {
  vec3 i = floor(p), f = fract(p), u = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(iriHash(i), iriHash(i + vec3(1,0,0)), u.x), mix(iriHash(i + vec3(0,1,0)), iriHash(i + vec3(1,1,0)), u.x), u.y),
             mix(mix(iriHash(i + vec3(0,0,1)), iriHash(i + vec3(1,0,1)), u.x), mix(iriHash(i + vec3(0,1,1)), iriHash(i + vec3(1,1,1)), u.x), u.y), u.z);
}
vec3 iriPalette(float t) {
  t = fract(t);
  vec3 c0 = vec3(1.00, 0.84, 0.20), c1 = vec3(1.00, 0.33, 0.77), c2 = vec3(0.18, 0.93, 1.00), c3 = vec3(0.30, 1.00, 0.46);
  if (t < 0.25) return mix(c0, c1, t * 4.0);
  if (t < 0.50) return mix(c1, c2, (t - 0.25) * 4.0);
  if (t < 0.75) return mix(c2, c3, (t - 0.50) * 4.0);
  return mix(c3, c0, (t - 0.75) * 4.0);
}
vec3 applyIri(vec3 baseColor) {
  float s = clamp(uEggIridescence, 0.0, 1.0);
  if (s <= 0.0001) return baseColor;
  vec3 P = vIriP.xzy * uIriScale; // Z-up → Atlas Y-up, mm → Atlas units
  vec3 n = normalize(vIriN);
  float ndv = clamp(dot(n, normalize(cameraPosition - vIriP)), 0.0, 1.0);
  float jitter = iriNoise(P * 1.5 + vec3(31.4));
  float broad = iriNoise(P * 0.48 + vec3(11.7));
  float f = max(0.2, uEggIridescenceFrequency);
  float facet = (P.y * 1.8 + P.x * 0.42 - P.z * 0.31) * f;
  float stepB = (abs(P.x) + abs(P.z)) * 0.92;
  float swirl = 0.5 + 0.5 * sin(dot(P, vec3(0.73, 0.51, -0.46)) * f * 1.25 + broad * 4.6 + 6.283);
  float tT = fract(facet * 0.123 + stepB * 0.081 + swirl * 0.39 + jitter * 0.27 + 5.7);
  float nm = mix(120.0, 980.0, tT);
  vec3 phase = (4.0 * 3.14159265 * 1.65 * nm * max(ndv, 0.08)) / vec3(680.0, 540.0, 440.0);
  vec3 interference = 0.5 + 0.5 * cos(phase + vec3(0.0, 2.094, 4.188));
  vec3 oxide = mix(interference, iriPalette(fract(tT * (0.55 + f * 0.65) + dot(n, vec3(0.23, -0.37, 0.11)) * 0.18)), 0.68);
  float fres = pow(1.0 - ndv, 2.2);
  float film = s * (0.48 + 0.52 * fres);
  vec3 tint = mix(vec3(1.0), baseColor, 0.58);
  vec3 metal = vec3(0.92, 0.94, 0.98) * mix(vec3(1.0), tint, 0.26);
  vec3 blend = mix(metal, mix(oxide, oxide * tint, 0.62), clamp(film * 0.78, 0.0, 1.0));
  vec3 base = baseColor * mix(vec3(1.0), blend, 0.62 * s) + oxide * fres * s * 0.22;
  return mix(baseColor, base, 0.85 * s);
}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
diffuseColor.rgb = applyIri(diffuseColor.rgb);`);
  };
}

// ---------------------------------------------------------------- frame visibility shaders
const VIEW_VS = /* glsl */ `
varying vec3 vN; varying vec3 vV; varying vec3 vW;
#include <common>
#include <logdepthbuf_pars_vertex>
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vW = wp.xyz;
  vN = normalize(mat3(modelMatrix) * normal);
  vV = normalize(cameraPosition - wp.xyz);
  gl_Position = projectionMatrix * viewMatrix * wp;
  #include <logdepthbuf_vertex>
}`;

// Glass-like rim shader: dark core, bright fresnel edge, specular streak. Reads clearly
// against white cushions, unlike physical transmission which washes out.
export function fresnelMaterial({ color = 0x2b3a40, rim = 0xffffff, opacity = 1, power = 2.2, xray = false } = {}) {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(color) }, uRim: { value: new THREE.Color(rim) }, uOpacity: { value: opacity }, uPower: { value: power }, uXray: { value: xray ? 1 : 0 } },
    vertexShader: VIEW_VS,
    fragmentShader: /* glsl */ `
uniform vec3 uColor; uniform vec3 uRim; uniform float uOpacity; uniform float uPower; uniform float uXray;
varying vec3 vN; varying vec3 vV; varying vec3 vW;
void main() {
  vec3 n = normalize(vN); if (!gl_FrontFacing) n = -n;
  float ndv = clamp(dot(n, normalize(vV)), 0.0, 1.0);
  float fr = pow(1.0 - ndv, uPower);
  vec3 L = normalize(vec3(-0.4, -0.5, 0.9));
  vec3 H = normalize(L + normalize(vV));
  float spec = pow(clamp(dot(n, H), 0.0, 1.0), 60.0);
  float band = smoothstep(0.2, 0.95, n.z) * 0.12; // soft overhead softbox
  vec3 col = mix(uColor, uRim, fr) + spec * 0.9 + band;
  float a = uXray > 0.5 ? (0.18 + 0.7 * fr) * uOpacity : uOpacity;
  gl_FragColor = vec4(col, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`,
    transparent: xray || opacity < 1,
    depthTest: !xray,
    depthWrite: !xray,
    side: THREE.FrontSide,
  });
}

// Zebra (reflection-line) shader: stripes of a virtual striped dome — the standard way to judge
// surface continuity of SubD / Class-A surfaces.
export function zebraMaterial({ freq = 14, dark = 0x1a1a1a, light = 0xf4f4f2 } = {}) {
  return new THREE.ShaderMaterial({
    uniforms: { uFreq: { value: freq }, uDark: { value: new THREE.Color(dark) }, uLight: { value: new THREE.Color(light) } },
    vertexShader: VIEW_VS,
    fragmentShader: /* glsl */ `
uniform float uFreq; uniform vec3 uDark; uniform vec3 uLight;
varying vec3 vN; varying vec3 vV;
void main() {
  vec3 n = normalize(vN); if (!gl_FrontFacing) n = -n;
  vec3 r = reflect(-normalize(vV), n);
  float t = acos(clamp(r.z, -1.0, 1.0)) / 3.14159265 * uFreq;
  float w = fwidth(t);
  float s = smoothstep(0.5 - w, 0.5 + w, abs(fract(t) - 0.5) * 2.0);
  float shade = 0.75 + 0.25 * clamp(dot(n, normalize(vV)), 0.0, 1.0);
  gl_FragColor = vec4(mix(uDark, uLight, s) * shade, 1.0);
  #include <colorspace_fragment>
}`,
    side: THREE.DoubleSide,
  });
}

// Ghost: transparent view-dependent shell so the frame inside stays readable
export function ghostMaterial({ color = 0xdfe4e6, opacity = 0.28 } = {}) {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(color) }, uOpacity: { value: opacity } },
    vertexShader: VIEW_VS,
    fragmentShader: /* glsl */ `
uniform vec3 uColor; uniform float uOpacity;
varying vec3 vN; varying vec3 vV;
void main() {
  vec3 n = normalize(vN); if (!gl_FrontFacing) n = -n;
  float fr = pow(1.0 - clamp(dot(n, normalize(vV)), 0.0, 1.0), 1.6);
  gl_FragColor = vec4(mix(uColor, vec3(1.0), fr * 0.6), uOpacity * (0.35 + fr));
  #include <colorspace_fragment>
}`,
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
  });
}

// Back-face diagnostic (Atlas): white front, pink back
export function backfaceMaterial() {
  return new THREE.ShaderMaterial({
    vertexShader: VIEW_VS,
    fragmentShader: /* glsl */ `
varying vec3 vN; varying vec3 vV;
void main() {
  vec3 n = normalize(vN);
  float l = 0.55 + 0.45 * abs(dot(n, normalize(vV)));
  gl_FragColor = vec4((gl_FrontFacing ? vec3(1.0) : vec3(1.0, 0.0, 0.85)) * l, 1.0);
  #include <colorspace_fragment>
}`,
    side: THREE.DoubleSide,
  });
}

// Curvature-ish cavity shader from screen-space normal derivatives (highlights creases where frame pinches)
export function cavityMaterial({ color = 0xeceae4 } = {}) {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(color) } },
    vertexShader: VIEW_VS,
    fragmentShader: /* glsl */ `
uniform vec3 uColor;
varying vec3 vN; varying vec3 vV; varying vec3 vW;
void main() {
  vec3 n = normalize(vN); if (!gl_FrontFacing) n = -n;
  vec3 dn = fwidth(n);
  float dw = length(fwidth(vW)) + 1e-5;
  float curv = clamp(length(dn) / dw * 2.0, 0.0, 1.0);
  float ndv = clamp(dot(n, normalize(vV)), 0.0, 1.0);
  vec3 col = uColor * (0.55 + 0.45 * ndv) * (1.0 - 0.75 * curv);
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}`,
  });
}
