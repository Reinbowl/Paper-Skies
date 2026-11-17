// ============================================================================
// WGSL sources
// ============================================================================
const W_FS = /*wgsl*/ `
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f { return vec4f(f32(i32(i & 1u) * 4 - 1), f32(i32(i >> 1u) * 4 - 1), 0., 1.); }
`;

const W_NOISE = /*wgsl*/ `
fn ss(a: f32, b: f32, x: f32) -> f32 { let t = clamp((x - a) / (b - a), 0., 1.); return t * t * (3. - 2. * t); }
fn h21(p: vec2f) -> f32 { var q = fract(vec3f(p.xyx) * .1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
fn vn(p: vec2f) -> f32 {
  let i = floor(p); let f = fract(p); let u = f * f * (3. - 2. * f);
  return mix(mix(h21(i), h21(i + vec2f(1., 0.)), u.x), mix(h21(i + vec2f(0., 1.)), h21(i + vec2f(1., 1.)), u.x), u.y);
}
fn fbm(p: vec2f, n: i32) -> f32 {
  var a = .5; var s = 0.; var q = p;
  for (var i = 0; i < n; i++) { s += a * vn(q); q = q * 2.03 + vec2f(17.1, 31.7); a *= .5; }
  return s / (1. - 2. * a);
}
fn ridged(p: vec2f, n: i32) -> f32 {
  var a = .5; var s = 0.; var q = p;
  for (var i = 0; i < n; i++) { s += a * (1. - abs(2. * vn(q) - 1.)); q = q * 2.03 + vec2f(17.1, 31.7); a *= .5; }
  return s / (1. - 2. * a);
}
`;

// ---------------------------------------------------------------- island heights (compute, once)
// I: two vec4 per island: (x, z, radius, height), (kind, warp, roughness, seed); kind 0 rolling, 1 cone, 2 pillar
const W_HGT =
  W_NOISE +
  /*wgsl*/ `
struct U { n: u32, ni: u32, gs: f32, wo: f32 };
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var<storage, read_write> H: array<f32>;
@group(0) @binding(2) var<storage, read> I: array<vec4f>;
fn smax(a: f32, b: f32, k: f32) -> f32 { let h = max(k - abs(a - b), 0.) / k; return max(a, b) + h * h * k * .25; }
fn height(p: vec2f) -> f32 {
  let w = vec2f(fbm(p * .0023 + 3.1, 3), fbm(p * .0023 + 17.7, 3)) - .5;
  var h = -42. + 8. * (fbm(p * .003 + 40., 3) - .5);
  for (var i = 0u; i < u.ni; i++) {
    let a = I[i * 2u]; let b = I[i * 2u + 1u];
    let q = p + w * b.y;
    let d = length(q - a.xy) / a.z;
    var e = -1e3;
    if (b.x < .5) {
      let f = max(1. - d * d, 0.);
      e = -42. + (a.w + 42.) * f * f * (1. + b.z * (fbm(q * .011 + b.w, 4) - .5));
    } else if (b.x < 1.5) {
      let an = atan2(q.y - a.y, q.x - a.x);
      let gul = ridged(vec2f(an * 6.4 + b.w, d * 4.), 3);
      let cone = pow(max(1. - d, 0.), 1.7);
      let top = min(cone, .93) / .93 - .035 * ss(.07, .0, d);
      e = -42. + (a.w + 42.) * top - b.z * gul * ss(.0, .3, d) * ss(1., .5, d) * 26.;
    } else {
      let dir = (q - a.xy) / max(length(q - a.xy), 1e-3);
      let d2 = d * (1. + .5 * (fbm(dir * 1.3 + b.w, 3) - .5));
      let f = exp(-pow(d2, 4.5));
      e = -42. + (a.w + 42.) * f * (1. + .26 * (fbm(q * .045 + b.w, 3) - .5));
    }
    h = smax(h, e, 7.);
  }
  // rolling detail on the land, softened right at the shore so beaches stay wide
  let land = ss(-4., 24., h);
  h += 22. * (fbm(p * .0075 + 7.7, 4) - .5) * land;
  h = mix(h, .4 * h + 1.5, ss(-2., 1., h) * ss(9., 3., h) * .55);
  return h;
}
@compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= u.n || id.y >= u.n) { return; }
  H[id.x + id.y * u.n] = height(vec2f(id.xy) * u.gs + u.wo);
}
`;

