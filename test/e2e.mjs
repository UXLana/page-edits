#!/usr/bin/env node
// page-edits in a real browser: three notes sent back to back while the inbox is deliberately
// slow, so the test proves the box never waits on it. Also: the note list follows the receiver's
// states, a half-typed note survives a reload, and the keyboard shortcut opens the box.
//
// Playwright is not a dependency of page-edits. Point PAGE_EDITS_PLAYWRIGHT_FROM at any folder whose
// node_modules has it (a site that runs Playwright tests does); without it this WARNs and exits 0.
//
//   PAGE_EDITS_PLAYWRIGHT_FROM=<folder> node test/e2e.mjs [screenshot.png]

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendNote, appendState, readNotes } from "../store.mjs";
import { createHandler } from "../vite-plugin.mjs";

let chromium;
try {
  const from = process.env.PAGE_EDITS_PLAYWRIGHT_FROM;
  ({ chromium } = from ? createRequire(join(from, "package.json"))("playwright") : await import("playwright"));
} catch {
  console.log("WARN page-edits e2e skipped: Playwright not found (set PAGE_EDITS_PLAYWRIGHT_FROM)");
  process.exit(0);
}

const PARAGRAPHS = [
  "Talking to people, watching how they work, listening to what they need.",
  "AI turns the synthesis into a structured brief with acceptance criteria.",
  "Designing in code means working with the real material of the product.",
  "Once a feature is live, real usage shows what testing could not.",
];
const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>page-edits test page</title></head>
<body><main id="root">${PARAGRAPHS.map((text, i) => `<p id="p${i + 1}">${text}</p>`).join("")}</main>
<script type="module" src="/__page-edits/client.js"></script></body></html>`;

const inbox = join(mkdtempSync(join(tmpdir(), "page-edits-e2e-")), "e2e.jsonl");
const handler = createHandler({ root: tmpdir(), storeFile: inbox });
let refuseNextPosts = 0; // a dev server that is down for a moment
let hangNextPost = false; // a send that never gets an answer
let rejectNextPost = false; // a note the dev server will never take
let hangNextStatus = false; // a status read that never gets an answer
const server = createServer(async (req, res) => {
  if (req.method === "POST" && hangNextPost) {
    hangNextPost = false;
    return; // no answer, ever
  }
  if (req.method === "GET" && req.url?.startsWith("/__page-edits/notes") && hangNextStatus) {
    hangNextStatus = false;
    return; // no answer, ever
  }
  if (req.method === "POST" && rejectNextPost) {
    rejectNextPost = false;
    res.statusCode = 400;
    return res.end("{}");
  }
  if (req.method === "POST" && refuseNextPosts > 0) {
    refuseNextPosts -= 1;
    await new Promise((r) => setTimeout(r, 800)); // fail slowly, so the next note is written meanwhile
    res.statusCode = 503;
    return res.end();
  }
  if (req.method === "POST") await new Promise((r) => setTimeout(r, 1500)); // a slow inbox
  if (req.url === "/" || req.url?.startsWith("/?")) {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.end(PAGE);
  }
  return handler(req, res, () => ((res.statusCode = 404), res.end()));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}/`;

