// ============================================================================
// quality level, chosen before anything is built
// ============================================================================
// LV: 0 High, 1 Medium, 2 Low. Medium and Low keep every 2nd / 4th small prop; Low also drops anti-aliasing,
// builds the land from a coarser grid and uses smaller shadow maps.
// localStorage.paperskies = "level,pixels" (?lv=N in the address overrides it without saving). paperskiesLoad is set
// while the world is built: still set on the next visit means that load crashed the tab, so this one runs a level lower.
const mob = matchMedia('(pointer:coarse)').matches;
const mem = navigator.deviceMemory;
const keep = (k, v) => {
  try {
    localStorage[k] = v;
  } catch {}
};
let SV = [];
let LV;
let bad;
try {
  SV = (localStorage.paperskies || '').split(',');
  bad = localStorage.paperskiesLoad;
} catch {}
LV = SV[0] ? +SV[0] : mob ? (mem > 7 ? 1 : 2) : mem <= 4 ? 2 : 0;
if (bad && LV < 2) {
  SV = [++LV];
  keep('paperskies', LV);
}
// ?lv=0, 1 or 2 in the address forces a level for this visit only (handy for testing a phone's level on a computer)
const LVQ = new URLSearchParams(location.search).get('lv');
if (LVQ && /^[012]$/.test(LVQ)) {
  LV = +LVQ;
  SV = [];
}
const THIN = 1 << LV;
const AA = LV > 1 ? 1 : 4;
const NEARSH = LV > 1 ? 1024 : 2048;
const GN = LV > 1 ? 1024 : 2048; // height grid samples per side
