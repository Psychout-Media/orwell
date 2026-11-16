# 0173 - Status, informal leaders and the HOH court (Theme 3 slice 11) - DRAFT, not built

Executable spec (drafted only): `0173-status-and-the-hoh-court.feature`. Not in `cucumber.cjs`; no step definitions. Awaiting the owner's approval of the Theme 3 plan.

## What it adds
A hidden pecking order (status from wins, allies, respect; challengeable), informal leaders with lieutenants, houseguests courting the HOH (the HOH room as a court), and a power vacuum with splits when a leader falls.

## Reuses (verified to exist)
- `src/engine/presence.ts` / `presenceConstants.ts` and `houseLife.ts` for where houseguests spend time (courting is movement toward the HOH room); the want-driven movement flag (A10, `ORWELL_WANT_MOVEMENT`, default OFF, k=1 measured) is the nearest precedent and must not be double-counted.
- `src/engine/campaigns.ts` (the HOH-courting pitch), `src/engine/alliances.ts` / `blocs.ts` (a leader's group; the split on a vacuum), `src/engine/relationships.ts` for respect and threat reads.
- Depends on the social core (Core 1, Auditor): the status read is derived from the house graph (hubs) plus comp wins.

## Data shape (engine-only)
Derived each day, saved only as history: `statusOrder: [{houseguest, tier}]` coarse tiers, `leader?`, `lieutenants[]`, `vacuumSince?`. Tiers, never a numeric score on any surface. Own seeded side stream.

## Open owner questions
- Is courting allowed to change nominations directly, or only the HOH's reads (plan implies reads only; recommended)?
- A calibration risk: HOH courting moves NPC presence, which can touch 0049 lingering and juryReach (A10 saw seed 18 fail at k>=1.5). Measure before any flag flips.
