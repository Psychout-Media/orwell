# 0191 - NPC decisions read the decider's own view (ORW-574, Fable audit T1-6; widens 0163)

Ryne 11-03: NPCs decide "from their own view... what each NPC believes". Fable's audit T1-6 found decisions that still read another houseguest's
hidden edge or stat. In a **played game** (`live.playedGame`) with `ORWELL_OWN_VIEW` on (default ON), each site below reads the DECIDER's view:
their own edges, the public record (archetype, comp wins), the scenes they were in or watched, and the beliefs they hold
(`perceivedTrust` / `perceivedThreat` / `perceivedBond` in `GameSessionAdapter`, constants `OWN_VIEW` in `beliefDecisions.ts`). Headless seeded
games and `ORWELL_OWN_VIEW=0` keep the old reads byte for byte; no new rng draws. Everything is engine-only; no view projects any of it.

## Inventory (current main at the time of building)

| Site | Hidden read before | Perceived read now | Fallback when unseen |
|---|---|---|---|
| Comp intent `deriveCompIntent` (`maxThreatOnMe`) | each rival's hidden `edge(rival, me).threat` | `perceivedThreat(me, rival, me)`: my public menace (archetype, public wins) + half my own wariness of them mirrored back + beliefs that they target me | public menace alone (the move-in read) |
| Houseguest's Choice `hcStrategyFor` | candidate's hidden stats; candidate's trust in holder; candidate's bonds with nominees | `publicStrength` (archetype aptitudes + public wins); `perceivedTrust(holder, candidate, holder)`; `perceivedBond` (scenes the holder saw, allied-with beliefs) | edge baseline / archetype strength |
| Nomination tactic `politicalTemperature` (via `nominationPlan`) | house-wide average of every reader's hidden `edge.threat` | `threatOf` = `perceivedThreat(HOH, reader, subject)` (half the HOH's own read, half the subject's public menace, plus a rumor heard) | public menace |
| Pitch strength `derivePitches` | HOH's hidden `edge(hoh, pitcher).threat` | `perceivedThreat(pitcher, hoh, pitcher)`: how the PITCHER believes the HOH reads them | public menace |
| Jury term in the vote `voteChoice` (`juryManagementWeight`) | nominee's hidden `edge(n, voter).trust` | `perceivedTrust(voter, n, voter)`: the voter's own trust moved by an assurance held (up) or a believed grievance (down) | the voter's own trust |
| HOH-referendum target in `voteChoice` | the HOH's hidden threat edges | `perceivedThreat(voter, hoh, nominee)` | public menace |
| Vote counting `voteStillInDoubt` | each voter's hidden threat/trust toward the target | `perceivedThreat` / `perceivedTrust` of the actor about each voter | the bond the actor saw; baseline |
| Final-HOH estimate `finalHohMindChoice` -> `estimateJuryShare` | the rival's hidden bond with each juror | `perceivedBond(hoh, rival, juror)` | edge baseline (strangers) |
| Floater/duo read `perceivedBond` (ORW-596) | half the pair's true bond | only every warm or cold scene the decider was in or saw, plus allied-with beliefs; warmth toward the decider is `perceivedTrust` | edge baseline |

## Gates

- `tests/unit/ownViewDecisions.test.ts` (one per site, hidden state perturbed with the perceived state fixed, then the perceived state moved).
- `docs/features/0191-own-view-decisions.feature` ("own view:" steps): per-family scenarios, flag-off/headless identity, no-leak, determinism.
- Measured, never gated: house mix, jury reach and gradient (reported on the card).
