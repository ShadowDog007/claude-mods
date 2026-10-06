import { atom, read, update } from 'claude-code';
import type { EngineInterface, ModelUsage, Register } from 'claude-code';

import type { ContextBarBreakdown, ContextBarMark, ContextBarSlice, ContextBarStep, ContextBarTurn } from '../types';

// The steps the turn line lists, newest last.
const MAX_STEPS_SHOWN = 8;
// The bar's widest, in cells; it is narrower where the band is.
const MAX_BAR_CELLS = 60;
const MIN_BAR_CELLS = 10;
// The turn and step boundaries kept, newest last; far more than a bar has cells.
const MAX_MARKS = 500;
// What the newest part of the conversation is drawn in, and the colour used
// instead when the row it is carved from already draws in that one.
const LAST_TURN_COLOR = 'warning';
const LAST_TURN_FALLBACK_COLOR = 'success';

// The short names for /context's rows, by the start of the row's name, in the
// order the bar draws them; a row named otherwise goes by its first word, just
// before the conversation, which stays last for the last turn to end it.
const SHORT_NAMES: [prefix: string, name: string][] = [
  ['System', 'System'],
  ['MCP', 'MCP'],
  ['Custom agents', 'Agents'],
  ['Skills', 'Skills'],
  ['Memory', 'Memory'],
  ['Messages', 'Messages'],
];

function rank(slice: ContextBarSlice) {
  const index = SHORT_NAMES.findIndex(([prefix]) => slice.name.startsWith(prefix));
  return index < 0 ? SHORT_NAMES.length - 1.5 : index;
}

// Kept in the session's state, so a reload of the module draws at once rather
// than waiting for the next response.
const breakdown = atom({ plugin: 'context-bar', key: 'breakdown' } as const, null);
const measured = atom({ plugin: 'context-bar', key: 'measured' } as const, null);
const turn = atom({ plugin: 'context-bar', key: 'turn' } as const, null);
const marks = atom({ plugin: 'context-bar', key: 'marks' } as const, []);

// Re-estimates the window by category. `summary` counts locally and sends no
// request, so it is cheap enough to run after every response.
async function refresh($: EngineInterface) {
  try {
    const usage = await $.session.usage({ breakdown: 'summary' });
    const rows = usage.context.breakdown;
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

// A turn kept by an earlier version has no compactedAt.
async function readTurn($: EngineInterface): Promise<ContextBarTurn | null> {
  const current = await read($, turn);
  return current === null ? null : { ...current, compactedAt: current.compactedAt ?? null };
}

function mark($: EngineInterface, boundary: ContextBarMark) {
  return update($, marks, current => [...current, boundary].slice(-MAX_MARKS));
}

function inputSide(usage: ModelUsage) {
  return usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens;
}

// The context the turn's growth counts from: where it started, or where a
// compaction within it left the context.
function baseline(current: ContextBarTurn) {
  return current.compactedAt === null ? current.contextBefore : current.steps[current.compactedAt]!.context;
}

// What the turn has added to the context so far: from its baseline to its
// latest request, that request's own output included, since the next one
// carries it.
export function turnGrowth(current: ContextBarTurn) {
  const last = current.steps.at(-1);
  const start = baseline(current);
  if (last === undefined || start === null) return null;
  return last.context + last.output - start;
}

// What each step added over the one before it (the first over the turn's
// start); 'compacted' for the step a compaction shrank, null where there is
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

type Segment = { name: string; tokens: number; color: string; kind: ContextBarSlice['kind'] | 'turn' };

function isContent(segment: Segment) {
  return segment.kind === 'used' || segment.kind === 'turn';
}

export function shortName(slice: ContextBarSlice) {
  if (slice.kind === 'free') return 'Free';
  if (slice.kind === 'buffer') return 'Buffer';
  const known = SHORT_NAMES.find(([prefix]) => slice.name.startsWith(prefix));
  return known?.[1] ?? slice.name.split(' ')[0] ?? slice.name;
}

// The bar's segments in order, each by its short name, neighbours of one name
// (the system prompt and the system tools) drawn as one in the first one's
// colour: the content in SHORT_NAMES' order, with the last turn's growth
// carved off the end of the last of it (the conversation, which a turn
// appends to), then the free space and the buffer.
export function segments(rows: ContextBarBreakdown, growth: number | null): Segment[] {
  const result: Segment[] = [];
  const add = (slice: ContextBarSlice) => {
    const name = shortName(slice);
    const previous = result.at(-1);
    if (previous?.name === name) previous.tokens += slice.tokens;
    else result.push({ ...slice, name });
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
      color: tail.color === LAST_TURN_COLOR ? LAST_TURN_FALLBACK_COLOR : LAST_TURN_COLOR,
      kind: 'turn',
    });
  }
  rows.slices.filter(slice => slice.kind === 'free').forEach(add);
  rows.slices.filter(slice => slice.kind === 'buffer').forEach(add);
  return result.filter(segment => segment.tokens > 0);
}

