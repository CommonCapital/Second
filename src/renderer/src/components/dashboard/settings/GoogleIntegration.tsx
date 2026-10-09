/**
 * Optional Google integration (Calendar, Gmail, Drive). Nothing connects
 * until the user adds their own OAuth client and clicks Connect.
 */

import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import type { GoogleStatus } from '../../../../../shared/second/views'
import { REPO_URL } from '../../../../../shared/project'

const SETUP_URL = `${REPO_URL}/blob/main/docs/GOOGLE_SETUP.md`
const SECRET_MASK = '••••••••'

type Svc = 'calendar' | 'gmail' | 'drive'
const SERVICES: Array<{ id: Svc; label: string; help: string }> = [
  { id: 'calendar', label: 'Calendar', help: 'Upcoming meetings, attendees, and a reminder to prepare' },
  { id: 'gmail', label: 'Gmail', help: 'Recent threads with the people you are meeting' },
  { id: 'drive', label: 'Drive', help: 'Decks, memos, and notes that match the meeting' },
]

function Check({ checked, disabled, onChange }: { checked: boolean; disabled?: boolean; onChange: (v: boolean) => void }) {
  return (
    <input
      type="checkbox"
      className="w-4 h-4 accent-[#141B2D]"
      checked={checked}
      disabled={disabled}
      onChange={(e) => onChange(e.target.checked)}
    />
  )
}

export function GoogleIntegration() {
  const [status, setStatus] = useState<GoogleStatus | null>(null)
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [busy, setBusy] = useState<'save' | 'connect' | 'disconnect' | null>(null)
  const [message, setMessage] = useState<{ kind: 'ok' | 'error' | 'warn'; text: string } | null>(null)

  const apply = (s: GoogleStatus) => {
    setStatus(s)
    setClientId(s.clientId)
    setClientSecret(s.hasClientSecret ? SECRET_MASK : '')
  }

  useEffect(() => {
    void window.second.google.status().then(apply).catch(() => {})
    return window.second.google.onStatus(apply)
  }, [])

  if (!status) return null

  const credsChanged = clientId.trim() !== status.clientId || (clientSecret !== SECRET_MASK && clientSecret !== '')
  const hasCreds = !!status.clientId && status.hasClientSecret

  const save = async () => {
    setBusy('save')
    setMessage(null)
    const res = await window.second.google.saveClient(clientId.trim(), clientSecret === SECRET_MASK ? SECRET_MASK : clientSecret.trim())
    setBusy(null)
    if (!res.ok) setMessage({ kind: 'error', text: res.error ?? 'Could not save' })
    else if (res.status) {
      apply(res.status)
      setMessage({ kind: 'ok', text: 'Saved. Now click Connect.' })
    }
  }

  const connect = async () => {
    setBusy('connect')
    setMessage({ kind: 'ok', text: 'Finish signing in in your browser…' })
    const res = await window.second.google.connect()
    setBusy(null)
    if (!res.ok) setMessage({ kind: 'error', text: res.error ?? 'Google sign-in failed' })
    else {
      if (res.status) apply(res.status)
      setMessage(res.warning ? { kind: 'warn', text: res.warning } : { kind: 'ok', text: 'Connected.' })
    }
  }

  const disconnect = async () => {
    setBusy('disconnect')
    const res = await window.second.google.disconnect()
    setBusy(null)
    apply(res.status)
    setMessage({ kind: 'ok', text: 'Disconnected. Second no longer has access to your Google account.' })
  }

  const setOption = async (opts: Partial<Record<Svc | 'reminders', boolean>>) => {
    apply(await window.second.google.setOptions(opts))
  }

  const input = 'w-full rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-[#B08A4A]/40'

  return (
    <div className="rounded-xl border border-gray-200 p-4 space-y-3">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-sm font-medium text-gray-900">Google: Calendar, Gmail, Drive <span className="ml-1 text-[11px] font-normal text-gray-400">optional</span></div>
          <div className="text-xs text-gray-500 mt-0.5">
            Builds your pre-meeting packet from the invite, recent email with the attendees, and matching docs. Read-only.
            Uses your own Google OAuth client.{' '}
            <button onClick={() => { void window.second.openExternal(SETUP_URL) }} className="text-[#8A6A33] hover:underline">5-minute setup guide</button>
          </div>
        </div>
        {status.connected && <span className="shrink-0 text-[11px] px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200">Connected</span>}
      </div>

      {!status.connected && (
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">OAuth client ID</label>
            <input className={input} value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="…apps.googleusercontent.com" spellCheck={false} />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Client secret</label>
            <input
              className={input}
              type="password"
              value={clientSecret}
              onFocus={() => { if (clientSecret === SECRET_MASK) setClientSecret('') }}
              onChange={(e) => setClientSecret(e.target.value)}
              placeholder="GOCSPX-…"
              spellCheck={false}
            />
          </div>
        </div>
      )}

      {status.connected && (
        <p className="text-sm text-gray-700">Signed in as <span className="font-medium">{status.email || 'your Google account'}</span></p>
      )}

      <div className="space-y-1.5">
        {SERVICES.map((s) => {
          const st = status.services[s.id]
          return (
            <label key={s.id} className="flex items-center gap-2.5 text-sm text-gray-800">
              <Check checked={st.enabled} onChange={(v) => { void setOption({ [s.id]: v }) }} />
              <span className="w-16">{s.label}</span>
              <span className="text-xs text-gray-500 flex-1">{s.help}</span>
              {status.connected && st.enabled && !st.granted && <span className="text-[11px] text-amber-600">not granted, reconnect</span>}
            </label>
          )
        })}
        <label className="flex items-center gap-2.5 text-sm text-gray-800 pt-1">
          <Check checked={status.reminders} disabled={!status.services.calendar.enabled} onChange={(v) => { void setOption({ reminders: v }) }} />
          <span>Remind me to prepare 10 minutes before calendar meetings</span>
        </label>
      </div>

      <div className="flex items-center gap-2 pt-1">
        {!status.connected ? (
          <>
            <button
              onClick={() => { void save() }}
              disabled={!credsChanged || busy !== null}
              className="px-3 py-1.5 rounded-lg text-sm border border-gray-200 hover:bg-gray-50 disabled:opacity-40"
            >
              {busy === 'save' ? <Loader2 size={13} className="animate-spin inline" /> : 'Save'}
            </button>
            <button
              onClick={() => { void connect() }}
              disabled={!hasCreds || credsChanged || busy !== null}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm text-white bg-[#141B2D] hover:bg-[#222b42] disabled:opacity-40"
            >
              {busy === 'connect' && <Loader2 size={13} className="animate-spin" />} Connect Google
            </button>
          </>
        ) : (
          <>
            <button onClick={() => { void connect() }} disabled={busy !== null} className="px-3 py-1.5 rounded-lg text-sm border border-gray-200 hover:bg-gray-50 disabled:opacity-40">
              Reconnect
            </button>
            <button onClick={() => { void disconnect() }} disabled={busy !== null} className="px-3 py-1.5 rounded-lg text-sm border border-gray-200 text-rose-600 hover:bg-rose-50 disabled:opacity-40">
              {busy === 'disconnect' ? <Loader2 size={13} className="animate-spin inline" /> : 'Disconnect'}
            </button>
          </>
        )}
        {message && (
          <span className={`text-xs ml-1 ${message.kind === 'error' ? 'text-rose-600' : message.kind === 'warn' ? 'text-amber-600' : 'text-gray-500'}`}>{message.text}</span>
        )}
      </div>
    </div>
  )
}
