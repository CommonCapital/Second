/**
 * Second settings: live coaching, models, privacy, the editable professional
 * profile (no code deploy needed), the dual-audio self test, and the
 * diagnostics bundle.
 */

import { useEffect, useRef, useState } from 'react'
import { Loader2, Plus, Trash2 } from 'lucide-react'
import { MODEL_CATALOG, type AIProviderName } from '../../../lib/aiModels'
import { emptyProfile, isDynamicStale, type DynamicContextItem, type UserProfile } from '../../../../../shared/second/profile'
import type { SelfTestResult } from '../../../../../shared/second/views'
import { GoogleIntegration } from './GoogleIntegration'

type Sensitivity = 'auto' | 'quiet' | 'balanced' | 'active'

const SENSITIVITY_HELP: Record<Sensitivity, string> = {
  auto: 'Follow the meeting type (negotiation and LP calls are quieter, interviews more active).',
  quiet: 'Speak rarely. Only high-confidence, high-value cards.',
  balanced: 'A card when it clearly beats silence.',
  active: 'More frequent suggestions. Good for interviews and practice.',
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={`relative shrink-0 w-10 h-6 rounded-full transition-colors ${checked ? 'bg-[#141B2D]' : 'bg-gray-300'}`}
    >
      <span className={`absolute top-0.5 left-0 w-5 h-5 rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-[18px]' : 'translate-x-0.5'}`} />
    </button>
  )
}

