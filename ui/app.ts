// DrawPad board UI: custom minimal canvas (transformed div + one SVG layer for arrows and pins).
import type { Board, Item, Intent, Section } from '../src/types.ts';

const PAD = 24, THUMB_W = 640;
const $ = <T extends HTMLElement>(s: string) => document.querySelector(s) as T;
const view$ = $('#view'), world = $('#world'), svg = document.querySelector('#arrows') as SVGSVGElement;

type Op = Record<string, unknown>;
type Rect = { x: number; y: number; w: number; h: number };

let board: Board | null = null;
let view = { x: 40, y: 40, z: 0.5 };
let tool: 'select' | 'comment' = 'select';
let sel: string | null = null;
let busy: string | null = null; // id being dragged: live updates skip it
let mouse: [number, number] = [0, 0];
let space = false;              // space held = hand tool
const els = new Map<string, HTMLElement>();
// Only touch the DOM when the markup changed: replacing an element mid-click swallows the click.
const setHTML = (el: HTMLElement, html: string) => { if (el.dataset.html !== html) { el.innerHTML = html; el.dataset.html = html; } };
const secEls = new Map<string, HTMLElement>();
let byId = new Map<string, Item>();

// ---------- data ----------
async function load() {
  board = await (await fetch('/api/board')).json();
  byId = new Map(board!.items.map(i => [i.id, i]));
  render();
}
async function op(o: Op): Promise<string> {
  const r = await fetch('/api/op', { method: 'POST', body: JSON.stringify({ by: 'human', ...o }) });
  const t = await r.text();
  if (!r.ok) { hint(t, true); throw new Error(t); }
  return t;
}
async function upload(blob: Blob, ext: string, prefix = 'up'): Promise<string> {
  const r = await fetch(`/api/upload?ext=${ext}&prefix=${prefix}`, { method: 'POST', body: blob });
  return (await r.json()).asset;
}
const cur = (it: Item) => it.versions[it.versions.length - 1];
const active = () => board!.items.filter(i => i.state === 'active');
const solid = () => active().filter(i => i.kind !== 'arrow');

// ---------- undo / redo (the human's own actions) ----------
const undos: { undo: Op; redo: Op }[] = [], redos: { undo: Op; redo: Op }[] = [];
async function act(redo: Op, undo: Op) { await op(redo); undos.push({ undo, redo }); redos.length = 0; }
// For creations: the undo target is only known from the result line ("key v1 ...").
async function create(o: Op) {
  const key = (await op(o)).split(' ')[0];
  undos.push({ undo: { op: 'archive', id: key }, redo: { op: 'restore', id: key } }); redos.length = 0;
  return key;
}
async function undoLast() { const u = undos.pop(); if (!u) return hint('Nothing to undo'); await op(u.undo); redos.push(u); hint('Undone · ⇧⌘Z to redo'); }
async function redoLast() { const u = redos.pop(); if (!u) return hint('Nothing to redo'); await op(u.redo); undos.push(u); hint('Redone'); }

function sectionRect(s: Section): Rect {
  const m = solid().filter(i => i.section === s.id);
  if (!m.length) return { x: s.x - PAD, y: s.y - PAD, w: 400, h: 160 };
  const x0 = Math.min(...m.map(i => i.x)), y0 = Math.min(...m.map(i => i.y));
  const x1 = Math.max(...m.map(i => i.x + i.w)), y1 = Math.max(...m.map(i => i.y + i.h));
  return { x: x0 - PAD, y: y0 - PAD, w: x1 - x0 + 2 * PAD, h: y1 - y0 + 2 * PAD };
}

// ---------- view ----------
function applyView() {
  world.style.transform = `translate(${view.x}px,${view.y}px) scale(${view.z})`;
  world.style.setProperty('--inv', String(1 / view.z));
  world.classList.toggle('far', view.z < 0.22);
  view$.style.backgroundSize = `${24 * view.z}px ${24 * view.z}px`;
  view$.style.backgroundPosition = `${view.x}px ${view.y}px`;
  cull();
  drawArrows();
  saveView();
  markSeenSoon();
}
let saveT = 0;
function saveView() { clearTimeout(saveT); saveT = window.setTimeout(() => board && localStorage.setItem('view-' + board.id, JSON.stringify(view)), 300); }

function toWorld(cx: number, cy: number): [number, number] {
  const r = view$.getBoundingClientRect();
  return [(cx - r.left - view.x) / view.z, (cy - r.top - view.y) / view.z];
}
function fit(r: Rect | null) {
  if (!r) return;
  const vw = view$.clientWidth, vh = view$.clientHeight;
  const z = Math.min(vw / (r.w + 120), vh / (r.h + 160), 1.5);
  view = { z, x: (vw - r.w * z) / 2 - r.x * z, y: (vh - r.h * z) / 2 - r.y * z + 20 };
  applyView();
}
function bbox(items: Rect[]): Rect | null {
  if (!items.length) return null;
  const x0 = Math.min(...items.map(i => i.x)), y0 = Math.min(...items.map(i => i.y));
  return { x: x0, y: y0, w: Math.max(...items.map(i => i.x + i.w)) - x0, h: Math.max(...items.map(i => i.y + i.h)) - y0 };
}
const fitAll = () => board && fit(bbox(solid()));

