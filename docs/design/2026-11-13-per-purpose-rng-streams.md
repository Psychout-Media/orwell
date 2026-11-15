# Per-purpose rng streams (ORW-334): scoping note

Status: scoping only (no code). Written 2026-11-13 by Overseer B, from tracing the Traitors' Fury flag's season divergence (ORW-325, PRs #2602 and #2605).

## The short version

The engine is already mostly built from per-purpose streams: about 70 dedicated `hashSeed(...)` streams, almost all keyed on stable inputs (the game seed, a name, a week, a phase) or on their OWN tick counter (`presenceTickCount`, `juryHouseTickCount`, `triggerTickCount`, ...). Those cannot be shifted by another feature. The fragility is **narrow**: four streams are keyed on the global event-store count, and one stateful stream is shared. Fixing the four is small; it is the re-pin afterwards that costs.

## What shares what today

**A. Keyed on the global event count (the fragile ones).** Any feature that records one more hidden event re-rolls every later draw of these:

| Stream | Where | Key | What it decides |
|---|---|---|---|
| co-presence spread | `composition/orchestrator.ts` (~946) | `seed : copresence : holder : listener : clockNow : <event count>` | each shared / slipped / held choice when houseguests meet: the told ledger, so who knows what, so later decisions. **Default ON, and it moves outcomes.** |
| confessional recent / phrasing | `orchestrator.ts` (~1020, ~1030) | `... : confessor : clockNow : <event count>` | which of a confessor's events a confessional recalls and its wording (Vault-only text) |
| ambient house event | `orchestrator.ts` (~1113) | `... : week : phase : <event count>` | the day's ambient line |
| deal reputation | `composition/registry.ts` (~326) | `... : honorer : week : <events.count()>` | the reliability reward when a deal is honoured |

(The event ids `offscreen:<type>:<count>:...` also embed the count, but ids are labels, not draws. They matter only through item C.)

**B. The one shared, stateful stream.** `Orchestrator.rngFor(user)` is a single `SeededRandom` advanced across ticks; competitions, votes and the off-screen society draw from it in order. It is protected by convention (every new feature must use its own dedicated stream, see the comments on `juryHouseStretch`), and the convention has held: the Fury flag's draws were on dedicated streams. It is not part of this card.

**C. Counter ids used as sort keys.** Fact lineage ids (`know:N`) come from one counter shared with event ids (`InMemoryKnowledgeService.seq`), and `heldCandidates` orders by that string. A feature that mints extra facts or events shifts every later id and so can reorder ties. I tried a separate id counter for the Fury block (ORW-325): it removed a real lineage-id difference in the trace but moved no outcome, so it was reverted. Treat C as a possible contributor, not a proven one.

## What per-purpose streams would look like

For the four streams in A, replace the global count with the stream's own counter or stable inputs:
- co-presence: `seed : copresence : holder : listener : in-game time : copresenceTickCount` (a counter owned by the spread, persisted in the save like `juryHouseTickCount`). The roll for a given pair at a given time then depends on nothing another feature records.
- confessionals: key on `confessor : in-game time : the confessor's own confessional index`.
- ambient house event: `week : phase : day` (it already de-duplicates by day stamp).
- deal reputation: `honorer : week : the deal's own id`.
For C: break `heldCandidates` ties on a content or lineage hash rather than the counter id.
The Fury subtraction in #2605 (`before - furyAtBefore`, `live.furyEvents`) then goes away.

## Blast radius

Re-keying changes the DRAWS, not their distribution, so it is a re-roll: no bias, but every seeded season changes wherever these streams act (co-presence is default ON, so that is every played season).
- **Pinned seeds that will move** (rough, from the repo): 16 test files touch co-presence / the told ledger; 37 touch confessional / ambient streams (loose match); 17 files already carry a "re-selected / re-anchored / re-pinned" history, which is the seed-sensitive set (BDD 0003, 0034, 0043, 0078:72, 0130:48, 0135; unit `exitInterview`, `beatsTerminateThemselves`, `finalHohThreePartLive`, `triggerOutcomeNeutral`, `endgameWinnerMomentNeutral`, ...).
- **Calibration gates:** the PO gate (three arms, 300 seeds), `juryReach` (+ reweight), `calibrationGradient` (+ reweight) and the three UAT blocks all play default-profile seasons, so all re-roll. Expect to re-measure the PO bands; single 300-seed readings swing about +-2.5 points, so use 900 seeds to separate a real drift from noise (as in ORW-19). The passive "earned wins" jury guard is a 20-seed lottery and may trip on a seed; re-select, never loosen.
- **Estimate** (calibrated on ORW-19, which re-pinned 7 BDD scenarios, 6 unit pins and a value pin): about 1 agent-day plus 4 to 6 runner-hours for the sweeps; 8 to 14 pins to re-anchor; 2 to 5 seed re-selections. Do it as ONE deliberate re-pin PR, merged when no other seed-sensitive PR is in flight.

## Would it close ORW-325's tail?

Probably not by itself. The channel that caused most of the Fury drift (the event-count key) is already closed for the Fury events by #2605; per-purpose streams would make that closure general (no per-flag subtraction) but add nothing for what is left: seed 8 under the shipping profile (a harness-versus-engine mismatch: the lockstep trace sees identical state, the sequential test sees a different winner) and seed 7's week-11 fact value difference (a value channel, not a key). Those need their own tracing (next steps are on the ORW-325 card).

## Recommendation

Do ORW-334 **before the next hidden-event features land** (themes 2 and 4: lies and claims will each record new hidden events). Without it each of them re-shifts every seeded season on its own and each needs its own neutrality fix like Fury's. Do it once, deliberately, as the single re-pin above. If no such feature is coming soon, leave it parked; nothing is broken today.
