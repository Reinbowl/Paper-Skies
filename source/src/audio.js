// ============================================================================
// audio: a calm, procedural soundscape (no sample files)
// ============================================================================
// A fixed Web Audio graph, built on the first click / key / touch and driven by a 10 Hz timer, not the frame loop.
// Layers: wind over the paper (follows the airspeed), the sea below, a slow pentatonic drone, wind chimes, a few
// plucked notes, a singing bowl at dawn and dusk, birds by day and crickets by night.
let AC;
let OUT;
let muted = false;
const VOL = 0.7;
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
  // drone: D pentatonic, each note a pair of slightly detuned sines that slowly beat
  const padF = BQ('lowpass', 900, 0.4, out, G(1.3, wet));
  const pad = G(1, padF);
  [73.42, 110, 146.83, 220, 329.63].forEach((f, i) => {
    const g = G(0.02 - i * 0.0025, pad);
    lfo(0.03 + i * 0.011, 0.008, g.gain);
    N(OscillatorNode, { frequency: f }, g);
    N(OscillatorNode, { frequency: f + rr(0.04, 0.12) }, g);
  });
  // pooled voices: a few partials per voice -> envelope -> pan -> dry + reverb
  const pool = (n, parts, send, type = 'sine', lp = 0) =>
    Array.from({ length: n }, () => {
      const p = N(StereoPannerNode, {}, out, G(send, wet));
      const into = lp ? BQ('lowpass', lp, 0.7, p) : p;
      return {
        p,
        os: Array.from({ length: parts }, () => {
          const g = G(0, into);
          return { g, o: N(OscillatorNode, { type }, g) };
        }),
      };
    });
  // one strike: partial k at f * ratio[k], level vol * amp[k], decaying over dur * len[k]
  const strike = (vs, t, f, ratio, amp, len, vol, dur, pan) => {
    const v = vs.shift();
    vs.push(v);
    v.p.pan.setValueAtTime(pan, t);
    v.os.forEach((x, k) => {
      const g = x.g.gain;
      x.o.frequency.setValueAtTime(f * ratio[k], t);
      g.cancelScheduledValues(t);
      g.setValueAtTime(0, t);
      g.linearRampToValueAtTime(vol * amp[k], t + 0.004 + k * 0.002);
      g.setTargetAtTime(0, t + 0.01, (dur * len[k]) / 4);
    });
  };
  const chime = pool(4, 3, 1);
  const bowl = pool(2, 3, 1.4);
  const pluck = pool(4, 2, 0.8, 'triangle', 1600);
  const bird = pool(2, 1, 0.5);
  // crickets: a high tone pulsed fast, in slow waves
  const crk = G(0, out, G(0.3, wet));
  const crkA = G(0, crk);
  N(OscillatorNode, { frequency: 4400 }, crkA);
  lfo(23, 0.5, crkA.gain);
  const yo = [0, 2, 5, 7, 9, 12, 14, 17, 19, 21, 24]; // D major pentatonic, in semitones above D
  const D4 = 293.66;
  let lt = ac.currentTime;
  let tC = lt + 4;
  let tP = lt + 14;
  let tB = lt + 9;
  let tW = lt + 6;
  let lastS = DAY[D_SY];
  out.gain.setTargetAtTime(VOL, lt, 2);
  return () => {
    const now = ac.currentTime;
    const t = now + 0.05;
    const dt = now - lt;
    if (dt <= 0) return;
    lt = now;
    const v = FS[SPD];
    const alt = FS[PY] - groundAt(FS[PX], FS[PZ]);
    const sv = clamp((v - 10) / 30, 0, 1);
    wind.gain.setTargetAtTime(0.05 + 0.22 * sv * sv, t, 0.5);
    windF.frequency.setTargetAtTime(260 + 900 * sv, t, 0.5);
    rust.gain.setTargetAtTime(0.03 * clamp(abs(FS[ROL]) * 1.6 + FS[BOOST] * 0.8, 0, 1), t, 0.3);
    const overSea = hAt(FS[PX], FS[PZ]) < -1 ? 1 : 0.35;
    sea.gain.setTargetAtTime(0.06 + 0.3 * overSea * sstep(120, 8, alt), t, 1);
    const night = DAY[D_NIGHT];
    const s = DAY[D_SY];
    padF.frequency.setTargetAtTime(500 + 700 * sstep(-0.2, 0.3, s), t, 2);
    crk.gain.setTargetAtTime(0.012 * night * sstep(90, 20, alt) * (overSea < 1 ? 1 : 0.3), t, 2);
    crkA.gain.setTargetAtTime(0.5 + 0.5 * sin(now * 0.7), t, 0.5);
    if (t > tC) {
      // wind chimes: one to three glassy tinkles
      let tt = t;
      for (let n = 1 + ((rnd() * 3) | 0); n--; ) {
        const f = D4 * 4 * pow(2, yo[(rnd() * 7) | 0] / 12);
        strike(chime, tt, f, [1, 2.76, 5.4], [1, 0.4, 0.18], [1, 0.5, 0.3], rr(0.012, 0.024), rr(3, 5), rr(-0.6, 0.6));
        tt += rr(0.12, 0.5);
      }
      tC = tt + rr(7, 18);
    }
    if (t > tP) {
      // a short plucked phrase, rising or falling through the scale
      let k = 2 + ((rnd() * 5) | 0);
      const dir = rnd() < 0.5 ? 1 : -1;
      let tt = t;
      for (let n = 3 + ((rnd() * 3) | 0); n--; ) {
        strike(pluck, tt, D4 * pow(2, yo[clamp(k, 0, 10)] / 12), [1, 2], [1, 0.25], [1, 0.4], rr(0.03, 0.05), 2.4, rr(-0.4, 0.4));
        k += dir * (1 + (rnd() < 0.3));
        tt += rr(0.35, 0.8);
      }
      tP = tt + rr(22, 48);
    }
    // the singing bowl: at sunrise and sunset, and now and then
    const turn = lastS > 0.02 !== s > 0.02;
    lastS = s;
    if (t > tB || turn) {
      const f = rnd() < 0.5 ? 146.83 : 110;
      strike(bowl, t, f, [1, 2.71, 5.15], [1, 0.55, 0.25], [1, 0.6, 0.35], 0.07, 12, rr(-0.3, 0.3));
      tB = t + rr(70, 130);
    }
    if (t > tW) {
      // birds by day: a few quick chirps
      if (s > 0.08 && overSea < 1 && alt < 120) {
        let tt = t;
        for (let n = 2 + ((rnd() * 4) | 0); n--; ) {
          const f = rr(2600, 4200);
          const b = bird[0];
          strike(bird, tt, f, [1], [1], [1], 0.012, 0.16, rr(-0.8, 0.8));
          b.os[0].o.frequency.setValueAtTime(f * 0.8, tt);
          b.os[0].o.frequency.exponentialRampToValueAtTime(f * 1.25, tt + 0.06);
          b.os[0].o.frequency.exponentialRampToValueAtTime(f * 0.9, tt + 0.12);
          tt += rr(0.12, 0.3);
        }
      }
      tW = t + rr(5, 14);
    }
  };
}
// called on every click / key / touch: builds the graph once and resumes it when the browser allows
function sound() {
  if (!AC) {
    AC = new AudioContext({ latencyHint: 'playback' });
    setInterval(mkSound(AC), 100);
  }
  if (AC.state === 'suspended' && !document.hidden) AC.resume();
}
function mute() {
  if (!AC) return;
  muted = !muted;
  OUT.gain.setTargetAtTime(muted ? 0 : VOL, AC.currentTime, 0.1);
}
document.addEventListener('visibilitychange', () => {
  if (AC) document.hidden ? AC.suspend() : AC.resume();
});
