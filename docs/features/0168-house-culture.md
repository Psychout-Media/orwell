# 0168 - Season house culture (slices 1-3: the foundation, the house-life dials, then the relationship dials)

Card: ORW-551. Executable spec: `0168-house-culture.feature`. Unit gate: `tests/unit/houseLeans.test.ts`.

## What it is

Each played season draws a loose, seeded **blend of 2-3 culture leans** from 22 (gossip mill, chess club, showmance, catty, one big family, paranoid,
floaters, comp beasts, majority bloc, duos, chaos, ride-or-die, backstabbers, party house, cold war, powder keg, bedroom factions, slow burn, honor
code, liars' season, puppet master, underdogs). A lean is a small skew on the house dials (bonding, lying, gossip spread, credulity, flirting, conflict
threshold, alliance size, loyalty, paranoia, comp focus, meeting frequency): never a label, never a fixed script. Individual houseguests still vary and
can push against it. The player is never told the culture while the season is live.

## Slice 1 (this spec): the foundation, NO dial effect

- `src/engine/houseLeans.ts` (pure, Vault-class): the lean and dial ids, the `LEANS` table of log-space nudges in [-1, 1], one tunable block
  (`HOUSE_LEAN_TUNING`: K 0.3, F 1.35), `drawHouseLeans(seed)`, `dialMult(culture, dial)` = clamp(exp(sum w_i * nudge_i * K), 1/F, F) (exactly 1 with no
  culture), and the plain-words phrase table for the retrospective.
- The draw uses its own side stream `${seed}:culture`, so it cannot shift any shared random stream. It is stored as `live.houseLeans = {leans:[{id,w}]}`
  (ids and weights only, never multipliers), **write-once**, drawn at the same moment as the house theme (the first played message), only in a played game
  and only with `ORWELL_HOUSE_CULTURE` on (default ON). A season already under way when this ships, and any headless or calibration game, never gains one.
- Slice 1 itself consumed nothing; slice 2 (below) is the first reader. With no culture (flag off, a headless game, a load lacking `houseLeans`) every
  multiplier is exactly 1 and every seeded sim is byte-identical.

## Slice 2: the house-life dials

`HourView.culture?: HouseCulture` (`{gossip, conflict, flirting, lying}`, plain multipliers; type and `CULTURE_CANDOR_SHIFT` in `houseLifeConstants.ts`) is
filled at ONE call site (`GameSessionAdapter` house-life hour, from `dialMult(live.houseLeans, ...)`, only when the flag is on and a culture exists), so
`houseLife.ts` stays pure and imports no lean module. The multiplier scales the house BASELINE; the per-person terms (temper, mood, candor, goals) then apply
unchanged, so a hothead in a family house still fights. All draws are the existing keyed `agendaRoll` hashes: only a threshold moves, never an rng order.

- gossip: `gossipChance` x `dialMult('gossip')`.
- conflict: a THRESHOLD dial (a negative nudge = a lower threshold = more conflict), so `frictionChance` is DIVIDED by `dialMult('conflict')` (both the free-hour
  fight and the roommate squabble). `frictionAffinity` is left as it is (scaling it too would double the effect).
- flirting: `romanceChance` x `dialMult('flirting')` (the showmance pair's free hour only).
- lying: `schemingLieBoost` x `dialMult('lying')`, plus an additive shift of the speaker's own candor by `(lying - 1) x CULTURE_CANDOR_SHIFT` (0.25, so at most
  about 0.09 at the clamp), applied BEFORE the candor-minus-boost comparison.

Nothing moves further than the 1.35 factor from baseline. The house-mix guard (12 seasons, which draw cultures) is the mean-neutrality proof; if its average leaves
the band the fix is `HOUSE_LEAN_TUNING` (K) or the LEANS nudges, never the guard.

## Slice 3: the relationship dials

Same rules as slice 2: the culture is read from live state at the CALL SITE (`GameSessionAdapter.cultureMult(dial)`, exactly 1 with the flag off, no live game or
no culture), pure modules receive the multiplier as an argument, and it scales the house BASELINE before any per-person term (so individuals still push against it).
Only thresholds, floors and weights move: never a number of draws, never a loop count, never an outcome.

