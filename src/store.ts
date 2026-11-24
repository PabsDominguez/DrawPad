import fs from 'node:fs';
import path from 'node:path';
import type { Board, By, Kind, Intent, Item, Mark, Reply, Section, Source, Version } from './types.ts';
import { ensureDirs, paths, writeAtomic } from './project.ts';
import { imageSize, makeThumb, renderHtml, svgSize } from './images.ts';
import { GAP, PAD, SECTION_GAP, contentBottom, imageBox, kindOf, moveSection, place, sectionRect, solid, textHeight } from './layout.ts';

export interface AddArgs {
  kind: 'image' | 'text' | 'link' | 'html';
  key?: string; title?: string; section?: string;
  path?: string; asset?: string; text?: string; url?: string;
  at?: [number, number]; below?: string; rightOf?: string; inRowWith?: string;
  width?: number; height?: number; pw?: number; ph?: number;
  source?: Source; note?: string; by?: By; color?: string;
}

const now = () => new Date().toISOString();
const SCHEMA = 1;

export class Store {
  root: string;
  p: ReturnType<typeof paths>;
  board: Board;
  onChange: ((rev: number) => void)[] = [];

  constructor(root: string) {
    this.root = root;
    this.p = ensureDirs(root);
    if (fs.existsSync(this.p.board)) this.board = migrate(JSON.parse(fs.readFileSync(this.p.board, 'utf8')));
    else {
      this.board = { schemaVersion: SCHEMA, revision: 0, nextId: 1, id: `b${Date.now().toString(36)}`, name: path.basename(root),
        background: 'dark', round: 1, items: [], sections: [], relations: [], groups: [], rounds: [] };
      this.save();
    }
  }

  save() {
    writeAtomic(this.p.board, JSON.stringify(this.board, null, 1));
    for (const f of this.onChange) f(this.board.revision);
  }
  bump() { return ++this.board.revision; }
  nid() { return this.board.nextId++; }

  find(ref: string): Item {
    const it = this.board.items.find(i => i.key === ref) ?? this.board.items.find(i => i.id === ref);
    if (!it) throw new Error(`no item "${ref}"`);
    return it;
  }
  sectionByTitle(title: string, create = true): Section | undefined {
    let s = this.board.sections.find(x => x.title.toLowerCase() === title.toLowerCase());
    if (!s && create) {
      const bottom = contentBottom(this.board);
      s = { id: `s${this.nid()}`, title, x: 0, y: bottom === null ? 0 : bottom + SECTION_GAP + PAD, rev: this.board.revision };
      this.board.sections.push(s);
    }
    return s;
  }
  // Section whose box contains the point, ignoring one item.
  sectionAt(x: number, y: number, ignore?: string): Section | undefined {
    return this.board.sections.find(s => {
      const r = sectionRect(this.board, s, ignore);
      return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
    });
  }

