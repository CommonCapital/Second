import { describe, expect, it } from 'vitest'
import { TurnAssembler, TURN_END_SILENCE_MS } from '../turns'
import { CARD_PROTECT_MS, shouldPublish, shouldRunCoach, type PublishContext } from '../interventionGate'
import type { Card } from '../card'
import { createMeetingState, type Turn } from '../meetingState'

const card = (over: Partial<Card> = {}): Card => ({
  id: 'c',
  mode: 'ASK',
  text: 'What share of revenue is services?',
  urgency: 'medium',
  confidence: 0.8,
  grounding: ['turn_1'],
  expiresAfterSeconds: 30,
  replacePolicy: 'normal',
  createdAt: 0,
  ...over,
})

describe('TurnAssembler', () => {
  it('groups finals from one speaker and commits on speaker change', () => {
    const a = new TurnAssembler()
    expect(a.onEntry({ id: 'e1', source: 'system', text: 'We grew a lot', isFinal: true }, 0)).toEqual([])
    expect(a.onEntry({ id: 'e1', source: 'system', text: 'We grew a lot last year', isFinal: true }, 100)).toEqual([])
    expect(a.onEntry({ id: 'e2', source: 'system', text: 'mostly enterprise.', isFinal: true }, 200)).toEqual([])
    const out = a.onEntry({ id: 'e3', source: 'mic', text: 'Interesting.', isFinal: true }, 300)
    expect(out).toEqual([{ id: 'turn_1', speaker: 'them', text: 'We grew a lot last year mostly enterprise.', at: 300 }])
  })

  it('commits after silence, but not while the speaker is still talking', () => {
    const a = new TurnAssembler()
    a.onEntry({ id: 'e1', source: 'system', text: 'Our churn is low', isFinal: true }, 0)
    a.onEntry({ id: 'i', source: 'system', text: 'and we', isFinal: false }, TURN_END_SILENCE_MS - 100)
    expect(a.tick(TURN_END_SILENCE_MS + 50)).toEqual([])
    expect(a.isSpeaking('them', TURN_END_SILENCE_MS + 50)).toBe(true)
    const out = a.tick(2 * TURN_END_SILENCE_MS + 50)
    expect(out).toHaveLength(1)
    expect(out[0].speaker).toBe('them')
  })

  it('other side starting to talk (interim) ends the turn', () => {
    const a = new TurnAssembler()
    a.onEntry({ id: 'e1', source: 'mic', text: 'What is your burn?', isFinal: true }, 0)
    const out = a.onEntry({ id: 'i', source: 'system', text: 'So burn is', isFinal: false }, 400)
    expect(out[0]).toMatchObject({ speaker: 'you', text: 'What is your burn?' })
  })
})

const turn = (speaker: Turn['speaker'], text: string): Turn => ({ id: 'turn_1', speaker, text, at: 0 })

describe('shouldRunCoach', () => {
  const base = { now: 100_000, sensitivity: 'balanced' as const, lastRunAt: 0, inFlight: false, youSpeaking: false }

  it('runs on a meaningful finalized turn', () => {
    expect(shouldRunCoach({ ...base, turn: turn('them', 'We have about forty customers today mostly mid market') }).run).toBe(true)
  })
  it('skips trivial turns, in-flight calls, and while the user is speaking', () => {
    expect(shouldRunCoach({ ...base, turn: turn('them', 'Yeah, sure.') })).toEqual({ run: false, reason: 'trivial_turn' })
    expect(shouldRunCoach({ ...base, inFlight: true, turn: turn('them', 'a long enough meaningful turn here') }).reason).toBe('in_flight')
    expect(shouldRunCoach({ ...base, youSpeaking: true, turn: turn('them', 'a long enough meaningful turn here') }).reason).toBe('user_speaking')
  })
  it('rate limits, except for a direct question', () => {
    const recent = { ...base, lastRunAt: base.now - 2000 }
    expect(shouldRunCoach({ ...recent, turn: turn('them', 'Here is a long statement about the market') }).reason).toBe('rate_limited')
    expect(shouldRunCoach({ ...recent, turn: turn('them', 'Why now?') })).toEqual({ run: true, reason: 'direct_question' })
  })
  it('always runs when the user asked', () => {
    expect(shouldRunCoach({ ...base, inFlight: true, turn: null, userRequested: true }).run).toBe(true)
  })
})

describe('shouldPublish', () => {
  const ctx = (over: Partial<PublishContext> = {}): PublishContext => ({
    now: 100_000,
    sensitivity: 'balanced',
    current: null,
    recent: [],
    themSpeaking: false,
    state: createMeetingState(),
    ...over,
  })

  it('publishes a confident, novel card', () => {
    expect(shouldPublish(card({ createdAt: 100_000 }), ctx()).publish).toBe(true)
  })
  it('suppresses low confidence unless urgent', () => {
    expect(shouldPublish(card({ confidence: 0.3 }), ctx()).reason).toBe('low_confidence')
    expect(shouldPublish(card({ confidence: 0.3, urgency: 'high' }), ctx()).publish).toBe(true)
  })
  it('suppresses repeats', () => {
    const prev = card({ text: 'What share of revenue comes from services?' })
    expect(shouldPublish(card(), ctx({ recent: [prev] })).reason).toBe('repeat')
  })
  it('protects a fresh current card, allows interrupt', () => {
    const current = card({ text: 'Ask about the budget owner.', createdAt: 100_000 - (CARD_PROTECT_MS - 1000) })
    expect(shouldPublish(card({ text: 'Who signs the contract?' }), ctx({ current })).reason).toBe('protect_current')
    expect(shouldPublish(card({ text: 'Correct that: it was 3.2M, not 4M.', urgency: 'high' }), ctx({ current })).publish).toBe(true)
  })
  it('prefers listening while THEM is mid-answer', () => {
    expect(shouldPublish(card({ mode: 'SAY', text: 'Say this now.' }), ctx({ themSpeaking: true })).reason).toBe('them_mid_answer')
    expect(shouldPublish(card({ mode: 'WATCH', text: 'Numbers changed from 4M to 3.2M.' }), ctx({ themSpeaking: true })).publish).toBe(true)
  })
  it('does not stack a question while one is pending', () => {
    const state = { ...createMeetingState(), questionsOpen: [{ question: 'What is burn?', priority: 'medium' as const, owner: 'them' as const, firstAskedAt: 95_000, source: 'turn_2' }] }
    expect(shouldPublish(card({ text: 'Ask about gross margin.' }), ctx({ state })).reason).toBe('question_pending')
  })
  it('WAIT never displaces a useful card', () => {
    const current = card({ createdAt: 99_000 })
    expect(shouldPublish(card({ mode: 'WAIT', text: 'Keep listening.' }), ctx({ current })).reason).toBe('wait_keeps_current')
    expect(shouldPublish(card({ mode: 'WAIT', text: 'Keep listening.' }), ctx()).publish).toBe(true)
  })
})