// ---------------------------------------------------------------- paper texture (tileable, once): r fibres, g grain, b mottling
const W_DETAIL =
  W_NOISE +
  W_FS +
  /*wgsl*/ `
fn hp(p: vec2f, per: f32) -> f32 { return h21(p - per * floor(p / per) + per * 1.7); }
fn tn(p: vec2f, per: f32) -> f32 {
  let i = floor(p); let f = fract(p); let u = f * f * (3. - 2. * f);
  return mix(mix(hp(i, per), hp(i + vec2f(1., 0.), per), u.x), mix(hp(i + vec2f(0., 1.), per), hp(i + vec2f(1., 1.), per), u.x), u.y);
}
fn tf(uv: vec2f, per: f32, n: i32) -> f32 { var a = .5; var s = 0.; var pr = per; for (var i = 0; i < n; i++) { s += a * tn(uv * pr + f32(i) * 7.3, pr); pr *= 2.; a *= .5; } return s / (1. - 2. * a); }
// long kozo fibres: a few gently curved strands per cell, drawn as soft lines
fn fibres(uv: vec2f, per: f32) -> f32 {
  let p = uv * per; let i = floor(p); var a = 0.;
  for (var x = -1; x <= 1; x++) { for (var y = -1; y <= 1; y++) {
    let c = i + vec2f(f32(x), f32(y)); let cw = c - per * floor(c / per);
    for (var k = 0; k < 3; k++) {
      let r = vec3f(h21(cw * 1.3 + f32(k) * 9.1), h21(cw * 2.1 + f32(k) * 4.7), h21(cw * .7 + f32(k) * 13.3));
      let o = c + r.xy; let an = r.z * 6.2831; let d = vec2f(cos(an), sin(an));
      let q = p - o; let along = clamp(dot(q, d), -1.1, 1.1);
      let bend = .18 * (r.x - .5) * along * along;
      let perp = abs(dot(q, vec2f(-d.y, d.x)) - bend);
      a += (1. - ss(.0, .035 + .02 * r.y, perp)) * ss(1.1, .6, abs(along)) * (.5 + .5 * r.y);
    }
  } }
  return a;
}
@fragment fn fs(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let uv = fc.xy / 1024.;
  let f = min(fibres(uv, 9.) * .7 + fibres(uv + .37, 23.) * .45, 1.);
  let gr = tf(uv, 96., 3) * .6 + h21(floor(fc.xy)) * .4;
  let m = tf(uv, 4., 5);
  return vec4f(f, gr, m, 1.);
}
`;

// blit / mip / bloom chain
const W_BLIT =
  W_FS +
  /*wgsl*/ `
@group(0) @binding(0) var t: texture_2d<f32>;
@group(0) @binding(1) var s: sampler;
fn uvOf(fc: vec4f, k: f32) -> vec2f { return fc.xy * k / vec2f(textureDimensions(t)); }
@fragment fn fsMip(@builtin(position) fc: vec4f) -> @location(0) vec4f { return textureSampleLevel(t, s, uvOf(fc, 2.), 0.); }
fn kar(c: vec3f) -> vec4f { let w = 1. / (1. + max(c.r, max(c.g, c.b))); return vec4f(c * w, w); }
@fragment fn fsDown0(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let uv = uvOf(fc, 2.); let e = 1. / vec2f(textureDimensions(t));
  let a = kar(min(textureSampleLevel(t, s, uv + e * vec2f(-1., -1.), 0.).rgb, vec3f(24.)));
  let b = kar(min(textureSampleLevel(t, s, uv + e * vec2f(1., -1.), 0.).rgb, vec3f(24.)));
  let c = kar(min(textureSampleLevel(t, s, uv + e * vec2f(-1., 1.), 0.).rgb, vec3f(24.)));
  let d = kar(min(textureSampleLevel(t, s, uv + e * vec2f(1., 1.), 0.).rgb, vec3f(24.)));
  let m = a + b + c + d;
  return vec4f(max(m.rgb / m.a - vec3f(2.4), vec3f(0.)), 1.);
}
@fragment fn fsDown(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let uv = uvOf(fc, 2.); let e = 1. / vec2f(textureDimensions(t));
  return (textureSampleLevel(t, s, uv + e * vec2f(-1., -1.), 0.) + textureSampleLevel(t, s, uv + e * vec2f(1., -1.), 0.)
        + textureSampleLevel(t, s, uv + e * vec2f(-1., 1.), 0.) + textureSampleLevel(t, s, uv + e * vec2f(1., 1.), 0.)) * .25;
}
@fragment fn fsUp(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let uv = uvOf(fc, .5); let e = .75 / vec2f(textureDimensions(t));
  return (textureSampleLevel(t, s, uv + e * vec2f(-1., -1.), 0.) + textureSampleLevel(t, s, uv + e * vec2f(1., -1.), 0.)
        + textureSampleLevel(t, s, uv + e * vec2f(-1., 1.), 0.) + textureSampleLevel(t, s, uv + e * vec2f(1., 1.), 0.)) * .25;
}
`;

// ---------------------------------------------------------------- terrain shadow heights (render pass, a band of rows per frame)
// Per height sample: how far above its own sheet the shadow of higher sheets reaches, toward the key light (-2: lit)
const W_SHH =
  W_FS +
  /*wgsl*/ `
struct SU { d: vec4f };
@group(0) @binding(0) var<uniform> su: SU;
@group(0) @binding(1) var tH: texture_2d<f32>;
const N = ${GN}; const L = ${LAYER}.; const MAXH = 250.;
fn hq(p: vec2f) -> f32 {
  let i = clamp(vec2i(floor(p)), vec2i(0), vec2i(N - 2)); let f = clamp(p - vec2f(i), vec2f(0.), vec2f(1.));
  let a = textureLoad(tH, i, 0).r; let b = textureLoad(tH, i + vec2i(1, 0), 0).r;
  let c = textureLoad(tH, i + vec2i(0, 1), 0).r; let d = textureLoad(tH, i + vec2i(1, 1), 0).r;
  return floor(mix(mix(a, b, f.x), mix(c, d, f.x), f.y) / L) * L;
}
@fragment fn fs(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let p0 = fc.xy - .5;
  let h0 = hq(p0);
  let rise = su.d.z;
  var s = -2.; var t = .7;
  for (var i = 0; i < 200; i++) {
    let q = p0 + su.d.xy * t;
    if (q.x < 0. || q.y < 0. || q.x > f32(N - 1) || q.y > f32(N - 1) || MAXH - h0 - t * rise < s) { break; }
    s = max(s, hq(q) - h0 - t * rise);
    t += max(.7, t * .03);
  }
  return vec4f(s, 0., 0., 1.);
}
`;

