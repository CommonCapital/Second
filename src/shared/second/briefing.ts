/**
 * Pre-meeting packet and post-meeting report contracts.
 *
 * Brief:  the best live answer starts before the call. A 90-second read:
 *         who they are, what matters, three facts, three questions to land,
 *         two likely hard questions, one close target, and what not to say.
 * Report: shorter than most notes, more useful than most notes. Grounded in
 *         the meeting state + transcript; proposes (never applies) context
 *         updates for the user to approve.
 */

import { extractJsonObject } from './card'
import type { MeetingModeId } from './playbooks'

export interface MeetingSetupInput {
  mode: MeetingModeId
  title?: string
  counterpartyPeople: string[]
  counterpartyOrg: string
  objective: string
  idealOutcome: string
  avoid: string[]
  /** Pasted notes, prior thread, agenda, or document excerpts. */
  notes: string
}

export interface HardQuestion {
  question: string
  answerShape: string
}

export interface MeetingBrief {
  whoTheyAre: string
  whatMatters: string
  likelyAgenda: string[]
  likelyCounterpartyObjectives: string[]
  factsToRemember: string[]
  questionsToLand: string[]
  hardQuestions: HardQuestion[]
  closeTarget: string
  doNotSay: string[]
  generatedAt: number
}

export interface ReportCommitment {
  who: string
  action: string
  due?: string
}

export interface ContextUpdateProposal {
  topic: string
  content: string
}

export interface PostMeetingReport {
  outcome: string
  factsLearned: string[]
  decisions: string[]
  commitments: ReportCommitment[]
  openQuestions: string[]
  risks: string[]
  nextStep: string
  followUpDraft: string
  contextUpdates: ContextUpdateProposal[]
  generatedAt: number
}

type Json = Record<string, unknown>
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {})
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')
const strs = (v: unknown, max = 8): string[] =>
  (Array.isArray(v) ? v : []).map((x) => (typeof x === 'string' ? x.trim() : '')).filter(Boolean).slice(0, max)

function parseJson(raw: string): Json | null {
  const text = extractJsonObject(raw)
  if (!text) return null
  try {
    return obj(JSON.parse(text))
  } catch {
    return null
  }
}

export function parseMeetingBrief(raw: string, now: number): MeetingBrief | null {
  const o = parseJson(raw)
  if (!o) return null
  const brief: MeetingBrief = {
    whoTheyAre: str(o.who_they_are),
    whatMatters: str(o.what_matters),
    likelyAgenda: strs(o.likely_agenda, 6),
    likelyCounterpartyObjectives: strs(o.likely_counterparty_objectives, 5),
    factsToRemember: strs(o.facts_to_remember, 3),
    questionsToLand: strs(o.questions_to_land, 3),
    hardQuestions: (Array.isArray(o.hard_questions) ? o.hard_questions : [])
      .map(obj)
      .map((q) => ({ question: str(q.question), answerShape: str(q.answer_shape) }))
      .filter((q) => q.question)
      .slice(0, 2),
    closeTarget: str(o.close_target),
    doNotSay: strs(o.do_not_say, 5),
    generatedAt: now,
  }
  if (!brief.whatMatters && brief.questionsToLand.length === 0 && !brief.closeTarget) return null
  return brief
}

export function parsePostMeetingReport(raw: string, now: number): PostMeetingReport | null {
  const o = parseJson(raw)
  if (!o) return null
  const report: PostMeetingReport = {
    outcome: str(o.outcome),
    factsLearned: strs(o.facts_learned, 12),
    decisions: strs(o.decisions, 8),
    commitments: (Array.isArray(o.commitments) ? o.commitments : [])
      .map(obj)
      .map((c) => ({ who: str(c.who), action: str(c.action), due: str(c.due) || undefined }))
      .filter((c) => c.who && c.action)
      .slice(0, 12),
    openQuestions: strs(o.open_questions, 8),
    risks: strs(o.risks, 6),
    nextStep: str(o.next_step),
    followUpDraft: str(o.follow_up_draft),
    contextUpdates: (Array.isArray(o.context_updates) ? o.context_updates : [])
      .map(obj)
      .map((c) => ({ topic: str(c.topic), content: str(c.content) }))
      .filter((c) => c.topic && c.content)
      .slice(0, 5),
    generatedAt: now,
  }
  if (!report.outcome && !report.nextStep && report.decisions.length === 0) return null
  return report
}

