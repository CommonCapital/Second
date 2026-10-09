/**
 * Independent health channels and the preflight truth table.
 *
 * Second is only "ready" when the underlying audio and provider paths are
 * observably live. A connected socket without verified audio energy is NOT
 * ready. Every status maps to a plain-English message and a concrete action.
 */

export type ChannelId = 'mic' | 'system' | 'sttYou' | 'sttThem' | 'coach' | 'network'

export type ChannelStatus =
  | 'off'         // not running (no session)
  | 'unverified'  // running, but no proof of life yet
  | 'live'        // proven: audio energy / transcript / successful call
  | 'silent'      // samples flowing but no energy for a long time
  | 'connecting'  // provider (re)connecting
  | 'down'        // failed / no data at all

export interface ChannelHealth {
  status: ChannelStatus
  detail?: string
  /** Last time this channel proved it was alive (ms epoch). */
  lastOkAt?: number
}

export type HealthSnapshot = Record<ChannelId, ChannelHealth>

export type ReadinessLevel = 'ready' | 'degraded' | 'not_ready' | 'offline' | 'idle'

export interface Readiness {
  level: ReadinessLevel
  message: string
  action?: string
}

export const CHANNEL_LABELS: Record<ChannelId, string> = {
  mic: 'Mic',
  system: 'Meeting audio',
  sttYou: 'You transcript',
  sttThem: 'Them transcript',
  coach: 'Coach',
  network: 'Network',
}

/** No audio chunks at all for this long => capture path is dead. */
export const AUDIO_DEAD_MS = 5_000
/** Chunks flowing but no energy for this long => treat as silent. */
export const AUDIO_SILENT_MS = 45_000
/** RMS (int16) above this counts as real signal, not the noise floor. */
export const ENERGY_RMS_FLOOR = 60

export function emptyHealth(): HealthSnapshot {
  return {
    mic: { status: 'off' },
    system: { status: 'off' },
    sttYou: { status: 'off' },
    sttThem: { status: 'off' },
    coach: { status: 'off' },
    network: { status: 'live' },
  }
}

/**
 * Derive an audio channel status from observed timestamps.
 * `startedAt` is when capture started; `lastChunkAt` when any PCM arrived;
 * `lastEnergyAt` when PCM above the noise floor arrived.
 */
export function audioChannelStatus(opts: {
  active: boolean
  now: number
  startedAt: number
  lastChunkAt: number
  lastEnergyAt: number
}): ChannelHealth {
  if (!opts.active) return { status: 'off' }
  const sinceStart = opts.now - opts.startedAt
  if (!opts.lastChunkAt) {
    return sinceStart > AUDIO_DEAD_MS
      ? { status: 'down', detail: 'No audio is arriving from capture' }
      : { status: 'unverified', detail: 'Waiting for audio' }
  }
  if (opts.now - opts.lastChunkAt > AUDIO_DEAD_MS) {
    return { status: 'down', detail: 'Audio stopped arriving', lastOkAt: opts.lastEnergyAt || undefined }
  }
  if (!opts.lastEnergyAt) return { status: 'unverified', detail: 'Audio flowing, no speech heard yet' }
  if (opts.now - opts.lastEnergyAt > AUDIO_SILENT_MS) {
    return { status: 'silent', detail: 'No sound for a while', lastOkAt: opts.lastEnergyAt }
  }
  return { status: 'live', lastOkAt: opts.lastEnergyAt }
}

/** PCM16 mono RMS. */
export function pcmRms(buf: Uint8Array): number {
  const samples = Math.floor(buf.byteLength / 2)
  if (samples === 0) return 0
  const view = new DataView(buf.buffer, buf.byteOffset, samples * 2)
  let sum = 0
  for (let i = 0; i < samples; i++) {
    const s = view.getInt16(i * 2, true)
    sum += s * s
  }
  return Math.sqrt(sum / samples)
}

const isUp = (c: ChannelHealth) => c.status === 'live'
const isAudioBad = (c: ChannelHealth) => c.status === 'silent' || c.status === 'down'
const isSttBad = (c: ChannelHealth) => c.status === 'down'

/**
 * Preflight truth table. Order matters: the most fundamental failure wins.
 */
export function deriveReadiness(h: HealthSnapshot): Readiness {
  const running = h.mic.status !== 'off' || h.system.status !== 'off'
  if (!running) return { level: 'idle', message: 'Not recording' }

  if (h.network.status === 'down') {
    return {
      level: 'offline',
      message: 'Offline, reconnecting',
      action: 'Capture continues; the transcript gap will be marked when the network returns.',
    }
  }

  if (isAudioBad(h.mic) && isAudioBad(h.system)) {
    return {
      level: 'not_ready',
      message: 'No audio from either side',
      action: 'Check Microphone and Screen Recording permissions, then restart the session.',
    }
  }
  if (isAudioBad(h.system) && !isAudioBad(h.mic)) {
    return {
      level: 'degraded',
      message: 'I can hear you, not the meeting',
      action: 'Check Screen Recording permission and that meeting audio is playing on this Mac.',
    }
  }
  if (isAudioBad(h.mic) && !isAudioBad(h.system)) {
    return {
      level: 'degraded',
      message: 'I can hear the meeting, not you',
      action: 'Check the microphone (System Settings → Sound → Input) or reconnect your headset.',
    }
  }

  const audioLive = isUp(h.mic) || isUp(h.system)
  if (audioLive && (isSttBad(h.sttYou) || isSttBad(h.sttThem))) {
    return {
      level: 'degraded',
      message: 'Audio live, transcript unavailable',
      action: 'Retrying the transcription session without stopping capture.',
    }
  }

  if (!(isUp(h.mic) && isUp(h.system))) {
    return {
      level: 'not_ready',
      message: 'Verifying audio',
      action: 'Waiting to hear both you and the meeting before showing ready.',
    }
  }

  if (h.sttYou.status === 'connecting' || h.sttThem.status === 'connecting') {
    return { level: 'degraded', message: 'Transcription reconnecting', action: 'Capture continues; nothing is lost.' }
  }

  if (h.coach.status === 'down') {
    return {
      level: 'degraded',
      message: 'Coach unavailable, transcript live',
      action: 'Check your AI key in Settings. Second will retry on the next turn.',
    }
  }

  return { level: 'ready', message: 'Ready' }
}
