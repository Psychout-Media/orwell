# 0129 — The jury house (living with the evicted: perspectives, Q&A, and an informed vote)

> **Status:** 🏗️ **Partially built (2026-11-03): slices 1–4** (roster projection, jurors voiced from their own knowledge, the `askJuror` lever, the informed `juror-vote` card — slice 4 is an ASSUMED default pending Ryne) — see §9; jury gossip and the roundtable pending. Authored during the 0046 PO review (2026-07-13) (PO: "write
> the spec for this and build later again"). **Expands 0046** (player eviction & the juror's seat) and pairs
> with its **ceremonies-as-broadcast** knowledge model. Today an evicted player on the jury watches a paced,
> Vault-safe **broadcast** of the remaining weeks — *alone*. This spec adds the **jury house**: the other
> **jurors** (never the earlier, pre-jury evictees) are there too, and the player can hear the season **from their perspective**, **ask them
> questions**, get their read on who's left, and walk into the finale vote **informed** — the _Big Brother_
> "jury roundtable" that is where the vote is really decided.
> **Executable spec:** [`0129-the-jury-house.feature`](./0129-the-jury-house.feature)
> **Disambiguation:** "jury house" names two things. **This spec (0129) is the player-facing sequestered jury house** a juror-player would visit. The built hidden NPC↔NPC layer is [0100](./0100-jury-grudge-book.md) (`src/engine/juryHouse.ts`).
> **Sequestration (owner ruling 2026-11-03, PR #1957):** the jury house holds **only jurors**. The player can talk to jurors only if the player is a juror, and jurors mix only with other jurors. Pre-jury evictees go home and appear in no later jury-house or social event. **One exception:** the departing evictee's own eviction-night departure beat (their goodbye message, exit interview, or "leaves the house" line, where exactly one participant is already out and the rest are the still-playing house) is not excluded; `tests/support/jurySequesterScenario.ts` pins exactly that one-out-participant case. The engine's membership is "evicted from the jury-start point onward" (the last nine, capped), pinned by `tests/unit/jurySequester.test.ts`. The player-as-juror surface below is still unbuilt.

## 1. Summary

0046 made losing faithful: you take the juror's seat and watch the public ceremonies broadcast to the finale.
But it's a solo, passive fast-forward. In the show, the jury is a **place full of people** — every juror
(only the houseguests seated on the jury, never the early evictees), living together, comparing notes, nursing grudges, and arguing about who deserves
to win. 0129 turns the spectate phase into that: the player, as a juror, can **talk to the other jurors**,
**hear the game from each of their (biased, partial) points of view**, **ask them what they know and think**,
and get a rolling **update on the house** as each new evictee arrives — all of it feeding the read the player
carries into their 0037 finale vote. Losing stays engaging, and the vote stops being a cold menu pick.

## 2. What exists today (the gap this closes)

- **0046: solo broadcast.** The juror learns only the **public ceremony outcomes** (Vault-safe, 0002) and
  fast-forwards to the finale. Correct and leak-proof, but **the other jurors are invisible** — the player
  never talks to them, never hears their side, never feels the jury as a room.
- **0037: the vote arrives cold.** The player's finale juror vote is a validated pick with no deliberation
  behind it — none of the "the jury talked it out and turned on the frontrunner" drama the show is famous for.
- **The evictees already carry rich state** (their soul, their relationship to the player, and the recorded
  eviction **manner** — bitter / blindsided / respected, 0037/0014) that nothing surfaces once they're out.

## 3. Scope

**In:** a **jury-house social surface** available while the player holds `player.status === "jury"` (0046):

- **The jurors are present.** A Vault-free `juryHouse` projection lists the evicted houseguests currently in
  the jury and, per juror, **what they can legitimately talk about** — their own witness-bounded knowledge
  (everything they saw before *their* eviction) + the shared **broadcast** since (0046) + what other jurors
  have told them. **Never** the live house's hidden scheming or confessionals (they're sequestered).
- **Perspective.** Each juror tells the season **their way** — colored by their soul, their read on why they
  went home, and the **manner** of their eviction (a juror the player blindsided is prickly; one the player
  treated well is candid). Two jurors can hold **contradictory** beliefs about the same event (0002/0038 —
  belief, not truth).
- **Q&A (bidirectional).** The player can **ask a juror questions** — "what do you think of the frontrunner?",
  "who do you think wins?", "what really happened with that vote?" — and the narrator answers **in that
  juror's voice, grounded in that juror's actual knowledge + opinion**. Jurors also **approach the player**
  (a new arrival with fresh news, a juror lobbying for their pick).
- **House updates.** As each new evictee joins the jury, the room's collective picture **updates** — the new
  arrival brings the freshest (still pre-*their*-eviction) read plus the broadcast everyone shares.
- **An informed vote.** The deliberation is what the player carries into the **0037** finale juror vote — the
  vote is now the payoff of the roundtable, not a cold pick.

**Out:** the finale vote *mechanic* itself (0037 — unchanged; this feeds the player's read, it doesn't change
the validated seam); the broadcast knowledge model (0046 — reused, not replaced); NPC-juror **vote formation**
(the show's roundtable also moves *other* jurors' votes — that is **calibration-sensitive** and is called out
as an **optional flagged sub-scope / deferred follow-on** in §4, not the core of this feature); changing how
NPCs are evicted (0045).

## 4. Design

- **A Vault-free `juryHouse` projection.** While `player.status === "jury"`, `GameStateView` exposes the jury
  roster and, per juror, a **shareable-knowledge view** = that juror's `KnowledgeState` (already witness-bounded
  by 0002) filtered to what they'd actually say, plus their **stance toward the player** (relationship + the
  recorded eviction manner) and their **reads** (predictions/opinions computed from their knowledge + soul).
  **Structurally leak-proof:** because the source is each juror's own witness-bounded knowledge, a Vault
  sentinel from scheming that happened **after** that juror left can never appear — the same 0002 guarantee
  0046 relies on (extend the 0001 canary to the jury-house projection).
