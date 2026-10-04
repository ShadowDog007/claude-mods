import type { On } from 'claude-code';
import type { Engine } from 'claude-code/testing';
import { expect, mock, test } from 'claude-code/testing';

import type { IdleCompactTracker } from '../types';

const MINUTE = 60_000;
const SHELL = { id: 'b1', type: 'shell', status: 'running', description: 'npm run dev' };
const IDLE: IdleCompactTracker = {
  lastModelCallAt: null,
  contextTokens: null,
  backgroundTasks: [],
  hasCompacted: false,
};

// Stands in for the engine beneath the plugin: a session, a model request
// that answers at once, a compaction that counts its calls (and fails when
// `isFailing`), and the session state, holding `tracker` as a reload finds
// what the module before it wrote. It starts from the idle tracker, which the
// plugin reads the same as nothing written.
function engine(
  on: On,
  { isFailing = false, tracker = IDLE }: { isFailing?: boolean; tracker?: IdleCompactTracker } = {},
) {
  const clock = mock.clock(on, { now: 0 });
  const compacted = { count: 0 };
  const state = { value: tracker, version: 1 };
  on('state.get', () => ({ value: { value: state.value, version: state.version } }));
  on('state.set', (_$, e) => {
    if (e.ifVersion !== undefined && e.ifVersion !== state.version) {
      return { value: { isSet: false, version: state.version } };
    }
    state.value = e.value as IdleCompactTracker;
    state.version++;
    return { value: { isSet: true, version: state.version } };
  });
  on('session.start', (_$, e) => ({ cwd: e.cwd }));
  on('session.measure', (_$, e) => ({ changed: e.changed }));
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }));
  on('turn.start', (_$, e) => ({ turnId: e.turnId }));
  on('classic.Stop', () => ({}));
  on('turn.step', async function* (_$, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null };
  });
  on('session.compact', () => {
    compacted.count++;
    if (isFailing) throw new Error('provider down');
    return { messages: [{ role: 'user', text: 'summary', toolUses: [] }] };
  });
  return { clock, compacted, state };
}

// One finished turn: a model request over `tokens` of context, leaving
// `backgroundTasks` running.
async function turn($: Engine, backgroundTasks: (typeof SHELL)[], tokens = 150_000) {
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true });
  await $.turn.start({ text: 'go', turnId: 't1' });
  const step = $.turn.step({ turnId: 't1', index: 0, model: 'm', messageCount: 1 });
  for await (const _ of step);
  await $.session.measure({ context: { tokens, window: 200_000 }, rateLimits: [], changed: ['context'] });
  await $.classic.Stop({ stop_hook_active: false, background_tasks: backgroundTasks });
}

test('compacts once, 55 idle minutes after the last model request, with a background command running', async ($, on) => {
  const { clock, compacted } = engine(on);
  await turn($, [SHELL]);

  await clock.advance(54 * MINUTE);
  expect(compacted.count).toBe(0);

  await clock.advance(MINUTE + 5_000);
  expect(compacted.count).toBe(1);

  await clock.advance(120 * MINUTE);
  expect(compacted.count).toBe(1);
});

test('does not compact with no background work in flight', async ($, on) => {
  const { clock, compacted } = engine(on);
  await turn($, []);

  await clock.advance(120 * MINUTE);
  expect(compacted.count).toBe(0);
});

test('does not compact while a turn runs, or after one is interrupted', async ($, on) => {
  const { clock, compacted } = engine(on);
  await turn($, [SHELL]);
  await $.turn.start({ text: '', turnId: 't2' });

  await clock.advance(120 * MINUTE);
  expect(compacted.count).toBe(0);
});

test('does not compact a context below 100k tokens', async ($, on) => {
  const { clock, compacted } = engine(on);
  await turn($, [SHELL], 99_999);

  await clock.advance(120 * MINUTE);
  expect(compacted.count).toBe(0);
});

test(
  'honours a configured idle time and context threshold',
  { options: { idleMinutes: 10, minContextTokens: 20_000 } },
  async ($, on) => {
    const { clock, compacted } = engine(on);
    await turn($, [SHELL], 30_000);

    await clock.advance(9 * MINUTE);
    expect(compacted.count).toBe(0);

    await clock.advance(MINUTE + 5_000);
    expect(compacted.count).toBe(1);
  },
);

test('does not retry a compaction that failed', async ($, on) => {
  const { clock, compacted } = engine(on, { isFailing: true });
  await turn($, [SHELL]);

  await clock.advance(120 * MINUTE);
  expect(compacted.count).toBe(1);
});

test('does not compact once the background subagent has finished', async ($, on) => {
  const { clock, compacted } = engine(on);
  await turn($, [{ id: 'a1', type: 'subagent', status: 'running', description: 'review' }]);

  await clock.advance(120 * MINUTE);
  expect(compacted.count).toBe(0);
});

test('keeps what it tracks in the session state', async ($, on) => {
  const { clock, state } = engine(on);
  await clock.advance(MINUTE);
  await turn($, [SHELL]);

  expect(state.value).toEqual({
    lastModelCallAt: MINUTE,
    contextTokens: 150_000,
    backgroundTasks: [{ id: 'b1', type: 'shell' }],
    hasCompacted: false,
  });
});

test('carries on after a reload from what the session state holds', async ($, on) => {
  const { clock, compacted } = engine(on, {
    tracker: {
      lastModelCallAt: 0,
      contextTokens: 150_000,
      backgroundTasks: [{ id: 'b1', type: 'shell' }],
      hasCompacted: false,
    },
  });
  // A reload: the module starts afresh, and no turn runs.
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true });

  await clock.advance(55 * MINUTE + 5_000);
  expect(compacted.count).toBe(1);
});

test('forgets what it tracked on /clear', async ($, on) => {
  const { clock, compacted, state } = engine(on);
  await turn($, [SHELL]);
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } });

  await clock.advance(120 * MINUTE);
  expect(compacted.count).toBe(0);
  expect(state.value?.lastModelCallAt).toBe(null);
});
