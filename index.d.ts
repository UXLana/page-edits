import type { Plugin } from "vite";

export interface PageEditsOptions {
  /**
   * Names the site in the dev server's log and keys the page's unsent notes. Default:
   * `PAGE_EDITS_SITE`, then the name of the site's folder.
   */
  site?: string;
  /**
   * Where notes go: a path (relative to the site's folder) or a function of the site's name and
   * folder. Default: `PAGE_EDITS_INBOX`, then `.page-edits/notes.jsonl` in the site, in a folder
   * Git ignores by itself.
   */
  inbox?: string | ((site: string, root: string) => string);
}

/** The comment box and its inbox, on the dev server only: builds never include it. */
export default function pageEdits(options?: PageEditsOptions): Plugin;
