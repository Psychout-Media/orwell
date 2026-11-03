# 0046 — Player eviction & the juror's seat

> **Status:** ✅ **Built & green** (queue **B48**; in `cucumber.cjs`). The game's **most common ending** now
> has a spec and an implementation. The live projection marks the player out — `GameStateView.player.status`
> is `active` → `jury` (evicted into the last-9 jury: spectate the public ceremonies + vote at the finale) or
> `evicted` (pre-jury: season over) — and `momentForPhase` switches to the jury/closure framing. The **juror
> knowledge model** is **ceremonies-as-broadcast** (the recommendation below, made canonical): a sequestered
> juror keeps witnessing the **public** ceremony beats (non-hidden house-events) and **nothing** private —
> structurally enforced by the 0002 witness model (off-screen scenes + confessionals exclude the player), so a
> juror's knowledge contains only the broadcast facts. The season completes for **any** eviction index, and an
> evicted player on the jury still casts their own vote at the 0037 finale. The pre-jury **terminal recap**
> (rich season-end content) ties to **0048** and is out of scope here.
> **Executable spec:** [`0046-player-eviction-and-jury.feature`](./0046-player-eviction-and-jury.feature)
> **Tests:** `tests/unit/playerEviction.test.ts` (status/moment, completion, juror vote, broadcast-only
> knowledge, Vault canary) + the name-agnostic `.feature` (`features/step_definitions/player_eviction.steps.ts`).
>
> **Amended by 0133 (pre-jury path).** A pre-jury evictee's path now ends with the goodbye / exit interview (0130), then the
> `spectator-choice` card (skip to the finale reveal, or watch the skeleton season), then the finale-night interview. Pre-jury evictees go
> home: they appear in no later house, jury-house or social event (#1957) — the ONLY exceptions are the spectator-choice card and the finale-night
> interview (0133), which are the player's own seat at the finale, not house events; the sequestered jury house is a juror-only space (0129).

## 1. Summary

A houseguest wins ~1/16 of the time; **the player usually gets evicted.** Right now that ending is
undefined: the loop keeps running, but the player's projection still shows them "active," there's no jury
membership, and 0014's prose ("jurors observe the remainder") is **incompatible** with the 0002 witness
model. 0046 makes losing a first-class, faithful experience: you're voted out, you either go home (pre-jury)
or take the **juror's seat**, you watch a paced, **Vault-safe** version of the rest of the season, and you
cast your finale vote (0037). Losing should feel like _Big Brother_, not a dead end.

## 2. What exists today (the gap this closes)

- **The projection never marks the player out.** `GameSessionAdapter` renders the player's card as active
  regardless of eviction; `GameStateView` has no `status` for the player.
- **No juror knowledge model.** 0014 says "jurors observe the remainder," but 0002 says a houseguest knows
  only what they **witnessed or were told**. A sequestered juror witnesses nothing live — the two specs
  conflict, and nothing wires juror knowledge into `KnowledgeState`.
- **No jury/spectate framing.** `MOMENT_PROMPTS`/`momentForPhase` have no fragment for "you're out, watching"
  — so the narrator can't frame the spectator/jury experience.

## 3. Scope

**In:** a `player.status: "active" | "jury" | "evicted"` on `GameStateView`; the **pre-jury** path (a closure
beat + a terminal **season-end state**, ties to **0048**); the **jury** path — a **defined juror knowledge
model** wired into `KnowledgeState`, **bounded spectate/fast-forward pacing** to the finale, then the
existing **0037** finale interactivity (statement/answer/juror-vote); a `MOMENT_PROMPTS` fragment for
spectating/jury and a `momentForPhase` mapping.

**Out:** the endgame *structure* (0045 — F5→F2 legality); the eviction-night *staging* (0047); the
post-season unsealing/recap (0048 — but the pre-jury terminal state ties into it); changing how NPCs are
evicted.

## 4. Design

- **`player.status` projection.** The Vault-free `GameStateView` gains `status`. On the player's eviction the
  loop sets it: `"evicted"` (pre-jury) or `"jury"` (juror seat); `momentForPhase` selects a jury/spectate
  fragment so the narrator frames it.
- **Juror knowledge model (the crux — pick ONE, recommended below).** **Recommended: ceremonies-as-broadcast
  only.** A juror learns only the **public ceremony outcomes** after their eviction — who was HOH, the
  nominations, the veto outcome, who was evicted — modeled as **non-hidden** events the juror is added to the
  witness set of (or derived from the public ceremony record). They learn **nothing** of off-screen scheming
  or confessionals (those stay Vault-only, witness excludes the juror). This is canon (sequestered jurors see
  a curated broadcast), and it's **0002-compatible by construction** — replacing 0014's incompatible "observe
  the remainder." *(Alternative considered: "nothing + evictee gossip" as later jurors arrive — richer drift
  but noisier; rejected for the cleaner broadcast model.)*
