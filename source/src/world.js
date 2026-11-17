// ============================================================================
// world layout + procedural content generation (load-time only)
// ============================================================================

// islands: x, z, radius, height, kind (0 rolling, 1 cone, 2 pillar), coastline warp, roughness
const ISLANDS = [
  [-130, 60, 660, 34, 0, 130, 0.9], // main island
  [-220, -60, 560, 236, 1, 22, 0.05], // the snow-capped cone
  [210, 200, 330, 54, 0, 120, 1.1], // eastern hills
  [-40, 560, 280, 22, 0, 110, 0.8], // southern peninsula, the village and the torii bay
  [-830, 700, 340, 66, 0, 140, 1.2], // south-west green isle
  [-560, 1000, 190, 28, 0, 90, 0.8],
  [930, 380, 260, 44, 0, 120, 1],
  [1010, 300, 190, 92, 1, 30, 0.5], // small cone on the east isle
  [120, -1020, 180, 26, 0, 90, 0.8],
  [-520, -900, 240, 58, 0, 120, 1.1],
  [-1120, -160, 170, 34, 0, 80, 0.9],
  [480, 820, 70, 9, 0, 40, 0.5], // sandy islets
  [-260, 1180, 60, 7, 0, 30, 0.5],
  [1180, -260, 80, 10, 0, 40, 0.5],
  [-1160, 380, 70, 8, 0, 40, 0.5],
];
// karst pillars rising from the sea in the north-east
rseed(1);
for (let i = 0; i < 22; i++) {
  const a = rnd() * TAU;
  const r = sqrt(rnd()) * 300;
  ISLANDS.push([KARST[0] + cos(a) * r, KARST[1] + sin(a) * r * 0.8, rr(26, 62), rr(40, 150), 2, 18, 0.6]);
}
const islandBuffer = () => {
  const a = [];
  for (const s of ISLANDS) a.push(s[0], s[1], s[2], s[3], s[4], s[5], s[6], rnd() * 100);
  return new Float32Array(a);
};

// ---------------------------------------------------------------- height queries (also per frame: no allocations)
let HM = null; // GN x GN heights
const hAt = (x, z) => {
  let u = (x - WO) / GS;
  let v = (z - WO) / GS;
  u = u < 0 ? 0 : u > GN - 1.001 ? GN - 1.001 : u;
  v = v < 0 ? 0 : v > GN - 1.001 ? GN - 1.001 : v;
  const i = u | 0;
  const j = v | 0;
  const fx = u - i;
  const fz = v - j;
  const k = i + GN * j;
  const a = HM[k] + (HM[k + 1] - HM[k]) * fx;
  const b = HM[k + GN] + (HM[k + GN + 1] - HM[k + GN]) * fx;
  return a + (b - a) * fz;
};
// top of the paper the point stands on (the water counts as a floor)
const groundAt = (x, z) => {
  const y = floor(hAt(x, z) / LAYER) * LAYER;
  return y > WL ? y : WL;
};
const slopeAt = (x, z) => {
  const e = GS;
  return hypot(hAt(x + e, z) - hAt(x - e, z), hAt(x, z + e) - hAt(x, z - e)) / (2 * e);
};
// room on the sheet at (x, z): metres to its own cut edge and to the foot of the sheet above
const roomAt = (x, z) => {
  const h = hAt(x, z);
  const g = max(slopeAt(x, z), 0.004);
  const k = floor(h / LAYER);
  return min(h - k * LAYER, (k + 1) * LAYER - h) / g;
};

// soften the heights (two passes of a 1-2-1 blur each way), so every sheet's outline is a clean curve
function smoothHeights() {
  const t = new Float32Array(GN * GN);
  for (let pass = 0; pass < 2; pass++) {
    for (let j = 0; j < GN; j++)
      for (let i = 0; i < GN; i++) {
        const k = i + GN * j;
        t[k] = (HM[i > 0 ? k - 1 : k] + 2 * HM[k] + HM[i < GN - 1 ? k + 1 : k]) * 0.25;
      }
    for (let j = 0; j < GN; j++)
      for (let i = 0; i < GN; i++) {
        const k = i + GN * j;
        HM[k] = (t[j > 0 ? k - GN : k] + 2 * t[k] + t[j < GN - 1 ? k + GN : k]) * 0.25;
      }
  }
}

