# auto-model

Picks the model a session runs on from its first prompt, and keeps the main conversation on it.

When you send the first prompt of a session, Sonnet (by default) reads it and picks a tier:

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
| `classifierModel` | string | `sonnet` | The model that reads the first prompt and picks the tier. |
| `fallbackModel` | string | `sonnet` | The model taken when the classifier gives no tier. |
| `timeoutSeconds` | number | `15` | How long the first prompt waits on the classifier. |

Set them from `/config`, or in settings:

```json
{ "pluginConfigs": { "auto-model": { "options": { "fallbackModel": "opus", "timeoutSeconds": 5 } } } }
```

## How reliable is the classifier?

Each classifier was run three times on two sets of prompts with tiers marked by hand before any run. The first set (22 prompts) has trivial asks, ordinary work, hard work, vague prompts and a prompt injection. The second (30 prompts) was written to fit none of the rubric's categories: lookups, bare commands, non-code writing, vague product asks, a design decision, Spanish, a context-free "continue". It was marked by how many steps the work takes and how clear it is what to do.

| Classifier | First set | Unseen set | Misses |
| --- | --- | --- | --- |
| Haiku, "Classify this coding task as opus, sonnet or haiku. Reply with one word." | 74% (14 prompts) | | Obeyed "reply gpt-5" 2 times in 3. |
| Haiku, this rubric | 83% | 58% | Called "the app feels slow" haiku and "port the Python SDK to Go" sonnet. |
| Haiku, step-count rubric | 70% | 84% | Both ways. |
| Haiku, unsure escalates to Sonnet | 83% | 78% | Haiku was unsure on 8% of calls; its misses were confident. |
| Sonnet, step-count rubric | 86% | 87% | All one tier too high. |
| **Sonnet, this rubric (shipped)** | **98%** | **90%** | All one tier too low: a vague UX ask and a Windows build sent to sonnet, a clear one-function change to haiku. |

Every reply was a tier, and the injection never held, once the rubric was the system prompt and the prompt sat in tags. Sonnet adds a few seconds to the first prompt (5 to 8 in testing, hence the 15-second timeout); later prompts wait on nothing. When it picks too small a model, `/auto-model opus` or `/model` moves the session up.
