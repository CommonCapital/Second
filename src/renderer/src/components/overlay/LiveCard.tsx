/**
 * The live surface: one dominant card, a mode label, and an expiry line.
 * Quiet by design: dark, strong type, almost no chrome. Keyboard first
 * (Cmd/Ctrl+Shift+Enter asks for the best card now).
 */

import { useState, type CSSProperties } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Pin, X, Brain } from 'lucide-react'
import type { Card, CardMode } from '../../../../shared/second/card'
import { useCountdown } from '../../lib/useLive'

const MODE_STYLE: Record<CardMode, { label: string; chip: string; bar: string }> = {
  SAY: { label: 'SAY', chip: 'bg-emerald-400/15 text-emerald-300 border-emerald-400/30', bar: 'bg-emerald-400/70' },
  ASK: { label: 'ASK', chip: 'bg-sky-400/15 text-sky-300 border-sky-400/30', bar: 'bg-sky-400/70' },
  WATCH: { label: 'WATCH', chip: 'bg-amber-400/15 text-amber-300 border-amber-400/30', bar: 'bg-amber-400/70' },
  WAIT: { label: 'WAIT', chip: 'bg-white/10 text-white/60 border-white/15', bar: 'bg-white/30' },
  CLOSE: { label: 'CLOSE', chip: 'bg-[#B08A4A]/20 text-[#E2C48E] border-[#B08A4A]/40', bar: 'bg-[#B08A4A]/80' },
}

const noDrag = { WebkitAppRegion: 'no-drag' } as CSSProperties

interface LiveCardProps {
  card: Card | null
  shortcutLabel: string
}

export function LiveCard({ card, shortcutLabel }: LiveCardProps) {
  const { remaining, fraction } = useCountdown(card)
  const [asking, setAsking] = useState(false)

  const deeper = async () => {
    setAsking(true)
    try {
      await window.second.live.requestCard('think_deeper')
    } finally {
      setAsking(false)
    }
  }

  return (
    <div className="px-4 pt-3 pb-2" style={noDrag}>
      <AnimatePresence mode="wait">
        {card ? (
          <motion.div
            key={card.id}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            className="relative"
          >
            <div className="flex items-center gap-2 mb-1.5">
              <span className={`text-[10px] font-semibold tracking-[0.12em] px-1.5 py-0.5 rounded border ${MODE_STYLE[card.mode].chip}`}>
                {MODE_STYLE[card.mode].label}
              </span>
              {card.urgency === 'high' && (
                <span className="text-[10px] font-medium text-rose-300/90">now</span>
              )}
              {card.why && <span className="text-[11px] text-white/35 truncate">{card.why}</span>}
              <div className="ml-auto flex items-center gap-0.5">
                <button
                  type="button"
                  onClick={() => { void window.second.live.holdCard() }}
                  title="Keep this card"
                  className="p-1 rounded text-white/35 hover:text-white/80 hover:bg-white/10"
                >
                  <Pin size={12} />
                </button>
                <button
                  type="button"
                  onClick={() => { void deeper() }}
                  disabled={asking}
                  title="Think deeper"
                  className="p-1 rounded text-white/35 hover:text-white/80 hover:bg-white/10 disabled:opacity-40"
                >
                  <Brain size={12} />
                </button>
                <button
                  type="button"
                  onClick={() => { void window.second.live.dismissCard() }}
                  title="Dismiss"
                  className="p-1 rounded text-white/35 hover:text-white/80 hover:bg-white/10"
                >
                  <X size={12} />
                </button>
              </div>
            </div>
            <p
              className={`leading-snug select-text ${card.mode === 'WAIT' ? 'text-[14px] text-white/55' : 'text-[17px] font-medium text-white'}`}
              style={{ fontFamily: "Georgia, 'Times New Roman', serif" }}
            >
              {card.text}
            </p>
            <div className="mt-2 h-[2px] w-full bg-white/[0.06] rounded-full overflow-hidden" title={`${remaining}s`}>
              <div className={`h-full ${MODE_STYLE[card.mode].bar} transition-[width] duration-200`} style={{ width: `${fraction * 100}%` }} />
            </div>
          </motion.div>
        ) : (
          <motion.div
            key="listening"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="flex items-center justify-between text-[12px] text-white/35"
          >
            <span>Listening.</span>
            <button
              type="button"
              onClick={() => { void window.second.live.requestCard('user_requested') }}
              className="text-white/40 hover:text-white/80"
            >
              Best move now <span className="text-white/25">{shortcutLabel}</span>
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