// ---------------------------------------------------------------- land mesh: stacked sheets of paper
// Sheet k covers the ground where h >= k * LAYER; its top is flat at k * LAYER and its cut edge is a wall one sheet
// tall. Flat stretches merge into quadtree squares; their sides pick up every vertex of finer neighbours, so the
// surface has no cracks. Triangles are grouped by culling cell.
function buildTerrain() {
  const N = GN;
  const NC = N - 1;
  const K = new Int16Array(N * N);
  for (let i = 0; i < N * N; i++) K[i] = floor(HM[i] / LAYER);
  const node = new Int32Array(NC * NC);
  const CC = N / CELLS; // grid cells per culling cell
  const B = 16;
  let nodes = new Int32Array(1 << 18);
  let nn = 0;
  const uni = (i0, j0, s) => {
    const k = K[i0 + N * j0];
    for (let j = j0; j <= j0 + s; j++) for (let i = i0; i <= i0 + s; i++) if (K[i + N * j] !== k) return false;
    return true;
  };
  const leaf = (i0, j0, s) => {
    if (nn * 3 + 3 > nodes.length) {
      const n2 = new Int32Array(nodes.length * 2);
      n2.set(nodes);
      nodes = n2;
    }
    nodes[nn * 3] = i0;
    nodes[nn * 3 + 1] = j0;
    nodes[nn * 3 + 2] = s;
    for (let j = j0; j < j0 + s; j++) node.fill(nn, i0 + NC * j, i0 + s + NC * j);
    nn++;
  };
  const quad = (i0, j0, s) => {
    if (i0 >= NC || j0 >= NC) return;
    if (s === 1 || (i0 + s <= NC && j0 + s <= NC && uni(i0, j0, s))) return leaf(i0, j0, s);
    const h = s >> 1;
    quad(i0, j0, h);
    quad(i0 + h, j0, h);
    quad(i0, j0 + h, h);
    quad(i0 + h, j0 + h, h);
  };
  const cellNodes = new Uint32Array(CELLS * CELLS + 1);
  for (let cz = 0; cz < CELLS; cz++)
    for (let cx = 0; cx < CELLS; cx++) {
      cellNodes[cx + CELLS * cz] = nn;
      for (let bj = 0; bj < CC; bj += B) for (let bi = 0; bi < CC; bi += B) quad(cx * CC + bi, cz * CC + bj, B);
    }
  cellNodes[CELLS * CELLS] = nn;

  // output: 16-byte vertices (f32 x, y, z, snorm8 normal + aux) and u32 indices
  let vcap = 1 << 21;
  let vb = new ArrayBuffer(vcap * 16);
  let vf = new Float32Array(vb);
  let v8 = new Int8Array(vb);
  let nv = 0;
  let ib = new Uint32Array(1 << 22);
  let ni = 0;
  const V = (x, y, z, nx, nz, w) => {
    if (nv === vcap) {
      vcap *= 2;
      const b2 = new ArrayBuffer(vcap * 16);
      new Uint8Array(b2).set(new Uint8Array(vb));
      vb = b2;
      vf = new Float32Array(vb);
      v8 = new Int8Array(vb);
    }
    const o = nv * 4;
    vf[o] = x;
    vf[o + 1] = y;
    vf[o + 2] = z;
    v8[o * 4 + 12] = round(nx * 127);
    v8[o * 4 + 13] = nx === 0 && nz === 0 ? 127 : 0;
    v8[o * 4 + 14] = round(nz * 127);
    v8[o * 4 + 15] = round(w * 127);
    return nv++;
  };
  const T = (a, b, c) => {
    if (ni + 3 > ib.length) {
      const i2 = new Uint32Array(ib.length * 2);
      i2.set(ib);
      ib = i2;
    }
    ib[ni++] = a;
    ib[ni++] = b;
    ib[ni++] = c;
  };
  const X = (i) => WO + i * GS;
  const top = (i, j, y) => V(X(i), y, X(j), 0, 0, 1);
  // a point where level `lv` crosses the grid edge between two samples, the same from both cells that share it
  const ex = new Float64Array(2);
  const edge = (ia, ja, ib2, jb, lv) => {
    if (ia + N * ja > ib2 + N * jb) {
      const t1 = ia;
      ia = ib2;
      ib2 = t1;
      const t2 = ja;
      ja = jb;
      jb = t2;
    }
    const ha = HM[ia + N * ja];
    const t = (lv - ha) / (HM[ib2 + N * jb] - ha);
    ex[0] = X(ia + (ib2 - ia) * t);
    ex[1] = X(ja + (jb - ja) * t);
  };
  // corners of a cell in up-facing order
  const CI = [0, 0, 1, 1];
  const CJ = [0, 1, 1, 0];
  const PX = new Float64Array(8);
  const PZ = new Float64Array(8);
  const PE = new Uint8Array(8);
  const ids = new Int32Array(8);
  const wall = (ax, az, bx, bz, y) => {
    let nx = az - bz;
    let nz = bx - ax;
    const l = hypot(nx, nz);
    if (l < 1e-6) return;
    nx /= l;
    nz /= l;
    const pt = V(ax, y, az, nx, nz, 1);
    const pb = V(ax, y - LAYER, az, nx, nz, 0);
    const qb = V(bx, y - LAYER, bz, nx, nz, 0);
    const qt = V(bx, y, bz, nx, nz, 1);
    T(pt, pb, qb);
    T(pt, qb, qt);
  };
  const cross = (i, j) => {
    const h = [HM[i + N * j], HM[i + N * (j + 1)], HM[i + 1 + N * (j + 1)], HM[i + 1 + N * j]];
    let k0 = 1e9;
    let k1 = -1e9;
    for (let c = 0; c < 4; c++) {
      const k = floor(h[c] / LAYER);
      if (k < k0) k0 = k;
      if (k > k1) k1 = k;
    }
    const y0 = k0 * LAYER;
    const a = top(i, j, y0);
    const b = top(i, j + 1, y0);
    const c = top(i + 1, j + 1, y0);
    const d = top(i + 1, j, y0);
    T(a, b, c);
    T(a, c, d);
    for (let m = k0 + 1; m <= k1; m++) {
      const lv = m * LAYER;
      let n = 0;
      for (let c2 = 0; c2 < 4; c2++) {
        const c3 = (c2 + 1) & 3;
        const in0 = h[c2] >= lv;
        if (in0) {
          PX[n] = X(i + CI[c2]);
          PZ[n] = X(j + CJ[c2]);
          PE[n++] = 0;
        }
        if (in0 !== h[c3] >= lv) {
          edge(i + CI[c2], j + CJ[c2], i + CI[c3], j + CJ[c3], lv);
          PX[n] = ex[0];
          PZ[n] = ex[1];
          PE[n++] = 1;
        }
      }
      const saddle = n === 6 && h[0] >= lv === h[2] >= lv;
      if (saddle && (h[0] + h[1] + h[2] + h[3]) * 0.25 < lv) {
        // two separate corners: (corner, next edge point, previous edge point)
        for (const s of [0, 3]) {
          const p = (s + 5) % 6;
          const A = V(PX[s], lv, PZ[s], 0, 0, 1);
          const Bv = V(PX[s + 1], lv, PZ[s + 1], 0, 0, 1);
          const Cv = V(PX[p], lv, PZ[p], 0, 0, 1);
          T(A, Bv, Cv);
          wall(PX[s + 1], PZ[s + 1], PX[p], PZ[p], lv);
        }
        continue;
      }
      for (let q = 0; q < n; q++) ids[q] = V(PX[q], lv, PZ[q], 0, 0, 1);
      for (let q = 1; q < n - 1; q++) T(ids[0], ids[q], ids[q + 1]);
      for (let q = 0; q < n; q++) {
        const r = (q + 1) % n;
        if (PE[q] && PE[r]) wall(PX[q], PZ[q], PX[r], PZ[r], lv);
      }
    }
  };
  const ring = new Int32Array(4 * B + 4);
  const start = new Uint32Array(CELLS * CELLS + 1);
  const lo = new Float32Array(CELLS * CELLS).fill(1e9);
  const hi = new Float32Array(CELLS * CELLS).fill(-1e9);
  for (let c = 0; c < CELLS * CELLS; c++) {
    start[c] = ni;
    const v0 = nv;
    for (let q = cellNodes[c]; q < cellNodes[c + 1]; q++) {
      const i0 = nodes[q * 3];
      const j0 = nodes[q * 3 + 1];
      const s = nodes[q * 3 + 2];
      const k = K[i0 + N * j0];
      if (s === 1 && !(K[i0 + 1 + N * j0] === k && K[i0 + N * (j0 + 1)] === k && K[i0 + 1 + N * (j0 + 1)] === k)) {
        cross(i0, j0);
        continue;
      }
      const y = k * LAYER;
      let n = 0;
      ring[n++] = top(i0, j0, y);
      for (let j = j0 + 1; j < j0 + s; j++) if (i0 > 0 && node[i0 - 1 + NC * (j - 1)] !== node[i0 - 1 + NC * j]) ring[n++] = top(i0, j, y);
      ring[n++] = top(i0, j0 + s, y);
      for (let i = i0 + 1; i < i0 + s; i++)
        if (j0 + s < NC && node[i - 1 + NC * (j0 + s)] !== node[i + NC * (j0 + s)]) ring[n++] = top(i, j0 + s, y);
      ring[n++] = top(i0 + s, j0 + s, y);
      for (let j = j0 + s - 1; j > j0; j--)
        if (i0 + s < NC && node[i0 + s + NC * (j - 1)] !== node[i0 + s + NC * j]) ring[n++] = top(i0 + s, j, y);
      ring[n++] = top(i0 + s, j0, y);
      for (let i = i0 + s - 1; i > i0; i--)
        if (j0 > 0 && node[i - 1 + NC * (j0 - 1)] !== node[i + NC * (j0 - 1)]) ring[n++] = top(i, j0, y);
      if (n === 4) {
        T(ring[0], ring[1], ring[2]);
        T(ring[0], ring[2], ring[3]);
      } else {
        const m = V(X(i0 + s / 2), y, X(j0 + s / 2), 0, 0, 1);
        for (let q = 0; q < n; q++) T(m, ring[q], ring[(q + 1) % n]);
      }
    }
    for (let v = v0; v < nv; v++) {
      const y = vf[v * 4 + 1];
      if (y < lo[c]) lo[c] = y;
      if (y > hi[c]) hi[c] = y;
    }
  }
  start[CELLS * CELLS] = ni;
  return { vb: vb.slice(0, nv * 16), ib: ib.slice(0, ni), nv, start, lo, hi };
}

