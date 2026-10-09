/**
 * Google integration helpers (pure): mapping API responses, building search
 * queries, and assembling the pre-meeting context packet.
 *
 * Integration order follows the product spec: Calendar for the meeting,
 * attendees, and preparation trigger; Gmail for the exact thread and
 * relationship history; Drive for decks, memos, models, and prior notes.
 * Every item keeps provenance (packet:gmail:<id>, packet:drive:<id>) so the
 * coach can ground facts in it and the user can see where they came from.
 */

export type GoogleService = 'calendar' | 'gmail' | 'drive'

export const GOOGLE_SCOPES: Record<GoogleService | 'identity', string[]> = {
  identity: ['openid', 'email'],
  calendar: ['https://www.googleapis.com/auth/calendar.readonly'],
  gmail: ['https://www.googleapis.com/auth/gmail.readonly'],
  drive: ['https://www.googleapis.com/auth/drive.readonly'],
}

export function scopesFor(services: GoogleService[]): string[] {
  const set = new Set(GOOGLE_SCOPES.identity)
  for (const s of services) for (const scope of GOOGLE_SCOPES[s]) set.add(scope)
  return [...set]
}

export function grantedServices(scopes: string[]): GoogleService[] {
  return (['calendar', 'gmail', 'drive'] as GoogleService[]).filter((s) =>
    GOOGLE_SCOPES[s].every((scope) => scopes.includes(scope)),
  )
}

export interface Attendee {
  email: string
  name: string
  self: boolean
  organizer: boolean
}

export interface CalendarEvent {
  id: string
  title: string
  start: number
  end: number
  allDay: boolean
  attendees: Attendee[]
  description: string
  location: string
  meetingLink: string
}

type Json = Record<string, unknown>
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {})
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

function parseTime(t: Json): { ms: number; allDay: boolean } {
  if (str(t.dateTime)) return { ms: Date.parse(str(t.dateTime)), allDay: false }
  if (str(t.date)) return { ms: Date.parse(`${str(t.date)}T00:00:00`), allDay: true }
  return { ms: NaN, allDay: false }
}

const MEETING_LINK_RE = /https:\/\/(?:[\w-]+\.)?(?:zoom\.us\/j\/[^\s"<>]+|meet\.google\.com\/[a-z0-9-]+|teams\.microsoft\.com\/l\/meetup-join\/[^\s"<>]+|[\w-]+\.webex\.com\/[^\s"<>]+)/i

/** Strip HTML tags/entities from Calendar descriptions. */
export function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function mapCalendarEvent(raw: unknown): CalendarEvent | null {
  const e = obj(raw)
  if (str(e.status) === 'cancelled') return null
  const start = parseTime(obj(e.start))
  const end = parseTime(obj(e.end))
  if (!Number.isFinite(start.ms)) return null
  const attendees: Attendee[] = (Array.isArray(e.attendees) ? e.attendees : [])
    .map(obj)
    .filter((a) => str(a.email) && !a.resource && str(a.responseStatus) !== 'declined')
    .map((a) => ({
      email: str(a.email).toLowerCase(),
      name: str(a.displayName) || nameFromEmail(str(a.email)),
      self: a.self === true,
      organizer: a.organizer === true,
    }))
  const description = htmlToText(str(e.description))
  const entryPoints = Array.isArray(obj(e.conferenceData).entryPoints) ? (obj(e.conferenceData).entryPoints as unknown[]) : []
  const video = entryPoints.map(obj).find((p) => str(p.entryPointType) === 'video')
  const meetingLink =
    str(e.hangoutLink) ||
    str(video?.uri) ||
    (str(e.location).match(MEETING_LINK_RE)?.[0] ?? '') ||
    (description.match(MEETING_LINK_RE)?.[0] ?? '')
  return {
    id: str(e.id),
    title: str(e.summary) || '(No title)',
    start: start.ms,
    end: Number.isFinite(end.ms) ? end.ms : start.ms,
    allDay: start.allDay,
    attendees,
    description: description.slice(0, 4000),
    location: str(e.location),
    meetingLink,
  }
}

/** "dana.lee@acme.com" -> "Dana Lee" */
export function nameFromEmail(email: string): string {
  const local = email.split('@')[0] ?? ''
  return local
    .split(/[._-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ')
}

const FREE_MAIL = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'yahoo.com', 'icloud.com',
  'me.com', 'mac.com', 'aol.com', 'proton.me', 'protonmail.com', 'gmx.com', 'yandex.com', 'mail.ru',
])

/** Most common external, non-free-mail domain among attendees -> "Acme". */
export function organizationFromAttendees(attendees: Attendee[], selfEmail: string): string {
  const selfDomain = selfEmail.split('@')[1]?.toLowerCase() ?? ''
  const counts = new Map<string, number>()
  for (const a of attendees) {
    if (a.self) continue
    const domain = a.email.split('@')[1]?.toLowerCase() ?? ''
    if (!domain || domain === selfDomain || FREE_MAIL.has(domain) || domain.endsWith('calendar.google.com')) continue
    counts.set(domain, (counts.get(domain) ?? 0) + 1)
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
  if (!top) return ''
  const label = top.split('.').slice(-2, -1)[0] ?? top
  return label.charAt(0).toUpperCase() + label.slice(1)
}

export function externalAttendees(event: CalendarEvent): Attendee[] {
  return event.attendees.filter((a) => !a.self)
}

/** A calendar entry that looks like a real meeting (not a focus block). */
export function isMeetingLike(event: CalendarEvent): boolean {
  if (event.allDay) return false
  return externalAttendees(event).length > 0 || !!event.meetingLink
}

/** Gmail search across the people in the meeting, recent first. */
export function gmailQueryForPeople(emails: string[], newerThanDays = 180): string {
  const clean = [...new Set(emails.map((e) => e.trim().toLowerCase()).filter((e) => /^[^\s@]+@[^\s@]+$/.test(e)))].slice(0, 10)
  if (clean.length === 0) return ''
  const terms = clean.map((e) => `from:${e} OR to:${e}`).join(' OR ')
  return `(${terms}) newer_than:${newerThanDays}d -in:chats`
}

/** Drive query matching any term in name or full text, excluding trash. */
export function driveQueryForTerms(terms: string[]): string {
  const clean = [...new Set(terms.map((t) => t.trim()).filter((t) => t.length >= 3))].slice(0, 4)
  if (clean.length === 0) return ''
  const esc = (t: string) => t.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
  const parts = clean.map((t) => `name contains '${esc(t)}' or fullText contains '${esc(t)}'`)
  return `(${parts.join(' or ')}) and trashed = false`
}

function base64UrlDecode(data: string): string {
  const b64 = data.replace(/-/g, '+').replace(/_/g, '/')
  try {
    const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4))
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0))
    return new TextDecoder('utf-8').decode(bytes)
  } catch {
    return ''
  }
}

