import type { Board, Item, Section } from './types.ts';

// Semantic placement: callers name an anchor or a section, never coordinates.
export const GAP = 40, PAD = 40, SECTION_GAP = 160, ROW_MAX = 3600;

export interface Rect { x: number; y: number; w: number; h: number }
export interface PlaceOpts { at?: [number, number]; below?: Item; rightOf?: Item; inRowWith?: Item; flow?: 'right' | 'down' }

export const solid = (b: Board) => b.items.filter(i => i.state === 'active' && i.kind !== 'arrow');
const members = (b: Board, s: Section) => solid(b).filter(i => i.section === s.id);

// Box = members (comments float, they don't stretch it), and at least the drawn frame.
export function sectionRect(b: Board, s: Section, ignore?: string): Rect {
  const m: Rect[] = members(b, s).filter(i => i.id !== ignore && !i.comment).map(i => ({ x: i.x - PAD, y: i.y - PAD, w: i.w + 2 * PAD, h: i.h + 2 * PAD }));
  if (s.w && s.h) m.push({ x: s.x - PAD, y: s.y - PAD, w: s.w, h: s.h });
  if (!m.length) return { x: s.x - PAD, y: s.y - PAD, w: 400, h: 160 };
  const x0 = Math.min(...m.map(i => i.x)), y0 = Math.min(...m.map(i => i.y));
  return { x: x0, y: y0, w: Math.max(...m.map(i => i.x + i.w)) - x0, h: Math.max(...m.map(i => i.y + i.h)) - y0 };
}

export function contentBottom(b: Board): number | null {
  const bottoms = [...solid(b).map(i => i.y + i.h), ...b.sections.map(s => { const r = sectionRect(b, s); return r.y + r.h; })];
  return bottoms.length ? Math.max(...bottoms) : null;
}

const hit = (a: Rect, b: Rect, m = 0) => a.x < b.x + b.w + m && b.x < a.x + a.w + m && a.y < b.y + b.h + m && b.y < a.y + a.h + m;

// Places `it` (sets x, y). Returns human-readable problems; empty when the placement was clean.
export function place(b: Board, it: Item, o: PlaceOpts): string[] {
  const problems: string[] = [];
  let x = 0, y = 0;
  const sec = b.sections.find(s => s.id === it.section);
  if (o.at) [x, y] = o.at;
  else if (o.below) { x = o.below.x; y = o.below.y + o.below.h + GAP; }
  else if (o.rightOf) { x = o.rightOf.x + o.rightOf.w + GAP; y = o.rightOf.y; }
  else if (o.inRowWith) {
    const a = o.inRowWith;
    const row = solid(b).filter(i => i.id !== it.id && i.section === a.section && Math.abs(i.y - a.y) < 1);
    x = Math.max(...row.map(i => i.x + i.w)) + GAP; y = a.y;
  } else if (sec) {
    const m = members(b, sec).filter(i => i.id !== it.id);
    if (!m.length) { x = sec.x; y = sec.y; }
    else {
      const rowY = Math.max(...m.map(i => i.y));
      x = Math.max(...m.filter(i => Math.abs(i.y - rowY) < 1).map(i => i.x + i.w)) + GAP; y = rowY;
      if (x + it.w > sec.x + ROW_MAX) { x = sec.x; y = Math.max(...m.map(i => i.y + i.h)) + GAP; }
    }
  } else {
    const bottom = contentBottom(b);
    x = 0; y = bottom === null ? 0 : bottom + SECTION_GAP;
  }
  it.x = Math.round(x); it.y = Math.round(y);

  const others = solid(b).filter(i => i.id !== it.id);
  for (let n = 0; n < 500; n++) {
    const ob = others.find(o2 => hit(it, o2));
    if (!ob) break;
    if (o.flow === 'down') it.y = ob.y + ob.h + GAP; else it.x = ob.x + ob.w + GAP;
  }
  if (o.at && (it.x !== Math.round(x) || it.y !== Math.round(y)))
    problems.push(`overlap at ${Math.round(x)},${Math.round(y)}; placed at ${it.x},${it.y}`);
  if (it.kind === 'image' && it.w < 120) problems.push(`small: ${it.w}px wide is hard to read`);
  problems.push(...pushSections(b));
  return problems;
}

// Pushes sections down when a section above has grown into them. Returns what moved.
export function pushSections(b: Board): string[] {
  const moved: string[] = [];
  const order = [...b.sections].sort((p, q) => sectionRect(b, p).y - sectionRect(b, q).y);
  for (let i = 0; i < order.length; i++) {
    const a = sectionRect(b, order[i]);
    for (let j = i + 1; j < order.length; j++) {
      const r = sectionRect(b, order[j]);
      if (!hit(a, r, SECTION_GAP / 2)) continue;
      const dy = a.y + a.h + SECTION_GAP - r.y;
      if (dy <= 0) continue;
      moveSection(b, order[j], 0, dy);
      moved.push(`pushed section "${order[j].title}" down ${Math.round(dy)}`);
    }
  }
  return moved;
}

export function moveSection(b: Board, s: Section, dx: number, dy: number) {
  s.x += dx; s.y += dy; s.rev = b.revision;
  for (const i of members(b, s)) { i.x += dx; i.y += dy; i.rev = b.revision; }
}

// Default display size for an image of pw x ph pixels.
export function imageBox(pw: number, ph: number, w?: number, h?: number): [number, number] {
  if (w && h) return [w, h];
  const ar = ph / pw;
  if (w) return [w, Math.round(w * ar)];
  if (h) return [Math.round(h / ar), h];
  const dw = ar > 1 ? 300 : 480;
  return [dw, Math.round(dw * ar)];
}

export function textHeight(text: string, w: number): number {
  const perLine = Math.max(10, Math.floor((w - 24) / 7.5));
  const lines = text.split('\n').reduce((n, l) => n + Math.max(1, Math.ceil(l.length / perLine)), 0);
  return Math.min(900, 28 + lines * 20);
}
