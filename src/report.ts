import type { Item } from './types.ts';
import type { Store } from './store.ts';

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
  const out = [`rev ${b.revision} · round ${b.round} · ${b.items.filter(i => i.kind !== 'arrow' && !i.comment && i.state === 'active' && !draft(i)).length} items${since !== undefined ? ` · changes since ${since}` : ''}`];

  const desc = (it: Item) => {
    const v = cur(it).v;
    let d = `${it.key} ${it.kind}${v > 1 ? ` v${v}` : ''}`;
    if (it.state !== 'active') d += ` ${it.state}`;
    if (it.createdBy === 'human') d += ' (human)';
    else if (!it.seenByHuman) d += ' *';
    if (it.title) d += ` "${clip(it.title, 40)}"`;
    if (it.reaction?.sent !== undefined) d += ` ${it.reaction.kind}d`;
    return d;
  };
  const listable = vis.filter(i => i.kind !== 'arrow' && !i.comment && (i.state === 'active' || since !== undefined));
  for (const sec of b.sections) {
    if (section && sec.title.toLowerCase() !== section.toLowerCase()) continue;
    const m = listable.filter(i => i.section === sec.id);
    if (m.length || (since !== undefined && sec.rev > since)) out.push(`## ${sec.title} (${m.length})`, ...m.map(desc));
  }
  const loose = listable.filter(i => !b.sections.some(x => x.id === i.section));
  if (loose.length && !section) out.push('## Inbox / loose', ...loose.map(desc));

  const arrows = vis.filter(i => i.kind === 'arrow' && i.state === 'active' && !byId.get(i.from!)?.comment);
  if (arrows.length) out.push('arrows: ' + arrows.map(a => `${byId.get(a.from!)?.key}->${byId.get(a.to!)?.key}${a.label ? `(${a.label})` : ''}`).join(', '));

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
    sent !== undefined && (o.since !== undefined ? sent > o.since : !delivered);

  const items = b.items.filter(i => i.createdBy === 'human' && i.state === 'active' && take(i.sent, i.delivered));
  const reacts = b.items.filter(i => i.reaction && take(i.reaction.sent, i.reaction.delivered));
  const replies = b.items.flatMap(i => (i.comment?.thread ?? []).filter(t => t.by === 'human' && take(t.sent, t.delivered)).map(t => ({ it: i, t })));

  const comments = items.filter(i => i.comment);
  const todo = comments.filter(c => c.comment!.intent !== 'keep'), keep = comments.filter(c => c.comment!.intent === 'keep');
  const news = items.filter(i => !i.comment && i.kind !== 'arrow');
  const arrows = items.filter(i => i.kind === 'arrow' && !byId.get(i.from!)?.comment);

  if (o.json) {
    mark(); return JSON.stringify({ rev: b.revision, comments, news, arrows, reactions: reacts.map(i => ({ key: i.key, ...i.reaction })), replies: replies.map(r => ({ key: r.it.key, text: r.t.text })) });
  }
  const total = comments.length + news.length + arrows.length + reacts.length + replies.length;
  if (!total) return 'no new feedback';

  const out = [`feedback rev ${b.revision}: ${todo.length} to-do, ${keep.length} keep, ${news.length} new, ${reacts.length} reactions`];
  const pointTo = (it: Item) => b.items.filter(a => a.kind === 'arrow' && a.from === it.id && a.state === 'active').map(a => byId.get(a.to!)?.key).filter(Boolean);
  const com = (c: Item) => {
    const k = c.comment!, t = byId.get(k.target!);
    const now = t ? cur(t).v : 0;
    let l = `${c.key} [${k.intent}] on ${t?.key} v${k.targetVersion}${now > (k.targetVersion ?? 0) ? ` (now v${now})` : ''}`;
    if (k.point) l += ` @${k.point.map(v => v.toFixed(2)).join(',')}`;
    if (k.region) l += ` region ${k.region[2].toFixed(2)}x${k.region[3].toFixed(2)}`;
    if (k.crop && !o.crops) l += ' (crop)';
    const lines = [`${l}: ${cur(c).text}`];
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
    else out.push(`${n.key} new text${tail}: ${v.text}`);
  }
  for (const a of arrows) out.push(`arrow ${byId.get(a.from!)?.key} -> ${byId.get(a.to!)?.key}${a.toPoint ? ` @${a.toPoint.map(v => v.toFixed(2))}` : ''}${a.label ? ` "${a.label}"` : ''}`);
  for (const r of reacts) out.push(`${r.reaction!.kind} ${r.key} v${r.reaction!.version}${r.reaction!.reason ? `: ${r.reaction!.reason}` : ''}`);
  for (const r of replies) out.push(`${r.it.key} reply: ${r.t.text}`);
  mark();
  return out.join('\n');

  function mark() {
    for (const i of items) i.delivered = true;
    for (const i of reacts) i.reaction!.delivered = true;
    for (const r of replies) r.t.delivered = true;
    if (items.length + reacts.length + replies.length) s.closeRound();
  }
}

export function hookLine(p: { comments: number; items: number; reactions: number; replies: number; total: number }): string {
  if (!p.total) return '';
  const parts = [p.comments && `${p.comments} comments`, p.items && `${p.items} new items`, p.reactions && `${p.reactions} reactions`, p.replies && `${p.replies} replies`].filter(Boolean);
  return `DrawPad: ${parts.join(', ')} waiting. Run \`drawpad feedback\`.`;
}