/** Drop quoted history ("On ... wrote:" and ">" lines) and signatures. */
export function stripQuotedReply(text: string): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const out: string[] = []
  for (const line of lines) {
    if (/^On .{5,200} wrote:\s*$/.test(line.trim())) break
    if (/^-{2,}\s*Original Message\s*-{2,}/i.test(line.trim())) break
    if (/^From: .+/.test(line.trim()) && out.length > 3) break
    if (line.trim() === '--') break
    if (line.trim().startsWith('>')) continue
    out.push(line)
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

/** Extract readable text from a Gmail message payload (format=full). */
export function gmailBodyText(payload: unknown): string {
  const plain: string[] = []
  const html: string[] = []
  const walk = (part: Json) => {
    const mime = str(part.mimeType)
    const data = str(obj(part.body).data)
    if (data && mime === 'text/plain') plain.push(base64UrlDecode(data))
    else if (data && mime === 'text/html') html.push(base64UrlDecode(data))
    for (const child of Array.isArray(part.parts) ? part.parts : []) walk(obj(child))
  }
  walk(obj(payload))
  const text = plain.length ? plain.join('\n') : htmlToText(html.join('\n'))
  return stripQuotedReply(text)
}

export function gmailHeader(payload: unknown, name: string): string {
  const headers = Array.isArray(obj(payload).headers) ? (obj(payload).headers as unknown[]) : []
  const h = headers.map(obj).find((x) => str(x.name).toLowerCase() === name.toLowerCase())
  return str(h?.value)
}

export type ContextKind = 'calendar' | 'gmail' | 'drive'

export interface ContextSource {
  /** Provenance id the coach can cite, e.g. packet:gmail:18c2f... */
  ref: string
  kind: ContextKind
  title: string
  /** e.g. sender + date, or file type + modified date */
  meta: string
  url?: string
  text: string
}

export const PACKET_CHAR_BUDGET = 16_000
const PER_SOURCE_CHARS = 3_000

/** Supplied-context block for the meeting setup, each item tagged with its source. */
export function formatPacket(sources: ContextSource[], budget = PACKET_CHAR_BUDGET): string {
  const blocks: string[] = []
  let used = 0
  for (const s of sources) {
    const body = s.text.trim().slice(0, PER_SOURCE_CHARS)
    const block = `[${s.ref}] ${s.title}${s.meta ? ` (${s.meta})` : ''}\n${body}`
    if (used + block.length > budget) break
    blocks.push(block)
    used += block.length + 2
  }
  return blocks.join('\n\n')
}

export const REMINDER_LEAD_MS = 10 * 60_000

/** Should we nudge the user to prepare for this event now? */
export function shouldRemind(event: CalendarEvent, now: number, alreadyReminded: ReadonlySet<string>, leadMs = REMINDER_LEAD_MS): boolean {
  if (alreadyReminded.has(event.id) || !isMeetingLike(event)) return false
  const until = event.start - now
  return until > 0 && until <= leadMs
}
