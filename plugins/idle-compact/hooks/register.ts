import { atom, read, update } from 'claude-code';
import type { EngineInterface, Register, Timer } from 'claude-code';

import type { IdleCompactMode, IdleCompactTracker } from '../types';

// A minute short of the prompt cache's lifetime, so the compaction's request
// still reads the cache.
const IDLE_MINUTES = { '5m': 4, '1h': 59 } as const;
const DEFAULT_MIN_CONTEXT_TOKENS = 100_000;
const MODES: readonly IdleCompactMode[] = ['auto', 'on', 'off'];
// A subagent still doing work; `idle` is a teammate waiting on a message.
const ACTIVE_AGENT = new Set(['pending', 'running', 'waiting']);

// `idleMinutes` is null when it follows the prompt cache's lifetime.
type Limits = { idleMinutes: number | null; minContextTokens: number };
type CacheLifetime = keyof typeof IDLE_MINUTES;

const IDLE: IdleCompactTracker = {
  lastModelCallAt: null,
  contextTokens: null,
  backgroundTasks: [],
  hasCompacted: false,
  isIdle: false,
  rateLimits: null,
};

// Kept in the session's state, so a reload of the module carries on where it
// was rather than waiting for the next turn.
const tracker = atom({ plugin: 'idle-compact', key: 'tracker' } as const, IDLE);
// Set by /idle-compact, and kept through a /clear.
const mode = atom({ plugin: 'idle-compact', key: 'mode' } as const, 'auto' as IdleCompactMode);

function track($: EngineInterface, change: Partial<IdleCompactTracker>) {
  return update($, tracker, current => ({ ...current, ...change }));
}

function isEnabled(value: string | undefined) {
  return value !== undefined && value !== '' && value !== '0' && value.toLowerCase() !== 'false';
}

function lifetime(value: unknown): CacheLifetime | null {
  return value === '5m' || value === '1h' ? value : null;
}

// How long the main conversation's prompt cache lives, worked out as Claude
// Code picks it: the environment and settings that force one, then an hour on
// a subscription within its plan's usage and five minutes otherwise (an API
// key, a cloud provider, usage past the plan). Until the first response tells
// whether the session is on a subscription, it takes the hour.
async function cacheLifetime($: EngineInterface): Promise<CacheLifetime> {
  if (isEnabled(await $.env.get('FORCE_PROMPT_CACHING_5M'))) return '5m';
  const fromEnv = lifetime(await $.env.get('CLAUDE_CODE_PROMPT_CACHE_TTL'));
  if (fromEnv) return fromEnv;
  const fromSettings = lifetime((await $.settings.read()).promptCacheTtl);
  if (fromSettings) return fromSettings;
  if (isEnabled(await $.env.get('ENABLE_PROMPT_CACHING_1H'))) return '1h';
  const { rateLimits } = await read($, tracker);
  if (rateLimits === null) return '1h';
  return rateLimits.length > 0 && rateLimits.every(limit => limit.percentUsed < 100) ? '1h' : '5m';
}

async function idleMs($: EngineInterface, limits: Limits) {
  return (limits.idleMinutes ?? IDLE_MINUTES[await cacheLifetime($)]) * 60_000;
}

// Whether a session the last turn left with `backgroundTasks` compacts once idle.
function isWaiting(current: IdleCompactMode, backgroundTasks: readonly unknown[]) {
  return current === 'on' || (current === 'auto' && backgroundTasks.length > 0);
}

// The one pending compaction. A plain variable: a reload cancels the timer
// along with the module, and `session.start` arms it again from the state.
let timer: Timer | undefined;

function disarm($: EngineInterface) {
  timer?.cancel();
  timer = undefined;
  $.ui.status(undefined);
}

