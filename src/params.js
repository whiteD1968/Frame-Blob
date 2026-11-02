// Frame/Blob — parameter schema, defaults, presets

export const DEFAULTS = {
  name: 'Untitled study',
  units: 'mm',
  // boundary
  boundary: 'ellipsoid', sizeX: 160, sizeY: 150, sizeZ: 130,
  // lattice
  lattice: 'random', count: 11, nx: 3, ny: 3, nz: 3, jitter: 0.5, gradient: 0, gradAxis: 'z', relax: 4, seed: 7, cull: 0, disabled: [],
  // subdivision
  subdiv: 0, subSeed: 1, subRelax: 2, subRadius: 0.55,
  // frame
  frameTopology: 'surface', cordSmooth: 2, outerEdges: true, creaseAngle: 40, cordLift: 0.5, radius: 2.2, nodeScale: 1.0, taper: 0.1, fillet: 3, skinEdges: false, frameScope: 'all', wrap: 0, cordTaut: 2, frameMesh: 'auto',
  // inflation
  blobSource: 'cells', blobLattice: 'random', blobCount: 14, blobSeed: 3, blobRelax: 2, blobJitter: 0.6,
  inflateMode: 'constrained', wallBulge: 0, inflate: 9, roundness: 0.7, gap: 1.0, merge: 3, variance: 0.12, skinPush: 0, grooveOn: true, groove: 1.0, grooveSoft: 2.5,
  // mesh
  res: 96, smooth: 2, meshMode: 'voxel', subdLevels: 1,
  // lattice deformation (FFD)
  ffdX: 2, ffdY: 2, ffdZ: 2, ffdFalloff: 0, ffdStrength: 1, ffdDeltas: null, showLattice: false,
  // shading / lighting
  lighting: 'studio', exposure: 1.12, frameShader: 'fresnel', frameColor: '#2b3a40', xray: false,
  blobShader: 'preset', blobOpacity: 1, wire: 'off', wireColor: '#3a3f3a', zebraFreq: 14,
  // display
  material: 'fabric-glass', showFrame: true, showBlob: true, showCells: false, showSeeds: false, showGround: true,
  // drawing
  cut: 0.5, contours: 0, centerlines: true, drawScale: 1,
};

