/**
 * Automatic continuation after a provider-rejected model request.
 *
 * A request the provider rejects with a rejection code cannot succeed when it is
 * resent unchanged: the request-retry plugin therefore never recovers it, and the
 * whole turn dies. What does work is a fresh turn carrying one new user message —
 * the same thing a human does by typing "continue". This plugin watches turn
 * endings, waits for the agent to go idle, and submits a bounded,
 * backoff-spaced continuation from its own durable message source.
 *
 * `cordis.patch.yml` carries the configuration; README.md carries the contract,
 * the evidence behind it, and the costs.
 *
 * @module dsh-auto-continue
 */

import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'

export const name = 'auto-continue'

/** The live agent registry is the only service this plugin reads. */
export const inject = ['agents']

/** Producer-owned message-source kind of every submitted continuation. */
const SOURCE_KIND = 'auto-continue'

const DEFAULT_CODES = ['INVALID_REQUEST']
const DEFAULT_DELAYS_MS = [15_000, 60_000, 240_000]
const DEFAULT_MAX_CONTINUES = 3
const KNOWN_KEYS = new Set(['enabled', 'codes', 'maxContinues', 'delaysMs', 'skipActiveGoal'])

/**
 * Validate one configuration object, filling documented defaults.
 *
 * Misconfiguration fails loud at plugin load rather than degrading silently: a
 * deployment that asks for a delay of zero, a fractional budget, or an unknown
 * key has a typo, not a policy.
 *
 * @param {unknown} raw - the `config` mapping from the cordis row.
 * @returns {{ enabled: boolean, codes: Set<string>, maxContinues: number, delaysMs: number[], skipActiveGoal: boolean }}
 * @throws {Error} when a value is absent-but-required, malformed, or unknown.
 */
function resolveConfig(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('auto-continue: config must be a mapping')
  }
  for (const key of Object.keys(raw)) {
    if (!KNOWN_KEYS.has(key)) throw new Error(`auto-continue: unknown config key "${key}"`)
  }
  const enabled = raw.enabled ?? true
  if (typeof enabled !== 'boolean') throw new Error('auto-continue: enabled must be a boolean')
  const codes = raw.codes ?? [...DEFAULT_CODES]
  if (!Array.isArray(codes) || codes.length === 0) {
    throw new Error('auto-continue: codes must list at least one failure code')
  }
  for (const code of codes) {
    if (typeof code !== 'string' || code.length === 0) {
      throw new Error('auto-continue: codes must contain only non-empty strings')
    }
  }
  if (new Set(codes).size !== codes.length) throw new Error('auto-continue: codes must not repeat')
  const maxContinues = raw.maxContinues ?? DEFAULT_MAX_CONTINUES
  if (!Number.isInteger(maxContinues) || maxContinues < 1) {
    throw new Error('auto-continue: maxContinues must be a positive integer')
  }
  const delaysMs = raw.delaysMs ?? [...DEFAULT_DELAYS_MS]
  if (!Array.isArray(delaysMs) || delaysMs.length === 0) {
    throw new Error('auto-continue: delaysMs must list at least one delay')
  }
  for (const delay of delaysMs) {
    if (typeof delay !== 'number' || !Number.isFinite(delay) || delay <= 0) {
      throw new Error('auto-continue: delaysMs must contain positive finite milliseconds')
    }
  }
  const skipActiveGoal = raw.skipActiveGoal ?? true
  if (typeof skipActiveGoal !== 'boolean') {
    throw new Error('auto-continue: skipActiveGoal must be a boolean')
  }
  return { enabled, codes: new Set(codes), maxContinues, delaysMs: [...delaysMs], skipActiveGoal }
}

