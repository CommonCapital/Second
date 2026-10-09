/**
 * Optional Google integration wiring: IPC, connection state, context
 * gathering for the pre-meeting packet, and the "prepare now" reminder.
 *
 * Off unless the user adds their own OAuth client in Settings and connects.
 */

import { ipcMain, Notification, shell } from 'electron'
import { createLogger } from '../../logger'
import { getSetting, isMaskedKey, saveSetting } from '../../store'
import { getDashboardWindow, getOverlayWindow } from '../../windowManager'
import { GoogleAuthError, GoogleClient } from './client'
import { revokeToken, runAuthFlow, type FetchFn } from './oauth'
import {
  externalAttendees,
  grantedServices,
  isMeetingLike,
  organizationFromAttendees,
  scopesFor,
  shouldRemind,
  type CalendarEvent,
  type ContextSource,
  type GoogleService,
} from '../../../shared/second/google'
import type { GoogleStatus, GatherRequest, GatherResult } from '../../../shared/second/views'

const log = createLogger('Google')
const fetchFn = globalThis.fetch as unknown as FetchFn

const POLL_MS = 5 * 60_000
const CHECK_MS = 60_000

const client = new GoogleClient(
  () => ({
    clientId: (getSetting('googleClientId') as string) || '',
    clientSecret: (getSetting('googleClientSecret') as string) || '',
    refreshToken: (getSetting('googleRefreshToken') as string) || '',
  }),
  fetchFn,
)

let upcoming: CalendarEvent[] = []
const reminded = new Set<string>()
let pollTimer: ReturnType<typeof setInterval> | null = null
let checkTimer: ReturnType<typeof setInterval> | null = null
let connecting = false
let initialized = false

function enabled(service: GoogleService): boolean {
  const key = service === 'calendar' ? 'googleCalendarEnabled' : service === 'gmail' ? 'googleGmailEnabled' : 'googleDriveEnabled'
  return getSetting(key) !== false
}

function granted(): GoogleService[] {
  const scopes = getSetting('googleGrantedScopes')
  return grantedServices(Array.isArray(scopes) ? (scopes as string[]) : [])
}

function usable(service: GoogleService): boolean {
  return isConnected() && enabled(service) && granted().includes(service)
}

export function isConnected(): boolean {
  return !!getSetting('googleRefreshToken') && !!getSetting('googleClientId')
}

export function googleStatus(): GoogleStatus {
  const g = granted()
  return {
    clientId: (getSetting('googleClientId') as string) || '',
    hasClientSecret: !!getSetting('googleClientSecret'),
    connected: isConnected(),
    email: (getSetting('googleAccountEmail') as string) || '',
    services: {
      calendar: { enabled: enabled('calendar'), granted: g.includes('calendar') },
      gmail: { enabled: enabled('gmail'), granted: g.includes('gmail') },
      drive: { enabled: enabled('drive'), granted: g.includes('drive') },
    },
    reminders: getSetting('googleMeetingReminders') !== false,
  }
}

function broadcastStatus(): void {
  const status = googleStatus()
  for (const w of [getDashboardWindow(), getOverlayWindow()]) {
    if (w && !w.isDestroyed()) w.webContents.send('google:status-changed', status)
  }
}

function clearConnection(): void {
  saveSetting('googleRefreshToken' as never, '' as never)
  saveSetting('googleAccountEmail' as never, '' as never)
  saveSetting('googleGrantedScopes' as never, [] as never)
  client.reset()
  upcoming = []
}

async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    if (err instanceof GoogleAuthError && /expired|not connected|invalid_grant/i.test(err.message)) {
      log.warn('Google auth no longer valid; disconnecting:', err.message)
      clearConnection()
      broadcastStatus()
    }
    throw err
  }
}

async function refreshUpcoming(): Promise<void> {
  if (!usable('calendar')) {
    upcoming = []
    return
  }
  try {
    upcoming = await guard(() => client.upcomingEvents(2, 30))
  } catch (err) {
    log.warn('Calendar refresh failed:', err instanceof Error ? err.message : err)
  }
}

