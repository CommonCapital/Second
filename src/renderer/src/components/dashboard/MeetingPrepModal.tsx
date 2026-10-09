/**
 * Pre-meeting packet: pick the room, say who and why, optionally paste
 * context, and get a 90-second brief. The setup and brief feed the live
 * coach for the next recording.
 */

import { useEffect, useState } from 'react'
import { X, Sparkles, Loader2 } from 'lucide-react'
import type { MeetingBrief, MeetingSetupInput } from '../../../../shared/second/briefing'
import type { MeetingModeId } from '../../../../shared/second/playbooks'
import type { PlaybookSummary } from '../../../../shared/second/views'

interface Props {
  isOpen: boolean
  onClose: () => void
  onStart: () => void
}

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

export function MeetingPrepModal({ isOpen, onClose, onStart }: Props) {
  const [playbooks, setPlaybooks] = useState<PlaybookSummary[]>([])
  const [setup, setSetup] = useState<MeetingSetupInput>(EMPTY)
  const [people, setPeople] = useState('')
  const [avoid, setAvoid] = useState('')
  const [brief, setBrief] = useState<MeetingBrief | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!isOpen) return
    setError(null)
    void window.second.live.playbooks().then(setPlaybooks).catch(() => {})
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

  const current = (): MeetingSetupInput => ({ ...setup, counterpartyPeople: textToList(people), avoid: textToList(avoid) })
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
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg text-gray-400 hover:bg-gray-100"><X size={18} /></button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
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
              className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium border border-gray-200 text-gray-800 hover:bg-gray-50 disabled:opacity-50"
            >
              {busy ? <Loader2 size={15} className="animate-spin" /> : <Sparkles size={15} />}
              {brief ? 'Regenerate brief' : 'Generate brief'}
            </button>
            <button
              onClick={() => { void save().then(onClose) }}
              className="px-4 py-2 rounded-lg text-sm font-medium border border-gray-200 text-gray-800 hover:bg-gray-50"
            >
              Save for next meeting
            </button>
            <button
              onClick={() => { void save().then(() => { onClose(); onStart() }) }}
              className="px-4 py-2 rounded-lg text-sm font-medium text-white bg-[#141B2D] hover:bg-[#222b42]"
            >
              Start meeting
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
