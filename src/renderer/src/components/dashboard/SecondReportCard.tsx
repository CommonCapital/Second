/**
 * Post-meeting Second report: outcome, decisions, commitments, open
 * questions, risks, next step, follow-up draft, and proposed context
 * updates the user can approve into their profile.
 */

import { useEffect, useState } from 'react'
import { Check, Copy, Loader2, RefreshCw } from 'lucide-react'
import { reportToMarkdown } from '../../../../shared/second/briefing'
import { getPlaybook } from '../../../../shared/second/playbooks'
import type { SecondSessionData } from '../../../../shared/second/views'

function List({ title, items, tone }: { title: string; items: string[]; tone?: 'warn' }) {
  if (!items.length) return null
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wider text-gray-400 mb-1">{title}</div>
      <ul className={`text-sm space-y-0.5 ${tone === 'warn' ? 'text-amber-800' : 'text-gray-800'}`}>
        {items.map((x, i) => <li key={i}>• {x}</li>)}
      </ul>
    </div>
  )
}

export function SecondReportCard({ sessionId }: { sessionId: string }) {
  const [data, setData] = useState<SecondSessionData | null>(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    const load = () => {
      void window.second.live.getSessionData(sessionId).then((d) => { if (alive) setData(d) }).catch(() => {})
    }
    load()
    const off = window.second.live.onSessionUpdated((id) => { if (id === sessionId) load() })
    return () => { alive = false; off() }
  }, [sessionId])

  if (!data || data.reportStatus === 'none') return null

  const copy = async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(key)
      setTimeout(() => setCopied(null), 1500)
    } catch { /* clipboard unavailable */ }
  }

  const regenerate = async () => {
    setBusy(true)
    setError(null)
    const res = await window.second.live.regenerateReport(sessionId)
    if (!res.ok) setError(res.error ?? 'Could not regenerate the report')
    setBusy(false)
  }

  const header = (
    <div className="flex items-center gap-2 mb-3">
      <h3 className="text-sm font-semibold text-gray-900">Second report</h3>
      <span className="text-[11px] px-1.5 py-0.5 rounded border border-gray-200 text-gray-500">{getPlaybook(data.modeId).label}</span>
      {data.metrics && (
        <span className="text-[11px] text-gray-400">
          {data.metrics.cards} cards · {data.metrics.suppressed} held back
          {data.metrics.p50Ms !== null ? ` · p50 ${(data.metrics.p50Ms / 1000).toFixed(1)}s` : ''}
        </span>
      )}
      <div className="ml-auto flex items-center gap-1">
        {data.report && (
          <button onClick={() => { void copy('all', reportToMarkdown(data.report!)) }} className="p-1.5 rounded-md text-gray-400 hover:bg-gray-100" title="Copy report">
            {copied === 'all' ? <Check size={14} /> : <Copy size={14} />}
          </button>
        )}
        {data.retention === 'on' && (
          <button onClick={() => { void regenerate() }} disabled={busy} className="p-1.5 rounded-md text-gray-400 hover:bg-gray-100 disabled:opacity-40" title="Regenerate">
            {busy ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
          </button>
        )}
      </div>
    </div>
  )

  if (data.reportStatus === 'pending') {
    return (
      <div className="rounded-xl border border-gray-200 p-4 max-w-3xl">
        {header}
        <p className="text-sm text-gray-500 flex items-center gap-2"><Loader2 size={14} className="animate-spin" /> Writing the report from the meeting state…</p>
      </div>
    )
  }

  if (data.reportStatus === 'failed' || !data.report) {
    return (
      <div className="rounded-xl border border-gray-200 p-4 max-w-3xl">
        {header}
        <p className="text-sm text-gray-600">The report did not generate{data.reportError ? `: ${data.reportError}` : '.'}</p>
        {error && <p className="text-xs text-rose-600 mt-1">{error}</p>}
      </div>
    )
  }

  const r = data.report
  return (
    <div className="rounded-xl border border-[#E8DFCF] bg-[#FBF8F2] p-4 max-w-3xl space-y-3">
      {header}
      {r.outcome && <p className="text-[15px] text-gray-900" style={{ fontFamily: "Georgia, 'Times New Roman', serif" }}>{r.outcome}</p>}
      {r.nextStep && (
        <p className="text-sm text-gray-900"><span className="font-semibold">Next step: </span>{r.nextStep}</p>
      )}
      <div className="grid grid-cols-2 gap-4">
        <List title="Decisions" items={r.decisions} />
        <List title="Commitments" items={r.commitments.map((c) => `${c.who}: ${c.action}${c.due ? ` (by ${c.due})` : ''}`)} />
        <List title="Facts learned" items={r.factsLearned} />
        <List title="Open questions" items={r.openQuestions} />
      </div>
      <List title="Risks / watch items" items={r.risks} tone="warn" />
      {r.followUpDraft && (
        <div>
          <div className="flex items-center justify-between mb-1">
            <div className="text-[11px] uppercase tracking-wider text-gray-400">Follow-up draft</div>
            <button onClick={() => { void copy('fu', r.followUpDraft) }} className="text-[11px] text-gray-500 hover:text-gray-800">
              {copied === 'fu' ? 'Copied' : 'Copy'}
            </button>
          </div>
          <p className="text-sm text-gray-800 whitespace-pre-wrap rounded-lg bg-white border border-gray-200 p-3">{r.followUpDraft}</p>
        </div>
      )}
      {r.contextUpdates.length > 0 && (
        <div>
          <div className="text-[11px] uppercase tracking-wider text-gray-400 mb-1">Proposed context updates (nothing is saved until you approve)</div>
          <ul className="space-y-1.5">
            {r.contextUpdates.map((u, i) => (
              <li key={`${u.topic}-${i}`} className="flex items-start gap-2 text-sm text-gray-800">
                <span className="flex-1"><span className="font-medium">{u.topic}:</span> {u.content}</span>
                <button
                  onClick={() => { void window.second.live.applyContextUpdate(sessionId, i) }}
                  className="text-xs px-2 py-1 rounded-md border border-gray-200 bg-white hover:bg-gray-50"
                >
                  Save to profile
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {data.retention === 'off' && (
        <p className="text-[11px] text-gray-400">Transcript not retained for this meeting (Settings → Second → Privacy).</p>
      )}
    </div>
  )
}
