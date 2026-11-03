# 0093 — Secrets as strategic levers (information becomes power)

> **Status:** ✅ **BUILT (2026-06-27)** — PO review resolved, shipped as ONE spec with 0099; the live `exposeSecret` lever and the BDD gate (`secrets_as_power.steps.ts`, in `cucumber.cjs`) exist. The review text below is the original spec. *(Original status:)* 🟢 **PO REVIEW RESOLVED (owner, 2026-06-27) — BUILD-READY.** R1–R4 settled; builds as ONE *secrets-as-power* spec WITH 0099 (#880) — expose = first-class `exposeSecret` lever, leverage = `makeDeal` descriptor, real-but-recoverable ceiling, **deception / bluff first-class**. See § "PO review" + `docs/decisions/PO-DECISIONS-LOG.md` (2026-06-27) + #862.
> Tracks **#862**. *(Original text, before the rulings and the build:)* a design proposal awaiting decisions;
> it likely warrants its own build spec once R1–R4 are ruled. R1–R4 are now ruled and the feature is built (see the status above).
> **Builds on (does NOT duplicate):** **0075** (trust-gated confidences — the pathway by which a player
> *learns* a real secret; `src/engine/confidence.ts`, the `confide` lever, `ConfideResult`,
> `mayConfide`), **0039** (deals & promises — the first-class `Deal` / `DealLedger`; `src/engine/deals.ts`),
> **0002** (event visibility & pathway propagation / `surfaceInformationTo`; `KnowledgeFact`), **0017/0026**
> (the directed relationship model + betrayal-shock fold), **0023** (the consequence & memory fold),
> **0014/jury** (jury-management demerits). **Bounded by:** mandate #2 (Vault Wall — player **and** admin),
> mandate #3 (anti-sycophancy — the engine owns the bounded, seeded *magnitude*; the model never bends an
> outcome), mandate #4 (non-degradation), ADR **0005** (split authority by openness — the model proposes
> *shape*, the engine keeps *magnitude*), ADR **0003** (the conversation is the game).

## Why — the gap this closes

The game already lets a player **learn** a houseguest's real secret: an earned confidence (0075) or a
pathway surfacing (0002, gossip) records it as a `KnowledgeFact` in the player's knowledge. But once
learned, **a secret is inert flavor.** It deepens the fiction — the player *knows* something — yet it
**changes nothing the player can DO.** There is no mechanic that turns "I know your secret" into
strategic advantage. In real _Big Brother_, learned information *is* power: you trade it, you hold it
over someone, you out them at the right moment to sink their game. A secret you can't *use* is a story
detail, not a lever.

This feature makes a **learned** secret unlock a **concrete strategic option** — leverage in a deal,
or an *expose* that damages a rival's standing — so the social-information loop finally pays off in
play, not just in narration. Information becomes power.

### Retention / "why it matters to a returning player"

This closes the loop that makes *gathering* information worth the effort across a long season. Today a
player can spend hours earning confidences and overhearing scenes with no payoff except atmosphere;
nothing rewards the patient, information-hungry style of play that _BB_ rewards. With secrets as
levers, every learned secret is a **bankable asset** the player can spend later — which deepens the
0023 "the house remembers" promise from the player's side too: *you* remember what you learned, and the
game lets you cash it in. It turns passive knowledge into a reason to keep playing the social game.

## The core idea — a learned secret unlocks a concrete option

A `KnowledgeFact` the player holds **about a houseguest** (`subject = thatHouseguest`, learned via a
real pathway) is promoted from *flavor* to a **usable lever** with exactly two sanctioned uses:

1. **Leverage in a deal (compose with 0039).** When the player makes/renegotiates a deal (0039) with a
   houseguest, holding a secret *about that houseguest* (or about someone that houseguest cares about)
   can be offered as **leverage** — "keep me safe, or this gets out." The engine treats the leverage as
   a (bounded, seeded) factor that makes the houseguest **more likely to enter / honor** the deal —
   *not* a guaranteed yes. It is pressure, not a cheat code: a high-threat, low-warmth houseguest may
   call the bluff (and resent it); a vulnerable one may fold. The deal itself stays a first-class
   `Deal` (0039) — this only colors its *formation/honoring* likelihood.