function Row({ title, help, children }: { title: string; help?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-6 py-3 border-b border-gray-100">
      <div className="min-w-0">
        <div className="text-sm font-medium text-gray-900">{title}</div>
        {help && <div className="text-xs text-gray-500 mt-0.5">{help}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

function SelfTest() {
  const [phase, setPhase] = useState<'idle' | 'running' | 'done'>('idle')
  const [levels, setLevels] = useState({ micPeakRms: 0, systemPeakRms: 0 })
  const [result, setResult] = useState<SelfTestResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const poll = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => () => {
    if (poll.current) clearInterval(poll.current)
    window.speechSynthesis?.cancel()
  }, [])

  const run = async () => {
    setError(null)
    setResult(null)
    const start = await window.second.live.selfTestStart()
    if (!start.ok) {
      setError(start.error ?? 'Could not start the self test')
      return
    }
    setPhase('running')
    poll.current = setInterval(() => {
      void window.second.live.selfTestLevels().then(setLevels).catch(() => {})
    }, 250)
    // Known audio for the THEM side: spoken through this Mac's speakers.
    try {
      const u = new SpeechSynthesisUtterance('This is the Second system audio test. If you can see the meeting meter move, the other side of your calls will be heard.')
      window.speechSynthesis.speak(u)
    } catch { /* speech synthesis unavailable: user can play any audio instead */ }
  }

  const finish = async () => {
    if (poll.current) clearInterval(poll.current)
    window.speechSynthesis?.cancel()
    const r = await window.second.live.selfTestFinish()
    setResult(r)
    setPhase('done')
  }

  const bar = (rms: number) => Math.min(100, Math.round((Math.log10(Math.max(rms, 60) / 60) / Math.log10(3000 / 60)) * 100))

  return (
    <div className="rounded-xl border border-gray-200 p-4">
      <div className="flex items-center justify-between mb-2">
        <div>
          <div className="text-sm font-medium text-gray-900">Dual audio self test</div>
          <div className="text-xs text-gray-500">Second plays a test sentence (THEM) and listens to your mic (YOU). Speak a sentence while it runs.</div>
        </div>
        {phase === 'running' ? (
          <button onClick={() => { void finish() }} className="px-3 py-1.5 rounded-lg text-sm bg-[#141B2D] text-white">Finish</button>
        ) : (
          <button onClick={() => { void run() }} className="px-3 py-1.5 rounded-lg text-sm border border-gray-200 hover:bg-gray-50">Run test</button>
        )}
      </div>
      {(phase === 'running' || result) && (
        <div className="space-y-2 mt-3">
          {(['micPeakRms', 'systemPeakRms'] as const).map((k) => {
            const value = result ? result[k] : levels[k]
            const ok = result ? (k === 'micPeakRms' ? result.micOk : result.systemOk) : null
            return (
              <div key={k} className="flex items-center gap-3 text-xs">
                <span className="w-24 text-gray-600">{k === 'micPeakRms' ? 'You (mic)' : 'Them (system)'}</span>
                <span className="flex-1 h-2 bg-gray-100 rounded-full overflow-hidden">
                  <span className={`block h-full ${ok === false ? 'bg-rose-400' : 'bg-emerald-500'}`} style={{ width: `${bar(value)}%` }} />
                </span>
                {ok !== null && <span className={ok ? 'text-emerald-600' : 'text-rose-600'}>{ok ? 'Heard' : 'Not heard'}</span>}
              </div>
            )
          })}
          {result && !result.systemOk && (
            <p className="text-xs text-rose-600">Meeting audio was not heard. Check System Settings → Privacy & Security → Screen Recording (or System Audio Recording) for Second, and that your output volume is up.</p>
          )}
          {result && !result.micOk && (
            <p className="text-xs text-rose-600">Your microphone was not heard. Check System Settings → Privacy & Security → Microphone and your input device.</p>
          )}
        </div>
      )}
      {error && <p className="text-xs text-rose-600 mt-2">{error}</p>}
    </div>
  )
}

function ProfileEditor() {
  const [profile, setProfile] = useState<UserProfile>(emptyProfile())
  const [neverSay, setNeverSay] = useState('')
  const [saved, setSaved] = useState<string | null>(null)
  const [historyCount, setHistoryCount] = useState(0)

  useEffect(() => {
    void window.second.live.getProfile().then((r) => {
      setProfile(r.profile)
      setNeverSay(r.profile.neverSay.join('\n'))
      setHistoryCount(r.historyCount)
    }).catch(() => {})
  }, [])

  const set = (k: keyof UserProfile) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setProfile((p) => ({ ...p, [k]: e.target.value }))

  const setDyn = (i: number, patch: Partial<DynamicContextItem>) =>
    setProfile((p) => ({ ...p, dynamic: p.dynamic.map((d, j) => (j === i ? { ...d, ...patch } : d)) }))

  const save = async () => {
    const next = await window.second.live.saveProfile({
      ...profile,
      neverSay: neverSay.split('\n').map((x) => x.trim()).filter(Boolean),
    })
    setProfile(next)
    setHistoryCount((n) => n + (next.version > 1 ? 1 : 0))
    setSaved(`Saved version ${next.version}`)
    setTimeout(() => setSaved(null), 2500)
  }

  const input = 'w-full rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-[#B08A4A]/40'
  const label = 'block text-xs font-medium text-gray-500 mb-1'
  const now = Date.now()

  return (
    <div className="space-y-3">
      <p className="text-xs text-gray-500">
        Your stable professional context. Second only uses the slices relevant to each meeting and never tells the
        other side what it knows. Keep it professional; this stays on this machine and is sent to your AI provider only as context.
      </p>
      <div className="grid grid-cols-3 gap-3">
        <div><label className={label}>Name</label><input className={input} value={profile.name} onChange={set('name')} /></div>
        <div><label className={label}>Role</label><input className={input} value={profile.role} onChange={set('role')} /></div>
        <div><label className={label}>Organization</label><input className={input} value={profile.organization} onChange={set('organization')} /></div>
      </div>
      <div><label className={label}>Background (experience Second may cite when it proves the point)</label><textarea className={`${input} h-20`} value={profile.background} onChange={set('background')} /></div>
      <div className="grid grid-cols-2 gap-3">
        <div><label className={label}>Operating posture</label><textarea className={`${input} h-16`} value={profile.operatingPosture} onChange={set('operatingPosture')} placeholder="e.g. Evidence before narrative; relationship before transaction" /></div>
        <div><label className={label}>Current focus</label><textarea className={`${input} h-16`} value={profile.focus} onChange={set('focus')} /></div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div><label className={label}>Voice notes (how lines should sound from you)</label><textarea className={`${input} h-16`} value={profile.voiceNotes} onChange={set('voiceNotes')} /></div>
        <div><label className={label}>Never suggest (one per line)</label><textarea className={`${input} h-16`} value={neverSay} onChange={(e) => setNeverSay(e.target.value)} /></div>
      </div>

      <div className="pt-2">
        <div className="flex items-center justify-between mb-1">
          <div className="text-xs font-medium text-gray-500">Dynamic context (used only when a meeting mentions its topic)</div>
          <button
            onClick={() => setProfile((p) => ({ ...p, dynamic: [...p.dynamic, { id: `dyn_${Date.now()}`, topic: '', content: '', asOf: new Date().toISOString().slice(0, 10), sensitivity: 'normal' }] }))}
            className="flex items-center gap-1 text-xs text-gray-600 hover:text-gray-900"
          >
            <Plus size={13} /> Add
          </button>
        </div>
        <div className="space-y-2">
          {profile.dynamic.map((d, i) => (
            <div key={d.id} className="rounded-lg border border-gray-200 p-2.5">
              <div className="flex items-center gap-2 mb-1.5">
                <input className={`${input} py-1`} value={d.topic} placeholder="Topic (company, workstream)" onChange={(e) => setDyn(i, { topic: e.target.value })} />
                <input className={`${input} py-1 w-36`} type="date" value={d.asOf} onChange={(e) => setDyn(i, { asOf: e.target.value })} />
                {isDynamicStale(d, now) && <span className="text-[11px] text-amber-600 whitespace-nowrap">stale</span>}
                <button onClick={() => setProfile((p) => ({ ...p, dynamic: p.dynamic.filter((_, j) => j !== i) }))} className="p-1 text-gray-400 hover:text-rose-600"><Trash2 size={14} /></button>
              </div>
              <textarea className={`${input} h-14`} value={d.content} placeholder="What Second should know when this comes up" onChange={(e) => setDyn(i, { content: e.target.value })} />
            </div>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-3 pt-1">
        <button onClick={() => { void save() }} className="px-4 py-2 rounded-lg text-sm font-medium text-white bg-[#141B2D] hover:bg-[#222b42]">Save profile</button>
        {saved && <span className="text-xs text-emerald-600">{saved}</span>}
        <span className="ml-auto text-[11px] text-gray-400">v{profile.version}{historyCount ? ` · ${historyCount} earlier versions kept` : ''}</span>
      </div>
    </div>
  )
}

export function SecondTab() {
  const [coach, setCoach] = useState(true)
  const [sensitivity, setSensitivity] = useState<Sensitivity>('auto')
  const [provider, setProvider] = useState<AIProviderName>('anthropic')
  const [coachModel, setCoachModel] = useState('')
  const [deepModel, setDeepModel] = useState('')
  const [retain, setRetain] = useState(false)
  const [diag, setDiag] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)

  useEffect(() => {
    void window.second.storeGetAll().then((s: Record<string, unknown>) => {
      setCoach(s.secondCoachEnabled !== false)
      setSensitivity((s.secondSensitivity as Sensitivity) || 'auto')
      setProvider((s.aiProvider as AIProviderName) || 'anthropic')
      setCoachModel((s.secondCoachModel as string) || '')
      setDeepModel((s.secondDeepModel as string) || '')
      setRetain(s.retainTranscripts === true)
    }).catch(() => {})
  }, [])

  const persist = (key: string, value: unknown) => { void window.second.storeSet(key, value) }
  const models = MODEL_CATALOG[provider] ?? []
  const select = 'rounded-lg border border-gray-200 px-2.5 py-1.5 text-sm text-gray-900 bg-white'

  return (
    <div className="space-y-8">
      <section>
        <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-1">Live coaching</h3>
        <Row title="Live cards" help="One card at a time (SAY, ASK, WATCH, WAIT, CLOSE), only when it beats silence. The transcript works either way.">
          <Toggle checked={coach} onChange={(v) => { setCoach(v); persist('secondCoachEnabled', v) }} />
        </Row>
        <Row title="How often Second speaks" help={SENSITIVITY_HELP[sensitivity]}>
          <select className={select} value={sensitivity} onChange={(e) => { const v = e.target.value as Sensitivity; setSensitivity(v); persist('secondSensitivity', v) }}>
            <option value="auto">Auto</option>
            <option value="quiet">Quiet</option>
            <option value="balanced">Balanced</option>
            <option value="active">Active</option>
          </select>
        </Row>
        <Row title="Live card model" help="Fast model for cards. Latency matters more than depth here.">
          <select className={select} value={coachModel} onChange={(e) => { setCoachModel(e.target.value); persist('secondCoachModel', e.target.value) }}>
            <option value="">Default (fast)</option>
            {models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
        </Row>
        <Row title="Deep model" help="Briefs, “think deeper”, and post-meeting reports.">
          <select className={select} value={deepModel} onChange={(e) => { setDeepModel(e.target.value); persist('secondDeepModel', e.target.value) }}>
            <option value="">Default (deep)</option>
            {models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
        </Row>
      </section>

      <section>
        <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-1">Privacy</h3>
        <Row
          title="Keep full transcripts"
          help="Off by default. Title, summary, action items, and the Second report are kept; the raw transcript is deleted after notes are written. Ask across meetings needs transcripts. Raw audio is never saved."
        >
          <Toggle checked={retain} onChange={(v) => { setRetain(v); persist('retainTranscripts', v) }} />
        </Row>
      </section>

      <section>
        <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Preflight</h3>
        <SelfTest />
      </section>

      <section>
        <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Your professional profile</h3>
        <ProfileEditor />
      </section>

      <section>
        <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Integrations</h3>
        <GoogleIntegration />
      </section>

      <section>
        <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-1">Diagnostics</h3>
        <Row title="Diagnostic bundle" help="State changes, latencies, error classes, and versions. No audio, transcript, card text, profile, or keys. Preview before saving.">
          <div className="flex gap-2">
            <button onClick={() => { void window.second.live.diagnosticsPreview().then(setDiag) }} className="px-3 py-1.5 rounded-lg text-sm border border-gray-200 hover:bg-gray-50">Preview</button>
            <button
              onClick={() => { setExporting(true); void window.second.live.diagnosticsExport().finally(() => setExporting(false)) }}
              className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-sm border border-gray-200 hover:bg-gray-50"
            >
              {exporting && <Loader2 size={13} className="animate-spin" />} Save…
            </button>
          </div>
        </Row>
        {diag && <pre className="mt-2 max-h-64 overflow-auto rounded-lg bg-gray-50 p-3 text-[11px] text-gray-700">{diag}</pre>}
      </section>
    </div>
  )
}
