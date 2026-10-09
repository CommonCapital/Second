import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { CARD_MODES } from '../card'
import { PLAYBOOK_IDS } from '../playbooks'
import { createMeetingState } from '../meetingState'

const load = (f: string) => JSON.parse(readFileSync(join(process.cwd(), 'schemas', f), 'utf8'))

describe('published JSON schemas stay in sync with code', () => {
  it('card modes match', () => {
    expect(load('card.json').properties.mode.enum).toEqual([...CARD_MODES, 'NONE'])
  })
  it('meeting modes match the playbooks', () => {
    expect([...load('meeting_state.json').properties.mode.enum].sort()).toEqual([...PLAYBOOK_IDS].sort())
  })
  it('every meeting state field is documented', () => {
    const documented = Object.keys(load('meeting_state.json').properties)
    const actual = Object.keys(createMeetingState()).filter((k) => k !== 'lastTurnAt')
    for (const key of actual) expect(documented, key).toContain(key)
  })
  it('the prompt contract mentions every state_updates key', () => {
    const prompt = readFileSync(join(process.cwd(), 'prompts', 'second_core.md'), 'utf8')
    const keys = Object.keys(load('meeting_state.json').$defs.state_updates.properties)
    for (const k of keys.filter((k) => !['agenda_done', 'agenda_parked', 'last_user_intent'].includes(k))) {
      expect(prompt, k).toContain(`"${k}"`)
    }
  })
})