/** Render one thrown value for a log line. */
function reason(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Whether the goal driver currently owns this session's continuation.
 *
 * The conjunction is the whole point. `phase` is durable, but `activation` is
 * process-local: `@deepseek-ai/dsh-goal` keeps it out of the durable projection,
 * the driver disarms it on every failed turn, and a goal reloaded after a restart
 * starts disarmed again. So a goal the driver has already let go of still reads
 * `phase: 'active'` — a session nobody is driving, which is exactly the gap a
 * continuation fills. Declining on `phase` alone silently disables this plugin in
 * every goal session forever (observed: a 400 ten minutes after a goal was created
 * was never continued, while three earlier identical ones in that session were).
 *
 * An unreadable goal keeps its authority: the fence wins over recovery.
 *
 * @param {object} ctx - the plugin context; `goals` is an optional service.
 * @param {object} agent - the live agent whose turn just ended.
 * @returns {boolean} true when a live, armed goal owns this session's continuation.
 */
function goalDriverOwns(ctx, agent) {
  try {
    const goal = ctx.get('goals')?.get(agent)
    return goal?.phase === 'active' && goal.activation === 'armed'
  } catch (error) {
    ctx.logger.warn(
      `auto-continue: could not read the goal for agent "${agent.id}": ${reason(error)}`,
    )
    return true
  }
}

/**
 * Install the continuation policy for every agent in this plugin's scope.
 *
 * @param {object} ctx - the plugin context; `agents` must be injected.
 * @param {object} [config] - the cordis row's `config` mapping.
 */
export function apply(ctx, config = {}) {
  const settings = resolveConfig(config)
  if (!settings.enabled) return

  /** @type {Map<object, { count: number, pending: { code: string, turn: number } | undefined, timer: ReturnType<typeof setTimeout> | undefined }>} */
  const states = new Map()
  let disposed = false

  /** Read or create the bookkeeping for one exact live agent. */
  function entryFor(agent) {
    let entry = states.get(agent)
    if (entry === undefined) {
      entry = { count: 0, pending: undefined, timer: undefined }
      states.set(agent, entry)
    }
    return entry
  }

  /** Drop the reservation and its wait; the streak itself stays for its caller to decide. */
  function cancel(entry) {
    if (entry.timer !== undefined) {
      clearTimeout(entry.timer)
      entry.timer = undefined
    }
    entry.pending = undefined
  }

  /** Submit one continuation whose wait elapsed, if the reservation is still the live one. */
  function deliver(agent, entry, reservation) {
    // A newer turn ending, human input, or a new turn supersedes every older
    // reservation, so only identity with the newest one may submit.
    if (disposed || entry.pending !== reservation) return
    cancel(entry)
    if (ctx.agents.get(agent.id) !== agent) {
      states.delete(agent)
      return
    }
    // A busy agent is running its own turn; a synthetic one would fight it.
    if (agent.status !== 'idle') return
    const round = entry.count + 1
    const content = [{
      type: 'text',
      text: 'Your previous request was rejected by the provider before it produced any output.'
        + ' Continue the task from the current state.'
        + ` (automatic recovery ${round} of ${settings.maxContinues})`,
    }]
    const source = {
      kind: SOURCE_KIND,
      form: 'notice',
      summary: boundContextSummary(
        `auto-continue ${round}/${settings.maxContinues} — ${reservation.code}`,
      ),
    }
    try {
      // The submission itself spends the budget, before the driver can wake.
      entry.count = round
      agent.followup(createUserMessage({ content, source }))
      ctx.logger.info(
        `auto-continue: submitted recovery ${round}/${settings.maxContinues} for agent "${agent.id}"`
        + ` after ${reservation.code}`,
      )
    } catch (error) {
      // A rejected submission must not consume the budget of a session that still
      // needs recovery.
      entry.count = round - 1
      ctx.logger.warn(`auto-continue: could not submit a recovery for agent "${agent.id}": ${reason(error)}`)
    }
  }

  // The newest turn ending decides whether a continuation is owed: a session that
  // recovered on its own, took human input, or failed for an unrelated reason
  // reserves nothing.
  ctx.on('session/event', (session, event) => {
    if (disposed) return
    const agent = ctx.agents.get(session.id)
    if (agent === undefined || agent.session !== session) return
    const entry = entryFor(agent)
    if (event.type === 'assistant/message') {
      entry.count = 0
      cancel(entry)
      return
    }
    if (event.type === 'user/message') {
      // Human (or another producer's) input owns the session again; this plugin's
      // own submission keeps its budget.
      if (event.data.source.kind !== SOURCE_KIND) {
        entry.count = 0
        cancel(entry)
      }
      return
    }
    if (event.type === 'turn/start') {
      cancel(entry)
      return
    }
    if (event.type !== 'turn/end') return
    cancel(entry)
    if (event.data.reason.kind !== 'error') return
    if (entry.count >= settings.maxContinues) return
    const code = event.data.reason.error.code
    if (!settings.codes.has(code)) return
    // An armed goal owns the session: its driver queues the next round, and this
    // plugin must not route around it. A disarmed goal (the driver gave up on a
    // failure, or the goal reloaded after a restart) is waiting for input instead —
    // that one this plugin recovers.
    if (settings.skipActiveGoal && goalDriverOwns(ctx, agent)) return
    entry.pending = { code, turn: event.data.turn }
  })

  // A continuation is only ever submitted from idle, and never while queued input
  // is about to open a turn of its own.
  ctx.on('agent/status', ({ agent, status }) => {
    if (disposed) return
    const entry = states.get(agent)
    if (entry === undefined) return
    if (status !== 'idle') {
      cancel(entry)
      return
    }
    const reservation = entry.pending
    if (reservation === undefined || entry.timer !== undefined) return
    const delay = settings.delaysMs[Math.min(entry.count, settings.delaysMs.length - 1)]
    entry.timer = setTimeout(() => {
      entry.timer = undefined
      deliver(agent, entry, reservation)
    }, delay)
  })

  ctx.effect(function* () {
    yield ctx.on('agent/disposed', ({ agent }) => {
      const entry = states.get(agent)
      if (entry === undefined) return
      cancel(entry)
      states.delete(agent)
    })
    yield () => {
      disposed = true
      for (const entry of states.values()) cancel(entry)
      states.clear()
    }
  }, 'auto-continue lifecycle')
}
