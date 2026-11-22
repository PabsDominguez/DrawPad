import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findRoot, paths, ensureDirs, codeStamp, preferredPort } from './project.ts';
import { Store } from './store.ts';
import { hookLine } from './report.ts';

const HELP = `drawpad: shared visual board for a human and an agent

  board [--section S] [--since REV]       compact outline ("unchanged" if nothing moved)
  add image|text|link <path|text|url|-> --key K [--title T] [--section S]
      [--below K | --right-of K | --in-row-with K | --at x,y] [--width W] [--height H]
      [--note N] [--commit C] [--launch L] [--files a,b]   same key = new version
  add --many items.json                   [{kind,key,path|text|url,section,...}]
  capture sim --key K [--bundle ID --launch "args"] [--wait S] [add flags]
      simulator screenshot -> image item; --bundle relaunches the app with --launch first
  drop <key> [--version N]                remove one version (default latest)
  feedback [--since REV] [--crops] [--json]   sent human feedback, marks it delivered
  crop <comment>                          path of a comment's crop png
  reply <comment> "text"     done <comment> [--artifact K]
  arrow <from> <to> [--point x,y] [--label L]
  section "Title" [keys...]  move <key> --at x,y  archive|restore <key>
  hook                       one line when feedback waits (UserPromptSubmit hook)
  wait [--timeout S]         blocks until feedback waits and the human paused ~8s
  open                       board in its own window      app   make a Dock/Spotlight launcher
  serve [--port P]  url  stats`;

const BOOL = new Set(['crops', 'json', 'help', 'quiet']);
const argv = process.argv.slice(2);
const pos: string[] = [];
const fl: Record<string, string | true> = {};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) {
    const [k, v] = a.slice(2).split(/=(.*)/s);
    fl[k] = v !== undefined ? v : BOOL.has(k) ? true : (argv[++i] ?? '');
  } else pos.push(a);
}
const str = (k: string) => (typeof fl[k] === 'string' ? (fl[k] as string) : undefined);
const num = (k: string) => (str(k) !== undefined ? Number(str(k)) : undefined);
const pair = (k: string) => { const s = str(k); if (!s) return undefined; const [a, b] = s.split(',').map(Number); return [a, b] as [number, number]; };

const verb = pos.shift() ?? 'help';
const root = findRoot() ?? process.cwd();

function out(text: string) {
  if (text) process.stdout.write(text.endsWith('\n') ? text : text + '\n');
  try { fs.appendFileSync(paths(root).stats, JSON.stringify({ v: verb, c: text.length }) + '\n'); } catch { /* no .drawpad yet */ }
}
function fail(msg: string): never { process.stderr.write(msg + '\n'); process.exit(1); }

async function ping(port: number): Promise<{ stamp?: number } | null> {
  try { const r = await fetch(`http://127.0.0.1:${port}/api/ping`, { signal: AbortSignal.timeout(400) }); return r.ok ? await r.json() : null; } catch { return null; }
}

// Returns the base URL of this project's server, starting it on demand
// (and restarting it when the drawpad code changed since it started).
async function server(): Promise<string> {
  const p = ensureDirs(root);
  if (fs.existsSync(p.server)) {
    const { port, pid } = JSON.parse(fs.readFileSync(p.server, 'utf8'));
    const info = await ping(port);
    if (info && info.stamp === codeStamp()) return `http://127.0.0.1:${port}`;
    if (info) { try { process.kill(pid); } catch { /* gone */ } await new Promise(r => setTimeout(r, 200)); }
    fs.rmSync(p.server, { force: true });
  }
  const log = fs.openSync(p.log, 'a');
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', fileURLToPath(import.meta.url), 'serve', '--quiet', '--port', String(preferredPort(root))], { cwd: root, detached: true, stdio: ['ignore', log, log] });
  child.unref();
  for (let i = 0; i < 50; i++) {
    await new Promise(r => setTimeout(r, 100));
    if (fs.existsSync(p.server)) {
      const { port } = JSON.parse(fs.readFileSync(p.server, 'utf8'));
      if (await ping(port)) return `http://127.0.0.1:${port}`;
    }
  }
  fail(`server did not start; see ${p.log}`);
}

