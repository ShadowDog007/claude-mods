# context-bar

A coloured bar in the band above the prompt showing what fills the context window, by category, and how much the last turn and each of its steps added.

```
██████████████████████████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░▒▒▒▒▒▒▒▒▒▒▒▒▒
60k/200k (30%)  █ System prompt 3.0k  █ System tools 17k  █ MCP tools 4.0k  █ Skills 2.0k  █ Messages 22k  █ Last turn 13k  ░ Free space 107k  ▒ Autocompact buffer 33k
Last turn: 3 steps · context 40k → 52k (+13k) · 1.5k out · steps +1.0k +6.0k +5.0k
```

- **The bar** spans the band's width. Each category of `/context` (system prompt, system tools, MCP tools, custom agents, memory files, skills, messages) is drawn in the colour `/context` gives it, followed by the free space (shaded) and the autocompact buffer. Every category in use gets at least one cell, however small.
- **The last turn** is carved off the end of the conversation in its own colour, so you can see how much of the window the latest turn took.
- **The legend** gives the total in use against the window and each category's tokens.
- **The turn line** shows the current turn while it runs (`This turn`) and the previous one after it ends (`Last turn`): how many model requests it made, the context it started from and reached, the tokens it generated, and what each of its last eight steps added.

The band yields to a survey, and can be collapsed like any band above the prompt (`ctrl+x ctrl+a`).

## Notes

- The categories are the engine's local estimate (`/context`'s summary breakdown), refreshed after every response. It sends no requests, so it costs nothing. The estimate is measured against the compaction window and need not match the status line's figure exactly.
- Turn and step figures come from the API's reported usage of each main-conversation request (uncached, cache-read and cache-written input together); subagents' requests are not counted.
- Tool schemas loaded on demand sit outside the window and are left out.
- What it shows is kept in the session's plugin state, so a reload draws at once. `/clear` resets it.
