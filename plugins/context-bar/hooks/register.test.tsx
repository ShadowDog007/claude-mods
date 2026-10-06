import type { ContextCategory, On } from 'claude-code';
import type { Engine } from 'claude-code/testing';
import { expect, test } from 'claude-code/testing';

import { allocate, formatTokens, segments, stepGrowth, turnGrowth } from './register';

const WINDOW = 200_000;
const SURFACES = ['terminal', 'desktop'] as const;

function row(name: string, tokens: number, color: string, kind: ContextCategory['kind'] = 'used'): ContextCategory {
  return { name, tokens, color, kind, isDeferred: kind === 'deferred' };
}

const CATEGORIES = [
  row('System prompt', 3_000, 'promptBorder'),
  row('System tools', 17_000, 'inactive'),
  row('MCP tools', 4_000, 'cyan_FOR_SUBAGENTS_ONLY'),
  row('Skills', 2_000, 'warning'),
  row('Messages', 34_000, 'purple_FOR_SUBAGENTS_ONLY'),
  row('MCP tools (deferred)', 9_000, 'inactive', 'deferred'),
  row('Free space', 107_000, 'promptBorder', 'free'),
  row('Autocompact buffer', 33_000, 'inactive', 'buffer'),
];

// Stands in for the engine beneath the plugin: a session whose context breaks
// down as `CATEGORIES`, and a model whose every request is answered over the
// next of `contexts` tokens of input.
function engine(on: On) {
  const state = new Map<string, { value: unknown; version: number }>();
  on('state.get', (_$, e) => {
    const entry = state.get(e.key);
    return { value: entry ?? { value: undefined, version: 0 } };
  });
  on('state.set', (_$, e) => {
    const version = (state.get(e.key)?.version ?? 0) + 1;
    state.set(e.key, { value: e.value, version });
    return { value: { isSet: true, version } };
  });
  on('session.start', (_$, e) => ({ cwd: e.cwd }));
  on('session.measure', (_$, e) => ({ changed: e.changed }));
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }));
  on('turn.start', (_$, e) => ({ turnId: e.turnId }));
  on('turn.complete', () => ({ text: '' }));
  on('ui.log', () => ({ value: undefined }));
  // The engine's own band: empty.
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e);
    return <Box key="engine" />;
  });
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      rateLimits: [],
      context: {
        tokens: 60_000,
        window: WINDOW,
        percent: 30,
        breakdown: {
          categories: CATEGORIES,
          totalTokens: 60_000,
          maxTokens: WINDOW,
          rawMaxTokens: WINDOW,
          autocompactSource: 'auto' as const,
          percentage: 30,
          gridRows: [],
          model: 'claude-opus-5-5',
          memoryFiles: [],
          mcpTools: [],
          agents: [],
          isAutoCompactEnabled: true,
          apiUsage: null,
        },
      },
    },
  }));
  const contexts: number[] = [];
  on('turn.step', async function* (_$, e) {
    const context = contexts.shift() ?? 0;
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn',
      usage: {
        model: 'claude-opus-5-5',
        input_tokens: 10,
        cache_read_input_tokens: context - 110,
        cache_creation_input_tokens: 100,
        output_tokens: 500,
      },
    };
  });
  return { contexts };
}

async function measure($: Engine, tokens: number) {
  await $.session.measure({ context: { tokens, window: WINDOW }, rateLimits: [], changed: ['context'] });
}

// A finished turn from 40k of context, over three requests.
async function turn($: Engine, contexts: number[], steps: number[]) {
  contexts.push(...steps);
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true });
  await measure($, 40_000);
  await $.turn.start({ text: 'go', turnId: 't1' });
  for (const [index] of steps.entries()) {
    for await (const _ of $.turn.step({ turnId: 't1', index, model: 'm', messageCount: 1 }));
    await measure($, steps[index]!);
  }
  await $.turn.complete({ turnId: 't1', answer: '', durationMs: 1, isAborted: false } as never);
}

function band(surface: (typeof SURFACES)[number], bodyColumns = 80) {
  return {
    plugin: 'context-bar',
    surface,
    component: 'AbovePrompt' as const,
    props: {
      hasSurvey: false,
      isWorking: false,
      maxRows: 20,
      bodyColumns,
      scroll: { offset: 0, bodyRows: 20 },
      view: {},
    },
  };
}

