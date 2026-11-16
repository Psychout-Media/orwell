# Live-run testing (ORW-109)

A real narrator, a staged build, a written pass bar, one report. CI never talks to the real narrator, so this is the only gate that sees tool under-calls,
narration that runs ahead of the engine, and stalls. Roles only; no cast name is hard-coded.

## Tiers

- **Short tier (this slice, `live_short.py`):** after every dev update. Casting -> premiere -> an early "run the competition" ask -> the engine clock is jumped
  with the engine's own player API (turn-in / time-passing) to the veto morning of Week 1 -> four real chat turns (the draw, then the house waiting for the
  competition). About 10 minutes, a few cents on DeepSeek, images OFF.
- **Full week (not built yet):** a whole week played like a real player, before each playtest and release. The short tier should grow eviction night and the
  finale before this one is started.

## Automatic run: `run_short.sh`

`scripts/live-run/run_short.sh [--if-new] [REF]` is the one command: stage origin/REF (default main) on the rehearsal rig with fresh data and images OFF, play
`live_short.py`, stop the rig by PID, and print one line, `LIVE-SHORT PASS|FAIL|COULD-NOT-RUN <sha> <report path>` (exit 0/1/2; 3 = another run holds the rig).
`--if-new` skips a sha that was already run, so a watcher can call it after every dev update without repeating itself. About 8 minutes, no agent turns.
Hook it to whatever notices a dev update (the merge watcher or a deploy hook) and read the one line; open `report.md` only on FAIL.

## After every dev update: `dev_watch.sh` (ORW-109)

Dev auto-deploys main, so a new `origin/main` sha is a dev update. `RIG_SLOT=2 scripts/live-run/dev_watch.sh` polls main every 10 minutes (`POLL`), runs
`run_short.sh --if-new main` on slot 2 when the sha is new, and appends the verdict line to `$RIG_STATE_DIR/watch-2.log`. The agent on watch posts each run's
report on the board and cards every FAIL the same day. `--once` does a single poll (for a cron line). Each run is capped (`RIG_SPEND_CAP`, default $0.50,
estimated high from the model-call archive by `spend_guard.py`); a capped run prints `LIVE-SHORT CAPPED` (exit 4).

The report opens with the header the vault note "Live Run Pass Bar" asks for: build sha and the engine's `/health` flags, the time in UTC and Arizona, the
model, the spend against the cap, the check table mapped to the bar's T-numbers, and what the short tier does not cover. An older build is run with a ref
like `main~55` (`run_short.sh main~55`), which is how the known-bad proof below was made.

## Running it

1. Stage the build on the rehearsal rig with fresh data (kit: `stage2.sh`; add `MERGE_PR=<n>` or `MERGE_BRANCHES="..."` to include an unmerged change).
   Set `image_gen_enabled=false` in the staged `frontend/data/settings.json`. Only one run at a time: the rig uses engine :18765 and FE :17000.
2. `python3 scripts/live-run/live_short.py --run-dir <the staged run dir>` (use the FE venv for Playwright; `TMPDIR` on disk if `/tmp` is a nearly full tmpfs).
3. Read `report.md` in the run dir. Exit code: 0 pass, 1 fail, 2 could not run. Stop the rig by PID when done.

## Rig slots (ORW-344): two playtests at once

The rehearsal kit used to have exactly one rig. It now has two, picked by ONE variable, `RIG_SLOT` (default 1), read by every kit and live-run script (`scripts/rehearsal-kit/slot.sh`):

