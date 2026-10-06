# context-bar

A coloured bar in the band above the prompt showing what fills the context window, by category, where each turn and step began, and how much the last turn added.

```
██████████┃█████││███░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░▒▒▒▒▒▒▒▒▒▒ 60k/200k (30%)
System 20k  MCP 4.0k  Skills 2.0k  Messages 22k  Turn 13k  Free 107k  Buffer 33k
Last turn: 3 steps · context 40k → 52k (+13k) · 1.5k out · steps +1.0k +6.0k +5.0k
```

- **The bar** fills the band, with the total in use against the window at its end. Content is drawn in the colours `/context` uses: system prompt and tools, MCP tools, custom agents, skills, memory files, then messages. After the content come the free space (shaded) and the autocompact buffer. Every category in use gets at least one cell, however small.
- **The last turn** is carved off the end of the messages in a colour no other segment uses, so you can see how much of the window the latest turn took.
- **Markers** in the bar show where each turn (`┃`) and each later step of a turn (a thinner `│`) began, drawn as a line on the segment's colour so it stays filled. Boundaries that fall in the same cell share one marker, so lots of small steps never widen the bar.
- **The legend** names each segment, in its colour, with its tokens. When the line is too narrow it drops the token counts, then the trailing names, so it never wraps.
- **The turn line** shows the current turn while it runs (`This turn`) and the previous one after it ends (`Last turn`): how many model requests it made, the context it started from and reached, the tokens it generated, and what each of its last eight steps added. When a compaction runs partway through a turn, the line shows where it left the context (`context 166k → compacted 34k → 37k`) and counts the turn's growth from there.

The band yields to a survey, and can be collapsed and restored like any band above the prompt (`ctrl+x ctrl+a`, or the `[-]`/`[+]` at its right edge).

## Notes

- The categories are the engine's local estimate (`/context`'s summary breakdown), refreshed after every response. It sends no requests, so it costs nothing. The estimate is measured against the compaction window and need not match the status line's figure exactly.
- Turn and step figures, and the markers, come from the API's reported usage of each main-conversation request (uncached, cache-read and cache-written input together); subagents' requests are not counted. Since the bar is drawn from the estimate, a marker can sit a cell off the exact boundary.
- Tool schemas loaded on demand sit outside the window and are left out.
- What it shows is kept in the session's plugin state, so a reload draws at once. A compaction drops the markers past the new, smaller context, and `/clear` resets everything.