test('fills the bar to the band width, every category given a cell', () => {
  const rows = {
    window: WINDOW,
    slices: CATEGORIES.filter(c => c.kind !== 'deferred').map(({ name, tokens, color, kind }) => ({
      name,
      tokens,
      color,
      kind: kind as 'used' | 'free' | 'buffer',
    })),
  };
  const parts = segments(rows, 5_000);
  const counts = allocate(
    parts.map(p => p.tokens),
    40,
    parts.map(p => p.kind === 'used' || p.kind === 'turn'),
  );
  expect(counts.reduce((a, b) => a + b, 0)).toBe(40);
  for (const [index, part] of parts.entries()) {
    if (part.kind === 'used' || part.kind === 'turn') expect(counts[index]).toBeGreaterThan(0);
  }
});

test('carves the last turn off the end of the conversation', () => {
  const rows = {
    window: WINDOW,
    slices: [
      { name: 'System prompt', tokens: 3_000, color: 'promptBorder', kind: 'used' as const },
      { name: 'Messages', tokens: 34_000, color: 'claude', kind: 'used' as const },
      { name: 'Free space', tokens: 163_000, color: 'promptBorder', kind: 'free' as const },
    ],
  };
  expect(segments(rows, 10_000).map(p => [p.name, p.tokens])).toEqual([
    ['System prompt', 3_000],
    ['Messages', 24_000],
    ['Last turn', 10_000],
    ['Free space', 163_000],
  ]);
  // Never more than the conversation holds.
  expect(segments(rows, 50_000).find(p => p.name === 'Last turn')?.tokens).toBe(34_000);
});

test('counts what a turn and each of its steps added', () => {
  const current = {
    contextBefore: 40_000,
    steps: [
      { context: 41_000, output: 200 },
      { context: 47_000, output: 300 },
      { context: 52_000, output: 1_000 },
    ],
    isRunning: false,
  };
  expect(turnGrowth(current)).toBe(13_000);
  expect(stepGrowth(current)).toEqual([1_000, 6_000, 5_000]);
  expect(turnGrowth({ ...current, contextBefore: null })).toBe(null);
});

test('formats token counts compactly', () => {
  expect(formatTokens(850)).toBe('850');
  expect(formatTokens(3_240)).toBe('3.2k');
  expect(formatTokens(42_400)).toBe('42k');
  expect(formatTokens(1_200_000)).toBe('1.2M');
});

test('draws nothing before the context is measured', async ($, on) => {
  engine(on);
  for (const surface of SURFACES) {
    const ui = await $.ui.mount(band(surface));
    expect(await ui.find({ type: 'Text', text: /System prompt/ })).toBe(undefined);
    await ui.unmount();
  }
});

test('draws the bar, a legend by category, and the last turn', async ($, on) => {
  const { contexts } = engine(on);
  await turn($, contexts, [41_000, 47_000, 52_000]);

  for (const surface of SURFACES) {
    const ui = await $.ui.mount(band(surface));
    expect(await ui.find({ type: 'Text', text: /System tools 17k/ })).toBeDefined();
    expect(await ui.find({ type: 'Text', text: /MCP tools 4\.0k/ })).toBeDefined();
    expect(await ui.find({ type: 'Text', text: /Last turn 13k/ })).toBeDefined();
    expect(await ui.find({ type: 'Text', text: /deferred/ })).toBe(undefined);
    expect(
      await ui.find({ type: 'Text', text: 'Last turn: 3 steps · context 40k → 52k (+13k) · 1.5k out · steps +1.0k +6.0k +5.0k' }),
    ).toBeDefined();

    const bar = (await ui.find({ key: 'bar' }))!;
    expect(bar.text.length).toBe(80);
    await ui.unmount();
  }
});

test('yields the band to a survey', async ($, on) => {
  const { contexts } = engine(on);
  await turn($, contexts, [41_000]);
  for (const surface of SURFACES) {
    const target = band(surface);
    const ui = await $.ui.mount({ ...target, props: { ...target.props, hasSurvey: true } });
    expect(await ui.find({ type: 'Text', text: /System prompt/ })).toBe(undefined);
    await ui.unmount();
  }
});

test('forgets the conversation on /clear', async ($, on) => {
  const { contexts } = engine(on);
  await turn($, contexts, [41_000]);
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } });
  const ui = await $.ui.mount(band('terminal'));
  expect(await ui.find({ type: 'Text', text: /System prompt/ })).toBe(undefined);
  await ui.unmount();
});
