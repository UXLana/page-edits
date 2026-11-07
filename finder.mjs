// Finds where a highlighted passage is written in a site's source.
//
// The page shows text; the source writes it. They differ in small, predictable ways: a JSX line
// break is a space on screen, `&rsquo;` is a curly apostrophe, an inline `<strong>` splits a
// sentence. So the highlighted words become a pattern that tolerates exactly those differences and
// nothing else. A file-and-line lookup would point at the JSX that draws the text, which for copy
// kept in a data array is the wrong place; searching the words lands on the string itself.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { extname, join, relative } from "node:path";

const SOURCE_EXTENSIONS = new Set([".tsx", ".ts", ".jsx", ".js", ".mjs", ".mdx", ".md", ".html", ".json"]);
const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".git", ".next", ".vite", "coverage", "public"]);
const MAX_FILE_BYTES = 1_000_000;
// Tests and fixtures quote page copy too; a match there is never the copy's home.
const TEST_FILE = /(?:\.test\.|\.spec\.|\.fixture)/;

// One page character → the ways a source file may spell it.
const EQUIVALENTS = {
  "'": `(?:'|’|‘|&rsquo;|&lsquo;|&apos;|&#39;|\\\\')`,
  "’": `(?:'|’|‘|&rsquo;|&lsquo;|&apos;|&#39;|\\\\')`,
  "‘": `(?:'|’|‘|&rsquo;|&lsquo;|&apos;|&#39;|\\\\')`,
  '"': `(?:"|“|”|&quot;|&ldquo;|&rdquo;|\\\\")`,
  "“": `(?:"|“|”|&quot;|&ldquo;|&rdquo;|\\\\")`,
  "”": `(?:"|“|”|&quot;|&ldquo;|&rdquo;|\\\\")`,
  "—": "(?:—|&mdash;|\\\\u2014)",
  "–": "(?:–|&ndash;|\\\\u2013)",
  "…": "(?:…|\\.\\.\\.|&hellip;)",
  "&": "(?:&|&amp;)",
  "<": "(?:<|&lt;)",
  ">": "(?:>|&gt;)",
};

// Between two words the source may hold a line break, a JSX `{" "}`, or an inline tag. Inside a
// word, an inline tag may sit where letters meet punctuation: `<b>world</b>!`.
const GAP = `(?:\\s|&nbsp;|\\{\\s*["'\`]\\s*["'\`]\\s*\\}|</?[A-Za-z][^<>]*>)+`;
const TAGS = "(?:</?[A-Za-z][^<>]*>)*";
const WORDISH = /[\p{L}\p{N}]/u;

function escapeChar(ch) {
  if (EQUIVALENTS[ch]) return EQUIVALENTS[ch];
  return ch.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

function wordPattern(word) {
  const chars = [...word];
  return chars
    .map((ch, i) => (i > 0 && WORDISH.test(ch) !== WORDISH.test(chars[i - 1]) ? TAGS : "") + escapeChar(ch))
    .join("");
}

// Whole words first: "Title" is not copy inside `pageTitle`, nor a tag name like `<Title>`. A
// highlight that itself starts or ends mid-word ("rtial highl") is searched for as it is when no
// whole-word match exists.
export function patternFor(text, { wholeWords = true } = {}) {
  const words = text.replace(/\u00a0/g, " ").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;
  const body = words.map(wordPattern).join(GAP);
  const start = wholeWords && WORDISH.test(words[0][0]) ? "(?<![\\p{L}\\p{N}_$<])" : "";
  const end = wholeWords && WORDISH.test(words.at(-1).at(-1)) ? "(?![\\p{L}\\p{N}_$])" : "";
  return new RegExp(`${start}${body}${end}`, "gu");
}

// Letters and digits only, lower-cased: the common ground between page text and source text.
const squash = (text) => text.toLowerCase().replace(/&[a-z]+;/g, "").replace(/<[^<>]*>/g, "").replace(/[^\p{L}\p{N}]+/gu, "");

function commonSuffixLength(a, b) {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n += 1;
  return n;
}

function commonPrefixLength(a, b) {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n += 1;
  return n;
}

// The site's own source: `src/` and the root `index.html` when there is a `src/`, else the whole
// root. Drafts, docs and tests beside `src/` repeat the copy and would make every match ambiguous.
export function sourceFiles(root) {
  const src = join(root, "src");
  if (!existsSync(src)) return walkSource(root);
  const index = join(root, "index.html");
  return [...walkSource(src), ...(existsSync(index) ? [index] : [])];
}

function walkSource(root) {
  const files = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.isDirectory()) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && entry.name !== "__tests__") walk(path);
      } else if (
        SOURCE_EXTENSIONS.has(extname(entry.name)) &&
        !TEST_FILE.test(entry.name) &&
        statSync(path).size <= MAX_FILE_BYTES
      ) {
        files.push(path);
      }
    }
  };
  walk(root);
  return files.sort();
}

