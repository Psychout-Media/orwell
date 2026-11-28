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

## 3. Principle (within ADR 0005)

ADR 0005 stands: the open set (what people say and feel, creative acts nobody coded for) stays
narrator-authored and is *recorded*, never normalized. This plan applies only to the **closed set of
physical and structural state**:

- where the player and each houseguest are, and who is present;
- the clock, time passing, sleep and waking;
- bed ownership;
- alliances, deals and pacts (a binding agreement);
- ceremony and competition steps.

For the closed set: **the engine decides first; the narrator describes what was committed.**

## 4. Three pillars

### Pillar 1: engine-first turns (prevention)

1. **Commit, then narrate.** Each turn: (a) decide the player's closed-set acts (act first's slot), (b)
   commit them through the real tools, (c) narrate from the committed delta and the current state. The
   narrator gets the delta, not freedom to invent closed-set state. This is plan-then-check part C
   (C3, commit-from-plan), which Kevin approved for prod on 11-27.
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

## 7. Decisions needed

For Ryne (his game, his word equals Kevin's):
1. Is the closed set in section 3 right? Anything to add (for example competition outcomes) or remove?
2. On a claim-without-commit mismatch the player asked for, commit it (the default here) or always
   regenerate and let the player ask again?
3. The day recap when a day closes outside a narrator turn: voice it at the start of the next turn (the
   default here), or show it as its own panel?

For Kevin:
4. The nightly bot seasons: approve after seeing one season's measured cost.
5. Alerts: push to Kevin's phone for every crash, or only streaks (stuck, repeated mismatch) plus a daily
   digest?

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
