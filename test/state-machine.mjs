// State-machine coverage for index.js. No DSH runtime is involved: a hand-made
// context records the listeners the plugin registers, and the test drives them.
import assert from 'node:assert/strict'
import test from 'node:test'
import { apply } from '../index.js'

/** Build a cordis-shaped context with an event registry, effect disposers, and agents. */
function harness(config = {}) {
  const listeners = new Map()
  const agents = []
  const disposers = []
  const logs = { info: [], warn: [] }
  const services = new Map()
  const ctx = {
    logger: {
      info: (message) => logs.info.push(String(message)),
      warn: (message) => logs.warn.push(String(message)),
    },
    agents: { get: (id) => agents.find((agent) => agent.id === id) },
    get: (service) => services.get(service),
    on(event, handler) {
      const list = listeners.get(event) ?? []
      list.push(handler)
      listeners.set(event, list)
      return () => {
        listeners.set(event, (listeners.get(event) ?? []).filter((entry) => entry !== handler))
      }
    },
    effect(callback) {
      const produced = callback()
      if (produced !== null && typeof produced === 'object' && typeof produced.next === 'function') {
        for (let step = produced.next(); step.done !== true; step = produced.next()) disposers.push(step.value)
      } else if (typeof produced === 'function') {
        disposers.push(produced)
      }
    },
  }
  apply(ctx, config)
  return {
    ctx,
    logs,
    services,
    agents,
    emit(event, ...args) {
      for (const handler of [...(listeners.get(event) ?? [])]) handler(...args)
    },
    spawn(id = 'session-1') {
      const agent = {
        id,
        status: 'idle',
        session: { id },
        delivered: [],
        followup(message) {
          this.delivered.push(message)
        },
      }
      agents.push(agent)
      return agent
    },
    dispose() {
      for (const disposer of [...disposers].reverse()) disposer()
    },
  }
}

const rejected = (turn, code = 'INVALID_REQUEST') => ({
  type: 'turn/end',
  data: { turn, reason: { kind: 'error', error: { message: `${code} fixture`, code } } },
})
const ended = (turn, kind = 'completed') => ({ type: 'turn/end', data: { turn, reason: { kind } } })
const settled = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms))

test('submits one continuation after the delay, as a notice from its own source', async () => {
  const h = harness({ delaysMs: [1], maxContinues: 2 })
  const agent = h.spawn()
  h.emit('session/event', agent.session, rejected(1))
  h.emit('agent/status', { agent, status: 'idle' })
  await settled()

  assert.equal(agent.delivered.length, 1)
  const [message] = agent.delivered
  assert.equal(message.role, 'user')
  assert.equal(message.source.kind, 'auto-continue')
  assert.equal(message.source.form, 'notice')
  assert.equal(message.source.summary, 'auto-continue 1/2 — INVALID_REQUEST')
  assert.match(message.content[0].text, /automatic recovery 1 of 2/)
  assert.ok(Object.isFrozen(message))
  assert.equal(h.logs.info.length, 1)
})

test('waits for idle: a running agent receives nothing', async () => {
  const h = harness({ delaysMs: [1] })
  const agent = h.spawn()
  h.emit('session/event', agent.session, rejected(1))
  h.emit('agent/status', { agent, status: 'running' })
  await settled()
  assert.equal(agent.delivered.length, 0)
})

test('a turn that ended without an error reserves nothing', async () => {
  const h = harness({ delaysMs: [1] })
  const agent = h.spawn()
  for (const event of [ended(1), ended(2, 'aborted'), ended(3, 'max-tokens')]) {
    h.emit('session/event', agent.session, event)
    h.emit('agent/status', { agent, status: 'idle' })
  }
  await settled()
  assert.equal(agent.delivered.length, 0)
})

test('only the configured failure codes trigger, and the list is the policy', async () => {
  const h = harness({ delaysMs: [1] })
  const agent = h.spawn()
  h.emit('session/event', agent.session, rejected(1, 'RATE_LIMIT'))
  h.emit('agent/status', { agent, status: 'idle' })
  await settled()
  assert.equal(agent.delivered.length, 0)

  const allowed = harness({ delaysMs: [1], codes: ['RATE_LIMIT'] })
  const other = allowed.spawn()
  allowed.emit('session/event', other.session, rejected(1, 'RATE_LIMIT'))
  allowed.emit('agent/status', { agent: other, status: 'idle' })
  await settled()
  assert.equal(other.delivered.length, 1)
})

test('the budget is bounded and the last failure goes back to the human', async () => {
  const h = harness({ delaysMs: [1], maxContinues: 3 })
  const agent = h.spawn()
  for (let turn = 1; turn <= 4; turn += 1) {
    h.emit('session/event', agent.session, rejected(turn))
    h.emit('agent/status', { agent, status: 'idle' })
    await settled()
  }
  assert.equal(agent.delivered.length, 3)
  assert.deepEqual(
    agent.delivered.map((message) => message.source.summary),
    ['auto-continue 1/3 — INVALID_REQUEST', 'auto-continue 2/3 — INVALID_REQUEST', 'auto-continue 3/3 — INVALID_REQUEST'],
  )
})

test('a successful model output resets the streak', async () => {
  const h = harness({ delaysMs: [1], maxContinues: 3 })
  const agent = h.spawn()
  h.emit('session/event', agent.session, rejected(1))
  h.emit('agent/status', { agent, status: 'idle' })
  await settled()
  h.emit('session/event', agent.session, { type: 'assistant/message', data: {} })
  h.emit('session/event', agent.session, rejected(2))
  h.emit('agent/status', { agent, status: 'idle' })
  await settled()
  assert.deepEqual(
    agent.delivered.map((message) => message.source.summary),
    ['auto-continue 1/3 — INVALID_REQUEST', 'auto-continue 1/3 — INVALID_REQUEST'],
  )
})

