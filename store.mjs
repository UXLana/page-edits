// The page-edits inbox: one append-only JSON-lines file per site.
//
// Two writers share it without coordinating. The dev server appends `note` events as the person
// sends them; the receiving session appends `state` events as it works. Appends are single small
// writes to a file opened for append, so neither can tear the other's line, and the file's order is
// the queue's order. Nothing is ever rewritten. A note's number is its place among the notes in the
// file, never a counter read before writing, so two dev servers sharing an inbox cannot hand out
// the same number.

import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { foldNotes, NOTE_FORMAT, parseEvents, STATES, FINAL_STATES } from "./fold.mjs";

export { FINAL_STATES, isNewer, NOTE_FORMAT, STATES } from "./fold.mjs";

// The default inbox is in the site's own folder, inside a folder that tells Git to ignore
// everything in it, so a note can never be committed.
export const INBOX_FOLDER = ".page-edits";

export function defaultInbox(root) {
  return join(root, INBOX_FOLDER, "notes.jsonl");
}

function append(file, event) {
  const folder = dirname(file);
  mkdirSync(folder, { recursive: true });
  const ignore = join(folder, ".gitignore");
  if (basename(folder) === INBOX_FOLDER && !existsSync(ignore)) {
    writeFileSync(ignore, "# page-edits notes stay on this machine.\n*\n");
  }
  appendFileSync(file, `${JSON.stringify(event)}\n`, { flag: "a" });
}

export function readEvents(file) {
  return existsSync(file) ? parseEvents(readFileSync(file, "utf8")) : [];
}

export function readNotes(file) {
  return foldNotes(readEvents(file));
}

export function appendNote(file, fields, now = new Date()) {
  const existing = readNotes(file);
  if (fields.clientId) {
    // A retry from the page after a dropped response must not queue the same note twice.
    const duplicate = existing.find((note) => note.clientId === fields.clientId);
    if (duplicate) return duplicate;
  }
  const note = {
    type: "note",
    format: NOTE_FORMAT,
    uid: randomUUID(),
    at: now.toISOString(),
    clientId: fields.clientId ?? null,
    root: fields.root,
    page: fields.page,
    selected: fields.selected,
    before: fields.before ?? "",
    after: fields.after ?? "",
    comment: fields.comment,
  };
  append(file, note);
  return readNotes(file).find((n) => n.uid === note.uid || (note.clientId && n.clientId === note.clientId));
}

// `result` for done: { file, before, after } — the exact source text replaced and its replacement.
// It is both what the page shows and the ledger a later note follows when its words were rewritten.
// A done note is final: its result is what later notes follow, so it is never reopened.
export function appendState(file, id, state, result = null, now = new Date(), expectedIdentity = null) {
  if (!STATES.includes(state)) throw new Error(`page-edits: unknown state "${state}"`);
  const note = readNotes(file).find((n) => n.id === id);
  if (!note) throw new Error(`page-edits: no note ${id}`);
  if (expectedIdentity && (note.uid ?? `${note.id}:${note.at}`) !== expectedIdentity) throw new Error(`page-edits: note ${id} changed; refresh the queue`);
  if (note.state === "done") throw new Error(`page-edits: note ${id} is already done`);
  if (note.state === "cancelled") throw new Error(`page-edits: note ${id} was cleared; do not apply it`);
  if (FINAL_STATES.has(note.state)) throw new Error(`page-edits: note ${id} is already ${note.state}`);
  if (state === "queued" || (state === "applying" && note.state !== "queued")) throw new Error(`page-edits: note ${id} is already ${note.state}; it cannot be claimed again`);
  if (state === "cancelled" && note.state !== "queued") throw new Error(`page-edits: note ${id} has already started or finished; it cannot be cleared`);
  const eventId = randomUUID();
  append(file, { type: "state", id, noteUid: note.uid ?? null, noteAt: note.at, eventId, state, result, at: now.toISOString() });
  const accepted = readNotes(file).find((n) => n.id === id);
  if (accepted?.stateEventId !== eventId) {
    throw new Error(`page-edits: note ${id} is now ${accepted?.state ?? "unavailable"}; this action was not accepted`);
  }
}
