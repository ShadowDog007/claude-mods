import type { On } from 'claude-code';
import type { Engine } from 'claude-code/testing';
import { expect, mock, test } from 'claude-code/testing';

import type { IdleCompactTracker } from '../types';

const MINUTE = 60_000;
const SHELL = { id: 'b1', type: 'shell', status: 'running', description: 'npm run dev' };
// A subscription within its plan's usage, whose cache lives an hour.
const SUBSCRIPTION = [{ kind: 'five_hour', percentUsed: 20 }];
const IDLE: IdleCompactTracker = {
  lastModelCallAt: null,
  contextTokens: null,
  backgroundTasks: [],
  hasCompacted: false,
  isIdle: false,
  rateLimits: null,
};

// Stands in for the engine beneath the plugin: a session, a model request
// that answers at once, a compaction that counts its calls (and fails when
// `isFailing`), the environment and settings it reads, and the session state,
// holding `tracker` as a reload finds what the module before it wrote. It
// starts from the idle tracker, which the plugin reads the same as nothing
// written.
function engine(
  on: On,
  {
    isFailing = false,
    tracker = IDLE,
    env = {},
    settings = {},
  }: {
    isFailing?: boolean;
    tracker?: IdleCompactTracker;
    env?: Record<string, string>;
    settings?: Record<string, unknown>;
  } = {},
) {
  const clock = mock.clock(on, { now: 0 });
  mock.env(on, env);
  on('settings.read', () => ({ value: settings }));
  on('command.register', (_$, e) => ({ value: { command: e.name } }));
  const compacted = { count: 0 };
  const status: { text: string | undefined } = { text: undefined };
  on('ui.status', (_$, e) => {
    status.text = e.text;
    return { value: undefined };
  });
  on('ui.toast', () => ({ value: undefined }));
  const slots = new Map<string, { value: unknown; version: number }>([['tracker', { value: tracker, version: 1 }]]);
  const state = {
    get value() {
      return slots.get('tracker')?.value as IdleCompactTracker | undefined;
    },
  };
  on('state.get', (_$, e) => ({ value: slots.get(e.key) ?? { value: undefined, version: 0 } }));
  on('state.set', (_$, e) => {
    const version = slots.get(e.key)?.version ?? 0;
    if (e.ifVersion !== undefined && e.ifVersion !== version) return { value: { isSet: false, version } };
    slots.set(e.key, { value: e.value, version: version + 1 });
    return { value: { isSet: true, version: version + 1 } };
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
  return { clock, compacted, state, status };
}

// One finished turn: a model request over `tokens` of context, leaving
// `backgroundTasks` running, on a session whose usage windows read `rateLimits`.
async function turn(
  $: Engine,
  backgroundTasks: (typeof SHELL)[],
  { tokens = 150_000, rateLimits = SUBSCRIPTION }: { tokens?: number; rateLimits?: typeof SUBSCRIPTION } = {},
) {
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true });
  await $.turn.start({ text: 'go', turnId: 't1' });
  const step = $.turn.step({ turnId: 't1', index: 0, model: 'm', messageCount: 1 });
  for await (const _ of step);
  await $.session.measure({ context: { tokens, window: 200_000 }, rateLimits, changed: ['context'] });
  await $.classic.Stop({ stop_hook_active: false, background_tasks: backgroundTasks });
}

async function command($: Engine, args: string) {
  const ran = await $.command.run({
    command: 'idle-compact',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 120 },
  } as never);
  return (ran as { text?: string }).text;
}

// The minute it first compacts within two hours, or null when it does not.
async function compactsAfter(clock: { advance(ms: number): Promise<void> }, compacted: { count: number }) {
  for (let minute = 1; minute <= 120; minute++) {
    await clock.advance(MINUTE);
    if (compacted.count > 0) return minute;
  }
  return null;
}

test('compacts once, exactly 59 idle minutes after the last model request, with a background command running', async ($, on) => {
  const { clock, compacted } = engine(on);
  await turn($, [SHELL]);

  await clock.advance(59 * MINUTE - 1);
  expect(compacted.count).toBe(0);

  await clock.advance(1);
  expect(compacted.count).toBe(1);

  await clock.advance(120 * MINUTE);
  expect(compacted.count).toBe(1);
});

test('compacts after 4 idle minutes under the five-minute cache of an API key', async ($, on) => {
  const { clock, compacted } = engine(on);
  await turn($, [SHELL], { rateLimits: [] });

  await clock.advance(4 * MINUTE - 1);
  expect(compacted.count).toBe(0);

  await clock.advance(1);
  expect(compacted.count).toBe(1);
});

test('takes the five-minute cache once the subscription is past its plan usage', async ($, on) => {
  const { clock, compacted } = engine(on);
  await turn($, [SHELL], { rateLimits: [{ kind: 'five_hour', percentUsed: 100 }] });

  expect(await compactsAfter(clock, compacted)).toBe(4);
});

