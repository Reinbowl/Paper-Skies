// ============================================================================
// renderer, frame loop, input and menu
// ============================================================================
const $ = (id) => document.getElementById(id);
const canvas = $('c');
const info = $('i');
const body = document.body;
// a phone held upright gets the page turned on its side (see template.html)
const rot = matchMedia('(orientation:portrait) and (pointer:coarse)');
// loading bar: each stage glides it to `to` over ~`ms` on the compositor, so it moves while this thread is busy
let loaded = 0;
let dead;
const say = (m, to, ms) => {
  if (!dead) $('s').textContent = m;
  const a = $('b').animate(
    { transform: [`scaleX(${loaded})`, `scaleX(${to})`] },
    { duration: ms, fill: 'forwards', easing: 'cubic-bezier(.3,.5,.5,1)' },
  );
  loaded = to;
  return new Promise((r) => {
    a.ready.then(() => setTimeout(r));
    setTimeout(r, document.hidden ? 0 : 1e3);
  });
};
const fail = (m) => {
  throw new Error(m, { cause: 1 });
};
if (!navigator.gpu) fail('This page needs WebGPU. Try a current Chrome or Edge.');
const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
if (!adapter) fail('No WebGPU adapter found.');
$('w').hidden = !!navigator.userAgentData;
const hasTS = adapter.features.has('timestamp-query');
const device = await adapter.requestDevice({ requiredFeatures: hasTS ? ['timestamp-query'] : [] });
device.addEventListener('uncapturederror', (e) => console.error('GPU: ' + e.error.message));
// a device lost while the page is being left is not a crash: don't lower the detail level for it
let leaving = false;
addEventListener('pagehide', () => {
  leaving = true;
});
device.lost.then((l) => {
  if (l.reason === 'destroyed' || leaving) return;
  console.warn(`GPU device lost (${l.reason}): ${l.message}`);
  if (LV < 2) {
    keep('paperskies', LV + 1);
    location.reload();
  }
  dead = body.className = 'l e';
  $('s').textContent = 'The graphics device was lost. Reload the page to try again.';
});
const ctx = canvas.getContext('webgpu');
const FMT = navigator.gpu.getPreferredCanvasFormat();
const Q = device.queue;
const HDR = 'rgba16float';
const DEPTH = 'depth32float';
const TU = GPUTextureUsage;
const BU = GPUBufferUsage;
const SS = GPUShaderStage;
const mod = (code) => device.createShaderModule({ code });
const buf = (data, usage) => {
  const b = device.createBuffer({ size: max(16, (data.byteLength + 3) & ~3), usage: usage | BU.COPY_DST });
  Q.writeBuffer(b, 0, data.buffer || data, data.byteOffset || 0, data.byteLength);
  return b;
};
const tex = (w, h, format, usage, o = {}) =>
  device.createTexture({ size: [w, h], format, usage, mipLevelCount: o.mips || 1, sampleCount: o.samples || 1 });

// ---------------------------------------------------------------- static resources
const sRep = device.createSampler({
  addressModeU: 'repeat',
  addressModeV: 'repeat',
  magFilter: 'linear',
  minFilter: 'linear',
  mipmapFilter: 'linear',
  maxAnisotropy: LV > 1 ? 1 : 8,
});
const sClamp = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
const sCmp = device.createSampler({ compare: 'less-equal', magFilter: 'linear', minFilter: 'linear' });
const tNear = tex(NEARSH, NEARSH, DEPTH, TU.RENDER_ATTACHMENT | TU.TEXTURE_BINDING);
const tDummy = tex(1, 1, DEPTH, TU.RENDER_ATTACHMENT | TU.TEXTURE_BINDING);
const tH = tex(GN, GN, 'r32float', TU.TEXTURE_BINDING | TU.COPY_DST);
const tS = tex(GN, GN, 'r16float', TU.RENDER_ATTACHMENT | TU.TEXTURE_BINDING);
const tD = tex(1024, 1024, 'rgba8unorm', TU.RENDER_ATTACHMENT | TU.TEXTURE_BINDING, { mips: 11 });
const tM = tex(1024, 1024, 'rgba8unorm', TU.TEXTURE_BINDING | TU.COPY_DST);

const UB = new Float32Array(104);
const ubo = device.createBuffer({ size: UB.byteLength, usage: BU.UNIFORM | BU.COPY_DST });
const SU = new Float32Array(4);
const suo = device.createBuffer({ size: 16, usage: BU.UNIFORM | BU.COPY_DST });

const VF = SS.VERTEX | SS.FRAGMENT;
const bgl0 = device.createBindGroupLayout({
  entries: [
    { binding: 0, visibility: VF, buffer: {} },
    { binding: 1, visibility: VF, sampler: {} },
    { binding: 2, visibility: VF, sampler: {} },
    { binding: 3, visibility: VF, sampler: { type: 'comparison' } },
    { binding: 4, visibility: VF, texture: { sampleType: 'depth' } },
    { binding: 5, visibility: VF, texture: { sampleType: 'unfilterable-float' } },
    { binding: 6, visibility: VF, texture: {} },
    { binding: 7, visibility: VF, texture: {} },
    { binding: 8, visibility: VF, texture: {} },
  ],
});
const mkBG0 = (sh) =>
  device.createBindGroup({
    layout: bgl0,
    entries: [
      { binding: 0, resource: { buffer: ubo } },
      { binding: 1, resource: sRep },
      { binding: 2, resource: sClamp },
      { binding: 3, resource: sCmp },
      { binding: 4, resource: sh.createView() },
      { binding: 5, resource: tH.createView() },
      { binding: 6, resource: tS.createView() },
      { binding: 7, resource: tD.createView() },
      { binding: 8, resource: tM.createView() },
    ],
  });
const bg0 = mkBG0(tNear);
const bg0s = mkBG0(tDummy);
const pl0 = device.createPipelineLayout({ bindGroupLayouts: [bgl0] });

