# DrawPad: notes for agents working on this repo

DrawPad is a shared visual board for one human (Pablo) and one coding agent. The agent puts things on it
(screenshots, notes, HTML/SVG designs of anything); the human reacts with pinned comments, drawings, notes and frames;
the agent reads that feedback as compact text. Design and decisions: `SPEC.md`. Install and controls: `README.md`.

## Priorities (in order)
1. **Agent token cost.** Everything the agent reads (`drawpad board`, `drawpad feedback`, the hook line) is
   terse text; images only on request. UI-only features cost the agent nothing; keep it that way. Judge every
   feature by what it adds to the agent's context.
2. **Simple, working, now.** Ship the simplest version and name its limits. Don't fight macOS for polish
   (window focus, permissions); offer the simple path instead.
3. Feels like a design tool to the human (Figma conventions: V, F frame, ⇧1 fit, ⇧0 100%, Shift snaps).

## Stack
- TypeScript run directly by Node >= 22.18 (type stripping): no build step. Only `erasableSyntaxOnly` TS
  (no enums, no parameter properties). Zero runtime deps; dev deps are `typescript` + `@types/node` for checks.
- The server strips types from `ui/*.ts` on the fly for the browser. Plain DOM, no framework.
- macOS: `sips` for image sizes/thumbnails; native WebKit app for the window (Chrome app mode fallback);
  one hidden headless Chrome per server for design renders (DevTools protocol, `src/images.ts`).

## Architecture
- One **server per project** (`src/server.ts`), auto-started by any CLI command, the **single writer** of
  `<project>/.drawpad/board.json` (atomic rename). Fixed port per project (hash of the path, 47100-47999).
  The CLI restarts a server whose code is older than the source (`codeStamp`), so code changes apply on the
  next CLI command or when the board is reopened.
- The UI (`ui/`), the CLI (`src/cli.ts`) and the hook are thin clients: every mutation is `POST /api/op`
  `{op, ...args}` (see the `ops` map in `server.ts`). `batch` runs several ops as one human undo step.
- Live refresh: SSE `/api/events` sends the revision; the UI refetches `/api/board` and re-renders.
- Feedback: human items/replies/drawings get `sent` (= revision) + `delivered=false` when saved, but the agent only
  sees those with `sent <= board.released`; the human's **Send to agent** button (⌘↩, op `release`) moves it.
  `drawpad feedback` prints them and marks them delivered (closes the round). `drawpad hook`
  (UserPromptSubmit) prints one line only when something is waiting.

## Files
- `src/types.ts` data model (Board, Item, Section, Comment, Reply, Mark).
- `src/store.ts` all board mutations (add/upsert-by-key with versions, move with section rules, frames,
  comments, replies, marks, archive, rounds). Every mutation: bump revision, set `it.rev`, `save()`.
- `src/layout.ts` placement for agent items (semantic: section/below/rightOf, overlap resolution) and
  `sectionRect` (members' box, never smaller than a drawn frame; comments don't stretch it).
- `src/images.ts` image sizes/thumbs (sips), design render + probes via headless Chrome; `src/probe.js` runs inside
  that page (checks, element under a pin, outline). Plain JS, inlined as a script.
- `src/report.ts` the agent's text views. **Every byte costs tokens.**
- `src/cli.ts` verbs, server start/restart, `open`, `app` (builds the native `~/Applications/DrawPad.app` from
  `app/DrawPad.swift`: WebKit window per board, Info.plist holds node/cli paths; `recent` gives it a URL).
- `ui/app.ts` the whole canvas: render, pointer tools, editors, undo stack, copy/paste. `ui/style.css`.
- `test/ui.mjs` headless UI smoke test (real input via Chrome DevTools Protocol, throwaway project in /tmp).

## Rules that bit us
- Comment cards and their editors keep screen size at any zoom (`scale(var(--inv))`); world-space math
  for them multiplies by `1/view.z`.
- Don't replace DOM under a click (`setHTML` compares first); `#view` must never scroll (focus with
  `preventScroll`).
- Human undo is client-side: `act(redo, undo)` pushes inverse ops; creations use the key in the result line.
- Agent sections only stretch when an item is dragged; drawn frames (with `w/h`) release items dropped
  outside them.
- Designs (`add html`) are image items whose version has `html` (source copy) and `cw`; the PNG keeps every
  image feature (crops, drawings) working. Render: `src/images.ts` `renderHtml`. Don't add design templates:
  the agent is free to make anything, any layout, any number of options.
- Drawings stuck to an image store 0..1 coords of that image and are burned into its crops.

## Working on it
- `npm run check` (types) and `npm run test:ui` (headless; opens nothing on screen) after changes.
  Add a check to `test/ui.mjs` for each behaviour you fix or add.
- Never open windows or dialogs on Pablo's screen to test without asking.
- Pablo's live board is Liftor (`~/Stuff/Projects/Liftor`, port 47225); don't write test data there.
- Commit and push to `origin/main` (github.com/PabsDominguez/DrawPad) when a change is done and checked.
