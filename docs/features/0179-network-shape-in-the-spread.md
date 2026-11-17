# 0179 - The house's shape in how news spreads (Theme 3 slice 9)

Card: ORW-552 (Ryne approved the Theme 3 plan, 2026-11-17). Executable spec: `0179-network-shape-in-the-spread.feature`. Plan: the vault note "Theme 3 Slice
Plan", slice 9. Code: `src/engine/networkSpread.ts` (pure); the co-presence spread's motive (`copresenceSpread.ts`); the adapter's `networkRoles()`; the
orchestrator's off-screen spread.

## What it is

Theme 2's co-presence spread decides, scene by scene, whether a holder passes a fact to the person they're with. Its motive is affinity to the listener, the
threat of the fact's subject and the fact's confidence. Now the house's **shape** adds to that motive. The shape is the house graph (0177): cliques, brokers and
loners, derived once a day from the bonds (0175).

- **Brokers carry news across.** A broker, tied into two cliques, telling someone outside the clique of the person the news is about gains `brokerBridge`.
  Information and leverage are the broker's trade.
- **Weak ties carry across.** Two houseguests in different cliques with a casual tie (closer than strangers, not close) gain `weakTieAcross`. Inside a close
  clique everyone already knows.
- **Loners hear late.** Holders bother less with someone tied to almost no one: `lonerDamp`.

A house with no shape (no cliques, no roles) adds nothing, so it spreads exactly as before.

## The wall and the rest

- Roles, motives and the graph are engine-only: they never reach a player or admin view.
- The spread keeps its own seeded rng per pair; this only moves the motive.
- Flag `ORWELL_NETWORK_SPREAD`: default ON. `=0` means the spread reads no shape (byte-identical).
- Measured, never gated: the house mix and the calibration gates run as usual. A spread that reaches more people faster can move gossip and beliefs.
