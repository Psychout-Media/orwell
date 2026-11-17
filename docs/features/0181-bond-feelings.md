# 0181 - A bond's life: feelings vs strategy, guilt (Theme 3 slice 4, part 1, ORW-568)

Status: part 1 built. Engine-only; nothing new is shown and no text is added. Flag `ORWELL_BOND_FEELINGS` (default ON, `=0` opts out; needs `ORWELL_BOND_RECORD`), played games only. Part 2 (jealousy, triangles, divided loyalty) is not in this feature yet.

## What it does
A houseguest's plan can say "cut them" while what they really feel for that person says no. Two effects, both read from the bond record through the bond reader (never written):
- **Hesitation.** The feeling holds a holder back. It is a probability drop, never a hard block.
- **Guilt after.** A betrayer who truly liked the person they hurt is shaken afterwards. It moves the existing mood only, so it surfaces only through the channels that already read the soul.

## Rules (tunables in one block in `src/engine/bondFeelings.ts`)
- **Feeling** = warmth x (1 - resentment): zero for a stranger or a grudge-holder.
- **Hesitation** = maxHesitation x feeling x (1 - a small strain damp). Monotone in warmth, falls with resentment, strictly below 1. `hesitationFor(holder, other, reader)` is the single hook the plan roll of Theme 3 slice 1 reads.
- **Votes and nominations.** One additive, signed term (`feelingKeepFor`, a `SeasonCtx` provider) keeps the nominee the voter truly likes in the NPC eviction vote; the same provider is a negative push in the NPC HOH's nominations and replacement. The veto save does not read it. Named `feeling` at the end of the vote and nomination term lists (the why-ledger indexes by position).
- **Alliance break over a goal clash.** The break threshold is divided by (1 + k x hesitation). Threshold only: the keyed draw is the same.
- **Guilt.** Past a bar on the feeling, the betrayer catches `guiltScale` of the existing `betrayed` impulse (scale = feeling x a weight, leaned by the culture's loyalty, bonding and paranoia dials). No new emotion, no memory note, no rng, and no resentment: the bond record's grudge is untouched. Never the player. Once per betrayer, wronged and week (`live.feelingsSeen`, ordered, hidden, optional, persisted with the season). Three doors: an alliance break, a deal broken by an NPC, and each voter who sent home someone they truly liked (the ballot stays secret: nothing is announced).
- **Headless.** The provider is spread into the context only in a played game with the flag and the bond record on, so a seeded headless sim adds +0 everywhere and is byte-identical.

## Gates
BDD `0181-bond-feelings.feature`, `tests/unit/bondFeelings.test.ts` (pure rules, decision level, byte-identity, dedupe across save and restore, wall) and the decision x memory-source gates in `tests/unit/memoryDecisionMatrix*.test.ts`.
