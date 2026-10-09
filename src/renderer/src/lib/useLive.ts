import { useEffect, useState } from 'react'
import type { Card } from '../../../shared/second/card'
import type { HealthView, LiveStateView } from '../../../shared/second/views'

export interface LiveView {
  active: boolean
  card: Card | null
  state: LiveStateView | null
  health: HealthView | null
  coachEnabled: boolean
}

/** Live card + meeting state + health, pushed from the main process. */
export function useLive(): LiveView {
  const [view, setView] = useState<LiveView>({ active: false, card: null, state: null, health: null, coachEnabled: true })

  useEffect(() => {
    const live = window.second?.live
    if (!live) return
    let cancelled = false
    void live.getSnapshot().then((snap) => {
      if (cancelled || !snap) return
      setView({ active: snap.active, card: snap.card, state: snap.state, health: snap.health, coachEnabled: snap.coachEnabled })
    }).catch(() => {})
    const offs = [
      live.onCard((card) => setView((v) => ({ ...v, card }))),
      live.onState((state) => setView((v) => ({ ...v, state, active: true }))),
      live.onHealth((health) => setView((v) => ({
        ...v,
        health,
        active: health.readiness.level !== 'idle',
        ...(health.readiness.level === 'idle' ? { card: null } : {}),
      }))),
    ]
    return () => {
      cancelled = true
      offs.forEach((off) => off())
    }
  }, [])

  return view
}

/** Seconds left on a card, ticking. */
export function useCountdown(card: Card | null): { remaining: number; fraction: number } {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!card) return
    const t = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(t)
  }, [card])
  if (!card) return { remaining: 0, fraction: 0 }
  const total = card.expiresAfterSeconds * 1000
  const left = Math.max(0, card.createdAt + total - now)
  return { remaining: Math.ceil(left / 1000), fraction: total > 0 ? left / total : 0 }
}