// In a script file, copy is text: string and template literals and JSX text. With the site's own
// TypeScript the file is parsed and a match must start and end inside such text, so comments,
// names and other code never count. Without it, the rules below keep comments out.
const SCRIPT = new Set([".tsx", ".ts", ".jsx", ".js", ".mjs"]);
const typescripts = new Map();
function typescriptFor(root) {
  if (!typescripts.has(root)) {
    let ts = null;
    try {
      ts = createRequire(join(root, "package.json"))("typescript");
    } catch {
      ts = null;
    }
    // TypeScript 7 offers no classic compiler API from its main entry; the rules stand in then.
    const parses = ["createSourceFile", "forEachChild"].every((name) => typeof ts?.[name] === "function");
    typescripts.set(root, parses && ts.ScriptKind && ts.SyntaxKind ? ts : null);
  }
  return typescripts.get(root);
}

function textSpans(ts, file, source) {
  const kinds = { ".tsx": ts.ScriptKind.TSX, ".jsx": ts.ScriptKind.JSX, ".ts": ts.ScriptKind.TS };
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, false, kinds[extname(file)] ?? ts.ScriptKind.JS);
  const text = new Set([
    ts.SyntaxKind.StringLiteral,
    ts.SyntaxKind.NoSubstitutionTemplateLiteral,
    ts.SyntaxKind.TemplateHead,
    ts.SyntaxKind.TemplateMiddle,
    ts.SyntaxKind.TemplateTail,
    ts.SyntaxKind.JsxText,
  ]);
  const spans = [];
  const visit = (node) => {
    if (text.has(node.kind)) spans.push([node.getStart(tree), node.end]);
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return spans;
}

const inside = (spans, index) => spans.some(([start, end]) => index >= start && index < end);

