/**
 * Pre-meeting packet: pick the room, say who and why, optionally paste
 * context, and get a 90-second brief. The setup and brief feed the live
 * coach for the next recording.
 */

import { useEffect, useState } from 'react'
import { X, Sparkles, Loader2, Calendar, Mail, FileText, ExternalLink } from 'lucide-react'
import type { MeetingBrief, MeetingSetupInput } from '../../../../shared/second/briefing'
import type { MeetingModeId } from '../../../../shared/second/playbooks'
import type { GoogleStatus, PlaybookSummary } from '../../../../shared/second/views'
import {
  externalAttendees,
  formatPacket,
  organizationFromAttendees,
  type CalendarEvent,
  type ContextSource,
} from '../../../../shared/second/google'

interface Props {
  isOpen: boolean
  onClose: () => void
  onStart: () => void
  /** Calendar event to prepare for (e.g. from the "starting soon" reminder). */
  initialEvent?: CalendarEvent | null
}

type PacketItem = ContextSource & { included: boolean }

interface EventContext {
  title: string
  people: string
  organization: string
  sources: PacketItem[]
  errors: string[]
}

/** Pull invite, email with the attendees, and matching docs for one event. */
async function loadEventContext(event: CalendarEvent, selfEmail: string): Promise<EventContext> {
  const attendees = externalAttendees(event)
  const org = organizationFromAttendees(event.attendees, selfEmail)
  const res = await window.second.google.gather({ eventId: event.id, emails: attendees.map((a) => a.email), terms: [org, event.title].filter(Boolean) })
  return {
    title: event.title,
    people: attendees.map((a) => a.name).join(', '),
    organization: res.organization || org,
    sources: res.sources.map((x) => ({ ...x, included: true })),
    errors: res.errors,
  }
}

const calendarEnabled = (g: GoogleStatus | null) => !!g?.connected && g.services.calendar.enabled && g.services.calendar.granted

function eventLabel(e: CalendarEvent): string {
  const d = new Date(e.start)
  const day = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  return `${day} ${time} · ${e.title}`
}

const KIND_ICON = { calendar: Calendar, gmail: Mail, drive: FileText } as const

const EMPTY: MeetingSetupInput = {
  mode: 'general',
  title: '',
  counterpartyPeople: [],
  counterpartyOrg: '',
  objective: '',
  idealOutcome: '',
  avoid: [],
  notes: '',
}

const listToText = (l: string[]) => l.join(', ')
const textToList = (t: string) => t.split(/[,\n]/).map((x) => x.trim()).filter(Boolean)

function BriefView({ brief }: { brief: MeetingBrief }) {
  const List = ({ title, items }: { title: string; items: string[] }) =>
    items.length ? (
      <div>
        <div className="text-[11px] uppercase tracking-wider text-gray-400 mb-1">{title}</div>
        <ul className="text-sm text-gray-800 space-y-0.5">{items.map((x, i) => <li key={i}>• {x}</li>)}</ul>
      </div>
    ) : null
  return (
    <div className="space-y-3 rounded-xl border border-gray-200 bg-[#FBF8F2] p-4">
      {brief.whoTheyAre && <p className="text-sm text-gray-800"><span className="font-semibold">Who: </span>{brief.whoTheyAre}</p>}
      {brief.whatMatters && <p className="text-sm text-gray-800"><span className="font-semibold">What matters: </span>{brief.whatMatters}</p>}
      <List title="Three facts to remember" items={brief.factsToRemember} />
      <List title="Three questions to land" items={brief.questionsToLand} />
      {brief.hardQuestions.length > 0 && (
        <div>
          <div className="text-[11px] uppercase tracking-wider text-gray-400 mb-1">Likely hard questions</div>
          <ul className="text-sm text-gray-800 space-y-1">
            {brief.hardQuestions.map((q, i) => (
              <li key={i}>• {q.question} <span className="text-gray-500">→ {q.answerShape}</span></li>
            ))}
          </ul>
        </div>
      )}
      {brief.closeTarget && <p className="text-sm text-gray-800"><span className="font-semibold">Close target: </span>{brief.closeTarget}</p>}
      <List title="Do not say" items={brief.doNotSay} />
    </div>
  )
}

