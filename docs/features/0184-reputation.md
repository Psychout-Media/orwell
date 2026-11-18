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

## Part 2a: social roles, and reputations voiced as gossip (ORW-564; flag `ORWELL_SOCIAL_ROLES`, default ON)
**The read (`src/engine/socialRoles.ts`, adapter `roleOf(observer, subject)`).** Roles emerge from what each houseguest SAW (the scenes they were in, or saw from the room), never assigned:
- **villain:** starts fights and turns on people;
- **peacemaker:** brings both sides of a fight they were not in back together;
- **therapist:** takes the one who just got hit aside, one on one;
- **jokester:** has a sense of humour (their voice) and gets the group going;
- **outcast:** seen with almost nobody, in a house the observer has seen plenty of;
- **snake:** the observer's own part-1 standing of them is poor;
- **floater:** nobody the observer can see is close to them (the perceived floater read).

Labels the observer was TOLD count toward a role at their confidence. So a role is a read, and it can be wrong. The player is read like anyone.

**Voiced as gossip (Ryne's Q3 ruling).**
- A new spoken claim kind, `has-reputation`, with an engine label: the listener holds it as a heard rumor whose nature carries the label (`rep:<label>`), with no new belief field. The narrator voices it in its own words, never as a label.
- When a houseguest is asked what they know (the house-life `fish` action) and holds a role read of someone, a quarter of the time (`ROLES.voiceShare`) they answer with that instead of a belief, and they always do when they hold no belief to pass on. It is about the one asked about, else someone they hold a role for, and may be about the asker ("everyone says you're..."). (A `leak` still passes on only what the speaker holds, per 0153; house life never chooses that action today, noted for ORW-636.)
- Measured in one chat-paced played season: 48 reputation claims across six labels.
- A heard reputation can be passed on to the player through the usual `tellsYou` decision, the player's own name included ("everyone thinks you're the snake").
- A told "snake" or "villain" counts as a heard wrong in the part-1 standing, so a reputation spreads as claims do.
- Heard reputations are talk, not a fact to check: they never start an ask-around test.
- A label is TRUE only when the engine's own read of the whole record (every scene, as if seen) gives the same role. The retrospective's claim records show which labels were wrong.

**The player in both directions.** The player's own scenes make their role in each observer's eyes (start fights and the house reads a villain). Gossip about the player reaches the player. The player can spread a reputation too: telling a houseguest someone is a snake (or any role) is an ORW-612 statement of kind `has-reputation` with the role word (the front end's scene belt proposes it, validated against the engine's role words, and the engine re-checks), and the listener holds it from the player like any claim.

## Part 2b: a close pair fakes distance in public (ORW-564; flag `ORWELL_FAKED_DISTANCE`, default ON)
- **Who hides (`src/engine/fakedDistance.ts`).** Each week, an NPC pair where each feels close to the other (`HIDE.bondAtLeast`) decides whether to hide it. The chance rises with either one's cunning and with the house's paranoia dial. It's decided once a week on its own seeded side stream and kept on the season (`live.hiding`).
- **What hiding does.** Their warm time together (bonding, showmance, strategy, alliance talk) stays low-key: someone else in the room registers it only on a keyed catch roll (`HIDE.catchChance`). A fight is never hidden. Under own-view (ORW-574, played games) the house reads a pair only from the scenes it registered, so anyone who never caught them reads them as no closer than strangers; one who did reads them closer.
- **The player in both directions.** The player in the room can catch a hiding pair slipping off together, as a scene only the player saw (their own read to make). The player's own time with a houseguest is never registered by onlookers in the first place (own-view: only what is told spreads), so only NPC pairs decide to hide.
- **Measured:** see the PR (the 12-season mix guard; scene types are unchanged, only who registers them).

## Part 2c: a bad name keeps you out of pacts, and the house's social map (ORW-564)
- **Pacts and alliances read reputations (played games, with `ORWELL_REPUTATION`).** A houseguest who holds another at a bad name (part 1 standing at or below `REPUTATION.pactBar`, 0.7: two or three heard wrongs) won't seal a quiet NPC-to-NPC pact with them, or take them into an alliance. Either side's view is enough.
- **The player counts like anyone.** A founder who has heard the player is a snake won't pitch them their alliance. The player's broken word (part 1, Ryne's Q2) now closes doors.
- **The social map (post-crown only).** The retrospective's `socialMap` lists, for each houseguest and the player, the roles the house read in them and how many houseguests held each read. These are engine keys with counts, voiced by the narrator, never shown as labels.

## Still to come
The pairs that faked distance (part 2b keeps only the current week's) on the social map: a weekly record, then a `hiddenPairs` list.
