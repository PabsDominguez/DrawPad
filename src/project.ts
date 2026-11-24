import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Walks up from cwd looking for a .drawpad folder. Returns the project root or null.
export function findRoot(start = process.cwd()): string | null {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.drawpad', 'board.json'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

export function paths(root: string) {
  const d = path.join(root, '.drawpad');
  return {
    dir: d,
    board: path.join(d, 'board.json'),
    decisions: path.join(d, 'decisions.md'),
    assets: path.join(d, 'assets'),
    shared: path.join(d, 'shared'),
    history: path.join(d, 'history'),
    server: path.join(d, 'server.json'),
    log: path.join(d, 'server.log'),
    stats: path.join(d, 'stats.jsonl'),
  };
}

export function ensureDirs(root: string) {
  const p = paths(root);
  for (const d of [p.dir, p.assets, p.shared, p.history]) fs.mkdirSync(d, { recursive: true });
  return p;
}

export function writeAtomic(file: string, data: string) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

// Newest mtime of the server code; the CLI restarts a server started from older code.
export function codeStamp(): number {
  const dir = path.dirname(new URL(import.meta.url).pathname);
  return Math.max(...fs.readdirSync(dir).filter(f => f.endsWith('.ts')).map(f => fs.statSync(path.join(dir, f)).mtimeMs));
}

// Stable per-project port (47100-47999) so the app window keeps its address, size and position.
export function preferredPort(root: string): number {
  let h = 0;
  for (const c of path.resolve(root)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return 47100 + (h % 900);
}

// Projects that have had a board open, most recent first (for the DrawPad launcher's list).
const REGISTRY = path.join(os.homedir(), 'Library', 'Application Support', 'DrawPad', 'projects.json');
export function projects(): string[] {
  try { return (JSON.parse(fs.readFileSync(REGISTRY, 'utf8')) as string[]).filter(r => fs.existsSync(path.join(r, '.drawpad', 'board.json'))); } catch { return []; }
}
export function remember(r: string) {
  if (/^\/(private\/)?(tmp|var\/folders)\//.test(fs.realpathSync(r))) return; // throwaway test projects
  fs.mkdirSync(path.dirname(REGISTRY), { recursive: true });
  fs.writeFileSync(REGISTRY, JSON.stringify([r, ...projects().filter(x => x !== r)], null, 1));
}

