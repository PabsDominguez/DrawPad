# DrawPad: a visual working space for building apps with an AI agent

Status: draft v5, 2026-11-23. Step 1 is built and in daily use (Liftor); step 2 (mockups) is next.
See "Status" at the end for what exists today.
v5 changes: human drawing tools (line, arrow, rect, ellipse; Shift snaps; drawn on a screen they stick to it
and show in its crops); text tool (T); comment threads with editable / deletable replies written in place;
comment cards keep screen size at any zoom; copy/cut/paste (single image or text also to other apps);
group resize; zoom control with 100%; comment type auto-set to question when it ends in "?".
v4 changes (Pablo's second pass): human-drawn frames (F, or Frame on a selection) with an explicit box;
an item dropped outside a drawn frame leaves it; selection box on empty canvas, Shift-click multi-select,
group move and delete as one undo step; comments collapse to their pin after saving (click to open);
comment link is a dashed elbow line; Approve / Reject hidden in the UI until mockups (step 2).
v3 changes (after the first Liftor test): no Send step, human feedback reaches the agent when saved;
no arrow tool for the human (pin + note covers it); Cmd+Z / Shift+Cmd+Z undo; draggable comment pins;
pin crops are the whole image with the pin drawn on it.
v2 changes: custom canvas confirmed (tldraw rejected, see 7); human toolkit is image / text / link / arrow;
CLI-first agent interface and token budgets added; agent-made mockups (design-system sheets, screens
from code) are read-only for the human and come right after the MVP.

**Audience: one human and one agent, nobody else.** No productisation, no multi-user,
no auth. The tool is optimised for the agent's ergonomics and for cost first (section 5b);
the human UI only has to be clear and fast, not polished.

## 1. Purpose

A shared, free-form board where the agent **shows and creates** things and the human **reacts**.
It replaces the loop of: agent saves screenshots to a folder -> human opens them ->
human pastes them into Paper/pen.dev and comments -> human re-types feedback in chat.

It is a working visual space for a project, like the Paper/pen.dev boards used for
LifTxT: messy and exploratory, with design-system sheets, annotated screenshots,
screens built from the current code, option rounds, logo explorations and flow diagrams
all on one surface. The agent can paint things there (design system, screens); the human
cannot edit them, only react.

Why it exists next to Paper, pen.dev and tldraw: none of them covers the whole loop in one
place (agent-placed artifacts + feedback as data + agent memory), and each adds a lot that is
not needed here. DrawPad deliberately has no design tools, no styling panels, no plugins.

### Principles
- **The agent authors; the human guides.** No design tools for the human. No shape
  drawing, no text styling, no layout editing of mockup content. The human's toolkit is
  deliberately small: add an image, add text, add a link, pin a comment.
- **Feedback must reach the agent as data.** A comment is text + the exact target
  + a crop image + the artifact version it was made on. Nothing the agent has to guess.
- **Files, not a service.** One folder per project, diffable, offline, in git.
- **Stays legible when huge.** 100+ items must remain navigable.
- **Cheap to build, cheap to run.** Few dependencies; every agent-facing output is
  token-budgeted (section 5b). If a feature does not make the loop cheaper or shorter, it waits.

## 2. Who can do what

| Action | Agent | Human |
|---|---|---|
| Add image (screenshot, file) | yes | yes (paste, drop) |
| Add HTML mockup (design-system sheet, screen, any size) | yes | no |
| Add link card (URL + title) | yes | yes (paste URL) |
| Add text card (markdown, any length) | yes | yes (type or paste text) |
| Add arrow (item to item, or item to a point on an item) | yes | no (comment pins only) |
| Comment (text card + arrow to a target) | yes (own notes) | yes |
| Create / rename section | yes | rename only |
| Group as options, relate artifacts | yes | no |
| Pick an option, approve, reject | no | yes |
| Move / resize / archive items | yes | yes |
| Edit inside an artifact (mockup HTML, other's image) | own only | no |
| Delete | agent, soft | soft (undo) |

## 2b. One surface, everything is a frame (decided 2026-11-22)

There is a single board, not a review surface plus a scratch surface. The difference between
"agent's output" and "human's open field" is ownership, not location.

- **Every item is a frame**: agent screens and mockups, screenshots, pasted images, links, text cards.
- **Content is locked to its author.** The human cannot edit inside an agent's mockup; the agent
  cannot alter a human's pasted image. Either can comment on, move, resize and archive any frame.
- **Layout is free for both.** The agent may move or re-arrange anything, including items the human
  has positioned (otherwise the human would have to keep tidying). Safety net: every agent
  move/arrange snapshots the layout first, returns the list of what moved, and the UI has
  **Undo last arrange**.
- **Inbox section**: human-pasted or dropped items land in a section called "Inbox" by default so
  they do not interrupt the agent's rows. Dragging them out is optional.
- **Optional later**: a filter view over the same data (for example "Review": agent-created items
  with open comments, as a simple list). A lens, not a second surface.

## 3. Data model (all in `board.json` + asset files)

Every item uses one common envelope plus a per-kind payload, so new kinds never change the core.
The file carries a `schemaVersion` with migrations.

- **Board**: schemaVersion, revision (monotonic counter), id, name, background (dark/light),
  items[], sections[], relations[], groups[], rounds[].
- **Item** (common): id, **key** (stable readable handle, e.g. `day-screen`, unique per board),
  kind, x, y, w, h, z, title?, section?, state (`active | archived | not_chosen`),
  **versions[]** (every item, including images; comments attach to item + version),
  **source?** (`{commit, launchArg, files[], note}`: what code state produced it),
  createdBy (`agent | human`), round, createdAt, seenByHuman (bool).
  - `image`: asset path, source label (e.g. "simulator: Day screen"). Thumbnails at a few sizes.
  - `mockup`: versions[] of {html path, snapshot png, note}. Fixed canvas size, fonts via
    `@font-face` and values via shared `tokens.css` from the project (see 5b).
  - `link`: url, title, optional preview image (agent-provided; for human links the server
    fetches the page title only).
  - `text`: markdown, optional colour preset. Replaces the old sticky and note kinds; both
    agent and human can add it. Human comments are text items (see Comment).
  - `arrow`: from (itemId), to (itemId), toPoint? (x, y in the target's item coordinates, 0 to 1),
    label?. Endpoints are bound to items and follow them when moved or resized. One style, one colour.
- **Section**: id, title, rect or member items. Title stays readable at any zoom. Moving a section moves its members.
- **Relation** (agent only): from, to, kind (`revision_of | alternative_to | flows_to`), label?.
  Distinct from `arrow`, which is a visual pointer either side can draw.
- **OptionGroup**: question, items[], chosen?, reason?. Picks set `chosen` and mark the rest `not_chosen`.
- **Round**: id, timestamp, label (auto, e.g. "Round 7, 22 Nov 19:47"), items added.
- **Comment**: not a separate canvas object. It is a `text` item with `intent`
  (`change | question | keep | bug`, quick-pick, default `change`), `status`
  (`open | addressed | resolved`), `thread[]` of replies, plus one or more arrows whose
  `to` is the target item (and version). Derived fields: targetItem, targetVersion, targetPoint,
  optional region (w, h in item coordinates, if the human dragged one to set the crop), and
  cropAsset (png rendered from the snapshot of that version around the point or region).
  All coordinates are item-local (0 to 1) so resizing or replacing an image does not break them.
- **Reaction**: itemId, kind (`approve | reject`), reason?.

## 4. Human UI (local web page, one screen)

- Infinite canvas: pan, zoom, select, move, resize. Fit-to-section, fit-all.
- **Outline sidebar**: sections, with counts of unseen items and open comments. Click jumps.
- **Unseen badge** on items added since the last visit; "next unseen" key.
- **Add**: paste an image anywhere = new image item at the cursor. Paste a URL = link card.
  Paste text, or double-click empty space and type = text card.
- **Arrows**: agent only (`drawpad arrow`). The human points at things with comment pins.
- **Comment**: click a spot on an artifact. A text card is created beside it with an arrow to
  that point; type, Enter to save. Optional drag to set a crop region, intent quick-pick.
  Typed text only, no handwriting or freehand. The pin can be dragged later (new crop, re-delivered).
- **Undo / redo**: Cmd+Z and Shift+Cmd+Z for the human's own actions (move, add, archive, edit, pin,
  reply, pick, rename). Space held = hand tool for panning.
- Option groups show A/B/C side by side with a "pick this one" button and an optional reason.
- Version stepper on mockups and images (compare previous and current).
- Archive: dimmed, collapsed rows. One key to archive or restore.
- **No Send step** (decided 2026-11-22): a comment is private while it is being typed and goes to the
  agent once saved (Enter). The human talks to the agent in chat anyway; the hook announces what
  is waiting on the next prompt. A round closes when the agent takes a batch with `drawpad feedback`.
- Search and minimap are optional and come last.

### Rendering
- Mockups render as cached snapshots when zoomed out or off-screen; live iframe only when
  zoomed in or selected. Section titles and item titles scale to stay legible (never truncated
  to "Ne...").
- Viewport culling and thumbnails from day one.
- Dark canvas by default (frames read better), light as an option.

## 5. Agent interface (CLI first, thin MCP wrapper optional)

**The CLI is the primary interface.** An MCP server puts every tool definition into the agent's
context each session; a CLI used through Bash costs nothing until called. Verbs take flags
instead of there being one tool per action. All verbs print compact text by default.

- `drawpad board [--section S] [--since REV]`: compact text outline (see 5b). Prints "unchanged" when nothing moved.
- `drawpad add <image|mockup|text|link> [path|url|-] --key K [--title T] [--section S]
  [--below K|--right-of K|--in-row-with K|--at x,y] [--source ...] [--width W --height H]`:
  upsert by key (same key adds a version). `drawpad add --many file.json` places several in one call.
- `drawpad update <key> [--html file | --patch old=>new] [--note N]`: new version; `--patch`
  applies a find/replace to the current HTML so a small change does not resend the whole file.
- `drawpad feedback [--since REV] [--crops] [--json]`: sent comments, picks, reactions and new human
  items. Marks them delivered. `drawpad crop <comment_id>` returns one crop on demand.
- `drawpad reply <comment_id> "text"`, `drawpad done <comment_id> [--artifact K]`
- `drawpad arrow <from> <to> [--point x,y] [--label L]` and `drawpad relate <from> <to> <kind>`
- `drawpad section <title> [keys...]`, `drawpad arrange <section> --layout row|grid|column`
  (snapshots first, moves any item including human-placed ones, lists what moved),
  `drawpad options "question" k1 k2 ...`, `drawpad archive|restore <key>`
- `drawpad shot <key|section|board> [--scale]`: so the agent can see the board; last resort.
- `drawpad capture sim|url <url>` and `drawpad render --html file --width W --height H`:
  one-call capture-and-place.
- `drawpad hook`, `drawpad wait`: delivery paths (see 5b).

**MCP (optional)**: a thin wrapper over about six tools (`board`, `add`, `update`, `feedback`,
`reply`, `shot`) for clients that prefer it. Every call goes through the same HTTP API as the CLI.

All placement is semantic; the tool avoids overlaps.

## 5b. Agent ergonomics and cost (the main design goal)

**Token budgets (acceptance checks, measured with `drawpad stats`)**
- `drawpad board` for a 20-item board: under ~1,500 tokens; "unchanged" when nothing moved.
- `drawpad feedback`: under ~300 tokens per comment without crops.
- Hook line: under ~30 tokens when active, nothing when there is no new feedback.
- A mutating call returns one line (key, version, position). Rects and a problem list
  (overlap, image under a readable size, mockup overflow) only when something is wrong.
- `drawpad stats` prints approximate output tokens per call so regressions are visible.

**Token-cheap, text first**
- `drawpad board` replaces taking a screenshot of the board (far more tokens). It lists sections, items
  (key, kind, state, round), unseen items, open comments, pending picks and the latest few
  decisions (older ones read on request).
- Images are on demand. Feedback arrives as text: comment, intent, arrow target, point, region,
  item + version, `source`. Crops are fetched with `--crops` or `drawpad crop`, capped at ~1000px on
  the long edge. Human-pasted images arrive as key + dimensions + file path; the agent opens the
  file only if it needs to look.
- Deltas, not snapshots: every change bumps `revision`; `--since` returns only what is new.

**Cheap to author (agent-made mockups)**
- Shared `shared/tokens.css`, fonts and small HTML partials live in `.drawpad/` (a script can generate
  tokens from the project's code, e.g. Liftor's `Cyber` palette). A screen references them
  instead of repeating them, so each mockup is short.
- `drawpad update --patch` and keyed upserts mean edits and re-runs do not resend full files.
- Design-system sheets and screens-from-code are normal mockups: read-only for the human, versioned,
  commentable.

**Hard to call wrongly**
- Items are addressed by `key`. `add` with the same key **upserts** a new version instead of a duplicate,
  so re-running a skill is safe.
- Batch: `--many` and rows place several items in one call.
- Placement is semantic; coordinates are optional and never required.

**Feedback reliably reaches the agent**
- Pull alone is the weak point. Provide both:
  1. a Claude Code `UserPromptSubmit` hook (`drawpad hook`) that prints "N open comments, M picks on
     DrawPad" into context each turn, only when there is something new;
  2. `drawpad wait`: blocks until feedback is waiting and the human has paused for ~8s, for use as a
     background command so the agent is woken by it.
- `intent` on each comment tells the agent whether it is a change request, a question, a bug, or
  "keep this". A `keep` comment is never treated as a to-do.

**Tied to the code**
- `source` on an item records the commit, the launch argument (Liftor: `-debugOpen day`), and files.
  `drawpad feedback` returns it with the comment, so the agent knows what to open.

**The board as memory**
- `decisions.md` in `.drawpad/` is appended on every pick/approve/reject with item keys, the reason,
  and the date. `drawpad board` includes the latest decisions. Context resets do not lose
  what was chosen and why.

**Deliberately not built**: Mac wrapper, multi-user, permissions, accounts, polished theming,
freehand or shape drawing, human editing of mockups.

## 6. Storage

```
<project>/.drawpad/
  board.json
  decisions.md       append-only log of picks/approvals/rejections with reasons
  shared/            tokens.css, fonts, HTML partials for mockups
  assets/            images, mockup html, snapshots, comment crops
  history/           board.json snapshots (one per feedback round taken by the agent)
```
Git-friendly. Writes are atomic. A single tool install serves many projects (each `.drawpad/` is independent).

## 7. Architecture

- Local Node server (HTTP + WebSocket for live refresh) + browser page, TypeScript end to end, few
  dependencies. One server is the **single writer**; the web UI, CLI, MCP and hook are thin
  clients of one HTTP/JSON API. The revision counter gives `since` queries, live refresh and undo.
- **Custom minimal canvas** (transformed div; iframes, `<img>` and one SVG layer for arrows).
  tldraw was considered and rejected (2026-11-22): the human has no drawing tools, so a locked-down
  drawing library is harder to bend than a small custom canvas; its SDK now needs a licence key for
  production use (hobby licences are discretionary and keep a watermark); and its shape store would
  duplicate the server-owned `board.json`. Revisit only if freehand, free text or floating marks
  become wanted. Because `board.json` is the source of truth, swapping the view layer later would
  not change the agent API.
- Mockup snapshots and comment crops need a headless browser. Prefer `puppeteer-core` driving the
  Chrome already installed (no browser download); only needed from step 2.
- Pull model plus nudges: the page cannot push into the agent's session. The agent calls
  `drawpad feedback` when asked ("check DrawPad") or when the hook / `drawpad wait` tells it there is something.
- Region crops are rendered from the snapshot of the version the comment was made on.
- A Mac app wrapper (WKWebView) is optional later.

## 8. Build order

1. **Board + images + text/link/arrow + comments (MVP).** Canvas, pan/zoom, image items (agent +
   paste/drop), text and link cards (human + agent), arrows, sections with outline, comments
   (text + arrow + crop + intent), Send feedback, `drawpad add` (upsert by key), `--many`, `drawpad board`,
   `drawpad feedback`, `reply`, `done`, `capture sim`, `shot board`, terse mutation results,
   `decisions.md`, `drawpad stats`, and the `drawpad hook` / `drawpad wait` delivery paths.
2. **Mockups + versions.** `add mockup`, `update` (incl. `--patch`), shared tokens/partials,
   snapshot cache, live-on-zoom, version stepper, `render`. Design-system sheets and
   screens-from-code are the target use.
3. **Options + relations + rounds.** Option groups with picks, relations, unseen badge, archive
   states, `arrange` with undo.
4. **Extras.** `capture url`, history snapshots, token-sheet generator from code, then (only if
   wanted) search and minimap.

### Step 1 acceptance checks
- Agent adds 3 simulator screenshots in a section; they appear without reload and don't overlap.
- Human pastes a phone screenshot; it lands at the cursor as a human-authored item, in "Inbox".
- Human pastes a block of text and a URL; a text card and a link card appear.
- Human clicks a spot on a screenshot, types "this label is too small", presses Send feedback.
- `drawpad feedback` returns that comment with text, intent, target point, crop PNG on request,
  item key and version, and the item's `source`.
- Human draws an arrow from a text card to an image; moving either item keeps the arrow attached.
- Agent `reply`s and marks done; the thread shows it, and the status updates on the board.
- 150 image items still pan and zoom smoothly; section titles stay readable at overview zoom.
- Restarting the server and reloading restores the whole board from `.drawpad/`.
- `drawpad add` twice with the same key creates one item with two versions.
- `drawpad board` for a 20-item board fits in under ~1,500 tokens and lists unseen items,
  open comments and the last decisions; with no change it prints "unchanged".
- A `keep` comment is reported but not listed as a to-do.
- With the hook installed, pressing Send makes the next prompt show "N open comments"; with no
  new feedback the hook prints nothing.
- A deliberately overlapping placement returns a problem report with the corrected rect; a clean
  placement returns a one-line result.

### Step 3 acceptance checks
- `arrange` on a section with a human-moved item moves it, lists it in the result, and
  "Undo last arrange" restores the previous layout exactly.

## 9. Decisions (2026-11-22)
1. Name: **DrawPad**. CLI `drawpad`, folder `.drawpad/`, MCP name `drawpad`.
2. Tool repo: `~/Stuff/Projects/DrawPad`, installed globally with `npm link`. Each project keeps only
   its own `.drawpad/` folder.
3. Server lifecycle: `drawpad serve` per project, started on demand (auto-started by the first
   command that needs it). No shared daemon.
4. First board: Liftor (git-ignored until decided otherwise).
5. Stack: TypeScript + Node; UI in plain TS with small modules, no framework in the MVP
   (switch to React only if the UI starts to need it).
6. Human move/resize: allowed.
7. Hook output: count only to start.
8. Mockup tokens: hand-maintained `tokens.css` first, generator from code later.
9. Multi-user is out of scope (just the human and the agent).

## 10. Open questions
1. Whether to track the agent's own session/branch on each round (useful when several agents work).

## Status (2026-11-23)

Built (step 1 plus Pablo's feedback rounds):
- Canvas: pan (Space, trackpad, wheel), zoom (pinch, ⌘-scroll, bottom-right control), fit (⇧1), 100% (⇧0).
- Items: images (paste, drop, agent), text cards and the text tool, links. Undo/redo of all human actions.
- Selection: box select, Shift-click, ⌘A; move, scale and delete groups; copy/cut/paste.
- Board switcher: click the board name (top right) to load another project's board in the same window.
- Frames/sections: drawn frames (F) or Frame on a selection; move by title, resize from the corner.
- Comments: pin or region, type (change/question/bug/keep), collapse to pin, hover peek, threads with
  editable replies, resolve; crops (whole image with pin, or region) include the human's drawings.
- Drawings: line, arrow, rectangle, ellipse (agent sees them as one line of text each, plus a crop).
- Agent: `add` (upsert by key, versions), `--many`, `board`, `feedback`, `reply`, `done`, `drop`, `section`,
  `move`, `archive/restore`, `capture sim`, `hook`, `wait`, `stats`; launcher app; one window per board.

Step 2 part 1 built (2026-11-24): `add html <file.html|svg>` = an image item with an HTML source
(`version.html`, `cw`), rendered by headless Chrome (exact width via an iframe, auto height); live sandboxed
iframe when it is >= 360px on screen; `/p/` serves project files for its relative links. Re-add = version.

Not built yet: themes/tokens grid, components, option sets with picks (Approve/Reject is hidden in the UI until then),
`shot board`, version stepper, `capture url`. Comments panel (top bar "Comments"): grouped For you / With the agent / Resolved; a row zooms to the screen and opens the comment.

Sharing later: replace `sips` with JS image sizing and browser thumbnails (cross-platform), publish to npm,
package hook + a skill as a Claude Code plugin, add a licence.
