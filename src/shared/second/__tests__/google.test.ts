import { describe, expect, it } from 'vitest'
import {
  driveQueryForTerms,
  formatPacket,
  gmailBodyText,
  gmailHeader,
  gmailQueryForPeople,
  grantedServices,
  htmlToText,
  isMeetingLike,
  mapCalendarEvent,
  nameFromEmail,
  organizationFromAttendees,
  scopesFor,
  shouldRemind,
  stripQuotedReply,
} from '../google'

const b64url = (s: string) => Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

const rawEvent = {
  id: 'evt1',
  summary: 'Intro: Acme x Example Capital',
  start: { dateTime: '2026-10-12T15:00:00Z' },
  end: { dateTime: '2026-10-12T15:45:00Z' },
  description: '<p>Agenda:<br>1. Product demo</p><p>Join: https://meet.google.com/abc-defg-hij</p>',
  attendees: [
    { email: 'me@example.com', self: true, responseStatus: 'accepted' },
    { email: 'dana.lee@acme.com', displayName: 'Dana Lee', organizer: true },
    { email: 'sam@acme.com' },
    { email: 'room-1@resource.calendar.google.com', resource: true },
    { email: 'declined@acme.com', responseStatus: 'declined' },
  ],
}

describe('calendar mapping', () => {
  it('maps attendees, meeting link, and cleans the description', () => {
    const e = mapCalendarEvent(rawEvent)!
    expect(e.title).toBe('Intro: Acme x Example Capital')
    expect(e.attendees.map((a) => a.email)).toEqual(['me@example.com', 'dana.lee@acme.com', 'sam@acme.com'])
    expect(e.attendees[2].name).toBe('Sam')
    expect(e.meetingLink).toBe('https://meet.google.com/abc-defg-hij')
    expect(e.description).toContain('1. Product demo')
    expect(e.description).not.toContain('<p>')
    expect(isMeetingLike(e)).toBe(true)
  })

  it('skips cancelled events and treats all-day blocks as non-meetings', () => {
    expect(mapCalendarEvent({ ...rawEvent, status: 'cancelled' })).toBeNull()
    const allDay = mapCalendarEvent({ id: 'x', summary: 'OOO', start: { date: '2026-10-12' }, end: { date: '2026-10-13' } })!
    expect(isMeetingLike(allDay)).toBe(false)
  })

  it('infers the counterparty organization, ignoring self and free mail', () => {
    const e = mapCalendarEvent({ ...rawEvent, attendees: [...rawEvent.attendees, { email: 'friend@gmail.com' }] })!
    expect(organizationFromAttendees(e.attendees, 'me@example.com')).toBe('Acme')
    expect(nameFromEmail('dana.lee@acme.com')).toBe('Dana Lee')
  })

  it('reminds once, only inside the lead window, only for meetings', () => {
    const e = mapCalendarEvent(rawEvent)!
    const start = e.start
    expect(shouldRemind(e, start - 9 * 60_000, new Set())).toBe(true)
    expect(shouldRemind(e, start - 20 * 60_000, new Set())).toBe(false)
    expect(shouldRemind(e, start + 1000, new Set())).toBe(false)
    expect(shouldRemind(e, start - 5 * 60_000, new Set(['evt1']))).toBe(false)
  })
})

describe('gmail helpers', () => {
  it('builds a people query', () => {
    expect(gmailQueryForPeople(['Dana.Lee@acme.com', 'bad', 'dana.lee@acme.com'])).toBe('(from:dana.lee@acme.com OR to:dana.lee@acme.com) newer_than:180d -in:chats')
    expect(gmailQueryForPeople([])).toBe('')
  })

  it('extracts the plain-text body and strips quoted history', () => {
    const payload = {
      headers: [{ name: 'Subject', value: 'Re: data room' }],
      mimeType: 'multipart/alternative',
      parts: [
        { mimeType: 'text/plain', body: { data: b64url('Happy to share the cap table — naïve question first.\n\nOn Mon, Oct 5, 2026 at 9:00 AM Alex <me@example.com> wrote:\n> earlier text') } },
        { mimeType: 'text/html', body: { data: b64url('<p>html version</p>') } },
      ],
    }
    expect(gmailHeader(payload, 'subject')).toBe('Re: data room')
    const body = gmailBodyText(payload)
    expect(body).toBe('Happy to share the cap table — naïve question first.')
  })

  it('falls back to HTML when there is no plain part', () => {
    expect(gmailBodyText({ mimeType: 'text/html', body: { data: b64url('<div>Hi&nbsp;there</div>') } })).toBe('Hi there')
  })

  it('stops at forwarded / signature markers', () => {
    expect(stripQuotedReply('Thanks!\n--\nDana\nCEO')).toBe('Thanks!')
  })
})

describe('drive + packet', () => {
  it('escapes Drive query terms and drops tiny ones', () => {
    expect(driveQueryForTerms(["O'Neil Co", 'ab'])).toBe("(name contains 'O\\'Neil Co' or fullText contains 'O\\'Neil Co') and trashed = false")
  })

  it('formats a provenance-tagged packet within budget', () => {
    const text = formatPacket([
      { ref: 'packet:gmail:t1', kind: 'gmail', title: 'Re: data room', meta: 'Dana, 2026-10-05', text: 'Cap table attached.' },
      { ref: 'packet:drive:f1', kind: 'drive', title: 'Acme deck', meta: 'presentation', text: 'x'.repeat(5000) },
    ], 3500)
    expect(text).toContain('[packet:gmail:t1] Re: data room (Dana, 2026-10-05)\nCap table attached.')
    expect(text).toContain('[packet:drive:f1] Acme deck')
    expect(text.length).toBeLessThan(3500)
  })

  it('maps scopes to services', () => {
    const scopes = scopesFor(['calendar', 'drive'])
    expect(scopes).toContain('openid')
    expect(grantedServices(scopes)).toEqual(['calendar', 'drive'])
    expect(htmlToText('a &amp; b')).toBe('a & b')
  })
})