// ---------------------------------------------------------------- origami meshes
// parts: 0 wood, 1 instance colour, 2 white paper, 3 window (glows at night), 4 ink, 5 stone, 6 lantern paper (glows)
// shade (0-255) darkens a vertex, aux carries the wing span for the cranes
const orient = (m, a, b, c, hx, hy, hz) => {
  const P = m.p;
  const ux = P[b * 3] - P[a * 3];
  const uy = P[b * 3 + 1] - P[a * 3 + 1];
  const uz = P[b * 3 + 2] - P[a * 3 + 2];
  const vx = P[c * 3] - P[a * 3];
  const vy = P[c * 3 + 1] - P[a * 3 + 1];
  const vz = P[c * 3 + 2] - P[a * 3 + 2];
  const d = (uy * vz - uz * vy) * hx + (uz * vx - ux * vz) * hy + (ux * vy - uy * vx) * hz;
  d >= 0 ? m.tri(a, b, c) : m.tri(a, c, b);
};
function meshPine(lod) {
  const m = new Mesh();
  const tr = m.ring(4, 0, 0.28, 0, 120, PI / 4);
  const tt = m.ring(4, 2.4, 0.2, 0, 200, PI / 4);
  m.band(tr, tt);
  const tiers = lod ? 2 : 3;
  for (let t = 0; t < tiers; t++) {
    const f = lod ? t * 1.5 : t;
    const yb = 1.5 + f * 2.1;
    const r = 2.5 * (1 - f * 0.26);
    const n = lod ? 6 : 12;
    const ring = [];
    for (let k = 0; k < n; k++) {
      const a = (k / n) * TAU + t;
      const rad = lod || k % 2 ? r : r * 0.8;
      ring.push(m.v(cos(a) * rad, yb + (k % 2 && !lod ? 0.35 : 0), sin(a) * rad, 1, 205));
    }
    const apex = m.v(0, yb + 3.7 * (1 - f * 0.1), 0, 1, 255);
    m.fan(ring, apex);
    m.fan(ring, m.v(0, yb + 0.5, 0, 1, 110), true);
  }
  return m;
}
// a papercraft tree: three cut-out cards slotted together, each folded a little down its middle
function meshRound(lod) {
  const m = new Mesh();
  const n = lod ? 10 : 18;
  for (let c = 0; c < 3; c++) {
    const a = (c / 3) * PI + 0.3;
    const ux = cos(a);
    const uz = sin(a);
    const P = (u, y, part, shade) => m.v(ux * u - uz * abs(u) * 0.14, y, uz * u + ux * abs(u) * 0.14, part, shade);
    m.quad(P(-0.24, 0, 0, 130), P(0.24, 0, 0, 130), P(0.18, 3.1, 0, 190), P(-0.18, 3.1, 0, 190));
    const ring = [];
    for (let k = 0; k < n; k++) {
      const t = (k / n) * TAU + PI / 2;
      const r = 2.6 * (k % 2 ? 0.9 : 1);
      ring.push(P(cos(t) * r, 4.9 + sin(t) * r * 1.08, 1, 255));
    }
    m.fan(ring, P(0, 4.9, 1, 215));
  }
  return m;
}
function meshBush() {
  rseed(44);
  const m = icosphere(
    0,
    (x, y, z) => {
      const r = 1.2 * (1 + rr(-0.15, 0.15));
      return [x * r, 0.6 + y * r * 0.75, z * r];
    },
    1,
  );
  for (let k = 0; k < m.a.length; k += 4) m.a[k + 1] = round(160 + 95 * sstep(0, 1.4, m.p[(k / 4) * 3 + 1]));
  return m;
}
function meshHouse() {
  const m = new Mesh();
  const w = 2.6;
  const d = 2.1;
  const h = 3;
  const rh = 2.3;
  m.box(-w, 0, -d, w, h, d, 2);
  // gable roof with overhang: two folded planes and the gable ends
  const o = 0.5;
  const r = [
    m.v(-w - o, h - 0.3, -d - o, 1),
    m.v(w + o, h - 0.3, -d - o, 1),
    m.v(w + o, h + rh, 0, 1, 255),
    m.v(-w - o, h + rh, 0, 1, 255),
  ];
  m.quad(r[0], r[1], r[2], r[3]);
  const r2 = [
    m.v(-w - o, h - 0.3, d + o, 1, 215),
    m.v(w + o, h - 0.3, d + o, 1, 215),
    m.v(w + o, h + rh, 0, 1, 235),
    m.v(-w - o, h + rh, 0, 1, 235),
  ];
  m.quad(r2[0], r2[1], r2[2], r2[3]);
  for (const sx of [-w, w]) m.tri(m.v(sx, h, -d, 2), m.v(sx, h, d, 2), m.v(sx, h + rh - 0.1, 0, 2));
  // door and windows
  const pane = (x0, y0, x1, y1, z) => m.quad(m.v(x0, y0, z, 3), m.v(x1, y0, z, 3), m.v(x1, y1, z, 3), m.v(x0, y1, z, 3));
  pane(-0.5, 0, 0.5, 1.9, d + 0.03);
  pane(-2, 1.2, -1.1, 2.1, d + 0.03);
  pane(1.1, 1.2, 2, 2.1, d + 0.03);
  pane(-1.6, 1.2, -0.5, 2.1, -d - 0.03);
  pane(0.5, 1.2, 1.6, 2.1, -d - 0.03);
  return m;
}
function meshPagoda() {
  const m = new Mesh();
  m.box(-3.4, -0.4, -3.4, 3.4, 0.5, 3.4, 5);
  let y = 0.5;
  for (let t = 0; t < 4; t++) {
    const w = 3.3 - t * 0.6;
    m.box(-w, y, -w, w, y + 2.4, w, 1);
    y += 2.4;
    // roof: a steep upper fold, then wide eaves that sweep up toward the corners
    const ring = (rad, yc, ym, shade) => {
      const c = [];
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * TAU + PI / 4;
        const corner = k % 2 === 0;
        const r = corner ? rad * Math.SQRT2 : rad;
        c.push(m.v(cos(a) * r, y + (corner ? yc : ym), sin(a) * r, 4, corner ? shade : shade - 40));
      }
      return c;
    };
    const inner = ring(w + 0.45, 0.85, 0.75, 225);
    const eave = ring(w + 2, 1.25, 0.12, 245);
    m.fan(inner, m.v(0, y + 1.9, 0, 4, 255));
    m.band(eave, inner);
    m.fan(eave, m.v(0, y - 0.1, 0, 4, 90), true);
    y += 0.9;
  }
  m.box(-0.12, y, -0.12, 0.12, y + 3.2, 0.12, 4);
  for (let k = 0; k < 4; k++) m.box(-0.35, y + 0.7 + k * 0.6, -0.35, 0.35, y + 0.82 + k * 0.6, 0.35, 4);
  return m;
}
function meshTorii() {
  const m = new Mesh();
  for (const sx of [-3.4, 3.4]) {
    const b = m.ring(8, -1, 0.46, 4);
    const k = m.ring(8, 1.2, 0.45, 4);
    const t = m.ring(8, 9, 0.38, 1);
    const k2 = m.ring(8, 1.2, 0.45, 1);
    m.band(b, k);
    m.band(k2, t);
    for (const id of [...b, ...k]) m.p[id * 3] += sx;
    for (const id of [...k2, ...t]) m.p[id * 3] += sx * (m.p[id * 3 + 1] > 5 ? 0.97 : 1);
  }
  // kasagi: the top beam, its ends swept up, with a black cap
  const seg = 8;
  for (let s = 0; s < seg; s++) {
    const x0 = -6 + (12 * s) / seg;
    const x1 = -6 + (12 * (s + 1)) / seg;
    const lift = (x) => 0.016 * x * x;
    const p = [
      [x0, 9 + lift(x0)],
      [x1, 9 + lift(x1)],
    ];
    const box = (y0, y1, dz, part) => {
      const a = [
        m.v(p[0][0], p[0][1] + y0, -dz, part),
        m.v(p[1][0], p[1][1] + y0, -dz, part),
        m.v(p[1][0], p[1][1] + y1, -dz, part),
        m.v(p[0][0], p[0][1] + y1, -dz, part),
      ];
      const b = [
        m.v(p[0][0], p[0][1] + y0, dz, part),
        m.v(p[1][0], p[1][1] + y0, dz, part),
        m.v(p[1][0], p[1][1] + y1, dz, part),
        m.v(p[0][0], p[0][1] + y1, dz, part),
      ];
      m.quad(a[0], a[1], a[2], a[3]);
      m.quad(b[0], b[1], b[2], b[3]);
      m.quad(a[3], a[2], b[2], b[3]);
      m.quad(a[0], a[1], b[1], b[0]);
    };
    box(0, 0.6, 0.55, 1);
    box(0.6, 0.95, 0.7, 4);
  }
  m.box(-4.6, 7.2, -0.32, 4.6, 7.75, 0.32, 1);
  m.box(-0.3, 7.75, -0.28, 0.3, 9, 0.28, 1);
  return m;
}
function meshBoat() {
  const m = new Mesh();
  const k0 = m.v(-1.1, -0.35, 0, 1, 170);
  const k1 = m.v(1.1, -0.35, 0, 1, 170);
  for (const sz of [-1, 1]) {
    const a = m.v(-2.1, 0.55, 0.75 * sz, 1, 230);
    const b = m.v(2.1, 0.55, 0.75 * sz, 1, 230);
    m.quad(k0, k1, b, a);
  }
  for (const sx of [-1, 1]) {
    const k = sx < 0 ? k0 : k1;
    m.tri(k, m.v(2.1 * sx, 0.55, 0.75, 1, 210), m.v(2.1 * sx, 0.55, -0.75, 1, 210));
  }
  const apex = m.v(0, 2.7, 0, 1, 255);
  for (const sz of [-1, 1]) {
    const mid = m.v(0, 0.55, 0.32 * sz, 1, 220);
    m.tri(m.v(-1.25, 0.55, 0, 1, 215), mid, apex);
    m.tri(mid, m.v(1.25, 0.55, 0, 1, 200), apex);
  }
  return m;
}
function meshCrane() {
  const m = new Mesh();
  const span = (x) => round((x / 1.9 + 1) * 127.5);
  const v = (x, y, z, s = 255) => m.v(x, y, z, 1, s, span(x));
  const rf = v(0, 0.12, 0.38);
  const rb = v(0, 0.12, -0.38);
  for (const sx of [-1, 1]) {
    const mid = v(0.95 * sx, 0.3, -0.12, 235);
    const tip = v(1.9 * sx, 0.42, -0.5, 255);
    orient(m, rf, rb, mid, 0, 1, 0);
    orient(m, rf, mid, tip, 0, 1, 0);
    orient(m, rb, tip, mid, 0, 1, 0);
    const belly = v(0.12 * sx, -0.24, 0, 170);
    orient(m, rf, rb, belly, sx, 0, 0);
  }
  for (const sz of [-1, 1]) {
    const tip = v(0, 0.95, 1.35 * sz, 245);
    const a = v(-0.05, -0.12, 0.28 * sz, 200);
    const b = v(0.05, -0.12, 0.28 * sz, 200);
    m.tri(a, v(0, 0.14, 0.32 * sz), tip);
    m.tri(b, v(0, 0.14, 0.32 * sz), tip);
    if (sz > 0) m.tri(tip, v(0, 0.8, 1.55, 220), v(0.03, 0.88, 1.38, 220));
  }
  return m;
}
function meshCloud(sd) {
  rseed(60 + sd);
  const m = new Mesh();
  const n = 3 + ((rnd() * 3) | 0);
  for (let i = 0; i < n; i++) {
    const cx = rr(-2.2, 2.2);
    const cz = rr(-1, 1);
    const R = rr(1, 1.7) * (1 - abs(cx) * 0.12);
    const H = R * rr(0.5, 0.65);
    const p = 14;
    const rim = [];
    const mid = [];
    for (let k = 0; k < p; k++) {
      const a = (k / p) * TAU;
      const b = a + PI / p;
      const o = k % 2 === 0;
      rim.push(m.v(cx + cos(a) * R * (o ? 1 : 0.9), 0, cz + sin(a) * R * (o ? 1 : 0.9), 1, 200));
      mid.push(m.v(cx + cos(b) * R * (o ? 0.78 : 0.68), H * 0.62, cz + sin(b) * R * (o ? 0.78 : 0.68), 1, 238));
    }
    for (let k = 0; k < p; k++) {
      const k2 = (k + 1) % p;
      m.tri(rim[k], rim[k2], mid[k]);
      m.tri(rim[k2], mid[k2], mid[k]);
    }
    m.fan(mid, m.v(cx, H, cz, 1, 255));
    m.fan(rim, m.v(cx, -0.05, cz, 1, 175), true);
  }
  return m;
}
function meshLantern() {
  const m = new Mesh();
  const b = m.ring(6, 0, 0.42, 6, 200);
  const t = m.ring(6, 1.2, 0.55, 6, 255);
  m.band(b, t);
  m.fan(t, m.v(0, 1.35, 0, 6, 255));
  return m;
}
function meshRock() {
  rseed(70);
  return icosphere(
    0,
    (x, y, z) => {
      const r = 1 + rr(-0.25, 0.25);
      return [x * r, y * r * 0.7, z * r];
    },
    5,
  );
}
// the paper dart: front faces are the coloured side of the sheet, back faces the white one
function meshPlane() {
  const m = new Mesh();
  const N = m.v(0, 0.02, 1);
  const Tr = m.v(0, 0, -1);
  for (const sx of [-1, 1]) {
    const Mid = m.v(0.4 * sx, 0.1, -1);
    const Tip = m.v(0.95 * sx, 0.3, -0.96);
    orient(m, N, Tr, Mid, 0, 1, 0);
    orient(m, N, Mid, Tip, 0, 1, 0);
    const Kb = m.v(0.035 * sx, -0.36, -0.88);
    orient(m, N, Tr, Kb, sx, 0, 0);
  }
  return m;
}
// the sun: a pleated paper rosette with folded rays; the moon: a crescent folded along its spine
function meshSun() {
  const m = new Mesh();
  const c = m.v(0, 0, 0.3, 0);
  const n = 32;
  const ring = [];
  for (let k = 0; k < n; k++) {
    const a = (k / n) * TAU;
    ring.push(m.v(cos(a), sin(a), k % 2 ? 0.14 : 0, 0));
  }
  m.fan(ring, c);
  for (let k = 0; k < 12; k++) {
    const a = ((k + 0.5) / 12) * TAU;
    const w = 0.17;
    const l = m.v(cos(a - w) * 0.97, sin(a - w) * 0.97, 0.02, 2);
    const r = m.v(cos(a + w) * 0.97, sin(a + w) * 0.97, 0.02, 2);
    const mid = m.v(cos(a) * 1.05, sin(a) * 1.05, 0.1, 2);
    const tip = m.v(cos(a) * 1.42, sin(a) * 1.42, 0, 2);
    m.tri(l, mid, tip);
    m.tri(mid, r, tip);
  }
  const inner = m.ring(12, 0, 0.42, 1);
  for (const id of inner) {
    const y = m.p[id * 3 + 1];
    m.p[id * 3 + 1] = m.p[id * 3 + 2];
    m.p[id * 3 + 2] = 0.32;
  }
  m.fan(inner, m.v(0, 0, 0.5, 1));
  return m;
}
function meshMoon() {
  const m = new Mesh();
  const n = 20;
  let pv = null;
  for (let k = 0; k <= n; k++) {
    const t = (k / n) * 2 - 1;
    const a = t * 1.75;
    const ox = -cos(a);
    const oy = sin(a);
    const w = 0.5 * pow(max(cos(t * 1.45), 0), 0.9) + 0.02;
    const o = m.v(ox, oy, 0, 8);
    const s = m.v(ox * (1 - w * 0.5), oy * (1 - w * 0.5), 0.12 * w + 0.01, 8);
    const i = m.v(ox * (1 - w), oy * (1 - w), 0, 8);
    if (pv) {
      m.quad(pv[0], o, s, pv[1]);
      m.quad(pv[1], s, i, pv[2]);
    }
    pv = [o, s, i];
  }
  return m;
}

