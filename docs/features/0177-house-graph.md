# 0177 - The house graph (Theme 3, core 1: the graph half)

Status: built and wired engine-side. Owner: Overseer B. The bond-per-pair half is the Auditor's (ORW-552, spec 0175). The adapter derives the graph at most once per in-game day from the folded bond read (`foldedHouseGraph`, ORW-684), and three engine decisions read it: how news spreads (0179), the status read's hubs (0173) and group life's hubs and brokers (0172). Still never shown. The "no surface imports it" rule below still holds for every view, prompt, admin tool and MCP file.

## What it is
`deriveHouseGraph({ members, ties })` in `src/engine/houseGraph.ts` reads the shape of the house: cliques, hubs, loners, brokers. Pure, deterministic, total, Vault-free. It is never shown: the output is four lists of ids, no numbers, and no surface, admin tool or MCP file imports it (pinned in `tests/unit/houseGraph.test.ts` and the BDD feature). It replaces nothing and never reads or writes the relationship model.

## Rules (tunables in `houseGraphConstants.ts`)
- **Symmetrization = min of the two directions** (missing = 0). A one-sided lean is not a group; this equals the bond reader's own `tie(a, b)`. Strengths are clamped to [0,1]; NaN/unknown ids/self-ties are ignored.
- **Tie** = symmetrized strength >= 0.5 (the midpoint of the closeness scale).
- **Clique** = maximal group of >= 3 mutually tied members (Bron-Kerbosch); overlapping cliques are allowed.
- **Hub** = degree >= max(4, ceil(0.4 x (house - 1))), so it scales with the house.
- **Loner** = at most 1 tie and in no clique.
- **Broker** = ties to >= 2 members of each of two cliques whose other members do not overlap. By maximality that means the two sides are not all tied to each other. Brokers can never be loners.

## Inputs
`houseGraphFromReader(reader)` takes the local `GraphBondReader { living(); tie(a,b); day?() }`, which the Auditor's `BondReader` satisfies structurally. `deriveDailyHouseGraph(reader, prev?)` is the pure derive-daily helper (re-derives once per in-game day, otherwise returns `prev`). Neither is wired into `GameSessionAdapter` or the snapshot; that waits for the bond read API. Until it lands, the stub adapter tie is `clamp01((rel.bondStrength(a,b) - baseline) / DECISION.nomination.floaterBondSpan)`, symmetrized by min. Do not wire it from here.

## Gates
BDD `0177-house-graph.feature` (steps in `features/step_definitions/house_graph.steps.ts`) and `tests/unit/houseGraph.test.ts` (scenarios, totality, 200 seeded 16-member graphs: cliques valid, no loner in a clique, brokers never loners, order-stable).
