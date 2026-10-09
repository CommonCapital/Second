/**
 * LiveEngine: the realtime judgment loop.
 *
 *   STT entries -> TurnAssembler -> finalized turns -> event log -> reducer
 *        -> run gate -> coach (state + recent turns) -> card contract
 *        -> publish gate -> live surface (one card) -> expiry
 *
 * Capture, transcription, state, coaching, and rendering are separate fault
 * domains: a coach failure never touches the transcript or state; a stopped
 * session discards late coach results.
 *
 * All side effects are injected (clock, coach call, broadcast, diagnostics)
 * so the loop is unit-testable and replayable without Electron or network.
 */

import { cardExpiresAt, isCardExpired, type Card } from '../../shared/second/card'
import {
  createMeetingState,
  normalizeKey,
  reduceMeeting,
  type MeetingEvent,
  type MeetingSetup,
  type MeetingState,
  type StateUpdates,
  type Turn,
} from '../../shared/second/meetingState'
import { shouldPublish, shouldRunCoach, type Sensitivity } from '../../shared/second/interventionGate'
import { getPlaybook, type Playbook } from '../../shared/second/playbooks'
import { TurnAssembler, type SttEntry } from '../../shared/second/turns'
import type { MeetingBrief } from '../../shared/second/briefing'
import type { ParsedCoachResponse } from '../../shared/second/card'
import type { CoachInput } from './coachService'
import type { DiagnosticKind } from './diagnostics'

export interface CoachCallResult {
  parsed: ParsedCoachResponse
  latencyMs: number
  model: string
}

export interface LiveEngineDeps {
  now(): number
  coach(input: CoachInput, opts: { deep: boolean; cardId: string }): Promise<CoachCallResult>
  profileText(meetingText: string): string
  sensitivity(playbook: Playbook): Sensitivity
  coachEnabled(): boolean
  onCard(card: Card | null): void
  onState(state: MeetingState): void
  onCoachHealth(ok: boolean, detail?: string): void
  diag(kind: DiagnosticKind, data?: Record<string, unknown>): void
  promptVersion: string
}

export interface StartParams {
  sessionId: string
  modeId?: string | null
  setup?: MeetingSetup | null
  brief?: MeetingBrief | null
  /** Turns carried over from a resumed session. */
  priorTurns?: Turn[]
}

export interface LiveEngineResult {
  sessionId: string
  modeId: string
  setup: MeetingSetup | null
  brief: MeetingBrief | null
  state: MeetingState
  turns: Turn[]
  events: MeetingEvent[]
  metrics: { cards: number; suppressed: number; rejected: number; coachRuns: number; coachErrors: number; latenciesMs: number[] }
}

export type RequestOutcome =
  | { ok: true; card: Card | null; reason: string }
  | { ok: false; error: string }

const MAX_RECENT_CARDS = 8
const TOPIC_MOVE_MIN_AGE_MS = 5_000

export class LiveEngine {
  private active = false
  private sessionId = ''
  private playbook: Playbook = getPlaybook('general')
  private setup: MeetingSetup | null = null
  private brief: MeetingBrief | null = null
  private state: MeetingState = createMeetingState()
  private events: MeetingEvent[] = []
  private turns: Turn[] = []
  private assembler = new TurnAssembler()
  private recentCards: Card[] = []
  private lastRunAt = 0
  private inFlight = false
  private pendingRerun = false
  private generation = 0
  private cardSeq = 0
  private metrics = { cards: 0, suppressed: 0, rejected: 0, coachRuns: 0, coachErrors: 0, latenciesMs: [] as number[] }

  constructor(private readonly deps: LiveEngineDeps) {}

  isActive(): boolean {
    return this.active
  }

  getSessionId(): string {
    return this.sessionId
  }

  getState(): MeetingState {
    return this.state
  }

  getCard(): Card | null {
    return this.state.currentCard
  }

  getPlaybook(): Playbook {
    return this.playbook
  }

  getBrief(): MeetingBrief | null {
    return this.brief
  }

  start(params: StartParams): void {
    const now = this.deps.now()
    this.generation += 1
    this.active = true
    this.sessionId = params.sessionId
    this.playbook = getPlaybook(params.modeId)
    this.setup = params.setup ?? null
    this.brief = params.brief ?? null
    this.events = []
    this.turns = [...(params.priorTurns ?? [])]
    this.assembler = new TurnAssembler(undefined, this.turns.length)
    this.recentCards = []
    this.lastRunAt = 0
    this.inFlight = false
    this.pendingRerun = false
    this.cardSeq = 0
    this.metrics = { cards: 0, suppressed: 0, rejected: 0, coachRuns: 0, coachErrors: 0, latenciesMs: [] }
    this.state = createMeetingState()
    this.apply({
      type: 'meeting_started',
      at: now,
      meetingId: params.sessionId,
      mode: this.playbook.id,
      setup: {
        ...(params.setup ?? {}),
        closeTarget: params.setup?.closeTarget || params.brief?.closeTarget || this.playbook.closeTarget,
      },
    })
    this.deps.onCard(null)
    this.deps.diag('session_start', { meetingMode: this.playbook.id, resumed: (params.priorTurns?.length ?? 0) > 0 })
  }

