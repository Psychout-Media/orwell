# 0153 — NPCs spread and lie on purpose (theme 2, slice 3)

Card: ORW-330. Executable spec: `0153-npcs-spread-and-lie.feature`. Plan: the vault note "Theme 2 Slice Plan", slice 3.
Builds on 0149 (claims) and 0150 (beliefs drive decisions).

## What it is

The house-life speech actions that used to be only labels now say something real. Each one becomes a claim
(`src/engine/houseSpeech.ts`), decided by the engine and checked against its own truth:

- **plant** (and a campaign's **flip-a-vote** and **frame**): a story about the target told to a listener.
  - An untruthful speaker tells a claim the engine knows is false: that the target is targeting the listener, is
    lying to them, or has been talking about them.
  - A truthful speaker tells a damaging claim that is actually true, or says nothing.
  - Truthfulness comes from the existing house-life roll: candor against the scheming boost.
- **leak:** the speaker passes on something they believe about the target.
  - It's true or false as the belief happens to be; the leaker can't know.
  - If the speaker holds no belief about the target, nothing is said.
- **confirm:** the speaker backs up what the listener already believes about the target.
- **fish:** the listener answers the asker with one of their own beliefs, so the claim runs from listener to asker.

Each told claim plants the listener's belief, which 0150 turns into decisions.

## The engine's truth (`truthOf`)

| Claim | True when |
|---|---|
| targets-you, going-after | the subject holds an active get-them-out, revenge or long-con goal on that person |
| voted-to-evict-you | a recorded ballot says so |
| final-two-with | an open final-two deal exists |
| lying-about | the claim log holds a lie from the subject to that person |
| talking-about | the claim log holds a claim the subject told about that person |

Lies about votes are left to slice 5.

## The misinformation campaign

When a houseguest wants a nominee out, the campaign tells its stories to this week's voters. The HOH, the nominees and the
target are never told. This uses the house-life campaign's own "ears", now turned into claims.

## The wall

All of this happens off-screen between NPCs (Ryne's question 4, assumed yes; the seam is `CLAIM_RULES.npcToNpc`). A claim
told to the player is slice 4 (Overseer B). Nothing here reaches the narrator.
