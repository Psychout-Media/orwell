# 0123 — NPC-initiated deal offers (the house comes to YOU)

> **Status:** ✅ Built (BDD/TDD-first; BDD-gated in `cucumber.cjs`). Closes the last gap in the deal system:
> today the **player** proposes deals (`makeDeal`) and **NPCs deal with each other** (`mintNpcDeal`, hidden),
> but **no houseguest ever comes to the player with an offer**. This adds that pathway — a motivated NPC
> pulls the player aside at a lull and floats a deal the player can **accept** or **decline** — grounded in
> the NPC's real read, Vault-safe, bounded, and calibration-safe (default-off flag ⇒ byte-identical).
> **Executable spec:** [`0123-npc-initiated-deal-offers.feature`](./0123-npc-initiated-deal-offers.feature)
> **Also proven by:** `tests/unit/npcDealOffers.test.ts`

> **Amended 2026-11-01 (PO ruling — "should play out within the LLM … not really wanting a pop up").**
> The first build surfaced the offer as a `deal-offer` **pending decision card** that **blocked the week**
> until answered — and the FE relays rejected the answer, so in a real deploy the game **froze**. Now:
> - **No pop-up, never a freeze.** The offer is Vault-free **open state** (`openDealOffer` on the state and
>   status views), not a pending; the weekly loop advances past it.
> - **The narrator voices it** in-scene (who, kind, terms) at a natural moment; the player answers in chat and
>   the model records it via `submitDecision({ kind: "deal-offer", vote: "accept" | "decline" })` (accept ⇒ a
>   real deal; decline ⇒ the existing bounded hidden cooling).
> - **Ignored ⇒ lapses at week's end**, recorded as a player-witnessed event, with an **NPC-dependent** hidden
>   cooling: the `conflict` fold is scaled by the offerer's soul `volatility` from `playerOffer.lapse.scaleMin`
>   (a calm houseguest shrugs) to `scaleMax` (a hothead stews). Flag-off stays byte-identical.

## 1. Summary

In real _Big Brother_, houseguests are **constantly** coming to *you* — "I'll use the veto on you if you
don't put me up," "take me to the end and I've got your back." Today the deal system only flows the other
way: the player must always be the one to propose. This feature makes deals **bidirectional at the player
seam** — a plausibly-motivated NPC **offers the player a deal**, surfaced as an accept/decline the player
answers. On **accept** it becomes a real player↔NPC deal on the same ledger every deal binds against; on
**decline** the rebuffed houseguest cools on the player a little (hidden). The offer's *shape* is **queried
from the NPC's real relationship read** (a close ally floats a final-two; a wary houseguest floats mutual
safety) — never invented (anti-sycophancy #3).

## 2. What exists today (the gap this closes)

| Direction | Before | After |
|---|---|---|
| **Player → NPC** | ✅ `makeDeal` | unchanged |
| **NPC ↔ NPC** | ✅ `mintNpcDeal` (hidden, auto at nominations; player learns via a pathway) | unchanged |
| **NPC → Player** | ❌ **missing** — no houseguest ever offers the player a deal | ✅ **this feature** |

The whole deal *spine* already exists (0039 tracking, 0121 depth, the reconcile/fold/jury machinery) — this
is a **new front door** onto it, not new plumbing.

## 3. Scope

> **Superseded in part (2026-11-01 amendment above).** Where this section describes the offer as a
> `deal-offer` **pending decision card** that blocks the loop until answered, read instead: the offer is
> **`openDealOffer` open state** (never a pending, never blocking); the narrator voices it in-scene from the
> per-turn brief; the player's in-chat answer is recorded via `submitDecision({kind:"deal-offer", vote})`;
> an unanswered offer lapses at week's end (or at the finale) with the volatility-scaled cooling — except
> that an offer whose offerer or the player has left the house is voided quietly (no lapse event, no cooling).


**In:**
- **Offer generation** (`maybeOfferPlayerDeal`) at a **lull** (no pending decision, game live): a seeded,
  **bounded** (at most one open offer; per-week cap; probability-gated) check picks a **motivated** NPC —
  one who reads the player as a **real ally** (wants a final-two/alliance) **or** a **real threat** (wants
  mutual safety) — and floats a deal whose **kind is grounded** in that read (`final-two` for a strong
  bond, else `safety`). Nothing is invented; a bare/indifferent house floats nothing.
- **Surfacing** as a **`deal-offer` pending** (through the existing decision seam — a **player-witnessed**
  approach, never hidden Vault content), carrying `offer.from` / `offer.kind` / `offer.terms` (a Vault-safe
  paraphrase — **no number, no sealed state**).
- **Resolution** via the existing `submitDecision` (no new tool): `vote: "accept" | "decline"`.
  - **accept** → a real player↔NPC deal via the **same `deals.make` spine** (binds/reconciles/folds like
    any deal; composes with 0121 depth + 0109 duration + the jury reliability signal).
  - **decline** → no deal; a small **grounded cooling** of the rebuffed NPC's read of the player (hidden —
    the Vault Wall working: the change is real, recorded, invisible).
