import { atom, read, update } from 'claude-code';
import type { EngineInterface, On } from 'claude-code';

// The row expanded, by its call's id; the pane shows one at a time.
const expanded = atom({ plugin: 'context-bar', key: 'expandedTool' } as const, null);
// The window by category, which register.tsx keeps.
const breakdown = atom({ plugin: 'context-bar', key: 'breakdown' } as const, null);

// The command, and the pane it opens, listing the largest tool results.
export const TOOLS_PANE = 'context-tools';
const MAX_LISTED = 20;
// A tool result's tokens, estimated from its text's length.
const CHARS_PER_TOKEN = 4;
// The width of a row's size bar, in cells, drawn in eighths.
const BAR_CELLS = 10;
const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉'];
// What an expanded row shows of its result.
const PREVIEW_LINES = 8;
// The arguments that say what an unknown tool was called on, the first present.
const TARGET_KEYS = ['file_path', 'notebook_path', 'path', 'command', 'pattern', 'url', 'query', 'skill', 'description', 'prompt'];

// One tool result in the context: the call it answers and its estimated size.
export type ToolResult = {
  id: string;
  tool: string;
  input: Record<string, unknown>;
  text: string;
  isError: boolean;
  tokens: number;
};

type Block = { type: string; [field: string]: unknown };
type Message = { role: string; content: Block[] };

function resultText(content: unknown) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return (content as Block[])
    .filter(block => block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text as string)
    .join('\n');
}

// The tool results of `messages` (the context in API form), largest first,
// each paired with the call it answers.
export function toolResults(messages: readonly Message[]): ToolResult[] {
  const calls = new Map<string, Block>();
  const results: ToolResult[] = [];
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === 'tool_use' && typeof block.id === 'string') calls.set(block.id, block);
      if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
      const call = calls.get(block.tool_use_id);
      const text = resultText(block.content);
      results.push({
        id: block.tool_use_id,
        tool: typeof call?.name === 'string' ? call.name : 'Tool',
        input: (call?.input ?? {}) as Record<string, unknown>,
        text,
        isError: block.is_error === true,
        tokens: Math.ceil(text.length / CHARS_PER_TOKEN),
      });
    }
  }
  return results.filter(result => result.tokens > 0).sort((a, b) => b.tokens - a.tokens);
}

function oneLine(value: unknown) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

// `path` relative to `cwd` when it lies inside it.
export function relative(path: string, cwd: string) {
  const norm = (each: string) => each.replace(/\\/g, '/').toLowerCase();
  const root = norm(cwd).replace(/\/$/, '');
  return norm(path).startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
}

function splitPath(path: string) {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return cut < 0 ? { name: path, folder: '' } : { name: path.slice(cut + 1), folder: path.slice(0, cut) };
}

// The tool's name for a row: an MCP tool by its server and tool.
export function toolName(tool: string) {
  const mcp = /^mcp__(.+?)__(.+)$/.exec(tool);
  return mcp === null ? tool : `${mcp[1]} ${mcp[2]}`;
}

