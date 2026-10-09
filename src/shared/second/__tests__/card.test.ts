import { describe, expect, it } from 'vitest'
import { extractJsonObject, isCardExpired, parseCoachResponse } from '../card'
import { findVoiceViolations } from '../voicebook'

const opts = { now: 1000, id: 'c1' }

describe('card contract parser', () => {
  it('parses a valid card and its state updates', () => {
    const raw = `Here you go:\n\`\`\`json
{"mode":"ASK","text":"What share of ARR is the top customer?","urgency":"medium","confidence":0.8,
 "grounding":["turn_14"],"expires_after_seconds":20,"replace_policy":"normal",
 "state_updates":{"current_topic":"concentration","numbers":[{"metric":"ARR","value":"5000000","unit":"USD","source":"turn_12"}]}}
\`\`\``
    const r = parseCoachResponse(raw, opts)
    expect(r.rejected).toBeUndefined()
    expect(r.card).toMatchObject({ id: 'c1', mode: 'ASK', confidence: 0.8, expiresAfterSeconds: 20, grounding: ['turn_14'] })
    expect(r.stateUpdates.currentTopic).toBe('concentration')
    expect(r.stateUpdates.numbers?.[0]).toMatchObject({ metric: 'ARR', value: 5_000_000 })
  })

  it('treats NONE as a deliberate no-card with state updates kept', () => {
    const r = parseCoachResponse('{"mode":"NONE","state_updates":{"phase":"closing"}}', opts)
    expect(r.card).toBeNull()
    expect(r.rejected).toBeUndefined()
    expect(r.stateUpdates.phase).toBe('closing')
  })

  it('accepts WAIT with no text', () => {
    const r = parseCoachResponse('{"mode":"WAIT","confidence":0.9}', opts)
    expect(r.card?.mode).toBe('WAIT')
    expect(r.card?.text).toBe('Keep listening.')
  })

  it('rejects unknown modes, empty text, and long cards', () => {
    expect(parseCoachResponse('{"mode":"ADVISE","text":"x"}', opts).rejected).toMatch(/unknown mode/)
    expect(parseCoachResponse('{"mode":"SAY","text":""}', opts).rejected).toMatch(/empty/)
    const long = Array.from({ length: 45 }, () => 'word').join(' ')
    expect(parseCoachResponse(`{"mode":"SAY","text":"${long}"}`, opts).rejected).toMatch(/too long/)
  })

  it('warns (but accepts) slightly long or ungrounded cards', () => {
    const text = Array.from({ length: 25 }, () => 'word').join(' ')
    const r = parseCoachResponse(`{"mode":"SAY","text":"${text}","confidence":0.7}`, opts)
    expect(r.card).not.toBeNull()
    expect(r.warnings.join(' ')).toMatch(/over 22 words/)
    expect(r.warnings.join(' ')).toMatch(/no grounding/)
  })

  it('rejects banned voice', () => {
    const r = parseCoachResponse('{"mode":"SAY","text":"Would love to compare notes sometime.","grounding":["turn_1"]}', opts)
    expect(r.rejected).toMatch(/voice violation/)
  })

  it('handles garbage safely', () => {
    expect(parseCoachResponse('no json here', opts).rejected).toMatch(/no JSON/)
    expect(parseCoachResponse('{"mode": "SAY", ', opts).rejected).toBeDefined()
  })

  it('clamps expiry', () => {
    const r = parseCoachResponse('{"mode":"SAY","text":"Ask for the cap table.","expires_after_seconds":9999}', opts)
    expect(r.card?.expiresAfterSeconds).toBe(120)
    expect(isCardExpired(r.card!, 1000 + 119_000)).toBe(false)
    expect(isCardExpired(r.card!, 1000 + 120_000)).toBe(true)
  })

  it('extracts nested JSON with braces in strings', () => {
    expect(extractJsonObject('x {"a":"{b}","c":{"d":1}} y')).toBe('{"a":"{b}","c":{"d":1}}')
  })
})

describe('voicebook', () => {
  it('flags banned phrases and formulaic reversals', () => {
    expect(findVoiceViolations('This could unlock real value')).toContain('unlock')
    expect(findVoiceViolations("It's not a product, it's a platform")).toContain('formulaic reversal')
    expect(findVoiceViolations('What does churn look like by cohort?')).toEqual([])
  })
})
