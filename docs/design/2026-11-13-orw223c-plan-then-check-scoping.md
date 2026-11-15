# ORW-223 part C - plan, check, write, check, commit: scoping (no code yet)

Status: SCOPING for the Coordinator, 2026-11-13, Overseer A. Nothing is built. No paid calls were made for this note; every number below is from runs already on record (the 2026-11-12 live arms and the offline checks).

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
