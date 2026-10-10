# idle-compact

Automatically runs `/compact` when a session has been left waiting on background work, right before the prompt cache expires.

It compacts when all of these hold:

1. The current turn has ended (the agent is not working).
2. At least one background task (a background shell command, subagent, monitor, ...) is still running, unless `/idle-compact on` is set.
3. The context holds at least `minContextTokens` (default **100,000**) tokens.
4. The idle time has passed since the last model request of the main conversation was sent.

It compacts at most once per idle stretch; the next model request re-arms it. When a turn ends with background work running, it sets a timer for the moment the idle time runs out and checks the conditions again when it fires.

The idle time counts from when a request is sent, because that is when the prompt cache's lifetime is refreshed. Compacting just before the lifetime runs out means the compaction request still reads the conversation from cache, and the session wakes to a smaller context when the background work reports back. It is a minute short of the cache's lifetime, which it works out as Claude Code picks it:

- **59 minutes** under the one-hour cache: a Claude subscription within its plan's usage.
- **4 minutes** under the five-minute cache: an API key, a cloud provider, or a subscription past its plan's usage (on usage credits).
- `FORCE_PROMPT_CACHING_5M`, `CLAUDE_CODE_PROMPT_CACHE_TTL`, the `promptCacheTtl` setting and `ENABLE_PROMPT_CACHING_1H` override that, in that order, as they do the cache itself.

Whether the session is on a subscription is read from the usage limits each response reports, so until the first response it takes the one-hour cache. Set `idleMinutes` to pick the idle time yourself.

While a compaction is scheduled and the context is big enough for it, the plugin pins `idle-compact scheduled for HH:MM` (local time) as its own status line under the prompt. The line clears when a turn starts, when it compacts, or when there's nothing left to compact for. When it compacts, it also shows a toast.

## `/idle-compact [auto|on|off]`

Sets when it compacts, for the rest of the session (a `/clear` keeps it):

- `auto` (the default): only while background work runs, as above.
- `on`: whenever the session sits idle, background work or not.
- `off`: never.

With no argument it says what it is set to, the idle time, and the cache lifetime it worked out. It runs at once, even mid-turn.

## Configuration

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `idleMinutes` | number | `0` | Minutes since the last model request before an idle session is compacted. `0` follows the prompt cache: 4 under its five-minute lifetime, 59 under its one-hour lifetime. |
| `minContextTokens` | number | `100000` | Only compact when the context holds at least this many tokens. |

Set them from `/config`, or in settings:

```json
{ "pluginConfigs": { "idle-compact": { "options": { "idleMinutes": 57, "minContextTokens": 150000 } } } }
```

## Notes

- Background tasks are taken from the `Stop` event at the end of each turn, and checked again just before compacting:
  - Background subagents are checked live (`$.agent.list()`); one that is not pending, running or waiting does not count.
  - Shell commands and monitors have no live listing in the plugin API. Each sends a notification when it ends (stopped or killed too), which starts a turn, and that turn's `Stop` takes the count again.
- An interrupted turn counts no background tasks, so nothing is compacted until a turn ends normally.
- The context size is the input of the last model response, as the status line reports it.
- What it tracks is kept in the session's plugin state, so a reload of the plugin (such as changing an option in `/config`) carries on where it was. `/clear` resets it.
