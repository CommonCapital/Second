/**
 * Card contract: the only thing the live surface ever shows.
 *
 * One dominant card at a time. Modes:
 *   SAY   - the exact concise line the user can say now
 *   ASK   - the one best question
 *   WATCH - one material signal, inconsistency, risk, or unresolved item
 *   WAIT  - listening has higher expected value than speaking
 *   CLOSE - a natural line that converts momentum into a concrete next step
 * The model may also return NONE (no card). Silence is a first-class output.
 *
 * The model answers in snake_case JSON (see schemas/card.json). This module
 * parses it defensively and rejects anything that breaks the contract.
 */

import type { MeetingPhase, StateUpdates, Speaker } from './meetingState'
import { CARD_HARD_MAX_WORDS, CARD_MAX_WORDS, findVoiceViolations, wordCount } from './voicebook'

export const CARD_MODES = ['SAY', 'ASK', 'WATCH', 'WAIT', 'CLOSE'] as const
export type CardMode = (typeof CARD_MODES)[number]
export type Urgency = 'low' | 'medium' | 'high'
export type ReplacePolicy = 'normal' | 'interrupt'

export interface Card {
  id: string
  mode: CardMode
  text: string
  urgency: Urgency
  confidence: number
  grounding: string[]
  expiresAfterSeconds: number
  replacePolicy: ReplacePolicy
  createdAt: number
  /** Optional context the coach attached: why this card, in a few words. */
  why?: string
}

export interface ParsedCoachResponse {
  card: Card | null
  stateUpdates: StateUpdates
  /** Set when the model returned a card that was rejected by the contract. */
  rejected?: string
  /** Soft issues worth logging/evaluating (card still accepted). */
  warnings: string[]
}

export const DEFAULT_EXPIRY_SECONDS: Record<CardMode, number> = {
  SAY: 25,
  ASK: 30,
  WATCH: 40,
  WAIT: 15,
  CLOSE: 45,
}
const MIN_EXPIRY = 5
const MAX_EXPIRY = 120

