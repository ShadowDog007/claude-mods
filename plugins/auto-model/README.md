# auto-model

Picks the model a session runs on from its first prompt, and keeps the main conversation on it.

When you send the first prompt of a session, a small model (Haiku by default) reads it and picks a tier:

- **haiku**: trivial and quick. A short question, a typo, a rename, a version bump, a one-line change.
- **sonnet**: ordinary engineering work. A feature, a bug fix, tests, a refactor across a few files, debugging from a clear error.
- **opus**: hard or open-ended. Design, large migrations, subtle bugs with no lead (race conditions, flakiness, performance), work across many files.

Every request of the main conversation after that goes to the chosen model. Subagents keep the model they were given. Because the choice sticks for the session, the prompt cache stays warm.

The plugin shows a toast when it routes, and keeps `auto-model: <model>` in its status line under the prompt, because Claude Code's own model display still names the model the session started on.

## How it behaves

- **Only your prompts are routed.** The classifier reads prompts you type, or send from a phone, the SDK or a scheduled task. It skips task notifications, peer messages and slash commands.
- **The prompt is data.** It reaches the classifier in `<message>` tags after a rubric in the system prompt, so a prompt that asks a question, or says "reply gpt", gets classified rather than answered.
- **Fallback.** If the classifier fails, runs past `timeoutSeconds`, or replies with anything but a tier as its first word, the session gets `fallbackModel`.
- **`/model` wins.** If you switch model with `/model`, the plugin stops routing for the rest of the session.
- **`/clear`** routes the next prompt again; a session turned off, or stood down by `/model`, stays that way.
- **`/resume`** brings back the route of the session it resumes, saved by session id in the plugin's store (the last 200 sessions).
- **`/branch`** keeps the route of the conversation it branched from.

## `/auto-model [haiku|sonnet|opus|auto|off]`

- No argument: what the session is routed to, and how it was chosen.
- `haiku`, `sonnet` or `opus`: pins the session to that model.
- `auto`: routes the next prompt again (also after a `/model` switch).
- `off`: stops routing for this session.

## Configuration

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `classifierModel` | string | `haiku` | The model that reads the first prompt and picks the tier. |
| `fallbackModel` | string | `sonnet` | The model taken when the classifier gives no tier. |
| `timeoutSeconds` | number | `8` | How long the first prompt waits on the classifier. |

Set them from `/config`, or in settings:

```json
{ "pluginConfigs": { "auto-model": { "options": { "fallbackModel": "opus", "timeoutSeconds": 5 } } } }
```

## How reliable is the classifier?

The classifier prompt was tested against Haiku on 22 prompts, three runs each (66 calls), with tiers marked by hand: trivial asks, ordinary work, hard work, vague prompts and a prompt injection.

| Prompt | Right tier | Notes |
| --- | --- | --- |
| One line ("Classify this coding task as opus, sonnet or haiku. Reply with one word.") | 74% (14 prompts) | Sent a unit test and a stack-trace fix to haiku; obeyed "reply gpt-5" 2 times in 3; mixed case. |
| Rubric in the user message | 89% | Unsteady on vague and mid-sized prompts. |
| Rubric in the system prompt | 74% (14 prompts) | Promoted ordinary work to opus. |
| Rubric and examples in the system prompt, the prompt in tags | 89% | Answered 4 of 66 questions instead of classifying them. |
| The same, plus a closing question after the tags (shipped) | 94% | Every reply a tier; the injection never held. The misses were borderline (a unit test sent to haiku, a flaky test to sonnet). |
