import { useState, useEffect, useCallback } from 'react'
import { createLogger } from '../../lib/logger'
import { Header } from './Header'

const log = createLogger('Dashboard')
import { SessionList } from './SessionList'
import { RecordingChip } from './RecordingChip'
import { SessionDetail } from './SessionDetail'
import { SettingsModal } from './SettingsModal'
import { SearchResultsView } from './SearchResultsView'
import { AskView } from './AskView'
import { UpdateBanner } from './UpdateBanner'
import { MacUpdateModal } from './MacUpdateModal'
import { MeetingPrepModal } from './MeetingPrepModal'
import type { CalendarEvent } from '../../../../shared/second/google'
import { OverlayTour } from '../OverlayTour'
import { detectMacPlatform } from '../../lib/shortcutLabels'

interface TranscriptEntry {
  id: string
  source: 'mic' | 'system'
  text: string
  timestamp: number
  isFinal: boolean
}

interface SessionDetailData {
  id: string
  title: string
  transcript: TranscriptEntry[]
  summary: string | null
  insightsJson?: string | null
  actionItemsJson?: string | null
  followUpEmail?: string | null
  segmentsJson?: string | null
  durationSeconds: number
  startedAt: number
  modeId: string | null
}

interface DashboardProps {
  initialUserProfile?: { name: string; email: string; avatarUrl: string | null } | null
}

