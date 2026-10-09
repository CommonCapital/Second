# Release gate

A packaged build ships only when every P0 check below passes. A polished interface with unreliable capture is still a demo. Do not ship on vibes.

Record each run in the release PR: build version, prompt version (`prompts/second_core.md`), model ids, tester, date, and pass/fail per row. Any failure gets an issue using the [issue log template](.github/ISSUE_TEMPLATE/bug_report.yml) with a regression test before it is closed.

## Automated (must be green in CI)

| # | Check | Where |
|---|-------|-------|
| A1 | Renderer + shared typecheck, main + preload typecheck, lint | `npm test`, `npm run lint`, CI |
| A2 | Unit + integration suite | `npm test` |
| A3 | Meeting state replay is deterministic | `src/shared/second/__tests__/meetingState.test.ts`, `evalCorpus.test.ts` |
| A4 | Card contract, voice rules, intervention gates | `src/shared/second/__tests__` |
| A5 | Live loop: coalescing, late-result drop, coach-failure isolation | `src/main/second/__tests__/liveEngine.test.ts` |
| A6 | No API key reaches the renderer (`store:get` masks) | `src/main/__tests__/ipc.test.ts`, `store.test.ts` |
| A7 | Diagnostics carry no content | `src/main/second/__tests__/coachAndHealth.test.ts` |
| A8 | Schemas match code | `src/shared/second/__tests__/schemas.test.ts` |

## Model evaluation

| # | Check | Pass bar |
|---|-------|----------|
| E1 | `SECOND_EVAL_ENFORCE=1 npm run eval` on the release model | Auto-good rate ≥ 85%, zero forbidden-mode choices |
| E2 | Human review of `evals/results/scorecard-latest.csv` (usefulness, timing, grounding, voice, state accuracy, close quality) | ≥ 85% of surfaced cards rated good or excellent |
| E3 | Zero fabricated facts or commitments in reviewed cards and reports | 0 |
| E4 | At least one scenario where WAIT is the best output, and the model chooses it | Pass |
| E5 | Card latency on a normal network | p50 < 1.5 s, p95 < 3.0 s after a finalized turn |

## Packaged-app acceptance (manual, on a Mac that has never run a dev build)

1. Fresh install from the DMG. No terminal required.
2. Permission flow obtains and verifies Microphone and Screen Recording (system audio).
3. Settings → Second → **Run test**: mic shows live energy (YOU).
4. Same test: the spoken test sentence registers as meeting audio (THEM).
5. The status rail never shows **Ready** before both sides have real audio and transcripts.
6. 30-minute Google Meet call: YOU and THEM stay correctly attributed throughout.
7. 30-minute native Zoom call: same.
8. AirPods connect or disconnect mid-call: Second recovers, or the rail names the failing side with a one-step fix.
9. Network dropped for 15 seconds: rail shows offline, transcription reconnects, no duplicated turns, and the State tab shows a gap.
10. One transcription session force-failed: the other source stays alive and the rail says which side is down.
11. Coach API force-failed (bad key): transcript and meeting state stay alive; rail shows coach unavailable.
12. Overlay renderer force-closed: the app recovers the surface or stops capture cleanly and says so.
13. Computer sleeps mid-call: on wake, a gap is recorded and the user is told.
14. No raw audio on disk after a default meeting.
15. With **Keep full transcripts** off (default): no transcript remains after the meeting ends or after restart; summary, action items, and the Second report remain.
16. No provider key or profile content appears in ordinary app files or logs (`grep` the user-data folder and log output for a known key suffix).
17. Founder scenario: Second finds the decisive evidence gap and lands the next step without interrogating.
18. LP scenario: explains strategy consistently, never invents traction, and discovers the decision process.
19. Interview scenario: answers direct questions naturally using only grounded profile facts.
20. Negotiation scenario: identifies the variable being traded and does not overtalk.
21. Post-meeting report captures decisions, commitments with owners and dates, open questions, risks, and the next step.
22. The live surface stays responsive for the whole session.
23. Editing the profile in Settings changes behavior on the next meeting without a code change.
24. Works with an empty profile (no external memory attached).
25. The full automated suite and eval replay were run for this release candidate.

## Signing and distribution

- Release macOS workflow green; `spctl -a -vv -t install` on `Second.app` reports `Notarized Developer ID`.
- In-app update from the previous release installs and relaunches on the new version.
