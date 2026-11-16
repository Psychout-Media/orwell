# 0168 - Season house culture (slices 1-2: the foundation, then the house-life dials)

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

## The wall

`houseLeans` is Vault-class and engine-only: it appears in no projection, prompt, tool result, log or debug-safe view, and the module is in the
dependency-cruiser engine denylist. Its one outward door is the post-season retrospective (below).

## The retrospective reveal

Owner ruling (2026-11-12): the limited perspective is broken in the season retrospective - the same door as the rumor mill (0157, mandate #2 exception 3).
`RetrospectiveView.houseCulture?: { leans: string[] }`, built in `seasonRetrospective()` behind the `finished` crown gate: one short plain phrase per lean,
heaviest first ("a house that ran on gossip"). Never an id, label, weight or number. Absent when no culture was drawn, so seasons without one are
unchanged. The front-end retrospective window renders it as plain text; the host model's tool result leaves it out (like "the house you never saw").

## Later slices (not this spec)

2: the house-life dials (built, above). 3: baseline trust / bonding, loyalty, alliance size, meeting frequency. 4: the house-mix guard rework (an across-seed average
within a band plus a minimum between-season spread; numbers go to the owner). 5: credulity, after the conviction work merges.
