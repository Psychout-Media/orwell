# 0130 — Exit interviews (the producer's eviction-night sit-down)

> **Status:** ✅ **Built & green** (2026-07-13; BDD-gated in `cucumber.cjs`). **Expands 0047** (eviction night
> live). Every staged eviction ends with the show's signature beat: the evicted houseguest sits down with the
> **producers** and is interviewed on the way out — they see their **goodbye messages**, react in the moment,
> and tell their side. Fires on **every staged eviction**, is a real **agency beat when the *player* is
> evicted** (a pending decision — their own words), and is **carried into the 0048 season-end retrospective**.
> **Calibration-neutral** (no flag): the beat draws no rng and mutates no seeded state (the NPC stance is a
> read of the already-fixed manner; the record feeds only the retrospective), so the seeded spine is
> byte-identical — proven against a pre-feature eviction-order baseline + `juryReach` re-run green.
> **Built in** `liveSeason.ts` (`EvictionStage` `exit-interview`, `ExitStance`/`npcExitStance`, the stage +
> the player pending), `GameSession.ts` (the `exit-interview` pending/submit + `RetrospectiveView.exitInterviews`),
> `GameSessionAdapter.ts` (projection + retrospective reel), `momentPrompts.ts` (the narration fragment), and the
> FE decision card `frontend/static/js/orwellDecision.js` (the player's own posture + optional words, mirroring the
> E34 goodbye-message card) + the `🎤` beat chip in `orwellToolBeats.js`.
> **Tests:** `tests/unit/exitInterview.test.ts` + BDD `0130-exit-interviews.feature` (`exit_interview.steps.ts`)
> + FE `frontend/tests/test_m3_4_decision_faces.py` (buildPayload byte-parity for the new kind).
> **Executable spec:** [`0130-exit-interviews.feature`](./0130-exit-interviews.feature)
> **Also proven by:** `tests/unit/exitInterview.test.ts`
> **Post-goodbye chain (#1945):** after the player's goodbye the engine owes `exit-interview → eviction result`. The front-end now advances through that whole chain in one bounded loop (at most 6 steps, each compare-and-swapped on the prior `beatSeq` with its own idempotency key; it stops when the result beat lands, the eviction view is gone, a pending decision appears, or the season finishes), shared by the HTTP and WebSocket decision paths. Before this it fired a single advance and eviction night stalled at the exit interview. Pinned by `tests/unit/postGoodbyeBeatChain.test.ts` + `frontend/tests/test_0130_post_goodbye_advance.py`.

## 1. Summary

0047 stages eviction night — the vote reveal, the exit, and the **goodbye messages** the house records for the
evictee. But the evictee never gets to *speak*: the house talks to them, then they're gone. In the show, the
evictee's exit is a **producer interview** — they watch their goodbye messages, react (vindicated, blindsided,
bitter, gracious), and answer the producers' pointed questions about what just happened. 0130 adds that beat:
after every eviction, the producers sit the evictee down. For an **NPC** it's narration whose posture is grounded in the recorded manner of their eviction
and how they went out; for the **player** it's an interactive moment — a real say at their lowest point. The
exit interview is recorded and **resurfaces in the 0048 retrospective**, so a season closes with every
houseguest's own account of their exit.

## 2. What exists today (the gap this closes)

- **0047: the house speaks, the evictee doesn't.** Eviction night stages the reveal + goodbye messages (tone →
  manner → jury lean), but there is **no beat for the evictee's own reaction** — they're recorded as gone.
- **Goodbye messages land with no response.** The evictee's goodbye messages (0047) are recorded and folded,
  but the evictee never **sees or reacts** to them — the show's most-charged moment ("they said *what*?").
- **The player's eviction is a dead end for their voice.** 0046 marks the player out; nothing lets the player
  *say* anything on the way out. Losing should still have a mic.
