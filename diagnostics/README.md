# Diagnostics

A meeting product fails in the room, not in a ticket. Second tells the user what is wrong in plain English and keeps enough local telemetry to reproduce it, without recording what was said.

## Getting a bundle

Settings → Second → Diagnostics → **Preview** shows exactly what will be exported. **Save…** writes it to a JSON file you choose. Nothing is uploaded.

## What a bundle contains

| Field | Meaning |
|-------|---------|
| `app` | Version, platform, architecture, Electron version |
| `promptVersion` | Core coach prompt version (`prompts/second_core.md`) |
| `settings` | Provider names, model ids, sensitivity, retention flag. **No keys.** |
| `health` | Current per-channel status and readiness |
| `latency` | Count, p50, p95 of coach calls |
| `events` | Up to 2,000 recent events (below) |

Every event is `{ at, kind, data }`. `data` may only contain these keys (anything else is dropped when it's recorded, see `src/main/second/diagnostics.ts`):

`reason, mode, urgency, confidence, latencyMs, model, promptVersion, channel, from, to, level, turnCount, cards, suppressed, durationS, errorClass, provider, micPeak, systemPeak, micOk, systemOk, ok, words, warnings, meetingMode, resumed, incognito, p50, p95, count`

It **never** contains audio, transcript text, card text, profile content, setup notes, or API keys.

## Event kinds

| Kind | When | Useful fields |
|------|------|---------------|
| `session_start` / `session_end` | Recording starts/stops | `meetingMode`, `resumed`, `turnCount`, `cards`, `suppressed` |
| `health_change` | Readiness level changes | `from`, `to` |
| `coach_run` | Coach call succeeded | `latencyMs`, `model`, `promptVersion`, `reason`, `warnings` |
| `coach_skip` | A turn did not trigger a call | `reason` (`trivial_turn`, `rate_limited`, `in_flight`, `user_speaking`) |
| `card_published` | A card was shown | `mode`, `urgency`, `confidence`, `words` |
| `card_suppressed` | A candidate card was held back | `reason` (`low_confidence`, `repeat`, `protect_current`, `them_mid_answer`, `question_pending`, `wait_keeps_current`, `user_speaking_card`) |
| `card_rejected` | Model output broke the card contract | `reason` (e.g. `voice violation`, `card too long`, `invalid JSON`) |
| `card_cleared` | Card left the screen | `reason` (`expired`, `dismissed`, `replaced`, `topic_moved`) |
| `coach_error` | Coach call failed | `errorClass` |
| `error` | Capture gap recorded | `reason` (`gap_sleep`, `gap_network`), `durationS` |
| `self_test` | Dual audio self test finished | `micOk`, `systemOk`, `micPeak`, `systemPeak` |
| `brief` / `report` | Brief or report generation | `ok`, `latencyMs`, `model`, `errorClass` |

## Known failure signatures

| User sees | Health channel | Likely cause | Fix |
|-----------|----------------|--------------|-----|
| "I can hear you, not the meeting" | `system: silent/down` | Screen Recording / System Audio permission missing, or meeting audio routed to a device the capture can't see | Grant permission to the **packaged** app (not Terminal), check output device, rerun the self test |
| "I can hear the meeting, not you" | `mic: silent/down` | Mic permission, wrong input device, headset disconnected | System Settings → Sound → Input; reconnect; rerun the self test |
| "No audio from either side" | `mic` and `system` down | Capture helper exited (permission revoked mid-session) | Re-grant permissions, restart the session |
| "Verifying audio" never clears | `unverified` | Audio flowing but no speech energy yet, or a silent stream from missing Info.plist usage strings | Speak / play audio; in a custom build confirm `NSAudioCaptureUsageDescription` is present |
| "Audio live, transcript unavailable" | `sttYou/sttThem: down` | STT key invalid, quota, or provider outage | Check the STT key in Settings; capture continues meanwhile |
| "Coach unavailable, transcript live" | `coach: down` | AI key invalid, model id unavailable, rate limit | Check the AI key/model; `coach_error.errorClass` in the bundle |
| No cards ever appear | `coach: live` | Cards being suppressed or rejected | Look at `card_suppressed` / `card_rejected` reasons; try sensitivity **Active** |
| "Offline, reconnecting" | `network: down` | Network loss | Capture continues; a gap is marked when it returns |

## Filing an issue

Use the bug report template. Attach the bundle and fill in: release, environment, meeting type, reproduction steps, expected state, actual state, which health channel failed, the user-visible message.
