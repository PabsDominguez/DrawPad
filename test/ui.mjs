// Headless UI smoke test: real mouse/keyboard input through Chrome DevTools Protocol.
// Usage: npm run test:ui   (needs Google Chrome; opens nothing on screen; uses a throwaway project in /tmp)
// Add a check here whenever a UI behaviour is fixed or added.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const BIN = path.join(import.meta.dirname, '..', 'bin', 'drawpad.js');
const dir = fs.mkdtempSync('/tmp/drawpad-ui-'), prof = path.join(dir, 'chrome');
fs.mkdirSync(path.join(dir, '.drawpad'));
const dp = (...a) => execFileSync(process.execPath, [BIN, ...a], { cwd: dir, encoding: 'utf8' }).trim();

// A plain 400x600 PNG to stand in for a screenshot.
function png(file, rgb) {
  const w = 400, h = 600, raw = Buffer.concat(Array.from({ length: h }, () => Buffer.from([0, ...Array(w).fill(rgb).flat()])));
  const crc = b => { let c = ~0; for (const x of b) { c ^= x; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1; } return ~c >>> 0; };
  const ch = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w); ihdr.writeUInt32BE(h, 4); ihdr.set([8, 2, 0, 0, 0], 8);
  fs.writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), ch('IHDR', ihdr), ch('IDAT', zlib.deflateSync(raw)), ch('IEND', Buffer.alloc(0))]));
}
png(path.join(dir, 'a.png'), [30, 30, 140]);
dp('add', 'image', 'a.png', '--key', 's1', '--section', 'Screens');
dp('add', 'image', 'a.png', '--key', 's2', '--section', 'Screens');
const URL_ = dp('url');

