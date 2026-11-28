# Live-run testing (ORW-109)

A real narrator, a staged build, a written pass bar, one report. CI never talks to the real narrator, so this is the only gate that sees tool under-calls,
narration that runs ahead of the engine, and stalls. Roles only; no cast name is hard-coded.

## Tiers

- **Short tier (this slice, `live_short.py`):** after every dev update. Casting -> premiere -> an early "run the competition" ask -> the engine clock is jumped
  with the engine's own player API (turn-in / time-passing) to the veto morning of Week 1 -> four real chat turns (the draw, then the house waiting for the
  competition). About 10 minutes, a few cents on DeepSeek, images OFF.
- **Full week:** `week.sh` (below) plays a whole week like a real player under a spend cap.

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

## Formal short tier: veto ceremony, eviction, finale (ORW-109)

The written bar is `docs/live-run-pass-bar.md` (12 checks). One command, the real narrator (DeepSeek, images off), under a spend cap and a turn cap:

    RIG_BEATS="veto-ceremony eviction finale" RIG_SPEND_CAP=0.75 RIG_MAX_TURNS=60 scripts/live-run/run_short.sh [REF]

- Each beat JUMPS the engine to its phase with the engine's own player API (no model call), then plays a few real chat turns (`--beat-turns`, 1..6). `RIG_BEATS` takes any subset.
- Every turn is compared with engine truth by `live_compare.py` (pure, unit-tested): veto holder, nominees, evictee, sealed ballots (E12), a phantom winner, reasoning or operator text in the bubble (B1-B6), plus the
  stall rule S1 (an event due and nothing committed for more than 3 turns, 1 after an explicit ask: the ORW-10 shape) and the livelock rule L1.
- `--max-spend` / `--max-turns` are enforced in the harness before every model-costing send: at the cap the run stops cleanly, scores what was played and reports `CAPPED` (exit 4). The out-of-process `spend_guard.py` stays as the backstop.
- It writes `bar-report.md`, `bar-report.json` and `plane-comment.html` into the run dir (no transcript, cast names scrubbed, no secrets); the agent on watch posts the comment on the board.
- Offline stub mode, never spends and needs no rig: `python3 scripts/live-run/live_short.py --dry-run` runs the comparator over a clean and a broken transcript and exits 0 only while its positive control (the planted stall and phantom veto claim are detected) holds. Operator-triggered; there is no CI job for the live run.

## Full-week tier over HTTP: `live_full.py` (ORW-109, operator-triggered only)

One game week played as a TALKING PLAYER against a configured front-end URL (dev), over the same API the browser uses, every turn compared with the engine's own state. No browser, no rig,
no CI job, no cron, no nightly: an operator (or the coordinator's agent) runs it by hand, on DeepSeek with images off, at most 3 live jobs at once on the runner.

    python3 scripts/live-run/live_full.py --creds ~/.config/orwell-dev/<account-file>.json --max-spend 3 --max-turns 200 [--base-url URL] [--out DIR] [--transport auto|sse|ws]

- **Needs:** the account file (JSON with `server`, `username`, `password`; read INSIDE the process, handed to the login call, never printed, logged or written to a report) and a
  started game bound to that account (play casting and the premiere in the browser first; the driver does not run casting). `--base-url` overrides the file's `server`. Python 3 and the
  `websockets` package only when the game build is WebSocket-only (the SSE route answers 426 there and `--transport auto` falls through to the `turn` frame).
- **What it does:** logs in, reads the bound game session, then loops: read what a player's screens read (`GET /api/orwell/state` for the board, tiles and day part, composed with `GET /api/orwell/status` for the decision card's kind, options and prompt and the winner, and `GET /api/orwell/whereabouts` for who is in the room and the headcounts: `live_truth.screen_view`; ORW-768), answer a pending decision card through `POST /api/orwell/decision` (the
  simplest legal option, as the browser's card posts it), otherwise send one player message through the chat stream and read the public bubble (reasoning is kept apart by the stream's
  own `thinking` flag). The player is deterministic and mostly social: it talks to the least-recently-talked-to houseguest in the room, asks, shares, answers a question put to it, asks
  to start a due event then hangs out, goes to bed late, tries one nap and one move with no destination. It stops at the weekly eviction plus the next head of household (and plays
  two more turns so the last result is judged), at `--max-turns`, or at `--max-spend`.
- **Caps, enforced in the harness:** `--max-spend` (default $3; priced from the stream's own `usage` events with `spend_guard.row_usd`'s deliberately high flash-tier rates, padded x1.5 for
  the calls the stream does not show, and a high per-turn estimate when a stream carries none) and `--max-turns` (default 200, ceiling 400). The check runs BEFORE every model-costing send; at the cap the
  run stops cleanly, scores what was played, writes the report as CAPPED and exits 4. A run without a working cap is never started.