- **Perspective = engine-grounded, narrator-voiced (anti-sycophancy).** A juror's slant is **computed** — a
  bitter juror is bitter because the recorded manner says so; their prediction favors whoever their soul
  respects. The narrator **voices** that; it never invents a juror's opinion out of nothing. Contradiction
  between jurors is real (each reads from their own belief, 0002/0038), not scripted drama.
- **Conversation reuses the live social seam.** The player↔juror Q&A runs through the **same social-approach
  machinery** as in-house play (0036/0049) — scoped to the jury house — and is **player-witnessed** (not
  hidden). The narrator answers each question from the addressed juror's shareable-knowledge view. Model
  under-call is caught by the existing `_auto_record_scene` belt family, same as live play.
- **Pacing.** 0129 replaces 0046's *silent* fast-forward with an **interactive** spectate: the broadcast
  ceremonies still arrive on a bounded pace, but between them the player can mill the jury house and talk —
  the player owns when to move on to the finale (the same "lingering is play" principle, ADR 0003 / 0049).
- **Calibration.** The **core** (perspectives, Q&A, updates, the player's informed vote) is a **Vault-free
  projection + player-facing narration** that touches **no seeded state** — so it is **calibration-neutral by
  construction** (byte-identical seeded spine, like the 0125 projection). The **optional sub-scope** — letting
  the jury-house deliberation **nudge other jurors' finale votes** (a real BB roundtable effect) — *does* move
  the seeded finale, so it ships **default-off** behind `ORWELL_JURY_ROUNDTABLE` with a `juryReach`/finale
  re-check, or is deferred entirely. The core needs no flag.
- **Vault Wall.** Everything a juror can share is broadcast + their own pre-eviction memory + jury gossip — no
  live scheme, no confessional, no number crosses (canary-tested). The player's own jury-house talk has **no
  pathway back into the still-playing house** (the jurors are sequestered; nothing they say to the player
  reaches an active houseguest) — the mirror of the Diary-Room one-way rule.

## 5. Contracts (stack-agnostic)

```text
while player.status == "jury" (0046):
  GameStateView += juryHouse: {
    jurors: [ per juror: {
      shareableKnowledge,          // = juror's own KnowledgeState (0002 witness-bounded) + broadcast + jury gossip
      stanceTowardPlayer,          // relationship + recorded eviction MANNER (bitter/blindsided/respected)
      reads,                       // predictions/opinions computed from knowledge + soul (belief, can be wrong/contradict)
    } ]
  }                                // Vault-free; NEVER live scheming/confessional (sequestered) [0002/0001]
player asks a juror a question → narrator answers in that juror's voice, grounded in shareableKnowledge (0036/0049 seam)
new evictee joins → jury-house picture updates (their fresh pre-eviction read + shared broadcast)
the deliberation informs the player's 0037 finale juror vote (mechanic UNCHANGED)
core = projection + narration ⇒ calibration-neutral (no seeded mutation);
optional ORWELL_JURY_ROUNDTABLE (default off) = NPC-juror vote nudging (calibration-sensitive; juryReach re-check) — deferred
```

## 6. Definition of Done (when built)

> **Status (AMEND 2026-11-06):** slices 1–4 are built and unit-tested (roster with bearing, jurors voiced from their own knowledge, `askJuror`, the finale juror-vote card). **Not built:** jurors approaching the player, rolling updates as new evictees arrive, and broadcast of ceremony outcomes since eviction. Boxes stay unticked until each item is verified in a live game.

- [ ] **The jury is a room:** while a juror, the player sees the other jurors and can talk to any of them;
      jurors also approach the player.
- [ ] **Perspective is grounded + biased:** each juror tells the season from their own belief, colored by
      their soul + eviction manner; two jurors can contradict; the narrator voices it, the engine grounds it.
- [ ] **Q&A works:** the player asks a juror a question and gets an answer from **that juror's** knowledge +
      opinion (never another's, never the Vault).
- [ ] **Rolling updates:** each new evictee's arrival updates the jury-house picture.
- [ ] **Informed vote:** the deliberation feeds the player's 0037 finale vote (mechanic unchanged).
- [ ] **Vault-safe:** a planted sentinel from post-a-juror's-eviction scheming never reaches that juror or the
      player (extend the 0001 canary to the jury-house projection); jurors share only broadcast + own memory +
      jury gossip; no number crosses; the player's jury-house talk reaches no active houseguest.
- [ ] **Calibration-neutral core:** the seeded spine (juryReach/gradient/UAT/golden) is **byte-identical**
      (the core mutates no seeded state); any NPC-vote-nudging is behind default-off `ORWELL_JURY_ROUNDTABLE`.
- [ ] Seed-deterministic; name-agnostic (roles only — juror/evictee/finalist); restart mid-jury-house resumes
      (0030); `0129` added to `cucumber.cjs`; `npm test` green.

## 7. Dependencies & traceability

Expands **0046** (juror seat + the ceremonies-as-broadcast knowledge model — reused as the leak-proof spine)
and hands the enriched read to **0037** (the finale juror vote, unchanged). Reuses the **0002** witness model
(each juror's shareable knowledge is already witness-bounded), the **0036/0049** social-approach seam (the
Q&A), the recorded eviction **manner** (0037/0014), and **0038** belief/gossip (jurors hold biased,
contradictory reads). Under **0001** (Vault Wall) and **0030** (restart), framed by **0018/momentPrompts**.
The optional roundtable sub-scope touches the finale calibration (juryReach), hence its default-off flag.

## 8. Implementer-ready (Definition of Ready) — when scheduled

**Touch points (exact):**
- `src/ports/GameSession.ts` — add the Vault-free `juryHouse` shape to `GameStateView` (roster + per-juror
  `shareableKnowledge` / `stanceTowardPlayer` / `reads`); populated only while `player.status === "jury"`.
- `src/services/` (the `KnowledgeService`/`VisibleStateService` layer) — derive each juror's **shareable**
  view from their own witness-bounded `KnowledgeState` (0002) + the 0046 broadcast record + jury gossip;
  **never** the live hidden layer. Extend the 0001 Vault canary to this projection.
- `src/engine/momentPrompts.ts` — a `jury-house` `MOMENT_PROMPTS` fragment (the player mills the jury house,
  hears perspectives, asks questions) + a `momentForPhase` mapping; the narrator answers a question from the
  addressed juror's shareable view.
- `src/engine/liveSeason.ts` — while the player is a juror, run the **interactive** spectate (0046's bounded
  broadcast + jury-house social beats) instead of a silent fast-forward; a new evictee joining updates the
  roster; hand off to 0037 at the finale.
- FE: a jury-house social surface (reuse the live social-approach UI, scoped to jurors) + the Q&A path through
  the existing agent-tool social seam; the `_auto_record_scene` belt covers model under-call.
- **Optional (deferred, flagged):** `ORWELL_JURY_ROUNDTABLE` — jury-house deliberation nudges NPC jurors'
  finale votes; default-off, `juryReach`/finale re-check; byte-identical off.
- **Tests:** `tests/unit/juryHouse.test.ts` (roster, per-juror shareable-knowledge bounding, the Vault canary,
  contradiction-between-jurors, restart-resume) + `docs/features/0129-*.feature` → `cucumber.cjs`.

**Open decision (deferred to build time):** whether to ship the optional NPC-juror-vote roundtable effect at
all, or keep 0129 purely the player's *experience* (perspectives + Q&A + informed own-vote). Spec ships the
experience as the core; the vote-nudging is flagged and optional.

## 9. Build addendum (A-13, 2026-11-03) — sliced; what is built, what is held

Built on A-8's spectator machinery (0133). **Slice 1 — the roster projection (built):** `GameStateView.juryHouse`,
present only while the player holds a juror's seat (never for a self-evicted player, 0061): the OTHER jurors in the
order they joined, each `{id, name, evictedWeek, bearing}` where `bearing` (`warm | even | cool | sour`) is a categorical
read of the **recorded** jury-management manner toward the player (the eviction manner plus any broken-deal demerit; no number, no hidden lean). Read-only, so the
seeded spine is byte-identical (`tests/unit/juryHouse0129.test.ts`: whitelist keys, Vault sentinel, manner → bearing,
read-only determinism). The existing 0100 `juryHouse.ts` is the grudge book (a different concern) — unchanged.

**Slices 2–3 (built, 2026-11-03) — by SEAM REUSE, no new knowledge reader.** (2) While the player holds a juror's seat, `presentKnowledge` in the narration prompt lists the OTHER jurors, each under their own `npcVoice` scope (their own witnessed-or-told set, labelled under their name) — so a juror's fact appears in that juror's block only. (3) The model lever `askJuror({jurorId})` (jury seat only; null otherwise): the ENGINE gates the telling on the juror's recorded bearing (sour never, cool 40%, even 75%, warm always; seeded per juror/week/phase, so a repeat press in a beat decides the same), picks ONE fact from that juror's own set that the player does not already hold (never a Diary-Room-class fact), and the telling reaches the player only through the content-anchored `told-by:<juror>` pathway (`setOnJurorTell` in the composition root looks the fact up in the JUROR's knowledge — a fact they do not hold cannot be surfaced). It folds nothing into the live house and moves no relationship. The `jury` moment fragment and the glossary advertise it; the FE five-place wiring (`tool_schemas`, `agent_tools`, `orwell_engine.ask_juror`, `tool_execution`, `do_ask_juror`, beat label, admin TOOL_META, mutating-manifest) ships in the same change. Gate: `tests/unit/juryHouseVoice0129.test.ts` (no cross-juror bleed; sour stonewalls; no re-tell; MCP boundary; canary — a Vault sentinel and a LIVE houseguest's private knowledge never reach the block, the telling or the state).

**Slice 4 (built, 2026-11-03; ASSUMED, pending Ryne) — the informed `juror-vote` card.** `PendingDecisionView.jurorBrief` (juror-vote only) lists, per finalist, what fellow jurors TOLD the player — the player's own `told-by:<juror>` knowledge, matched to the finalist by subject or name, capped at 4, humanized; absent when nothing was told (the card is then byte-identical). It carries no lean, no number and nothing a juror merely holds. The FE card renders it as a small "What the jurors told you" block (`textContent` only). Gate: `tests/unit/jurorVoteCard0129.test.ts` (3 tests, mutation-checked). Design call for Ryne: whether the card should also show jurors' *regard* (bearing) — default no, it would read as a vote lean.

**Slices still to come (same feature, each its own PR):** jury gossip / the broadcast reaching jurors' own sets (today a juror's set stops growing at eviction). The roundtable (NPC vote nudging) stays deferred behind `ORWELL_JURY_ROUNDTABLE`
(default off).

**HELD for Ryne (not built, default chosen):** whether a juror-player may skip/watch through the jury house or leave it
early. Default per his rulings: jurors are sequestered through the finale; there is no skip/watch for jurors.