/** Pull the first balanced JSON object out of a model response. */
export function extractJsonObject(raw: string): string | null {
  if (!raw) return null
  const text = raw.replace(/```(?:json)?/gi, '')
  const start = text.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return null
}

type Json = Record<string, unknown>

const asString = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
const asNumber = (v: unknown): number | undefined => {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  return undefined
}
const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const asStringArray = (v: unknown): string[] =>
  asArray(v).map((x) => (typeof x === 'string' ? x.trim() : '')).filter(Boolean)
const asObj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {})
const asLevel = (v: unknown): Urgency => (v === 'high' || v === 'low' ? v : 'medium')
const asPhase = (v: unknown): MeetingPhase | undefined =>
  v === 'opening' || v === 'body' || v === 'closing' ? v : undefined
const asSpeaker = (v: unknown): Speaker => (v === 'you' ? 'you' : 'them')

/** snake_case model output -> camelCase StateUpdates. Unknown keys ignored. */
export function parseStateUpdates(raw: unknown): StateUpdates {
  const o = asObj(raw)
  const u: StateUpdates = {}
  const phase = asPhase(o.phase)
  if (phase) u.phase = phase
  const str = (k: string) => asString(o[k])?.trim() || undefined
  if (str('current_topic')) u.currentTopic = str('current_topic')
  if (str('relationship_state')) u.relationshipState = str('relationship_state')
  if (str('last_user_intent')) u.lastUserIntent = str('last_user_intent')
  if (str('next_best_action')) u.nextBestAction = str('next_best_action')
  const list = (k: string) => asStringArray(o[k])
  if (list('agenda_done').length) u.agendaDone = list('agenda_done')
  if (list('agenda_parked').length) u.agendaParked = list('agenda_parked')
  if (list('people').length) u.people = list('people')
  if (list('organizations').length) u.organizations = list('organizations')
  if (list('objections_resolved').length) u.objectionsResolved = list('objections_resolved')

  const facts = asArray(o.facts).map(asObj).map((f) => ({
    claim: asString(f.claim) ?? '',
    value: asString(f.value) ?? (asNumber(f.value) !== undefined ? String(f.value) : undefined),
    source: asString(f.source) ?? '',
    confidence: asNumber(f.confidence) ?? 0.5,
  })).filter((f) => f.claim.trim())
  if (facts.length) u.facts = facts

  const numbers = asArray(o.numbers).map(asObj).map((n) => ({
    metric: asString(n.metric) ?? '',
    value: asNumber(n.value) ?? NaN,
    unit: asString(n.unit),
    period: asString(n.period),
    source: asString(n.source) ?? '',
  })).filter((n) => n.metric.trim() && Number.isFinite(n.value))
  if (numbers.length) u.numbers = numbers

  const qOpen = asArray(o.questions_open).map(asObj).map((q) => ({
    question: asString(q.question) ?? '',
    priority: asLevel(q.priority),
    owner: asSpeaker(q.owner),
    source: asString(q.source) ?? '',
  })).filter((q) => q.question.trim())
  if (qOpen.length) u.questionsOpen = qOpen

  const qRes = asArray(o.questions_resolved).map(asObj).map((q) => ({
    question: asString(q.question) ?? '',
    answerRef: asString(q.answer_ref) ?? '',
  })).filter((q) => q.question.trim())
  if (qRes.length) u.questionsResolved = qRes

  const objections = asArray(o.objections).map(asObj).map((x) => ({
    topic: asString(x.topic) ?? '',
    severity: asLevel(x.severity),
    resolved: x.resolved === true,
    evidence: asString(x.evidence) ?? '',
  })).filter((x) => x.topic.trim())
  if (objections.length) u.objections = objections

  const commitments = asArray(o.commitments).map(asObj).map((c) => ({
    who: asString(c.who) ?? '',
    action: asString(c.action) ?? '',
    due: asString(c.due),
    confidence: asNumber(c.confidence) ?? 0.6,
    source: asString(c.source) ?? '',
  })).filter((c) => c.who.trim() && c.action.trim())
  if (commitments.length) u.commitments = commitments

  const signals = asArray(o.signals).map(asObj).map((s) => ({
    type: asString(s.type) ?? '',
    evidence: asString(s.evidence) ?? '',
    confidence: asNumber(s.confidence) ?? 0.5,
  })).filter((s) => s.type.trim() && s.evidence.trim())
  if (signals.length) u.signals = signals

  return u
}

export function parseCoachResponse(raw: string, opts: { now: number; id: string }): ParsedCoachResponse {
  const jsonText = extractJsonObject(raw)
  if (!jsonText) {
    return { card: null, stateUpdates: {}, rejected: 'no JSON object in response', warnings: [] }
  }
  let parsed: Json
  try {
    parsed = asObj(JSON.parse(jsonText))
  } catch {
    return { card: null, stateUpdates: {}, rejected: 'invalid JSON', warnings: [] }
  }

  const stateUpdates = parseStateUpdates(parsed.state_updates)
  const warnings: string[] = []
  const modeRaw = (asString(parsed.mode) ?? '').trim().toUpperCase()

  if (!modeRaw || modeRaw === 'NONE' || modeRaw === 'NULL' || modeRaw === 'NO_CARD') {
    return { card: null, stateUpdates, warnings }
  }
  if (!(CARD_MODES as readonly string[]).includes(modeRaw)) {
    return { card: null, stateUpdates, rejected: `unknown mode "${modeRaw}"`, warnings }
  }
  const mode = modeRaw as CardMode
  const text = (asString(parsed.text) ?? '').replace(/\s+/g, ' ').trim()

  if (mode !== 'WAIT' && !text) {
    return { card: null, stateUpdates, rejected: 'empty card text', warnings }
  }
  const words = wordCount(text)
  if (words > CARD_HARD_MAX_WORDS) {
    return { card: null, stateUpdates, rejected: `card too long (${words} words)`, warnings }
  }
  if (words > CARD_MAX_WORDS) warnings.push(`card over ${CARD_MAX_WORDS} words (${words})`)

  const violations = findVoiceViolations(text)
  if (violations.length) {
    return { card: null, stateUpdates, rejected: `voice violation: ${violations.join(', ')}`, warnings }
  }

  const grounding = asStringArray(parsed.grounding)
  if (mode !== 'WAIT' && grounding.length === 0) warnings.push('card has no grounding')

  const expiryRaw = asNumber(parsed.expires_after_seconds)
  const expiresAfterSeconds = Math.round(
    Math.max(MIN_EXPIRY, Math.min(MAX_EXPIRY, expiryRaw ?? DEFAULT_EXPIRY_SECONDS[mode])),
  )
  const confidence = Math.max(0, Math.min(1, asNumber(parsed.confidence) ?? 0.5))

  const card: Card = {
    id: opts.id,
    mode,
    text: mode === 'WAIT' && !text ? 'Keep listening.' : text,
    urgency: asLevel(parsed.urgency),
    confidence,
    grounding,
    expiresAfterSeconds,
    replacePolicy: parsed.replace_policy === 'interrupt' ? 'interrupt' : 'normal',
    createdAt: opts.now,
    why: asString(parsed.why)?.trim() || undefined,
  }
  return { card, stateUpdates, warnings }
}

export function cardExpiresAt(card: Card): number {
  return card.createdAt + card.expiresAfterSeconds * 1000
}

export function isCardExpired(card: Card, now: number): boolean {
  return now >= cardExpiresAt(card)
}
