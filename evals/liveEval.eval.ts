/**
 * Live replay evaluation: runs the production coach (same prompt, parser,
 * reducer) over the curated corpus and writes a scorecard.
 *
 *   SECOND_EVAL_PROVIDER=anthropic ANTHROPIC_API_KEY=... npm run eval
 *   SECOND_EVAL_PROVIDER=openai    OPENAI_API_KEY=...    npm run eval
 *   SECOND_EVAL_MODEL=claude-haiku-4-5   (optional, else the coach default)
 *   SECOND_EVAL_ENFORCE=1                (fail if release thresholds miss)
 *
 * Output: evals/results/scorecard-<timestamp>.csv, scorecard-latest.csv,
 * and summary-latest.json. Human reviewers fill the blank score columns.
 */

import { describe, expect, it } from 'vitest'
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { AnthropicProvider } from '../src/main/services/ai/anthropicProvider'
import { OpenAIProvider } from '../src/main/services/ai/openaiProvider'
import type { AIProvider } from '../src/main/services/ai/types'
import { PROMPT_VERSION } from '../src/main/second/prompts'
import { COACH_DEFAULT_MODELS } from '../src/main/services/ai/providerFactory'
import { summarize, toCsv, validateScenario, type EvalScenario, type MomentScore } from '../src/shared/second/evalScoring'
import { replayScenario } from './replay'

const providerName = (process.env.SECOND_EVAL_PROVIDER || (process.env.OPENAI_API_KEY && !process.env.ANTHROPIC_API_KEY ? 'openai' : 'anthropic')) as 'anthropic' | 'openai'
const apiKey = providerName === 'openai' ? process.env.OPENAI_API_KEY : process.env.ANTHROPIC_API_KEY
const model = process.env.SECOND_EVAL_MODEL || COACH_DEFAULT_MODELS[providerName]

function makeProvider(): AIProvider {
  return providerName === 'openai'
    ? new OpenAIProvider(apiKey!, model, 'none')
    : new AnthropicProvider(apiKey!, model, 'low')
}

const scenarioDir = join(process.cwd(), 'evals', 'scenarios')
const scenarios: EvalScenario[] = readdirSync(scenarioDir)
  .filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(readFileSync(join(scenarioDir, f), 'utf8')) as EvalScenario)

describe.skipIf(!apiKey)(`Second live eval (${providerName}:${model}, ${PROMPT_VERSION})`, () => {
  it('corpus is valid', () => {
    for (const s of scenarios) expect(validateScenario(s), s.id).toEqual([])
  })

  it('replays the corpus and writes a scorecard', async () => {
    const provider = makeProvider()
    const rows: MomentScore[] = []
    for (const s of scenarios) {
      rows.push(...(await replayScenario(provider, s)))
    }
    const summary = summarize(rows)
    const outDir = join(process.cwd(), 'evals', 'results')
    mkdirSync(outDir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const csv = toCsv(rows, { promptVersion: PROMPT_VERSION, model: `${providerName}:${model}` })
    writeFileSync(join(outDir, `scorecard-${stamp}.csv`), csv)
    writeFileSync(join(outDir, 'scorecard-latest.csv'), csv)
    writeFileSync(join(outDir, 'summary-latest.json'), JSON.stringify({ promptVersion: PROMPT_VERSION, model: `${providerName}:${model}`, ...summary }, null, 2))

    console.log(`\nSecond eval ${PROMPT_VERSION} on ${providerName}:${model}`)
    console.log(`  moments: ${summary.moments}, auto-good: ${summary.autoGood} (${Math.round(summary.goodRate * 100)}%)`)
    console.log(`  forbidden-mode choices: ${summary.forbidden}, contract failures: ${summary.contractFailures}`)
    console.log(`  latency p50 ${summary.p50Ms}ms, p95 ${summary.p95Ms}ms`)
    for (const r of rows.filter((x) => !x.autoGood)) {
      console.log(`  MISS ${r.scenarioId}@${r.afterTurn}: got ${r.mode} "${r.text}" ${r.rejectedReason ? `(${r.rejectedReason})` : ''}\n       expected: ${r.note}`)
    }

    if (process.env.SECOND_EVAL_ENFORCE === '1') {
      expect(summary.passes.quality, 'auto-good rate below release threshold').toBe(true)
      expect(summary.forbidden, 'forbidden-mode choices').toBe(0)
    }
  }, 30 * 60_000)
})