function viewport() {
  const r = view$.getBoundingClientRect();
  const [x0, y0] = toWorld(r.left, r.top);
  return { x0, y0, x1: x0 + view$.clientWidth / view.z, y1: y0 + view$.clientHeight / view.z };
}
// Hide off-screen items; swap thumbnails for full images when zoomed in.
function cull() {
  if (!board) return;
  const v = viewport(), m = 200 / view.z;
  for (const it of solid()) {
    const el = els.get(it.id); if (!el) continue;
    const vis = it.x + it.w > v.x0 - m && it.x < v.x1 + m && it.y + it.h > v.y0 - m && it.y < v.y1 + m;
    el.style.display = vis ? '' : 'none';
    if (vis && it.kind === 'image') {
      const ver = cur(it), img = el.querySelector('img')!;
      const want = '/a/' + (ver.thumb && it.w * view.z * devicePixelRatio < THUMB_W * 1.1 ? ver.thumb : ver.asset);
      if (img.getAttribute('src') !== want) img.setAttribute('src', want);
    }
  }
}
// Agent items that stay on screen at a readable size for 1.5s count as seen (clears the blue dot).
let seenT = 0;
function markSeenSoon() {
  clearTimeout(seenT);
  seenT = window.setTimeout(() => {
    if (!board || document.hidden) return;
    const v = viewport();
    const ids = solid().filter(i => i.createdBy === 'agent' && !i.seenByHuman && i.w * view.z > 140 &&
      i.x >= v.x0 && i.x + i.w <= v.x1 + i.w / 2 && i.y >= v.y0 - i.h / 2 && i.y <= v.y1).map(i => i.id);
    if (ids.length) op({ op: 'seen', ids }).catch(() => {});
  }, 1500);
}

// ---------- render ----------
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
function md(src: string): string {
  const inline = (s: string) => esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1<i>$2</i>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank">$1</a>')
    .replace(/(^|\s)(https?:\/\/[^\s<]+)/g, '$1<a href="$2" target="_blank">$2</a>');
  let html = '', list = false;
  for (const l of src.split('\n')) {
    const li = /^\s*[-*] (.*)/.exec(l);
    if (li) { if (!list) { html += '<ul>'; list = true; } html += `<li>${inline(li[1])}</li>`; continue; }
    if (list) { html += '</ul>'; list = false; }
    const h = /^#{1,3} (.*)/.exec(l);
    html += h ? `<h3>${inline(h[1])}</h3>` : l.trim() ? `<p>${inline(l)}</p>` : '';
  }
  return html + (list ? '</ul>' : '');
}

function content(it: Item): string {
  const v = cur(it);
  const label = (txt: string) => `<div class="label"><b>${esc(txt)}</b>${v.v > 1 ? ` v${v.v}` : ''}${it.createdBy === 'agent' && it.title ? ` · ${esc(it.key)}` : ''}</div>`;
  const dot = it.createdBy === 'agent' && !it.seenByHuman ? '<div class="dot"></div>' : '';
  const react = it.reaction ? `<div class="react ${it.reaction.kind}">${it.reaction.kind === 'approve' ? '✓ approved' : '✗ rejected'}${it.reaction.reason ? `: ${esc(it.reaction.reason)}` : ''}</div>` : '';
  if (it.kind === 'image') return `<img draggable="false">${label(it.title ?? it.key)}${dot}${react}`;
  if (it.kind === 'link') {
    let host = v.url!; try { host = new URL(v.url!).host; } catch { /* keep */ }
    return `<div class="card link" style="height:100%"><div class="t">${esc(it.title ?? host)}</div><a href="${esc(v.url!)}" target="_blank" class="host">${esc(v.url!)}</a></div>${dot}${react}`;
  }
  if (it.comment) {
    const c = it.comment;
    const thread = c.thread.map(t => `<div class="reply"><b>${t.by === 'agent' ? 'agent' : 'you'}</b> ${md(t.text)}</div>`).join('');
    const mine = it.createdBy === 'human';
    const acts = c.status !== 'resolved'
      ? `<div class="acts"><button data-act="reply">Reply</button>${mine ? '<button data-act="resolve">Resolve</button>' : ''}</div>`
      : `<div class="acts"><button data-act="reopen">Reopen</button></div>`;
    const state = c.status === 'open' ? (it.delivered || !mine ? 'open' : 'waiting for agent') : c.status;
    return `<div class="card comment${c.status === 'resolved' ? ' done' : ''}" style="height:100%"><div class="head"><span class="chip i-${c.intent}"${mine ? ' data-act="intent" title="Click to change"' : ''}>${c.intent}</span>` +
      `<span class="s-${c.status}">${state}${c.artifact ? ` → ${esc(c.artifact)}` : ''}</span></div>${md(v.text ?? '')}${thread}${acts}</div>${dot}`;
  }
  return `<div class="card" style="height:100%">${md(v.text ?? '')}</div>${it.title ? label(it.title) : ''}${dot}${react}`;
}

