/**
 * Read-only Google API client: Calendar events, Gmail threads, Drive docs.
 * Access tokens are refreshed from the stored refresh token on demand.
 */

import {
  driveQueryForTerms,
  gmailBodyText,
  gmailHeader,
  gmailQueryForPeople,
  mapCalendarEvent,
  type CalendarEvent,
  type ContextSource,
} from '../../../shared/second/google'
import { refreshAccessToken, type FetchFn } from './oauth'

const CAL = 'https://www.googleapis.com/calendar/v3'
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me'
const DRIVE = 'https://www.googleapis.com/drive/v3'

export class GoogleAuthError extends Error {}

export interface GoogleCredentials {
  clientId: string
  clientSecret: string
  refreshToken: string
}

/** Google-native types we can export as text, and the export MIME to use. */
const EXPORTABLE: Record<string, string> = {
  'application/vnd.google-apps.document': 'text/plain',
  'application/vnd.google-apps.presentation': 'text/plain',
  'application/vnd.google-apps.spreadsheet': 'text/csv',
}
const DOWNLOADABLE_TEXT = new Set(['text/plain', 'text/markdown', 'text/csv'])
const MAX_DOC_CHARS = 6_000

export class GoogleClient {
  private accessToken = ''
  private expiresAt = 0

  constructor(private readonly creds: () => GoogleCredentials, private readonly fetchFn: FetchFn, private readonly now: () => number = Date.now) {}

  private async token(force = false): Promise<string> {
    if (!force && this.accessToken && this.now() < this.expiresAt - 60_000) return this.accessToken
    const c = this.creds()
    if (!c.clientId || !c.clientSecret || !c.refreshToken) throw new GoogleAuthError('Google is not connected.')
    try {
      const t = await refreshAccessToken(this.fetchFn, c, this.now())
      this.accessToken = t.accessToken
      this.expiresAt = t.expiresAt
      return t.accessToken
    } catch (err) {
      throw new GoogleAuthError(err instanceof Error ? err.message : 'Google token refresh failed')
    }
  }

  reset(): void {
    this.accessToken = ''
    this.expiresAt = 0
  }

  private async get(url: string, asText = false): Promise<unknown> {
    let res = await this.fetchFn(url, { headers: { Authorization: `Bearer ${await this.token()}` } })
    if (res.status === 401) {
      res = await this.fetchFn(url, { headers: { Authorization: `Bearer ${await this.token(true)}` } })
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      if (res.status === 401) throw new GoogleAuthError('Google access expired. Reconnect in Settings → Second.')
      if (res.status === 403 && /insufficient|scope/i.test(body)) throw new GoogleAuthError('Second does not have permission for this Google service. Reconnect and allow it.')
      throw new Error(`Google API ${res.status}`)
    }
    return asText ? res.text() : res.json()
  }

  async upcomingEvents(days = 7, max = 25): Promise<CalendarEvent[]> {
    const now = this.now()
    const u = new URL(`${CAL}/calendars/primary/events`)
    u.searchParams.set('timeMin', new Date(now - 30 * 60_000).toISOString())
    u.searchParams.set('timeMax', new Date(now + days * 86_400_000).toISOString())
    u.searchParams.set('singleEvents', 'true')
    u.searchParams.set('orderBy', 'startTime')
    u.searchParams.set('maxResults', String(max))
    const data = (await this.get(u.toString())) as { items?: unknown[] }
    return (data.items ?? []).map(mapCalendarEvent).filter((e): e is CalendarEvent => !!e && e.end > now)
  }

  async event(id: string): Promise<CalendarEvent | null> {
    const data = await this.get(`${CAL}/calendars/primary/events/${encodeURIComponent(id)}`)
    return mapCalendarEvent(data)
  }

  /** Recent email with the meeting's people: subject, sender, date, cleaned body. */
  async mailWithPeople(emails: string[], max = 5): Promise<ContextSource[]> {
    const q = gmailQueryForPeople(emails)
    if (!q) return []
    const list = (await this.get(`${GMAIL}/messages?maxResults=${max}&q=${encodeURIComponent(q)}`)) as { messages?: Array<{ id: string; threadId: string }> }
    const seenThreads = new Set<string>()
    const out: ContextSource[] = []
    for (const m of list.messages ?? []) {
      if (seenThreads.has(m.threadId)) continue
      seenThreads.add(m.threadId)
      const msg = (await this.get(`${GMAIL}/messages/${encodeURIComponent(m.id)}?format=full`)) as { payload?: unknown; snippet?: string; internalDate?: string }
      const subject = gmailHeader(msg.payload, 'Subject') || '(no subject)'
      const from = gmailHeader(msg.payload, 'From')
      const date = msg.internalDate ? new Date(Number(msg.internalDate)).toISOString().slice(0, 10) : ''
      const text = gmailBodyText(msg.payload) || msg.snippet || ''
      out.push({
        ref: `packet:gmail:${m.threadId}`,
        kind: 'gmail',
        title: subject,
        meta: [from, date].filter(Boolean).join(', '),
        url: `https://mail.google.com/mail/u/0/#all/${m.threadId}`,
        text,
      })
    }
    return out
  }

  /** Drive docs matching the meeting (company, title); exported as text where possible. */
  async docsMatching(terms: string[], max = 4): Promise<ContextSource[]> {
    const q = driveQueryForTerms(terms)
    if (!q) return []
    const u = new URL(`${DRIVE}/files`)
    u.searchParams.set('q', q)
    u.searchParams.set('pageSize', String(max))
    u.searchParams.set('orderBy', 'modifiedTime desc')
    u.searchParams.set('fields', 'files(id,name,mimeType,modifiedTime,webViewLink)')
    const data = (await this.get(u.toString())) as { files?: Array<{ id: string; name: string; mimeType: string; modifiedTime?: string; webViewLink?: string }> }
    const out: ContextSource[] = []
    for (const f of data.files ?? []) {
      let text = ''
      try {
        if (EXPORTABLE[f.mimeType]) {
          text = String(await this.get(`${DRIVE}/files/${encodeURIComponent(f.id)}/export?mimeType=${encodeURIComponent(EXPORTABLE[f.mimeType])}`, true))
        } else if (DOWNLOADABLE_TEXT.has(f.mimeType)) {
          text = String(await this.get(`${DRIVE}/files/${encodeURIComponent(f.id)}?alt=media`, true))
        }
      } catch {
        text = ''
      }
      out.push({
        ref: `packet:drive:${f.id}`,
        kind: 'drive',
        title: f.name,
        meta: [f.mimeType.split('.').pop()?.replace('vnd.google-apps.', ''), f.modifiedTime?.slice(0, 10)].filter(Boolean).join(', '),
        url: f.webViewLink,
        text: text ? text.slice(0, MAX_DOC_CHARS) : '(content not available as text; open the link)',
      })
    }
    return out
  }
}
