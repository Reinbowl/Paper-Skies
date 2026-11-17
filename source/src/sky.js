// ============================================================================
// time of day: the origami sun crosses the sky, sets, and the origami moon rises opposite it
// ============================================================================
const CYCLE = 640; // seconds of day for one turn of the sun at the daytime pace (nights pass faster)
const TILT = 0.5; // the sun's path leans this far from straight overhead
// sky keyframes by the height of the sun (y of its direction):
// sun y, zenith rgb, horizon rgb, ambient from the sky rgb, ambient from the ground rgb
const SKYK = new Float32Array([
  -0.4, 0.016, 0.024, 0.062, 0.06, 0.075, 0.15, 0.045, 0.06, 0.12, 0.016, 0.018, 0.03, -0.14, 0.035, 0.05, 0.13, 0.2, 0.17, 0.3, 0.09, 0.1,
  0.2, 0.03, 0.03, 0.05, -0.03, 0.13, 0.15, 0.33, 0.85, 0.46, 0.4, 0.28, 0.24, 0.32, 0.12, 0.08, 0.08, 0.06, 0.3, 0.4, 0.68, 1.15, 0.7,
  0.46, 0.5, 0.46, 0.5, 0.26, 0.18, 0.12, 0.25, 0.25, 0.48, 0.86, 1.0, 0.84, 0.68, 0.6, 0.66, 0.78, 0.32, 0.27, 0.2, 0.75, 0.2, 0.45, 0.88,
  0.88, 0.88, 0.84, 0.62, 0.72, 0.9, 0.34, 0.31, 0.24,
]);
const SKYN = SKYK.length / 13;
// this frame's light: sun, moon, key light (whichever of the two is up), sky and ambient colours
const DAY = new Float64Array(36);
const D_SUN = 0;
const D_MOON = 4;
const D_KEY = 8;
const D_KEYC = 12;
const D_NIGHT = 15;
const D_ZEN = 16;
const D_HOR = 19;
const D_AMBS = 22;
const D_AMBG = 25;
const D_LANT = 28;
const D_EXPO = 29;
const D_SY = 30;

// direction of a body at angle a along the tilted path, lifted so days are longer than nights; into DAY[o..o+2]
function orbit(a, o) {
  let x = cos(a);
  let y = sin(a) * cos(TILT) + 0.2;
  let z = sin(a) * sin(TILT);
  const l = sqrt(x * x + y * y + z * z);
  x /= l;
  y /= l;
  z /= l;
  DAY[o] = x;
  DAY[o + 1] = y;
  DAY[o + 2] = z;
  DAY[o + 3] = sstep(-0.12, 0.02, y); // visible above the horizon (the far sea hides it as it sets)
}
// how fast the day moves at sun angle a: nights go by quicker
const dayRate = (a) => 1 + 1.6 * sstep(-0.05, -0.3, sin(a) * cos(TILT) + 0.2);

function daylight(a) {
  orbit(a, D_SUN);
  orbit(a + PI, D_MOON);
  const s = DAY[D_SUN + 1];
  // sky keyframes
  let k = 0;
  while (k < SKYN - 2 && s > SKYK[(k + 1) * 13]) k++;
  let t = clamp((s - SKYK[k * 13]) / (SKYK[(k + 1) * 13] - SKYK[k * 13]), 0, 1);
  t = t * t * (3 - 2 * t);
  for (let j = 0; j < 12; j++) DAY[D_ZEN + j] = mix(SKYK[k * 13 + 1 + j], SKYK[(k + 1) * 13 + 1 + j], t);
  // key light: the sun by day, the moon by night, switched while both are dark
  const sunI = 2 * sstep(-0.03, 0.1, s);
  const moonI = 0.42 * sstep(0.03, 0.16, -s);
  const o = sunI > 0 ? D_SUN : D_MOON;
  DAY[D_KEY] = DAY[o];
  DAY[D_KEY + 1] = DAY[o + 1];
  DAY[D_KEY + 2] = DAY[o + 2];
  DAY[D_KEY + 3] = sunI + moonI;
  const w = sstep(0.02, 0.4, s); // warm low sun -> white high sun
  if (sunI > 0) {
    DAY[D_KEYC] = 1;
    DAY[D_KEYC + 1] = mix(0.58, 0.93, w);
    DAY[D_KEYC + 2] = mix(0.34, 0.82, w);
  } else {
    DAY[D_KEYC] = 0.6;
    DAY[D_KEYC + 1] = 0.72;
    DAY[D_KEYC + 2] = 1;
  }
  DAY[D_NIGHT] = sstep(0.02, -0.16, s);
  DAY[D_LANT] = sstep(0.07, -0.06, s);
  DAY[D_EXPO] = mix(0.78, 1.5, sstep(0, -0.3, s));
  DAY[D_SY] = s;
}
