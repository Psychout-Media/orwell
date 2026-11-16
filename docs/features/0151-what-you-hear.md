# 0151 - What the player hears, and "who told you that?" (theme 2, slice 4)

Plan: the vault note "Theme 2 Slice Plan" (slice 4). Builds on 0149 (the claims core, `spokenClaims.ts`, owned by the BDD Auditor: any interface change goes through it).

## What it does
1. **A houseguest tells the player what they believe.** In a scene with the player, an NPC may pass on a belief they hold (the beliefs the claims core and B24 write: targets-me, voted-against-me, allied-with, rumors). The engine decides whether (gated by the NPC's trust in the player, the audience, candor, a seeded roll on its own side stream, once per houseguest per day, never the same belief twice), what, and how sure they sound (a band from the belief's confidence). The claim is recorded with `tellClaim` (listener = the player; `isTrue` = the engine's truth; the player gets no belief).
2. **The narrator only voices it.** A Vault-free per-houseguest field on the moment prompt: the claim as the speaker's words (kind, subject, object, certainty band). Never `isTrue`, never the intent, never the claim id.
3. **"Who told you that?"** The player's own words are read by the engine before the narrator (the resolvePlayerMove seam). The houseguest's recorded source for that belief is named or protected: decided by the engine from how they feel about the source and about the player (seeded, deterministic). A source of `witnessed` is "I saw it". The answer is the houseguest's belief; it can be wrong, and the narrator is not told.
4. **The player learns what they were told**: the named source reaches the player as "told by <houseguest>" knowledge through the existing pathway (as askJuror does), never as the truth.

## Rules kept
Vault Wall (only claims the player heard; no truth, no intent); the engine decides, the narrator voices; no model cost; calibration: its own side stream, house-mix and late-game guards in the PR; claims and beliefs kept for the season.
