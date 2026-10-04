import type { On, PromptOrigin, RenderElement } from 'claude-code';
import type { Engine, MockClock } from 'claude-code/testing';
import { expect, mock, test } from 'claude-code/testing';

import type { PromptQueue } from '../types';

const EMPTY: PromptQueue = { prompts: [], isPaused: false };
const COMPOSER: PromptOrigin = { kind: 'composer' };
const PRESENTATION = { isFullscreen: false, columns: 120 };
const BAND = {
  hasSurvey: false,
  isWorking: true,
  maxRows: 20,
  bodyColumns: 100,
  scroll: { offset: 0, bodyRows: 20 },
  view: {},
};

// Stands in for the engine beneath the plugin: the session state, the
// prompts that reach the session (the person's, and the plugin's own with
// `asUser`), and a plugin prompt's turn starting at once unless `isHolding`,
// when each waits for `release()` (the session not yet idle).
function engine(on: On, { isHolding = false }: { isHolding?: boolean } = {}) {
  const clock = mock.clock(on, { now: 0 });
  const state = { value: EMPTY, version: 1 };
  on('state.get', () => ({ value: { value: state.value, version: state.version } }));
  on('state.set', (_$, e) => {
    if (e.ifVersion !== undefined && e.ifVersion !== state.version) {
      return { value: { isSet: false, version: state.version } };
    }
    state.value = e.value as PromptQueue;
    state.version++;
    return { value: { isSet: true, version: state.version } };
  });
  const entered: string[] = [];
  const sent: string[] = [];
  const held: (() => void)[] = [];
  on('prompt.submit', async (_$, e) => {
    if (e.origin.kind !== 'plugin') {
      entered.push(e.text);
      return { text: e.text };
    }
    if (isHolding) await new Promise<void>(resolve => held.push(resolve));
    sent.push(e.text);
    return { text: e.text };
  });
  on('session.start', (_$, e) => ({ cwd: e.cwd }));
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }));
  on('command.register', (_$, e) => ({ value: { command: e.name } }));
  on('command.run', () => ({ text: 'unhandled' }));
  // The engine's own band: nothing drawn.
  on('ui.render', () => ({ type: 'Box', props: {}, children: [] }) as RenderElement);
  on('turn.start', (_$, e) => ({ turnId: e.turnId }));
  on('turn.complete', (_$, e) => ({ text: e.answer }));
  const logged: string[] = [];
  on('ui.toast', () => ({ value: undefined }));
  on('ui.log', (_$, e) => {
    logged.push(e.text);
    return { value: undefined };
  });
  const release = async () => {
    for (const resolve of held.splice(0)) resolve();
    await settle();
  };
  return { clock, state, entered, sent, logged, release };
}

async function start($: Engine) {
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true });
  await $.turn.start({ text: 'go', turnId: 't1' });
}

function typed($: Engine, text: string, { wait }: { wait: boolean }) {
  return $.prompt.submit({ text, wait, turnId: 't1', origin: COMPOSER });
}

function endTurn($: Engine, reason: 'answer' | 'aborted' = 'answer', turnId = 't1') {
  return $.turn.complete({ answer: '', durationMs: 1, isAborted: reason === 'aborted', turnId, reason });
}

function queueCommand($: Engine, args: string, command = 'queue') {
  return $.command.run({ command, args, origin: COMPOSER, presentation: PRESENTATION });
}

// Lets the unawaited submission settle.
async function settle() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

// A command's send waits on a timer: runs it, then lets the send settle.
async function flush(clock: MockClock) {
  await clock.advance(0);
  await settle();
}

test('a queued prompt (ctrl+x enter) mid-turn is held, and sent as the person once the turn ends', async ($, on) => {
  const { entered, sent } = engine(on);
  await start($);

  const result = await typed($, 'then run the tests', { wait: true });
  expect(result).toEqual({ drop: expect.any(String) });
  expect(entered).toEqual([]);

  await endTurn($);
  await settle();
  expect(sent).toEqual(['then run the tests']);
});

test('a plain Enter mid-turn still steers the running turn', async ($, on) => {
  const { entered, sent } = engine(on);
  await start($);

  await typed($, 'actually use pnpm', { wait: false });
  expect(entered).toEqual(['actually use pnpm']);

  await endTurn($);
  await settle();
  expect(sent).toEqual([]);
});

