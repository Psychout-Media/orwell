# Resiliency plan: the story can't run ahead of the game

**Status:** PROPOSED. For Kevin and Ryne to approve before building (Kevin, 2026-11-27: "Plan first").
**Card:** ORW-1156 (the error class), with its child cards.
**Builds on:** ADR 0003 (the conversation is the game), ADR 0005 (split authority by openness), ADR 0009
(location and movement source of truth), `docs/design/undercall-seam-structural.md` (the belt stack),
`docs/design/2026-11-13-orw223c-plan-then-check-scoping.md` (plan-then-check, part C), ORW-408 (pre-display check).

## 1. What happened on 11-28

One prod session (Ryne, premiere night, 16 houseguests) hit most of the known failure shapes in about
three hours. Codes only, no chat text.

| Shape | What the story said | What the engine did | Card |
|---|---|---|---|
| Sleep | He slept; next morning | Never slept; 11:41pm Day 1; no bed | ORW-1150 |
| Day recap | (nothing) | Recap built, never voiced: the day never closed through turnIn | ORW-1155 |
| Bed | "The double's yours" (room of singles) | No bed owner | ORW-1138, ORW-1150 |
| Alliance | Formed | Folded from an NPC's offer before the player answered | ORW-1137 |
| Search | A walk to the storage room | Ran on a question, not an order | ORW-1135 |
| Search target present | Room renamed to cover a "blocked" search | Target was already in the room | ORW-1136 |
| Presence | Group together in the barrel room | Player alone; group elsewhere | ORW-1138 |
| Loop | "You're alone", 6 turns running | Beat stuck at 178-183 | ORW-1148 (fixed, 34.86) |
| Repeats | Every houseguest toasts twice | Arrival release ran every turn | ORW-1130 |
| Crash | (no reply for 10 minutes) | UnboundLocalError on act first's acted path | ORW-1125 (fixed, 34.76) |
| Silence | (no error shown, nobody alerted) | Kevin found it from the TV | ORW-1143 |

Turn drivers that night: 10 of 12 game turns were driven by after-the-fact belts (auto-record-scene on
11, auto-move-npc on 6). Act first ran 15 times and acted once.

## 2. The shared error class

**Narration is allowed to state a change of state that the engine never committed, and nothing checks it.**

A state change happens only when a tool runs. Tools fire in two ways, and neither reports a miss:

1. **Narrow intent gates** decide whether the player meant an act: hand-written patterns (the bed-intent
   regex refused "I would like to go to bed" and a bare "Sleep."), act first's prefilter and closed set,
   the search cue, the fold classifier.
2. **The narrator choosing to call a tool**, which it under-calls (the undercall seam doc).

When both miss, the narration writes the outcome anyway. The belts then guess from the prose, or the
story and the engine drift. Two related shapes widen the damage: **one-shot steps that are not
idempotent** (toasts) and **tests that never play a real turn with real phrasing** (the crash).

## 3. What is already decided, built and seen in prod (audit 2026-11-28)

Ryne, on the first draft: the closed-set question had already been "discussed extremely in depth"; audit what is built
first. This section is that audit. Every ruling below is on record; this plan applies them and re-asks none. Prod
evidence is the CT 205 journal, 2026-11-28 01:13Z to 04:45Z, 53 ledger rows on builds 34.01, 34.76 (from 03:42Z)
and 34.86 (from 04:39Z). Codes and counts only.

### 3.1 Who owns which state (decided)

- **Closed set, the engine is dictator:** competition outcomes, eligibility, who is HOH, nominated or evicted, the
  week, vote tallies, win conditions, persistence, the Vault. ADR 0005, Decision, "The closed set".
- **Weekly-loop ceremony facts are announced by the engine** (the chyron); a narrator restatement is dropped before
  display, right or wrong. ADR 0003, amendment D1 (2026-07-21).
- **Open set, the engine records faithfully and never normalizes:** the meaning, texture and consequence of social
  and creative play. The model proposes the consequence shape; the engine owns the magnitude. ADR 0005 principles
  1 to 4; CLAUDE.md, "Sync work must never flatten creative play".
