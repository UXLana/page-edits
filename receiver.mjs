// The receiving session's side of page-edits.
//
//   page-edits watch                    one line per note still to handle, then one per new note
//   page-edits list                     every note and its state
//   page-edits find <id>                where the note's words are written (JSON)
//   page-edits state <id> <state>       records progress; `done` takes a result on stdin
//
// Every command takes `--inbox <file>`: the inbox the dev server printed. Without it,
// PAGE_EDITS_INBOX, else `.page-edits/notes.jsonl` in the current folder. A `done` state takes
// `{ "file", "before", "after", "message" }` on stdin: the exact source text replaced and its
// replacement, which later notes follow when an earlier edit rewrote their words.

import { watchFile } from "node:fs";
import { resolve } from "node:path";
import { locate } from "./finder.mjs";
import { appendState, defaultInbox, FINAL_STATES, isNewer, NOTE_FORMAT, readNotes } from "./store.mjs";

const USAGE = "usage: page-edits watch|list [--inbox <file>] · find <id> · state <id> <state>";

const oneLine = (text, max) => {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};
export const describe = (note) =>
  `note ${note.id} · ${oneLine(note.page, 200)} · "${oneLine(note.selected, 90)}" → ${oneLine(note.comment, 200)}`;

function parse(argv, env) {
  const words = [];
  let inbox = env.PAGE_EDITS_INBOX;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--inbox" || argv[i].startsWith("--inbox=")) {
      inbox = argv[i] === "--inbox" ? argv[++i] : argv[i].slice("--inbox=".length);
      if (!inbox) return { error: "page-edits: --inbox needs a path" };
    } else words.push(argv[i]);
  }
  return { words, file: inbox ? resolve(inbox) : defaultInbox(process.cwd()) };
}

async function readStdin() {
  if (process.stdin.isTTY) return "";
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8").trim();
}

// Returns the exit code; `watch` never returns.
export async function main(argv, { env = process.env, out = console.log, err = console.error } = {}) {
  const fail = (message, code = 1) => (err(message), code);
  const { words, file, error } = parse(argv, env);
  if (error) return fail(`${error}\n${USAGE}`, 2);
  const [command, idArg, stateArg] = words;
  const noteById = (id) => readNotes(file).find((n) => n.id === Number(id));
  const tooNew = (note) =>
    `page-edits: note ${note.id} was written in note format ${note.format}; this page-edits reads up to ${NOTE_FORMAT}. Update the package.`;

  if (command === "watch") {
    // By each note's own id, not its number: an inbox cleared or replaced numbers from 1 again.
    const seen = new Set();
    const emit = () => {
      for (const note of readNotes(file)) {
        const key = note.uid ?? `${note.id}:${note.at}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (!FINAL_STATES.has(note.state)) out(describe(note));
      }
    };
    out(`watching ${file}`);
    emit();
    watchFile(file, { interval: 400 }, emit);
    return new Promise(() => {});
  }
  if (command === "list") {
    for (const note of readNotes(file)) out(`${note.state.padEnd(11)} ${describe(note)}`);
    return 0;
  }
  if (command === "find" && idArg) {
    const note = noteById(idArg);
    if (!note) return fail(`page-edits: no note ${idArg} in ${file}`);
    if (isNewer(note)) return fail(tooNew(note));
    const ledger = readNotes(file)
      .filter((n) => n.id < note.id && n.state === "done" && n.result?.before && n.result?.after)
      .map(({ id, page, result, updatedAt }) => ({ id, page, result, doneAt: updatedAt }));
    const found = locate(note, ledger);
    out(
      JSON.stringify(
        {
          note: { id: note.id, page: note.page, selected: note.selected, comment: note.comment, root: note.root },
          status: found.status,
          followedNote: found.followedNote ?? null,
          match: found.match ?? null,
          candidates: found.matches.slice(0, 5),
        },
        null,
        2,
      ),
    );
    return 0;
  }
  if (command === "state" && idArg && stateArg) {
    const note = noteById(idArg);
    if (!note) return fail(`page-edits: no note ${idArg} in ${file}`);
    if (isNewer(note)) return fail(tooNew(note));
    const input = await readStdin();
    let result = null;
    try {
      result = input ? JSON.parse(input) : null;
    } catch {
      return fail(`page-edits: the result on stdin is not JSON: ${input.slice(0, 80)}`);
    }
    try {
      appendState(file, Number(idArg), stateArg, result);
    } catch (problem) {
      return fail(problem.message);
    }
    out(`note ${idArg} → ${stateArg}`);
    return 0;
  }
  return fail(USAGE, 2);
}
