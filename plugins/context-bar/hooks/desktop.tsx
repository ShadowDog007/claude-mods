import type { ElementTable } from 'claude-code';

import type { ContextBarSlice } from '../types';
import { formatTokens } from './tools';

// What the band draws, worked out the same on every surface.
export type BandSegment = { name: string; tokens: number; color: string; kind: ContextBarSlice['kind'] | 'turn' };
export type Band = { parts: BandSegment[]; summary: string; line: string | null };

// The colour the free space is filled with, in place of the terminal's shading.
const FREE_COLOR = 'subtle';

function fill(segment: BandSegment) {
  return segment.kind === 'free' ? FREE_COLOR : segment.color;
}

// `tokens` as a percentage of `total`, to a hundredth.
export function share(tokens: number, total: number) {
  return Math.round((tokens / Math.max(total, 1)) * 10_000) / 100;
}

// The band on the desktop: the surface lays the bar out from each segment's
// share, so it fills the band's width at any font size, in solid theme
// colours; the legend wraps rather than dropping what does not fit, and so
// does the turn line.
export function desktopBand({ Box, Text }: ElementTable<'desktop'>, { parts, summary, line }: Band) {
  const total = parts.reduce((sum, part) => sum + part.tokens, 0);
  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="row" alignItems="center" gap={1}>
        <Box key="bar" flexDirection="row" flexGrow={1} height={1}>
          {parts.map(part => (
            <Box
              key={`segment-${part.name}`}
              // Its percentage of the bar: the surface takes a grow of at most 10,000.
              flexGrow={share(part.tokens, total)}
              // Every kind of content in use shows, however small.
              minWidth={part.kind === 'used' || part.kind === 'turn' ? 1 : 0}
              backgroundColor={fill(part)}
            />
          ))}
        </Box>
        <Text bold>{summary}</Text>
      </Box>
      <Box key="legend" flexDirection="row" flexWrap="wrap" columnGap={2}>
        {parts.map(part => (
          <Box key={`legend-${part.name}`} flexDirection="row" gap={1}>
            <Box width={2} height={1} backgroundColor={fill(part)} />
            <Text dimColor={part.kind === 'free'}>
              {part.name} <Text dimColor>{formatTokens(part.tokens)}</Text>
            </Text>
          </Box>
        ))}
      </Box>
      {line === null ? null : <Text dimColor>{line}</Text>}
    </Box>
  );
}
