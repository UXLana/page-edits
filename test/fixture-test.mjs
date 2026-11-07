#!/usr/bin/env node
// page-edits: the finder, the inbox and the receiver's commands, against a synthetic site.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { locate } from "../finder.mjs";
import { appendNote, appendState, defaultInbox, readNotes } from "../store.mjs";
import pageEdits, { createHandler, resolveInbox, siteKey } from "../vite-plugin.mjs";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "../cli.mjs");
let passes = 0;
const pass = (label) => {
  passes += 1;
  console.log(`  PASS  ${label}`);
};

const site = mkdtempSync(join(tmpdir(), "page-edits-site-"));
const write = (path, text) => {
  mkdirSync(dirname(join(site, path)), { recursive: true });
  writeFileSync(join(site, path), text);
};
write(
  "src/pages/Process.tsx",
  `const phases = [
  { phase: "Brief", body: "AI turns the synthesis into a structured brief." },
  { phase: "Validate", body: "I review every finding and decide what gets fixed now." },
];
export const Process = () => (
  <main>
    <p>
      Designing in code means working
      with the real material of the product.
    </p>
    <p>Small teams ship what&rsquo;s worth shipping.</p>
    <p>Hello <strong>bold</strong> world, said the page.</p>
    <p>Intro words here. Patterns earn their place by appearing twice.</p>
    {phases.map((phase) => <p key={phase.phase}>{phase.body}</p>)}
  </main>
);
`,
);
write("src/pages/Other.tsx", `export const Other = () => <p>Elsewhere entirely. Patterns earn their place by appearing twice.</p>;\n`);
write("src/a/Twin.tsx", `export const A = () => <p>Same words in a twin.</p>;\n`);
write("src/b/Twin.tsx", `export const B = () => <p>Same words in a twin.</p>;\n`);
write("src/pages/Process.test.tsx", `expect(screen.getByText("Only a test says this sentence.")).toBeVisible();\n`);
write("docs/draft.md", `Designing in code means working with the real material of the product.\n`);

const note = (selected, extra = {}) => ({ root: site, selected, before: "", after: "", ...extra });

{
  const found = locate(note("means working with the real material"));
  assert.equal(found.status, "found");
  assert.equal(found.match.file, "src/pages/Process.tsx");
  assert.equal(found.match.line, 8);
  pass("JSX text wrapped across source lines is found, and docs beside src/ are not searched");
}
{
  const found = locate(note("AI turns the synthesis into a structured brief."));
  assert.equal(found.status, "found");
  assert.equal(found.match.line, 2);
  pass("a string in a data array is found where it is written, not where it is drawn");
}
{
  const found = locate(note("Small teams ship what’s worth shipping."));
  assert.equal(found.status, "found");
  assert.match(found.match.text, /&rsquo;/);
  pass("a curly apostrophe on the page matches an HTML entity in the source");
}
{
  const found = locate(note("Hello bold world"));
  assert.equal(found.status, "found");
  assert.equal(found.match.text, "Hello <strong>bold</strong> world");
  pass("a passage across an inline tag is found");
}
{
  const ambiguous = locate(note("Patterns earn their place by appearing twice."));
  assert.equal(ambiguous.status, "ambiguous");
  const found = locate(note("Patterns earn their place by appearing twice.", { before: "Intro words here." }));
  assert.equal(found.status, "found");
  assert.equal(found.match.file, "src/pages/Process.tsx");
  pass("two matches: the paragraph around the highlight decides, and without it the finder says so");
}
{
  const found = locate(note("Same words in a twin."));
  assert.equal(found.status, "ambiguous");
  assert.equal(found.matches.length, 2);
  pass("identical copy in two places stays ambiguous rather than guessing");
}
{
  write(
    "src/pages/Summary.tsx",
    `// The TL;DR is adapted, not verbatim.
const TLDR = "Short version."; // the TL;DR text itself
export const Summary = () => (
  <div>
    {/* The subtitle and the TL;DR belong
        to the written case. */}
    <p className="label">TL;DR</p>
  </div>
);
`,
  );
  const found = locate(note("TL;DR"));
  assert.equal(found.status, "found");
  assert.equal(found.match.line, 7);
  pass("words quoted in code comments are not copy; only the rendered label matches");
}
{
  write("src/pages/Process.tsx", `export const Edited = () => <p>I keep the human checks.</p>;\n`);
  const ledger = [{ id: 1, result: { before: "The human checks stay with me.", after: "I keep the human checks." } }];
  const found = locate(note("human checks stay with me"), ledger);
  assert.equal(found.status, "found");
  assert.equal(found.followedNote, 1);
  assert.equal(found.match.text, "I keep the human checks.");
  pass("words an earlier note rewrote are followed to their new wording");
}
{
  assert.equal(locate(note("Fetched from the database at runtime.")).status, "not-in-code");
  assert.equal(locate(note("Only a test says this sentence.")).status, "not-in-code");
  pass("copy that is not in the source, or only in a test, is not in code");
}