- **Presence:** `this.presence` is the one source of truth (ADR 0009, D2, D4). **Superseded framing (Kevin,
  2026-11-27):** the one-way reading of ADR 0009 PO ruling 1 ("the narration says, the engine records") is replaced
  by the bidirectional design in section 3.10, still a draft for Kevin and Ryne. Kevin: "needs to be able to be 50/50.
  Bidirectional. And it needs to make sense in normal gameplay. Don't say who 'decides'."
- **Clock:** time of day is engine state and moves by play, never by wall time; a conversation's felt length is
  model-proposed and engine-bounded; a new day starts only at the 8am wake. ADR 0006 principle 1 and the 24-hour
  amendment.
- **Sleep:** the player always chooses his own bedtime and is never auto-slept; `turnIn` may answer held (ORW-258).
  ADR 0006 principle 6; Fable review on ORW-1011.
- **Beds:** no claim before the circle closes; the player claims in his own words once he is in the room. Feature
  0201 (Ryne, 2026-11-18).
- **Deals and pacts:** the engine decides who offers what; the player's own in-chat yes or no records a real deal or
  a refusal; an ignored offer lapses. PO log, 0123. The narrator never decides, speaks or acts for the player. ADR
  0003, amendment ORW-725.

### 3.2 Which acts the engine commits before the prose (decided)

- **Act first's closed set:** moveTo, search, claimBed, turnIn, advance (only when the engine names `requiredLever`
  and no social hold stands), ceremony-step and comp answers, a deal-offer accept or decline on a clear answer,
  `noAction` as the default. Never offered: meeting-answer and every card-only decision. Kevin Q1 and the Fable
  review, ORW-1011 comments (2026-11-26); `frontend/src/act_first.py`.
- **Speech, social play and alliances are not act-first acts.** Scoping doc, revision 2026-11-26, section 4.
- **Kevin's Q2 to Q7 (ORW-1011, 2026-11-26):** each act runs on its own merits, in order, skipped only when a blocked
  earlier act was its real precondition (Q2); at most 2 s added at p95 (Q3); at least 98% correct and at most 1 wrong
  commit per 200 (Q4); a wrong move is fixed by moving again, no undo (Q5); a search with no lead tries busy rooms
  first (Q6); "Fastest" rollout, the flag is the rollback (Q7).
- **No keyword gate narrows what the model may call;** the cue test only saves a call on a message with nothing
  act-like. `act_first.py` header; scoping doc, revision 2026-11-28, section 5.
- **Never force `submitDecision`;** an open pending or a social hold suppresses forcing. `undercall-seam-structural.md`,
  section 3, option (a).

### 3.3 What narration may and may not do (decided)

- May voice committed facts and author all the open texture. ADR 0003 principle 2.
- May not state a closed-set outcome first, contradict the board, or write the player's words, acts or decisions.
  ADR 0003 amendments; ADR 0009; ORW-725.
- **No visible historic conflict:** a legal narrated move is hard-folded; an impossible claim is caught before
  display; a next-turn re-ground is only a belt against repetition, never the player-facing fix. ADR 0009, PO
  ruling 2 and D3.
- The desync guard acts on closed-set claims only, never on creative prose. ADR 0005 principle 1 and test 5.

### 3.4 How omissions and contradictions are corrected (decided)

- **Error-correct the omission, never engine-author content:** the front end may pull the lever the model was asked
  to pull; it never writes the player's choice or the scene. CLAUDE.md, consequence-loop section;
  `undercall-seam-structural.md`, section 3.
