/**
 * Shapes exchanged between the main process and the renderer over IPC.
 * Shared so both sides compile against the same contract.
 */

import type { Card } from './card'
import type { HealthSnapshot, Readiness } from './health'
import type { MeetingEvent, MeetingState } from './meetingState'
import type { MeetingBrief, MeetingSetupInput, PostMeetingReport } from './briefing'
import type { UserProfile } from './profile'

export interface HealthView {
  snapshot: HealthSnapshot
  readiness: Readiness
  /** 0..1 meter levels for the UI. */
  levels: { mic: number; system: number }
}

/** Compact state view for the live surface's meeting-state drawer. */
export interface LiveStateView {
  mode: string
  modeLabel: string
  phase: string
  objective: string
  currentTopic: string
  closeTarget: string
  nextBestAction: string
  questionsOpen: Array<{ question: string; owner: string }>
  commitments: Array<{ who: string; action: string; due?: string }>
  contradictions: Array<{ metric: string; previous: number; current: number }>
  objectionsOpen: string[]
  gaps: Array<{ from: number; to: number; reason: string }>
  startedAt: number
  turnCount: number
}

export interface LiveSnapshot {
  active: boolean
  card: Card | null
  state: LiveStateView | null
  brief: MeetingBrief | null
  health: HealthView
  coachEnabled: boolean
  promptVersion: string
}

export interface SecondSessionData {
  version: 1
  promptVersion: string
  modeId: string
  retention: 'on' | 'off'
  setup: MeetingSetupInput | null
  brief: MeetingBrief | null
  state: MeetingState | null
  metrics: { cards: number; suppressed: number; rejected: number; coachRuns: number; coachErrors: number; p50Ms: number | null; p95Ms: number | null } | null
  report: PostMeetingReport | null
  reportStatus: 'none' | 'pending' | 'ready' | 'failed'
  reportError?: string
  /** Event log, only kept when transcripts are retained (it contains turns). */
  events?: MeetingEvent[]
}

export interface PendingSetup {
  setup: MeetingSetupInput
  brief: MeetingBrief | null
  createdAt: number
}

export type CardRequestOutcome =
  | { ok: true; card: Card | null; reason: string }
  | { ok: false; error: string }

export interface SelfTestResult {
  micPeakRms: number
  systemPeakRms: number
  micOk: boolean
  systemOk: boolean
}

export interface PlaybookSummary {
  id: string
  label: string
  objective: string
}

export interface ProfileResponse {
  profile: UserProfile
  historyCount: number
}
