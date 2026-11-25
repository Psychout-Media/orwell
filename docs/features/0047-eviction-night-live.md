# 0047 — Eviction night live (reveal + goodbye messages)

> **Status:** ✅ **Built & green** (queue **B49**; in `cucumber.cjs`). The weekly eviction — _Big Brother_'s
> **defining beat, ~13×/season** — was **one line**; it is now staged through the **0034 seam** like the
> finale (0037): an **ordered vote reveal** (a seeded order, **all ballots in ONE advance** since the 2026-11-04 PO ruling; anonymized, never a pre-reveal winner)
> via a `EvictionProgress` sub-state machine, an **evictee goodbye** beat, and **goodbye messages** from a
> seeded selection of houseguests — recorded as events whose **relationship-derived tone** folds into the
> evictee's **manner** (0037 §4.2) and thus their **jury lean** (0014). The reveal order is engine-decided +
> seeded; the week-roll waits until after the goodbyes; the `EvictionView` projection on `AdvanceView` is
> Vault-free (names + the votes read so far only). Adds **no new pending decision kind** (the player's
> eviction vote / tie-break are unchanged) — so no front-end relay mirror is needed.
> **Executable spec:** [`0047-eviction-night-live.feature`](./0047-eviction-night-live.feature)
> **Since built:** (1) **0130** added an `exit-interview` stage, so the order is now `votes → goodbye → exit-interview → result`, and for a player evictee that stage IS a pending decision (the "no new pending decision kind" line above describes the original build). (2) **Owner ruling 2026-11-01 (#1912): eviction night takes about two in-game hours in total**, not a flat +3h per step. The first presentation step charges the ~2h budget (`eventBeatHours`, `eventSpanHours("eviction")`) and every later step (reveal batches, goodbye, exit interview, result) costs 0; the spend is tracked on `live.eventClock`, so it survives a save or restart.
> **BDD audit AMEND (2026-11-03):** the player-goodbye and warm-vs-cold scenarios now run on the **live adapter** (real seeded games, the engine's own `goodbye-message` pending, the registry snapshot/restore door) instead of hand-built pure seasons; four new live scenarios prove (1) after the player's goodbye the night owes the exit interview and then the result, bounded and never stalling at the interview (the FE route chain stays proven in `frontend/tests/test_0130_post_goodbye_advance.py`), and (2) a deal broken by a **secret ballot** shares the betrayal shock across everyone who voted to evict the wronged party and records no jury demerit naming the breaker, while a public (nomination) break and a break against the player keep the full attributed fold (#1963 / #1976 / #1987; formerly `tests/unit/sealedBallotLeak1963.test.ts` only). A warm vs a cold goodbye is compared as two same-seed live games; the lean is read from the live state and never shown to the player.
> **Tests:** `tests/unit/evictionNight.test.ts` (reveal mechanics, determinism, goodbye→lean, restart,
> Vault-free `EvictionView`) + the name-agnostic `.feature` (`features/step_definitions/eviction_night.steps.ts`).

## 1. Summary

Eviction night is the show's heartbeat: the ballots read out in order, the tension of a building tally, the
evicted houseguest's exit, and the goodbye messages that reveal who really had their back. Today the engine
resolves all of that into a single recorded line. 0047 gives the eviction the same live, staged treatment
the finale already has — a dramatic, Vault-safe sub-loop — and makes the **goodbye** matter: a warm send-off
vs. a cold one **measurably** shifts how that evictee (now a juror) later votes. It reuses 0037's proven
pattern (a staged view on `AdvanceView`, advanced through the decision seam).

## 2. What exists today (the gap this closes)

- **One-line eviction.** `liveSeason.ts` resolves the eviction vote and records a single event — no reveal
  order, no goodbye, no goodbye messages.
- **The finale is staged, the eviction isn't.** 0037 built `FinaleView` + the staged statements → questions →
  ordered vote reveal through the 0034 seam; the weekly eviction (far more frequent) got none of it.
- **Goodbye messages don't exist.** A core jury-management lever — how you treat someone on the way out — has
  no live representation feeding **manner**/**jury lean**.

## 3. Scope

**In:** stage the eviction through the **0034 seam** as a sub-loop (mirroring 0037): an **`EvictionView`** on
`AdvanceView` (`{ stage, nominees, votesRevealed[] }`) advanced beat-by-beat; an **ordered vote
reveal** (ALL ballots in one advance — PO ruling 2026-11-04; the outcome lands on the very next beat; HOH tie-break as
today); an **evictee goodbye** beat; **goodbye messages** from selected houseguests recorded as events that
feed eviction **manner** (0037 §4.2) + **jury lean** (0014). Reveal order **engine-decided + seeded**
(principle #1). Vault-safe; persisted (0030).

**Out:** the *who-is-evicted* decision (0011/0034/0045 — unchanged; this stages the **reveal** of an
already-decided vote); the finale (0037 — reused as the pattern, not re-built); the player-evicted experience
(0046 — but a player evicted here gets the goodbye beat).

## 4. Design

- **Staged sub-loop (reuse 0037's shape).** While an eviction is resolving, `advanceGame` returns an
  `EvictionView` with the current `stage` (`votes | goodbye | exit-interview | result`; the exit-interview stage was added by 0130) and the **reveals so far** — exactly
  as `FinaleView` does for the finale. **PO ruling (Ryne, 2026-11-04): the reveal is ALL IN ONE TURN** — the single reveal advance reads **every** anonymized ballot (the narrator reads them all in one suspenseful message), and the **result is the very next beat** (the FE pre-resolve walks reveal → result in the same pass). It never happens before the player's `eviction-vote` card is confirmed, and an NPC-only night reveals in one turn once the ceremony starts. Supersedes the 2026-06-27 batched rounds. Presentation only, no randomness; the `EvictionView` gains an optional `evictee` once the result beat has landed (absent before). The voter is never named.
- **Ordered reveal, no leak.** Ballots are revealed **in a seeded order, all in one advance** (each ballot still read individually, in order); the projection carries
  **only the revealed ballots (anonymized)** — never a pre-reveal count of unread votes, never the evictee before the last
  vote lands. The engine already decided the tally (0034); 0047 only choreographs the **reveal**.
- **Goodbye + goodbye messages.** Once the last ballot is read and the tally decides the evictee (the stage order is `votes → goodbye → exit-interview → result`, where `result` is the terminal stage), an **evictee goodbye** beat; then **goodbye messages**
  from a seeded selection of houseguests, each recorded as an event with a **tone** (warm/cold/respectful)
  that folds into the evictee's **eviction manner** (0037 §4.2) and thus their later **jury lean** (0014).
- **Vault Wall / anti-sycophancy.** Reveal order + tally are engine-decided and seeded; goodbye tone is
  derived from real relationship state, not narration. No pre-reveal tally or hidden number crosses the wall
  (extend the 0001 canary to the `EvictionView`).

## 5. Contracts (stack-agnostic)

```
AdvanceView += eviction?: EvictionView | null            // present only while an eviction stages
EvictionView: { stage: "votes"|"goodbye"|"exit-interview"|"result", nominees: NamedRef[], votesRevealed: { votedFor: NamedRef }[] }   // anonymized secret ballots: the nominee each ballot names, NEVER the voter
reveal: ALL ballots in ONE advance, seeded order, anonymized; the outcome lands on the very next beat (HOH tie-break) — PO ruling 2026-11-04
goodbye: an evictee goodbye beat + goodbye messages (tone) → eviction manner (0037 §4.2) → jury lean (0014)
invariants: engine-decided + seeded reveal; no pre-reveal tally/leak (0001); persisted (0030)
```

## 6. Definition of Done

- [x] **Staged reveal (amended 2026-11-04, PO ruling: all in ONE advance, the result the next beat):** an eviction reveals every ballot in a **seed-deterministic** order, with
      a revealed-only tally; the evictee is not knowable before the last vote.
- [x] **No leak:** no pre-reveal tally or hidden vote appears on the `EvictionView` / advance surface (a
      planted Vault sentinel never crosses; the projection carries only the votes read so far).
- [x] **Goodbye matters:** a **respectful** vs. a **cold** goodbye **measurably** moves the evictee's later
      **juror lean** (seeded source) via recorded manner (0037 §4.2 / 0014).
- [x] **Through the seam:** the staging advances via the 0034 `advanceGame` seam (like 0037); restart
      mid-reveal resumes to the same engine-decided result (0030).
- [x] 0034/0037/0014 scenarios stay green; name-agnostic (roles only — HOH/nominee/evictee/voter/juror);
      `0047` added to `cucumber.cjs`; `npm test` green.

## 7. Dependencies & traceability

Extends the **0034** decision/advance seam with an eviction sub-loop, reusing **0037**'s staged-reveal
pattern + its **eviction-manner** (§4.2), feeding **0014** jury lean, under **0001** (Vault Wall) and
**0030** (restart). Sibling to **0045** (the endgame the eviction runs within) and **0046** (a player evicted
here gets the goodbye beat).

## 8. Implementer-ready (Definition of Ready)

**Touch points (exact):**
- `src/engine/liveSeason.ts` — the one-line eviction site (~L403): turn it into a staged sub-loop (a
  `FinaleProgress`-style `EvictionProgress` with `stage` + a seeded reveal order); add the goodbye + goodbye-
  message beats; fold tone into manner via `jury.ts` `mannerToward`.
- `src/ports/GameSession.ts` — add `EvictionView` + `AdvanceView.eviction?`; `GameSessionAdapter` projects it
  (Vault-free; mirror the existing `finaleView()` projection).
- Goodbye-message tone reads the relationship model; recorded as events (the existing event sink).
- Extend the **0001** sentinel canary to the `EvictionView` projection (no pre-reveal tally).

**Build order / deps:** 0037 (the staged-reveal pattern + manner) + 0034 + 0014 are built — this mirrors
them for the weekly eviction. **Test targets:** `tests/unit/evictionNight.test.ts` +
`docs/features/0047-*.feature` → `cucumber.cjs`. Assert §6 (esp. seeded reveal order, no pre-reveal leak, and
the warm-vs-cold goodbye → jury-lean delta).
**No open decisions.** Reveal ALL ballots in one advance (PO ruling 2026-11-04), seeded order, anonymized — the result is the next beat.

## Amendment 2026-11-20 (ORW-738, Season 2 week 3 playtest: "the eviction vote ran with no narration")

Diagnosis only, no behaviour change. A played eviction night pressed through with the Continue button reads as silent: the button is not a chat turn (ORW-703), so each press shows
only the engine's public chyron line (`a vote to evict X.`, then `X has been evicted from the house.`) and no prose. The clock cost is the eviction night's ~2 in-game hour budget
spread over its first five steps (ORW-262, `EVENT_SPREAD_STEPS`), 24 minutes a press and nothing after, plus 5 minutes for each typed message around the vote: 2h + 2 x 5 min is the
4:00 -> 6:10pm the playtest saw. `tests/unit/orw738EvictionVoteClock.test.ts` pins the spread, the non-empty headline on every ballot and the result, and E12 (no voter named).
The blank line in the bubble on that build was the role-claim guard dropping a premature Production result line and leaving a lone quote; #3105 closed it and
`frontend/tests/test_orw738_blank_announcement_line.py` pins the transcript's shape.

## Amendment 2026-11-20 (ORW-771, owner-ruled: a Continue press through the eviction vote gets a short narrated beat)

The ORW-738 diagnosis left one question for the owner: should a press through the vote be silent (banner only)? Ruled: no. Each press is now voiced as a SHORT beat, sealed like the
real show: a voter walks into the Diary Room and comes back, with the room's mood around them, and no ballot content; the tally press says the tally is read with names, as the chyron
banner does. Design, in the smallest-correct form:
- **The engine hands facts** (`ORWELL_VOTE_BEAT`, default ON; `=0` restores the banner-only press byte for byte). `EvictionView.voteBeat` (`src/engine/voteBeat.ts`, rendered per turn by
  `renderVoteBeatBlock` in `momentPrompts.ts`, never the base prompt) carries `sealed: true`, the press number, who walks into the Diary Room and who comes back out, the houseguests
  gathered, the part of the day, the two nominees (public), and `tallyRead` on the result press. A pure read: no rng, no clock, no write.
- **E12 holds.** The walk order is a hash of the week and the voter's id and reads neither the seeded ballot reveal order nor any vote, so naming the walker of a press says nothing about
  the ballot read on that press. No ballot, voter's choice or count is in the fact; the player is never walked (the engine does not act for them).
- **The press stays a progress press, not a chat turn (ORW-703).** The chyron `announcements` remain the single source of the board fact. When the press response carries
  `eviction.voteBeat`, the page sends ONE hidden production cue (`sendHiddenCue`; hidden on every device by the cue envelope) and the narrator voices the beat on the ordinary stream, so the
  second window gets the bubble through the same mirror. The server arms the cue on the press (`arm_vote_beat_cue`); an armed cue turn skips `noteMessage`, so it adds NO clock (the ORW-262
  budget of 5 presses at 24 minutes is unchanged; one message-step per player message), and a typed copy of the cue with no press is an ordinary 5-minute message. The cue is never a
  progress or readiness message, so it cannot advance the ceremony (ORW-297's typed `next` still advances exactly one step and gets its narration as before). A press made while a beat is
  still streaming sends no second cue (the banner still shows every press).
- Gates: `tests/unit/orw771VoteBeat.test.ts` (the fact on every ballot press, the tally press, E12 shape, flag off, no extra clock), `frontend/tests/test_orw771_vote_beat_cue.py`,
  and `test_orw771_vote_beat_card_browser.py`. Open (ORW-816): a real-stack test (real engine, real chat turn, second window) of a Continue press for a player on the block; the walk found no season
  that puts the player on the block in week 1 (150 seeds), so it is carded as ORW-816. A player who votes has no Continue card after their own vote card (the ballots then run on their next message), also ORW-816.

## Amendment 2026-11-23 (ORW-791: the player who voted gets the same Continue step)

The gap the ORW-771 note named is closed. Every ballot of a played, staged eviction leaves a ceremony WATCH step open (`pending` kind `ceremony-step`, step id `ballot`), including the first ballot
that the player's own vote card reads. A Continue press (a bare `advanceGame`) reads exactly one more ballot; the press past the last ballot decides the vote. A typed message that is not a
progress ask moves nothing (a real-stack run had shown one message after the vote drive nine ballots through the front end's one-turn reveal hops; that path is only reachable with no open step).
`advance` answers the ballot step with the next ballot (`liveSeason.ts`); the clock is unchanged (ORW-262, the same per-step spread). Gates: `tests/unit/orw791VoteContinue.test.ts` and the
real-stack `frontend/tests/test_orw791_vote_then_message.py`. A bare typed "next" at a ballot step still walks the ballots in one pass (the ORW-291 pacing ruling, `test_orw291p_ballot_pacing.py`).
