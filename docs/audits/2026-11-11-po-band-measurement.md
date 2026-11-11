# 2026-11-11 - PO-band measurement per flag-on layer (ORW-81) and B32 betraying-arm acceptance

Measurement only. Balance is reported, never a gate or a tuning target (Ryne, 2026-11-05: "Them not fitting the difficulty is not a gate to keep them off."). No engine behaviour or constant was changed.

## Headline

- Every flag in the B53 plan now defaults ON, so "per flag-on layer" was measured as **ablation**: the shipped default vs each layer switched off (`=0`) vs everything off (`ORWELL_FLAGS_OFF=1`).
- On the shipped default, **solid reaches F2 32% and wins 19%** against the PO bands of 12-20% / 8-12%: both above band (measured, 100 seeds). Passive (9% / 2%) and reckless (5% / 5%) are inside their bands. Reckless wins are not above passive beyond noise.
- The all-off baseline is also above band on solid reach-F2 (45%), so the high solid numbers are not caused by the flag layers; the layers pull solid reach **down** (45% -> 32%) and solid wins **up** (14% -> 19%).
- **B32 betraying arm: hardened share 100% (149/149 drifted) with the fix on, 0 drifted with it off** (bar: >= ~25%). Only neutral-baseline NPCs can newly harden; all 149 did.
- **The PO instrument (`tests/calibration/calibrationArms.ts`) was dead on main**: every season stalled at the premiere (`advanceGame` returns typed `held`, ORW-116) so `calibrationPoTarget` threw "season did not finish" for every seed. Fixed here (test-harness only, same handling as `juryReachShared.ts`); see Method.

## Results (100 seeds per arm, same seeds 1..100 in every row)

Cell = reached F2 % / won %. Bands (from `tests/calibration/poTargetBands.ts`): passive F2 <= ~15%, win < 5%; solid F2 12-20%, win 8-12%; reckless no higher than passive. "Violations" is the output of `poViolations()` (80% interval rule, so a point estimate near an edge is not flagged).

| config | passive | solid | reckless | `poViolations` |
|---|---|---|---|---|
| **default (all flags on, shipped)** | 9 / 2 | 32 / 19 | 5 / 5 | solid reach-F2 32% above 12-20; solid win 19% above 8-12 |
| all flags off (`ORWELL_FLAGS_OFF=1`) | 20 / 3 | 45 / 14 | 16 / 5 | solid reach-F2 45% above 12-20 |
| group 1 off: want-driven (DESIRE_CLOCK, WANT_MOVEMENT, MORNING_APPROACH, LOBBYING, ASSURANCES, VETO_MEMORY, DEAL_NOMS, CAMPAIGN_MEMORY, VOTE_COUNT) | 12 / 3 | 30 / 16 | 8 / 4 | solid reach-F2 30% above 12-20 |
| group 2 off: memory-in-decisions (HC_MEMORY, APPROACH_MEMORY, GOSSIP_COPRESENCE) | 9 / 5 | 27 / 11 | 2 / 2 | solid reach-F2 27% above 12-20 |
| group 3 off: emotion block (NPC_TELLS, TELL_REACTIONS, MOOD_VETO/APPROACH/DEAL/CAMPAIGN, DRIFT_FIX, DRIVE_DECISIONS) | 14 / 10 | 23 / 11 | 5 / 5 | passive win 10% not under 5 |

Other columns for the default run (wins / F2 reach / jury reach): passive 2 / 9 / 84; solid 19 / 32 / 87; reckless 5 / 5 / 81. Mean decided week: passive 9.3, solid 10.7, reckless 9.0. Solid conversion at F2 (wins / reached F2): default 19/32 (59%), all-off 14/45 (31%), group 1 off 16/30, group 2 off 11/27, group 3 off 11/23.

### Reading the table

- Noise: at n=100 the standard error of a 20% rate is about 4 points and of a 5% rate about 2 points. Differences under roughly 8-10 points between two rows are not distinguishable from sampling noise; do not read single-digit moves as effects.
- Only large, probably-real moves: (1) default vs all-off, solid reach-F2 45 -> 32 and passive reach-F2 20 -> 9, reckless 16 -> 5 (the layers make it harder to *reach* F2 for every arm); solid conversion at F2 roughly doubles (31% -> 59%). (2) Group 3 off: passive wins 2 -> 10 (a within-noise-looking move on 2 vs 10 wins, but the only one that crosses a band; treat as a flag to re-run at 300 seeds, not a conclusion). Groups 1 and 2 off are within noise of the default on every arm except reckless reach (5 -> 2, a 3-win difference).
- This is a layer-group ablation, not a one-flag-at-a-time screen. A flag that "moved nothing" here is not shown inert; individual flags were not isolated.