const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=9339', `--user-data-dir=${prof}`, '--window-size=1400,900', 'about:blank'], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let ws;
for (let i = 0; i < 40 && !ws; i++) { try { const l = await (await fetch('http://127.0.0.1:9339/json')).json(); ws = new WebSocket(l.find(x => x.type === 'page').webSocketDebuggerUrl); } catch { await sleep(250); } }
await new Promise(r => (ws.onopen = r));
let n = 0; const pend = new Map(), errs = [];
ws.onmessage = m => { const d = JSON.parse(m.data); if (d.id) pend.get(d.id)?.(d); if (d.method === 'Runtime.exceptionThrown') errs.push(JSON.stringify(d.params.exceptionDetails).slice(0, 300)); };
const cmd = (method, params = {}) => new Promise(r => { const i = ++n; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async e => (await cmd('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })).result?.result?.value;
const mouse = (type, x, y, mods = 0) => cmd('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, modifiers: mods });
const click = async ([x, y], mods = 0) => { await mouse('mousePressed', x, y, mods); await mouse('mouseReleased', x, y, mods); await sleep(400); };
async function drag([x0, y0], [x1, y1], mods = 0) {
  await mouse('mousePressed', x0, y0, mods);
  for (let i = 1; i <= 6; i++) { await mouse('mouseMoved', x0 + (x1 - x0) * i / 6, y0 + (y1 - y0) * i / 6, mods); await sleep(20); }
  await mouse('mouseReleased', x1, y1, mods); await sleep(800);
}
const key = (k, code, mods = 0) => cmd('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, modifiers: mods, windowsVirtualKeyCode: k.length === 1 ? k.toUpperCase().charCodeAt(0) : k === 'Enter' ? 13 : 0 })
  .then(() => cmd('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, modifiers: mods }));
const type = async t => { await cmd('Input.insertText', { text: t }); await key('Enter', 'Enter'); await sleep(900); };
const board = async () => (await fetch(URL_ + 'api/board')).json();
const byKey = async k => (await board()).items.find(i => i.key === k);
const box = async sel => ev(`(()=>{const r=document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect();return {x:r.x,y:r.y,r:r.right,b:r.bottom,cx:r.x+r.width/2,cy:r.y+r.height/2}})()`);
const fit = async () => { await key('!', 'Digit1', 8); await sleep(300); };

let failed = 0;
const check = (name, ok, got) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ' -> ' + JSON.stringify(got)}`); if (!ok) failed++; };

try {
  await cmd('Runtime.enable'); await cmd('Page.navigate', { url: URL_ }); await sleep(1500);
  await fit();
  const id1 = (await byKey('s1')).id, id2 = (await byKey('s2')).id;
  let a = await box(`[data-id="${id1}"]`), b = await box(`[data-id="${id2}"]`);

  // Selection box, Shift-click, group move + one-step undo.
  await drag([a.x - 30, a.y + 40], [b.r + 10, a.y + 80]);
  check('selection box selects both', (await ev(`document.querySelector('#selbar').textContent`)).startsWith('2 selected'));
  const x0 = (await byKey('s1')).x;
  await drag([a.cx, a.cy], [a.cx + 60, a.cy]);
  check('group move', (await byKey('s1')).x !== x0);
  await key('z', 'KeyZ', 4); await sleep(500);
  check('undo group move', (await byKey('s1')).x === x0, (await byKey('s1')).x);
  await key('Escape', 'Escape');

  // Comment: collapses to its pin; pin click opens; × closes; peek on hover.
  a = await box(`[data-id="${id1}"]`);
  await key('c', 'KeyC'); await click([a.cx, a.y + 80]); await type('Header too heavy');
  check('comment collapsed after save', await ev(`document.querySelectorAll('.item.closed').length`) === 1);
  const pin = await box('.pinh.shut');
  await mouse('mouseMoved', pin.cx, pin.cy); await sleep(300);
  check('hover peeks', (await ev(`document.querySelector('#peek').textContent`)).includes('Header too heavy'));
  await click([pin.cx, pin.cy]);
  check('pin click opens', await ev(`document.querySelectorAll('.item.closed').length`) === 0);

  // Replies: written in place, editable, deletable, undo restores.
  for (const t of ['first', 'second']) { await ev(`document.querySelector('[data-act=reply]').click()`); await sleep(300); await type(t); }
  const thread = async () => (await board()).items.find(i => i.comment).comment.thread.map(t => t.text);
  check('two replies', JSON.stringify(await thread()) === '["first","second"]', await thread());
  await ev(`document.querySelectorAll('[data-act=deleteReply]')[1].click()`); await sleep(700);
  check('delete reply', (await thread()).length === 1);
  await key('z', 'KeyZ', 4); await sleep(700);
  check('undo delete reply', (await thread()).length === 2);
  await ev(`document.querySelector('[data-act=close]').click()`); await sleep(400);
  check('× closes', await ev(`document.querySelectorAll('.item.closed').length`) === 1);

  // Drawing: Shift pressed mid-drag snaps; drawn on a screen it sticks to it.
  await fit(); a = await box(`[data-id="${id1}"]`);
  await key('l', 'KeyL');
  await mouse('mousePressed', a.x + 20, a.y + 150); await mouse('mouseMoved', a.x + 40, a.y + 160);
  await mouse('mouseMoved', a.r - 20, a.y + 170, 8); await mouse('mouseReleased', a.r - 20, a.y + 170, 8); await sleep(800);
  const line = (await board()).items.find(i => i.mark);
  check('line sticks to s1', line?.mark.on === id1, line?.mark);
  check('shift snaps horizontal', line && Math.abs(line.mark.pts[1] - line.mark.pts[3]) < 1e-6, line?.mark.pts);

  // Text tool: drag a width, type, agent gets it with what it's near.
  b = await box(`[data-id="${id2}"]`);
  await key('t', 'KeyT'); await drag([b.r + 30, b.y], [b.r + 300, b.y + 30]);
  await cmd('Input.insertText', { text: 'Context note' }); await key('Enter', 'Enter', 4); await sleep(900);
  const fb = await (await fetch(URL_ + 'api/feedback', { method: 'POST', body: '{}' })).text();
  check('note reported near s2', /new text near s2/.test(fb), fb);
  check('drawing reported', /line on s1/.test(fb), fb);

  // Copy / paste duplicates at the cursor.
  await fit(); a = await box(`[data-id="${id1}"]`); await click([a.cx, a.cy + 100]);
  const marker = await ev(`(()=>{const dt=new DataTransfer();document.dispatchEvent(new ClipboardEvent('copy',{clipboardData:dt,bubbles:true}));return dt.getData('text/plain')})()`);
  await mouse('mouseMoved', 300, 300);
  await ev(`(()=>{const dt=new DataTransfer();dt.setData('text/plain',${JSON.stringify(marker)});document.dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true}))})()`); await sleep(1200);
  check('paste makes a copy', (await board()).items.filter(i => i.kind === 'image' && i.state === 'active').length === 3);

  // Frame tool: drawn box adopts what is inside.
  await fit(); b = await box(`[data-id="${id2}"]`);
  await key('f', 'KeyF'); await drag([b.x - 20, b.y - 20], [b.r + 20, b.b + 20]);
  const bd = await board(), fr = bd.sections.at(-1);
  check('frame adopts s2', fr.w > 0 && bd.items.find(i => i.key === 's2').section === fr.id, fr);

  check('no page errors', errs.length === 0, errs);
} catch (e) { console.log('FAIL crashed:', e.message); failed++; }
finally {
  chrome.kill();
  try { process.kill(JSON.parse(fs.readFileSync(path.join(dir, '.drawpad', 'server.json'), 'utf8')).pid); } catch { /* gone */ }
  await sleep(300); fs.rmSync(dir, { recursive: true, force: true });
}
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
