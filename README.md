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

V select · C comment (click a spot, or drag a region; drag a pin later to move it) · Space hand ·
F fit · Esc · Backspace archive · ⌘Z undo · ⇧⌘Z redo · double-click a section title to rename it.
Paste an image, URL or text anywhere; drop image files; double-click empty space to write a card.
A comment goes to the agent when you save it (Enter); there is no Send step.

Sections: an item belongs to a section until it is dropped inside another section's box. Dragging it
past its own section's edge only stretches the box; it never makes the item loose. Pasted items join the
section under the cursor, else they are loose ("Inbox / loose" in `drawpad board`).

Pin comments send the whole image (max 1000px) with the pin drawn on it; region comments send a crop of the region.

## Dev

`npm run check` type-checks (dev-only TypeScript).
