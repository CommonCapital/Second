/**
 * Meeting state drawer: objective, open questions, commitments, numbers that
 * changed, and the next step. Read-only view of the reducer's state.
 */

import type { LiveStateView } from '../../../../shared/second/views'

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-3">
      <div className="text-[10px] uppercase tracking-[0.12em] text-white/35 mb-1">{title}</div>
      {children}
    </div>
  )
}

export function MeetingStateTab({ state }: { state: LiveStateView | null }) {
  if (!state) {
    return <div className="p-4 text-xs text-white/40">Meeting state appears once a meeting starts.</div>
  }
  return (
    <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 text-[12.5px] text-white/80">
      <div className="flex items-center gap-2 mb-3 text-[11px] text-white/45">
        <span className="px-1.5 py-0.5 rounded border border-white/15">{state.modeLabel}</span>
        <span>{state.phase}</span>
        <span className="ml-auto">{state.turnCount} turns</span>
      </div>
      {state.objective && <Section title="Objective"><p>{state.objective}</p></Section>}
      {state.currentTopic && <Section title="Topic"><p>{state.currentTopic}</p></Section>}
      {state.contradictions.length > 0 && (
        <Section title="Numbers that changed">
          {state.contradictions.map((c, i) => (
            <p key={i} className="text-amber-300/90">{c.metric}: {c.previous.toLocaleString()} → {c.current.toLocaleString()}</p>
          ))}
        </Section>
      )}
      {state.questionsOpen.length > 0 && (
        <Section title="Open questions">
          <ul className="space-y-0.5">
            {state.questionsOpen.map((q, i) => (
              <li key={i}>• {q.question} <span className="text-white/30">({q.owner === 'you' ? 'you owe' : 'they owe'})</span></li>
            ))}
          </ul>
        </Section>
      )}
      {state.objectionsOpen.length > 0 && (
        <Section title="Objections">
          <ul className="space-y-0.5">{state.objectionsOpen.map((o, i) => <li key={i}>• {o}</li>)}</ul>
        </Section>
      )}
      {state.commitments.length > 0 && (
        <Section title="Commitments">
          <ul className="space-y-0.5">
            {state.commitments.map((c, i) => (
              <li key={i}>• <span className="text-white">{c.who}</span>: {c.action}{c.due ? ` — ${c.due}` : <span className="text-amber-300/80"> — no date yet</span>}</li>
            ))}
          </ul>
        </Section>
      )}
      {state.closeTarget && <Section title="Close target"><p>{state.closeTarget}</p></Section>}
      {state.nextBestAction && <Section title="Next best action"><p>{state.nextBestAction}</p></Section>}
    </div>
  )
}
