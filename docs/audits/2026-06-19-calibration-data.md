# Calibration data — the "coast to Final 2, then lose" pattern (data-gathering lane)

> 📋 **Audit record** · 2026-06-19 · Calibration data (instrument-first) · **Status:** **Data record** — no calibration constant changed *in the data-gathering lane*
>
> ➡️ **Follow-up applied (2026-06-20):** the follow-up tuning lane took recommendation #1 and lowered
> `JURY_WEIGHTS.gameRespect` **0.9 → 0.7** (single lever). Details in the "Applied change" callout
> under *Ranked tuning recommendations*. This data record stays as the as-measured (0.9) baseline.
>
> ✅ **Re-measured (2026-06-21):** a fresh 30-seed instrument run on current main (gameRespect 0.7)
> shows the inversion **RESOLVED** — **active wins 20% vs passive 7%** (F2-blowouts 50% vs 63%; active
> meanComp 1.60 vs passive 1.20). The primary goal ("playing the game converts, not just reaches") is
> **MET**; **do NOT lower `gameRespect` further** (0.65 would over-correct a solved problem). The
> "active 7% < passive 17%" figures throughout the body below are the **historical as-measured 0.9
> baseline**. Full numbers + the stale-doc flags: `docs/audits/2026-06-21-session-observations.md`.

**Date:** 2026-06-19 · **Status:** DATA ONLY — **no calibration constant was changed in this
(data-gathering) lane.** *(The follow-up lane applied recommendation #1 on 2026-06-20 — `gameRespect`
0.9 → 0.7; see the callout below. The distributions in this document remain the 0.9 baseline.)*
This document quantifies the largest open game-feel concern (the "playtest-gated calibration revisit"
in the close-out ledger) and hands a follow-up lane a ranked, concrete tuning menu. The instrument
is `tests/calibration/calibrationInstrument.test.ts`; the machine-readable artifact it emits is
`docs/audits/data/2026-06-19-calibration-data.json` (+ a generated table at
`docs/audits/data/2026-06-19-calibration-data-summary.md`).

## The concern, in one sentence

> *Passive players coast to Final 2 in ~half of seasons, then lose there.*

Ruled "emergent realism for now" through rounds 4–7 (the `juryReach` floor/ceiling band + the
anti-sycophancy finale teeth). This lane measures it so the follow-up tuning lane is data-driven,
not vibes-driven.

## Method (so the numbers are trustworthy)

- **Same runtime as the player.** The instrument drives the live loop through the exact composition
  `main.ts` uses (`composeRuntime` → `registry` → orchestrator commit spine, pure turn-driven, one
  bounded off-screen tick per beat). It reuses the seeded season driver pattern from the existing
  `juryReach` / `calibrationGradient` gates — it does **not** re-implement the loop.
- **Two arms, same seeds.** A **PASSIVE** policy (no social game; first legal option everywhere;
  compete; veto only on self) and a **minimal-ACTIVE** policy (the passive answers PLUS: bond with
  two fixed allies via a few engine-folded `bonding`/`alliance` scenes, and never nominate/vote out
  an ally). Both arms run seeds 1–30, so any gap is a **real, attributable effect of play**, never
  noise (seeded determinism).
- **Vault Wall.** The instrument reads ONLY Vault-free public projections (`getGameState` /
  `advanceGame` / the public 0046 seat + broadcast comp-win beats). It is a dev/calibration record
  and is wired into **no** runtime player/admin path. Roles only — no houseguest names.
- **Determinism discipline.** A dedicated `hashSeed`-forked strategy sub-stream (`strategyRng`) is
  reserved for any future randomized policy, so the engine's competition/vote RNG stream stays
  byte-identical and the `juryReach`/`calibrationGradient` gates are unaffected.
- **Scale.** 30 seeds/arm (60 full live seasons), ~6 min as a single bounded vitest file.

## Measured distributions (30 seeds/arm)

| arm | reached jury | reached F2 | **won** | **F2-and-lost** | F2 record (W/L) | mean comp wins | mean comp wins @F2 | mean loss margin (votes) |
|---|---|---|---|---|---|---|---|---|
| **passive** | 29/30 (97%) | **13/30 (43%)** | **5/30 (17%)** | **8/30 (27%)** | 5/8 | 1.40 | 1.15 | 5.8 |
| **active**  | 29/30 (97%) | **16/30 (53%)** | **2/30 (7%)**  | **14/30 (47%)** | 2/14 | 1.20 | 1.25 | 6.0 |

