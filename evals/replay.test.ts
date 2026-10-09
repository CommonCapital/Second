import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { replayScenario } from './replay'
import type { AIProvider } from '../src/main/services/ai/types'
import type { EvalScenario } from '../src/shared/second/evalScoring'

const scenario = JSON.parse(readFileSync(join(process.cwd(), 'evals/scenarios/founder-evasive-metrics.json'), 'utf8')) as EvalScenario

describe('eval replay pipeline (fake provider)', () => {
  it('runs the coach at each decision moment, applies state, and scores', async () => {
    const prompts: string[] = []
    const provider: AIProvider = {
      name: 'anthropic',
      streamResponse: async () => {},
      generateShort: async ({ prompt }) => {
        prompts.push(prompt)
        return prompts.length === 1
          ? '{"mode":"WAIT","state_updates":{"numbers":[{"metric":"ARR","value":4200000,"period":"last year","source":"turn_1"}]}}'
          : '{"mode":"WATCH","text":"ARR went from 4.2M to 3.6M. Which is right?","confidence":0.85,"grounding":["turn_1","turn_5"],"state_updates":{"numbers":[{"metric":"ARR","value":3600000,"period":"last year","source":"turn_5"}]}}'
      },
    }
    const rows = await replayScenario(provider, scenario)
    expect(rows.map((r) => [r.afterTurn, r.mode, r.autoGood])).toEqual([[3, 'WAIT', true], [5, 'WATCH', true]])
    // The second call sees the state the first call recorded.
    expect(prompts[1]).toContain('ARR: 4200000')
    expect(prompts[1]).toContain('turn_5 THEM')
  })
})
