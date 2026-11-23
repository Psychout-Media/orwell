# 0176 - Homophily and territory (Theme 3 slice 10, ORW-561)

Status: **part 1 (homophily) and part 2 (territory) built**.

## Part 1: like attracts like

In a real house people drift toward people like them. Two houseguests who share a look, an age, a part of the country, a kind of job or a temperament warm to each other a little faster and take a slight a little less hard; a mismatched pair the reverse. It is a nudge on the SPEED of a bond, never a verdict: individuals still surprise.

### How it works

- `src/engine/homophily.ts` (pure, no rng, no I/O) scores two houseguests 0..1 from PUBLIC facets only: age gap, style family (same family, then same loose cluster), archetype closeness (shared strategy styles), region (from the hometown), and job sector. A facet that is missing or unreadable counts as neutral. It never reads the Vault: no stats, no hidden elements, no soul disposition.
- `pairBondMult(a, b) = 1 + (similarity - CENTER) x SPAN`, clamped to `[1/F, F]` with `F` the house-culture bound (1.35). `CENTER` (0.34) is the measured mean similarity over seeded casts, so the nudge is mean-neutral across a house. Tunables live in `src/engine/homophilyConstants.ts`.
- The multiplier rides the existing bond-fold seam (`GameSessionAdapter.socialFoldValence`), now asked per edge: WARMING components are multiplied, SOURING components are divided, composed with the house culture's bonding dial. The jitter draws of the fold are the same whatever the magnitude, so the seeded random streams are never perturbed. A no-op multiplier returns the same valence as before.
- Fold sites: the player-channel `recordInteraction` partner, generative and third-party folds (`EngineCommandsAdapter`), and the off-screen scene fold (`orchestrator`). The bystander read and the player's own reciprocal feeling are not scaled.
- Played games only (`live.playedGame`), like the culture dials, so headless calibration is untouched. Flag `ORWELL_HOMOPHILY`, default ON, `=0` opts out.
- Engine-only and Vault-free on the way out: no similarity or multiplier reaches any projection, tool result, prompt or admin view; the module is in the dependency-cruiser engine denylist.

### Not in part 1

Move-in seeding of relationships, the base occupancy, beds (ORW-466), and courting the HOH (slice 11) are unchanged.

## Part 2: territory

A house sorts itself by where people spend their hours: the kitchen crowd, the backyard set, the pair who share a bedroom. Hidden mechanics: the engine decides, the narrator voices, no number or roster ever surfaces.

- **Tenure** (`src/engine/territory.ts`, `live.tenure`): a hidden map of hours per houseguest per room. After the hour's walk, each awake houseguest's hour accrues to the room they ended up in (`GameSessionAdapter.houseLifeStretch`). Monotonic (a non-positive amount does nothing), saved in the snapshot as an optional field (an older save loads without it and simply starts accruing), Vault-class and engine-only (in the dependency-cruiser denylist). The HOH room is recorded like any room: slice 11 reads that time for the HOH court. No courting weight lives here, and the Diary Room is never recorded.
- **Regulars**: `topRoomOf` is the room a houseguest has spent the most hours in (at least `MIN_HOURS`, hangout rooms only: not the HOH room, not the Diary Room); `regularsOf(room)` is whoever's top room that is. Engine-only reads.
- **Partner choice**: in `chooseHourAction`'s ordinary-life partner pick, someone who shares the holder's top room gets a small additive (`PARTNER_PULL`, 0.06 on a score of `affinity + roll x 0.3`). No extra draw, so the seeded streams are untouched; absent set means byte-identical.
- **Bloc nudge**: roommates (the same bedroom, from `live.beds`) get `ROOMMATE_NUDGE` and a shared top room `SHARED_ROOM_NUDGE`, summed and capped at `NUDGE_CAP` (0.05), added to the MUTUAL BOND INPUT of bloc detection (the `allianceTie` seam into `detectBlocs`) and of NPC alliance formation (`formNpcAlliances`). The alliance floors (`npcAllyFloor` 0.58, `joinBondFloor` 0.45) and `maxNpcSize` are not moved, and `pickBedFor` is untouched.
- Played games only (`live.playedGame`), so headless calibration is byte-identical. Flag `ORWELL_TERRITORY`, default ON, `=0` opts out.
- Seam note: a "cliquey" house culture could scale `TERRITORY.*` later; no lean reads it yet.

### TODO (not built) (ORW-825)

A words-only line in the post-season retrospective behind the finished gate ("the kitchen crowd", "the backyard set", "a bedroom that became a bloc"). `describeTerritory` (pure, words only, no digits) is ready; surfacing it needs the `RetrospectiveView` type, the front-end tool pass-through (as `houseCulture` has) and the retrospective window.

Gate: BDD `0176-homophily-and-territory.feature` + `tests/unit/homophily.test.ts` + `tests/unit/territory.test.ts`.
