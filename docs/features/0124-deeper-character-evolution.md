# 0124 — Deeper character evolution (multi-axis affect · temperament drift · personality-tuned reactivity)

> **Status:** ✅ Built (BDD/TDD-first; BDD-gated in `cucumber.cjs`). **Expands 0041** (character evolution & season arc) per the PO review
> (2026-07-12). 0041 made a season *change* a houseguest — but the change is **one dial** (a single
> confidence↔distress slider + volatility), personality-flat (an NPC's reactivity is a **random draw**, not
> their character), and mood-only (their *strategy* never hardens). This deepens all three, so the house
> evolves like real people: independent feelings, a temperament that bends under pressure, and reactivity
> that actually reflects who each houseguest is. Hidden layer only; **calibration-safe** (one flag, code default ON since #1996 - `ORWELL_SOUL_DEPTH=0` is the rollback, ON in the deploy profile
> ⇒ byte-identical when off) so the seeded spine is untouched (it once also protected the golden fixture; golden replay decommissioned 2026-07-21).
> **Executable spec:** [`0124-deeper-character-evolution.feature`](./0124-deeper-character-evolution.feature)
> **Also proven by:** `tests/unit/deeperEvolution.test.ts`

## 1. Summary

0041 landed the linchpin: consequential events move a houseguest's hidden soul, that bends their play, and
it accumulates into a recall-able arc. The PO review found three ways it's still thinner than a real _BB_
houseguest — this feature closes all three, under one flag:

1. **Multi-axis affect.** Today a houseguest's mood is **one slider** (distress ↔ confidence) — so they
   can't be *both* cocky and on-edge, which real players constantly are. Split it into **independent
   `distress` and `confidence` axes** (plus the existing `volatility`), so a houseguest can ride a comp
   win high *while* rattled by a blindside — and behave accordingly (bold but erratic).
2. **Strategic-temperament drift.** Today only their *mood* drifts; their **strategy** never hardens. A
   houseguest burned again and again should slowly turn **more paranoid/defensive** — a bounded
   **temperament drift** at the soul level that bends their effective disposition and **mean-reverts** toward
   their true baseline when things calm. The static CHARACTER never changes; the soul does.
3. **Personality-tuned reactivity (the PO's question).** Today an NPC's **starting volatility is a random
   draw** — disconnected from their character (the player's is already disposition-derived). Wire each NPC's
   **starting volatility AND their settle rate to their disposition**, so a **combative/temperamental**
   houseguest is genuinely **more sensitive on the on-edge dial and settles slower**, while an even-keeled one
   shrugs shocks off — exactly as their personality reads.

All hidden (the player feels it only through behavior, never a number), CHARACTER byte-stable (0007),
persisted (0030), deterministic, and **calibration-neutral when off**.

## 2. What exists today (the gap this closes)

| | Today (0041) | After 0124 |
|---|---|---|
| **Affect model** | one `emotionalState` scalar (distress↔confidence) + `volatility` | + **independent `distress` & `confidence`** axes |
| **Strategy over time** | static disposition — never bends | + a bounded, mean-reverting **temperament drift** (effective disposition) |
| **NPC reactivity source** | `volatility = rng.next()` — **random, personality-flat** | **`VOL_OF[disposition]`** + disposition-scaled settle rate (draw-preserving) |
| **Player reactivity** | already `VOL_OF[disposition]` | unchanged (NPCs now match) |

- `src/engine/emotionalArc.ts` `evolveEmotion` moves the single `emotionalState` via
  `circumstance = valence * (0.5 + soul.volatility)` — volatility already scales the swing, but the
  *starting* volatility is a flat random draw for NPCs (`characterFactory.ts` `const volatility = rng.next()`),
  so a "temperamental" archetype is only reactive **by luck**. `VOL_OF = { clash: 0.7, bond: 0.3, neutral: 0.5 }`
  already exists and is used for the **player** — this feature extends it to NPCs.
- Disposition (`clash | bond | neutral`) is a **static** trait that gates nomination tactics
  (`nominationStrategy`/`dispositionOf`) — nothing bends it over a season.

## 3. Scope

**In (all behind one flag `ORWELL_SOUL_DEPTH` - default ON since #1996, `=0` rolls back - dedicated where rng is involved):**
- **A) Multi-axis affect.** Add optional soul axes `distress` and `confidence` (0..1). When the flag is on,
  `evolveEmotion` moves them **independently** per event (blindside ⇒ +distress; comp-win ⇒ +confidence;
  both can be high at once), and the behavior reads factor both (the **distress** term drags a competition
  even when confidence is high; a confident-but-distressed houseguest plays **bolder but more erratic**). The
  legacy `emotionalState` scalar still evolves exactly as today (so **off ⇒ byte-identical**; on ⇒ the richer
  axes drive behavior alongside it).
- **B) Temperament drift.** Add a bounded, signed soul `temperamentDrift` (toward clash + / bond −) that
  accumulates from events (betrayal/blindside ⇒ toward paranoia; bonding/surviving ⇒ toward trust) and
  **mean-reverts toward 0** (the character baseline) on calm. The decision code reads an **effective
  disposition** = the static baseline shifted by the drift, **only when the flag is on**. The static CHARACTER
  disposition is **byte-stable** (0007); off ⇒ decisions use the static disposition exactly ⇒ byte-identical.
- **C) Personality-tuned reactivity.** In the character factory, derive each NPC's starting **volatility**
  from their **disposition** (`VOL_OF`, as the player already does) and scale their **settle (mean-reversion)
  rate** by disposition (clash settles **slower** — agitation/grudges stick; bond **faster**). **Draw-preserving:**
  the factory still consumes the same `rng.next()` (so every downstream name/stat/draw is byte-identical), but
  overrides the volatility **value** from disposition only when the flag is on. Off ⇒ the random draw stands ⇒
  byte-identical.

