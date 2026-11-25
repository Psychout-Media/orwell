# 0204 - The night it all comes out (ORW-647)

**Status: built (2026-11-18). Ryne approved the idea 2026-11-17: "I think that's a great idea. And maybe the person does it themselves." Flag `ORWELL_SECRET_BREAKS` (default ON; `=0` = none). BDD `0204-the-night-it-all-comes-out.feature` + `tests/unit/secretBreak.test.ts`.**

A secret that many houseguests already hold stops being a secret. On a given night it breaks in front of the house, said by the others once enough hold it, or blown up by the person it is about when they are pressured and volatile enough.

## How it is decided (pure, `src/engine/secretBreak.ts`; engine-only, on the dependency-cruiser Vault list)
- **Who holds it:** the knowledge layer the engine already keeps. A fact about a living houseguest (a `subject`), counted by how many living NPCs outside the subject hold the same lineage (`factId`). Nothing is read from the Vault.
- **Due:** held by at least `holderShare` of the others and never fewer than `minHolders`. On a due night the others say it on a keyed roll (`outChance`).
- **Self-detonation:** once it is closing in (`closingShare` of the others hold it) the subject may get ahead of it. Chance = temper (their volatility and how unsteady they feel) x pressure (how far it has spread, being on the block, how cold the house reads toward them) x a ceiling. A calm, steady subject never does; the player is never detonated by the engine.
- Every roll is a keyed `agendaRoll` (no shared rng). One break a night, once per fact (`live.secretBreaks`, saved). Played games only.

## What the room hears
A recorded house event (type `secret-break`) whose witnesses are the awake room, the player too if awake (a witnessed event is not a secret). The line is composed from the subject's name and the fact as the holders word it (the retelling's hedge tail is cut); the narrator authors the real words and the room's reaction from it. No holder list, truth marker or number is in the line. If the player is asleep the event is hidden like any scene they were not in.

## Consequences (existing stores, bounded)
Each present houseguest who did not hold it now holds it (pathway `public`). The room re-reads the subject (a small directed fold; a self-detonation takes half, coming clean costs less than being caught). A houseguest kept out holds a grudge (`lied-to`) against the holder they had trusted most. The secret is marked exposed so it is never re-wielded as leverage, a trade or an exposure.

## The player
- As the subject (NPCs hold a fact about the player): built; the room hears it, the engine never detonates for them.
- As a present witness: built; they hear exactly the line.
- Player detonates their own: **part 2** (a player action, never engine-authored; see the design note below).

## Part 2 (not built): the player blows up their own secret (ORW-825)
A player action, in the player's own words, never engine-authored. Proposed: an open decision card (the deal-offer / meeting-answer open-state pattern, `submitDecision`) the engine offers only when a fact about the player is closing in (the same `closingShare` test), carrying nothing but "say it yourself or wait"; the player's words are recorded as the public event verbatim, the same consequences apply at the self-detonation share, and the fact is marked broken. It needs no new read: the card is a pending the player channel already carries. A player-initiated version (any time, any own secret) would be a new lever and needs the Auditor's wall call first.

## Deferred (ORW-825)
House norms (0180) and a reputation mark (0184) are not touched by a break yet: the bond fold and grudge book carry the consequence today.

## Amendment 2026-11-19 (ORW-688): the facts houseguests hold now say who they are about

Every consumer here keys on a held fact's `subject` (who it is about), but the records the houseguests actually held had none: the confidant's origin belief for a thread rumor, a pre-show tie observation and a confidence was lodged without it (only the copy handed to the player carried it), and a secret the player exposed or traded was lodged under a fresh id per recipient (so no two houseguests ever held one lineage) with the subject only on a separate, lineage-less copy. So plays, breaks and barters found almost nothing to match in a played game.
- The origin beliefs now carry the subject; a thread rumor diffused along the graph carries it on every hop; a scene rumor (graph path) names the one who is not the teller.
- An exposed or traded secret is lodged under the player's own fact id as its lineage, so the whole house holds ONE lineage with the subject on it (and a secret already exposed is known to be out, so 0204 does not re-break it).
- `surfaceInformationTo` takes an optional `factId` so a record with a subject also has a lineage.
- An old save is backfilled on load from the record's own fields (a scene rumor's lineage id names its origin and its undrifted text names the pair), append-only, no rng.
- Flag `ORWELL_RUMOR_SUBJECTS` (default ON, `=0` = subject-less, byte-identical). Played games only. The subject is engine-only (Vault class): only a fact the player was told reaches them, with its source. Test `tests/unit/rumorSubjects.test.ts`; report `tests/calibration/secretSubjectReport.test.ts` (`ORWELL_SECRET_SUBJECT_REPORT=1`).
- Not done: an overheard fragment (presence) is still subject-less. (ORW-825)
