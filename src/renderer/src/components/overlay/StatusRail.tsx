/**
 * Status rail: mic, meeting audio, transcription, coach, network. Each dot is
 * an independent truth state; the summary never shows green without proof.
 */

import type { CSSProperties } from 'react'
import { CHANNEL_LABELS, type ChannelId, type ChannelStatus } from '../../../../shared/second/health'
import type { HealthView } from '../../../../shared/second/views'

const DOT: Record<ChannelStatus, string> = {
  live: 'bg-emerald-400',
  unverified: 'bg-white/30',
  connecting: 'bg-amber-300 animate-pulse',
  silent: 'bg-amber-400',
  down: 'bg-rose-500',
  off: 'bg-white/10',
}

const LEVEL_TEXT: Record<string, string> = {
  ready: 'text-emerald-300/90',
  degraded: 'text-amber-300/90',
  not_ready: 'text-white/55',
  offline: 'text-rose-300/90',
  idle: 'text-white/40',
}

const ORDER: ChannelId[] = ['mic', 'system', 'sttYou', 'sttThem', 'coach', 'network']

function Meter({ value }: { value: number }) {
  return (
    <span className="inline-block w-8 h-[3px] bg-white/10 rounded-full overflow-hidden align-middle">
      <span className="block h-full bg-white/50 transition-[width] duration-150" style={{ width: `${Math.round(value * 100)}%` }} />
    </span>
  )
}

export function StatusRail({ health }: { health: HealthView | null }) {
  if (!health) return null
  const { snapshot, readiness, levels } = health
  return (
    <div
      className="flex items-center gap-2 px-4 py-1.5 border-b border-white/[0.06] text-[11px]"
      style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}
    >
      <div className="flex items-center gap-1.5">
        {ORDER.map((id) => {
          const ch = snapshot[id]
          return (
            <span
              key={id}
              title={`${CHANNEL_LABELS[id]}: ${ch.status}${ch.detail ? ` — ${ch.detail}` : ''}`}
              className={`w-1.5 h-1.5 rounded-full ${DOT[ch.status]}`}
            />
          )
        })}
      </div>
      <span className={`truncate ${LEVEL_TEXT[readiness.level] ?? 'text-white/50'}`} title={readiness.action ?? readiness.message}>
        {readiness.message}
      </span>
      <span className="ml-auto flex items-center gap-1.5 text-white/30" title="You / Them audio level">
        You <Meter value={levels.mic} /> Them <Meter value={levels.system} />
      </span>
    </div>
  )
}