{
  write("src/x/A.tsx", `export const A = () => <p>New copy.</p>;\n`);
  write("src/x/B.tsx", `export const B = () => <p>Old copy.</p>;\n`);
  const ledger = [{ id: 1, page: "/a", result: { file: "src/x/A.tsx", before: "Old copy.", after: "New copy." } }];
  const unsure = locate(note("Old copy.", { page: "/a" }), ledger);
  assert.equal(unsure.status, "ambiguous");
  assert.deepEqual(unsure.matches.map((m) => m.file), ["src/x/A.tsx", "src/x/B.tsx"]);
  assert.equal(unsure.followedNote, 1);
  const elsewhere = locate(note("Old copy.", { page: "/b" }), ledger);
  assert.equal(elsewhere.match.file, "src/x/B.tsx");
  write("src/x/G.tsx", `export const G = () => <footer><p>Contact us here. Old copy.</p></footer>;\n`);
  const footer = locate(note("Old copy.", { page: "/a", before: "Contact us here." }), ledger);
  assert.equal(footer.status, "found");
  assert.equal(footer.match.file, "src/x/G.tsx");
  pass("an earlier rewrite and untouched identical copy: context decides, and without it the finder says it cannot tell");
}
{
  write("src/x/H.tsx", `export const H = () => <p>Stale words.</p>;\n`);
  write("src/x/I.tsx", `export const I = () => <p>Fresh words.</p>;\n`);
  const ledger = [
    { id: 1, page: "/a", doneAt: "2026-11-04T10:00:00.000Z", result: { file: "src/x/I.tsx", before: "Stale words.", after: "Fresh words." } },
  ];
  const before = locate(note("Stale words.", { page: "/a", at: "2026-11-04T09:00:00.000Z" }), ledger);
  assert.equal(before.status, "ambiguous");
  const after = locate(note("Stale words.", { page: "/a", at: "2026-11-04T11:00:00.000Z" }), ledger);
  assert.equal(after.status, "found");
  assert.equal(after.match.file, "src/x/H.tsx");
  pass("a rewrite that landed before the note was written is not followed");
}
{
  const from = process.env.PAGE_EDITS_TYPESCRIPT_FROM;
  if (!from) {
    console.log("  WARN  parsed-copy cases skipped: set PAGE_EDITS_TYPESCRIPT_FROM to a folder whose node_modules has typescript");
  } else {
    const parsed = mkdtempSync(join(tmpdir(), "page-edits-ts-"));
    mkdirSync(join(parsed, "node_modules"), { recursive: true });
    symlinkSync(join(from, "node_modules", "typescript"), join(parsed, "node_modules", "typescript"));
    writeFileSync(join(parsed, "package.json"), "{}");
    mkdirSync(join(parsed, "src"));
    writeFileSync(
      join(parsed, "src", "P.tsx"),
      `const Title = getHeading();\nconst x = 1; /* Quoted copy. */\nconst alt = "Quoted copy.";\nexport const P = () => <p>Hi <b>there</b>, Title case. Partial highlight.</p>;\n`,
    );
    const at = (selected) => locate({ root: parsed, selected, before: "", after: "" });
    assert.equal(at("Quoted copy.").match.line, 3);
    assert.equal(at("Title").match.line, 4);
    assert.equal(at("Hi there,").status, "found");
    assert.equal(at("rtial highl").status, "found");
    rmSync(parsed, { recursive: true, force: true });
    pass("with the site's TypeScript, only text counts: not a comment after code, not a name, partial highlights still found");
  }
}
{
  // A site on TypeScript 7, whose main entry offers no parser: the rules find the copy, nothing throws.
  const seven = mkdtempSync(join(tmpdir(), "page-edits-ts7-"));
  mkdirSync(join(seven, "node_modules", "typescript"), { recursive: true });
  writeFileSync(join(seven, "node_modules", "typescript", "package.json"), JSON.stringify({ name: "typescript", version: "7.0.2", main: "index.js" }));
  writeFileSync(join(seven, "node_modules", "typescript", "index.js"), `module.exports = { version: "7.0.2", versionMajorMinor: "7.0" };\n`);
  writeFileSync(join(seven, "package.json"), "{}");
  mkdirSync(join(seven, "src"));
  writeFileSync(join(seven, "src", "App.tsx"), `// Your questions, answered\nexport const App = () => <p>Your questions, answered</p>;\n`);
  const found = locate({ root: seven, selected: "Your questions, answered", before: "", after: "" });
  assert.equal(found.status, "found");
  assert.equal(found.match.line, 2);
  rmSync(seven, { recursive: true, force: true });
  pass("a site on TypeScript 7 (no parser API) falls back to the rules instead of crashing");
}
{
  write("src/x/C.tsx", `export const C = () => <p>Lead in. Final wording. Tail out.</p>;\n`);
  const ledger = [
    { id: 2, result: { file: "src/x/C.tsx", before: "Second wording.", after: "Final wording." } },
    { id: 1, result: { file: "src/x/C.tsx", before: "Original wording.", after: "Second wording." } },
  ];
  const chained = locate(note("Original wording."), ledger);
  assert.equal(chained.match.text, "Final wording.");
  assert.equal(chained.followedNote, 2);
  const wide = locate(note("Lead in. Original wording. Tail out."), ledger);
  assert.equal(wide.match.text, "Lead in. Final wording. Tail out.");
  pass("rewrites are followed in order, and a wider highlight keeps its width");
}
{
  write("src/x/D.tsx", `const pattern = "/docs/*";\nexport const D = () => <p>Hi <strong>planet</strong>! Read this copy.</p>;\n`);
  assert.equal(locate(note("Hi planet!")).status, "found");
  assert.equal(locate(note("Read this copy.")).status, "found");
  write("src/x/E.tsx", `const pageTitle = getHeading();\nexport const E = () => <h2>{pageTitle}</h2>;\nconst T = <Title />;\n`);
  assert.equal(locate(note("Title")).status, "not-in-code");
  pass("tags before punctuation match; a /* in a string is not a comment; words inside names are not copy");
}