  stop(): LiveEngineResult | null {
    if (!this.active) return null
    const now = this.deps.now()
    for (const t of this.assembler.flush(now)) this.recordTurn(t)
    this.apply({ type: 'meeting_ended', at: now })
    this.active = false
    this.generation += 1
    this.deps.onCard(null)
    this.deps.diag('session_end', {
      turnCount: this.state.turnCount,
      cards: this.metrics.cards,
      suppressed: this.metrics.suppressed,
    })
    return {
      sessionId: this.sessionId,
      modeId: this.playbook.id,
      setup: this.setup,
      brief: this.brief,
      state: this.state,
      turns: this.turns.slice(),
      events: this.events.slice(),
      metrics: { ...this.metrics, latenciesMs: this.metrics.latenciesMs.slice() },
    }
  }

  /** Feed every STT update (interim and final). */
  onEntry(entry: SttEntry): void {
    if (!this.active) return
    const now = this.deps.now()
    for (const turn of this.assembler.onEntry(entry, now)) this.onTurn(turn, now)
  }

  /** Call every ~250ms: ends turns after pauses, expires stale cards. */
  tick(): void {
    if (!this.active) return
    const now = this.deps.now()
    for (const turn of this.assembler.tick(now)) this.onTurn(turn, now)
    this.retryPendingRun(now)
    const card = this.state.currentCard
    if (card && isCardExpired(card, now)) {
      this.clearCard('expired', now)
    }
  }

  dismissCard(): void {
    if (!this.active || !this.state.currentCard) return
    this.clearCard('dismissed', this.deps.now())
  }

  /** Keep the current card on screen longer (user is using it). */
  holdCard(extraSeconds = 30): void {
    const card = this.state.currentCard
    if (!this.active || !card) return
    const now = this.deps.now()
    const remaining = Math.max(0, (cardExpiresAt(card) - now) / 1000)
    const held: Card = { ...card, expiresAfterSeconds: Math.round((now - card.createdAt) / 1000 + remaining + extraSeconds) }
    this.apply({ type: 'card_published', at: now, card: held })
    this.deps.onCard(held)
  }

  applyUserUpdates(updates: StateUpdates): void {
    if (!this.active) return
    this.apply({ type: 'state_updates', at: this.deps.now(), origin: 'user', updates })
  }

  /** Explicit user request (Assist hotkey or "think deeper"). Bypasses run gates. */
  async request(kind: 'user_requested' | 'think_deeper', customPrompt?: string): Promise<RequestOutcome> {
    if (!this.active) return { ok: false, error: 'No meeting in progress' }
    const now = this.deps.now()
    for (const t of this.assembler.flush(now)) this.recordTurn(t)
    return this.runAndPublish({
      kind,
      reason: kind === 'think_deeper' ? 'user asked to think deeper' : 'user asked for help',
      turnId: this.turns[this.turns.length - 1]?.id,
      customPrompt,
    }, { deep: kind === 'think_deeper', userRequested: true })
  }

  private onTurn(turn: Turn, now: number): void {
    this.recordTurn(turn)
    this.maybeRun(turn, now)
  }

  private recordTurn(turn: Turn): void {
    this.turns.push(turn)
    this.apply({ type: 'turn', at: turn.at, turn })
  }

  private maybeRun(turn: Turn, now: number): void {
    if (!this.deps.coachEnabled()) return
    const decision = shouldRunCoach({
      turn,
      now,
      sensitivity: this.deps.sensitivity(this.playbook),
      lastRunAt: this.lastRunAt,
      inFlight: this.inFlight,
      youSpeaking: this.assembler.isSpeaking('you', now),
    })
    if (!decision.run) {
      if (decision.reason === 'in_flight') this.pendingRerun = true
      this.deps.diag('coach_skip', { reason: decision.reason })
      return
    }
    void this.runAndPublish({ kind: 'turn', reason: decision.reason, turnId: turn.id }, { deep: false, userRequested: false })
  }

  /**
   * Turns that arrived while a call was in flight are coalesced into one
   * follow-up run, which still respects the sensitivity rate limit.
   */
  private retryPendingRun(now: number): void {
    if (!this.pendingRerun || this.inFlight || !this.active) return
    const last = this.turns[this.turns.length - 1]
    if (!last || !this.deps.coachEnabled()) {
      this.pendingRerun = false
      return
    }
    const decision = shouldRunCoach({
      turn: last,
      now,
      sensitivity: this.deps.sensitivity(this.playbook),
      lastRunAt: this.lastRunAt,
      inFlight: false,
      youSpeaking: this.assembler.isSpeaking('you', now),
    })
    if (decision.run) {
      this.pendingRerun = false
      void this.runAndPublish({ kind: 'turn', reason: `${decision.reason}_coalesced`, turnId: last.id }, { deep: false, userRequested: false })
    } else if (decision.reason !== 'rate_limited' && decision.reason !== 'user_speaking') {
      this.pendingRerun = false
    }
  }

