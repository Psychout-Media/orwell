# 0203 - Coming clean, nuanced (Theme 4, ORW-646)

Card: ORW-646 (Ryne approved 2026-11-17, Fable 4.3). Executable spec: `0203-coming-clean.feature` (wired: `features/step_definitions/coming_clean.steps.ts`). Foundation: `src/engine/comingClean.ts` + `tests/unit/comingClean.test.ts` (built, BDD Auditor). Build (Overseer A, 2026-11-18): the adapter acts (`confess`, `loopIn`), the daily NPC decision (`comingCleanTick`), the player's engine entry points (`playerConfess`, `playerLoopIn`), the flag, the snapshot superset rule. The player's door (Auditor ruling): two optional fields, `retracts` and `tellsAbout`, on the EXISTING scene-belt `statement` (no new tool); the engine finds the player's own open lie and drops a mismatch. Deferred: the post-crown retrospective door. Gates: `tests/unit/comingCleanBuild.test.ts`, the feature.

Ryne's words: "there's also this like mechanic or this pathway in which I tell one person one thing and that's a lie, and I tell an ally that I told them a lie. So you're almost coming clean to someone else... or maybe you're telling lies to both people and coming clean differently to others... that realm should be nuanced."

## The three moves
1. **Confess first.** A speaker tells the listener that a claim they told them was false, before it is caught.
   - It costs less than being caught: a trust drop of `COMING_CLEAN.confessShare` (0.35) times a caught lie's, and NO `lied-to-me` belief. An owned lie is not a caught one, so there's no credibility hit and no revenge goal.
   - The listener's planted belief is refuted.
2. **Loop an ally in.** A speaker tells an ally the truth about a lie told to someone else.
   - The ally's trust in the speaker rises (`loopInTrustGain`, by closeness).
   - The ally now holds "the speaker lied to X" as a fact (`heard-rumor`, nature `lying`, object X, at `loopInConfidence` 0.9). It can travel by the house's gossip; if it reaches X, X catches the lie the usual way (`catchLie`, full cost).
3. **Layered lies.** Different listeners get different versions, and different confessions. Every act names a claim id (`CleanAct`), so the engine knows who heard which version, who was told the truth, and who was looped in (`versionsAbout`).

## Who does it
- **NPCs, engine-decided.** At a decision point (suggested: the nightly fold, once per held lie), an NPC liar reads the catch risk from what THEY can see (`catchRisk`):
  - another version of the same lie reached someone close to the listener;
  - the listener doubts it (an open test);
  - the subject is close to the listener, so it may be checked.
  They then roll once on a keyed side stream against `confessChance(risk, candor)`. Looping in happens in a scene with an ally (an extra house-life speech act on the claims path), with the ally chosen by bond.
- **The player, in play.** Two levers, which are the build's call: `confessLie(npcId, ...)` and `tellAllyAboutLie(allyId, ...)`. The player says it in their own words; the scene belt proposes the act, and the engine re-validates it against the claim log (the claim must be the player's own, and a lie).
  - A lever the narrator prompt names needs the five-place FE wiring (CLAUDE.md, "the lever-drift trap").
  - NPCs also confess to the player and loop others in about lies told to the player.

## Engine seams for the build
- **Store:** `live.cleanActs?: CleanAct[]`, append-only and persisted (no thinning; the non-degradation check covers it like the claim log).
- **Adapter `confess(by, to, claimId)`:** check `confessable`; apply `confessionTrustDrop()` to to->by trust; refute the listener's belief planted by that claim (the claim's `plantedBy` link, ORW-591); append the act; record a scene event witnessed by both (the player is a witness when the player is either side).
- **Adapter `loopIn(by, ally, claimId)`:** the claim must be `by`'s own lie. Apply `loopInTrustGain(closeness)` to ally->by trust; write the ally's `heard-rumor` (`nature: "lying"`, object = the claim's listener, source = by, confidence `loopInConfidence`); append the act. Gossip carries it from there; catching runs the existing path.
- **NPC decision:** a nightly pass over each NPC's open lies (`liesBy` + `confessable`), using `catchRisk`, `confessChance` and a keyed roll. Played games only; headless byte-identical.
- **Retrospective (post-crown):** `versionsAbout` per liar and subject, words authored by the narrator from the claim kinds (no fixed glosses). Built (ORW-747): `comingClean.stories` (`buildComingCleanRetro`), only for liar and subject pairs with at least one confession or loop-in; `said` is the engine's existing claim wording (`claimText`). It renders in the retrospective window as plain sentences and is kept off the host model's context, like the rumor mill: a measured season held about 85 stories (about 100 KB), too much for the narrator's context. Gate: `tests/unit/retroLeftovers747.test.ts` + `tests/uat/realPathRetroLeftovers.test.ts` (heavy `real-path` leg).
- **Flag:** `ORWELL_COMING_CLEAN`, default ON.
- **Measure:** the mix, plus the stacking report if any decision term moves (trust changes feed the vote's threat and bond terms indirectly; no new term).

## The rules
- The player in both directions (above).
- No short lists: no player-facing words from a list, and the narrator voices confessions and loop-ins from the claim kinds.
- The wall: the ally learns a lie only by being told; nothing reaches the player except through a scene they're in.
- Never shown as numbers.
