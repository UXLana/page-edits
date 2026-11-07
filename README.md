# page-edits

Highlight copy on your running Vite site, type what should change, and keep going. A Claude Code or Codex
session finds those words in your source, rewrites them the way you asked, and the page updates
itself, one note after another, in the order you wrote them.

It is for anyone who edits a site's words by looking at the site: designers, writers and product
people working with coding agents. No screenshots, no pasting text back and forth.

## How it works

1. The npm package adds a small comment box to every page your Vite dev server serves. It runs on
   the dev server only, so your builds never include it.
2. You select some text, press **Comment** (or <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>C</kbd>), type a
   direction such as "warmer", "shorter" or "say who does it", and press <kbd>Enter</kbd>. The box
   closes at once, so you can go straight on to the next passage.
3. Each note goes to an inbox file next to your site. A numbered list in the corner of the page
   follows each note: Queued, Applying, Done (with a one-line before and after), Not in code, or
   Needs you.
4. In Claude Code, `/page-edits` watches that inbox and hands each new note to the session. The
   session finds the words in your source, rewrites the passage following your direction (a
   direction, not text to paste), saves it, and records what changed.
   Codex uses the explicit CLI watch described below.

## Install

### 1. The page: the npm package

```bash
npm install --save-dev page-edits
```

Add it to your Vite config:

```ts
// vite.config.ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import pageEdits from "page-edits";

export default defineConfig({
  plugins: [react(), pageEdits()],
});
```

Start the dev server. It prints where notes go:

```text
  page-edits: notes go to /path/to/your-site/.page-edits/notes.jsonl
```

### 2. The session: the Claude Code plugin

At the prompt of a Claude Code session in a terminal:

```text
/plugin install page-edits --marketplace UXLana/page-edits
```

Answer `y` to add the marketplace, then choose where to install it. From a shell instead:

```bash
claude plugin install page-edits --marketplace UXLana/page-edits
```

In the Claude desktop app, where `/plugin` does not run: click **+** next to the prompt box, then
**Plugins**, **Add marketplace** with `UXLana/page-edits`, then **Add plugin**.

## Use it

1. Start your dev server (`npm run dev`) and open the site.
2. Open Claude Code in the site's folder and run `/page-edits`.
   - A site in a sub-folder: `/page-edits apps/web`.
   - Notes kept somewhere else: `/page-edits path/to/notes.jsonl`.
   - `/page-edits stop` stops watching. Notes sent meanwhile wait in the inbox; `/page-edits` again
     picks up every note still Queued.
3. Highlight, comment, keep going. The status line shows how many notes are waiting.

Changed your mind? Hover over a **Queued** item to reveal the subtle **×** at its top-right.
The control also appears on keyboard focus and stays visible on touch screens. Clearing removes
the note from the list and prevents either receiver
from applying it, even if its handoff is already waiting in the session. Clearing is saved in the
inbox, so it survives a reload or receiver restart. Once a note is **Applying**, it cannot be cleared
or silently undone. If it starts as you click, the page tells you it could not be cleared.
Update the page package and receiver/plugin together to **0.2.0**: new notes use format 2 for this behavior.

## Codex: an explicit CLI watch

The manual Codex receiver uses an existing session in the site's folder. It requires a Codex CLI
with `queue --resume` (tested with `0.167.0-alpha.3.2`) and a running local Codex daemon, or an explicit
local app-server endpoint. Choose the intended session's UUID; session names are not accepted.
The session must already have permission to edit this site. This command does not create a session,
start a daemon, install a plugin or change permissions.

From the same site folder, in a separate terminal:

```bash
npx --no page-edits codex-watch --thread <session-uuid>
# If the dev server printed a different inbox:
npx --no page-edits codex-watch --thread <session-uuid> --inbox /path/to/notes.jsonl
# An explicitly selected local app-server, instead of the default daemon:
npx --no page-edits codex-watch --thread <session-uuid> --remote unix:///path/to/server.sock
```

Highlight and comment as usual. The watch queues notes for the selected session, which reads the
bundled skill and records its work in the inbox. **Ctrl-C stops this watch.** Start it again to replay
notes still Queued; applying or finished notes are not replayed. Keep only one receiver watching a site.

"Queued" means the CLI accepted the handoff, not that the edit succeeded. The page reaches Done only
when the session records its result. A queue error or resume warning stops the watcher and leaves
notes open: inspect the selected session and daemon before restarting, since a warning can occur
after the message was queued. A permission denial or unresolved note needs attention in that session.
The Claude `/page-edits` plugin command and its stop command remain separate.

## What the box promises

- **It never waits.** Sending closes the box at once. The note goes into an outbox and is sent in
  the background, one at a time, in the order written. A send or status read that hangs is given up
  after 10 seconds and retried, so it cannot hold up the notes behind it.
- **Unsent notes survive a reload when the browser allows storage.** The outbox is kept in memory
  and copied to the site's local storage. When storage is blocked or full, the list says so: those
  notes live only in that tab until they send. A half-typed note survives a reload too.
