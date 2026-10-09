/**
 * Evaluation corpus format and automatic scoring.
 *
 * Every release replays the same corpus and produces a scorecard. Automatic
 * checks cover what a machine can judge (contract, mode choice at annotated
 * decision moments, brevity, voice, grounding, latency). Human columns
 * (usefulness, timing, voice, close quality) are left blank in the CSV for a
 * reviewer to fill in.
 */

import { CARD_MODES, type ParsedCoachResponse } from './card'
import { PLAYBOOK_IDS } from './playbooks'
import { CARD_MAX_WORDS, wordCount } from './voicebook'

export type ExpectedMode = (typeof CARD_MODES)[number] | 'NONE'
const EXPECTED_MODES: readonly string[] = [...CARD_MODES, 'NONE']

export interface EvalTurn {
  speaker: 'you' | 'them'
  text: string
}

export interface EvalMoment {
  after_turn: number
  accept: ExpectedMode[]
  reject?: ExpectedMode[]
  note: string
}

export interface EvalScenario {
  id: string
  mode: string
  title: string
  setup?: {
    counterpartyOrg?: string
    counterpartyPeople?: string[]
    objective?: string
    idealOutcome?: string
    avoid?: string[]
  }
  profile?: Record<string, unknown>
  turns: EvalTurn[]
  moments: EvalMoment[]
}

export function validateScenario(raw: unknown): string[] {
  const errors: string[] = []
  const s = raw as Partial<EvalScenario>
  if (!s || typeof s !== 'object') return ['not an object']
  if (!s.id || typeof s.id !== 'string') errors.push('missing id')
  if (!s.mode || !PLAYBOOK_IDS.includes(s.mode as never)) errors.push(`unknown mode "${String(s.mode)}"`)
  if (!Array.isArray(s.turns) || s.turns.length === 0) errors.push('no turns')
  else {
    s.turns.forEach((t, i) => {
      if (t?.speaker !== 'you' && t?.speaker !== 'them') errors.push(`turn ${i + 1}: bad speaker`)
      if (!t?.text?.trim()) errors.push(`turn ${i + 1}: empty text`)
    })
  }
  if (!Array.isArray(s.moments) || s.moments.length === 0) errors.push('no decision moments')
  else {
    s.moments.forEach((m, i) => {
      const n = s.turns?.length ?? 0
      if (!Number.isInteger(m?.after_turn) || m.after_turn < 1 || m.after_turn > n) errors.push(`moment ${i + 1}: after_turn out of range`)
      if (!Array.isArray(m?.accept) || m.accept.length === 0) errors.push(`moment ${i + 1}: no accepted modes`)
      for (const mode of [...(m?.accept ?? []), ...(m?.reject ?? [])]) {
        if (!EXPECTED_MODES.includes(mode)) errors.push(`moment ${i + 1}: unknown mode ${mode}`)
      }
      if (!m?.note?.trim()) errors.push(`moment ${i + 1}: missing note`)
    })
  }
  return errors
}

export interface MomentScore {
  scenarioId: string
  afterTurn: number
  mode: ExpectedMode
  text: string
  contractOk: boolean
  rejectedReason: string
  modeOk: boolean
  modeForbidden: boolean
  brevityOk: boolean
  grounded: boolean
  latencyMs: number
  /** All automatic checks pass. */
  autoGood: boolean
  note: string
}

export function scoreMoment(
  scenarioId: string,
  moment: EvalMoment,
  parsed: ParsedCoachResponse,
  latencyMs: number,
): MomentScore {
  const mode: ExpectedMode = parsed.card ? parsed.card.mode : 'NONE'
  const text = parsed.card?.text ?? ''
  // A rejected card behaves like silence in the product (nothing shows).
  const contractOk = !parsed.rejected
  // WAIT and NONE both mean "nothing to say"; treat them as interchangeable.
  const equivalent = (m: ExpectedMode): ExpectedMode[] => (m === 'WAIT' || m === 'NONE' ? ['WAIT', 'NONE'] : [m])
  const acceptSet = new Set(moment.accept.flatMap(equivalent))
  const rejectSet = new Set((moment.reject ?? []).flatMap(equivalent))
  const modeOk = acceptSet.has(mode)
  const modeForbidden = rejectSet.has(mode)
  const silent = mode === 'WAIT' || mode === 'NONE'
  const brevityOk = silent || wordCount(text) <= CARD_MAX_WORDS
  const grounded = silent || (parsed.card?.grounding.length ?? 0) > 0
  return {
    scenarioId,
    afterTurn: moment.after_turn,
    mode,
    text,
    contractOk,
    rejectedReason: parsed.rejected ?? '',
    modeOk,
    modeForbidden,
    brevityOk,
    grounded,
    latencyMs,
    autoGood: contractOk && modeOk && !modeForbidden && brevityOk && grounded,
    note: moment.note,
  }
}

export const RELEASE_THRESHOLDS = {
  /** Handoff target: at least 85% of surfaced cards good on the curated corpus. */
  minGoodRate: 0.85,
  p50LatencyMs: 1500,
  p95LatencyMs: 3000,
}

export interface EvalSummary {
  moments: number
  autoGood: number
  goodRate: number
  forbidden: number
  contractFailures: number
  p50Ms: number | null
  p95Ms: number | null
  passes: { quality: boolean; latency: boolean }
}

function pct(values: number[], p: number): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]
}

export function summarize(rows: MomentScore[]): EvalSummary {
  const autoGood = rows.filter((r) => r.autoGood).length
  const lat = rows.map((r) => r.latencyMs)
  const p50 = pct(lat, 50)
  const p95 = pct(lat, 95)
  const goodRate = rows.length ? autoGood / rows.length : 0
  return {
    moments: rows.length,
    autoGood,
    goodRate,
    forbidden: rows.filter((r) => r.modeForbidden).length,
    contractFailures: rows.filter((r) => !r.contractOk).length,
    p50Ms: p50,
    p95Ms: p95,
    passes: {
      quality: goodRate >= RELEASE_THRESHOLDS.minGoodRate,
      latency: p50 !== null && p95 !== null && p50 <= RELEASE_THRESHOLDS.p50LatencyMs && p95 <= RELEASE_THRESHOLDS.p95LatencyMs,
    },
  }
}

const csvCell = (v: unknown) => {
  const s = String(v ?? '')
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export const SCORECARD_HEADER = [
  'prompt_version', 'model', 'scenario', 'after_turn', 'mode', 'card_text', 'auto_good', 'mode_ok', 'mode_forbidden',
  'contract_ok', 'rejected_reason', 'brevity_ok', 'grounded', 'latency_ms', 'note',
  // Human-scored (fill in during review): 1-5
  'usefulness', 'timing', 'grounding_human', 'voice', 'state_accuracy', 'close_quality',
]

export function toCsv(rows: MomentScore[], meta: { promptVersion: string; model: string }): string {
  const lines = [SCORECARD_HEADER.join(',')]
  for (const r of rows) {
    lines.push([
      meta.promptVersion, meta.model, r.scenarioId, r.afterTurn, r.mode, r.text, r.autoGood, r.modeOk, r.modeForbidden,
      r.contractOk, r.rejectedReason, r.brevityOk, r.grounded, r.latencyMs, r.note,
      '', '', '', '', '', '',
    ].map(csvCell).join(','))
  }
  return lines.join('\n') + '\n'
}