// stage tells the app how much to rebuild; 'display' never touches geometry
export const SCHEMA = [
  { title: 'Boundary', open: true, items: [
    { key: 'boundary', type: 'select', options: { box: 'Box', ellipsoid: 'Ellipsoid', dome: 'Dome', cylinder: 'Cylinder' } },
    { key: 'sizeX', label: 'Width X', min: 30, max: 1200, step: 1 },
    { key: 'sizeY', label: 'Depth Y', min: 10, max: 1200, step: 1 },
    { key: 'sizeZ', label: 'Height Z', min: 10, max: 1200, step: 1 },
    { key: 'units', type: 'select', options: { mm: 'mm', cm: 'cm', m: 'm' }, stage: 'display' },
  ] },
  { title: 'Lattice · Voronoi', open: true, items: [
    { key: 'lattice', type: 'select', options: { random: 'Random (Voronoi)', cubic: 'Cubic grid', bcc: 'BCC · Kelvin cells', hex: 'Hex prisms', stagger: 'Staggered hex (FCC-ish)' } },
    { key: 'count', label: 'Cells', min: 2, max: 160, step: 1, show: (P) => P.lattice === 'random' },
    { key: 'nx', label: 'Div X', min: 1, max: 12, step: 1, show: (P) => P.lattice !== 'random' },
    { key: 'ny', label: 'Div Y', min: 1, max: 12, step: 1, show: (P) => P.lattice !== 'random' },
    { key: 'nz', label: 'Div Z', min: 1, max: 12, step: 1, show: (P) => P.lattice !== 'random' },
    { key: 'jitter', label: 'Jitter', min: 0, max: 1, step: 0.01, show: (P) => P.lattice !== 'random' },
    { key: 'relax', label: 'Relax (Lloyd)', min: 0, max: 12, step: 1 },
    { key: 'gradient', label: 'Density gradient', min: -1, max: 1, step: 0.01 },
    { key: 'gradAxis', label: 'Gradient axis', type: 'select', options: { x: 'X', y: 'Y', z: 'Z' } },
    { key: 'seed', label: 'Seed', min: 1, max: 9999, step: 1, dice: true },
    { key: 'cull', label: 'Cull cells', min: 0, max: 0.9, step: 0.01 },
  ] },
  { title: 'Lattice subdivision', open: false, items: [
    { key: 'subdiv', label: 'Sub-cells / cell', min: 0, max: 8, step: 1, note: 'second-order Voronoi inside each active cell' },
    { key: 'subRelax', label: 'Sub relax', min: 0, max: 6, step: 1 },
    { key: 'subRadius', label: 'Sub strut ratio', min: 0.1, max: 1, step: 0.01 },
    { key: 'subSeed', label: 'Sub seed', min: 1, max: 9999, step: 1, dice: true },
  ] },
  { title: 'Frame · SubD struts', open: true, items: [
    { key: 'frameTopology', label: 'Frame topology', type: 'select', options: { surface: 'Surface seams (cords)', walls: 'All cell walls (3D lattice)', cage: 'Walls + outer cage' }, note: 'surface = only where cushions meet on the outside' },
    { key: 'outerEdges', label: 'Outer edges', type: 'bool', show: (P) => P.frameTopology === 'surface', note: 'frame where the outer surface folds (box edges, rims)' },
    { key: 'creaseAngle', label: 'Crease angle °', min: 10, max: 120, step: 1, show: (P) => P.frameTopology === 'surface' && P.outerEdges },
    { key: 'cordSmooth', label: 'Cord smoothing', min: 0, max: 8, step: 1 },
    { key: 'frameMesh', label: 'Frame mesh', type: 'select', options: { auto: 'Auto (cords for seams / thin)', sdf: 'Fused SDF (fillets, print)', cords: 'Swept cords (exact)' } },
    { key: 'radius', label: 'Strut radius', min: 0, max: 20, step: 0.1 },
    { key: 'nodeScale', label: 'Node bulge', min: 0, max: 3, step: 0.01 },
    { key: 'taper', label: 'Mid-span taper', min: -0.8, max: 0.8, step: 0.01 },
    { key: 'fillet', label: 'Fillet (smooth)', min: 0, max: 15, step: 0.1 },
    { key: 'skinEdges', label: 'Outer skin edges', type: 'bool', show: (P) => P.frameTopology === 'walls' },
    { key: 'wrap', label: 'Wrap onto blob', min: 0, max: 1, step: 0.01, note: 'skin struts become cords on the cushion surface' },
    { key: 'cordTaut', label: 'Cord tautness', min: 0, max: 8, step: 1, show: (P) => P.wrap > 0, note: 'higher = cords bridge the crevices' },
    { key: 'cordLift', label: 'Cord lift', min: -1, max: 1.5, step: 0.05, show: (P) => P.wrap > 0, note: 'cord centre above (+) or into (−) the cushion, × radius' },
    { key: 'frameScope', label: 'Frame scope', type: 'select', options: { all: 'All cells', active: 'Active cells only' }, show: (P) => P.frameTopology !== 'surface' },
  ] },
  { title: 'Inflation · Blob', open: true, items: [
    { key: 'blobSource', label: 'Inflate from', type: 'select', options: { cells: 'Frame cells', subcells: 'Sub-cells', independent: 'Independent field' } },
    { key: 'blobLattice', label: 'Blob lattice', type: 'select', options: { random: 'Random', cubic: 'Cubic', bcc: 'BCC', hex: 'Hex' }, show: (P) => P.blobSource === 'independent' },
    { key: 'blobCount', label: 'Blob count', min: 2, max: 120, step: 1, show: (P) => P.blobSource === 'independent' },
    { key: 'blobSeed', label: 'Blob seed', min: 1, max: 9999, step: 1, dice: true, show: (P) => P.blobSource === 'independent' },
    { key: 'blobRelax', label: 'Blob relax', min: 0, max: 8, step: 1, show: (P) => P.blobSource === 'independent' },
    { key: 'inflateMode', label: 'Inflation', type: 'select', options: { constrained: 'Held by frame (membrane)', free: 'Free (grows past frame)' }, note: 'membrane: cushions stay tied to the struts and bulge between them' },
    { key: 'inflate', label: 'Inflate', min: -10, max: 60, step: 0.1 },
    { key: 'wallBulge', label: 'Wall bulge', min: 0, max: 1, step: 0.01, show: (P) => P.inflateMode !== 'free', note: 'interior walls bulge too (0 = flat, equal pressure)' },
    { key: 'roundness', label: 'Pillow roundness', min: 0.05, max: 2, step: 0.01 },
    { key: 'gap', label: 'Cell gap', min: -10, max: 20, step: 0.1 },
    { key: 'merge', label: 'Metaball merge', min: 0, max: 30, step: 0.1 },
    { key: 'variance', label: 'Pressure variance', min: 0, max: 0.8, step: 0.01 },
    { key: 'skinPush', label: 'Bulge past skin', min: -10, max: 60, step: 0.1 },
    { key: 'grooveOn', label: 'Frame pinches blob', type: 'bool' },
    { key: 'groove', label: 'Pinch clearance', min: -3, max: 10, step: 0.1 },
    { key: 'grooveSoft', label: 'Pinch softness', min: 0, max: 10, step: 0.1 },
  ] },
  { title: 'Lattice deform · FFD', open: false, items: [
    { key: 'ffdX', label: 'Width div', min: 1, max: 12, step: 1, stage: 'lattice' },
    { key: 'ffdY', label: 'Depth div', min: 1, max: 12, step: 1, stage: 'lattice' },
    { key: 'ffdZ', label: 'Height div', min: 1, max: 12, step: 1, stage: 'lattice' },
    { key: 'ffdFalloff', label: 'Falloff radius', min: 0, max: 1, step: 0.01, stage: 'display', note: 'fraction of lattice diagonal' },
    { key: 'ffdStrength', label: 'Falloff strength', min: 0, max: 1, step: 0.01, stage: 'display' },
    { key: 'showLattice', label: 'Show lattice', type: 'bool', stage: 'display' },
    { type: 'buttons', buttons: [['⌗ Edit lattice (L)', 'latticeEdit'], ['Reset lattice', 'latticeReset']] },
  ] },
  { title: 'Mesh · Subdivision', open: false, items: [
    { key: 'meshMode', label: 'Surface', type: 'select', options: { voxel: 'Voxel + Taubin', subd: 'SubD · Catmull–Clark' } },
    { key: 'res', label: 'Resolution', min: 24, max: 200, step: 1, note: 'voxels along longest side' },
    { key: 'subdLevels', label: 'SubD levels', min: 0, max: 3, step: 1, show: (P) => P.meshMode === 'subd', note: 'quad cage from surface nets → Catmull–Clark' },
    { key: 'smooth', label: 'Smoothing', min: 0, max: 8, step: 1 },
  ] },
  { title: 'Shading · Lighting', open: true, items: [
    { key: 'lighting', label: 'Lighting', type: 'select', options: { studio: 'Studio softboxes', room: 'Neutral room', dark: 'Dark studio' }, stage: 'display' },
    { key: 'exposure', label: 'Exposure', min: 0.3, max: 2.5, step: 0.01, stage: 'display' },
    { key: 'frameShader', label: 'Frame shader', type: 'select', options: { fresnel: 'Glass rim (shader)', glass: 'Physical glass', solid: 'Solid colour', foil: 'Foil', preset: 'From material preset' }, stage: 'display' },
    { key: 'frameColor', label: 'Frame colour', type: 'color', stage: 'display' },
    { key: 'xray', label: 'Frame X-ray', type: 'bool', stage: 'display', note: 'see the frame through the cushions (X)' },
    { key: 'blobShader', label: 'Blob shader', type: 'select', options: { preset: 'From material preset', foil: 'Foil · iridescent', matte: 'Matte', ghost: 'Ghost (see-through)', zebra: 'Zebra · continuity', cavity: 'Cavity · creases', normals: 'Normals', backfaces: 'Back faces' }, stage: 'display' },
    { key: 'zebraFreq', label: 'Zebra stripes', min: 4, max: 40, step: 1, stage: 'display', show: (P) => P.blobShader === 'zebra' },
    { key: 'blobOpacity', label: 'Blob opacity', min: 0.05, max: 1, step: 0.01, stage: 'display' },
    { key: 'wire', label: 'Mesh wires', type: 'select', options: { off: 'Off', blob: 'Blob', frame: 'Frame', both: 'Both' }, stage: 'display' },
    { key: 'wireColor', label: 'Wire colour', type: 'color', stage: 'display' },
  ] },
  { title: 'Drawings', open: false, items: [
    { key: 'cut', label: 'Section cut', min: 0, max: 1, step: 0.01, stage: 'display', note: '0 = no cut' },
    { key: 'contours', label: 'Contours', min: 0, max: 30, step: 1, stage: 'display' },
    { key: 'centerlines', label: 'Strut centrelines', type: 'bool', stage: 'display' },
    { key: 'drawScale', label: 'Scale 1:', min: 1, max: 500, step: 1, stage: 'display' },
  ] },
];

