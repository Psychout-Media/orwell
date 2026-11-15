# 0121 — Deal depth: active-obligation kinds + reliability rewards

> **Current default (AMEND 2026-11-05):** `ORWELL_DEAL_DEPTH` is **default ON** in the engine (`DEAL_DEPTH_ENABLED_DEFAULT = flagDefaultOn(...)`, #1996); `=0` turns it off. The "default OFF" / "deploy opts in" wording below records how it was built and calibrated (byte-identical OFF), not today's default.

> **Status:** ✅ **COMPLETE.** Both active-obligation kinds fire LIVE end-to-end (comp-throw at the comp
> crown, veto-save at the veto ceremony) + all three reliability rewards — loyalty streak, reliable-ally
> protection, and (R1) the diffusing "keeps their word" reputation. R2 (the FE chat-extraction of the new
> kinds) shipped **flag-gated off `/health.flags.dealDepth`** — no golden re-record needed (off ⇒ base four
> ⇒ byte-identical). R3 opts the flag into the deploy (`ORWELL_DEAL_DEPTH=1` in `orwell-install.sh` +
> `smoke.sh`), kept off in the golden driver. The flag stays **default OFF in code** so the seeded gates +
> golden fixture stay byte-identical; the deploy turns the whole layer on.
> **PO expansion of the 0039 review** (2026-07-12). 0039 made deals
> first-class and engine-adjudicated, but (a) every kind is a *defensive* "don't move against me" promise,
> and (b) keeping a deal is under-rewarded relative to breaking it (a modest trust/reliability build vs. a
> large, multi-channel betrayal hit). This feature adds the *active* promises and makes reliability a
> **felt positive**.
> **Calibration-safe by construction:** all new behavior is gated behind a dedicated flag `ORWELL_DEAL_DEPTH`
> (default OFF); off ⇒ 0039/0109 behavior exactly (byte-identical seeded spine). Enabled in the live deploy.
> **Executable spec:** [`0121-deal-depth-kinds-and-reliability-rewards.feature`](./0121-deal-depth-kinds-and-reliability-rewards.feature)
> **Also proven by:** `tests/unit/dealDepth.test.ts`

## 1. Two dials

### A. Two new ACTIVE-obligation deal kinds

Today's four kinds (`safety`/`vote`/`final-two`/`target-other`) are all *negative* obligations — a break is
"a bound promisor moves adversely against the protected party." The other half of _BB_ dealmaking is
*positive* obligations — promising to **do** something for someone — where a break is a **failure to act**:

- **`comp-throw`** — "I'll throw this competition for you." The promisor pledges NOT to try to win the next
  competition they play. **Broken** when they compete/win it anyway; **kept** when they throw it. Adjudicated
  from the competitor's own comp behavior (`compete`/`throw`/`play-safe` intent, 0006b) — never prose.
- **`veto-save`** — "If I win the veto and you're on the block, I'll use it on you." **Broken** when the
  promisor holds the veto, the promisee is a nominee, and they do NOT save them; **kept** when they pull
  them down. Adjudicated from the veto-use decision — never prose.

Both are **one-way** (the promisor is bound; the protected party is `parties[1]`), week-scoped (they resolve
at that comp / that veto ceremony), and reuse the whole 0039 consequence machinery on break (betrayal-shock
+ jury demerit + witnessed reveal).

### B. Reliability as a felt reward (a mix of all three)

Keeping a deal already builds a hidden, non-decaying **reliability** signal (evidence, not sentiment) that
feeds the jury (weight 0.4) and the nomination-safety read — but it is subtle and back-loaded. This makes it
a positive you can play toward, three ways (all hidden, engine-computed, **no number ever shown**):

1. **Reputation that spreads (the positive mirror of the betrayal rumor).** A kept deal seeds a hidden
   *"keeps their word"* reputation belief that **diffuses NPC→NPC** (0038 gossip). A houseguest who has
   heard it reads the reliable player as a **safer, more-appealing deal partner** — reliability buys future
   opportunity (the honest-player path).
2. **A reliable ally protects you.** A partner whose deals you have kept weights you **lower as a nomination
   target** and **higher as someone to protect** — the existing reliability→bond link, strengthened and
   surfaced as real protective behavior (they spare you, keep their own deals with you).
3. **Loyalty streaks compound.** Consecutive kept deals with the SAME partner apply an **escalating** honored
   fold (a "we've never broken faith" bonus, bounded) — a rock-solid alliance builds faster the longer you
   both hold the line.

## 2. The mechanic — additive, pure, gated

- **Domain (`src/domain/deal.ts`):** extend `DealKind` with `comp-throw`/`veto-save`; extend `BindingAction`
  with a `compete` kind (+ `outcome: "threw"|"competed"|"won"`) and a `veto-use` `saved`/`nominees` payload;
  add positive-obligation branches to `actionBreaks`/`actionHonors`/`conditionFor`/`horizonOf`. The existing
  negative-kind logic is **untouched** (new branches fire only for the new kinds/actions) ⇒ byte-identical
  for every existing deal.
- **Engine (`src/engine/deals.ts` + `relationshipConstants.ts`):** reconcile handles the new actions; the
  honored fold gains the streak bonus; a kept deal emits a *reputation* seed; the reliability build is
  strengthened. `src/engine/gossip.ts` diffuses the reputation belief. NPC deal/nomination reads consult
  the reliability reputation.
- **Live wiring (`liveSeason.ts` / `GameSessionAdapter.ts`):** after a comp resolves, reconcile each
  competitor's `compete` action; after a veto is used, reconcile the `veto-use` action. `makeDeal` accepts
  the new kinds.
- **FE:** the deal-extraction belt learns the two new kinds so a player striking one in chat gets it tracked.
- **The gate:** every fold/gossip/NPC-read change and the making/reconciling of the new kinds is behind
  `ORWELL_DEAL_DEPTH` (default ON; `=0` opts out). Off ⇒ no new kind is made, the honored/broken folds are exactly 0039/0109,
  no reputation is seeded ⇒ **byte-identical** (juryReach/gradient/UAT unmoved). Enabled in the deploy.

## 3. Scope

**In:** the two new kinds + their adjudication + live reconciliation; the three reliability rewards; the
flag; the FE extraction of the new kinds; tests.

**Out:** a general contract DSL (still only concrete BB promises); multi-party (3+) deals; changing the
existing four kinds' behavior; any player-facing number (the reward is always felt as behavior).

## 4. Contracts (stack-agnostic)

```
DealKind += "comp-throw" | "veto-save"                       // active-obligation promises
BindingAction.kind += "compete"; BindingAction.outcome?, .saved?, .nominees?
actionBreaks/actionHonors: positive-obligation branch — a FAILURE TO ACT breaks comp-throw/veto-save
DealLedger.reconcile(compete|veto-use action): kept/broken from the outcome — never prose
honored fold: + bounded loyalty-STREAK bonus (consecutive kept deals, same pair)
kept deal: seeds a hidden "reliable" reputation that diffuses (gossip) + raises NPC deal-willingness
ORWELL_DEAL_DEPTH (default OFF): gates ALL of the above ⇒ byte-identical when off
```

## 5. Definition of Done

- [x] **[Part 1] New kinds adjudicated (engine, not prose):** a `comp-throw` breaks when the promisor
      competes/wins and keeps when they throw; a `veto-save` breaks when the veto-holder leaves the promisee
      on the block, keeps when they pull them down, and carries **no duty** when the promisee wasn't
      nominated — decided from the structured action, identical under different prose. *(`dealDepth.test.ts`;
      BDD 0121.)*
- [x] **[Part 1] Break reuses the 0039 fallout:** a broken new-kind deal folds betrayal-shock + a jury
      demerit + a witnessed reveal, exactly like the existing kinds (via the shared `reconcile`/`applyBreak`).
- [x] **[Part 1] Byte-identical when off:** with `ORWELL_DEAL_DEPTH` unset the new kinds can't be made
      (`makeDeal` refuses them) and every existing fold is exactly 0039/0109; the domain change is additive
      (new branches fire only for the new kinds) — 0039/0109 unit suites unchanged, juryReach band unchanged.
- [x] **[Part 1] Name-agnostic tests** (roles only); BDD-gated in `cucumber.cjs`; `test:arch` green.
- [x] **[Part 2a] veto-save live wiring:** the veto ceremony emits a `veto-use` binding action (actor =
      veto-holder, `saved` = who was pulled down, `nominees` = who was originally on the block, replacement
      excluded), so a `veto-save` promise auto-resolves in a real game — gated on the flag (`bindingActionsFor`).
- [x] **[Part 2a] Loyalty streak (reward 3):** consecutive kept deals with the same partner compound the
      honored fold (bounded `DEAL_STREAK`); a break resets the streak; off ⇒ the plain honored fold
      (byte-identical). *(`dealDepth.test.ts`.)*
- [x] **[Part 2b] comp-throw live wiring:** the HOH / veto crown emits a `compete` action per competitor,
      judged by OUTCOME (broken iff the promisor WON the comp they swore to throw — no fragile intent
      threading); resolves live end-to-end. *(`dealDepthLive.test.ts` drives a real season.)*
- **[Ryne ruling 2026-11-11] comp-throw: the RESULT dominates, visible effort counts for a smaller extent.** Ryne (ORW-83): "I think
      result should have the biggest impact for sure. But I think the others would apply for an extent. Like fighting hard when
      committing to throwing it would be suspicious." So the rule above stands (win = broken, lose = kept, never reversed by effort), and on
      top of it a promisor who is SEEN fighting hard after agreeing to throw draws SUSPICION (a smaller trust/reliability hit than a
      break) even if they lose; the reverse holds for the player (visibly going through the motions of a promised throw reads as
      honest, a hard fight reads as suspicious). **Not built.** It needs NPC comp effort to exist as an OBSERVABLE engine fact (the
      natural home is competition slice 3's play-by-play rounds). Constraints: played games only, a dedicated side stream (never the shared
      rng), tunable magnitude, effort never changes who wins, and no prose-driven judgement. Tracked as a follow-up card under ORW-83.
- [x] **[Part 2b] Reliable-ally protection (reward 2):** delivered by the EXISTING reliability→nomination
      machinery — a proven-reliable partner outranks others as a nomination target (`relationships.ts`
      `bondStrength`/nom read) — and the streak's reliability build amplifies it. No new code needed.
- [x] **[R1] Reputation that spreads (reward 1)** — SHIPPED (knowledge-belief design, refined 2026-07-12,
      absorbing the parallel #1504). A kept deal seeds a hidden **`reliable:<honorer>` knowledge belief** that
      diffuses NPC→NPC (0038) under a **stable, resolvable lineage** (`domain/deal.reliableFactId`). The
      **deal consequence** is an explicit, bounded **deal-willingness lean** read from that belief
      (`GameSessionAdapter.mintNpcDeal` + `reliabilityLean`, `DEAL_REPUTATION.dealLean`; the pact KIND stays
      keyed to bare mutual trust — reputation buys the opportunity, not a bigger promise), wired via
      `GameSessionAdapter.setReliabilityReader`. Plus a small **affinity-only whisper** so reliable players are
      faintly more liked (`GOSSIP_HEARD.reliable`, affinity-only — kept OFF the deal-trust read so the whisper
      and the willingness lean never double-count). Seeded **once** (idempotency watermark = the knowledge
      layer) via `gossip.spreadReliableReputation` + `GameSessionAdapter.setDealReputationSink` + the
      `reconcileDeals` `reputation` hook. Gated on the deal-depth flag ⇒ off is byte-identical
      (`tests/unit/dealReputation.test.ts`; juryReach unchanged). The engine `dealDepth` flag is surfaced on
      `/health` (`bootFlags`) for the FE flag-gate (R2).
- [x] **[R2] FE chat-extraction of the new kinds** — SHIPPED (flag-gated, no re-record). The FE caches the
      engine's `/health` `flags.dealDepth` (`orwell_engine.engine_flag`) and, when on, extends makeDeal's
      `kind` enum + the deal-extraction prompt/validation with `comp-throw`/`veto-save` at SEND time
      (`tool_schemas.with_deal_depth_kinds`/`current_deal_kinds`; `agent_loop`; `tool_implementations`). OFF
      (the default, and the golden driver) ⇒ the schema is the identical base four ⇒ the 0108 golden fixture
      is byte-identical (`frontend/tests/test_0121_deal_kinds.py`).
- [x] **[R3] Deploy opt-in (`ORWELL_DEAL_DEPTH=1`)** — SHIPPED. Added to `deploy/orwell-install.sh`
      (living-house block) + `deploy/smoke.sh` `SHIPPED_FLAGS`; the golden driver leaves it off, so the
      fixture stays byte-identical.

## 6. Dependencies & traceability

Extends **0039** (the deal ledger + adjudication) and **0109** (deal duration), reuses **0026**
(betrayal-shock), **0014** (jury manner/reliability), **0006b** (comp intent — the `comp-throw` signal),
**0038/0002** (gossip — the reputation diffusion), gated like **0120/0087/0085** behind a dedicated flag so
the seeded spine stays byte-identical when off. PO expansion approved in the 0039 review (2026-07-12): more
deal kinds + a real reward for keeping your word.

## 7. Remaining work — specced for a later PR (build + merge when ready)

The engine is complete (both active kinds fire live; the loyalty-streak + reliable-ally rewards are in).
Three items remain, each behind a real constraint — captured here so they are buildable later, ideally in
an environment where the golden fixture can be regenerated. **All stay behind `ORWELL_DEAL_DEPTH` (default
OFF) and must keep the seeded spine + golden replay byte-identical.**

### R1 — Reputation that spreads (the third reward) — ✅ SHIPPED

> **Built** (knowledge-belief design, refined 2026-07-12 — absorbs the parallel #1504). Two distinct axes,
> never double-counting:
> - **Deal axis (the reward):** `gossip.spreadReliableReputation` diffuses a hidden `reliable:<honorer>`
>   belief under a **stable, resolvable lineage** (`domain/deal.reliableFactId`) ← `setDealReputationSink` ←
>   the `reconcileDeals` `reputation` hook (fires only under the flag, **seeded once** — the knowledge layer
>   is the idempotency watermark). The read side: `setReliabilityReader` → `mintNpcDeal.reliabilityLean`
>   adds a bounded `DEAL_REPUTATION.dealLean` to deal WILLINGNESS when a candidate credits the other as
>   reliable (the pact KIND stays keyed to bare mutual trust — reputation buys the opportunity, not a bigger
>   promise).
> - **Social whisper (a faint warmth):** each third-party holder gets a small **affinity-only**
>   `GOSSIP_HEARD.reliable` lean toward the honorer — "reliable people are more liked" — kept OFF the
>   deal-trust read so it never double-counts with the willingness lean. The deal partner is excluded (direct
>   fold) and the honorer never folds toward themself.
>
> Gated ⇒ off byte-identical. Gate: `tests/unit/dealReputation.test.ts`.

**What:** a kept deal seeds a hidden *"keeps their word"* reputation belief about the honorer that
**diffuses NPC→NPC** through the existing **0038** gossip layer; a houseguest who has heard it reads the
honorer as a **more-appealing deal partner** (an explicit, bounded willingness lean) and likes them a little
more (an affinity-only whisper). The positive mirror of the betrayal rumor. Hidden; the player only ever
feels it as behavior (never a number).

**Approach:**
- The hook already exists: `ReconcileSink.reputation?(honorer, other, deal)` (defined in `src/engine/deals.ts`,
  currently unwired) and `applyHonor` already calls it when `dealDepth` is on.
- Wire it in `GameSessionAdapter.reconcileDeals`: seed a Vault-free `KnowledgeService` belief
  (`content: "<honorer> keeps their word"`, `factId: reliable:<honorer>`, pathway `witnessed`) held by
  `other`, so the **0038** diffusion spreads it; a houseguest holding it applies a small positive lean when
  weighing a deal with the honorer (NPC deal-willingness read — the 0085/0039 deal-formation path).

**Constraint:** `reconcileDeals` does not currently hold the `KnowledgeService` handle (it is passed to
other methods, not this one). Thread it in (or move the reputation seed to a beat-commit point that has it).
Gate on `ORWELL_DEAL_DEPTH` (off ⇒ the callback is never passed ⇒ byte-identical).

**DoD:** a kept deal seeds a reliability belief for `other`; the belief diffuses NPC→NPC; a houseguest
holding it is measurably more willing to deal with the honorer; Vault-free (sentinel-clean); off ⇒
byte-identical; juryReach band unchanged.

### R2 — FE chat-extraction of the new kinds

**What:** let the player strike `comp-throw` / `veto-save` deals from natural-language chat (today only the
four defensive kinds are extractable). Touch points:
- `frontend/src/tool_schemas.py` — the `makeDeal` tool `kind` enum.
- `frontend/src/tool_implementations.py` — the `kind` validation set.
- `frontend/src/agent_loop.py` — the `_DEAL_KINDS` set + the deal-extraction prompt description (add
  "comp-throw = throw a competition for them; veto-save = use the veto to save them").

**Constraint (golden-safety — the load-bearing one):** the `makeDeal` tool schema is part of what the
**0108 golden-path fixture** records. Adding two enum values changes the request digest ⇒ **stales the
fixture** ⇒ requires a **live-model re-record** (`OPENROUTER_API_KEY`, which exists only in the deploy/CI,
not in a keyless dev box). Two ways to land it:
- **(a) Flag-gate the schema (golden-safe, no key):** include the two new kinds in the enum/prompt **only
  when the engine's `ORWELL_DEAL_DEPTH` is on** (the FE reads the flag from the engine `/health` flags
  block). The golden replay runs with the flag OFF ⇒ the schema is unchanged ⇒ fixture safe. Adds a small
  amount of FE plumbing to read + cache the flag. **Recommended.**
- **(b) Re-record in the same PR:** add the kinds unconditionally and regenerate
  `frontend/tests/golden/golden_path_glm-5.2.jsonl` (needs the key; see `frontend/INTEGRATION.md`
  §golden-path). Simpler code, but the PR can only be validated where the key exists.

**DoD:** a player striking a throw-a-comp / veto-save promise in chat gets it tracked (the FE extraction +
`makeDeal` accept the kind); `fe-unit` green; the golden gate green (via (a) flag-gating, or (b) a
re-recorded fixture); the belt telemetry unchanged.

### R3 — Deploy opt-in

**What:** add `ORWELL_DEAL_DEPTH=1` to the deploy `SHIPPED_FLAGS` (`deploy/smoke.sh`) + the installer env
(`deploy/orwell-install.sh`, the living-house block) so the live game gets the whole deal-depth layer.

**Constraint:** land **only after R1 + R2** (so nothing is half-wired in production). Keep `ORWELL_DEAL_DEPTH`
**off** in the golden driver (`frontend/scripts/_golden_driver.py`) so the golden replay stays flag-off and
byte-identical, matching R2 option (a).

**DoD:** the deploy smoke boots with the flag on and drives a full turn; the new kinds are live end-to-end;
golden replay unchanged; the calibration band holds with the flag on (heavy-sim it ON alongside the other
living-house flags, as the deploy already does for 0120/0087/0085).