const bglBlit = device.createBindGroupLayout({
  entries: [
    { binding: 0, visibility: SS.FRAGMENT, texture: {} },
    { binding: 1, visibility: SS.FRAGMENT, sampler: {} },
  ],
});
const plBlit = device.createPipelineLayout({ bindGroupLayouts: [bglBlit] });
const mBlit = mod(W_BLIT);
const ADD = { color: { srcFactor: 'one', dstFactor: 'one' }, alpha: { srcFactor: 'one', dstFactor: 'one' } };
const blitPipe = (entry, format, add) =>
  device.createRenderPipeline({
    layout: plBlit,
    vertex: { module: mBlit, entryPoint: 'vs' },
    fragment: { module: mBlit, entryPoint: entry, targets: [{ format, blend: add ? ADD : undefined }] },
  });
const blitBG = (view) =>
  device.createBindGroup({
    layout: bglBlit,
    entries: [
      { binding: 0, resource: view },
      { binding: 1, resource: sClamp },
    ],
  });
const colorAtt = (view, clear) => ({ view, loadOp: clear ? 'clear' : 'load', storeOp: 'store', clearValue: [0, 0, 0, 0] });

// vertex layouts
const A = (shaderLocation, offset, format) => ({ shaderLocation, offset, format });
const vbTerrL = { arrayStride: 16, attributes: [A(0, 0, 'float32x3'), A(1, 12, 'snorm8x4')] };
const vbMeshL = { arrayStride: 16, attributes: [A(0, 0, 'float32x3'), A(1, 12, 'uint8x4')] };
const ibInstL = { arrayStride: 32, stepMode: 'instance', attributes: [A(2, 0, 'float32x4'), A(3, 16, 'float32x4')] };

const scenePipe = (m, vsE, fsE, buffers, o = {}) =>
  device.createRenderPipeline({
    layout: pl0,
    vertex: { module: m, entryPoint: vsE, buffers, constants: o.constants },
    fragment: { module: m, entryPoint: fsE, targets: [{ format: HDR, blend: o.blend }], constants: o.constants },
    primitive: { topology: o.strip ? 'triangle-strip' : 'triangle-list', cullMode: o.cull || 'none' },
    depthStencil: { format: DEPTH, depthWriteEnabled: o.write ?? !o.blend, depthCompare: o.cmp || 'greater' },
    multisample: { count: AA },
  });
const shadowPipe = (m, vsE, buffers, o = {}) =>
  device.createRenderPipeline({
    layout: pl0,
    vertex: { module: m, entryPoint: vsE, buffers, constants: o.constants },
    primitive: { topology: 'triangle-list', cullMode: 'none' },
    depthStencil: { format: DEPTH, depthWriteEnabled: true, depthCompare: 'less', depthBias: 2, depthBiasSlopeScale: 1.5 },
  });

await say('Folding paper…', 0.05, 300);
const mTerr = mod(W_TERR);
const mProp = mod(W_PROP);
const mSky = mod(W_SKY);
const mOrb = mod(W_ORB);
const mWater = mod(W_WATER);
const pTerr = scenePipe(mTerr, 'vs', 'fs', [vbTerrL], { cull: 'back' });
const pSky = scenePipe(mSky, 'vs', 'fs', [], { cmp: 'greater-equal', write: false });
const pOrb = scenePipe(mOrb, 'vs', 'fs', [vbMeshL]);
const PREMUL = {
  color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
  alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
};
const pWater = scenePipe(mWater, 'vs', 'fs', [], { strip: true, blend: PREMUL, write: true });
const pProp = [0, 1, 2, 3, 4, 5].map((k) => scenePipe(mProp, 'vs', 'fs', [vbMeshL, ibInstL], { constants: { KIND: k } }));
const pPropSh = [0, 1, 2, 3, 4, 5].map((k) => shadowPipe(mProp, 'vsSh', [vbMeshL, ibInstL], { constants: { KIND: k } }));
const mShh = mod(W_SHH);
const pShh = device.createRenderPipeline({
  layout: 'auto',
  vertex: { module: mShh, entryPoint: 'vs' },
  fragment: { module: mShh, entryPoint: 'fs', targets: [{ format: 'r16float' }] },
});
const bgShh = device.createBindGroup({
  layout: pShh.getBindGroupLayout(0),
  entries: [
    { binding: 0, resource: { buffer: suo } },
    { binding: 1, resource: tH.createView() },
  ],
});
const pMip8 = blitPipe('fsMip', 'rgba8unorm');
const pDown0 = blitPipe('fsDown0', HDR);
const pDown = blitPipe('fsDown', HDR);
const pUp = blitPipe('fsUp', HDR, true);
const mPost = mod(W_POST);
const pPost = device.createRenderPipeline({
  layout: 'auto',
  vertex: { module: mPost, entryPoint: 'vs' },
  fragment: { module: mPost, entryPoint: 'fs', targets: [{ format: FMT }] },
});

// ---------------------------------------------------------------- the islands
await say('Shaping the islands…', 0.15, 600);
keep('paperskiesLoad', 1);
addEventListener('pagehide', () => keep('paperskiesLoad', ''));
{
  const m = mod(W_HGT);
  const p = device.createComputePipeline({ layout: 'auto', compute: { module: m, entryPoint: 'main' } });
  const size = GN * GN * 4;
  const u = new ArrayBuffer(16);
  new Uint32Array(u, 0, 2).set([GN, ISLANDS.length]);
  new Float32Array(u, 8, 2).set([GS, WO]);
  const bu = buf(new Uint8Array(u), BU.UNIFORM);
  const bi = buf(islandBuffer(), BU.STORAGE);
  const bd = device.createBuffer({ size, usage: BU.STORAGE | BU.COPY_SRC });
  const br = device.createBuffer({ size, usage: BU.MAP_READ | BU.COPY_DST });
  const bg = device.createBindGroup({
    layout: p.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: bu } },
      { binding: 1, resource: { buffer: bd } },
      { binding: 2, resource: { buffer: bi } },
    ],
  });
  const e = device.createCommandEncoder();
  const c = e.beginComputePass();
  c.setPipeline(p);
  c.setBindGroup(0, bg);
  c.dispatchWorkgroups(GN / 8, GN / 8);
  c.end();
  e.copyBufferToBuffer(bd, 0, br, 0, size);
  Q.submit([e.finish()]);
  await br.mapAsync(GPUMapMode.READ);
  HM = new Float32Array(br.getMappedRange().slice(0));
  br.unmap();
  br.destroy();
  bd.destroy();
}
smoothHeights();
Q.writeTexture({ texture: tH }, HM, { bytesPerRow: GN * 4 }, [GN, GN]);

