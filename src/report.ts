import type { Item } from './types.ts';
import type { Store } from './store.ts';
import { kindOf } from './layout.ts';

// Compact text views for the agent. Every byte here costs tokens: keep it terse.

const clip = (s: string, n: number) => { const t = s.replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const cur = (it: Item) => it.versions[it.versions.length - 1];
const draft = (it: Item) => it.createdBy === 'human' && it.sent === undefined;
const A = '.drawpad/assets/';

export function boardText(s: Store, since?: number, section?: string): string {
  const b = s.board;
  if (since !== undefined && since >= b.revision) return 'unchanged';
  const byId = new Map(b.items.map(i => [i.id, i]));
  const vis = b.items.filter(i => !draft(i) && (since === undefined || i.rev > since));
  const out = [`rev ${b.revision} · round ${b.round} · ${b.items.filter(i => i.kind !== 'arrow' && i.kind !== 'mark' && !i.comment && i.state === 'active' && !draft(i)).length} items${since !== undefined ? ` · changes since ${since}` : ''}`];

  const desc = (it: Item) => {
    const v = cur(it).v;
    let d = `${it.key} ${kindOf(it)}${v > 1 ? ` v${v}` : ''}`;
    if (it.state !== 'active') d += ` ${it.state}`;
    if (it.createdBy === 'human') d += ' (human)';
    else if (!it.seenByHuman) d += ' *';
    if (it.title) d += ` "${clip(it.title, 40)}"`;
    if (it.reaction?.sent !== undefined) d += ` ${it.reaction.kind}d`;
    return d;
  };
  const listable = vis.filter(i => i.kind !== 'arrow' && i.kind !== 'mark' && !i.comment && (i.state === 'active' || since !== undefined));
  for (const sec of b.sections) {
    if (section && sec.title.toLowerCase() !== section.toLowerCase()) continue;
    const m = listable.filter(i => i.section === sec.id);
    if (m.length || (since !== undefined && sec.rev > since)) out.push(`## ${sec.title} (${m.length})`, ...m.map(desc));
  }
  const loose = listable.filter(i => !b.sections.some(x => x.id === i.section));
  if (loose.length && !section) out.push('## Inbox / loose', ...loose.map(desc));

  const arrows = vis.filter(i => i.kind === 'arrow' && i.state === 'active' && !byId.get(i.from!)?.comment);
  if (arrows.length) out.push('arrows: ' + arrows.map(a => `${byId.get(a.from!)?.key}->${byId.get(a.to!)?.key}${a.label ? `(${a.label})` : ''}`).join(', '));

  const marks = b.items.filter(i => i.mark && i.state === 'active');
  if (marks.length) out.push(`drawings: ${marks.map(m => markText(b.items, m)).join('; ')}`);

  const comments = b.items.filter(i => i.comment && i.state === 'active' && !draft(i) && i.comment.status !== 'resolved');
  const todo = comments.filter(c => c.comment!.intent !== 'keep');
  const cl = (c: Item) => `${c.key} [${c.comment!.intent}${c.comment!.status === 'addressed' ? ', addressed' : ''}] on ${byId.get(c.comment!.target!)?.key} v${c.comment!.targetVersion}: "${clip(cur(c).text ?? '', 70)}"`;
  if (todo.length) out.push(`open (${todo.length}):`, ...todo.map(cl));
  const keep = comments.filter(c => c.comment!.intent === 'keep');
  if (keep.length) out.push('keep (no action): ' + keep.map(c => `${byId.get(c.comment!.target!)?.key} "${clip(cur(c).text ?? '', 40)}"`).join('; '));
  if (since === undefined) {
    const unseen = b.items.filter(i => i.createdBy === 'agent' && !i.seenByHuman && i.state === 'active' && i.kind !== 'arrow');
    if (unseen.length) out.push(`unseen by human: ${unseen.length}`);
    const dec = s.decisions();
    if (dec.length) out.push('decisions:', ...dec);
    const p = s.pending();
    if (p.total) out.push(`undelivered feedback: ${p.total} (drawpad feedback)`);
  }
  return out.join('\n');
}

export interface FeedbackOpts { since?: number; crops?: boolean; json?: boolean }

export function feedbackText(s: Store, o: FeedbackOpts): string {
  const b = s.board;
  const byId = new Map(b.items.map(i => [i.id, i]));
  const take = (sent: number | undefined, delivered: boolean | undefined) =>
    sent !== undefined && sent <= (b.released ?? Infinity) && (o.since !== undefined ? sent > o.since : !delivered);

  const items = b.items.filter(i => i.createdBy === 'human' && i.state === 'active' && take(i.sent, i.delivered));
  const reacts = b.items.filter(i => i.reaction && take(i.reaction.sent, i.reaction.delivered));
  const replies = b.items.flatMap(i => (i.comment?.thread ?? []).filter(t => t.by === 'human' && take(t.sent, t.delivered)).map(t => ({ it: i, t })));

  const comments = items.filter(i => i.comment);
  const todo = comments.filter(c => c.comment!.intent !== 'keep'), keep = comments.filter(c => c.comment!.intent === 'keep');
  const news = items.filter(i => !i.comment && i.kind !== 'arrow' && i.kind !== 'mark');
  const marks = items.filter(i => i.mark);
  const arrows = items.filter(i => i.kind === 'arrow' && !byId.get(i.from!)?.comment);

  if (o.json) {
    mark(); return JSON.stringify({ rev: b.revision, comments, news, arrows, reactions: reacts.map(i => ({ key: i.key, ...i.reaction })), replies: replies.map(r => ({ key: r.it.key, text: r.t.text })) });
  }
  const total = comments.length + news.length + marks.length + arrows.length + reacts.length + replies.length;
  if (!total) return 'no new feedback';

  const out = [`feedback rev ${b.revision}: ${todo.length} to-do, ${keep.length} keep, ${news.length} new, ${reacts.length} reactions${marks.length ? `, ${marks.length} drawings` : ''}`];
  const pointTo = (it: Item) => b.items.filter(a => a.kind === 'arrow' && a.from === it.id && a.state === 'active').map(a => byId.get(a.to!)?.key).filter(Boolean);
  const com = (c: Item) => {
    const k = c.comment!, t = byId.get(k.target!);
    const now = t ? cur(t).v : 0;
    let l = `${c.key} [${k.intent}] on ${t?.key} v${k.targetVersion}${now > (k.targetVersion ?? 0) ? ` (now v${now})` : ''}`;
    if (k.point) l += ` @${k.point.map(v => v.toFixed(2)).join(',')}`;
    if (k.region) l += ` region ${k.region[2].toFixed(2)}x${k.region[3].toFixed(2)}`;
    if (k.crop && !o.crops) l += ' (crop)';
    const lines = [`${l}: ${cur(c).text}`];
    if (k.el) lines.push(`  el: ${k.el}`);
    const src = t?.source;
    if (src) lines.push('  src: ' + [src.commit && `commit=${src.commit}`, src.launch && `launch="${src.launch}"`, src.files?.length && `files=${src.files.join(',')}`, src.note].filter(Boolean).join(' '));
    if (k.crop && o.crops) lines.push(`  crop: ${A}${k.crop}`);
    return lines.join('\n');
  };
  out.push(...todo.map(com));
  if (keep.length) out.push('keep (no action):', ...keep.map(com));
  for (const n of news) {
    const v = cur(n), to = pointTo(n), sec = b.sections.find(x => x.id === n.section)?.title ?? 'Inbox';
    const tail = `${to.length ? ` -> ${to.join(',')}` : ''} [${sec}]`;
    if (n.kind === 'image') out.push(`${n.key} new image ${v.pw}x${v.ph} ${A}${v.asset}${tail}`);
    else if (n.kind === 'link') out.push(`${n.key} new link ${v.url}${n.title ? ` "${clip(n.title, 60)}"` : ''}${tail}`);
    else {
      // Where a loose note sits says what it's about: name the nearest thing.
      const cx = n.x + n.w / 2, cy = n.y + n.h / 2;
      const near = b.items.filter(i => i !== n && i.state === 'active' && !i.comment && (i.kind === 'image' || i.kind === 'link' || i.kind === 'text'))
        .map(i => ({ i, d: Math.hypot(Math.max(i.x - cx, 0, cx - i.x - i.w), Math.max(i.y - cy, 0, cy - i.y - i.h)) })).sort((p, q) => p.d - q.d)[0];
      out.push(`${n.key} new text${near && near.d < 400 ? ` near ${near.i.key}` : ''}${tail}: ${v.text}`);
    }
  }
  for (const a of arrows) out.push(`arrow ${byId.get(a.from!)?.key} -> ${byId.get(a.to!)?.key}${a.toPoint ? ` @${a.toPoint.map(v => v.toFixed(2))}` : ''}${a.label ? ` "${a.label}"` : ''}`);
  // Drawings: one line each, one image per target (the latest crop shows all its drawings).
  const crops = new Map<string, string>();
  for (const m of marks) {
    out.push(markText(b.items, m));
    if (m.mark!.on && m.mark!.crop) crops.set(m.mark!.on, m.mark!.crop);
  }
  for (const [on, c] of crops) out.push(o.crops ? `  drawn on ${byId.get(on)?.key}: ${A}${c}` : `  (crop of ${byId.get(on)?.key} with drawings: --crops)`);
  for (const r of reacts) out.push(`${r.reaction!.kind} ${r.key} v${r.reaction!.version}${r.reaction!.reason ? `: ${r.reaction!.reason}` : ''}`);
  // Enough context to act without another call: the target, the comment, and what the human is answering.
  for (const r of replies) {
    const k = r.it.comment!, th = k.thread, prev = th[th.indexOf(r.t) - 1];
    const ctx = `"${clip(cur(r.it).text ?? '', 50)}"` + (prev?.by === 'agent' ? ` > you: "${clip(prev.text, 50)}"` : '');
    out.push(`${r.it.key} reply on ${byId.get(k.target!)?.key ?? '?'} (${ctx})${r.t.edited ? ' (edited)' : ''}: ${r.t.text}`);
  }
  mark();
  return out.join('\n');

  function mark() {
    for (const i of items) i.delivered = true;
    for (const i of reacts) i.reaction!.delivered = true;
    for (const r of replies) r.t.delivered = true;
    if (items.length + reacts.length + replies.length) s.closeRound();
  }
}

// "m-12 line on s1 (0.10,0.30)-(0.90,0.30)" or "m-13 arrow s1 -> s2" / "m-14 rect around s1,s2" for free drawings.
function markText(all: Item[], m: Item): string {
  const k = m.mark!, f = (v: number) => v.toFixed(2);
  if (k.on) return `${m.key} ${k.shape} on ${all.find(i => i.id === k.on)?.key} (${f(k.pts[0])},${f(k.pts[1])})-(${f(k.pts[2])},${f(k.pts[3])})`;
  const live = all.filter(i => i.state === 'active' && i.kind !== 'arrow' && i.kind !== 'mark' && !i.comment);
  const at = (x: number, y: number) => live.find(i => x >= i.x && x <= i.x + i.w && y >= i.y && y <= i.y + i.h)?.key ?? 'canvas';
  const [x1, y1, x2, y2] = k.pts;
  if (k.shape === 'line' || k.shape === 'arrow') return `${m.key} ${k.shape} ${at(x1, y1)} -> ${at(x2, y2)}`;
  const r = { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
  const inside = live.filter(i => i.x < r.x + r.w && r.x < i.x + i.w && i.y < r.y + r.h && r.y < i.y + i.h).map(i => i.key);
  return `${m.key} ${k.shape} around ${inside.join(',') || 'empty canvas'}`;
}

export function hookLine(p: { comments: number; items: number; marks?: number; reactions: number; replies: number; total: number }): string {
  if (!p.total) return '';
  const parts = [p.comments && `${p.comments} comments`, p.items && `${p.items} new items`, p.marks && `${p.marks} drawings`, p.reactions && `${p.reactions} reactions`, p.replies && `${p.replies} replies`].filter(Boolean);
  return `DrawPad: ${parts.join(', ')} waiting. Run \`drawpad feedback\`.`;
}
