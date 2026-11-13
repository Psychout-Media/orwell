# 0142 - Deal depth II: counteroffers, owed favors, new deal kinds, weighing a break

> **Status:** SPEC; section 1 (counteroffers) BUILT 2026-11-11 (`maybeCounterOffer` in the adapter, `tests/unit/dealCounteroffer.test.ts`; reuses the 0123 `dealOffer` and its existing flags, no new flag); section 2 (owed favors, `callInFavor`) BUILT (#2383); section 3: protect-a-third-person BUILT (`protect-third`, `tests/unit/protectThirdDeal.test.ts`), conditional BUILT (#2405, `tests/unit/conditionalDeal.test.ts`), information BUILT (`information`, `deliverInformationDeals`, `tests/unit/informationDeal.test.ts`), package BUILT (`package` + `parts`, `makePackageDeal`, `tests/unit/packageDeal.test.ts`; section 3 complete); section 4 (NPCs weigh breaking a deal) BUILT (`weighDealBreaks`, `src/engine/dealTemptation.ts`, `tests/unit/dealBreakWeighing.test.ts`; section 4 complete, so all four ideas are built). Approved by Ryne 2026-11-06, all four ideas; build in the order below, after the playtest. Ships ON when built, but see section 5 for the gating rule that keeps seeded sims byte-identical.
> **Executable spec:** [`0142-deal-depth-ii.feature`](./0142-deal-depth-ii.feature)
> **Builds on:** 0039 (deals), 0109 (duration), 0121 (active kinds + reliability), 0123 (NPC-initiated offers, the open-state pattern), B48 (credibility memory). **Not part of this:** ORW-84 (deals feed nominations), ORW-85 (witnesses remember a deal), ORW-82 (consent tests).

The rules of deals are solid; the play is thin. Everything here is decided by the engine; the narrator only voices. No hard caps; Vault-free.

## 1. Counteroffers (build first)
Today an ask is yes or no. A lukewarm NPC answers with terms ("I'll throw the comp if you keep me off the block"). The engine picks the ask from what the NPC wants (its drive, fear, strongest bonds), reusing the 0123 open-state pattern (`openDealOffer`-style view, voiced in chat, never a pop-up or blocking pending, lapses at week's end). The player accepts, or counters in chat; the result is recorded as an ordinary 0039 deal through the existing `makeDeal` path.

## 2. Owed favors you can call in
A kept deal banks a favor (hidden ledger entry on the honored side, built on the 0121 reliability rewards). Either side may later call it in ("you owe me a vote"). The engine prices whether the other side honors it from trust, reliability and what it costs them (seeded only where a roll is needed). Ignoring a called-in favor hurts: trust and reliability fall, through the existing consequence fold.

## 3. New deal kinds
- **Conditional:** "if you are nominated I vote to keep you, if I am, you do the same." Binds only when the condition occurs; otherwise lapses without a break.
- **Information:** "I will tell you what I hear." Moves facts only through the co-presence rule (only when the two are together), as witnessed, Vault-free facts.
- **Protect-a-third-person.**
- **Package:** bundles two promises; each is adjudicated on its own, and a break of either costs the package's reliability.

## 4. NPCs weigh breaking a deal
A seeded decision from the NPC's own interest and personality (temptation against the price of being known as a liar, tied to the credibility memory B48): keep, quietly break, or renegotiate. A deal can be broken on purpose, not only by accident. Built; rides the existing deal-depth flag (`ORWELL_DEAL_DEPTH`), adds none.

**When.** `weighDealBreaks()` runs at the start of `advanceOneBeat`, in a PLAYED game only (`live.playedGame`), with deal depth on, never while a ceremony step is open. Once per open player-party deal per week (`Deal.weighedWeek`, persisted), for the promisor NPC of a `safety`, `vote`, `final-two` or `target-other` deal with no `packageId`. One roll from a SIDE stream seeded `${seed}:deal-weigh:${deal.id}:${week}` (never the shared streams) picks keep, break or renegotiate.

**Temptation** (`dealTemptation.ts`, constants in `dealTemptationConstants.ts`): the NPC's threat read of the player above a floor, a low bond (mean of trust and affinity below the midpoint), the NPC's own standing plan against the player (campaign or held target drive), the agenda pull on the player (`goalPull` of a get-them-out or revenge goal, at full strength, per the NPC-minds ruling), and the endgame (jury started, final five); scaled by the deal kind. **Cost** (the price of being known as a liar): the house's credibility in the NPC (mean `credibilityOf` over the other living NPCs, B48), the share of the house crediting them as reliable (the diffusing reputation belief), their own bond with the player, and their loyalty. `margin = temptation - cost`. The break chance is `slope * margin`, capped small, and 0 when the margin is not positive; renegotiation applies only when temptation is high (at or above a floor) and the margin is NOT positive.

**A quiet break** goes through `DealLedger.breakDeliberately`, which shares `applyBreak` with `reconcile`: the same betrayal-shock, loyalty-streak reset, jury demerit and witness fallout as an ordinary break. The deal is marked `sealedBallot`, so `dealView` keeps projecting it OPEN to the player; the break event is Vault-held (no player witness), so the player learns only through the existing witness pathways or the 0048 retrospective. The engine never narrates the break as content. Once broken the NPC is no longer bound, so their nominations and votes read the board without the deal's protection.

**A renegotiation** is a standing NPC-initiated offer (the 0123 pattern: open, non-blocking, voiced in chat, lapses at week's end) carrying `replacesDealId`; the lighter term offered is a one-week `vote` promise (a `vote` deal has nothing lighter, so it is only kept or broken). Accepting retires the old deal neutrally (status `lapsed`: not kept, not broken, no fold) and makes the new deal through the ordinary spine; declining or ignoring leaves the old deal binding.

**The why.** Each break or renegotiation records its named terms in `decisionWhy` (kinds `deal-break`, `deal-renegotiate`) and a `statedReasons` record (`explainDecision`). A break's stated reason is never public (never voiced); a renegotiation's is voiceable (kind and subject only) only while its public offer stands. The real reason, the terms and the candor stay Vault-side (the `liveSentinelPlanting` sweep covers them).

## 5. Gating and calibration
Every new behavior runs only for a played game (`live.playedGame`) or draws from a side rng stream, never the shared one, so headless seeded sims stay byte-identical (`stagedTrajectoryNeutral`, `memoryDecisionMatrix*`, the deal-depth tests stay green). Each slice ships with a both-ways test (behavior present / absent) and a mutant. Balance is measured and reported, never a gate. Any new flag must be registered the usual way (featureFlags, `deploy/orwell-env-defaults.sh`, `docs/FLAG-INVENTORY.md`, `healthFlags` count); this spec adds none.

## 6. Open questions for the build
- Where a banked favor lives (the deal ledger vs a separate list) and whether it expires.
- Whether a counteroffer may carry a 0121 active kind (comp-throw / veto-save) from day one.
