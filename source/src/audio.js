// ============================================================================
// audio: the music, over a soft bed of wind, sea and birds
// ============================================================================
// A fixed Web Audio graph, built on the first click / key / touch and driven by a 10 Hz timer, not the frame loop.
// The music (source/music.m4a, embedded by the build) plays whole and loops: its own fade-out is laid over its
// opening, so it wraps around without a pause. The wind follows the airspeed, the sea is louder low over the water.
const MUSIC = '/*MUSIC*/';
let AC;
let OUT;
let MUS;
let muted = false;
const VOL = 0.7;
let vol = 0.7; // the volume slider, kept between visits
try {
  const v = localStorage.paperskiesVol;
  if (v) vol = clamp(+v, 0, 1);
} catch {}
const MVOL = 0.62;
function mkSound(ac) {
  const sr = ac.sampleRate;
  const N = (C, o, ...to) => {
    const n = new C(ac, o);
    for (const d of to) n.connect(d);
    if (n.start) n.start();
    return n;
  };
  const G = (gain, ...to) => N(GainNode, { gain }, ...to);
  const BQ = (type, frequency, Q, ...to) => N(BiquadFilterNode, { type, frequency, Q }, ...to);
  const lfo = (frequency, depth, to) => N(OscillatorNode, { frequency }, G(depth, to));
  const noise = (secs, f) => {
    const n = (sr * secs) | 0;
    const b = new AudioBuffer({ length: n, numberOfChannels: 2, sampleRate: sr });
    f(b.getChannelData(0), n);
    f(b.getChannelData(1), n);
    return b;
  };
  // seamless brown noise loop (the end cross-fades into the start)
  const nb = noise(11, (d, n) => {
    for (let i = 0, b = 0; i < n + 4096; i++) {
      b = (b + 0.02 * (rnd() * 2 - 1)) / 1.02;
      if (i < n) d[i] = b * 3.5;
      else {
        const k = (i - n) / 4096;
        d[i - n] = d[i - n] * k + b * 3.5 * (1 - k);
      }
    }
  });
  // reverb: 6 s of soft, darkening noise
  const ir = noise(6, (d, n) => {
    for (let i = 0, b = 0; i < n; i++) {
      const t = i / sr;
      b += (rnd() * 2 - 1 - b) * (0.03 + 0.4 * exp(-t * 2));
      d[i] = b * (1 - exp(-t * 40)) * exp(-t * 1.1) * (1 - i / n);
    }
  });
  const lim = N(DynamicsCompressorNode, { threshold: -8, knee: 8, ratio: 12, attack: 0.005, release: 0.4 }, ac.destination);
  const out = (OUT = G(0, lim));
  MUS = G(0, out);
  const wet = N(ConvolverNode, { buffer: ir }, out);
  const src = (playbackRate, ...to) => N(AudioBufferSourceNode, { buffer: nb, loop: true, playbackRate }, ...to);
  // wind over the wings and a lighter rustle of paper in the turns
  const wind = G(0, out);
  const windF = BQ('lowpass', 400, 0.6, wind);
  src(0.8, windF);
  const rust = G(0, out);
  const rustF = BQ('bandpass', 1800, 1.4, rust);
  src(2.3, rustF);
  // the sea, breathing slowly
  const sea = G(0, out, G(0.4, wet));
  const swell = G(0.6, sea);
  src(0.55, BQ('lowpass', 520, 0.5, swell));
  lfo(0.07, 0.35, swell.gain);
  lfo(0.031, 0.2, swell.gain);
  // birds: short sweeping chirps, each voice a sine through a pan and a little reverb
  const bird = Array.from({ length: 2 }, () => {
    const p = N(StereoPannerNode, {}, out, G(0.5, wet));
    const g = G(0, p);
    return { p, g, o: N(OscillatorNode, {}, g) };
  });
  let lt = ac.currentTime;
  let tW = lt + 6;
  out.gain.setTargetAtTime(muted ? 0 : VOL * vol, lt, 2);
  return () => {
    const now = ac.currentTime;
    const t = now + 0.05;
    const dt = now - lt;
    if (dt <= 0) return;
    lt = now;
    const v = FS[SPD];
    const alt = FS[PY] - groundAt(FS[PX], FS[PZ]);
    const sv = clamp((v - 10) / 30, 0, 1);
    wind.gain.setTargetAtTime(0.035 + 0.16 * sv * sv, t, 0.5);
    windF.frequency.setTargetAtTime(260 + 900 * sv, t, 0.5);
    rust.gain.setTargetAtTime(0.022 * clamp(abs(FS[ROL]) * 1.6 + FS[BOOST] * 0.8, 0, 1), t, 0.3);
    const overSea = hAt(FS[PX], FS[PZ]) < -1 ? 1 : 0.35;
    sea.gain.setTargetAtTime(0.04 + 0.22 * overSea * sstep(120, 8, alt), t, 1);
    if (t > tW) {
      // birds by day, over the land: a few quick chirps
      if (DAY[D_SY] > 0.08 && overSea < 1 && alt < 120) {
        let tt = t;
        for (let n = 2 + ((rnd() * 4) | 0); n--; ) {
          const b = bird.shift();
          bird.push(b);
          const f = rr(2600, 4200);
          const fq = b.o.frequency;
          const g = b.g.gain;
          b.p.pan.setValueAtTime(rr(-0.8, 0.8), tt);
          fq.setValueAtTime(f * 0.8, tt);
          fq.exponentialRampToValueAtTime(f * 1.25, tt + 0.06);
          fq.exponentialRampToValueAtTime(f * 0.9, tt + 0.12);
          g.cancelScheduledValues(tt);
          g.setValueAtTime(0, tt);
          g.linearRampToValueAtTime(0.01, tt + 0.005);
          g.setTargetAtTime(0, tt + 0.01, 0.04);
          tt += rr(0.12, 0.3);
        }
      }
      tW = t + rr(5, 14);
    }
  };
}
// decodes the embedded music and lays its fade-out over its opening; resolves to { buf, x } where x is the length of
// that overlap in samples (the loop runs from 0 to the end minus x, and the first pass starts at x)
async function loadMusic(ac) {
  if (MUSIC.length < 100) return null;
  const b = await ac.decodeAudioData(await (await fetch('data:audio/mp4;base64,' + MUSIC)).arrayBuffer());
  const n = b.length;
  const w = b.sampleRate >> 2;
  const ch = [];
  for (let c = 0; c < b.numberOfChannels; c++) ch.push(b.getChannelData(c));
  // energy per quarter second; the fade-out starts after the last stretch within 8 dB of the song's typical level
  const lv = [];
  for (let i = 0; i + w <= n; i += w) {
    let s = 0;
    for (const d of ch) for (let j = i; j < i + w; j++) s += d[j] * d[j];
    lv.push(s);
  }
  const typ = [...lv].sort((a, c) => a - c)[lv.length >> 1];
  let k = lv.length - 1;
  while (k > 0 && lv[k] < typ * 0.16) k--;
  const x = clamp(n - (k + 1) * w, b.sampleRate >> 1, b.sampleRate * 20);
  for (const d of ch) for (let i = 0; i < x; i++) d[i] += d[n - x + i];
  return { buf: b, x };
}
function playMusic(ac, m) {
  if (!m) return;
  const s = new AudioBufferSourceNode(ac, { buffer: m.buf, loop: true, loopStart: 0, loopEnd: (m.buf.length - m.x) / m.buf.sampleRate });
  s.connect(MUS);
  s.start(ac.currentTime + 0.05, m.x / m.buf.sampleRate);
  MUS.gain.setTargetAtTime(MVOL, ac.currentTime, 1.2);
}
// called on every click / key / touch: builds the graph once and resumes it when the browser allows
function sound() {
  if (!AC) {
    AC = new AudioContext({ latencyHint: 'playback' });
    setInterval(mkSound(AC), 100);
    loadMusic(AC).then(
      (m) => playMusic(AC, m),
      (e) => console.warn('music: ' + e.message),
    );
  }
  if (AC.state === 'suspended' && !document.hidden) AC.resume();
}
function mute() {
  muted = !muted;
  setVolume();
}
function setVolume() {
  if (AC) OUT.gain.setTargetAtTime(muted ? 0 : VOL * vol, AC.currentTime, 0.05);
}
// the volume slider in the menu: a strip of paper filling with ink
{
  const el = $('vol');
  const show = () => {
    el.value = round(vol * 100);
    el.style.setProperty('--v', `${round(vol * 100)}%`);
  };
  show();
  el.oninput = () => {
    vol = el.value / 100;
    muted = false;
    show();
    sound();
    setVolume();
    keep('paperskiesVol', vol);
  };
}
document.addEventListener('visibilitychange', () => {
  if (AC) document.hidden ? AC.suspend() : AC.resume();
});
