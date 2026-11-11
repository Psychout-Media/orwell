# 0141 — A private orientation can reach you, by the houseguest's own choice

> **Status:** ✅ **BUILT (confide path), 2026-11-11** — Ryne ruled "Their own choice" (ORW-261, BDD card 31). Engine: `maybeShareOrientation` in `GameSessionAdapter.confide` (played games only, side stream `orientation-disclosure`, trust bar + `routeDisclosure`, told once per houseguest, `live.orientationTold`). Proven by `tests/unit/orientationDisclosure.test.ts` (the `.feature` stays spec-only, no step definitions). **Slice 2 (unprompted, built):** an NPC who steps in by the desire clock (A8, `advanceClockPerConversation`) may volunteer it (`volunteerOrientation`; trust bar 0.75, no press, extra rarity draw 0.12, same side stream); surfaced as `interruption.tells`, recorded as a told-by fact. **Not built:** an ask path that is not the confide press.
> **Depends on:** 0063 (the diversity layer that seals `privateOrientations` in the Vault), 0075 (trust-gated confidences — the same engine-decided disclosure pattern), 0002 (pathway propagation / `surfaceInformationTo`),
> the disclosure decision (`disclosureDecision`, #2135, routed for confide in #2366), 0001 (Vault Wall). **Lines up with:** ORW-253 (NPC agency design) — this is one disclosure *choice* an NPC makes; it must be specced once, there.

## Ryne's words (BDD card 31, 2026-11-11)

"Private orientation should reach you … someone coming out should be a path, but … if someone didn't want to come out, they didn't have to … it could come out, if someone asks, so if we're talking about it."

## What exists today

`privateOrientations` (a closeted / private orientation per houseguest, 0063) is **sealed in the Vault**, persisted, and read for showmance plausibility. **Nothing surfaces it to the player.** The 0063 Gherkin fakes the pathway by writing the belief itself.

## The design

1. **Never forced, may never happen.** A houseguest with a private orientation *may* choose to tell the player. Most never do. There is no timer, no quota, no scripted reveal.
2. **The engine decides, the narrator voices.** Whether *this* houseguest says it *now* is an engine decision from: their personality (a guarded one rarely; an open, warm one more often), how much they trust the player (the same trust/closeness reads 0075 uses), and the moment (the topic is live — the player raised orientation, relationships or secrets in the scene, or the houseguest is already in a `confide` moment — and they are alone or with people they trust). It rides the existing disclosure decision (share / slip / hold) with `risk` set by the houseguest's own stakes, **not** a new rng consumer on the shared stream: a per-moment seeded side stream keyed on (game seed, `orientation-disclosure`, houseguest, week, phase), so the same seed reproduces the same answer and repeated presses in one beat get one answer.
3. **Asking is allowed; asking is not a key.** If the player asks and the houseguest holds, it stays private and the player is told **nothing** — no "they won't say", no tell that distinguishes "hold" from "nothing to tell". The narrator is given only `disclose: true` plus the fact when the engine says share; on hold it gets the same prompt as a houseguest with nothing to disclose.
4. **It is a recorded, witnessed "told by" event.** When it comes out, it is an ordinary player-witnessed event (a told-by pathway with the houseguest as the source, via `surfaceInformationTo`), so it is the player's own knowledge and Journal-visible. **No other route** carries a private orientation to the player or the admin. It is not a number and not a label on any panel; the player learns it as the houseguest's own words.
5. **Public orientations are unchanged.** (`out` houseguests, 0063.)
6. **No competition effect.** Hearing it moves no stat, no outcome, no seeded roll on the competition/vote stream. The relationship effect of being trusted with it (a small trust/bond bump on the houseguest → player edge, as 0075's confidences do) is the *only* consequence, and the secret is then the player's to keep or spend like any told secret (the 0092/0093 secret-power rules apply unchanged; exposing it is a betrayal).
7. **Played games only for the rollout** (keyed on `live.playedGame`, as the other disclosure routing): headless calibration sims never run it, so they stay byte-identical.

## Out of scope / open for Ryne

- Whether an NPC may volunteer it unprompted (a "coming out" scene the NPC initiates) or only when the player brings the topic up. Draft: **both**, the unprompted case far rarer and only above a higher trust bar.
- Whether the same pattern should cover other deeply private facts (health, family) — decided under ORW-253, not here.
- Tuning constants (trust bar, risk, side-stream weights) are placeholders for the build.

## Acceptance (scenarios in `0141-private-orientation-disclosure.feature`)

1. A trusted player who asks can learn it on some seeds, and the same seed reproduces it.
2. A houseguest who does not choose to tell never does, however the player asks.
3. A distrusting houseguest declines more often (monotone in trust).
4. The learned fact is a recorded told-by event with the houseguest as the source.
5. A unique-marker sweep proves nothing about a private orientation reaches the player or the admin outside that path (Vault sentinel).
6. It moves no competition outcome (seeded outcomes byte-identical with the feature on, headless).