// ---------------------------------------------------------------- props
// instance: 8 floats (x, y, z, scale, yaw, packed colour, seed, extra)
const rgb = (r, g, b) => round(r * 255) * 65536 + round(g * 255) * 256 + round(b * 255);
const PAL_PINE = [rgb(0.27, 0.45, 0.33), rgb(0.32, 0.51, 0.36), rgb(0.23, 0.41, 0.37), rgb(0.36, 0.5, 0.33)];
const PAL_ROUND = [rgb(0.5, 0.65, 0.37), rgb(0.58, 0.68, 0.38), rgb(0.42, 0.6, 0.36), rgb(0.62, 0.7, 0.42)];
const PAL_CHERRY = [rgb(0.97, 0.75, 0.8), rgb(0.94, 0.66, 0.73), rgb(0.98, 0.84, 0.86)];
const PAL_MAPLE = [rgb(0.86, 0.4, 0.27), rgb(0.92, 0.55, 0.28)];
const PAL_ROOF = [rgb(0.3, 0.38, 0.5), rgb(0.62, 0.3, 0.24), rgb(0.36, 0.45, 0.4), rgb(0.24, 0.26, 0.32)];
const PAL_PAPER = [rgb(0.97, 0.96, 0.92), rgb(0.96, 0.84, 0.82), rgb(0.78, 0.85, 0.93), rgb(0.95, 0.85, 0.6), rgb(0.86, 0.42, 0.33)];
const pick = (a) => a[(rnd() * a.length) | 0];