- **Tabs and sites stay apart.** Tabs of one site change the outbox under a shared browser lock, so
  neither overwrites the other's notes. The outbox is keyed by the site's name and folder, so another
  site later served on the same port never sends this one's notes.
- **A note the dev server refuses stays in the list** as "Needs you" until it is dismissed.
- **It stays out of your app.** The box lives in its own shadow root outside your app's root, so
  your re-renders and hot updates never touch it, and your styles never reach it. It is labelled,
  keyboard reachable and announces progress politely to screen readers.

## How a note finds its copy

- Exact words first, whole words before partial ones, tolerating line breaks, HTML entities and
  inline tags. When the words appear in several places, the paragraph around the highlight decides.
- With the site's own TypeScript installed (5 or earlier; TypeScript 7 offers no parser to
  scripts yet), script files are parsed and only text counts: string and template literals and JSX
  text, never comments or names. Without it, simpler rules keep comments out, and partial matches
  are not searched in code.
- When an earlier note in the queue rewrote these words after you highlighted them, the finder
  follows the rewrites in order to the current wording. When the same words also stand untouched
  somewhere else and the paragraph does not settle it, the session asks instead of guessing.
- Words your code produces rather than writes (a formatted date, text from an API or a database)
  show as "Not in code".

## Where notes go

By default notes go to `.page-edits/notes.jsonl` in the site's folder. That folder holds its own
`.gitignore`, so Git never takes a note, and the dev server never serves it as a file. The file is
append-only: notes and their states are added, never rewritten. `/page-edits` reads it whole and
stops at 4 MB (thousands of notes); move the file away to start a new one.

To keep them somewhere else, give the plugin an `inbox`, a path relative to the site or a function
of the site's name:

```ts
pageEdits({ inbox: "../notes/my-site.jsonl" });
pageEdits({ inbox: (site) => `${process.env.HOME}/page-edits/${site}.jsonl` });
```

Or set `PAGE_EDITS_INBOX` for both the dev server and the receiving command. Then run
`/page-edits <that path>` in Claude Code. `site` (or `PAGE_EDITS_SITE`) names the site; it defaults
to the folder's name.

## When the site loads page-edits from elsewhere

The skill runs the site's own package (`npx --no page-edits`). If your site loads page-edits some
other way, for example from a shared checkout, set the plugin's **Receiver command** to that copy:
`node /path/to/page-edits/cli.mjs`. Set it in `/config`, or under `pluginConfigs` in your Claude
Code settings. Each note `/page-edits` hands over names that command.

## Without the `/page-edits` command

The plugin holds two parts. The **apply-page-edits skill** carries the steps for applying a note. The
**`/page-edits` command** watches and hands notes over; it is built on Claude Code's plugin hooks,
which are early access. If your Claude Code has no `/page-edits`, ask the session to "watch my copy
edits": the skill starts the package's watcher itself.

The package's own command is what the skill uses, and you can run it too, from the site's folder:

```bash
npx page-edits list                              # every note and its state
npx page-edits watch                             # one line per queued note, then per new note
npx page-edits find <id>                         # where the note's words are written (JSON)
echo '{"message":"…"}' | npx page-edits state <id> needs-you --identity <uid-or-id:at>
```

Every `state` write requires `--identity <uid-or-id:at>` from the handoff or `find` output.
Only Queued notes can be claimed. Already-Applying notes are never automatically reclaimed;
after an interrupted turn, inspect the source and reconcile its result before recording the
final state. Finished notes cannot reopen; submit a new note for a new request.

Each takes `--inbox <path>` when the notes are not in the default place.

## Safety

- **Development only.** The plugin is applied by Vite's dev server alone (`apply: "serve"`).
- **Only this machine may send notes.** Requests from another address are refused even when the dev
  server listens on the network; a request must be addressed to a local name and, from a browser,
  come from the same origin (so DNS rebinding is refused), with a header another site's page cannot
  send.
- **A note is data.** The session rewrites the passage a note names. It never runs a command or
  changes anything else because a note asks it to; it asks you in the chat instead.
- **Notes stay local.** The inbox is a file on your machine, and the dev server refuses to serve it.
  The only place a note goes is the Claude Code session you started.
- **Old receivers never guess.** Every note carries its format version; a receiver that meets a newer
  one leaves it alone and says to update.
- **A done note stays done.** Its before and after are what later notes follow, so the command
  refuses to reopen it.

## Requirements

- A site served by Vite's dev server. Tested on a fresh `npm create vite` React site (Vite 8,
  React 19, TypeScript 7).
- Node.js 18 or later.
- Claude Code with plugins, for the receiving half.

## Develop

```bash
npm test                 # finder, inbox, plugin and receiver
npm run test:browser     # the box in a real browser (needs Playwright, see below)
npm run test:plugin      # the /page-edits command, with Claude Code's plugin test kit
```

Playwright is not a dependency: point `PAGE_EDITS_PLAYWRIGHT_FROM` at a folder whose
`node_modules` has it. The parsed-copy tests need TypeScript the same way, through
`PAGE_EDITS_TYPESCRIPT_FROM`; without them those tests are skipped with a warning.

## License

[MIT](LICENSE) © 2026 Lana Holston