const store = join(mkdtempSync(join(tmpdir(), "page-edits-store-")), "site.jsonl");
{
  const first = appendNote(store, { root: site, page: "/p", selected: "one", comment: "a", clientId: "c1" });
  const retry = appendNote(store, { root: site, page: "/p", selected: "one", comment: "a", clientId: "c1" });
  appendNote(store, { root: site, page: "/p", selected: "two", comment: "b", clientId: "c2" });
  assert.equal(first.id, 1);
  assert.equal(retry.id, 1);
  appendState(store, 1, "applying");
  appendState(store, 1, "done", { file: "src/x.tsx", before: "one", after: "uno" });
  const notes = readNotes(store);
  assert.deepEqual(notes.map((n) => [n.id, n.state]), [[1, "done"], [2, "queued"]]);
  assert.equal(notes[0].result.after, "uno");
  assert.throws(() => appendState(store, 2, "finished"), /unknown state/);
  assert.throws(() => appendState(store, 9, "done"), /no note 9/);
  pass("the inbox keeps arrival order, folds states, and ignores a retried send");
}

{
  // Two dev servers on one inbox: each appends without reading a counter first.
  const shared = join(mkdtempSync(join(tmpdir(), "page-edits-shared-")), "site.jsonl");
  const writer = (word) =>
    new Promise((resolveRun) => {
      const child = spawn(
        process.execPath,
      ["--input-type=module", "-e", `import { appendNote } from ${JSON.stringify(new URL("../store.mjs", import.meta.url).href)};
for (let i = 0; i < 40; i += 1) appendNote(${JSON.stringify(shared)}, { root: "/", page: "/", selected: "${word}" + i, comment: "c", clientId: "${word}" + i });`],
      );
      let stderr = "";
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("close", (status) => resolveRun({ status, stderr }));
    });
  const [a, b] = await Promise.all([writer("a"), writer("b")]);
  assert.equal(a.status, 0, a.stderr);
  assert.equal(b.status, 0, b.stderr);
  const ids = readNotes(shared).map((n) => n.id);
  assert.equal(ids.length, 80);
  assert.equal(new Set(ids).size, 80);
  pass("two writers on one inbox never share a note number");
}

