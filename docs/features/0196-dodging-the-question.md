# 0196 - Dodging the question

Card: ORW-630 (approved by Ryne 2026-11-17, Fable idea Theme 2 #12). Executable spec: `0196-dodging-the-question.feature`. Unit gates: `tests/unit/dodging.test.ts`.
Flag: `ORWELL_DODGING` (default ON, `=0` kill switch). Played games only; a headless game and flag-off are byte-identical (no key, no draw, nothing saved).

## What was already built

Asked what they hold, a houseguest already tells, slips, lies or declines: the confide press (`decideConfidence` + the A52 disclosure route `ORWELL_DISCLOSURE_ENGINE`) is decided from trust, warmth, goodwill and personality, and a declined press carried a bare `deflect: true`. Asking around about a third person
(ORW-475, `askAround.ts`) already tells, dodges or misleads from the character sheet. A lie is already recorded as the player's belief with its own truth.

## What this adds

A bare `deflect` told the narrator only "they do not give it up", so every dodge was the model's improvisation. Now the engine also decides HOW (`src/engine/dodging.ts`, pure): `approach` (what they do with the question), `openness` (how their carriage reads: firm, uneasy or easy) and `pushesBack` (they hand it
back to the asker), composed from independent axes. Inputs are the houseguest's public style (guile, leakiness), temperament, their trust in the asker and the stakes. The draw comes from a keyed side stream per houseguest, week and phase (never the shared rng), so a repeat press in one beat reaches the same dodge. Each is appended
to a saved `dodgeLog` (one per houseguest, week and phase).

`npcVoice.dodge` hands the narrator that fact in the third person. The narrator authors every word; the prompt states a rule, not a sample.

## Wall

`dodge` carries no content (never what they hold or why), no number and no hidden state beyond the carriage a tell already shows. The player can read a dodge only by what the houseguest does and says.

## Deferred (ORW-825)

NPC-to-NPC asks (the same decision for a houseguest pressed by another houseguest), the stakes read from the held fact's own risk (a fixed middling stake for now), and a lie that is also a recorded claim at the dodge seam.
