# 0151 - What the player hears, and "who told you that?" (theme 2, slice 4)

Plan: the vault note "Theme 2 Slice Plan" (slice 4). Builds on 0149 (the claims core, `spokenClaims.ts`, owned by the BDD Auditor: any interface change goes through it).

## What it does
1. **A houseguest tells the player what they believe.** In a scene with the player, an NPC may pass on a belief they hold (the beliefs the claims core and B24 write: targets-me, voted-against-me, allied-with, rumors). The engine decides whether (gated by the NPC's trust in the player, the audience, candor, a seeded roll on its own side stream, once per houseguest per day, never the same belief twice), what, and how sure they sound (a band from the belief's confidence). The claim is recorded with `tellClaim` (listener = the player; `isTrue` = the engine's truth; the player gets no belief).
2. **The narrator only voices it.** A Vault-free per-houseguest field on the moment prompt: the claim as the speaker's words (kind, subject, object, certainty band). Never `isTrue`, never the intent, never the claim id.
3. **"Who told you that?"** The player's own words are read by the engine before the narrator (the resolvePlayerMove seam). The houseguest's recorded source for that belief is named or protected: decided by the engine from how they feel about the source and about the player (seeded, deterministic). A source of `witnessed` is "I saw it". The answer is the houseguest's belief; it can be wrong, and the narrator is not told.
4. **The player learns what they were told**: the named source reaches the player as "told by <houseguest>" knowledge through the existing pathway (as askJuror does), never as the truth.

## Rules kept
Vault Wall (only claims the player heard; no truth, no intent); the engine decides, the narrator voices; no model cost; calibration: its own side stream, house-mix and late-game guards in the PR; claims and beliefs kept for the season.

## 2026-11-18: claims from a plan step aimed at the player

A houseguest's speech step aimed at the player (plant, leak, confirm, fish) is told to the player as a claim when they step up, like any other
telling; see 0153 (same date). It adds no new field to `tellsYou`.

## 2026-11-18: "who told you that?" answers the claim asked about, and a liar's cover can slip (ORW-685, T2-14)
- The answer is about ONE claim: the one the player named (a subject or object in their words; most names matched wins), otherwise the newest the houseguest told them. It no longer falls through to an older claim that happens to be easier to answer.
- A liar asked about a lie they planted has no belief behind it. They play it off (say they saw it themself, or will not say who) or the cover slips. The slip chance is the actor's: it falls with cunning and rises with nerves, inside a band (`COVER` in `src/engine/claimSource.ts`), decided on its own keyed side stream (`${seed}:cover-slip`), so asking again gives the same answer and no other roll moves.
- A slip hands the narrator one Vault-free fact (the account does not hold together; voice a visible stumble; name no one; never say outright anything is untrue). The engine writes no line and the player decides what it means.
- Hidden impact, once per claim (recorded in `live.coverSlips`, append-only, persisted): the liar's read of the player takes a small bounded `conflict` step (`COVER.foldScale`).
- Flag `ORWELL_COVER_SLIPS` (default ON, played games only; off = today: the liar always says they saw it themself, the first askable claim is answered). Test: `tests/unit/orw685.test.ts`.
- Not built here: an NPC asking the PLAYER "who told you that?" (the engine would have to read the player's answer in their own words; parked for the Coordinator).
