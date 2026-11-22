import fs from 'node:fs';
import path from 'node:path';

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
