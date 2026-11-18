# 0163 - Decisions read what the decider can see (theme 2, slice 2b)

Card: ORW-539 (from ORW-330). Executable spec: `0163-decisions-read-what-they-see.feature`. Code: `season.ts` (`floaterRead`, `duoRead`,
`duoPartner` take a `BondReader`), the adapter's `perceivedBond`, house-life scenes' `seenBy`.

## What it is

The HOH's floater and duo reads decide who looks like a floater, who is in a tight pair, and who goes up beside a target to break a duo. They
used to look straight at other houseguests' real relationships, which no houseguest can see. Now they read the bond the HOH **perceives**:

- **half what the HOH could see:** the bonding and showmance scenes they took part in or watched from the same room (house-life scenes record
  `seenBy`, the houseguests in the room who were not part of it), plus their allied-with beliefs ("they have a final two");
- **half the true bond:** a house reads more than its own scenes (tone, glances). A first version that used only what was seen failed the
  calibration gradient; the blend passes.
- A houseguest reads their **own** bond true.

So a pair that bonds out of the HOH's sight looks less close than it is, and a pair the HOH watched, or was told about, looks closer.

## Flag

`ORWELL_PERCEIVED_BONDS`, default ON (built means on); `=0` gives the hidden-truth read, byte for byte. It is separate from the belief store,
so the belief layer stays byte-neutral. It applies only at `BELIEF_RULES.strength === "full"`.

## The wall

`seenBy` and the perceived bond are engine-only, never projected.

## Widened: every NPC decision reads its own view (ORW-574, ORW-596; 2026-11-17)

Ryne's 11-03 rule: NPCs decide "from their own view... what each NPC believes". A decision may read the DECIDER's own edges, beliefs and
perceptions, never another houseguest's hidden feelings. In a **played** game (`live.playedGame`) with this flag on:

- **The floater and duo read is only what the decider saw (ORW-596).** The half that was the true bond is gone: the read is every warm
  (bonding, showmance, alliance, strategy, gossip) or cold (conflict, betrayal) scene between the two that the decider was in or watched,
  plus their allied-with beliefs. A pair that bonds only out of sight reads as strangers. How warm someone is to the decider THEMSELVES is the
  decider's own bond shaded by their beliefs, never the other's edge.
- **How someone feels about the decider** (`perceivedTrust` / `perceivedThreat`) is their own reciprocal read, their public menace (archetype,
  public comp wins) and their beliefs: an assurance they hold raises it, a believed grievance (targets me, voted against me, lied to me,
  going after me) lowers trust and raises threat. **Between two others** it is the bond they saw, and for threat half their own read of the
  subject and half the subject's public menace, plus a rumor they heard that one is going after the other.
- Routed through it: comp intent (a rival's threat read of me), Houseguest's Choice (the candidate's trust, bonds and competition strength,
  now public: archetype and comp wins), the week's political temperature (the house's threat reads as the HOH sees them), pitch strength (the
  pitcher's read of the HOH), the vote's jury-management term (the nominee's trust in the voter) and the HOH's target as the voter reads it,
  vote counting (each voter's lean as the counter sees it), and the final HOH's jury estimate (the rival's closeness to each juror).
- The player in both directions: an NPC's read of the player is its perception, never the player's hidden edges.

Headless seeded sims (calibration, jury reach, UAT) never set `playedGame`, so they keep the earlier reads (including the 50/50 blend) byte
for byte. Gate: `tests/unit/ownViewDecisions.test.ts` (each decision does not move when only the other party's hidden edge moves, and does
move when the decider's own view moves).

## 2026-11-18: premise check for ORW-685 item 4 (floater and duo read on beliefs)
Verified against main: in a played game (`ownViewOn`) `perceivedBond` already reads only the scenes the holder was in or watched plus the holder's own `allied-with` belief claims (not refuted, at their confidence); the hidden true bond enters only in headless sims (the 50/50 blend above). The HOH's floater and duo reads (`liveSeason` `bondOf` via `perceivedBondFor`) and the role read's floater term take that same reader. Nothing is left to build for played games; no change made.
