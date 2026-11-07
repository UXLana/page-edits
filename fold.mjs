// Reading the inbox, with nothing but text in and notes out. The dev server, the receiver's command
// and the Claude Code plugin's watch all fold the same event log, so they agree on every note's
// number and state. No file system here: the plugin's hooks run where there is none.

// Every note carries the format it was written in. The page half and the receiving half are
// installed apart, so a receiver meeting a newer format leaves the note alone instead of guessing.
export const NOTE_FORMAT = 1;
export const isNewer = (note) => Number(note.format ?? 1) > NOTE_FORMAT;

export const STATES = ["queued", "applying", "done", "not-in-code", "needs-you"];
export const FINAL_STATES = new Set(["done", "not-in-code", "needs-you"]);

export function parseEvents(text) {
  const events = [];
  for (const line of String(text ?? "").split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // A half-written last line while another process appends: skip it, the next read has it.
    }
  }
  return events;
}

// Folds the event log into notes, oldest first, each carrying its latest state. A note sent twice
// (a retry that reached two servers) counts once, at its first place.
export function foldNotes(events) {
  const notes = new Map();
  const clients = new Set();
  for (const event of events) {
    if (event.type === "note") {
      if (event.clientId && clients.has(event.clientId)) continue;
      if (event.clientId) clients.add(event.clientId);
      const id = notes.size + 1;
      notes.set(id, { ...event, id, type: undefined, state: "queued", result: null });
    } else if (event.type === "state" && notes.has(event.id)) {
      const note = notes.get(event.id);
      note.state = event.state;
      note.result = event.result ?? null;
      note.updatedAt = event.at;
    }
  }
  return [...notes.values()].map(({ type, ...note }) => note);
}
