import { describe, expect, it } from 'vitest'
import {
  OPENING_PHASE_MS,
  createMeetingState,
  formatStateForPrompt,
  isGroundedSource,
  reduceMeeting,
  replayMeeting,
  type MeetingEvent,
} from '../meetingState'

const T0 = 1_700_000_000_000

const start: MeetingEvent = {
  type: 'meeting_started',
  at: T0,
  meetingId: 'm1',
  mode: 'founder',
  setup: { objective: 'Understand ARR quality', people: ['Dana'], organizations: ['Acme'], closeTarget: 'Get the P&L' },
}

describe('meeting state reducer', () => {
  it('seeds from the meeting setup', () => {
    const s = reduceMeeting(createMeetingState(), start)
    expect(s.meetingId).toBe('m1')
    expect(s.mode).toBe('founder')
    expect(s.objective).toBe('Understand ARR quality')
    expect(s.people).toEqual(['Dana'])
    expect(s.closeTarget).toBe('Get the P&L')
    expect(s.phase).toBe('opening')
  })

  it('opens a question when YOU ask one, and resolves it on update', () => {
    let s = replayMeeting([
      start,
      { type: 'turn', at: T0 + 1000, turn: { id: 'turn_1', speaker: 'you', text: 'Thanks for making time. What is your current ARR?', at: T0 + 1000 } },
    ])
    expect(s.questionsOpen).toHaveLength(1)
    expect(s.questionsOpen[0]).toMatchObject({ question: 'What is your current ARR?', owner: 'them', source: 'turn_1' })

    s = reduceMeeting(s, {
      type: 'state_updates',
      at: T0 + 5000,
      origin: 'coach',
      updates: { questionsResolved: [{ question: 'what is the current ARR', answerRef: 'turn_2' }] },
    })
    expect(s.questionsOpen).toHaveLength(0)
    expect(s.questionsResolved[0]).toMatchObject({ answerRef: 'turn_2' })
  })

  it('never promotes an ungrounded claim to a fact', () => {
    const s = replayMeeting([
      start,
      {
        type: 'state_updates',
        at: T0 + 1,
        origin: 'coach',
        updates: {
          facts: [
            { claim: 'Company has 40 customers', source: 'turn_3', confidence: 0.9 },
            { claim: 'Founder seems nervous about churn', source: 'inference', confidence: 0.9 },
          ],
        },
      },
    ])
    expect(s.facts.map((f) => f.claim)).toEqual(['Company has 40 customers'])
    expect(s.signals).toEqual([{ type: 'inference', evidence: 'Founder seems nervous about churn', confidence: 0.5 }])
  })

  it('detects number contradictions on the same metric and period', () => {
    const s = replayMeeting([
      start,
      { type: 'state_updates', at: T0 + 1, origin: 'coach', updates: { numbers: [{ metric: 'ARR', value: 4_000_000, unit: 'USD', period: 'FY24', source: 'turn_2' }] } },
      { type: 'state_updates', at: T0 + 2, origin: 'coach', updates: { numbers: [{ metric: 'arr', value: 3_200_000, unit: 'USD', period: 'fy24', source: 'turn_9' }] } },
    ])
    expect(s.numbers).toHaveLength(1)
    expect(s.numbers[0].value).toBe(3_200_000)
    expect(s.contradictions).toHaveLength(1)
    expect(s.contradictions[0]).toMatchObject({ previous: 4_000_000, current: 3_200_000, sources: ['turn_2', 'turn_9'] })
  })

  it('flags commitments without a due date and fills it later', () => {
    let s = replayMeeting([
      start,
      { type: 'state_updates', at: T0 + 1, origin: 'coach', updates: { commitments: [{ who: 'Dana', action: 'Send the cap table', confidence: 0.8, source: 'turn_4' }] } },
    ])
    expect(s.commitments[0].missingDue).toBe(true)
    s = reduceMeeting(s, { type: 'state_updates', at: T0 + 2, origin: 'coach', updates: { commitments: [{ who: 'dana', action: 'send the cap table', due: 'Friday', confidence: 0.9, source: 'turn_6' }] } })
    expect(s.commitments).toHaveLength(1)
    expect(s.commitments[0]).toMatchObject({ due: 'Friday', missingDue: false })
  })

  it('moves from opening to body after the opening window', () => {
    const s = replayMeeting([
      start,
      { type: 'turn', at: T0 + OPENING_PHASE_MS + 1, turn: { id: 'turn_1', speaker: 'them', text: 'Sure, let me walk you through it.', at: T0 + OPENING_PHASE_MS + 1 } },
    ])
    expect(s.phase).toBe('body')
  })

  it('replay is deterministic', () => {
    const events: MeetingEvent[] = [
      start,
      { type: 'turn', at: T0 + 10, turn: { id: 'turn_1', speaker: 'you', text: 'How do you think about churn?', at: T0 + 10 } },
      { type: 'state_updates', at: T0 + 20, origin: 'coach', updates: { currentTopic: 'retention', objections: [{ topic: 'Price', severity: 'high', resolved: false, evidence: 'turn_2' }] } },
      { type: 'state_updates', at: T0 + 30, origin: 'coach', updates: { objectionsResolved: ['price'] } },
      { type: 'meeting_ended', at: T0 + 40 },
    ]
    const a = replayMeeting(events)
    const b = replayMeeting(events)
    expect(a).toEqual(b)
    expect(a.objections[0].resolved).toBe(true)
    expect(a.endedAt).toBe(T0 + 40)
  })

  it('records capture gaps and tells the coach not to assume what was said', () => {
    const s = replayMeeting([
      start,
      { type: 'gap', at: T0 + 200_000, gap: { from: T0 + 120_000, to: T0 + 180_000, reason: 'network' } },
      { type: 'gap', at: T0 + 200_001, gap: { from: T0 + 5, to: T0 + 5, reason: 'sleep' } },
    ])
    expect(s.gaps).toEqual([{ from: T0 + 120_000, to: T0 + 180_000, reason: 'network' }])
    expect(formatStateForPrompt(s)).toContain('2:00 to 3:00 (network)')
  })

  it('formats a compact prompt view and omits empty sections', () => {
    const s = replayMeeting([start])
    const text = formatStateForPrompt(s)
    expect(text).toContain('objective: Understand ARR quality')
    expect(text).not.toContain('facts:')
  })

  it('recognizes grounded sources', () => {
    expect(isGroundedSource('turn_12')).toBe(true)
    expect(isGroundedSource('packet:deck')).toBe(true)
    expect(isGroundedSource('context:fund_terms')).toBe(true)
    expect(isGroundedSource('inference')).toBe(false)
    expect(isGroundedSource('')).toBe(false)
  })
})
