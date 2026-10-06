import type { ContextCategory, On } from 'claude-code';
import type { Engine } from 'claude-code/testing';
import { expect, test } from 'claude-code/testing';

import { allocate, legend, segments, turnLine } from './register';
import { describe, fitMiddle, formatTokens, reminderTokens, sizeBar, tableColumns, toolResults } from './tools';

const WINDOW = 200_000;

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

// `CATEGORIES` as the plugin keeps them: the deferred rows left out.
const ROWS = {
  window: WINDOW,
  slices: CATEGORIES.filter(c => c.kind !== 'deferred').map(({ name, tokens, color, kind }) => ({
    name,
    tokens,
    color,
    kind: kind as 'used' | 'free' | 'buffer',
  })),
};

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
  on('command.register', (_$, e) => ({ value: { command: e.name } }));
  // The conversation in API form, as `messages` holds it, in /repo.
  const messages: { role: 'user' | 'assistant'; content: { type: string; [field: string]: unknown }[] }[] = [];
  on('session.messages', () => ({ value: messages }));
  on('session.cwd', () => ({ value: '/repo' }));
  // Every pane is placed; `opened` lists them.
  const opened: { id: string; columns?: number }[] = [];
  on('ui.open', (_$, e) => {
    opened.push({ id: e.id, columns: e.columns });
    return { value: { isPlaced: true as const } };
  });
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
  return { contexts, messages, opened };
}

async function start($: Engine) {
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true });
}

async function measure($: Engine, tokens: number) {
  await $.session.measure({ context: { tokens, window: WINDOW }, rateLimits: [], changed: ['context'] });
}

// A finished turn from 40k of context, a request answered over each of `steps`.
async function turn($: Engine, contexts: number[], steps: number[]) {
  contexts.push(...steps);
  await start($);
  await measure($, 40_000);
  await $.turn.start({ text: 'go', turnId: 't1' });
  for (const [index, context] of steps.entries()) {
    for await (const _ of $.turn.step({ turnId: 't1', index, model: 'm', messageCount: 1 }));
    await measure($, context);
  }
  await $.turn.complete({ turnId: 't1', answer: '', durationMs: 1, isAborted: false } as never);
}

function band(bodyColumns = 80, hasSurvey = false) {
  return {
    plugin: 'context-bar',
    surface: 'terminal' as const,
    component: 'AbovePrompt' as const,
    props: { hasSurvey, isWorking: false, maxRows: 20, bodyColumns, scroll: { offset: 0, bodyRows: 20 }, view: {} },
  };
}

test('gives every kind of content at least one cell, the rest in proportion', () => {
  expect(allocate([10_000, 1, 1], 10, [true, true, true])).toEqual([8, 1, 1]);
  expect(allocate([10_000, 1], 10, [true, false])).toEqual([10, 0]);
});

