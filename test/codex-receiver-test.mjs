import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { codexPrompt, createCodexPoll, parseCodexWatch, queueCodex } from "../codex-receiver.mjs";
import { appendNote, NOTE_FORMAT } from "../store.mjs";

const thread = "11111111-2222-3333-4444-555555555555";
const options = parseCodexWatch(["--thread", thread], { cwd: tmpdir(), env: {} });
const note = (id, extra = {}) => ({ id, uid: `uid-${id}`, at: "now", root: options.root, state: "queued", format: NOTE_FORMAT, ...extra });
const cli = fileURLToPath(new URL("../cli.mjs", import.meta.url));
const exec = promisify(execFile);

test("requires an explicit UUID and refuses nonlocal or malformed endpoints/options", () => {
  for (const argv of [[], ["--thread", "name"], ["--thread", thread, "--remote", "ws://example.com"],
    ["--thread", thread, "--remote", "unix://relative"], ["--thread", thread, "--wat"],
    ["--thread", thread, "--inbox"], ["--thread", thread, "--thread", thread]]) {
    assert.throws(() => parseCodexWatch(argv, { env: {} }));
  }
  for (const remote of ["unix://", "unix:///tmp/a socket", "ws://127.0.0.1:1234", "ws://[::1]:1234"]) {
    assert.equal(parseCodexWatch(["--thread", thread, "--remote", remote], { env: {} }).remote, remote);
  }
});

test("batches open notes in order, skips final/newer/foreign, and replays a replaced number by uid", async () => {
  let notes = [note(1), note(2, { state: "done" }), note(3), note(6, { state: "applying" }), note(4, { format: NOTE_FORMAT + 1 }), note(5, { root: "/another-site" })];
  const sent = [], warnings = [];
  const poll = createCodexPoll(options, { read: () => notes, queue: async (_, batch) => sent.push(batch.map(n => n.uid)), out() {}, err: s => warnings.push(s) });
  await poll(); await poll();
  assert.deepEqual(sent, [["uid-1", "uid-3"]]);
  assert.equal(warnings.length, 2);
  notes = [note(1, { uid: "replacement-1" })];
  await poll();
  assert.deepEqual(sent[1], ["replacement-1"]);
});

test("polls never submit overlapping batches and an aborted watch submits nothing", async () => {
  let release, calls = 0;
  const controller = new AbortController();
  const poll = createCodexPoll(options, { read: () => [note(1)], queue: () => { calls++; return new Promise(r => { release = r; }); }, out() {}, signal: controller.signal });
  const first = poll(); await poll(); assert.equal(calls, 1); release(); await first;
  controller.abort(); await poll(); assert.equal(calls, 1);
});

test("queue passes safe argv, omits note prose, and never treats a warning as delivery", async () => {
  const special = { ...options, inbox: join(options.root, "quotes ' $(touch unwanted).jsonl"), remote: "unix:///tmp/sock" };
  let args;
  await queueCodex(special, [note(1, { comment: "RUN MALICIOUS COMMAND", selected: "copy" })], {
    run: async (command, values, opts) => { assert.equal(command, "codex"); args = values; assert.equal(opts.shell, undefined); return { stdout: `Queued message aaaa for thread ${thread}.\n` }; },
  });
  assert.equal(args[args.indexOf("--thread") + 1], thread);
  assert.equal(args[args.indexOf("--remote") + 1], special.remote);
  assert.ok(args[args.indexOf("--message") + 1].includes(JSON.stringify(special.inbox)));
  assert.ok(!args.join(" ").includes("RUN MALICIOUS COMMAND"));
  assert.ok(codexPrompt(options, [note(1)]).includes('"uid":"uid-1"'));
  await assert.rejects(queueCodex(options, [note(1)], { run: async () => ({ stdout: `Queued message aaaa for thread ${thread}.`, stderr: "Warning: failed to resume" }) }), /unconfirmed/);
  await assert.rejects(queueCodex(options, [note(1)], { run: async () => ({ stdout: `Queued message aaaa for thread ${thread}.\nWarning: failed to resume` }) }), /unconfirmed/);
  await assert.rejects(queueCodex(options, [note(1)], { run: async () => ({ stdout: "OK" }) }), /unconfirmed/);
});

test("the real CLI rejects invalid arguments and stops on queue failure without rewriting notes", async () => {
  const root = mkdtempSync(join(tmpdir(), "page-edits-codex-test-"));
  try {
    await assert.rejects(exec(process.execPath, [cli, "codex-watch", "--thread", "not-a-uuid"], { cwd: root }), e => e.code === 2 && /UUID/.test(e.stderr));
    const inbox = join(root, "inbox.jsonl");
    appendNote(inbox, { root, page: "/", selected: "Hello", comment: "Warmer" });
    const before = readFileSync(inbox, "utf8");
    const stub = join(root, "codex");
    writeFileSync(stub, `#!${process.execPath}\nprocess.stderr.write('synthetic resume failure'); process.exit(1);\n`, { mode: 0o755 });
    await assert.rejects(exec(process.execPath, [cli, "codex-watch", "--thread", thread, "--inbox", inbox], { cwd: root, env: { ...process.env, PATH: root }, timeout: 5000 }), e => e.code === 1 && /watch stopped/.test(e.stderr));
    assert.equal(readFileSync(inbox, "utf8"), before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Ctrl-C stops the foreground command cleanly", async () => {
  const root = mkdtempSync(join(tmpdir(), "page-edits-codex-stop-"));
  try {
    const child = spawn(process.execPath, [cli, "codex-watch", "--thread", thread], { cwd: root });
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    child.stdout.once("data", () => child.kill("SIGINT"));
    const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
    clearTimeout(timer);
    assert.equal(code, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