  private async runAndPublish(
    trigger: CoachInput['trigger'],
    opts: { deep: boolean; userRequested: boolean },
  ): Promise<RequestOutcome> {
    const generation = this.generation
    const startedAt = this.deps.now()
    this.inFlight = true
    this.lastRunAt = startedAt
    this.metrics.coachRuns += 1
    const cardId = `card_${this.sessionId.slice(0, 8)}_${++this.cardSeq}`

    try {
      const result = await this.deps.coach(
        {
          profileText: this.deps.profileText(this.meetingText()),
          playbook: this.playbook,
          brief: this.brief,
          state: this.state,
          turns: this.turns,
          trigger,
          now: startedAt,
          themSpeaking: this.assembler.isSpeaking('them', startedAt),
        },
        { deep: opts.deep, cardId },
      )
      // Session ended or restarted while the call was in flight: drop it.
      if (generation !== this.generation || !this.active) return { ok: false, error: 'Meeting ended' }

      const now = this.deps.now()
      this.metrics.latenciesMs.push(result.latencyMs)
      this.deps.onCoachHealth(true)
      this.deps.diag('coach_run', {
        latencyMs: result.latencyMs,
        model: result.model,
        promptVersion: this.deps.promptVersion,
        reason: trigger.reason,
        warnings: result.parsed.warnings.length,
      })

      const prevTopic = this.state.currentTopic
      if (Object.keys(result.parsed.stateUpdates).length > 0) {
        this.apply({ type: 'state_updates', at: now, origin: 'coach', updates: result.parsed.stateUpdates })
      }

      if (result.parsed.rejected) {
        this.metrics.rejected += 1
        this.deps.diag('card_rejected', { reason: result.parsed.rejected.split(':')[0] })
      }

      const candidate = result.parsed.card
      const current = this.state.currentCard

      // Topic moved: an older card about the previous topic is stale now.
      if (
        current && prevTopic && this.state.currentTopic &&
        normalizeKey(prevTopic) !== normalizeKey(this.state.currentTopic) &&
        now - current.createdAt > TOPIC_MOVE_MIN_AGE_MS
      ) {
        this.clearCard('topic_moved', now)
      }

      if (candidate && !opts.userRequested && this.assembler.isSpeaking('you', now) && this.state.currentCard && candidate.urgency !== 'high') {
        this.metrics.suppressed += 1
        this.deps.diag('card_suppressed', { reason: 'user_speaking_card', mode: candidate.mode })
        return { ok: true, card: null, reason: 'user_speaking_card' }
      }

      const decision = shouldPublish(candidate, {
        now,
        sensitivity: this.deps.sensitivity(this.playbook),
        current: this.state.currentCard,
        recent: this.recentCards,
        themSpeaking: this.assembler.isSpeaking('them', now),
        state: this.state,
        userRequested: opts.userRequested,
      })
      if (!decision.publish || !candidate) {
        if (candidate) {
          this.metrics.suppressed += 1
          this.deps.diag('card_suppressed', { reason: decision.reason, mode: candidate.mode, confidence: candidate.confidence })
        }
        return { ok: true, card: null, reason: result.parsed.rejected ? 'rejected' : decision.reason }
      }

      const card: Card = { ...candidate, createdAt: now }
      if (this.state.currentCard) {
        this.recentCards.push(this.state.currentCard)
        if (this.recentCards.length > MAX_RECENT_CARDS) this.recentCards.shift()
      }
      this.apply({ type: 'card_published', at: now, card })
      this.metrics.cards += 1
      this.deps.onCard(card)
      this.deps.diag('card_published', { mode: card.mode, urgency: card.urgency, confidence: card.confidence, words: card.text.split(/\s+/).length })
      return { ok: true, card, reason: decision.reason }
    } catch (err) {
      if (generation !== this.generation) return { ok: false, error: 'Meeting ended' }
      this.metrics.coachErrors += 1
      const message = err instanceof Error ? err.message : String(err)
      this.deps.onCoachHealth(false, message)
      this.deps.diag('coach_error', { errorClass: err instanceof Error ? err.name : 'unknown' })
      return { ok: false, error: message }
    } finally {
      if (generation === this.generation) {
        this.inFlight = false
        this.retryPendingRun(this.deps.now())
      }
    }
  }

  private clearCard(reason: 'expired' | 'dismissed' | 'replaced' | 'topic_moved', now: number): void {
    const card = this.state.currentCard
    if (!card) return
    this.recentCards.push(card)
    if (this.recentCards.length > MAX_RECENT_CARDS) this.recentCards.shift()
    this.apply({ type: 'card_cleared', at: now, reason })
    this.deps.onCard(null)
    this.deps.diag('card_cleared', { reason, mode: card.mode })
  }

  private apply(event: MeetingEvent): void {
    this.events.push(event)
    this.state = reduceMeeting(this.state, event)
    this.deps.onState(this.state)
  }

  /** Text used to decide which dynamic profile context is relevant. */
  private meetingText(): string {
    const s = this.state
    return [
      s.objective, s.currentTopic, s.people.join(' '), s.organizations.join(' '),
      this.turns.slice(-6).map((t) => t.text).join(' '),
    ].join(' ')
  }
}
