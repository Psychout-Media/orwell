# 0150 — Beliefs drive decisions at full strength (theme 2, slice 2)

Card: ORW-330. Executable spec: `0150-beliefs-drive-decisions.feature`. Plan: the vault note "Theme 2 Slice Plan", slice 2.
Builds on 0149, the claims core: claims plant beliefs, and this slice makes those beliefs count.

## What it is

What a houseguest believes about someone now pushes their decisions, whether the belief is true or not. Four kinds of
believed grievance count:

- **targets-me:** "they're targeting me";
- **voted-against-me:** "they voted to evict me";
- **lied-to-me:** "they lied to me";
- **going-after-me:** a rumor that they're going after me.

Before this slice only "targets me" counted, and it was capped at a small tilt (0.18). Goals count at full strength (Ryne,
2026-11-12), so beliefs were the weaker voice. Now:

- **Nominations, votes and deal consent** read `beliefPull`. At full strength a believed grievance sits on a goal's scale
  (`REASONS.goalWeight`).
  - Each belief counts as weight × confidence × decay, with a 4-week half-life.
  - Several beliefs stack with diminishing returns.
  - A refuted or disbelieved belief counts for nothing.
- **Goals:** a believed grievance over the bar (0.6, the same bar a remembered grudge needs) can form a revenge goal. The
  goal's reason is the belief (`why.kind = "belief"`).
  - There is never a second revenge goal on someone a remembered grudge already made one on.
  - The season retrospective words the reason as "something they believed about …".

## Ryne's question 2, behind one seam

`BELIEF_RULES.strength` in `src/engine/beliefDecisions.ts`:

- **"full"** is the recommended answer: beliefs count like goals, and the effect is measured and reported, never used as a gate.
- **"capped"** is the behaviour before this slice, byte for byte: the old targets-me tilt, and no goals formed from beliefs.

A different answer is a change in that one place.

## The wall

Beliefs and the goals they form are engine-only, never projected. Scenario 3 proves that telling the claim and forming the
goal changes nothing on any player or admin surface.

## The veto too

The veto save reads beliefs as well. Its memory bias (`vetoMemoryFor`, B7) already includes the holder's belief tilt
(`beliefNomTiltFor`), and this slice turned that tilt into `beliefPull`. So a believed grievance against a nominee cuts the
save at the same strength.

## Not in this slice

- The reads that still use the hidden truth (who's a floater, who the HOH really wants out, a juror's trust) are not yet moved
  to beliefs. This is noted on ORW-330 for a later slice.

## Measured, not gated

The PR reports how full strength changes three things:

- the week-1 house mix;
- jury reach and the calibration gradient;
- how often a houseguest is evicted because of what someone wrongly believed.
