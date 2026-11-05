# 0028 — Temperature & emotional-modifier constants

> **Status:** Built (see the [README status index](./README.md#index)). Firms [0006](./0006-outcomes-by-stats-and-temperature.md)'s *shape* (bounded
> per-moment temperature + a soul-sourced emotional modifier) into a **single tunable constants
> module** — the distributions, per-variable weighting, bounds, the emotional modifier's
> volatility/mean-reversion, and the **hidden-element surfacing rate**. Defaults match 0006's
> calibration (a clear favorite wins a **strong majority — ~66%** on a 0.9-vs-0.5 field — but loses
> **real upsets**; the player is **never protected**). **The shape is fixed; every number is config** —
> the sibling to the relationship constants (0026).
> **Executable spec:** [`0028-temperature-and-emotional-constants.feature`](./0028-temperature-and-emotional-constants.feature)
> **Also proven by:** `tests/unit/temperatureConstants.test.ts`
>
> **Calibration note (PO ruling 2026-07-06):** the headline was **~72%** at first draft; the **0006 PO
> retune** (competition temperature weight **0.36 → 0.40**, to make upsets a touch more common) lowered a
> 0.9-vs-0.5 favorite to a measured **~66%**. The spec + the calibration gate are re-centred on that
> reality: the win-rate band is **0.60–0.80** (floor widened from 0.65 for headroom), the **≥10% upset**
> and **no-player-protection** invariants unchanged. Retune the number, not the shape — this and 0006 move together.
>
> **Guard for the outcome-moving values (S15, Ryne 2026-11-05):** two retuned constants move outcomes without a band of their own here: the rest/sleep penalty (**0.20**, #1419) and `COMP_WON_IMPACT.threat` (**0.3**, pinned by `tests/unit/compWonImpactPin.test.ts`). The real guard for both is the weekly PO balance gate (`calibration-nightly`, bands in `tests/calibration/poTargetBands.ts`); a deliberate retune updates the pin and re-runs that gate.

## 1. Summary

Temperature is the per-moment variance/surprise of the whole sim — it rolls across *all* involved
variables (outcomes, expression, NPC initiative, which secret surfaces, alliance shifts,
volatility). 0006 fixed *how* it works and proved the calibration; 0028 fixes *the numbers* and puts
them in one place so the game's "swing" can be retuned without touching logic:

- **Bounded variance** — temperature shifts outcomes within bounds; it **never** overrides hard
  rules (eligibility, the Vault Wall) or archetype-grounded weighting.
- **Calibrated** — the favorite wins a **strong majority (~66%)** but genuine upsets happen; the
  engine **never protects the player**.
- **Soul-sourced emotional modifier** — a baseline (from `Character`/`Soul`) that grows more or less
  volatile with circumstances + temperature, and **mean-reverts** when things calm.
- **Rare hidden-element surfacing** — a houseguest's hidden elements surface **rarely**, gated by
  the temperature roll.

## 2. Scope

**In:** the temperature **distribution + bounds**; the **per-variable weighting** (which moments
roll, how hard); the **emotional modifier** constants (baseline, volatility scaling, mean-reversion
rate); the **hidden-element surfacing rate**; the **single tunable constants module**.

**Out:** the temperature **mechanism/shape** and the outcome resolution (**0006** — this firms its
numbers); the **relationship** constants (**0026** — sibling module); the **what** of each moment
(the game features that consume temperature).

## 3. Temperature distribution & bounds

A per-moment roll through the seeded `RandomnessSource`, **bounded** so it adds surprise without
breaking determinism-by-seed or hard rules. Default calibrated to 0006: stat-vs-type weighting +
the bounded roll yields the **~66% favorite win** with real upsets. The bound is config.

## 4. Per-variable weighting

Temperature is **not** one global multiplier — each variable it touches has its own weight:
outcomes, NPC expression/initiative, **which secret surfaces**, alliance shifts, emotional
volatility. The weights (how much temperature moves each) are config, so e.g. "more dramatic
expression, same outcome stability" is a tuning, not a rewrite.

## 5. The emotional modifier (constants)

From `Character`/`Soul` (decision 0001): a **baseline** stasis that grows more or less volatile with
adverse/positive circumstances + the temperature roll, and **mean-reverts** toward baseline when
calm. Constants: the baseline, the **volatility scaling** (how much circumstance/temperature swings
it), and the **mean-reversion rate** (how fast it settles). It is a `Character`/`Soul` attribute, a
competition input — **never a fourth stat**.

## 6. Hidden-element surfacing rate

Generated houseguests carry **tons of hidden elements**; they surface **rarely**, gated by the
temperature roll (0003/0004). The **rate** is config and **bounded low** — surfacing is a treat, not
a flood. Too high floods the game; too low and secrets never pay off.

## 7. Tunable constants (one place)

**Every number** — temperature bound + distribution, the per-variable weights, the emotional-
modifier baseline/volatility/mean-reversion, the surfacing rate — lives in **one config module**
(sibling to `richnessConfig.ts` and the relationship constants, 0026). **Shape fixed (0006);
numbers config** — a future admin/God-Mode tuning knob (0016) without code changes.

## 8. Contracts (stack-agnostic)

```
TEMPERATURE_CONSTANTS = {                            # the single tunable module
  bound, distribution, variableWeights,             # the roll + per-variable weighting
  emotional: { baseline, volatilityScale, meanReversionRate },
  hiddenSurfacingRate,
}
temperatureRoll(moment, rng) -> number              # bounded; seeded
emotionalModifier(character, soul, circumstances, temperature) -> number   # §5; mean-reverts when calm
```

**Invariants:** the favorite wins a **calibrated strong majority (~66%)** with real upsets; the
player is **never protected**; temperature is **bounded** and **never** overrides hard rules; the
emotional modifier **mean-reverts**; hidden elements surface **rarely** (bounded rate); **all
numbers are config** (changing one changes the behavior); seed-reproducible.

## 9. Test strategy

- **Calibration holds:** over many seeds the favorite wins ~66% (the 0006 property), upsets are real
  but uncommon, and the player loses when the dice say so (unprotected).
- **Bounded + rule-safe:** temperature never produces an illegal outcome or leaks the Vault.
- **Mean-reversion:** after a spike, the emotional modifier settles toward baseline over calm
  moments.
- **Rare surfacing:** hidden elements surface at the configured low rate over seeded play — present
  but rare.
- **Tunable:** changing a constant changes the resulting distribution (the config is the knob).
- **Seed-reproducible** throughout.

## 10. Definition of Done

- [ ] Temperature, per-variable weights, the emotional modifier, and the surfacing rate come from
      **one tunable constants module**.
- [ ] Default calibration matches 0006 (~66% favorite; real upsets; player unprotected; bounded).
- [ ] The emotional modifier mean-reverts; hidden elements surface rarely (bounded).
- [ ] No number is hard-coded outside the module; the shape stays fixed (0006).
- [ ] All checks seed-reproducible.

## 11. Dependencies

**0006** (the shape this firms + the calibration property), **0001/0004** (Character/Soul + hidden
elements), **0003** (rare surfacing thresholds), **0026** (sibling relationship constants), the
seedable `RandomnessSource`. Builds on the existing `src/domain/temperature.ts` /
`competitionOutcome.ts` and `src/engine/richnessConfig.ts`.

## 12. Traceability

`CLAUDE.md` (temperature is per-moment, bounded, never overrides hard rules; the emotional modifier;
hidden elements surface rarely); open decision #1 ("Temperature & emotional-modifier constants —
distributions, per-variable weighting, bounds, surfacing rate, volatility/mean-reversion… the
*shape* is fixed; the numbers are tunable config"); `docs/features/0006`, `docs/decisions/0001`.