function render() {
  if (!board) return;
  const live = new Set<string>();
  for (const it of solid()) {
    live.add(it.id);
    let el = els.get(it.id);
    if (!el) { el = document.createElement('div'); el.dataset.id = it.id; world.appendChild(el); els.set(it.id, el); }
    if (el.dataset.rev !== String(it.rev) || el.dataset.sel !== String(sel === it.id)) {
      el.className = `item ${it.kind}${sel === it.id ? ' sel' : ''}`;
      el.innerHTML = content(it) + (sel === it.id ? '<div class="handle"></div>' : '');
      el.dataset.rev = String(it.rev); el.dataset.sel = String(sel === it.id);
    }
    if (busy !== it.id) place(el, it);
  }
  for (const [id, el] of els) if (!live.has(id)) { el.remove(); els.delete(id); }

  const liveS = new Set<string>();
  for (const s of board.sections) {
    liveS.add(s.id);
    let el = secEls.get(s.id);
    if (!el) {
      el = document.createElement('div'); el.className = 'section'; el.dataset.sec = s.id;
      el.innerHTML = '<div class="sectitle" title="Drag to move the section · double-click to rename"></div>';
      world.prepend(el); secEls.set(s.id, el);
    }
    const t = el.firstChild as HTMLElement;
    if (!t.isContentEditable) t.textContent = s.title;
    place(el, sectionRect(s));
  }
  for (const [id, el] of secEls) if (!liveS.has(id)) { el.remove(); secEls.delete(id); }

  outline(); status(); selbar(); cull(); drawArrows();
  requestAnimationFrame(fitCards);
}
// Text cards grow to their content; the real height goes back to the server so placement stays honest.
function fitCards() {
  for (const it of solid()) {
    if (it.kind !== 'text' || busy === it.id) continue;
    const card = els.get(it.id)?.querySelector('.card') as HTMLElement | null;
    if (!card || card.offsetParent === null) continue;
    const need = card.scrollHeight + 2;
    if (need > it.h + 2) { it.h = need; op({ op: 'move', id: it.id, x: it.x, y: it.y, h: need, by: 'agent' }).catch(() => {}); }
  }
}
function place(el: HTMLElement, r: Rect) {
  el.style.left = r.x + 'px'; el.style.top = r.y + 'px'; el.style.width = r.w + 'px'; el.style.height = r.h + 'px';
}
function refreshSections() {
  for (const s of board!.sections) { const el = secEls.get(s.id); if (el) place(el, sectionRect(s)); }
}

function edge(r: Rect, p: [number, number]): [number, number] {
  const cx = r.x + r.w / 2, cy = r.y + r.h / 2, dx = p[0] - cx, dy = p[1] - cy;
  if (!dx && !dy) return [cx, cy];
  const s = Math.min(1, Math.min(Math.abs((r.w / 2) / dx || Infinity), Math.abs((r.h / 2) / dy || Infinity)));
  return [cx + dx * s, cy + dy * s];
}
function arrowPath(a: [number, number], b: [number, number], cls = '') {
  const k = 1 / view.z, len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  const ux = (b[0] - a[0]) / len, uy = (b[1] - a[1]) / len, hs = 11 * k;
  const bx = b[0] - ux * hs, by = b[1] - uy * hs;
  const head = `${b[0]},${b[1]} ${bx - uy * hs * 0.5},${by + ux * hs * 0.5} ${bx + uy * hs * 0.5},${by - ux * hs * 0.5}`;
  return `<g class="${cls}"><path class="ar" stroke-width="${2 * k}" d="M${a[0]},${a[1]}L${bx},${by}"/><polygon class="head" points="${head}"/></g>`;
}
function drawArrows() {
  if (!board) return;
  const k = 1 / view.z;
  let html = '';
  for (const a of active()) {
    if (a.kind !== 'arrow') continue;
    const f = byId.get(a.from!), t = byId.get(a.to!);
    if (!f || !t || f.state !== 'active' || t.state !== 'active') continue;
    const end: [number, number] = a.toPoint ? [t.x + a.toPoint[0] * t.w, t.y + a.toPoint[1] * t.h] : edge(t, [f.x + f.w / 2, f.y + f.h / 2]);
    const start = edge(f, end);
    const pin = f.comment && a.toPoint;
    if (!pin) html += `<path class="hit" data-id="${a.id}" stroke-width="${14 * k}" d="M${start[0]},${start[1]}L${end[0]},${end[1]}"/>`;
    html += pin ? `<g class="${sel === a.id ? 'sel' : ''}"><path class="ar" stroke-width="${2 * k}" d="M${start[0]},${start[1]}L${end[0]},${end[1]}"/></g>` : arrowPath(start, end, sel === a.id ? 'sel' : '');
    if (a.label) html += `<text x="${(start[0] + end[0]) / 2}" y="${(start[1] + end[1]) / 2}" font-size="${12 * k}">${esc(a.label)}</text>`;
    // Comment pins are draggable.
    if (pin) html += `<circle class="pinh" data-c="${f.id}" data-a="${a.id}" cx="${end[0]}" cy="${end[1]}" r="${7 * k}" stroke-width="${2 * k}"><title>Drag to move the pin</title></circle>`;
  }
  svg.innerHTML = html;
}