function showDashboardAndPrepare(event: CalendarEvent): void {
  const dash = getDashboardWindow()
  if (dash && !dash.isDestroyed()) {
    dash.show()
    dash.focus()
    dash.webContents.send('second:prepare-event', event)
  }
}

function checkReminders(): void {
  if (getSetting('googleMeetingReminders') === false || !usable('calendar')) return
  const now = Date.now()
  for (const event of upcoming) {
    if (!shouldRemind(event, now, reminded)) continue
    reminded.add(event.id)
    const mins = Math.max(1, Math.round((event.start - now) / 60_000))
    const title = `Prepare for “${event.title}”`
    const body = `Starts in ${mins} min. Open Second for a 90-second brief.`
    try {
      if (Notification.isSupported()) {
        const n = new Notification({ title, body, silent: false })
        n.on('click', () => showDashboardAndPrepare(event))
        n.show()
      }
    } catch (err) {
      log.warn('Notification failed:', err)
    }
    const overlay = getOverlayWindow()
    if (overlay && !overlay.isDestroyed()) {
      overlay.webContents.send('overlay:notification', { id: `prep-${event.id}`, title, body, type: 'meeting', autoDismissMs: 30_000 })
    }
    const dash = getDashboardWindow()
    if (dash && !dash.isDestroyed()) dash.webContents.send('second:meeting-soon', event)
  }
}

function startPolling(): void {
  stopPolling()
  if (!isConnected()) return
  void refreshUpcoming().then(checkReminders)
  pollTimer = setInterval(() => { void refreshUpcoming() }, POLL_MS)
  checkTimer = setInterval(checkReminders, CHECK_MS)
}

function stopPolling(): void {
  if (pollTimer) clearInterval(pollTimer)
  if (checkTimer) clearInterval(checkTimer)
  pollTimer = null
  checkTimer = null
}

/** Gather the pre-meeting packet for an event (or ad-hoc people/terms). */
export async function gatherContext(req: GatherRequest): Promise<GatherResult> {
  const sources: ContextSource[] = []
  const errors: string[] = []
  let event: CalendarEvent | null = null

  if (req.eventId && usable('calendar')) {
    try {
      event = upcoming.find((e) => e.id === req.eventId) ?? (await guard(() => client.event(req.eventId!)))
    } catch (err) {
      errors.push(`Calendar: ${err instanceof Error ? err.message : 'failed'}`)
    }
  }
  const self = (getSetting('googleAccountEmail') as string) || ''
  const emails = [
    ...(event ? externalAttendees(event).map((a) => a.email) : []),
    ...(req.emails ?? []),
  ]
  const org = event ? organizationFromAttendees(event.attendees, self) : ''
  const terms = [...(req.terms ?? []), org, event?.title ?? ''].filter(Boolean)

  if (event?.description) {
    sources.push({ ref: `packet:calendar:${event.id}`, kind: 'calendar', title: `Invite: ${event.title}`, meta: new Date(event.start).toISOString().slice(0, 16).replace('T', ' '), text: event.description })
  }
  if (usable('gmail') && emails.length) {
    try {
      sources.push(...(await guard(() => client.mailWithPeople(emails, 5))))
    } catch (err) {
      errors.push(`Gmail: ${err instanceof Error ? err.message : 'failed'}`)
    }
  }
  if (usable('drive') && terms.length) {
    try {
      sources.push(...(await guard(() => client.docsMatching(terms, 4))))
    } catch (err) {
      errors.push(`Drive: ${err instanceof Error ? err.message : 'failed'}`)
    }
  }
  return { event, organization: org, sources, errors }
}