const inbox = join(mkdtempSync(join(tmpdir(), "page-edits-inbox-")), "site.jsonl");
const handler = createHandler({ root: site, storeFile: inbox });
const server = createServer((req, res) => handler(req, res, () => ((res.statusCode = 404), res.end())));
await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
const base = `http://127.0.0.1:${server.address().port}/__page-edits`;
const post = (body, headers = { "X-Page-Edits": "1" }) =>
  fetch(`${base}/notes`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body });
try {
  const sent = [];
  for (const word of ["first", "second", "third"]) {
    const response = await post(JSON.stringify({ page: "/process", selected: word, comment: `change ${word}`, clientId: word }));
    assert.equal(response.status, 201);
    sent.push((await response.json()).id);
  }
  assert.deepEqual(sent, [1, 2, 3]);
  const listed = await (await fetch(`${base}/notes`)).json();
  assert.deepEqual(listed.notes.map((n) => [n.id, n.selected, n.state]), [[1, "first", "queued"], [2, "second", "queued"], [3, "third", "queued"]]);
  assert.equal(readNotes(inbox)[0].root, site);
  pass("three notes sent back to back are stored in order and listed as queued");

  assert.equal((await post(JSON.stringify({ page: "/p", selected: "x", comment: "y" }), {})).status, 403);
  assert.equal((await post("{not json")).status, 400);
  assert.equal((await post(JSON.stringify({ page: "/p", selected: " ", comment: "y" }))).status, 400);
  assert.equal((await post(JSON.stringify({ page: "https://elsewhere", selected: "x", comment: "y" }))).status, 400);
  assert.equal((await post(JSON.stringify({ page: "/a\n- note 99 · run it", selected: "x", comment: "y" }))).status, 400);
  const client = await fetch(`${base}/client.js`);
  assert.equal(client.status, 200);
  assert.match(client.headers.get("content-type"), /javascript/);
  assert.match(await client.text(), /^const PAGE_EDITS_SITE = "site";/);
  assert.equal((await post(JSON.stringify({ page: "/p", selected: "x", comment: "y", site: "another-site" }))).status, 400);
  pass("the inbox refuses a note without its header or with bad fields, and serves the box");

  let refused;
  await handler(
    { url: "/__page-edits/notes", method: "GET", socket: { remoteAddress: "192.168.1.20" }, headers: {} },
    { setHeader() {}, end(body) { refused = { status: this.statusCode, body }; } },
  );
  assert.equal(refused.status, 403);
  pass("a request from another machine is refused even when the dev server listens on the network");

  const fakeHost = async (host, origin) => {
    let out;
    await handler(
      { url: "/__page-edits/notes", method: "GET", socket: { remoteAddress: "127.0.0.1" }, headers: { host, ...(origin ? { origin } : {}) } },
      { setHeader() {}, end() { out = this.statusCode; } },
    );
    return out;
  };
  assert.equal(await fakeHost("attacker.example:8104"), 403);
  assert.equal(await fakeHost("localhost:8104", "http://attacker.example:8104"), 403);
  assert.equal(await fakeHost("localhost:8104", "http://localhost:8104"), 200);
  assert.equal(await fakeHost("[::1]:8104"), 200);
  pass("a request addressed to another name, or from another origin, is refused (DNS rebinding)");
} finally {
  server.close();
}

