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
- An NPC asking the PLAYER "who told you that?" is built in ORW-687 (see below).

## 2026-11-18: a houseguest asks the PLAYER "who told you that?" (ORW-687, the mirror of ORW-685's cover slip)
- When the player passes a claim on to a houseguest (a recorded `statement`), that houseguest may ask where the player got it. Whether they ask is one draw on its own keyed side stream (`${seed}:asks-source`), likelier the less they trust the player, inside a band (`ASK` in `src/engine/sourceAsk.ts`). Only a claim the engine HAS a recorded teller for is ever asked about: the engine's record of who told the player is the told-to-the-player lineage in the claim log (`trueSourceOf`, same story = `sameStory`). One open question per houseguest, once per claim, appended to `live.sourceAsks` (append-only, persisted, superset-checked in the session snapshot; engine-only, never projected).
- It is an open approach: the narrator is handed `asksSource` (the claim in public names, never the teller) that turn and the next, voices the question once and waits. The player answers in their OWN words or ignores it; the engine never answers for them, and an ignored question lapses with the week with nothing folded.
- The engine reads the player's words before the narrator writes (the same `resolvePlayerMove` seam as "who told you that?"). The read is structural, never rolled and never a hidden player stat: naming exactly the recorded teller = `matches`; naming one other houseguest = `contradicted`; naming no one and plainly declining (will not say, no one told them, worked it out themself) = `dodged`; anything else reads nothing. It folds one bounded step on the asker's read of the player, once, on the cover-slip scale (`COVER.foldScale`): a small warm step, half, full. The narrator gets one fact (`readsAnswer`: believed, noticed-a-dodge, doubts-it) and the rule says add no fact and never say what the truth is.
- Limits: the answer is read from the player's typed words by a name match plus a decline parse (like "who told you that?" itself), not by a model proposal; a negated name ("it wasn't Sam") reads as naming Sam. A model-proposed `{named}` field through `recordInteraction` would be the stricter follow-up. (ORW-825)
- Reuses flag `ORWELL_COVER_SLIPS` (default ON, played games only; off = nothing is asked or recorded). Test: `tests/unit/orw687.test.ts`.
