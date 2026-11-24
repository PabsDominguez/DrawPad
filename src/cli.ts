import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findRoot, paths, ensureDirs, codeStamp, preferredPort, projects, remember } from './project.ts';
import { Store } from './store.ts';
import { hookLine } from './report.ts';

const HELP = `drawpad: shared visual board for a human and an agent

  board [--section S] [--since REV]       compact outline ("unchanged" if nothing moved)
  add image|html|text|link <path|text|url|-> --key K [--title T] [--section S]
      html: your .html/.svg file (any design); --width = CSS width (default 1280, then kept),
      height = full page unless --height. Edit the file, re-add same key = new version.
      Link project files (css, fonts, images) by relative path; don't embed base64.
      Result: problems (clipping, fonts, cut text, <11px, contrast, data-tap <44) or "checks ok"
  outline <key> [--boxes]                 a design's visible text (x,y wxh size [b] text); --boxes adds
                                          images and visible boxes [selector bg]
  title <key> "Title"                     rename an item (no new version)
      [--below K | --right-of K | --in-row-with K | --at x,y] [--width W] [--height H]
      [--note N] [--commit C] [--launch L] [--files a,b]   same key = new version
  add --many items.json                   [{kind,key,path|text|url,section,...}]
  capture sim --key K [--bundle ID --launch "args"] [--wait S] [add flags]
      simulator screenshot -> image item; --bundle relaunches the app with --launch first
  drop <key> [--version N]                remove one version (default latest)
  feedback [--since REV] [--crops] [--json] [--section S]   sent human feedback, marks it delivered;
      --section: only feedback about that section (boards shared by several agents)
  crop <comment>                          path of a comment's crop png
  reply <comment> "text"     done <comment> [--artifact K]
  arrow <from> <to> [--point x,y] [--label L]
  section "Title" [keys...]  move <key> --at x,y  archive|restore <key>
  hook [--wait S]            Claude Code hook (UserPromptSubmit, PostToolUse, Stop): tells the agent when
                             sent feedback waits; on Stop, --wait S holds up to S seconds for a Send
  wait [--timeout S] [--feedback] [--section S]   blocks until feedback waits and the human paused ~8s;
      --feedback prints it (= feedback). Run in the background, start again after handling it
  open                       board in its own window
  app                        build ~/Applications/DrawPad.app (native board window, own Dock icon)
  serve [--port P]  url  stats
  tell-dev "..."             DrawPad got in your way or cost you time/tokens? Report it (one point, what you
                             tried, what happened, what would help). Goes to DrawPad's developers.`;

const BOOL = new Set(['crops', 'json', 'help', 'quiet', 'feedback', 'boxes']);
const KNOWN = new Set([...BOOL, 'height', 'port', 'since', 'timeout', 'version', 'wait', 'width', 'at', 'point', 'artifact', 'below', 'bundle',
  'color', 'commit', 'files', 'in-row-with', 'key', 'label', 'launch', 'many', 'note', 'right-of', 'section', 'title']);
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
{ const bad = Object.keys(fl).filter(k => !KNOWN.has(k)); if (bad.length) { process.stderr.write(`unknown flag ${bad.map(b => '--' + b).join(', ')} (see drawpad help)\n`); process.exit(1); } }
const root = findRoot() ?? process.cwd();

