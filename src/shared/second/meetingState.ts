/**
 * Meeting state: a compact, deterministic model of the room.
 *
 * The coach never receives the whole transcript. It receives this state, the
 * meeting brief, and a short window of recent turns. State only changes by
 * applying events, so replaying the same event log always reproduces the same
 * state (see `replayMeeting`).
 *
 * Rules enforced here:
 *  - Facts need provenance (a turn id, packet source, or user context).
 *  - Inferences are never promoted to facts; they land in `signals`.
 *  - Numbers are normalized so contradictions are detected without the model.
 *  - Open questions persist until resolved or explicitly parked.
 *  - Commitments need who + what; a missing due date is flagged.
 */

import type { Card } from './card'

export type Speaker = 'you' | 'them'
export type MeetingPhase = 'opening' | 'body' | 'closing'
export type Confidence = number // 0..1

export interface Turn {
  id: string
  speaker: Speaker
  text: string
  at: number
}

export interface Fact {
  claim: string
  value?: string
  source: string
  confidence: Confidence
  at: number
}

export interface NumberFact {
  metric: string
  value: number
  unit?: string
  period?: string
  source: string
  at: number
}

export interface Contradiction {
  metric: string
  period?: string
  previous: number
  current: number
  sources: [string, string]
  at: number
}

export interface OpenQuestion {
  question: string
  priority: 'low' | 'medium' | 'high'
  /** Who is expected to answer. */
  owner: Speaker
  firstAskedAt: number
  source: string
}

export interface ResolvedQuestion {
  question: string
  answerRef: string
  at: number
}

export interface Objection {
  topic: string
  severity: 'low' | 'medium' | 'high'
  resolved: boolean
  evidence: string
}

export interface Commitment {
  who: string
  action: string
  due?: string
  confidence: Confidence
  missingDue: boolean
  source: string
}

export interface Signal {
  type: string
  evidence: string
  confidence: Confidence
}

/** A period the meeting was not fully captured (sleep, network loss, capture loss). */
export interface CaptureGap {
  from: number
  to: number
  reason: 'sleep' | 'network' | 'capture'
}

export interface MeetingSetup {
  objective?: string
  idealOutcome?: string
  avoid?: string[]
  people?: string[]
  organizations?: string[]
  closeTarget?: string
}

export interface MeetingState {
  meetingId: string
  startedAt: number
  mode: string
  phase: MeetingPhase
  objective: string
  idealOutcome: string
  avoid: string[]
  people: string[]
  organizations: string[]
  currentTopic: string
  agendaDone: string[]
  agendaParked: string[]
  facts: Fact[]
  numbers: NumberFact[]
  contradictions: Contradiction[]
  questionsOpen: OpenQuestion[]
  questionsResolved: ResolvedQuestion[]
  objections: Objection[]
  commitments: Commitment[]
  signals: Signal[]
  relationshipState: string
  lastUserIntent: string
  currentCard: Card | null
  closeTarget: string
  nextBestAction: string
  gaps: CaptureGap[]
  turnCount: number
  lastTurnAt: number
  endedAt: number | null
}

/** Structured patch the coach (or the user) may propose. Every field optional. */
export interface StateUpdates {
  phase?: MeetingPhase
  currentTopic?: string
  agendaDone?: string[]
  agendaParked?: string[]
  facts?: Array<Omit<Fact, 'at'>>
  numbers?: Array<Omit<NumberFact, 'at'>>
  questionsOpen?: Array<Omit<OpenQuestion, 'firstAskedAt'>>
  questionsResolved?: Array<{ question: string; answerRef: string }>
  objections?: Objection[]
  objectionsResolved?: string[]
  commitments?: Array<Omit<Commitment, 'missingDue'>>
  signals?: Signal[]
  relationshipState?: string
  lastUserIntent?: string
  nextBestAction?: string
  people?: string[]
  organizations?: string[]
}

