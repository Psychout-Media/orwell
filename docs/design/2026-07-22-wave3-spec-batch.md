# Wave-3 spec batch — the round-2 moonshot short specs + the two v1-archaeology commissions

**Date:** 2026-07-22. **Status:** short specs per the owner's Q8 hybrid ruling (2026-07-21) — M/L-cost
ideas get a 1–2-page spec before build; S-cost/reversible ideas skip straight to flagged build (that
set — C1, B1, E2, F1 — is **not** in this batch). **Scope:** every item Part C's Wave 3 lists ("footage
+ the round-2 spec batch") plus the two OQ4-commissioned v1-archaeology beats, one section each.

**Sources.** `docs/audits/2026-07-21-campaign-report-and-exhaustive-backlog.md` Part B (T0–T9 contracts
+ DoR/AC/DoD shape) and Part C (the wave breakout) on `claude/backlog-dod-dor-ac`;
`docs/design/2026-07-21-moonshot-round2-divergent-slate.md` idea records + §5 owner rulings + §6
binding constraints on `claude/playtest-protocol-review-u4wxaz`; `CLAUDE.md` for architecture and hard
do-nots; `docs/legacy/meta-feedback/bb-day-2.md` (format-only — content never ingested as canon or seed
data, per the testing rules) for the two commissioned v1 voice references.

**Every spec below carries, per the task brief and the slate's §6 binding-constraint addendum:**
Player experience · Mechanism (respecting the hexagonal split + the four/five-place wiring rules) · the
binding constraints that apply (typed beliefs / bounded observers / deterministic grounding) · flag +
off ⇒ byte-identical + designated fallback + rollback condition (the T9 reversibility doctrine) · DoR /
AC / DoD naming test lanes · Cost (S/M/L). All flags below are **OFF by default** — nothing here ships
live without its own later live-demo approval, per Q8.

**Index.** 1. D1 Ballot Arithmetic · 2. A1 Fifteen Pairs of Eyes (+ Attention Ledger) · 3. C2 Odd-Couple
B-Plots · 4. E1 The Exit Package · 5. C3 Seeded Partial Reaction Pan · 6. A2 The Booth Has Receipts ·
7. C4 The Running Bit Ledger · 8. D2 Publicity-Priced Promises · 9. B2 The Walls Repeat You · 10. B3 The
Barium Meal · 11. C5 Cabin-Fever Ceremonies · 12. F2 Cold Cases + F4 Production Memory (without step 2)
· 13. The Producer Read (commissioned) · 14. The Player Dossier (commissioned).

**Sibling spec (Wave 2, not in this batch):** Q7 The Pacing Budget (#1787, resolves PO-1) ships as its
own file, same section format, spec #15 of this family — `docs/design/2026-07-22-q7-pacing-budget.md`.

---

## 1. Ballot Arithmetic — D1

**Player experience.** After an eviction, houseguests start claiming how they voted — to your face, to
each other, sometimes to you about a third party. You know the public count. If four people separately
swear "I voted to keep her" and she only got two keep-votes, the arithmetic is a hard wall: at least two
of them are lying, and you can feel the house start doing the same math you just did. You can play this
game yourself — over-claim loyalty you didn't show, and risk getting caught by the same pigeonhole logic
you'd use on anyone else.

**Mechanism.**
- No new player-facing tool. Vote claims are ordinary speech: they enter through the existing,
  already-wired `recordInteraction` (`src/ports/EngineCommands.ts`) and its optional Vault-free
  `consequence` descriptor (ADR 0005 — model proposes shape, engine owns bounded magnitude). The
  descriptor grammar gains one new optional shape: `voteClaim: { evictionId, audience: EntityId[],
  claimedVote: EntityId, confidence? }`.
- On commit, the engine mints a typed claim fact using the SAME shape `KnowledgeService.BeliefInput`
  already uses for gossip (`content`, `confidence`, `source`, `subject` — `src/ports/KnowledgeService.ts`)
  — claimant = speaker, audience = witness set, provenance = the recording event id. It is an ordinary
  knowledge-layer fact, diffusible via existing 0038 gossip pathways (`transmitGossip`).
- NPC claim-policy (truth-or-lie) is Vault-side: it reads the NPC's true ballot + edges inside the
  existing eviction-commit fold in `GameSessionAdapter` (engine-only, already holds the Vault handle),
  extending the 0110 module rather than replacing it (`src/engine/voteDeduction.ts`).
- A new PURE domain module, `src/domain/ballotSolvency.ts`, runs the per-audience arithmetic: claims
  known to an audience member vs. the PUBLIC tally (already public — no Vault read needed for the
  contradiction itself). On an unsolvable claim set, it mints a Vault-free "the numbers don't add up"
  fact scoped to the audience that holds the contradicting claims, plus a bounded seeded suspicion fold
  across over-claiming candidates reusing 0110's ranking math, on its own forked sub-`RandomnessSource`
  stream (the C1 fork-after-resolution pattern — perturbs nothing downstream).
- Sealed ballot attribution never unseals; only speech + arithmetic circulate (E12 stays intact).
- **Four-place FE-write-back rule:** N/A — reuses the already-wired `recordInteraction`/consequence-
  descriptor pathway; no new tool, no new registry entry.

**Binding constraints applied.**
- **Typed beliefs, never bare facts** — the headline constraint. Every claim persists as a
  claimant/audience/confidence/provenance record; the solvency check and any diffusion run over CLAIMS,
  never promotes a lie to engine truth. `ballotSolvency.ts` reads only claims + the public tally, never
  the sealed true ballot.
- Deterministic grounding — the contradiction detection itself is pure arithmetic, not LLM judgment;
  the LLM only proposes claim *shape*, never decides whether it's a lie.

**Flag & reversibility (T9).**
- Flag: `ORWELL_BALLOT_CLAIMS` (default OFF).
- Off ⇒ byte-identical: `recordInteraction`'s consequence-descriptor parser ignores an absent
  `voteClaim` key exactly as it does today; no solvency pass runs; no suspicion fold fires.
- Designated fallback: today's terminal 0110 deduction (public count, sealed attribution, no player
  claims economy) stays exactly as built.
- Rollback condition: any drift on `tests/property/juryReach.property.test.ts` or the gradient
  calibration shards attributable to the new suspicion fold; or a boundary-test finding that sealed
  per-voter attribution ever becomes reconstructible from claims + solvency (an E12 regression).

**DoR / AC / DoD.**
- DoR: solvency schema decided; NPC claim-policy (truth vs. lie, motivated by soul/edges) decided as an
  extension of `voteDeduction.ts`'s existing ranking math; the forked sub-rng stream confirmed isolated
  from 0110's existing draws; confirmation the consequence-descriptor extension is additive/optional.
- AC: a typed `voteClaim` record is minted per claim with claimant/audience/confidence/provenance; the
  per-audience solvency check is deterministic given the same claims + public tally; an unsolvable claim
  set mints a scoped contradiction fact + a bounded seeded suspicion fold; sealed attribution never
  crosses into any minted fact (a boundary test); with the flag off, `recordInteraction` processing is
  byte-identical.
- DoD: test lanes — `npm run test:unit` (`ballotSolvency.ts` pure unit tests + the sub-rng isolation
  test), `tests/property/juryReach.property.test.ts` and the gradient shards re-run for calibration
  drift, a flag-off byte-identity check across `tests/uat/**`, full FE pytest suite if any claim-making
  UI affordance is added. `docs/decisions/0005` cross-referenced for the consequence-descriptor
  extension.

**Cost:** M (flagged optimistic per the slate's L2 note — NPC claim policy + per-audience solvency is
real engine work; may run toward L in practice).

---

## 2. Fifteen Pairs of Eyes (+ the Attention Ledger) — A1

**Player experience.** Skip the kitchen all morning, dodge the HOH room while working the rest of the
house — someone clocks it. "Marcus noticed you never came down" lands as an ordinary piece of house
gossip, not a system message. You start reading absence the way the house does: who wasn't where, who's
been avoiding whom since the nomination, who's paying close enough attention to have noticed you at all.
The counterplay is watching them back — you're never told who's watching, only that someone was.

**Mechanism.**
- A PURE derivation pass, `src/engine/attention.ts`, run at tick time over the EXISTING ground truth in
  `src/engine/presence.ts` (per-NPC room occupancy, adjacency-constrained movement) and the `EventStore`.
  It computes socially-loaded NON-events: absence from a high-occupancy room for a full phase, zero-
  contact streaks, visible movement traces.