const browser = await chromium.launch();
let passes = 0;
const pass = (label) => {
  passes += 1;
  console.log(`  PASS  ${label}`);
};
try {
  const context = await browser.newContext({ viewport: { width: 1100, height: 760 } });
  const page = await context.newPage();
  await page.goto(url);
  const select = (id, from = 0, to) =>
    page.evaluate(
      ([id, from, to]) => {
        const text = document.getElementById(id).firstChild;
        const range = document.createRange();
        range.setStart(text, from);
        range.setEnd(text, to ?? text.length);
        const selection = document.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
      },
      [id, from, to],
    );
  const trigger = page.getByRole("button", { name: /Comment on the selected text/ });
  const box = page.getByRole("textbox", { name: "What should change?" });

  const started = Date.now();
  for (const [i, comment] of ["warmer", "shorter", "say who does it"].entries()) {
    await select(`p${i + 1}`);
    await trigger.click({ timeout: 2000 });
    await box.fill(comment);
    await box.press("Enter");
    await assert.doesNotReject(box.waitFor({ state: "hidden", timeout: 500 }));
  }
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 3000, `three notes took ${elapsed} ms against a 1500 ms inbox`);
  pass(`three notes written back to back in ${elapsed} ms while each send takes 1500 ms`);

  await page.waitForFunction(() => true);
  for (let i = 0; i < 100 && readNotes(inbox).length < 3; i += 1) await new Promise((r) => setTimeout(r, 100));
  const stored = readNotes(inbox);
  assert.deepEqual(
    stored.map((n) => [n.id, n.selected, n.comment]),
    [
      [1, PARAGRAPHS[0], "warmer"],
      [2, PARAGRAPHS[1], "shorter"],
      [3, PARAGRAPHS[2], "say who does it"],
    ],
  );
  assert.equal(stored[1].page, "/");
  pass("the inbox holds the three notes in the order they were written");

  await select("p4", 24, 40);
  await trigger.click();
  await box.fill("make it plainer");
  await box.press("Enter");
  for (let i = 0; i < 100 && readNotes(inbox).length < 4; i += 1) await new Promise((r) => setTimeout(r, 100));
  const partial = readNotes(inbox)[3];
  assert.equal(partial.selected, "real usage shows");
  assert.equal(partial.before, "Once a feature is live,");
  assert.equal(partial.after, "what testing could not.");
  pass("a partial highlight carries the paragraph text before and after it");

  appendState(inbox, 1, "applying");
  appendState(inbox, 1, "done", { file: "src/p.tsx", before: PARAGRAPHS[0], after: "We still talk to people first." });
  appendState(inbox, 3, "not-in-code", { message: "Comes from the database." });
  const list = page.getByRole("list");
  await list.getByText("We still talk to people first.", { exact: false }).waitFor({ timeout: 5000 });
  const items = list.getByRole("listitem");
  await assert.doesNotReject(items.nth(0).getByText("Done").waitFor({ timeout: 3000 }));
  await assert.doesNotReject(items.nth(1).getByText("Queued").waitFor({ timeout: 3000 }));
  await assert.doesNotReject(items.nth(2).getByText("Not in code").waitFor({ timeout: 3000 }));
  await page.getByRole("status").filter({ hasText: "Note 1 done, note 3 not in code." }).waitFor({ state: "attached", timeout: 3000 });
  pass("the list follows the receiver, and one announcement names every note that finished");

  await select("p2");
  await trigger.click();
  await box.fill("half typed");
  await page.reload();
  await box.waitFor({ timeout: 3000 });
  assert.equal(await box.inputValue(), "half typed");
  await box.press("Escape");
  await box.waitFor({ state: "hidden" });
  pass("a half-typed note survives a full reload, and Esc closes the box");

  await select("p3");
  await page.keyboard.press("Alt+Shift+KeyC");
  await box.waitFor({ timeout: 2000 });
  await box.press("Escape");
  pass("Alt+Shift+C opens the box on the selection");

  refuseNextPosts = 2;
  for (const [id, comment] of [["p1", "while the server is down"], ["p2", "and one more"]]) {
    await select(id);
    await trigger.click();
    await box.fill(comment);
    await box.press("Enter");
  }
  await page.getByText("Not sent yet, retrying").first().waitFor({ timeout: 3000 });
  for (let i = 0; i < 150 && readNotes(inbox).length < 6; i += 1) await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(
    readNotes(inbox).slice(4).map((n) => n.comment),
    ["while the server is down", "and one more"],
  );
  pass("notes written while the dev server is down are kept, retried and stored in order");

  const write = async (target, id, comment) => {
    await target.evaluate((id) => {
      const text = document.getElementById(id).firstChild;
      const range = document.createRange();
      range.selectNodeContents(text);
      document.getSelection().removeAllRanges();
      document.getSelection().addRange(range);
    }, id);
    await target.getByRole("button", { name: /Comment on the selected text/ }).click();
    const input = target.getByRole("textbox", { name: "What should change?" });
    await input.fill(comment);
    await input.press("Enter");
  };
  const waitFor = async (count) => {
    for (let i = 0; i < 250 && readNotes(inbox).length < count; i += 1) await new Promise((r) => setTimeout(r, 100));
    return readNotes(inbox);
  };

  hangNextPost = true;
  await write(page, "p1", "the send for this one hangs");
  await write(page, "p2", "this one must still arrive");
  const afterHang = await waitFor(8);
  assert.deepEqual(afterHang.slice(6).map((n) => n.comment), ["the send for this one hangs", "this one must still arrive"]);
  pass("a send that hangs is abandoned and retried; the notes behind it still arrive, in order");

  const other = await page.context().newPage();
  await other.goto(url);
  await Promise.all([write(page, "p3", "from the first tab"), write(other, "p4", "from the second tab")]);
  const afterTabs = await waitFor(10);
  assert.deepEqual(afterTabs.slice(8).map((n) => n.comment).sort(), ["from the first tab", "from the second tab"]);
  await other.close();
  pass("two tabs writing at once both get their notes through");

  rejectNextPost = true;
  await write(page, "p1", "the dev server refuses this one");
  await page.getByText("The dev server refused this note.").waitFor({ timeout: 5000 });
  await page.reload();
  const dismiss = page.getByRole("button", { name: /Dismiss refused note/ });
  await dismiss.waitFor({ timeout: 5000 });
  await dismiss.click();
  await dismiss.waitFor({ state: "detached", timeout: 3000 });
  pass("a refused note stays visible across a reload until it is dismissed");

  const blocked = await browser.newContext();
  await blocked.addInitScript(() => {
    for (const name of ["localStorage", "sessionStorage"]) {
      Object.defineProperty(window, name, { get() { throw new Error("storage blocked"); } });
    }
  });
  const noStorage = await blocked.newPage();
  await noStorage.goto(url);
  await write(noStorage, "p2", "sent with storage blocked");
  const afterBlocked = await waitFor(11);
  assert.equal(afterBlocked.at(-1).comment, "sent with storage blocked");
  await blocked.close();
  pass("a browser that blocks storage still sends the note");

  const full = await browser.newContext();
  await full.addInitScript(() => {
    Storage.prototype.setItem = () => {
      throw new Error("quota exceeded");
    };
  });
  const fullPage = await full.newPage();
  await fullPage.goto(url);
  refuseNextPosts = 1;
  await write(fullPage, "p3", "sent with storage full and the server down once");
  await fullPage.getByText("This browser is not saving unsent notes").waitFor({ timeout: 3000 });
  const afterFull = await waitFor(12);
  assert.equal(afterFull.at(-1).comment, "sent with storage full and the server down once");
  await full.close();
  pass("with storage full and one failed send, the note is kept in memory and sent");

  hangNextStatus = true;
  await write(page, "p1", "sent while a status read hangs");
  await write(page, "p2", "and the one after it");
  const afterStatus = await waitFor(14);
  assert.deepEqual(afterStatus.slice(12).map((n) => n.comment), ["sent while a status read hangs", "and the one after it"]);
  pass("a status read that hangs does not hold up the notes behind it");

  const reused = await browser.newContext();
  await reused.addInitScript(() => {
    localStorage.setItem(
      "page-edits:another-site:outbox",
      JSON.stringify([{ clientId: "left-behind", page: "/", selected: "x", before: "", after: "", comment: "from another site" }]),
    );
  });
  const reusedPage = await reused.newPage();
  await reusedPage.goto(url);
  await write(reusedPage, "p4", "this site's own note");
  const afterReuse = await waitFor(15);
  assert.equal(afterReuse.at(-1).comment, "this site's own note");
  assert.ok(!afterReuse.some((n) => n.comment === "from another site"));
  await reused.close();
  pass("another site's leftover outbox on the same port is never sent here");

  await select("p2");
  await trigger.click();
  await page.getByRole("button", { name: "Cancel" }).focus();
  await page.keyboard.press("Escape");
  await box.waitFor({ state: "hidden", timeout: 2000 });
  pass("Esc closes the box from its buttons too");

  for (let i = 0; i < 45; i += 1) appendNote(inbox, { root: tmpdir(), page: "/", selected: `bulk ${i}`, comment: "pending" });
  const total = readNotes(inbox).length;
  const open = readNotes(inbox).filter((n) => !["done", "not-in-code", "needs-you"].includes(n.state)).length;
  const counter = page.getByRole("button", { name: `Notes · ${open} in progress · ${total} total` });
  await counter.waitFor({ timeout: 15000 }).catch(async (error) => {
    console.log("  list header reads:", await page.getByRole("button", { name: /^Notes ·/ }).textContent());
    throw error;
  });
  assert.equal(await page.getByRole("listitem").filter({ hasText: "bulk" }).count(), 45);
  pass(`the list counts all ${total} notes and shows every unfinished one`);

  const shot = process.argv[2];
  if (shot) {
    await select("p2");
    await trigger.click();
    await box.fill("Tighter: lead with the brief.");
    await page.screenshot({ path: shot });
  }
} finally {
  await browser.close();
  server.close();
}
console.log(`page-edits e2e: ${passes} passed`);
