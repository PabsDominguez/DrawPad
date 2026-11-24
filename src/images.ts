import { execFile, execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

// Image size and thumbnails via macOS `sips` (built in, no dependency).
// Falls back gracefully when sips is unavailable.

export function imageSize(file: string): [number, number] | null {
  try {
    const out = execFileSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', file], { encoding: 'utf8' });
    const w = /pixelWidth:\s*(\d+)/.exec(out), h = /pixelHeight:\s*(\d+)/.exec(out);
    return w && h ? [Number(w[1]), Number(h[1])] : null;
  } catch { return null; }
}

export const THUMB_W = 640;

// Writes a JPEG thumbnail next to the asset; returns its file name or undefined.
export function makeThumb(file: string, pw: number): string | undefined {
  if (pw <= THUMB_W * 1.4) return undefined;
  const out = file.replace(/\.[^.]+$/, '') + '.thumb.jpg';
  try {
    execFileSync('sips', ['--resampleWidth', String(THUMB_W), '-s', 'format', 'jpeg', '-s', 'formatOptions', '80', file, '--out', out], { stdio: 'ignore' });
    return path.basename(out);
  } catch { return undefined; }
}

// Agent designs (HTML or SVG) rendered to PNG by headless Chrome at 2x. No height = the page's full height.
// The design sits in an iframe of exactly its width (headless windows are at least 500 wide), centred, then cropped
// (sips crops around the centre). Probes (src/probe.js) run in the same page and report back through the title.
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
// Kept between renders: a fresh Chrome profile costs ~3s.
const PROFILE = path.join(os.homedir(), 'Library', 'Application Support', 'DrawPad', 'render');
const PROBE = fs.readFileSync(new URL('./probe.js', import.meta.url), 'utf8');

function page(tmp: string, inner: string, w: number, h: number, call?: string): string[] {
  const js = call ? `<script>${PROBE}\nf.onload=async()=>{try{const d=f.contentDocument;await d.fonts.ready;document.title='M'+encodeURIComponent(JSON.stringify(${call}))}catch(e){document.title='E'+encodeURIComponent(String(e))}}</script>` : '';
  const file = path.join(tmp, 'p.html');
  fs.writeFileSync(file, `<!doctype html><style>html,body{margin:0;overflow:hidden}</style><iframe id=f src="${inner}" style="border:0;display:block;margin:0 auto;width:${w}px;height:${h}px"></iframe>${js}`);
  return ['--headless=new', `--user-data-dir=${PROFILE}`, '--hide-scrollbars', '--no-first-run', '--allow-file-access-from-files',
    '--virtual-time-budget=1000', `--window-size=${Math.max(w, 500)},${h}`, ...(call ? ['--dump-dom'] : []), pathToFileURL(file).href];
}
const result = (dom: string) => {
  const m = /<title>([ME])([^<]+)<\/title>/.exec(dom);
  if (!m) return null;
  if (m[1] === 'E') throw new Error('probe: ' + decodeURIComponent(m[2]));
  return JSON.parse(decodeURIComponent(m[2]));
};
const OPTS = { encoding: 'utf8' as const, timeout: 30000, maxBuffer: 64e6 };
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'drawpad-r-'));

export function renderHtml(src: string, outPng: string, w: number, h?: number): { w: number; h: number; warn: string[] } {
  if (!fs.existsSync(CHROME)) throw new Error('rendering designs needs Google Chrome');
  const tmp = tmpDir();
  try {
    let inner = pathToFileURL(src).href;
    if (src.toLowerCase().endsWith('.svg')) {
      const f = path.join(tmp, 'svg.html');
      fs.writeFileSync(f, `<!doctype html><base href="${pathToFileURL(path.dirname(src)).href}/"><style>html,body{margin:0}svg{display:block;width:100vw;height:auto}</style>${fs.readFileSync(src, 'utf8')}`);
      inner = pathToFileURL(f).href;
    }
    // One probe pass: size + checks (layout below the 800px viewport is still real), then the screenshot.
    const run = (hh: number, call: string) => result(execFileSync(CHROME, page(tmp, inner, w, hh, call), { ...OPTS, stdio: ['ignore', 'pipe', 'ignore'] }));
    const got: { m: { h: number; sw: number; fails: string[] }; c: string[] } | null = run(h ?? 800, '{m:measure(d),c:checks(d)}');
    const warn: string[] = [];
    if (got && h && got.m.h > h + 1) warn.push(`content is ${got.m.h}px tall, cut at --height ${h}`);
    if (!h) h = Math.min(20000, Math.max(50, got?.m.h ?? 800));
    if (got && got.m.sw > w + 1) warn.push(`content is ${got.m.sw}px wide, cut at ${w}`);
    if (got?.m.fails.length) warn.push(`fonts failed to load: ${got.m.fails.join(', ')}`);
    warn.push(...(got?.c ?? []));
    execFileSync(CHROME, page(tmp, inner, w, h).toSpliced(-1, 0, `--screenshot=${outPng}`, '--force-device-scale-factor=2'), { stdio: 'ignore', timeout: 30000 });
    if (!fs.existsSync(outPng)) throw new Error('Chrome did not render the design');
    if (w < 500) execFileSync('sips', ['-c', String(h * 2), String(w * 2), outPng], { stdio: 'ignore' });
    const size = imageSize(outPng);
    if (size && (size[0] !== w * 2 || size[1] !== h * 2)) warn.push(`snapshot is ${size[0] / 2}x${size[1] / 2}, asked ${w}x${h}`);
    return { w, h, warn };
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

// Runs a probe (src/probe.js expression over `d`) on a stored design (assets/*.html, whose <base> points at /p/).
export function probeDesign(htmlAsset: string, root: string, w: number, h: number, call: string): Promise<unknown> {
  const tmp = tmpDir(), f = path.join(tmp, 'd.html');
  fs.writeFileSync(f, fs.readFileSync(htmlAsset, 'utf8').replace(/<base href="\/p\//, `<base href="${pathToFileURL(root).href}/`));
  return new Promise((ok, bad) => execFile(CHROME, page(tmp, pathToFileURL(f).href, w, h, call), OPTS, (e, out) => {
    fs.rmSync(tmp, { recursive: true, force: true });
    if (e) return bad(e);
    try { ok(result(out)); } catch (x) { bad(x); }
  }));
}

// Size an SVG asks for (width/height or viewBox), for its default board size.
export function svgSize(src: string): [number, number] | null {
  const head = fs.readFileSync(src, 'utf8').slice(0, 2000);
  const n = (a: string) => { const m = new RegExp(`<svg[^>]*\\s${a}="([\\d.]+)(px)?"`).exec(head); return m ? Number(m[1]) : 0; };
  if (n('width') && n('height')) return [n('width'), n('height')];
  const vb = /<svg[^>]*viewBox="[\d.\s-]*?([\d.]+)[\s,]+([\d.]+)"/.exec(head);
  return vb ? [Number(vb[1]), Number(vb[2])] : null;
}