| | slot 1 (today's rig, unchanged) | slot 2 |
|---|---|---|
| engine / front end | :18765 / :17000 | :18766 / :17001 |
| lock | `live-short/rig.lock` | `live-short/rig-2.lock` (beside it) |
| worktree | `$RIG_HOME/orwell-rehearsal` | `$RIG_HOME/orwell-slot2` (its own git worktree; `node_modules` and the FE venv are shared read-only from the main checkout, never written) |
| run pointer | `/tmp/claude-1000/a11_run` | `/tmp/claude-1000/a11_run_2` |
| run directories | `rehearsal-<date>` | `slot2-rehearsal-<date>` (a glob of slot 1's never matches them) |

`RIG_HOME` is the rig user's home directory: the main checkout (`orwell`), the worktrees, `orwell-playtest` and `.config/orwell/secrets.env` all live under it. It defaults to `$HOME` (the rig runs as its own user); set `ORWELL_RIG_HOME=<dir>` when the rig's files live elsewhere. A stage records it in the run's `slot.env`.

A stage writes `slot.env` into the run directory it creates, so the scripts copied there keep following THEIR run's slot. Slot 2 never creates, edits or reads slot 1's worktree, lock, pointer or run directories.

`scripts/live-run/week.sh` plays one whole Week 1 on the real narrator under a spend cap (`RIG_SPEND_CAP`, default $3, estimated from the model-call archive at a deliberately high rate; `spend_guard.py` stops the run by PID file when it is reached) and writes `spend.json` and `rig-stats.md` (the sent size per call and per turn, and the E22 rate) into the run directory. `RIG_DRY=1` stands the slot up, checks the front end and engine answer, and tears it down: no model calls, nothing spent.

    RIG_SLOT=2 RIG_DRY=1 scripts/live-run/week.sh          # prove a slot
    RIG_SLOT=2 RIG_SPEND_CAP=3 scripts/live-run/week.sh    # one capped week

## Pass bar (short tier)

A run PASSES when every FAIL check holds. WARN checks are listed in the report and do not fail the run.

| Id | Check | Severity |
|---|---|---|
| G1 | The game starts: the phase leaves `setup` after the casting messages | FAIL |
| G2 | The veto morning is reached (phase `veto-competition`) | FAIL |
| P1 | Production hold: asking to run the HOH competition before it is called leaves the engine without a HOH | FAIL |
| T1 | Every player message gets a settled reply (no missing, unsettled or timed-out bubble) | FAIL |
| T2 | Every reply is a real scene: at least 200 characters and not a guard's replacement shell ("feed glitched ... say that again") | FAIL |
| T3 | No machinery in a reply: no `npc:` id, `<think`, tool or lever name, `beatSeq`, "Vault" | FAIL |
| T4 | A reply slower than 120 s | WARN |
| T5 | A reply slower than 240 s | FAIL |
| T12 | Every houseguest gives their champagne toast before the premiere ends (Ryne, ORW-368; the bar's T12) | FAIL |
| T13 | Zero clocks: no reply names a clock time ("8:15", "9 am", "ten o'clock"); parts of the day only; the bubble's header stamp is ignored (Ryne, ORW-377; the bar's T13) | FAIL |
| T16 | Headcounts include the player (Ryne, ORW-376): a reply's house total ("16 of us", "fifteen houseguests left", "all 14 of us") must equal the engine's `whereabouts.counts.house` (player included) at the start or end of the turn. A claim that names the whole house is FAIL; an unqualified "N of us" (N >= 5) that is neither the house nor the room count is WARN; room counts ("the four of us at the table"), small huddles and a houseguest count with no house word are never flagged | FAIL / WARN |
| T17 | A recap every bedtime (0102, ORW-382), `--crossover` only: after the eviction-night bed, the engine's `dailyRecap` (materialized by the narrator's turnIn) has at least one highlight / surfaced / yourDay item (WARN when it is for another day than the one closed); the bed reply naming the evictee is N4 (WARN) | FAIL |
| T19 | The engine moves the player first (ORW-418/419), `--crossover` only: after "I walk to the kitchen." on the Week 2 morning (the living room if already in the kitchen) the engine has the player in that room; a move the engine refused in fiction (`playerMove.refused`) is WARN | FAIL |
| C1 | While the engine says the veto competition is not due, no reply narrates competition play (apparatus, rounds, eliminations, a winner) | FAIL |
| C2 | A veto-morning reply voices the draw | FAIL |
| C3 | A clock the reply states matches the engine's clock (within an hour) | WARN |
| C4 | No ceremony is voiced (key turn, nominations read) before the engine ran it | FAIL |
| C5 | Nominees named in the narration are the engine's nominees | FAIL |
| C6 | Everyone who speaks in the player's room is in that room per the engine | FAIL |
| A1 | Every houseguest is inside by the end of the premiere | FAIL |
| A2 | Arrivals keep progressing (no long flat stretch of the inside count) | FAIL |
| D1 | Day one is not skipped: after the premiere the clock still reads Day 1 | FAIL |
| K1 | No skipped time: a clock jump over an hour needs a bed or nap message, the 8am wake, the runner's own move, or a sanctioned ceremony (competition crown share, staged eviction ballots, the veto draw when the reply voices it). A jump of at most 4.5 hours in a message that also moves the phase (a beat played inside one message) is accepted too and listed as a note, so read the notes; this allowance never covers a competition crown, which is accepted only up to 1.5 hours and is otherwise a K2 failure | FAIL (notes for the sanctioned cases) |
| K2 | A competition is never crowned inside one message that also moves the clock by hours | FAIL |
| K3 | An event the schedule reports due fires within a few messages | FAIL |
| N1, N2, N5, N12 | A daytime goodnight does not end the day (N1); "hang out until morning" never reaches morning (N2); an early bed wakes before the house (N5); a nap stays in the day (N12) | FAIL |
| N4 | The bed reply names the evicted houseguest in the day in review | WARN |
| N7, N8 | The Nightfall card lists who is awake; the Whereabouts card shows no sleeper with the player. A missing card is recorded as `N7-widget-missing[<moment>]` / `N8-widget-missing[<moment>]` (for example `N7-widget-missing[morning]`) | FAIL / WARN when the card is missing |
| W2, W3, W10 | Only with `RIG_CROSSOVER=1`: a Week recap card after the bed, the HOH next in the afternoon, the bubble header shows the new week | FAIL |
| X0 | Only with `RIG_CROSSOVER=1`: eviction night is reached and Week 2 begins with no HOH | FAIL |
| T1c, T2b | A settled reply's bubble has its footer (T1c); a player request gets a scene, not a thin answer (T2b) | WARN |

## Deliberately not covered yet

- Hidden-information leaks beyond the machinery list (the Vault Wall is gated structurally in CI; this tier only catches visible leaks).
- Claims the engine did not do other than the pre-narrated competition (nominees named before the ceremony, a winner before the result). Add as checks when
  a staged break is available to prove each one fails.
- "The short run catches the ORW-10 stall on the old build" (the card's must-pass): needs the old build staged; not done.
- The BDD Auditor's approved-scenario pass bar: this table is a first draft from the live-run findings so far and is for the Auditor to amend.
