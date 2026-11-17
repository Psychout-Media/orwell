# 0174 - Triads, swing votes and kingmakers (Theme 3 slice 13) - BUILT behind ORWELL_TRIADS

Executable spec: `0174-triads-swing-votes-kingmakers.feature`, wired into `cucumber.cjs`; steps in `features/step_definitions/triads.steps.ts`. Unit gates: `tests/unit/triads.test.ts`, `triadsSession.test.ts`; report: `tests/calibration/triadsReport.test.ts`. The 12-season mix, the jury reach and the gradient are measured with the flag on and off (see the PR report), not asserted in a scenario.

## What it adds
Structural balance: the enemy of my enemy grows warmer, two friends of one person drift toward each other, an unbalanced triad strains its center's bond to the one they like less. A houseguest whose ballot could decide a close eviction is courted by both camps, knows it, and the price a camp pays rises with the rival bidders. The deciding ballot is kept as the kingmaker, history only.

## How it works (all engine-only, played games only, keyed side streams `${seed}:triads:...`)
- Daily (in `settleOvernight`): `triadsTick` reads the bond reader only (`bond`/`ties`, never `RelationshipModel.edge`): each holder's strongest enemies (threat or resentment at the bar) and closest friends, then `sharedEnemyNudges`, `commonFriendNudges`, `strainedTriads` (pure, `src/engine/triads.ts`). At most four nudges a day, each on a keyed roll, a small `applyImpactDirected` step, a per-pair cap on the total drift. Never touches the player's own edges; the player is a possible enemy, friend and center (a friend of two NPCs pulls them together; an enemy of two warms them to each other).
- At the vote (`startEvictionVote`, before the player's ballot pends): the liveSeason ctx hook `swingAtVote` hands the adapter each NPC voter's pick and firmness (a read-only preview of `voteChoice`, no `why` record). When the others leave it within two votes, the softest ballots on the leading side are the swing voters. Each nominee's camp (the nominee and their closest ally who votes) pitches on a keyed roll weighted by closeness; a landed pitch moves the swing voter's read of the pitcher (the edges the vote already reads) and costs the pitcher favors owed to the swing voter (`priceTier`: one more per rival bidder, capped). No new lever: the favor ledger and the one standing offer slot.
- The player: when their own ballot could decide it, pitches reach them as the standing offer (kind `vote`, accept or decline) plus lines said in the room; the player's ballot is never set, and NPCs read the player as a possible swing in the count.
- The result (`commitStagedEviction`, hook `triadsAtResult`): a close vote's deciding ballot (the softest on the winning side, or the HOH who broke a tie) is the kingmaker. The retrospective alone unseals the courted votes and the kingmakers.

## Data shape
`live.triads = { day, drift, courted[], kingmakers[], lastGaps }`, monotone (never deleted), persisted with the season, never projected.

## Open owner questions
- Drift size and the pitch gain are small by design; the mix guard reports them. Raise if the house feels static.
- A swing voter's price is paid in favors owed to them; if you want trust or deals as the price instead, say so.
