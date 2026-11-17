# 0181 - A bond's life: feelings vs strategy, guilt, jealousy, divided loyalty (Theme 3 slice 4, ORW-568)

Status: parts 1 and 2 built. Engine-only; nothing new is shown and no text is added. Flag `ORWELL_BOND_FEELINGS` (default ON, `=0` opts out; needs `ORWELL_BOND_RECORD`), played games only.  Part 2 rides the same flag.

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

## Part 2: jealousy and divided loyalty (`src/engine/bondJealousy.ts`; the negative side only, positive triads are slice 13's)
- **Jealousy.** A holder close to X (warmth past a bar) who watches X spend noticeably more of the recent shared scenes (the last window of recorded pair scenes) and more warmth on a third person Y than on the holder grows jealous. The reading is monotone in X's scenes with Y, falls as X's scenes with the holder grow, grows with how close the holder is, and is bounded below 1. The culture's paranoia and bonding lean it; loyalty damps it.
- **What it does.** A nightly tick (next to the bond fold) keeps a hidden overlay `live.jealousy` per `holder|rival` (value, the close friend it is over, the week), which follows a higher reading up and fades each night otherwise. Closeness slips: the holder's feeling-keep for X is cut by a bounded share (same provider, `feelingKeepFor`), and once a week the holder's mood takes a small scaled hit through the existing agitation impulse (deduped in `live.jealousySeen`). No new emotion, no memory note, no rng, no text.
- **Unless handled.** A bonding, alliance or showmance scene between the holder and X since the last tick (`live.jealousyCursor`) clears that jealousy and takes no new reading for the pair that night.
- **The bond record is never written.** There is no sanctioned strain write in the record; the effects go through mood and the keep term only.
- **Divided loyalty.** A holder close to both of two people who have fallen out (the worse of their grudge or strain, either way, past a bar) is pulled both ways: `loyaltySplit(h, a, b, reader)` in 0..maxSplit. It adds a bounded extra keep for either (carried by the same `feelingKeepFor` provider, so no new vote term) and divides the alliance-break threshold a little more (threshold only; the draw is unchanged). Never the player.
- **Flag and headless.** Same flag `ORWELL_BOND_FEELINGS`, played games only; a headless sim is byte-identical.

## Gates
BDD `0181-bond-feelings.feature`, `tests/unit/bondFeelings.test.ts` and `tests/unit/bondJealousy.test.ts` (pure rules, decision level, byte-identity, dedupe across save and restore, wall) and the decision x memory-source gates in `tests/unit/memoryDecisionMatrix*.test.ts`.