### Headline findings

1. **The concern reproduces, almost exactly as stated.** A passive player reaches the Final 2 in
   **43%** of seasons and **loses there in 27%** of all seasons (8 of 13 F2 appearances). "Coast to
   F2 then lose in ~half of seasons" is a slight overstatement of *frequency* but a precise
   description of the *F2 record*: a passive finalist loses **8 of 13** F2 seats (62%).

2. **F2 losses are landslides, not nail-biters.** Across both arms, **16 of 22** F2 losses are
   blow-outs (≥5-vote margin: 7-2, 8-1, 9-0); only **6 of 22** are close (≤3 votes). The jury vote
   is not a coin-flip the player narrowly drops — it is a near-deterministic verdict on the public
   game resume. Several 9-0 sweeps appear (passive seeds 3/29; active seeds 2/3/5/26).

3. **Wins are comp-earned, cleanly.** Every win in the set has a real public comp resume:
   passive winners' comp counts `[3, 2, 2, 2, 1]`; active winners' `[4, 1]`. Passive F2 *winners*
   averaged **2.00** comp wins vs **0.62** for F2 *losers*; active winners **2.50** vs losers
   **1.07**. Winning F2 ≈ "did you out-resume your rival." (The anti-sycophancy teeth are working:
   no 0-comp goat is ever crowned.)

4. **Counter-intuitive but real: minimal-active play wins LESS (2 vs 5).** The minimal-active arm
   reaches F2 *more* (16 vs 13) yet wins *less* (2 vs 5). This is not noise — it is the same 30
   seeds. The mechanism (below): protecting two allies **drags a comp-strong ally to the Final 2 as
   the rival**, so the active finalist routinely faces a *better* resume than the passive finalist
   would have. Active F2 *losses* include seeds with 2–3 of the player's own comp wins (seeds 17/18/
   19 → 3/2/2 comps) that still lose, because `gameRespect` is **relative** (share of the *pair's*
   combined resume), and the dragged-along ally out-resumes the player.

## The mechanical source (cite-able)

The pattern is the intended consequence of one deliberate design decision plus its sizing. The
chain, in code:

### 1. The finale verdict is dominated by the *relative* public comp resume

`src/engine/juryConstants.ts` → `JURY_WEIGHTS` **as measured in this lane** (the values the
distributions above were gathered against):

```
{ relationship: 1.0, manner: 0.8, finale: 0.3, gameRespect: 0.9, reliability: 0.4 }
```

> ⚠️ **Stale framing — corrected below.** This paragraph called `gameRespect` (0.9) "the
> second-largest jury term." That description was *true at measurement time* (0.9 sat just above
> `manner` 0.8). It is **no longer current**: the follow-up calibration lane (2026-06-20) lowered
> `gameRespect` 0.9 → **0.7** (see *Applied change* under the recommendations). At 0.7 it is the
> **third-largest** term, behind `relationship` (1.0) and `manner` (0.8) — which is the intended
> effect (let an earned social/reliability reservoir compete with a comp resume). The measured
> snapshot is kept verbatim for provenance; trust `src/engine/juryConstants.ts` for the live value.

`src/engine/jury.ts` → `juryLean` **deliberately excludes threat** (the D4/E33 ruling, 2026-06-11:
penalizing "they were a threat" at the finale structurally crowns the harmless goat). In its place,
`gameRespectTerm(own, other) = own/(own+other) − 0.5` (a signed ±0.5 share of the pair's combined
comp resume) was weighted **0.9 at measurement time** — then the second-largest jury term, just under
`relationship` (1.0) and above `manner` (0.8). A finalist who reaches F2 with **0 comps against a
rival with several** saw a gameRespect term near **−0.45 × 0.9 ≈ −0.40** per juror — applied to
*every* juror, it was the landslide engine. A passive/idle player, by construction, brings a thin
resume, so this term ran hard against them. *(After the 0.7 retune the same goat sees ≈ −0.45 × 0.7 ≈
−0.32 per juror — still a real debit, deliberately smaller, leaving room for the earned social terms
to close the gap.)*

### 2. The relationship term doesn't rescue the idle player

