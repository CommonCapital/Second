/**
 * Offline checks on the evaluation corpus (no network): every scenario is
 * well-formed and replays deterministically through the state reducer.
 * The live, model-backed replay lives in evals/liveEval.eval.ts (npm run eval).
 */

import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { scoreMoment, summarize, toCsv, validateScenario, type EvalScenario } from '../evalScoring'
import { parseCoachResponse } from '../card'
import { reduceMeeting, createMeetingState, replayMeeting, type MeetingEvent } from '../meetingState'

const dir = join(process.cwd(), 'evals', 'scenarios')
const files = readdirSync(dir).filter((f) => f.endsWith('.json'))
const scenarios = files.map((f) => ({ file: f, data: JSON.parse(readFileSync(join(dir, f), 'utf8')) as EvalScenario }))

describe('evaluation corpus', () => {
  it('has scenarios for every core meeting type', () => {
    const modes = new Set(scenarios.map((s) => s.data.mode))
    for (const m of ['founder', 'lp', 'interview', 'negotiation', 'relationship', 'banker', 'ic']) {
      expect(modes.has(m), `missing ${m} scenario`).toBe(true)
    }
    expect(scenarios.some((s) => s.data.moments.some((m) => m.accept.includes('WAIT')))).toBe(true)
  })

  it.each(scenarios)('$file is valid', ({ file, data }) => {
    expect(validateScenario(data), file).toEqual([])
    expect(`${data.id}.json`).toBe(file)
  })

  it.each(scenarios)('$file replays deterministically', ({ data }) => {
    const events: MeetingEvent[] = [{ type: 'meeting_started', at: 0, meetingId: data.id, mode: data.mode }]
    data.turns.forEach((t, i) => {
      events.push({ type: 'turn', at: (i + 1) * 8000, turn: { id: `turn_${i + 1}`, speaker: t.speaker, text: t.text, at: (i + 1) * 8000 } })
    })
    const a = replayMeeting(events)
    const b = events.reduce(reduceMeeting, createMeetingState())
    expect(a).toEqual(b)
    expect(a.turnCount).toBe(data.turns.length)
  })
})

describe('eval scoring', () => {
  const moment = { after_turn: 1, accept: ['ASK' as const, 'WATCH' as const], reject: ['SAY' as const], note: 'n' }

  it('scores an accepted, grounded, brief card as good', () => {
    const parsed = parseCoachResponse('{"mode":"ASK","text":"How much of ARR is services?","confidence":0.8,"grounding":["turn_4"]}', { now: 0, id: 'c' })
    const r = scoreMoment('s', moment, parsed, 900)
    expect(r.autoGood).toBe(true)
  })

  it('flags forbidden modes and treats NONE like WAIT', () => {
    const say = scoreMoment('s', moment, parseCoachResponse('{"mode":"SAY","text":"Great.","grounding":["turn_1"]}', { now: 0, id: 'c' }), 1)
    expect(say.modeForbidden).toBe(true)
    const none = scoreMoment('s', { after_turn: 1, accept: ['WAIT'], note: 'n' }, parseCoachResponse('{"mode":"NONE"}', { now: 0, id: 'c' }), 1)
    expect(none.autoGood).toBe(true)
  })

  it('summarizes against release thresholds and writes CSV', () => {
    const good = scoreMoment('s', moment, parseCoachResponse('{"mode":"WATCH","text":"ARR changed from 4.2M to 3.6M.","grounding":["turn_5"]}', { now: 0, id: 'c' }), 1200)
    const bad = scoreMoment('s', moment, parseCoachResponse('not json', { now: 0, id: 'c' }), 4000)
    const sum = summarize([good, bad])
    expect(sum.goodRate).toBe(0.5)
    expect(sum.passes.quality).toBe(false)
    expect(sum.contractFailures).toBe(1)
    const csv = toCsv([good], { promptVersion: 'v', model: 'm' })
    expect(csv.split('\n')[0]).toContain('usefulness')
    expect(csv).toContain(',ARR changed from 4.2M to 3.6M.,')
    const withComma = { ...good, text: 'Ask about churn, then margin.' }
    expect(toCsv([withComma], { promptVersion: 'v', model: 'm' })).toContain('"Ask about churn, then margin."')
  })
})
