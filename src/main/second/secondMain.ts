/**
 * Second main-process wiring.
 *
 * Connects the LiveEngine to sessions, raw audio taps, STT connection state,
 * settings, windows, and IPC. Owns the post-meeting pipeline (state ->
 * report -> transcript retention) and the preflight self test.
 */

import { app, BrowserWindow, dialog, ipcMain, net } from 'electron'
import { writeFile } from 'fs/promises'
import { createLogger } from '../logger'
import { getSetting, saveSetting } from '../store'
import { databaseService, type Session } from '../services/database'
import { sessionManager } from '../services/sessionManager'
import { getCoachProvider, getDeepProvider } from '../services/ai/providerFactory'
import { addRawAudioTap, isCaptureRunning, startCapture, stopCapture } from '../systemAudioNative'
import { getDashboardWindow, getOverlayWindow } from '../windowManager'
import { LiveEngine, type LiveEngineResult } from './liveEngine'
import { runCoach } from './coachService'
import { HealthMonitor, type HealthView } from './healthMonitor'
import { diagnostics, latencyStats } from './diagnostics'
import { generateBrief, generateReport } from './briefingService'
import { PROMPT_VERSION } from './prompts'
import type { Card } from '../../shared/second/card'
import type { MeetingEvent, MeetingState, Turn } from '../../shared/second/meetingState'
import { ENERGY_RMS_FLOOR } from '../../shared/second/health'
import { PLAYBOOKS, PLAYBOOK_IDS, getPlaybook, type Playbook } from '../../shared/second/playbooks'
import type { Sensitivity } from '../../shared/second/interventionGate'
import {
  formatProfileForPrompt,
  normalizeProfile,
  selectRelevantDynamic,
  type UserProfile,
} from '../../shared/second/profile'
import {
  isSetupEmpty,
  normalizeSetup,
  type MeetingBrief,
  type MeetingSetupInput,
  type PostMeetingReport,
} from '../../shared/second/briefing'

const log = createLogger('Second')

const TICK_MS = 250
const HEALTH_BROADCAST_MS = 1000
const STATE_BROADCAST_MS = 400
const PENDING_SETUP_MAX_AGE_MS = 12 * 60 * 60_000
const PROFILE_HISTORY_LIMIT = 20
const SELF_TEST_MAX_MS = 30_000

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

interface PendingSetup {
  setup: MeetingSetupInput
  brief: MeetingBrief | null
  createdAt: number
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
  turnCount: number
}

const health = new HealthMonitor()
let engine: LiveEngine | null = null
let tickTimer: ReturnType<typeof setInterval> | null = null
let healthTimer: ReturnType<typeof setInterval> | null = null
let stateTimer: ReturnType<typeof setTimeout> | null = null
let lastReadinessLevel = ''
let audioManagerRef: { getSttConnection(): { recording: boolean; mic: boolean; system: boolean }; getIsRecording(): boolean } | null = null
let selfTest: { startedAt: number; micPeak: number; systemPeak: number; timer: ReturnType<typeof setTimeout> } | null = null
let initialized = false

function windows(): BrowserWindow[] {
  return [getOverlayWindow(), getDashboardWindow()].filter(
    (w): w is BrowserWindow => !!w && !w.isDestroyed(),
  )
}

function send(channel: string, payload: unknown): void {
  for (const w of windows()) {
    try { w.webContents.send(channel, payload) } catch { /* window closing */ }
  }
}

export function getProfile(): UserProfile {
  const p = normalizeProfile(getSetting('secondProfile'))
  if (!p.name) p.name = (getSetting('displayName') as string) || ''
  return p
}

function profileText(meetingText: string): string {
  const profile = getProfile()
  const staleDays = Number(getSetting('secondDynamicStaleDays')) || 30
  const relevant = selectRelevantDynamic(profile.dynamic, meetingText, Date.now(), staleDays)
  return formatProfileForPrompt(profile, relevant)
}

function sensitivityFor(playbook: Playbook): Sensitivity {
  const s = getSetting('secondSensitivity') as string
  return s === 'quiet' || s === 'balanced' || s === 'active' ? s : playbook.sensitivity
}

function retentionOn(): boolean {
  return getSetting('retainTranscripts') === true
}

