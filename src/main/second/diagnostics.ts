/**
 * Safe local telemetry for reproducing failures.
 *
 * Records state transitions, latencies, reconnects, error classes, token-free
 * model metadata, and prompt version. Never records raw audio, transcript
 * text, card text, profile content, or keys. The export shows exactly what
 * will be shared before the user saves it.
 */

export type DiagnosticKind =
  | 'session_start'
  | 'session_end'
  | 'health_change'
  | 'coach_run'
  | 'coach_skip'
  | 'card_published'
  | 'card_suppressed'
  | 'card_rejected'
  | 'card_cleared'
  | 'coach_error'
  | 'self_test'
  | 'brief'
  | 'report'
  | 'error'

export interface DiagnosticEvent {
  at: number
  kind: DiagnosticKind
  /** Only codes, counts, durations, model ids, versions. Never content. */
  data?: Record<string, string | number | boolean | null>
}

const MAX_EVENTS = 2000

/** Keys allowed in diagnostic data. Anything else is dropped at record time. */
const SAFE_KEYS = new Set([
  'reason', 'mode', 'urgency', 'confidence', 'latencyMs', 'model', 'promptVersion', 'channel', 'from', 'to',
  'level', 'turnCount', 'cards', 'suppressed', 'durationS', 'errorClass', 'provider', 'micPeak', 'systemPeak',
  'micOk', 'systemOk', 'ok', 'words', 'warnings', 'meetingMode', 'resumed', 'incognito', 'p50', 'p95', 'count',
])

export class DiagnosticsLog {
  private events: DiagnosticEvent[] = []

  record(kind: DiagnosticKind, data?: Record<string, unknown>, at = Date.now()): void {
    let safe: DiagnosticEvent['data']
    if (data) {
      safe = {}
      for (const [k, v] of Object.entries(data)) {
        if (!SAFE_KEYS.has(k)) continue
        if (typeof v === 'string') safe[k] = v.slice(0, 80)
        else if (typeof v === 'number' || typeof v === 'boolean' || v === null) safe[k] = v
      }
    }
    this.events.push({ at, kind, ...(safe ? { data: safe } : {}) })
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS)
  }

  all(): DiagnosticEvent[] {
    return this.events.slice()
  }

  clear(): void {
    this.events = []
  }
}

export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[idx]
}

export function latencyStats(log: DiagnosticEvent[]): { count: number; p50: number | null; p95: number | null } {
  const values = log
    .filter((e) => e.kind === 'coach_run' && typeof e.data?.latencyMs === 'number')
    .map((e) => e.data!.latencyMs as number)
  return { count: values.length, p50: percentile(values, 50), p95: percentile(values, 95) }
}

export const diagnostics = new DiagnosticsLog()