- paranoia: the rattled-voter self-protect weight (`DECISION.vote.moodSelfProtectWeight`) and the rattled-HOH nomination weight (`DECISION.nomination.paranoiaWeight`,
  through `NominationRead.paranoiaMult` / `nominationBaseVals`), both fed from `SeasonCtx.paranoiaMult`.
- loyalty: `derivedLoyalty(..., cultureMult)` scales the disposition baseline `BLOC.dispositionLoyalty` before the soul swing (so a rattled loyalist still dips);
  and the alliance goal-clash break chance `ALLIANCE.goalClashBreak` is DIVIDED by it (a loyal house breaks over a clash less; the keyed draw is unchanged).
- bonding (bond speed): the one fold seam `socialFoldValence` (used by the player-scene and the off-screen fold) multiplies the WARM scale by the dial and divides the SORE
  scale by it, on top of the fatigue valence (the existing `warmScale` / `soreScale` parameters; the four-draw jitter stream is untouched).
- alliance size: `ALLIANCE.npcAllyFloor` is DIVIDED by the dial (a majority-bloc house joins at a lower mutual bond); the integer cap `maxNpcSize` moves by at most one,
  only through `round(4 x dial)` clamped to +-1 (at the 1.35 clamp that is 3 to 5). The player's own join floor is left alone (a player-facing rule).
- meeting frequency: `npcWouldCall(..., chanceMult)` moves the THRESHOLD `MEETING.callChancePerDay x dial`; the draw on the `${seed}:house-meeting` side stream is unchanged.

- credulity (slice 5): the ONE seam is the adapter's private `credulityOf(id)` (0160, `beliefConviction.credulityOf`): the culture multiplier scales that listener's final per-owner
  value and the result is clamped to 0..1. It scales the value, not a house baseline, because the per-owner value is already formed from the person's own sheet; so a
  strongly credulous or skeptical individual still leans their own way (a x1.35 house cannot make a skeptic gullible, and a x1/1.35 house cannot make a believer a skeptic).
  Every listener caller (`tellClaim` intake, gossip beliefs) reads it through that seam. Exactly 1 with no culture, so those games are byte-identical.

Not wired, on purpose:
- comp focus: there is no single constant, and a competition's outcome is the engine's alone (mandate 3). The dial stays unconsumed and no lean may ever bend a comp.
- the trust baseline (`RELATIONSHIP_CONSTANTS.baseline.trust`): it is read in many places (move-in seeding, decay and overnight-drift targets, bond-above-neutral
  comparisons) with no single seam, and the move-in seeding happens before the culture is drawn. Shifting only some of them would make drift read as a bond. Bond speed
  above covers the intent; a shifted baseline is left for a later slice if the owner still wants it. (ORW-825)

## The wall

`houseLeans` is Vault-class and engine-only: it appears in no projection, prompt, tool result, log or debug-safe view, and the module is in the
dependency-cruiser engine denylist. Its one outward door is the post-season retrospective (below).

## The retrospective reveal

Owner ruling (2026-11-12): the limited perspective is broken in the season retrospective - the same door as the rumor mill (0157, mandate #2 exception 3).
`RetrospectiveView.houseCulture?: { leans: string[] }`, built in `seasonRetrospective()` behind the `finished` crown gate: one short plain phrase per lean,
heaviest first ("a house that ran on gossip"). Never an id, label, weight or number. Absent when no culture was drawn, so seasons without one are
unchanged. The front-end retrospective window renders it as plain text; the host model's tool result leaves it out (like "the house you never saw").

## Later slices (not this spec)

2: the house-life dials (built). 3: paranoia, loyalty, bond speed, alliance size, meeting frequency (built, above; the trust baseline deferred). 4: the house-mix guard rework (an across-seed average (ORW-825)
within a band plus a minimum between-season spread; numbers go to the owner). 5: credulity (built, above).