export const MATERIALS = {
  'fabric-glass': 'Fabric + glass frame',
  'frosted-cord': 'Frosted glass + black cord',
  'etfe-steel': 'ETFE cushion + steel',
  plaster: 'Plaster study',
  clay: 'Terracotta',
  foil: 'Foil (Atlas)',
  diagram: 'Diagram (dark)',
};

export const PRESETS = [
  { name: 'Pouf · fabric + glass', p: { boundary: 'ellipsoid', sizeX: 150, sizeY: 150, sizeZ: 130, lattice: 'random', count: 10, relax: 4, seed: 12, radius: 2.2, nodeScale: 1.3, taper: 0.1, fillet: 3, skinEdges: false, inflate: 12, roundness: 0.75, gap: 0.5, merge: 3, skinPush: 0, groove: 1, grooveSoft: 2.5, material: 'fabric-glass', blobSource: 'cells', subdiv: 0, cull: 0 } },
  { name: 'Wall relief · frosted + cord', p: { boundary: 'box', sizeX: 240, sizeY: 40, sizeZ: 300, lattice: 'cubic', nx: 4, ny: 1, nz: 5, jitter: 0.3, relax: 0, seed: 4, radius: 1.8, nodeScale: 1, taper: 0, fillet: 0.8, skinEdges: true, wrap: 1, inflateMode: 'free', blobSource: 'independent', blobLattice: 'random', blobCount: 20, blobSeed: 8, blobRelax: 3, inflate: 2, roundness: 0.95, gap: 1.5, merge: 1.5, skinPush: 15, groove: 0.5, grooveSoft: 1.5, variance: 0.15, material: 'frosted-cord', frameShader: 'preset', subdiv: 0, cull: 0, res: 160 } },
  { name: 'Kelvin block · plaster', p: { frameTopology: 'cage', wrap: 0, boundary: 'box', sizeX: 200, sizeY: 200, sizeZ: 200, lattice: 'bcc', nx: 3, ny: 3, nz: 3, jitter: 0, relax: 0, radius: 3, nodeScale: 1.6, taper: 0.25, fillet: 4, skinEdges: true, blobSource: 'cells', inflate: 4, roundness: 0.5, gap: 2, merge: 2, skinPush: 2, groove: 1, variance: 0, material: 'plaster', frameShader: 'preset', meshMode: 'subd', subdLevels: 1, res: 72, subdiv: 0, cull: 0 } },
  { name: 'Cloud pavilion · ETFE', p: { boundary: 'dome', sizeX: 320, sizeY: 260, sizeZ: 150, lattice: 'random', count: 26, relax: 3, seed: 21, radius: 2.6, nodeScale: 1.4, taper: 0.2, fillet: 3, skinEdges: false, subdiv: 0, blobSource: 'cells', inflate: 6, roundness: 0.6, gap: 1, merge: 3, skinPush: 10, groove: 1.2, variance: 0.2, material: 'etfe-steel', frameShader: 'preset', cull: 0 } },
  { name: 'Hex bench · clay', p: { boundary: 'box', sizeX: 420, sizeY: 130, sizeZ: 90, lattice: 'hex', nx: 6, ny: 2, nz: 1, jitter: 0.15, relax: 1, radius: 2.4, nodeScale: 1.2, taper: 0.1, fillet: 3, skinEdges: true, blobSource: 'cells', inflate: 6, roundness: 0.8, gap: 1, merge: 5, skinPush: 8, groove: 1, variance: 0.1, material: 'clay', frameShader: 'preset', subdiv: 0, cull: 0 } },
  { name: 'Subdivided lattice · diagram', p: { frameTopology: 'walls', wrap: 0, boundary: 'cylinder', sizeX: 180, sizeY: 180, sizeZ: 220, lattice: 'random', count: 7, relax: 5, seed: 33, subdiv: 4, subRelax: 2, subRadius: 0.45, radius: 2.8, nodeScale: 1.3, fillet: 2.5, skinEdges: false, blobSource: 'subcells', inflate: 4, roundness: 0.6, gap: 1, merge: 2, skinPush: 3, groove: 0.8, material: 'diagram', frameShader: 'preset', xray: true, cull: 0 } },
];
