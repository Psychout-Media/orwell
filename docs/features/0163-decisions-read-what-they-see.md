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

## Not yet

Two reads the card names still use the hidden truth: the HOH's real target as other houseguests see it, and a juror's trust. They are a
follow-up.
