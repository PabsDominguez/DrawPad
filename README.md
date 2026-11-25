# DrawPad

A shared board where an agent shows things and a human reacts. See `SPEC.md`.

Zero runtime dependencies: Node >= 22.18 runs the TypeScript directly (type stripping), and the
server strips types for the browser UI too. Image sizes and thumbnails use macOS `sips`.

```sh
npm link                 # once: puts `drawpad` on PATH
cd ~/some/project
mkdir .drawpad           # or let the first `drawpad add` create it
drawpad open             # starts the per-project server on demand, opens the board in its own window
drawpad app              # once: ~/Applications/DrawPad.app, one launcher for all boards (Dock/Spotlight)
drawpad help
```

`drawpad app` builds `~/Applications/DrawPad.app` (needs Xcode command line tools): a native window for boards
(macOS WebKit, `app/DrawPad.swift`) with its own Dock icon. `drawpad open` then opens boards there, one window per
board; launched from the Dock or Spotlight it opens the most recent board, and the board name at the top left
switches boards. Run `drawpad app` again after switching Node versions (it pins the Node path). Without the app,
`open` falls back to a Chrome app-mode window.

Design renders use one hidden headless Chrome per project server (started on the first render, closed after
10 idle minutes or with the server); nothing appears on screen.

## Agent designs

The agent can design anything in HTML or SVG (a website, a screen, an icon, a poster, something new) and
put it on the board. It writes the file in the project with its own editor, then:

```sh
drawpad add html design/landing.html --key landing --width 1280 --section "Website"
# edit the file, then the same command (same key) = v2; --width is remembered
drawpad add html design/icon.svg --key icon --width 180 --right-of landing
```

Headless Chrome renders a PNG at 2x (full page height unless `--height`), used when zoomed out and for
comment crops; zoomed in, the board shows the live page. Relative links (css, fonts, images) load from the
project, so link shared CSS and fonts instead of embedding them in every file. The agent's own words go in text
items (`add text`), wherever and however it wants.

What the agent gets back without reading images:
- `add html` lists problems found in the render: content cut at the frame, failed fonts, cut-off text, text
  under 11px, low contrast (WCAG), elements marked `data-tap` under 44px, snapshot size mismatch. Nothing when clean.
- Comments pinned on a design name the element under the pin in feedback:
  `el: .row:nth-child(3) .zone 96x52 bg #d63a53 color #ffffff 15px "Legs"`.
- `drawpad outline <key>`: the design's visible text with positions and sizes.

## Claude Code hooks

In the project's `.claude/settings.json` (or `settings.local.json`). `drawpad hook` is silent when nothing waits.

```json
{ "hooks": {
  "UserPromptSubmit": [ { "hooks": [ { "type": "command", "command": "drawpad hook" } ] } ],
  "PostToolUse":      [ { "hooks": [ { "type": "command", "command": "drawpad hook" } ] } ],
  "Stop":             [ { "hooks": [ { "type": "command", "command": "drawpad hook --wait 1800", "timeout": 1860 } ] } ]
} }
```

- UserPromptSubmit / PostToolUse: one line of context when sent feedback waits (PostToolUse only when it changes).
- Stop: the agent doesn't stop while sent feedback waits; it gets the feedback itself. With `--wait S` it
  holds the stop until you press **Send to agent** (up to S seconds), only while a round is on: the agent used
  drawpad in the last 15 minutes and the board is open. Otherwise it goes idle as usual.
  The session shows as busy meanwhile; interrupt it as usual. Without `--wait` it only catches feedback sent
  while the agent was working.

Your comments, notes and drawings are held until you press **Send to agent** (bottom of the Comments panel, ⌘↩).

## Human controls

V select · C comment · F frame · Space hand · ⇧1 fit all · Esc · ⌫ delete (archive) · ⌘A select all ·
⌘Z undo · ⇧⌘Z redo · double-click a section title to rename it.

Select: drag on empty canvas for a selection box (Shift adds), Shift-click to add/remove, drag any selected
item to move them all, or its corner handle to scale them all. ⌘C / ⌘X / ⌘V copy, cut and paste items (pasted at the cursor); one copied image or text card also pastes into other apps.
T text block: click or drag out a width, type markdown; the agent gets it with the nearest item ("near s1"). Zoom: bottom-right control, click the % (or ⇧0) for 100%. Comment cards keep their size at any zoom. Pan with Space-drag, the trackpad or the scroll wheel; zoom with pinch or ⌘-scroll.
Paste an image, URL or text anywhere; drop image files; double-click empty space to write a card.

Drawing: L line · A arrow · R rectangle · O ellipse; Shift snaps (45° lines, squares, circles). Drawn inside one
screen, a shape sticks to it (moves and scales with it) and is burned into that screen's crops, so the agent
sees it; elsewhere it sits on the canvas. Select a drawing to move it, drag its ends to adjust, ⌫ to delete.

Comments: click a spot (or drag a region) on an item. A comment goes to the agent when you save it (Enter);
there is no Send step. It then collapses to its pin; hover its pin to peek, click to open (the × icon closes it; the pencil and bin icons edit and delete it), drag to move it.
A comment ending in "?" is sent as a question unless you picked a type.
A blue dot on a pin means the agent replied.

Frames and sections: press F and drag out a box (what's fully inside joins it), or select items and
click Frame. Drag the title to move the frame with everything in it; click its empty area to select it, then
drag the corner to resize or "Remove frame" (its items stay). Dropping an item outside a drawn frame takes it
out; the agent's sections (no drawn box) only stretch, so an item leaves them only by being dropped into
another section. Pasted items join the section under the cursor, else they are loose ("Inbox / loose").

Pin comments send the whole image (max 1000px) with the pin drawn on it; region comments send a crop of the region.

## Dev

`npm run check` type-checks (dev-only TypeScript).