- **Never ship an action that is narrated but never recorded.** CLAUDE.md, engine resilience paragraph.
- **A contradiction with a hard fact:** quietly rewrite once with the correction and show only the fixed reply; if
  the redo still fails, remove the smallest wrong part; never cut mid-sentence. ORW-408 owner ruling
  (`frontend/src/predisplay_check.py` header); the rewrite defaults ON (Kevin, 2026-11-26, #3343).
- **Social play must move the weights:** an engaged turn that recorded nothing gets `_auto_record_scene`. Feature 0055
  (owner, 2026-06-18).

### 3.5 What the belts are for (decided)

- A safety net, not the design. No belt is removed by structural work; a belt is demoted to a count-only watchdog and
  deleted only after a prod window with zero applied fires, its counter kept alarmed. T9 ruling (owner, 2026-07-21),
  `undercall-seam-structural.md` section 2.4; Fable review on ORW-1011.
- Counted only when applied (success-gated). CLAUDE.md; `frontend/tests/test_belt_telemetry.py`.
- The belt share is a health metric with no target. The bars are 0 player acts narrated but not recorded and 0
  recorded but not narrated. Scoping doc, revision 2026-11-26, section 3 item 7 and section 6.
- The houseguest-side belts (auto-move-npc, auto-record-scene) stay. Same revision, section 2 item 4; ADR 0009 ruling 1.

### 3.6 What plan-then-check commits to (decided)

- C1 the plan schema and a pure checker; C2 the plan call in shadow; C3 the front end commits validated plan effects
  with `expectedBeatSeq` and an idempotency key, and skips the extraction calls on plan-covered turns; C4 write from
  the plan; C5 check the prose; C6 ceremonies stay on their structured flows. The checker may only reject or trim,
  never add; no belt is removed in C1 to C4. Scoping doc, "Slices" and "Risks" 1 and 5.
- The 2026-11-26 revision replaced the separate plan call with the act-first forced round for the player's own
  closed-set acts. Built (ORW-1014), on in prod since 2026-11-27.
- The 2026-11-28 revision, sections 4 and 6: the remaining belt share is auto-record-scene and auto-move-npc, which act
  first cannot reach by design; only C3 for scene records and houseguest moves can move it, and it "needs Kevin and
  Ryne to approve it". No approval of that C3 is on record; the C3 build lane was stopped by Kevin on 2026-11-27.

### 3.7 The day recap (decided)

- A daily day-in-review fired at the player's own bedtime (`turnIn`), replacing the weekly recap. PO log, 0102
  redesign. Built engine-side and delivered as an in-chat narrator beat; the pop-up window the PO note describes is
  not built (ORW-824). Feature 0102 status.

### 3.8 Built, and whether it fired on 11-28

- **Act first** (`act_first.py`, `orwell_player_move.py`): 68 decisions: 3 acted, 27 noAction, 28 skipped (no cue),
  10 skipped (ungrounded). 2 of the 3 acted turns crashed (UnboundLocalError, 01:48Z and 03:37Z; fixed in 34.76, #3476).
- **Forced `tool_choice` at a closed-set beat** (undercall seam option a): fired 3 times, advanceGame.
- **Pre-emission outcome and count guard** (`chat_helpers.py`): held 3 engine-count claims.
- **Pre-display check, quiet rewrite ON** (`predisplay_check.py`, ORW-408): ran on 66 turns; 2 conflicts counted
  (part of day, asleep speaks); 3 sentences withheld (absent-present). It has no fact for a sleep, bed, alliance or
  deal claim, so those were never checked.
- **Presence wall:** 7 drops on 3 turns.
- **ADR 0009 D2 belt** (auto-move-npc): 26 moves on 11 turns; 2 unrequested arrivals dropped.
- **0055 belt** (auto-record-scene): 42 of 53 rows. 3 scenes folded as kind alliance from houseguests' talk before
  the player said yes (ORW-1137).
- **Next-turn re-ground** (desync-reground-voiced): 23 fires on 19 rows; desync on 13 of 53 rows; 5 presence-desync
  lines; 1 time-of-day drift line.
- **Premiere arrival release:** 15 rows (the toasts repeated, ORW-1130).
- **Bedtime gate:** refused the player's sleep request; `turnIn` ran only through the Coordinator's repair, so its
  recap was never voiced (ORW-1150, ORW-1155).
- **Deal back-fill:** 11 extractions, none found a deal.
- Turn drivers: belt 40, both 2, narrator 3, none 8.

### 3.9 The gap

**Decided and built, but not holding in prod:**
1. No visible historic conflict (ADR 0009): 13 desync rows were corrected on the next turn, which the ruling forbids.
2. Error-correct the omission for sleep: the bedtime gate refused real requests (ORW-1150; #3489, #3492, #3496 open).
3. The recap at bedtime: never voiced when `turnIn` ran outside a narrator turn (ORW-1155; #3491 open).
4. The player's yes for an alliance (0123, ORW-725): folded without it (ORW-1137; #3497 open).
5. Act first's own rules: 2 crashes on its acted path (fixed); the cue and grounding skips refused real acts (#3480
   merged, #3497 open).
6. Each premiere speaker once (premiere-entrances.md): repeated (ORW-1130; #3477, #3493 open).
7. Never narrated but not recorded: the pre-display check had no sleep, bed, alliance or deal fact (ORW-1156 part 1;
   #3498 open).

**Decided, not built:** C3 for scene records and houseguest moves (needs approval, 3.6); the recap pop-up (ORW-824);
houseguests placed in their rooms during the bed rush (0201, "Left for later"); a visible, retryable crash and a
real-loop test (ORW-1143, ORW-1144; #3490 open); per-gate miss rates and the belt watchdog path (ORW-1156 part 3).

**Correction to the first draft:** it put houseguest location, the clock and alliances in an engine-decides-first
closed set. That contradicts ADR 0009 ruling 1 (houseguest movement is narrated and recorded), ADR 0006's
model-proposed, engine-bounded durations, and ADR 0005 (alliance talk is open set; only a binding deal waits for the
player's yes). The rule this plan applies is the one in 3.1 to 3.4: the engine commits the player's own closed-set
acts first, records the narrated open texture, and no reply may show a change the engine did not make.

### 3.10 Location, both ways (APPROVED by Ryne, Kevin present, 2026-11-27 ~22:20 MST)

**Principle.** People move for two kinds of reasons, and both are equal sources of a move:
- **From the story:** the player asks ("let's all go to the kitchen"), or the scene moves someone (a houseguest
  follows, storms out, wanders in).
- **From the house:** the daily schedule (meals, routines), summons (ceremonies, competitions, a Diary Room call),
  sleep and waking, and each houseguest's own off-screen wants (seeking someone out, avoiding someone).

Every move, from either source, is a **proposal** to one occupancy record. Nobody else holds a copy: narration,
the "who's here" strip, act first and the pre-display check all read that record. No source outranks the other;
every proposal passes the same rules.

**Shared common-sense rules** (a proposal that fails one is not recorded):
1. **Awake:** a sleeping person does not move. Waking someone is its own event, from either source.
2. **Reachable:** doors and room rules hold (the HOH room, the Diary Room by call, a locked room).
3. **Travel takes time:** a next-door room costs a beat; across the house costs minutes on the clock. Nobody is in
   two places, and nobody teleports.
4. **Busy people stay busy:** someone mid-ceremony, or mid-conversation with the player, does not vanish unless the
   scene ends that moment.
5. **A reason:** every move carries a why (a schedule slot, a summons, a want, or the story's motive), so the story
   can say it and the engine can remember it.

**When the two sources want different things for the same person, in the same turn:**
1. Whatever the player has already seen stands; it is never silently undone.
2. A summons outranks an idle want or a passing story beat.
3. In the player's own scene, the story's version wins if it passes the rules (the player is watching). Out of
   view, the house's version wins (nobody is watching to contradict it).
4. The proposal that loses is **deferred, not dropped:** a house want is retried later, and a story move becomes
   "she'll be along in a minute", made real when the rules allow.

**Visibility, so nothing pops in or out:**
- A house move into or out of the player's room is handed to the narration as this turn's arrivals and departures,
  and must be shown; no one silently appears or vanishes.
- House moves out of view surface only when the player looks, asks or searches (ORW-934's search reads the record).
- A story move the record refused is caught before display (the ORW-1156 check), not corrected on the next turn.

**In normal play:**
- *"Let's all go to the kitchen."* Each person is checked: awake, not busy, reachable. Those who pass walk with him;
  the story says who stayed and why. People may also decline for their own reasons, a want the house supplies.
- *The dinner bell.* The schedule moves six people to the dining room; three of them were with the player, so the
  reply shows them leaving.
- *A dramatic entrance.* The story wants Jace to walk in. He's awake, one room away, not busy, so it's recorded
  before the reply is shown. If he were asleep, the reply is regenerated without him.
- *Eviction night.* The summons gathers everyone in the living room, whatever their wants.

**How we'd know it works:** zero presence mismatches shown to the player; zero people appearing or vanishing without
a line; a count of deferred moves and how long they wait; the "who's here" strip never disagreeing with the reply.

**Ryne's rulings (2026-11-27 ~22:20 MST, question boxes, Kevin present):** (a) the conflict rules above are right as
written: in view the story's version leads if it passes the rules, out of view the house's leads, a summons beats both,
what the player saw stands, and the losing move is deferred; (b) houseguests may decline the player's "let's all go"
for their own wants, often enough to feel real without blocking the player, and the story says who stayed and why.

The engine occupancy double-buffer (ADR 0009's deferred item, which Ryne approved on 2026-11-27) is built to this
design (approved). C3's houseguest-move part follows the same rules.

## 4. Three pillars

### Pillar 1: engine-first turns (prevention)

1. **Commit, then narrate.** Each turn: (a) decide the player's closed-set acts (act first's slot), (b)
   commit them through the real tools, (c) narrate from the committed delta and the current state. The
   narrator gets the delta, not freedom to invent closed-set state. This is plan-then-check part C
   (C3, commit-from-plan). Its approval is not on record (section 3.6); it is open question 1 in section 7.
2. **No claim without commit** (ORW-1156 part 1, in build). After generation, before display, extract the
   reply's closed-set claims and check each against the engine. On a mismatch, either commit the change
   through its tool (only when the player asked for it, never an alliance without his yes) or
   regenerate against the real state. Every check is logged and counted.
3. **Gates never veto.** A hand-written pattern may fast-path a clear act; it may not refuse one. The
   decision belongs to the model classifier, measured against labelled real messages (Pillar 2).
4. **One-shot steps are idempotent.** Arrivals, toasts, the champagne circle, the day recap, entrances:
   each carries an idempotency key and fires once (ORW-1156 part 4, in build).
5. **Unvoiced beats are replayed.** Any closed day or ceremony whose narration beat was skipped is voiced
   on the next turn, once (ORW-1155, in build).

### Pillar 2: real play as the test suite (detection before release)

1. **Every prod turn becomes a test.** Each real turn is saved as a code-only case (state before, the
   player's act label, the engine's committed delta, the turn's checks). No chat text is stored in the
   repo; labels are paraphrased codes. Before any build ships, the corpus is replayed against it; a turn
   that gets worse blocks the release.
2. **Per-gate miss rates.** Every intent gate logs its decision; against the labelled corpus, each gate's
   misses show on /api/admin/health (ORW-1156 part 3, in build).
3. **Nightly bot seasons.** Player bots on the DeepSeek API (never Claude, per the Orwell model rule) play
   full seasons on dev every night with varied personas and phrasing: polite, terse, typos, questions,
   changes of mind, creative open-set moves. A judge model scores every turn: story vs engine, stuck,
   repeated, contradicted, slow. Each finding becomes a card automatically, with the turn's codes. The
   cost of one season is measured first and brought to Kevin before it runs nightly.
4. **Real-loop tests are required.** Any change to the turn loop, act first or a belt must pass a test
   that plays real turns through chat_stream (fake model, real engine), one per outcome (ORW-1144).
5. **Dev is a real test bed.** A deploy hold during live checks and pre-cast test accounts (ORW-1145);
   images off by default on dev, with a daily spend cap (ORW-1146).

### Pillar 3: production that watches and repairs itself (limit the damage)

1. **A standing per-turn health watch.** The live watch the Coordinator ran on 11-28 becomes a service:
   per turn, it flags story vs engine mismatch, a stuck beat (3 turns), a repeated re-ground, act-first
   ungrounded skips, errors and slow turns.
2. **Instant alerts.** A push to Kevin and the Coordinator on the first crash per session and on any
   stuck or mismatch streak, with codes, never chat text.
3. **Visible, retryable errors.** A crashed turn shows the player an error with Retry; a retry narrates
   any committed change, never commits twice (ORW-1143, in build).
4. **Logged repair tools.** One command each, dry run by default, every run audited: regroup (shipped in
   34.86, `frontend/scripts/orwell_regroup.py`), commit sleep, replay a missed beat.
5. **Release discipline.** Every behaviour change ships behind a switch with a real-loop test; a broken
   prod is fixed forward at once; nothing is switched off without Kevin's OK.

## 5. How we know it worked (measured on real play)

| Measure | 11-28 baseline | Target |
|---|---|---|
| Closed-set claims without a commit, per 100 turns | to be counted by the 1156 replay | 0 |
| Turns driven by belts (game turns) | 10 of 12 | under 10% |
| Desync-flagged turns | 2 of 12 | under 2% |
| Stuck beat (3 turns, no advance) | 1 streak of 6 | 0 |
| Crashes shown to the player as silence | 2 | 0 (all visible, all alerted) |
| Gate misses on the labelled corpus | not measured | each gate under 2%, reported |
| Act first: correct, wrong per 200, added p95 | 98.3%, 0, 1.18 s (dev replay) | at least 98%, at most 1, at most 2 s |

## 6. Order of work (milestones, no dates)

1. **Stop the bleeding (in flight):** sleep intent (#3489), time-jump guard and bed words (ORW-1150),
   recap replay (ORW-1155), search and consent (ORW-1135-1137), group moves and idempotent releases
   (ORW-1138, 1130, 1140), visible crashes (ORW-1143), real-loop test (ORW-1144), no claim without
   commit (ORW-1156). Each deploys to prod as it merges.
2. **Watch and repair:** the standing health watch and alerts (Pillar 3).
3. **Engine-first turns:** C3 commit-from-plan, behind a switch, gated as act first was.
4. **Real play as the suite:** the prod-turn corpus as a release gate, then nightly bot seasons after
   Kevin sees the cost of one.

## 7. Decisions: what is already decided, and what is still open

The first draft asked five questions. Three were already answered on record:

1. **The closed set** (was Ryne's Q1): decided. ADR 0005's closed set, the ADR 0003 chyron facts, act first's set
   (Kevin Q1 on ORW-1011 and the Fable review), with presence, the clock, beds, sleep and deals as ruled in 3.1.
2. **Commit or regenerate on a claim without a commit** (was Ryne's Q2): decided. Commit when the player's own message
   asked for the act, through the same tool (error-correct the omission; never narrated but not recorded); otherwise
   quietly rewrite once, then trim the smallest wrong part (ORW-408 owner ruling); a legal narrated houseguest move is
   folded (ADR 0009 D3); never a decision, alliance or deal the player did not state (ORW-725, 0123). PR #3498 builds
   exactly this.
3. **The recap when a day closes outside a narrator turn** (was Ryne's Q3): decided. The recap fires at the player's
   bedtime (0102 redesign) and is voiced in chat until the pop-up (ORW-824) is built; #3491 voices a missed one once.
4. **Alerts** (was Kevin's Q5): decided by Kevin's standing rule "Keep Kevin Posted On Bug Chases" (push on a
   production hit, a root cause or a fix), so every prod crash pushes.

**Still open, for Ryne** (none of these is on record):

1. **Approve C3 for scene records and houseguest moves?** The validated plan's scene record and moves are committed
   by the front end before the prose, and auto-record-scene and auto-move-npc stand down on plan-covered turns. It
   is the one change that moves the belt share (scoping doc, revision 2026-11-28, sections 4 and 6). Behind a flag,
   gated like act first.
2. **Build the engine occupancy double-buffer now?** ADR 0009 deferred it ("Open questions" 1) until houseguest
   relocations were frequent enough to jar. On 11-28: 26 narrated houseguest moves on 11 turns, 5 presence desyncs
   and a 6-turn re-ground loop. Revisit now, or keep the front-end freeze?
3. **The act-first expansion order.** The Fable review proposed nap, hangOut, the Diary Room, offer cards,
   askToTalkAlone and entering a closed room next, with follow only after houseguest-move commits. Kevin asked for the
   review; no owner has approved the order.

**Still open, for Kevin:** the nightly bot seasons, approved only after he sees one season's measured cost.

## 8. Risks

- **Over-correction flattens the game** (the ADR 0005 worry). Mitigation: only the closed set is
  checked; open-set content stays narrator-led; every regenerate is counted, and a rising regenerate
  rate is itself an alert.
- **Latency.** The claim check and commit-first add work per turn. Mitigation: the act-first budget
  stands (at most 2 s added at p95); the claim check runs on the already-built reply with a cheap model or
  rules, and its latency is measured.
- **Corpus privacy.** Real turns become tests only as codes and paraphrased labels; no chat text, cast
  bios or player names are committed.
- **Cost.** Bot seasons and judges spend model tokens; measured first, approved by Kevin.