**Out:**
- Changing the **static CHARACTER** (archetype/aptitudes/backstory/disposition stay byte-stable, 0007).
- The relationship math (0026), the arc/recall plumbing (0024/0041 — reused), narration quality.
- Any player-facing number (all three are hidden; the player reads behavior only).

## 4. Design

- **A) Independent axes.** `distress`/`confidence` are optional soul fields (absent on a pre-0124 save ⇒ the
  legacy single-scalar path, byte-identical). `evolveEmotion(soul, event, …, { soulDepth: true })` moves them
  by per-event deltas (a `DISTRESS_AROUSAL`/`CONFIDENCE_VALENCE` split of the existing `IMPACT` table), each
  bounded [0,1], each mean-reverting toward its own baseline on `calm`. The **competition emotional modifier**
  (0006/0028) and **decision leanings** read a *composed* mood when the axes are present: confidence lifts,
  distress drags (and widens variance) — so "confident but rattled" is bold + erratic, not just "neutral".
- **B) Effective disposition.** `temperamentDrift ∈ [−1, +1]` accrues bounded per-event deltas (reusing the
  0028 mean-reversion family), and `effectiveDisposition(soul, character)` maps `baseline + drift` back to a
  `clash | bond | neutral` band (with hysteresis so it doesn't flip-flop). `nominationStrategy` / the
  disposition reads consult it **only** when the flag is on. The drift is a **soul** value — the CHARACTER's
  own disposition never moves; a long calm stretch returns the houseguest to who they really are.
- **C) Disposition→reactivity in the factory.** A small post-pass (touching **no** main-stream draw, the
  0063/L28 second-pass pattern) sets `volatility = VOL_OF[disposition]` and stamps a `settleScale` from
  disposition; `evolveEmotion`'s `calm` reversion is multiplied by `settleScale` when present. The
  disposition source is the NPC's character (archetype→disposition, the same map the player uses). Everything
  is skipped when the flag is off ⇒ the `rng.next()` volatility stands and the settle rate is the flat global
  constant ⇒ byte-identical.
- **The wall + calibration.** All three are hidden soul state — sentinel-clean, no number crosses. One flag
  `ORWELL_SOUL_DEPTH` (default ON since #1996; `=0` turns every branch off) gates every branch; where rng is touched it is **dedicated/draw-preserving**,
  so the seeded competition/vote spine (`juryReach`/gradient/UAT) is **byte-identical**
  until the deploy opts in (the 0117/0120/0121/0122 shipped-flag pattern).

## 5. Contracts (stack-agnostic)

```
soul += { distress?: number, confidence?: number, temperamentDrift?: number, settleScale?: number }  // all hidden
evolveEmotion(soul, event, c, rng?, { soulDepth })   // on ⇒ moves distress/confidence independently + drift;
                                                     // off ⇒ moves only emotionalState (byte-identical to 0041)
effectiveDisposition(soul, character): Disposition   // baseline ± temperamentDrift, banded w/ hysteresis (on only)
factory: volatility = soulDepth ? VOL_OF[disposition] : rng.next()   // draw-preserving; settleScale from disposition
behavior: competition modifier + decision leanings read {confidence, distress} when present; effective disposition
flag: ORWELL_SOUL_DEPTH (default ON since #1996; =0 rolls back)   // off ⇒ no new axis/drift/reactivity ⇒ byte-identical
invariants: CHARACTER byte-stable (0007); bounded; never overrides a hard rule (0005); player sees no number (0001)
```

## 6. Definition of Done

- [x] **Multi-axis:** with soul-depth on, a houseguest can carry **high confidence AND high distress at once**;
      the distress axis drags a competition even when confident; off ⇒ only the single `emotionalState` dial
      moves (byte-identical to 0041).
- [x] **Temperament drift:** repeated betrayals bend a bond houseguest's **effective disposition** toward
      paranoia (and bend a live decision); a calm stretch **reverts** it toward baseline; the **static
      CHARACTER disposition never changes**; off ⇒ decisions use the static disposition exactly.
- [x] **Personality-tuned reactivity:** with soul-depth on, a **clash** houseguest's on-edge dial **swings
      harder** and **settles slower** than a **bond** houseguest facing the same shock; the starting volatility
      is **disposition-derived, draw-preserving** (no extra rng); off ⇒ the legacy random draw stands.
- [x] **Vault-free + deterministic:** no new axis/drift/reactivity number on any player surface (extend the
      0001 canary); same seed ⇒ same axes/drift/reactivity; persisted across restart (0030).
- [x] **Calibration-neutral:** flag **off** ⇒ the seeded spine (`juryReach`) is
      **byte-identical**; name-agnostic (roles only); added to `cucumber.cjs`; `npm test` + `test:arch` green.

## 7. Dependencies & traceability

Deepens **0041** (character evolution — `emotionalArc.ts`/`evolveEmotion`, the soul in the live sandbox),
reusing **0024** (SoulStore/recall), **0028** (the emotional/temperature constants + mean-reversion family),
**0026** (dispositions), and the **0044/0011/0014** decision leanings. Grounded in the **CHARACTER/SOUL split
+ 0007** (byte-stable character), sealed by **0001** (no number to the player), persisted by **0030**.
Calibration-neutral by construction (one flag, default ON since #1996, `=0` = byte-identical; + dedicated/draw-preserving rng) ⇒ byte-identical
to 0041 until the deploy opts in.
