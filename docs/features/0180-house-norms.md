# 0180 - House norms (Theme 3 slice 12, part 1)

Summary: the house enforces its own rules. A houseguest the house KNOWS has broken their word is shunned, by the people who know it and not only by the people they wronged. Part 1 is the promise-keeping norm. Bandwagons and dissent (part 2) and scapegoats (part 3) follow. Flag `ORWELL_HOUSE_NORMS`, default ON (`=0` means no shunning). Engine-only; the player never sees a number.

## Rule
- **What counts is what each observer holds**, never the hidden truth (Theme 2's pathways):
  - their own `lied-to-me` about the subject;
  - each `heard-rumor` of nature `lying` about the subject, one per person the subject lied to.
  - A refuted belief does not count.
- **One known incident is gossip.** From `NORMS.threshold` (2) distinct incidents, the observer shuns the subject: a bounded move down in their own read of them (affinity −0.06, trust −0.05 per incident). Each further incident deepens it, capped at `maxIncidents` (6).
- **The culture moves it:** strength = 1 + 0.6 × ((loyalty dial − 1) − (lying dial − 1)), floored at 0. An honest, loyal house shuns harder; a house of liars barely notices.
- **Overnight, once:** the fold runs in the overnight step after the learned-of-the-break gate (ORW-597). It records what it has already applied per observer and subject, so the same knowledge never moves the edge twice.

## The player in both directions
- **The player's actions move NPC state:** a player who breaks their word to two people, once the house knows, is shunned like anyone.
- **NPCs act toward the player:** the shunning is the same hidden edge every nomination, vote and deal decision already reads, so it shows up in how the house treats the player.
- **Known gap:** the player exposing a liar does not yet shun them. What the player says becomes no claim (Fable P-5, a separate card). When P-5 lands, the player's own words become one more pathway.

## Wall
The incident counts and the applied ledger (`live.normsApplied`) are engine-only. No player or admin view carries them. The narrator voices only the later behaviour.

Code: `src/engine/houseNorms.ts` (pure), `GameSessionAdapter.foldNormsOvernight`. Tests: `tests/unit/houseNorms.test.ts`, `0180-house-norms.feature`.
