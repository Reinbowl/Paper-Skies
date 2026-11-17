// ============================================================================
// development tools: only in dev.html (npm run build:dev), never in index.html
// ============================================================================
//   1-6  viewpoints (plane pose + time of day), held still for screenshots; any of them again releases
//   F    a 60 s autopilot flight from a fixed start and seed
//   B    the same flight as a benchmark: the resolution stays fixed, every frame is timed, the result is shown at the end
//   P    print the plane's pose
// window.__ps drives the same from the screenshot tool (tools/shoot.mjs).
{
  const LOGN = 1 << 16;
  const logFrame = new Float32Array(LOGN);
  const logGpu = new Float32Array(LOGN);
  let flying = false;
  let bench = false;
  let t0 = 0;
  let last = 0;
  let nFrame = 0;
  let nGpu = 0;
  // plane x, y, z, yaw, time of day (sun angle), camera orbit offset
  const T = Wd.torii;
  const Pg = Wd.pagoda;
  const V0 = Wd.villages[0];
  const POSES = [
    [T[0] - 10, 16, T[1] + 70, atan2(10, -70) + 0.1, 2.95, 0.35],
    [-40, 70, 420, atan2(-180, -480), 2.2, -0.3],
    [620, 50, -520, atan2(-1, 0.25), 3.26, 0.25],
    [V0[0] - 60, groundAt(V0[0] - 60, V0[1]) + 48, V0[1] - 20, 1.12, 3.6, 0.3, 0.06],
    [Pg[0] - 70, groundAt(Pg[0], Pg[1]) + 30, Pg[1] + 50, atan2(70, -50), 0.75, -0.4],
    [300, 260, 700, atan2(-500, -760), 1.6, 0],
  ];
  const settle = () => {
    for (let i = 0; i < 600; i++) chase(1 / 60, false);
  };
  const shot = (i) => {
    const p = POSES[i];
    paused = true;
    flying = false;
    placePlane(p[0], p[1], p[2], p[3]);
    F[TOD] = p[4];
    FS[ACC] = 0;
    FS[CYAW] = p[3] + p[5];
    FS[COFF] = 0;
    FS[CDIST] = 12.5;
    FS[CPIT] = -0.13;
    FS[CX] = p[0] - sin(FS[CYAW]) * 12;
    FS[CY] = p[1] + 2.8;
    FS[CZ] = p[2] - cos(FS[CYAW]) * 12;
    const cy = FS[CYAW];
    for (let k = 0; k < 600; k++) {
      FS[CYAW] = cy;
      if (p[6] !== undefined) FS[CPIT] = p[6];
      chase(1 / 60, false);
      FS[CYAW] = cy;
      if (p[6] !== undefined) FS[CPIT] = p[6];
    }
    daylight(F[TOD]);
    shadowsNow();
  };
  const stop = () => {
    flying = bench = false;
    dynT = 0;
  };
  const report = () => {
    const st = (a, n) => {
      const s = Array.from(a.subarray(0, n)).sort((x, y) => x - y);
      let sum = 0;
      for (const v of s) sum += v;
      return { n, avg: sum / n, p99: s[min(n - 1, floor(n * 0.99))], max: s[n - 1] };
    };
    const fm = (o) => `avg ${o.avg.toFixed(2)}  p99 ${o.p99.toFixed(2)}  max ${o.max.toFixed(2)} ms`;
    const f = st(logFrame, nFrame);
    const g = nGpu ? st(logGpu, nGpu) : null;
    info.textContent = `Fly-through ${W}x${H}, ${f.n} frames\nframe  ${fm(f)}\nGPU    ${g ? fm(g) : 'timestamp-query unavailable'}`;
    window.__bench = { W, H, frame: f, gpu: g };
  };
  const start = (b) => {
    paused = false;
    flying = true;
    bench = b;
    apSeed = 7;
    placePlane(-60, 48, 900, atan2(-160, -940));
    FS[GX] = -220;
    FS[GZ] = -60;
    FS[GT] = 60;
    FS[SIMT] = 0;
    FS[CT] = 0;
    F[TOD] = 2.55;
    shadowsNow();
    settle();
    t0 = F[LAST];
    last = F[LAST];
    nFrame = nGpu = 0;
    if (bench) {
      pix = PIXMAX;
      resize();
      hud = false;
      info.textContent = '';
      dynT = -Infinity;
    }
  };
  const draw = render;
  render = () => {
    if (flying) {
      const dtr = F[LAST] - last;
      last = F[LAST];
      if (bench) {
        if (nFrame < LOGN) logFrame[nFrame++] = dtr;
        if (F[GPU] > 0 && nGpu < LOGN) logGpu[nGpu++] = F[GPU];
      }
      if (F[LAST] - t0 > 60000) {
        if (bench) report();
        stop();
      }
    }
    draw();
  };
  // top-down map of the islands (sheets coloured by height) as an overlay, for laying out the world
  const map = (on) => {
    let img = document.getElementById('devmap');
    if (!on) return img?.remove();
    const n = 768;
    const cv = document.createElement('canvas');
    cv.width = cv.height = n;
    const g = cv.getContext('2d');
    const id = g.createImageData(n, n);
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) {
        const x = WO + ((i + 0.5) / n) * WORLD;
        const z = WO + ((j + 0.5) / n) * WORLD;
        const h = hAt(x, z);
        const k = floor(h / LAYER);
        const o = (i + n * j) * 4;
        const t = (k & 1) * 12;
        if (h < 0) id.data.set([40 + t, 80 + t + h, 150 + h * 2, 255], o);
        else if (h > 180) id.data.set([240 - t, 240 - t, 235 - t, 255], o);
        else id.data.set([120 + h * 0.6 + t, 170 - h * 0.3 + t, 90 + t, 255], o);
      }
    g.putImageData(id, 0, 0);
    g.fillStyle = '#c00';
    for (const p of Wd.pois) g.fillRect(((p[0] - WO) / WORLD) * n - 3, ((p[1] - WO) / WORLD) * n - 3, 6, 6);
    img = document.createElement('img');
    img.id = 'devmap';
    img.src = cv.toDataURL();
    img.style.cssText = 'position:fixed;left:0;top:0;height:100%;z-index:9;image-rendering:pixelated';
    document.body.append(img);
  };
  window.__ps = {
    shot,
    map,
    start,
    stats: () => ({
      tris: TR.ib.length / 3,
      verts: TR.nv,
      props: Wd.stat.map((s) => s.n),
      cranes: nCrane,
      boats: nBoat,
      W,
      H,
      gpu: F[GPU],
    }),
    tod: (a) => {
      F[TOD] = a;
      daylight(a);
      shadowsNow();
    },
    // advance k frames of 1/60 s by hand (the page stays paused), for frame-exact sequences
    adv: (k) => {
      paused = true;
      for (let i = 0; i < k; i++) {
        F[TOD] += (TAU * dayRate(F[TOD])) / 60 / CYCLE;
        FS[ACC] += 1 / 60;
        while (FS[ACC] >= DT) {
          controls();
          FS[ACC] -= DT;
        }
        chase(1 / 60, auto || menu);
      }
    },
    // render a minute of the soundscape offline and measure it: peak and loudness per second (dBFS)
    audioTest: async (secs = 60) => {
      const sr = 44100;
      const oc = new OfflineAudioContext(2, sr * secs, sr);
      const music = await loadMusic(oc);
      const tick = mkSound(oc);
      playMusic(oc, music);
      for (let t = 0.1; t < secs - 0.1; t += 0.1)
        oc.suspend(round(t * 10) / 10).then(() => {
          tick();
          oc.resume();
        });
      const b = await oc.startRendering();
      const d = b.getChannelData(0);
      const db = (x) => +(20 * Math.log10(x + 1e-9)).toFixed(1);
      let peak = 0;
      let sum = 0;
      const rms = [];
      for (let s = 0; s < secs; s++) {
        let q = 0;
        for (let i = s * sr; i < (s + 1) * sr; i++) {
          const v = d[i];
          q += v * v;
          if (abs(v) > peak) peak = abs(v);
        }
        sum += q;
        rms.push(db(sqrt(q / sr)));
      }
      return { peak: db(peak), rms: db(sqrt(sum / d.length)), perSecond: rms };
    },
    // fly the autopilot for `mins` simulated minutes and report how close it came to the paper
    clearance: (mins = 15) => {
      paused = true;
      let lo = 1e9;
      let low = 0;
      let far = 0;
      const n = mins * 60 * 120;
      for (let i = 0; i < n; i++) {
        autopilot();
        stepPlane(apTurn, apPitch, 0);
        const wx = -cos(FS[YAW]) * 1.6;
        const wz = sin(FS[YAW]) * 1.6;
        const c = FS[PY] - max(groundAt(FS[PX], FS[PZ]), groundAt(FS[PX] + wx, FS[PZ] + wz), groundAt(FS[PX] - wx, FS[PZ] - wz));
        if (c < lo) lo = c;
        if (c < 4) low++;
        far = max(far, hypot(FS[PX], FS[PZ]));
      }
      return { minClearance: +lo.toFixed(2), secondsBelow4m: +(low / 120).toFixed(1), farthest: round(far) };
    },
    // loudness (dB, per quarter second) across the music's loop point: the last 8 s before it, then the first 8 s after
    musicSeam: async () => {
      const oc = new OfflineAudioContext(2, 48000, 48000);
      const m = await loadMusic(oc);
      const b = m.buf;
      const sr = b.sampleRate;
      const end = b.length - m.x;
      const d0 = b.getChannelData(0);
      const q = sr >> 2;
      const at = (i0) => {
        let s = 0;
        for (let i = i0; i < i0 + q; i++) {
          const v = d0[(i + end) % end];
          s += v * v;
        }
        return +(10 * Math.log10(s / q + 1e-12)).toFixed(1);
      };
      const before = [];
      const after = [];
      for (let k = 32; k > 0; k--) before.push(at(end - k * q));
      for (let k = 0; k < 32; k++) after.push(at(k * q));
      // the samples right at the seam: last two before, first two after
      return {
        overlapSeconds: +(m.x / sr).toFixed(2),
        loopSeconds: +(end / sr).toFixed(2),
        before,
        after,
        seam: [d0[end - 2], d0[end - 1], d0[0], d0[1]].map((v) => +v.toFixed(4)),
      };
    },
    audio: () => ({ state: AC?.state, music: MUS ? +MUS.gain.value.toFixed(3) : null, time: AC ? +AC.currentTime.toFixed(1) : 0 }),
    play: () => {
      paused = false;
    },
    go: (fly) => go(fly),
    get ready() {
      return F[LAST] > 0;
    },
  };
  addEventListener('keydown', (e) => {
    if (menu || e.repeat) return;
    if (e.code === 'KeyF' || e.code === 'KeyB') {
      if (flying) stop();
      else start(e.code === 'KeyB');
    } else if (/Digit[1-6]/.test(e.code)) {
      if (paused) paused = false;
      else shot(e.code.charCodeAt(5) - 49);
    } else if (e.code === 'KeyP') console.log([FS[PX], FS[PY], FS[PZ], FS[YAW], F[TOD]].map((v) => +v.toFixed(2)).join(', '));
  });
}