`juryLean` = `1.0 × (trust+affinity)/2 + 0.8 × manner + 0.4 × reliability`. The idle/passive player
recorded **no** `bonding`/`alliance`/`strategy` scenes → no positive trust/affinity folds
(`src/engine/relationshipConstants.ts` `IMPACT.*`), and no protective binding acts → `reliability`
stays at the `baseline` 0.3 and is centered to ~0. So the player's relationship + reliability terms
sit near the **move-in baseline** (`baseline.trust 0.25`, `affinity 0.25`) for every juror, while
`gameRespect` actively pulls negative. There is no warm-relationship reservoir to offset the resume
deficit — exactly the "no social game ⇒ no jury votes" anti-sycophancy intent, but it means the
*only* way an idle player wins F2 is to have out-competed the comps (rare for a coaster).

### 3. The active arm's lower win rate traces to the vote/nomination constants that keep allies alive

`src/engine/decisionConstants.ts` → `DECISION.vote.bondKeepWeight: 0.35` ("keep your own") and the
active policy's own "never nominate/vote out an ally" combine so the two allies the active player
protects **survive deep and one becomes the F2 rival**. Because `gameRespect` is *relative*, dragging
a comp-strong ally to F2 *raises the bar the player must clear* — the active player's slightly better
seat (53% F2) converts to a *worse* win rate (7%) because the rival they sit beside is stronger than
the rival a passive player would have faced. The minimal-active policy improves *reach* and worsens
*conversion*; only **comp wins** move conversion.

### 4. Temperature / emotional modifier is not the lever here

`src/domain/temperatureConstants.ts` governs per-moment comp variance and the soul emotional
modifier (it decides *who wins comps*, upstream of the resume). It is a second-order input to this
pattern (more player comp wins ⇒ better resume ⇒ better F2 conversion), but the F2 *verdict* itself
is decided by the jury constants above, not by temperature. Tuning temperature to hand the player
more comps would be an anti-sycophancy regression (the engine must never protect the player); the
right levers are the jury-weighting and social-payoff constants.

## Ranked tuning recommendations (for the FOLLOW-UP lane — NOT applied here)

> ✅ **Applied change (follow-up lane, 2026-06-20): `JURY_WEIGHTS.gameRespect` lowered `0.9 → 0.7`.**
> The product owner took recommendation #1 (the highest-impact, lowest-risk lever) and resolved the
> internal conflict baked into its own caveat. **The caveat was arithmetically incompatible with the
> recommended band:** #1 said both "lower to ~0.6–0.7" *and* "keep it the second-largest term" — but
> `manner` is `0.8`, so *any* value in `0.6–0.7` necessarily drops `gameRespect` **below** `manner`,
> i.e. to **third**-largest. You cannot have both. The owner resolved it **in favor of the value
> (0.7)** and **accepted the third-largest slot as intended** — `gameRespect` is the comp-resume term
> and the dominant landslide driver, so letting it sit beneath the two *social* terms (`relationship`
> 1.0, `manner` 0.8) is exactly the targeted effect: an earned relationship/reliability reservoir now
> competes with a comp resume. The "wins stay earned" guarantee is preserved **not by the ordinal
> slot** but by the **`juryReach` `EARNED_WINS` guard** in CI — that gate, not where `gameRespect`
> ranks, is the real anti-sycophancy backstop. **Single-lever scope:** `manner` and every other weight
> were left untouched. *(Resulting order: `relationship` 1.0 > `manner` 0.8 > `gameRespect` 0.7 >
> `reliability` 0.4 > `finale` 0.3.)* **Validation runs in CI's sharded heavy lanes** — the `juryReach`
> `EARNED_WINS`/`F2_WIN_MAX` teeth and the `calibrationGradient` monotonic, plus a re-run of this
> instrument — **not locally** (the dev box OOMs on the heavy sims).

Goal framing: keep the anti-sycophancy spine (a 0-social, 0-comp goat must still lose; wins stay
comp-grounded) while making **social play a real, *convertible* path to the win** and turning
landslide F2 losses into **earned, sometimes-close** ones. Each item names the constant, the
direction, and the expected effect. Ranked by expected impact-per-risk.

