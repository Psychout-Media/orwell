# 0141 - Deal depth II: counteroffers, owed favors, new deal kinds, weighing a break

> **Status:** SPEC ONLY (ORW-88, 2026-11-11). Approved by Ryne 2026-11-06, all four ideas; build in the order below, after the playtest. Ships ON when built, but see section 5 for the gating rule that keeps seeded sims byte-identical.
> **Executable spec:** [`0141-deal-depth-ii.feature`](./0141-deal-depth-ii.feature)
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
A seeded decision from the NPC's own interest and personality (temptation against the price of being known as a liar, tied to the credibility memory B48): keep, quietly break, or renegotiate. A deal can be broken on purpose, not only by accident.

## 5. Gating and calibration
Every new behavior runs only for a played game (`live.playedGame`) or draws from a side rng stream, never the shared one, so headless seeded sims stay byte-identical (`stagedTrajectoryNeutral`, `memoryDecisionMatrix*`, the deal-depth tests stay green). Each slice ships with a both-ways test (behavior present / absent) and a mutant. Balance is measured and reported, never a gate. Any new flag must be registered the usual way (featureFlags, `deploy/orwell-env-defaults.sh`, `docs/FLAG-INVENTORY.md`, `healthFlags` count); this spec adds none.

## 6. Open questions for the build
- Where a banked favor lives (the deal ledger vs a separate list) and whether it expires.
- Whether a counteroffer may carry a 0121 active kind (comp-throw / veto-save) from day one.