function outline() {
  const b = board!, o = $('#outline');
  if (o.querySelector('[contenteditable]')) return;
  const comments = active().filter(i => i.comment && i.comment.status !== 'resolved');
  const row = (title: string, ids: Set<string>, key: string) => {
    const n = solid().filter(i => ids.has(i.id) && !i.comment).length;
    const c = comments.filter(i => ids.has(i.comment!.target!)).length;
    const u = solid().filter(i => ids.has(i.id) && i.createdBy === 'agent' && !i.seenByHuman).length;
    return `<div data-key="${key}"><span class="name">${esc(title)}</span>${c ? `<span class="c" title="open comments">${c}</span>` : ''}${u ? `<span class="u" title="new from the agent">${u}</span>` : ''}<span class="n">${n}</span></div>`;
  };
  let html = `<div data-key="*"><b>All</b><span class="n">${solid().filter(i => !i.comment).length}</span></div>`;
  for (const s of b.sections) html += row(s.title, new Set(solid().filter(i => i.section === s.id).map(i => i.id)), s.id);
  const loose = solid().filter(i => !b.sections.some(s => s.id === i.section));
  if (loose.length) html += row('Inbox / loose', new Set(loose.map(i => i.id)), '~');
  setHTML(o, html);
}
function status() {
  const waiting = active().filter(i => i.createdBy === 'human' && !i.delivered && i.kind !== 'arrow').length;
  $('#status').textContent = `${board!.name} · round ${board!.round}${waiting ? ` · ${waiting} not yet read by the agent` : ''}`;
}
function selbar() {
  const it = sel ? byId.get(sel) : undefined, s = $('#selbar');
  if (!it) { setHTML(s, ''); return; }
  const agentItem = it.createdBy === 'agent' && it.kind !== 'arrow' && !it.comment;
  const r = it.reaction?.kind;
  setHTML(s, `<code title="Click to copy, then mention it in chat">${esc(it.key)}</code>` +
    (agentItem ? `<button data-act="approve" class="${r === 'approve' ? 'on' : ''}">Approve</button><button data-act="reject" class="${r === 'reject' ? 'on' : ''}">Reject</button>` : '') +
    '<button data-act="archive" title="Delete / Backspace">Archive</button>');
}

// ---------- hints ----------
let hintT = 0;
function hint(text: string, err = false) {
  const h = $('#hint'); h.textContent = text; h.className = 'show' + (err ? ' err' : '');
  clearTimeout(hintT); hintT = window.setTimeout(() => (h.className = ''), err ? 5000 : 2500);
}
function setTool(t: typeof tool) {
  tool = t;
  document.querySelectorAll<HTMLElement>('#bar [data-tool]').forEach(b => b.classList.toggle('on', b.dataset.tool === t));
  view$.classList.toggle('tool-comment', t === 'comment');
  if (t === 'comment') hint('Comment: click a spot or drag a region on an item');
}
function select(id: string | null) { sel = id; render(); }

// ---------- editor ----------
let editing = false;
interface EdOpts { x: number; y: number; w: number; init?: string; mode: 'text' | 'comment' | 'line'; placeholder?: string; allowEmpty?: boolean;
  onSave: (text: string, intent: Intent) => void; onCancel?: () => void }
