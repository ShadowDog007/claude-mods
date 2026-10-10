import { atom, read, update } from 'claude-code';
import type { EngineInterface, Register } from 'claude-code';

import type { PromptQueue } from '../types';

const EMPTY: PromptQueue = { prompts: [], isPaused: false };
// How many queued prompts the band lists before it counts the rest.
const SHOWN = 3;
const PREVIEW_LENGTH = 80;

// Kept in the session's state, so a reload keeps what was queued.
const queue = atom({ plugin: 'prompt-queue', key: 'queue' } as const, EMPTY);

// Whether a main-loop turn is running. A plain variable: a reload mid-turn
// reads idle until the next turn starts, and a prompt sent then still waits
// for the session to go idle, as every plugin's prompt does.
let isTurnRunning = false;
// Set from sending a queued prompt until its turn has started, so a turn that
// ends in the meantime (a steering prompt that went first) sends no second.
let isSending = false;
// Set when a prompt of the person's own reaches the session, and cleared as a
// turn ends: only a turn they started resumes a paused queue, not one a
// background task or another plugin woke.
let hasPersonPrompted = false;
// An `@file` mention, which the engine expands for the person's prompt but
// not for a plugin's.
const MENTION = /(^|\s)@\S/;

function preview(text: string) {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > PREVIEW_LENGTH ? `${line.slice(0, PREVIEW_LENGTH - 1)}…` : line;
}

function plural(count: number) {
  return count === 1 ? '1 prompt' : `${count} prompts`;
}

async function enqueue($: EngineInterface, text: string) {
  return update($, queue, current => ({ ...current, prompts: [...current.prompts, text] }));
}

// Sends the oldest queued prompt, as the person's own words, once no turn is
// running and the queue is not paused. The engine runs a plugin's prompt once
// the session is idle, behind any steering prompt already waiting there.
async function sendNext($: EngineInterface) {
  if (isTurnRunning || isSending) return;
  const current = await read($, queue);
  const text = current.prompts[0];
  if (current.isPaused || text === undefined) return;
  await update($, queue, latest => ({ ...latest, prompts: latest.prompts.slice(1) }));
  isSending = true;
  // Not awaited: it resolves once the prompt's turn has started, which the
  // hook calling this may be holding up.
  $.prompt
    .submit({ text, asUser: true })
    .then(result => (result.drop === undefined ? undefined : Promise.reject(new Error(result.drop))))
    .catch(async error => {
      // Back at the front, paused, rather than lost.
      $.ui.log(`prompt-queue: could not send a queued prompt: ${error instanceof Error ? error.message : String(error)}`);
      await update($, queue, latest => ({ prompts: [text, ...latest.prompts], isPaused: true }));
    })
    .finally(() => {
      isSending = false;
    });
}

// From a command: the engine refuses a prompt submitted inside a `command.run`
// hook, which would wait on the turn the hook holds, so it goes on a timer.
function sendNextSoon($: EngineInterface) {
  $.clock.after(0, () => sendNext($));
}

