/**
 * Coach service: one structured card per qualifying turn.
 *
 * Prompt discipline (cache-friendly, compact):
 *   system  = versioned core prompt (static)
 *   user    = profile + playbook + brief (stable for the meeting)
 *             then meeting state + recent turns + trigger (volatile, last)
 * The full transcript is never resent; the state carries the long memory.
 */

import type { AIProvider } from '../services/ai/types'
import { parseCoachResponse, type ParsedCoachResponse } from '../../shared/second/card'
import { formatStateForPrompt, type MeetingState, type Turn } from '../../shared/second/meetingState'
import { formatPlaybookForPrompt, type Playbook } from '../../shared/second/playbooks'
import { formatBriefForPrompt, type MeetingBrief } from '../../shared/second/briefing'
import { CORE_SYSTEM_PROMPT } from './prompts'

export const RECENT_TURN_LIMIT = 12
export const RECENT_WORD_BUDGET = 1200
export const COACH_TIMEOUT_MS = 9_000

export interface CoachInput {
  profileText: string
  playbook: Playbook
  brief: MeetingBrief | null
  state: MeetingState
  turns: Turn[]
  trigger: { kind: 'turn' | 'user_requested' | 'think_deeper'; turnId?: string; reason: string; customPrompt?: string }
  now: number
  themSpeaking: boolean
}

export function recentTurnWindow(turns: Turn[], limit = RECENT_TURN_LIMIT, wordBudget = RECENT_WORD_BUDGET): Turn[] {
  const out: Turn[] = []
  let words = 0
  for (let i = turns.length - 1; i >= 0 && out.length < limit; i--) {
    const w = turns[i].text.split(/\s+/).length
    if (out.length > 0 && words + w > wordBudget) break
    out.unshift(turns[i])
    words += w
  }
  return out
}

function elapsed(state: MeetingState, now: number): string {
  if (!state.startedAt) return '0:00'
  const s = Math.max(0, Math.floor((now - state.startedAt) / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export function buildCoachUserPrompt(input: CoachInput): string {
  const parts: string[] = []
  if (input.profileText.trim()) parts.push(`<user_profile>\n${input.profileText}\n</user_profile>`)
  parts.push(`<mode_playbook>\n${formatPlaybookForPrompt(input.playbook)}\n</mode_playbook>`)
  if (input.brief) parts.push(`<meeting_brief>\n${formatBriefForPrompt(input.brief)}\n</meeting_brief>`)
  parts.push(`<meeting_state>\n${formatStateForPrompt(input.state)}\n</meeting_state>`)

  const window = recentTurnWindow(input.turns)
  const turnLines = window.map((t) => `${t.id} ${t.speaker.toUpperCase()}: ${t.text}`)
  parts.push(`<recent_turns>\n${turnLines.join('\n') || '(no finalized turns yet)'}\n</recent_turns>`)

  const triggerLines = [
    `kind: ${input.trigger.kind}`,
    `reason: ${input.trigger.reason}`,
    input.trigger.turnId ? `latest_turn: ${input.trigger.turnId}` : '',
    `elapsed: ${elapsed(input.state, input.now)}`,
    `them_speaking_now: ${input.themSpeaking ? 'yes' : 'no'}`,
  ].filter(Boolean)
  parts.push(`<trigger>\n${triggerLines.join('\n')}\n</trigger>`)

  if (input.trigger.customPrompt?.trim()) {
    parts.push(`<user_input>\nUSER QUESTION: ${input.trigger.customPrompt.trim()}\n</user_input>`)
  }
  if (input.trigger.kind !== 'turn') {
    parts.push('The user explicitly asked for help now: return your single best card (NONE only if truly nothing helps).')
  }
  parts.push('Return only the JSON object.')
  return parts.join('\n\n')
}

export class CoachTimeoutError extends Error {
  constructor() {
    super('coach timed out')
  }
}

export async function runCoach(
  provider: AIProvider,
  input: CoachInput,
  opts: { cardId: string; timeoutMs?: number },
): Promise<ParsedCoachResponse & { raw: string }> {
  const prompt = buildCoachUserPrompt(input)
  let timer: ReturnType<typeof setTimeout> | null = null
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new CoachTimeoutError()), opts.timeoutMs ?? COACH_TIMEOUT_MS)
  })
  try {
    const raw = await Promise.race([
      provider.generateShort({ system: CORE_SYSTEM_PROMPT, prompt, maxTokens: 900 }),
      timeout,
    ])
    const parsed = parseCoachResponse(raw, { now: Date.now(), id: opts.cardId })
    return { ...parsed, raw }
  } finally {
    if (timer) clearTimeout(timer)
  }
}
