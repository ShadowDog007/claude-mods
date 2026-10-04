# idle-compact

Automatically runs `/compact` when a session has been left waiting on background work, right before the prompt cache expires.

It compacts when all of these hold:

1. The current turn has ended (the agent is not working).
2. At least one background task (a background shell command, subagent, monitor, ...) is still running.
3. The context holds at least `minContextTokens` (default **100,000**) tokens.
4. `idleMinutes` (default **55**) have passed since the last model request of the main conversation was sent.

It compacts at most once per idle stretch; the next model request re-arms it. The conditions are checked every 5 seconds, so a compaction starts at most 5 seconds after the idle time.

The idle time counts from when a request is sent, because that is when the prompt cache's lifetime is refreshed. Compacting just before the one-hour lifetime runs out means the compaction request still reads the conversation from cache, and the session wakes to a smaller context when the background work reports back. If you raise `idleMinutes` towards 60, leave room for the compaction request to be sent in time. This only helps where the session uses the one-hour cache; under the five-minute cache, the cache has expired long before any useful idle time.

## Configuration

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `idleMinutes` | number | `55` | Minutes since the last model request before an idle session with background work running is compacted. |
| `minContextTokens` | number | `100000` | Only compact when the context holds at least this many tokens. |

Set them from `/config`, or in settings:

```json
{ "pluginConfigs": { "idle-compact": { "options": { "idleMinutes": 57, "minContextTokens": 150000 } } } }
```

## Notes

- Background tasks are taken from the `Stop` event at the end of each turn, and checked again just before compacting:
  - Background subagents are checked live (`$.agent.list()`); one no longer pending, running or waiting no longer counts.
  - Shell commands and monitors have no live listing in the plugin API. Each sends a notification when it ends (stopped or killed too), which starts a turn, and that turn's `Stop` takes the count again.
- An interrupted turn counts no background tasks, so nothing is compacted until a turn ends normally.
- The context size is the input of the last model response, as the status line reports it.
- What it tracks is kept in the session's plugin state, so a reload of the plugin (such as changing an option in `/config`) carries on where it was. `/clear` resets it.
