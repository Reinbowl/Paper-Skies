// ============================================================================
// math + procedural helpers (load-time only unless noted)
// ============================================================================
const { sin, cos, tan, sqrt, min, max, abs, floor, round, PI, pow, atan2, hypot, exp, asin } = Math;
const TAU = PI * 2;
let _seed = 20261117;
const rnd = () => {
  _seed = (_seed + 0x6d2b79f5) | 0;
  let t = Math.imul(_seed ^ (_seed >>> 15), 1 | _seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const rr = (a, b) => a + (b - a) * rnd();
// each generator system starts its own random stream, so the systems stay independent
const rseed = (s) => {
  _seed = (20261117 + Math.imul(s, 7919)) | 0;
};
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const mix = (a, b, t) => a + (b - a) * t;
const sstep = (a, b, x) => {
  x = clamp((x - a) / (b - a), 0, 1);
  return x * x * (3 - 2 * x);
};
const fract = (x) => x - floor(x);
// shortest signed angle from a to b
const adiff = (a, b) => {
  let d = (b - a) % TAU;
  if (d > PI) d -= TAU;
  if (d < -PI) d += TAU;
  return d;
};

const ihash = (x, y) => {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};
// smooth 1D / 2D value noise in [0, 1] (also used per frame: no allocations)
const vn1 = (x) => {
  const i = floor(x);
  let f = x - i;
  f = f * f * (3 - 2 * f);
  return mix(ihash(i, 7), ihash(i + 1, 7), f);
};
const vn2 = (x, y) => {
  const ix = floor(x);
  const iy = floor(y);
  let fx = x - ix;
  let fy = y - iy;
  fx = fx * fx * (3 - 2 * fx);
  fy = fy * fy * (3 - 2 * fy);
  return mix(mix(ihash(ix, iy), ihash(ix + 1, iy), fx), mix(ihash(ix, iy + 1), ihash(ix + 1, iy + 1), fx), fy);
};
const fbm2 = (x, y, o = 4) => {
  let a = 0.5;
  let s = 0;
  for (let i = 0; i < o; i++) {
    s += a * vn2(x, y);
    x = x * 2.03 + 17.1;
    y = y * 2.03 + 31.7;
    a *= 0.5;
  }
  return s / (1 - 2 * a);
};

// world grid: GN x GN height samples over a WORLD x WORLD metre square centred on the origin
const WORLD = 3072;
const WO = -WORLD / 2;
const GS = WORLD / (GN - 1);
const LAYER = 4; // thickness of one paper sheet of land
const WL = -1.5; // water level
const CELLS = 32; // culling grid over XZ
const CELLW = WORLD / CELLS;
const KARST = [700, -620]; // centre of the karst pillars

// ---------------------------------------------------------------- mesh builder
// vertex format: f32x3 position, u8x4 (part, shade, aux, aux2). Normals come from the faces in the shader, so every
// fold reads as a crisp crease.
class Mesh {
  constructor() {
    this.p = [];
    this.a = [];
    this.i = [];
  }
  v(x, y, z, part = 0, shade = 255, aux = 0, aux2 = 0) {
    this.p.push(x, y, z);
    this.a.push(part, shade, aux, aux2);
    return this.p.length / 3 - 1;
  }
  tri(a, b, c) {
    this.i.push(a, b, c);
  }
  quad(a, b, c, d) {
    this.i.push(a, b, c, a, c, d);
  }
  // closed fan between a ring of vertex ids and one apex id
  fan(ring, apex, flip) {
    for (let k = 0; k < ring.length; k++) {
      const a = ring[k];
      const b = ring[(k + 1) % ring.length];
      flip ? this.tri(a, apex, b) : this.tri(a, b, apex);
    }
  }
  // side wall between two rings of equal length
  band(r0, r1) {
    for (let k = 0; k < r0.length; k++) {
      const k2 = (k + 1) % r0.length;
      this.quad(r0[k], r0[k2], r1[k2], r1[k]);
    }
  }
  // ring of n vertices around the y axis; rf(k) gives the radius of vertex k
  ring(n, y, rf, part, shade, a0 = 0, aux = 0) {
    const r = [];
    for (let k = 0; k < n; k++) {
      const a = a0 + (k / n) * TAU;
      const rad = typeof rf === 'function' ? rf(k) : rf;
      r.push(this.v(cos(a) * rad, y, sin(a) * rad, part, shade, aux));
    }
    return r;
  }
  // box from (x0, y0, z0) to (x1, y1, z1)
  box(x0, y0, z0, x1, y1, z1, part, shade = 255) {
    const c = [
      [x0, y0, z0],
      [x1, y0, z0],
      [x1, y0, z1],
      [x0, y0, z1],
      [x0, y1, z0],
      [x1, y1, z0],
      [x1, y1, z1],
      [x0, y1, z1],
    ].map((p) => this.v(p[0], p[1], p[2], part, shade));
    this.quad(c[0], c[1], c[2], c[3]);
    this.quad(c[4], c[7], c[6], c[5]);
    this.quad(c[0], c[4], c[5], c[1]);
    this.quad(c[1], c[5], c[6], c[2]);
    this.quad(c[2], c[6], c[7], c[3]);
    this.quad(c[3], c[7], c[4], c[0]);
  }
  // append another mesh, transformed by f(x, y, z) -> [x, y, z]
  add(m, f) {
    const o = this.p.length / 3;
    for (let k = 0; k < m.p.length; k += 3) {
      const q = f ? f(m.p[k], m.p[k + 1], m.p[k + 2]) : [m.p[k], m.p[k + 1], m.p[k + 2]];
      this.p.push(q[0], q[1], q[2]);
    }
    this.a.push(...m.a);
    for (const i of m.i) this.i.push(i + o);
  }
  build() {
    const n = this.p.length / 3;
    const vb = new ArrayBuffer(n * 16);
    const f = new Float32Array(vb);
    const u = new Uint8Array(vb);
    for (let k = 0; k < n; k++) {
      f[k * 4] = this.p[k * 3];
      f[k * 4 + 1] = this.p[k * 3 + 1];
      f[k * 4 + 2] = this.p[k * 3 + 2];
      for (let j = 0; j < 4; j++) u[k * 16 + 12 + j] = this.a[k * 4 + j];
    }
    return { vb, ib: new Uint32Array(this.i), nv: n };
  }
}

// icosphere, each vertex moved by fn(x, y, z) -> [x, y, z]
function icosphere(sub, fn, part = 0) {
  const m = new Mesh();
  const t = (1 + sqrt(5)) / 2;
  const V = [
    [-1, t, 0],
    [1, t, 0],
    [-1, -t, 0],
    [1, -t, 0],
    [0, -1, t],
    [0, 1, t],
    [0, -1, -t],
    [0, 1, -t],
    [t, 0, -1],
    [t, 0, 1],
    [-t, 0, -1],
    [-t, 0, 1],
  ].map((v) => {
    const l = hypot(...v);
    return v.map((c) => c / l);
  });
  let F = [
    [0, 11, 5],
    [0, 5, 1],
    [0, 1, 7],
    [0, 7, 10],
    [0, 10, 11],
    [1, 5, 9],
    [5, 11, 4],
    [11, 10, 2],
    [10, 7, 6],
    [7, 1, 8],
    [3, 9, 4],
    [3, 4, 2],
    [3, 2, 6],
    [3, 6, 8],
    [3, 8, 9],
    [4, 9, 5],
    [2, 4, 11],
    [6, 2, 10],
    [8, 6, 7],
    [9, 8, 1],
  ];
  for (let s = 0; s < sub; s++) {
    const cache = new Map();
    const F2 = [];
    const mid = (a, b) => {
      const key = a < b ? a * 65536 + b : b * 65536 + a;
      let r = cache.get(key);
      if (r === undefined) {
        const p = [0, 1, 2].map((k) => V[a][k] + V[b][k]);
        const l = hypot(...p);
        V.push(p.map((c) => c / l));
        r = V.length - 1;
        cache.set(key, r);
      }
      return r;
    };
    for (const [a, b, c] of F) {
      const ab = mid(a, b);
      const bc = mid(b, c);
      const ca = mid(c, a);
      F2.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
    }
    F = F2;
  }
  for (const v of V) {
    const p = fn ? fn(v[0], v[1], v[2]) : v;
    m.v(p[0], p[1], p[2], part);
  }
  for (const f of F) m.tri(f[0], f[1], f[2]);
  return m;
}
