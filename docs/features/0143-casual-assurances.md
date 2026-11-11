# 0143 - Casual Assurances ("you're safe with me")

> **Retrospective note (written 2026-11-11, ORW-15).** B4 (design S2, slices 1-8, #2095 to #2166) shipped flag-gated before any spec existed; this documents what the merged code does. Flag `ORWELL_ASSURANCES` is deploy-default ON (#2189).

## Problem
Players and houseguests make cheap, explicit promises in scenes ("you're safe with me", "you have my vote", "I'm with you"). A formal deal is too heavy for these, so they used to move nothing.

## What shipped
- A separate, cheap ledger (`src/engine/assurances.ts`, `AssuranceLedger`): kinds `safe` / `vote` / `loyal`; an assurance is `open`, then `kept`, `broken` or `lapsed` (open ones lapse after `horizonWeeks` = 3). No jury demerit, no kept/broken verdict machinery.
- Recording: `recordInteraction` takes an optional `assurance` (`kind`, optional `from`). The FE `_auto_record_scene` belt extracts it (`_validate_assurance`: closed kind set, the maker must be the player or a houseguest in the scene) and `orwell_engine.record_interaction` threads it only when well-formed. The engine ignores it when the flag is off.
- The engine, never the model, decides whether it is kept (`decideKeep`: loyalty and aggression scale a keep weight; an insincere strategic lie is never kept for its own sake; breaking pays more as the assured's threat grows).
- Binding reads: a KEPT `safe` keeps the assured off the HOH's block while two legal others remain; a KEPT `vote` / `safe` gives the assured an eviction-vote shield worth half a deal's honor weight.
- Break fold: the assured keeps a `deal-broken` memory (severity 0.3) and loses 0.12 trust in the assurer, and with the belief layer on holds an engine-only `lied-to-me` claim (read by the B48 believability read). Witnesses who merely heard it remember at half weight (B22). A kept assurance leaves a smaller favor (0.2). A kept one is sometimes WRONGLY believed broken (B39 rumor, 20%).
- **Sealed ballots (ORW-15, E12).** An eviction ballot is secret, so a break at the vote must not name the voter. The ledger still resolves BROKEN (engine truth), but the assured's memory and trust fold is divided across every voter who could have cast the ballot, with no named `lied-to-me` claim and no witness fold. The HOH tie-break is a public act and stays attributed.

## Flag
`ORWELL_ASSURANCES`, deploy default ON; OFF writes no ledger, so the run is byte-identical.

## Vault Wall and anti-sycophancy
The ledger, memories and claims are engine-only (no number reaches the player, and the player's own hidden read is never acted on). The model proposes only that a promise was made; the keep/break outcome is the engine's seeded, personality-scaled decision.

## Tests
`tests/unit/assurances.test.ts`, `assuranceRecording.test.ts` (boundary through `McpServer.callTool`), `assuranceNominations`, `assuranceVotes`, `assuranceBreakFold`, `assuranceKeptFold`, `assuranceWitnessMemory`, `assuranceRumoredBreak`, `assuranceNpcSincerity`, and `sealedBallotAssurances.test.ts` (a sealed vote reveals no voter). FE: `frontend/tests/test_b4_assurance_belt.py`, `test_orw104_chat_assurance.py`.

## Known gaps
No standalone FE surface; the lever is diegetic only. `lied-to-me` is read only by the B48 believability read.
