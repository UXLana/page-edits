// What the page-edits mod keeps for the session: the inbox it watches, and the notes (by their own
// ids) it has already handed to the session from it.
export type Watch = { inbox: string; handed: string[] }

declare module 'claude-code' {
  interface PluginState {
    'page-edits': { watch: Shaped<Watch | null> }
  }
}
