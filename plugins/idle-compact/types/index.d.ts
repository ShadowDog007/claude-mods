export type IdleCompactTask = { id: string; type: string };

// What the plugin tracks of the main conversation, kept in the session's
// state so a reload (an option changed in /config, /reload-plugins) keeps it.
export type IdleCompactTracker = {
  // When the last model request was sent (the prompt cache's lifetime runs
  // from there), in `$.clock.now()` milliseconds; null before the first.
  lastModelCallAt: number | null;
  // The input tokens of the last response; null until one is measured.
  contextTokens: number | null;
  // The background tasks the last finished turn left in flight; emptied when
  // a turn starts, so empty while one runs and after one is interrupted.
  backgroundTasks: IdleCompactTask[];
  // One compaction per idle stretch: the next model request re-arms it.
  hasCompacted: boolean;
};

declare module 'claude-code' {
  interface PluginState {
    'idle-compact': { tracker: IdleCompactTracker };
  }
}
