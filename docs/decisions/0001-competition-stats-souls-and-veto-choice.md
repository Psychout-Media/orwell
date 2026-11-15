# 0001 — Competition stats, the Character/Soul split, and veto "Houseguest's Choice"

> **Status:** Accepted. The binary `ALLIES` / `BEST_FRIEND` idea in §3 of the first draft is
> **superseded** by the calculated, organic relationship model in
> [decision 0002](./0002-relationship-model.md).
> **Source:** human spec feedback (this session), refining `README.md`.

## Context

Two refinements to the canonical mechanics, plus an architecture question about where
"character" stats live. Captured here so the feature specs (0004, 0005, 0006) and the
canonical-mechanics summaries stay consistent.

## Decisions

### 1. Drop the Luck stat — **Accepted**

Competition stats are **Physical, Mental, Social** only. There is no Luck stat or modifier.

### 2. Add a soul-sourced **emotional modifier** — **Accepted**

Competition outcomes apply an **emotional modifier** alongside the per-moment temperature
roll. Emotional state is **not** a fourth competition stat — it is a **character/soul
attribute** that *modulates* outcomes (and behavior).

**It is a moving value, not a constant.** Each houseguest has a **baseline emotional
disposition** (a "stasis") set by `Character` temperament and shaded by current `Soul`, plus a
**volatility trait** (how reactive they are). Current emotional state drifts from baseline in
response to **surrounding circumstances** (adverse or positive events), the **size of the
swing scaled by volatility × the temperature roll**, and it **mean-reverts** toward baseline
when things are calm. A steady archetype barely moves; a volatile one on tilt after a blow-up
competes very differently. The modifier reads this *current* state.

Unpredictability the Luck stat used to provide now comes from **temperature + emotional
state**, both driven through the seedable `RandomnessSource`.

### 3. Static `Character` vs dynamic `Soul` — **Accepted**

Split each houseguest's data into two facets behind `SoulProvider` / `CharacterFactory`:

- **`Character` (static — "facts"):** what is true / what has happened — archetype, **core
  Physical/Mental/Social aptitudes**, identity, backstory, baseline temperament. Set at
  generation; rarely changes.
- **`Soul` (dynamic, md + vector):** evolving state — current **emotional** state, accumulated
  memory, shifting leanings, and the **relationship beliefs** (decision 0002). Changes
  throughout the game.

The competition **emotional modifier** (decision 2) and the veto **Houseguest's Choice**
selection (decision 4) both read the **dynamic `Soul`**.

> Confirmed by the human: *character is facts / archetypal; soul is dynamic.* The first
> draft's binary `ALLIES` / `BEST_FRIEND` flags are **dropped** and re-architected as the
> calculated, **organic** relationship model in
> **[decision 0002](./0002-relationship-model.md)** (no stored labels).

### 4. Veto "Houseguest's Choice" — **Accepted**

The veto field is still six (HOH + two nominees + three by chip draw), but — as on the real
show — one chip in the bag is **"Houseguest's Choice."** Whoever draws it **selects** the slot
instead of receiving a random name:

- An **NPC** holder chooses by **soul motivation** — their strongest, most-trusted *available*
  bond as scored by the relationship model (decision 0002), with temperature variance (never a
  stored flag).
- The **player** has no influence over *which* chips are drawn, but **if the player draws
  Houseguest's Choice they pick** — the single bit of player agency in the draw.

## Rationale

- Luck was a thin, characterless randomness knob; temperature already supplies seeded
  variance, and an **emotional** modifier supplies variance that is *grounded in character*,
  serving behavioral fidelity (the #1 mandate) instead of pure noise.
- Putting emotional state and relationships in a **dynamic** store (vs. static baseline) keeps
  competition aptitudes stable while letting mood, alliances, and memory **deepen over the
  game** — aligned with the non-degradation mandate.
- Houseguest's Choice adds authentic *BB* texture and a real consequence for the soul's
  **relationship graph** (decision 0002), without handing the player control over the draw.

## Consequences (specs updated with this record)

- `docs/features/0004-replayability-and-naming.md` — `SoulProvider` split into
  `characterOf` (static) / `soulOf` (dynamic); relationship beliefs (decision 0002) noted.
- `docs/features/0005-competition-eligibility.{feature,md}` — veto draw now includes the
  Houseguest's Choice chip and its holder's selection; a new scenario covers it.
- `docs/features/0006-outcomes-by-stats-and-temperature.{feature,md}` — Luck removed; the
  emotional modifier added; "variance" replaces "Luck" in the predictability scenario.
- `README.md` and `CLAUDE.md` — canonical-mechanics summaries updated.

## Open / to confirm

- The **emotional-modifier weighting** and the **volatility / mean-reversion** constants are
  part of the still-open temperature/0006 tunable config (numbers, not shape).
- The relationship model's signal set and math live in
  **[decision 0002](./0002-relationship-model.md)**.

## Traceability

`docs/bb-sim-spec.md` §7 (deep, evolving characters), §8 (temperature);
`docs/legacy/BB_GameBible.md` §4–§5 (veto of six; stats); human feedback (this session).

## Amendment 2026-11-14 (ORW-381, owner-ruled by Kevin)

A houseguest's public build leans toward their physical competition stat at character creation: a hint, not a readout. The engine reads the hidden physical stat once, inside the engine, to pick a fitness band with noise (its own `${seed}:build-band` side stream), then deals a build description of that band. Only the words are stored and projected, never a number, band or stat-derived field. This is the fourth sanctioned exception to the Vault Wall (CLAUDE.md mandate 2); stats still decide every outcome and nothing reads the build back.
