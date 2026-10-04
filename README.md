# claude-mods

A [Claude Code plugin marketplace](https://code.claude.com/docs/en/plugin-marketplaces).

## Install

```
/plugin marketplace add ShadowDog007/claude-mods
```

Then browse and install plugins with `/plugin`.

## Plugins

| Plugin | Description |
| --- | --- |
| [idle-compact](plugins/idle-compact) | Runs `/compact` while the session sits idle waiting on background work, right before the prompt cache expires. |
| [context-bar](plugins/context-bar) | A coloured bar above the prompt showing what fills the context window, by category, and how much the last turn and its steps added. |
| [prompt-queue](plugins/prompt-queue) | Queues prompts (`ctrl+x enter` or `/queue`) to run after the current turn ends, while a plain Enter keeps steering the running turn. |