function SelfTestStatus({ result }: { result: { at: number; micOk: boolean; systemOk: boolean } | null }) {
  const days = result ? Math.floor((Date.now() - result.at) / 86_400_000) : null
  const ok = !!result && result.micOk && result.systemOk
  const label = !result
    ? 'Audio self test not run (Settings → Second)'
    : ok
      ? `Audio self test passed ${days === 0 ? 'today' : `${days}d ago`}`
      : `Last self test failed: ${!result.micOk ? 'mic' : ''}${!result.micOk && !result.systemOk ? ' + ' : ''}${!result.systemOk ? 'meeting audio' : ''} not heard`
  return (
    <span className={`block mt-0.5 text-[11px] ${ok && (days ?? 99) <= 7 ? 'text-emerald-600' : 'text-amber-600'}`}>{label}</span>
  )
}

export function MeetingPrepModal({ isOpen, onClose, onStart, initialEvent }: Props) {
  const [playbooks, setPlaybooks] = useState<PlaybookSummary[]>([])
  const [setup, setSetup] = useState<MeetingSetupInput>(EMPTY)
  const [people, setPeople] = useState('')
  const [avoid, setAvoid] = useState('')
  const [brief, setBrief] = useState<MeetingBrief | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selfTest, setSelfTest] = useState<{ at: number; micOk: boolean; systemOk: boolean } | null>(null)
  const [google, setGoogle] = useState<GoogleStatus | null>(null)
  const [events, setEvents] = useState<CalendarEvent[]>([])
  const [eventId, setEventId] = useState('')
  const [sources, setSources] = useState<PacketItem[]>([])
  const [gathering, setGathering] = useState(false)
  const [gatherNote, setGatherNote] = useState<string | null>(null)

  const applyContext = (ctx: EventContext) => {
    setSetup((s) => ({ ...s, title: ctx.title, counterpartyOrg: ctx.organization || s.counterpartyOrg }))
    if (ctx.people) setPeople(ctx.people)
    setSources(ctx.sources)
    setGatherNote(ctx.errors.length ? ctx.errors.join(' · ') : ctx.sources.length ? null : 'No related email or docs found.')
  }

  useEffect(() => {
    if (!isOpen) return
    let alive = true
    void window.second.google.status().then(async (g) => {
      if (!alive) return
      setGoogle(g)
      if (!calendarEnabled(g)) return
      const res = await window.second.google.upcoming()
      if (alive) setEvents(res.events)
      if (alive && initialEvent) {
        setEventId(initialEvent.id)
        setGathering(true)
        try {
          const ctx = await loadEventContext(initialEvent, g.email)
          if (alive) applyContext(ctx)
        } finally {
          if (alive) setGathering(false)
        }
      }
    }).catch(() => {})
    return () => { alive = false }
  }, [isOpen, initialEvent])

  useEffect(() => {
    if (!isOpen) return
    setError(null)
    void window.second.live.playbooks().then(setPlaybooks).catch(() => {})
    void window.second.storeGet('secondLastSelfTest').then((v) => {
      setSelfTest(v && typeof v === 'object' ? (v as { at: number; micOk: boolean; systemOk: boolean }) : null)
    }).catch(() => {})
    void window.second.live.getPendingSetup().then((pending) => {
      if (pending?.setup) {
        setSetup(pending.setup)
        setPeople(listToText(pending.setup.counterpartyPeople))
        setAvoid(listToText(pending.setup.avoid))
        setBrief(pending.brief)
      }
    }).catch(() => {})
  }, [isOpen])

  if (!isOpen) return null

  const packet = formatPacket(sources.filter((x) => x.included))
  const current = (): MeetingSetupInput => ({
    ...setup,
    counterpartyPeople: textToList(people),
    avoid: textToList(avoid),
    notes: [setup.notes.trim(), packet].filter(Boolean).join('\n\n'),
  })

  const pickEvent = async (id: string) => {
    setEventId(id)
    const event = events.find((e) => e.id === id)
    if (!event) return
    setGathering(true)
    setGatherNote(null)
    try {
      applyContext(await loadEventContext(event, google?.email ?? ''))
    } catch (err) {
      setGatherNote(err instanceof Error ? err.message : 'Could not load context')
    } finally {
      setGathering(false)
    }
  }

  const searchContext = async () => {
    setGathering(true)
    setGatherNote(null)
    try {
      const emails = textToList(people).filter((p) => p.includes('@'))
      const res = await window.second.google.gather({ emails, terms: [setup.counterpartyOrg, setup.title ?? ''].filter(Boolean) })
      setSources(res.sources.map((x) => ({ ...x, included: true })))
      setGatherNote(res.errors.length ? res.errors.join(' · ') : res.sources.length ? null : 'No related email or docs found.')
    } finally {
      setGathering(false)
    }
  }
  const field = (k: keyof MeetingSetupInput) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
    setSetup((s) => ({ ...s, [k]: e.target.value }))

  const generate = async () => {
    setBusy(true)
    setError(null)
    try {
      const res = await window.second.live.generateBrief(current())
      if (res.ok) setBrief(res.brief)
      else setError(res.error)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not generate the brief')
    } finally {
      setBusy(false)
    }
  }

  const save = async () => {
    await window.second.live.setPendingSetup(current(), brief)
  }

  const clear = async () => {
    await window.second.live.setPendingSetup(null)
    setSetup(EMPTY)
    setPeople('')
    setAvoid('')
    setBrief(null)
  }

  const input = 'w-full rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-[#B08A4A]/40'
  const label = 'block text-xs font-medium text-gray-500 mb-1'
  const selected = playbooks.find((p) => p.id === setup.mode)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/25" onClick={onClose} />
      <div className="relative bg-white rounded-2xl shadow-xl w-[680px] max-h-[88vh] flex flex-col">
        <div className="flex items-center justify-between px-6 pt-5 pb-3 border-b border-gray-100">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">Prepare meeting</h2>
            <p className="text-xs text-gray-500">Second uses this to know what matters before the call starts.</p>
            <SelfTestStatus result={selfTest} />
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg text-gray-400 hover:bg-gray-100"><X size={18} /></button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
          {google?.connected ? (
            <div className="rounded-xl border border-gray-200 bg-gray-50/60 p-3 space-y-2">
              <div className="flex items-center gap-2">
                {calendarEnabled(google) && (
                  <select
                    className="flex-1 rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-sm text-gray-900"
                    value={eventId}
                    onChange={(e) => { void pickEvent(e.target.value) }}
                  >
                    <option value="">{events.length ? 'From your calendar…' : 'No upcoming meetings in the next 2 days'}</option>
                    {events.map((e) => <option key={e.id} value={e.id}>{eventLabel(e)}</option>)}
                  </select>
                )}
                <button
                  onClick={() => { void searchContext() }}
                  disabled={gathering}
                  className="flex items-center gap-1.5 whitespace-nowrap px-3 py-1.5 rounded-lg text-sm border border-gray-200 bg-white hover:bg-gray-50 disabled:opacity-50"
                  title="Search Gmail and Drive for the people and organization below"
                >
                  {gathering ? <Loader2 size={14} className="animate-spin" /> : <Mail size={14} />} Find email & docs
                </button>
              </div>
              {gatherNote && <p className="text-xs text-gray-500">{gatherNote}</p>}
              {sources.length > 0 && (
                <ul className="space-y-1">
                  {sources.map((src, i) => {
                    const Icon = KIND_ICON[src.kind]
                    return (
                      <li key={src.ref} className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          className="w-4 h-4 accent-[#141B2D]"
                          checked={src.included}
                          onChange={(e) => setSources((all) => all.map((x, j) => (j === i ? { ...x, included: e.target.checked } : x)))}
                        />
                        <Icon size={14} className="text-gray-400 shrink-0" />
                        <span className="truncate text-gray-800">{src.title}</span>
                        <span className="truncate text-xs text-gray-400">{src.meta}</span>
                        {src.url && (
                          <button onClick={() => { void window.second.openExternal(src.url!) }} className="ml-auto text-gray-400 hover:text-gray-700" title="Open">
                            <ExternalLink size={13} />
                          </button>
                        )}
                      </li>
                    )
                  })}
                </ul>
              )}
              {sources.length > 0 && (
                <p className="text-[11px] text-gray-400">Ticked items are added to the context below when you generate the brief or start. Sent only to your AI provider.</p>
              )}
            </div>
          ) : (
            google && <p className="text-xs text-gray-400">Tip: connect Google in Settings → Second to pull the invite, recent email, and docs automatically.</p>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={label}>Meeting type</label>
              <select className={input} value={setup.mode} onChange={(e) => setSetup((s) => ({ ...s, mode: e.target.value as MeetingModeId }))}>
                {playbooks.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
              </select>
              {selected && <p className="mt-1 text-[11px] text-gray-400">{selected.objective}</p>}
            </div>
            <div>
              <label className={label}>Meeting</label>
              <input className={input} value={setup.title ?? ''} onChange={field('title')} placeholder="e.g. Intro with the Acme founders" />
            </div>
            <div>
              <label className={label}>Who (comma separated)</label>
              <input className={input} value={people} onChange={(e) => setPeople(e.target.value)} placeholder="Dana Lee, CEO" />
            </div>
            <div>
              <label className={label}>Organization</label>
              <input className={input} value={setup.counterpartyOrg} onChange={field('counterpartyOrg')} placeholder="Acme" />
            </div>
          </div>
          <div>
            <label className={label}>Objective</label>
            <input className={input} value={setup.objective} onChange={field('objective')} placeholder="What you need from this meeting" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={label}>Ideal outcome</label>
              <input className={input} value={setup.idealOutcome} onChange={field('idealOutcome')} placeholder="The next step you want to land" />
            </div>
            <div>
              <label className={label}>Must not happen</label>
              <input className={input} value={avoid} onChange={(e) => setAvoid(e.target.value)} placeholder="e.g. Anchoring on price" />
            </div>
          </div>
          <div>
            <label className={label}>Context (optional): agenda, prior thread, notes, document excerpts</label>
            <textarea className={`${input} h-28 resize-y`} value={setup.notes} onChange={field('notes')} placeholder="Paste anything relevant. It stays on this machine except when sent to your AI provider to write the brief." />
          </div>

          {error && <p className="text-sm text-rose-600">{error}</p>}
          {brief && <BriefView brief={brief} />}
        </div>

        <div className="flex items-center gap-2 px-6 py-4 border-t border-gray-100">
          <button onClick={() => { void clear() }} className="text-sm text-gray-500 hover:text-gray-800">Clear</button>
          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={() => { void generate() }}
              disabled={busy}
              className="flex items-center gap-1.5 whitespace-nowrap px-4 py-2 rounded-lg text-sm font-medium border border-gray-200 text-gray-800 hover:bg-gray-50 disabled:opacity-50"
            >
              {busy ? <Loader2 size={15} className="animate-spin" /> : <Sparkles size={15} />}
              {brief ? 'Regenerate brief' : 'Generate brief'}
            </button>
            <button
              onClick={() => { void save().then(onClose) }}
              className="whitespace-nowrap px-4 py-2 rounded-lg text-sm font-medium border border-gray-200 text-gray-800 hover:bg-gray-50"
            >
              Save for later
            </button>
            <button
              onClick={() => { void save().then(() => { onClose(); onStart() }) }}
              className="whitespace-nowrap px-4 py-2 rounded-lg text-sm font-medium text-white bg-[#141B2D] hover:bg-[#222b42]"
            >
              Start meeting
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