// ---------------------------------------------------------------- shared scene code
const S_G = /*wgsl*/ `
struct G { vp: mat4x4f, sm: mat4x4f, cam: vec4f, right: vec4f, up: vec4f, fwd: vec4f, key: vec4f, keyc: vec4f, sun: vec4f, moon: vec4f,
  zen: vec4f, hor: vec4f, ambs: vec4f, ambg: vec4f, res: vec4f, pr: vec4f, pu: vec4f, pf: vec4f, pp: vec4f, mis: vec4f };
const TAU = 6.2831853;
const L = ${LAYER}.;
const WL = ${WL};
fn sat(x: f32) -> f32 { return clamp(x, 0., 1.); }
fn ss(a: f32, b: f32, x: f32) -> f32 { let t = clamp((x - a) / (b - a), 0., 1.); return t * t * (3. - 2. * t); }
fn ign(p: vec2f) -> f32 { return fract(52.9829189 * fract(dot(p, vec2f(.06711056, .00583715)))); }
fn h21(p: vec2f) -> f32 { var q = fract(vec3f(p.xyx) * .1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
fn fin(c: vec3f) -> vec4f { return vec4f(min(max(c, vec3f(0.)), vec3f(60.)), 1.); }
// the sky: a gradient of overlapping paper strips with gently torn edges, glowing around the sun and the moon
fn skyc(rd: vec3f, g: G) -> vec3f {
  let e = max(rd.y, 0.);
  let t = pow(1. - e, 2.4);
  let az = atan2(rd.z, rd.x);
  let w = .16 * sin(az * 3. + 1.3) + .06 * sin(az * 7. + g.cam.w * .01) + .025 * sin(az * 23. + 2.);
  let bq = t * 6. + w;
  let fr = fract(bq);
  let tq = clamp((floor(bq) + ss(.42, .58, fr) - w) / 6., 0., 1.);
  var c = mix(g.zen.rgb, g.hor.rgb, tq);
  c *= 1. - .045 * ss(.58, .64, fr) * ss(.95, .7, fr) * (1. - t * .6);
  let ms = max(dot(rd, g.sun.xyz), 0.);
  c += vec3f(1., .6, .34) * (pow(ms, 5.) * .32 + pow(ms, 48.) * .55) * g.sun.w * (1. - g.keyc.w);
  let mm = max(dot(rd, g.moon.xyz), 0.);
  c += vec3f(.35, .45, .8) * (pow(mm, 8.) * .1 + pow(mm, 60.) * .3) * g.moon.w * g.keyc.w;
  if (rd.y < 0.) { c = mix(c, g.hor.rgb * .92, ss(0., -.08, rd.y)); }
  return c;
}
// distance haze toward the horizon colour, thicker low over the sea
fn hazeAmt(wp: vec3f, g: G) -> f32 {
  let d = distance(wp, g.cam.xyz);
  let y0 = max(g.cam.y, 0.); let y1 = max(wp.y, 0.); let H = 220.;
  let dy = y1 - y0;
  var k = exp(-y0 / H);
  if (abs(dy) > 1.) { k = H * (exp(-y0 / H) - exp(-y1 / H)) / dy; }
  return 1. - exp(-d * k / 3600.);
}
fn haze(c: vec3f, wp: vec3f, g: G) -> vec3f {
  let rd = normalize(wp - g.cam.xyz);
  return mix(c, skyc(normalize(vec3f(rd.x, .0, rd.z)), g), hazeAmt(wp, g));
}
`;

