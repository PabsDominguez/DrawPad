// Runs inside headless Chrome, in the page that holds a design's iframe (see images.ts). Plain JS on purpose:
// it is inlined into that page as a <script>, never imported by Node.

const css = (d, el) => d.defaultView.getComputedStyle(el);

// Short, readable selector: #id, or up to 3 levels of tag.class:nth-child.
function sel(el) {
  const parts = [];
  for (let e = el; e && e.nodeType === 1 && e.tagName !== 'BODY' && parts.length < 3; e = e.parentElement) {
    if (e.id) { parts.unshift('#' + e.id); break; }
    let s = e.tagName.toLowerCase();
    const cls = [...e.classList].slice(0, 2);
    if (cls.length) s = '.' + cls.join('.');
    const sib = e.parentElement ? [...e.parentElement.children].filter(x => x.tagName === e.tagName) : [];
    if (sib.length > 1) s += `:nth-child(${[...e.parentElement.children].indexOf(e) + 1})`;
    parts.unshift(s);
  }
  return parts.join(' ') || 'body';
}

const hex = c => { const m = c.match(/[\d.]+/g); if (!m) return c; const [r, g, b, a] = m.map(Number); return a === 0 ? 'transparent' : '#' + [r, g, b].map(v => Math.round(v).toString(16).padStart(2, '0')).join(''); };
const rgb = c => (c.match(/[\d.]+/g) || []).map(Number);
const lum = ([r, g, b]) => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
// First solid background behind el; null when an image or gradient is in the way (contrast unknown).
function bgOf(d, el) {
  for (let e = el; e; e = e.parentElement) {
    const s = css(d, e);
    if (s.backgroundImage !== 'none') return null;
    const c = rgb(s.backgroundColor);
    if (c.length && (c[3] === undefined || c[3] > 0.5)) return c;
  }
  return [255, 255, 255];
}
const ownText = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').replace(/\s+/g, ' ').trim();
const visible = (d, el) => { const s = css(d, el), r = el.getBoundingClientRect(); return s.visibility !== 'hidden' && s.display !== 'none' && +s.opacity > 0.05 && r.width > 0 && r.height > 0; };

function measure(d) {
  const b = d.body, c = css(d, b), r = d.createRange(); r.selectNodeContents(b);
  return { h: Math.ceil(r.getBoundingClientRect().bottom + parseFloat(c.paddingBottom) + parseFloat(c.marginBottom)),
    sw: Math.max(d.documentElement.scrollWidth, b.scrollWidth),
    fails: [...new Set([...d.fonts].filter(x => x.status === 'error').map(x => x.family.replace(/["']/g, '')))] };
}

// Legibility checks; each returns at most a few examples so the agent's report stays short.
function checks(d) {
  const cut = [], tiny = [], low = [], tap = [];
  for (const el of d.body.querySelectorAll('*')) {
    if (!visible(d, el)) continue;
    const s = css(d, el), t = ownText(el);
    if (t) {
      if ((el.scrollWidth > el.clientWidth + 1 && s.overflowX !== 'visible') || (el.scrollHeight > el.clientHeight + 1 && s.overflowY !== 'visible' && s.overflowY !== 'auto' && s.overflowY !== 'scroll'))
        cut.push(`${sel(el)} "${t.slice(0, 30)}"`);
      const fs = parseFloat(s.fontSize);
      if (fs < 11) tiny.push(`${sel(el)} ${fs}px`);
      const bg = bgOf(d, el), fg = rgb(s.color);
      if (bg && fg.length) {
        const a = (fg[3] ?? 1) * +s.opacity, mix = fg.slice(0, 3).map((v, i) => v * a + bg[i] * (1 - a));
        const L1 = lum(mix), L2 = lum(bg), ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
        const big = fs >= 24 || (fs >= 18.5 && +s.fontWeight >= 700);
        if (ratio < (big ? 3 : 4.5)) low.push(`${sel(el)} "${t.slice(0, 20)}" ${ratio.toFixed(1)}:1`);
      }
    }
    if (el.hasAttribute('data-tap')) { const r = el.getBoundingClientRect(); if (r.width < 44 || r.height < 44) tap.push(`${sel(el)} ${Math.round(r.width)}x${Math.round(r.height)}`); }
  }
  const few = (a, label) => a.length ? [`${label} (${a.length}): ${a.slice(0, 3).join('; ')}${a.length > 3 ? '; …' : ''}`] : [];
  return [...few(cut, 'text cut off'), ...few(tiny, 'text under 11px'), ...few(low, 'low contrast'), ...few(tap, 'tap target under 44'), ];
}

// What a pin at (x, y) CSS px points at.
function elAt(d, x, y) {
  let el = d.elementFromPoint(x, y);
  if (!el) return null;
  const r = el.getBoundingClientRect(), s = css(d, el), t = (el.innerText || '').replace(/\s+/g, ' ').trim();
  let bg = s.backgroundColor;
  for (let e = el; e && hex(bg) === 'transparent'; e = e.parentElement) bg = css(d, e).backgroundColor;
  return `${sel(el)} ${Math.round(r.width)}x${Math.round(r.height)} bg ${hex(bg)} color ${hex(s.color)} ${parseFloat(s.fontSize)}px${t ? ` "${t.slice(0, 40)}"` : ''}`;
}

// Visible text with positions, top to bottom: lets the agent check content without reading an image.
function outline(d) {
  const out = [];
  for (const el of d.body.querySelectorAll('*')) {
    const t = ownText(el);
    if (!t || !visible(d, el)) continue;
    const r = el.getBoundingClientRect(), s = css(d, el);
    out.push([r.y, `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)} ${parseFloat(s.fontSize)}px${+s.fontWeight >= 600 ? ' b' : ''} ${t.slice(0, 80)}`]);
  }
  return out.sort((a, b) => a[0] - b[0]).slice(0, 200).map(x => x[1]);
}
