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

`open` uses Chrome's app mode (a window without tabs or address bar) in a DrawPad-only Chrome profile, so it runs
as its own instance whether or not your Chrome is open. Each project gets a fixed port, so
the window keeps its size and position, and opening a board again replaces its old window (one per board).
The DrawPad launcher lists every project whose board has been opened (most recent first) and opens the
one you pick; with a single project it opens it directly. It pins the current Node path; run `drawpad app`
again after switching Node versions.

## Claude Code hook

In the project's `.claude/settings.json`, so new feedback shows up in context each turn
(prints nothing when there is none):

```json
{ "hooks": { "UserPromptSubmit": [ { "hooks": [ { "type": "command", "command": "drawpad hook" } ] } ] } }
```

Or run `drawpad wait` as a background command; it returns once feedback is waiting and the human
has paused for ~8 seconds.

## Human controls

V select · C comment · F frame · Space hand · ⇧1 fit all · Esc · ⌫ delete (archive) · ⌘A select all ·
⌘Z undo · ⇧⌘Z redo · double-click a section title to rename it.

Select: drag on empty canvas for a selection box (Shift adds), Shift-click to add/remove, drag any selected
item to move them all, or its corner handle to scale them all. ⌘C / ⌘X / ⌘V copy, cut and paste items (pasted at the cursor). Zoom: bottom-right control, click the % (or ⇧0) for 100%. Comment cards keep their size at any zoom. Pan with Space-drag, the trackpad or the scroll wheel; zoom with pinch or ⌘-scroll.
Paste an image, URL or text anywhere; drop image files; double-click empty space to write a card.

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
