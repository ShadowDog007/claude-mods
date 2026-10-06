// One row of the context window as /context breaks it down: content in use,
// the free space, or the compaction buffer.
export type ContextBarSlice = {
  name: string;
  tokens: number;
  // The theme colour /context draws the row in, by its key in the theme.
  color: string;
  kind: 'used' | 'free' | 'buffer';
};

// The window by category, as last estimated; on-demand tool schemas, which
// sit outside the window, are left out.
export type ContextBarBreakdown = {
  slices: ContextBarSlice[];
  // The window measured against: the model's, or a smaller compaction window.
  window: number;
};

// One model request of the main conversation: the input side it was answered
// over (uncached, cache-read and cache-written together) and what it generated.
export type ContextBarStep = { context: number; output: number };

// The main conversation's latest turn, kept until the next one starts.
export type ContextBarTurn = {
  // The context the turn started from: the last response's input side, or
  // null when none was measured (a fresh or just-compacted session).
  contextBefore: number | null;
  steps: ContextBarStep[];
  // The first step after a compaction within the turn, if one ran: the
  // turn's growth is counted from there instead.
  compactedAt: number | null;
  isRunning: boolean;
};

// One tool result of the main conversation still in the context: the tool,
// what it was called on, and its text's estimated tokens.
export type ContextBarToolResult = { tool: string; target: string; tokens: number };

declare module 'claude-code' {
  interface PluginState {
    'context-bar': {
      breakdown: ContextBarBreakdown | null;
      // The input side of the last response, as the status line reports it.
      measured: number | null;
      turn: ContextBarTurn | null;
      // The largest tool results since the last compaction, largest first.
      toolResults: ContextBarToolResult[];
    };
  }
}
