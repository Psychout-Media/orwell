# 0176 - Homophily and territory (Theme 3 slice 10, ORW-561)

Status: **part 1 (homophily) built**; part 2 (territory, tenure, the HOH room) pending.

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

## Part 2: territory (pending)

Territory, tenure and the HOH room: not started.

Gate: BDD `0176-homophily-and-territory.feature` + `tests/unit/homophily.test.ts`.
