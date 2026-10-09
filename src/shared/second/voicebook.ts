/**
 * Voicebook: how Second should sound in a live card.
 *
 * Senior, warm, concise, specific, understated. A line should sound like
 * something a calm, engaged professional would actually say aloud.
 * The banned list catches generic consultant / chatbot cadence; a card that
 * trips it is suppressed rather than shown.
 */

export const CARD_MAX_WORDS = 22
/** Hard ceiling. Above this the card is rejected, not just flagged. */
export const CARD_HARD_MAX_WORDS = 40

export const BANNED_PHRASES: readonly string[] = [
  'compare notes',
  'would value 15 minutes',
  'worth a chat',
  'portfolio judgment',
  'excited to announce',
  'ai is changing everything',
  'game changing',
  'game-changing',
  'unlock',
  'ecosystem',
  'synergy',
  'circle back',
  'touch base',
  'leverage our',
  'great question',
  'as an ai',
  'i hope this helps',
  'delve',
]

/** Formulaic reversal: "it's not X, it's Y" / "this is not X, it is Y". */
const FORMULAIC_REVERSAL = /\b(it'?s|it is|this is|this isn'?t)\s+not\s+[^,.;]{1,40}[,;]\s*(it'?s|it is)\b/i

export function wordCount(text: string): number {
  const trimmed = text.trim()
  if (!trimmed) return 0
  return trimmed.split(/\s+/).length
}

export function findVoiceViolations(text: string): string[] {
  const lower = text.toLowerCase()
  const hits: string[] = []
  for (const phrase of BANNED_PHRASES) {
    const re = new RegExp(`\\b${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i')
    if (re.test(lower)) hits.push(phrase)
  }
  if (FORMULAIC_REVERSAL.test(text)) hits.push('formulaic reversal')
  return hits
}