// Splits `cells` among the weights in proportion, by largest remainder, then
// gives a cell to each used segment that rounded to none, taken from the
// largest, so every kind of content in the window shows.
export function allocate(weights: number[], cells: number, isRequired: boolean[] = []) {
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
  return Math.min(Math.max(columns - summaryWidth - 1, MIN_BAR_CELLS), MAX_BAR_CELLS);
}

const GLYPH: Record<Segment['kind'], string> = { used: '█', turn: '█', free: '░', buffer: '▒' };
const MARK_GLYPH: Record<ContextBarMark['kind'], string> = { turn: '┃', step: '│' };

export type Run = { text: string; color: string | undefined; isDim: boolean };

// The bar as runs of text: each segment's cells in its glyph, a turn's or a
// step's boundary drawn over the content cell its tokens fall in. Boundaries
// in one cell draw as one, a turn's over a step's, so the bar is as wide as
// the counts add up to whatever their number. Neighbouring cells of one style
// are one run.
export function bar(parts: Segment[], counts: number[], boundaries: readonly ContextBarMark[]): Run[] {
  const cells: (Run & { isContent: boolean })[] = [];
  for (const [index, part] of parts.entries()) {
    for (let count = 0; count < counts[index]!; count++) {
      cells.push({
        text: GLYPH[part.kind],
        color: part.kind === 'free' ? undefined : part.color,
        isDim: part.kind === 'free',
        isContent: isContent(part),
      });
    }
  }
  const total = parts.reduce((sum, part) => sum + part.tokens, 0);
  const at = new Map<number, ContextBarMark['kind']>();
  for (const boundary of total > 0 ? boundaries : []) {
    const index = Math.min(Math.floor((boundary.tokens / total) * cells.length), cells.length - 1);
    if (index >= 0 && at.get(index) !== 'turn') at.set(index, boundary.kind);
  }
  for (const [index, kind] of at) {
    const cell = cells[index]!;
    if (cell.isContent) cells[index] = { ...cell, text: MARK_GLYPH[kind], isDim: kind === 'step' };
  }

  const runs: Run[] = [];
  for (const { text, color, isDim } of cells) {
    const last = runs.at(-1);
    if (last !== undefined && last.color === color && last.isDim === isDim) last.text += text;
    else runs.push({ text, color, isDim });
  }
  return runs;
}

type LegendItem = { segment: Segment; label: string };

// Labels with two spaces between them.
function legendWidth(items: LegendItem[]) {
  return items.reduce((sum, item) => sum + item.label.length + 2, 0) - 2;
}