export function initGoogle(): void {
  if (initialized) return
  initialized = true

  ipcMain.handle('google:status', () => googleStatus())

  ipcMain.handle('google:save-client', (_e, clientId: unknown, clientSecret: unknown) => {
    if (typeof clientId !== 'string' || clientId.length > 300) return { ok: false, error: 'Invalid client ID' }
    const id = clientId.trim()
    if (id && !/\.apps\.googleusercontent\.com$/.test(id)) return { ok: false, error: 'That does not look like a Google OAuth client ID (it ends in .apps.googleusercontent.com).' }
    const changed = id !== getSetting('googleClientId')
    saveSetting('googleClientId' as never, id as never)
    if (typeof clientSecret === 'string' && clientSecret.length <= 300 && !isMaskedKey(clientSecret)) {
      saveSetting('googleClientSecret' as never, clientSecret.trim() as never)
    }
    if (changed || !id) {
      clearConnection()
      stopPolling()
    }
    broadcastStatus()
    return { ok: true, status: googleStatus() }
  })

  ipcMain.handle('google:connect', async () => {
    if (connecting) return { ok: false, error: 'Already connecting. Finish in your browser.' }
    const clientId = (getSetting('googleClientId') as string) || ''
    const clientSecret = (getSetting('googleClientSecret') as string) || ''
    if (!clientId || !clientSecret) return { ok: false, error: 'Add your Google OAuth client ID and secret first.' }
    const services = (['calendar', 'gmail', 'drive'] as GoogleService[]).filter(enabled)
    if (services.length === 0) return { ok: false, error: 'Turn on at least one of Calendar, Gmail, or Drive.' }
    connecting = true
    try {
      const result = await runAuthFlow({
        clientId,
        clientSecret,
        scopes: scopesFor(services),
        openBrowser: (url) => shell.openExternal(url),
        fetchFn,
      })
      saveSetting('googleRefreshToken' as never, result.refreshToken as never)
      saveSetting('googleAccountEmail' as never, result.email as never)
      saveSetting('googleGrantedScopes' as never, result.scopes as never)
      client.reset()
      startPolling()
      broadcastStatus()
      log.info('Google connected', result.email, grantedServices(result.scopes).join(','))
      const missing = services.filter((s) => !grantedServices(result.scopes).includes(s))
      return { ok: true, status: googleStatus(), warning: missing.length ? `Not granted: ${missing.join(', ')}. Reconnect and tick every box on Google's consent screen.` : undefined }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Google sign-in failed' }
    } finally {
      connecting = false
      const dash = getDashboardWindow()
      if (dash && !dash.isDestroyed()) dash.focus()
    }
  })

  ipcMain.handle('google:disconnect', async () => {
    const token = (getSetting('googleRefreshToken') as string) || ''
    if (token) await revokeToken(fetchFn, token)
    clearConnection()
    stopPolling()
    broadcastStatus()
    return { ok: true, status: googleStatus() }
  })

  ipcMain.handle('google:set-options', (_e, opts: unknown) => {
    const o = opts && typeof opts === 'object' ? (opts as Record<string, unknown>) : {}
    if (typeof o.calendar === 'boolean') saveSetting('googleCalendarEnabled' as never, o.calendar as never)
    if (typeof o.gmail === 'boolean') saveSetting('googleGmailEnabled' as never, o.gmail as never)
    if (typeof o.drive === 'boolean') saveSetting('googleDriveEnabled' as never, o.drive as never)
    if (typeof o.reminders === 'boolean') saveSetting('googleMeetingReminders' as never, o.reminders as never)
    if (isConnected()) startPolling()
    broadcastStatus()
    return googleStatus()
  })

  ipcMain.handle('google:upcoming', async () => {
    if (!usable('calendar')) return { ok: true, events: [] }
    try {
      await refreshUpcoming()
      return { ok: true, events: upcoming.filter(isMeetingLike) }
    } catch (err) {
      return { ok: false, events: [], error: err instanceof Error ? err.message : 'Calendar failed' }
    }
  })

  ipcMain.handle('google:gather', async (_e, raw: unknown) => {
    const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
    const req: GatherRequest = {
      eventId: typeof r.eventId === 'string' ? r.eventId.slice(0, 300) : undefined,
      emails: Array.isArray(r.emails) ? (r.emails as unknown[]).filter((x): x is string => typeof x === 'string').slice(0, 10) : [],
      terms: Array.isArray(r.terms) ? (r.terms as unknown[]).filter((x): x is string => typeof x === 'string').map((t) => t.slice(0, 100)).slice(0, 4) : [],
    }
    if (!isConnected()) return { event: null, organization: '', sources: [], errors: ['Google is not connected.'] }
    return gatherContext(req)
  })

  startPolling()
}

export function shutdownGoogle(): void {
  stopPolling()
}
