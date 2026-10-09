import { describe, expect, it, vi } from 'vitest'
import { LiveEngine, type CoachCallResult, type LiveEngineDeps } from '../liveEngine'
import { parseCoachResponse, type Card } from '../../../shared/second/card'
import type { CoachInput } from '../coachService'

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function setup(over: Partial<LiveEngineDeps> = {}) {
  let clock = 1_000_000
  const cards: Array<Card | null> = []
  const calls: Array<{ input: CoachInput; deep: boolean }> = []
  let respond: (input: CoachInput) => string = () =>
    '{"mode":"ASK","text":"What share of ARR is the top customer?","confidence":0.8,"grounding":["turn_1"],"state_updates":{"current_topic":"concentration"}}'
  const coachHealth: boolean[] = []
  const deps: LiveEngineDeps = {
    now: () => clock,
    coach: vi.fn(async (input, opts) => {
      calls.push({ input, deep: opts.deep })
      return { parsed: parseCoachResponse(respond(input), { now: clock, id: opts.cardId }), latencyMs: 800, model: 'test-model' } as CoachCallResult
    }),
    profileText: () => 'name: Alex',
    sensitivity: () => 'balanced',
    coachEnabled: () => true,
    onCard: (c) => cards.push(c),
    onState: () => {},
    onCoachHealth: (ok) => coachHealth.push(ok),
    diag: () => {},
    promptVersion: 'test',
    ...over,
  }
  const engine = new LiveEngine(deps)
  return {
    engine,
    deps,
    cards,
    calls,
    coachHealth,
    advance: (ms: number) => { clock += ms },
    setResponse: (fn: (input: CoachInput) => string) => { respond = fn },
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

function themSays(engine: LiveEngine, id: string, text: string) {
  engine.onEntry({ id, source: 'system', text, isFinal: true })
}

describe('LiveEngine', () => {
  it('runs the coach on a finalized THEM turn and publishes one card', async () => {
    const t = setup()
    t.engine.start({ sessionId: 'sess-1', modeId: 'founder' })
    themSays(t.engine, 'e1', 'Our biggest customer is about forty percent of revenue right now')
    t.advance(1500)
    t.engine.tick()
    await flush()
    expect(t.calls).toHaveLength(1)
    expect(t.calls[0].input.playbook.id).toBe('founder')
    expect(t.calls[0].input.turns.map((x) => x.id)).toEqual(['turn_1'])
    const card = t.cards.filter(Boolean).pop()
    expect(card?.mode).toBe('ASK')
    expect(t.engine.getState().currentTopic).toBe('concentration')
    expect(t.coachHealth).toEqual([true])
  })

  it('expires the card after its lifetime', async () => {
    const t = setup()
    t.engine.start({ sessionId: 's' })
    themSays(t.engine, 'e1', 'We closed three new enterprise logos last quarter actually')
    t.advance(1500)
    t.engine.tick()
    await flush()
    expect(t.engine.getCard()).not.toBeNull()
    t.advance(31_000)
    t.engine.tick()
    expect(t.engine.getCard()).toBeNull()
    expect(t.cards[t.cards.length - 1]).toBeNull()
  })

  it('coalesces turns that arrive while a call is in flight, then re-runs once', async () => {
    const pending = deferred<CoachCallResult>()
    let n = 0
    const t = setup({
      coach: vi.fn(async (_input, opts) => {
        n += 1
        if (n === 1) return pending.promise
        return { parsed: parseCoachResponse('{"mode":"NONE"}', { now: 0, id: opts.cardId }), latencyMs: 500, model: 'm' }
      }),
    })
    t.engine.start({ sessionId: 's' })
    themSays(t.engine, 'e1', 'Here is a long first statement about our pipeline')
    t.engine.onEntry({ id: 'e2', source: 'mic', text: 'Got it, and what about churn?', isFinal: true })
    t.advance(1500)
    t.engine.tick()
    themSays(t.engine, 'e3', 'Churn has been very low this year overall honestly')
    t.advance(1500)
    t.engine.tick()
    expect(n).toBe(1)
    pending.resolve({ parsed: parseCoachResponse('{"mode":"NONE"}', { now: 0, id: 'x' }), latencyMs: 900, model: 'm' })
    await flush()
    t.engine.tick()
    expect(n).toBe(1) // still inside the balanced rate-limit window
    t.advance(10_000)
    t.engine.tick()
    await flush()
    expect(n).toBe(2)
    t.advance(10_000)
    t.engine.tick()
    expect(n).toBe(2) // coalesced into exactly one follow-up run
  })

  it('drops a late coach result after the meeting stops', async () => {
    const pending = deferred<CoachCallResult>()
    const t = setup({ coach: vi.fn(() => pending.promise) })
    t.engine.start({ sessionId: 's' })
    themSays(t.engine, 'e1', 'This is a long enough statement to trigger coaching')
    t.advance(1500)
    t.engine.tick()
    const result = t.engine.stop()
    expect(result?.turns).toHaveLength(1)
    pending.resolve({ parsed: parseCoachResponse('{"mode":"SAY","text":"Late card","confidence":0.9}', { now: 0, id: 'x' }), latencyMs: 1, model: 'm' })
    await flush()
    expect(t.cards.filter(Boolean)).toHaveLength(0)
  })

  it('isolates coach failures: transcript and state stay alive', async () => {
    const t = setup({ coach: vi.fn(async () => { throw new Error('401 invalid key') }) })
    t.engine.start({ sessionId: 's' })
    themSays(t.engine, 'e1', 'We have about forty customers in total right now')
    t.advance(1500)
    t.engine.tick()
    await flush()
    expect(t.coachHealth).toEqual([false])
    expect(t.engine.getState().turnCount).toBe(1)
    expect(t.engine.isActive()).toBe(true)
  })

  it('think deeper bypasses gates and uses the deep slot', async () => {
    const t = setup()
    t.engine.start({ sessionId: 's' })
    const out = await t.engine.request('think_deeper')
    expect(out.ok).toBe(true)
    expect(t.calls[0].deep).toBe(true)
    expect(t.calls[0].input.trigger.kind).toBe('think_deeper')
  })

  it('does nothing when coaching is disabled', async () => {
    const t = setup({ coachEnabled: () => false })
    t.engine.start({ sessionId: 's' })
    themSays(t.engine, 'e1', 'A long statement that would normally trigger the coach')
    t.advance(1500)
    t.engine.tick()
    await flush()
    expect(t.calls).toHaveLength(0)
    expect(t.engine.getState().turnCount).toBe(1)
  })

  it('records grounded facts from the coach into state', async () => {
    const t = setup()
    t.setResponse(() => '{"mode":"NONE","state_updates":{"facts":[{"claim":"40 customers","source":"turn_1","confidence":0.9}],"commitments":[{"who":"Dana","action":"send cap table","source":"turn_1"}]}}')
    t.engine.start({ sessionId: 's' })
    themSays(t.engine, 'e1', 'We have forty customers and I will send the cap table')
    t.advance(1500)
    t.engine.tick()
    await flush()
    const s = t.engine.getState()
    expect(s.facts[0].claim).toBe('40 customers')
    expect(s.commitments[0]).toMatchObject({ who: 'Dana', missingDue: true })
  })
})
