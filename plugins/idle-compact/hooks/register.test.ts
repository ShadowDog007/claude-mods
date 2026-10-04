import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { expect, mock, test } from 'claude-code/testing'

const MINUTE = 60_000
const SHELL = { id: 'b1', type: 'shell', status: 'running', description: 'npm run dev' }

// Stands in for the engine beneath the plugin: a session, a model request
// that answers at once, and a compaction that counts its calls (and fails
// when `isFailing`).
function engine(on: On, isFailing = false) {
  const clock = mock.clock(on, { now: 0 })
  const compacted = { count: 0 }
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('classic.Stop', () => ({}))
  on('turn.step', async function* (_$, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  on('session.compact', () => {
    compacted.count++
    if (isFailing) throw new Error('provider down')
    return { messages: [{ role: 'user', text: 'summary', toolUses: [] }] }
  })
  return { clock, compacted }
}

async function turn($: Engine, backgroundTasks: (typeof SHELL)[]) {
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'go', turnId: 't1' })
  const step = $.turn.step({ turnId: 't1', index: 0, model: 'm', messageCount: 1 })
  for await (const _ of step);
  await $.classic.Stop({ stop_hook_active: false, background_tasks: backgroundTasks })
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
}

test('compacts once after 50 idle minutes with a background command running', async ($, on) => {
  const { clock, compacted } = engine(on)
  await turn($, [SHELL])

  await clock.advance(49 * MINUTE)
  expect(compacted.count).toBe(0)

  await clock.advance(2 * MINUTE)
  expect(compacted.count).toBe(1)

  await clock.advance(120 * MINUTE)
  expect(compacted.count).toBe(1)
})

test('does not compact with no background work in flight', async ($, on) => {
  const { clock, compacted } = engine(on)
  await turn($, [])

  await clock.advance(120 * MINUTE)
  expect(compacted.count).toBe(0)
})

test('does not compact while a turn is running', async ($, on) => {
  const { clock, compacted } = engine(on)
  await turn($, [SHELL])
  await $.turn.start({ text: '', turnId: 't2' })

  await clock.advance(120 * MINUTE)
  expect(compacted.count).toBe(0)
})

test('honours a configured idle time', { options: { idleMinutes: 10 } }, async ($, on) => {
  const { clock, compacted } = engine(on)
  await turn($, [SHELL])

  await clock.advance(9 * MINUTE)
  expect(compacted.count).toBe(0)

  await clock.advance(2 * MINUTE)
  expect(compacted.count).toBe(1)
})

test('does not retry a compaction that failed', async ($, on) => {
  const { clock, compacted } = engine(on, true)
  await turn($, [SHELL])

  await clock.advance(120 * MINUTE)
  expect(compacted.count).toBe(1)
})

test('does not compact once the background subagent has finished', async ($, on) => {
  const { clock, compacted } = engine(on)
  await turn($, [{ id: 'a1', type: 'subagent', status: 'running', description: 'review' }])

  await clock.advance(120 * MINUTE)
  expect(compacted.count).toBe(0)
})