export function formatBriefForPrompt(b: MeetingBrief): string {
  const lines: string[] = []
  const add = (label: string, v: string) => v && lines.push(`${label}: ${v}`)
  const list = (label: string, v: string[]) => v.length && lines.push(`${label}:\n${v.map((x) => `  - ${x}`).join('\n')}`)
  add('who_they_are', b.whoTheyAre)
  add('what_matters', b.whatMatters)
  list('likely_agenda', b.likelyAgenda)
  list('likely_counterparty_objectives', b.likelyCounterpartyObjectives)
  list('facts_to_remember', b.factsToRemember)
  list('questions_to_land', b.questionsToLand)
  if (b.hardQuestions.length) {
    lines.push(`hard_questions:\n${b.hardQuestions.map((q) => `  - ${q.question} -> ${q.answerShape}`).join('\n')}`)
  }
  add('close_target', b.closeTarget)
  list('do_not_say', b.doNotSay)
  return lines.join('\n')
}

export function formatSetupForPrompt(s: MeetingSetupInput): string {
  const lines: string[] = []
  if (s.title) lines.push(`meeting: ${s.title}`)
  if (s.counterpartyPeople.length) lines.push(`counterparty_people: ${s.counterpartyPeople.join(', ')}`)
  if (s.counterpartyOrg) lines.push(`counterparty_org: ${s.counterpartyOrg}`)
  if (s.objective) lines.push(`objective: ${s.objective}`)
  if (s.idealOutcome) lines.push(`ideal_outcome: ${s.idealOutcome}`)
  if (s.avoid.length) lines.push(`avoid: ${s.avoid.join('; ')}`)
  if (s.notes.trim()) lines.push(`<supplied_context>\n${s.notes.trim().slice(0, 12_000)}\n</supplied_context>`)
  return lines.join('\n')
}

export function reportToMarkdown(r: PostMeetingReport): string {
  const out: string[] = []
  const section = (title: string, items: string[]) => {
    if (!items.length) return
    out.push(`## ${title}`, ...items.map((i) => `- ${i}`), '')
  }
  if (r.outcome) out.push(`## Outcome`, r.outcome, '')
  section('Facts learned', r.factsLearned)
  section('Decisions', r.decisions)
  section('Commitments', r.commitments.map((c) => `${c.who}: ${c.action}${c.due ? ` (by ${c.due})` : ''}`))
  section('Open questions', r.openQuestions)
  section('Risks / watch items', r.risks)
  if (r.nextStep) out.push(`## Next step`, r.nextStep, '')
  if (r.followUpDraft) out.push(`## Follow-up draft`, r.followUpDraft, '')
  return out.join('\n').trim()
}

const clip = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '')
const clipList = (v: unknown, maxItems: number, maxLen: number): string[] => {
  const arr = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[,\n;]/) : []
  return arr.map((x) => clip(x, maxLen)).filter(Boolean).slice(0, maxItems)
}

/** Validate untrusted setup input (from the renderer) into a safe shape. */
export function normalizeSetup(raw: unknown, validModes: readonly string[]): MeetingSetupInput {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const mode = typeof o.mode === 'string' && validModes.includes(o.mode) ? (o.mode as MeetingModeId) : 'general'
  return {
    mode,
    title: clip(o.title, 200) || undefined,
    counterpartyPeople: clipList(o.counterpartyPeople, 12, 120),
    counterpartyOrg: clip(o.counterpartyOrg, 200),
    objective: clip(o.objective, 1000),
    idealOutcome: clip(o.idealOutcome, 1000),
    avoid: clipList(o.avoid, 10, 300),
    notes: clip(o.notes, 20_000),
  }
}

export function isSetupEmpty(s: MeetingSetupInput): boolean {
  return !s.title && s.counterpartyPeople.length === 0 && !s.counterpartyOrg && !s.objective && !s.idealOutcome && s.avoid.length === 0 && !s.notes
}