2. **Expose (a first-class strategic action — pending R2).** The player can choose to **out** a learned
   secret to the house (or to a specific houseguest). The engine resolves a **seeded, bounded** standing
   hit on the secret's subject — a drop in how the house reads them (threat/affinity moves on *other*
   houseguests' edges, a possible jury-management mark) — **and** a backlash on the *exposer* (outing a
   secret is itself read as ruthless: the subject takes a betrayal-grade hit toward the player, and
   some of the house may recoil). The magnitude is the **engine's**, seeded — never the model's, never
   narrated into being.

A learned secret is **spent or weakened by use**: once exposed, it is public (it can't be the basis of
fresh leverage), and the engine records that it was used (monotonic, persisted — § Persistence).

### What stays exactly as-is (so this is additive, not a rewrite)

- **Learning a secret is unchanged.** This feature does **not** add a new way to learn secrets — it
  consumes what 0075/0002 already record. No new disclosure path, no new Vault read.
- **The relationship/jury folds are reused** (0026 betrayal-shock, 0014 jury demerit). Expose's backlash
  and the subject's standing hit are the *existing* folds, applied from a new trigger — no new hidden
  authoring.
- **Deals are unchanged in shape.** Leverage rides *alongside* `makeDeal` as an optional factor; with
  no leverage offered, deal formation is **byte-identical** to 0039 today.

## The mechanic (ports / modules — Definition of Ready, pending the PO rulings)

> Exact signatures firm up at build after R1–R4. Sketch only, to prove hexagonal fit. These are
> **model levers**, engine-decided — like `confide` / `makeDeal`, **not** FE-driven write-backs — so the
> four-place FE-write-back wiring discipline does not apply.

- **New** `src/engine/leverage.ts` *(pure, no I/O, no Vault handle)* — the decision core:
  - `leverageStrength(secret, holderRead, subjectRead, rng) → number` — a bounded, seeded factor in
    `[0,1]` derived from *already-read* signals: the secret's **severity class** (the public `kind` of
    the `HiddenElement`, never its text — sibling to 0075's class gloss), the subject's **vulnerability**
    (their soul state + how much they'd lose if it's out), and the subject's read of the player
    (threat/warmth — a houseguest who already distrusts the player resists pressure). **No raw number
    ever crosses to the player.**
  - `exposeOutcome(secret, subject, house, rng) → { subjectHit, exposerBacklash, juryMark? }` — the
    bounded, seeded standing resolution (magnitudes pulled from the constants module / reused 0026
    deltas). Pure; the adapter delivers the folds through a sink (the 0039 `ReconcileSink` pattern).
- **New** `src/engine/leverageConstants.ts` — the single tunable `LEVERAGE` module (severity weights,
  the leverage-to-deal factor cap, the expose subject-hit / exposer-backlash bands, the per-season
  expose cap). The `CONFIDENCE` / `DEAL_IMPACTS` sibling; the B59 grep gate covers it.
- **`GameSessionAdapter`:**
  - `makeDeal` (0039) gains an **optional, Vault-free `leverage` descriptor** — a *reference* to a
    `KnowledgeFact` the player already holds about a party (by `factId`, validated against the player's
    own knowledge — the player can only leverage what they actually learned). The engine computes
    `leverageStrength` and folds it into the (bounded, seeded) formation/honoring likelihood. Absent ⇒
    0039 unchanged.
  - a new action **`exposeSecret(factId, audience?)`** on the `GameSession` port / `PLAYER_TOOLS`:
    validates the fact is the player's own knowledge about a real subject, resolves `exposeOutcome`,
    folds the subject's standing hit + the exposer backlash (0026) + an optional jury mark (0014),
    **records the exposure as a witnessed event** (0002, `surfaceInformationTo` — the house now *knows*),
    increments the season expose cap, and returns `{ exposed, subjectImpactNarratable, … }` — **no
    number**, only what the model may voice. It is the single authority — like `runCompetition` /
    `confide` / `makeDeal`: the model previews/voices, the engine decides + commits.