export function toStateView(state: MeetingState): LiveStateView {
  const pb = getPlaybook(state.mode)
  return {
    mode: pb.id,
    modeLabel: pb.label,
    phase: state.phase,
    objective: state.objective,
    currentTopic: state.currentTopic,
    closeTarget: state.closeTarget,
    nextBestAction: state.nextBestAction,
    questionsOpen: state.questionsOpen.slice(-6).map((q) => ({ question: q.question, owner: q.owner })),
    commitments: state.commitments.slice(-6).map((c) => ({ who: c.who, action: c.action, due: c.due })),
    contradictions: state.contradictions.slice(-3).map((c) => ({ metric: c.metric, previous: c.previous, current: c.current })),
    objectionsOpen: state.objections.filter((o) => !o.resolved).slice(-4).map((o) => o.topic),
    turnCount: state.turnCount,
  }
}

function scheduleStateBroadcast(): void {
  if (stateTimer) return
  stateTimer = setTimeout(() => {
    stateTimer = null
    if (engine) send('second:state', toStateView(engine.getState()))
  }, STATE_BROADCAST_MS)
}

function currentHealth(): HealthView {
  const stt = audioManagerRef?.getSttConnection() ?? { mic: false, system: false }
  return health.view(Date.now(), stt, net.isOnline())
}

function broadcastHealth(): void {
  const view = currentHealth()
  if (view.readiness.level !== lastReadinessLevel) {
    diagnostics.record('health_change', { from: lastReadinessLevel || 'none', to: view.readiness.level })
    lastReadinessLevel = view.readiness.level
  }
  send('second:health', view)
}

function getEngine(): LiveEngine {
  if (engine) return engine
  engine = new LiveEngine({
    now: () => Date.now(),
    coach: async (input, opts) => {
      const { provider, model } = opts.deep ? await getDeepProvider() : await getCoachProvider()
      const started = Date.now()
      const result = await runCoach(provider, input, { cardId: opts.cardId, timeoutMs: opts.deep ? 30_000 : undefined })
      return { parsed: result, latencyMs: Date.now() - started, model }
    },
    profileText,
    sensitivity: sensitivityFor,
    coachEnabled: () => getSetting('secondCoachEnabled') !== false,
    onCard: (card: Card | null) => send('second:card', card),
    onState: () => scheduleStateBroadcast(),
    onCoachHealth: (ok, detail) => health.recordCoach(ok, Date.now(), detail),
    diag: (kind, data) => diagnostics.record(kind, data),
    promptVersion: PROMPT_VERSION,
  })
  return engine
}

function takePendingSetup(): PendingSetup | null {
  const raw = getSetting('secondPendingSetup') as PendingSetup | null
  saveSetting('secondPendingSetup' as never, null as never)
  if (!raw || typeof raw !== 'object' || !raw.setup) return null
  if (Date.now() - (raw.createdAt || 0) > PENDING_SETUP_MAX_AGE_MS) return null
  return { setup: normalizeSetup(raw.setup, PLAYBOOK_IDS), brief: raw.brief ?? null, createdAt: raw.createdAt }
}

export function parseSecondJson(json: string | null | undefined): SecondSessionData | null {
  if (!json) return null
  try {
    const data = JSON.parse(json) as SecondSessionData
    return data && data.version === 1 ? data : null
  } catch {
    return null
  }
}

function priorTurnsFrom(session: Session): Turn[] {
  return session.transcript
    .filter((e) => e.isFinal && e.text?.trim())
    .map((e, i) => ({ id: `turn_${i + 1}`, speaker: e.source === 'mic' ? 'you' : 'them', text: e.text, at: e.timestamp }))
}

