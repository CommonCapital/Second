/**
 * Replays one corpus scenario through the production reducer + coach and
 * scores each annotated decision moment. Provider is injected so this runs
 * against a real model (npm run eval) or a fake one (unit tests).
 */

import type { AIProvider } from '../src/main/services/ai/types'
import { runCoach } from '../src/main/second/coachService'
import { createMeetingState, reduceMeeting, type MeetingState, type Turn } from '../src/shared/second/meetingState'
import { getPlaybook } from '../src/shared/second/playbooks'
import { formatProfileForPrompt, normalizeProfile } from '../src/shared/second/profile'
import { scoreMoment, type EvalScenario, type MomentScore } from '../src/shared/second/evalScoring'

const TURN_SPACING_MS = 8_000

export async function replayScenario(provider: AIProvider, s: EvalScenario): Promise<MomentScore[]> {
  const playbook = getPlaybook(s.mode)
  const start = Date.now()
  let state: MeetingState = reduceMeeting(createMeetingState(), {
    type: 'meeting_started',
    at: start,
    meetingId: s.id,
    mode: playbook.id,
    setup: {
      objective: s.setup?.objective,
      idealOutcome: s.setup?.idealOutcome,
      avoid: s.setup?.avoid,
      people: s.setup?.counterpartyPeople,
      organizations: s.setup?.counterpartyOrg ? [s.setup.counterpartyOrg] : [],
      closeTarget: playbook.closeTarget,
    },
  })
  const profileText = formatProfileForPrompt(normalizeProfile(s.profile ?? {}))
  const turns: Turn[] = []
  const rows: MomentScore[] = []

  for (let i = 0; i < s.turns.length; i++) {
    const at = start + (i + 1) * TURN_SPACING_MS
    const turn: Turn = { id: `turn_${i + 1}`, speaker: s.turns[i].speaker, text: s.turns[i].text, at }
    turns.push(turn)
    state = reduceMeeting(state, { type: 'turn', at, turn })

    for (const moment of s.moments.filter((m) => m.after_turn === i + 1)) {
      const t0 = Date.now()
      const result = await runCoach(provider, {
        profileText,
        playbook,
        brief: null,
        state,
        turns,
        trigger: { kind: 'turn', reason: turn.speaker === 'them' && turn.text.trim().endsWith('?') ? 'direct_question' : 'finalized_turn', turnId: turn.id },
        now: at,
        themSpeaking: false,
      }, { cardId: `${s.id}_${turn.id}`, timeoutMs: 30_000 })
      const latency = Date.now() - t0
      if (Object.keys(result.stateUpdates).length) {
        state = reduceMeeting(state, { type: 'state_updates', at, origin: 'coach', updates: result.stateUpdates })
      }
      rows.push(scoreMoment(s.id, moment, result, latency))
    }
  }
  return rows
}