await say('Stacking the paper…', 0.35, 1500);
const TR = buildTerrain();
const vbTerr = buf(new Uint8Array(TR.vb), BU.VERTEX);
const ibTerr = buf(TR.ib, BU.INDEX);
await say('Planting the trees…', 0.7, 1200);
const Wd = makeWorld();
POIS = Wd.pois;

await say('Folding cranes…', 0.9, 600);
// mesh ids: 0 pine, 1 round tree, 2 bush, 3 house, 4 pagoda, 5 torii, 6 rock, 7-8 far trees, 9 boat, 10 crane,
// 11-12 clouds, 13 lantern, 14 plane, 15 sun, 16 moon
const meshes = [
  meshPine(0),
  meshRound(0),
  meshBush(),
  meshHouse(),
  meshPagoda(),
  meshTorii(),
  meshRock(),
  meshPine(1),
  meshRound(1),
  meshBoat(),
  meshCrane(),
  meshCloud(0),
  meshCloud(1),
  meshLantern(),
  meshPlane(),
  meshSun(),
  meshMoon(),
].map((m) => m.build());
let nV = 0;
let nI = 0;
for (const m of meshes) {
  m.v0 = nV;
  m.i0 = nI;
  nV += m.nv;
  nI += m.ib.length;
}
const allV = new Uint8Array(nV * 16);
const allI = new Uint32Array(nI);
for (const m of meshes) {
  allV.set(new Uint8Array(m.vb), m.v0 * 16);
  allI.set(m.ib, m.i0);
}
const vbMesh = buf(allV, BU.VERTEX);
const ibMesh = buf(allI, BU.INDEX);
const ibStat = Wd.stat.map((s) => buf(s.data, BU.VERTEX));
const ibBoat = buf(Wd.boats, BU.VERTEX);
const ibCrane = buf(Wd.cranes, BU.VERTEX);
const ibCloud = buf(Wd.clouds, BU.VERTEX);
const ibLant = buf(Wd.lanterns, BU.VERTEX);
const PLANE_COL = rgb(0.85, 0.37, 0.29);
const ibPlane = buf(new Float32Array([0, 0, 0, 1, 0, PLANE_COL, 0.5, 0]), BU.VERTEX);
const nBoat = Wd.boats.length / 8;
const nCrane = Wd.cranes.length / 8;
const nCloud = Wd.clouds.length / 8;
const nLant = Wd.lanterns.length / 8;
Q.writeTexture({ texture: tM }, Wd.gm, { bytesPerRow: 1024 * 4 }, [1024, 1024]);
UB.set([Wd.torii[0], Wd.torii[1], Wd.toriiYaw, 1.45], 100);

// ---------------------------------------------------------------- one-time bakes: paper texture
{
  const m = mod(W_DETAIL);
  const p = device.createRenderPipeline({
    layout: 'auto',
    vertex: { module: m, entryPoint: 'vs' },
    fragment: { module: m, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] },
  });
  const e = device.createCommandEncoder();
  let r = e.beginRenderPass({ colorAttachments: [colorAtt(tD.createView({ baseMipLevel: 0, mipLevelCount: 1 }), true)] });
  r.setPipeline(p);
  r.draw(3);
  r.end();
  for (let i = 1; i < 11; i++) {
    r = e.beginRenderPass({ colorAttachments: [colorAtt(tD.createView({ baseMipLevel: i, mipLevelCount: 1 }), true)] });
    r.setPipeline(pMip8);
    r.setBindGroup(0, blitBG(tD.createView({ baseMipLevel: i - 1, mipLevelCount: 1 })));
    r.draw(3);
    r.end();
  }
  Q.submit([e.finish()]);
}

