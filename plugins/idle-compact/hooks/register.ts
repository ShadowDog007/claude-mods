import type { EngineInterface, Register } from 'claude-code';

const DEFAULT_IDLE_MINUTES = 55;
const DEFAULT_MIN_CONTEXT_TOKENS = 100_000;
// How late a compaction may land past the idle time.
const POLL_MS = 5_000;
// A subagent still doing work; `idle` is a teammate waiting on a message.
const ACTIVE_AGENT = new Set(['pending', 'running', 'waiting']);

type BackgroundTask = { id: string; type: string };
type Limits = { idleMs: number; minContextTokens: number };

// Whether a main-loop turn is running, when its last model request was sent
// (the prompt cache's lifetime runs from there), the context's size, and the
// background tasks the last finished turn left in flight. Reset with the
// module, so a reload waits for the next turn before compacting.
const session = {
  isTurnRunning: false,
  lastModelCallAt: undefined as number | undefined,
  contextTokens: undefined as number | undefined,
  backgroundTasks: [] as BackgroundTask[],
  // One compaction per idle stretch: the next model call re-arms it.
  hasCompacted: false,
};

// The tasks from the last turn's snapshot still running now. Subagents are
// checked live; shell and monitor tasks have no live listing, but each sends
// a notification when it ends (killed too), whose turn retakes the snapshot.
async function runningTasks($: EngineInterface) {
  if (!session.backgroundTasks.some(task => task.type === 'subagent')) return session.backgroundTasks;
  const activeAgents = new Set(
    (await $.agent.list()).filter(agent => ACTIVE_AGENT.has(agent.status)).map(agent => agent.id),
  );
  return session.backgroundTasks.filter(task => task.type !== 'subagent' || activeAgents.has(task.id));
}

async function compactIfIdle($: EngineInterface, limits: Limits) {
  if (session.isTurnRunning || session.hasCompacted) return;
  if (session.backgroundTasks.length < 1 || session.lastModelCallAt === undefined) return;
  if ((session.contextTokens ?? 0) < limits.minContextTokens) return;
  if ((await $.clock.now()) - session.lastModelCallAt < limits.idleMs) return;

  session.backgroundTasks = await runningTasks($);
  if (session.backgroundTasks.length < 1) return;

  // Counted whether it lands or not, so a failure is not retried every poll;
  // a turn started meanwhile makes a model call, which re-arms it anyway.
  session.hasCompacted = true;
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

  on('session.start', ($, e, next) => {
    $.clock.every(POLL_MS, () => compactIfIdle($, limits));
    return next(e);
  });

  on('session.measure', ($, e, next) => {
    session.contextTokens = e.context.tokens;
    return next(e);
  });

  on('turn.start', ($, e, next) => {
    session.isTurnRunning = true;
    // Retaken when the turn stops; an interrupted turn leaves none counted.
    session.backgroundTasks = [];
    return next(e);
  });

  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) {
      session.isTurnRunning = true;
      session.lastModelCallAt = await $.clock.now();
      session.hasCompacted = false;
    }
    return yield* next(e);
  });

  on('classic.Stop', ($, e, next) => {
    if (e.agent_id === undefined) {
      session.isTurnRunning = false;
      session.backgroundTasks = (e.background_tasks ?? []).map(({ id, type }) => ({ id, type }));
    }
    return next(e);
  });

  on('turn.complete', ($, e, next) => {
    if (e.agentId === undefined) session.isTurnRunning = false;
    return next(e);
  });
};
