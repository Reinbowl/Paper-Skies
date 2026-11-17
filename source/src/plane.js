// ============================================================================
// the paper plane: flight model (fixed steps, shared by both modes), autopilot and the chase camera
// ============================================================================
// Roll positive = right wing down. Forward is (sin yaw * cos pitch, sin pitch, cos yaw * cos pitch), so turning right
// lowers the yaw.
const DT = 1 / 120;
const FS = new Float64Array(64);
const PX = 0;
const PY = 1;
const PZ = 2;
const YAW = 3;
const PIT = 4;
const ROL = 5;
const SPD = 6;
const QX = 7; // previous step, for smooth frames between steps
const QY = 8;
const QZ = 9;
const QYAW = 10;
const QPIT = 11;
const QROL = 12;
const LOAD = 13;
const GX = 14; // autopilot goal
const GZ = 15;
const GT = 16;
const SIMT = 17;
const ACC = 18;
const STX = 19; // the virtual stick that the mouse pushes around
const STY = 20;
const KT = 21; // smoothed keys
const KP = 22;
const BOOST = 23;
// interpolated pose and the camera
const IX = 24;
const IY = 25;
const IZ = 26;
const IYAW = 27;
const IPIT = 28;
const IROL = 29;
const CX = 30;
const CY = 31;
const CZ = 32;
const CYAW = 33;
const CPIT = 34;
const CROL = 35;
const COFF = 36;
const CT = 37;
const FX = 38; // camera basis: forward, right, up
const FY = 39;
const FZ = 40;
const RX = 41;
const RY = 42;
const RZ = 43;
const UX = 44;
const UY = 45;
const UZ = 46;
const AGL = 47;
const CDIST = 48;
let apSeed = 1;
const apRnd = () => {
  apSeed = (apSeed + 0x6d2b79f5) | 0;
  let t = Math.imul(apSeed ^ (apSeed >>> 15), 1 | apSeed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
let POIS = [];

// highest ground along the heading, `secs` seconds ahead, including a wingspan or two to either side
function groundAhead(secs) {
  const fx = sin(FS[YAW]);
  const fz = cos(FS[YAW]);
  const v = FS[SPD];
  let g = groundAt(FS[PX], FS[PZ]);
  for (let k = 0; k <= 8; k++) {
    const d = (k / 8) * secs * v;
    for (let s = -1; s <= 1; s++) {
      const h = groundAt(FS[PX] + fx * d + fz * s * 7, FS[PZ] + fz * d - fx * s * 7);
      if (h > g) g = h;
    }
  }
  return g;
}

function placePlane(x, y, z, yaw) {
  FS[PX] = FS[QX] = x;
  FS[PY] = FS[QY] = y;
  FS[PZ] = FS[QZ] = z;
  FS[YAW] = FS[QYAW] = yaw;
  FS[PIT] = FS[QPIT] = FS[ROL] = FS[QROL] = 0;
  FS[SPD] = 21;
  FS[CYAW] = yaw;
  FS[CPIT] = -0.12;
  FS[CX] = x - sin(yaw) * 13;
  FS[CY] = y + 3;
  FS[CZ] = z - cos(yaw) * 13;
  FS[GT] = 0;
}

function pickGoal() {
  const n = POIS.length;
  let x = 0;
  let z = 0;
  for (let k = 0; k < 6; k++) {
    const p = POIS[(apRnd() * n) | 0];
    x = p[0] + (apRnd() - 0.5) * 300;
    z = p[1] + (apRnd() - 0.5) * 300;
    if (hypot(x - FS[PX], z - FS[PZ]) > 350) break;
  }
  FS[GX] = x;
  FS[GZ] = z;
  FS[GT] = 45 + apRnd() * 45;
}

// one fixed step; turn and pitch in [-1, 1] (right, nose up), boost 0..1
function stepPlane(turn, pitch, boost) {
  FS[QX] = FS[PX];
  FS[QY] = FS[PY];
  FS[QZ] = FS[PZ];
  FS[QYAW] = FS[YAW];
  FS[QPIT] = FS[PIT];
  FS[QROL] = FS[ROL];
  FS[SIMT] += DT;
  const v = FS[SPD];
  // rising sheets ahead lift the plane over them, so it never meets a cut edge head on
  const need = groundAhead(2.4) + 10 - FS[PY];
  let pt = pitch * 0.55;
  if (need > 0) pt = max(pt, min(need * 0.07, 0.65));
  if (FS[PY] > 360) pt = min(pt, -(FS[PY] - 360) * 0.01);
  // past the islands a soft wind turns the plane for home
  const dist = hypot(FS[PX], FS[PZ]);
  if (dist > 1250) {
    const home = atan2(-FS[PX], -FS[PZ]);
    turn = clamp(turn - adiff(FS[YAW], home) * ((dist - 1250) / 140), -1, 1);
  }
  FS[ROL] += (turn * 0.78 - FS[ROL]) * (1 - exp(-DT * 2.2));
  const yr = (-9.8 * tan(FS[ROL]) * 0.85) / max(v, 8);
  FS[YAW] += yr * DT;
  const pr = (pt - FS[PIT]) * (1 - exp(-DT * 1.7));
  FS[PIT] += pr;
  FS[LOAD] += (abs(yr) * v * 0.06 + (pr / DT) * 0.5 + boost * 0.25 - FS[LOAD]) * (1 - exp(-DT * 4));
  FS[BOOST] += (boost - FS[BOOST]) * (1 - exp(-DT * 2));
  let a = -9.8 * sin(FS[PIT]) * 0.8 + (21 - v) * 0.3 + FS[BOOST] * 10;
  let nv = v + a * DT;
  nv = nv < 12 ? 12 : nv > 46 ? 46 : nv;
  FS[SPD] = nv;
  const cp = cos(FS[PIT]);
  FS[PX] += sin(FS[YAW]) * cp * nv * DT;
  FS[PY] += sin(FS[PIT]) * nv * DT;
  FS[PZ] += cos(FS[YAW]) * cp * nv * DT;
  const g = groundAt(FS[PX], FS[PZ]) + 3.5;
  if (FS[PY] < g) FS[PY] += (g - FS[PY]) * 0.35;
}

// the autopilot's hands on the controls: wander toward a point of interest, hold a drifting height above the land
let apTurn = 0;
let apPitch = 0;
function autopilot() {
  FS[GT] -= DT;
  if (FS[GT] <= 0 || hypot(FS[GX] - FS[PX], FS[GZ] - FS[PZ]) < 160) pickGoal();
  const t = FS[SIMT];
  const want = atan2(FS[GX] - FS[PX], FS[GZ] - FS[PZ]) + 0.9 * (vn1(t * 0.021) - 0.5);
  apTurn = -adiff(FS[YAW], want) * 1.3;
  // lean away from ground rising beside the plane
  const rx = -cos(FS[YAW]);
  const rz = sin(FS[YAW]);
  const fx = sin(FS[YAW]) * 20;
  const fz = cos(FS[YAW]) * 20;
  const gl = groundAt(FS[PX] + fx - rx * 30, FS[PZ] + fz - rz * 30);
  const gr = groundAt(FS[PX] + fx + rx * 30, FS[PZ] + fz + rz * 30);
  const wall = max(gl, gr) - (FS[PY] - 18);
  if (wall > 0) apTurn += clamp((gl - gr) / 25, -1, 1) * min(wall / 10, 1);
  apTurn = clamp(apTurn, -0.62, 0.62);
  FS[AGL] = 28 + 70 * pow(vn1(t * 0.009 + 4.2), 1.6) + 30 * clamp(slopeAt(FS[PX], FS[PZ]) - 0.3, 0, 1);
  const ty = max(groundAhead(4), WL) + FS[AGL];
  const vy = sin(FS[PIT]) * FS[SPD];
  apPitch = clamp((ty - FS[PY]) * 0.035 - vy * 0.09, -0.55, 0.65);
}

// the camera: follows the plane on a soft spring and always looks straight at it
function chase(dt, auto) {
  const a = FS[ACC] / DT;
  FS[IX] = FS[QX] + (FS[PX] - FS[QX]) * a;
  FS[IY] = FS[QY] + (FS[PY] - FS[QY]) * a;
  FS[IZ] = FS[QZ] + (FS[PZ] - FS[QZ]) * a;
  FS[IYAW] = FS[QYAW] + adiff(FS[QYAW], FS[YAW]) * a;
  FS[IPIT] = FS[QPIT] + (FS[PIT] - FS[QPIT]) * a;
  FS[IROL] = FS[QROL] + (FS[ROL] - FS[QROL]) * a;
  FS[CT] += dt;
  const t = FS[CT];
  const off = auto ? 0.5 * sin(t * 0.041) + 0.3 * sin(t * 0.017 + 1.3) : 0;
  FS[COFF] += (off - FS[COFF]) * (1 - exp(-dt * 0.4));
  const k = 1 - exp(-dt * 2.4);
  FS[CYAW] += adiff(FS[CYAW], FS[IYAW] + FS[COFF]) * k;
  const lift = auto ? 0.1 * sin(t * 0.033 + 0.6) : 0;
  FS[CPIT] += (FS[IPIT] * 0.45 - 0.13 - lift - FS[CPIT]) * k;
  FS[CROL] += (FS[IROL] * 0.22 - FS[CROL]) * (1 - exp(-dt * 3));
  const agl = FS[IY] - groundAt(FS[IX], FS[IZ]);
  FS[CDIST] +=
    (12.5 + (FS[SPD] - 21) * 0.18 + (auto ? 2 * sin(t * 0.027) : 0) + clamp((agl - 50) / 12, 0, 9) - FS[CDIST]) * (1 - exp(-dt * 1.5));
  const cp = cos(FS[CPIT]);
  const d = FS[CDIST];
  let x = FS[IX] - sin(FS[CYAW]) * cp * d;
  let y = FS[IY] - sin(FS[CPIT]) * d + 1.2;
  let z = FS[IZ] - cos(FS[CYAW]) * cp * d;
  const kp = 1 - exp(-dt * 9);
  x = FS[CX] + (x - FS[CX]) * kp;
  y = FS[CY] + (y - FS[CY]) * kp;
  z = FS[CZ] + (z - FS[CZ]) * kp;
  let gm = groundAt(x, z);
  for (let k2 = 0; k2 < 4; k2++) gm = max(gm, groundAt(x + ((k2 & 1) * 2 - 1) * 2, z + ((k2 >> 1) * 2 - 1) * 2));
  const floorY = gm + min(9, max(3, agl + 1));
  if (y < floorY) y = floorY;
  FS[CX] = x;
  FS[CY] = y;
  FS[CZ] = z;
  // basis: forward at the plane, right level with the ground, then rolled a little with the plane
  let fx = FS[IX] - x;
  let fy = FS[IY] - y;
  let fz = FS[IZ] - z;
  const l = sqrt(fx * fx + fy * fy + fz * fz);
  fx /= l;
  fy /= l;
  fz /= l;
  let rx = -fz;
  let rz = fx;
  const rl = sqrt(rx * rx + rz * rz) || 1;
  rx /= rl;
  rz /= rl;
  const ux = -rz * fy;
  const uy = rz * fx - rx * fz;
  const uz = rx * fy;
  const cr = cos(FS[CROL]);
  const sr = sin(FS[CROL]);
  FS[FX] = fx;
  FS[FY] = fy;
  FS[FZ] = fz;
  FS[RX] = rx * cr - ux * sr;
  FS[RY] = -uy * sr;
  FS[RZ] = rz * cr - uz * sr;
  FS[UX] = ux * cr + rx * sr;
  FS[UY] = uy * cr;
  FS[UZ] = uz * cr + rz * sr;
}
