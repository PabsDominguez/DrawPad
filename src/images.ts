import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
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

// Agent designs (HTML or SVG) rendered to PNG at 2x by one hidden headless Chrome that stays running (driven over
// the DevTools protocol), so renders don't launch Chrome each time. Each render gets its own tab with the exact
// viewport size. Probes (src/probe.js) run in that tab: size, checks, element under a pin, outline.
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PROBE = fs.readFileSync(new URL('./probe.js', import.meta.url), 'utf8');
const IDLE_MS = 10 * 60_000;

interface Cdp { send(method: string, params?: object, session?: string): Promise<any>; once(session: string, method: string, ms: number): Promise<any>; close(): void }
let browser: Promise<Cdp> | null = null, idleT: NodeJS.Timeout | undefined;

function launch(): Promise<Cdp> {
  if (!fs.existsSync(CHROME)) throw new Error('rendering designs needs Google Chrome');
  // One profile per project server (a profile can't be shared by two running Chromes); kept, so later starts are fast.
  const profile = path.join(os.homedir(), 'Library', 'Application Support', 'DrawPad', 'render', createHash('md5').update(process.cwd()).digest('hex').slice(0, 10));
  const proc = spawn(CHROME, ['--headless=new', `--user-data-dir=${profile}`, '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check',
    '--hide-scrollbars', '--allow-file-access-from-files', '--mute-audio', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const kill = () => { try { proc.kill(); } catch { /* gone */ } };
  process.once('exit', kill);
  return new Promise((ok, bad) => {
    let err = '';
    const t = setTimeout(() => { kill(); bad(new Error('Chrome did not start: ' + err.slice(-300))); }, 20000);
    proc.on('exit', () => { browser = null; });
    proc.stderr!.on('data', d => {
      err += d;
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(err);
      if (!m || err === '') return;
      err = '';
      clearTimeout(t);
      const ws = new WebSocket(m[1]);
      let n = 0;
      const pend = new Map<number, [(v: any) => void, (e: Error) => void]>(), waits: { s: string; m: string; f: (v: any) => void }[] = [];
      ws.onmessage = e => {
        const d = JSON.parse(String(e.data));
        if (d.id) { const p = pend.get(d.id); pend.delete(d.id); if (d.error) p?.[1](new Error(d.error.message)); else p?.[0](d.result); return; }
        for (const w of waits.filter(w => w.m === d.method && w.s === d.sessionId)) { waits.splice(waits.indexOf(w), 1); w.f(d.params); }
      };
      ws.onopen = () => ok({
        send: (method, params = {}, sessionId) => new Promise((r, j) => { const id = ++n; pend.set(id, [r, j]); ws.send(JSON.stringify({ id, method, params, sessionId })); }),
        once: (s, m2, ms) => new Promise((r, j) => { const w = { s, m: m2, f: r }; waits.push(w); setTimeout(() => { if (waits.includes(w)) { waits.splice(waits.indexOf(w), 1); j(new Error(`timeout waiting for ${m2}`)); } }, ms); }),
        close: () => { ws.close(); kill(); },
      });
      ws.onerror = () => bad(new Error('could not connect to Chrome'));
    });
  });
}

// For one-off use outside the server (the CLI): stop the hidden Chrome so the process can exit.
export async function closeRenderer() { if (browser) (await browser.catch(() => null))?.close(); browser = null; clearTimeout(idleT); }

// A fresh tab of exactly w x h CSS px at 2x, showing url; fn runs with that tab's session.
async function withPage<T>(url: string, w: number, h: number, fn: (S: (m: string, p?: object) => Promise<any>) => Promise<T>): Promise<T> {
  browser ??= launch().catch(e => { browser = null; throw e; });
  const c = await browser;
  clearTimeout(idleT);
  const { targetId } = await c.send('Target.createTarget', { url: 'about:blank' });
  try {
    const { sessionId } = await c.send('Target.attachToTarget', { targetId, flatten: true });
    const S = (m: string, p?: object) => c.send(m, p, sessionId);
    await S('Page.enable');
    await S('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: false });
    const loaded = c.once(sessionId, 'Page.loadEventFired', 15000);
    await S('Page.navigate', { url });
    await loaded;
    return await fn(S);
  } finally {
    c.send('Target.closeTarget', { targetId }).catch(() => {});
    idleT = setTimeout(() => { c.close(); browser = null; }, IDLE_MS);
    idleT.unref();
  }
}
async function probe(S: (m: string, p?: object) => Promise<any>, call: string): Promise<any> {
  const r = await S('Runtime.evaluate', { expression: `(async()=>{${PROBE}\nconst d=document;await d.fonts.ready;await new Promise(r=>setTimeout(r,150));return ${call}})()`, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error('probe: ' + (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text));
  return r.result.value;
}

export async function renderHtml(src: string, outPng: string, w: number, h?: number): Promise<{ w: number; h: number; warn: string[] }> {
  let url = pathToFileURL(src).href, tmp: string | undefined;
  if (src.toLowerCase().endsWith('.svg')) {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drawpad-r-'));
    const f = path.join(tmp, 'svg.html');
    fs.writeFileSync(f, `<!doctype html><base href="${pathToFileURL(path.dirname(src)).href}/"><style>html,body{margin:0}svg{display:block;width:100vw;height:auto}</style>${fs.readFileSync(src, 'utf8')}`);
    url = pathToFileURL(f).href;
  }
  try {
    return await withPage(url, w, h ?? 800, async S => {
      // SVGs (icons, logos) keep their transparency; HTML pages get the browser's usual white.
      if (tmp) await S('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
      const got: { m: { h: number; sw: number; fails: string[] }; c: string[] } = await probe(S, '{m:measure(d),c:checks(d)}');
      const warn: string[] = [];
      if (h && got.m.h > h + 1) warn.push(`content is ${got.m.h}px tall, cut at --height ${h}`);
      if (got.m.sw > w + 1) warn.push(`content is ${got.m.sw}px wide, cut at ${w}`);
      if (got.m.fails.length) warn.push(`fonts failed to load: ${got.m.fails.join(', ')}`);
      warn.push(...got.c);
      const hh = h ?? Math.min(16000, Math.max(50, got.m.h));
      if (hh !== (h ?? 800)) { await S('Emulation.setDeviceMetricsOverride', { width: w, height: hh, deviceScaleFactor: 2, mobile: false }); await new Promise(r => setTimeout(r, 150)); }
      const shot = await S('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(outPng, Buffer.from(shot.data, 'base64'));
      const size = imageSize(outPng);
      if (size && (size[0] !== w * 2 || size[1] !== hh * 2)) warn.push(`snapshot is ${size[0] / 2}x${size[1] / 2}, asked ${w}x${hh}`);
      return { w, h: hh, warn };
    });
  } finally { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); }
}

// Runs a probe (src/probe.js expression over `d`) on a stored design (assets/*.html, whose <base> points at /p/).
export async function probeDesign(htmlAsset: string, root: string, w: number, h: number, call: string): Promise<unknown> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drawpad-r-')), f = path.join(tmp, 'd.html');
  fs.writeFileSync(f, fs.readFileSync(htmlAsset, 'utf8').replace(/<base href="\/p\//, `<base href="${pathToFileURL(root).href}/`));
  try { return await withPage(pathToFileURL(f).href, w, h, S => probe(S, call)); }
  finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

// Size an SVG asks for (width/height or viewBox), for its default board size.
export function svgSize(src: string): [number, number] | null {
  const head = fs.readFileSync(src, 'utf8').slice(0, 2000);
  const n = (a: string) => { const m = new RegExp(`<svg[^>]*\\s${a}="([\\d.]+)(px)?"`).exec(head); return m ? Number(m[1]) : 0; };
  if (n('width') && n('height')) return [n('width'), n('height')];
  const vb = /<svg[^>]*viewBox="[\d.\s-]*?([\d.]+)[\s,]+([\d.]+)"/.exec(head);
  return vb ? [Number(vb[1]), Number(vb[2])] : null;
}
