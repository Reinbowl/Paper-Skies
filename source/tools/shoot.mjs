// Drives Windows Chrome over CDP to take screenshots of the scene (run with Windows node.exe).
//   node shoot.mjs <steps.json> [--headful] [--mobile] [--transparent] [--size 2560x1440] [--port 9333]
// steps.json: { "url": "...", "out": "dir", "steps": [{ "eval"?, "waitFor"?, "sleep"?, "shot"? }] }
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (k, d) => {
  const i = args.indexOf(k);
  return i < 0 ? d : args[i + 1];
};
const cfg = JSON.parse(readFileSync(args[0], 'utf8'));
const [W, H] = opt('--size', '2560x1440').split('x').map(Number);
const port = +opt('--port', 9333);
const headful = args.includes('--headful');
const chrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const flags = [
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${path.join(tmpdir(), 'paperskies-chrome')}`,
  `--window-size=${W},${H}`,
  '--force-device-scale-factor=1',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
  '--autoplay-policy=no-user-gesture-required',
  ...(headful ? [] : ['--headless=new']),
  'about:blank',
];
const proc = spawn(chrome, flags, { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let ws;
for (let i = 0; i < 100 && !ws; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const page = list.find((t) => t.type === 'page');
    if (page) ws = new WebSocket(page.webSocketDebuggerUrl);
  } catch {}
  if (!ws) await sleep(200);
}
if (!ws) throw new Error('Chrome did not start');
await new Promise((r) => ws.addEventListener('open', r));

let nextId = 1;
const pending = new Map();
ws.addEventListener('message', (m) => {
  const d = JSON.parse(m.data);
  if (d.id && pending.has(d.id)) {
    const p = pending.get(d.id);
    pending.delete(d.id);
    d.error ? p.reject(new Error(d.error.message)) : p.resolve(d.result);
  } else if (d.method === 'Runtime.consoleAPICalled') {
    console.log(`[console.${d.params.type}]`, d.params.args.map((a) => a.value ?? a.description).join(' '));
  } else if (d.method === 'Runtime.exceptionThrown') {
    console.log('[exception]', d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text);
  }
});
// every command fails after `limit` ms instead of hanging the run
const send = (method, params = {}, limit = 180000) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    const t = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out`));
    }, limit);
    pending.set(id, {
      resolve: (v) => {
        clearTimeout(t);
        resolve(v);
      },
      reject: (e) => {
        clearTimeout(t);
        reject(e);
      },
    });
    ws.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};

await send('Runtime.enable');
await send('Page.enable');
const mobile = args.includes('--mobile');
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: mobile ? 3 : 1, mobile });
if (mobile) await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
if (args.includes('--transparent')) await send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
await send('Page.navigate', { url: cfg.url });
mkdirSync(cfg.out, { recursive: true });

try {
  for (const s of cfg.steps) {
    if (s.eval) {
      const v = await evaluate(s.eval);
      if (v !== undefined) console.log(typeof v === 'string' ? v : JSON.stringify(v));
    }
    if (s.waitFor) {
      const t0 = Date.now();
      while (!(await evaluate(s.waitFor).catch(() => false))) {
        if (Date.now() - t0 > (s.timeout || 60000)) throw new Error(`timed out waiting for ${s.waitFor}`);
        await sleep(100);
      }
    }
    if (s.tap) {
      const [x, y] = s.tap;
      for (const type of ['touchStart', 'touchEnd'])
        await send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
    }
    if (s.key) {
      const [type, code] = s.key;
      await send('Input.dispatchKeyEvent', { type, code, key: code.replace(/^Key/, '').toLowerCase(), windowsVirtualKeyCode: s.vk || 0 });
    }
    if (s.sleep) await sleep(s.sleep);
    if (s.shot) {
      const r = await send('Page.captureScreenshot', { format: s.shot.endsWith('.jpg') ? 'jpeg' : 'png', quality: 95 });
      writeFileSync(path.join(cfg.out, s.shot), Buffer.from(r.data, 'base64'));
      console.log('shot', s.shot);
    }
  }
} finally {
  // leave the page normally first, so its pagehide handlers run (a killed tab looks like a crash to the next visit)
  await send('Page.navigate', { url: 'about:blank' }, 5000).catch(() => 0);
  await sleep(500);
  ws.close();
  proc.kill();
}
process.exit(0);