// ---------------------------------------------------------------- render targets (rebuilt on resize)
const PIXMAX = 2560 * 1440;
const PIXMIN = mob ? 25e4 : 5e5;
let W = 0;
let H = 0;
let DW = 0;
let DH = 0;
let pix = +SV[1] || (LV > 1 ? 41e4 : mob ? 1280 * 720 : PIXMAX);
let dynN = 0;
let dynT = 0;
let dynG = 0;
let dynGN = 0;
let dynBad = 0;
let dynOk = 0;
let dynWait = 3;
let passScene;
let passPost;
let bgPost;
let bloomPass = [];
let bloomBG = [];
let targets = [];
const NB = 6;
function resize() {
  DW = max(2, round(canvas.clientWidth * devicePixelRatio));
  DH = max(2, round(canvas.clientHeight * devicePixelRatio));
  const s = min(1, sqrt(pix / (DW * DH)));
  const w = max(2, round(DW * s) & ~1);
  const h = max(2, round(DH * s) & ~1);
  if (w === W && h === H) return;
  dynN = dynG = dynGN = 0;
  dynT = -300;
  W = w;
  H = h;
  canvas.width = W;
  canvas.height = H;
  ctx.configure({ device, format: FMT, alphaMode: 'opaque' });
  for (const t of targets) t.destroy();
  const tMS = tex(AA > 1 ? W : 1, H, HDR, TU.RENDER_ATTACHMENT, { samples: AA });
  const tDp = tex(W, H, DEPTH, TU.RENDER_ATTACHMENT, { samples: AA });
  const tRes = tex(W, H, HDR, TU.RENDER_ATTACHMENT | TU.TEXTURE_BINDING);
  targets = [tMS, tDp, tRes];
  const bl = [];
  for (let i = 0; i < NB; i++) {
    const t = tex(max(1, W >> (i + 1)), max(1, H >> (i + 1)), HDR, TU.RENDER_ATTACHMENT | TU.TEXTURE_BINDING);
    bl.push(t);
    targets.push(t);
  }
  const vRes = tRes.createView();
  const vBl = bl.map((t) => t.createView());
  passScene = {
    colorAttachments: [
      {
        view: AA > 1 ? tMS.createView() : vRes,
        resolveTarget: AA > 1 ? vRes : undefined,
        loadOp: 'clear',
        storeOp: AA > 1 ? 'discard' : 'store',
        clearValue: [0, 0, 0, 1],
      },
    ],
    depthStencilAttachment: { view: tDp.createView(), depthClearValue: 0, depthLoadOp: 'clear', depthStoreOp: 'discard' },
  };
  passPost = { colorAttachments: [{ view: null, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] };
  bgPost = device.createBindGroup({
    layout: pPost.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: ubo } },
      { binding: 1, resource: sClamp },
      { binding: 2, resource: vRes },
      { binding: 3, resource: vBl[0] },
    ],
  });
  bloomPass = [];
  bloomBG = [];
  for (let i = 0; i < NB; i++) {
    bloomPass.push({ colorAttachments: [colorAtt(vBl[i], true)] });
    bloomBG.push(blitBG(i ? vBl[i - 1] : vRes));
  }
  for (let i = NB - 1; i > 0; i--) {
    bloomPass.push({ colorAttachments: [colorAtt(vBl[i - 1], false)] });
    bloomBG.push(blitBG(vBl[i]));
  }
  UB[80] = W;
  UB[81] = H;
  UB[82] = 1 / W;
  UB[83] = 1 / H;
}
resize();
addEventListener('resize', resize);
const passNear = {
  colorAttachments: [],
  depthStencilAttachment: { view: tNear.createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' },
};
const passShh = { colorAttachments: [colorAtt(tS.createView(), false)] };
const SHB = LV > 1 ? 8 : 16; // the land shadows are refreshed in this many bands, one per frame
let shBand = 0;

// ---------------------------------------------------------------- timing (GPU timestamp queries)
let qs;
let qResolve;
const qRead = [];
let tsBegin;
let tsEnd;
const F = new Float64Array(16);
const LAST = 0;
const GPU = 1;
const HUDT = 2;
const TOD = 3;
if (hasTS) {
  qs = device.createQuerySet({ type: 'timestamp', count: 2 });
  qResolve = device.createBuffer({ size: 16, usage: BU.QUERY_RESOLVE | BU.COPY_SRC });
  for (let i = 0; i < 6; i++) {
    const b = device.createBuffer({ size: 16, usage: BU.MAP_READ | BU.COPY_DST });
    const o = { b, busy: false, done: null };
    o.done = () => {
      const a = new BigInt64Array(b.getMappedRange());
      const ms = Number(a[1] - a[0]) / 1e6;
      F[GPU] = ms;
      b.unmap();
      o.busy = false;
      if (dynT > 0 && ms > 0 && ms < 1e3) {
        dynG += ms;
        dynGN++;
      }
    };
    qRead.push(o);
  }
  tsBegin = { querySet: qs, beginningOfPassWriteIndex: 0 };
  tsEnd = { querySet: qs, endOfPassWriteIndex: 1 };
}

// ---------------------------------------------------------------- culling
const NEAR = 0.1;
let TANH = 0.5;
const PLN = new Float64Array(12); // the four side planes of the view, inward normals
const rowOrd = new Uint8Array(CELLS);
// Draws the cells of a cell-sorted set that are in view and whose nearest point is within [minD, maxD), as merged
// runs, nearest rows first. Without a mesh the set is the land: ranges of its index buffer.
function drawCells(r, S, mesh, minD, maxD, mar) {
  const cx = FS[CX];
  const cy = FS[CY];
  const cz = FS[CZ];
  const min2 = minD * minD;
  const max2 = maxD * maxD;
  const hw = CELLW * 0.5 + mar;
  for (let k = 0; k < CELLS; k++) {
    const rw = rowOrd[k];
    const row = rw * CELLS;
    const pz = WO + (rw + 0.5) * CELLW - cz;
    const dz = max(abs(pz) - hw, 0);
    let run = -1;
    for (let x = 0; x <= CELLS; x++) {
      const c = row + x;
      let v = false;
      if (x < CELLS) {
        const l = S.lo[c];
        const h = S.hi[c];
        if (l <= h) {
          const px = WO + (x + 0.5) * CELLW - cx;
          const dx = max(abs(px) - hw, 0);
          const d2 = dx * dx + dz * dz;
          if (d2 < max2 && d2 >= min2) {
            const py = (l + h) * 0.5 - cy;
            const ey = (h - l) * 0.5 + mar;
            v = true;
            for (let p = 0; p < 12 && v; p += 3) {
              const nx = PLN[p];
              const ny = PLN[p + 1];
              const nz = PLN[p + 2];
              v = px * nx + py * ny + pz * nz + hw * abs(nx) + ey * abs(ny) + hw * abs(nz) >= 0;
            }
          }
        }
      }
      if (v) {
        if (run < 0) run = c;
      } else if (run >= 0) {
        const a = S.start[run];
        const n = S.start[c] - a;
        if (n > 0) {
          if (mesh) r.drawIndexed(mesh.ib.length, n, mesh.i0, mesh.v0, a);
          else r.drawIndexed(n, 1, a, 0, 0);
        }
        run = -1;
      }
    }
  }
}
// the cells within `rad` of the plane, for its shadow map
function drawNear(r, S, mesh, rad) {
  const px0 = FS[IX];
  const pz0 = FS[IZ];
  const hw = CELLW * 0.5 + 8;
  for (let z = 0; z < CELLS; z++) {
    const dz = max(abs(WO + (z + 0.5) * CELLW - pz0) - hw, 0);
    if (dz > rad) continue;
    let run = -1;
    for (let x = 0; x <= CELLS; x++) {
      const c = z * CELLS + x;
      const v = x < CELLS && S.lo[c] <= S.hi[c] && hypot(max(abs(WO + (x + 0.5) * CELLW - px0) - hw, 0), dz) < rad;
      if (v) {
        if (run < 0) run = c;
      } else if (run >= 0) {
        const a = S.start[run];
        const n = S.start[c] - a;
        if (n > 0) r.drawIndexed(mesh.ib.length, n, mesh.i0, mesh.v0, a);
        run = -1;
      }
    }
  }
}

// ---------------------------------------------------------------- frame
const submitList = [null];
const NEARR = 64; // radius of the plane's shadow map
let auto = true;
let menu = true;
let hurry = 0;
let hud = false;
let paused = false; // dev.js: hold the plane and the sun still
function render() {
  const cx = FS[CX];
  const cy = FS[CY];
  const cz = FS[CZ];
  const fx = FS[FX];
  const fy = FS[FY];
  const fz = FS[FZ];
  const rx = FS[RX];
  const ry = FS[RY];
  const rz = FS[RZ];
  const ux = FS[UX];
  const uy = FS[UY];
  const uz = FS[UZ];
  TANH = 0.5 + FS[BOOST] * 0.05;
  const asp = W / H;
  const sx = 1 / (TANH * asp);
  const sy = 1 / TANH;
  const m = UB;
  m[0] = rx * sx;
  m[4] = ry * sx;
  m[8] = rz * sx;
  m[12] = -(rx * cx + ry * cy + rz * cz) * sx;
  m[1] = ux * sy;
  m[5] = uy * sy;
  m[9] = uz * sy;
  m[13] = -(ux * cx + uy * cy + uz * cz) * sy;
  m[2] = 0;
  m[6] = 0;
  m[10] = 0;
  m[14] = NEAR;
  m[3] = fx;
  m[7] = fy;
  m[11] = fz;
  m[15] = -(fx * cx + fy * cy + fz * cz);
  m[32] = cx;
  m[33] = cy;
  m[34] = cz;
  m[35] = FS[SIMT];
  m[36] = rx;
  m[37] = ry;
  m[38] = rz;
  m[39] = TANH * asp;
  m[40] = ux;
  m[41] = uy;
  m[42] = uz;
  m[43] = TANH;
  m[44] = fx;
  m[45] = fy;
  m[46] = fz;
  m[47] = NEAR;
  const tw = TANH * asp;
  PLN[0] = fx * tw - rx;
  PLN[1] = fy * tw - ry;
  PLN[2] = fz * tw - rz;
  PLN[3] = fx * tw + rx;
  PLN[4] = fy * tw + ry;
  PLN[5] = fz * tw + rz;
  PLN[6] = fx * TANH - ux;
  PLN[7] = fy * TANH - uy;
  PLN[8] = fz * TANH - uz;
  PLN[9] = fx * TANH + ux;
  PLN[10] = fy * TANH + uy;
  PLN[11] = fz * TANH + uz;
  // daylight
  daylight(F[TOD]);
  for (let i = 0; i < 4; i++) {
    m[48 + i] = DAY[D_KEY + i];
    m[56 + i] = DAY[D_SUN + i];
    m[60 + i] = DAY[D_MOON + i];
  }
  for (let i = 0; i < 3; i++) {
    m[52 + i] = DAY[D_KEYC + i];
    m[64 + i] = DAY[D_ZEN + i];
    m[68 + i] = DAY[D_HOR + i];
    m[72 + i] = DAY[D_AMBS + i];
    m[76 + i] = DAY[D_AMBG + i];
  }
  m[55] = DAY[D_NIGHT];
  m[67] = DAY[D_EXPO];
  m[71] = DAY[D_LANT];
  m[75] = DAY[D_SY];
  // near shadow map: an orthographic view down the key light, centred on the plane and snapped to its texels
  {
    const Lx = DAY[D_KEY];
    const Ly = DAY[D_KEY + 1];
    const Lz = DAY[D_KEY + 2];
    let ax = -Lz;
    let az = Lx;
    const al = hypot(ax, az) || 1;
    ax /= al;
    az /= al;
    const bx = -az * Ly;
    const by = az * Lx - ax * Lz;
    const bz = ax * Ly;
    const R = NEARR;
    const step = (2 * R) / NEARSH;
    const pa = round((ax * FS[IX] + az * FS[IZ]) / step) * step;
    const pb = round((bx * FS[IX] + by * FS[IY] + bz * FS[IZ]) / step) * step;
    const pl = Lx * FS[IX] + Ly * FS[IY] + Lz * FS[IZ];
    const d = 600;
    m[16] = ax / R;
    m[20] = 0;
    m[24] = az / R;
    m[28] = -pa / R;
    m[17] = bx / R;
    m[21] = by / R;
    m[25] = bz / R;
    m[29] = -pb / R;
    m[18] = -Lx / d;
    m[22] = -Ly / d;
    m[26] = -Lz / d;
    m[30] = pl / d + 0.5;
    m[19] = 0;
    m[23] = 0;
    m[27] = 0;
    m[31] = 1;
  }
  // the plane
  {
    const y = FS[IYAW];
    const p = FS[IPIT];
    const ro = FS[IROL];
    const cp = cos(p);
    const pfx = sin(y) * cp;
    const pfy = sin(p);
    const pfz = cos(y) * cp;
    let prx = -pfz;
    let prz = pfx;
    const l = hypot(prx, prz) || 1;
    prx /= l;
    prz /= l;
    const pux = -prz * pfy;
    const puy = prz * pfx - prx * pfz;
    const puz = prx * pfy;
    const c = cos(ro);
    const s = sin(ro);
    m[84] = prx * c - pux * s;
    m[85] = -puy * s;
    m[86] = prz * c - puz * s;
    m[87] = 0.05 + FS[LOAD] * 0.12;
    m[88] = pux * c + prx * s;
    m[89] = puy * c;
    m[90] = puz * c + prz * s;
    m[91] = FS[SPD] / 21;
    m[92] = pfx;
    m[93] = pfy;
    m[94] = pfz;
    m[95] = 1.7;
    m[96] = FS[IX];
    m[97] = FS[IY];
    m[98] = FS[IZ];
    m[99] = FS[BOOST];
  }
  Q.writeBuffer(ubo, 0, UB);
  {
    let lx = DAY[D_KEY];
    let lz = DAY[D_KEY + 2];
    const lh = hypot(lx, lz) || 1;
    lx /= lh;
    lz /= lh;
    SU[0] = lx;
    SU[1] = lz;
    SU[2] = (max(DAY[D_KEY + 1], 0.12) / lh) * GS;
    Q.writeBuffer(suo, 0, SU);
  }
  {
    let cr = floor((cz - WO) / CELLW) | 0;
    cr = cr < 0 ? 0 : cr > CELLS - 1 ? CELLS - 1 : cr;
    let n = 0;
    rowOrd[n++] = cr;
    for (let d = 1; d < CELLS; d++) {
      if (cr - d >= 0) rowOrd[n++] = cr - d;
      if (cr + d < CELLS) rowOrd[n++] = cr + d;
    }
  }

  const e = device.createCommandEncoder();
  let slot = null;
  if (hasTS)
    for (let i = 0; i < qRead.length; i++)
      if (!qRead[i].busy) {
        slot = qRead[i];
        break;
      }
  passShh.timestampWrites = slot ? tsBegin : undefined;
  passPost.timestampWrites = slot ? tsEnd : undefined;
  // land shadows: one band of rows (all of them while time hurries)
  let r = e.beginRenderPass(passShh);
  r.setPipeline(pShh);
  r.setBindGroup(0, bgShh);
  const bands = hurry ? 4 : 1;
  for (let b = 0; b < bands; b++) {
    const y0 = (shBand * GN) / SHB;
    r.setViewport(0, y0, GN, GN / SHB, 0, 1);
    r.setScissorRect(0, y0, GN, GN / SHB);
    r.draw(3);
    shBand = (shBand + 1) % SHB;
  }
  r.end();
  // the plane's own shadow map: props near it, cranes, boats, the plane
  r = e.beginRenderPass(passNear);
  r.setBindGroup(0, bg0s);
  r.setVertexBuffer(0, vbMesh);
  r.setIndexBuffer(ibMesh, 'uint32');
  r.setPipeline(pPropSh[0]);
  for (let i = 0; i < 7; i++) {
    if (i === 2 || i === 6) continue;
    r.setVertexBuffer(1, ibStat[i]);
    drawNear(r, Wd.stat[i], meshes[i], NEARR + 20);
  }
  r.setPipeline(pPropSh[1]);
  r.setVertexBuffer(1, ibCrane);
  r.drawIndexed(meshes[10].ib.length, nCrane, meshes[10].i0, meshes[10].v0, 0);
  r.setPipeline(pPropSh[2]);
  r.setVertexBuffer(1, ibBoat);
  r.drawIndexed(meshes[9].ib.length, nBoat, meshes[9].i0, meshes[9].v0, 0);
  r.setPipeline(pPropSh[5]);
  r.setVertexBuffer(1, ibPlane);
  r.drawIndexed(meshes[14].ib.length, 1, meshes[14].i0, meshes[14].v0, 0);
  r.end();
  // scene
  r = e.beginRenderPass(passScene);
  r.setBindGroup(0, bg0);
  r.setPipeline(pTerr);
  r.setVertexBuffer(0, vbTerr);
  r.setIndexBuffer(ibTerr, 'uint32');
  drawCells(r, TR, null, 0, 1e9, 2);
  r.setPipeline(pProp[0]);
  r.setVertexBuffer(0, vbMesh);
  r.setIndexBuffer(ibMesh, 'uint32');
  const det = 1;
  for (let i = 0; i < 7; i++) {
    r.setVertexBuffer(1, ibStat[i]);
    const S = Wd.stat[i];
    if (i < 2) {
      drawCells(r, S, meshes[i], 0, 280 * det, 16);
      drawCells(r, S, meshes[7 + i], 280 * det, 1500 * det, 16);
    } else drawCells(r, S, meshes[i], 0, (i === 2 ? 500 : i === 6 ? 700 : 2400) * det, 16);
  }
  r.setPipeline(pProp[1]);
  r.setVertexBuffer(1, ibCrane);
  r.drawIndexed(meshes[10].ib.length, nCrane, meshes[10].i0, meshes[10].v0, 0);
  r.setPipeline(pProp[2]);
  r.setVertexBuffer(1, ibBoat);
  r.drawIndexed(meshes[9].ib.length, nBoat, meshes[9].i0, meshes[9].v0, 0);
  r.setPipeline(pProp[3]);
  r.setVertexBuffer(1, ibCloud);
  r.drawIndexed(meshes[11].ib.length, nCloud >> 1, meshes[11].i0, meshes[11].v0, 0);
  r.drawIndexed(meshes[12].ib.length, nCloud - (nCloud >> 1), meshes[12].i0, meshes[12].v0, nCloud >> 1);
  r.setPipeline(pProp[5]);
  r.setVertexBuffer(1, ibPlane);
  r.drawIndexed(meshes[14].ib.length, 1, meshes[14].i0, meshes[14].v0, 0);
  r.setPipeline(pOrb);
  r.drawIndexed(meshes[15].ib.length, 1, meshes[15].i0, meshes[15].v0, 0);
  r.drawIndexed(meshes[16].ib.length, 1, meshes[16].i0, meshes[16].v0, 0);
  r.setPipeline(pSky);
  r.draw(3);
  r.setPipeline(pWater);
  r.draw(4);
  r.setPipeline(pProp[4]);
  r.setVertexBuffer(1, ibLant);
  r.drawIndexed(meshes[13].ib.length, nLant, meshes[13].i0, meshes[13].v0, 0);
  r.end();
  // bloom
  for (let i = 0; i < bloomPass.length; i++) {
    r = e.beginRenderPass(bloomPass[i]);
    r.setPipeline(i === 0 ? pDown0 : i < NB ? pDown : pUp);
    r.setBindGroup(0, bloomBG[i]);
    r.draw(3);
    r.end();
  }
  passPost.colorAttachments[0].view = ctx.getCurrentTexture().createView();
  r = e.beginRenderPass(passPost);
  r.setPipeline(pPost);
  r.setBindGroup(0, bgPost);
  r.draw(3);
  r.end();
  if (slot) {
    e.resolveQuerySet(qs, 0, 2, qResolve, 0);
    e.copyBufferToBuffer(qResolve, 0, slot.b, 0, 16);
  }
  submitList[0] = e.finish();
  Q.submit(submitList);
  if (slot) {
    slot.busy = true;
    slot.b.mapAsync(GPUMapMode.READ).then(slot.done);
  }
}
// the whole land shadow map at once (start, and jumps in time)
function shadowsNow() {
  for (let b = 0; b < SHB; b++) {
    const e = device.createCommandEncoder();
    const r = e.beginRenderPass(passShh);
    r.setPipeline(pShh);
    r.setBindGroup(0, bgShh);
    r.setViewport(0, (b * GN) / SHB, GN, GN / SHB, 0, 1);
    r.setScissorRect(0, (b * GN) / SHB, GN, GN / SHB);
    r.draw(3);
    r.end();
    Q.submit([e.finish()]);
  }
}

// ---------------------------------------------------------------- input state
let kf = 0;
let kb = 0;
let kl = 0;
let kr = 0;
let ks = 0;
let mdx = 0;
let mdy = 0;
let inv = false;
let tId = -1;
let tN = 0;
let tx0 = 0;
let ty0 = 0;
let tx = 0;
let ty = 0;
let hN = 0;
let hMax = 0;
let hMin = 1e9;
let hPer = 1e9;
let hLate = 0;
let hTot = 0;

function controls() {
  if (auto || menu) {
    autopilot();
    stepPlane(apTurn, apPitch, 0);
    return;
  }
  FS[STX] *= exp(-DT * 1.1);
  FS[STY] *= exp(-DT * 1.1);
  const kk = 1 - exp(-DT * 4);
  FS[KT] += (kr - kl - FS[KT]) * kk;
  FS[KP] += (kf - kb - FS[KP]) * kk;
  const turn = clamp(FS[STX] + FS[KT], -1, 1);
  const pitch = clamp(FS[STY] + FS[KP], -1, 1) * (inv ? -1 : 1);
  stepPlane(turn, pitch, ks || tN > 1 ? 1 : 0);
}

function frame(now) {
  requestAnimationFrame(frame);
  const dtr = now - F[LAST];
  F[LAST] = now;
  let dt = dtr / 1000;
  if (dt > 0.1) dt = 0.1;
  // dynamic resolution for 60 fps: every second (0.4 s behind the menu) scale the pixel count by k
  if (dtr < 1e3) {
    dynT += dtr;
    if (dynT > 0) dynN++;
  }
  if (dtr < 1e3 && dynT > (menu ? 400 : 1000)) {
    const a = dynT / dynN;
    const g = dynGN ? dynG / dynGN : 0;
    let k = 1;
    if (g) {
      if (g > 13.6 || g < 9.8) k = 11.7 / g;
    } else if (a > 17.6) {
      dynOk = 0;
      if (++dynBad > 1) {
        k = 15 / a;
        dynBad = 0;
        dynWait = min(dynWait * 2, 60);
      }
    } else {
      dynBad = 0;
      if (a < 12.5) k = 15 / a;
      else if (++dynOk > dynWait) {
        k = 1.17;
        dynOk = 0;
      }
    }
    k = k < 0.5 ? 0.5 : k > 1.7 ? 1.7 : k;
    const top = min(PIXMAX, DW * DH);
    const was = pix;
    pix *= k;
    pix = pix < PIXMIN ? PIXMIN : pix > top ? top : pix;
    if (was !== pix && !LVQ) keep('paperskies', [LV, pix < top ? pix | 0 : '']);
    dynN = dynT = dynG = dynGN = 0;
    resize();
  }
  if (paused) dt = 0;
  F[TOD] += (dt * TAU * dayRate(F[TOD]) * (hurry ? 24 : 1)) / CYCLE;
  // touch: holding the finger away from where it went down steers like a joystick
  if (tId >= 0) {
    const tr = 4 / (innerWidth < innerHeight ? innerWidth : innerHeight);
    FS[STX] = clamp((tx - tx0) * tr, -1, 1);
    FS[STY] = clamp(-(ty - ty0) * tr, -1, 1);
  }
  FS[STX] = clamp(FS[STX] + mdx * 0.004, -1, 1);
  FS[STY] = clamp(FS[STY] - mdy * 0.004, -1, 1);
  mdx = mdy = 0;
  FS[ACC] += dt;
  for (let n = 0; FS[ACC] >= DT && n < 14; n++) {
    controls();
    FS[ACC] -= DT;
  }
  if (FS[ACC] >= DT) FS[ACC] = 0;
  chase(dt, auto || menu);
  render();
  if (hud) {
    hN++;
    if (dtr > hMax) hMax = dtr;
    if (dtr < hMin) hMin = dtr;
    if (dtr > hPer * 1.5) {
      hLate++;
      hTot++;
    }
    F[HUDT] += dtr / 1000;
    if (F[HUDT] > 0.5) {
      info.textContent = `${(hN / F[HUDT]).toFixed(0)} fps  ·  worst frame ${hMax.toFixed(1)} ms  ·  late frames ${hLate} (total ${hTot})  ·  GPU ${F[GPU].toFixed(2)} ms  ·  ${W}x${H} (${((W * 100) / DW) | 0}%)`;
      F[HUDT] = 0;
      hPer = hMin;
      hN = 0;
      hMax = 0;
      hMin = 1e9;
      hLate = 0;
    }
  }
}

// ---------------------------------------------------------------- input
const toastEl = $('t');
let toastT = 0;
const toast = (s) => {
  toastEl.textContent = s;
  toastEl.className = 'on';
  clearTimeout(toastT);
  toastT = setTimeout(() => (toastEl.className = ''), 1600);
};
let switching = false;
const setMode = (fly, quiet) => {
  if (auto === !fly) return;
  auto = !fly;
  FS[STX] = FS[STY] = 0;
  if (auto) pickGoal();
  if (!quiet) toast(fly ? 'Fly' : 'Autopilot');
  if (!mob && !menu) {
    switching = true;
    if (fly) capture();
    else document.exitPointerLock();
    setTimeout(() => (switching = false), 300);
  }
};
const STEER = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
const key = (e, v) => {
  switch (e.code) {
    case 'KeyW':
    case 'ArrowUp':
      kf = v;
      break;
    case 'KeyS':
    case 'ArrowDown':
      kb = v;
      break;
    case 'KeyA':
    case 'ArrowLeft':
      kl = v;
      break;
    case 'KeyD':
    case 'ArrowRight':
      kr = v;
      break;
    case 'ShiftLeft':
    case 'ShiftRight':
      ks = v;
      break;
    case 'KeyT':
      hurry = v;
      break;
    default:
      if (v && !e.repeat) {
        if (e.code === 'KeyH') {
          hud = !hud;
          hTot = 0;
          hPer = 1e9;
          info.textContent = '';
        } else if (e.code === 'KeyM') mute();
        else if (e.code === 'Escape') ui(true);
        else if (e.code === 'Tab') setMode(auto);
      }
  }
  // steering while on autopilot takes the controls
  if (v && auto && !menu && STEER.includes(e.code)) setMode(true);
};
// behind the menu only the stats and mute keys work
addEventListener('keydown', (e) => {
  if (e.code === 'Tab') e.preventDefault();
  if (menu && e.code !== 'KeyH' && e.code !== 'KeyM') return;
  sound();
  key(e, 1);
});
addEventListener('keyup', (e) => key(e, 0));
const release = () => {
  kf = kb = kl = kr = ks = hurry = 0;
  tId = -1;
  tN = 0;
};
const capture = () => {
  sound();
  const p = canvas.requestPointerLock({ unadjustedMovement: true });
  if (p?.catch) p.catch(() => canvas.requestPointerLock()).catch(() => 0);
};
canvas.addEventListener('click', () => {
  if (!auto) capture();
});
// with the mouse still for 3 s, the cursor and the menu button fade away so the view is all world
let idleT = 0;
const wake = () => {
  body.classList.remove('z');
  clearTimeout(idleT);
  idleT = setTimeout(() => menu || body.classList.add('z'), 3000);
};
addEventListener('mousemove', (e) => {
  wake();
  if (document.pointerLockElement === canvas) {
    mdx += e.movementX;
    mdy += e.movementY;
  }
});
addEventListener('blur', release);
// every touch brings the faded menu button back and steers at once (a touch is never swallowed: on a phone the
// controls are faded nearly every time a finger goes down). The stick is measured from where the finger went
// down, so a tap on its own doesn't move the plane.
const touch = (e) => {
  e.preventDefault();
  wake();
  sound();
  tN = e.touches.length;
  if (auto && tN && !menu) setMode(true);
  let f = null;
  let first = false;
  for (let i = 0; i < tN; i++) if (e.touches[i].identifier === tId) f = e.touches[i];
  if (!f) {
    tId = -1;
    if (tN) {
      f = e.touches[0];
      tId = f.identifier;
      first = true;
    } else FS[STX] = FS[STY] = 0;
  }
  if (f) {
    const x = rot.matches ? f.clientY : f.clientX;
    const y = rot.matches ? -f.clientX : f.clientY;
    if (first) {
      tx0 = x;
      ty0 = y;
    }
    tx = x;
    ty = y;
  }
};
for (const n of ['touchstart', 'touchmove', 'touchend', 'touchcancel']) canvas.addEventListener(n, touch, { passive: false });

// ---------------------------------------------------------------- menu
// The scene keeps flying on autopilot (softened by CSS) behind the menu.
const bFly = $('fly');
const ui = (m) => {
  if (dead) return;
  menu = m;
  body.className = m ? 'm' : document.pointerLockElement ? 'g p' : 'g';
  if (m) {
    release();
    if (document.pointerLockElement) {
      switching = true;
      document.exitPointerLock();
      setTimeout(() => (switching = false), 300);
    }
    setTimeout(() => menu && bFly.focus(), 100);
  } else {
    document.activeElement.blur();
    wake();
  }
};
const go = (fly) => {
  sound();
  ui(false);
  if (auto === fly) {
    auto = !fly;
    FS[STX] = FS[STY] = 0;
    if (auto) pickGoal();
  }
  toast(fly ? 'Fly' : 'Autopilot');
  if (mob)
    document.documentElement
      .requestFullscreen?.()
      ?.then(() => screen.orientation.lock('landscape'))
      .catch(() => 0);
  else if (fly) capture();
};
bFly.onclick = () => go(true);
$('auto').onclick = () => go(false);
$('o').onclick = () => ui(true);
$('q')
  .querySelectorAll('button')
  .forEach((b, i) => {
    if (i === 2 - LV) b.className = 'on';
    else
      b.onclick = () => {
        keep('paperskies', 2 - i);
        location.reload();
      };
  });
document.addEventListener('pointerlockchange', () => {
  if (document.pointerLockElement) body.className = 'g p';
  else if (!switching && !auto && !menu) ui(true);
  else if (!menu) {
    body.className = 'g';
    wake();
  }
});

// first frame: the plane off the southern shore in the late afternoon, heading for the mountain
F[TOD] = 2.55;
// the autopilot takes a different route on every visit
apSeed = (Math.random() * 4294967296) | 0;
placePlane(-60, 48, 900, atan2(-160, -940));
pickGoal();
FS[CT] = 0;
for (let i = 0; i < 240; i++) {
  controls();
  chase(DT, true);
}
await say('Letting the light in…', 1, 400);
daylight(F[TOD]);
render();
shadowsNow();
await Q.onSubmittedWorkDone();
setTimeout(keep, 15e3, 'paperskiesLoad', '');
ui(true);
requestAnimationFrame((t) => {
  F[LAST] = t;
  requestAnimationFrame(frame);
});
