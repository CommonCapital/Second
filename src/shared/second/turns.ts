/**
 * Turn assembly: groups finalized STT segments into speaker turns.
 *
 * STT engines emit many short finals per speaker (and sometimes update the
 * same entry id as they merge). Coaching should only fire on a *meaningful
 * finalized turn*: a run of finals from one speaker that has ended because
 * the other side started talking or because the speaker went quiet.
 *
 * Pure: the caller supplies `now`, so tests and replays are deterministic.
 */

import type { Speaker, Turn } from './meetingState'

export interface SttEntry {
  id: string
  source: 'mic' | 'system'
  text: string
  isFinal: boolean
}

/** Speaker silent this long after their last final => turn ends. */
export const TURN_END_SILENCE_MS = 1100
/** An interim within this window means the speaker is still talking. */
export const SPEAKING_WINDOW_MS = 900

interface PendingTurn {
  speaker: Speaker
  segments: Map<string, string>
  startedAt: number
  lastActivityAt: number
}

export function speakerFor(source: 'mic' | 'system'): Speaker {
  return source === 'mic' ? 'you' : 'them'
}

export class TurnAssembler {
  private pending: PendingTurn | null = null
  private lastInterimAt: Record<Speaker, number> = { you: 0, them: 0 }
  private counter = 0

  constructor(private readonly silenceMs = TURN_END_SILENCE_MS, startCount = 0) {
    this.counter = startCount
  }

  /** Feed one STT update. Returns any turns that this update completed. */
  onEntry(entry: SttEntry, now: number): Turn[] {
    const speaker = speakerFor(entry.source)
    const text = entry.text.trim()
    const committed: Turn[] = []

    if (!entry.isFinal) {
      if (!text) return committed
      this.lastInterimAt[speaker] = now
      // The other side started talking: the pending turn is over.
      if (this.pending && this.pending.speaker !== speaker && text.split(/\s+/).length >= 2) {
        const t = this.commit(now)
        if (t) committed.push(t)
      } else if (this.pending && this.pending.speaker === speaker) {
        this.pending.lastActivityAt = now
      }
      return committed
    }

    if (!text) return committed

    if (this.pending && this.pending.speaker !== speaker) {
      const t = this.commit(now)
      if (t) committed.push(t)
    }
    if (!this.pending) {
      this.pending = { speaker, segments: new Map(), startedAt: now, lastActivityAt: now }
    }
    // Same id = the STT engine merged more words into an existing entry.
    this.pending.segments.set(entry.id, text)
    this.pending.lastActivityAt = now
    return committed
  }

  /** Call periodically; ends the pending turn after a pause. */
  tick(now: number): Turn[] {
    if (!this.pending) return []
    const lastInterim = this.lastInterimAt[this.pending.speaker]
    const lastActivity = Math.max(this.pending.lastActivityAt, lastInterim)
    if (now - lastActivity >= this.silenceMs) {
      const t = this.commit(now)
      return t ? [t] : []
    }
    return []
  }

  /** Force-commit whatever is pending (meeting end, manual Assist). */
  flush(now: number): Turn[] {
    const t = this.commit(now)
    return t ? [t] : []
  }

  isSpeaking(speaker: Speaker, now: number): boolean {
    return now - this.lastInterimAt[speaker] < SPEAKING_WINDOW_MS
  }

  pendingSpeaker(): Speaker | null {
    return this.pending?.speaker ?? null
  }

  get turnCount(): number {
    return this.counter
  }

  private commit(now: number): Turn | null {
    const p = this.pending
    this.pending = null
    if (!p) return null
    const text = [...p.segments.values()].join(' ').replace(/\s+/g, ' ').trim()
    if (!text) return null
    this.counter += 1
    return { id: `turn_${this.counter}`, speaker: p.speaker, text, at: now }
  }
}