// The legend that fits on one line of `columns`, each label drawn in its
// segment's colour: every segment with its tokens; then by name alone; then
// as many of those as fit.
export function legend(parts: Segment[], columns: number): LegendItem[] {
  const tiers: LegendItem[][] = [
    parts.map(segment => ({ segment, label: `${segment.name} ${formatTokens(segment.tokens)}` })),
    parts.map(segment => ({ segment, label: segment.name })),
  ];
  for (const tier of tiers) {
    if (legendWidth(tier) <= columns) return tier;
  }
  const fitting: LegendItem[] = [];
  for (const item of tiers.at(-1)!) {
    if (legendWidth([...fitting, item]) > columns) break;
    fitting.push(item);
  }
  return fitting;
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
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
      await update($, marks, () => []);
    }
    return next(e);
  });

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('context')) {
      const tokens = e.context.tokens ?? null;
      await update($, measured, () => tokens);
      // A compaction shrinks the context, and the boundaries past it are gone.
      await update($, marks, current =>
        tokens === null ? [] : current.some(each => each.tokens > tokens) ? current.filter(each => each.tokens <= tokens) : current,
      );
      await refresh($);
    }
    return next(e);
  });

  on('turn.start', async ($, e, next) => {
    const contextBefore = await read($, measured);
    await update($, turn, () => ({ contextBefore, steps: [], compactedAt: null, isRunning: true }));
    if (contextBefore !== null) await mark($, { tokens: contextBefore, kind: 'turn' });
    return next(e);
  });

  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e);
    if (e.agentId === undefined && result.usage !== null) {
      const step: ContextBarStep = { context: inputSide(result.usage), output: result.usage.output_tokens };
      const current = await readTurn($);
      if (current !== null) {
        // The context only shrinks when a compaction runs mid-turn.
        const previous = current.steps.at(-1)?.context ?? current.contextBefore;
        const compactedAt = previous !== null && step.context < previous ? current.steps.length : current.compactedAt;
        await update($, turn, () => ({ ...current, steps: [...current.steps, step], compactedAt }));
        // The first step starts where the turn does.
        if (current.steps.length > 0) await mark($, { tokens: step.context, kind: 'step' });
      }
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
    const current = await readTurn($);
    const growth = current === null ? null : turnGrowth(current);
    const { Box, Text } = $.ui.resolve(e);

    const used = rows.slices.filter(slice => slice.kind === 'used').reduce((sum, slice) => sum + slice.tokens, 0);
    const percent = Math.round((used / Math.max(rows.window, 1)) * 100);
    const summary = `${formatTokens(used)}/${formatTokens(rows.window)} (${percent}%)`;

    const parts = segments(rows, growth);
    const counts = allocate(
      parts.map(part => part.tokens),
      barWidth(e.props.bodyColumns, summary.length),
      parts.map(isContent),
    );
    const runs = bar(parts, counts, await read($, marks));

    const steps = current === null ? [] : stepGrowth(current);
    const shown = steps.slice(-MAX_STEPS_SHOWN);
    const turnLine =
      current === null || current.steps.length < 1
        ? null
        : [
            `${current.isRunning ? 'This turn' : 'Last turn'}: ${current.steps.length} step${current.steps.length === 1 ? '' : 's'}`,
            current.contextBefore === null && current.compactedAt === null
              ? `context ${formatTokens(current.steps.at(-1)!.context)}`
              : 'context ' +
                [
                  current.contextBefore === null ? null : formatTokens(current.contextBefore),
                  current.compactedAt === null ? null : `compacted ${formatTokens(baseline(current)!)}`,
                  formatTokens(current.steps.at(-1)!.context),
                ]
                  .filter(part => part !== null)
                  .join(' → ') +
                (growth === null ? '' : ` (${signed(growth)})`),
            `${formatTokens(current.steps.reduce((sum, step) => sum + step.output, 0))} out`,
            shown.length < 2
              ? null
              : `steps ${steps.length > shown.length ? '… ' : ''}${shown.map(delta => (delta === null ? '?' : delta === 'compacted' ? delta : signed(delta))).join(' ')}`,
          ]
            .filter(part => part !== null)
            .join(' · ');

    return (
      <Box flexDirection="column">
        <Box flexDirection="row">
          <Box key="bar" flexDirection="row">
            {runs.map(run => (
              <Text color={run.color} dimColor={run.isDim}>
                {run.text}
              </Text>
            ))}
          </Box>
          <Text bold> {summary}</Text>
        </Box>
        <Box key="legend" flexDirection="row">
          {legend(parts, e.props.bodyColumns).map(({ segment, label }, index) => (
            <Text color={segment.kind === 'free' ? undefined : segment.color} dimColor={segment.kind === 'free'}>
              {index === 0 ? '' : '  '}
              {label}
            </Text>
          ))}
        </Box>
        {turnLine === null ? null : (
          <Text dimColor wrap="truncate-end">
            {turnLine}
          </Text>
        )}
      </Box>
    );
  });
};