const S_B =
  S_G +
  /*wgsl*/ `
@group(0) @binding(0) var<uniform> g: G;
@group(0) @binding(1) var sR: sampler;
@group(0) @binding(2) var sC: sampler;
@group(0) @binding(3) var sS: sampler_comparison;
@group(0) @binding(4) var tSh: texture_depth_2d;
@group(0) @binding(5) var tH: texture_2d<f32>;
@group(0) @binding(6) var tS: texture_2d<f32>;
@group(0) @binding(7) var tD: texture_2d<f32>;
@group(0) @binding(8) var tM: texture_2d<f32>;
const GN = ${GN}; const GS = ${GS}; const WO = ${WO}.; const WORLD = ${WORLD}.;
// height of the land (bilinear) and its gradient
fn hgrid(p: vec2f) -> vec3f {
  let u = (p - WO) / GS;
  let i = clamp(vec2i(floor(u)), vec2i(0), vec2i(GN - 2)); let f = clamp(u - vec2f(i), vec2f(0.), vec2f(1.));
  let a = textureLoad(tH, i, 0).r; let b = textureLoad(tH, i + vec2i(1, 0), 0).r;
  let c = textureLoad(tH, i + vec2i(0, 1), 0).r; let d = textureLoad(tH, i + vec2i(1, 1), 0).r;
  return vec3f(mix(mix(a, b, f.x), mix(c, d, f.x), f.y), mix(b - a, d - c, f.y) / GS, mix(c - a, d - b, f.x) / GS);
}
fn sheetY(h: f32) -> f32 { return max(floor(h / L) * L, WL); }
// shadow of the land: rel = height of the point above the sheet it stands on
fn shLand(p: vec2f, rel: f32) -> f32 {
  let s = textureSampleLevel(tS, sC, ((p - WO) / GS + .5) / f32(GN), 0.).r;
  return ss(-.35, .35, rel - s);
}
// shadow of the props and the plane, from the light map that follows the plane
fn shNear(p: vec3f) -> f32 {
  let s = g.sm * vec4f(p, 1.);
  let uv = vec2f(s.x * .5 + .5, .5 - s.y * .5);
  let fade = ss(.5, .44, max(abs(uv.x - .5), abs(uv.y - .5)));
  if (fade <= 0.) { return 1.; }
  let e = 1. / ${NEARSH}.; let z = s.z - .0004;
  let v = (textureSampleCompareLevel(tSh, sS, uv + vec2f(-e, -e) * .7, z) + textureSampleCompareLevel(tSh, sS, uv + vec2f(e, -e) * .7, z)
         + textureSampleCompareLevel(tSh, sS, uv + vec2f(-e, e) * .7, z) + textureSampleCompareLevel(tSh, sS, uv + vec2f(e, e) * .7, z)) * .25;
  return mix(1., v, fade);
}
// paper: fibres, grain and soft mottling, projected along the face's main axis
fn paperUV(wp: vec3f, n: vec3f) -> vec2f {
  let a = abs(n);
  if (a.y > a.x && a.y > a.z) { return wp.xz; }
  if (a.x > a.z) { return wp.zy; }
  return wp.xy;
}
fn paper(wp: vec3f, n: vec3f, sc: f32) -> f32 {
  let uv = paperUV(wp, n);
  let d = distance(wp, g.cam.xyz);
  let a = textureSample(tD, sR, uv * sc);
  let b = textureSample(tD, sR, uv * sc * .083 + .31);
  let near = ss(90., 20., d * sc);
  return 1. + ((a.r - .3) * .1 + (a.g - .5) * .08) * near + (b.b - .5) * .12;
}
// soft matte paper: wrapped diffuse from the key light, light through thin sheets, sky and ground fill
fn shade(base: vec3f, n: vec3f, sh: f32, ao: f32, thin: f32) -> vec3f {
  let ndl = dot(n, g.key.xyz);
  let diff = max((ndl + .3) / 1.3, 0.) * sh;
  let back = max(-ndl, 0.) * thin * sh * .5;
  let amb = mix(g.ambg.rgb, g.ambs.rgb, n.y * .5 + .5) * ao;
  return base * (g.keyc.rgb * g.key.w * (diff + back) + amb);
}
fn faceN(wp: vec3f) -> vec3f {
  var n = normalize(cross(dpdx(wp), dpdy(wp)));
  if (dot(n, g.cam.xyz - wp) < 0.) { n = -n; }
  return n;
}
fn lin(c: vec3f) -> vec3f { return pow(c, vec3f(2.2)); }
`;

// ---------------------------------------------------------------- sky (behind everything)
const W_SKY =
  S_B +
  /*wgsl*/ `
struct SO { @builtin(position) cp: vec4f, @location(0) ndc: vec2f };
@vertex fn vs(@builtin(vertex_index) i: u32) -> SO {
  let p = vec2f(f32(i32(i & 1u) * 4 - 1), f32(i32(i >> 1u) * 4 - 1));
  return SO(vec4f(p, 0., 1.), p);
}
// little folded stars: five points, one side of each point lighter than the other
fn stars(rd: vec3f) -> vec3f {
  let el = asin(clamp(rd.y, -1., 1.)); let az = atan2(rd.z, rd.x);
  let sc = 38.; let p = vec2f(az * sc * cos(el), el * sc);
  var c = vec3f(0.);
  let i = floor(p);
  for (var x = -1; x <= 1; x++) { for (var y = -1; y <= 1; y++) {
    let cc = i + vec2f(f32(x), f32(y));
    let r = h21(cc + 17.); if (r > .17) { continue; }
    let o = cc + vec2f(h21(cc), h21(cc + 5.1)) * .8 + .1;
    let sz = h21(cc + 2.2); let q = (p - o) / (.07 + .26 * sz * sz);
    let a = atan2(q.y, q.x) + h21(cc + 9.) * 6.28; let rr = length(q);
    let k = cos(a * 5.) * .5 + .5;
    let edge = mix(.42, 1., pow(k, 3.));
    let m = 1. - ss(edge - .08, edge + .02, rr);
    let side = select(.75, 1., sin(a * 5.) > 0.);
    let tw = .75 + .25 * sin(g.cam.w * (.6 + h21(cc + 3.) * 1.2) + r * 40.);
    c += vec3f(1., .9, .66) * m * side * tw * (.6 + 1.2 * h21(cc + 1.));
  } }
  return c;
}
@fragment fn fs(i: SO) -> @location(0) vec4f {
  let rd = normalize(g.fwd.xyz + g.right.xyz * i.ndc.x * g.right.w + g.up.xyz * i.ndc.y * g.up.w);
  var c = skyc(rd, g);
  c *= .97 + .06 * (textureSample(tD, sR, vec2f(atan2(rd.z, rd.x) * 1.3, rd.y * 2.) * 2.).b - .5);
  if (rd.y > 0.) { c += stars(rd) * ss(-.07, -.24, g.ambs.w) * ss(0., .15, rd.y) * .9; }
  return fin(c);
}
`;

