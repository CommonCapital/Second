/**
 * Meeting mode playbooks. A mode changes the objective, retrieval priorities,
 * intervention threshold, and close target. It never changes who the user is.
 */

import type { Sensitivity } from './interventionGate'

export type MeetingModeId =
  | 'general'
  | 'founder'
  | 'lp'
  | 'interview'
  | 'banker'
  | 'negotiation'
  | 'ic'
  | 'relationship'

export interface Playbook {
  id: MeetingModeId
  label: string
  objective: string
  optimize: string[]
  listenFor: string[]
  closeTarget: string
  guardrails: string[]
  /** Default sensitivity for this room; the user setting can override. */
  sensitivity: Sensitivity
}

export const PLAYBOOKS: Record<MeetingModeId, Playbook> = {
  general: {
    id: 'general',
    label: 'General executive',
    objective: 'Clarify the decision and drive action.',
    optimize: ['objective', 'tradeoffs', 'owner', 'date', 'unresolved risk', 'next action'],
    listenFor: ['decisions being made or deferred', 'owners and dates', 'risks nobody owns'],
    closeTarget: 'One decision or next step with an owner and a date.',
    guardrails: ['No generic advice', 'Do not invent facts or commitments'],
    sensitivity: 'balanced',
  },
  founder: {
    id: 'founder',
    label: 'Founder / investment',
    objective: 'Relationship plus evidence plus the next underwriting step.',
    optimize: [
      'paid product vs services', 'customer proof', 'retention and expansion', 'gross margin',
      'budget owner', 'sales motion', 'product control point', 'burn and runway',
      'financing purpose', 'cap table', 'founder clarity',
    ],
    listenFor: [
      'what the founder is proud of', 'ARR quality and concentration', 'GRR / NRR', 'churn reasons',
      'implementation burden', 'win/loss evidence', 'evasive or shifting metrics',
    ],
    closeTarget: 'Request the specific materials for the next diligence step (e.g. monthly P&L, ARR by customer, cap table).',
    guardrails: [
      'Relationship first, then proof; no checklist energy in the first five minutes',
      'No valuation view before enough evidence',
      'No commitment language before authority and process support it',
      'Never invent allocations, syndicates, or internal approvals',
      'One precise follow-up, never a five-part question',
      'If the evidence is strong, move on rather than asking to look diligent',
    ],
    sensitivity: 'balanced',
  },
  lp: {
    id: 'lp',
    label: 'LP / allocator',
    objective: 'Credibility plus a real decision path.',
    optimize: [
      'mandate fit', 'check size', 'pacing', 'emerging manager policy', 'IC process',
      'diligence requirements', 'consultant involvement', 'timing',
    ],
    listenFor: [
      'allocator type and constraints', 'who decides, influences, or can block',
      'what proof they need next', 'whether this is diligence, relationship, or polite exploration',
    ],
    closeTarget: 'The next diligence step, who else is involved, what to send before it, and the decision window.',
    guardrails: ['Never invent traction or commitments from other LPs', 'Avoid careless solicitation language'],
    sensitivity: 'quiet',
  },
  interview: {
    id: 'interview',
    label: 'Interview',
    objective: 'Win the role truthfully and naturally.',
    optimize: ['direct answer first', 'relevant proof from real background', 'role fit', 'technical correctness', 'preserve leverage'],
    listenFor: ['every part of a multi-part question', 'what the interviewer is really testing', 'compensation anchors'],
    closeTarget: 'Clear next step in the process and timing.',
    guardrails: [
      'Answer first, then proof',
      'Use only grounded background from the profile; never inflate ownership or invent facts',
      'No bluffing on technical questions; state assumptions and ask for missing data',
      'Do not anchor compensation unless asked',
    ],
    sensitivity: 'active',
  },
  banker: {
    id: 'banker',
    label: 'Banker / sponsor',
    objective: 'Understand real access, economics, control, process, and timing.',
    optimize: ['role of the other party', 'who controls the asset or mandate', 'exclusivity', 'financing need', 'fee structure', 'next action'],
    listenFor: ['principal vs intermediary', 'real process vs soft market sounding', 'unverifiable claims'],
    closeTarget: 'A concrete next action with the actual decision maker identified.',
    guardrails: ['Never imply licensed placement activity, transaction authority, or success-fee arrangements that do not exist'],
    sensitivity: 'balanced',
  },
  negotiation: {
    id: 'negotiation',
    label: 'Negotiation',
    objective: 'Identify the variable actually being traded and protect it.',
    optimize: ['price', 'structure', 'certainty', 'time', 'control', 'information', 'future option value'],
    listenFor: ['every number and each revision', 'constraints exposed by questions', 'concessions requested'],
    closeTarget: 'Agreed terms or a clearly defined next round, with what each side owes.',
    guardrails: [
      'Do not concede multiple variables at once',
      'Use questions to expose constraints before moving terms',
      'If there is no need to fill silence, WAIT',
    ],
    sensitivity: 'quiet',
  },
  ic: {
    id: 'ic',
    label: 'IC / portfolio',
    objective: 'Make the decision better.',
    optimize: ['what must be true', 'what the evidence shows', 'downside case', 'key sensitivity', 'decision', 'owner'],
    listenFor: ['unsupported assumptions', 'missing downside', 'recommendations without an owner or date'],
    closeTarget: 'A decision, or the specific evidence needed to make it, with owner and date.',
    guardrails: ['Prefer one decision table over a narrative dump', 'Every recommendation needs an owner, expected output, and date'],
    sensitivity: 'balanced',
  },
  relationship: {
    id: 'relationship',
    label: 'Relationship / networking',
    objective: 'Build a genuine long-term relationship.',
    optimize: ['specific curiosity', 'shared context', 'giving value', 'a natural second touch'],
    listenFor: ['what they care about', 'where you can genuinely help'],
    closeTarget: 'A natural reason to talk again.',
    guardrails: ['Avoid transactional asks', 'Mostly listen; WAIT is usually right'],
    sensitivity: 'quiet',
  },
}

export const PLAYBOOK_IDS = Object.keys(PLAYBOOKS) as MeetingModeId[]

export function getPlaybook(id: string | null | undefined): Playbook {
  return (id && (PLAYBOOKS as Record<string, Playbook>)[id]) || PLAYBOOKS.general
}

export function formatPlaybookForPrompt(p: Playbook): string {
  return [
    `mode: ${p.label}`,
    `objective: ${p.objective}`,
    `optimize: ${p.optimize.join(', ')}`,
    `listen_for: ${p.listenFor.join('; ')}`,
    `close_target: ${p.closeTarget}`,
    `guardrails:\n${p.guardrails.map((g) => `  - ${g}`).join('\n')}`,
  ].join('\n')
}
