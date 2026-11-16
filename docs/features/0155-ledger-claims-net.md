# 0155 — The open ledger as the safety net (theme 2, slice 6)

Card: ORW-330. Executable spec: `0155-ledger-claims-net.feature`. Plan: the vault note "Theme 2 Slice Plan", slice 6.
Builds on 0149, 0150 and 0153, and on the open ledger (ORW-407; ORW-448 is next door, and its code is untouched).

## What it is

Sometimes the narrator writes a claim the engine never decided: an NPC tells someone that a houseguest is targeting
them, or how someone voted. The open ledger already catches what is said in the player's hearing. Now, when the
entry is a claim about houseguests that fits the engine's claim set, it carries a structured form
`claim: {kind, subject, object?}` to the engine, and the engine handles it like any other claim:

- **Recorded:** the claim is kept with its speaker and its listeners, as `origin: "narrated"`. The listeners are the
  addressees, the houseguests present, and the player.
- **Truth:** it gets its truth from the engine's own records (`truthOf`: goals, ballots, deals, the claim log).
- **Belief:** every NPC listener holds it as a belief, sourced to the speaker. The player gets no belief.

So there is one record of what was said, not two. A narrated false claim becomes a real false belief that slice 2
turns into decisions, and the season retrospective (0157) can show it.

## Pieces

- **Front end** (`frontend/src/orwell_open_ledger.py`):
  - The extraction may add `claim` from the fixed set: targets-you, voted-to-evict-you, final-two-with, going-after,
    talking-about, lying-about, voted-against, voted-to-keep.
  - Names resolve to ids. A claim the engine wouldn't understand is dropped, and the entry is kept without it.
  - `record_open_ledger` sends `claim` only when there is one.
- **Boundary:** the McpServer shape guard accepts an optional `claim` of strings.
- **Engine:**
  - `recordOpenLedger` strips `claim` before the ledger's own proposal, so the entry, its validation and its bounds
    are exactly as before.
  - Once the entry is recorded, `tellNarratedClaim` tells it. A re-statement (a duplicate entry) never re-tells it.

## Ryne's question 6

A narrated claim's intent is unknown, so it is recorded as "inform". **Promises** the narrator writes are not handled
here: whether they bind the NPC is Ryne's open question 6. They stay ledger entries only.

## The wall

Claims, their truth and their origin stay engine-only. The narrator's seam shows only what the player heard, as words.
Scenario 2 checks that no player or admin surface shows a verdict.
