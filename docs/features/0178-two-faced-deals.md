# 0178 - Two-faced deals (Theme 3 slice 1)

Card: ORW-552 (Ryne approved the Theme 3 plan, 2026-11-17). Executable spec: `0178-two-faced-deals.feature`. Plan: the vault note "Theme 3 Slice Plan",
slice 1. Code: `src/engine/dealPlans.ts` (pure); the adapter's `planAndCarryOutDeals`, `flipsAtThisVote` and the retrospective's `dealPlans`.

## What it is

When a houseguest agrees to a deal (with the player or another houseguest), the engine gives them a **secret plan** for it, once, the first beat it sees the
deal:

- **keep**: today's behaviour. The 0142 weekly weighing can still change their mind, because people do.
- **break-at**: break it at a chosen moment. A safety deal is broken at the nominations it was meant to cover; a final two is broken at a later vote.
- **flip**: at this week's vote, the deal's weight turns against the person it protected. The vote itself carries it out.
- **cut-final-three**: a final two, cut once three are left.

A two-faced plan is carried out at its moment through `DealLedger.breakDeliberately`: the ordinary fallout, quiet and Vault-held. The weekly weighing
skips a deal its two-faced plan rules. Each plan's outcome is written once: carried out, kept anyway, or overtaken.

## How it is decided (Ryne's rulings)

- The 0142 weighing at the moment of agreeing sets the base: their read of the other party, their own push and goals, and the price of being known as a liar.
- **Q1** (2026-11-17): how often depends on the person, the bond and the culture, **with no cap**. A houseguest who makes many deals leans toward breaking
  them: each deal beyond the first adds `dealCountLean`. Their temperament (low candor) and the house culture (the lying and loyalty dials) move it too.
  `P = clamp(slope × lean + baseRate × temperament, 0, 1)`: no ceiling below certainty.
- **Q3** (Theme 2): no built-in tells. A two-faced houseguest says and does what a keeper does until the moment comes.
- Which plan comes from the deal's kind, using rolls from a side stream keyed on (seed, deal, holder): no shared stream moves.

## The player's promise record (Ryne's Q2)

Every promise the player makes is kept on record with its status: their deals, and the promises they said aloud (the open ledger). After the crown, the
retrospective shows it **beside** each houseguest's plan and how it went. Before the crown nothing shows a plan: no view, no prompt.

## The wall, the words and the measurement

- The plans are engine-only (Vault class). Plan kinds are engine enums; the words a player reads about them are written live by the narrator from the
  retrospective's structured data, never from a fixed menu (Ryne's 11-17 rule against short lists).
- It runs in played games only, like the 0142 weighing. Flag `ORWELL_DEAL_PLANS`: default ON; `=0` means no plans, byte-identical.
- The rate is **measured and reported, never capped**: `tests/calibration/dealPlansReport.test.ts` (opt-in) prints the two-faced share by plan kind, by deals
  made before, and by outcome. The house-mix guard and the calibration gates run as usual.
