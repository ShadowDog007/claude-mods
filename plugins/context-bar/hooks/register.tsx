import { atom, read, update } from 'claude-code';
import type { EngineInterface, ModelUsage, Register } from 'claude-code';

import type { ContextBarBreakdown, ContextBarSlice, ContextBarStep, ContextBarToolResult, ContextBarTurn } from '../types';

const COMMAND = 'context-tools';
// The tool results kept, and how many the command lists unless told.
const MAX_TOOL_RESULTS = 20;
const TOOL_RESULTS_LISTED = 10;
// A tool result's tokens, estimated from its text's length.
const CHARS_PER_TOKEN = 4;
// The arguments that say what a tool was called on, the first one present.
const TARGET_KEYS = ['file_path', 'notebook_path', 'path', 'command', 'pattern', 'url', 'query', 'skill', 'description'];
const MAX_TARGET_LENGTH = 80;

// The steps the turn line lists, newest last.
const MAX_STEPS_SHOWN = 8;
// The bar's narrowest, in cells; otherwise it fills the band beside its summary.
const MIN_BAR_CELLS = 10;
// What the last turn is drawn in: the first of these no other segment uses.
const LAST_TURN_COLORS = ['warning', 'suggestion', 'success', 'permission'];

// The short names for /context's rows, by the start of the row's name, in the
// order the bar draws them. A row named otherwise goes by its first word, just
// before the messages, which stay last so the last turn can be carved off them.
const SHORT_NAMES: [prefix: string, name: string][] = [
  ['System', 'System'],
  ['MCP', 'MCP'],
  ['Custom agents', 'Agents'],
  ['Skills', 'Skills'],
  ['Memory', 'Memory'],
  ['Messages', 'Messages'],
];

// Kept in the session's state, so a reload of the module draws at once rather
// than waiting for the next response.
const breakdown = atom({ plugin: 'context-bar', key: 'breakdown' } as const, null);
const measured = atom({ plugin: 'context-bar', key: 'measured' } as const, null);
const turn = atom({ plugin: 'context-bar', key: 'turn' } as const, null);
const toolResults = atom({ plugin: 'context-bar', key: 'toolResults' } as const, []);

