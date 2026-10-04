import type { EngineInterface, Register } from 'claude-code'

const DEFAULT_IDLE_MINUTES = 50
const POLL_MS = 30_000

// Whether a main-loop turn is running, when its last model request ended, and
// how many background tasks the last finished turn left in flight. Reset with
// the module, so a reload waits for the next turn before compacting.
const session = {
  isTurnRunning: false,
  lastModelCallAt: undefined as number | undefined,
  backgroundTasks: 0,
  // One compaction per idle stretch: the next model call re-arms it.
  hasCompacted: false,
}

async function compactIfIdle($: EngineInterface, idleMs: number) {
  if (session.isTurnRunning || session.hasCompacted) return
  if (session.backgroundTasks < 1 || session.lastModelCallAt === undefined) return
  if ((await $.clock.now()) - session.lastModelCallAt < idleMs) return

  // Counted whether it lands or not, so a failure is not retried every poll;
  // a turn started meanwhile makes a model call, which re-arms it anyway.
  session.hasCompacted = true
  try {
    const result = await $.session.compact()
    if ('skip' in result) $.ui.log(`idle-compact: compaction skipped: ${result.skip}`)
    else $.ui.toast('idle-compact: compacted the idle session')
  } catch (error) {
    $.ui.log(`idle-compact: compaction failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export const register: Register = (on, options) => {
  const configured = Number(options.idleMinutes)
  const idleMs = (configured > 0 ? configured : DEFAULT_IDLE_MINUTES) * 60_000

  on('session.start', ($, e, next) => {
    $.clock.every(POLL_MS, () => compactIfIdle($, idleMs))
    return next(e)
  })

  on('turn.start', ($, e, next) => {
    session.isTurnRunning = true
    // Recounted when the turn stops; an interrupted turn leaves none counted.
    session.backgroundTasks = 0
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) session.isTurnRunning = true
    try {
      return yield* next(e)
    } finally {
      if (e.agentId === undefined) {
        session.lastModelCallAt = await $.clock.now()
        session.hasCompacted = false
      }
    }
  })

  on('classic.Stop', ($, e, next) => {
    if (e.agent_id === undefined) {
      session.isTurnRunning = false
      session.backgroundTasks = e.background_tasks?.length ?? 0
    }
    return next(e)
  })

  on('turn.complete', ($, e, next) => {
    if (e.agentId === undefined) session.isTurnRunning = false
    return next(e)
  })
}