export type MeetingEvent =
  | { type: 'meeting_started'; at: number; meetingId: string; mode: string; setup?: MeetingSetup }
  | { type: 'turn'; at: number; turn: Turn }
  | { type: 'state_updates'; at: number; origin: 'coach' | 'user'; updates: StateUpdates }
  | { type: 'card_published'; at: number; card: Card }
  | { type: 'card_cleared'; at: number; reason: 'expired' | 'dismissed' | 'replaced' | 'topic_moved' }
  | { type: 'phase'; at: number; phase: MeetingPhase }
  | { type: 'gap'; at: number; gap: CaptureGap }
  | { type: 'meeting_ended'; at: number }

/** Opening phase lasts this long unless the coach moves it on sooner. */
export const OPENING_PHASE_MS = 5 * 60_000
const MAX_FACTS = 60
const MAX_NUMBERS = 60
const MAX_SIGNALS = 30
const MAX_LIST = 40

export function createMeetingState(meetingId = '', startedAt = 0, mode = 'general'): MeetingState {
  return {
    meetingId,
    startedAt,
    mode,
    phase: 'opening',
    objective: '',
    idealOutcome: '',
    avoid: [],
    people: [],
    organizations: [],
    currentTopic: '',
    agendaDone: [],
    agendaParked: [],
    facts: [],
    numbers: [],
    contradictions: [],
    questionsOpen: [],
    questionsResolved: [],
    objections: [],
    commitments: [],
    signals: [],
    relationshipState: '',
    lastUserIntent: '',
    currentCard: null,
    closeTarget: '',
    nextBestAction: '',
    gaps: [],
    turnCount: 0,
    lastTurnAt: 0,
    endedAt: null,
  }
}

/** Normalize free text for matching questions/topics/people. */
export function normalizeKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9%$ ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function sameQuestion(a: string, b: string): boolean {
  const na = normalizeKey(a)
  const nb = normalizeKey(b)
  if (!na || !nb) return false
  if (na === nb) return true
  // Token overlap: questions are often paraphrased between ask and answer.
  const ta = new Set(na.split(' ').filter((w) => w.length > 3))
  const tb = new Set(nb.split(' ').filter((w) => w.length > 3))
  if (ta.size === 0 || tb.size === 0) return false
  let shared = 0
  for (const w of ta) if (tb.has(w)) shared++
  return shared / Math.min(ta.size, tb.size) >= 0.75
}

function addUnique(list: string[], items: string[] | undefined): string[] {
  if (!items?.length) return list
  const seen = new Set(list.map(normalizeKey))
  const out = [...list]
  for (const item of items) {
    const clean = item.trim()
    if (!clean) continue
    const key = normalizeKey(clean)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(clean)
  }
  return out.slice(-MAX_LIST)
}

function clamp01(n: unknown): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? n : 0.5
  return Math.max(0, Math.min(1, v))
}

/** Explicit provenance markers. "inference" and empty sources are not facts. */
export function isGroundedSource(source: string | undefined): boolean {
  if (!source) return false
  const s = source.trim().toLowerCase()
  if (!s || s === 'inference' || s === 'model' || s === 'guess') return false
  return /^(turn_\d+|packet:|context:|user:|doc:)/.test(s)
}

function numberKey(metric: string, period?: string): string {
  return `${normalizeKey(metric)}|${normalizeKey(period ?? '')}`
}