function inComment(source, index, file) {
  if (!SCRIPT.has(extname(file))) return false;
  const prefix = source.slice(source.lastIndexOf("\n", index - 1) + 1, index);
  if (/^\s*(?:\/\/|\/\*|\*|\{\/\*)/.test(prefix) || /(?:^|\s)\/\/\s/.test(prefix)) return true;
  // Inside a block comment only when the nearest unclosed `/*` opens its own line (or a JSX
  // `{/*`); a `/*` inside a string such as "/docs/*" opens nothing.
  const open = source.lastIndexOf("/*", index);
  if (open < 0 || open < source.lastIndexOf("*/", index)) return false;
  return /^\s*\{?\s*$/.test(source.slice(source.lastIndexOf("\n", open - 1) + 1, open));
}

function lineAndColumn(text, index) {
  const before = text.slice(0, index);
  const line = before.split("\n").length;
  return { line, column: index - before.lastIndexOf("\n") };
}

export function findText(root, text, options = {}) {
  const whole = matchText(root, text, { ...options, wholeWords: true });
  return whole.length > 0 ? whole : matchText(root, text, { ...options, wholeWords: false });
}

function matchText(root, text, { before = "", after = "", files = sourceFiles(root), wholeWords }) {
  const pattern = patternFor(text, { wholeWords });
  if (!pattern) return [];
  const pageBefore = squash(before);
  const pageAfter = squash(after);
  const ts = typescriptFor(root);
  const matches = [];
  for (const file of files) {
    // Unparsed code: a partial match is as likely a name (`pageTitle`) as copy, so leave it out.
    if (!wholeWords && !ts && SCRIPT.has(extname(file))) continue;
    const source = readFileSync(file, "utf8");
    let spans = null; // parsed only when the file has a match
    for (const match of source.matchAll(pattern)) {
      const start = match.index;
      const end = start + match[0].length;
      if (ts && SCRIPT.has(extname(file))) {
        spans ??= textSpans(ts, file, source);
        if (!inside(spans, start) || !inside(spans, end - 1)) continue;
      } else if (inComment(source, start, file)) continue;
      // How much of the paragraph around the highlight also surrounds this spot in the source.
      const score =
        commonSuffixLength(pageBefore, squash(source.slice(Math.max(0, start - 400), start))) +
        commonPrefixLength(pageAfter, squash(source.slice(end, end + 400)));
      matches.push({
        file: relative(root, file),
        ...lineAndColumn(source, start),
        index: start,
        text: match[0],
        score,
      });
    }
  }
  return matches.sort((a, b) => b.score - a.score);
}

// A clear winner needs real context agreeing with it, and more than any rival has.
function pick(matches) {
  if (matches.length === 1) return { status: "found", match: matches[0], matches };
  if (matches.length > 1 && matches[0].score >= 8 && matches[0].score > matches[1].score) {
    return { status: "found", match: matches[0], matches };
  }
  return { status: "ambiguous", matches };
}

const overlaps = (a, b) => Boolean(a && b) && (a.includes(b) || b.includes(a));

// Follows the highlighted words through the rewrites that landed after they were written, oldest
// first, each step continuing from the previous step's wording: Original → Second → Final. A
// highlight wider than a rewrite keeps its width, with the rewritten part swapped in; one inside a
// rewritten passage becomes that passage's new wording.
const spaced = (text) => text.replace(/\s+/g, " ").trim();
function follow(note, ledger, options) {
  // A rewrite that had already landed when the note was written changed nothing the note saw.
  const written = Date.parse(note.at ?? "");
  const edits = [...ledger]
    .filter((e) => e.result?.before && e.result?.after && (!e.page || !note.page || e.page === note.page))
    .filter((e) => !(written && Date.parse(e.doneAt ?? "") < written))
    .sort((a, b) => a.id - b.id);
  let text = spaced(note.selected);
  let last = null;
  for (const edit of edits) {
    const before = spaced(edit.result.before);
    const after = spaced(edit.result.after);
    if (text.includes(before)) text = text.replace(before, after);
    else if (overlaps(squash(text), squash(before))) text = after;
    else continue;
    last = edit;
  }
  if (!last) return null;
  const files = last.result.file ? sourceFiles(note.root).filter((f) => relative(note.root, f) === last.result.file) : [];
  const followed = findText(note.root, text, { ...options, ...(files.length ? { files } : {}) });
  return followed.length > 0 ? { ...pick(followed), followedNote: last.id } : null;
}

// `ledger`: earlier notes in this queue that landed, each { id, page, doneAt, result: { file,
// before, after } }. When the paragraph around the highlight points at one match, that is the
// passage. Otherwise an earlier rewrite of these words is followed, and if the same words also
// stand somewhere else, the finder says it cannot tell rather than guessing.
export function locate(note, ledger = [], options = {}) {
  const direct = findText(note.root, note.selected, { before: note.before, after: note.after, ...options });
  const picked = direct.length > 0 ? pick(direct) : null;
  if (picked?.status === "found" && direct[0].score >= 8) return picked;
  const followed = follow(note, ledger, options);
  if (followed && direct.length > 0) {
    return { status: "ambiguous", matches: [...followed.matches, ...direct], followedNote: followed.followedNote };
  }
  if (followed) return followed;
  return picked ?? { status: "not-in-code", matches: [] };
}
