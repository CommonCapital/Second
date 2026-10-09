/**
 * Canonical professional profile: the user's stable identity layer.
 *
 * Editable in Settings (no code deploy), versioned on every save, stored
 * locally. Only professional context relevant to meetings belongs here.
 * Dynamic items (deals, open roles, live workstreams) carry an as-of date and
 * go stale after a configurable horizon so they are refreshed, not trusted
 * forever.
 */

export interface DynamicContextItem {
  id: string
  /** Short label used to decide relevance, e.g. a company or workstream name. */
  topic: string
  content: string
  /** ISO date (YYYY-MM-DD) the user last confirmed this. */
  asOf: string
  sensitivity: 'normal' | 'confidential'
}

export interface UserProfile {
  version: number
  updatedAt: number
  name: string
  role: string
  organization: string
  background: string
  /** How the user operates: principles, posture, style. */
  operatingPosture: string
  /** What the user is focused on / looking for. */
  focus: string
  /** Phrases or topics the user never wants suggested. */
  neverSay: string[]
  /** Free-form voice notes: how lines should sound coming from this user. */
  voiceNotes: string
  dynamic: DynamicContextItem[]
}

export const DYNAMIC_STALE_DAYS_DEFAULT = 30

export function emptyProfile(): UserProfile {
  return {
    version: 0,
    updatedAt: 0,
    name: '',
    role: '',
    organization: '',
    background: '',
    operatingPosture: '',
    focus: '',
    neverSay: [],
    voiceNotes: '',
    dynamic: [],
  }
}

export function normalizeProfile(raw: unknown): UserProfile {
  const base = emptyProfile()
  if (!raw || typeof raw !== 'object') return base
  const o = raw as Record<string, unknown>
  const str = (k: keyof UserProfile) => (typeof o[k] === 'string' ? (o[k] as string) : '')
  const dynamic = Array.isArray(o.dynamic)
    ? (o.dynamic as unknown[])
        .filter((d): d is Record<string, unknown> => !!d && typeof d === 'object')
        .map((d, i) => ({
          id: typeof d.id === 'string' && d.id ? d.id : `dyn_${i}`,
          topic: typeof d.topic === 'string' ? d.topic : '',
          content: typeof d.content === 'string' ? d.content : '',
          asOf: typeof d.asOf === 'string' ? d.asOf : '',
          sensitivity: d.sensitivity === 'confidential' ? 'confidential' as const : 'normal' as const,
        }))
        .filter((d) => d.topic.trim() || d.content.trim())
    : []
  return {
    version: typeof o.version === 'number' ? o.version : 0,
    updatedAt: typeof o.updatedAt === 'number' ? o.updatedAt : 0,
    name: str('name'),
    role: str('role'),
    organization: str('organization'),
    background: str('background'),
    operatingPosture: str('operatingPosture'),
    focus: str('focus'),
    neverSay: Array.isArray(o.neverSay) ? (o.neverSay as unknown[]).filter((x): x is string => typeof x === 'string' && !!x.trim()) : base.neverSay,
    voiceNotes: str('voiceNotes'),
    dynamic,
  }
}

export function isProfileEmpty(p: UserProfile): boolean {
  return !p.name && !p.role && !p.background && !p.focus && !p.operatingPosture && p.dynamic.length === 0
}

export function isDynamicStale(item: DynamicContextItem, now: number, staleDays = DYNAMIC_STALE_DAYS_DEFAULT): boolean {
  const t = Date.parse(item.asOf)
  if (!Number.isFinite(t)) return true
  return now - t > staleDays * 86_400_000
}

function tokens(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2))
}

/**
 * Dynamic context is retrieved only when the meeting clearly relates to it:
 * its topic must appear in the meeting setup, people/orgs, or recent talk.
 * Company-specific facts must never leak into an unrelated meeting.
 */
export function selectRelevantDynamic(
  items: DynamicContextItem[],
  meetingText: string,
  now: number,
  staleDays = DYNAMIC_STALE_DAYS_DEFAULT,
): Array<DynamicContextItem & { stale: boolean }> {
  const hay = tokens(meetingText)
  return items
    .filter((item) => {
      const topicTokens = [...tokens(item.topic)]
      return topicTokens.length > 0 && topicTokens.every((t) => hay.has(t))
    })
    .map((item) => ({ ...item, stale: isDynamicStale(item, now, staleDays) }))
}

export function formatProfileForPrompt(
  p: UserProfile,
  relevantDynamic: Array<DynamicContextItem & { stale: boolean }> = [],
): string {
  const lines: string[] = []
  const add = (label: string, v: string) => {
    if (v.trim()) lines.push(`${label}: ${v.trim()}`)
  }
  add('name', p.name)
  add('role', p.role)
  add('organization', p.organization)
  add('background', p.background)
  add('operating_posture', p.operatingPosture)
  add('focus', p.focus)
  add('voice', p.voiceNotes)
  if (p.neverSay.length) lines.push(`never_say: ${p.neverSay.join('; ')}`)
  for (const d of relevantDynamic) {
    lines.push(`context[${d.topic}] (as of ${d.asOf || 'unknown'}${d.stale ? ', STALE - confirm before relying on it' : ''}): ${d.content.trim()}`)
  }
  return lines.join('\n')
}