test('carves the last turn off the end of the conversation, in a colour no other segment uses', () => {
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
  // Skills draws in the first colour the turn could; the turn takes the next.
  expect(segments(ROWS, 12_500).find(p => p.name === 'Turn')?.color).toBe('suggestion');
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
  const parts = segments(ROWS, 12_500);
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

test('marks a step with nothing to compare against with ?', () => {
  const current = {
    contextBefore: null,
    steps: [
      { context: 41_000, output: 200 },
      { context: 47_000, output: 300 },
      { context: 52_000, output: 1_000 },
    ],
    compactedAt: null,
    isRunning: false,
  };
  expect(turnLine(current)).toBe('Last turn: 3 steps · context 52k · 1.5k out · steps ? +6.0k +5.0k');
});

test('formats token counts compactly', () => {
  expect(formatTokens(850)).toBe('850');
  expect(formatTokens(3_240)).toBe('3.2k');
  expect(formatTokens(42_400)).toBe('42k');
  expect(formatTokens(1_200_000)).toBe('1.2M');
});

test('draws nothing before the context is measured', async ($, on) => {
  engine(on);
  const ui = await $.ui.mount(band());
  expect(await ui.find({ type: 'Text', text: /System/ })).toBe(undefined);
  await ui.unmount();
});

test('draws the bar, a legend by category, and the last turn', async ($, on) => {
  const { contexts } = engine(on);
  await turn($, contexts, [41_000, 47_000, 52_000]);

  const ui = await $.ui.mount(band());
  expect(await ui.find({ type: 'Text', text: /System 20k/ })).toBeDefined();
  expect(await ui.find({ type: 'Text', text: /MCP 4\.0k/ })).toBeDefined();
  expect(await ui.find({ type: 'Text', text: /Turn 13k/ })).toBeDefined();
  expect(await ui.find({ type: 'Text', text: /60k\/200k \(30%\)/ })).toBeDefined();
  expect(await ui.find({ type: 'Text', text: /deferred/ })).toBe(undefined);
  expect(
    await ui.find({ type: 'Text', text: 'Last turn: 3 steps · context 40k → 52k (+13k) · 1.5k out · steps +1.0k +6.0k +5.0k' }),
  ).toBeDefined();
  // The 65 cells beside the summary: content, free space, buffer.
  const drawn = (await ui.find({ key: 'bar' }))!.text;
  expect(drawn.length).toBe(65);
  expect(drawn).toMatch(/^█+░+▒+$/);
  await ui.unmount();

  // Never narrower than ten cells.
  const narrow = await $.ui.mount(band(20));
  expect((await narrow.find({ key: 'bar' }))!.text.length).toBe(10);
  await narrow.unmount();
});

test('counts a turn compacted partway from where the compaction left it', async ($, on) => {
  const { contexts } = engine(on);
  await turn($, contexts, [45_000, 12_000, 15_000]);

  const ui = await $.ui.mount(band());
  expect(
    await ui.find({
      type: 'Text',
      text: 'Last turn: 3 steps · context 40k → compacted 12k → 15k (+3.5k) · 1.5k out · steps +5.0k compacted +3.0k',
    }),
  ).toBeDefined();
  await ui.unmount();
});

test('yields the band to a survey', async ($, on) => {
  const { contexts } = engine(on);
  await turn($, contexts, [41_000]);
  const ui = await $.ui.mount(band(80, true));
  expect(await ui.find({ type: 'Text', text: /System/ })).toBe(undefined);
  await ui.unmount();
});

test('forgets the conversation on /clear', async ($, on) => {
  const { contexts } = engine(on);
  await turn($, contexts, [41_000]);
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } });
  const ui = await $.ui.mount(band());
  expect(await ui.find({ type: 'Text', text: /System/ })).toBe(undefined);
  await ui.unmount();
});

test('says what a tool call set out to do', () => {
  expect(describe('Bash', { command: 'npm test -- --watch=false', description: 'Run the tests' }, '/repo')).toEqual({
    title: 'Run the tests',
    detail: 'npm test -- --watch=false',
  });
  expect(describe('Bash', { command: 'git\n  status' }, '/repo')).toEqual({ title: 'git status', detail: '' });
  expect(describe('Read', { file_path: '/repo/src/engine.ts' }, '/repo')).toEqual({ title: 'engine.ts', detail: 'src' });
  expect(describe('Edit', { file_path: 'C:\\Repo\\src\\a.ts' }, 'c:\\repo')).toEqual({ title: 'a.ts', detail: 'src' });
  expect(describe('Grep', { pattern: 'session.compact', path: '/repo/types', glob: '*.ts' }, '/repo')).toEqual({
    title: '"session.compact"',
    detail: 'in types *.ts',
  });
  expect(describe('WebFetch', { url: 'https://example.com/docs', prompt: 'hooks' }, '/repo')).toEqual({
    title: 'example.com/docs',
    detail: 'hooks',
  });
  expect(describe('mcp__docs__read', {}, '/repo')).toEqual({ title: 'docs read', detail: '' });
});

test('pairs each tool result with its call, largest first', () => {
  const results = toolResults([
    { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'Read', input: { file_path: 'a.ts' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'x'.repeat(400) }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'b', name: 'Bash', input: { command: 'ls' } }] },
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'b', is_error: true, content: [{ type: 'text', text: 'x'.repeat(4_000) }] }],
    },
  ]);
  expect(results.map(each => [each.tool, each.tokens, each.isError])).toEqual([
    ['Bash', 1_000, true],
    ['Read', 100, false],
  ]);
});