- **Bounded spectating.** After eviction the player **fast-forwards** through the remaining weeks at a bounded
  pace (they watch outcomes, not play), arriving at the **finale**, where 0037's juror interactivity takes
  over (the player, as a juror, gives their vote).
- **Vault Wall.** Everything the evicted player/juror sees is **public broadcast** — no hidden scheme, no
  number, no confessional (extend the 0001 canary to the post-eviction + juror projections).

## 5. Contracts (stack-agnostic)

```
GameStateView += status: "active" | "jury" | "evicted"        // Vault-free
on player eviction: pre-jury → terminal season-end state (0048);  jury → juror seat
juror knowledge: ceremonies-as-broadcast — juror added to the witness set of PUBLIC ceremony events only
                 (off-screen scheming + confessionals stay Vault-only, witness excludes the juror) [0002]
spectate: bounded fast-forward to the finale → 0037 juror interactivity (statement/answer/juror-vote)
MOMENT_PROMPTS += jury/spectate fragment; momentForPhase maps the out-of-game phase to it
```

## 6. Definition of Done

- [x] **Any eviction index completes:** a seeded season where the player is evicted at week N (pre-jury or
      jury) runs to a defined end — the loop reaches Final 2 + crowns a winner; a juror → finale vote.
- [x] **Juror knowledge is provably Vault-safe:** a juror's witnessed events contain **only** the
      defined-pathway (public ceremony broadcast) facts — **no** off-screen scheme or confessional (a planted
      Vault sentinel never reaches the juror); 0002 holds.
- [x] **The projection marks the player out:** `player.status` flips to `evicted`/`jury`, and the projection
      switches the moment to the jury/closure framing.
- [x] **Vault Wall holds throughout** the spectate + jury experience; the out-of-game status resumes after a
      restart (0030).
- [x] 0014/0037 scenarios stay green; name-agnostic (roles only — evictee/juror/finalist); `0046` added to
      `cucumber.cjs`; `npm test` green.

## 7. Dependencies & traceability

Resolves the 0014 vs **0002** conflict with a Vault-safe juror knowledge model; extends the live loop
(0011/0034) and the player projection (0020), framed by 0018, handing off to **0037** at the finale; the
pre-jury terminal state ties to **0048**; under **0001** (Vault Wall) and **0030** (restart). Builds on
**0045** (a legal endgame to be evicted within).

## 8. Implementer-ready (Definition of Ready)

**Touch points (exact):**
- `src/ports/GameSession.ts` `GameStateView` — add `status: "active" | "jury" | "evicted"`;
  `GameSessionAdapter` `view()` (the projection that today always renders active) sets it from the live state.
- Juror knowledge: wire into the `KnowledgeService`/`KnowledgeState` — on the player's eviction, add the juror
  to the witness set of subsequent **public ceremony** events (non-hidden), so `deriveNpcKnowledge`/the player
  projection yields broadcast-only facts (reuse 0002's witness model; no new pathway type needed).
- `src/engine/momentPrompts.ts` — add a `jury`/`spectate` `MOMENT_PROMPTS` fragment + a `momentForPhase`
  mapping for the out-of-game phase.
- `src/engine/liveSeason.ts` — on player eviction, branch to pre-jury terminal vs juror seat; bounded
  fast-forward to the finale (hand off to 0037).

**Build order / deps:** best after **0045** (legal endgame). 0037 (finale juror interactivity) + 0002 +
0030 are built. **Test targets:** `tests/unit/playerEviction.test.ts` + `docs/features/0046-*.feature` →
`cucumber.cjs`. Assert §6 (esp. the juror-knowledge canary).
**Open decision (made):** juror knowledge = **ceremonies-as-broadcast only** (canon + 0002-safe). If the
product owner prefers the "evictee-gossip" variant, swap the witness-derivation; the tests are agnostic to
which, asserting only that no hidden scheme/confessional reaches a juror.