function onSessionStart(session: Session, info: { resumed: boolean; incognito: boolean }): void {
  const eng = getEngine()
  let setup: MeetingSetupInput | null = null
  let brief: MeetingBrief | null = null
  let priorTurns: Turn[] = []

  if (info.resumed) {
    const prior = parseSecondJson(session.secondJson)
    setup = prior?.setup ?? null
    brief = prior?.brief ?? null
    priorTurns = priorTurnsFrom(session)
  } else {
    const pending = takePendingSetup()
    setup = pending?.setup ?? null
    brief = pending?.brief ?? null
  }

  eng.start({
    sessionId: session.id,
    modeId: setup?.mode ?? 'general',
    setup: setup
      ? {
          objective: setup.objective,
          idealOutcome: setup.idealOutcome,
          avoid: setup.avoid,
          people: setup.counterpartyPeople,
          organizations: setup.counterpartyOrg ? [setup.counterpartyOrg] : [],
        }
      : null,
    brief,
    priorTurns,
  })
  health.start(Date.now())
  lastReadinessLevel = ''

  if (!info.incognito) {
    const data: SecondSessionData = {
      version: 1,
      promptVersion: PROMPT_VERSION,
      modeId: eng.getPlaybook().id,
      retention: retentionOn() ? 'on' : 'off',
      setup,
      brief,
      state: null,
      metrics: null,
      report: null,
      reportStatus: 'none',
    }
    try {
      databaseService.updateSession(session.id, { secondJson: JSON.stringify(data) })
    } catch (err) {
      log.error('Failed to persist Second setup (non-fatal):', err)
    }
  }

  if (!tickTimer) tickTimer = setInterval(() => engine?.tick(), TICK_MS)
  if (!healthTimer) healthTimer = setInterval(broadcastHealth, HEALTH_BROADCAST_MS)
  send('second:state', toStateView(eng.getState()))
  broadcastHealth()
}

function onEntry(entry: { id: string; source: 'mic' | 'system'; text: string; isFinal: boolean }): void {
  if (entry.isFinal && entry.text?.trim()) health.recordTranscript(entry.source, Date.now())
  engine?.onEntry({ id: entry.id, source: entry.source, text: entry.text ?? '', isFinal: entry.isFinal })
}

async function onSessionEnd(session: Session, info: { incognito: boolean }): Promise<void> {
  const result = engine?.stop() ?? null
  health.stop()
  if (tickTimer) { clearInterval(tickTimer); tickTimer = null }
  if (healthTimer) { clearInterval(healthTimer); healthTimer = null }
  broadcastHealth()
  send('second:card', null)
  if (info.incognito || !result || result.sessionId !== session.id) return

  await runPostMeetingPipeline(session.id, result)
}

function metricsOf(result: LiveEngineResult): SecondSessionData['metrics'] {
  const stats = latencyStats(diagnostics.all())
  return {
    cards: result.metrics.cards,
    suppressed: result.metrics.suppressed,
    rejected: result.metrics.rejected,
    coachRuns: result.metrics.coachRuns,
    coachErrors: result.metrics.coachErrors,
    p50Ms: stats.p50,
    p95Ms: stats.p95,
  }
}

function readData(sessionId: string): SecondSessionData | null {
  try {
    return parseSecondJson(databaseService.getSession(sessionId)?.secondJson)
  } catch {
    return null
  }
}

function writeData(sessionId: string, data: SecondSessionData): void {
  databaseService.updateSession(sessionId, { secondJson: JSON.stringify(data) })
  send('second:session-updated', sessionId)
}

async function runPostMeetingPipeline(sessionId: string, result: LiveEngineResult): Promise<void> {
  const retain = retentionOn()
  const prior = readData(sessionId)
  const base: SecondSessionData = {
    version: 1,
    promptVersion: PROMPT_VERSION,
    modeId: result.modeId,
    retention: prior?.retention ?? (retain ? 'on' : 'off'),
    setup: prior?.setup ?? null,
    brief: result.brief,
    state: { ...result.state, currentCard: null },
    metrics: metricsOf(result),
    report: null,
    reportStatus: result.turns.length > 0 ? 'pending' : 'none',
    ...(retain ? { events: result.events } : {}),
  }
  try {
    writeData(sessionId, base)
  } catch (err) {
    log.error('Failed to persist meeting state:', err)
  }

  if (result.turns.length > 0) {
    const started = Date.now()
    try {
      const { provider, model } = await getDeepProvider()
      const report = await generateReport(provider, {
        state: result.state,
        turns: result.turns,
        brief: result.brief,
        profileText: profileText(result.state.organizations.join(' ') + ' ' + result.state.objective),
        modeId: result.modeId,
      })
      const latest = readData(sessionId) ?? base
      writeData(sessionId, { ...latest, report, reportStatus: report ? 'ready' : 'failed', reportError: report ? undefined : 'Report could not be parsed' })
      diagnostics.record('report', { ok: !!report, latencyMs: Date.now() - started, model })
    } catch (err) {
      const latest = readData(sessionId) ?? base
      writeData(sessionId, { ...latest, reportStatus: 'failed', reportError: err instanceof Error ? err.message : 'Report failed' })
      diagnostics.record('report', { ok: false, errorClass: err instanceof Error ? err.name : 'unknown' })
    }
  }

  // Let sessionManager register its notes job (started right after onEnd),
  // then wait for it so title/summary/action items are written from the
  // transcript before the transcript is deleted.
  if ((readData(sessionId)?.retention ?? 'off') === 'off') {
    await new Promise((r) => setImmediate(r))
    await sessionManager.waitForNotes(sessionId)
    try {
      databaseService.purgeSessionTranscript(sessionId)
      send('sessions:list-updated', null)
      send('second:session-updated', sessionId)
      log.info('Transcript not retained (retention off):', sessionId)
    } catch (err) {
      log.error('Transcript purge failed:', err)
    }
  }
}