  // Upsert by key: same key adds a version. Returns the one-line result (+ problems).
  add(a: AddArgs): string {
    const by = a.by ?? 'agent';
    const rev = this.bump();
    let it = a.key ? this.board.items.find(i => i.key === a.key) : undefined;
    const design = a.kind === 'html';
    let renderWarn: string[] = [];
    if (design) a.kind = 'image';
    if (it && it.kind !== a.kind) throw new Error(`key "${a.key}" is a ${it.kind}, not ${a.kind}`);
    const isNew = !it;
    const sec = a.section ? this.sectionByTitle(a.section)! : undefined; // before the item exists, so it doesn't count as content
    const n = this.nid();
    const key = a.key ?? `${a.kind === 'image' ? 'img' : a.kind}-${n}`;
    const ver: Version = { v: it ? it.versions[it.versions.length - 1].v + 1 : 1, at: now() };
    if (a.note) ver.note = a.note;

    if (design) {
      if (!a.path || !fs.existsSync(a.path)) throw new Error(`no file ${a.path}`);
      const stem = `${key.replace(/[^\w.-]/g, '_')}-v${ver.v}`, prev = it?.versions.at(-1);
      const cw = Math.round(a.width ?? prev?.cw ?? svgSize(a.path)?.[0] ?? 1280);
      const h = a.height ?? (a.path.toLowerCase().endsWith('.svg') ? svgSize(a.path)?.[1] : undefined);
      const { h: ch, warn } = renderHtml(a.path, path.join(this.p.assets, stem + '.png'), cw, h && Math.round(h * cw / (svgSize(a.path)?.[0] ?? cw)));
      // Source copy for the live view; <base> points at its folder (served under /p/) so relative files load.
      const rel = path.relative(this.root, path.dirname(a.path));
      let src = fs.readFileSync(a.path, 'utf8');
      if (!rel.startsWith('..')) { const base = `<base href="/p/${rel ? encodeURI(rel) + '/' : ''}">`; src = /<head[^>]*>/i.test(src) ? src.replace(/<head[^>]*>/i, m => m + base) : base + src; }
      fs.writeFileSync(path.join(this.p.assets, stem + '.html'), src);
      renderWarn = warn;
      Object.assign(ver, { asset: stem + '.png', html: stem + '.html', cw, pw: cw * 2, ph: ch * 2 });
      ver.thumb = makeThumb(path.join(this.p.assets, stem + '.png'), cw * 2);
    } else if (a.kind === 'image') {
      let file: string;
      if (a.asset) file = path.join(this.p.assets, path.basename(a.asset));
      else if (a.path) {
        if (!fs.existsSync(a.path)) throw new Error(`no file ${a.path}`);
        const name = `${key.replace(/[^\w.-]/g, '_')}-v${ver.v}${path.extname(a.path).toLowerCase() || '.png'}`;
        file = path.join(this.p.assets, name);
        fs.copyFileSync(a.path, file);
      } else throw new Error('image needs a path');
      const size = imageSize(file) ?? (a.pw && a.ph ? [a.pw, a.ph] : [800, 600]);
      ver.asset = path.basename(file); [ver.pw, ver.ph] = size;
      ver.thumb = makeThumb(file, size[0]);
    } else if (a.kind === 'text') ver.text = a.text ?? '';
    else if (a.kind === 'link') { if (!a.url) throw new Error('link needs a url'); ver.url = a.url; }

    if (!it) {
      it = { id: `i${n}`, key, kind: a.kind as Kind, x: 0, y: 0, w: 0, h: 0, z: n, state: 'active', versions: [],
        createdBy: by, round: this.board.round, createdAt: now(), rev, seenByHuman: by === 'human' };
      this.board.items.push(it);
    }
    it.versions.push(ver);
    it.rev = rev;
    if (a.title) it.title = a.title;
    if (a.color) it.color = a.color;
    if (a.source) it.source = a.source;
    if (by === 'agent') it.seenByHuman = false;
    else this.fromHuman(it, rev);

    // size
    if (design) {
      if (isNew) [it.w, it.h] = [ver.cw!, Math.round(ver.ph! / 2)];
      else it.h = Math.round(it.w * ver.ph! / ver.pw!);
    } else if (a.kind === 'image') {
      if (isNew || a.width || a.height) [it.w, it.h] = imageBox(ver.pw!, ver.ph!, a.width, a.height);
      else it.h = Math.round(it.w * ver.ph! / ver.pw!);
    } else if (a.kind === 'text') {
      it.w = a.width ?? (it.w || 280);
      it.h = a.height ?? textHeight(ver.text!, it.w);
    } else if (isNew) { it.w = a.width ?? 280; it.h = a.height ?? 96; }

    // section + placement
    let problems: string[] = [];
    const oldSection = it.section;
    if (by === 'human' && a.at) {
      it.x = Math.round(a.at[0]); it.y = Math.round(a.at[1]);
      it.section = sec ? sec.id : this.sectionAt(it.x, it.y, it.id)?.id;
    } else {
      if (sec) it.section = sec.id;
      const anchor = (r?: string) => (r ? this.find(r) : undefined);
      const o = { at: a.at, below: anchor(a.below), rightOf: anchor(a.rightOf), inRowWith: anchor(a.inRowWith) };
      if (!a.section && !isNew && !(o.at || o.below || o.rightOf || o.inRowWith)) {
        problems = place(this.board, it, { at: [it.x, it.y] }).filter(p => !p.includes(' was at '));
      } else {
        if (!a.section && (o.below || o.rightOf || o.inRowWith)) it.section = (o.below ?? o.rightOf ?? o.inRowWith)!.section;
        if (isNew || o.at || o.below || o.rightOf || o.inRowWith || it.section !== oldSection) problems = place(this.board, it, o);
      }
    }
    if (a.kind === 'link' && by === 'human' && !a.title) this.fetchTitle(it, ver.url!);
    this.save();
    return line(this, it) + [...renderWarn, ...problems].map(p => `\n  ! ${p}`).join('');
  }