// ---------------------------------------------------------------- origami sun and moon, far out along their directions
const W_ORB =
  S_B +
  /*wgsl*/ `
struct OO { @builtin(position) cp: vec4f, @location(0) wp: vec3f, @location(1) @interpolate(flat) part: u32, @location(2) dir: vec3f };
@vertex fn vs(@location(0) p: vec3f, @location(1) a: vec4u) -> OO {
  let moon = a.x >= 8u;
  let d = select(g.sun.xyz, g.moon.xyz, moon);
  let vis = select(g.sun.w, g.moon.w, moon);
  let r = normalize(cross(d, vec3f(0., 1., 0.))); let u = cross(r, d);
  let D = 6000.; let R = D * select(.062, .05, moon) * step(.001, vis);
  let wp = g.cam.xyz + d * D + (r * p.x + u * p.y - d * p.z) * R;
  return OO(g.vp * vec4f(wp, 1.), wp, a.x, d);
}
@fragment fn fs(i: OO) -> @location(0) vec4f {
  let n = faceN(i.wp);
  let r = normalize(cross(i.dir, vec3f(0., 1., 0.))); let u = cross(r, i.dir);
  let lit = .72 + .4 * sat(dot(n, normalize(u * .7 - r * .5 - i.dir * .5)));
  var c: vec3f;
  switch (i.part) {
    case 0u: { c = vec3f(3.4, 1.65, .5); }
    case 1u: { c = vec3f(3.6, 2.2, .7); }
    case 2u: { c = vec3f(3.2, 1.2, .42); }
    case 8u: { c = vec3f(1.5, 1.45, 1.25); }
    default: { c = vec3f(1.25, 1.18, 1.); }
  }
  c *= lit;
  if (i.part < 8u) { c *= mix(vec3f(1.), vec3f(1.15, .72, .5), ss(.3, 0., i.dir.y)); }
  c = mix(c, skyc(normalize(vec3f(i.dir.x, 0., i.dir.z)), g), ss(.12, -.06, i.dir.y) * .45);
  return fin(c);
}
`;

