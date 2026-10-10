# prompt-queue

Queues prompts to run after the current turn ends, instead of steering the turn that is running.

Claude Code delivers a prompt typed while a turn runs into that turn (steering). This plugin adds a second kind of prompt that waits its turn:

| While a turn runs | What happens |
| --- | --- |
| `Enter` | Steers the running turn, as usual. |
| `ctrl+x enter` | Queues the prompt. |
| `/queue <prompt>` | Queues the prompt. |

Queued prompts are sent one at a time, oldest first, each after a turn ends. A steering prompt still goes ahead of them: if one is waiting when the turn ends, it runs first and the next queued prompt follows the turn it started. A queued prompt is sent as your own words.

`ctrl+x enter` is Claude Code's `chat:queueSubmit` action, so you can rebind it in `~/.claude/keybindings.json`. While the session is idle, `ctrl+x enter` sends the prompt at once, as `Enter` would; so does `/queue <prompt>`, unless older prompts are still queued (a paused queue), in which case it joins the end.

While prompts are queued, a band above the prompt lists the first few.

## Interrupting

If you interrupt a turn (`Esc`) or it ends on an error while prompts are queued, the queue pauses so it doesn't start the next prompt behind your back. It resumes when a turn you started with a prompt of your own ends with an answer, or straight away with `/queue-resume`. A turn something else started (a background task finishing, another plugin) leaves it paused.

## Commands

| Command | Description |
| --- | --- |
| `/queue <prompt>` | Queue a prompt. With nothing after it, list the queue. |
| `/queue-clear` | Drop every queued prompt. |
| `/queue-resume` | Resume a paused queue, sending the next prompt now if the session is idle. |

## Notes

- A prompt with pasted images or other attachments can't be held by a plugin, and `@file` mentions aren't expanded in a prompt a plugin sends; `ctrl+x enter` sends such a prompt as usual and shows a toast.
- If a hook refuses a queued prompt when it is sent (a `UserPromptSubmit` hook that blocks it, say), it goes back to the front of the queue and the queue pauses.
- A queued prompt leaves the queue once it is sent. If it is waiting behind a steering prompt whose turn you then interrupt, it still runs after it.
- The queue lives in the session's plugin state, so it survives a plugin reload. `/clear` empties it.
- Subagent turns don't count: only a turn of the main conversation ending sends the next prompt.
