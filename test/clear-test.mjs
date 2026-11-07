import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { foldNotes, FINAL_STATES } from "../fold.mjs";
import { appendNote, appendState, readNotes } from "../store.mjs";
import { createHandler } from "../vite-plugin.mjs";
import { createCodexPoll, parseCodexWatch } from "../codex-receiver.mjs";

const exec = promisify(execFile);
const noteEvent = { type: "note", uid: "one", root: "/site", at: "now", page: "/", selected: "Hello", comment: "Shorter" };
const state = (name, eventId) => ({ type: "state", id: 1, noteUid: "one", eventId, state: name, at: "now" });

test("the first clear/claim append wins; clearing and completion cannot be reopened", () => {
  assert.ok(FINAL_STATES.has("cancelled"));
  const cleared = foldNotes([noteEvent, state("cancelled", "c"), state("applying", "a"), state("done", "d")])[0];
  assert.equal(cleared.state, "cancelled"); assert.equal(cleared.stateEventId, "c");
  const claimed = foldNotes([noteEvent, state("applying", "a"), state("cancelled", "c")])[0];
  assert.equal(claimed.state, "applying"); assert.equal(claimed.stateEventId, "a");
  assert.equal(foldNotes([noteEvent, state("done", "d"), state("applying", "a")])[0].state, "done");
  assert.equal(foldNotes([noteEvent, { ...state("cancelled", "c"), noteUid: "old-inbox" }])[0].state, "queued");
  assert.equal(foldNotes([noteEvent, { ...state("cancelled", "c"), noteUid: null, noteAt: "old" }])[0].state, "queued");
  assert.equal(foldNotes([{ ...noteEvent, uid: undefined }, { ...state("cancelled", "c"), noteUid: null, noteAt: "old" }])[0].state, "queued");
});

