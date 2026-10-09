import { describe, expect, it } from 'vitest'
import { AUDIO_DEAD_MS, AUDIO_SILENT_MS, audioChannelStatus, deriveReadiness, emptyHealth, pcmRms, type HealthSnapshot } from '../health'
import { emptyProfile, formatProfileForPrompt, isDynamicStale, normalizeProfile, selectRelevantDynamic } from '../profile'
import { getPlaybook, PLAYBOOK_IDS } from '../playbooks'
import { parseMeetingBrief, parsePostMeetingReport, reportToMarkdown } from '../briefing'

const live = { status: 'live' as const }

function health(over: Partial<HealthSnapshot>): HealthSnapshot {
  return { ...emptyHealth(), mic: live, system: live, sttYou: live, sttThem: live, coach: live, ...over }
}

describe('preflight truth table', () => {
  it('is idle when nothing is running', () => {
    expect(deriveReadiness(emptyHealth()).level).toBe('idle')
  })
  it('is ready only when both audio sides and transcription are proven live', () => {
    expect(deriveReadiness(health({})).level).toBe('ready')
  })
  it('never shows ready on a connected provider with unverified audio', () => {
    const r = deriveReadiness(health({ mic: { status: 'unverified' }, system: { status: 'unverified' } }))
    expect(r.level).toBe('not_ready')
  })
  it('names which side is missing', () => {
    expect(deriveReadiness(health({ system: { status: 'silent' } })).message).toBe('I can hear you, not the meeting')
    expect(deriveReadiness(health({ mic: { status: 'down' } })).message).toBe('I can hear the meeting, not you')
  })
  it('reports transcript loss while audio is live', () => {
    expect(deriveReadiness(health({ sttThem: { status: 'down' } })).message).toBe('Audio live, transcript unavailable')
  })
  it('reports offline and coach failures', () => {
    expect(deriveReadiness(health({ network: { status: 'down' } })).level).toBe('offline')
    expect(deriveReadiness(health({ coach: { status: 'down' } })).message).toMatch(/Coach unavailable/)
  })
})

describe('audio channel status', () => {
  const base = { active: true, now: 100_000, startedAt: 90_000, lastChunkAt: 99_900, lastEnergyAt: 99_000 }
  it('is live with recent energy', () => expect(audioChannelStatus(base).status).toBe('live'))
  it('is unverified before any energy', () => expect(audioChannelStatus({ ...base, lastEnergyAt: 0 }).status).toBe('unverified'))
  it('is down when chunks stop', () => expect(audioChannelStatus({ ...base, lastChunkAt: 100_000 - AUDIO_DEAD_MS - 1 }).status).toBe('down'))
  it('is silent after a long quiet stretch', () => expect(audioChannelStatus({ ...base, lastEnergyAt: 100_000 - AUDIO_SILENT_MS - 1 }).status).toBe('silent'))
  it('computes PCM RMS', () => {
    const buf = new Uint8Array(4)
    new DataView(buf.buffer).setInt16(0, 1000, true)
    new DataView(buf.buffer).setInt16(2, -1000, true)
    expect(pcmRms(buf)).toBe(1000)
  })
})

describe('profile and dynamic context', () => {
  const now = Date.parse('2026-10-09')
  const profile = normalizeProfile({
    name: 'Alex',
    role: 'Partner',
    neverSay: ['circle back', 42],
    dynamic: [
      { topic: 'Acme', content: 'Evaluating Series B; ARR ~5M', asOf: '2026-10-01' },
      { topic: 'Globex rollout', content: 'Pilot ends in Q4', asOf: '2026-01-01' },
    ],
  })

  it('normalizes untrusted input', () => {
    expect(profile.neverSay).toEqual(['circle back'])
    expect(profile.dynamic).toHaveLength(2)
    expect(normalizeProfile(null)).toEqual(emptyProfile())
  })
  it('retrieves dynamic context only when the meeting relates to it', () => {
    expect(selectRelevantDynamic(profile.dynamic, 'Intro call with Acme founders', now).map((d) => d.topic)).toEqual(['Acme'])
    expect(selectRelevantDynamic(profile.dynamic, 'Interview at Initech', now)).toEqual([])
  })
  it('marks stale context', () => {
    expect(isDynamicStale(profile.dynamic[1], now)).toBe(true)
    const text = formatProfileForPrompt(profile, selectRelevantDynamic(profile.dynamic, 'globex rollout review', now))
    expect(text).toContain('STALE')
  })
})

describe('playbooks', () => {
  it('falls back to general for unknown modes', () => {
    expect(getPlaybook('nope').id).toBe('general')
    expect(PLAYBOOK_IDS).toContain('founder')
  })
})

describe('brief and report parsing', () => {
  it('parses a brief and caps list sizes', () => {
    const b = parseMeetingBrief(JSON.stringify({
      who_they_are: 'Seed-stage founder', what_matters: 'Retention',
      facts_to_remember: ['a', 'b', 'c', 'd'], questions_to_land: ['q1'],
      hard_questions: [{ question: 'Why you?', answer_shape: 'One proof point' }], close_target: 'Get data room',
    }), 1)
    expect(b?.factsToRemember).toHaveLength(3)
    expect(b?.hardQuestions[0].answerShape).toBe('One proof point')
  })
  it('rejects empty briefs', () => {
    expect(parseMeetingBrief('{}', 1)).toBeNull()
  })
  it('parses a report and renders markdown', () => {
    const r = parsePostMeetingReport(JSON.stringify({
      outcome: 'Agreed to a second meeting', decisions: ['Proceed to diligence'],
      commitments: [{ who: 'Dana', action: 'Send P&L', due: 'Friday' }, { who: '', action: 'x' }],
      next_step: 'Review P&L Monday', follow_up_draft: 'Thanks Dana...',
      context_updates: [{ topic: 'Acme', content: 'ARR 5.1M as of Oct' }],
    }), 1)
    expect(r?.commitments).toHaveLength(1)
    const md = reportToMarkdown(r!)
    expect(md).toContain('## Outcome')
    expect(md).toContain('Dana: Send P&L (by Friday)')
  })
})