1. **`juryConstants.ts` → `JURY_WEIGHTS.gameRespect`: lower 0.9 → ~0.6–0.7 (highest impact, low risk).**
   *(✅ APPLIED 2026-06-20 at **0.7** — see the "Applied change" callout above. NOTE: the
   "keep it the second-largest term" caveat below is **arithmetically impossible** alongside the
   0.6–0.7 band, since `manner` = 0.8; the owner resolved this in favor of the value — `gameRespect`
   is now the **third**-largest term — with the `EARNED_WINS` guard as the backstop instead of the
   ordinal slot. The original recommendation text is preserved verbatim below for the record.)*
   This is the dominant driver of the landslide and of "active wins less." Trimming it lets the
   `relationship` (1.0) + `reliability` (0.4) terms a socially-active player *earns* actually
   compete with a comp resume, converting the active arm's extra F2 seats into wins and shrinking
   blow-out margins. **Risk:** too low re-opens the rigged-goat door — keep it the second-largest
   term and re-run the instrument + `juryReach` `EARNED_WINS`=2 guard to confirm wins stay comp-or-
   social-grounded, never empty.

2. **`relationshipConstants.ts` → bonding `IMPACT` magnitudes: raise the social folds (high impact,
   medium risk).** `bonding {affinity +0.15, trust +0.10}`, `alliance {+0.16/+0.14}`, `strategy
   {+0.12/+0.06}` are the player's *only* route to a relationship/jury reservoir. Nudging these up
   (e.g. +20–30%) makes a season of real social play accumulate enough trust/affinity that the
   `relationship` term offsets a modest resume gap — directly rewarding "playing the game." **Risk:**
   raises NPC↔NPC warmth too (folds are symmetric) — re-check the `calibrationGradient` monotonic
   (active ≥ passive) still holds and the off-screen society doesn't over-bond.

3. **`relationshipConstants.ts` → `RELIABILITY_WEIGHT` (0.25) and/or `juryConstants.ts` →
   `JURY_WEIGHTS.reliability` (0.4): raise (medium impact, low risk).** Reliability is the
   *demonstrated-loyalty* evidence signal (honored deals, protective votes, veto saves). Weighting
   it higher rewards a player who **protected jurors on the way out** — the canonical "jury
   management is a real mechanic" path — without rewarding empty floating. This is the cleanest
   anti-sycophancy-safe buff: it only pays a player who built a real protective track record.

4. **`decisionConstants.ts` → `DECISION.vote.juryManagementWeight` (0.1): raise modestly (medium
   impact, medium risk).** Today it only "shades near-ties." A larger value makes NPCs more reluctant
   to cut a houseguest who still trusts them, which both (a) keeps a social player alive on the
   strength of relationships rather than only the unattached-pawn shield, and (b) makes *who reaches
   F2* depend more on jury-management play. **Risk:** interacts with `bondKeepWeight` — tune one at a
   time and re-measure reach.

5. **`juryConstants.ts` → `JURY_WEIGHTS.finale` (0.3) and `APPEAL.*`: raise the finale sway band
   (lower impact, low risk — close-game polish).** With (1)–(3) narrowing margins, a stronger finale
   term (and a player who picks the *right* appeal for each juror's grievance) can tip the now-close
   jurors — turning some 5-vote losses into wins and making the finale Q&A feel consequential.
   Deliberately last: it only matters once the margins are close, and over-raising it lets eloquence
   overturn the game (the exact anti-sycophancy line `finale: 0.3` was sized to respect).

**Do NOT touch** `temperatureConstants.ts` to "give the player comps" (anti-sycophancy regression),
and do not weaken the `juryReach` `EARNED_WINS`/`F2_WIN_MAX` teeth or the `calibrationGradient`
monotonic — those are the guardrails that prove any tuning didn't just start protecting the player.

## Re-measure protocol for the follow-up lane

After each constant change, re-run the SAME instrument (`ORWELL_CALIB_WRITE=1 ORWELL_CALIB_SEEDS=30 npx vitest run
tests/calibration/calibrationInstrument.test.ts`) and compare the table above. The success target
the data suggests:

- **Active win rate climbs above passive** (playing the game should convert, not just reach) —
  today it is inverted (active 7% < passive 17%).
- **F2-and-lost blow-out share (≥5 votes) falls** from 16/22 toward closer, earned verdicts.
- **`juryReach` and `calibrationGradient` stay green** (run them on a non-OOM host / in CI's
  heavy-sims lane, never locally here) — wins remain comp-or-social-earned, never handed.
