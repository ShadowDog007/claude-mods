# idle-compact

Automatically runs `/compact` when a session has been left waiting on background work.

It compacts when all of these hold:

1. The current turn has ended (the agent is not working).
2. At least one background task (a background shell command, subagent, monitor, ...) was still running when the turn ended.
3. `idleMinutes` (default **50**) have passed since the last model request of the main conversation.

It compacts at most once per idle stretch; the next model request re-arms it. The conditions are checked every 30 seconds.

The default of 50 minutes sits just under the one-hour prompt cache lifetime, so the compaction request still reads the conversation from cache, and the session wakes to a smaller context when the background work reports back.

## Configuration

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `idleMinutes` | number | `50` | Minutes since the last model call before an idle session with background work running is compacted. |

Set it from `/config`, or in settings:

```json
{ "pluginConfigs": { "idle-compact": { "options": { "idleMinutes": 30 } } } }
```

## Notes

- Background tasks are counted from the `Stop` event at the end of each turn. A task that finishes, or is stopped, without starting a turn still counts until the next turn ends.
- An interrupted turn counts no background tasks, so nothing is compacted until a turn ends normally.