test('sends one queued prompt per turn end, oldest first', async ($, on) => {
  const { sent } = engine(on);
  await start($);
  await typed($, 'first', { wait: true });
  await typed($, 'second', { wait: true });

  await endTurn($);
  await settle();
  expect(sent).toEqual(['first']);

  await $.turn.start({ text: 'first', turnId: 't2' });
  await endTurn($, 'answer', 't2');
  await settle();
  expect(sent).toEqual(['first', 'second']);
});

test('a steering prompt that runs first does not let a second queued prompt through', async ($, on) => {
  const { sent, release } = engine(on, { isHolding: true });
  await start($);
  await typed($, 'first', { wait: true });
  await typed($, 'second', { wait: true });

  await endTurn($);
  // The steering prompt waiting in the engine runs its own turn first.
  await $.turn.start({ text: 'steer', turnId: 't2' });
  await endTurn($, 'answer', 't2');
  await release();
  expect(sent).toEqual(['first']);
});

test('an interrupted turn pauses the queue until /queue-resume', async ($, on) => {
  const { clock, sent, state } = engine(on);
  await start($);
  await typed($, 'later', { wait: true });

  await endTurn($, 'aborted');
  await settle();
  expect(sent).toEqual([]);
  expect(state.value.isPaused).toBe(true);

  await queueCommand($, '', 'queue-resume');
  await flush(clock);
  expect(sent).toEqual(['later']);
});

test('a turn that ends with an answer resumes a paused queue', async ($, on) => {
  const { sent } = engine(on);
  await start($);
  await typed($, 'later', { wait: true });
  await endTurn($, 'aborted');

  await $.turn.start({ text: 'something else', turnId: 't2' });
  await endTurn($, 'answer', 't2');
  await settle();
  expect(sent).toEqual(['later']);
});

test('/queue mid-turn queues; /queue while idle sends at once', async ($, on) => {
  const { clock, sent, logged } = engine(on);
  await start($);

  const queued = await queueCommand($, 'mid-turn prompt');
  expect(queued.text).toMatch(/queued as #1/);
  expect(sent).toEqual([]);

  await endTurn($);
  await settle();
  expect(sent).toEqual(['mid-turn prompt']);

  await $.turn.start({ text: 'mid-turn prompt', turnId: 't2' });
  await endTurn($, 'answer', 't2');
  const idle = await queueCommand($, 'idle prompt');
  await flush(clock);
  expect(logged).toEqual([]);
  expect(idle.text).toMatch(/sent/);
  expect(sent).toEqual(['mid-turn prompt', 'idle prompt']);
});

test('a queued submit while idle enters as usual', async ($, on) => {
  const { entered } = engine(on);
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true });

  await $.prompt.submit({ text: 'hello', wait: true, origin: COMPOSER });
  expect(entered).toEqual(['hello']);
});

test('/queue lists, /queue-clear drops', async ($, on) => {
  const { sent } = engine(on);
  await start($);
  await typed($, 'one', { wait: true });
  await queueCommand($, 'two');

  expect((await queueCommand($, '')).text).toMatch(/2 prompts queued[\s\S]*1\. one[\s\S]*2\. two/);
  expect((await queueCommand($, '', 'queue-clear')).text).toMatch(/dropped 2 prompts/);

  await endTurn($);
  await settle();
  expect(sent).toEqual([]);
});

test('the band above the prompt lists the queue, on every surface that has it', async ($, on) => {
  engine(on);
  await start($);
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'prompt-queue', surface, component: 'AbovePrompt', props: BAND });
    expect(await ui.find({ type: 'Text', text: /Queued/ })).toBe(undefined);
    await ui.unmount();
  }

  await typed($, 'run the linter', { wait: true });
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'prompt-queue', surface, component: 'AbovePrompt', props: BAND });
    expect(await ui.find({ type: 'Text', text: 'Queued: 1 prompt · sent after the turn ends' })).toBeDefined();
    expect(await ui.find({ type: 'Text', text: '1. run the linter' })).toBeDefined();
    await ui.unmount();
  }
});