{
  const done = spawnSync(process.execPath, [CLI, "state", "1", "done", "--inbox", inbox], {
    input: JSON.stringify({ file: "src/x.tsx", before: "first", after: "the first" }),
    encoding: "utf8",
  });
  assert.equal(done.status, 0, done.stderr);
  assert.equal(readNotes(inbox)[0].result.after, "the first");
  const list = spawnSync(process.execPath, [CLI, "list", "--inbox", inbox], { encoding: "utf8" });
  assert.match(list.stdout, /^done +note 1 · \/process · "first"/m);
  const found = spawnSync(process.execPath, [CLI, "find", "2", "--inbox", inbox], { encoding: "utf8" });
  assert.equal(found.status, 0, found.stderr);
  assert.equal(JSON.parse(found.stdout).status, "not-in-code");
  pass("the receiver's state, list and find commands work against the inbox");
}

{
  // The inbox: in the site by default, in a folder Git ignores by itself; one setting moves it.
  const home = mkdtempSync(join(tmpdir(), "page-edits-home-"));
  assert.equal(resolveInbox({ root: home, env: {} }), join(home, ".page-edits", "notes.jsonl"));
  assert.equal(resolveInbox({ root: home, inbox: "notes/here.jsonl", env: {} }), join(home, "notes", "here.jsonl"));
  assert.equal(resolveInbox({ root: home, env: { PAGE_EDITS_INBOX: "/elsewhere/n.jsonl" } }), "/elsewhere/n.jsonl");
  assert.equal(resolveInbox({ root: home, site: "web", inbox: (name) => `/kept/${name}.jsonl`, env: {} }), "/kept/web.jsonl");
  const git = spawnSync("git", ["init", "-q", home]);
  assert.equal(git.status, 0);
  appendNote(defaultInbox(home), { root: home, page: "/", selected: "x", comment: "y" });
  assert.equal(readFileSync(join(home, ".page-edits", ".gitignore"), "utf8").trim().split("\n").at(-1), "*");
  const ignored = spawnSync("git", ["-C", home, "check-ignore", "-q", ".page-edits/notes.jsonl"]);
  assert.equal(ignored.status, 0, "Git must ignore the default inbox");
  const untracked = spawnSync("git", ["-C", home, "status", "--porcelain", "--untracked-files=all"], { encoding: "utf8" });
  assert.equal(untracked.stdout, "");
  pass("the default inbox is in the site, Git ignores it by itself, and a path, a function or the environment moves it");

  // The Vite plugin's own hooks, as Vite calls them.
  const logged = [];
  const plugin = pageEdits();
  assert.equal(plugin.apply, "serve");
  assert.deepEqual(plugin.config({ root: home }).server.watch.ignored, [`${join(home, ".page-edits")}/**`]);
  plugin.configResolved({ root: home, logger: { info: (line) => logged.push(line) } });
  assert.match(logged[0], new RegExp(`page-edits: notes go to ${join(home, ".page-edits", "notes.jsonl").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  const outside = pageEdits({ inbox: "/kept/elsewhere.jsonl" });
  assert.equal(outside.config({ root: home }), undefined);
  assert.throws(() => pageEdits({ site: "../up" }).configResolved({ root: home, logger: { info() {} } }), /bad site name/);
  assert.deepEqual(plugin.transformIndexHtml(), [
    { tag: "script", attrs: { type: "module", src: "/__page-edits/client.js" }, injectTo: "body" },
  ]);
  pass("the Vite plugin runs on the dev server only, says where notes go, and keeps its watcher off the inbox");

  // The watcher leaves a custom inbox's file alone, never the folder around it.
  assert.deepEqual(pageEdits({ inbox: "src/notes.jsonl" }).config({ root: home }).server.watch.ignored, [join(home, "src", "notes.jsonl")]);
  assert.notEqual(siteKey("web", "/one/web"), siteKey("web", "/two/web"));
  assert.match(siteKey("web", "/one/web"), /^web-[0-9a-f]{8}$/);
  pass("a custom inbox is unwatched by itself, and two sites with one folder name keep their outboxes apart");

  // The dev server never serves the inbox as a plain file, by any spelling, to any address.
  const served = createHandler({ root: home, storeFile: defaultInbox(home) });
  const status = async (url, remoteAddress = "127.0.0.1") => {
    let out;
    let passed = false;
    await served(
      { url, method: "GET", socket: { remoteAddress }, headers: { host: "localhost:5173" } },
      { setHeader() {}, end() { out = this.statusCode; } },
      () => (passed = true),
    );
    return passed ? "passed on" : out;
  };
  for (const url of ["/.page-edits/notes.jsonl", "/.PAGE-EDITS/notes.jsonl", "/%2Epage-edits/notes.jsonl", "/app/.page-edits/notes.jsonl",
    "/src/../.page-edits/notes.jsonl", "/.page-edits/.gitignore", `/@fs${join(home, ".page-edits", "notes.jsonl")}`]) {
    assert.equal(await status(url, "192.168.1.20"), 404, url);
    assert.equal(await status(url), 404, url);
  }
  assert.equal(await status("/src/main.tsx"), "passed on");
  pass("the inbox is never served as a file: encoded, under a base path, through /@fs/, from this machine or another");

  // The receiver's command finds the same inbox from the site's folder, or from the environment.
  const here = spawnSync(process.execPath, [CLI, "list"], { cwd: home, encoding: "utf8", env: { ...process.env, PAGE_EDITS_INBOX: "" } });
  assert.match(here.stdout, /^queued +note 1 · \/ · "x" → y$/m);
  const moved = join(home, "moved.jsonl");
  appendNote(moved, { root: home, page: "/m", selected: "moved", comment: "z" });
  const fromEnv = spawnSync(process.execPath, [CLI, "list"], { cwd: tmpdir(), encoding: "utf8", env: { ...process.env, PAGE_EDITS_INBOX: moved } });
  assert.match(fromEnv.stdout, /note 1 · \/m · "moved"/);
  const bad = spawnSync(process.execPath, [CLI, "nonsense"], { cwd: home, encoding: "utf8" });
  assert.equal(bad.status, 2);
  const noPath = spawnSync(process.execPath, [CLI, "list", "--inbox"], { cwd: home, encoding: "utf8" });
  assert.equal(noPath.status, 2);
  assert.match(noPath.stderr, /--inbox needs a path/);
  const notJson = spawnSync(process.execPath, [CLI, "state", "1", "done"], { cwd: home, input: "{oops", encoding: "utf8" });
  assert.equal(notJson.status, 1);
  assert.match(notJson.stderr, /^page-edits: the result on stdin is not JSON/);
  const unknown = spawnSync(process.execPath, [CLI, "state", "1", "finished"], { cwd: home, encoding: "utf8" });
  assert.equal(unknown.status, 1);
  assert.equal(unknown.stderr.trim(), 'page-edits: unknown state "finished"');
  spawnSync(process.execPath, [CLI, "state", "1", "done"], { cwd: home, input: '{"file":"a","before":"x","after":"z"}', encoding: "utf8" });
  const reopen = spawnSync(process.execPath, [CLI, "state", "1", "applying"], { cwd: home, encoding: "utf8" });
  assert.equal(reopen.status, 1);
  assert.equal(reopen.stderr.trim(), "page-edits: note 1 is already done");
  assert.equal(readNotes(defaultInbox(home))[0].result.after, "z");
  assert.equal(readNotes(defaultInbox(home))[0].format, 1);
  writeFileSync(join(home, "newer.jsonl"), `${JSON.stringify({ type: "note", format: 2, uid: "n", at: "2026-11-05T00:00:00.000Z", root: home, page: "/", selected: "a", comment: "b" })}\n`);
  for (const args of [["find", "1"], ["state", "1", "applying"]]) {
    const newer = spawnSync(process.execPath, [CLI, ...args, "--inbox", join(home, "newer.jsonl")], { cwd: home, encoding: "utf8" });
    assert.equal(newer.status, 1);
    assert.match(newer.stderr, /written in note format 2; this page-edits reads up to 1\. Update the package\./);
  }
  rmSync(home, { recursive: true, force: true });
  pass("the receiver's command reads the site's inbox from its folder or PAGE_EDITS_INBOX, refuses bad input without a stack trace, never reopens a done note, and leaves a newer note format alone");
}

rmSync(site, { recursive: true, force: true });
console.log(`page-edits: ${passes} passed`);