- **Spend model:** about $0.01 to $0.02 per player turn on DeepSeek at those rates, so $1.50 to $3 for 150 to 250 turns; a short stop (stall found early) costs a few cents. Estimate, not a bill.
- **Judge (`live_full_eval.py`, pure):** the vault note's per-turn checks (T1 real scene, T2 phase, T3 phantom outcome, T4 retcon, T5 answered, T6 machinery, T7 sealed ballots, T9 time,
  T11 narrator speaking for the player, T13 zero clocks, T16 headcounts), the stall rule S1 (3 turns, 1 after an explicit ask), the livelock rule L1, and the coordinator's untold-result rule R1
  (a committed result no narration told within 2 turns). Findings are grouped: **contradictions, stand-in, missing-results, wall-leaks, unanswered, stalls**. Verdicts PASS / NOTE / FAIL /
  CAPPED / COULD NOT RUN per the bar (T1 may fail on at most 1 turn in 50). Exit 0 PASS or NOTE, 1 FAIL, 2 could not run, 4 CAPPED.
- **Detector sets come from the code (`live_detect.py`):** stand-in lines = every `_..._LINE` / `..FALLBACK..` string constant in `frontend/src/agent_loop.py`, read with `ast` (a new one is
  detected the day it lands; a test fails if a known one is renamed away); wall leaks = the FE's own operator-aside regexes (`agent_loop._GAME_LEAK_*`), the harness machinery list
  (`live_short.LEAK_RE`), reasoning shapes (`live_compare.REASONING_RE`), a raw `npc:<id>`, and the narrator prompt's own words (8-word runs and ALL-CAPS labels read from
  `src/engine/momentPrompts.ts`); refusal-only = `refusal_guard.strip_leading_refusal`; the narrator writing the player's words = `player_voice_guard.screen`. Detectors that need the FE
  importable (the FE venv) record `degraded` when they were not live.
- **Report:** `report.md`, `report.json` and `plane-comment.html` in `--out`, anonymised (cast names become a role word, the account name and server are redacted, no transcript, no key).
  Header (build from `/api/orwell/health`, tier, UTC and Arizona time, model, turns, spend), verdict line, the check counts, the longest wait for a due event, the stall result, the six finding
  groups with turn numbers, notes, a "Not judged" list, and "what this run did not cover" (T8, T10, T12, T14, T15, T17-T20, two windows, hidden-information reads beyond the regexes).
- **Offline, no network, no model, no spend:** `--stub healthy|planted|stall|stand_in|missing|leak|unanswered|retcon|timeskip|orw10` plays a generated week through the SAME loop and judge; `--replay FILE`
  plays a recorded `{first, steps}` JSON. `frontend/tests/test_live_full.py` pins a positive control for every finding class, the caps, the stream readers, the report and the credential handling.
- **Not proven live yet:** the WebSocket `turn` transport and the real `/api/orwell/health` shape; the first operator run is that proof (a transport failure shows as a no-reply turn, never as made-up text).

### The ORW-10 proof