function editor(o: EdOpts) {
  editing = true;
  let intent: Intent = 'change';
  const box = document.createElement('div');
  box.className = 'editor';
  Object.assign(box.style, { left: o.x + 'px', top: o.y + 'px', width: Math.max(o.w, 240) + 'px' });
  const intents: Intent[] = ['change', 'question', 'bug', 'keep'];
  const tip = o.mode === 'text' ? '⌘Enter or click away to save' : 'Enter to save · Shift+Enter new line';
  box.innerHTML = (o.mode === 'comment' ? `<div class="intents">${intents.map(i => `<button class="i-${i}${i === intent ? ' on' : ''}" data-i="${i}">${i}</button>`).join('')}</div>` : '') +
    `<textarea placeholder="${esc(o.placeholder ?? '')}"></textarea><div class="tip">${tip} · Esc cancel</div>`;
  world.appendChild(box);
  const ta = box.querySelector('textarea')!;
  if (o.mode === 'line') ta.style.minHeight = '38px';
  ta.value = o.init ?? ''; ta.focus({ preventScroll: true });
  box.addEventListener('pointerdown', e => e.stopPropagation());
  box.addEventListener('dblclick', e => e.stopPropagation());
  box.querySelectorAll<HTMLElement>('[data-i]').forEach(b => {
    b.addEventListener('mousedown', e => e.preventDefault());
    b.onclick = () => { intent = b.dataset.i as Intent; box.querySelectorAll('[data-i]').forEach(x => x.classList.toggle('on', x === b)); };
  });
  let closed = false;
  const close = () => { if (closed) return; closed = true; editing = false; box.remove(); };
  const save = () => { const t = ta.value.trim(); close(); if (t || o.allowEmpty) o.onSave(t, intent); else o.onCancel?.(); };
  ta.onkeydown = e => {
    e.stopPropagation();
    if (e.key === 'Escape') { close(); o.onCancel?.(); }
    else if (e.key === 'Enter' && (o.mode === 'text' ? e.metaKey || e.ctrlKey : !e.shiftKey)) { e.preventDefault(); save(); }
  };
  ta.onblur = () => setTimeout(() => { if (!closed && document.activeElement !== ta) (o.mode === 'line' ? (close(), o.onCancel?.()) : save()); }, 100);
}

// Inline rename (section titles on the board and in the outline).
function renameInline(el: HTMLElement, s: Section) {
  el.contentEditable = 'true'; el.focus({ preventScroll: true });
  document.getSelection()?.selectAllChildren(el);
  editing = true;
  const done = (save: boolean) => {
    el.contentEditable = 'false'; editing = false;
    const t = (el.textContent ?? '').trim();
    if (save && t && t !== s.title) act({ op: 'renameSection', id: s.id, title: t }, { op: 'renameSection', id: s.id, title: s.title });
    else el.textContent = s.title;
    render();
  };
  el.onkeydown = e => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); el.onblur = null; done(true); } if (e.key === 'Escape') { el.onblur = null; done(false); } };
  el.onblur = () => done(true);
}

// ---------- crops ----------
async function makeCrop(it: Item, point: [number, number], region?: [number, number, number, number]): Promise<string | undefined> {
  const v = cur(it);
  if (it.kind !== 'image' || !v.asset) return;
  const img = new Image(); img.src = '/a/' + v.asset; await img.decode();
  const W = img.naturalWidth, H = img.naturalHeight;
  let cx = 0, cy = 0, cw = W, ch = H; // a pin alone doesn't say what it points at: whole image, pin drawn on it
  if (region) {
    const mx = region[2] * W * 0.25 + 40, my = region[3] * H * 0.25 + 40;
    cx = region[0] * W - mx; cy = region[1] * H - my; cw = Math.min(W, region[2] * W + 2 * mx); ch = Math.min(H, region[3] * H + 2 * my);
    cx = Math.max(0, Math.min(cx, W - cw)); cy = Math.max(0, Math.min(cy, H - ch));
  }
  const s = Math.min(1, 1000 / Math.max(cw, ch));
  const c = document.createElement('canvas'); c.width = Math.round(cw * s); c.height = Math.round(ch * s);
  const g = c.getContext('2d')!;
  g.drawImage(img, cx, cy, cw, ch, 0, 0, c.width, c.height);
  g.strokeStyle = '#ff2d20'; g.lineWidth = Math.max(3, c.width / 150);
  if (region) g.strokeRect((region[0] * W - cx) * s, (region[1] * H - cy) * s, region[2] * W * s, region[3] * H * s);
  else {
    const px = point[0] * W * s, py = point[1] * H * s, r = Math.max(10, c.width / 28);
    g.beginPath(); g.arc(px, py, r, 0, Math.PI * 2); g.stroke();
    g.beginPath(); g.moveTo(px - r * 1.8, py); g.lineTo(px - r * 0.5, py); g.moveTo(px + r * 0.5, py); g.lineTo(px + r * 1.8, py);
    g.moveTo(px, py - r * 1.8); g.lineTo(px, py - r * 0.5); g.moveTo(px, py + r * 0.5); g.lineTo(px, py + r * 1.8); g.stroke();
  }
  const blob = await new Promise<Blob>(r => c.toBlob(b => r(b!), 'image/png'));
  return upload(blob, 'png', 'crop');
}

// ---------- pointer ----------
const itemAt = (e: { target: EventTarget | null }) => {
  const el = (e.target as HTMLElement).closest?.('.item') as HTMLElement | null;
  return el ? byId.get(el.dataset.id!) : undefined;
};
const local = (it: Item, p: [number, number]): [number, number] =>
  [Math.min(1, Math.max(0, (p[0] - it.x) / it.w)), Math.min(1, Math.max(0, (p[1] - it.y) / it.h))];

