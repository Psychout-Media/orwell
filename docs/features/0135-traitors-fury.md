# 0135 - Traitors' Fury (jury bearing and misdirected blame)

> **Retrospective note (written 2026-11-03, issue #1938).** This feature shipped flag-gated before any spec existed; this documents what was actually built from the merged code, not a forward design. Issue #1790; merged in PR #1904 (amended by #1914).

## Problem
0110 vote deduction lets a juror deduce, possibly wrongly, who voted them out, but the finale did not let that held grudge show: jurors read as equally settled and the asking juror's question carried no flavor of their blame.

## What shipped
- Each 0110 deduction's possibly-wrong culprit conclusion is routed into the deducer-juror's knowledge and diffused through jury-house grievance gossip (the blame routing and diffusion live in `GameSessionAdapter.ts`, using `diffuseGossip` from `gossip.ts` and the jury-house graph from `juryHouse.ts`): content-only `diffuseGossip` (no `rel`/`subjects`) with a dedicated jury-house rng, so no new fold weight or rng draw; the `juryReach` band is unchanged.
- `finaleView().asking` carries a bearing word for the CURRENT asking juror only (questions stage, not every juror's view), `settled` / `cold` / `warm` / `burning`, from `BEARING_THRESHOLDS` in `src/engine/juryHouseConstants.ts` (grudge lower bounds 0, 0.02, 0.07, 0.13 on the 0..0.18 scale).
- The asking juror's question carries only the bearing word; since #1914 it carries no names and no held belief (see the amendment below).
- The vote reveal is regrouped for drama over the already-committed result (presentation-only; winner, finalists and tally identical ON vs OFF).
- Jury-house bearing scenes unseal only via the terminal-gated 0048 retrospective.
- Amended by #1914 (PO ruling 2026-11-02): `finaleView().asking.heldBelief` was REMOVED because it fed the narrator per-voter attribution of a secret ballot (E12). The bearing word stays.

## Flag
Flag `ORWELL_TRAITORS_FURY`, deploy default ON; flag OFF is a byte-identical finale.

## Vault Wall and anti-sycophancy
Only the bearing word crosses, never the grudge number. No voter attribution before the retrospective (E12). Neutral to the seeded spine: reveal order cannot change who wins.

## Tests
`tests/unit/traitorsFuryNeutral.test.ts`, `traitorsFuryFinale.test.ts` (pins `heldBelief` absent), `traitorsFuryRetrospective.test.ts`, `juryHouse.test.ts`; `juryReach` per the PR.

## Known gaps
The diffused blame belief is held in the jurors' own knowledge (never the player's) and is not exposed to the player at all before the retrospective.
