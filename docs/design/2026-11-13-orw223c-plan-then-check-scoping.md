# ORW-223 part C - plan, check, write, check, commit: scoping (no code yet)

Status: SCOPING for the Coordinator, 2026-11-13, Overseer A. Nothing is built. **Revised 2026-11-26 (ORW-1011): see the last section, "Revision 2026-11-26". It supersedes the PLAN-call design in C1 to C3 with an act-first tool round, and it is for Kevin and Ryne to review before any build.** No paid calls were made for this note; every number below is from runs already on record (the 2026-11-12 live arms and the offline checks).

## What part C is

The Showrunner Memory design (ORW-223, parts A to E) has three jobs for the narrator: always know where the story stands (part A, the Show Brief, built and on), never contradict what it already said (part B, the canon ledger, built), and now part C: **decide what happens this turn before writing it**, check the plan against the engine, write only what the plan allows, check the prose against the plan and the engine, and let the front end commit the plan's effects. It is the same idea as ORW-42 / issue #1782 "Act, Commit, Voice", which is in the Backlog waiting for a keep / cut / park. Part C is the scene-turn slice of it.

Rulings that bound it (all already on record): ADR 0003 (the conversation is the game: the engine hands the model facts to voice, never scripts to recite), ADR 0005 (only the closed set may be engine-dictated; the open set, the meaning and texture of social play, is recorded faithfully and never normalized), the owner ruling "error-correct the omission, never engine-author content", the Vault Wall (the plan step sees Vault-free state only), and Ryne 2026-11-12: motives are voiced as the engine's STATED reason for public acts only; real reasons stay Vault-side until the retrospective. Ryne's first-HOH answer (day 2, afternoon) is already built; part C does not touch scheduling.

## What we have today (and why it is not enough)

The model writes prose first and tools second. A pile of belts then repairs what it skipped or invented (docs/design/undercall-seam-structural.md lists about 20: stall nudges, forced advance, `_auto_record_scene`, `_auto_record_deal`, `_auto_move_*`, the pre-emission outcome guard, the ceremony-unvoiced re-ground). The live runs on 2026-11-12 showed the limit of that design on the production narrator (deepseek-flash, which rejects `tool_choice` and ignores textual "you must call X" lines):

