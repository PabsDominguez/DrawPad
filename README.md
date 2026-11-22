# DrawPad

A shared board where an agent shows things and a human reacts. See `SPEC.md`.

Zero runtime dependencies: Node >= 22.18 runs the TypeScript directly (type stripping), and the
server strips types for the browser UI too. Image sizes and thumbnails use macOS `sips`.

```sh
npm link                 # once: puts `drawpad` on PATH
cd ~/some/project
mkdir .drawpad           # or let the first `drawpad add` create it
drawpad open             # starts the per-project server on demand, opens the board
drawpad help
```

## Claude Code hook

In the project's `.claude/settings.json`, so new feedback shows up in context each turn
(prints nothing when there is none):

```json
{ "hooks": { "UserPromptSubmit": [ { "hooks": [ { "type": "command", "command": "drawpad hook" } ] } ] } }
```

Or run `drawpad wait` as a background command; it returns when the human presses Send.

## Human controls

V select · A arrow · C comment (click a spot, or drag a region) · F fit · Esc · Backspace archive · ⌘Z restore.
Paste an image, URL or text anywhere; drop image files; double-click empty space to write a card.
Nothing reaches the agent until **Send feedback**.

Sections: an item belongs to a section until it is dropped inside another section's box. Dragging it
past its own section's edge only stretches the box; it never makes the item loose. Pasted items join the
section under the cursor, else they are loose ("Inbox / loose" in `drawpad board`).

Pin comments send the whole image (max 1000px) with the pin drawn on it; region comments send a crop of the region.

## Dev

`npm run check` type-checks (dev-only TypeScript).
