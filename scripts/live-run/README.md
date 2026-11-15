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
| worktree | `/home/ryne/orwell-rehearsal` | `/home/ryne/orwell-slot2` (its own git worktree; `node_modules` and the FE venv are shared read-only from the main checkout, never written) |
| run pointer | `/tmp/claude-1000/a11_run` | `/tmp/claude-1000/a11_run_2` |
| run directories | `rehearsal-<date>` | `slot2-rehearsal-<date>` (a glob of slot 1's never matches them) |

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
| C1 | While the engine says the veto competition is not due, no reply narrates competition play (apparatus, rounds, eliminations, a winner) | FAIL |
| C2 | A veto-morning reply voices the draw | FAIL |

## Deliberately not covered yet

- Hidden-information leaks beyond the machinery list (the Vault Wall is gated structurally in CI; this tier only catches visible leaks).
- Claims the engine did not do other than the pre-narrated competition (nominees named before the ceremony, a winner before the result). Add as checks when
  a staged break is available to prove each one fails.
- "The short run catches the ORW-10 stall on the old build" (the card's must-pass): needs the old build staged; not done.
- The BDD Auditor's approved-scenario pass bar: this table is a first draft from the live-run findings so far and is for the Auditor to amend.