function applyUpdates(state: MeetingState, updates: StateUpdates, at: number): MeetingState {
  const next: MeetingState = { ...state }

  if (updates.phase) next.phase = updates.phase
  if (updates.currentTopic?.trim()) next.currentTopic = updates.currentTopic.trim()
  if (updates.relationshipState?.trim()) next.relationshipState = updates.relationshipState.trim()
  if (updates.lastUserIntent?.trim()) next.lastUserIntent = updates.lastUserIntent.trim()
  if (updates.nextBestAction?.trim()) next.nextBestAction = updates.nextBestAction.trim()
  next.agendaDone = addUnique(state.agendaDone, updates.agendaDone)
  next.agendaParked = addUnique(state.agendaParked, updates.agendaParked)
  next.people = addUnique(state.people, updates.people)
  next.organizations = addUnique(state.organizations, updates.organizations)

  // Facts: grounded only. Ungrounded claims become low-confidence signals.
  if (updates.facts?.length) {
    const facts = [...state.facts]
    const signals = [...(next.signals ?? state.signals)]
    for (const f of updates.facts) {
      if (!f?.claim?.trim()) continue
      if (!isGroundedSource(f.source)) {
        signals.push({ type: 'inference', evidence: f.claim.trim(), confidence: Math.min(clamp01(f.confidence), 0.5) })
        continue
      }
      const dup = facts.findIndex((x) => normalizeKey(x.claim) === normalizeKey(f.claim))
      const fact: Fact = { claim: f.claim.trim(), value: f.value, source: f.source.trim(), confidence: clamp01(f.confidence), at }
      if (dup >= 0) facts[dup] = fact
      else facts.push(fact)
    }
    next.facts = facts.slice(-MAX_FACTS)
    next.signals = signals.slice(-MAX_SIGNALS)
  }

  // Numbers: detect contradictions on same metric + period.
  if (updates.numbers?.length) {
    const numbers = [...state.numbers]
    const contradictions = [...state.contradictions]
    for (const n of updates.numbers) {
      if (!n?.metric?.trim() || typeof n.value !== 'number' || !Number.isFinite(n.value)) continue
      if (!isGroundedSource(n.source)) continue
      const key = numberKey(n.metric, n.period)
      const prevIdx = numbers.findIndex((x) => numberKey(x.metric, x.period) === key)
      const entry: NumberFact = { metric: n.metric.trim(), value: n.value, unit: n.unit, period: n.period, source: n.source.trim(), at }
      if (prevIdx >= 0) {
        const prev = numbers[prevIdx]
        if (prev.value !== n.value && prev.source !== entry.source) {
          contradictions.push({
            metric: entry.metric,
            period: entry.period,
            previous: prev.value,
            current: entry.value,
            sources: [prev.source, entry.source],
            at,
          })
        }
        numbers[prevIdx] = entry
      } else {
        numbers.push(entry)
      }
    }
    next.numbers = numbers.slice(-MAX_NUMBERS)
    next.contradictions = contradictions.slice(-MAX_LIST)
  }

  if (updates.questionsOpen?.length) {
    const open = [...state.questionsOpen]
    for (const q of updates.questionsOpen) {
      if (!q?.question?.trim()) continue
      if (open.some((x) => sameQuestion(x.question, q.question))) continue
      if (state.questionsResolved.some((x) => sameQuestion(x.question, q.question))) continue
      open.push({
        question: q.question.trim(),
        priority: q.priority ?? 'medium',
        owner: q.owner === 'you' ? 'you' : 'them',
        firstAskedAt: at,
        source: q.source ?? '',
      })
    }
    next.questionsOpen = open.slice(-MAX_LIST)
  }

  if (updates.questionsResolved?.length) {
    let open = [...next.questionsOpen]
    const resolved = [...state.questionsResolved]
    for (const r of updates.questionsResolved) {
      if (!r?.question?.trim()) continue
      const before = open.length
      open = open.filter((x) => !sameQuestion(x.question, r.question))
      if (open.length !== before || !resolved.some((x) => sameQuestion(x.question, r.question))) {
        resolved.push({ question: r.question.trim(), answerRef: r.answerRef ?? '', at })
      }
    }
    next.questionsOpen = open
    next.questionsResolved = resolved.slice(-MAX_LIST)
  }

  if (updates.objections?.length) {
    const objections = [...state.objections]
    for (const o of updates.objections) {
      if (!o?.topic?.trim()) continue
      const idx = objections.findIndex((x) => normalizeKey(x.topic) === normalizeKey(o.topic))
      const entry: Objection = { topic: o.topic.trim(), severity: o.severity ?? 'medium', resolved: !!o.resolved, evidence: o.evidence ?? '' }
      if (idx >= 0) objections[idx] = entry
      else objections.push(entry)
    }
    next.objections = objections.slice(-MAX_LIST)
  }
  if (updates.objectionsResolved?.length) {
    const keys = new Set(updates.objectionsResolved.map(normalizeKey))
    next.objections = next.objections.map((o) => (keys.has(normalizeKey(o.topic)) ? { ...o, resolved: true } : o))
  }

  if (updates.commitments?.length) {
    const commitments = [...state.commitments]
    for (const c of updates.commitments) {
      if (!c?.who?.trim() || !c?.action?.trim()) continue
      const key = `${normalizeKey(c.who)}|${normalizeKey(c.action)}`
      const idx = commitments.findIndex((x) => `${normalizeKey(x.who)}|${normalizeKey(x.action)}` === key)
      const entry: Commitment = {
        who: c.who.trim(),
        action: c.action.trim(),
        due: c.due?.trim() || undefined,
        confidence: clamp01(c.confidence),
        missingDue: !c.due?.trim(),
        source: c.source ?? '',
      }
      if (idx >= 0) commitments[idx] = { ...entry, due: entry.due ?? commitments[idx].due, missingDue: !(entry.due ?? commitments[idx].due) }
      else commitments.push(entry)
    }
    next.commitments = commitments.slice(-MAX_LIST)
  }

  if (updates.signals?.length) {
    const signals = [...next.signals]
    for (const s of updates.signals) {
      if (!s?.type?.trim() || !s?.evidence?.trim()) continue
      signals.push({ type: s.type.trim(), evidence: s.evidence.trim(), confidence: clamp01(s.confidence) })
    }
    next.signals = signals.slice(-MAX_SIGNALS)
  }

  return next
}

