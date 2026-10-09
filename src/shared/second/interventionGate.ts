/**
 * Intervention engine gates. Second competes against silence: a suggestion
 * is published only when its expected value beats the cost of interrupting.
 *
 * Two pure decisions:
 *   shouldRunCoach  - is this finalized turn worth a model call at all?
 *   shouldPublish   - is the model's candidate card worth showing now?
 */

import type { Card } from './card'
import { isCardExpired } from './card'
import type { MeetingState, Turn } from './meetingState'
import { normalizeKey } from './meetingState'
import { wordCount } from './voicebook'

export type Sensitivity = 'quiet' | 'balanced' | 'active'

export const SENSITIVITY: Record<Sensitivity, { minIntervalMs: number; minConfidence: number }> = {
  quiet: { minIntervalMs: 20_000, minConfidence: 0.7 },
  balanced: { minIntervalMs: 10_000, minConfidence: 0.55 },
  active: { minIntervalMs: 5_000, minConfidence: 0.4 },
}

/** A fresh card is protected from replacement for this long (user reading/speaking it). */
export const CARD_PROTECT_MS = 12_000
/** After YOU ask something, don't stack another ASK for this long unless it's answered. */
export const QUESTION_PENDING_MS = 30_000
const MIN_TURN_WORDS = 4

export interface RunDecisionInput {
  turn: Turn | null
  now: number
  sensitivity: Sensitivity
  lastRunAt: number
  inFlight: boolean
  youSpeaking: boolean
  /** Explicit user request (Assist hotkey / "think deeper"). Always runs. */
  userRequested?: boolean
}

export type RunDecision = { run: true; reason: string } | { run: false; reason: string }

export function isDirectQuestion(turn: Turn): boolean {
  return turn.speaker === 'them' && /\?\s*$/.test(turn.text.trim())
}

export function shouldRunCoach(input: RunDecisionInput): RunDecision {
  if (input.userRequested) return { run: true, reason: 'user_requested' }
  if (input.inFlight) return { run: false, reason: 'in_flight' }
  const turn = input.turn
  if (!turn) return { run: false, reason: 'no_turn' }
  if (input.youSpeaking) return { run: false, reason: 'user_speaking' }

  const direct = isDirectQuestion(turn)
  if (!direct && wordCount(turn.text) < MIN_TURN_WORDS) return { run: false, reason: 'trivial_turn' }

  const { minIntervalMs } = SENSITIVITY[input.sensitivity]
  if (!direct && input.now - input.lastRunAt < minIntervalMs) return { run: false, reason: 'rate_limited' }

  return { run: true, reason: direct ? 'direct_question' : 'finalized_turn' }
}

export interface PublishContext {
  now: number
  sensitivity: Sensitivity
  current: Card | null
  /** Recently shown cards (newest last), for repeat suppression. */
  recent: Card[]
  themSpeaking: boolean
  state: MeetingState
  userRequested?: boolean
}

export type PublishDecision = { publish: true; reason: string } | { publish: false; reason: string }

function similar(a: string, b: string): boolean {
  const na = normalizeKey(a)
  const nb = normalizeKey(b)
  if (!na || !nb) return false
  if (na === nb) return true
  const ta = new Set(na.split(' ').filter((w) => w.length > 2))
  const tb = new Set(nb.split(' ').filter((w) => w.length > 2))
  if (ta.size === 0 || tb.size === 0) return false
  let shared = 0
  for (const w of ta) if (tb.has(w)) shared++
  return shared / Math.min(ta.size, tb.size) >= 0.7
}

function recentUserQuestionPending(state: MeetingState, now: number): boolean {
  return state.questionsOpen.some((q) => q.owner === 'them' && now - q.firstAskedAt < QUESTION_PENDING_MS)
}

export function shouldPublish(candidate: Card | null, ctx: PublishContext): PublishDecision {
  if (!candidate) return { publish: false, reason: 'no_card' }
  const urgent = candidate.urgency === 'high' || candidate.replacePolicy === 'interrupt'
  const current = ctx.current && !isCardExpired(ctx.current, ctx.now) ? ctx.current : null

  if (!ctx.userRequested) {
    const { minConfidence } = SENSITIVITY[ctx.sensitivity]
    if (candidate.confidence < minConfidence && !urgent) return { publish: false, reason: 'low_confidence' }
  }

  const history = [...ctx.recent, ...(current ? [current] : [])]
  if (history.some((c) => c.mode === candidate.mode && similar(c.text, candidate.text))) {
    return { publish: false, reason: 'repeat' }
  }

  if (candidate.mode === 'WAIT') {
    // WAIT never displaces a live, useful card; it is the absence of advice.
    if (current && current.mode !== 'WAIT') return { publish: false, reason: 'wait_keeps_current' }
    return { publish: true, reason: 'wait' }
  }

  if (current && !ctx.userRequested && !urgent) {
    const age = ctx.now - current.createdAt
    if (age < CARD_PROTECT_MS && current.mode !== 'WAIT') return { publish: false, reason: 'protect_current' }
  }

  if (ctx.themSpeaking && !urgent && !ctx.userRequested && (candidate.mode === 'SAY' || candidate.mode === 'ASK')) {
    return { publish: false, reason: 'them_mid_answer' }
  }

  if (candidate.mode === 'ASK' && !urgent && !ctx.userRequested && recentUserQuestionPending(ctx.state, ctx.now)) {
    return { publish: false, reason: 'question_pending' }
  }

  return { publish: true, reason: ctx.userRequested ? 'user_requested' : urgent ? 'urgent' : 'valuable' }
}
