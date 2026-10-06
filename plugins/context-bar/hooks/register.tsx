import { atom, read, update } from 'claude-code';
import type { EngineInterface, ModelUsage, Register } from 'claude-code';

import type { ContextBarBreakdown, ContextBarSlice, ContextBarStep, ContextBarTurn } from '../types';

// The steps the turn line lists, newest last.
const MAX_STEPS_SHOWN = 8;
// What the newest part of the conversation is drawn in, and the colour used
// instead when the row it is carved from already draws in that one.
const LAST_TURN_COLOR = 'warning';
const LAST_TURN_FALLBACK_COLOR = 'success';

// Kept in the session's state, so a reload of the module draws at once rather
// than waiting for the next response.
const breakdown = atom({ plugin: 'context-bar', key: 'breakdown' } as const, null);
const measured = atom({ plugin: 'context-bar', key: 'measured' } as const, null);
const turn = atom({ plugin: 'context-bar', key: 'turn' } as const, null);

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

function inputSide(usage: ModelUsage) {
  return usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens;
}

// What the turn has added to the context so far: from where it started to its
// latest request, that request's own output included, since the next one
// carries it.
export function turnGrowth(current: ContextBarTurn) {
  const last = current.steps.at(-1);
  if (last === undefined || current.contextBefore === null) return null;
  return last.context + last.output - current.contextBefore;
}

// What each step added over the one before it (the first over the turn's
// start); null where there is nothing to compare against.
export function stepGrowth(current: ContextBarTurn) {
  return current.steps.map((step, index) => {
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

// The bar's segments in order: the used rows, with the last turn's growth
// carved off the end of the last of them (the conversation, which a turn
// appends to), then the free space and the buffer.
export function segments(rows: ContextBarBreakdown, growth: number | null): Segment[] {
  const used = rows.slices.filter(slice => slice.kind === 'used');
  const rest = rows.slices.filter(slice => slice.kind !== 'used');
  const result: Segment[] = used.map(slice => ({ ...slice }));
  const tail = result.at(-1);
  if (tail !== undefined && growth !== null && growth > 0) {
    const carved = Math.min(growth, tail.tokens);
    tail.tokens -= carved;
    result.push({
      name: 'Last turn',
      tokens: carved,
      color: tail.color === LAST_TURN_COLOR ? LAST_TURN_FALLBACK_COLOR : LAST_TURN_COLOR,
      kind: 'turn',
    });
  }
  return [...result, ...rest.map(slice => ({ ...slice }))].filter(segment => segment.tokens > 0);
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

const GLYPH: Record<Segment['kind'], string> = { used: '█', turn: '█', free: '░', buffer: '▒' };

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
    }
    return next(e);
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
    await update($, turn, () => ({ contextBefore, steps: [], isRunning: true }));
    return next(e);
  });

  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e);
    if (e.agentId === undefined && result.usage !== null) {
      const step: ContextBarStep = { context: inputSide(result.usage), output: result.usage.output_tokens };
      await update($, turn, current => (current === null ? current : { ...current, steps: [...current.steps, step] }));
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
    const growth = current === null ? null : turnGrowth(current);
    const { Box, Text } = $.ui.resolve(e);

    const parts = segments(rows, growth);
    const counts = allocate(
      parts.map(part => part.tokens),
      Math.max(e.props.bodyColumns, 10),
      parts.map(part => part.kind === 'used' || part.kind === 'turn'),
    );
    const used = rows.slices.filter(slice => slice.kind === 'used').reduce((sum, slice) => sum + slice.tokens, 0);
    const percent = Math.round((used / Math.max(rows.window, 1)) * 100);

    const steps = current === null ? [] : stepGrowth(current);
    const shown = steps.slice(-MAX_STEPS_SHOWN);
    const turnLine =
      current === null || current.steps.length < 1
        ? null
        : [
            `${current.isRunning ? 'This turn' : 'Last turn'}: ${current.steps.length} step${current.steps.length === 1 ? '' : 's'}`,
            current.contextBefore === null
              ? `context ${formatTokens(current.steps.at(-1)!.context)}`
              : `context ${formatTokens(current.contextBefore)} → ${formatTokens(current.steps.at(-1)!.context)}` +
                (growth === null ? '' : ` (${signed(growth)})`),
            `${formatTokens(current.steps.reduce((sum, step) => sum + step.output, 0))} out`,
            shown.length < 2
              ? null
              : `steps ${steps.length > shown.length ? '… ' : ''}${shown.map(delta => (delta === null ? '?' : signed(delta))).join(' ')}`,
          ]
            .filter(part => part !== null)
            .join(' · ');

    return (
      <Box flexDirection="column">
        <Box key="bar" flexDirection="row">
          {parts.map((part, index) =>
            counts[index]! > 0 ? (
              <Text color={part.kind === 'free' ? undefined : part.color} dimColor={part.kind === 'free'}>
                {GLYPH[part.kind].repeat(counts[index]!)}
              </Text>
            ) : null,
          )}
        </Box>
        <Box key="legend" flexDirection="row" flexWrap="wrap">
          <Text bold>
            {formatTokens(used)}/{formatTokens(rows.window)} ({percent}%){'  '}
          </Text>
          {parts.map(part => (
            <Text>
              <Text color={part.kind === 'free' ? undefined : part.color} dimColor={part.kind === 'free'}>
                {GLYPH[part.kind]}
              </Text>
              <Text dimColor>
                {' '}
                {part.name} {formatTokens(part.tokens)}
                {'  '}
              </Text>
            </Text>
          ))}
        </Box>
        {turnLine === null ? null : (
          <Text dimColor>
            {turnLine}
          </Text>
        )}
      </Box>
    );
  });
};
