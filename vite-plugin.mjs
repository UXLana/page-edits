// page-edits for a Vite site: injects the comment box into every page the dev server serves and
// keeps the notes it sends in the site's inbox. Development only — `apply: "serve"` keeps it out of
// every build.
//
// The notes are instructions a session will act on, so only this machine may send them: requests
// from another address are refused even when the dev server listens on the network; the request
// must be addressed to a local name and, from a browser, come from that same origin, so a site
// that points its own name at this machine (DNS rebinding) is refused; and a custom header blocks
// a page from another origin posting through the browser.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { appendNote, defaultInbox, INBOX_FOLDER, readNotes } from "./store.mjs";

const BASE = "/__page-edits";
const CLIENT = join(dirname(fileURLToPath(import.meta.url)), "client.js");
const MAX_BODY_BYTES = 32 * 1024;
const LIMITS = { page: 2_000, selected: 4_000, before: 400, after: 400, comment: 4_000, clientId: 100, site: 200 };

const isLoopback = (address = "") =>
  address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";

function isLocalHostHeader(host = "") {
  const name = host.replace(/:\d+$/, "").replace(/^\[(.*)\]$/, "$1").toLowerCase();
  return name === "localhost" || name === "127.0.0.1" || name === "::1" || name.endsWith(".localhost");
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // not a cross-site browser request
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function send(res, status, body, type = "application/json") {
  res.statusCode = status;
  res.setHeader("Content-Type", `${type}; charset=utf-8`);
  res.setHeader("Cache-Control", "no-store");
  res.end(type === "application/json" ? JSON.stringify(body) : body);
}

function readBody(req) {
  return new Promise((resolveBody, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("too large"));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function validNote(body) {
  if (!body || typeof body !== "object") return null;
  const note = {};
  for (const [key, max] of Object.entries(LIMITS)) {
    const value = body[key] ?? "";
    if (typeof value !== "string" || value.length > max) return null;
    note[key] = value;
  }
  if (!note.selected.trim() || !note.comment.trim() || !note.page.startsWith("/")) return null;
  if (/[\u0000-\u001f\u007f]/.test(note.page + note.site + note.clientId)) return null;
  return note;
}

// A site name keys the page's outbox and names the site in the dev server's log.
const SITE_NAME = /^[a-z0-9][a-z0-9._-]*$/i;

// A connect-style handler, so the same code serves Vite's dev server and the tests. `site` keys
// the page's outbox; a note from another site's outbox (another dev server once on this port) is
// refused rather than filed here.
export function createHandler({ root, storeFile, site = basename(storeFile, ".jsonl") }) {
  const hidden = inboxPaths(root, storeFile);
  return async function pageEdits(req, res, next) {
    const url = (req.url ?? "").split("?")[0];
    // An inbox inside the site would otherwise be served as a plain file, to any address.
    if (hidden.some((path) => servedPath(url).includes(path))) return send(res, 404, { error: "not found" });
    if (!url.startsWith(BASE)) return next?.();
    if (!isLoopback(req.socket?.remoteAddress) || !isLocalHostHeader(req.headers?.host) || !sameOrigin(req)) {
      return send(res, 403, { error: "this machine only" });
    }

    if (req.method === "GET" && url === `${BASE}/client.js`) {
      return send(res, 200, `const PAGE_EDITS_SITE = ${JSON.stringify(site)};\n${readFileSync(CLIENT, "utf8")}`, "text/javascript");
    }
    if (req.method === "GET" && url === `${BASE}/notes`) {
      const notes = readNotes(storeFile).map(({ id, at, page, selected, comment, state, result }) => ({
        id, at, page, selected, comment, state, result,
      }));
      return send(res, 200, { notes });
    }
    if (req.method === "POST" && url === `${BASE}/notes`) {
      if (req.headers["x-page-edits"] !== "1") return send(res, 403, { error: "missing header" });
      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        return send(res, 400, { error: "unreadable note" });
      }
      const fields = validNote(body);
      if (!fields || (fields.site && fields.site !== site)) return send(res, 400, { error: "invalid note" });
      const note = appendNote(storeFile, { ...fields, root });
      return send(res, 201, { id: note.id, state: note.state });
    }
    return send(res, 404, { error: "not found" });
  };
}

// The URL paths (lower-cased) under which a dev server could serve the inbox: by its place in the
// site (after any `base`), and by Vite's /@fs/ route to any file. Its whole folder when that folder
// is the inbox's own.
function inboxPaths(root, storeFile) {
  const own = basename(dirname(storeFile)) === INBOX_FOLDER;
  const target = own ? `${dirname(storeFile)}${sep}` : storeFile;
  const paths = [`/@fs${target.split(sep).join("/")}`];
  const inside = relative(root, target);
  if (!inside.startsWith("..") && !isAbsolute(inside)) paths.push(`/${inside.split(sep).join("/")}${own ? "/" : ""}`);
  return paths.map((path) => path.toLowerCase());
}

function servedPath(url) {
  let path = url;
  try {
    path = decodeURIComponent(url);
  } catch {
    // A malformed escape is left as it came; it matches nothing below.
  }
  return posix.normalize(path.replace(/\\/g, "/")).toLowerCase();
}

// The page's outbox is keyed by the site's name and folder, so two sites with the same folder name
// served on one port never share unsent notes.
export function siteKey(name, root) {
  return `${name}-${createHash("sha256").update(resolve(root)).digest("hex").slice(0, 8)}`;
}

// Where the notes go: the `inbox` option (a path, or a function of the site's name and folder),
// else PAGE_EDITS_INBOX, else `.page-edits/notes.jsonl` in the site. A relative path is the site's.
export function resolveInbox({ inbox, site, root, env = process.env }) {
  const chosen = typeof inbox === "function" ? inbox(site, root) : inbox ?? env.PAGE_EDITS_INBOX;
  return chosen ? resolve(root, chosen) : defaultInbox(root);
}

// `site` names the site; it defaults to PAGE_EDITS_SITE, then the site folder's name.
export default function pageEdits({ site, inbox } = {}) {
  let handler;
  let storeFile;
  return {
    name: "page-edits",
    apply: "serve",
    config(config) {
      // The inbox changes with every note and nothing on the page imports it, so the file watcher
      // leaves it alone: the file itself, or its whole folder when that folder is the inbox's own.
      const root = resolve(config.root ?? process.cwd());
      const file = resolveInbox({ inbox, site: site ?? process.env.PAGE_EDITS_SITE ?? basename(root), root });
      const inside = relative(root, file);
      if (inside.startsWith("..") || isAbsolute(inside)) return undefined;
      const own = basename(dirname(file)) === INBOX_FOLDER;
      return { server: { watch: { ignored: [own ? `${dirname(file)}/**` : file] } } };
    },
    configResolved(config) {
      const name = site ?? process.env.PAGE_EDITS_SITE ?? basename(config.root);
      if (!SITE_NAME.test(name)) throw new Error(`page-edits: bad site name "${name}"`);
      storeFile = resolveInbox({ inbox, site: name, root: config.root });
      handler = createHandler({ root: config.root, storeFile, site: siteKey(name, config.root) });
      config.logger.info(`  page-edits: notes go to ${storeFile}`);
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => handler(req, res, next));
    },
    transformIndexHtml() {
      return [{ tag: "script", attrs: { type: "module", src: `${BASE}/client.js` }, injectTo: "body" }];
    },
  };
}