function describe(current: PromptQueue) {
  if (current.prompts.length < 1) return 'prompt-queue: nothing queued';
  const lines = current.prompts.map((text, index) => `${index + 1}. ${preview(text)}`);
  const state = current.isPaused ? ' (paused; /queue-resume sends the next)' : '';
  return [`prompt-queue: ${plural(current.prompts.length)} queued${state}`, ...lines].join('\n');
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'queue',
      description: 'Queue a prompt to send after the current turn ends; with nothing after it, list the queue',
      argumentHint: '[prompt]',
      immediate: true,
    });
    await $.command.register({
      name: 'queue-clear',
      description: 'Drop every queued prompt',
      immediate: true,
    });
    await $.command.register({
      name: 'queue-resume',
      description: 'Resume a queue paused by an interrupted turn',
      immediate: true,
    });
    return next(e);
  });

  // `chat:queueSubmit` (ctrl+x enter) while a turn runs: held here instead of
  // reaching the running turn. A plain Enter steers, as it always does.
  on('prompt.submit', async ($, e, next) => {
    const isPerson = e.origin.kind === 'composer' || e.origin.kind === 'bridge';
    if (!isPerson) return next(e);
    if (!e.wait || e.turnId === undefined) {
      hasPersonPrompted = true;
      return next(e);
    }
    if ((e.attachments !== undefined && e.attachments.length > 0) || MENTION.test(e.text)) {
      $.ui.toast('prompt-queue: a prompt with attachments or @-mentions cannot be queued; sent as usual');
      hasPersonPrompted = true;
      return next(e);
    }
    const current = await enqueue($, e.text);
    $.ui.toast(`prompt-queue: queued (${plural(current.prompts.length)} waiting)`);
    // The turn it was typed over may have ended while it was on its way.
    if (!isTurnRunning) sendNextSoon($);
    return { drop: 'queued by prompt-queue until the turn ends' };
  });

  on('command.run', { command: 'queue' }, async ($, e) => {
    const text = e.args.trim();
    if (text === '') return { text: describe(await read($, queue)) };
    const current = await enqueue($, text);
    // Idle with nothing ahead of it, it goes at once.
    if (!isTurnRunning && !isSending && !current.isPaused && current.prompts.length === 1) {
      sendNextSoon($);
      return { text: 'prompt-queue: sent' };
    }
    const paused = current.isPaused ? ' (the queue is paused; /queue-resume sends the next)' : '';
    return { text: `prompt-queue: queued as #${current.prompts.length}${paused}` };
  });

  on('command.run', { command: 'queue-clear' }, async $ => {
    const { prompts } = await read($, queue);
    await update($, queue, () => EMPTY);
    return { text: `prompt-queue: dropped ${plural(prompts.length)}` };
  });

  on('command.run', { command: 'queue-resume' }, async $ => {
    const current = await update($, queue, latest => ({ ...latest, isPaused: false }));
    if (current.prompts.length < 1) return { text: 'prompt-queue: nothing queued' };
    if (isTurnRunning) return { text: 'prompt-queue: resumed; the next prompt is sent after this turn' };
    sendNextSoon($);
    return { text: 'prompt-queue: resumed' };
  });

  // Main-loop turns only: a subagent's run raises no `turn.start`.
  on('turn.start', async ($, e, next) => {
    isTurnRunning = true;
    return next(e);
  });

  on('turn.complete', async ($, e, next) => {
    const result = await next(e);
    if (e.agentId !== undefined) return result;
    isTurnRunning = false;
    const isTheirs = hasPersonPrompted;
    hasPersonPrompted = false;
    if (e.reason === 'answer') {
      if (isTheirs) await update($, queue, current => (current.isPaused ? { ...current, isPaused: false } : current));
      await sendNext($);
    } else {
      // Interrupted (Esc) or failed: wait for the person rather than carry on.
      await update($, queue, current =>
        current.prompts.length > 0 && !current.isPaused ? { ...current, isPaused: true } : current,
      );
    }
    return result;
  });

  // A /clear starts the conversation over; what was queued was for the old one.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') await update($, queue, () => EMPTY);
    return next(e);
  });

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const current = await read($, queue);
    if (e.props.hasSurvey || current.prompts.length < 1) return next(e);
    const { Box, Text } = $.ui.resolve(e);
    const hidden = current.prompts.length - SHOWN;
    return (
      <Box flexDirection="column">
        <Text dimColor>
          {`Queued: ${plural(current.prompts.length)} · `}
          {current.isPaused ? 'paused, /queue-resume to send' : 'sent after the turn ends'}
        </Text>
        {current.prompts.slice(0, SHOWN).map((text, index) => (
          <Text dimColor>{`${index + 1}. ${preview(text)}`}</Text>
        ))}
        {hidden > 0 ? <Text dimColor>{`+${hidden} more (/queue lists them)`}</Text> : null}
      </Box>
    );
  });
};
