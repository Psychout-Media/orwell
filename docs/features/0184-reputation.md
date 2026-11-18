# 0184 - Reputations (Theme 3 slice 8, ORW-564) - part 1

Status: part 1 built. Engine-only; nothing new is shown. Flag `ORWELL_REPUTATION` (default ON, `=0` opts out), played games only, needs `ORWELL_BOND_RECORD`.

## What it does
Each houseguest holds their own picture of every other houseguest's name, from what they have heard or seen of that houseguest lying to or turning on people. Someone heard to be a snake is believed less and dealt with less readily by those who heard it. Observers who heard nothing see a clean name. The player is a target the same way: what the house hears about the player's turns and broken faith lowers their name with those who heard.

## The read (`src/engine/reputation.ts`, tunables in `REPUTATION`; adapter `reputationOf(observer, target)`)
- Evidence is the observer's OWN belief claims about the target that name a wrong done to someone else (a heard rumor of lying or of betrayal): the same claims gossip already spreads, so a reputation spreads as claims do (Ryne's Q3 ruling) and is never a separate score.
- Each such claim multiplies the standing by 1 - perHeardWrong x confidence x recency (half-life in weeks, never fully forgotten).
- Promises the target kept to the observer (kept deals) close part of the gap, up to a cap.
- Bounded to [floor, 1]; never zero; 1 = nothing heard.
- The observer's own caught lies stay with credibility (ORW-587 / B48). Reputation reads only the rest, so nothing is counted twice.

## Where it decides (two seams)
1. How readily a listener credits what a speaker tells them: the listener's credibility of the speaker is multiplied by the speaker's standing, bounded below by the credibility floor (`composeWithCredibility`).
2. How willing a houseguest is to take a deal the player offers: a poor standing of the player in their eyes adds a small signed drag to the existing deal-willingness mood term (`dealWillingnessShift`).

## Wall
Never projected, never a tool result, never a prompt line, never a number or label to the player. `tests/unit/reputation.test.ts` pins it.

## Deferred to part 2
Reputation voiced as gossip about NPCs and the player, social roles, reputation read by NPC-to-NPC deals and alliance offers, perceived bonds beyond the HOH read, faked distance, and the retrospective.

## Part 2b: a close pair fakes distance in public (ORW-564; flag `ORWELL_FAKED_DISTANCE`, default ON)
- **Who hides (`src/engine/fakedDistance.ts`).** Each week, a pair where each feels close to the other (`HIDE.bondAtLeast`) decides whether to hide it. The chance rises with either one's cunning and with the house's paranoia dial. It's decided once a week on its own seeded side stream and kept on the season (`live.hiding`). A pair with the player hides on the NPC's say.
- **What hiding does.**
  - Their warm time together (bonding, showmance, strategy, alliance talk) stays low-key: someone else in the room registers it only on a keyed catch roll (`HIDE.catchChance`). A fight is never hidden.
  - Someone who never caught them reads only a little of their true closeness (`HIDE.leak`) in the perceived-bond read (0163). Anyone who caught them together, or was told, reads them as before.
- **The player in both directions.**
  - An NPC close to the player can hide it, and the house then reads the player as less tied to them (the floater and duo reads see what the house sees).
  - The player in the room can catch a hiding pair slipping off together, as a scene only the player saw (their own read to make).
- **Measured:** see the PR (the 12-season mix guard; scene types are unchanged, only who registers them).
