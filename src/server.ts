import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
import { fileURLToPath } from 'node:url';
import { Store } from './store.ts';
import { codeStamp } from './project.ts';
import { boardText, feedbackText, hookLine } from './report.ts';

// Single writer for one project's .drawpad/. Web UI, CLI and hook are thin clients of this API.

const UI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui');
const TYPES: Record<string, string> = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.ts': 'text/javascript',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.json': 'application/json' };

export function serve(root: string, port = 0): Promise<number> {
  const store = new Store(root);
  const stamp = codeStamp();
  const clients = new Set<http.ServerResponse>();
  store.onChange.push(rev => { for (const c of clients) c.write(`data: ${rev}\n\n`); });

  const ops: Record<string, (a: any) => string> = {
    add: a => store.add(a),
    many: a => (a.items as any[]).map(x => { try { return store.add(x); } catch (e) { return `${x.key ?? '?'} error: ${(e as Error).message}`; } }).join('\n'),
    move: a => store.move(a.id, a.x, a.y, a.w, a.h, a.by),
    moveSection: a => store.moveSection(a.id, a.dx, a.dy),
    renameSection: a => store.renameSection(a.id, a.title),
    section: a => store.section(a.title, a.keys ?? []),
    edit: a => store.edit(a.id, a, a.by ?? 'agent'),
    drop: a => store.drop(a.id, a.version),
    archive: a => store.setState(a.id, 'archived'),
    restore: a => store.setState(a.id, 'active'),
    arrow: a => store.arrow(a.from, a.to, a.by ?? 'agent', a.toPoint, a.label, a.key),
    comment: a => store.comment(a),
    reply: a => store.reply(a.id, a.text, a.by ?? 'agent'),
    done: a => store.setStatus(a.id, 'addressed', a.artifact),
    resolve: a => store.setStatus(a.id, 'resolved'),
    reopen: a => store.setStatus(a.id, 'open'),
    react: a => store.react(a.id, a.kind, a.reason),
    send: () => store.send(),
  };

  const tsCache = new Map<string, string>();
  const body = (req: http.IncomingMessage) => new Promise<Buffer>(r => { const c: Buffer[] = []; req.on('data', d => c.push(d)); req.on('end', () => r(Buffer.concat(c))); });
  const send = (res: http.ServerResponse, code: number, data: string | Buffer, type = 'text/plain; charset=utf-8') => { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-cache' }); res.end(data); };
  const file = (res: http.ServerResponse, f: string, immutable = false) => {
    if (!fs.existsSync(f) || !fs.statSync(f).isFile()) return send(res, 404, 'not found');
    res.writeHead(200, { 'content-type': TYPES[path.extname(f).toLowerCase()] ?? 'application/octet-stream', 'cache-control': immutable ? 'max-age=31536000' : 'no-cache' });
    fs.createReadStream(f).pipe(res);
  };

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    const p = u.pathname;
    try {
      if (p === '/') return file(res, path.join(UI, 'index.html'));
      if (p.startsWith('/ui/')) {
        const f = path.join(UI, path.basename(p));
        if (f.endsWith('.ts')) {
          if (!fs.existsSync(f)) return send(res, 404, 'not found');
          const st = fs.statSync(f).mtimeMs + f;
          if (!tsCache.has(st)) tsCache.set(st, stripTypeScriptTypes(fs.readFileSync(f, 'utf8')));
          return send(res, 200, tsCache.get(st)!, 'text/javascript');
        }
        return file(res, f);
      }
      if (p.startsWith('/a/')) return file(res, path.join(store.p.assets, path.basename(decodeURIComponent(p))), true);
      if (p === '/api/ping') return send(res, 200, JSON.stringify({ ok: true, root, rev: store.board.revision, stamp }), 'application/json');
      if (p === '/api/board') return send(res, 200, JSON.stringify(store.board), 'application/json');
      if (p === '/api/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        res.write(`data: ${store.board.revision}\n\n`);
        clients.add(res); req.on('close', () => clients.delete(res));
        return;
      }
      if (p === '/api/text/board') {
        const since = u.searchParams.get('since');
        return send(res, 200, boardText(store, since ? Number(since) : undefined, u.searchParams.get('section') ?? undefined));
      }
      if (p === '/api/feedback') {
        const a = JSON.parse((await body(req)).toString() || '{}');
        return send(res, 200, feedbackText(store, a));
      }
      if (p === '/api/wait') {
        const done = () => { if (!res.writableEnded) send(res, 200, hookLine(store.pending())); };
        if (store.pending().total) return done();
        store.waiters.push(done);
        const t = Number(u.searchParams.get('timeout') ?? 0);
        if (t) setTimeout(() => { store.waiters = store.waiters.filter(w => w !== done); if (!res.writableEnded) send(res, 200, 'timeout'); }, t * 1000);
        return;
      }
      if (p === '/api/upload' && req.method === 'POST') {
        const ext = (u.searchParams.get('ext') ?? 'png').replace(/[^a-z0-9]/gi, '').slice(0, 5) || 'png';
        const name = `${u.searchParams.get('prefix') ?? 'up'}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}.${ext}`;
        fs.writeFileSync(path.join(store.p.assets, name), await body(req));
        return send(res, 200, JSON.stringify({ asset: name }), 'application/json');
      }
      if (p === '/api/op' && req.method === 'POST') {
        const a = JSON.parse((await body(req)).toString());
        const f = ops[a.op];
        if (!f) return send(res, 400, `unknown op ${a.op}`);
        return send(res, 200, f(a));
      }
      send(res, 404, 'not found');
    } catch (e) {
      send(res, 400, `error: ${(e as Error).message}`);
    }
  });

  return new Promise(resolve => {
    server.listen(port, '127.0.0.1', () => {
      const actual = (server.address() as { port: number }).port;
      fs.writeFileSync(store.p.server, JSON.stringify({ port: actual, pid: process.pid }));
      resolve(actual);
    });
  });
}