  private async fetchTitle(it: Item, url: string) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(5000), headers: { 'user-agent': 'drawpad' } });
      const m = /<title[^>]*>([^<]{1,200})<\/title>/i.exec(await r.text());
      if (m) { it.title = m[1].trim().replace(/&amp;/g, '&'); it.rev = this.bump(); this.save(); }
    } catch { /* title stays empty */ }
  }

  // section: set explicitly (used by undo; null = loose) instead of inferring it from the drop point.
  move(ref: string, x: number, y: number, w?: number, h?: number, by: By = 'agent', section?: string | null): string {
    const it = this.find(ref);
    const rev = this.bump();
    const dx = x - it.x, dy = y - it.y;
    it.x = Math.round(x); it.y = Math.round(y);
    if (w) it.w = Math.round(w);
    if (h) it.h = Math.round(h);
    it.rev = rev;
    // Dragging never takes an item out of its section (the box stretches to follow it).
    // Dropping it inside another section's box moves it into that section.
    if (section !== undefined) it.section = section ?? undefined;
    else if (by === 'human' && it.kind !== 'arrow' && (dx || dy)) {
      // A drawn frame is a real box: dropping an item outside it takes the item out.
      const cx = it.x + it.w / 2, cy = it.y + it.h / 2;
      const into = this.sectionAt(cx, cy, it.id);
      const own = this.board.sections.find(s => s.id === it.section);
      if (into && into.id !== it.section) it.section = into.id;
      else if (own?.w && !into) it.section = undefined;
      else if (own && !own.w && !solid(this.board).some(i => i.section === own.id && i.id !== it.id)) { own.x += dx; own.y += dy; own.rev = rev; }
    }
    this.save();
    return line(this, it);
  }

  // Removes one version (default: the latest). Numbers are never reused; a version with comments stays.
  drop(ref: string, v?: number): string {
    const it = this.find(ref);
    const target = v ?? it.versions[it.versions.length - 1].v;
    const idx = it.versions.findIndex(x => x.v === target);
    if (idx < 0) throw new Error(`${it.key} has no v${target}`);
    if (it.versions.length === 1) throw new Error(`v${target} is the only version of ${it.key}; use archive`);
    const refs = this.board.items.filter(c => c.comment?.target === it.id && c.comment.targetVersion === target && c.state === 'active');
    if (refs.length) throw new Error(`v${target} has comments (${refs.map(c => c.key).join(', ')}); archive them first`);
    const [gone] = it.versions.splice(idx, 1);
    for (const f of [gone.asset, gone.thumb]) if (f) fs.rmSync(path.join(this.p.assets, f), { force: true });
    const last = it.versions[it.versions.length - 1];
    if (it.kind === 'image' && last.pw && last.ph) it.h = Math.round(it.w * last.ph / last.pw);
    it.rev = this.bump();
    this.save();
    return `${it.key} dropped v${target}; now v${last.v} (${it.versions.length} versions)`;
  }

  moveSection(id: string, dx: number, dy: number) {
    const s = this.board.sections.find(x => x.id === id || x.title === id);
    if (!s) throw new Error(`no section ${id}`);
    this.bump(); moveSection(this.board, s, dx, dy); this.save();
    return `section "${s.title}" moved`;
  }

  renameSection(id: string, title: string) {
    const s = this.board.sections.find(x => x.id === id);
    if (!s) throw new Error(`no section ${id}`);
    s.title = title; s.rev = this.bump(); this.save();
    return `section "${title}"`;
  }

  // Copies of items (the human's copy / paste), offset by dx, dy. Images get their own asset file.
  duplicate(ids: string[], dx: number, dy: number): string {
    return ids.map(id => this.find(id)).filter(it => it.kind !== 'arrow' && !it.comment).map(it => {
      const v = it.versions[it.versions.length - 1];
      if (it.kind === 'mark') return '';
      return this.add({ kind: it.kind as 'image' | 'text' | 'link', by: 'human', at: [it.x + dx, it.y + dy], width: it.w, height: it.h, title: it.title,
        text: v.text, url: v.url, path: v.asset ? path.join(this.p.assets, v.asset) : undefined });
    }).join('\n');
  }

  // The human's drawings (lines, arrows, boxes, ellipses).
  mark(a: { shape: Mark['shape']; pts: Mark['pts']; on?: string; crop?: string; by?: By }): string {
    const rev = this.bump(), n = this.nid(), by = a.by ?? 'human';
    const it: Item = { id: `i${n}`, key: `m-${n}`, kind: 'mark', x: 0, y: 0, w: 0, h: 0, z: n, state: 'active', versions: [{ v: 1, at: now() }],
      createdBy: by, round: this.board.round, createdAt: now(), rev, seenByHuman: by === 'human', mark: { shape: a.shape, pts: a.pts } };
    if (a.on) it.mark!.on = this.find(a.on).id;
    if (a.crop) it.mark!.crop = path.basename(a.crop);
    if (by === 'human') this.fromHuman(it, rev);
    this.board.items.push(it); this.save();
    return `${it.key} ${a.shape}`;
  }
  remark(ref: string, pts: Mark['pts'], crop?: string): string {
    const it = this.find(ref);
    if (!it.mark) throw new Error(`${it.key} is not a drawing`);
    const rev = this.bump();
    it.mark.pts = pts; it.rev = rev;
    if (crop) it.mark.crop = path.basename(crop);
    if (it.createdBy === 'human') this.fromHuman(it, rev);
    this.save();
    return `${it.key} moved`;
  }

  // A frame the human drew (or the undo of removing one): explicit box, adopts the given items in place.
  frame(f: { id?: string; title?: string; x: number; y: number; w?: number; h?: number; ids?: string[] }): string {
    const rev = this.bump();
    const id = f.id && !this.board.sections.some(s => s.id === f.id) ? f.id : `s${this.nid()}`;
    let n = this.board.sections.length + 1;
    while (this.board.sections.some(s => s.title === `Frame ${n}`)) n++;
    const s: Section = { id, title: f.title ?? `Frame ${n}`, x: Math.round(f.x), y: Math.round(f.y), rev };
    if (f.w && f.h) { s.w = Math.round(f.w); s.h = Math.round(f.h); }
    this.board.sections.push(s);
    for (const r of f.ids ?? []) { const it = this.find(r); it.section = id; it.rev = rev; }
    this.save();
    return `${id} section "${s.title}"`;
  }
  // Removes a section; its items stay where they are (loose, or back where `restore` says).
  unframe(id: string, restore: Record<string, string | null> = {}): string {
    const s = this.board.sections.find(x => x.id === id);
    if (!s) throw new Error(`no section ${id}`);
    const rev = this.bump();
    this.board.sections = this.board.sections.filter(x => x !== s);
    for (const it of this.board.items) {
      if (it.section === id) { it.section = undefined; it.rev = rev; }
      if (it.id in restore) { it.section = restore[it.id] ?? undefined; it.rev = rev; }
    }
    this.save();
    return `section "${s.title}" removed`;
  }
  resizeSection(id: string, x: number, y: number, w?: number, h?: number): string {
    const s = this.board.sections.find(q => q.id === id);
    if (!s) throw new Error(`no section ${id}`);
    s.x = Math.round(x); s.y = Math.round(y);
    if (w && h) { s.w = Math.round(w); s.h = Math.round(h); } else { delete s.w; delete s.h; }
    s.rev = this.bump(); this.save();
    return `section "${s.title}" resized`;
  }

  // Creates the section if needed and moves the given items into its row.
  section(title: string, keys: string[]): string {
    this.bump();
    const s = this.sectionByTitle(title)!;
    const out: string[] = [];
    for (const k of keys) {
      const it = this.find(k);
      it.section = s.id; it.rev = this.board.revision;
      const p = place(this.board, it, {});
      out.push(`${it.key}@${it.x},${it.y}` + p.map(x => ` (${x})`).join(''));
    }
    this.save();
    return `section "${s.title}"${out.length ? ': ' + out.join(', ') : ''}`;
  }

  // Human edits to their own text; agent edits go through add (versions).
  edit(ref: string, f: { text?: string; title?: string; intent?: Intent; h?: number; w?: number }, by: By): string {
    const it = this.find(ref);
    if (f.text !== undefined && it.createdBy !== by) throw new Error(`${it.key} belongs to the ${it.createdBy}`);
    const rev = this.bump();
    const cur = it.versions[it.versions.length - 1];
    if (f.text !== undefined) {
      // Rewrites in place until the agent has read it; after that an edit is a new version.
      if (!it.delivered) cur.text = f.text;
      else it.versions.push({ v: cur.v + 1, at: now(), text: f.text });
      it.h = f.h ?? textHeight(f.text, it.w);
    }
    if (f.w) it.w = f.w;
    if (f.title !== undefined) it.title = f.title;
    if (f.intent && it.comment) it.comment.intent = f.intent;
    if (by === 'human') this.fromHuman(it, rev);
    it.rev = rev;
    this.save();
    return line(this, it);
  }

  // Human feedback goes to the agent as soon as it is saved (no draft/send step).
  lastHuman = 0;
  private fromHuman(it: Item, rev: number) { it.sent = rev; it.delivered = false; this.lastHuman = Date.now(); }

  // Moves a comment's pin (and region); the comment is re-delivered with the new crop.
  repin(ref: string, point: [number, number], region?: [number, number, number, number], crop?: string): string {
    const it = this.find(ref);
    if (!it.comment) throw new Error(`${it.key} is not a comment`);
    const rev = this.bump();
    it.comment.point = point;
    if (region) it.comment.region = region; else delete it.comment.region;
    if (crop) it.comment.crop = path.basename(crop);
    for (const a of this.board.items) if (a.kind === 'arrow' && a.from === it.id && a.to === it.comment.target) { a.toPoint = point; a.rev = rev; }
    it.rev = rev;
    if (it.createdBy === 'human') this.fromHuman(it, rev);
    this.save();
    return `${it.key} pin @${point.map(v => v.toFixed(2))}`;
  }

  // The human has looked at these agent items.
  seen(ids: string[]): string {
    const its = this.board.items.filter(i => ids.includes(i.id) && !i.seenByHuman);
    if (!its.length) return 'seen 0';
    const rev = this.bump();
    for (const i of its) { i.seenByHuman = true; i.rev = rev; }
    this.save();
    return `seen ${its.length}`;
  }

  setState(ref: string, state: Item['state']): string {
    const it = this.find(ref);
    it.state = state; it.rev = this.bump();
    // Arrows follow their ends: archived with either end, restored when both ends are back.
    for (const a of this.board.items) {
      if (a.kind !== 'arrow' || (a.from !== it.id && a.to !== it.id) || a.state === state) continue;
      const other = this.board.items.find(o => o.id === (a.from === it.id ? a.to : a.from));
      if (state === 'archived' || other?.state === 'active') { a.state = state; a.rev = it.rev; }
    }
    this.save();
    return `${it.key} ${state}`;
  }

  arrow(fromRef: string, toRef: string, by: By, toPoint?: [number, number], label?: string, key?: string): string {
    const from = this.find(fromRef), to = this.find(toRef);
    const rev = this.bump(), n = this.nid();
    const a: Item = { id: `i${n}`, key: key ?? `a-${n}`, kind: 'arrow', x: 0, y: 0, w: 0, h: 0, z: n, state: 'active', versions: [{ v: 1, at: now() }],
      createdBy: by, round: this.board.round, createdAt: now(), rev, seenByHuman: by === 'human', from: from.id, to: to.id };
    if (toPoint) a.toPoint = toPoint;
    if (label) a.label = label;
    if (by === 'human') this.fromHuman(a, rev);
    this.board.items.push(a);
    this.save();
    return `${a.key} ${from.key} -> ${to.key}${toPoint ? ` @${toPoint.map(v => v.toFixed(2))}` : ''}`;
  }

  comment(c: { target: string; text: string; intent?: Intent; point?: [number, number]; region?: [number, number, number, number]; crop?: string; by: By; at?: [number, number] }): string {
    const t = this.find(c.target);
    const rev = this.bump(), n = this.nid();
    const ver = t.versions[t.versions.length - 1].v;
    const w = 240, h = textHeight(c.text, w) + 24;
    const it: Item = { id: `i${n}`, key: `c-${n}`, kind: 'text', x: 0, y: 0, w, h, z: n, state: 'active',
      versions: [{ v: 1, at: now(), text: c.text }], createdBy: c.by, round: this.board.round, createdAt: now(), rev,
      seenByHuman: c.by === 'human', section: t.section,
      comment: { intent: c.intent ?? 'change', status: 'open', thread: [], target: t.id, targetVersion: ver } };
    if (c.point) it.comment!.point = c.point;
    if (c.region) it.comment!.region = c.region;
    if (c.crop) it.comment!.crop = path.basename(c.crop);
    if (c.by === 'human') this.fromHuman(it, rev);
    // Beside the target at the point's height; under the target when a neighbour is in the way.
    const right = { x: t.x + t.w + GAP, y: Math.round(t.y + (c.point ? c.point[1] * t.h : 0) - 20), w, h };
    const blocked = solid(this.board).some(o => !o.comment && o.id !== t.id &&
      o.x < right.x + w + GAP && right.x < o.x + o.w && o.y < right.y + h && right.y < o.y + o.h);
    this.board.items.push(it);
    place(this.board, it, { at: c.at ?? (blocked ? [t.x, t.y + t.h + GAP] : [right.x, right.y]), flow: 'down' });
    this.arrowNoSave(it, t, c.by, c.point);
    this.save();
    return line(this, it);
  }
  private arrowNoSave(from: Item, to: Item, by: By, toPoint?: [number, number]) {
    const n = this.nid();
    const a: Item = { id: `i${n}`, key: `a-${from.key}`, kind: 'arrow', x: 0, y: 0, w: 0, h: 0, z: n, state: 'active', versions: [{ v: 1, at: now() }],
      createdBy: by, round: this.board.round, createdAt: now(), rev: this.board.revision, seenByHuman: by === 'human', from: from.id, to: to.id };
    if (toPoint) a.toPoint = toPoint;
    if (by === 'human') a.sent = a.rev;
    this.board.items.push(a);
  }

  reply(ref: string, text: string, by: By): string {
    const it = this.find(ref);
    if (!it.comment) throw new Error(`${it.key} is not a comment`);
    const rev = this.bump();
    it.comment.thread.push({ by, text, at: now(), ...(by === 'human' ? { sent: rev } : {}) });
    it.rev = rev;
    if (by === 'agent') it.seenByHuman = false; else this.lastHuman = Date.now();
    this.save();
    return `${it.key} replied (${it.comment.thread.length})`;
  }

  // The human edits or deletes their own reply (i = index in the thread); insertReply is delete's undo.
  editReply(ref: string, i: number, text: string): string {
    const it = this.find(ref), r = it.comment?.thread[i];
    if (!r || r.by !== 'human') throw new Error(`${it.key} has no reply ${i} of yours`);
    const rev = this.bump();
    Object.assign(r, { text, sent: rev, delivered: false, edited: true }); it.rev = rev; this.lastHuman = Date.now();
    this.save();
    return `${it.key} reply ${i} edited`;
  }
  deleteReply(ref: string, i: number): string {
    const it = this.find(ref), r = it.comment?.thread[i];
    if (!r || r.by !== 'human') throw new Error(`${it.key} has no reply ${i} of yours`);
    it.comment!.thread.splice(i, 1); it.rev = this.bump(); this.save();
    return `${it.key} reply ${i} deleted`;
  }
  insertReply(ref: string, i: number, r: Reply): string {
    const it = this.find(ref);
    if (!it.comment) throw new Error(`${it.key} is not a comment`);
    it.comment.thread.splice(i, 0, r); it.rev = this.bump(); this.save();
    return `${it.key} reply restored`;
  }

  // Undo for the human's last reply.
  unreply(ref: string): string {
    const it = this.find(ref);
    const th = it.comment?.thread ?? [];
    const i = th.map(t => t.by).lastIndexOf('human');
    if (i < 0) throw new Error(`no human reply on ${it.key}`);
    th.splice(i, 1);
    it.rev = this.bump(); this.save();
    return `${it.key} reply removed`;
  }

  setStatus(ref: string, status: 'open' | 'addressed' | 'resolved', artifact?: string): string {
    const it = this.find(ref);
    if (!it.comment) throw new Error(`${it.key} is not a comment`);
    it.comment.status = status;
    if (artifact) it.comment.artifact = this.find(artifact).key;
    it.rev = this.bump();
    if (status === 'addressed') it.seenByHuman = false;
    this.save();
    return `${it.key} ${status}${artifact ? ` in ${artifact}` : ''}`;
  }

  // kind undefined = withdraw (undo). Every pick is logged to decisions.md straight away.
  react(ref: string, kind?: 'approve' | 'reject', reason?: string): string {
    const it = this.find(ref);
    const rev = this.bump();
    const v = it.versions[it.versions.length - 1].v;
    const day = now().slice(0, 10);
    if (kind) {
      it.reaction = { kind, reason, version: v, sent: rev, delivered: false };
      fs.appendFileSync(this.p.decisions, `- ${day} ${kind} ${it.key} v${v}${reason ? `: ${reason}` : ''}\n`);
    } else if (it.reaction) {
      fs.appendFileSync(this.p.decisions, `- ${day} withdrew ${it.reaction.kind} ${it.key} v${it.reaction.version}\n`);
      delete it.reaction;
    }
    it.rev = rev;
    this.lastHuman = Date.now();
    this.save();
    return `${it.key} ${kind ?? 'unmarked'}`;
  }

  // Called when the agent takes a feedback batch: closes the round and snapshots the board.
  closeRound() {
    const b = this.board;
    b.rounds.push({ id: b.round, at: now(), label: `Round ${b.round}, ${new Date().toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}` });
    b.round++;
    b.revision++;
    this.save();
    fs.writeFileSync(path.join(this.p.history, `rev-${b.revision}.json`), JSON.stringify(b));
  }

  // Counts of sent-but-undelivered feedback.
  pending() {
    let comments = 0, items = 0, marks = 0, reactions = 0, replies = 0;
    for (const it of this.board.items) {
      if (it.createdBy === 'human' && it.sent !== undefined && !it.delivered && it.state === 'active') {
        if (it.comment) comments++; else if (it.kind === 'mark') marks++; else if (it.kind !== 'arrow') items++;
      }
      if (it.reaction?.sent !== undefined && !it.reaction.delivered) reactions++;
      for (const t of it.comment?.thread ?? []) if (t.by === 'human' && t.sent !== undefined && !t.delivered) replies++;
    }
    return { comments, items, marks, reactions, replies, total: comments + items + marks + reactions + replies };
  }

  decisions(last = 3): string[] {
    if (!fs.existsSync(this.p.decisions)) return [];
    return fs.readFileSync(this.p.decisions, 'utf8').trim().split('\n').filter(Boolean).slice(-last);
  }
}

export function line(s: Store, it: Item): string {
  const v = it.versions[it.versions.length - 1].v;
  const sec = s.board.sections.find(x => x.id === it.section);
  return `${it.key} v${v} ${kindOf(it)} @${it.x},${it.y} ${it.w}x${it.h}${sec ? ` [${sec.title}]` : ''}`;
}

function migrate(b: Board): Board {
  if (b.schemaVersion > SCHEMA) throw new Error(`board.json schema ${b.schemaVersion} is newer than this drawpad`);
  b.schemaVersion = SCHEMA;
  // Boards from before drafts were dropped: anything still a draft counts as sent.
  for (const it of b.items) {
    if (it.createdBy === 'human' && it.sent === undefined) { it.sent = b.revision; it.delivered = false; }
    if (it.reaction && it.reaction.sent === undefined) { it.reaction.sent = b.revision; it.reaction.delivered = false; }
    for (const t of it.comment?.thread ?? []) if (t.by === 'human' && t.sent === undefined) t.sent = b.revision;
  }
  return b;
}