async function api(route: string, payload?: unknown): Promise<string> {
  const base = await server();
  const r = await fetch(base + route, payload === undefined ? {} : { method: 'POST', body: JSON.stringify(payload) });
  const t = await r.text();
  if (!r.ok) fail(t);
  return t;
}
const op = (o: Record<string, unknown>) => api('/api/op', o);

function source() {
  if (!str('commit') && !str('launch') && !str('files')) return undefined;
  let commit = str('commit');
  if (!commit) try { commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* not a repo */ }
  return { commit, launch: str('launch'), files: str('files')?.split(',') };
}

function addArgs(kind: string, src?: string) {
  const a: Record<string, unknown> = {
    kind, key: str('key'), title: str('title'), section: str('section'), at: pair('at'),
    below: str('below'), rightOf: str('right-of'), inRowWith: str('in-row-with'),
    width: num('width'), height: num('height'), note: str('note'), color: str('color'), source: source(), by: 'agent',
  };
  if (kind === 'image') { if (!src) fail('add image needs a path'); a.path = path.resolve(src); }
  else if (kind === 'link') a.url = src;
  else if (kind === 'text') a.text = src === '-' ? fs.readFileSync(0, 'utf8') : src && fs.existsSync(src) ? fs.readFileSync(src, 'utf8') : src ?? '';
  else fail(`unknown kind ${kind} (image|text|link; mockup comes in step 2)`);
  return a;
}

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
// Own window without tabs or address bar (Chrome app mode); a plain browser tab if Chrome is missing.
function openWindow(url: string) {
  if (!fs.existsSync(CHROME)) return void execFileSync('open', [url]);
  spawn(CHROME, [`--app=${url}`], { detached: true, stdio: 'ignore' }).unref();
}

// ~/Applications/DrawPad <Project>.app: a launcher for Spotlight and the Dock.
function makeApp(): string {
  if (!findRoot()) fail('run this inside a project with a .drawpad folder');
  const name = `DrawPad ${path.basename(root)}`;
  const app = path.join(os.homedir(), 'Applications', `${name}.app`);
  const macos = path.join(app, 'Contents', 'MacOS');
  fs.mkdirSync(macos, { recursive: true });
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  fs.writeFileSync(path.join(macos, 'launch'), `#!/bin/sh\ncd ${q(root)} && exec ${q(process.execPath)} --disable-warning=ExperimentalWarning ${q(fileURLToPath(import.meta.url))} open\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(app, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleName</key><string>${name}</string>
<key>CFBundleIdentifier</key><string>local.drawpad.${path.basename(root).replace(/[^\w]/g, '')}</string>
<key>CFBundleExecutable</key><string>launch</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>LSUIElement</key><true/>
</dict></plist>
`);
  return `${app}\nOpen it from Spotlight ("${name}") or drag it to the Dock.`;
}

