export type AutoModelTier = 'haiku' | 'sonnet' | 'opus';

// How the session's model was chosen: by the classifier, by the fallback when
// the classifier gave no tier, or by /auto-model.
export type AutoModelSource = 'classified' | 'fallback' | 'pinned';

// Why the plugin has stopped rerouting the session: the person switched model
// with /model, or turned it off with /auto-model off.
export type AutoModelStandDown = 'manual' | 'off';

// The session's route, also saved under its id in the plugin's store so a
// /resume picks it up again.
export type AutoModelRoute = {
  // The session the route belongs to: another id means /clear, /resume or
  // /branch moved the process on to another conversation.
  sessionId: string;
  // The model the main conversation runs on; null until the first prompt.
  model: string | null;
  source: AutoModelSource | null;
  // The main loop's model as `/model` showed it when the route was set. When
  // it changes, the person has switched by hand.
  baseline: string | null;
  standDown: AutoModelStandDown | null;
};

declare module 'claude-code' {
  interface PluginState {
    'auto-model': { route: AutoModelRoute | null; clearedSessionId: string | null };
  }
}