- **Calibration safety:** the whole feature is behind a **default-ON** flag `ORWELL_NPC_DEAL_OFFERS` (`=0` opts out), drives
  a **dedicated** seeded rng, and only ever acts at a lull — so with the flag off **no offer is generated,
  no pending is raised, nothing folds** ⇒ byte-identical to today (juryReach/gradient/UAT unmoved). The
  golden driver leaves it off ⇒ the fixture never stales.

**Out:**
- Player→NPC and NPC↔NPC deals (unchanged).
- The *terms* being free-text negotiated — the offer is a bounded kind + a paraphrase; the player accepts or
  declines the whole thing (a future feature could let the player counter-offer).
- Any change to how deals reconcile/fold (reused verbatim).

## 4. Design

> **Superseded in part (2026-11-01 amendment above).** Where this section describes the offer as a
> `deal-offer` **pending decision card** that blocks the loop until answered, read instead: the offer is
> **`openDealOffer` open state** (never a pending, never blocking); the narrator voices it in-scene from the
> per-turn brief; the player's in-chat answer is recorded via `submitDecision({kind:"deal-offer", vote})`;
> an unanswered offer lapses at week's end (or at the finale) with the volatility-scaled cooling — except
> that an offer whose offerer or the player has left the house is voided quietly (no lapse event, no cooling).


- **Trigger (lull-only, bounded).** `maybeOfferPlayerDeal` runs at the top of `advanceGame`'s commit, but
  no-ops unless: the flag is on, the game is live (an HOH is crowned), there is **no** loop pending and **no**
  open offer already, and a per-week cooldown has cleared. Then a **dedicated** seeded rng
  (`deal-offer:<beat>`) rolls the offer probability. Because it only fires when nothing else is pending, it
  never preempts a ceremony — it seizes a genuine lull (the ADR 0003 "conversation is the game" pacing).
