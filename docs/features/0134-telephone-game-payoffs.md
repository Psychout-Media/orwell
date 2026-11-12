# 0134 - Telephone-Game Payoffs

> **Retrospective note (written 2026-11-03, issue #1938).** This feature shipped flag-gated before any spec existed; this documents what was actually built from the merged code, not a forward design. Issue #1789; merged in PR #1903.

## Problem
Gossip already drifts with each retelling (0038/0094), but a drifted fact reached the player in the same voice as a first-hand one, so the comedy and the doubt of a telephone-game chain were lost.

## What shipped
- When a surfaced gossip fact has `hops >= 2`, its rendered row carries a provenance-texture word: `second-hand` (2 hops), `third-hand` (3), `everyone's saying` (4+). Under 2 hops the word is empty.
- New pure `provenanceWord(hops)` in `src/domain/humanize.ts` (sibling of `confidenceWord`). `hops` is plumbed through the player-knowledge reader -> `freshSurfacedFacts` -> `renderSurfacedFacts` (`GameSessionAdapter.ts`, `registry.ts`).
- A conditional deadpan-narrator guidance line (in `src/engine/momentPrompts.ts`) tells the narrator to deliver the drifted version straight and let the player's own memory supply the contrast.
- The 0094 `confront` lever is unmodified.

## Flag
The flag is `ORWELL_GOSSIP_DRIFT` (`gossipDriftEnabledNow()`), also the flag for the wider character-mediated gossip drift (#1397). Deploy default ON (`deploy/orwell-env-defaults.sh`). Flag OFF: the surfaced-facts object is byte-identical (no word, no guidance line).

## Vault Wall and anti-sycophancy
Only `hops` is carried, never source, pathway or original content; it becomes a word before rendering, so neither the raw number nor any chain-member id reaches the player. Presentation only: no outcome, fold or rng is touched.

## Tests
`tests/unit/humanize.test.ts`, `tests/unit/surfacedFactsDelivery.test.ts` (flag-OFF byte-identity and Vault assertions); `tests/unit/gossipDriftNeutral.test.ts` was run per the PR (not in its diff).

## Known gaps
Word reflects chain length only, not distortion magnitude. BDD-wired by ORW-300.