// ---------------------------------------------------------------- land: stacked sheets of paper
const W_TERR =
  S_B +
  /*wgsl*/ `
struct TO { @builtin(position) cp: vec4f, @location(0) wp: vec3f, @location(1) n: vec4f };
@vertex fn vs(@location(0) p: vec3f, @location(1) n: vec4f) -> TO { return TO(g.vp * vec4f(p, 1.), p, n); }
// paper colours by height: deep sea indigo, aqua shallows, sand, greens, stone, snow (sRGB)
fn layerCol(y: f32) -> vec3f {
  var P = array<vec4f, 12>(vec4f(-44., .15, .25, .42), vec4f(-24., .2, .4, .55), vec4f(-10., .36, .6, .66), vec4f(-4., .55, .76, .72),
    vec4f(0., .91, .85, .69), vec4f(4., .75, .82, .55), vec4f(16., .58, .74, .45), vec4f(40., .42, .62, .4), vec4f(80., .45, .55, .41),
    vec4f(124., .6, .6, .54), vec4f(158., .74, .75, .74), vec4f(176., .96, .97, .98));
  var c = P[0].yzw;
  for (var i = 1; i < 12; i++) { let a = P[i - 1]; let b = P[i]; if (y > a.x) { c = mix(a.yzw, b.yzw, sat((y - a.x) / (b.x - a.x))); } }
  return c;
}
// the karst pillars keep to misty jade greens all the way up
fn karst(p: vec2f) -> f32 { return ss(420., 260., length((p - vec2f(${KARST[0]}, ${KARST[1]})) * vec2f(1., 1.2))); }
fn jade(y: f32) -> vec3f { return mix(vec3f(.4, .62, .46), vec3f(.5, .68, .56), ss(10., 150., y)); }
@fragment fn fs(i: TO) -> @location(0) vec4f {
  let top = i.n.y > .5;
  let v = i.n.w;
  var k = round(i.wp.y / L);
  if (!top) { k = round((i.wp.y - v * L) / L) + 1.; }
  let y = k * L;
  let hg = hgrid(i.wp.xz);
  let gl = max(length(hg.yz), .015);
  // each sheet its own shade, alternating slightly so neighbouring sheets read apart
  let jit = h21(vec2f(k, 3.7));
  var base = mix(layerCol(y), jade(y), karst(i.wp.xz) * ss(2., 8., y)) * (1. + .025 * (jit - .5) + .02 * select(-1., 1., (i32(k) & 1) == 0));
  let reg = vn2(i.wp.xz * .0016);
  base *= mix(vec3f(1.04, 1.02, .9), vec3f(.95, 1., 1.05), reg) ;
  let gm = textureSampleLevel(tM, sC, (i.wp.xz - WO) / WORLD, 0.);
  base = mix(base, base * vec3f(.82, .9, .84), gm.g * ss(2., 6., y));
  base = mix(base, vec3f(.96, .8, .84), gm.b * .35 * ss(2., 6., y));
  var n = i.n.xyz;
  var ao = 1.; var sh = 1.;
  if (top) {
    let up = ((k + 1.) * L - hg.x) / gl;
    ao = mix(.5, 1., ss(0., 4.5, up)) * mix(.88, 1., ss(0., 1.2, up));
    let own = (hg.x - y) / gl;
    base *= 1. + .07 * ss(.45, .0, own);
    sh = shLand(i.wp.xz, 0.);
  } else {
    // the cut edge: shaded along the sheet's smooth outline rather than per segment
    let e = GS * 1.2;
    let gx = hgrid(i.wp.xz + vec2f(e, 0.)).x - hgrid(i.wp.xz - vec2f(e, 0.)).x;
    let gz = hgrid(i.wp.xz + vec2f(0., e)).x - hgrid(i.wp.xz - vec2f(0., e)).x;
    let sn = normalize(vec3f(-gx, 0., -gz) + n * .05);
    if (dot(sn, n) > .2) { n = sn; }
    base = mix(base, vec3f(.97, .95, .9), .16);
    base *= mix(.62, 1., ss(.0, .16, v)) * (1. + .22 * ss(.9, .97, v));
    ao = .9;
    sh = shLand(i.wp.xz + n.xz * GS * .6, i.wp.y - y + L);
  }
  ao *= 1. - gm.r * .5;
  sh *= shNear(i.wp + n * .05);
  var c = shade(lin(base) * paper(i.wp, n, .4), n, sh, ao, 0.);
  return fin(haze(c, i.wp, g));
}
fn vn2(p: vec2f) -> f32 {
  let i = floor(p); let f = fract(p); let u = f * f * (3. - 2. * f);
  return mix(mix(h21(i), h21(i + vec2f(1., 0.)), u.x), mix(h21(i + vec2f(0., 1.)), h21(i + vec2f(1., 1.)), u.x), u.y);
}
`;

// ---------------------------------------------------------------- the sea: a sheet of tracing paper, gently folded into facets
const W_WATER =
  S_B +
  /*wgsl*/ `
struct WO_ { @builtin(position) cp: vec4f, @location(0) wp: vec3f };
@vertex fn vs(@builtin(vertex_index) i: u32) -> WO_ {
  let c = vec2f(f32(i & 1u), f32(i >> 1u)) * 2. - 1.;
  let wp = vec3f(g.cam.x + c.x * 9000., WL, g.cam.z + c.y * 9000.);
  return WO_(g.vp * vec4f(wp, 1.), wp);
}
fn wv(v: vec2f) -> f32 { let h = h21(v * 1.37 + 3.1); return .32 * sin(g.cam.w * (.5 + .35 * h) + h * TAU); }
fn wpos(v: vec2f, s: f32) -> vec3f { return vec3f((v.x + v.y * .5) * s, wv(v), v.y * .8660254 * s); }
fn facet(p: vec2f) -> vec3f {
  let s = 7.; let q = p / s;
  let b = q.y / .8660254; let a = q.x - b * .5;
  let ia = floor(a); let ib = floor(b);
  var v0 = vec2f(ia, ib); var v1 = vec2f(ia + 1., ib); var v2 = vec2f(ia, ib + 1.);
  if (a - ia + b - ib > 1.) { v0 = vec2f(ia + 1., ib + 1.); v1 = vec2f(ia, ib + 1.); v2 = vec2f(ia + 1., ib); }
  let p0 = wpos(v0, s); let n = normalize(cross(wpos(v2, s) - p0, wpos(v1, s) - p0));
  return select(n, -n, n.y < 0.);
}
@fragment fn fs(i: WO_) -> @location(0) vec4f {
  let hg = hgrid(i.wp.xz);
  let fl = floor(hg.x / L) * L;
  let depth = WL - fl;
  let d = distance(i.wp, g.cam.xyz);
  let v = normalize(g.cam.xyz - i.wp);
  let n = normalize(mix(facet(i.wp.xz), vec3f(0., 1., 0.), ss(140., 650., d)));
  let deep = ss(2., 30., depth);
  var col = lin(mix(vec3f(.62, .86, .84), vec3f(.16, .36, .52), deep));
  let sh = mix(.45, 1., shLand(i.wp.xz, depth) * shNear(i.wp));
  var c = shade(col, n, sh, 1., .4) * paper(i.wp, vec3f(0., 1., 0.), .25);
  let fr = .04 + .32 * pow(1. - sat(dot(n, v)), 4.);
  c = mix(c, skyc(reflect(-v, n), g), fr);
  // a soft sheen that drifts across the facets as they slowly tilt
  let hv = normalize(g.key.xyz + v);
  c += g.keyc.rgb * g.key.w * (pow(max(dot(n, hv), 0.), 60.) * .16 + pow(max(dot(n, hv), 0.), 8.) * .03) * sh;
  var a = mix(.42, .95, ss(1., 26., depth));
  // shore: a strip of white paper that slowly breathes in and out
  let dsh = -hg.x / max(length(hg.yz), .02);
  let wob = .5 + .5 * sin(g.cam.w * .6 + i.wp.x * .045 + i.wp.z * .037);
  let foam = (1. - ss(.7, 1.1, dsh / (1.2 + 1.3 * wob) + .25 * (h21(floor(i.wp.xz * 2.)) - .5))) * ss(-8., -1., hg.x);
  c = mix(c, shade(vec3f(.93, .93, .9), vec3f(0., 1., 0.), sh, 1., 0.), foam * .9);
  a = max(a, foam * .95);
  c = haze(c, i.wp, g);
  a = mix(a, 1., hazeAmt(i.wp, g));
  return vec4f(min(c, vec3f(60.)) * a, a);
}
`;