/** A YOU turn that asks something leaves a question open for THEM. */
function extractUserQuestion(turn: Turn): string | null {
  if (turn.speaker !== 'you') return null
  const parts = turn.text.split(/(?<=[.!?])\s+/)
  const asked = parts.filter((p) => p.trim().endsWith('?'))
  if (asked.length === 0) return null
  return asked[asked.length - 1].trim()
}

export function reduceMeeting(state: MeetingState, event: MeetingEvent): MeetingState {
  switch (event.type) {
    case 'meeting_started': {
      const s = createMeetingState(event.meetingId, event.at, event.mode)
      const setup = event.setup ?? {}
      return {
        ...s,
        objective: setup.objective?.trim() ?? '',
        idealOutcome: setup.idealOutcome?.trim() ?? '',
        avoid: addUnique([], setup.avoid),
        people: addUnique([], setup.people),
        organizations: addUnique([], setup.organizations),
        closeTarget: setup.closeTarget?.trim() ?? '',
      }
    }
    case 'turn': {
      const next: MeetingState = {
        ...state,
        turnCount: state.turnCount + 1,
        lastTurnAt: event.turn.at,
      }
      if (state.phase === 'opening' && state.startedAt && event.at - state.startedAt >= OPENING_PHASE_MS) {
        next.phase = 'body'
      }
      const asked = extractUserQuestion(event.turn)
      if (asked) {
        return applyUpdates(next, { questionsOpen: [{ question: asked, priority: 'medium', owner: 'them', source: event.turn.id }] }, event.at)
      }
      return next
    }
    case 'state_updates':
      return applyUpdates(state, event.updates, event.at)
    case 'card_published':
      return { ...state, currentCard: event.card }
    case 'card_cleared':
      return { ...state, currentCard: null }
    case 'phase':
      return { ...state, phase: event.phase }
    case 'gap':
      if (event.gap.to <= event.gap.from) return state
      return { ...state, gaps: [...state.gaps, event.gap].slice(-MAX_LIST) }
    case 'meeting_ended':
      return { ...state, endedAt: event.at, currentCard: null }
    default:
      return state
  }
}