test('leaves the reminders attached to a result out of its size, counting them apart', () => {
  // 400 characters: 100 tokens.
  const reminder = `<system-reminder>${'r'.repeat(365)}</system-reminder>`;
  const messages = [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'Edit', input: { file_path: 'a.ts' } }] },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'a', content: `${'x'.repeat(40)}\n\n${reminder}\n\n${reminder}` },
        { type: 'text', text: reminder },
      ],
    },
  ];
  const [result] = toolResults(messages);
  expect([result!.tokens, result!.text]).toEqual([10, 'x'.repeat(40)]);
  expect(reminderTokens(messages)).toBe(300);
});

test('fits a target to its width by cutting its middle', () => {
  expect(fitMiddle('src/engine.ts', 20)).toBe('src/engine.ts');
  expect(fitMiddle('C:/Users/me/projects/app/src/engine.ts', 20)).toBe('C:/Users/m…engine.ts');
});

test('sizes a bar in eighths of a cell, never less than one', () => {
  expect(sizeBar(100, 100)).toBe('██████████');
  expect(sizeBar(55, 100)).toBe('█████▌    ');
  expect(sizeBar(1, 100_000)).toBe('▏         ');
});

test('lays the table out to the pane width, the detail dropped when narrow', () => {
  const rows = [
    { size: '~5.0k', title: 'Run the tests', tool: 'Bash' },
    { size: '~100', title: 'small.ts', tool: 'Read' },
  ];
  // The columns and a gap of two after each but the last.
  const width = (w: ReturnType<typeof tableColumns>) => w.rank + w.size + w.bar + w.tool + w.call + w.detail + 5 * 2;
  const wide = tableColumns(100, rows);
  expect([wide.call, wide.detail, width(wide)]).toEqual([15, 55, 100]);
  const narrow = tableColumns(40, rows);
  expect([narrow.detail, width(narrow)]).toEqual([0, 40]);
});

// A Read of 400 characters and a Bash of about 20k, in /repo.
function toolCalls(messages: ReturnType<typeof engine>['messages']) {
  messages.push(
    {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/repo/src/small.ts' } },
        { type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'npm test', description: 'Run the tests' } },
      ],
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 't1', content: 'x'.repeat(400) },
        { type: 'tool_result', tool_use_id: 't2', content: `12 passed\n${'y'.repeat(20_000)}` },
      ],
    },
  );
}

test('opens /context-tools in a pane as wide as it can, leaving the model nothing to read', async ($, on) => {
  const { opened } = engine(on);
  await start($);
  const ran = await $.command.run({
    command: 'context-tools',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 160 },
  } as never);
  expect(opened).toEqual([{ id: 'context-tools', columns: 160 }]);
  expect((ran as { text?: string }).text).toBe(undefined);
});

test('lists the tool results largest first, a call expanding on a press', async ($, on) => {
  const { messages } = engine(on);
  toolCalls(messages);
  await start($);
  const ui = await $.ui.mount({
    plugin: 'context-bar',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'context-tools',
    props: { title: 'Largest tool results', isFocused: true, bodyColumns: 100, placement: 'inline', scroll: { offset: 0, bodyRows: 20 }, view: {} },
  });
  expect(await ui.find({ type: 'Text', text: /^2 results · ~5\.1k of 34k in messages/ })).toBeDefined();
  expect((await ui.find({ key: 'tool-t2' }))?.text).toBe('▸ Run the tests');
  expect((await ui.find({ key: 'tool-t1' }))?.text).toBe('▸ small.ts');
  expect(await ui.find({ type: 'Text', text: 'npm test' })).toBeDefined();
  expect(await ui.find({ type: 'Text', text: /12 passed/ })).toBe(undefined);

  await ui.press({ key: 'tool-t2' });
  expect((await ui.find({ key: 'tool-t2' }))?.text).toBe('▾ Run the tests');
  expect(await ui.find({ type: 'Text', text: 'command' })).toBeDefined();
  expect(await ui.find({ type: 'Text', text: /12 passed/ })).toBeDefined();
  await ui.press({ key: 'tool-t2' });
  expect(await ui.find({ type: 'Text', text: /12 passed/ })).toBe(undefined);
  await ui.unmount();
});
