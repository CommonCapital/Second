import { describe, expect, it } from 'vitest'
import { buildCoachUserPrompt, recentTurnWindow, runCoach } from '../coachService'
import { HealthMonitor, STT_RECONNECT_GRACE_MS } from '../healthMonitor'
import { DiagnosticsLog, latencyStats, percentile } from '../diagnostics'
import { CORE_SYSTEM_PROMPT, PROMPT_VERSION } from '../prompts'
import { createMeetingState, type Turn } from '../../../shared/second/meetingState'
import { getPlaybook } from '../../../shared/second/playbooks'
import type { AIProvider } from '../../services/ai/types'

const turns: Turn[] = Array.from({ length: 30 }, (_, i) => ({
  id: `turn_${i + 1}`,
  speaker: i % 2 ? 'you' : 'them',
  text: `statement number ${i + 1} with some words`,
  at: i,
}))

describe('versioned core prompt', () => {
  it('loads the prompt and its version from /prompts/second_core.md', () => {
    expect(PROMPT_VERSION).toMatch(/^second-core-\d+\.\d+\.\d+$/)
    expect(CORE_SYSTEM_PROMPT).toContain('You are SECOND')
    expect(CORE_SYSTEM_PROMPT).not.toContain('prompt_version')
  })
})

describe('coach prompt', () => {
  it('windows recent turns instead of resending the transcript', () => {
    const w = recentTurnWindow(turns)
    expect(w).toHaveLength(12)
    expect(w[w.length - 1].id).toBe('turn_30')
  })

  it('puts stable context first and volatile state last', () => {
    const prompt = buildCoachUserPrompt({
      profileText: 'name: Alex',
      playbook: getPlaybook('negotiation'),
      brief: null,
      state: { ...createMeetingState('m', 1_000, 'negotiation'), objective: 'Hold price' },
      turns,
      trigger: { kind: 'turn', reason: 'finalized_turn', turnId: 'turn_30' },
      now: 66_000,
      themSpeaking: false,
    })
    expect(prompt.indexOf('<user_profile>')).toBeLessThan(prompt.indexOf('<meeting_state>'))
    expect(prompt.indexOf('<meeting_state>')).toBeLessThan(prompt.indexOf('<recent_turns>'))
    expect(prompt).toContain('mode: Negotiation')
    expect(prompt).not.toContain('turn_1 THEM')
    expect(prompt).toContain('elapsed: 1:05')
  })

  it('times out slow providers', async () => {
    const slow: AIProvider = {
      name: 'anthropic',
      streamResponse: async () => {},
      generateShort: () => new Promise((r) => setTimeout(() => r('{}'), 1000)),
    }
    await expect(
      runCoach(slow, {
        profileText: '', playbook: getPlaybook('general'), brief: null, state: createMeetingState(), turns: [],
        trigger: { kind: 'turn', reason: 'x' }, now: 0, themSpeaking: false,
      }, { cardId: 'c', timeoutMs: 10 }),
    ).rejects.toThrow(/timed out/)
  })
})

describe('HealthMonitor', () => {
  const loud = new Uint8Array(320)
  new DataView(loud.buffer).setInt16(0, 20000, true)
  for (let i = 0; i < 160; i++) new DataView(loud.buffer).setInt16(i * 2, i % 2 ? 3000 : -3000, true)
  const quiet = new Uint8Array(320)

  it('is not ready until both sides show real energy and transcripts', () => {
    const h = new HealthMonitor()
    h.start(0)
    expect(h.view(100, { mic: true, system: true }, true).readiness.level).toBe('not_ready')
    h.recordAudio('mic', quiet, 200)
    h.recordAudio('system', quiet, 200)
    expect(h.view(300, { mic: true, system: true }, true).readiness.level).toBe('not_ready')
    h.recordAudio('mic', loud, 400)
    h.recordAudio('system', loud, 400)
    h.recordTranscript('mic', 450)
    h.recordTranscript('system', 450)
    h.recordCoach(true, 460)
    const v = h.view(500, { mic: true, system: true }, true)
    expect(v.readiness.level).toBe('ready')
    expect(v.levels.mic).toBeGreaterThan(0)
  })

  it('reports transcription down after the reconnect grace period', () => {
    const h = new HealthMonitor()
    h.start(0)
    h.recordAudio('mic', loud, 10)
    h.recordAudio('system', loud, 10)
    expect(h.view(100, { mic: false, system: true }, true).snapshot.sttYou.status).toBe('connecting')
    const later = STT_RECONNECT_GRACE_MS + 50
    h.recordAudio('mic', loud, later)
    h.recordAudio('system', loud, later)
    expect(h.view(later, { mic: false, system: true }, true).readiness.message).toBe('Audio live, transcript unavailable')
  })
})

describe('diagnostics', () => {
  it('drops non-allowlisted keys so content can never leak', () => {
    const log = new DiagnosticsLog()
    log.record('coach_run', { latencyMs: 900, model: 'm', text: 'secret transcript', apiKey: 'sk-123', card: 'Say X' }, 1)
    expect(log.all()[0].data).toEqual({ latencyMs: 900, model: 'm' })
  })

  it('computes latency percentiles', () => {
    const log = new DiagnosticsLog()
    for (const ms of [500, 700, 900, 1100, 3000]) log.record('coach_run', { latencyMs: ms })
    expect(latencyStats(log.all())).toEqual({ count: 5, p50: 900, p95: 3000 })
    expect(percentile([], 50)).toBeNull()
  })
})