- **Bounded observer sets — the headline constraint.** The eligible-observer set for each derived fact
  is computed FIRST, strictly from presence/adjacency/coverage (who was actually in-room, in-earshot, or
  on a route that crosses the absence) — BEFORE any seeded roll runs. Only THEN does a seeded,
  temperature-gated roll pick a subset of the eligible set as who actually noticed (never everyone — the
  paranoia is not knowing who). A fact never enters an observer's knowledge layer unless that observer
  was both eligible AND selected.
- Selected observers receive the fact as an ORDINARY witnessed fact (Vault-free by construction — anyone
  eligible could legitimately have observed it), feeding npcVoice/narrator context exactly like any other
  witnessed event.
- Merged from the Attention Ledger: a bounded, seeded avoidance-inference fold into hidden edges
  (sustained post-nomination avoidance reads as guilt/distance), reusing the existing magnitude caps in
  `relationshipConstants.ts` — no new fold mechanism, no raw number crosses. Plus a diegetic pre-decision
  "coverage stock-take" — a Vault-free context block (who you haven't connected with) rendered as
  always-on moment-prompt content (the I6 lesson: this is delivery texture, never an under-callable
  tool).
- No new outward port or tool. Delivered entirely through the existing knowledge-layer pathway + the
  always-on prompt context block.
- **Four-place FE-write-back rule:** N/A — pure engine derivation, no FE content produced or written
  back.

**Binding constraints applied.**
- **Bounded observer sets** (the batch's own headline example for this constraint) — the eligible set
  is computed from presence/adjacency/coverage strictly before the noticed-by roll; a boundary test must
  prove aggregate ground truth (the FULL absence pattern) never leaks to an observer outside the
  eligible+selected set.

**Flag & reversibility (T9).**
- Flag: `ORWELL_ATTENTION_LEDGER` (default OFF).
- Off ⇒ byte-identical: no derivation pass runs; zero new knowledge facts minted; zero new context
  block; the avoidance fold never fires.
- Designated fallback: today's status quo — presence stores stay silent ground truth with no read-out.
- Rollback condition: a boundary test finds any leak of an absence fact to an ineligible observer; or
  the avoidance fold is shown to drift `juryReach`/gradient calibration.

**DoR / AC / DoD.**
- DoR: eligible-observer derivation rule specified (room co-occupancy window, adjacency graph, 0049/0066
  wake state); the "who notices" temperature-gate parameters decided; the avoidance-fold bound confirmed
  to reuse existing `relationshipConstants` caps (no new cap); the stock-take context-block format
  decided as always-on, not a tool.
- AC: the eligible-observer set is computed strictly from presence/adjacency/coverage before any
  noticed-by roll (a boundary test proves this ordering); absence/movement facts reach only
  eligible+selected observers; the noticed-by roll never selects the full eligible set (a property
  test); the avoidance fold applies only bounded, capped impact; the coverage stock-take renders as
  always-on context; with the flag off, byte-identical turn processing.
- DoD: test lanes — `npm run test:unit` (`attention.ts` eligible-set derivation tests + the dedicated
  no-leak-to-ineligible-observer boundary test, a property test on noticed-by subset selection),
  `tests/property/juryReach.property.test.ts` + gradient shards re-run, a flag-off byte-identity check
  across `tests/uat/**`, full FE pytest suite for the always-on stock-take block (I6 compliance check).

**Cost:** M.

---

## 3. Odd-Couple B-Plots — C2

**Player experience.** Two houseguests whose relationship has been quietly souring, who the house keeps
throwing into the same room, become the season's petty feud — over dishes, snoring, a stolen protein
shaker. You never see a number; you see two adults holding an impromptu house meeting about a shaker,
and you get to decide whether you're watching for fun or working the crack for leverage.

**Mechanism.**
- Each tick, intersect souring-phase pairs from `src/engine/trajectory.ts` (0087 — PURE, engine-only,
  reads a directed edge's `phase`/`momentum`, never exported past the Vault boundary) with high forced
  co-presence from `src/engine/presence.ts` (0049/0066). The top seeded intersecting pair becomes a
  `FrictionPair` record carrying a persisted escalation rung `0..4`, stored engine-side alongside other
  per-sandbox live-season state (monotonic — non-degrading, survives save/reload).
- `src/engine/houseEvents.ts` gains a new petty-dispute event family: a seeded pool of trivial-object
  flashpoints (dishes, snoring, a shaker…), staged PUBLIC with witness set = the room. The player
  witnesses a rung directly if present, or hears about it via normal 0038 gossip if absent — no new
  pathway.
- Each rung is a recorded `EventStore` event folding a real, bounded, seeded relationship impact through
  the EXISTING fold path (`relationshipConstants` caps) — the hidden edge causes the fight, the fight
  scene never states the edge or its phase/momentum word.
- `trajectory.ts`'s own contract holds: the module stays PURE/engine-only, no outward import; only the
  RESULTING public scene (dialogue, staging) is player-facing, never the trajectory number.
- **Four-place FE-write-back rule:** N/A — pure engine selection + existing houseEvents recording path;
  no FE content, no write-back.

**Binding constraints applied.**
- None of the three named constraints is the headline fit here; the load-bearing guarantee is the
  existing Vault Wall / "the feeling is theirs" mandate — the hidden trajectory phase and momentum
  values never cross into any player- or admin-facing surface, verified the same way `trajectory.ts`'s
  existing dependency-cruiser edge is verified.

**Flag & reversibility (T9).**
- Flag: `ORWELL_ODD_COUPLE_BPLOTS` (default OFF).
- Off ⇒ byte-identical: the petty-dispute event family is absent from `houseEvents.ts`'s selection pool;
  no `FrictionPair` state is minted; the daily-event pool is unchanged.
- Designated fallback: today's generic houseEvents pool (status quo).
- Rollback condition: any regression on the daily-event invariant or heavy-sims calibration; or any
  surface (player or admin) shown to render a trajectory phase/momentum number or label.

**DoR / AC / DoD.**
- DoR: `FrictionPair` schema + rung 0..4 escalation design decided; the trivial-object seeded table
  authored; the intersection-selection rule (souring-phase × co-presence threshold) decided; the
  persistence location for `FrictionPair` state confirmed (per-sandbox, monotonic).
- AC: `FrictionPair` selection is deterministic given the seed; petty-dispute events stage PUBLIC with
  witness set = room; each rung folds a bounded seeded impact within existing caps; no player- or
  admin-facing surface ever renders a trajectory number/phase word; the daily-event invariant holds
  across a full week with the flag on.
- DoD: test lanes — `npm run test:unit` (`FrictionPair` selection + rung-escalation determinism tests),
  a byte-identity flag-off test (mirroring `stagedTrajectoryNeutral.test.ts`'s pattern), `npm run
  test:heavy` (daily-event invariant + calibration spine re-run), full FE pytest suite if any dispute
  scene rendering touches FE surfaces.

**Cost:** M.

---

## 4. The Exit Package — E1

*Ruling context: Q1 approved a structurally-filtered, **player-only** eviction-night exit package as
the SECOND sanctioned Vault door (mandate #2). The gossip-diffusion variant ("…Airs") is explicitly NOT
approved — the evictee's wrong-blame belief never enters the house's own knowledge layer.*

**Player experience.** The moment a houseguest walks out, the show hands you their exit package: their
diary-room voice about YOU, how they really felt about the alliance, and who they *believe* voted them
out — possibly dead wrong, possibly you. It fires every single eviction, a small honest dividend instead
of everything hoarded for a finale most abandoned seasons never reach. Nothing about a still-active
houseguest ever appears in it.

**Mechanism.**
- A new engine-scoped, player-channel read: `buildExitPackage(evicteeId)` on the `GameSession` port,
  implemented in `GameSessionAdapter` (which already holds the composition-root Vault wiring). It fires
  AUTOMATICALLY at every eviction commit when the flag is on — never model-optional, matching Q1's
  "fires at EACH eviction" literally and sidestepping the under-call seam entirely (the cross-cutting
  lesson: always-on/engine-signaled beats a callable tool). Delivery follows the same pattern as the
  T0-3 `BeatAnnouncement` chyrons: a Vault-free projection emitted at commit, rendered FE-side as a
  broadcast/package card.
- A new PURE filter module, `src/engine/exitPackage.ts`, runs INSIDE the adapter before any content
  leaves it. The filter predicate is the SAME boundary for every input field (per Q1: "one boundary,
  not two"): **speaker = the evictee AND every named subject ∈ {the player, a prior evictee, a fact
  already present in the player's `KnowledgeService` record}.** Anything touching a still-active
  houseguest's hidden state is DROPPED WHOLE, never redacted-in-place.
- Candidate inputs: the evictee's confessional pull-quotes about the player (0040/0089), the evictee's
  own 0110 `voteDeduction` belief about the player rendered as a typed belief (subject/confidence,
  "possibly wrong" — never asserted truth), one legend clause (0104) if it satisfies the predicate.
- The returned `ExitPackageView` type carries no Vault marker; the tool stays `readsVault: false` like
  every advertised tool (`src/surfaces/tools/registry.ts`) — the boundary is enforced by the filter
  running structurally inside the adapter, not by prompt wording. Because this is the FIRST time the
  source material is genuine Vault content on the PLAYER channel, it needs its own adversarial test
  gate, not reuse of any existing outward-safety test: `tests/unit/exitPackage.test.ts`, fuzzed across
  many seeds/season shapes, mirroring `tests/unit/producerVault.test.ts`'s shape.
- **Four-place FE-write-back rule:** N/A — this is an engine-signaled READ/projection at a fixed beat,
  not FE-authored content written back.

**Binding constraints applied.**
- **Typed beliefs, never bare facts** — the carried 0110 deduction is delivered as a belief with
  confidence, explicitly labeled possibly-wrong, never as engine truth.
- Adversarial-test-gated like `producerVault` — the closest fit to "deterministic grounding" here is
  that the filter predicate is a single deterministic boundary function, fuzz-tested rather than
  reviewed by inspection.

**Flag & reversibility (T9).**
- Flag: `ORWELL_EXIT_PACKAGE` (default OFF, off-by-default per Q1).
- Off ⇒ byte-identical: no `buildExitPackage` call, no new projection, eviction-commit processing
  unchanged.
- Designated fallback: the 0048 retrospective stays the sole unseal surface (today's status quo).
- Rollback condition: the adversarial suite finds ANY case where a still-active houseguest's hidden
  state crosses, or any subject outside {player, prior evictees, player-known facts} appears — immediate
  flag-off, no re-enable without a fresh audit pass.

**DoR / AC / DoD.**
- DoR: `ExitPackageView` schema decided; the single structural filter predicate coded as one function
  shared by every candidate-input type (confessional quotes AND the deduction belief AND the legend
  clause); the adversarial test suite design drafted (fuzzing evictee Vault content across seeds/season
  shapes); confirmation the gossip-diffusion variant is explicitly OUT OF SCOPE (no house-knowledge-
  layer write is designed).
- AC: `buildExitPackage` fires automatically at EACH eviction commit with the flag on; audience is the
  player ONLY (no NPC ever receives it, no gossip write); speaker is always the departing evictee; every
  named subject satisfies the Q1 predicate (structurally verified, not by prompt); the deduction is
  rendered as a typed belief; a still-active houseguest's hidden state never appears across the
  adversarial suite's full sweep; with the flag off, eviction-commit and beat-commit processing are
  byte-identical.
- DoD: test lanes — `tests/unit/exitPackage.test.ts` (the adversarial gate), `npm run test:arch`
  (dependency-cruiser confirming `exitPackage.ts` isn't imported by any other outward surface — keeping
  the door singular), `npm run test:ci` for the flag-off byte-identity check, full FE pytest suite for
  the package-card render (T0-3's chyron/broadcast grammar). **CLAUDE.md's mandate #2 gets a
  documentation update** naming `buildExitPackage`/`ORWELL_EXIT_PACKAGE` as the SECOND sanctioned Vault
  door alongside `producerVault`, spelling out the structural differences (player-channel/automatic vs.
  admin-channel/manual-unseal) — this update is itself a DoD item, not optional paperwork.

**Cost:** M.

---

## 5. Seeded Partial Reaction Pan — C3

*Ruling context: Q4 — "seeded partial reaction pan… temperature-rolled subset, never all 15."*

**Player experience.** After your nomination speech, the camera pans the room — but only part of it,
different houseguests each time. The oversharer is already crying; the literalist asks a procedural
question; "Jasmine gives you nothing, which from Jasmine means everything is fine." You never get the
same full roll-call twice, so the panel never reads like a status board — it reads like a room.

**Mechanism.**
- At closed-set ceremony beats (after the engine has committed the outcome, per the T0-3 chyron
  ordering), emit a Vault-safe `reactionPan` block into the moment prompt: a temperature-ROLLED SUBSET
  of the witness set (never the full set), each member getting one seeded `{register, valenceWord}`
  pair.
- `register` is a new byte-stable `CHARACTER` field (deadpan / oversharer / literalist / catastrophizer
  / performer), seeded once at genesis — never changes mid-season (mandate #4 non-degradation).
  `valenceWord` derives from ALREADY-BUILT plumbing (mood-word + relationship-label machinery), not a
  new signal.
- Delivered as always-on prompt content (the I6 pattern), NOT an under-callable tool — a small new pure
  selection module, `src/engine/reactionPan.ts`, or an extension of `src/engine/momentPrompts.ts`,
  handles subset-size + member selection, both seeded.
- Pan lines are part of the recorded ceremony event, making them Bit-Ledger-eligible (item 7, if both
  flags are on).
- **Four-place FE-write-back rule:** N/A — pure engine selection feeding the always-on prompt; no FE
  content, no write-back.

**Binding constraints applied.**
- This spec **is** Q4's own coarseness-dial ruling: the subset must be strictly partial (a property
  test proves the full witness set is never selected), and `valenceWord`'s vocabulary must stay
  genuinely coarse — bounded to a small fixed pool, audited so it can never function as "a number in
  disguise" (the L2 risk the slate itself flags).

**Flag & reversibility (T9).**
- Flag: `ORWELL_REACTION_PAN` (default OFF).
- Off ⇒ byte-identical: no `reactionPan` block appended to any ceremony prompt.
- Designated fallback: the narrator's existing unstructured ad-lib ceremony description (status quo).
- Rollback condition: a coarseness audit or live playtest finds the valence-word pool reliably
  reconstructs a hidden trust/threat scalar (a Vault Wall spirit-of-the-rule violation) — flag off
  pending pool recalibration.

**DoR / AC / DoD.**
- DoR: `register` field added to genesis authoring (byte-stable); subset-size distribution + the
  temperature-gate parameters decided (e.g., a bounded fraction of the witness set, never all); the
  `valenceWord` pool coarseness-reviewed against the Q4 risk BEFORE build, with a fixed small vocabulary
  size decided.
- AC: the pan renders for a strict subset of witnesses at ceremony beats, never the full set (a
  property test); `register` is genesis-seeded and stable across the season; `valenceWord` draws from a
  fixed, bounded vocabulary (a unit test enforces the bound); pan lines are recorded as part of the
  ceremony event; with the flag off, byte-identical moment-prompt content.
- DoD: test lanes — `npm run test:unit` (subset-selection determinism + never-full-set property test,
  register-genesis byte-stability test, vocabulary-bound unit test), full FE pytest suite (prompt-block
  rendering, I6 always-on-not-tool compliance), `npm run test:bdd` if a ceremony scenario is authored.

**Cost:** M.

---

## 6. The Booth Has Receipts — A2

**Player experience.** The Diary Room occasionally becomes a screening room: "Week 1, you promised
final-two to three different people. Footage doesn't forget." It never judges and never leaks anything
to anyone else — it just proves the archive of YOUR OWN words is complete, and it's the last honest
mirror before you're about to do something you'll regret.

**Mechanism.**
- A new PURE engine module, `src/engine/receipts.ts`, deterministically extracts candidate
  contradictions from ONLY the player's own witnessed/authored record: recorded events the player
  participated in, deals the player made (`deals.ts`), decisions, and Diary Room statements
  (`KnowledgeService.recordDiaryRoom`). Candidate classes: divergent commitments (final-two promised to
  multiple people), stated-target-vs-actual-vote mismatches, DR-statement-vs-later-public-statement
  flips. **Zero Vault read** — a unit test with the Vault handle absent/mocked-out proves the module
  cannot touch it.
- Exposed as a new outward-safe read on `GameSession`, e.g. `playerReceipts()`, returning the
  deterministic candidate list — no LLM in this step.
- An FE-side, fail-soft utility-LLM pass (mirroring the `orwell_cast_authoring.py` pattern: resolve a
  utility LLM via `_resolve_llm_fn`, synthesize prose) WORDS the candidates into producer-voice prose for
  display. The LLM only ranks/words — it never originates a contradiction absent from the candidate
  list (a groundedness test enforces this).
- Delivered EXCLUSIVELY on the player-level OOC channel, which by spec has NO pathway to any NPC — the
  same DR guarantee (`NO_NPC_PATHWAY`). Triggerable diegetically before a self-contradictory decision
  (the v1 anti-tragedy mirror) or on a periodic cadence; the player can always dismiss/proceed.
- **Four-place FE-write-back rule:** N/A — `playerReceipts()` is a plain outward READ; the FE-side LLM
  pass only renders for display, it writes nothing back into engine state.

**Binding constraints applied.**
- **Deterministic grounding before persistence/display** — `receipts.ts` extracts every candidate +
  source event ids deterministically from the `EventStore`/deals ledger before any LLM touches it; the
  LLM only words the already-decided candidates, never originates new ones (mirrors C4's own use of this
  constraint).

**Flag & reversibility (T9).**
- Flag: `ORWELL_BOOTH_RECEIPTS` (default OFF).
- Off ⇒ byte-identical: no `playerReceipts()` computation; the DR renders exactly as it does today.
- Designated fallback: a template-only receipts renderer (a bounded phrase-template floor, same shape
  as Footage Pool's T9 fallback) if the utility LLM is killed mid-season — fail-soft, never a stall.
- Rollback condition: the groundedness test finds the wording pass introduces a contradiction absent
  from the deterministic candidate list.

**DoR / AC / DoD.**
- DoR: the contradiction-candidate classes finalized; the screening-room trigger cadence decided
  (periodic / pre-decision mirror / both); the template-fallback floor drafted.
- AC: candidates are extracted deterministically from ONLY the player's own record (zero-Vault-read
  proof); the wording pass never introduces an ungrounded contradiction; delivery is exclusively
  player-level OOC with no NPC pathway; the player can always proceed; with the flag off,
  byte-identical.
- DoD: test lanes — `npm run test:unit` (`receipts.ts` pure extraction tests + the zero-Vault-read
  structural proof), `npm run test:arch` (dependency-cruiser confirming no VaultStore import), full FE
  pytest suite (the groundedness test comparing wording vs. candidates, the DR no-NPC-pathway test
  extended, a killed-utility-model template-fallback test).

**Cost:** M.

---

## 7. The Running Bit Ledger — C4

**Player experience.** The first time an NPC quotes your weird word back, it's a chill; the fifth time
the whole house is saying it, it's the season's catchphrase. Running gags get FUNNIER over the season
because the engine remembers every callback and who made it — comedy that compounds instead of thinning.

**Mechanism.**
- A new PURE module, `src/engine/houseBits.ts`. Primary detection is fully deterministic: when the
  `EventStore` shows a normalized token/phrase recurring across ≥2 recorded events — restricted to
  events whose witness set qualifies as player-known-or-fully-public (never a Vault-only event) — a
  seeded temperature roll promotes it to a `Bit` record `{token, originEvent, witnesses, callbackCount,
  lastInvokedBy}`. This deterministic floor works with zero LLM involvement.
- An OPTIONAL FE-side utility-LLM assist handles the fuzzier case (two phrasings that are plausibly the
  same bit) — this genuinely IS a new FE-driven write-back and gets the full four-place seam: (1)
  `src/ports/GameSession.ts` — `recordBitLabel` req/result types, (2)
  `src/adapters/engine/GameSessionAdapter.ts` — implementation, (3)
  `src/surfaces/tools/registry.ts` — `PLAYER_TOOLS` + `INFRA_LEVERS` (FE-driven, not a model lever), (4)
  `src/adapters/mcp/McpServer.ts` — arg-guard + dispatch case, plus a `tests/unit/*.test.ts` boundary
  test dispatching through `McpServer.callTool` (the `castPrewarm.test.ts` template). **Fail-soft:** if
  this write-back never fires, the deterministic-token floor still produces Bits — no stall, no
  correctness loss.
- `callbackCount` is monotonic (mandate #4). Bits ride the always-on context block (I6 pattern), not a
  callable tool. Off-screen ticks give NPCs seeded callback chances against recorded events — bounded
  affinity folds via existing `relationshipConstants` caps. 0048 unseals each Bit's full biography. Bits
  can retire diegetically but the record is never deleted (append-only, matching `EventStore` discipline).
- Cross-feeds: C1 wipeouts, C2 feuds (item 3), C5 rituals (item 11) all mint Bit-eligible material.

**Binding constraints applied.**
- **Deterministic grounding before persistence** (the slate's own §6 example for C4) — candidates +
  source event ids are extracted deterministically before persistence; the optional LLM assist only
  ranks/normalizes phrasing equivalence, never originates a Bit from nothing.

**Flag & reversibility (T9).**
- Flag: `ORWELL_HOUSE_BITS` (default OFF).
- Off ⇒ byte-identical: no `houseBits.ts` pass runs, no context block, no `recordBitLabel` calls.
- Designated fallback: a recurring token is simply narrated ad hoc, as today (no tracked bit).
- Rollback condition: the LLM-normalization step is shown to originate a Bit not backed by ≥2 real
  source events; or `callbackCount` is observed to decrease (a non-degradation regression).

**DoR / AC / DoD.**
- DoR: the token/phrase normalization rule for deterministic candidate detection decided; the promotion
  threshold (≥2 occurrences + seeded roll) decided; the player-known-or-fully-public mint restriction
  encoded as an explicit witness-set check; retirement semantics (diegetic sunset, never delete)
  decided; the `recordBitLabel` four-place wiring plan drafted.
- AC: every minted Bit traces to ≥2 real `EventStore` ids (a unit test); Bits mint only from events
  whose witness set qualifies (a boundary test proves no Vault-only-event Bit); `callbackCount` is
  monotonic across a season; Bits ride the always-on prompt, never a callable tool; 0048 renders each
  Bit's biography; with the flag off, byte-identical.
- DoD: test lanes — `npm run test:unit` (`houseBits.ts` deterministic-detection + monotonicity tests),
  a boundary test proving no Vault-only event mints a Bit, `McpServer.callTool` boundary test for
  `recordBitLabel` (the write-back template), full FE pytest suite (context-block rendering, I6
  compliance, LLM-normalization groundedness test), the 0048 retrospective render test extended to
  include Bit biographies.

**Cost:** M.

---

## 8. Publicity-Priced Promises — D2

**Player experience.** Where you make a promise matters as much as what you promise. A whispered
final-two in an empty HOH room is cheap and deniable; the same deal sworn in front of three houseguests
posts your reputation as collateral — more credibility now, and a breach that three people carry through
the house if you break it. You start staging promises like a lawyer picking a venue.

**Mechanism.**
- Extend the existing `Deal` record in `src/engine/deals.ts` with a `formationWitnesses: EntityId[]`
  field, populated from `presence.ts` ground truth at the moment `makeDeal` commits (the same source A1
  reads).
- Two bounded, seeded effects inside EXISTING fold paths (no new fold mechanism, no new outward tool):
  (1) at formation, the counterpart's trust fold scales with audience size, staying inside the existing
  `relationshipConstants` magnitude caps (ADR 0005: engine owns the magnitude); (2) at breach, the
  EXISTING `applyBreak` function seeds the breach fact into each formation-witness's knowledge via the
  standard 0038 diffusion pathway — the collateral forfeited equals the audience the promiser chose.
- The player's lever is purely diegetic (pick the room/company before speaking) — reuses existing
  `makeDeal` + ordinary room/presence actions, no new tool.
- Complements the already-built deal-duration mechanic (0109, `src/engine/deals.ts:67`) as a second,
  previously-unpriced term of the same contract.
- **Four-place FE-write-back rule:** N/A — pure extension of an existing engine-side record and its
  existing fold paths.

**Binding constraints applied.**
- No direct fit among the three named constraints (D2 doesn't mint typed claims, doesn't derive
  observer sets, and doesn't persist LLM-authored canon) — it satisfies the general ADR 0005 open/closed
  split already governing `deals.ts` (model proposes shape via the existing consequence descriptor if
  any; engine owns the bounded magnitude).

**Flag & reversibility (T9).**
- Flag: `ORWELL_DEAL_WITNESSES` (default OFF).
- Off ⇒ byte-identical: `formationWitnesses` is either unpopulated or ignored; trust-fold magnitude and
  breach diffusion behave exactly as today.
- Designated fallback: today's audience-blind deal fold (status quo).
- Rollback condition: gradient/juryReach calibration drift attributable to the audience-scaled fold; or
  a boundary test finds breach diffusion reaching beyond the recorded formation-witness set.

**DoR / AC / DoD.**
- DoR: the formation-witness capture rule (presence snapshot at commit) decided; the trust-fold
  audience-scaling formula decided within existing caps; confirmation breach-diffusion reuses the
  existing `KnowledgeService`/gossip pathway with no new mechanism.
- AC: `Deal` carries `formationWitnesses` sourced from presence ground truth; the formation trust-fold
  scales with witness-set size, bounded; at breach, the fact reaches exactly the formation-witness set
  (a boundary test proves no over-reach); the player's only lever is diegetic room/company choice; with
  the flag off, byte-identical deal-fold behavior.
- DoD: test lanes — `npm run test:unit` (`deals.ts` formation-witness capture + scaled-fold unit tests,
  the breach-diffusion-scope boundary test), gradient/juryReach shards re-run, full FE pytest suite if
  any dossier/DR surface later references collateral.

**Cost:** M.

---

## 9. The Walls Repeat You — B2

*Prerequisite: sequenced after the B1 flag flip (`ORWELL_GOSSIP_DRIFT`, already Q2-approved live in
Wave 1) — B2 rides the same drift substrate.*

**Player experience.** You coin a private word with one ally — two days later a different houseguest
uses it to your face. Cold water down the spine: you were overheard, or your ally talks. Tracing how the
phrase traveled becomes a winnable deduction about who's connected to whom, and popping it with a
confrontation is the payoff.

**Mechanism.**
- A temperature-gated `verbatim` payload on gossip records, extending the EXISTING `gossip.ts` structures
  that already carry source chains, hops, and per-hop distortion.
- The already-wired 0055 auto-record extraction (`_auto_record_scene`, `frontend/src/agent_loop.py`)
  additionally captures one distinctive player phrase (the player's OWN words — sourced from their own
  recorded speech, never Vault content) as part of the interaction's existing consequence descriptor.
- With a small seeded probability, that one field rides a gossip edge undistorted — `distort()` is
  skipped for THAT FIELD ONLY, every other field of the same retelling drifts normally — and resurfaces
  in a chain-holder's npcVoice context as a phrase-to-voice fact.
- The reveal travels ONLY the legitimate 0038 diffusion pathway, gated by the built 0077 overhear/
  presence rule (both directions) — the Wall holds structurally, not by convention. Provenance (the real
  chain, hop count) is engine-recorded, using the SAME `BeliefInput` shape (`source`, `hops`,
  `distortion`, `factId`) `KnowledgeService.transmitGossip` already uses — so `confront(npcId, factId)`
  (0094) resolves against a REAL recorded chain, never an invented one.
- **Four-place FE-write-back rule:** N/A — reuses the already-wired 0055 extraction seam; no new tool.

**Binding constraints applied.**
- **Typed beliefs, provenance** — the verbatim fact carries the same claimant/source/hops/confidence
  shape as every other gossip belief; `confront` resolves against recorded provenance, never a bare
  assertion.

**Flag & reversibility (T9).**
- Flag: `ORWELL_VERBATIM_CARRIAGE` (default OFF; requires `ORWELL_GOSSIP_DRIFT` on).
- Off ⇒ byte-identical: gossip records never carry the verbatim payload; every retelling distorts
  normally as today.
- Designated fallback: distorted-only gossip (today's shipped B1 behavior).
- Rollback condition: a boundary test finds a verbatim phrase reaching an audience outside its own
  legitimate diffusion chain (a Wall violation); or `confront` resolving against a phrase that didn't
  actually travel the recorded chain (a provenance-integrity regression).

**DoR / AC / DoD.**
- DoR: the "distinctive phrase" selection rule for 0055's capture decided (length/rarity heuristic);
  the skip-distort-for-this-field-only mechanism confirmed field-scoped (not record-wide) in `gossip.ts`;
  the seeded probability + hop-cap for verbatim carriage decided; B1's flag confirmed live first.
- AC: a distinctive phrase rides a gossip edge with zero distortion on that field while other fields
  distort normally; the phrase reaches only houseguests reachable via a legitimate, engine-recorded
  chain (a boundary test proves no bypass of the 0077 gate); `confront` resolves the fact against its
  real chain; with the flag off, byte-identical gossip-record shape.
- DoD: test lanes — `npm run test:unit` (`gossip.ts` field-scoped skip-distort test, chain-integrity
  test), a boundary test proving no bypass of the 0077 overhear/presence gate,
  `tests/unit/expressiveNonCollapse.test.ts` + `frontend/tests/test_expressive_non_collapse.py` re-run
  (verbatim stays an open-set claim, never promoted to closed-set truth), full FE pytest suite
  (npcVoice phrase-to-voice rendering), a 0094 `confront` test extended with a verbatim-fact fixture.

**Cost:** M (keeper) — S residual once B1's substrate is live.

---

## 10. The Barium Meal — B3

*Prerequisite: sequenced after B1 (`ORWELL_GOSSIP_DRIFT`) and `ORWELL_SECRET_BARTER` (both Q2-approved,
Wave 1) — B3 operates on the secret-barter tick's knower-set bookkeeping.*

**Player experience.** Selling a secret finally costs what it should: exposure. If only two people knew
and it gets back to the subject, the suspect list is two names long — and you can run the classic
counterintelligence play, telling slightly different versions to different people and waiting to see
which one walks back in the door.

**Mechanism.**
- Scarcity pricing: extend `tradeValue` (`src/engine/leverage.ts`, currently prices severity/
  vulnerability only) with a knower-set-size term — fewer holders ⇒ higher value; information
  deterministically depreciates as the knower set grows. A pure, bounded formula change.
- Trace-back: when a secret's recorded gossip chain (0038, extended by item 9's provenance carriage)
  terminates at its SUBJECT, run a seeded leak-attribution deduction over the ACTUAL recorded knower set
  at leak time, reusing the 0110 ranking-math pattern (`src/engine/voteDeduction.ts`'s suspicion-ranking
  + ambiguity-jitter), on its OWN forked sub-`RandomnessSource` stream (never perturbing 0110's existing
  vote-deduction draws — the C1 fork-after-resolution pattern). The result is a typed, POSSIBLY-WRONG
  blame belief that folds a bounded grudge via the existing relationship-fold path and can itself
  circulate as gossip through the existing pathway — no new mechanism.
- The canary trap (telling different versions to different people) falls out for free from item 9's
  per-recipient verbatim/variant recording plus the 0094 confront lever — purely a query over
  already-recorded per-recipient chain data, no new field.
- **Four-place FE-write-back rule:** N/A — pure engine pricing + deduction extension, no new tool.

**Binding constraints applied.**
- **Typed beliefs, never bare facts** — the leak-attribution result is explicitly a possibly-wrong
  belief, never promoted to truth, mirroring D1's and item 9's discipline.
- **Bounded observer sets (in spirit)** — the trace-back must run only over the ACTUAL, structurally
  recorded knower set at leak time, never an inferred or aggregate one.

**Flag & reversibility (T9).**
- Flag: `ORWELL_BARIUM_MEAL` (default OFF; requires B1 + `ORWELL_SECRET_BARTER` on).
- Off ⇒ byte-identical: `tradeValue` ignores the knower-set term; no trace-back deduction runs; no
  canary-trap query surface.
- Designated fallback: today's flat severity/vulnerability-only secret pricing (the already-lit
  barter-tick status quo).
- Rollback condition: leak-attribution is shown to leak the TRUE (non-deduced) knower set rather than a
  belief; trace-back runs over a knower set larger than what was actually recorded; or barter/gradient
  calibration drifts.

**DoR / AC / DoD.**
- DoR: `tradeValue`'s knower-set depreciation formula decided (bounded, within existing pricing scale);
  B1's flag + `ORWELL_SECRET_BARTER` confirmed live as prerequisites; the leak-attribution sub-rng
  stream confirmed forked and isolated from 0110's existing draws.
- AC: `tradeValue` scales inversely with knower-set size, deterministic given the same inputs; a
  trace-back deduction fires only when a real recorded chain terminates at its subject, producing a
  typed possibly-wrong belief that folds a bounded grudge; the new sub-rng draw doesn't perturb 0110's
  existing stream (a byte-identity check on that stream with B3 on); the canary trap is queryable purely
  from item 9's existing per-recipient records; with the flag off, byte-identical pricing and zero
  deductions.
- DoD: test lanes — `npm run test:unit` (`leverage.ts` pricing tests, trace-back deduction tests reusing
  the 0110 ranking-math pattern), a stream-isolation test proving no perturbation of `voteDeduction`'s
  draws, gradient/juryReach shards re-run, full FE pytest suite (grudge-fold rendering). Sequencing note
  in the eventual PR confirming B1 + `ORWELL_SECRET_BARTER` are live before merge.

**Cost:** L (the batch's heaviest lift in this set).

---

## 11. Cabin-Fever Ceremonies — C5

**Player experience.** Week 3, nothing strategic is happening — and suddenly the house is holding a full
funeral for the broken toaster, with a eulogy, a procession, and one houseguest refusing to participate
on principle. Boredom becomes content; the refusal is funnier than the ritual. You can attend, mock, or
skip — lingering is still play.

**Mechanism.**
- A new "ritual" event family in `src/engine/houseEvents.ts`'s seeded pool, eligible ONLY when
  ENGINE-SIDE tension proxies read low: no pending decision, no fresh nomination window, low recent
  event salience (the existing houseEvents/day-index salience tracking, NOT the FE's own idle/engagement
  heuristic — that heuristic governs a separate concern, the Director's `advanceGame` nudge in T1-6, and
  the two signals must stay explicitly decoupled per the slate's own L2 flag).
- Rituals REPLACE silence only — never a comp or ceremony — so no player input ever modulates any
  outcome distribution (a heavy-sims check across full seasons proves this).
- Template drawn seeded from a curated pool (mock award show, house court over a food crime, object
  funeral, invented sport). Casting is deterministic given genesis facets + seed: instigator =
  highest-CHARACTER-facet-fit, refuser = seeded worst-fit — a recorded, witnessed, PUBLIC scene, not an
  LLM invention.
- Participation scenes are recorded public events folding real bounded affinity through the existing
  fold path. Recurring rituals feed item 7's Bit Ledger if that flag is also on.
- **Four-place FE-write-back rule:** N/A — pure engine event-family addition using the existing
  houseEvents mint pathway; no FE content, no write-back.

**Binding constraints applied.**
- **Deterministic grounding (loosely)** — casting selection (instigator/refuser) is a deterministic
  read of genesis `CHARACTER` facets plus a seeded tie-break, never an LLM invention of who's involved.

**Flag & reversibility (T9).**
- Flag: `ORWELL_CABIN_FEVER` (default OFF).
- Off ⇒ byte-identical: the ritual family is absent from `houseEvents.ts`'s selection pool; the
  existing daily-event pool is unchanged.
- Designated fallback: today's generic houseEvents pool (status quo).
- Rollback condition: any evidence a ritual ever substitutes for or delays a comp/ceremony beat (a
  daily-event-invariant violation); or the engine-lull and FE-lull signals are shown to have tangled,
  causing a mis-timed ritual.

**DoR / AC / DoD.**
- DoR: the engine-side-only lull/eligibility signal specified precisely and explicitly decoupled from
  any FE idle-timer; the ritual template pool authored (several seeded entries); the instigator/refuser
  casting-selection rule decided (deterministic facet-fit read, seeded tie-break).
- AC: a ritual fires only when the engine-side eligibility proxy reads low tension (a unit test with
  mocked engine state proves the gate); a ritual never substitutes for or delays a comp/ceremony beat
  (a heavy-sims/UAT check across full seasons); casting is deterministic given facets + seed;
  participation scenes are PUBLIC, recorded, and fold real bounded affinity; with the flag off,
  byte-identical daily-event pool and zero rituals.
- DoD: test lanes — `npm run test:unit` (`houseEvents.ts` ritual-family selection tests, the engine-
  only-signal isolation test), `npm run test:heavy` (daily-event-invariant + full-season UAT re-run),
  full FE pytest suite (participation-scene render, lingering-is-play affordances), a cross-feed check
  against item 7 if both flags are on.

**Cost:** M.

---

## 12. Cold Cases (F2) + Production Memory without step 2 (F4)

*Ruling context: Q3 approved full cross-season CARRY-IN OF CONTENT (never outcomes) — "legend precedes
you + cold cases + production memory." Q5 ruled engagement-biased SURFACING is OUT ("no player-derived
input influences any engine selection, including presentation routing") — F4 ships without the
biased-routing step described in its own original pitch.*

### 12a. Cold Cases — F2

**Player experience.** At the retrospective: "3 secrets in this house never surfaced. Unseal them now —
or leave them buried." Anything left sealed rides into your next season as a cold case: a returning
thread, a rumor the new cast arrives already carrying, a mystery with a real season of history behind
it. The shareable moment is choosing NOT to know.

**Mechanism.**
- `buildVaultUnseal` (the 0048 retrospective) already knows which threads never surfaced
  (`threadConstants.ts`'s own instrumentation). Add a per-thread player choice at the retrospective:
  reveal (today's default) or seal as a cold case.
- Sealed threads are EXCLUDED from that season's unseal payload — **Vault→Vault, the wall never opens**
  (nothing crosses that wasn't already going to cross under "reveal"). They're written into a small,
  bounded, monotonic carry-over object following the SAME pattern the built `NotorietySummary`
  (`src/engine/notoriety.ts`, 0104) already establishes — computed alongside the sealed Vault, never
  from it, and riding the SAME sanctioned season-restart door (`registry.resetUser` /
  `Orchestrator.forgetUser`, `src/composition/`) that `NotorietySummary` already uses. No second restart
  path is added.
- Next season's cast genesis samples carried cold cases as seed material for one NPC's hidden layer plus
  one dormant thread the EXISTING 0060 scheduler surfaces under NORMAL pathway rules — no forced reveal,
  no shortcut; it can take a whole season to resurface, exactly like any other hidden thread.
- Non-degradation (mandate #4) is satisfied by construction: nothing is lost, only postponed.
- **Four-place FE-write-back rule:** N/A — the reveal/seal choice is a plain player-channel decision at
  an existing retrospective surface; the carry-over write happens engine-side through the existing
  season-door hinge, not a new FE write-back tool.

**Binding constraints applied.** No direct fit among the three named constraints; the load-bearing
guarantee is the season-door singularity (one sanctioned restart path) plus non-degradation.

**Flag & reversibility (T9).**
- Flag: `ORWELL_COLD_CASES` (default OFF).
- Off ⇒ byte-identical: the retrospective always reveals (today's behavior); no carry-over object is
  written.
- Designated fallback: today's always-reveal-or-nothing retrospective.
- Rollback condition: any case where a sealed thread's content crosses to the player before its
  legitimate re-surfacing pathway (a Wall regression); or a seeding bug letting a carried thread skip
  normal 0060 scheduler rules.

**DoR / AC / DoD.**
- DoR: the reveal-or-seal choice UI/flow at the retrospective decided; the carry-over object's schema
  decided (mirroring `NotorietySummary`'s bounded-summary shape); the next-season genesis-seeding rule
  (one NPC's hidden layer + one dormant 0060-eligible thread) decided.
- AC: a per-thread reveal-or-seal choice appears at the retrospective; sealed threads never appear in
  that season's unseal payload; sealed threads seed exactly one NPC's hidden layer + one dormant thread
  next season, surfacing only under normal pathway rules; the sanctioned single season-restart door is
  the only path touching the carry-over object; with the flag off, byte-identical retrospective.
- DoD: test lanes — `npm run test:unit` (carry-over schema tests, the season-door-only-write boundary
  test), `npm run test:ci` for the full season-reset path, full FE pytest suite (retrospective
  reveal/seal UI flow, cast-genesis seeding from carried threads), `npm run test:heavy` to confirm the
  daily-event/calibration spine is undisturbed.

**Cost:** M.

### 12b. Production Memory, without step 2 — F4

**Player experience.** Season 2's invisible showrunner has read your season-1 file — you leaned hard
into betrayal arcs, barely engaged comp drama? The production bible's NOTES about you read a little
differently because of it. The camera doesn't get rigged, easier, or harder — it just writes about you
like it's been paying attention across seasons, and the retrospective shows you exactly what it learned.

**Mechanism.**
- Step 1 (already Q2-approved, Wave 1, orthogonal to this item): `ORWELL_SHOWRUNNER=1` observe-only in
  deploy defaults.
- This item is the CONTENT-CARRY half only. At season end, a PURE engine module folds a Vault-FREE
  engagement profile — computed strictly from player-witnessed events (which beat-classes/thread-types
  the player actually engaged with, e.g. leaned into betrayal arcs vs. comp drama) — into the SAME
  bounded, monotonic carry-over object item 12a's cold cases use, following the `NotorietySummary`
  pattern.
- **The Q5 boundary, coded as a hard function split:** next season's showrunner (0101) may read the
  profile ONLY inside its NOTE-COMPOSITION function (wording/emphasis of an already-selected note — pure
  content, not a decision) — it is structurally UNREACHABLE from the beat-SELECTION / surfacing-slot-
  ROUTING function (which already-committed hidden beat gets narrated, in what order). A boundary test
  proves the profile object is never passed into the selection function's arguments at all — not merely
  "unused," but architecturally absent from that call.
- `SHOWRUNNER_REWEIGHT` (the dangerous Phase-2 knob that WOULD touch selection/outcomes) stays
  permanently OFF and untouched by this item — it is the named designated-fallback boundary, never a
  future increment of this spec.
- **Four-place FE-write-back rule:** N/A — pure engine-side fold of already-witnessed events into the
  existing carry-over object; no FE content, no write-back.

**Binding constraints applied.** No direct fit among the three named constraints; the load-bearing
guarantee is the Q5 boundary itself — engagement-derived content may inform WORDING, never SELECTION or
ROUTING.

**Flag & reversibility (T9).**
- Flag: `ORWELL_SHOWRUNNER_MEMORY` (default OFF; distinct from the already-approved `ORWELL_SHOWRUNNER`
  step-1 flag and from the permanently-off `SHOWRUNNER_REWEIGHT` knob).
- Off ⇒ byte-identical: no engagement profile is computed or carried; the showrunner behaves exactly as
  the Wave-1 observe-only shape.
- Designated fallback: the Wave-1 observe-only showrunner with zero cross-season memory (today's Phase-1
  shape once Q2's flag lands).
- Rollback condition: the selection-vs-composition boundary test fails — i.e., the profile becomes
  reachable from the selection/routing path by any means — immediate flag-off, re-opens the Q5 question
  for the owner.

**DoR / AC / DoD.**
- DoR: the engagement-profile schema decided (which player-witnessed event classes it aggregates); the
  two function boundaries (composition vs. selection) coded as genuinely separate call paths with the
  profile passed to only one of them; confirmation `SHOWRUNNER_REWEIGHT` is untouched and stays off.
- AC: the engagement profile is computed strictly from player-witnessed events (zero-Vault-read proof);
  it may bias note WORDING/emphasis only; a boundary test proves the beat-selection/routing function
  never receives the profile as an argument; `SHOWRUNNER_REWEIGHT` remains off and unmodified; with the
  flag off, byte-identical showrunner behavior.
- DoD: test lanes — `npm run test:unit` (the selection-vs-composition boundary/data-flow test, the
  carry-over schema test shared with item 12a), `npm run test:ci` for the season-door path, full FE
  pytest suite (production-bible wording render), `npm run test:heavy` for calibration-spine
  confirmation. Docs: CLAUDE.md's season-restart-door section cross-referenced to confirm no second
  restart path was added by either 12a or 12b.

**Cost:** M.

---

## 13. The Producer Read (commissioned, OQ4)

*V1 archaeology: `docs/legacy/meta-feedback/bb-day-2.md:148` — "He's gone before you fully process the
exit. Clean. Friendly. You got almost nothing concrete from him and he got a read on your strategy, your
anxiety about hidden connections, and confirmation that you're playing toward consensus. You gave a
little more than he did." And `:722` — "None of them asked you directly. None of them put their name on
it. They're all letting you hold the grenade while they point at the pin." Format-only reference per the
testing rules — no v1 content is ingested as canon, only its VOICE is studied.*

**Player experience.** After a real scene with a houseguest, the show breaks into a second-person
accounting of the exchange itself — economical, a little wry, never explaining the game to you but
making you feel exactly how exposed you just were. "You got almost nothing concrete. He got a read on
your strategy." It teaches you to read the game the way v1's beloved interstitial voice did, every
single time, without ever touching a number you're not supposed to see.

**Mechanism.**
- A new PURE engine module, `src/engine/producerRead.ts`, computes a compact `ExchangeAccounting` fact
  `{playerGained: bool/summary, npcGained: bool/summary}` immediately after a qualifying
  `recordInteraction` commit — using ONLY (a) the recorded event's own content/kind fields and (b) a
  before/after diff of the player's OWN `KnowledgeService` record (did the player's turn hand the house
  something it didn't already have; did the NPC's turn hand the player something new). **Explicitly
  Vault-free** — never hidden edges, never soul, never trust/threat state. A unit test with the Vault
  handle absent proves the module cannot read it, structurally.
- Delivered as always-on moment-prompt context immediately following a qualifying interaction (the I6
  pattern — this must fire every time, matching v1's "after every scene" cadence, so it cannot be a
  narrator-optional tool call).
- Narrator guidance (prompt craft, not a new mechanism): second person, economical, needles the
  informational imbalance the `ExchangeAccounting` fact reports — never states a hidden number, never
  asserts a trust/threat delta as fact, only voices the Vault-free fields it was handed (ADR 0003:
  facts to voice, never scripts to recite).
- Cadence gate: fires only for "substantive" interactions above a floor (mirrors the minimum-viable-
  turn concept) so it doesn't fire on trivial exchanges.
- **Four-place FE-write-back rule:** N/A — pure engine computation feeding the always-on prompt; no FE
  content, no write-back.

**Binding constraints applied.**
- **Explicitly Vault-free, never hidden edges** — the task's own headline requirement for this item.
  Structurally enforced by giving `producerRead.ts` no Vault handle at all (not merely "not calling"
  it), verified by a unit test with the handle absent.
- Deterministic grounding (loosely) — the `ExchangeAccounting` fact is computed pre-narration by pure
  code; the LLM only voices it.

**Flag & reversibility (T9).**
- Flag: `ORWELL_PRODUCER_READ` (default OFF).
- Off ⇒ byte-identical: no `ExchangeAccounting` fact computed or appended after any `recordInteraction`
  commit.
- Designated fallback: today's status quo — no post-scene accounting, the scene simply ends.
- Rollback condition: a structural test finds the computation reaching Vault/soul state (a mandate #2
  regression); or the narrator is shown asserting a hidden trust/threat delta as fact rather than
  voicing only the Vault-free fields it was handed (a mandate #3 sycophancy/fabrication regression).

**DoR / AC / DoD.**
- DoR: the `ExchangeAccounting` schema decided (informational-gain-asymmetry + novelty flags, nothing
  numeric/hidden); the knowledge-layer diff mechanism confirmed reusable from existing
  `KnowledgeService` primitives; prompt guidance drafted and reviewed against the two cited v1 excerpts
  for tone match; the substantive-interaction cadence floor decided.
- AC: an `ExchangeAccounting` fact is computed immediately after every qualifying `recordInteraction`
  commit, reading only the event's own content + the player's knowledge-layer delta; a unit test with a
  mocked/absent Vault handle proves the computation cannot read Vault or soul state; the fact rides the
  always-on prompt (never an under-callable tool); a scripted fixture reproduces the tone of
  `bb-day-2.md:148`/`:722` to reviewer satisfaction (a qualitative AC, called out as such); the
  accounting never asserts a hidden number/edge as fact; with the flag off, byte-identical.
- DoD: test lanes — `npm run test:unit` (`producerRead.ts` pure computation tests + the no-Vault-read
  structural proof), `npm run test:arch` (dependency-cruiser confirming no VaultStore import), full FE
  pytest suite (prompt-block rendering, I6 compliance, the tone/regression fixture against the two cited
  v1 lines), `npm run test:bdd` if a dedicated scenario is authored. A qualitative narration-fidelity
  spot-check on live play is noted alongside the automated gates, per the owner's live-play evidence
  standard.

**Cost:** M.

---

## 14. The Player Dossier (commissioned, OQ4)

*V1 archaeology: `docs/legacy/meta-feedback/bb-day-2.md:3195` — v1's Document 3 ("THE PLAYER'S
JOURNAL"): "This document is written in the third person for clarity, but everything in it reflects only
what [the player] has directly experienced, witnessed, or been told. You do not know things you were not
present for. Reads and suspicions are noted as reads and suspicions — not confirmed facts." Format-only
reference — no v1 content ingested as canon, only its curation CONVENTION is studied. Adjacent-but-
independent: `docs/features/0097-suspicion-ledger.md` — the pure `src/engine/suspicionLedger.ts`
(`logHunch`/`editHunch`/`withdrawHunch`, `resolveAgainstReveal`) is engine-core-built and structurally
the closest existing precedent (a player-private hunch ledger later scored against a sanctioned
reveal) — but its FE write-back wiring is explicitly **PARKED / PO-gated** in Part C. Per the task
brief, this spec does **not** depend on or build atop 0097's wiring; it ships self-sufficient on the
existing Diary Room pattern. A future merge of the two ledgers is a plausible non-blocking follow-on once
0097 is unparked — never a prerequisite here.*

**Player experience.** Your own reads, curated back to you — per houseguest, in your own words, never
confirmed or corrected by the game. "Reads and suspicions are noted as reads and suspicions — not
confirmed facts," exactly like v1's beloved Document 3. It's the private notebook you'd keep on a real
season, except the show remembers every entry and hands it back to you exactly as you wrote it.

**Mechanism.**
- Reuses the EXISTING, already-wired `diaryRoom` player-channel tool (`src/surfaces/tools/registry.ts`:
  `{name: "diaryRoom", channel: "player", readsVault: false, …}`, backed by
  `EngineCommands.diaryRoom(req: DiaryRoomReq)` and `KnowledgeService.recordDiaryRoom(content)`), which
  already guarantees `NO_NPC_PATHWAY` — the player's own OOC knowledge, exactly the shape this item
  needs. `DiaryRoomReq` gains one new OPTIONAL field, `subjectId?: EntityId`, so an entry can be
  explicitly tagged to a houseguest. Absent ⇒ behaves exactly as today (additive, backward-compatible).
- A new outward-safe read, `playerDossier(subjectId?)` on `GameSession`, alongside the existing
  `playerDiaryRoom?: string[]` field, groups the player's own tagged entries per houseguest.
- An OPTIONAL FE-side fail-soft curation pass (the same `orwell_cast_authoring.py`-style pattern used in
  item 6) may reformat the player's raw entries into readable third-person prose per the v1 Document 3
  convention ("reflects only what [the player] has directly experienced… reads and suspicions are noted
  as reads and suspicions") — it may ONLY reformat/summarize; it must NEVER inject a claim, confirm or
  deny anything, or consult ANY engine-truth source. A groundedness test enforces that every sentence in
  the curated output traces to the player's own authored text.
- **Never engine reads, never numbers — their words only**, per the task's explicit requirement: no
  relationship model, no soul, no Vault, no computed trust/threat value ever enters this surface,
  structurally, not by convention.
- **Four-place FE-write-back rule:** N/A — extends an EXISTING, already-wired tool with one optional
  field; `playerDossier` is a plain outward read; the optional curation pass renders for display only
  and writes nothing back into engine state (the record of truth stays the player's raw `diaryRoom`
  entries).

**Binding constraints applied.**
- None of the three named constraints applies in the usual positive sense — by design this surface
  never touches engine truth, Vault, or numbers at all. The nearest fit is constraint #3's spirit
  INVERTED and made stricter: the curation LLM may only reformat the player's own already-authored
  words, never ground or originate a claim from anywhere else — enforced by the groundedness test above.

**Flag & reversibility (T9).**
- Flag: `ORWELL_PLAYER_DOSSIER` (default OFF).
- Off ⇒ byte-identical: `DiaryRoomReq` carries no `subjectId` field in practice, `diaryRoom`/
  `playerDiaryRoom` behave exactly as today; no `playerDossier` accessor is exposed.
- Designated fallback: the player's own ad hoc chat history stands in as the (much weaker) equivalent —
  no engine-recorded per-houseguest read surface exists today; that status quo is the fallback.
- Rollback condition: any boundary test finds dossier content reaching an NPC pathway (the single most
  serious possible failure here — a `NO_NPC_PATHWAY`/Vault-Wall-spirit regression); or the curation pass
  is shown to inject a claim absent from the player's own authored text.

**DoR / AC / DoD.**
- DoR: the `DiaryRoomReq.subjectId?` extension confirmed additive/backward-compatible; the
  `playerDossier(subjectId?)` accessor schema decided (returns verbatim entries + optional curated
  prose, grouped per houseguest); the curation pass's strict-reproduction contract decided and a
  groundedness test drafted; explicit confirmation this spec does NOT wire into 0097's
  `suspicionLedger.ts` write-back (parked/PO-gated) — noted as adjacent, not depended on.
- AC: a diary-room entry can optionally be tagged to a houseguest via `subjectId`; omitting it behaves
  exactly as today; `playerDossier(subjectId?)` returns only the player's own authored entries, grouped
  per houseguest, with zero engine-truth admixture (a boundary test proves no relationship/soul/Vault
  read enters the accessor); the optional curation pass never introduces a claim absent from the
  player's own authored text (a groundedness test); the surface carries the same `NO_NPC_PATHWAY`
  guarantee as the base Diary Room (an extension of the existing DR Vault/NPC-pathway-free proof); with
  the flag off, byte-identical `diaryRoom`/`playerDiaryRoom` behavior.
- DoD: test lanes — `npm run test:unit` (`DiaryRoomReq` subject-tag extension test, `playerDossier`
  accessor unit tests, the no-engine-truth boundary test), `npm run test:arch` if a new module needs the
  same forbidden-edge guard the base DR pathway already carries, full FE pytest suite (the curated-prose
  groundedness test, the Dossier panel render test, an OOC/`NO_NPC_PATHWAY` regression test extended
  from the existing DR test). Docs: a cross-reference note (not a dependency) added pointing at
  `docs/features/0097-suspicion-ledger.md` as adjacent, PO-gated machinery — explicitly out of scope for
  this spec's build.

**Cost:** M.

---

## Summary table

| # | Spec | Flag | Cost | Prereqs |
|---|---|---|---|---|
| 1 | D1 Ballot Arithmetic | `ORWELL_BALLOT_CLAIMS` | M (may run L) | — |
| 2 | A1 Fifteen Pairs of Eyes | `ORWELL_ATTENTION_LEDGER` | M | — |
| 3 | C2 Odd-Couple B-Plots | `ORWELL_ODD_COUPLE_BPLOTS` | M | — |
| 4 | E1 The Exit Package | `ORWELL_EXIT_PACKAGE` | M | Q1 ruling (done) |
| 5 | C3 Seeded Partial Reaction Pan | `ORWELL_REACTION_PAN` | M | Q4 ruling (done) |
| 6 | A2 The Booth Has Receipts | `ORWELL_BOOTH_RECEIPTS` | M | — |
| 7 | C4 The Running Bit Ledger | `ORWELL_HOUSE_BITS` | M | — |
| 8 | D2 Publicity-Priced Promises | `ORWELL_DEAL_WITNESSES` | M | — |
| 9 | B2 The Walls Repeat You | `ORWELL_VERBATIM_CARRIAGE` | M | B1 flag live |
| 10 | B3 The Barium Meal | `ORWELL_BARIUM_MEAL` | L | B1 + `ORWELL_SECRET_BARTER` live |
| 11 | C5 Cabin-Fever Ceremonies | `ORWELL_CABIN_FEVER` | M | — |
| 12a | F2 Cold Cases | `ORWELL_COLD_CASES` | M | Q3 ruling (done) |
| 12b | F4 Production Memory (no step 2) | `ORWELL_SHOWRUNNER_MEMORY` | M | Q3/Q5 rulings (done) |
| 13 | The Producer Read | `ORWELL_PRODUCER_READ` | M | — |
| 14 | The Player Dossier | `ORWELL_PLAYER_DOSSIER` | M | — |

Every flag defaults OFF. Per the T9 doctrine, nothing in this batch is deleted on a future pass if it
underperforms in live play — it demotes to an armed, documented fallback, same as every other item in
the campaign backlog.