- **Motivated, grounded choice.** Over the living NPCs **not already bound to the player**, pick the one
  whose motivation — `max(bond, threat)` toward the player — clears a floor. A **strong bond** ⇒ a
  `final-two` offer ("take me to the end"); otherwise a `safety` offer ("you keep me safe, I keep you
  safe"). The kind is a *read of the engine's truth*, not a narrator invention.
- **Surface = a `deal-offer` pending.** `pendingView()` renders it (mirroring the self-evict player-level
  pending) with a prompt + `accept`/`decline` **options** and the `offer` detail. It is recorded as a
  **player-witnessed** event (`[player, from]`, **not hidden**) — the NPC came to them, so it is the
  player's knowledge, not Vault content.
- **Resolution (existing lever).** `submitDecision({ kind: "deal-offer", vote })`:
  - `accept` → `deals.make([player, from], kind, terms, evId, week)` + a player-witnessed "accepts" event.
  - `decline` → a player-witnessed "declines" event + one **bounded, seeded directed cooling** of the NPC's
    read of the player (a mild `conflict` move — they trust the player a touch less; never a betrayal-shock).
  Either way the offer is consumed (cleared) and the loop resumes on the next advance.
- **The wall.** Offers carry only public/ Vault-free content (who, kind, a paraphrase). The NPC's hidden
  motivation stays hidden; the decline-cooling is a hidden fold (numbers never cross). Sentinel-clean.

## 5. Contracts (stack-agnostic)

> **Superseded in part (2026-11-01 amendment above).** Where this section describes the offer as a
> `deal-offer` **pending decision card** that blocks the loop until answered, read instead: the offer is
> **`openDealOffer` open state** (never a pending, never blocking); the narrator voices it in-scene from the
> per-turn brief; the player's in-chat answer is recorded via `submitDecision({kind:"deal-offer", vote})`;
> an unanswered offer lapses at week's end (or at the finale) with the volatility-scaled cooling — except
> that an offer whose offerer or the player has left the house is voided quietly (no lapse event, no cooling).


```
maybeOfferPlayerDeal(): void            // lull-only, flag+cooldown+seeded; sets live.dealOffer or no-ops
PendingDecisionView.kind += "deal-offer"    // + offer:{ from, kind, terms } detail (Vault-free)
submitDecision({ kind:"deal-offer", vote:"accept"|"decline" })   // existing lever; no new tool
  accept  → deals.make([player, from], kind, terms, evId, week)  // the SAME spine every deal uses
  decline → recorded + one bounded seeded directed cooling of the NPC's read of the player (hidden)
flag: ORWELL_NPC_DEAL_OFFERS (default ON; =0 opts out)  // off ⇒ no offer, no pending, no fold ⇒ byte-identical
surface: event [player, from], NOT hidden   // player-witnessed approach (0002), never Vault content
```

## 6. Definition of Done

> **Superseded in part (2026-11-01 amendment above).** Where this section describes the offer as a
> `deal-offer` **pending decision card** that blocks the loop until answered, read instead: the offer is
> **`openDealOffer` open state** (never a pending, never blocking); the narrator voices it in-scene from the
> per-turn brief; the player's in-chat answer is recorded via `submitDecision({kind:"deal-offer", vote})`;
> an unanswered offer lapses at week's end (or at the finale) with the volatility-scaled cooling — except
> that an offer whose offerer or the player has left the house is voided quietly (no lapse event, no cooling).


- [x] **NPCs offer:** at a lull, a motivated houseguest floats the player a deal (bounded: one at a time,
      per-week cap, probability-gated, seeded).
- [x] **Grounded:** the offer's kind reflects the NPC's **real** read (strong bond ⇒ final-two; else safety),
      never invented; a house with no motivated NPC floats nothing.
- [x] **Accept makes a real deal:** accepting creates a player↔NPC deal on the **same ledger/spine** every
      deal binds against (reconciles/folds like any deal).
- [x] **Decline has a consequence:** no deal; the rebuffed NPC's read of the player cools a little (hidden,
      bounded, seeded).
- [x] **Vault-safe:** the offer is player-witnessed (never hidden), carries no number/sealed state; the
      decline-cooling never crosses the wall; sentinel-clean.
- [x] **Calibration-neutral:** flag **off** ⇒ no offer, no pending, no fold ⇒ **byte-identical** (juryReach
      re-run green); the golden fixture never stales (flag off in the golden driver).
- [x] Seed-deterministic; persisted (0030); name-agnostic (roles only); in `cucumber.cjs`; `npm test` +
      `npm run test:arch` green; FE renders it (the generic decision card) + `fe-unit` green.

## 7. Dependencies & traceability

The **NPC→player counterpart** of `makeDeal` (0039), reusing the deal spine end to end (0039 tracking, 0121
active kinds + reliability rewards, 0109 duration, 0014/0037 jury reliability). Grounded in the relationship
reads (0017/0026), surfaced through the decision seam (0034) as a player-witnessed event (0002), sealed by
0001 (no hidden state in the offer; the decline-cooling is a hidden fold). Calibration-neutral by
construction (default-off flag + dedicated rng + lull-only) ⇒ byte-identical until the deploy opts in.
