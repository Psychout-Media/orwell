# Live-run pass bar (short tier, ORW-109)

The written bar for the staged real-narrator run (`scripts/live-run/`). It is a checklist, not a runtime pick. Source: the ship gate (`docs/audits/2026-06-27-ship-gate.md`,
G5-G9 and F1-F5), the vault note "Live Run Pass Bar" (T1-T20) and Ryne's rulings. A run PASSES when every FAIL check below holds; WARN checks are listed and do not fail it.
Each check is read from engine state plus the transcript, never from opinion. Roles only: no cast name appears in a report.

The run jumps the engine to the veto ceremony, an eviction night and the finale with the engine's own player API, then plays a few real chat turns at each, on DeepSeek
with images off, under a spend cap and a turn cap.

| # | Check | Fails when | Read from |
|---|-------|-----------|-----------|
| 1 | Reached (G1, G2) | The game does not start, or a beat's phase (veto ceremony, eviction, finale) is not reached by the engine's closed set | engine phase after the jump |
| 2 | Real scene (G8) | A reply is empty, a guard's replacement shell, or under 200 characters (a one-line deflection of an out-of-schedule ask is a warning) | bubble text |
| 3 | Answered (F1) | A player message gets no settled reply, or a reply slower than 240 s | bubble state, timer |
| 4 | No machinery (G8, Vault Wall) | A reply holds an `npc:` id, reasoning text, an operator aside, a tool or lever name, `beatSeq` or an HTTP 409 | bubble text |
| 5 | Phase honest (G5, G6) | Competition play is narrated while the engine has not run it, or a ceremony is voiced before the engine committed it | `phase`, `daySchedule`, nominees |
| 6 | Board claims match the engine (G6) | A named veto winner, nominee or evictee that is not the engine's holder, nominee or recorded evictee (B1, B2, B3) | `veto`, `nominees`, `house` status |
| 7 | Sealed ballots stay sealed (E12) | A named voter is credited with a specific eviction ballot before the retrospective | transcript, phase `eviction` |
| 8 | No phantom winner | The finale names a winner the engine has not recorded (B5) | `winner`, `finished` |
| 9 | Stall rule (S1) | An event the engine reports as due fires later than 3 player turns (1 after an explicit ask) with nothing committed: the ORW-10 veto stall | `daySchedule.due`, phase per turn |
| 10 | No livelock (F2) | The same reply 3 turns in a row | transcript |
| 11 | Time honest (T9, K1-K3) | The clock jumps hours inside one message with no bed, no ceremony and no runner move, or a clock time is spoken | clock label per turn |
| 12 | Sync sanity (F4, F5) | A stale-beat 409 or an engine error is shown to the player as a game message | transcript, engine log |

Budget: the run stops cleanly at `--max-spend` or `--max-turns` and reports `CAPPED` with the spend so far; a capped run is not a PASS.
Verdicts: PASS (zero FAIL checks, not capped), FAIL, CAPPED, COULD NOT RUN. Not covered: hidden-information reads beyond the machinery list, naps, early sleepers, two windows
(the full-week tier owns those).

Full-week tier (`scripts/live-run/live_full.py`, operator-triggered): the same bar over the HTTP API, one game week as a talking player. Per-turn checks T1-T7, T9, T11, T13, T16, the stall rule S1, the livelock rule L1 and the
untold-result rule R1 (an engine-committed result the narration does not tell within 2 turns) are scored against the engine's own state; findings are grouped as contradictions, stand-in text, missing
results, wall leaks, unanswered messages and stalls. Not judged there: T8, T10, T12, T14, T15, T17-T20 and two windows (listed in every report).