// Re-estimates the window by category. `summary` counts locally and sends no
// request, so it is cheap enough to run after every response.
async function refresh($: EngineInterface) {
  try {
    const rows = (await $.session.usage({ breakdown: 'summary' })).context.breakdown;
    if (rows === undefined) return;
    const slices: ContextBarSlice[] = [];
    for (const { name, tokens, color, kind } of rows.categories) {
      if (kind !== 'deferred' && tokens > 0) slices.push({ name, tokens, color, kind });
    }
    await update($, breakdown, () => ({ slices, window: rows.rawMaxTokens }));
  } catch (error) {
    $.ui.log(`context-bar: could not break the context down: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function inputSide(usage: ModelUsage) {
  return usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens;
}

// What the turn has added to the context so far, from where it started (or
// where a compaction within it left the context) to its latest request, that
// request's own output included, since the next one carries it.
export function turnGrowth(current: ContextBarTurn) {
  const last = current.steps.at(-1);
  const start = current.compactedAt === null ? current.contextBefore : current.steps[current.compactedAt]!.context;
  if (last === undefined || start === null) return null;
  return last.context + last.output - start;
}

// What each step added over the one before it (the first over the turn's
// start): 'compacted' for the step a compaction shrank, null where there is
// nothing to compare against.
export function stepGrowth(current: ContextBarTurn) {
  return current.steps.map((step, index) => {
    if (index === current.compactedAt) return 'compacted';
    const before = index === 0 ? current.contextBefore : current.steps[index - 1]!.context;
    return before === null ? null : step.context - before;
  });
}

export function formatTokens(tokens: number) {
  const size = Math.abs(tokens);
  if (size < 1_000) return String(Math.round(tokens));
  if (size < 10_000) return `${(tokens / 1_000).toFixed(1)}k`;
  if (size < 1_000_000) return `${Math.round(tokens / 1_000)}k`;
  return `${(tokens / 1_000_000).toFixed(1)}M`;
}

function signed(tokens: number) {
  return `${tokens < 0 ? '-' : '+'}${formatTokens(Math.abs(tokens))}`;
}

// The line under the legend: the turn's requests, the context it went from
// and to, what it generated, and what each of its last steps added.
export function turnLine(current: ContextBarTurn) {
  const last = current.steps.at(-1);
  if (last === undefined) return null;
  const growth = turnGrowth(current);
  const context = [
    current.contextBefore === null ? null : formatTokens(current.contextBefore),
    current.compactedAt === null ? null : `compacted ${formatTokens(current.steps[current.compactedAt]!.context)}`,
    formatTokens(last.context),
  ].filter(point => point !== null);
  const steps = stepGrowth(current);
  const shown = steps
    .slice(-MAX_STEPS_SHOWN)
    .map(delta => (delta === null ? '?' : delta === 'compacted' ? delta : signed(delta)));
  const count = current.steps.length;
  return [
    `${current.isRunning ? 'This turn' : 'Last turn'}: ${count} step${count === 1 ? '' : 's'}`,
    `context ${context.join(' → ')}${growth === null ? '' : ` (${signed(growth)})`}`,
    `${formatTokens(current.steps.reduce((sum, step) => sum + step.output, 0))} out`,
    shown.length < 2 ? null : `steps ${steps.length > shown.length ? '… ' : ''}${shown.join(' ')}`,
  ]
    .filter(part => part !== null)
    .join(' · ');
}

// What a tool was called on, by its first argument of TARGET_KEYS, on one line.
export function toolTarget(input: Record<string, unknown>) {
  const value = TARGET_KEYS.map(key => input[key]).find(each => typeof each === 'string' && each.length > 0);
  if (typeof value !== 'string') return '';
  const line = value.replace(/\s+/g, ' ').trim();
  return line.length > MAX_TARGET_LENGTH ? `${line.slice(0, MAX_TARGET_LENGTH - 1)}…` : line;
}

// `list` with `result` in its place, largest first, the smallest past the cap
// dropped.
export function keepLargest(list: readonly ContextBarToolResult[], result: ContextBarToolResult) {
  const index = list.findIndex(each => each.tokens < result.tokens);
  const next = index < 0 ? [...list, result] : [...list.slice(0, index), result, ...list.slice(index)];
  return next.slice(0, MAX_TOOL_RESULTS);
}

// The command's answer: the `count` largest tool results, one a line.
export function toolResultsReport(list: readonly ContextBarToolResult[], count: number) {
  if (list.length < 1) return 'No tool results in the context yet.';
  const shown = list.slice(0, count);
  const sizes = shown.map(each => `~${formatTokens(each.tokens)}`);
  const sizeWidth = Math.max(...sizes.map(size => size.length));
  const toolWidth = Math.max(...shown.map(each => each.tool.length));
  return [
    `Largest tool results in the context (estimated at ${CHARS_PER_TOKEN} characters a token):`,
    ...shown.map((each, index) =>
      `  ${sizes[index]!.padStart(sizeWidth)}  ${each.tool.padEnd(toolWidth)}  ${each.target}`.trimEnd(),
    ),
  ].join('\n');
}

type Segment = { name: string; tokens: number; color: string; kind: ContextBarSlice['kind'] | 'turn' };

function isContent(segment: Segment) {
  return segment.kind === 'used' || segment.kind === 'turn';
}

// How a segment's cells and its legend label are drawn: the free space dimmed.
function style(segment: Segment) {
  return segment.kind === 'free' ? { color: undefined, isDim: true } : { color: segment.color, isDim: false };
}

function knownIndex(slice: ContextBarSlice) {
  return SHORT_NAMES.findIndex(([prefix]) => slice.name.startsWith(prefix));
}

export function shortName(slice: ContextBarSlice) {
  if (slice.kind === 'free') return 'Free';
  if (slice.kind === 'buffer') return 'Buffer';
  return SHORT_NAMES[knownIndex(slice)]?.[1] ?? slice.name.split(' ')[0] ?? slice.name;
}

// The bar's segments in order, each by its short name, neighbours of one name
// (the system prompt and the system tools) drawn as one in the first one's
// colour: the content in SHORT_NAMES' order with the last turn's growth carved
// off its end, then the free space and the buffer.
export function segments(rows: ContextBarBreakdown, growth: number | null): Segment[] {
  const result: Segment[] = [];
  const add = (slice: ContextBarSlice) => {
    const name = shortName(slice);
    const previous = result.at(-1);
    if (previous?.name === name) previous.tokens += slice.tokens;
    else result.push({ ...slice, name });
  };
  const rank = (slice: ContextBarSlice) => {
    const index = knownIndex(slice);
    return index < 0 ? SHORT_NAMES.length - 1.5 : index;
  };
  rows.slices
    .filter(slice => slice.kind === 'used')
    .sort((a, b) => rank(a) - rank(b))
    .forEach(add);
  const tail = result.at(-1);
  if (tail !== undefined && growth !== null && growth > 0) {
    const carved = Math.min(growth, tail.tokens);
    tail.tokens -= carved;
    result.push({
      name: 'Turn',
      tokens: carved,
      color: LAST_TURN_COLORS.find(color => result.every(each => each.color !== color)) ?? LAST_TURN_COLORS[0]!,
      kind: 'turn',
    });
  }
  rows.slices.filter(slice => slice.kind === 'free').forEach(add);
  rows.slices.filter(slice => slice.kind === 'buffer').forEach(add);
  return result.filter(segment => segment.tokens > 0);
}

// Splits `cells` among the weights in proportion, by largest remainder, then
// gives a cell to each required weight that rounded to none, taken from the
// largest, so every kind of content in the window shows.
export function allocate(weights: number[], cells: number, isRequired: boolean[]) {
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  if (total <= 0 || cells <= 0) return weights.map(() => 0);
  const exact = weights.map(weight => (weight / total) * cells);
  const counts = exact.map(Math.floor);
  let left = cells - counts.reduce((sum, count) => sum + count, 0);
  const byRemainder = exact.map((value, index) => ({ index, remainder: value - Math.floor(value) }));
  byRemainder.sort((a, b) => b.remainder - a.remainder);
  for (const { index } of byRemainder) {
    if (left <= 0) break;
    counts[index]!++;
    left--;
  }
  for (const [index, required] of isRequired.entries()) {
    if (!required || counts[index]! > 0 || weights[index]! <= 0) continue;
    const largest = counts.indexOf(Math.max(...counts));
    if (counts[largest]! <= 1) break;
    counts[largest]!--;
    counts[index] = 1;
  }
  return counts;
}

// The width of the bar beside a summary `summaryWidth` wide, in a band
// `columns` wide.
export function barWidth(columns: number, summaryWidth: number) {
  return Math.max(columns - summaryWidth - 1, MIN_BAR_CELLS);
}

const GLYPH: Record<Segment['kind'], string> = { used: '█', turn: '█', free: '░', buffer: '▒' };

export type Run = { text: string; color: string | undefined; isDim: boolean };

// The bar as runs of text, one per segment drawn: its cells in its glyph.
export function bar(parts: Segment[], counts: number[]): Run[] {
  return parts
    .map((part, index) => ({ text: GLYPH[part.kind].repeat(counts[index]!), ...style(part) }))
    .filter(run => run.text.length > 0);
}

type LegendItem = { segment: Segment; label: string };

// The legend that fits on one line of `columns`, labels two spaces apart: every
// segment with its tokens; then by name alone; then as many names as fit.
export function legend(parts: Segment[], columns: number): LegendItem[] {
  const width = (items: LegendItem[]) => items.reduce((sum, item) => sum + item.label.length + 2, -2);
  const full = parts.map(segment => ({ segment, label: `${segment.name} ${formatTokens(segment.tokens)}` }));
  if (width(full) <= columns) return full;
  const names = parts.map(segment => ({ segment, label: segment.name }));
  let used = -2;
  const fitting: LegendItem[] = [];
  for (const item of names) {
    used += item.label.length + 2;
    if (used > columns) break;
    fitting.push(item);
  }
  return fitting;
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: 'List the largest tool results in the context',
      argumentHint: '[count]',
      immediate: true,
    });
    const result = await next(e);
    await refresh($);
    return result;
  });

  // A /clear starts the conversation over.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await update($, breakdown, () => null);
      await update($, measured, () => null);
      await update($, turn, () => null);
      await update($, toolResults, () => []);
    }
    return next(e);
  });

  // A compaction replaces the tool results with its summary; a precompute only
  // prepares one, and a skipped one keeps them.
  on('session.compact', async ($, e, next) => {
    const result = await next(e);
    if (e.agentId === undefined && e.trigger !== 'precompute' && result.skip === undefined) {
      await update($, toolResults, () => []);
    }
    return result;
  });

  // Subagents' results stay in their own context, so only the main loop's count.
  on('tool.call', async ($, e, next) => {
    const ran = await next(e);
    if (e.agentId === undefined && ran.deny === undefined && ran.text !== undefined) {
      const result: ContextBarToolResult = {
        tool: e.tool,
        target: toolTarget(e as unknown as Record<string, unknown>),
        tokens: Math.ceil(ran.text.length / CHARS_PER_TOKEN),
      };
      await update($, toolResults, list => keepLargest(list, result));
    }
    return ran;
  });

  on('command.run', { command: COMMAND }, async ($, e) => {
    const count = Number.parseInt(e.args.trim(), 10);
    const list = await read($, toolResults);
    return { text: toolResultsReport(list, Number.isInteger(count) && count > 0 ? count : TOOL_RESULTS_LISTED) };
  });

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('context')) {
      await update($, measured, () => e.context.tokens ?? null);
      await refresh($);
    }
    return next(e);
  });

  on('turn.start', async ($, e, next) => {
    const contextBefore = await read($, measured);
    await update($, turn, () => ({ contextBefore, steps: [], compactedAt: null, isRunning: true }));
    return next(e);
  });

  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e);
    if (e.agentId === undefined && result.usage !== null) {
      const step: ContextBarStep = { context: inputSide(result.usage), output: result.usage.output_tokens };
      await update($, turn, current => {
        if (current === null) return current;
        // The context only shrinks when a compaction runs mid-turn.
        const previous = current.steps.at(-1)?.context ?? current.contextBefore;
        const compactedAt = previous !== null && step.context < previous ? current.steps.length : current.compactedAt;
        return { ...current, steps: [...current.steps, step], compactedAt };
      });
    }
    return result;
  });

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      await update($, turn, current => (current === null ? current : { ...current, isRunning: false }));
    }
    return next(e);
  });

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const rows = await read($, breakdown);
    if (e.props.hasSurvey || rows === null || rows.slices.length < 1) return next(e);
    const current = await read($, turn);
    const { Box, Text } = $.ui.resolve(e);

    const used = rows.slices.filter(slice => slice.kind === 'used').reduce((sum, slice) => sum + slice.tokens, 0);
    const percent = Math.round((used / Math.max(rows.window, 1)) * 100);
    const summary = `${formatTokens(used)}/${formatTokens(rows.window)} (${percent}%)`;

    const parts = segments(rows, current === null ? null : turnGrowth(current));
    const counts = allocate(
      parts.map(part => part.tokens),
      barWidth(e.props.bodyColumns, summary.length),
      parts.map(isContent),
    );
    const line = current === null ? null : turnLine(current);

    return (
      <Box flexDirection="column">
        <Box flexDirection="row">
          <Box key="bar" flexDirection="row">
            {bar(parts, counts).map(run => (
              <Text color={run.color} dimColor={run.isDim}>
                {run.text}
              </Text>
            ))}
          </Box>
          <Text bold> {summary}</Text>
        </Box>
        <Box key="legend" flexDirection="row">
          {legend(parts, e.props.bodyColumns).map(({ segment, label }, index) => {
            const { color, isDim } = style(segment);
            return (
              <Text color={color} dimColor={isDim}>
                {index === 0 ? '' : '  '}
                {label}
              </Text>
            );
          })}
        </Box>
        {line === null ? null : (
          <Text dimColor wrap="truncate-end">
            {line}
          </Text>
        )}
      </Box>
    );
  });
};
