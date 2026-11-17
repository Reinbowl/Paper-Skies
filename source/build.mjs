// Bundles src/*.js into the single self-contained ../index.html
//   npm run build            minified
//   npm run build:readable   unminified, for debugging
//   npm run build:dev        ../dev.html: unminified, plus the development tools in src/dev.js
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { transformSync } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
// concatenation order matters
const FILES = ['quality.js', 'math.js', 'sky.js', 'shaders.js', 'world.js', 'plane.js', 'main.js', 'audio.js'];
const dev = process.argv.includes('--dev');
const readable = dev || process.argv.includes('--readable');
const out = dev ? 'dev.html' : 'index.html';
if (dev) FILES.push('dev.js');

let js = FILES.map((f) => readFileSync(path.join(here, 'src', f), 'utf8')).join('\n');
// the music, embedded as base64 (see audio.js)
const music = path.join(here, 'music.m4a');
js = js.replace("'/*MUSIC*/'", () => JSON.stringify(existsSync(music) ? readFileSync(music).toString('base64') : ''));
// the paper plane icon for browser tabs, phones and home screens (source/icons), embedded so the page stays one file
const icon = (f) => readFileSync(path.join(here, 'icons', f));
const png = (f) => 'data:image/png;base64,' + icon(f).toString('base64');
const icons = [
  `<link rel=icon type=image/png sizes=32x32 href="${png('icon-32.png')}">`,
  `<link rel=icon type=image/png sizes=192x192 href="${png('icon-192.png')}">`,
  `<link rel=icon type=image/svg+xml href="data:image/svg+xml,${encodeURIComponent(icon('icon.svg').toString().trim())}">`,
  `<link rel=apple-touch-icon href="${png('apple-touch-icon.png')}">`,
].join('\n');
const tpl = readFileSync(path.join(here, 'template.html'), 'utf8').replace('<!--ICONS-->', () => icons);
// everything runs inside one async function; startup errors are shown on screen
const wrap = (body) =>
  `(async()=>{${body}\n})().catch(e=>{console.error(e);document.body.className='l e';document.getElementById('s').textContent=(e.cause?'':'Failed to start: ')+e.message});`;

let html;
if (readable) {
  html = tpl.replace('/*SCRIPT*/', () => wrap(js));
} else {
  // shrink the WGSL inside /*wgsl*/ template literals, then minify the JS and the page's CSS
  const minWgsl = (s) =>
    s
      .replace(/\/\/[^\n]*/g, '')
      .replace(/\s+/g, ' ')
      .replace(/ ?([{}()[\];,:=+\-*/<>&|!%@]) ?/g, '$1')
      .trim();
  js = js.replace(/\/\*wgsl\*\/`([^`]*)`/g, (_, w) => '`' + minWgsl(w) + '`');
  const code = transformSync(wrap(js), { minify: true, target: 'es2022', legalComments: 'none' }).code.trim();
  const css = (_, s) => '<style>' + transformSync(s, { loader: 'css', minify: true }).code.trim();
  html = tpl
    .replace(/<style>([\s\S]*?)(?=<\/style>)/, css)
    .replace(/>\s+</g, '><')
    .replace('/*SCRIPT*/', () => code)
    .replace(/<script>\s+/, '<script>')
    .replace(/\s+<\/script>/, '</script>');
}
writeFileSync(path.join(here, '..', out), html);
const gz = gzipSync(Buffer.from(html), { level: 9 }).length;
console.log(`${out}: ${(html.length / 1024).toFixed(1)} kB${readable ? ' (readable)' : ''}, ${(gz / 1024).toFixed(1)} kB gzipped`);