// ---------------------------------------------------------------- folded props: trees, houses, boats, cranes, clouds, lanterns, the plane
// instance: a = position + scale (or path centre + radius), b = yaw, packed colour, seed, extra
const W_PROP =
  S_B +
  /*wgsl*/ `
override KIND = 0;
struct PI { @location(0) p: vec3f, @location(1) at: vec4u, @location(2) a: vec4f, @location(3) b: vec4f };
struct PO { @builtin(position) cp: vec4f, @location(0) wp: vec3f, @location(1) @interpolate(flat) part: u32, @location(2) shade: f32,
  @location(3) col: vec3f, @location(4) lp: vec3f, @location(5) @interpolate(flat) glow: f32 };
fn rotY(p: vec3f, a: f32) -> vec3f { let c = cos(a); let s = sin(a); return vec3f(p.x * c + p.z * s, p.y, -p.x * s + p.z * c); }
fn unpack(c: f32) -> vec3f { let u = u32(c); return vec3f(f32((u >> 16u) & 255u), f32((u >> 8u) & 255u), f32(u & 255u)) / 255.; }
fn place(i: PI) -> vec3f {
  let t = g.cam.w; var p = i.p; let a = i.a; let b = i.b;
  if (KIND == 0) {
    if (i.at.x == 1u) { let sw = p.y * p.y * .004 * b.w; p.x += sin(t * .9 + b.z * 30.) * sw; p.z += sin(t * .7 + b.z * 17.) * sw * .6; }
    return a.xyz + rotY(p * a.w, b.x);
  }
  if (KIND == 1) {
    let sz = 2. + b.z * .7;
    let span = f32(i.at.z) / 127.5 - 1.;
    p.y += sin(t * 3.1 + b.z * 40.) * abs(span) * abs(span) * .55 - .08 * abs(span);
    let th = b.x + t * b.w / a.w;
    let bob = sin(t * .4 + b.z * 9.) * 3.;
    let c = vec3f(a.x + cos(th) * a.w, a.y + bob, a.z + sin(th) * a.w);
    let f = normalize(vec3f(-sin(th), .04 * cos(t * .4 + b.z * 9.), cos(th)) * sign(b.w));
    let r = normalize(cross(vec3f(0., 1., 0.), f)); let u = cross(f, r);
    let bank = -.25 * sign(b.w);
    let rr = r * cos(bank) + u * sin(bank); let uu = u * cos(bank) - r * sin(bank);
    return c + (rr * p.x + uu * p.y + f * p.z) * sz;
  }
  if (KIND == 2) {
    let dr = vec2f(cos(t * .015 + b.z * 6.3), sin(t * .015 + b.z * 6.3)) * b.w;
    var q = rotY(p * a.w, b.x + sin(t * .3 + b.z * 5.) * .15);
    q.y += q.x * sin(t * .9 + b.z * 7.) * .05 + q.z * sin(t * .7 + b.z * 3.) * .04;
    return vec3f(a.x + dr.x, WL + sin(t * 1.1 + b.z * 20.) * .12, a.z + dr.y) + q;
  }
  if (KIND == 3) {
    var x = a.x + t * b.w; x = x - 3600. * floor((x + 1800.) / 3600.);
    return vec3f(x, a.y, a.z) + rotY(p * a.w, b.x);
  }
  if (KIND == 4) {
    let rise = fract(t * b.w / 140. + b.z);
    let y = a.y + select(sin(t + b.z * 9.) * .1, rise * 140., b.w > 0.);
    let s = a.w * ss(.0, .25, g.hor.w) * select(1., ss(1., .85, rise) * ss(0., .04, rise), b.w > 0.);
    let sw = vec3f(sin(t * .3 + b.z * 6.), 0., cos(t * .23 + b.z * 4.)) * rise * 6.;
    return vec3f(a.x, y, a.z) + sw + rotY(p * s, b.x + t * .1);
  }
  // KIND 5: the plane, wing tips flexing with the load
  let ax = abs(p.x);
  p.y += g.pr.w * ax * ax * .5 + g.pu.w * sin(g.cam.w * 23. + p.x * 3.) * ax * .02;
  let s = g.pf.w;
  return g.pp.xyz + (g.pu.xyz * p.y + g.pf.xyz * p.z - g.pr.xyz * p.x) * s;
}
@vertex fn vs(i: PI) -> PO {
  let wp = place(i);
  var col = unpack(i.b.y);
  return PO(g.vp * vec4f(wp, 1.), wp, i.at.x, f32(i.at.y) / 255., col, i.p, select(0., 1., KIND == 4));
}
@vertex fn vsSh(i: PI) -> @builtin(position) vec4f { return g.sm * vec4f(place(i), 1.); }
// seigaiha: rows of overlapping circles of concentric arcs, each row drawn over the one before
fn seigaiha(p: vec2f) -> f32 {
  let j0 = i32(floor(p.y * 2.)) - 2;
  var best = -1.; var d = 9.;
  for (var j = j0; j <= j0 + 4; j++) {
    let o = f32(j & 1);
    let cy = f32(j) * .5;
    let cx = floor((p.x - o) * .5 + .5) * 2. + o;
    for (var k = -1; k <= 1; k++) {
      let e = length(p - vec2f(cx + f32(k) * 2., cy));
      if (e < 1. && f32(j) > best) { best = f32(j); d = e; }
    }
  }
  let v = abs(fract(d * 3.) - .5);
  return (1. - ss(.06, .13, v)) * step(.2, d);
}
@fragment fn fs(i: PO, @builtin(front_facing) ff: bool) -> @location(0) vec4f {
  let n = faceN(i.wp);
  var base: vec3f; var thin = .25; var emit = vec3f(0.);
  switch (i.part) {
    case 0u: { base = vec3f(.55, .42, .32); thin = 0.; }
    case 1u: { base = i.col; }
    case 2u: { base = vec3f(.95, .93, .88); thin = .1; }
    case 3u: {
      base = vec3f(.3, .28, .3);
      emit = lin(vec3f(1., .72, .4)) * 3.5 * g.hor.w;
    }
    case 4u: { base = vec3f(.24, .27, .31); thin = 0.; }
    case 5u: { base = vec3f(.72, .7, .66); thin = 0.; }
    case 6u: { base = i.col; emit = lin(i.col) * 7. * g.hor.w; thin = .6; }
    default: { base = i.col * .78; }
  }
  if (KIND == 5) {
    let pat = seigaiha(i.lp.xz * 3.2);
    base = select(vec3f(.97, .96, .92), mix(i.col, vec3f(1., .86, .72), pat * .32), ff);
    let ax = abs(i.lp.x);
    let crease = 1. - ss(.04, 0., ax) * .3 - ss(.025, 0., abs(ax - .2 * (1. - i.lp.z))) * .16;
    base *= crease * mix(.9, 1.06, ss(.1, .9, ax));
    thin = .7;
  }
  if (KIND == 3) {
    thin = .9;
    base *= 1. - .45 * g.keyc.w;
  }
  base = lin(base) * i.shade;
  let hg = hgrid(i.wp.xz);
  let rel = i.wp.y - sheetY(hg.x);
  var sh = shLand(i.wp.xz, rel);
  if (KIND != 3) { sh *= shNear(i.wp + n * .04); }
  var c = shade(base * paper(i.wp, n, select(.9, 2.2, KIND == 5)), n, sh, 1., thin) + emit;
  if (i.glow > 0.) { c = base * 5. * g.hor.w + c * .4; }
  return fin(haze(c, i.wp, g));
}
`;