export function Dashboard({ initialUserProfile }: DashboardProps = {}) {
  const [stealth, setStealth] = useState(false)
  const [isRecording, setIsRecording] = useState(false)
  // recordingStartedAt/priorDurationSeconds drive the live timer. For a
  // resumed session they differ from startedAt (the first sitting), which
  // would otherwise make the timer count the gap between sittings.
  const [activeSession, setActiveSession] = useState<{
    id: string
    title: string
    startedAt: number
    recordingStartedAt: number
    priorDurationSeconds: number
  } | null>(null)
  const [recordingDuration, setRecordingDuration] = useState(0)
  const [selectedSession, setSelectedSession] = useState<SessionDetailData | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsInitialTab, setSettingsInitialTab] = useState<'general' | undefined>(undefined)
  const [showOverlayTour, setShowOverlayTour] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [activeSearchQuery, setActiveSearchQuery] = useState<string | null>(null)
  const [askOpen, setAskOpen] = useState(false)

  useEffect(() => {
    async function loadState() {
      const val = await window.second.storeGet('stealthEnabled')
      setStealth(val as boolean)
    }
    loadState()

    async function syncActiveSession() {
      try {
        const active = await window.second.sessions.getActive()
        const session = active || (await window.second.sessions.getInProgress())
        if (session) {
          const startedAt = session.startedAt ?? session.createdAt ?? Date.now()
          setActiveSession({
            id: session.id,
            title: session.title || 'Untitled session',
            startedAt,
            recordingStartedAt: active?.recordingStartedAt ?? startedAt,
            priorDurationSeconds: active?.priorDurationSeconds ?? 0,
          })
        }
      } catch (error) {
        log.error('Failed to load active session:', error)
      }
    }

    const unsub = window.second.onStealthChanged((enabled) => {
      setStealth(enabled)
    })

    const unsubRecording = window.second.onRecordingStateChanged((state) => {
      setIsRecording(state.isRecording)
      if (state.isRecording) {
        syncActiveSession()
      } else {
        const sessionId = state.endedSessionId
        setActiveSession(null)
        if (sessionId) {
          window.second.sessions.get(sessionId).then((fullSession) => {
            if (fullSession) setSelectedSession(fullSession)
          }).catch(() => {})
        }
      }
    })

    const unsubSessionUpdated = window.second.sessions.onSessionUpdated((session) => {
      if (!session) return
      setActiveSession((prev) => {
        if (prev && prev.id !== session.id) return prev
        const startedAt = session.startedAt || prev?.startedAt || Date.now()
        return {
          id: session.id,
          title: session.title || prev?.title || 'Untitled session',
          startedAt,
          recordingStartedAt: session.recordingStartedAt ?? prev?.recordingStartedAt ?? startedAt,
          priorDurationSeconds: session.priorDurationSeconds ?? prev?.priorDurationSeconds ?? 0,
        }
      })
    })

    const unsubListUpdated = window.second.sessions.onListUpdated(() => {
      setSelectedSession((prev) => {
        if (!prev) return prev
        const prevId = prev.id
        window.second.sessions.get(prevId).then((updated) => {
          if (updated) {
            setSelectedSession((current) => current?.id === prevId ? updated : current)
          }
        }).catch(() => {})
        return prev
      })
    })

    window.second.audioGetState().then((state) => {
      setIsRecording(state.isRecording)
      if (state.isRecording) {
        syncActiveSession()
      } else {
        setActiveSession(null)
      }
    }).catch((err) => log.error('Failed to get audio state:', err))

    const unsubTraySettings = window.second.on('tray:open-settings', () => {
      setSettingsOpen(true)
    })

    return () => {
      unsub()
      unsubRecording()
      unsubSessionUpdated()
      unsubListUpdated()
      unsubTraySettings()
    }
  }, [])

  useEffect(() => {
    if (!activeSession) {
      setRecordingDuration(0)
      return
    }

    const tick = () => {
      const current = Math.max(0, Math.floor((Date.now() - activeSession.recordingStartedAt) / 1000))
      setRecordingDuration(activeSession.priorDurationSeconds + current)
    }

    tick()
    const interval = setInterval(tick, 1000)
    return () => clearInterval(interval)
  }, [activeSession])

  const handleToggleStealth = async () => {
    const newValue = !stealth
    await window.second.windowSetStealth(newValue)
    setStealth(newValue)
  }

  const [prepOpen, setPrepOpen] = useState(false)
  const [prepEvent, setPrepEvent] = useState<CalendarEvent | null>(null)

  // "Prepare now" reminder (Google Calendar) opens prep for that meeting.
  useEffect(() => window.second.google.onPrepareEvent((event) => {
    setPrepEvent(event)
    setPrepOpen(true)
  }), [])

  const handleStartSecond = async () => {
    if (!isRecording) {
      await window.second.windowShowOverlay()
    }
    window.second.sendHotkeyToggleRecording()
  }

  const handleStopRecording = () => {
    try {
      window.second.sendHotkeyToggleRecording()
    } catch (error) {
      log.error('Failed to stop recording:', error)
    }
  }

  const handleOpenSettings = () => {
    setSettingsInitialTab(undefined)
    setSettingsOpen(true)
  }

  const handleSessionSelect = async (session: { id: string }) => {
    try {
      const fullSession = await window.second.sessions.get(session.id)
      if (fullSession) {
        setSelectedSession(fullSession)
      }
    } catch (error) {
      log.error('Failed to load session:', error)
    }
  }

  const handleBackToList = () => {
    setSelectedSession(null)
  }

  const handleSearchSubmit = useCallback((query: string) => {
    setActiveSearchQuery(query)
    setSelectedSession(null)
    setAskOpen(false)
  }, [])

  const handleSearchBack = useCallback(() => {
    setActiveSearchQuery(null)
    setSearchQuery('')
  }, [])

  const handleUpdateTitle = async (sessionId: string, newTitle: string) => {
    try {
      await window.second.sessions.updateTitle(sessionId, newTitle)
      setSelectedSession((prev) => (prev ? { ...prev, title: newTitle } : null))
    } catch (error) {
      log.error('Failed to update title:', error)
    }
  }

  const isMac = detectMacPlatform()

  return (
    <div className="flex flex-col h-screen bg-white">
      {/* Mac: empty drag strip under hiddenInset traffic lights. Windows:
          keep the existing frameless title label — do not add a spacer. */}
      <div
        className="flex items-center justify-center shrink-0 h-9 bg-white border-b border-gray-100 text-xs font-medium text-gray-400 select-none"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        {isMac ? null : 'Second'}
      </div>
      <Header
        stealth={stealth}
        onToggleStealth={handleToggleStealth}
        onStartSecond={handleStartSecond}
        onPrepareMeeting={() => { setPrepEvent(null); setPrepOpen(true) }}
        isRecording={isRecording}
        onOpenSettings={handleOpenSettings}
        onReplayTour={() => setShowOverlayTour(true)}
        initialUserProfile={initialUserProfile}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        onSearchSubmit={handleSearchSubmit}
        onSessionSelect={handleSessionSelect}
        onOpenAsk={() => {
          setSelectedSession(null)
          setActiveSearchQuery(null)
          setAskOpen(true)
        }}
      />

      <UpdateBanner />

      <div className="flex-1 flex flex-col overflow-hidden">
        {selectedSession ? (
          <SessionDetail
            session={selectedSession}
            onBack={handleBackToList}
            onUpdateTitle={handleUpdateTitle}
            isRecording={isRecording}
            activeSessionId={activeSession?.id ?? null}
          />
        ) : activeSearchQuery ? (
          <SearchResultsView
            query={activeSearchQuery}
            onBack={handleSearchBack}
            onSessionSelect={handleSessionSelect}
          />
        ) : askOpen ? (
          <AskView
            onBack={() => setAskOpen(false)}
            onSessionSelect={(s) => {
              setAskOpen(false)
              handleSessionSelect(s)
            }}
          />
        ) : (
          <SessionList
            onSessionSelect={handleSessionSelect}
            activeSessionId={activeSession?.id || null}
            searchQuery={searchQuery}
            activeSession={
              activeSession
                ? { ...activeSession, durationSeconds: recordingDuration }
                : null
            }
          />
        )}
      </div>

      {activeSession && (
        <RecordingChip
          sessionTitle={activeSession.title}
          duration={recordingDuration}
          onStop={handleStopRecording}
        />
      )}

      <MeetingPrepModal
        isOpen={prepOpen}
        initialEvent={prepEvent}
        onClose={() => setPrepOpen(false)}
        onStart={() => { void handleStartSecond() }}
      />
      <SettingsModal
        isOpen={settingsOpen}
        onClose={() => { setSettingsOpen(false); setSettingsInitialTab(undefined) }}
        initialTab={settingsInitialTab}
      />

      {showOverlayTour && (
        <div className="fixed inset-0 z-[300] bg-white">
          <div className="flex items-center justify-center h-full">
            <div className="w-full max-w-md px-6">
              <OverlayTour
                onBack={() => setShowOverlayTour(false)}
                onNext={() => setShowOverlayTour(false)}
              />
            </div>
          </div>
        </div>
      )}

      <MacUpdateModal isRecording={isRecording} />
    </div>
  )
}