function pan(e: PointerEvent) {
  const v0 = { ...view }, c0 = [e.clientX, e.clientY];
  view$.classList.add('panning');
  const onMove = (ev: PointerEvent) => { view.x = v0.x + ev.clientX - c0[0]; view.y = v0.y + ev.clientY - c0[1]; applyView(); };
  const onUp = () => { view$.classList.remove('panning'); removeEventListener('pointermove', onMove); removeEventListener('pointerup', onUp); };
  addEventListener('pointermove', onMove); addEventListener('pointerup', onUp);
}

view$.addEventListener('pointerdown', e => {
  if (!board || e.button > 1) return;
  if (space || e.button === 1) { e.preventDefault(); return pan(e); }
  const t = e.target as HTMLElement;
  if (t.closest('.editor, a, button, [data-act], [contenteditable="true"]')) return;
  const start = toWorld(e.clientX, e.clientY);
  const it = itemAt(e);
  const hitArrow = t.classList.contains('hit') ? t.dataset.id! : null;
  const pinOf = t.classList.contains('pinh') ? byId.get(t.dataset.c!) : undefined;
  const sec = t.classList.contains('sectitle') ? board.sections.find(s => s.id === (t.parentElement as HTMLElement).dataset.sec) : undefined;
  let move: ((p: [number, number]) => void) | null = null, up: ((p: [number, number]) => void) | null = null;

  if (pinOf?.comment) {
    // Drag a comment's pin to a new spot on its target.
    const c = pinOf.comment, target = byId.get(c.target!)!, arrow = byId.get(t.dataset.a!)!;
    const old = { point: c.point!, region: c.region, crop: c.crop };
    let point = c.point!, region = c.region;
    move = p => {
      point = local(target, p);
      if (old.region) { const d = [point[0] - old.point[0], point[1] - old.point[1]]; region = [old.region[0] + d[0], old.region[1] + d[1], old.region[2], old.region[3]]; }
      arrow.toPoint = point; drawArrows();
    };
    up = async () => {
      if (point === old.point) return;
      const crop = await makeCrop(target, point, region).catch(() => undefined);
      act({ op: 'repin', id: pinOf.id, point, region, crop }, { op: 'repin', id: pinOf.id, point: old.point, region: old.region, crop: old.crop });
    };
  } else if (tool === 'select' && !it && !hitArrow && !sec) {
    if (sel) select(null);
    return pan(e);
  } else if (tool === 'select' && hitArrow) { select(hitArrow); return; }
  else if (tool === 'select' && sec) {
    const members = solid().filter(i => i.section === sec.id).map(i => ({ i, x: i.x, y: i.y }));
    let d: [number, number] = [0, 0];
    move = p => { d = [p[0] - start[0], p[1] - start[1]]; for (const m of members) { m.i.x = m.x + d[0]; m.i.y = m.y + d[1]; place(els.get(m.i.id)!, m.i); } refreshSections(); drawArrows(); };
    up = () => { if (d[0] || d[1]) act({ op: 'moveSection', id: sec.id, dx: d[0], dy: d[1] }, { op: 'moveSection', id: sec.id, dx: -d[0], dy: -d[1] }); };
  } else if (tool === 'select' && it) {
    if (sel !== it.id) select(it.id);
    const o = { x: it.x, y: it.y, w: it.w, h: it.h, section: it.section ?? null }, el = els.get(it.id)!;
    const resize = t.classList.contains('handle');
    const ar = it.kind === 'image' ? it.h / it.w : 0;
    busy = it.id;
    let moved = false;
    move = p => {
      const dx = p[0] - start[0], dy = p[1] - start[1];
      moved = moved || Math.abs(dx) + Math.abs(dy) > 2 / view.z;
      if (resize) { it.w = Math.max(60, o.w + dx); it.h = ar ? it.w * ar : Math.max(40, o.h + dy); }
      else { it.x = o.x + dx; it.y = o.y + dy; }
      place(el, it); refreshSections(); drawArrows();
    };
    up = () => {
      busy = null;
      if (moved) act({ op: 'move', id: it.id, x: it.x, y: it.y, w: resize ? it.w : undefined, h: resize ? it.h : undefined },
        { op: 'move', id: it.id, x: o.x, y: o.y, w: o.w, h: o.h, section: o.section });
    };
  } else if (tool === 'comment' && it && !it.comment) {
    const target = it;
    const mark = document.createElement('div'); world.appendChild(mark);
    const p0 = local(target, start);
    let region: [number, number, number, number] | undefined;
    const showPin = () => { mark.className = 'pin'; Object.assign(mark.style, { left: start[0] + 'px', top: start[1] + 'px', width: '', height: '' }); };
    showPin();
    move = p => {
      const p1 = local(target, p);
      const r: [number, number, number, number] = [Math.min(p0[0], p1[0]), Math.min(p0[1], p1[1]), Math.abs(p1[0] - p0[0]), Math.abs(p1[1] - p0[1])];
      if (r[2] * target.w * view.z > 8 || r[3] * target.h * view.z > 8) {
        region = r; mark.className = 'region';
        place(mark, { x: target.x + r[0] * target.w, y: target.y + r[1] * target.h, w: r[2] * target.w, h: r[3] * target.h });
      } else { region = undefined; showPin(); }
    };
    up = () => {
      const point: [number, number] = region ? [region[0] + region[2] / 2, region[1] + region[3] / 2] : p0;
      editor({ x: target.x + target.w + 40, y: target.y + point[1] * target.h - 20, w: 240, mode: 'comment', placeholder: 'What should change here?',
        onSave: async (text, intent) => {
          const crop = await makeCrop(target, point, region).catch(() => undefined);
          mark.remove();
          await create({ op: 'comment', target: target.id, text, intent, point, region, crop });
        }, onCancel: () => mark.remove() });
    };
  }
  if (!move) return;
  const onMove = (ev: PointerEvent) => move!(toWorld(ev.clientX, ev.clientY));
  const onUp = (ev: PointerEvent) => { removeEventListener('pointermove', onMove); removeEventListener('pointerup', onUp); up?.(toWorld(ev.clientX, ev.clientY)); };
  addEventListener('pointermove', onMove); addEventListener('pointerup', onUp);
});

