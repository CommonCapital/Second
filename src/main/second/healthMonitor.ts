/**
 * Health monitor: independent truth state per channel.
 *
 * Fed by raw capture taps (pre-AEC), transcript arrivals, STT connection
 * state, coach call outcomes, and network status. Never reports "live"
 * without an observable condition behind it.
 */

import {
  ENERGY_RMS_FLOOR,
  audioChannelStatus,
  deriveReadiness,
  emptyHealth,
  pcmRms,
  type ChannelHealth,
  type HealthSnapshot,
  type Readiness,
} from '../../shared/second/health'

type Source = 'mic' | 'system'

/** STT disconnected longer than this while recording => down (not reconnecting). */
export const STT_RECONNECT_GRACE_MS = 20_000

export interface HealthView {
  snapshot: HealthSnapshot
  readiness: Readiness
  /** 0..1 meter levels for the UI. */
  levels: { mic: number; system: number }
}

export class HealthMonitor {
  private active = false
  private startedAt = 0
  private lastChunkAt: Record<Source, number> = { mic: 0, system: 0 }
  private lastEnergyAt: Record<Source, number> = { mic: 0, system: 0 }
  private level: Record<Source, number> = { mic: 0, system: 0 }
  private peakRms: Record<Source, number> = { mic: 0, system: 0 }
  private lastTranscriptAt: Record<Source, number> = { mic: 0, system: 0 }
  private lastConnectedAt: Record<Source, number> = { mic: 0, system: 0 }
  private coach: ChannelHealth = { status: 'off' }

  start(now: number): void {
    this.active = true
    this.startedAt = now
    this.lastChunkAt = { mic: 0, system: 0 }
    this.lastEnergyAt = { mic: 0, system: 0 }
    this.level = { mic: 0, system: 0 }
    this.peakRms = { mic: 0, system: 0 }
    this.lastTranscriptAt = { mic: 0, system: 0 }
    this.lastConnectedAt = { mic: now, system: now }
    this.coach = { status: 'unverified', detail: 'No coaching call yet' }
  }

  stop(): void {
    this.active = false
    this.coach = { status: 'off' }
  }

  isActive(): boolean {
    return this.active
  }

  recordAudio(source: Source, buf: Uint8Array, now: number): number {
    this.lastChunkAt[source] = now
    const rms = pcmRms(buf)
    if (rms > ENERGY_RMS_FLOOR) this.lastEnergyAt[source] = now
    if (rms > this.peakRms[source]) this.peakRms[source] = rms
    // Log-ish meter: 0 at the floor, 1 near loud speech (~3000 RMS).
    const norm = rms <= ENERGY_RMS_FLOOR ? 0 : Math.min(1, Math.log10(rms / ENERGY_RMS_FLOOR) / Math.log10(3000 / ENERGY_RMS_FLOOR))
    this.level[source] = this.level[source] * 0.6 + norm * 0.4
    return rms
  }

  recordTranscript(source: Source, now: number): void {
    this.lastTranscriptAt[source] = now
  }

  recordCoach(ok: boolean, now: number, detail?: string): void {
    this.coach = ok ? { status: 'live', lastOkAt: now } : { status: 'down', detail: detail ?? 'Coach call failed', lastOkAt: this.coach.lastOkAt }
  }

  peaks(): { mic: number; system: number } {
    return { ...this.peakRms }
  }

  private sttStatus(source: Source, connected: boolean, now: number): ChannelHealth {
    if (!this.active) return { status: 'off' }
    if (connected) {
      this.lastConnectedAt[source] = now
      return this.lastTranscriptAt[source]
        ? { status: 'live', lastOkAt: this.lastTranscriptAt[source] }
        : { status: 'unverified', detail: 'Connected, no transcript yet' }
    }
    return now - this.lastConnectedAt[source] < STT_RECONNECT_GRACE_MS
      ? { status: 'connecting', detail: 'Connecting to transcription' }
      : { status: 'down', detail: 'Transcription disconnected' }
  }

  view(now: number, stt: { mic: boolean; system: boolean }, online: boolean): HealthView {
    const snapshot: HealthSnapshot = this.active
      ? {
          mic: audioChannelStatus({ active: true, now, startedAt: this.startedAt, lastChunkAt: this.lastChunkAt.mic, lastEnergyAt: this.lastEnergyAt.mic }),
          system: audioChannelStatus({ active: true, now, startedAt: this.startedAt, lastChunkAt: this.lastChunkAt.system, lastEnergyAt: this.lastEnergyAt.system }),
          sttYou: this.sttStatus('mic', stt.mic, now),
          sttThem: this.sttStatus('system', stt.system, now),
          coach: this.coach,
          network: online ? { status: 'live' } : { status: 'down', detail: 'No network connection' },
        }
      : { ...emptyHealth(), network: online ? { status: 'live' } : { status: 'down' } }
    return {
      snapshot,
      readiness: deriveReadiness(snapshot),
      levels: { mic: this.active ? this.level.mic : 0, system: this.active ? this.level.system : 0 },
    }
  }
}