test('human input cancels the wait and resets the streak', async () => {
  const h = harness({ delaysMs: [20], maxContinues: 3 })
  const agent = h.spawn()
  h.emit('session/event', agent.session, rejected(1))
  h.emit('agent/status', { agent, status: 'idle' })
  h.emit('session/event', agent.session, { type: 'user/message', data: { source: { kind: 'user' } } })
  await settled(60)
  assert.equal(agent.delivered.length, 0)
})

test("the plugin's own continuation keeps the budget", async () => {
  const h = harness({ delaysMs: [1], maxContinues: 3 })
  const agent = h.spawn()
  h.emit('session/event', agent.session, rejected(1))
  h.emit('agent/status', { agent, status: 'idle' })
  await settled()
  h.emit('session/event', agent.session, {
    type: 'user/message',
    data: { source: { kind: 'auto-continue', form: 'notice', summary: 'auto-continue 1/3' } },
  })
  h.emit('session/event', agent.session, rejected(2))
  h.emit('agent/status', { agent, status: 'idle' })
  await settled()
  assert.deepEqual(
    agent.delivered.map((message) => message.source.summary),
    ['auto-continue 1/3 — INVALID_REQUEST', 'auto-continue 2/3 — INVALID_REQUEST'],
  )
})

test('a new turn cancels the pending wait', async () => {
  const h = harness({ delaysMs: [20] })
  const agent = h.spawn()
  h.emit('session/event', agent.session, rejected(1))
  h.emit('agent/status', { agent, status: 'idle' })
  h.emit('session/event', agent.session, { type: 'turn/start', data: { turn: 2 } })
  await settled(60)
  assert.equal(agent.delivered.length, 0)
})

test('an active goal keeps its own continuation authority', async () => {
  const h = harness({ delaysMs: [1] })
  h.services.set('goals', { get: () => ({ phase: 'active' }) })
  const agent = h.spawn()
  h.emit('session/event', agent.session, rejected(1))
  h.emit('agent/status', { agent, status: 'idle' })
  await settled()
  assert.equal(agent.delivered.length, 0)

  const opting = harness({ delaysMs: [1], skipActiveGoal: false })
  opting.services.set('goals', { get: () => ({ phase: 'active' }) })
  const other = opting.spawn()
  opting.emit('session/event', other.session, rejected(1))
  opting.emit('agent/status', { agent: other, status: 'idle' })
  await settled()
  assert.equal(other.delivered.length, 1)
})

test('a session with no live agent is ignored', async () => {
  const h = harness({ delaysMs: [1] })
  h.emit('session/event', { id: 'closed-session' }, rejected(1))
  h.emit('agent/status', { agent: h.spawn('unrelated'), status: 'idle' })
  await settled()
  assert.equal(h.agents[0].delivered.length, 0)
})

test('a disposed agent and a disposed plugin both stop the wait', async () => {
  const h = harness({ delaysMs: [20] })
  const agent = h.spawn()
  h.emit('session/event', agent.session, rejected(1))
  h.emit('agent/status', { agent, status: 'idle' })
  h.emit('agent/disposed', { agent })
  await settled(60)
  assert.equal(agent.delivered.length, 0)

  const second = harness({ delaysMs: [20] })
  const other = second.spawn()
  second.emit('session/event', other.session, rejected(1))
  second.emit('agent/status', { agent: other, status: 'idle' })
  second.dispose()
  await settled(60)
  assert.equal(other.delivered.length, 0)
})

test('a rejected submission does not consume the budget', async () => {
  const h = harness({ delaysMs: [1] })
  const agent = h.spawn()
  agent.followup = () => {
    throw new Error('no driver')
  }
  h.emit('session/event', agent.session, rejected(1))
  h.emit('agent/status', { agent, status: 'idle' })
  await settled()
  assert.equal(h.logs.warn.length, 1)

  agent.followup = function followup(message) {
    this.delivered.push(message)
  }
  h.emit('session/event', agent.session, rejected(2))
  h.emit('agent/status', { agent, status: 'idle' })
  await settled()
  assert.deepEqual(
    agent.delivered.map((message) => message.source.summary),
    ['auto-continue 1/3 — INVALID_REQUEST'],
  )
})

test('invalid configuration fails loud at load', () => {
  const cases = [
    [null, /must be a mapping/],
    [{ typo: true }, /unknown config key "typo"/],
    [{ enabled: 'yes' }, /enabled must be a boolean/],
    [{ codes: [] }, /at least one failure code/],
    [{ codes: [''] }, /non-empty strings/],
    [{ codes: ['A', 'A'] }, /must not repeat/],
    [{ maxContinues: 0 }, /positive integer/],
    [{ maxContinues: 1.5 }, /positive integer/],
    [{ delaysMs: [] }, /at least one delay/],
    [{ delaysMs: [0] }, /positive finite milliseconds/],
    [{ skipActiveGoal: 'no' }, /skipActiveGoal must be a boolean/],
  ]
  for (const [config, expected] of cases) {
    assert.throws(() => harness(config), expected)
  }
})

test('disabled configuration registers nothing', async () => {
  const h = harness({ enabled: false, delaysMs: [1] })
  const agent = h.spawn()
  h.emit('session/event', agent.session, rejected(1))
  h.emit('agent/status', { agent, status: 'idle' })
  await settled()
  assert.equal(agent.delivered.length, 0)
})
