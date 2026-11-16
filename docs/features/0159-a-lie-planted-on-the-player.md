# 0159 - A lie planted on the player (theme 2, owner's Q1 ruling C)

Builds on 0151/0152 (slice 4), 0153 (slice 3's `planSpeech`) and the owner's ruling (Q1 = C): the engine decides a consequential lie's substance, the narrator words it freely.

## Rule
In `claimsToPlayerFor` (the slice 4a seam), when a houseguest tells the player nothing from a held belief, a houseguest who holds an ACTIVE goal against another houseguest (get-them-out / revenge / long-con, the same goals `truthOf` reads) may plant a lie on the player through slice 3's `planSpeech("plant", actor, PLAYER, about, truthful = false, ctx)`: one of the planter kinds (`targets-you`, `lying-about`, `talking-about`), false by the engine's truth, intent `mislead`. A seeded side stream (`${seed}:plant-to-player`), once per houseguest per in-game day, gated by the speaker's cunning/candor and a LOW base chance so the house mix does not move; the trust gate is not applied (a manipulator lies to anyone), a crowd lowers it.
The claim is recorded with `tellClaim` (listener = the player; no belief for the player). The narrator field is slice 4a's `tellsYou`, unchanged: {kind, subject, object, certainty}; the band is `presentedBand(undefined, roll)` (a lie carries the band a true claim would: no built-in tell).
"Who told you that?" about a planted lie: there is no held belief behind it, so the engine answers "saw it themself" (names no one, the note carries no hint it is untrue).
No change to `spokenClaims.ts`/`houseSpeech.ts` (Auditor-owned): the planter kinds and `planSpeech` are used as they are.