* the narrator narrated a whole morning and never called `turnIn` (ORW-310 / 310b: fixed by the FE running the player's own turnIn);
* a hidden state fault (ORW-316) was invisible because everything downstream is "the model said X, a belt noticed";
* extraction is done after the prose, from the prose (the merged extraction, ORW-294): effects are inferred, so a vague sentence produces a vague effect.

Reusable precedents already in the code: the FE executes a closed-set action itself through the normal dispatcher (forced `createCharacter` finalize, ORW-310b `turnIn`, `_advance_one_watch_step`); `recordInteraction` already takes a model-proposed `consequence` descriptor that the engine bounds (ADR 0005); the Show Brief and `stateDelta` already hand the narrator an O(change) view of the board; `explainDecision` / stated reasons (ORW-314) already give a Vault-free "what may be said about why"; the merged extraction already makes one constrained-JSON utility call per engaged turn.

## The proposed turn (scene turns only)

1. **PLAN** (one constrained-JSON utility call, before any prose). Input: the player's message, the Show Brief, who is in the room (engine IDs), the day schedule. Output, in engine IDs only: the scene's participants (a subset of the people present), the effects this turn intends (a record of the scene with kind and a bounded consequence shape, a move, a deal offer or response, a disclosure the engine has already rolled), and what the player's act clearly was (talk, go to bed, ask for X). The model proposes the shape; it never proposes an outcome of a closed-set thing.
2. **CHECK the plan** (pure code, no model). Participants are present and awake; every referenced ID exists; the effect is legal now (the same checks `recordInteraction` / `moveTo` / `makeDeal` already apply); nothing in the plan states a closed-set outcome (a winner, a vote, who is nominated); the player's own choices are not authored. A failing plan is repaired once by showing the model the rejection reason, then dropped to "no plan" (the narrator proceeds as today, with the old belts armed). Ryne's "if it fails, it fails" rule applies to the required genesis lanes, not here; this is an enhancement lane and fails soft, loudly (a soft-fail ring entry).
3. **WRITE**. The narrator gets the validated plan as facts to voice (who is in the scene, what is happening, what was decided and the stated reason if public) and writes the prose. Open-set texture stays free: the plan fixes WHO and WHAT HAPPENS, never the words.
4. **CHECK the prose** (deterministic first, then one claim check). Deterministic: only plan participants speak or act; no sleeping or absent houseguest appears (the asleep-list guard, #2571); clock and phase words agree with the board; the existing pre-emission outcome guard. Claim check (one utility call, only when the deterministic pass is clean and the turn is long enough to carry claims): extract claims about closed-set facts and compare with the plan and the board. A violating sentence is dropped before the player sees it (the same pre-emission mechanism that exists), never rewritten by the engine.
5. **COMMIT**. The FE executes the plan's effects through the dispatcher with `expectedBeatSeq` and an idempotency key (the precedents above), not the model. If the model also called the tool itself, the idempotency key makes it a no-op. The extraction calls that exist today (scene, player move, NPC move) become unnecessary for plan-covered turns: the plan already says it.

Net cost per scene turn, from measured numbers (2026-11-12 live arms, DeepSeek flash, about $0.0026 per turn with the cache fix, 5.8 calls per turn with the merged extraction): PLAN adds one small utility call (about 2 to 3k tokens in, 200 out, roughly $0.0004) and the claim check one more; the three extraction calls the plan replaces are about half the current non-narration calls. Expect calls per turn to stay roughly flat and dollars per turn to rise by a few percent. Latency is the real cost: the PLAN call is serial before the first narrated word (about 1 to 2 seconds on the utility model). That needs a live measurement before anyone commits to it; I have none.

## Slices (each ships alone, flag-gated, default off until measured)

* **C1 - the plan schema and the pure checker** (engine + FE, no model): the Zod-style schema, `validatePlan(plan, view)`, 100% deterministic tests with roles. No behavior change.
* **C2 - PLAN call on engaged player-houseguest turns, shadow mode**: run the plan call and the checker, log agreement with what the existing extraction would have recorded (no effect, no prompt change). Gives the first real accept / reject rates and the latency number. One 12-turn live arm (about $0.10).
* **C3 - COMMIT from the plan**: the FE executes validated plan effects; the extraction calls are skipped for plan-covered turns. Byte-identical headless; played-game A/B on the live arm (calls, cost, scene-record parity).
* **C4 - WRITE from the plan**: the narrator prompt carries the plan as facts to voice. Quality A/B on narration (grounding, no invented participants) with the same 12-turn script.
* **C5 - CHECK the prose**: the deterministic participant / sleeper / clock checks first (cheap, no model), then the claim check.
* **C6 - ceremonies and comps** stay on the existing structured flows (staged ceremony steps, the pre-resolve path). They already commit before the prose; part C does not re-plan them.

## Risks and open questions

1. **Anti-sycophancy / ADR 0005.** A model-authored plan that the engine merely validates is the open-set shape plus engine-bounded magnitude (the `consequence` descriptor precedent), but a plan that fixes WHO speaks starts to look like engine-authored content if the checker ever overrides it. Rule proposed: the checker may only REJECT or TRIM (drop an illegal participant or effect), never add.
2. **Rejecter models.** The production narrator ignores forced `tool_choice`; every part of this pipeline therefore has to be FE-executed, not model-called. That is a strength of the design (the commit never depends on the model calling a tool) but means the PLAN call must work on the cheap utility model, which has been reliable for extraction JSON (10 of 10 merged calls parsed in the live arm).
3. **Latency** (above): needs the C2 measurement; if it exceeds about 2 seconds it can run in parallel with the first narration token only for the non-gating parts, which weakens the guarantee.
4. **Decision (6) from the card** (plan on every turn, or scene turns only): recommended scene turns only (engaged player-houseguest turns, arrivals, plan-less small talk skipped), because ceremonies are already planned by the engine and OOC / casting turns have nothing to plan.
5. **Belts.** None is removed in C1 to C4. #1782's rule stands: a belt is demoted to an alarmed fallback and deleted only after a clean live season.
6. **Prompt budget.** C4 adds plan text to the per-turn tail (the volatile block, already after the cache boundary since #2570), not to BASE.

## Proof plan (all offline except one cheap live arm per slice)

Golden replays of recorded turns through the checker; mutations (a plan naming a sleeper, an absent person, a closed-set outcome, an illegal move must each be rejected); determinism (headless byte-identical, every slice); the Vault sentinels extended to the plan and the claim check inputs; the existing live-arm kit for C2 to C4 with a hard $0.30 cap per arm.

## Ask

Approve C1 to C3 (the schema and checker, shadow measurement, commit-from-plan) as the first build, with C4 and C5 decided after the C2 numbers. I will not spend model money on C2 without the Coordinator's go (about $0.10).


---

# Revision 2026-11-26 (ORW-1011): decide, commit, then narrate

Status: DESIGN for Kevin and Ryne to review. No code. Cards: ORW-1011 (this), ORW-1014, ORW-934, ORW-1008, ORW-1009, ORW-1010, ORW-408, ORW-749. Rulings that bound it: ADR 0005 (open set stays open), ADR 0009 ruling 1 (NPC movement is narrated, the engine records it), ADR 0016 (model choice), ADR 0003.

This revision extends the plan-then-check scoping above; it does not replace its checks, its proof plan or its rule that a belt is demoted before it is deleted. What changes is the first step. The scoping doc proposed a separate PLAN utility call. The review and Kevin's direction found a cheaper and more direct route: the narrator model itself is forced to call a tool first.

## 1. The problem, with prod numbers

Prod, season on 33.13, 16:40Z to 20:00Z on 2026-11-26, 47 turns:

* The narrator called a game tool on 5 of 47 turns.
* Belts did the rest: auto-record-scene 31, auto-move-player 13, desync-reground-voiced 9, forced-advance 6, stall-nudge 6, auto-move-npc 5.
* The board and the prose disagreed (desync) on 8 of 47 turns.
* Belts carried 89% of the turns.

Kevin, 2026-11-26: "I'm very concerned that we've had to leverage fallback code for such a high percentage of the turns and I continue to be concerned about the tool calling rate." And on ORW-1014: "I want to get that 89% number down. And I want us to use tool calling."

Why it happens, from the code at main 6611957d:

* DeepSeek V4 is on the rejecter list (`_TOOL_CHOICE_REJECTERS`, `agent_loop.py`), so forced `tool_choice` is skipped for the live narrator. The list dates from the always-thinking audit (ADR 0016). `llm_core.py` has since sent thinking-disabled on deepseek.com. A probe on dev on 2026-11-26 (ORW-1014) got HTTP 200 and the right call for `auto`, `required` and a named function. The block is stale.
* 42 tools are sent every round, so an unforced narrator mostly writes prose and skips the call.
* Several belts are themselves LLM JSON extractions run after the prose (`agent_loop.py`, around lines 3825 to 3949). The prose comes first and the effect is inferred from it.
* The player-move seam has two defects (ORW-1008): a mention of the player's own bed moves the player (the seam near `GameSessionAdapter.ts:8121`), and a plain "go to X" can fail through quote stripping (`playerMoveIntent.ts:172`).

## 2. The architecture

One turn, in order:

1. **Act first.** Before any prose, a forced tool round (ORW-1014 PR 2). The narrator must call exactly one tool from a small closed set of player acts: move, search, claim a bed, go to sleep, answer a pending step, advance, or `noAction`. Forcing needs the mode-aware rejecter fix (ORW-1014 PR 1): allowed on api.deepseek.com with thinking disabled, kept off for reasoner or thinking-on routes, with a canary that fails if DeepSeek rejects again. The round sends only the closed set, not 42 tools.
2. **Commit before narrate.** The engine validates and commits the call through the normal dispatcher with `expectedBeatSeq` and an idempotency key (the ORW-419 seam, the precedent in the scoping doc above). The checks are the ones the dispatcher already applies.
3. **Narrate committed facts.** The narration round gets the committed result as facts to voice: where the player now is, who is there, what time it is. The narrator writes the words, never the outcome of a closed-set act. A second call to the same tool is a no-op by the idempotency key.
4. **NPC-side belts stay** (ADR 0009 ruling 1). Houseguests wander, talk and act in the open set, and the narrator records that through the existing tools and belts. "Few or no tools" is not a goal. The goal is that the player's own closed-set acts never depend on a belt.
5. **Deals** (ORW-749). The consent roll needs the houseguest's reply, so the engine pre-rolls the stance before the narration and hands it to the narrator as a hidden bound. The deal itself is committed after the reply, by the same commit path.
6. **Search is an engine lever** (ORW-934, Kevin's spec, below).
7. **Pre-display check** (ORW-408) and the remaining belts stay as a backstop. Every belt firing stays counted in the sync ledger.

### Kevin's search spec (ORW-934, 2026-11-26)

Kevin: "I don't love the find within two turns directive... what I don't want to happen is me leading the search as the player and then the engine or narrator having to like teleport the character to where I am or teleport me to where they are... I'd rather just kind of like fast forward a bit and like oh we looked in this room this room this room didn't see them ended up being in the bedroom something like that I do not want any type of like forced movement into a place without it narratively making sense."

How the design meets it:

* `search` is one act in the closed set. The engine plans a route room by room: the last real sighting first (`lastSeenAt`, sightings), then nearby rooms by `roomsBetween` (`house.ts`), then the leads in `houseSearchView`.
* Each step is a real move on the board and costs clock time, and the clock rules for waits and interruptions apply. The engine commits the whole route before the narrator writes; the narrator voices one compressed passage: rooms checked, who was there, where the person turned up.
* No teleport either way. The player moves only along the committed route. The target is only where the engine has the target. If the target moves during the search, the route reflects it.
* A tip is real only if it comes from a recorded sighting (no invented sightings, ORW-1009). A stale tip is fine; the search continues from it.
* No fixed turn limit. The search ends when the target is found or when the target is somewhere the player cannot go (the Diary Room, a closed private talk), and the player is told so plainly. The player can stop or redirect at any point.

## 3. The review holes and the answers

The adversarial review (Fable, 2026-11-26, verdict "sound with changes") found nine. Each one and where this design answers it:

1. **Search needs an engine lever, not one action per message.** `movePlayer` is a single jump and the clock is billed once per message. Answer: section 2, item 6; the route is committed as a series of moves with clock cost per step.
2. **It duplicates ORW-223 part C and ORW-42.** Answer: this is a revision of that doc, not a fork. Its checks (CHECK the plan, CHECK the prose) and its proof plan stay.
3. **The diagnosis is half right: belts are already LLM extractions, and the seam already resolves moves before the narrator.** Answer: slice R0 fixes the two seam defects first and replays the 47 prod turns through `resolvePlayerMove` offline, so the numbers say how much is seam bug and how much is missing calls. "Nobody has claimed a bed" is intended text while the circle is open, and it is left alone.
4. **ADR 0005: a closed action list on every message flattens the open set.** Answer: the act-first set is closed-set player acts only (move, search, bed, sleep, pending answers, advance). Anything else is `noAction`. When the narrator is unsure it picks `noAction`; it never asks the player to disambiguate, and it never forces the player's binding pick. Speech and social play stay open and are recorded verbatim as today.
5. **Deals need the houseguest's reply.** Answer: section 2, item 5 (pre-roll, commit after the reply).
6. **NPC-side belts stay.** Answer: section 2, item 4.
7. **"Belts under 5%" is a vanity number.** Belts are success-gated, the player-move-intent belt counts as one, and no belt is removed in this work. Answer: the bar in section 6 uses correctness counts, and the belt rate stays as an alarmed health metric, not a target.
8. **Classifier risks: speech versus action, multi-action, injection, outage, latency, a wrong pre-commit narrated as fact.** Answer: section 4. Note the structural change from the first proposal: there is no separate classifier call. The narrator itself makes the forced call, which removes one model hop.
9. **The tool_choice probe.** Answer: done on 2026-11-26 (ORW-1014). Forcing works with thinking off. The first slice makes the fix permanent and tested.

## 4. What stays open (ADR 0005), failure modes, fail-soft

**Open set.** The engine commits only closed-set player acts. It never classifies speech, tone, persuasion or alliances into acts. The act-first round has no tool for them, so there is nothing to flatten. The checker may only reject or trim a call, never add one.

**Failure modes and what happens:**

* The forced call is wrong (a false commit): the checks reject an illegal act. A legal but wrong act (the player was talking about a room, not going there) is the worst case. Mitigation: the move and search tools require an explicit destination or target that resolves in the engine, the prompt for the round says to choose `noAction` when the message is talk, and false commits are weighted heavily in the replay corpus. A committed move is narrated as fact, so the player sees it at once and can say so; the correction is a normal move, never a hidden rewrite.
* The model returns no call, or an invalid one: one retry with the rejection reason, then no act is committed and the turn proceeds as today with the old belts armed. A ring entry records the soft fail.
* DeepSeek rejects forcing again or the call fails (outage, HTTP 400): fall back to the deterministic parsers (`playerMoveIntent`, the bed and sleep detectors) and the existing belts. The canary from ORW-1014 raises the alarm.
* Latency: the act-first round is serial before the first narrated word. It sends a small tool set and no thinking, so it should be shorter than the old 42-tool round, but there is no measurement yet. Section 6 sets the bar and the dev run measures it.
* Injection: the player's message is untrusted input to the round. It goes in behind the same fence as the extraction calls (`_EXTRACTION_UNTRUSTED_FENCE`), the round has no tool that can write free text into the board, and every argument is an engine ID or a room, validated by the dispatcher. The Vault stays out of the round; it sees Vault-free state only.
* Multi-action messages ("go to the kitchen and then sleep"): one act per round. The first act commits; the rest of the message is narrated as intent and is picked up by the next turn or the existing belts. Whether to allow a second round is an open question for Ryne below.

## 5. Rollout

All behind flags, default off. Dev first, then prod.

1. `ORWELL_ACT_FIRST` (ORW-1014 PR 2) and a separate flag for the search lever, each off by default. Dev only.
2. Dev replay: the same labelled scenarios run before and after on dev, against the prod baseline above. No prod change until the dev numbers meet the bar in section 6.
3. Prod: flip one flag at a time, with the belt rate, desync and the unrecorded and unnarrated counts on the admin page. Roll back by flag. Ryne approves the flip.

## 6. Measures and the success bar

Measured per 100 turns on the dev replay and then in prod:

* **0** player acts narrated but not recorded.
* **0** player acts recorded but not narrated.
* Desync turns from 8 in 47 to near 0.
* Tool-driven share: the share of engine changes made by a narrator tool call versus a belt, per turn (ORW-1014 metric, admin page). Baseline: a tool call on 5 of 47 turns. This is reported, with no fixed target, since NPC-side belts stay.
* Latency to first token, p50 and p95, before and after.
* A labelled replay corpus: the 47 prod turns, relabelled by hand with the act each player message performed (turn text stays out of the repo and out of the board; the labels and ids go in). Precision and recall per action, with false commits weighted above misses.
* The non-collapse tests (ADR 0005) stay green, and the belt rate stays counted and alarmed.

The bar: the first two counts at 0 on the replay and on one prod day, desync near 0, p95 latency no worse than the old path by more than the bound Ryne sets (open question 3), and precision on committed acts at or above the level Ryne sets (open question 4).

## 7. Slices and cards

Each ships alone, behind a flag, small PRs.

* **R0 seam fixes and the offline replay**: the bed false move, the quote stripping, the 47-turn replay through `resolvePlayerMove`. Cards ORW-1008 (move seam), ORW-1010 (beds).
* **R1 unblock forcing**: mode-aware rejecter, conformance test, canary, the narrator-versus-belt metric, the inventory of forcing sites. Card ORW-1014 PR 1.
* **R2 act-first round**: the closed-set forced round, commit, narrate committed facts, flag off. Card ORW-1014 PR 2.
* **R3 search lever**: route planner, clock cost per step, committed route, one compressed narration. Card ORW-934. Depends on R2 for the commit path.
* **R4 sightings and placement**: no invented sightings, dropped folds, so tips and routes are true. Card ORW-1009.
* **R5 pre-display check**: the prose check before the player sees it, so a wrong narrated act is caught. Card ORW-408.
* **R6 deals**: pre-rolled stance, commit after the reply. Card ORW-749.
* **R7 dev replay, measures, prod flip**: the corpus, the bar in section 6, the rollout in section 5. Card ORW-1011.

## 8. Open questions for Ryne

**For Ryne to decide.** Kevin has the same list.

1. **The closed set.** Is move, search, bed, sleep, pending answer, advance and `noAction` the right set? Anything to add or drop?
2. **Multi-action messages.** One act per turn with the rest left to the next turn, or allow a second forced round when the message clearly has two acts?
3. **Latency bound.** How much extra time before the first narrated word is acceptable at p95?
4. **Precision floor.** What precision on committed acts is acceptable before prod, given that a false commit is narrated as fact?
5. **A wrong commit.** When the player says a committed move was not what they meant, should the engine offer an undo, or is a normal move enough?
6. **Search without a sighting.** When no sighting exists for the target, should the route start from the room list in a fixed order, or should the narrator say the player has no lead and stop?
7. **Prod flip.** Is a one-day prod window per flag, with rollback by flag, the right gate, and does Ryne sign it off?


---

# Revision 2026-11-28 (ORW-1014): what prod's first real session showed, and the written definition of engine-driven

Status: BUILT in PR "ORW-1014 prod-1" (flag-gated work unchanged; the fixes below are not behind a flag). Source: the prod journal and ledger of CT 205 for the first real session (Ryne, 2026-11-28 00:35Z to 02:42Z, 26 player messages, act first ON since 2026-11-27 ~01:00Z). Codes, counts and ids only: no player text and no cast text is quoted anywhere in this section.

## 1. Where the 26 messages went (the metric gap)

* 13 messages were the casting interview (00:35Z to 01:04Z). Casting turns are never ledgered by design (`park_pending_unledgered_turn`, ORW-186), so they have no `driver=` line. They were still handed to act first: 13 act-first lines, 2 of them paid model calls (noAction, 666 and 744 ms) on a board that does not exist yet.
* 13 messages were game turns (01:13Z to 02:42Z). 12 have a `driver=` line. The 13th (01:48Z, the only act-first `acted` turn, a move to the kitchen) died with `UnboundLocalError: _direct_applied` in `_stream_agent_loop_impl`: the own-round tail reads `_direct_applied`, which only the bedtime, nap and pending-act branches bound. The slot had already committed the move, so the turn crashed after its commit and before its ledger row. Its belts (`act-first:moveTo`, `premiere-arrival-pre-release`) landed on the NEXT turn's row. This crash would hit every act-first turn whose only acts were slot commits (a move, a bed claim, a search).
* So: 12 lines = 13 game turns minus 1 crash. The metric was missing a turn, and the missing turn was the one real tool-driven turn.

Fixes: `_direct_applied` is bound before the round loop (AST test pins it); act first skips the casting interview (`state.started is False`); `record_unledgered_turn` writes a row for any live-game turn that never wrote one (reason failed / closed / no-record; its belts stay on its own row, an `act-first:<tool>` belt counts as the model's tool call); casting messages are counted (`castingTurns`) and logged; the `driver=` line gains `flow=` and `unledgered=`; the ledger totals gain `engineFlowTurns`, `unledgeredTurns`, `castingTurns`.

## 2. The belts that fired

Per game turn, by message index (belts that count under `ENGINE_CHANGE_BELT_PREFIXES` are `auto-*`): 99 auto-record-scene; 100 auto-move-npc, auto-record-scene; 101 auto-record-scene; 102 crashed (no row); 103 auto-record-scene; 104 auto-record-scene; 105 auto-move-npc, auto-record-scene; 106 auto-move-npc x4, auto-record-scene; 107 auto-move-npc x4, auto-record-scene; 108 auto-move-npc x4, auto-record-scene; 109 auto-record-scene; 110 auto-move-npc x4, auto-record-scene, plus the narrator's own advanceGame (forced, honored); 111 the narrator's advanceGame only. Rows 99 to 109 except 102 are `belt` (10), 110 is `both`, 111 is `narrator`.

* `auto-record-scene` fired on 11 of 12 rowed turns. It is the belt that makes 10 of the 12 turns `belt`: it is a JSON extraction from the prose after the reply (`_auto_record_scene`), standing in for the narrator's `recordInteraction`. A player cue does not trigger it: it is the narrator's omission, and the player's act is open-set speech.
* `auto-move-npc` fired on 6 of 12 turns (18 NPC moves): after-the-prose extraction of NPC movement, ADR 0009 ruling 1 (NPC movement is narrated and the engine records it).
* `premiere-arrival-pre-release` fired on 6 of 12 turns, the post-reply premiere-arrival belt once, `ceremony-unvoiced-reground` on 5, `desync-reground-voiced` on 6, `presence-wall` once, `companion-reseat` twice, `advance-stall-nudge` once. NONE of these is in `ENGINE_CHANGE_BELT_PREFIXES`: they were never counted as belt-driven.

So the premise "mostly premiere-arrival-pre-release" is about the belts that FIRED, not about the belts that made the turn `belt`. The driver label was already right about the premiere.

## 3. The written definition of engine-driven (old and new counts)

Scheduled engine flow = a commit the show's own staged schedule makes with no player act and no narrator omission behind it: the premiere entrance and toast arrivals released by the engine before the reply, or held over to the next turn's release. Names: prefix `premiere-arrival-` (`SCHEDULED_FLOW_BELT_PREFIXES`). It is reported as its own count (`engineFlowTurns`) and is not a narrator failure. Nothing that stands in for a player act or a narrator call (`auto-*`, `forced-advance*`, `player-move-intent`, the direct belts) is ever scheduled flow; advisory belts (re-grounds, nudges, walls, steers) stay advisory.

Counts on the 12 rowed prod turns (13 with the crashed one):

| rule | tool-driven (narrator or both) | belt-driven (belt or both) | none |
| --- | --- | --- | --- |
| old, as logged | 2 of 12 | 11 of 12 (10 belt, 1 both) | 0 |
| new definition, same rows | 2 of 12 | 11 of 12 | 0 |
| new definition, crash row restored | 3 of 13 | 12 of 13 | 0 |

The recount does not move the numbers because the scheduled-flow belts were never in the belt count. The only change is the crashed turn, which is a real tool-driven turn counted back in. No belt was relabeled to improve a number.

## 4. Act first: the 13 game-turn decisions

Outcomes: 1 acted (turn 102, correct: a move to a named room), 8 noAction (680 to 1345 ms each), 4 skipped no-cue. Judged against what each message asked, as codes:

* noAction correct, no closed-set act in the message: 105, 106 (no destination named), 109 and 110 (talk about choosing a bed later: a plan, not a claim), 111 (a question).
* noAction, the message does ask for something the closed set does not have: 99 (the player's own premiere entrance: the engine schedules it, `maybe_release_premiere_arrival`; the player's entrance is the narrator's to voice, section 2 item 4 of the revision above; no tool is missing, the lever is engine-owned), 107 (tour all the bedrooms: no room named, a tour is the ORW-934 route lever without a target, not in the closed set), 108 (a themed room name; it is a move if the name resolves, the lane could not read this season's room names from prod, so it is not counted as a miss).
* The closed set is therefore not what holds the share down. The two belts that make the turns `belt` (`auto-record-scene`, `auto-move-npc`) are open-set effects (who was in the scene, what it did to relationships, where NPCs went). Section 4 of the revision above excludes them from the act-first set on purpose (ADR 0005: the act-first round has no tool for speech or social play) and ADR 0009 ruling 1 keeps NPC moves narrated. Adding them is not allowed by the design as written; the design's own route is commit-from-plan (part C, slice C3, with the CHECK steps), which needs Kevin and Ryne to approve it. It is the single change that moves the share, and it is listed in section 6.

## 5. The no-call pre-filter

9 of 13 prod calls ended noAction at 0.7 to 1.3 s each. `can_commit_nothing` skips the call when `validate_calls` would reject EVERY call the model could make: a move or a bed claim needs a room the player's own words ground, a search needs an active houseguest's name in the words, a sleep needs a sleep word, and any offered step answer (advance, competition, deal) keeps the call. It mirrors the validator, so it cannot skip a real act: on the 880-row replay corpus no row that expects an act was skipped (0 of 181 newly skipped rows that had a cue). On the 13 prod game turns it skips 4 to 7 of the 8 noAction calls, depending on where the player stood (the room is not in the journal).

## 6. Gates (Kevin's: 98 percent correct, at most 1 wrong commit per 200, added p95 at most 2 s) and the share

Dev replay on CT 204 with the DeepSeek API, 880 rows (the 855-row labelled corpus plus the 25 prod messages from 00:35Z on, as codes): correct 865 of 880 (98.3 percent), wrong commits 0 (0.00 per 200), model calls 608 of 880 (272 skipped, 31 percent, against 81 skipped, 9 percent, before the filter), added latency over all turns p50 689 ms, p95 1176 ms (the call alone p50 800, p95 1218 ms; the endpoint was slower than on 11-26, the earlier run had p95 939 ms). The 15 misses are the same classes as before (a find-someone-in-a-room move, a typo, a hedge); none is a wrong commit.

Projected tool-driven share on the prod session: before 2 of 12 (17 percent) as logged; with the crash fixed 3 of 13 (23 percent). The pre-filter changes cost and latency, not the share. The remaining 10 belt turns each carry `auto-record-scene`; only commit-from-plan for scene records and NPC moves (C3, needs approval) can take the share toward the ceiling of 12 of 13, and that figure has no corpus yet: the scene-record labels do not exist.


---

# Revision 2026-11-28 (ORW-1011 C3): commit scene records and planned houseguest moves from the plan

Status: BUILT behind `ORWELL_COMMIT_FROM_PLAN` (or the setting `commit_from_plan_enabled`), default OFF. Code: `frontend/src/plan_commit.py`. Codes and counts only; the corpus lines are invented.

* **Slot** (`chat_helpers`, after the player's own move slot, before the briefing): one small JSON call names the scene (who, kind, one sentence of the PLAYER's own act; no edges, no numbers) and any houseguest the player's words send to a named room. The C1 checker (`check_plan`) trims it; extra guards: a scene is with the people the player named (or the one person present), a planned move needs the houseguest and the room in the player's own words, an arrival into the player's room needs a request to come. Planned moves go to `move_houseguest` (the engine stays the authority). Nothing is added, only trimmed.
* **Loop half** (after the turn-start settle): the scene is STAGED on the same deferred-settle ledger the scene belt uses (a regenerated take never double-folds), a `recordInteraction` tool event stands the scene belt down for that turn, and the narrator gets a production note of what is already recorded. The NPC-move belt is untouched (extra narrated moves still reach it).
* **Metric**: commits count as `plan-commit:<tool>`, never as a narrator call or a belt; `classify_driver` has a `plan` label and the totals gain `planOnly` / `planCommitTurns`. A belt that fires beside a plan commit still counts as a belt.
* **Fallback**: any skip, timeout, error, unparsed answer or empty plan commits nothing and the belts run as before.
* **Moves are direction-neutral** (ADR 0009, section 3.10 of the resiliency plan): a planned move is a proposal validated for plausibility, then recorded. No rule here says who may move people. TODO for the occupancy record: deferral of a losing proposal, a houseguest's decline, the per-move reason and travel time.
* **Known trade-off**: a pre-reply scene carries a kind and the player's own act only; the richer fields the after-the-prose belt can read (edges that depend on how a houseguest reacted, statements) are not in it. The promise backfill still runs on a recorded turn.
* **Gates** (dev replay, `frontend/scripts/orw1011_c3_replay.py`, 250 rows including labelled 11-28 shapes): see the PR and the ORW-1011 comment for the numbers.
