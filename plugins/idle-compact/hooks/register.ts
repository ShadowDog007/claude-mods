import { atom, read, update } from 'claude-code';
import type { EngineInterface, Register, Timer } from 'claude-code';

import type { IdleCompactTracker } from '../types';

const DEFAULT_IDLE_MINUTES = 59;
const DEFAULT_MIN_CONTEXT_TOKENS = 100_000;
// A subagent still doing work; `idle` is a teammate waiting on a message.
const ACTIVE_AGENT = new Set(['pending', 'running', 'waiting']);

type Limits = { idleMs: number; minContextTokens: number };

const IDLE: IdleCompactTracker = {
  lastModelCallAt: null,
  contextTokens: null,
  backgroundTasks: [],
  hasCompacted: false,
};

// Kept in the session's state, so a reload of the module carries on where it
// was rather than waiting for the next turn.
const tracker = atom({ plugin: 'idle-compact', key: 'tracker' } as const, IDLE);

function track($: EngineInterface, change: Partial<IdleCompactTracker>) {
  return update($, tracker, current => ({ ...current, ...change }));
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
      ? `idle-compact scheduled for ${clockTime(session.lastModelCallAt + limits.idleMs)}`
      : undefined,
  );
}

// Sets the timer for when the session will have sat idle for the idle time,
// if it is waiting on background work and has not compacted since its last
// model request.
async function arm($: EngineInterface, limits: Limits) {
  disarm($);
  const session = await read($, tracker);
  if (session.hasCompacted) return;
  if (session.backgroundTasks.length < 1 || session.lastModelCallAt === null) return;
  const remainingMs = session.lastModelCallAt + limits.idleMs - (await $.clock.now());
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
  if (session.hasCompacted) return;
  if (session.backgroundTasks.length < 1 || session.lastModelCallAt === null) return;
  if ((session.contextTokens ?? 0) < limits.minContextTokens) return;
  // Not yet, should the timer have fired early: wait out the rest.
  if ((await $.clock.now()) - session.lastModelCallAt < limits.idleMs) {
    await arm($, limits);
    return;
  }

  const backgroundTasks = await runningTasks($, session.backgroundTasks);
  if (backgroundTasks.length < 1) {
    await track($, { backgroundTasks });
    return;
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

function positive(value: unknown, fallback: number) {
  const number = Number(value);
  return number > 0 ? number : fallback;
}

export const register: Register = (on, options) => {
  const limits: Limits = {
    idleMs: positive(options.idleMinutes, DEFAULT_IDLE_MINUTES) * 60_000,
    minContextTokens: positive(options.minContextTokens, DEFAULT_MIN_CONTEXT_TOKENS),
  };

  // Fires again on every reload, which arms the timer from the session state.
  on('session.start', async ($, e, next) => {
    await arm($, limits);
    return next(e);
  });

  // A /clear starts the conversation over.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      disarm($);
      await track($, IDLE);
    }
    return next(e);
  });

  on('session.measure', async ($, e, next) => {
    await track($, { contextTokens: e.context.tokens ?? null });
    await showSchedule($, limits);
    return next(e);
  });

  on('turn.start', async ($, e, next) => {
    // Retaken when the turn stops, so none count while it runs; an
    // interrupted turn has no Stop and leaves none counted.
    disarm($);
    await track($, { backgroundTasks: [] });
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
      await track($, { backgroundTasks });
      await arm($, limits);
    }
    return next(e);
  }).catch(($, e, next) => next(e));
};
