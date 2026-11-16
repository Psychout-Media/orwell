# 0159 - Season house culture (slice 1: the foundation)

Card: ORW-551. Executable spec: `0159-house-culture.feature`. Unit gate: `tests/unit/houseLeans.test.ts`.

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
- **Nothing consumes `dialMult` yet** (slices 2+ wire the dials), so the house mix and every seeded sim are byte-identical: a played game with the flag on
  or off differs only in the `houseLeans` field.

## The wall

`houseLeans` is Vault-class and engine-only: it appears in no projection, prompt, tool result, log or debug-safe view, and the module is in the
dependency-cruiser engine denylist. Its one outward door is the post-season retrospective (below).

## The retrospective reveal

Owner ruling (2026-11-12): the limited perspective is broken in the season retrospective - the same door as the rumor mill (0157, mandate #2 exception 3).
`RetrospectiveView.houseCulture?: { leans: string[] }`, built in `seasonRetrospective()` behind the `finished` crown gate: one short plain phrase per lean,
heaviest first ("a house that ran on gossip"). Never an id, label, weight or number. Absent when no culture was drawn, so seasons without one are
unchanged. The front-end retrospective window renders it as plain text; the host model's tool result leaves it out (like "the house you never saw").

## Later slices (not this spec)

2: the house-life dials. 3: baseline trust / bonding, loyalty, alliance size, meeting frequency. 4: the house-mix guard rework (an across-seed average
within a band plus a minimum between-season spread; numbers go to the owner). 5: credulity, after the conviction work merges.