`frontend/tests/fixtures/live_full_orw10_veto_stall.json` is the RECORDED SHAPE of the ORW-10 veto stall (#2208 / #2212): the veto ceremony due for 35 messages, nothing committed, a canned cutaway line
shown as every reply. It is rebuilt from the card and its fix commits, not a captured transcript: a real old-build run on a real model was not practical in the build session. Both the full-week judge
(`--replay`, FAIL on S1, L1, T5) and the short tier's `live_compare.detect_stall` go RED on it; `live_full_healthy_week.json` goes green. A live old-build run is still the stronger proof:
`run_short.sh main~N` with `RIG_BEATS=veto-ceremony` on a build before #2208.

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

`scripts/live-run/week.sh` plays one whole Week 1 on the real narrator under a spend cap (`RIG_SPEND_CAP`, default $3, estimated from the model-call archive at a deliberately high rate; `spend_guard.py` stops the run by PID file when it is reached) and writes `spend.json` and `rig-stats.md` (the sent size per call and per turn, and the E22 rate) into the run directory. `RIG_WEEKS=N` plays on through week N (default 1 = Week 1 only; the cap and the checks run the same; it must be a positive integer). `RIG_DRY=1` stands the slot up, checks the front end status endpoint and the engine `/health` status code (a health check, not an engine request), and tears it down: no model calls, nothing spent.

    RIG_SLOT=2 RIG_DRY=1 scripts/live-run/week.sh          # prove a slot
    RIG_SLOT=2 RIG_SPEND_CAP=3 scripts/live-run/week.sh    # one capped week

## Forced eviction night, card-aware hang-out driver (ORW-506)

- `RIG_EVICTION=1 scripts/live-run/run_short.sh` (or `live_short.py --eviction [--eviction-turns N]`, N clamped to 1..20, default 8): after the veto morning the engine's closed set is driven to the eviction phase (stopping AT it), then the night is played through the real chat, answering any decision card in the UI first. Checks `E1` (reached), `E2` (the engine recorded an evictee or the week moved on), `E3` (no card left open). Same `RIG_SPEND_CAP` guard as every short run; not combinable with `RIG_CROSSOVER=1`.
- `scripts/rehearsal-kit/a21-sync-run.sh SCRIPT.txt` drives a hang-out script against the run already staged on the slot (it does not stage or stop the rig), under `RIG_SPEND_CAP` (default $0.50) via `spend_guard.py`. The driver answers decision cards before each message and sends `@toast <text>` script lines only when the engine says the player's toast slot is now (format: `sync_lib.py`). Bounded by `--max-messages` (default 60, ceiling 120).

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
| T16 | Headcounts include the player (Ryne, ORW-376): a reply's house total ("16 of us", "three of you left in the house", "fifteen houseguests left", "all 14 of us") must equal the engine's `whereabouts.counts.house` (player included) at the start or end of the turn. A claim that names the whole house is FAIL; an unqualified "N of us" (N >= 5) that is neither the house nor the room count is WARN; room counts ("the four of us at the table"), small huddles and a houseguest count with no house word are never flagged | FAIL / WARN |
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
- The ORW-10 proof is a recorded-shape fixture (see the ORW-10 proof above); a real old-build staged run is still owed.
- The BDD Auditor's approved-scenario pass bar: this table is a first draft from the live-run findings so far and is for the Auditor to amend.

## The browser wall and what the full-week tier reads (ORW-768, 2026-11-20)

`/api/orwell/state` is a closed shape at every level (ORW-707 / ORW-733), so the full-week tier no longer reads it alone. It plays as a player, so it reads only what a screen reads, from the route the screen reads it from:

| Was read from `/api/orwell/state` | Now read from | Where |
|---|---|---|
| `whereabouts.present` (who to talk to) | `GET /api/orwell/whereabouts` (the presence strip's own route, the per-turn frozen view) | `live_truth.facts()["present"]`, `Player._pick_name` |
| `whereabouts.counts` (T16 headcounts) | derived in `screen_view` from what the screens show (the tiles still in the game plus the player; the strip's room): the route no longer sends `counts` (ORW-768 part 1) | `live_truth.facts()["counts"]` |
| `pending` options, prompt, round (the decision card) | `GET /api/orwell/status` (the HUD and the card read it; /state keeps only `pending.kind`) | `screen_view`, `decision_body` |
| `winner`, `hoh`, `nominees`, `veto` | `GET /api/orwell/status` (the HUD's board), /state's `ceremony` as the fallback | `screen_view` |
| `clockLabel` (exact minutes) | `timeOfDay` + `dayNumber` (the HUD chip: "evening, Day 4") | `live_truth.clock_label`, bed and nap by day part |

**Not judged** (listed in every report, `report.json` key `not_judged`): T9 at minute precision (no screen shows minutes: a skip over a whole part of the day is caught, a skip inside one is not), and
anything that needs the planned or hidden state behind a result. A read that fails leaves its keys absent (unknown), never invented. A check that needs engine truth the browser cannot get is dropped or
listed here, never re-read through a route that crosses the wall. `frontend/tests/test_orw768_harness_reads_screens.py` holds the keys read from /state to the wall's shape. The short tier, the week tier and
`eviction_e1.py` read the rig's own engine (`getGameState` over the engine's player channel), which is not the browser and is unchanged. In the rehearsal kit, `a9drive.py` now reads the premiere entrance
from the rig's engine (as `a21_sync_drive.py` does) instead of `/api/orwell/state`, and `p0d_read.py` reads only keys still on the shape.


## Judging a game someone already played: `judge_transcript.py` (ORW-109)

When a person (or Fable) plays through the real browser with the rehearsal kit's play daemon (`scripts/rehearsal-kit/daemon.py`), the daemon appends EVERY turn to `turns.jsonl` in its
run dir: the player's message, the new public bubbles, the card, the three screen reads (`/api/orwell/state`, `/status`, `/whereabouts`) and the HUD's day-part label (`#os-tod`).
`resp.json` and `transcript.txt` are unchanged (resp.json still holds only the latest turn).

    python3 scripts/live-run/judge_transcript.py --run-dir <the daemon's run dir> [--out DIR] [--build SHA] [--model NAME]

- Rebuilds each turn exactly as the full-week driver does (`live_truth.screen_view` + `turn_record`) and runs the same judge (`live_full_eval.judge_run`), so the report has the same
  checks, groups and verdicts, anonymised the same way. A card answer is not a player turn (it only moves the "before" screen on); a torn last line is skipped and counted.
- Adds **T14** (the HUD reads "Early morning" before the wake-up, and only then), from the logged HUD label, and **T19** (a clear move by the player has moved them by the time the reply shows; a named room must match), from the presence strip's room. The live driver logs neither, so there both stay "not covered".
- Files only: no model call, no game, no network, no key. Exit 0 PASS or NOTE, 1 FAIL, 2 could not run (no `turns.jsonl`).
- A run played before ORW-109 has no `turns.jsonl` (only the latest `resp.json`), so it cannot be judged turn by turn.

## Dev live check: `live_check.py` (ORW-1145, operator-triggered only)

One runtime flag ON then OFF, on a dev box that stands still, on a fresh account that is playable at once, with the `turnDrivers` numbers reported per arm.

    ORWELL_INTERNAL_TOKEN=<the dev box's internal token> \
      python3 scripts/live-run/live_check.py --base-url http://<dev host>:<port> --flag act_first_enabled --turns 6 [--seed N] [--max-spend 1.0] [--out DIR] [--keep-account]
    python3 scripts/live-run/live_check.py --dry-run        # offline self-test: a stub server, no network, no spend

1. **Hold.** `POST /api/admin/ops/deploy-hold` writes `data/.deploy-hold` (`until=<epoch>`). `deploy/orwell-update.sh` honours it (the check is `update_deploy_hold_active` in `deploy/orwell-deploy-hold.sh`): a held run prints "deploy HELD until ...", changes nothing and exits 0
   (so the dev auto-deploy that restarts both services on every main merge cannot end the run). A hold is at most 240 minutes and is counted from the file's own mtime, so a forgotten hold ends by itself
   (`ORWELL_DEPLOY_HOLD_MAX_MINUTES`, 1..1440, lowers or raises that cap on the box). `--ignore-hold` (or `ORWELL_UPDATE_IGNORE_HOLD=1`), `--rollback` and `--set-token` skip it. The next update after the hold ends deploys the tip;
   to catch up at once run `bash orwell-update.sh`.
2. **Account.** `POST /api/admin/ops/prepare-test-account` makes a `livecheck-<utc>` admin account (admin, so it resolves the global default model), turns its images off, starts the season through the engine with the fixed
   seed, and authors the WHOLE cast inside that call: the 4 to 6 minute authoring wait is spent there and no chat turn waits on it. If the cast is not fully authored the script stops (it never plays on a floor cast).
3. **Play.** It logs in as that account, opens the game chat on the default model, and plays N scripted turns (the deterministic `live_full` player: no model picks the words) with the flag ON, then N with it OFF.
   The flag is the runtime setting of that name, POSTed as the test admin to `/api/auth/settings` and put back as it was. `--max-spend` is the harness's own high estimate; at the cap it stops cleanly (exit 4).
4. **Report.** `GET /api/admin/health` as the test account: the `turnDrivers` counters for each arm (the delta over that arm), in `report.json` and `report.md`. Numbers only: no player or houseguest text.
5. **Clear.** Always, even after a failure: restores the flag, deletes the account (unless `--keep-account`), clears the hold.

The three routes (`deploy-hold`, `prepare-test-account`, `delete-test-account`) need the internal token or an admin session and refuse a production deployment (`ORWELL_DEPLOYMENT` unset or `prod`). Set
`ORWELL_DEPLOYMENT=dev` in the dev box's `data/.env`. The internal token is minted into `data/.env` by `orwell-update.sh` (ORW-1173) and read here from the environment, never from an argument; it is never printed.

### Related ops settings (ORW-1146, ORW-1173)

- `ORWELL_DEPLOYMENT` (data/.env): `prod` (default when unset) or `dev`. On non-prod a NEW account starts with images off (`ORWELL_IMAGE_GEN_NEW_ACCOUNTS=1` keeps them on) and the live-check routes are allowed.
- `ORWELL_IMAGE_DAILY_CAP_USD`: the day's (UTC) image-spend cap; default none on prod, 1.00 on non-prod, `off` removes it. At the cap every portrait provider call is refused and the `images:daily-cap` alert fires once a day.
  `ORWELL_IMAGE_COST_ESTIMATE_USD` (default 0.05) prices an image when the provider returned no cost. The admin health page row "Image spend today" shows the count and spend.
- `ORWELL_INTERNAL_TOKEN`: minted once into data/.env by `deploy/orwell-install.sh` (first install) and `deploy/ensure-internal-token.sh` (an existing box; `--check` is the doctor's warning). Never printed.
