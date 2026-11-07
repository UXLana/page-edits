// Types for fold.mjs, which the Claude Code plugin's hooks import.
export type NoteState = "queued" | "applying" | "done" | "not-in-code" | "needs-you" | "cancelled";
export type Note = {
  id: number;
  uid?: string;
  format?: number;
  at: string;
  page: string;
  selected: string;
  comment: string;
  root: string;
  state: NoteState;
  result: { file?: string; before?: string; after?: string; message?: string } | null;
  [field: string]: unknown;
};
export declare const NOTE_FORMAT: number;
export declare function isNewer(note: { format?: unknown }): boolean;
export declare const STATES: NoteState[];
export declare const FINAL_STATES: Set<string>;
export declare function parseEvents(text: string): unknown[];
export declare function foldNotes(events: unknown[]): Note[];