// ---------------------------------------------------------------- final composite
const W_POST =
  S_G +
  W_FS +
  /*wgsl*/ `
@group(0) @binding(0) var<uniform> g: G;
@group(0) @binding(1) var sC: sampler;
@group(0) @binding(2) var tS: texture_2d<f32>;
@group(0) @binding(3) var tB: texture_2d<f32>;
fn tmap(x: vec3f) -> vec3f { return clamp((x * (2.51 * x + .03)) / (x * (2.43 * x + .59) + .14), vec3f(0.), vec3f(1.)); }
@fragment fn fs(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let px = vec2i(fc.xy);
  let uv = fc.xy * g.res.zw;
  var c = textureLoad(tS, px, 0).rgb;
  let bl = textureSampleLevel(tB, sC, uv, 0.).rgb;
  c += bl * .5;
  c *= g.zen.w;
  let q = uv - .5;
  c *= 1. - dot(q, q) * .4;
  c = tmap(c);
  let l = dot(c, vec3f(.2126, .7152, .0722));
  c = mix(c, l * vec3f(.8, .9, 1.12), g.keyc.w * .4 * ss(.75, .35, l));
  c = pow(max(c, vec3f(0.)), vec3f(1. / 2.2));
  c = c * .985 + vec3f(.012, .01, .016);
  let n = ign(fc.xy) + ign(fc.xy + 37.) - 1.;
  return vec4f(c + n / 255., 1.);
}
`;
