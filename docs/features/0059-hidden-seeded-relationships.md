# 0059 — Hidden seeded relationships (pre-game ties & showmances)

> **Status:** ✅ **BUILT** (unit-gated, following the 0054/0055/0056 convention — no standalone
> `.feature`). `src/engine/seededRelationships.ts` seeds **0–2 sparse pre-game ties + 0–2 showmances**
> off the 0025 reserve governance; the adapter folds each pair's small standing affinity bias onto the
> move-in edges, **seals** the layer into the Vault (new `seeded-relationship` HiddenKind — invisible to
> player AND admin), and **persists** it (a showmance stage never resets). Gate:
> `tests/unit/seededRelationships.test.ts` — sparseness over 80 seeds (no NPC in two pairs), the wall
> (sentinel + structural markers never cross), the affinity fold, the Vault seal, round-trip persistence.
> Pairs with the shipped **L40 moment-prompt restraint**. **§5 FOLLOW-ON NOW BUILT (issue #605):** the
> organic **stage-advancement surfacing scheduler** (spark→bond→visible via pathways 0002 + the
> consequence fold 0023) — analogous to 0058 Phase 1's dormant threads. Two halves: the **showmance arc**
> ships in the core (`GameSessionAdapter.advanceShowmances` → `nextShowmanceStage`, surfacing at `visible`
> as a PUBLIC house fact via `onShowmanceSurfaced`, wired into the off-screen tick), and the deferred
> **pre-game-TIE discovery scheduler** is now built (`GameSessionAdapter.advanceSeededTies` + the pure
> `src/engine/seededTieSurfacing.ts` + tunables in `src/engine/seededRelationshipConstants.ts`): as a
> sealed tie's live edge warms past an observable floor, a positioned observer notices, a Vault-free read
> ("they seem unusually tight") diffuses NPC↔NPC (0038) and rarely/capped reaches the player (0002, never
> the sealed `nature`), and the discovery folds a third-party re-read (0023). **Default ON**
> (`ORWELL_SEEDED_TIE_SURFACING`; `defaultOn` in `src/featureFlags.ts`, `=1` in the deploy defaults; it began opt-in/default-off, corrected 2026-11-12, ORW-286 item 8) on a **dedicated rng** ⇒ provably calibration-neutral when off (the
> off-screen stream is byte-identical to the pre-feature build; `tests/unit/seededTieSurfacing.test.ts` is
> the §6 gate — organic-only surfacing, the wall on player AND admin, monotonicity + persistence,
> player-showmance-earned, and the neutrality battery; `juryReach` re-verified green). Consolidates ledger
> items **L35** (pre-game relationships, approved 2026-06-19, twist-gated) and **L40** (showmance
> OVERLOAD). **Depth reference (FORMAT/DEPTH only):** `docs/legacy/BB_ProducersVault.md` §4 (pre-game
> relationships) + §6 (showmance).

## 1. Summary

A real *Big Brother* season carries a few relationships the cameras don't explain on day one: two
houseguests who **knew each other before the show** (and may hide it), and one or two genuine
**showmances** that develop over weeks. Today the engine models neither — so (a) there are no
pre-game ties at all, and (b) with no showmance concept, the narrator interprets the relationship
graph's many high-affinity edges as romances and produces **soap-opera saturation** ("everyone
romanced everyone," the 2026-06-19 finale Vault reveal). 0059 adds both as a **small, hidden,
seeded** layer that surfaces only organically — texture and drama without saturation, and never a
spoiler.

## 2. The two kinds (one model)

- **Pre-game ties (§4, L35):** a hidden pre-existing connection between two NPCs — met at a casting
  callback and silently agreed not to acknowledge it; a mutual friend; a shared hometown they don't
  mention. A *subtle behavioral seed* (unconscious warmth/protectiveness, a "destiny" bond on
  meeting), **never** a deterministic advantage.
- **Showmances (§6, L40):** a genuine romantic arc that develops *over weeks* between two
  houseguests (and possibly involving the player, if the player cultivates it). It begins as
  proximity/recognition, deepens to trust, and only later becomes visible to the house. **Never
  telegraphed; never week-one instant.**

Both are **directed/asymmetric beliefs in the same relationship layer** (0017/0026), tagged in the
Vault with a *kind* (`pre-game-tie` / `showmance`) and a *stage*, seeded sparsely at cast time.

## 3. Governed by the reserve-twist rules (0025) — the hard gate (L35 ruling)

This layer inherits the **reserve-twist governance** verbatim (feature 0025):

1. **Vault-sealed from the player AND the admin.** The engine generates + seals each tie; neither the
   player nor God Mode learns it in advance (mandate #2; `AdminPort` stays Vault-free).
2. **Held in reserve / SPARSE.** A small engine-decided count per season — **0–2 pre-game ties**,
   **0–2 showmances** (admin may set the budget like the twist count, 0016 — never the content).
   *Not every season has them*, and never "all bonds are romances." This sparseness is the direct
   fix for L40's saturation.
3. **Non-structural / format-preserving / never game-breaking.** A tie is a behavioral seed, never a
   deterministic edge that overrides legitimate play or a hard rule (0005).
4. **Engine-timed, seeded, organic surfacing — reveal-as-event only.** The tie exists at cast time
   but is **discovered only through in-game pathways** (a careful observer notices the warmth; an NPC
   slips; the showmance becomes visible once it has earned it) — **never** by exposition, never a
   "they have a secret" banner. Knowledge vs. suspicion holds (0002): the player may *suspect*
   without *knowing* until a pathway terminates at them.

## 4. The showmance model (fixing L40 directly)

- A showmance is a **seeded, staged** romantic arc — `{ a, b, stage, started }` in the Vault, where
  `stage` advances (`spark → bond → visible → resolved`) only as the live relationship between the
  two genuinely develops (high mutual affinity sustained over weeks), **never** instantly.
- **The narrator voices romance ONLY for a sealed, surfaced showmance** — a plain high-affinity
  friendship is a friendship, not a showmance. This is the prompt-side half: the moment prompt stops
  the GM from labeling every close bond a "showmance," and lets it voice romance only when the
  engine has surfaced one. (Interim, before the model ships: the pin alone curbs the saturation.)
- **Player showmances** develop *iff the player cultivates them* (v0 §6 discipline): organic,
  earned, never pushed — pure anti-sycophancy. The player's romantic interest is the human's to
  form; the engine never asserts it.

## 5. Surfacing & the consequence loop (reuse, don't rebuild)

Seeded ties reuse the existing organs (as 0058's threads do): the relationship layer (0017/0026)
carries the edges; **pathway propagation (0002)** governs discovery (witnessed/told/overheard/gossip
drift, with provenance + confidence); the **off-screen society (0038)** lets ties move when the
player is away; the **consequence fold (0023)** lets a discovered tie shift third-party reads. The
Vault hidden-records seam (0001/0025) seals + persists them (0030). A pre-game tie's "unconscious
protectiveness" is folded as a small standing affinity bias between the two — visible to a careful
player only as *behavior*.

## 6. Vault-Wall guarantees & testability

- **No tie, stage, or partner ever reaches the player OR the admin** until a modeled pathway
  surfaces it — sentinel-tested on the player surface, the admin/God-Mode surface, `npcVoice`, and
  the moment prompt (extends the 0001 canary). Dependency-cruiser stays green (no `VaultStore` edge).
- **Sparseness asserted:** across seeds, the seeded count stays within budget (≤2 each) — a property
  test that the cast is never saturated with romances (the L40 regression guard).
- **Organic-only surfacing:** a sealed tie reaches the player's knowledge ONLY after a pathway
  terminates at them; absent a pathway it stays Vault-only (player may suspect).
- **Non-degradation:** ties persist across restart (0030); the showmance stage only advances, never
  silently resets.
- **Player showmance is earned:** a property/scenario test that a passive player accrues no romance
  the engine wasn't cultivated into (anti-sycophancy).
- **No structural break:** the 0005 hard rules + the core arc hold under any seeded tie (like 0025).

## 7. Out of scope / relationships

- **Reuses:** 0025 (reserve seal + governance), 0017/0026 (the edges), 0002 (pathways), 0038
  (off-screen), 0023 (the fold), 0001 (the wall).
- **Pairs with:** 0058 (deep profiles — a pre-game tie is a special seeded thread class) and 0016
  (the admin budget knob, count-only).
- **Not here:** a dating-sim UI, any player-facing "relationship status," or a guaranteed showmance —
  all would break the wall or the earned-not-given discipline.

## Amendment (#1909, 2026-11-03) — tie natures

The pre-game tie NATURE for a preexisting romance is `prior-romance` (it was `showmance`, which collided with the in-house
`Showmance` arc — `spark → bond → visible → resolved` — that keeps the word). A legacy `showmance` nature in a save or a cast-genesis
prompt/output is aliased forward (`normalizeTieNature`, `migrateSeededRelationships`). The nature set was broadened per the PO ruling
(`docs/decisions/PO-DECISIONS-LOG.md`, 2026-11-03): `casting-callback`, `mutual-friend`, `shared-hometown`, `old-acquaintance`,
`prior-romance`, `family`, `ex`, `old-friend`, `rival`, plus the two PROPOSED extras `former-teammate` and `online-acquaintance` (still
pending coordinator confirmation per that log entry — treat them as provisional vocabulary). A nature is flavour only; the standing
affinity bias is identical for every tie, so no nature is a competition or vote input.


## ORW-132 (Ryne, 2026-11-06): ties are a huge minority, marked secret or public from the start
- Rare, like reserve twists: a budgeted tie slot loads with `TIE_LOAD_PROB` (ASSUMED 0.25, pending Ryne; reserve twists load at 0.5), so most seasons have no pre-show tie at all.
- Every tie carries a `visibility` mark, `secret` or `public`, decided at season start from a dedicated seeded draw whose chance depends on the pair (`PUBLIC_TIE_CHANCE`: family and former teammates are usually out in the open, an ex or a prior romance usually kept quiet; ASSUMED pending Ryne).
- A PUBLIC tie starts at exposure `public` and is announced on Day 1 as an event the whole house (player included) witnessed, so it is an ordinary house fact. A SECRET tie stays sealed and spreads only by the normal rules (0059 section 5, 0095).
- Hostility is the pair's own: an ex or a rival starts cold, each side by its own temperament (`tieDirectedBias`: strategy style and volatility); every friendly nature keeps the original small warm bias. Engine: `src/engine/tieVisibility.ts`. Tests: `tests/unit/preShowTiesVisibility.test.ts`.