/** Crash/quit safety: purge transcripts left behind by retention-off sessions. */
function sweepPendingPurges(): void {
  try {
    for (const id of databaseService.findSessionsPendingTranscriptPurge()) {
      databaseService.purgeSessionTranscript(id)
      log.info('Purged leftover transcript (retention off):', id)
    }
  } catch (err) {
    log.error('Retention sweep failed:', err)
  }
}

function onRawAudio(buf: Buffer, source: 'mic' | 'system'): void {
  const now = Date.now()
  if (health.isActive()) health.recordAudio(source, buf, now)
  if (selfTest) {
    const rms = peakRms(buf)
    if (source === 'mic') selfTest.micPeak = Math.max(selfTest.micPeak, rms)
    else selfTest.systemPeak = Math.max(selfTest.systemPeak, rms)
  }
}

function peakRms(buf: Buffer): number {
  const samples = Math.floor(buf.length / 2)
  if (!samples) return 0
  let sum = 0
  for (let i = 0; i < samples; i++) {
    const s = buf.readInt16LE(i * 2)
    sum += s * s
  }
  return Math.sqrt(sum / samples)
}

function finishSelfTest(): { micPeakRms: number; systemPeakRms: number; micOk: boolean; systemOk: boolean } {
  const t = selfTest
  selfTest = null
  if (t) clearTimeout(t.timer)
  if (isCaptureRunning() && !audioManagerRef?.getIsRecording()) stopCapture()
  const out = {
    micPeakRms: Math.round(t?.micPeak ?? 0),
    systemPeakRms: Math.round(t?.systemPeak ?? 0),
    micOk: (t?.micPeak ?? 0) > ENERGY_RMS_FLOOR * 2,
    systemOk: (t?.systemPeak ?? 0) > ENERGY_RMS_FLOOR * 2,
  }
  diagnostics.record('self_test', { micOk: out.micOk, systemOk: out.systemOk, micPeak: out.micPeakRms, systemPeak: out.systemPeakRms })
  return out
}

function saveProfile(raw: unknown): UserProfile {
  const prev = normalizeProfile(getSetting('secondProfile'))
  const next = normalizeProfile(raw)
  next.version = prev.version + 1
  next.updatedAt = Date.now()
  const history = Array.isArray(getSetting('secondProfileHistory')) ? (getSetting('secondProfileHistory') as unknown[]) : []
  if (prev.version > 0) history.push(prev)
  saveSetting('secondProfileHistory' as never, history.slice(-PROFILE_HISTORY_LIMIT) as never)
  saveSetting('secondProfile' as never, next as never)
  return next
}

function diagnosticsBundle(): string {
  const events = diagnostics.all()
  return JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      app: { version: app.getVersion(), platform: process.platform, arch: process.arch, electron: process.versions.electron },
      promptVersion: PROMPT_VERSION,
      settings: {
        aiProvider: getSetting('aiProvider'),
        sttProvider: getSetting('sttProvider'),
        transcriptionLanguage: getSetting('transcriptionLanguage'),
        secondCoachEnabled: getSetting('secondCoachEnabled'),
        secondSensitivity: getSetting('secondSensitivity'),
        secondCoachModel: getSetting('secondCoachModel') || '(default)',
        secondDeepModel: getSetting('secondDeepModel') || '(default)',
        retainTranscripts: getSetting('retainTranscripts'),
      },
      health: currentHealth(),
      latency: latencyStats(events),
      events,
      note: 'Contains no audio, transcript text, card text, profile content, or API keys.',
    },
    null,
    2,
  )
}

