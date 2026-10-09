# Second: product source of truth

Second is a private live meeting intelligence layer for interviews, founder and investor calls, LP conversations, banker and sponsor calls, IC discussions, negotiations, and other high-stakes meetings.

**North star:** the user forgets the software is there and simply has a materially better meeting.

**Ship gate:** trustworthy in the next real interview, founder call, LP meeting, or negotiation. See [RELEASE_GATE.md](../RELEASE_GATE.md).

When priorities conflict, protect reliability, latency, judgment quality, privacy, and user credibility before feature count. If a feature makes the live loop less predictable, it waits.

## The ten laws

1. **Judgment over transcription.** The transcript exists to make the next decision better.
2. **One glance.** A card is understood in about a second and can be spoken naturally.
3. **Silence is intelligence.** WAIT is common when listening has higher expected value.
4. **Timing outranks eloquence.** A great line after the moment passes is a failed line.
5. **Friendly before forensic.** In relationship-driven rooms, establish understanding before pressing for evidence.
6. **Facts before inference.** Distinguish what was said, what is known from context, and what Second infers.
7. **Never spend credibility casually.** No bluffing, invented authority, fake scarcity, fake relationships, or unearned certainty.
8. **Questions are sequential.** The best question now, not a checklist.
9. **Close the loop.** Track unanswered questions, commitments, owners, dates, documents, and the next step.
10. **Invisible when it works.**

**Non-goals for v1:** a bot that joins the call; an exhaustive note-taking surface competing with live coaching; chain-of-thought in the live UI; a ten-field setup ritual; generic emotional coaching; autonomous claims, emails, calendar sends, or promises without explicit user action.

## How the rules map to code

| Rule | Where |
|------|-------|
| One card at a time; SAY / ASK / WATCH / WAIT / CLOSE / none | `src/shared/second/card.ts`, `schemas/card.json` |
| Voice: ≤ 22 words, banned phrases, no formulaic reversals | `src/shared/second/voicebook.ts` |
| Coach only after meaningful finalized turns | `src/shared/second/turns.ts`, `shouldRunCoach` in `interventionGate.ts` |
| Suppression (low confidence, repeats, protect current card, THEM mid-answer, no stacked questions, WAIT never displaces) | `shouldPublish` in `src/shared/second/interventionGate.ts` |
| State before prompt; deterministic, replayable | `src/shared/second/meetingState.ts`, `schemas/meeting_state.json` |
| Facts need provenance; inferences never become facts; numbers normalized; contradictions detected; commitments need who/what | `applyUpdates` in `meetingState.ts` |
| Versioned core prompt | `prompts/second_core.md` (version in its header), loaded by `src/main/second/prompts.ts` |
| Compact prompt: stable context first, state + recent turns last, never the full transcript | `src/main/second/coachService.ts` |
| Mode changes the objective, not the user | `src/shared/second/playbooks.ts` |
| Live loop, fault isolation, late-result drop, coalesced re-runs | `src/main/second/liveEngine.ts` |
| No false green states | `src/shared/second/health.ts`, `src/main/second/healthMonitor.ts` |
| Post-meeting report, transcript retention, crash-safe purge | `src/main/second/secondMain.ts`, `briefingService.ts` |

## The meeting, end to end

**Before (Prepare meeting).** Optionally start from an upcoming Google Calendar meeting: Second fills in the attendees and organization and gathers the invite, recent email with the attendees, and matching Drive docs for you to review. Pick the meeting type, who, the objective, the ideal outcome, what must not happen, and optionally paste context. Second writes a 90-second brief: who they are, what matters, three facts to remember, three questions to land, two likely hard questions with answer shapes, the close target, and anything not to say. Run the dual-audio self test (Settings → Second); the last result shows in Prepare meeting.

**During.** The overlay shows a status rail (mic, meeting audio, both transcripts, coach, network), one dominant card with an expiry line, and a State tab (objective, open questions, objections, commitments with missing dates flagged, numbers that changed, capture gaps, close target, next best action). Cmd/Ctrl+Shift+Enter asks for the best card now; the card's brain button asks the deeper model.

**After.** One screen: outcome, facts learned, decisions, commitments, open questions, risks, the next step, a short follow-up draft in the user's voice, and proposed context updates the user approves before anything is saved to their profile.

## Intervention priority

1. Prevent a material mistake, false statement, accidental commitment, confidentiality or compliance problem.
2. Answer a direct question the user is expected to answer now.
3. Capture a decision-critical fact while the moment is open.
4. Expose economics, authority, timing, process, or missing evidence that changes the decision.
5. Resolve a material objection or inconsistency.
6. Convert real momentum into a concrete next step.
7. Improve framing, warmth, or persuasion.
8. Add color only if it materially improves the room.

Latency budget: from a meaningful finalized turn to a useful card, p50 under 1.5 s and p95 under 3.0 s.

## Context layers and precedence

1. Product truth and safety rules (core prompt).
2. The user's approved professional profile (Settings → Second; versioned on every save).
3. Meeting mode playbook.
4. Meeting setup, brief, and supplied context.
5. Current meeting state and recent turns.
6. Dynamic profile context, retrieved **only** when the meeting mentions its topic, marked stale after a configurable horizon (default 30 days).
7. Model inference, always labeled internally as inference.

User corrections win immediately. Dynamic facts expire or prompt a refresh rather than becoming permanent memory. Second never reveals private context just because it helped.

## Model routing

- **Coach slot** (live cards): a fast model with minimal reasoning effort.
- **Deep slot** (briefs, "think deeper", post-meeting report): a stronger model.
- Both are configurable in Settings → Second; defaults live in `src/main/services/ai/providerFactory.ts`.
- Change a model only after replaying the eval suite (`npm run eval`). Prompt version and model id are written into every scorecard and diagnostic record.

## Privacy and professional risk

- Explicit start and stop, with a visible recording indicator.
- Raw audio is never written to disk.
- Transcript retention is **off by default**: after notes and the report are written, the transcript, overlay chat, Ask index, and Assist memory for that meeting are deleted. A boot-time sweep catches meetings the app quit before cleaning.
- API keys never reach the renderer; it receives a masked value only.
- Diagnostics contain no content.
- No autonomous external action: drafts are drafts.
- Recording consent is the user's responsibility; see [PRIVACY.md](PRIVACY.md).

## Status against the build sequence

| Phase | Status |
|-------|--------|
| 1. Consolidate: one production code path | Done. The live loop runs inside the desktop app. |
| 2. Stabilize capture: permissions, meters, self test, recovery | Partly done. Shipped: usage strings, truthful status rail, meters, self test, sleep/network gaps. Still needs manual validation on real devices (release gate items 6 to 13). |
| 3. Meeting state | Done. Deterministic reducer, schemas, replay tests. |
| 4. Context | Done: profile, playbooks, brief, scoped dynamic context, and optional Google Calendar/Gmail/Drive packet (bring-your-own OAuth client, read-only, provenance-tagged, user-reviewed). CRM is deferred. |
| 5. Coaching | Shipped. Needs calibration against a larger human-scored corpus (`evals/`). |
| 6. Hardening | Mostly done. Shipped: masked keys and Google tokens, retention, diagnostics, typecheck in CI, self-contained macOS build (no Homebrew needed). Still needed: Developer ID signing and notarization secrets on this repo. |
| 7. Ship and learn | Not started. |
