# 0109 — Negotiated deal duration (when does a promise expire — and when do you turn?)

**Also proven by:** `tests/unit/dealDuration.test.ts`

> **Status:** ✅ **BUILT (2026-06-27) and BDD-gated in `cucumber.cjs`** (`tests/unit/dealDuration.test.ts` + the feature). Originally drafted 2026-06-27 from an owner edit during the PO-review sweep as BUILD-READY
> (amends **0039**, the deal ledger). Owner direction in `docs/decisions/PO-DECISIONS-LOG.md` (2026-06-27).
> **Builds on (does NOT duplicate):** **0039** (the first-class `Deal` / `DealLedger` —
> `src/engine/deals.ts` + `src/domain/deal.ts`, `horizonOf(kind)`), **0026** (the betrayal-shock
> relationship fold), **0017** (the directed, asymmetric relationship model), **0014/jury**
> (jury-management demerits). **Bounded by:** mandate #2 (Vault Wall — player **and** admin), mandate #3
> (anti-sycophancy — the engine owns the bounded, seeded *magnitude*; the model never bends an outcome),
> mandate #4 (non-degradation), ADR **0005** (split authority by openness — the model proposes the fuzzy
> "how long" as open-set prose; the engine keeps the bounded interpretation), ADR **0003** (the
> conversation is the game).

## Why — the gap this closes

Today a deal's lifespan is **implicit by kind**: `safety`/`vote` quietly expire at that week's eviction;
`final-two`/`target-other` run until broken or the season ends (`horizonOf(kind)`). There is no notion of
"we're tight **for two weeks**." So two of the most _Big Brother_ things are missing:

- **A promise with a negotiated term** — "keep me safe through the next two evictions, then we're free."
- **The drama of *when* to turn on an ally.** Today a betrayal is a flat flag. There is no sense of a deal
  *nearing its natural end* (a discounted, almost-expected betrayal) versus stabbing someone you **just
  renewed** with (a maximal shock). "When do you turn?" should be a weighted decision, not a binary.

## The mechanic

A `Deal` (0039) gains an optional negotiated **duration**, in exactly one of two forms:

- **Explicit** — a term the parties named out loud → an `expiresWeek` on the deal (made week 3, "two weeks"
  → `expiresWeek: 4`; the current week counts). This generalizes today's kind-implied horizon.