view$.addEventListener('pointermove', e => { mouse = toWorld(e.clientX, e.clientY); });

view$.addEventListener('wheel', e => {
  e.preventDefault();
  if (e.ctrlKey || e.metaKey) {
    const [wx, wy] = toWorld(e.clientX, e.clientY);
    const z = Math.min(4, Math.max(0.03, view.z * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.002))));
    const r = view$.getBoundingClientRect();
    view = { z, x: e.clientX - r.left - wx * z, y: e.clientY - r.top - wy * z };
  } else { view.x -= e.deltaX; view.y -= e.deltaY; }
  applyView();
}, { passive: false });

view$.addEventListener('dblclick', e => {
  if (!board || tool !== 'select') return;
  const t = e.target as HTMLElement;
  if (t.closest('.editor')) return;
  if (t.classList.contains('sectitle')) {
    const s = board.sections.find(x => x.id === (t.parentElement as HTMLElement).dataset.sec);
    if (s) renameInline(t, s);
    return;
  }
  const it = itemAt(e);
  if (it && it.kind === 'text' && it.createdBy === 'human') {
    els.get(it.id)!.style.visibility = 'hidden';
    const restore = () => { const el = els.get(it.id); if (el) el.style.visibility = ''; };
    const old = { text: cur(it).text ?? '', intent: it.comment?.intent };
    editor({ x: it.x, y: it.y, w: it.w, init: old.text, mode: it.comment ? 'comment' : 'text', onCancel: restore,
      onSave: (text, intent) => { restore(); act({ op: 'edit', id: it.id, text, intent: it.comment ? intent : undefined }, { op: 'edit', id: it.id, text: old.text, intent: old.intent }); } });
    return;
  }
  if (it) return;
  const [x, y] = toWorld(e.clientX, e.clientY);
  editor({ x, y, w: 280, mode: 'text', placeholder: 'Note (markdown)', onSave: text => create({ op: 'add', kind: 'text', text, at: [x, y] }) });
});

// Buttons inside cards and the selection bar.
document.addEventListener('click', async e => {
  const b = (e.target as HTMLElement).closest('[data-act]') as HTMLElement | null;
  if (!b || !board) return;
  const it = b.closest('.item') ? byId.get((b.closest('.item') as HTMLElement).dataset.id!) : sel ? byId.get(sel) : undefined;
  if (!it) return;
  const a = b.dataset.act;
  if (a === 'intent' && it.comment) {
    const order: Intent[] = ['change', 'question', 'bug', 'keep'], old = it.comment.intent;
    act({ op: 'edit', id: it.id, intent: order[(order.indexOf(old) + 1) % 4] }, { op: 'edit', id: it.id, intent: old });
  } else if (a === 'reply') {
    editor({ x: it.x, y: it.y + it.h + 8, w: it.w, mode: 'line', placeholder: 'Reply…',
      onSave: text => act({ op: 'reply', id: it.id, text }, { op: 'unreply', id: it.id }) });
  } else if (a === 'resolve' || a === 'reopen') {
    act({ op: 'status', id: it.id, status: a === 'resolve' ? 'resolved' : 'open' }, { op: 'status', id: it.id, status: it.comment!.status });
  } else if (a === 'approve' || a === 'reject') {
    const prev = { op: 'react', id: it.id, kind: it.reaction?.kind, reason: it.reaction?.reason };
    if (it.reaction?.kind === a) return act({ op: 'react', id: it.id }, prev); // clicking again withdraws
    editor({ x: it.x, y: it.y + it.h + 8, w: Math.max(it.w, 260), mode: 'line', allowEmpty: true,
      placeholder: `${a === 'approve' ? 'Approve' : 'Reject'}: reason (optional), Enter`,
      onSave: reason => act({ op: 'react', id: it.id, kind: a, reason: reason || undefined }, prev) });
  } else if (a === 'archive') archive(it);
});
$('#selbar').addEventListener('click', e => {
  if ((e.target as HTMLElement).tagName === 'CODE') { navigator.clipboard.writeText((e.target as HTMLElement).textContent!); hint('Key copied'); }
});

