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

Opens a pane listing the twenty largest tool results still in the context, each with its estimated tokens, the tool, and what it was called on. A long path or command is cut in the middle, so the file name stays in view:

```
Largest tool results in the context (estimated at 4 characters a token)
 ~12k  Bash  npm test
~5.0k  Read  C:\Users\me\projects\app…\src\engine.ts
[ Close ]
```

The pane is for you alone: nothing of it reaches the model. Escape, `q` or Close dismisses it. Only the main conversation's results are counted (a subagent's stay in its own context). The list clears at a compaction and at `/clear`. Sizes are estimated from each result's text at about four characters a token, so images are not counted.

## Notes

- The categories are the engine's local estimate (`/context`'s summary breakdown), refreshed after every response. It sends no requests, so it costs nothing. The estimate is measured against the compaction window and need not match the status line's figure exactly.
- Turn and step figures come from the API's reported usage of each main-conversation request (uncached, cache-read and cache-written input together); subagents' requests are not counted.
- Tool schemas loaded on demand sit outside the window and are left out.
- What it shows is kept in the session's plugin state, so a reload draws at once. `/clear` resets everything.