// The time of day `at` falls on, as hours and minutes.
function clockTime(at: number) {
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

// Pins when the armed timer will compact, if the context is big enough for it
// to; clears it otherwise. The status line is this plugin's own, beside the
// engine's pinned notices, so it covers nothing else on screen.
async function showSchedule($: EngineInterface, limits: Limits) {
  const session = await read($, tracker);
  const isDue = timer !== undefined && (session.contextTokens ?? 0) >= limits.minContextTokens;
  $.ui.status(
    isDue && session.lastModelCallAt !== null
      ? `idle-compact scheduled for ${clockTime(session.lastModelCallAt + (await idleMs($, limits)))}`
      : undefined,
  );
}

// Sets the timer for when the session will have sat idle for the idle time,
// if it sits between turns waiting on background work (or the mode is on)
// and has not compacted since its last model request.
async function arm($: EngineInterface, limits: Limits) {
  disarm($);
  const session = await read($, tracker);
  if (!session.isIdle || session.hasCompacted || session.lastModelCallAt === null) return;
  if (!isWaiting(await read($, mode), session.backgroundTasks)) return;
  const remainingMs = session.lastModelCallAt + (await idleMs($, limits)) - (await $.clock.now());
  timer = $.clock.after(Math.max(remainingMs, 0), () => compactIfIdle($, limits));
  await showSchedule($, limits);
}

// The tasks from the last turn's snapshot still running now. Subagents are
// checked live; shell and monitor tasks have no live listing, but each sends
// a notification when it ends (killed too), whose turn retakes the snapshot.
async function runningTasks($: EngineInterface, tasks: IdleCompactTracker['backgroundTasks']) {
  if (!tasks.some(task => task.type === 'subagent')) return tasks;
  const activeAgents = new Set(
    (await $.agent.list()).filter(agent => ACTIVE_AGENT.has(agent.status)).map(agent => agent.id),
  );
  return tasks.filter(task => task.type !== 'subagent' || activeAgents.has(task.id));
}

async function compactIfIdle($: EngineInterface, limits: Limits) {
  timer = undefined;
  $.ui.status(undefined);
  const session = await read($, tracker);
  const current = await read($, mode);
  if (!session.isIdle || session.hasCompacted || session.lastModelCallAt === null) return;
  if (!isWaiting(current, session.backgroundTasks)) return;
  if ((session.contextTokens ?? 0) < limits.minContextTokens) return;
  // Not yet, should the timer have fired early: wait out the rest.
  if ((await $.clock.now()) - session.lastModelCallAt < (await idleMs($, limits))) {
    await arm($, limits);
    return;
  }

  // On compacts whatever is running; auto only while some background work is.
  if (current === 'auto') {
    const backgroundTasks = await runningTasks($, session.backgroundTasks);
    if (backgroundTasks.length < 1) {
      await track($, { backgroundTasks });
      return;
    }
  }

  // Counted whether it lands or not, so a failure is not retried; the next
  // model request re-arms it.
  await track($, { hasCompacted: true });
  try {
    const result = await $.session.compact();
    if ('skip' in result) $.ui.log(`idle-compact: compaction skipped: ${result.skip}`);
    else $.ui.toast('idle-compact: compacted the idle session');
  } catch (error) {
    $.ui.log(`idle-compact: compaction failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function positive(value: unknown) {
  const number = Number(value);
  return number > 0 ? number : null;
}

// What /idle-compact answers: the mode, and when it compacts in it.
async function describe($: EngineInterface, limits: Limits) {
  const current = await read($, mode);
  if (current === 'off') return 'idle-compact is off for this session';
  const cache = await cacheLifetime($);
  const minutes = limits.idleMinutes ?? IDLE_MINUTES[cache];
  const when = current === 'on' ? 'whenever the session sits idle' : 'while background work runs';
  const cacheName = cache === '5m' ? 'five-minute' : 'one-hour';
  return `idle-compact is ${current}: compacts after ${minutes} idle minutes ${when} (${cacheName} prompt cache)`;
}

export const register: Register = (on, options) => {
  const limits: Limits = {
    idleMinutes: positive(options.idleMinutes),
    minContextTokens: positive(options.minContextTokens) ?? DEFAULT_MIN_CONTEXT_TOKENS,
  };

  // Fires again on every reload, which arms the timer from the session state.
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'idle-compact',
      description: 'Compact the session when idle: auto (with background work), on (always) or off',
      argumentHint: '[auto|on|off]',
      immediate: true,
    });
    await arm($, limits);
    return next(e);
  });

  // With no argument it says what it is set to; a mode sets it for the session.
  on('command.run', { command: 'idle-compact' }, async ($, e) => {
    const choice = e.args.trim().toLowerCase();
    if (choice !== '') {
      const chosen = MODES.find(each => each === choice);
      if (chosen === undefined) return { text: 'Usage: /idle-compact [auto|on|off]' };
      await update($, mode, () => chosen);
      await arm($, limits);
    }
    return { text: await describe($, limits) };
  });

  // A /clear starts the conversation over.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      disarm($);
      await track($, IDLE);
    }
    return next(e);
  });

  // Whether the session is on a subscription, and within its plan, comes with
  // each response's rate limits: none off a subscription.
  on('session.measure', async ($, e, next) => {
    await track($, {
      contextTokens: e.context.tokens ?? null,
      rateLimits: e.rateLimits.map(({ kind, percentUsed }) => ({ kind, percentUsed })),
    });
    await showSchedule($, limits);
    return next(e);
  });

  on('turn.start', async ($, e, next) => {
    // Retaken when the turn stops, so none count while it runs; an
    // interrupted turn has no Stop and leaves none counted.
    disarm($);
    await track($, { backgroundTasks: [], isIdle: false });
    return next(e);
  });

  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) {
      await track($, { lastModelCallAt: await $.clock.now(), hasCompacted: false });
    }
    return yield* next(e);
  });

  // Tracking is best effort: should it fail, the turn still stops as it would
  // have, and the next turn's Stop takes the count again.
  on('classic.Stop', async ($, e, next) => {
    if (e.agent_id === undefined) {
      const backgroundTasks = (e.background_tasks ?? []).map(({ id, type }) => ({ id, type }));
      await track($, { backgroundTasks, isIdle: true });
      await arm($, limits);
    }
    return next(e);
  }).catch(($, e, next) => next(e));
};
