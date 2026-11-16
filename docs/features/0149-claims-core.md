# 0149 — The claims core (theme 2, slice 1)

Card: ORW-330. Executable spec: `0149-claims-core.feature`. Plan: the vault note "Theme 2 Slice Plan", slice 1 (built on the
deep dive's recommended answers; Ryne's six theme 2 questions are still open, so every choice that depends on one sits behind a
named seam).

## What it is

What one houseguest tells another about the house becomes an **engine decision**, recorded as a *claim*:

- who said it (speaker), to whom (listener), about whom (subject, and a second party where the kind needs one);
- what it says, from a **fixed set**: `targets-you`, `voted-to-evict-you`, `final-two-with`, `going-after`, `talking-about`,
  `lying-about`;
- whether it is **true** (false = the speaker lied), and what the speaker really **meant** by it (`inform`, `warn`, `recruit`,
  `mislead`, `deflect`, `protect`).

Telling a claim to an NPC writes that NPC's **belief** (the #2017 belief store), with the speaker as its source and a confidence
from the speaker's reliability in the listener's eyes (trust, plus the word-keeper bonus: the same rule as heard-about-me, B24).
A false claim plants a false belief exactly like a true one; only the claim log knows it was a lie. The player is never handed a
belief: the read is the player's own (0017/0020).

## The wall

- The claim log (`LiveSeasonState.claims`) is engine-only, Vault class, never projected to a player or admin surface.
- The ONLY outward projection is `claimsHeardBy(PLAYER)`: the claims the player heard as their listener, built field by field
  (speaker, kind, subject, second party, week, day). Truth and intent can never ride along. It is the narrator seam; slice 4 wires
  it into the narrator's context.
- Claims are append-only for the season (never thinned) and round-trip through save and restore unchanged.

## Code

- `src/engine/spokenClaims.ts`: pure rules (no I/O, no rng). The caller decides the claim, its truth and its intent.
- `GameSessionAdapter.tellClaim` (engine-side only: not a tool, on no channel) and `claimsThePlayerHeard`.
- No live caller yet: slice 3 (house life: plant, leak, confirm, misinformation campaigns) and slice 4 (what you hear) are the
  callers. So this slice cannot move any outcome, and the house mix and calibration gates are unchanged by construction.

## Seams for Ryne's open questions

| Question | Assumed answer | Where it changes |
|---|---|---|
| Q1 lie content | the engine picks from a fixed set | `SPOKEN_CLAIM_KINDS` + `beliefFor` |
| Q2 belief strength | full strength, measured | slice 2 (how beliefs steer decisions); this slice only writes them |
| Q3 spotting a lie | no built-in tells | `claimsHeardBy` is the only projection; a tell would be a field there |
| Q4 NPC to NPC | yes, from the start | `CLAIM_RULES.npcToNpc` |
| Q5 house meetings | both can call, later | slice 7; not here |
| Q6 narrator promises | the engine decides first; the ledger is the net | `SpokenClaim.origin` (slice 6 adds `"narrated"`) |

## Deviation from the plan's set

The plan listed "X told me Y". A nested claim needs a claim inside a claim, which belongs with "who told you that?" (slice 4).
Slice 1 uses `talking-about` ("X has been talking about Y behind their back") in its place.