function archive(it: Item) { sel = null; act({ op: 'archive', id: it.id }, { op: 'restore', id: it.id }); hint(`Archived ${it.key} · ⌘Z to undo`); }

// ---------- paste / drop ----------
async function addFiles(files: File[], at: [number, number]) {
  for (const f of files) {
    if (!f.type.startsWith('image/')) continue;
    const asset = await upload(f, (f.type.split('/')[1] || 'png').replace('jpeg', 'jpg'));
    await create({ op: 'add', kind: 'image', asset, at });
    at = [at[0] + 40, at[1] + 40];
  }
}
document.addEventListener('paste', e => {
  if (editing || !board) return;
  const files = [...(e.clipboardData?.files ?? [])];
  if (files.length) { e.preventDefault(); addFiles(files, mouse); return; }
  const text = e.clipboardData?.getData('text/plain')?.trim();
  if (!text) return;
  e.preventDefault();
  create(/^https?:\/\/\S+$/.test(text) ? { op: 'add', kind: 'link', url: text, at: mouse } : { op: 'add', kind: 'text', text, at: mouse });
});
view$.addEventListener('dragover', e => e.preventDefault());
view$.addEventListener('drop', e => { e.preventDefault(); addFiles([...(e.dataTransfer?.files ?? [])], toWorld(e.clientX, e.clientY)); });

// ---------- keys / toolbar ----------
const typing = (e: KeyboardEvent) => editing || ['TEXTAREA', 'INPUT'].includes((e.target as HTMLElement).tagName) || (e.target as HTMLElement).isContentEditable;
document.addEventListener('keydown', e => {
  if (typing(e)) return;
  const k = e.key.toLowerCase();
  if (k === ' ') { e.preventDefault(); if (!space) { space = true; view$.classList.add('hand'); } return; }
  if ((e.metaKey || e.ctrlKey) && k === 'z') { e.preventDefault(); (e.shiftKey ? redoLast() : undoLast()).catch(() => {}); return; }
  if (e.metaKey || e.ctrlKey) return;
  if (k === 'v') setTool('select');
  else if (k === 'c') setTool('comment');
  else if (k === 'f') fitAll();
  else if (k === 'escape') { setTool('select'); select(null); }
  else if ((k === 'backspace' || k === 'delete') && sel) { const it = byId.get(sel); if (it) archive(it); }
});
document.addEventListener('keyup', e => { if (e.key === ' ') { space = false; view$.classList.remove('hand'); } });
addEventListener('blur', () => { space = false; view$.classList.remove('hand'); });
document.querySelectorAll<HTMLElement>('#bar [data-tool]').forEach(b => (b.onclick = () => setTool(b.dataset.tool as typeof tool)));
$('#fit').onclick = fitAll;
$('#theme').onclick = () => {
  const light = document.body.classList.toggle('light'); document.body.classList.toggle('dark', !light);
  localStorage.setItem('theme', light ? 'light' : 'dark');
};
if (localStorage.getItem('theme') === 'light') { document.body.className = 'light'; }
$('#outline').addEventListener('click', e => {
  const d = (e.target as HTMLElement).closest('[data-key]') as HTMLElement | null;
  if (!d || !board || d.querySelector('[contenteditable="true"]')) return;
  const k = d.dataset.key!;
  if (k === '*') return fitAll();
  if (k === '~') return fit(bbox(solid().filter(i => !board!.sections.some(s => s.id === i.section))));
  const s = board.sections.find(x => x.id === k); if (s) fit(sectionRect(s));
});
$('#outline').addEventListener('dblclick', e => {
  const d = (e.target as HTMLElement).closest('[data-key]') as HTMLElement | null;
  const s = board?.sections.find(x => x.id === d?.dataset.key);
  if (s) renameInline(d!.querySelector('.name') as HTMLElement, s);
});
addEventListener('resize', applyView);
// The canvas container must never scroll (focus can scroll it to reveal an editor); panning is the view transform.
view$.addEventListener('scroll', () => { view$.scrollTop = 0; view$.scrollLeft = 0; });

// ---------- live ----------
let first = true;
new EventSource('/api/events').onmessage = async e => {
  if (board && Number(e.data) === board.revision && !first) return;
  await load();
  if (first) {
    first = false;
    const saved = localStorage.getItem('view-' + board!.id);
    if (saved) { view = JSON.parse(saved); applyView(); } else fitAll();
    document.title = `DrawPad · ${board!.name}`;
  }
};