- **0048 has no per-houseguest exit account.** The retrospective unseals the season, but no houseguest's own
  in-the-moment "here's what happened to me" is captured.

## 3. Scope

**In:** an **exit-interview beat** appended to **0047**'s goodbye stage, firing on **every** eviction:

- **The producer interviews the evictee.** Using the existing diegetic producer/Diary-Room voice, the evictee
  is asked pointed, beat-grounded questions ("What happened? Who blindsided you? Any regrets?") and **shown
  their goodbye messages** (0047), reacting to them.
- **NPC evictee → narration.** The evictee's **posture** (`npcExitStance`) is **derived from the recorded
  eviction manner** (betrayed/disrespected ⇒ bitter, blindsided ⇒ defiant, respected ⇒ gracious, 0037 §4.2) —
  a blindsided houseguest is stunned, a respected one gracious. Engine-grounded (the stance is a read of the
  manner flags, no soul lookup); the narrator then voices it in the houseguest's own persona (anti-sycophancy).
- **Player evictee → an interactive agency beat.** When the **player** is evicted, the exit interview is a
  real **pending decision** through the 0034 seam (mirroring the player's own goodbye-message authoring, 0047
  E34): the producer asks; the player answers in their own words / chosen tone; the engine never speaks for
  them.
- **Feeds the retrospective.** Each exit interview is recorded as an event and **resurfaces in the 0048
  season-end retrospective** — the season closes with every houseguest's own account of going out.

**Out:** the eviction *reveal* + goodbye messages (0047 — reused; the exit interview *follows* the goodbye
stage); the *who-is-evicted* decision (0011/0045); the jury house (0129 — distinct: the exit interview is the
**moment-of-eviction** producer sit-down; 0129 is the **weeks after**, living with the other jurors); the
retrospective mechanic itself (0048 — this adds content to it, doesn't rebuild it).

## 4. Design

- **A beat after the goodbye stage.** 0047's `EvictionProgress` gains a terminal `exit-interview` stage after
  `goodbye`: the goodbye messages are surfaced **to the evictee**, then the producer's questions. For an NPC,
  the beat resolves as narration; for the player, it **pauses** for the player's answer (a pending decision),
  then resolves — the same shape as the player's own goodbye message.
- **Grounded, not invented (anti-sycophancy).** An NPC's exit-interview **stance** is computed from the recorded
  eviction **manner** flags (`npcExitStance`, no soul lookup); the narrator voices that stance in the houseguest's
  persona, bounded to what they legitimately know (0002) — a houseguest blindsided by an ally they trusted reacts to
  *that*, read through their own belief. The narrator voices it; it is never sycophantic or free-authored.
- **The player's mic.** The player's exit interview is theirs — tone and content their choice (validated
  through 0034). It has **no in-game pathway to any active houseguest** (the evictee is out; like the Diary
  Room, it informs framing/retrospective, never NPC behavior). Player-witnessed, OOC-adjacent.
- **Goodbye-message reaction (the correction, PO 2026-07-13).** The evictee **does** see their goodbye
  messages as part of the exit — a battle-back returnee (0025) therefore comes back **having seen who buried
  them**, a real grudge source, not a leak (the messages were always addressed to the evictee → witnessed, not
  Vault). The exit interview is where that reaction is voiced.
- **Retrospective tie-in.** Each recorded exit interview is a first-person exit account the **0048**
  retrospective replays alongside the unsealed ballots — the season's exits told in the evictees' own words.
- **Calibration-neutral.** The exit interview is **expressive/retrospective**, mutating **no seeded state**
  (manner is already fixed by 0047; the interview reacts, it does not re-weight the game) — so the seeded spine
  (juryReach/gradient/UAT/golden) is **byte-identical**. No flag needed for the core.
- **Vault Wall.** The evictee speaks only to what they know (0002) + their own goodbye messages (witnessed);
  no hidden scheme/number crosses (extend the 0001 canary to the exit-interview beat/projection).

## 5. Contracts (stack-agnostic)

```text
0047 EvictionProgress += terminal stage "exit-interview" (after "goodbye"), fires EVERY eviction
  NPC evictee:    narrated exit interview, grounded in soul + manner (0037 §4.2) + own knowledge (0002)
  player evictee: a pending decision (0034 seam) — the producer asks, the player answers (tone/content theirs)
evictee is shown their goodbye messages (0047) and reacts (a returnee via 0025 keeps that memory)
recorded as an event → resurfaced in the 0048 retrospective (first-person exit accounts)
calibration: mutates no seeded state ⇒ byte-identical spine (no flag); Vault-free (0001/0002); persisted (0030)
```

## 6. Definition of Done (when built)

- [ ] **Fires every eviction:** every evictee (NPC or player) gets an exit-interview beat after the goodbye
      stage.
- [ ] **Sees + reacts to goodbye messages:** the evictee is shown their 0047 goodbye messages and reacts.
- [ ] **NPC grounded / player interactive:** an NPC's exit interview is engine-grounded narration (soul +
      manner + own knowledge); the **player's** is a real pending decision (0034) — the player's own words,
      the engine never speaks for them.
