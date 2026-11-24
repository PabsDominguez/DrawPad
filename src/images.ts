import { execFileSync } from 'node:child_process';
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
// (sips crops around the centre).
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
// Kept between renders: a fresh Chrome profile costs ~3s.
const PROFILE = path.join(os.homedir(), 'Library', 'Application Support', 'DrawPad', 'render');
export function renderHtml(src: string, outPng: string, w: number, h?: number): { w: number; h: number; warn: string[] } {
  if (!fs.existsSync(CHROME)) throw new Error('rendering designs needs Google Chrome');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drawpad-r-'));
  try {
    let inner = pathToFileURL(src).href;
    if (src.toLowerCase().endsWith('.svg')) {
      const f = path.join(tmp, 'svg.html');
      fs.writeFileSync(f, `<!doctype html><base href="${pathToFileURL(path.dirname(src)).href}/"><style>html,body{margin:0}svg{display:block;width:100vw;height:auto}</style>${fs.readFileSync(src, 'utf8')}`);
      inner = pathToFileURL(f).href;
    }
    const page = path.join(tmp, 'p.html'), W = Math.max(w, 500);
    const frame = (hh: number, js = '') => fs.writeFileSync(page, `<!doctype html><style>html,body{margin:0;overflow:hidden}</style><iframe id=f src="${inner}" style="border:0;display:block;margin:0 auto;width:${w}px;height:${hh}px"></iframe>${js}`);
    const run = (extra: string[], hh: number) => execFileSync(CHROME, ['--headless=new', `--user-data-dir=${PROFILE}`, '--hide-scrollbars',
      '--no-first-run', '--allow-file-access-from-files', '--virtual-time-budget=1000', `--window-size=${W},${hh}`, ...extra, pathToFileURL(page).href],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30000, maxBuffer: 64e6 });
    // Measuring pass: content height and width, and fonts that failed to load (reported back to the agent).
    const mh = h ?? 800;
    frame(mh, `<script>f.onload=async()=>{try{const d=f.contentDocument,b=d.body,c=f.contentWindow.getComputedStyle(b),r=d.createRange();r.selectNodeContents(b);
      await d.fonts.ready;const fails=[...d.fonts].filter(x=>x.status==='error').map(x=>x.family.replace(/["']/g,''));
      document.title='M'+encodeURIComponent(JSON.stringify({h:Math.ceil(r.getBoundingClientRect().bottom+parseFloat(c.paddingBottom)+parseFloat(c.marginBottom)),sw:Math.max(d.documentElement.scrollWidth,b.scrollWidth),fails:[...new Set(fails)]}))}catch{}}</script>`);
    const m = /<title>M([^<]+)<\/title>/.exec(run(['--dump-dom'], mh));
    const got: { h: number; sw: number; fails: string[] } | null = m ? JSON.parse(decodeURIComponent(m[1])) : null;
    const warn: string[] = [];
    if (got && got.sw > w + 1) warn.push(`content is ${got.sw}px wide, cut at ${w}`);
    if (got && h && got.h > h + 1) warn.push(`content is ${got.h}px tall, cut at --height ${h}`);
    if (got?.fails.length) warn.push(`fonts failed to load: ${got.fails.join(', ')}`);
    if (!h) h = Math.min(20000, Math.max(50, got?.h ?? 800));
    frame(h);
    run([`--screenshot=${outPng}`, '--force-device-scale-factor=2'], h);
    if (!fs.existsSync(outPng)) throw new Error('Chrome did not render the design');
    if (W > w) execFileSync('sips', ['-c', String(h * 2), String(w * 2), outPng], { stdio: 'ignore' });
    return { w, h, warn };
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

// Size an SVG asks for (width/height or viewBox), for its default board size.
export function svgSize(src: string): [number, number] | null {
  const head = fs.readFileSync(src, 'utf8').slice(0, 2000);
  const n = (a: string) => { const m = new RegExp(`<svg[^>]*\\s${a}="([\\d.]+)(px)?"`).exec(head); return m ? Number(m[1]) : 0; };
  if (n('width') && n('height')) return [n('width'), n('height')];
  const vb = /<svg[^>]*viewBox="[\d.\s-]*?([\d.]+)[\s,]+([\d.]+)"/.exec(head);
  return vb ? [Number(vb[1]), Number(vb[2])] : null;
}