// What a call set out to do, in a row's words: `title` first, `detail` dim
// after it. A description the model wrote leads; else the file, search or
// address the call was on.
export function describe(tool: string, input: Record<string, unknown>, cwd: string) {
  const path = oneLine(input.file_path) || oneLine(input.notebook_path);
  if (path) {
    const { name, folder } = splitPath(relative(path, cwd));
    return { title: name, detail: folder };
  }
  const where = oneLine(input.path) ? `in ${relative(oneLine(input.path), cwd)}` : '';
  switch (tool) {
    case 'Bash':
      return oneLine(input.description)
        ? { title: oneLine(input.description), detail: oneLine(input.command) }
        : { title: oneLine(input.command), detail: '' };
    case 'Agent':
    case 'Task':
      return { title: oneLine(input.description) || oneLine(input.prompt), detail: oneLine(input.subagent_type) };
    case 'Grep':
      return { title: `"${oneLine(input.pattern)}"`, detail: [where, oneLine(input.glob)].filter(Boolean).join(' ') };
    case 'Glob':
      return { title: oneLine(input.pattern), detail: where };
    case 'WebFetch':
      return { title: oneLine(input.url).replace(/^https?:\/\//, ''), detail: oneLine(input.prompt) };
  }
  const target = TARGET_KEYS.map(key => oneLine(input[key])).find(Boolean) ?? '';
  return { title: target || toolName(tool), detail: '' };
}

// `text` in `width` cells, its middle cut where it is wider, so a path keeps
// both its root and its file name.
export function fitMiddle(text: string, width: number) {
  if (text.length <= width) return text;
  if (width < 2) return '…'.slice(0, Math.max(width, 0));
  const head = Math.ceil((width - 1) / 2);
  return `${text.slice(0, head)}…${text.slice(text.length - (width - 1 - head))}`;
}

// A bar of BAR_CELLS for `tokens` against the largest, in eighths of a cell,
// never less than one eighth.
export function sizeBar(tokens: number, largest: number) {
  const eighths = Math.max(Math.round((tokens / Math.max(largest, 1)) * BAR_CELLS * 8), 1);
  return `${'█'.repeat(Math.floor(eighths / 8))}${EIGHTHS[eighths % 8]}`.padEnd(BAR_CELLS);
}

export function formatSize(tokens: number) {
  if (tokens < 1_000) return `~${tokens}`;
  if (tokens < 10_000) return `~${(tokens / 1_000).toFixed(1)}k`;
  return `~${Math.round(tokens / 1_000)}k`;
}

// The arguments of a call, one a line, as an expanded row lists them.
export function argumentLines(input: Record<string, unknown>) {
  return Object.entries(input)
    .filter(([, value]) => value !== undefined && value !== '')
    .map(([key, value]) => `${key}: ${typeof value === 'string' ? oneLine(value) : JSON.stringify(value)}`);
}

// The first lines of a result, and how many more there are.
export function preview(text: string) {
  const lines = text.replace(/\s+$/, '').split('\n');
  return { lines: lines.slice(0, PREVIEW_LINES), more: Math.max(lines.length - PREVIEW_LINES, 0) };
}

// Opens the list in a pane, for the person alone: the command answers no text,
// so nothing of it reaches the model. Read from the context as it stands, so
// it holds what a compaction left and nothing it dropped.
// The messages' share of the window, as last estimated; null before one was.
// Read while drawn, it draws the pane again after every response.
async function messagesTokens($: EngineInterface) {
  const rows = await read($, breakdown);
  return rows?.slices.find(slice => slice.name.startsWith('Messages'))?.tokens ?? null;
}

export function registerTools(on: On) {
  on('command.run', { command: TOOLS_PANE }, async ($, e) => {
    await $.ui.open({
      id: TOOLS_PANE,
      title: 'Largest tool results',
      focus: true,
      closeOnEscape: true,
      rows: MAX_LISTED + 3,
      // A one-off look, so docked it asks for the whole width.
      columns: e.presentation.columns,
    });
    return {};
  });

  on('ui.render', { component: 'Pane', requestId: TOOLS_PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e);
    const [messages, cwd, open, inMessages] = await Promise.all([
      $.session.messages({ as: 'api' }),
      $.session.cwd(),
      read($, expanded),
      messagesTokens($),
    ]);
    const all = Array.isArray(messages) ? toolResults(messages as Message[]) : [];
    const listed = all.slice(0, MAX_LISTED);
    const total = all.reduce((sum, each) => sum + each.tokens, 0);
    const columns = e.props.bodyColumns;
    const sizeWidth = Math.max(0, ...listed.map(each => formatSize(each.tokens).length));
    const nameWidth = Math.max(0, ...listed.map(each => toolName(each.tool).length));
    const close = () => void $.ui.close({ id: TOOLS_PANE });
    const toggle = async (id: string) => {
      await update($, expanded, current => (current === id ? null : id));
      $.ui.invalidate('ui.render');
    };

    const header = [
      `${listed.length < all.length ? `${listed.length} of ` : ''}${all.length} result${all.length === 1 ? '' : 's'}`,
      `${formatSize(total)}${inMessages === null ? '' : ` of ${formatSize(inMessages).slice(1)} in messages`}`,
      `${CHARS_PER_TOKEN} characters a token`,
    ].join(' · ');

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between">
          <Text bold>Largest tool results in the context</Text>
          <Text dimColor wrap="truncate-end">
            {header}
          </Text>
        </Box>
        {listed.length < 1 ? <Text dimColor>No tool results in the context.</Text> : null}
        {listed.map((each, index) => {
          const isOpen = open === each.id;
          const { title, detail } = describe(each.tool, each.input, cwd);
          // The hotkey's `n: `, the marker, size, bar and the tool's name take
          // their share; the title, then the detail, the rest.
          const hotkeyWidth = index < 9 ? 3 : 0;
          const room = columns - hotkeyWidth - 2 - sizeWidth - 1 - BAR_CELLS - 1 - nameWidth - 2;
          const label = fitMiddle(title, room);
          const rest = room - label.length - 2;
          return (
            <Box key={`row-${each.id}`} flexDirection="column">
              <Box flexDirection="row">
                <Button
                  key={`tool-${each.id}`}
                  plain
                  hotkey={index < 9 ? String(index + 1) : undefined}
                  label={`${isOpen ? '▾' : '▸'} ${formatSize(each.tokens).padStart(sizeWidth)}`}
                  onPress={() => void toggle(each.id)}
                />
                <Text color="suggestion"> {sizeBar(each.tokens, listed[0]!.tokens)} </Text>
                <Text color={each.isError ? 'error' : undefined}>{label}</Text>
                <Box flexGrow={1}>
                  {rest > 8 && detail ? <Text dimColor>  {fitMiddle(detail, rest)}</Text> : null}
                </Box>
                <Text dimColor>  {toolName(each.tool)}</Text>
              </Box>
              {isOpen ? details(each, columns - 4) : null}
            </Box>
          );
        })}
        <Box flexDirection="row" marginTop={1}>
          <Button key="close" role="dismiss" hotkey="q" onPress={close}>
            Close
          </Button>
        </Box>
      </Box>
    );

    // An expanded row: the call's arguments and the start of its result.
    function details(result: ToolResult, width: number) {
      const { lines, more } = preview(result.text);
      return (
        <Box flexDirection="column" paddingLeft={4}>
          {argumentLines(result.input).map(line => (
            <Text dimColor wrap="truncate-end">
              {fitMiddle(line, width)}
            </Text>
          ))}
          <Text color={result.isError ? 'error' : 'suggestion'}>{result.isError ? 'error result' : 'result'}</Text>
          {lines.map(line => (
            <Text wrap="truncate-end">{line.slice(0, width) || ' '}</Text>
          ))}
          {more > 0 ? <Text dimColor>… {more} more lines</Text> : null}
        </Box>
      );
    }
  });
}
