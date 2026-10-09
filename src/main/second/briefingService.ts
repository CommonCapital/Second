/**
 * Pre-meeting brief and post-meeting report generation (deep model slot).
 */

import type { AIProvider } from '../services/ai/types'
import {
  formatBriefForPrompt,
  formatSetupForPrompt,
  parseMeetingBrief,
  parsePostMeetingReport,
  type MeetingBrief,
  type MeetingSetupInput,
  type PostMeetingReport,
} from '../../shared/second/briefing'
import { formatStateForPrompt, type MeetingState, type Turn } from '../../shared/second/meetingState'
import { formatPlaybookForPrompt, getPlaybook } from '../../shared/second/playbooks'
import { BRIEF_SYSTEM_PROMPT, REPORT_SYSTEM_PROMPT } from './prompts'

/** Transcript budget for the report prompt (characters, most recent kept). */
export const REPORT_TRANSCRIPT_CHARS = 60_000

export async function generateBrief(
  provider: AIProvider,
  setup: MeetingSetupInput,
  profileText: string,
  now = Date.now(),
): Promise<MeetingBrief | null> {
  const playbook = getPlaybook(setup.mode)
  const prompt = [
    profileText.trim() ? `<user_profile>\n${profileText}\n</user_profile>` : '',
    `<mode_playbook>\n${formatPlaybookForPrompt(playbook)}\n</mode_playbook>`,
    `<meeting_setup>\n${formatSetupForPrompt(setup)}\n</meeting_setup>`,
    'Write the brief now. Return only the JSON object.',
  ].filter(Boolean).join('\n\n')
  const raw = await provider.generateShort({ system: BRIEF_SYSTEM_PROMPT, prompt, maxTokens: 1500 })
  return parseMeetingBrief(raw, now)
}

export function transcriptForReport(turns: Turn[], youName = 'YOU'): string {
  const lines = turns.map((t) => `${t.id} ${t.speaker === 'you' ? youName : 'THEM'}: ${t.text}`)
  let text = lines.join('\n')
  if (text.length > REPORT_TRANSCRIPT_CHARS) {
    text = `[earlier transcript omitted]\n${text.slice(text.length - REPORT_TRANSCRIPT_CHARS)}`
  }
  return text
}

export async function generateReport(
  provider: AIProvider,
  params: {
    state: MeetingState
    turns: Turn[]
    brief: MeetingBrief | null
    profileText: string
    modeId: string
  },
  now = Date.now(),
): Promise<PostMeetingReport | null> {
  if (params.turns.length === 0) return null
  const playbook = getPlaybook(params.modeId)
  const prompt = [
    params.profileText.trim() ? `<user_profile>\n${params.profileText}\n</user_profile>` : '',
    `<mode_playbook>\n${formatPlaybookForPrompt(playbook)}\n</mode_playbook>`,
    params.brief ? `<meeting_brief>\n${formatBriefForPrompt(params.brief)}\n</meeting_brief>` : '',
    `<meeting_state>\n${formatStateForPrompt(params.state)}\n</meeting_state>`,
    `<transcript>\n${transcriptForReport(params.turns)}\n</transcript>`,
    'Write the post-meeting report now. Return only the JSON object.',
  ].filter(Boolean).join('\n\n')
  const raw = await provider.generateShort({ system: REPORT_SYSTEM_PROMPT, prompt, maxTokens: 2500 })
  return parsePostMeetingReport(raw, now)
}
