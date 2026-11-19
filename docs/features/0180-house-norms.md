# 0180 - House norms (Theme 3 slice 12, part 1)

Summary: the house enforces its own rules. A houseguest the house KNOWS has broken their word is shunned, by the people who know it and not only by the people they wronged. Part 1 is the promise-keeping norm, part 2 is bandwagons and dissent, and part 3 is scapegoats. Flag `ORWELL_HOUSE_NORMS`, default ON (`=0` means no shunning). Engine-only; the player never sees a number.

## Rule
- **What counts is what each observer holds**, never the hidden truth (Theme 2's pathways):
  - their own `lied-to-me` about the subject;
  - each `heard-rumor` of nature `lying` about the subject, one per person the subject lied to.
  - A refuted belief does not count.
- **One known incident is gossip.** From `NORMS.threshold` (2) distinct incidents, the observer shuns the subject: a bounded move down in their own read of them (affinity −0.06, trust −0.05 per incident). Each further incident deepens it, capped at `maxIncidents` (6).
- **The culture moves it:** strength = 1 + 0.6 × ((loyalty dial − 1) − (lying dial − 1)), floored at 0. An honest, loyal house shuns harder; a house of liars barely notices.
- **Overnight, once:** the fold runs in the overnight step after the learned-of-the-break gate (ORW-597). It records what it has already applied per observer and subject, so the same knowledge never moves the edge twice.

## Part 2: bandwagons and dissent
- **The herd:** before a vote, a voter reads where the house is going from who they have heard is going after each nominee: `heard-rumor`, nature `going-after`, this week, one voice per houseguest.
  - It takes at least two voices.
  - A bounded term (`HERD.weight` 0.18 at a unanimous read) pulls toward the house's side. It only tips a close call; a voter with a strong reason of their own keeps it.
  - The culture's alliance-size dial ("a majority bloc") makes the house herd harder.
  - It is a vote term named `herd`, so the decision's "why" records it.
- **Dissent noticed:** after the vote, a houseguest who voted with the majority (their own ballot, which they know) and has heard through vote talk that someone voted the other way cools on them.
  - The cooling scales with how lopsided the count was: nothing below a 60% majority, and the most for a lone dissent.
  - It happens once per pair per week (`live.dissentNoticed`).
  - Ballots stay secret: only what was said and heard counts.

## Part 3: scapegoats
In a **hard week**, the house unites against one target.
- **A hard week:** at least 40% of the house is rattled (mood below 0.4). The lean grows to full when everyone is rattled.
- **The target:** whoever the most houseguests hold a grievance against. It must be at least 30% of the house, with a clear lead.
  - A grievance is what each holder holds: a caught lie, being targeted, a vote against them, or a rumor of lying, scheming or voting against someone. It counts from this week or last, unrefuted.
- **The lean:** a houseguest deciding a nomination or a vote leans toward the scapegoat (`SCAPEGOAT.weight` 0.2 × hardness). Someone without a grievance of their own follows at half that.
- **Where it shows:** the lean rides the decider's belief term, so the decision's "why" names it as a belief.
- **When there is none:** a calm week, or a house with no clear focus, has no scapegoat.

## The player in both directions
- **The player's actions move NPC state:** a player who breaks their word to two people, once the house knows, is shunned like anyone.
- **NPCs act toward the player:** the shunning is the same hidden edge every nomination, vote and deal decision already reads, so it shows up in how the house treats the player.
- **Scapegoat:** the player can be the house's scapegoat when the house holds the most grievances against them; the player's own choices take no lean.
- **Dissent:** a player who tells someone they voted against the house is noticed like anyone. The houseguests the player is heard to be going after count as voices in the herd. The player's own vote stays theirs.
- **Known gap:** the player exposing a liar does not yet shun them. What the player says becomes no claim (Fable P-5, a separate card). When P-5 lands, the player's own words become one more pathway.

## Wall
The incident counts and the applied ledger (`live.normsApplied`) are engine-only. No player or admin view carries them. The narrator voices only the later behaviour.

Code: `src/engine/houseNorms.ts` (pure), `GameSessionAdapter.foldNormsOvernight`. Tests: `tests/unit/houseNorms.test.ts`, `0180-house-norms.feature`.

## Amendment - 2026-11-19 (ORW-692, Fable bug scan B1-8: the herd's writer)
The herd read `heard-rumor` going-after claims aimed at a nominee, but nothing in a played game wrote one in a vote week: the house-life speech actions voice what a houseguest believes ABOUT the target (so the nominee was the claim's subject), and a houseguest cannot claim their own stance. Measured zero voices in 550 votes. Now a houseguest working to get a house nominee out (a goal step of get-them-out or revenge, about that nominee) in a scene with another houseguest is heard doing it: the partner, and awake bystanders in the room on their own keyed roll, each hold "that houseguest is going after the nominee" (first-hand, confidence `HERD.heardConfidence`). Never the nominee, never the player's own knowledge. The weight and `minVoices` are unchanged. Played games with beliefs and house norms only, own keyed side stream, flag `ORWELL_HERD_VOICES` (default ON; `=0` restores the old read byte for byte). Test: `tests/unit/orw692HerdAssuranceWriters.test.ts` (real seeded games, no state injected).