- **Vague** — the parties left it open / unspoken → the deal is simply **labeled `vague`** (a flag on the
  deal). **No numeric expiry, and NO per-party belief object** (owner ruling: *"just labeled as vague is
  enough"*).

### Betrayal-shock scales with remaining deal life (0026)

When a binding action breaks a deal, the seeded betrayal-shock magnitude is modulated by how much life the
deal had left:

- **Explicit, broken with term remaining** → a **larger** betrayal-shock the more life was left (breaking a
  two-weeks-left deal hurts more than one about to lapse).
- **Explicit, broken at/after `expiresWeek`** → **not a betrayal** (no shock fold): turning after a
  mutually-known expiry is fair game.
- **Vague, broken** → a **softer, fuzzier** shock — built-in ambiguity, since neither party can claim a
  clean named term was violated. This is the drama lever, achieved **without** modeling two separate
  beliefs: vagueness *discounts* the betrayal.

So holding until a deal is near/at its end costs little; turning early pays the full betrayal price.

### What stays exactly as-is (additive, not a rewrite)

- **No duration / no label ⇒ byte-identical to 0039.** A deal with neither an `expiresWeek` nor the `vague`
  flag reconciles exactly as today (`horizonOf(kind)`). Pre-0109 saves load unchanged (absent ⇒ kind-implied
  horizon, no vague flag).
- **Honoring folds, reconciliation, jury demerits, and persistence are unchanged in shape** — duration only
  modulates the *break* magnitude and the *expiry* resolution.

## ADR 0005 — shape vs. magnitude

- **Open set (the model proposes shape).** *Whether* a duration was negotiated and the fuzzy "how long"
  wording live in the open-set `terms` prose; the model voices the negotiation as richly as the scene wants.
- **Closed set (the engine owns magnitude).** The `expiresWeek` the engine reconciles against, the `vague`
  flag, and the **seeded betrayal-shock magnitude** (including the remaining-life scale and the
  vague-softening factor) are bounded and engine-owned. The model never proposes an amount.

## The Vault Wall & anti-sycophancy

- **No magnitude crosses, to player OR admin.** The betrayal size, the remaining-life scale, and the
  vague-softening factor are Vault-hidden. The player sees the **deal terms** (including an `expiresWeek`
  they themselves negotiated — that is the player's own knowledge) and the **observable fallout** (a
  houseguest's reaction), **never** a shock size. A sentinel sweep over the assembled player/admin surfaces
  finds no derived magnitude.
- **The engine owns the magnitude.** The model cannot pump a "huge betrayal" by wording it that way — it
  proposes the shape, the engine sizes the fold (the `expressiveNonCollapse` sibling discipline).

## Persistence (0007/0030 — non-degradation)

`expiresWeek?` and the `vague` flag serialize with the `Deal` and survive a restart (lossless — the ledger
deepens, never thins). `expireWeekScoped` generalizes to honor an explicit `expiresWeek` (a deal whose named
term has passed un-broken resolves `kept`).

## Testability (role-only; HARD rules)

- **Back-compat:** a deal with no duration and no label reconciles **byte-identically** to 0039 today.
- **Explicit expiry is fair game:** an action breaking a deal **after** its `expiresWeek` folds **no**
  betrayal-shock; **before** it, the shock **scales up** with the weeks remaining.
- **Vague softens:** a broken `vague` deal folds a **smaller** betrayal-shock than an explicit deal of equal
  nominal life broken at the same moment.
- **No number crosses (player AND admin):** the negotiated `expiresWeek` may appear as a player-facing deal
  *term* (the player's own knowledge), but no derived shock/scale magnitude appears on any projection.
- **Determinism / calibration-neutral:** seeded; byte-identical `juryReach`/UAT on the untouched
  (no-duration) path.

## Dependencies & traceability

Amends **0039** (deals); folds via **0026** (betrayal-shock) / **0017**; feeds **0014** (jury-demerit
weighting); persisted by **0007/0030**; under **0001** (Vault Wall) and **0021** (isolation), on ADR **0005**.
Source: an owner edit during the 2026-06-27 PO-review sweep (`docs/decisions/PO-DECISIONS-LOG.md`). Turns a
deal's lifespan from an implicit kind-horizon into a **negotiated, dramatic term** — and makes "when do you
turn on an ally?" a real, weighted decision.

## Addendum (2026-11-03, #1993) — the producer

The ledger accepted a `duration` from the start, but nothing in play ever passed one, so the term, the
severity scaling, `expireWeekScoped`'s explicit-term path and the daily-recap `nearingExpiry`/`vague` hook were
unreachable. Now:

- `makeDeal` takes an optional `term: { weeks?, vague? }`, **proposed by the narrator** from what the scene
  actually named ("this week only" = `weeks: 1`; "for two weeks" = `weeks: 2`; unspoken = `vague: true`).
- The **engine validates and bounds it** (`boundDealTerm`, `src/engine/deals.ts`): `weeks` counts the current
  week (`expiresWeek = madeWeek + weeks - 1`), must be a finite integer ≥ 1, is clamped to
  `DEAL_DURATION.maxTermWeeks` (12); junk is ignored; an explicit term beats `vague`. No usable term ⇒ the
  kind-implied horizon, byte-identical to before.
- The live break path now passes `currentWeek` into the reconcile sink — without it an explicit term could never
  scale a break even once recorded.
- `DealView.term` shows the player their own negotiated term (`expiresWeek` / `vague`) and nothing derived.
- FE: `makeDeal` schema + `do_make_deal` + `orwell_engine.make_deal` forward `term` (shape-filtered only).
- Scenarios 2–5 run the live session path; scenario 1 stays standalone (a pure-fold floor claim).
- NPC-offered deals (0123) and the auto pact still carry no term — the narrator only proposes terms for deals the
  player strikes in a scene.