function out(text: string) {
  if (text) process.stdout.write(text.endsWith('\n') ? text : text + '\n');
  // Only what lands in the agent's context (open/app/pick/url are run by the launcher and the human too).
  if (!['open', 'app', 'pick', 'url', 'serve'].includes(verb)) try { fs.appendFileSync(paths(root).stats, JSON.stringify({ v: verb, c: text.length }) + '\n'); } catch { /* no .drawpad yet */ }
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
  if (kind === 'image' || kind === 'html') { if (!src) fail(`add ${kind} needs a path`); a.path = path.resolve(src); }
  else if (kind === 'link') a.url = src;
  else if (kind === 'text') a.text = src === '-' ? fs.readFileSync(0, 'utf8') : src && fs.existsSync(src) ? fs.readFileSync(src, 'utf8') : src ?? '';
  else fail(`unknown kind ${kind} (image|html|text|link)`);
  return a;
}

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
// Own window without tabs or address bar (Chrome app mode) in a DrawPad-only Chrome profile: it runs as
// its own instance (own Dock icon, works whether or not the user's Chrome is open). Plain tab if no Chrome.
function openWindow(url: string) {
  if (fs.existsSync(NATIVE)) return void execFileSync('open', ['-a', APP, url]);
  if (!fs.existsSync(CHROME)) return void execFileSync('open', [url]);
  const profile = path.join(os.homedir(), 'Library', 'Application Support', 'DrawPad', 'chrome');
  fs.mkdirSync(profile, { recursive: true });
  // Chrome brings the new window to the front; the page then closes any older window of the same board.
  // Through LaunchServices (`open -n`) so macOS brings it to the front even when started from a launcher.
  execFileSync('open', ['-n', '-a', CHROME.replace(/\/Contents\/.*/, ''), '--args', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', `--app=${url}`]);
}

// `drawpad pick`: choose a project from a small macOS list and open its board.
function pick(): string {
  const list = projects();
  if (!list.length) fail('no DrawPad projects yet: run `drawpad open` inside a project first');
  let chosen = list[0];
  if (list.length > 1) {
    const names = list.map(r => path.basename(r));
    const as = (x: string) => `"${x.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    const res = execFileSync('osascript', ['-e', `choose from list {${names.map(as).join(', ')}} with title "DrawPad" with prompt "Open which board?" default items {${as(names[0])}}`], { encoding: 'utf8' }).trim();
    if (res === 'false') return 'cancelled';
    chosen = list[names.indexOf(res)];
  }
  remember(chosen);
  return execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', fileURLToPath(import.meta.url), 'open'], { cwd: chosen, encoding: 'utf8' }).trim();
}

// ~/Applications/DrawPad.app: one launcher for all projects (Spotlight and the Dock).
// ~/Applications/DrawPad.app: a native window for boards (app/DrawPad.swift, WebKit), its own Dock icon.
// Falls back to Chrome app windows when swiftc (Xcode command line tools) isn't there.
const APP = path.join(os.homedir(), 'Applications', 'DrawPad.app');
const NATIVE = path.join(APP, 'Contents', 'MacOS', 'DrawPad');
const ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><rect x="100" y="100" width="824" height="824" rx="190" fill="#1d1f25"/>
<rect x="250" y="250" width="300" height="400" rx="28" fill="#4c8dff"/><rect x="590" y="250" width="184" height="250" rx="28" fill="#3a3c42"/>
<circle cx="680" cy="660" r="56" fill="#f4c542"/><path d="M640 610 L560 540" stroke="#f4c542" stroke-width="22" stroke-linecap="round"/></svg>`;
async function makeApp(): Promise<string> {
  const c = path.join(APP, 'Contents');
  fs.rmSync(APP, { recursive: true, force: true });
  fs.mkdirSync(path.join(c, 'MacOS'), { recursive: true }); fs.mkdirSync(path.join(c, 'Resources'));
  const src = fileURLToPath(new URL('../app/DrawPad.swift', import.meta.url));
  try { execFileSync('swiftc', ['-O', '-o', NATIVE, src], { stdio: 'pipe' }); }
  catch (e) { fs.rmSync(APP, { recursive: true, force: true }); fail('could not build the app (needs Xcode command line tools: xcode-select --install)\n' + String((e as { stderr?: Buffer }).stderr ?? e).slice(0, 600)); }
  const x = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  fs.writeFileSync(path.join(c, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleName</key><string>DrawPad</string>
<key>CFBundleIdentifier</key><string>local.drawpad.app</string>
<key>CFBundleExecutable</key><string>DrawPad</string>
<key>CFBundleIconFile</key><string>DrawPad</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>1.0</string>
<key>NSHighResolutionCapable</key><true/>
<key>DrawPadNode</key><string>${x(process.execPath)}</string>
<key>DrawPadCLI</key><string>${x(fileURLToPath(import.meta.url))}</string>
</dict></plist>
`);
  try { // icon: the SVG above through the design renderer, then iconutil
    const { renderHtml, closeRenderer } = await import('./images.ts');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drawpad-icon-')), set = path.join(tmp, 'DrawPad.iconset');
    fs.writeFileSync(path.join(tmp, 'i.svg'), ICON); fs.mkdirSync(set);
    try { await renderHtml(path.join(tmp, 'i.svg'), path.join(tmp, 'i.png'), 512, 512); } finally { await closeRenderer(); }
    for (const n of [16, 32, 128, 256, 512]) for (const k of [1, 2])
      execFileSync('sips', ['-z', String(n * k), String(n * k), path.join(tmp, 'i.png'), '--out', path.join(set, `icon_${n}x${n}${k > 1 ? '@2x' : ''}.png`)], { stdio: 'ignore' });
    execFileSync('iconutil', ['-c', 'icns', set, '-o', path.join(c, 'Resources', 'DrawPad.icns')]);
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch { /* no icon is fine */ }
  if (findRoot()) remember(root);
  try { execFileSync('/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister', ['-f', APP], { stdio: 'ignore' }); } catch { /* registers on first open */ }
  try { execFileSync('mdimport', [APP], { stdio: 'ignore' }); } catch { /* Spotlight picks it up later */ }
  return `${APP}\nNative DrawPad window. Open from Spotlight "DrawPad" or the Dock; switch boards from the name at the top left.`;
}

async function main() {
  if (fl.help || verb === 'help') return out(HELP);
  switch (verb) {
    case 'serve': {
      const { serve } = await import('./server.ts');
      const port = await serve(root, num('port') ?? 0);
      remember(root);
      if (!fl.quiet) console.log(`DrawPad for ${root}\nhttp://127.0.0.1:${port}/`);
      return;
    }
    case 'url': return out(await server() + '/');
    case 'open': { const u = await server() + '/'; openWindow(u); return out(u); }
    case 'app': return out(await makeApp());
    case 'recent': { // the DrawPad app at launch: URL of the most recent board (starts its server)
      const r = projects()[0]; if (!r) fail('no boards yet');
      return out(execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', fileURLToPath(import.meta.url), 'url'], { cwd: r, encoding: 'utf8' }).trim());
    }
    case 'pick': return out(pick());
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
    case 'tell-dev': { // feedback about DrawPad itself, to DrawPad's own repo (read by agents working on DrawPad)
      const text = pos.join(' ').trim() || (process.stdin.isTTY ? '' : fs.readFileSync(0, 'utf8').trim());
      if (!text) fail('tell-dev "what went wrong or what would help"');
      const inbox = fileURLToPath(new URL('../inbox.md', import.meta.url));
      fs.appendFileSync(inbox, `\n## ${new Date().toISOString().slice(0, 16).replace('T', ' ')} · ${path.basename(root)}\n${text}\n`);
      return out('thanks, sent to the DrawPad developers');
    }
    case 'title': return out(await op({ op: 'edit', id: pos[0], title: pos.slice(1).join(' '), by: 'agent' }));
    case 'outline': return out(await api('/api/outline?key=' + encodeURIComponent(pos[0] ?? '') + (fl.boxes ? '&boxes=1' : '')));
    case 'feedback': return out(await api('/api/feedback', { since: num('since'), crops: !!fl.crops, json: !!fl.json, section: str('section') }));
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
      // Claude Code hook (reads the board file directly: fast, never starts a server, silent when nothing waits).
      // UserPromptSubmit: a line of context. PostToolUse: the same line, once per change (no repeats every call).
      // Stop: keeps the agent going while sent feedback waits; --wait S holds the stop up to S seconds for a Send.
      if (!findRoot()) return;
      let ev: { hook_event_name?: string; stop_hook_active?: boolean } = {};
      if (!process.stdin.isTTY) try { ev = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch { /* manual run */ }
      const line = () => hookLine(new Store(root).pending(false, str('section')));
      if (ev.hook_event_name === 'Stop') {
        if (ev.stop_hook_active) return; // already continued once for this stop: let it stop
        let l = line();
        for (const until = Date.now() + (num('wait') ?? 0) * 1000; !l && Date.now() < until; l = line()) await new Promise(r => setTimeout(r, 2000));
        if (l) process.stdout.write(JSON.stringify({ decision: 'block', reason: l }));
        return;
      }
      const l = line();
      if (ev.hook_event_name === 'PostToolUse') {
        const mark = path.join(paths(root).dir, 'hook-last');
        let last = ''; try { last = fs.readFileSync(mark, 'utf8'); } catch { /* first */ }
        if (l === last) return;
        fs.writeFileSync(mark, l);
        if (l) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: l } }));
        return;
      }
      return out(l);
    }
    case 'wait': { // in 4-minute slices: Node's fetch drops a response that stays silent for 5 minutes
      const until = num('timeout') ? Date.now() + num('timeout')! * 1000 : Infinity;
      const q = `${fl.feedback ? '&feedback=1' : ''}${str('section') ? '&section=' + encodeURIComponent(str('section')!) : ''}`;
      for (;;) {
        const slice = Math.max(1, Math.min(240, Math.ceil((until - Date.now()) / 1000)));
        const r = await api(`/api/wait?timeout=${slice}${q}`);
        if (r !== 'timeout' || Date.now() >= until) return out(r);
      }
    }
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