export function setSecondAudioManager(am: NonNullable<typeof audioManagerRef>): void {
  audioManagerRef = am
}

/** Explicit card request from the Assist-card hotkey. */
export function requestSecondCard(): void {
  if (!engine?.isActive()) return
  void engine.request('user_requested')
}

export function initSecond(): void {
  if (initialized) return
  initialized = true

  sessionManager.addLiveListener({
    onStart: (session, info) => onSessionStart(session, info),
    onEntry: (entry) => onEntry(entry as { id: string; source: 'mic' | 'system'; text: string; isFinal: boolean }),
    onEnd: (session, info) => { void onSessionEnd(session, info) },
  })
  addRawAudioTap(onRawAudio)
  sweepPendingPurges()

  ipcMain.handle('second:get-snapshot', () => ({
    active: !!engine?.isActive(),
    card: engine?.isActive() ? engine.getCard() : null,
    state: engine?.isActive() ? toStateView(engine.getState()) : null,
    brief: engine?.isActive() ? engine.getBrief() : null,
    health: currentHealth(),
    coachEnabled: getSetting('secondCoachEnabled') !== false,
    promptVersion: PROMPT_VERSION,
  }))

  ipcMain.handle('second:request-card', async (_e, kind: unknown, prompt: unknown) => {
    if (!engine?.isActive()) return { ok: false, error: 'Start a meeting first' }
    const k = kind === 'think_deeper' ? 'think_deeper' : 'user_requested'
    const p = typeof prompt === 'string' ? prompt.slice(0, 2000) : undefined
    return engine.request(k, p)
  })
  ipcMain.handle('second:dismiss-card', () => { engine?.dismissCard(); return true })
  ipcMain.handle('second:hold-card', () => { engine?.holdCard(); return true })

  ipcMain.handle('second:playbooks', () =>
    PLAYBOOK_IDS.map((id) => ({ id, label: PLAYBOOKS[id].label, objective: PLAYBOOKS[id].objective })),
  )

  ipcMain.handle('second:get-profile', () => ({
    profile: getProfile(),
    historyCount: Array.isArray(getSetting('secondProfileHistory')) ? (getSetting('secondProfileHistory') as unknown[]).length : 0,
  }))
  ipcMain.handle('second:save-profile', (_e, raw: unknown) => saveProfile(raw))

  ipcMain.handle('second:get-pending-setup', () => {
    const raw = getSetting('secondPendingSetup') as PendingSetup | null
    if (!raw?.setup || Date.now() - (raw.createdAt || 0) > PENDING_SETUP_MAX_AGE_MS) return null
    return raw
  })
  ipcMain.handle('second:set-pending-setup', (_e, rawSetup: unknown, rawBrief: unknown) => {
    if (rawSetup === null) {
      saveSetting('secondPendingSetup' as never, null as never)
      return null
    }
    const setup = normalizeSetup(rawSetup, PLAYBOOK_IDS)
    const brief = rawBrief && typeof rawBrief === 'object' ? (rawBrief as MeetingBrief) : null
    const pending: PendingSetup = { setup, brief, createdAt: Date.now() }
    saveSetting('secondPendingSetup' as never, pending as never)
    return pending
  })
  ipcMain.handle('second:generate-brief', async (_e, rawSetup: unknown) => {
    const setup = normalizeSetup(rawSetup, PLAYBOOK_IDS)
    if (isSetupEmpty(setup)) return { ok: false, error: 'Add who you are meeting or what you want from it first.' }
    const started = Date.now()
    try {
      const { provider, model } = await getDeepProvider()
      const meetingText = [setup.title, setup.counterpartyOrg, setup.counterpartyPeople.join(' '), setup.objective, setup.notes.slice(0, 2000)].join(' ')
      const brief = await generateBrief(provider, setup, profileText(meetingText))
      diagnostics.record('brief', { ok: !!brief, latencyMs: Date.now() - started, model })
      if (!brief) return { ok: false, error: 'The model did not return a usable brief. Try again.' }
      saveSetting('secondPendingSetup' as never, { setup, brief, createdAt: Date.now() } as never)
      return { ok: true, brief }
    } catch (err) {
      diagnostics.record('brief', { ok: false, errorClass: err instanceof Error ? err.name : 'unknown' })
      return { ok: false, error: err instanceof Error ? err.message : 'Brief failed' }
    }
  })

  ipcMain.handle('second:get-session-data', (_e, sessionId: unknown) => {
    if (typeof sessionId !== 'string') return null
    return readData(sessionId)
  })
  ipcMain.handle('second:regenerate-report', async (_e, sessionId: unknown) => {
    if (typeof sessionId !== 'string') return { ok: false, error: 'Invalid session' }
    const session = databaseService.getSession(sessionId)
    const data = parseSecondJson(session?.secondJson)
    if (!session || !data?.state) return { ok: false, error: 'No meeting state for this session' }
    const turns = priorTurnsFrom(session)
    if (turns.length === 0) return { ok: false, error: 'The transcript was not retained, so the report cannot be regenerated.' }
    try {
      const { provider } = await getDeepProvider()
      const report = await generateReport(provider, { state: data.state, turns, brief: data.brief, profileText: profileText(data.state.objective), modeId: data.modeId })
      writeData(sessionId, { ...data, report, reportStatus: report ? 'ready' : 'failed' })
      return { ok: !!report, report }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Report failed' }
    }
  })
  ipcMain.handle('second:apply-context-update', (_e, sessionId: unknown, index: unknown) => {
    if (typeof sessionId !== 'string' || typeof index !== 'number') return { ok: false }
    const data = readData(sessionId)
    const update = data?.report?.contextUpdates?.[index]
    if (!data || !update) return { ok: false }
    const profile = getProfile()
    const today = new Date().toISOString().slice(0, 10)
    const existing = profile.dynamic.find((d) => d.topic.toLowerCase() === update.topic.toLowerCase())
    if (existing) {
      existing.content = `${existing.content}\n${update.content}`.trim()
      existing.asOf = today
    } else {
      profile.dynamic.push({ id: `dyn_${Date.now()}`, topic: update.topic, content: update.content, asOf: today, sensitivity: 'normal' })
    }
    saveProfile(profile)
    const report = { ...data.report!, contextUpdates: data.report!.contextUpdates.filter((_, i) => i !== index) }
    writeData(sessionId, { ...data, report })
    return { ok: true }
  })

  ipcMain.handle('second:diagnostics-preview', () => diagnosticsBundle())
  ipcMain.handle('second:diagnostics-export', async () => {
    const owner = getDashboardWindow()
    const opts = { defaultPath: `second-diagnostics-${Date.now()}.json`, filters: [{ name: 'JSON', extensions: ['json'] }] }
    const result = owner ? await dialog.showSaveDialog(owner, opts) : await dialog.showSaveDialog(opts)
    if (result.canceled || !result.filePath) return { ok: false }
    await writeFile(result.filePath, diagnosticsBundle(), 'utf8')
    return { ok: true, path: result.filePath }
  })

  ipcMain.handle('second:self-test-start', () => {
    if (audioManagerRef?.getIsRecording()) return { ok: false, error: 'Stop the current recording before running the self test.' }
    if (selfTest) finishSelfTest()
    const started = isCaptureRunning() || startCapture()
    if (!started) return { ok: false, error: 'Audio capture could not start. Check Microphone and Screen Recording permissions.' }
    selfTest = {
      startedAt: Date.now(),
      micPeak: 0,
      systemPeak: 0,
      timer: setTimeout(() => { if (selfTest) finishSelfTest() }, SELF_TEST_MAX_MS),
    }
    return { ok: true }
  })
  ipcMain.handle('second:self-test-finish', () => finishSelfTest())
  ipcMain.handle('second:self-test-levels', () => ({
    micPeakRms: Math.round(selfTest?.micPeak ?? 0),
    systemPeakRms: Math.round(selfTest?.systemPeak ?? 0),
  }))

  log.info('Second engine initialized, prompt', PROMPT_VERSION)
}

export function shutdownSecond(): void {
  if (tickTimer) { clearInterval(tickTimer); tickTimer = null }
  if (healthTimer) { clearInterval(healthTimer); healthTimer = null }
  if (selfTest) finishSelfTest()
}
