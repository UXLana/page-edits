// page-edits — the in-page half. Select text, press Comment (or Alt+Shift+C), type a direction,
// press Enter, keep going. Nothing here ever waits on the session that applies the notes: a note is
// queued locally the moment it is sent, the box closes at once, and a numbered list shows each
// note's progress as the session works through them in order.
//
// Everything lives in its own shadow root on <html>, outside the app's root, so the app's
// re-renders and hot updates cannot touch it. A half-typed note survives a full reload
// (sessionStorage), and a note the dev server did not take is retried until it does: the outbox
// lives in memory first and in localStorage when the browser allows it, changed under a lock that
// all tabs of the site share.

(() => {
  if (window.__pageEdits) return;
  window.__pageEdits = true;

  const BASE = "/__page-edits";
  // The dev server names its site when it serves this file. Keys are per site, so another site
  // later served on the same port never sends this one's notes.
  const SITE = typeof PAGE_EDITS_SITE === "string" ? PAGE_EDITS_SITE : "site";
  const DRAFT_KEY = `page-edits:${SITE}:draft`;
  const OUTBOX_KEY = `page-edits:${SITE}:outbox`;
  const OPEN_KEY = "page-edits:list-open";
  const FINAL = new Set(["done", "not-in-code", "needs-you", "cancelled"]);
  const SEND_TIMEOUT_MS = 10_000;
  const KEEP_FINISHED = 30; // finished notes kept in the list; unfinished ones are always shown
  const LABELS = {
    sending: "Sending",
    "not-sent": "Not sent yet, retrying",
    queued: "Queued",
    applying: "Applying",
    done: "Done",
    "not-in-code": "Not in code",
    "needs-you": "Needs you",
    cancelled: "Cleared",
  };
  const BLOCKS = new Set(["P", "LI", "H1", "H2", "H3", "H4", "H5", "H6", "BLOCKQUOTE", "TD", "TH", "DD", "DT", "FIGCAPTION", "SECTION", "ARTICLE", "MAIN", "BODY"]);

  // Storage can be blocked or full; every read and write says whether it worked.
  const readStored = (kind, key) => {
    try {
      const s = kind === "session" ? sessionStorage : localStorage;
      return { ok: true, value: JSON.parse(s.getItem(key) ?? "null") };
    } catch {
      return { ok: false, value: null };
    }
  };
  const writeStored = (kind, key, value) => {
    try {
      const s = kind === "session" ? sessionStorage : localStorage;
      if (value === null) s.removeItem(key);
      else s.setItem(key, JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  };
  const store = (kind, key, value) =>
    value === undefined ? readStored(kind, key).value : (writeStored(kind, key, value), null);

  const host = document.createElement("div");
  host.setAttribute("data-page-edits", "");
  host.style.cssText = "position:fixed;top:0;left:0;width:0;height:0;z-index:2147483000;";
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `
    <style>
      :host { all: initial; }
      * { box-sizing: border-box; font: 13px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
      .surface { --bg: #ffffff; --fg: #1d1d1f; --muted: #5c5c66; --line: #d4d4dc; --control: #767682; --accent: #2847d8; --accent-fg: #ffffff;
        --queued: #5c5c66; --applying: #8a5a00; --done: #1c7a3c; --stop: #b3261e; }
      @media (prefers-color-scheme: dark) {
        .surface { --bg: #1f1f24; --fg: #f2f2f5; --muted: #b0b0bb; --line: #3a3a44; --control: #8a8a96; --accent: #8ea2ff; --accent-fg: #10132a;
          --queued: #b0b0bb; --applying: #f0b54a; --done: #6fd492; --stop: #ff8a80; }
      }
      .surface { position: fixed; color: var(--fg); background: var(--bg); border: 1px solid var(--line);
        border-radius: 10px; box-shadow: 0 6px 24px rgba(0,0,0,.18); }
      button { cursor: pointer; border-radius: 6px; border: 1px solid var(--line); background: var(--bg); color: var(--fg);
        min-height: 28px; padding: 4px 10px; }
      button.primary { background: var(--accent); color: var(--accent-fg); border-color: var(--accent); font-weight: 600; }
      button:focus-visible, textarea:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
      [hidden] { display: none !important; }
      .trigger { padding: 2px; border-radius: 8px; }
      .trigger button { font-weight: 600; }
      .composer { width: min(360px, calc(100vw - 24px)); padding: 10px; }
      .quote { margin: 0 0 8px; padding-left: 8px; border-left: 3px solid var(--line); color: var(--muted);
        max-height: 4.4em; overflow: hidden; }
      textarea { width: 100%; min-height: 64px; resize: vertical; padding: 6px 8px; border-radius: 6px;
        border: 1px solid var(--control); background: var(--bg); color: var(--fg); }
      .warn { margin: 0; padding: 0 10px 8px; color: var(--stop); font-size: 12px; }
      .row { display: flex; gap: 8px; align-items: center; justify-content: flex-end; margin-top: 8px; }
      .hint { margin-right: auto; color: var(--muted); font-size: 12px; }
      .list { right: 12px; bottom: 12px; width: min(340px, calc(100vw - 24px)); }
      .list > button { width: 100%; border: 0; border-radius: 10px; text-align: left; font-weight: 600; min-height: 36px; }
      ol { list-style: none; margin: 0; padding: 0 10px 10px; max-height: min(50vh, 420px); overflow: auto; }
      li { padding: 8px 0; border-top: 1px solid var(--line); }
      .head { display: flex; gap: 8px; align-items: baseline; }
      li.can-clear { position: relative; padding-right: 34px; min-height: 44px; }
      .clear-note { position: absolute; top: 3px; right: 0; width: 28px; height: 28px;
        min-height: 28px; display: grid; place-items: center; padding: 0; border-color: transparent;
        background: transparent; color: var(--control); font-size: 16px; line-height: 1; opacity: 0; }
      li.can-clear:hover .clear-note, li.can-clear:focus-within .clear-note { opacity: 1; }
      @media (hover: none) { .clear-note { opacity: 1; } }
      .clear-note:hover:not(:disabled) { background: var(--line); color: var(--fg); }
      .clear-note:disabled { cursor: wait; opacity: .65; }
      .num { font-weight: 700; }
      .state { font-size: 12px; font-weight: 600; }
      .state.queued, .state.sending { color: var(--queued); }
      .state.applying, .state.not-sent { color: var(--applying); }
      .state.done { color: var(--done); }
      .state.not-in-code, .state.needs-you { color: var(--stop); }
      .page { margin-left: auto; min-width: 0; overflow-wrap: anywhere; color: var(--muted); font-size: 12px; }
      .text, .result { margin: 2px 0 0; overflow-wrap: anywhere; }
      .text q { color: var(--muted); }
      .result { color: var(--muted); font-size: 12px; }
      .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
    </style>
    <div class="surface trigger" hidden><button type="button" aria-label="Comment on the selected text (Alt+Shift+C)">Comment</button></div>
    <div class="surface composer" role="dialog" aria-label="Comment on the selected text" hidden>
      <p class="quote"></p>
      <textarea aria-label="What should change?" placeholder="What should change?"></textarea>
      <div class="row"><span class="hint">Enter sends · Shift+Enter new line · Esc cancels</span>
        <button type="button" data-cancel>Cancel</button><button type="button" class="primary" data-send>Send</button></div>
    </div>
    <div class="surface list" hidden><button type="button" aria-expanded="false"></button>
      <p class="warn" hidden>This browser is not saving unsent notes. Keep this tab open until they send.</p><ol></ol></div>
    <div class="sr" role="status" aria-live="polite"></div>`;
  document.documentElement.appendChild(host);

  const $ = (selector) => root.querySelector(selector);
  const trigger = $(".trigger");
  const composer = $(".composer");
  const quote = $(".quote");
  const textarea = $("textarea");
  const list = $(".list");
  const toggle = $(".list > button");
  const items = $("ol");
  const warn = $(".warn");
  const live = $("[role=status]");

  let pending = null; // what the current selection would send
  let returnFocus = null; // where focus was before the box opened
  let draft = null; // what the open composer will send
  let serverNotes = [];
  const savedOutbox = readStored("local", OUTBOX_KEY).value;
  let outbox = Array.isArray(savedOutbox) ? savedOutbox : []; // written, not yet taken; oldest first
  let outboxSaved = true; // whether the outbox last reached storage
  const announced = new Map();
  const clearing = new Set();
  const clearErrors = new Map();
  let shown = 0; // notes in the list at the last render, to bring a new one into view

  const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
  const squashSpace = (text) => text.replace(/\s+/g, " ").trim();
  const announce = (text) => {
    live.textContent = "";
    requestAnimationFrame(() => (live.textContent = text));
  };

  function blockOf(node) {
    let el = node.nodeType === 1 ? node : node.parentElement;
    while (el && el !== document.body) {
      if (BLOCKS.has(el.tagName)) return el;
      const display = getComputedStyle(el).display;
      if (display === "block" || display === "flex" || display === "grid" || display === "list-item") return el;
      el = el.parentElement;
    }
    return document.body;
  }

  function capture() {
    const selection = document.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
    const range = selection.getRangeAt(0);
    if (host.contains(range.commonAncestorContainer)) return null;
    const selected = squashSpace(selection.toString());
    if (!selected) return null;
    const block = blockOf(range.startContainer);
    const head = document.createRange();
    head.selectNodeContents(block);
    head.setEnd(range.startContainer, range.startOffset);
    const tail = document.createRange();
    tail.selectNodeContents(block);
    tail.setStart(range.endContainer, range.endOffset);
    return {
      selected: clip(selected, 4000),
      before: squashSpace(head.toString()).slice(-300),
      after: squashSpace(tail.toString()).slice(0, 300),
      page: location.pathname + location.search + location.hash,
      rect: range.getBoundingClientRect(),
    };
  }

  function place(el, rect) {
    el.hidden = false;
    const box = el.getBoundingClientRect();
    const left = Math.min(Math.max(8, rect.right - box.width), innerWidth - box.width - 8);
    const below = rect.bottom + 8;
    const top = below + box.height < innerHeight - 8 ? below : Math.max(8, rect.top - box.height - 8);
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  }

  function refreshTrigger() {
    if (!composer.hidden) return;
    pending = capture();
    if (pending) place(trigger, pending.rect);
    else trigger.hidden = true;
  }

  function openComposer(from, restoredComment = "") {
    if (!from) return;
    draft = { selected: from.selected, before: from.before, after: from.after, page: from.page };
    trigger.hidden = true;
    quote.textContent = `“${clip(from.selected, 220)}”`;
    textarea.value = restoredComment;
    if (!host.contains(document.activeElement)) returnFocus = document.activeElement;
    const rect = from.rect ?? { right: innerWidth - 12, bottom: innerHeight - 220, top: innerHeight - 220 };
    place(composer, rect);
    textarea.focus();
    store("session", DRAFT_KEY, { ...draft, comment: restoredComment });
  }

  function closeComposer() {
    composer.hidden = true;
    draft = null;
    store("session", DRAFT_KEY, null);
    // Back where focus was; after a mouse highlight that is nowhere, so the note list instead.
    if (returnFocus?.isConnected && returnFocus !== document.body) returnFocus.focus({ preventScroll: true });
    else if (!list.hidden) toggle.focus({ preventScroll: true });
    returnFocus = null;
  }

  // One read-change-write of the outbox at a time across every tab of the site. Stored notes win
  // when storage works (another tab may have added some); memory carries on when it does not.
  const withLock = (name, options, fn) =>
    navigator.locks ? navigator.locks.request(name, options, fn) : Promise.resolve().then(() => fn({}));
  // Memory is kept alongside what storage holds: storage may be readable but full, and a note only
  // memory has must not be lost. A note another tab already sent may come back this way; the dev
  // server ignores a note it already has.
  async function changeOutbox(change) {
    await withLock(`page-edits:${SITE}:outbox`, {}, () => {
      const saved = readStored("local", OUTBOX_KEY);
      const stored = saved.ok && Array.isArray(saved.value) ? saved.value : [];
      const known = new Set(stored.map((n) => n.clientId));
      outbox = change([...stored, ...outbox.filter((n) => !known.has(n.clientId))]);
      outboxSaved = writeStored("local", OUTBOX_KEY, outbox);
    });
    render();
  }

  function submit() {
    const comment = textarea.value.trim();
    if (!draft || !comment) return;
    const note = { ...draft, comment, clientId: crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`, state: "sending" };
    outbox = [...outbox, note]; // in memory at once, whatever storage does
    render();
    closeComposer();
    document.getSelection()?.removeAllRanges();
    announce("Note queued");
    setListOpen(true);
    render();
    changeOutbox((current) => (current.some((n) => n.clientId === note.clientId) ? current : [...current, note])).then(flush);
  }

  // Sends queued notes one at a time, in the order they were written. One tab sends at a time; a
  // failure keeps the note and its place in line, and a send that hangs is abandoned after a while
  // so it cannot hold up the notes behind it. The dev server ignores a note it already has.
  let retry = null;
  function flush() {
    return withLock(`page-edits:${SITE}:flush`, { ifAvailable: true }, async (lock) => {
      if (lock === null) return; // another tab is sending
      for (;;) {
        const note = outbox.find((n) => !n.refused);
        if (!note) return;
        const { state, refused, ...body } = note;
        let response = null;
        const abort = new AbortController();
        const timer = setTimeout(() => abort.abort(), SEND_TIMEOUT_MS);
        try {
          response = await fetch(`${BASE}/notes`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Page-Edits": "1" },
            body: JSON.stringify({ ...body, site: SITE }),
            signal: abort.signal,
          });
        } catch {
          response = null;
        } finally {
          clearTimeout(timer);
        }
        const mine = (n) => n.clientId === note.clientId;
        if (response && response.status >= 400 && response.status < 500) {
          // The server will never take this note: keep it, visibly, until it is dismissed.
          await changeOutbox((current) =>
            current.map((n) => (mine(n) ? { ...n, refused: true, state: "needs-you" } : n)),
          );
          continue;
        }
        if (!response || !response.ok) {
          await changeOutbox((current) => current.map((n) => (mine(n) ? { ...n, state: "not-sent" } : n)));
          clearTimeout(retry);
          retry = setTimeout(flush, 3000);
          return;
        }
        await changeOutbox((current) => current.filter((n) => !mine(n)));
        void poll(false); // never hold the send lock on a status read
      }
    });
  }

  function setListOpen(open) {
    store("local", OPEN_KEY, open);
    toggle.setAttribute("aria-expanded", String(open));
    items.hidden = !open;
  }

  async function clearNote(note) {
    const identity = note.uid ?? `${note.id}:${note.at}`;
    if (clearing.has(identity)) return;
    const hadFocus = root.activeElement?.dataset.queueKey === identity;
    let succeeded = false;
    clearing.add(identity);
    clearErrors.delete(identity);
    render();
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), SEND_TIMEOUT_MS);
    try {
      const response = await fetch(`${BASE}/notes/${note.id}/clear`, {
        method: "POST", headers: { "Content-Type": "application/json", "X-Page-Edits": "1" },
        body: JSON.stringify({ identity }), signal: abort.signal,
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Could not clear this note.");
      serverNotes = serverNotes.map((n) => (n.uid ?? `${n.id}:${n.at}`) === identity ? { ...n, state: "cancelled" } : n);
      announce(`Note ${note.id} cleared. It will not be applied.`);
      succeeded = true;
      if (hadFocus && root.activeElement === toggle) toggle.focus({ preventScroll: true });
    } catch (error) {
      const message = error.name === "AbortError" ? "Clear was not confirmed. Refresh the queue before trying again." : error.message;
      clearErrors.set(identity, message);
      announce(message);
    } finally {
      clearTimeout(timer);
      clearing.delete(identity);
      render();
      if (!succeeded && hadFocus && root.activeElement === toggle) {
        const retry = [...items.querySelectorAll("button[data-queue-key]")].find(button => button.dataset.queueKey === identity);
        retry?.focus({ preventScroll: true });
      }
      void poll(false);
    }
  }

  function render() {
    const focusedKey = root.activeElement?.dataset.queueKey;
    const all = [...serverNotes.filter((n) => n.state !== "cancelled"), ...outbox.map((n, i) => ({ ...n, id: n.refused ? "!" : `…${i + 1}` }))];
    const open = all.filter((n) => !FINAL.has(n.state)).length;
    const finished = all.filter((n) => FINAL.has(n.state)).slice(-KEEP_FINISHED);
    const notes = all.filter((n) => !FINAL.has(n.state) || finished.includes(n));
    // Keep the queue toggle available after clearing the last item, so keyboard focus has a home.
    list.hidden = all.length === 0 && serverNotes.length === 0;
    warn.hidden = outboxSaved || !outbox.some((n) => !n.refused);
    toggle.textContent = `Notes · ${open ? `${open} in progress` : "all handled"} · ${all.length} total`;
    items.replaceChildren(
      ...notes.map((note) => {
        const li = document.createElement("li");
        const head = document.createElement("div");
        head.className = "head";
        const num = document.createElement("span");
        num.className = "num";
        num.textContent = `#${note.id}`;
        const state = document.createElement("span");
        state.className = `state ${note.state}`;
        state.textContent = LABELS[note.state] ?? note.state;
        head.append(num, state);
        if (note.page && note.page !== location.pathname + location.search + location.hash) {
          const page = document.createElement("span");
          page.className = "page";
          page.textContent = note.page;
          head.append(page);
        }
        const text = document.createElement("p");
        text.className = "text";
        const q = document.createElement("q");
        q.textContent = clip(note.selected, 90);
        text.append(q, ` — ${clip(note.comment, 140)}`);
        li.append(head, text);
        const identity = note.uid ?? `${note.id}:${note.at}`;
        if (note.state === "queued") {
          const clear = document.createElement("button");
          li.className = "can-clear";
          clear.type = "button";
          clear.className = "clear-note";
          clear.textContent = clearing.has(identity) ? "…" : "×";
          clear.title = clearing.has(identity) ? "Clearing note…" : "Clear note";
          clear.setAttribute("aria-busy", String(clearing.has(identity)));
          clear.disabled = clearing.has(identity);
          clear.dataset.queueKey = identity;
          clear.setAttribute("aria-label", `Clear queued note ${note.id}: ${clip(note.selected, 40)}`);
          clear.addEventListener("click", () => void clearNote(note));
          li.append(clear);
        }
        if (clearErrors.has(identity)) {
          const problem = document.createElement("p");
          problem.className = "result";
          problem.textContent = clearErrors.get(identity);
          li.append(problem);
        }
        const result = note.result ?? {};
        const lines = [
          result.after ? `${clip(squashSpace(result.before ?? ""), 70)} → ${clip(squashSpace(result.after), 90)}` : "",
          result.message ?? "",
        ];
        for (const text of lines.filter(Boolean)) {
          const line = document.createElement("p");
          line.className = "result";
          line.textContent = text;
          li.append(line);
        }
        if (note.refused) {
          const why = document.createElement("p");
          why.className = "result";
          why.textContent = "The dev server refused this note.";
          const dismiss = document.createElement("button");
          dismiss.type = "button";
          dismiss.dataset.queueKey = `dismiss:${note.clientId}`;
          dismiss.textContent = "Dismiss";
          dismiss.setAttribute("aria-label", `Dismiss refused note: ${clip(note.selected, 40)}`);
          dismiss.addEventListener("click", () => changeOutbox((current) => current.filter((n) => n.clientId !== note.clientId)));
          li.append(why, dismiss);
        }
        return li;
      }),
    );
    if (focusedKey) {
      const replacement = [...items.querySelectorAll("button[data-queue-key]")].find(button => button.dataset.queueKey === focusedKey && !button.disabled);
      (replacement ?? toggle).focus({ preventScroll: true });
    }
    if (notes.length > shown) items.scrollTop = items.scrollHeight;
    shown = notes.length;
  }

  async function poll(schedule = true) {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), SEND_TIMEOUT_MS);
    try {
      const response = await fetch(`${BASE}/notes`, { cache: "no-store", signal: abort.signal });
      if (response.ok) {
        const { notes } = await response.json();
        serverNotes = notes;
        // One announcement per update, naming every note that finished, so none overwrites another.
        const finished = [];
        for (const note of notes) {
          const before = announced.get(note.id);
          if (before && before !== note.state && FINAL.has(note.state)) finished.push(`note ${note.id} ${LABELS[note.state].toLowerCase()}`);
          announced.set(note.id, note.state);
        }
        if (finished.length) announce(`${finished.join(", ")}.`.replace(/^n/, "N"));
        render();
      }
    } catch {
      // The dev server restarting; the next poll catches up.
    } finally {
      clearTimeout(timer);
    }
    if (schedule) {
      if (outbox.some((n) => !n.refused)) flush(); // notes another tab or an earlier visit left behind
      const busy = serverNotes.some((n) => !FINAL.has(n.state)) || outbox.some((n) => !n.refused);
      setTimeout(poll, busy ? 1200 : 4000);
    }
  }

  trigger.querySelector("button").addEventListener("click", () => openComposer(pending));
  $("[data-send]").addEventListener("click", submit);
  $("[data-cancel]").addEventListener("click", closeComposer);
  toggle.addEventListener("click", () => setListOpen(items.hidden));
  textarea.addEventListener("input", () => draft && store("session", DRAFT_KEY, { ...draft, comment: textarea.value }));
  textarea.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      submit();
    }
  });
  composer.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeComposer();
    }
  });
  document.addEventListener("selectionchange", () => requestAnimationFrame(refreshTrigger));
  addEventListener("scroll", () => (trigger.hidden ? null : refreshTrigger()), { passive: true });
  addEventListener("keydown", (event) => {
    if (event.altKey && event.shiftKey && event.code === "KeyC" && composer.hidden) {
      const from = capture();
      if (from) {
        event.preventDefault();
        openComposer(from);
      }
    }
  });

  const saved = store("session", DRAFT_KEY);
  if (saved?.selected) openComposer(saved, saved.comment ?? "");
  setListOpen(store("local", OPEN_KEY) ?? true);
  render();
  poll();
  flush();
})();