test("real concurrent clear and claim processes cannot both succeed", async () => {
  const root = mkdtempSync(join(tmpdir(), "page-edits-clear-race-"));
  try {
    const store = new URL("../store.mjs", import.meta.url).href;
    for (let i = 0; i < 5; i++) {
      const inbox = join(root, `race-${i}.jsonl`);
      appendNote(inbox, { root, page: "/", selected: "Hello", comment: "Shorter" });
      const launch = name => exec(process.execPath, ["--input-type=module", "-e", `import {appendState} from ${JSON.stringify(store)}; appendState(${JSON.stringify(inbox)},1,${JSON.stringify(name)});`]);
      const results = await Promise.allSettled([launch("cancelled"), launch("applying")]);
      assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
      assert.ok(["cancelled", "applying"].includes(readNotes(inbox)[0].state));
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("HTTP clear requires origin/header/identity, refuses started edits, and Codex skips cleared notes", async () => {
  const root = mkdtempSync(join(tmpdir(), "page-edits-clear-http-"));
  const inbox = join(root, "notes.jsonl");
  const handler = createHandler({ root, storeFile: inbox });
  const server = createServer((req, res) => handler(req, res, () => { res.statusCode = 404; res.end(); }));
  try {
    await new Promise(r => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${server.address().port}/__page-edits`;
    const first = appendNote(inbox, { root, page: "/", selected: "Hello", comment: "Shorter" });
    const request = (identity, headers = { "X-Page-Edits": "1" }, id = 1) => fetch(`${base}/notes/${id}/clear`, { method: "POST", headers, body: JSON.stringify({ identity }) });
    assert.equal((await request(first.uid, {})).status, 403);
    assert.equal((await request(first.uid, { "X-Page-Edits": "1", Origin: "https://example.invalid" })).status, 403);
    assert.equal((await request("stale-identity")).status, 409);
    assert.equal(readNotes(inbox)[0].state, "queued");
    assert.equal((await request(first.uid)).status, 200);
    assert.equal(readNotes(inbox)[0].state, "cancelled");
    assert.throws(() => appendState(inbox, 1, "applying"), /cleared/);
    const options = parseCodexWatch(["--thread", "11111111-2222-3333-4444-555555555555", "--inbox", inbox], { cwd: root, env: {} });
    let sent = 0;
    await createCodexPoll(options, { queue: async () => sent++, out() {}, err() {} })();
    assert.equal(sent, 0);
    const second = appendNote(inbox, { root, page: "/", selected: "Next", comment: "Shorter" });
    appendState(inbox, 2, "applying");
    assert.equal((await request(second.uid, undefined, 2)).status, 409);
    assert.equal(readNotes(inbox)[1].state, "applying");
  } finally { server.closeAllConnections(); await new Promise(r => server.close(r)); rmSync(root, { recursive: true, force: true }); }
});


test("state CLI binds claims and results to the handed-off identity, including legacy ids", async () => {
  const root = mkdtempSync(join(tmpdir(), "page-edits-state-identity-"));
  const inbox = join(root, "notes.jsonl");
  const cli = new URL("../cli.mjs", import.meta.url).pathname;
  const run = (name, identity) => {
    const pending = exec(process.execPath, [cli, "state", "1", name, "--inbox", inbox, ...(identity ? ["--identity", identity] : [])]);
    pending.child.stdin.end();
    return pending;
  };
  try {
    const original = appendNote(inbox, { root, page: "/", selected: "Original", comment: "Shorter" });
    await assert.rejects(run("applying"), e => /requires --identity/.test(e.stderr));
    writeFileSync(inbox, "");
    const replacement = appendNote(inbox, { root, page: "/", selected: "Replacement", comment: "Longer" });
    for (const state of ["applying", "done", "needs-you", "not-in-code"]) {
      await assert.rejects(run(state, original.uid), e => /changed/.test(e.stderr));
      assert.equal(readNotes(inbox)[0].state, "queued");
    }
    await run("applying", replacement.uid);
    await assert.rejects(run("applying", replacement.uid), e => /cannot be claimed again/.test(e.stderr));
    writeFileSync(inbox, JSON.stringify({ ...noteEvent, uid: undefined, at: "legacy-new" }) + "\n");
    await assert.rejects(run("applying", "1:legacy-old"), e => /changed/.test(e.stderr));
    await run("applying", "1:legacy-new");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("only one concurrent applying claim wins and every finished state stays terminal", async () => {
  const root = mkdtempSync(join(tmpdir(), "page-edits-claim-race-"));
  const inbox = join(root, "notes.jsonl");
  const store = new URL("../store.mjs", import.meta.url).href;
  try {
    appendNote(inbox, { root, page: "/", selected: "Hello", comment: "Shorter" });
    const launch = () => exec(process.execPath, ["--input-type=module", "-e", `import {appendState} from ${JSON.stringify(store)}; appendState(${JSON.stringify(inbox)},1,"applying");`]);
    const outcomes = await Promise.allSettled([launch(), launch()]);
    assert.equal(outcomes.filter(r => r.status === "fulfilled").length, 1);
    assert.equal(foldNotes([noteEvent, state("applying", "first"), state("applying", "second")])[0].stateEventId, "first");
    for (const terminal of FINAL_STATES) {
      const events = [noteEvent, state(terminal, "finished"), state("applying", "stale"), state("queued", "reopen")];
      assert.equal(foldNotes(events)[0].state, terminal);
      writeFileSync(inbox, events.slice(0, 2).map(e => JSON.stringify(e)).join("\n") + "\n");
      assert.throws(() => appendState(inbox, 1, "applying"));
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("legacy resumed completions remain readable without reopening modern terminal work", () => {
  const legacy = name => ({ type: "state", id: 1, state: name, at: "then" });
  const result = { file: "src/page.html", before: "Old words", after: "Finished words" };
  for (const terminal of ["needs-you", "not-in-code"]) {
    for (const format of [undefined, 1]) {
      const history = [{ ...noteEvent, format }, legacy(terminal), legacy("applying"), { ...legacy("done"), result }];
      const completed = foldNotes(history)[0];
      assert.equal(completed.state, "done");
      assert.deepEqual(completed.result, result); // The find ledger must retain this rewrite.
    }
    // New events on old notes enforce the new contract; old events on new notes do too.
    assert.equal(foldNotes([noteEvent, state(terminal, "modern"), legacy("applying"), legacy("done")])[0].state, terminal);
    assert.equal(foldNotes([{ ...noteEvent, format: 2 }, legacy(terminal), legacy("applying"), legacy("done")])[0].state, terminal);
    assert.equal(foldNotes([noteEvent, legacy(terminal), state("applying", "modern")])[0].state, terminal);
    assert.equal(foldNotes([noteEvent, state("applying", "modern"), legacy(terminal), legacy("applying"), legacy("done")])[0].state, terminal);
  }
  for (const terminal of ["done", "cancelled"]) {
    assert.equal(foldNotes([noteEvent, legacy(terminal), legacy("applying")])[0].state, terminal);
  }
});
