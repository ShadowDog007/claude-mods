import type { ContextCategory, On } from 'claude-code';
import type { Engine } from 'claude-code/testing';
import { expect, test } from 'claude-code/testing';

import { allocate, bar, barWidth, formatTokens, legend, segments, stepGrowth, turnGrowth } from './register';

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
    ['System', 3_000],
    ['Messages', 24_000],
    ['Turn', 10_000],
    ['Free', 163_000],
  ]);
  // Never more than the conversation holds.
  expect(segments(rows, 50_000).find(p => p.name === 'Turn')?.tokens).toBe(34_000);
});

test('draws one segment for the system prompt and tools, skills before memory, free space before the buffer', () => {
  const rows = {
    window: WINDOW,
    slices: [
      { name: 'System prompt', tokens: 3_000, color: 'promptBorder', kind: 'used' as const },
      { name: 'System tools', tokens: 17_000, color: 'inactive', kind: 'used' as const },
      { name: 'Custom agents', tokens: 1_000, color: 'permission', kind: 'used' as const },
      { name: 'Memory files', tokens: 500, color: 'claude', kind: 'used' as const },
      { name: 'Skills', tokens: 2_000, color: 'warning', kind: 'used' as const },
      { name: 'Autocompact buffer', tokens: 33_000, color: 'inactive', kind: 'buffer' as const },
      { name: 'Free space', tokens: 146_000, color: 'promptBorder', kind: 'free' as const },
    ],
  };
  expect(segments(rows, null).map(p => [p.name, p.tokens, p.color])).toEqual([
    ['System', 20_000, 'promptBorder'],
    ['Agents', 1_000, 'permission'],
    ['Skills', 2_000, 'warning'],
    ['Memory', 500, 'claude'],
    ['Free', 146_000, 'promptBorder'],
    ['Buffer', 33_000, 'inactive'],
  ]);
});

test('keeps the legend to one line, dropping tokens and then names', () => {
  const rows = {
    window: WINDOW,
    slices: CATEGORIES.filter(c => c.kind !== 'deferred').map(({ name, tokens, color, kind }) => ({
      name,
      tokens,
      color,
      kind: kind as 'used' | 'free' | 'buffer',
    })),
  };
  const parts = segments(rows, 12_500);
  expect(legend(parts, 80).map(item => item.label)).toEqual([
    'System 20k',
    'MCP 4.0k',
    'Skills 2.0k',
    'Messages 22k',
    'Turn 13k',
    'Free 107k',
    'Buffer 33k',
  ]);
  expect(legend(parts, 60).map(item => item.label)).toEqual(['System', 'MCP', 'Skills', 'Messages', 'Turn', 'Free', 'Buffer']);
  expect(legend(parts, 40).map(item => item.label)).toEqual(['System', 'MCP', 'Skills', 'Messages', 'Turn']);
});

test('caps the bar beside its summary', () => {
  expect(barWidth(200, 14)).toBe(60);
  expect(barWidth(50, 14)).toBe(35);
  expect(barWidth(12, 14)).toBe(10);
});

test('draws boundaries over content only, as one marker per cell, at a fixed width', () => {
  const parts = [
    { name: 'Messages', tokens: 50, color: 'claude', kind: 'used' as const },
    { name: 'Free', tokens: 50, color: 'promptBorder', kind: 'free' as const },
  ];
  const marks = [
    { tokens: 20, kind: 'step' as const },
    { tokens: 21, kind: 'turn' as const },
    { tokens: 22, kind: 'step' as const },
    { tokens: 40, kind: 'step' as const },
    // In the free space: not drawn.
    { tokens: 70, kind: 'turn' as const },
    ...Array.from({ length: 400 }, (_, index) => ({ tokens: 41 + (index % 9), kind: 'step' as const })),
  ];
  const runs = bar(parts, [10, 10], marks);
  const text = runs.map(run => run.text).join('');
  expect(text).toBe('████┃███││░░░░░░░░░░');
  expect(runs.length).toBeLessThanOrEqual(20);
});

test('counts what a turn and each of its steps added', () => {
  const current = {
    contextBefore: 40_000,
    steps: [
      { context: 41_000, output: 200 },
      { context: 47_000, output: 300 },
      { context: 52_000, output: 1_000 },
    ],
    compactedAt: null,
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
    expect(await ui.find({ type: 'Text', text: /System/ })).toBe(undefined);
    await ui.unmount();
  }
});

test('draws the bar, a legend by category, and the last turn', async ($, on) => {
  const { contexts } = engine(on);
  await turn($, contexts, [41_000, 47_000, 52_000]);

  for (const surface of SURFACES) {
    const ui = await $.ui.mount(band(surface));
    expect(await ui.find({ type: 'Text', text: /System 20k/ })).toBeDefined();
    expect(await ui.find({ type: 'Text', text: /MCP 4\.0k/ })).toBeDefined();
    expect(await ui.find({ type: 'Text', text: /Turn 13k/ })).toBeDefined();
    expect(await ui.find({ type: 'Text', text: /60k\/200k \(30%\)/ })).toBeDefined();
    expect(await ui.find({ type: 'Text', text: /deferred/ })).toBe(undefined);
    expect(
      await ui.find({ type: 'Text', text: 'Last turn: 3 steps · context 40k → 52k (+13k) · 1.5k out · steps +1.0k +6.0k +5.0k' }),
    ).toBeDefined();

    // The turn starts at 40k of 200k, its later steps at 47k and 52k: cells
    // 12, 14 and 15 of 60.
    const drawn = (await ui.find({ key: 'bar' }))!.text;
    expect(drawn.length).toBe(60);
    expect([drawn[12], drawn[14], drawn[15]]).toEqual(['┃', '│', '│']);
    expect(drawn.split('').filter(cell => cell === '┃' || cell === '│')).toHaveLength(3);
    await ui.unmount();
  }
});

test('counts a turn compacted partway from where the compaction left it', async ($, on) => {
  const { contexts } = engine(on);
  await turn($, contexts, [45_000, 12_000, 15_000]);

  for (const surface of SURFACES) {
    const ui = await $.ui.mount(band(surface));
    expect(
      await ui.find({
        type: 'Text',
        text: 'Last turn: 3 steps · context 40k → compacted 12k → 15k (+3.5k) · 1.5k out · steps +5.0k compacted +3.0k',
      }),
    ).toBeDefined();
    await ui.unmount();
  }
});

test('yields the band to a survey', async ($, on) => {
  const { contexts } = engine(on);
  await turn($, contexts, [41_000]);
  for (const surface of SURFACES) {
    const target = band(surface);
    const ui = await $.ui.mount({ ...target, props: { ...target.props, hasSurvey: true } });
    expect(await ui.find({ type: 'Text', text: /System/ })).toBe(undefined);
    await ui.unmount();
  }
});

test('forgets the conversation on /clear', async ($, on) => {
  const { contexts } = engine(on);
  await turn($, contexts, [41_000]);
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } });
  const ui = await $.ui.mount(band('terminal'));
  expect(await ui.find({ type: 'Text', text: /System/ })).toBe(undefined);
  await ui.unmount();
});