export function replayMeeting(events: readonly MeetingEvent[], initial: MeetingState = createMeetingState()): MeetingState {
  return events.reduce(reduceMeeting, initial)
}

/**
 * Compact text view of the state for the coach prompt. Keeps the prompt small
 * and stable: empty sections are omitted, lists are capped to the most recent.
 */
export function formatStateForPrompt(state: MeetingState): string {
  const lines: string[] = []
  const push = (label: string, value: string | undefined) => {
    if (value && value.trim()) lines.push(`${label}: ${value.trim()}`)
  }
  push('mode', state.mode)
  push('phase', state.phase)
  push('objective', state.objective)
  push('ideal_outcome', state.idealOutcome)
  if (state.avoid.length) push('avoid', state.avoid.join('; '))
  if (state.people.length) push('people', state.people.join(', '))
  if (state.organizations.length) push('organizations', state.organizations.join(', '))
  push('current_topic', state.currentTopic)
  push('relationship_state', state.relationshipState)
  push('close_target', state.closeTarget)
  push('next_best_action', state.nextBestAction)
  const recent = <T,>(list: T[], n: number) => list.slice(-n)
  if (state.questionsOpen.length) {
    lines.push('questions_open:')
    for (const q of recent(state.questionsOpen, 8)) lines.push(`  - [${q.priority}, owner ${q.owner}] ${q.question}`)
  }
  if (state.questionsResolved.length) {
    lines.push('questions_resolved:')
    for (const q of recent(state.questionsResolved, 6)) lines.push(`  - ${q.question} (${q.answerRef})`)
  }
  if (state.facts.length) {
    lines.push('facts:')
    for (const f of recent(state.facts, 12)) lines.push(`  - ${f.claim}${f.value ? ` = ${f.value}` : ''} [${f.source}]`)
  }
  if (state.numbers.length) {
    lines.push('numbers:')
    for (const n of recent(state.numbers, 10)) {
      lines.push(`  - ${n.metric}: ${n.value}${n.unit ? ` ${n.unit}` : ''}${n.period ? ` (${n.period})` : ''} [${n.source}]`)
    }
  }
  if (state.contradictions.length) {
    lines.push('contradictions:')
    for (const c of recent(state.contradictions, 4)) {
      lines.push(`  - ${c.metric}${c.period ? ` (${c.period})` : ''}: ${c.previous} vs ${c.current} [${c.sources.join(' vs ')}]`)
    }
  }
  const openObjections = state.objections.filter((o) => !o.resolved)
  if (openObjections.length) {
    lines.push('objections_open:')
    for (const o of recent(openObjections, 5)) lines.push(`  - [${o.severity}] ${o.topic}`)
  }
  if (state.commitments.length) {
    lines.push('commitments:')
    for (const c of recent(state.commitments, 8)) {
      lines.push(`  - ${c.who}: ${c.action}${c.due ? ` by ${c.due}` : ' (no date yet)'}`)
    }
  }
  if (state.signals.length) {
    lines.push('signals (inferred, not facts):')
    for (const s of recent(state.signals, 6)) lines.push(`  - ${s.type}: ${s.evidence}`)
  }
  if (state.gaps.length) {
    lines.push('capture_gaps (not heard; do not assume what was said):')
    for (const g of recent(state.gaps, 4)) {
      const rel = (t: number) => {
        const sec = Math.max(0, Math.round((t - state.startedAt) / 1000))
        return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`
      }
      lines.push(`  - ${rel(g.from)} to ${rel(g.to)} (${g.reason})`)
    }
  }
  if (state.currentCard) {
    lines.push(`current_card: ${state.currentCard.mode} "${state.currentCard.text}"`)
  }
  return lines.join('\n')
}