- [ ] **Retrospective tie-in:** each exit interview is recorded and resurfaces in the 0048 retrospective.
- [ ] **Vault-safe + calibration-neutral:** the evictee speaks only to what they know + their own goodbye
      messages; no hidden state/number crosses (canary extended); the seeded spine is **byte-identical**
      (no seeded mutation).
- [ ] Seed-deterministic; name-agnostic (roles only — evictee/producer/juror); restart mid-interview resumes
      (0030); `0130` added to `cucumber.cjs`; `npm test` green.

## 7. Dependencies & traceability

Expands **0047** (eviction night — the exit interview follows its goodbye stage and reuses its recorded
goodbye messages + **manner**, 0037 §4.2), gives the **player-evicted** path (0046) a voice, composes with
**0025** battle-back (a returnee keeps their exit memory), and **feeds 0048** (the retrospective — first-person
exit accounts). Reuses the diegetic producer/Diary-Room voice (0013), the **0034** pending-decision seam (for
the player), the **0002** witness model, under **0001** (Vault Wall) and **0030** (restart). Distinct from
**0129** (the jury house = the weeks after; this = the moment of exit).

## 8. Implementer-ready (Definition of Ready) — when scheduled

**Touch points (exact):**
- `src/engine/liveSeason.ts` — extend `EvictionProgress` with a terminal `exit-interview` stage after
  `goodbye`; surface the goodbye messages to the evictee; NPC → narrated beat, player → pause for a pending.
- `src/ports/GameSession.ts` — a `exit-interview` `PendingDecisionView`/`SubmitDecisionReq` kind for the
  **player-evicted** case (free-text/tone, mirroring the player goodbye-message decision, E34); the Vault-free
  exit-interview projection on `EvictionView`/`AdvanceView`.
- `src/engine/momentPrompts.ts` — an `exit-interview` `MOMENT_PROMPTS` fragment (the producer's questions;
  the evictee reacting to their goodbye messages) grounded in soul + manner.
- `src/engine/…` (retrospective, 0048) — record each exit interview as an event the retrospective replays.
- Extend the **0001** sentinel canary to the exit-interview beat/projection.
- **Tests:** `tests/unit/exitInterview.test.ts` (fires every eviction, NPC-grounded vs player-pending, goodbye
  reaction, retrospective tie-in, Vault canary, byte-identical seeded spine, restart-resume) +
  `docs/features/0130-*.feature` → `cucumber.cjs`.

**No open decisions** (PO-set 2026-07-13): fires **every** eviction; the player's is a real pending decision;
recorded into the **0048** retrospective; calibration-neutral (no flag). Open only at build time: the exact
producer question set per manner (bitter/blindsided/respected).
