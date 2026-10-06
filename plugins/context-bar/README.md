# context-bar

A coloured bar in the band above the prompt showing what fills the context window, by category, and how much the last turn added.

```
████████████████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░▒▒▒▒▒▒▒▒▒▒ 60k/200k (30%)
System 20k  MCP 4.0k  Skills 2.0k  Messages 22k  Turn 13k  Free 107k  Buffer 33k
Last turn: 3 steps · context 40k → 52k (+13k) · 1.5k out · steps +1.0k +6.0k +5.0k
```

- **The bar** fills the band, with the total in use against the window at its end. Content is drawn in the colours `/context` uses: system prompt and tools, MCP tools, custom agents, skills, memory files, then messages. After the content come the free space (shaded) and the autocompact buffer. Every category in use gets at least one cell, however small.
- **The last turn** is carved off the end of the messages in a colour no other segment uses, so you can see how much of the window the latest turn took.
- **The legend** names each segment, in its colour, with its tokens. When the line is too narrow it drops the token counts, then the trailing names, so it never wraps.
- **The turn line** shows the current turn while it runs (`This turn`) and the previous one after it ends (`Last turn`): how many model requests it made, the context it started from and reached, the tokens it generated, and what each of its last eight steps added. When a compaction runs partway through a turn, the line shows where it left the context (`context 166k → compacted 34k → 37k`) and counts the turn's growth from there.

The band yields to a survey, and can be collapsed and restored like any band above the prompt (`ctrl+x ctrl+a`, or the `[-]`/`[+]` at its right edge).

## `/context-tools`

Opens a pane, as wide as the terminal allows, with a table of the twenty largest tool results in the context, each by what its call set out to do:

```
Largest tool results in the context     54 results · ~31k of 101k in messages · 4 characters a token

 #   Size  Share       Tool  Call                                Detail
──────────────────────────────────────────────────────────────────────────────────────────────────────────
 1   ~12k  ██████████  Bash  ▸ Run plugin tests and type-check   claude plugin test plugins/context-bar
 2  ~5.0k  ████▏       Read  ▾ register.tsx                      plugins/context-bar/hooks
                               file_path  S:\repo\plugins\context-bar\hooks\register.tsx
                               Result
                               │ import { atom, read, update } from 'claude-code';
                               … 412 more lines

 3   ~725  ▋           Grep  ▸ "session.compact"                 in types *.ts
[ Close ]
```

- A call the model described (`Bash`, `Agent`) goes by its description, its command in the detail. A file goes by its name, its folder relative to the project in the detail. A search goes by its pattern and where it looked, and a fetch by its address. The detail is dropped when the pane is too narrow for it, and a failed call's tool is drawn in the error colour.
- Click a call, or Tab to it and press Enter, to expand it: the call's arguments and the first lines of its result. Press it again to fold it.
- The header counts the results and their total against the messages' share of the window.
- Each result is sized by the tool's own output. The `<system-reminder>` blocks Claude Code attaches to whichever result comes next are left out of it and counted together in the header.
- The pane is for you alone: nothing of it reaches the model. Escape, `q` or Close dismisses it.

The list is read from the context as it stands when drawn, so it holds what a compaction kept and nothing it dropped, and is drawn again after every response. Sizes are estimated from each result's text at about four characters a token, so images are not counted.

## Notes

- The categories are the engine's local estimate (`/context`'s summary breakdown), refreshed after every response. It sends no requests, so it costs nothing. The estimate is measured against the compaction window and need not match the status line's figure exactly.
- Turn and step figures come from the API's reported usage of each main-conversation request (uncached, cache-read and cache-written input together); subagents' requests are not counted.
- Tool schemas loaded on demand sit outside the window and are left out.
- What it shows is kept in the session's plugin state, so a reload draws at once. `/clear` resets everything.