- **`src/engine/momentPrompts.ts`** — the social moment + the lever manifest gain `exposeSecret` and the
  `makeDeal` leverage option (when to call them; that the engine decides whether the pressure works /
  how the house reacts; never invent a standing change the lever didn't return). The leverage is voiced
  as texture, never as a number.

## ADR 0005 — magnitude vs. shape (the anti-sycophancy spine)

This feature lives squarely on ADR 0005's line and must not cross it:

- **Open set (the model proposes shape).** *Which* secret is being used, *as leverage in which deal* or
  *exposed to whom*, and the *prose* of the scene — these are the model's to interpret and voice, as
  rich as the player's play. The free-text content rides through unchanged (lossless).
- **Closed set (the engine owns magnitude).** *How much* a secret moves a deal's likelihood, *how far*
  an expose drops the subject, *how hard* the backlash bites — all **bounded, seeded, engine-owned**.
  The model never proposes an amount; a learned secret can never be *pumped* to force a yes or flatten a
  rival (mandate #3). With no leverage/expose invoked, every existing fold is **byte-identical** — the
  `expressiveNonCollapse` gate stays the proof the open set isn't being normalized.

## The Vault Wall (player AND admin) — why this is safe

An "expose" looks, at a glance, like the player wielding secret state. It does not breach the Wall, for
the same structural reason 0075 doesn't:

1. **The player only ever leverages/exposes a secret they ALREADY legitimately learned.** The lever
   operates over the player's own `KnowledgeFact` set (0002) — content that already crossed via a
   modeled pathway and is already Journal-visible. **No undisclosed Vault content is read** to make a
   lever available; the engine consumes what is *already the player's knowledge*. The
   `exposeSecret`/`leverage` calls validate the `factId` against the player's knowledge and **reject**
   anything else — the player cannot expose what they were never told (no minting ground truth, sibling
   to `surfaceInformationTo`'s lineage check).
2. **Surfacing the exposed secret to the rest of the house is a modeled pathway, never a Vault read**
   (R3). When the player outs a secret, the *other* houseguests learn it through `surfaceInformationTo`
   (a recorded witnessed/told event), exactly as gossip diffuses — the engine never hands any surface
   the Vault; it records a new knowledge event whose origin is the player's exposure.
3. **No number ever crosses, to player OR admin.** `leverageStrength`, the deal-likelihood factor, the
   expose magnitudes, and every relationship/jury delta are Vault-hidden. Player surfaces show the
   *fact* of the deal/exposure and **observable** fallout (behavior) — never a strength, never a hit
   size. **God Mode / admin is walled identically** (mandate #2): no admin projection exposes the
   leverage strength or the hidden standing deltas; the load-bearing test sweeps the assembled
   admin/player surfaces for any sealed magnitude.

## Determinism / calibration-neutrality

- **Seeded + deterministic.** Same seed + same history + same lever call ⇒ same leverage factor, same
  expose outcome, same folds. `leverage.ts` is pure (handed the already-read signals; rng injected).
- **Calibration byte-identical when unused.** With no `leverage` on a `makeDeal` and no `exposeSecret`
  call, the 0039/0026 folds and the seeded vote/eviction distributions are **byte-identical** — the
  feature adds no rng draw on the untouched path. The `juryReach` / UAT gates stay green unperturbed
  (the same discipline 0086/0085 hold behind their flag). *(Build decision: whether expose/leverage sit
  behind a flag like `ORWELL_CAMPAIGNS` or are always-on-but-opt-in-per-call is a build detail; the
  byte-identity guard is the requirement either way.)*

## Persistence (0007/0030 — non-degradation)

- Each learned secret the player has **used** carries a sealed, monotonic `usedAs` marker
  (`none` / `leverage` / `exposed`) so a secret can't be re-leveraged after it's been made public, and
  a restored game remembers exactly which secrets the player has already spent.
- The per-season **expose count** persists in the snapshot (sibling to 0075's lie count /
  `surfacedThreadCount`).
- The exposure event itself is an ordinary recorded 0002 event — already durable; the knowledge layer
  **deepens, never thins**.

## ADR 0003 fit — the conversation is still the game

This *augments* conversation, it does not move play into UI (ADR 0003 principle #4). The player **learns**
the secret in conversation (0075), **decides** to leverage/expose it in conversation (the model calls the
lever from the player's social play), and the **fallout is narrated** from engine truth. The lever is a
*fact handed to the model to voice* ("you have something on them; press it, or out them"), never a script
or a dashboard button that replaces the scene. It earns its tokens against the four fixes: it strengthens
**behavioral fidelity** (the missing information-as-power beat) without touching leaks/sycophancy/memory
(all preserved by the structure above).

## Acceptance criteria (role-only; HARD rules — to firm up at build)

- [ ] **A learned secret unlocks a concrete option.** A `KnowledgeFact` the player holds about a
      houseguest can be offered as **leverage** in a `makeDeal` and/or **exposed** via `exposeSecret`;
      a secret the player has *not* learned (no pathway) offers **no** lever (the call is rejected).
- [ ] **Leverage colors a deal, never forces it (compose with 0039).** Offering valid leverage raises
      (bounded, seeded) the likelihood the houseguest enters/honors the deal; a high-threat/low-warmth
      houseguest may refuse and resent it. With no leverage, deal formation is byte-identical to 0039.
- [ ] **Expose is engine-decided and bounded (R2).** `exposeSecret` applies a seeded standing hit to the
      subject **and** a backlash on the exposer (0026), records the exposure as a witnessed pathway event
      (0002), and is **capped per season**. No magnitude is narrated into being.
- [ ] **Vault Wall (player AND admin).** No undisclosed secret is read to make a lever available; the
      player can only leverage/expose their own learned facts; surfacing to the house is a modeled
      pathway (R3), never a Vault read; **no number** crosses to player or admin (load-bearing sentinel
      sweep over both surfaces).
- [ ] **Anti-sycophancy (ADR 0005).** The engine owns the bounded, seeded magnitude; the model proposes
      only *which secret / which target / the prose*. A lever can never be pumped to force an outcome.
- [ ] **Non-degradation.** `usedAs` + the season expose count persist and survive a restart; the
      exposure event deepens the knowledge layer, never thins it.
- [ ] **Determinism + calibration-neutrality.** Seeded/deterministic; byte-identical `juryReach`/UAT on
      the untouched path.

## PO review — owner rulings needed (before build)

This spec is deliberately a **proposal**. Four decisions shape the build and want an owner ruling first;
this likely warrants its **own build spec** once they are settled.

- **R1 — How much may a learned secret move the CLOSED set?** The engine keeps the bounded, seeded
  *magnitude* (anti-sycophancy — the model never bends an outcome; ADR 0005). The owner call is the
  **ceiling**: how strong may leverage make a deal (a gentle nudge vs. a near-certain yes), and how hard
  may an expose drop a rival (texture vs. game-ending)? *Recommendation:* keep both **firmly bounded and
  felt, never deterministic** — leverage as pressure (a houseguest can always refuse), expose as a real
  but recoverable hit with a real backlash — so it reads as power, not an "I win" button, and never
  flattens the seeded variance (the `juryReach` band stays the guard).

- **R2 — Is "expose" a first-class player action with seeded consequences, or narrated-only?** Option A
  (recommended): a **first-class `exposeSecret` lever** with engine-resolved, seeded standing folds +
  backlash + a recorded pathway event — information genuinely changes the board, deterministically and
  anti-sycophantically. Option B: **narrated-only** — the model may *describe* an outing but it folds no
  engine consequence (cheaper, but then "secrets as levers" doesn't actually change what the player can
  *do*, which defeats #862). *Recommendation: A* — the whole point of #862 is that information becomes
  *power*, which requires a real, engine-owned consequence.

- **R3 — Confirm surfacing stays a modeled pathway, never a Vault read.** When the player outs a secret,
  the rest of the house must learn it through `surfaceInformationTo` (a recorded witnessed/told event),
  exactly as gossip diffuses — the engine never hands any surface the Vault, and the player can only
  expose facts they already legitimately hold. *Recommendation: confirm* — this is the structural reason
  the Wall holds (sibling to 0075); the build's load-bearing test pins it.

- **R4 — How does it compose with deals (0039) so "learn → leverage → trade" is one coherent mechanic?**
  Is leverage an **optional descriptor on the existing `makeDeal`** (recommended — one deal object, one
  ledger, leverage just colors formation/honoring likelihood), or a **separate "leveraged deal" kind**?
  And does a kept leveraged deal *consume* the secret, or does the threat persist while the deal holds?
  *Recommendation:* leverage as an **optional factor on `makeDeal`** (no new deal kind — reuse the 0039
  `Deal`/`DealLedger` and persistence), and the **threat persists while the deal is open** (it's why the
  deal holds) but **exposing** the secret spends it. This keeps learn → leverage → trade a single,
  legible loop on top of the existing deal machinery rather than a parallel system.

**If ruled as recommended, the build is:** `src/engine/leverage.ts` + `leverageConstants.ts`, an optional
`leverage` descriptor on `makeDeal`, a new engine-authoritative `exposeSecret` lever (port + adapter +
`PLAYER_TOOLS` + `momentPrompts`), the reused 0026/0014 folds, `usedAs` + season-expose-count persistence,
and the gates below — a focused build spec of its own.

## Testability (role-only; HARD rules)

- **Vault Wall (the load-bearing test):** a secret the player has not learned offers no lever (the
  `leverage`/`exposeSecret` call referencing it is rejected); no leverage strength or hidden standing
  delta appears on any player **or admin** projection; a sentinel sweep over the assembled
  player/admin surfaces finds no sealed magnitude.
- **Information becomes power:** a player holding a learned secret about a houseguest gains a concrete
  option (leverage and/or expose) that a player without it does not — asserted structurally on the
  available levers, not on prose.
- **Leverage colors, never forces:** valid leverage raises the (bounded, seeded) deal likelihood; a
  high-threat/low-warmth houseguest can still refuse and resent it; with no leverage, deal formation is
  byte-identical to 0039.
- **Expose is bounded + recorded + capped:** `exposeSecret` folds a seeded subject hit + exposer
  backlash, records the exposure as a witnessed pathway event (the house now knows via 0002), and never
  exceeds the season cap.
- **Anti-sycophancy:** no number crosses; the engine owns the magnitude; the model cannot pump a lever
  to force a deal or flatten a rival (ADR 0005 — the `expressiveNonCollapse` sibling gate).
- **Non-degradation:** `usedAs` + the expose count persist and survive a restart; a used/exposed secret
  can't be re-leveraged.
- **Determinism / calibration-neutral:** same seed + history ⇒ same factor + outcome; byte-identical
  `juryReach`/UAT on the untouched path.

## Dependencies & traceability

Builds on **0075** (the learn-a-secret pathway), **0039** (deals — the leverage host), **0002** (pathway
propagation / `surfaceInformationTo` — how an exposure reaches the house), **0017/0026** (relationship +
betrayal-shock folds), **0023** (consequence fold), **0014/jury** (jury demerits), persisted by **0007/0030**,
under **0001** (Vault Wall) and **0021** (isolation), on ADR **0005** (shape vs. magnitude) and ADR **0003**
(the conversation is the game). Tracks **#862**. Turns a learned secret from inert flavor into a usable,
engine-adjudicated lever — information becomes power, decided by the deterministic core, never the narrator.