## B32 acceptance (ORW-33 betraying arm)

`tests/calibration/driftMeasure.test.ts` ("betraying arm"): per seed a fresh house; the player records 3 betrayal scenes against every houseguest via `rememberPlayerScene`; NPCs whose effective disposition differs from baseline are counted. 40 seeds x 15 NPCs = 600 NPCs.

| ORWELL_DRIFT_FIX | NPCs | drifted | hardened | softened | hardened share | by baseline (n / hardened) |
|---|---|---|---|---|---|---|
| off | 600 | 0 | 0 | 0 | n/a | clash 201/0, bond 250/0, neutral 149/0 |
| on | 600 | 149 | 149 | 0 | 100% | clash 201/0, bond 250/0, neutral 149/149 |

Bar was hardened >= ~25% of the drifted set: met (100%). The "scripted arm yields 0 hardened NPCs" caveat from the card still stands for the **solid/reckless play arms** (the first test pair in that file, not re-run here); the betraying arm is what shows hardening is reachable. Caveat: every neutral NPC hardens after 3 betrayals each, which says the drift is reachable, not that its rate is well tuned for natural play; clash and bond baselines never move by design.

## Method

- Instrument: `tests/calibration/calibrationPoTarget.test.ts` shard mode (`ORWELL_PO_ARM/FROM/TO/OUT`), 3 arms x 8 seed slices run in parallel (24 processes) on the 10.0.1.98 runner via `/home/ryne/orwell-locks/remote`; shards recombined with `summarize()` + `poViolations()`. Engine-only seeded sims through the production `composeRuntime`; **no model call of any kind**.
- Each config = `env` switches only (`=0` for default-on flags; `ORWELL_FLAGS_OFF=1` for all-off). Seeds 1..100, identical across configs.
- Wall time: about 4.3 minutes per 100-seed x 3-arm config (about 12-14 CPU-seconds per season); the 300-seed run the plan calls for is about 13 minutes wall on that runner.
- Harness fix (the only code change, `tests/calibration/calibrationArms.ts`): on a `held` advance, call `endHeldNight(..., { direct: true })` and set `ORWELL_BEDTIME_GATE=0`, exactly as `tests/property/juryReachShared.ts` does. The night HOLD stays on; only the narrator-facing bedtime refusal is off for the sim player. No assertion or band was touched. Consequence: these runs are on the default profile with the bedtime gate off.
- Not the same as the 2026-06-21 measurement (`2026-06-21-session-observations.md`: active 20% vs passive 7% at 30 seeds): that predates the flag flips, ORW-116 and the premiere; do not compare rows directly.

## Not measured / caveats

- **Not run:** the B53 pass-1 *per-flag* screen (about 20 flags x 100 seeds, about 90 minutes wall at this runner's rate) and the 300-seed confirm runs; only the baseline, all-off and three group ablations. `juryReach` / `calibrationGradient` property tests were not run (their data is the same arms; heavy lanes cover them in CI). No "everything the owner wants on" combined run beyond the default (which is already all flags on).
- 100 seeds is a screen: solid-arm band misses (32/19 default) are large enough to hold up against noise (the 80% interval on 19/100 wins is about 14-25%, above 12%), but reckless/passive small-count comparisons are not.
- The scripted arms make almost no player pitches, so LOBBYING, ASSURANCES and player-pitch campaigns are under-exercised (plan "Limits"). Group 1 being near-flat is "not measurable by the bands", not "no effect".
- Bands measure outcome distribution, not texture.
- Group 3 off contains `NPC_TELLS`, the prerequisite of the other tells flags, so it removes the whole mood layer together with drift fix and drive decisions.

## Plane summary (ORW-81)

Measured on shipped defaults at 100 seeds: passive F2/win 9%/2%, solid 32%/19%, reckless 5%/5%. Passive and reckless inside bands; solid above both its reach (12-20) and win (8-12) bands. All-flags-off is solid 45%/14% (also above band), so the layers lower reach and raise conversion; they did not create the overshoot. Ablating want-driven (group 1) or memory (group 2) layers moves nothing beyond noise; ablating the emotion block (group 3) lowers solid reach to 23% and raises passive wins to 10% (one to re-check at 300 seeds). B32: betraying arm hardens 149/149 drifted NPCs with the fix on, 0 off (bar 25%). Reported, not tuned. Also fixed: the PO instrument could not finish any season on main (ORW-116 held night). Open: per-flag screen and 300-seed confirm, not run.