// What forces the cache's lifetime, strongest first, each over what follows it.
const FORCED: [string, Parameters<typeof engine>[1], typeof SUBSCRIPTION, number][] = [
  ['FORCE_PROMPT_CACHING_5M', { env: { FORCE_PROMPT_CACHING_5M: '1', CLAUDE_CODE_PROMPT_CACHE_TTL: '1h' } }, SUBSCRIPTION, 4],
  ['CLAUDE_CODE_PROMPT_CACHE_TTL', { env: { CLAUDE_CODE_PROMPT_CACHE_TTL: '1h' }, settings: { promptCacheTtl: '5m' } }, [], 59],
  ['the promptCacheTtl setting', { settings: { promptCacheTtl: '5m' }, env: { ENABLE_PROMPT_CACHING_1H: '1' } }, SUBSCRIPTION, 4],
  ['ENABLE_PROMPT_CACHING_1H', { env: { ENABLE_PROMPT_CACHING_1H: '1' } }, [], 59],
];
for (const [name, given, rateLimits, minutes] of FORCED) {
  test(`compacts after ${minutes} idle minutes when ${name} sets the cache's lifetime`, async ($, on) => {
    const { clock, compacted } = engine(on, given);
    await turn($, [SHELL], { rateLimits });

    expect(await compactsAfter(clock, compacted)).toBe(minutes);
  });
}

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
  await turn($, [SHELL], { tokens: 99_999 });

  await clock.advance(120 * MINUTE);
  expect(compacted.count).toBe(0);
});

test(
  'honours a configured idle time and context threshold, whatever the cache',
  { options: { idleMinutes: 10, minContextTokens: 20_000 } },
  async ($, on) => {
    const { clock, compacted } = engine(on);
    await turn($, [SHELL], { tokens: 30_000, rateLimits: [] });

    await clock.advance(10 * MINUTE - 1);
    expect(compacted.count).toBe(0);

    await clock.advance(1);
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
    isIdle: true,
    rateLimits: SUBSCRIPTION,
  });
});

test('carries on after a reload from what the session state holds', async ($, on) => {
  const { clock, compacted } = engine(on, {
    tracker: {
      lastModelCallAt: 0,
      contextTokens: 150_000,
      backgroundTasks: [{ id: 'b1', type: 'shell' }],
      hasCompacted: false,
      isIdle: true,
      rateLimits: SUBSCRIPTION,
    },
  });
  // A reload: the module starts afresh, and no turn runs.
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true });

  await clock.advance(59 * MINUTE);
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

test('pins when it will compact while idle, and clears it when a turn starts', async ($, on) => {
  const { status } = engine(on);
  await turn($, [SHELL]);
  expect(status.text).toMatch(/^idle-compact scheduled for \d\d:\d\d$/);

  await $.turn.start({ text: 'next', turnId: 't2' });
  expect(status.text).toBe(undefined);
});

test('clears the schedule once it compacts', async ($, on) => {
  const { clock, status } = engine(on);
  await turn($, [SHELL]);

  await clock.advance(59 * MINUTE);
  expect(status.text).toBe(undefined);
});

test('pins nothing when it would not compact', async ($, on) => {
  const { status } = engine(on);
  await turn($, [SHELL], { tokens: 99_999 });
  expect(status.text).toBe(undefined);

  await turn($, []);
  expect(status.text).toBe(undefined);
});

test('/idle-compact on compacts an idle session with no background work', async ($, on) => {
  const { clock, compacted } = engine(on);
  await turn($, []);
  // Switched on while idle, it arms at once.
  expect(await command($, 'on')).toBe(
    'idle-compact is on: compacts after 59 idle minutes whenever the session sits idle (one-hour prompt cache)',
  );

  expect(await compactsAfter(clock, compacted)).toBe(59);
});

test('/idle-compact on does not compact while a turn runs', async ($, on) => {
  const { clock, compacted } = engine(on);
  await turn($, []);
  await $.turn.start({ text: 'next', turnId: 't2' });
  await command($, 'on');

  await clock.advance(120 * MINUTE);
  expect(compacted.count).toBe(0);
});

test('/idle-compact off stops it for the session, through a /clear, until switched back', async ($, on) => {
  const { clock, compacted, status } = engine(on);
  await turn($, [SHELL]);
  expect(await command($, 'off')).toBe('idle-compact is off for this session');
  expect(status.text).toBe(undefined);

  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } });
  await turn($, [SHELL]);
  await clock.advance(120 * MINUTE);
  expect(compacted.count).toBe(0);

  await command($, 'auto');
  await turn($, [SHELL]);
  expect(await compactsAfter(clock, compacted)).toBe(59);
});

test('/idle-compact says what it is set to, and how it is used', async ($, on) => {
  engine(on);
  await turn($, [], { rateLimits: [] });

  expect(await command($, '')).toBe(
    'idle-compact is auto: compacts after 4 idle minutes while background work runs (five-minute prompt cache)',
  );
  expect(await command($, 'sometimes')).toBe('Usage: /idle-compact [auto|on|off]');
  expect(await command($, ' ON ')).toMatch(/^idle-compact is on:/);
});