async function main() {
  if (fl.help || verb === 'help') return out(HELP);
  switch (verb) {
    case 'serve': {
      const { serve } = await import('./server.ts');
      const port = await serve(root, num('port') ?? 0);
      if (!fl.quiet) console.log(`DrawPad for ${root}\nhttp://127.0.0.1:${port}/`);
      return;
    }
    case 'url': return out(await server() + '/');
    case 'open': { const u = await server() + '/'; openWindow(u); return out(u); }
    case 'app': return out(makeApp());
    case 'board': {
      const q = new URLSearchParams();
      if (str('since')) q.set('since', str('since')!);
      if (str('section')) q.set('section', str('section')!);
      return out(await api('/api/text/board?' + q));
    }
    case 'add': {
      if (str('many')) {
        const file = str('many')!; // paths inside resolve against the current folder
        const items = JSON.parse(fs.readFileSync(file, 'utf8')).map((x: Record<string, unknown>) =>
          ({ by: 'agent', ...x, path: x.path ? path.resolve(String(x.path)) : undefined }));
        return out(await op({ op: 'many', items }));
      }
      const kind = pos.shift();
      if (!kind) fail('add image|text|link <src> --key K');
      return out(await op({ op: 'add', ...addArgs(kind, pos.shift()) }));
    }
    case 'capture': {
      if (pos[0] !== 'sim') fail('capture sim --key K (capture url comes in step 4)');
      const bundle = str('bundle');
      if (bundle) {
        try { execFileSync('xcrun', ['simctl', 'terminate', 'booted', bundle], { stdio: 'ignore' }); } catch { /* not running */ }
        execFileSync('xcrun', ['simctl', 'launch', 'booted', bundle, ...(str('launch')?.split(/\s+/).filter(Boolean) ?? [])], { stdio: 'ignore' });
      }
      const wait = num('wait') ?? (bundle ? 2 : 0);
      if (wait) await new Promise(r => setTimeout(r, wait * 1000));
      const tmp = path.join(os.tmpdir(), `drawpad-sim-${Date.now()}.png`);
      execFileSync('xcrun', ['simctl', 'io', 'booted', 'screenshot', tmp], { stdio: 'ignore' });
      const res = await op({ op: 'add', ...addArgs('image', tmp) });
      fs.rmSync(tmp, { force: true });
      return out(res);
    }
    case 'feedback': return out(await api('/api/feedback', { since: num('since'), crops: !!fl.crops, json: !!fl.json }));
    case 'crop': {
      const b = JSON.parse(await api('/api/board'));
      const it = b.items.find((i: { key: string; id: string }) => i.key === pos[0] || i.id === pos[0]);
      if (!it?.comment?.crop) fail(`no crop for ${pos[0]}`);
      return out(`.drawpad/assets/${it.comment.crop}`);
    }
    case 'drop': return out(await op({ op: 'drop', id: pos[0], version: num('version') }));
    case 'reply': return out(await op({ op: 'reply', id: pos[0], text: pos.slice(1).join(' '), by: 'agent' }));
    case 'done': return out(await op({ op: 'done', id: pos[0], artifact: str('artifact') }));
    case 'arrow': return out(await op({ op: 'arrow', from: pos[0], to: pos[1], toPoint: pair('point'), label: str('label'), by: 'agent' }));
    case 'section': return out(await op({ op: 'section', title: pos[0], keys: pos.slice(1) }));
    case 'move': {
      const at = pair('at'); if (!at) fail('move <key> --at x,y');
      return out(await op({ op: 'move', id: pos[0], x: at[0], y: at[1], w: num('width'), h: num('height'), by: 'agent' }));
    }
    case 'archive': case 'restore': return out(await op({ op: verb, id: pos[0] }));
    case 'hook': {
      // Reads the file directly: fast, never starts a server, silent when nothing waits.
      if (!findRoot()) return;
      return out(hookLine(new Store(root).pending()));
    }
    case 'wait': return out(await api(`/api/wait?timeout=${num('timeout') ?? 0}`));
    case 'shot': return fail('shot needs the headless renderer (build step 2); use `drawpad board` for now');
    case 'stats': {
      const f = paths(root).stats;
      if (!fs.existsSync(f)) return out('no stats yet');
      const agg: Record<string, { n: number; sum: number; max: number }> = {};
      for (const l of fs.readFileSync(f, 'utf8').trim().split('\n')) {
        const { v, c } = JSON.parse(l); const t = Math.ceil(c / 4);
        const a = (agg[v] ??= { n: 0, sum: 0, max: 0 }); a.n++; a.sum += t; a.max = Math.max(a.max, t);
      }
      return process.stdout.write(Object.entries(agg).map(([v, a]) => `${v}: ${a.n} calls, ~${Math.round(a.sum / a.n)} tok avg, ${a.max} max`).join('\n') + '\n');
    }
    default: fail(`unknown command ${verb}\n\n${HELP}`);
  }
}

main().catch(e => fail(String(e?.message ?? e)));
