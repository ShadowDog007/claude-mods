// What the plugin holds, kept in the session's state so a reload
// (/reload-plugins, an option changed) keeps the queue.
export type PromptQueue = {
  // The prompts waiting for a turn to end, oldest first.
  prompts: string[];
  // Set when a turn with prompts waiting was interrupted or failed: nothing is
  // sent until a turn ends with an answer, or `/queue-resume`.
  isPaused: boolean;
};

declare module 'claude-code' {
  interface PluginState {
    'prompt-queue': { queue: PromptQueue };
  }
}