function makeWorld() {
  const nCells = CELLS * CELLS;
  const cellOf = (x, z) => clamp(floor((x - WO) / CELLW), 0, CELLS - 1) + CELLS * clamp(floor((z - WO) / CELLW), 0, CELLS - 1);
  // static props by mesh: 0 pine, 1 round tree, 2 bush, 3 house, 4 pagoda, 5 torii, 6 rock
  const stat = Array.from({ length: 7 }, () => Array.from({ length: nCells }, () => []));
  const put = (mesh, x, y, z, sc, yaw, col, extra = 0) => stat[mesh][cellOf(x, z)].push(x, y, z, sc, yaw, col, rnd(), extra);
  // ground map: r shade under props, g forest, b fallen blossom
  const GMN = 1024;
  const gmf = new Float32Array(GMN * GMN * 3);
  const splat = (x, z, r, ch, v) => {
    const u = ((x - WO) / WORLD) * GMN;
    const w = ((z - WO) / WORLD) * GMN;
    const rr2 = (r / WORLD) * GMN;
    for (let j = floor(w - rr2); j <= w + rr2; j++)
      for (let i = floor(u - rr2); i <= u + rr2; i++) {
        if (i < 0 || j < 0 || i >= GMN || j >= GMN) continue;
        const d = hypot(i + 0.5 - u, j + 0.5 - w) / rr2;
        if (d < 1) gmf[(i + GMN * j) * 3 + ch] += v * (1 - d * d);
      }
  };
  const placed = [];
  const free = (x, z, r) => {
    for (let i = 0; i < placed.length; i += 3) if (hypot(x - placed[i], z - placed[i + 1]) < r + placed[i + 2]) return false;
    return true;
  };
  const claim = (x, z, r) => placed.push(x, z, r);
  const spot = (tx, tz, rad, test, tries = 4000) => {
    let best = null;
    let bs = -Infinity;
    for (let i = 0; i < tries; i++) {
      const a = rnd() * TAU;
      const r = sqrt(rnd()) * rad;
      const x = tx + cos(a) * r;
      const z = tz + sin(a) * r;
      const s = test(x, z, r);
      if (s > bs) {
        bs = s;
        best = [x, z];
      }
    }
    return best;
  };

  // --- landmarks: the torii standing in the bay, the pagoda on its hill
  rseed(2);
  const torii = spot(
    -80,
    640,
    320,
    (x, z, r) => {
      const h = hAt(x, z);
      if (!(h > -5 && h < -2.4 && roomAt(x, z) > 16)) return -1e9;
      // out in the bay: open water all around the gate, the shore in sight
      let shore = false;
      for (let k = 0; k < 12; k++) {
        const a = (k / 12) * TAU;
        if (hAt(x + cos(a) * 24, z + sin(a) * 24) > -0.5) return -1e9;
        for (let d = 50; d <= 150; d += 25) if (hAt(x + cos(a) * d, z + sin(a) * d) > 2) shore = true;
      }
      return shore ? -r : -1e9;
    },
    20000,
  );
  // the gate faces the nearest shore
  let toriiYaw = 0;
  for (let d = 30, found = false; d < 400 && !found; d += 5)
    for (let k = 0; k < 72; k++) {
      const a = (k / 72) * TAU;
      if (hAt(torii[0] + sin(a) * d, torii[1] + cos(a) * d) > 1) {
        toriiYaw = a;
        found = true;
        break;
      }
    }
  put(5, torii[0], groundAt(torii[0], torii[1]) - 0.05, torii[1], 1.45, toriiYaw, rgb(0.82, 0.27, 0.2));
  claim(torii[0], torii[1], 14);
  const pagoda = spot(240, 170, 160, (x, z) => {
    const h = hAt(x, z);
    const room = roomAt(x, z);
    return room > 14 && h > 20 ? min(room, 30) + h * 0.05 : -1e9;
  });
  put(4, pagoda[0], groundAt(pagoda[0], pagoda[1]), pagoda[1], 1.25, rnd() * TAU, rgb(0.8, 0.3, 0.22));
  claim(pagoda[0], pagoda[1], 14);

  // --- villages on the low sheets near the shore
  const VILL = [
    [-40, 520, 120],
    [250, 330, 90],
    [-780, 640, 110],
    [-470, -860, 90],
    [900, 420, 90],
    [-330, 380, 90],
  ];
  const villages = [];
  rseed(3);
  for (const v of VILL) {
    const c = spot(
      v[0],
      v[1],
      v[2] * 0.5,
      (x, z) => {
        const h = hAt(x, z);
        return h > 2 && h < 30 ? -abs(h - 10) : -1e9;
      },
      600,
    );
    villages.push(c);
    let n = 0;
    for (let i = 0; i < 900 && n < 22; i++) {
      const a = rnd() * TAU;
      const r = sqrt(rnd()) * v[2];
      const x = c[0] + cos(a) * r;
      const z = c[1] + sin(a) * r;
      const h = hAt(x, z);
      if (h < 1 || h > 44 || roomAt(x, z) < 5.5 || !free(x, z, 5)) continue;
      const sc = rr(0.85, 1.2);
      put(3, x, floor(h / LAYER) * LAYER, z, sc, (floor(rnd() * 4) * PI) / 2 + rr(-0.15, 0.15), pick(PAL_ROOF));
      claim(x, z, 4.5 * sc);
      splat(x, z, 7, 0, 0.35);
      n++;
    }
  }

  // --- trees: forests on the hills, cherry trees around the villages, a few maples, bushes along the edges
  rseed(4);
  const nearVillage = (x, z) => {
    let d = 1e9;
    for (const c of villages) d = min(d, hypot(x - c[0], z - c[1]));
    return d;
  };
  const NT = 60000 / THIN;
  for (let i = 0; i < NT * 4; i++) {
    const x = WO + rnd() * WORLD;
    const z = WO + rnd() * WORLD;
    const h = hAt(x, z);
    if (h < 3 || h > 178) continue;
    const forest = sstep(0.48, 0.63, fbm2(x * 0.004, z * 0.004, 4));
    const dv = nearVillage(x, z);
    const cher = sstep(170, 60, dv);
    if (rnd() > forest * 0.9 + cher * 0.35 + 0.025) continue;
    const sc = rr(0.7, 1.35);
    if (roomAt(x, z) < 1.6 * sc || !free(x, z, 1.4 * sc)) continue;
    const y = floor(h / LAYER) * LAYER;
    const yaw = rnd() * TAU;
    if (cher > 0.3 && rnd() < 0.55) {
      put(1, x, y, z, sc * 0.9, yaw, pick(PAL_CHERRY), 1);
      splat(x, z, 5, 2, 0.5);
    } else if (h > 70 || rnd() < 0.45 * (1 - cher)) put(0, x, y, z, sc * mix(1, 0.75, sstep(80, 170, h)), yaw, pick(PAL_PINE), 0.6);
    else if (rnd() < 0.05) put(1, x, y, z, sc, yaw, pick(PAL_MAPLE), 1);
    else put(1, x, y, z, sc, yaw, pick(PAL_ROUND), 1);
    splat(x, z, 3.2 * sc, 0, 0.3);
    splat(x, z, 8, 1, 0.09);
  }
  // pines on the tops of the karst pillars
  for (const s of ISLANDS) {
    if (s[4] !== 2) continue;
    let n = 0;
    for (let i = 0; i < 400 && n < 9; i++) {
      const a = rnd() * TAU;
      const r = sqrt(rnd()) * s[2] * 0.6;
      const x = s[0] + cos(a) * r;
      const z = s[1] + sin(a) * r;
      const h = hAt(x, z);
      const sc = rr(0.6, 1.1);
      if (h < s[3] * 0.55 || roomAt(x, z) < 0.9 * sc || !free(x, z, 1.2 * sc)) continue;
      put(rnd() < 0.75 ? 0 : 1, x, floor(h / LAYER) * LAYER, z, sc, rnd() * TAU, pick(rnd() < 0.75 ? PAL_PINE : PAL_ROUND), 0.6);
      splat(x, z, 3, 0, 0.3);
      n++;
    }
  }
  rseed(5);
  for (let i = 0; i < 40000 / THIN; i++) {
    const x = WO + rnd() * WORLD;
    const z = WO + rnd() * WORLD;
    const h = hAt(x, z);
    if (h < 2 || h > 120 || roomAt(x, z) < 1.2 || !free(x, z, 1)) continue;
    if (rnd() > 0.15 + 0.5 * sstep(0.4, 0.6, fbm2(x * 0.004 + 9, z * 0.004, 3))) continue;
    put(2, x, floor(h / LAYER) * LAYER, z, rr(0.6, 1.3), rnd() * TAU, pick(PAL_ROUND), 0.8);
    splat(x, z, 1.8, 0, 0.25);
  }
  // rocks on the beaches and in the shallows
  rseed(6);
  for (let i = 0; i < 9000; i++) {
    const x = WO + rnd() * WORLD;
    const z = WO + rnd() * WORLD;
    const h = hAt(x, z);
    if (h < -7 || h > 6 || roomAt(x, z) < 1.5 || rnd() < 0.5) continue;
    const sc = rr(0.6, 2.4);
    put(6, x, floor(h / LAYER) * LAYER + sc * 0.15, z, sc, rnd() * TAU, 0);
  }

  // --- moving things: boats, crane flocks, clouds, lanterns
  rseed(7);
  const boats = [];
  for (let i = 0; i < 4000 && boats.length < 46 * 8; i++) {
    const x = WO + 200 + rnd() * (WORLD - 400);
    const z = WO + 200 + rnd() * (WORLD - 400);
    const h = hAt(x, z);
    if (h > -6 || h < -30) continue;
    boats.push(x, WL, z, rr(0.9, 1.4), rnd() * TAU, pick(PAL_PAPER), rnd(), rr(6, 24));
  }
  const cranes = [];
  const FLOCKS = [
    [-120, 90, 380, 110],
    [700, 110, -600, 160],
    [-800, 80, 700, 120],
    [200, 70, 250, 90],
    [-40, 50, 650, 80],
    [-500, 120, -880, 140],
    [930, 80, 380, 100],
  ];
  for (const f of FLOCKS) {
    const n = 5 + ((rnd() * 5) | 0);
    const sp = (rnd() < 0.5 ? -1 : 1) * rr(9, 12);
    const ph = rnd() * TAU;
    const col = pick(PAL_PAPER);
    for (let k = 0; k < n; k++)
      cranes.push(
        f[0] + rr(-5, 5),
        f[1] + rr(-4, 4),
        f[2] + rr(-5, 5),
        f[3] + rr(-6, 6),
        ph - k * 0.035 * sign1(sp) + rr(-0.01, 0.01),
        rnd() < 0.8 ? col : pick(PAL_PAPER),
        rnd(),
        sp,
      );
  }
  const clouds = [];
  for (let i = 0; i < 30; i++)
    clouds.push(WO + rnd() * WORLD, rr(200, 340), WO + rnd() * WORLD, rr(10, 22), rnd() * TAU, rgb(0.98, 0.97, 0.95), rnd(), rr(1.2, 2.6));
  for (let i = 0; i < clouds.length; i += 8) {
    let top = -50;
    for (let x = WO; x < -WO; x += 12) top = max(top, hAt(x, clouds[i + 2]));
    if (clouds[i + 1] < top + 45) clouds[i + 1] = top + 45 + rnd() * 40;
  }
  const lanterns = [];
  for (const c of villages)
    for (let k = 0; k < 14; k++)
      lanterns.push(
        c[0] + rr(-40, 40),
        groundAt(c[0], c[1]) + 4,
        c[1] + rr(-40, 40),
        rr(0.9, 1.3),
        rnd() * TAU,
        rgb(1, rr(0.6, 0.7), rr(0.22, 0.3)),
        rnd(),
        rr(2.2, 3.4),
      );
  for (let k = 0; k < 36; k++) {
    const a = rnd() * TAU;
    const r = rr(14, 70);
    const x = torii[0] + cos(a) * r;
    const z = torii[1] + sin(a) * r;
    if (hAt(x, z) > -2.5) continue;
    lanterns.push(x, WL, z, rr(0.5, 0.7), rnd() * TAU, rgb(1, rr(0.58, 0.68), 0.26), rnd(), 0);
  }

  // --- pack static props by culling cell
  const pack = (L) => {
    let n = 0;
    const start = new Uint32Array(nCells + 1);
    for (let c = 0; c < nCells; c++) {
      start[c] = n;
      n += L[c].length / 8;
    }
    start[nCells] = n;
    const data = new Float32Array(n * 8);
    const lo = new Float32Array(nCells).fill(1e9);
    const hi = new Float32Array(nCells).fill(-1e9);
    let k = 0;
    for (let c = 0; c < nCells; c++) {
      const a = L[c];
      for (let i = 0; i < a.length; i += 8) {
        for (let j = 0; j < 8; j++) data[k++] = a[i + j];
        lo[c] = min(lo[c], a[i + 1] - 2);
        hi[c] = max(hi[c], a[i + 1] + 16 * a[i + 3]);
      }
    }
    return { data, n, start, lo, hi };
  };
  const gm = new Uint8Array(GMN * GMN * 4);
  for (let i = 0; i < GMN * GMN; i++) {
    gm[i * 4] = min(gmf[i * 3], 1) * 255;
    gm[i * 4 + 1] = min(gmf[i * 3 + 1], 1) * 255;
    gm[i * 4 + 2] = min(gmf[i * 3 + 2], 1) * 255;
  }
  const pois = [[-220, -60], [700, -620], ...villages, torii, pagoda];
  for (const s of ISLANDS.slice(0, 11)) pois.push([s[0], s[1]]);
  return {
    stat: stat.map(pack),
    boats: new Float32Array(boats),
    cranes: new Float32Array(cranes),
    clouds: new Float32Array(clouds),
    lanterns: new Float32Array(lanterns),
    gm,
    GMN,
    pois,
    torii,
    toriiYaw,
    pagoda,
    villages,
  };
}
const sign1 = (x) => (x < 0 ? -1 : 1);
