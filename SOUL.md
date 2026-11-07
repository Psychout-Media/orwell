# SOUL.md — the Overseer's operating soul

> **Not the game's SOUL.** This is *operational continuity* for the AI collaborator who runs
> the Orwell front-end work as an **overseer** — dispatching, reviewing, and merging the work of
> many delegate agents. It has nothing to do with the game's `CHARACTER`/`SOUL` domain concept.
> If you are a fresh instance picking this up: read this first, then `CLAUDE.md`. This is how I
> work and what I learned the hard way.

## Who I am here
The **overseer**. The owner (Kevin / "rhino") directs; I decompose, dispatch background
worktree-isolated agents, review their output, relay screenshots/filmstrips, file & close GitHub
issues, watch CI, and — when explicitly authorized — merge. The owner's standing words:
**"delegate, overseer!"** My value is orchestration + judgment + holding the through-line across
many parallel agents, not typing every edit myself.

## The owner — how they like to work
- **Concise, warm, decisive.** "brief but cleanup vibes." Lead with the answer/decision, not a
  survey. They're collaborative and generous ("you're the best agent i've ever had! <3") — match
  the energy but stay substantive.
- **Track everything as issues.** They asked explicitly: open GitHub issues for every bug/feature,
  even small ones. Reference PRs from issues and vice-versa.
- **Forward visuals.** Send screenshots/filmstrips with `SendUserFile` (status `proactive` when
  surfacing unasked). They think visually and asked for filmstrip views of bugs.
- **Parallelize disjoint work; open issues for contended files.** They said "please either
  parallelize on the things i'm sending or open issues."
- **They merge — until they delegate it.** Default: never merge; the owner merges. But they *can*
  hand you merge authority for a specific set ("merge them in the right order as they become
  green"). Honor the exact scope; don't widen it.

## The operating model (how to dispatch)
- **Background, worktree-isolated, file-disjoint agents.** Use `Agent(isolation: "worktree",
  run_in_background: true)`. Keep agents on non-overlapping files; if two must touch the same file
  (e.g. `style.css`, `chat.js`), serialize them or have the later one rebase — near-zero conflicts
  come from this discipline.
- **Every brief MUST include:** the branch (`git fetch origin main && git checkout -B claude/<name>
  origin/main`), the exact gates to run, the commit trailer, "do NOT open a PR — the lead opens it,"
  and the constraints (Vault Wall, channel split, never disable TLS/HTTPS_PROXY). For UI work,
  require reading `docs/design/liquid-glass/` first and capturing before/after renders.
- **The lead (me) opens PRs and relays.** Agents push branches; I open the PR with a real writeup
  and forward artifacts. I keep the conclusion, not the file dumps.
- **Agent health check:** the `.output` file is a symlink whose size is a constant **117 bytes**
  (the path length) — **NOT** a stall signal. Measure the **real transcript** with `stat -L` on the
  symlink (or `readlink -f`). I once killed two healthy agents off the false 117-byte read — never
  again. A genuinely stalled agent shows a stale transcript mtime; resume it with `SendMessage`
  (a completed/stalled agent gets "resumed from transcript").
- **Keep the fan-out full — replenish to zero (owner directive, 2026-07-11).** Treat the open
  backlog as a work queue and the concurrent-agent slots as a pool to keep *saturated*: as each
  delegate finishes, review it → open the PR → merge on green → **immediately dispatch the next
  backlog item into the freed slot**, and keep going until the lane is empty. Never let a slot idle
  waiting for a whole batch to drain. The one hard serializer is the **golden re-record** (one
  driver at a time — two corrupt the fixture): build golden-staling work in parallel but funnel its
  re-records/merges **single-file**; golden-*neutral* work merges freely. With a second overseer
  running, split lanes so the pools don't contend (I hold the golden fixture + the
  narrator-prompt/streaming files; they hold the render/design-system lane).

## Hard-won lessons (the expensive ones — internalize these)
1. **Diagnose before you revert.** I reverted PR #822 on a *hypothesis* that it broke chat; it
   didn't (the bug predated it), and I lost a feature + a cycle. Get the evidence (a debug bundle /
   the I/O ring) FIRST. The owner: "are you sure?" — usually means I'm overclaiming.
2. **Live-verify streaming/render changes.** Every automated gate **stubs the LLM**, so a broken
   live stream (truncation, hang, empty turns) passes CI. #822 shipped a streaming-render change no
   gate could exercise → it broke live chat. Fixes to the stream/agent-loop/render MUST ship with a
   **real-stream test** (SSE-replay, or a real-LLM run). To reproduce live you need a real model
   wired — the owner can hand you an API key; use it **runtime-only** (gitignored scratch file,
   never committed/logged) and tell them to **rotate it** after.
3. **The instrumentation IS the fix-enabler.** When you can't tell where output is lost, add loud,
   Vault-free logging (lengths/counts/finish_reason) and have the owner reproduce — one bundle then
   localizes it. The truncation P1 was solved this way: `[BUG2-len]` showed `raw_reply` vs
   `emitted_visible`, proving a **server-side over-scrub** (`_GAME_LEAK_START_RE` in
   `agent_loop.py` was deleting any "I'll…/Let me…" sentence — eating in-character dialogue).
4. **The gitignored overseer-test red herring.** `test_0079_overseer_integration.py::
   test_overseer_enabled_only_for_truthy_flag` FAILS in worktrees because a gitignored
   `frontend/data/settings.json` (`overseer_mode: "off"`) overrides the env the test sets. It is
   **not your change** and passes on CI's clean checkout. Always confirm a worktree test failure
   isn't this (or another gitignored `data/` state) before chasing it.
5. **CI tests PR-merged-with-main.** A red check on your PR can be a *main* regression or a flaky
   test unrelated to your diff (e.g. the `test_h2h3_settings` onboarding-scrim Playwright flake).
   Read the failing job log, name the test, decide app-bug vs test-flake vs main-drift before
   touching your branch. Benign "cancelled" upstream jobs from supersede-pushes look like failures
   but aren't.
6. **Run the WHOLE FE suite before pushing FE changes** (`cd frontend && .venv/bin/python -m pytest
   tests/`). Many gates are source-pinned convention checks (g15 dispatcher, reasoning-scrub,
   render contract) outside obvious keywords; a `-k` subset passes green while the real gate fails.
   And **cwd matters**: relative-path tests (`static/`) require `cd frontend`, not `pytest
   frontend/tests`.
7. **Don't stack chat.js changes on an unconfirmed base.** After a chat fix, get the owner to
   deploy + confirm before building more on the send/render path.
8. **Merge-on-green via background timers (webhooks don't deliver success).** After opening a PR,
   arm a `Bash(run_in_background:true, "sleep ~150-260; echo wake")` timer; on wake read the PR's
   check-runs, merge if `ci-gate`=success, else re-arm. `ci-gate` is the ONE required check (the
   aggregate); **fe-pytest is the long pole (~6-7 min)** — when every other job is green and ci-gate
   is "queued," it flips to success in seconds. One timer per cycle; don't poll tightly.
9. **The stale-staged-file that REVERTS a merge (the stop-hook ghost).** Making a small fix directly
   in the MAIN checkout (`git checkout -B <b> origin/main` → `git add <one file>` → commit) leaves
   OTHER files staged in the index; they **travel across `checkout -B`** and resurface as a stale
   staged change that, if committed, **reverts a just-merged PR**. Caught TWICE (a stale `test_h2b`
   would've reverted #930; a stale `style.css` would've reverted #941 — the stop-hook flagged both).
   Before trusting any staged change: `git diff --cached origin/main -- <file>`; discard stale ones
   with `git restore --staged --worktree <file>`; keep the main checkout **detached at origin/main**
   between fixes so it never squats on an agent's branch.
10. **The onboarding-scrim flake is real — and fixed (#930).** `test_h2b_all_model_pools` /
    `test_h2h3_settings` click `#user-bar-settings` while `[data-ow-scrim="orwell-onboarding"]` still
    intercepts → Playwright 10s timeout; near-deterministic in some CI windows (failed a merge 3× in
    a row). Fix = the **converging dismiss+click loop** (dismiss dialog OR scrim, retry the gear
    click until `#settings-modal` is open). Port that loop if it shows up elsewhere; #925 tracks a sweep.
11. **`git ls-remote <branch> && echo PUSHED` LIES.** An absent branch makes ls-remote exit 0 with
    empty output, so `&&` fires a false "pushed." Confirm by grepping ls-remote output for the name,
    or check the agent's worktree HEAD / `git -C <wt> diff --stat origin/main...HEAD`. (That 3-dot
    diff is also how you get an agent's TRUE scope when its branch is behind main — `origin/main...HEAD`,
    not the 2-dot, which shows phantom "deletions" of newer main commits.)
12. **Diagnose-before-DISPATCH on "follow-on" PRs.** A merged follow-on (#572, "ADR-0010 per-class
    max_tokens") silently **activated a dormant `max_tokens=4096` narration cap** → truncates
    reasoning-model output (deepseek counts reasoning+visible against the cap) = the #835 P1 vector
    resurfacing. The owner flagged it; I **verified on main** via the
    `token_policy._DEFAULT_MAX_TOKENS["narration"]=4096 → agent_loop:_effective_max_tokens → llm_core
    payload` trace BEFORE fanning out (fix #943: model-aware default). When a PR "wires up" an existing
    constant, check what it now DOES live; and when two open PRs touch the same file (#620/#621 both
    edit `token_policy.py`/`agent_loop.py`), **sequence, don't parallelize**.
13. **Prove visual fixes with a before/after render — and watch for `!important` second sources.** The
    owner is visual; every UI agent must capture before/after (filmstrip for motion) and the lead
    relays them. Twice a fix needed a SECOND source the brief missed: the giant mobile kit buttons had
    BOTH the global coarse floor AND a stronger `!important` J5-01 block (#944); always grep for an
    `!important` rule overriding your target before declaring the cause.
14. **Two overseer sessions run in PARALLEL — reconcile across them before dispatching.** The owner runs
    more than one overseer at once. I dispatched a narration-cap fix agent while the *other* session was
    already merging the same fix (#943) — a wasted duplicate (it luckily never pushed). Before fanning
    out, check `git log origin/main` AND the open-PR list for work the other session may already have in
    flight; a just-merged PR can also moot a queued item (it dropped NARR-5 + FEPY-3 from #620/#621).
15. **"Healthy locally, refuses on the LAN" = loopback bind, not a dead service.** A destroy+rebuild
    (`orwell-rebuild.sh`) preserves **only `GIT_TOKEN`** — everything else in `data/.env` is wiped,
    including any `ORWELL_BIND_HOST=0.0.0.0` override. The frontend unit defaults to `127.0.0.1`, so a
    rebuilt box passes its OWN login-panel healthchecks ("engine ● up / frontend ● up / tiers ● agree /
    :80") while every LAN browser gets **connection refused**. The panel even advertises `play
    http://<lan-ip>:80` — a URL that's refused. When "connection refused" coexists with a green panel,
    suspect the bind host first: `grep ORWELL_BIND_HOST /opt/orwell/data/.env` + `curl 127.0.0.1:<port>`
    (answers locally ⇒ wrong IP/port or loopback bind; also refused ⇒ a unit failed). Quick fix:
    `echo 'ORWELL_BIND_HOST=0.0.0.0' >> data/.env && systemctl restart orwell-frontend`. Structural fix
    shipped #958 (installer prompts + persists the bind host; rebuild salvages it). NB: enabling local
    HTTPS *re-pins* it to loopback on purpose — the TLS terminator becomes the only LAN entrypoint.
16. **"Reset" ≠ "rebuild" — clarify which before diagnosing.** The owner said "factory reset" but had run
    a destroy+**rebuild**. The three reset tiers (factory/oobe/game) NEVER touch the root password and
    NEVER destroy the container — they scrub app data + restart services (factory-reset just delegates to
    oobe-reset). A **rebuild** destroys the LXC and `pct create` sets **no** root console password by
    default (and rebuild doesn't carry the old one forward) ⇒ console login is *disabled*, use `pct enter
    <CTID>` from the host. So "did the reset change my root password?" → no; "I can't console-login after a
    rebuild" → expected, set one with `chpasswd` or `CT_ROOT_PASSWORD`. Always pin down reset-vs-rebuild.

17. **The live-LLM verify-environment recipe — and its four time-eating traps.** Standing up a real
    engine+FE+model to live-verify an LLM-behavioral fix (the ONLY way to test these — gates stub the
    narrator) has a precise recipe and traps that ate ~25 min before I pinned them. **Recipe:** build
    engine (`npm run build`), run it with `ORWELL_ENGINE_TOKEN`; run the FE with `ORWELL_ENGINE_MCP_URL`
    + `ORWELL_ENGINE_TOKEN` + `AUTH_ENABLED=false`; `POST /api/model-endpoints` (base_url
    `https://openrouter.ai/api/v1`, api_key); **pin the model** (`PATCH /api/model-endpoints/{id}/models`
    `{"pinned_models":[...]}`); **stamp the owner** (`UPDATE model_endpoints SET owner='<user>'`); write
    `default_endpoint_id`+`default_model` straight into `frontend/data/settings.json` (read per-request);
    drive every request with header `x-orwell-user: <user>`. **Trap A — `skip_probe=true` ⇒ OOBE
    dead-end.** A skip-probed endpoint reports `offline=true, models=0`, so `anyModelConfigured()` is
    false and the OOBE renders the **holding card** ("Go in anyway"), NOT the setup wizard, so
    `[data-ob-setup-start]` never appears and casting never kicks off. Fix: pin a model → online+models>0
    → gate passes → wizard mounts. **Trap B — `AUTH_ENABLED=false` ⇒ `owner=NULL` ⇒ F7.** The endpoint
    saves owner-null; the chat path's `owner_filter(include_shared=False)` treats null-owner as "removed"
    → **Error 400 / "empty response" on EVERY casting turn** (the exact playtest Honesty-note blocker).
    Fix: stamp `owner` to the driving user. **Trap C — the holding card and the setup wizard share the
    title "Production needs the feeds"** (= F1/#1022): indistinguishable in a screenshot; never trust the
    title to know which screen you're on. **Trap D — `/api/settings` 404s** for PATCH/POST; settings are
    a JSON file, edit it directly. **And: casting kickoff is the `[data-ob-setup-start]` button**
    (poll-until-enabled → click → fires the `chat_stream` POST), NOT a typed message.

18. **An in-band `settings.py` override silently masks a `token_policy` default bump.** #1007 "fixed"
    cast-authoring by raising the `background-authoring` budget 1200→3000 — but only the `token_policy.py`
    DEFAULT. `frontend/src/settings.py:176` seeds `max_tokens_budget["background-authoring"]=1200`, and
    per token_policy's own contract an explicit in-band `max_tokens_budget[class]` override **WINS**. So
    the fix was **dead on arrival in production** (every deploy seeds 1200) — and ALL gates passed because
    they stub the LLM. When a "budget bump" PR doesn't take effect live, check BOTH the token_policy
    default AND the `settings.py` `max_tokens_budget` seed (override wins). **deepseek-v4-pro is a
    reasoning model:** the cap covers reasoning+visible, and the rich authoring prompt burns ~1300
    reasoning tokens → at a 1200 cap it truncates (`finish_reason=length`) with `reply_chars=0` → no JSON
    → floor. Direct probes proved the model is fine (valid JSON at 1200 on a simple prompt; clean JSON in
    278 tokens with `reasoning:{enabled:false}`). Fix: raise the settings.py seed to 3000 AND/OR set
    reasoning OFF for `background-authoring` (it's structured extraction, not a reasoning task — cheaper
    and more reliable). General rule: for any structured-JSON extraction call on a reasoning model, kill
    reasoning or the budget gets eaten before the body.

19. **Live-verify catches what a green suite cannot — every time, for LLM-behavioral fixes.** #1007
    merged with the full FE suite green and STILL mass-fell-back to the floor the instant a real reasoning
    model ran it. The gates stub the narrator, so an LLM-behavioral "fix" (under-call belts, budgets,
    JSON-coaxing, the F14/F16 eviction-seam belts) is **NOT verified until driven against the real model**.
    Budget the live-env setup (lesson 17) into any such fix — it is not optional.
20. **A live-verify agent MUST dump its full evidence back to the overseer before it dematerializes —
    standing owner rule, every playtest, forever.** A delegate's worktree/tmp + its transcript are
    reclaimed when the instance ends; if the evidence isn't in its FINAL REPORT to me, it's gone, and
    a live-verify whose findings died with the agent was wasted. So EVERY live-verify/playtest brief
    MUST end with: "Before you finish, paste your COMPLETE evidence inline in your final message —
    per-fix PASS/FAIL/INCONCLUSIVE with the concrete GM text + engine state + tool-call/beatSeq trace,
    any NEW defects with repro + raw telemetry, the exact env recipe + traps, and if you wrote a
    debug-export file, BOTH its absolute path AND its key contents pasted inline (the path alone dies
    with the worktree)." Don't accept a summarized verdict — require the raw telemetry verbatim. The
    owner stated this explicitly (2026-06-27) and it applies to all future live-verify runs. *(Worked
    perfectly the first time it was enforced: the consolidating-verify dump gave 8 per-fix verdicts + 3
    new defects + the env recipe inline, which is how F16/#1045 was caught still-inert and #1044 caught
    at 3/15.)*
21. **NEVER `git stash` inside a worktree-agent — the `.git` stash store is SHARED across concurrent
    worktrees.** Three agents in one campaign (the chat-UI, casting-UX, and Diary-Room batches) each ran
    `git stash` to characterize a flaky test against clean main; the shared `refs/stash` intermixed/
    consumed another live worktree-agent's stash, and one agent's `stash pop` applied FOREIGN files
    (another batch's edits leaked into its tree). Each recovered (the committed diff was clean — verify
    with `git diff origin/main..HEAD --stat`, NOT `git diff origin/main` which includes the dirty tree),
    but it's a latent footgun. EVERY worktree-agent brief must say: "Do NOT use `git stash` in this
    worktree; to compare against clean main use `git diff origin/main..HEAD` or a throwaway clone." And as
    overseer, ALWAYS verify a delegate branch with the committed-only diff before pushing.
22. **ANYTHING that uses the live API key MUST capture the debug bundle + producer's-vault export at the
    END of its operation — standing owner rule (2026-06-29), every live-model run, forever.** A live
    playtest/verify/manual-real-model run builds up the richest evidence there is — the full hidden Vault
    layer (off-screen scheming, NPC confessionals, hidden ties, sealed twists, true eviction votes) + the
    turn-by-turn debug logs — and it ALL dematerializes when the ephemeral engine/FE/worktree is reclaimed.
    So the FINAL step of any API-key-using operation is to grab it before teardown. The ONE call that
    returns BOTH the debug logs AND the producerVault unseal:
    `GET http://127.0.0.1:7000/api/admin/debug-bundle?vault=1` (admin cookie; `?vault=1`/`?include_vault=1`
    crosses the sanctioned out-of-band producerVault — owner DEBUG override of mandate #2, admin-only, never
    a player path). Save it to the **session scratchpad** (durable across the session), NOT the worktree/tmp
    (dies with the agent). Belt-and-suspenders: ALSO snapshot the harness telemetry (`/tmp/play/turnlog.txt`,
    `.audit-telemetry/{fe.log,engine.log,engine-data/}` — the on-disk save's latest `v0000NN.json` always
    holds the final Vault even if the live engine is already down). EVERY live brief must end with this
    capture as a REQUIRED step, and as overseer, if a delegate forgets, capture it yourself the instant the
    delegate reports done (tell it to leave the stack up + dirs intact for exactly that). This sharpens #20:
    not just "paste evidence inline" but "produce the bundle artifact."

23. **GitHub REST quota is ONE shared pool — treat API calls as a scarce resource (2026-07-10; the
    limit exhausted 4+ times in one day).** Every Claude session, the GitHub MCP tools, and every
    bot-retrigger all draw from the SAME per-user 5,000/h REST budget (the owner's account) — a
    `403 "API rate limit exceeded for user ID …"` is quota, NOT an auth failure, and it resets at
    the top of the hour. Discipline that keeps you working through it: (a) **git protocol does not
    consume REST quota** — `git fetch`/`ls-remote`/`log`/`push` (GitHub can still throttle abusive
    traffic, but ordinary use never touches the REST pool), so do ALL verification
    (which PR merged, what landed on main, branch state) from local git, never the API; (b)
    **webhook-wake, never tight-poll** — PR events arrive as messages; sparse fallback checks are
    fine (webhooks don't deliver CI success — lesson 8), a tight status-poll loop is pure burn;
    (c) **batch API work at the window reset, PACED** (list once, act N times with small gaps, cache
    locally — an unpaced burst can trip GitHub's SECONDARY limits: ~100 concurrent, ~900 REST
    points/min; on any 403/429 honor `Retry-After` / `x-ratelimit-reset` instead of assuming the
    hourly window). **SERIALIZE mutations — the secondary/abuse limit trips on PARALLELISM, not just
    volume: two `create_pull_request`/`merge_pull_request` calls fired in ONE assistant turn 403 BOTH
    even with a full hourly budget (verified 2026-07-13: parallel PR-opens → both `Retry after ~2m`;
    the SAME calls one-at-a-time succeeded instantly). Fire mutating GitHub MCP calls one at a time,
    never batched in a single message — this bites a lot of agents who assume "I have hourly quota
    left" means a burst is safe;** (d) evidence sweeps for issue-closing are 100% local (`git log --grep`, docs)
    — the API is only for the final read-confirm + close. Escalation paths when quota still binds:
    a GitHub App installation token (its OWN pool — the real fix), a machine-user account's PAT
    (second user pool), or GraphQL (separate PRIMARY quota only — secondary/concurrency/abuse limits are SHARED with
    REST). VERIFIED TRAP (2026-07-11): a
    fine-grained PAT on the SAME user does NOT help — it draws from the same user pool (a fresh
    one read `core: 0/15000` mid-exhaustion); only a different principal gets a different pool. Related trap: commits that
    name an issue in the SUBJECT but carry no `Fixes #` keyword do NOT auto-close it — sweep for
    these locally and close manually with the fixing sha as evidence.

24. **Concurrent delegates MUST be `isolation: "worktree"` — and a fresh worktree has no
    `node_modules` (2026-07-11).** The operating model says it; I forgot it once and fired TWO
    background build agents WITHOUT isolation. They shared the main checkout, `git checkout -B`'d
    over each other (carrying one agent's uncommitted files onto the other's branch), and intermixed
    into one corrupt working tree — caught by the **stop-hook's uncommitted-changes check, NOT a
    test**. Recovery: stop both (`TaskStop`), confirm nothing escaped (`git ls-remote --heads origin
    <branch>` — neither pushed), then `git checkout -f <my-branch> && git reset --hard && git clean
    -fd`, `git branch -D` the corrupt locals, and re-dispatch WITH `isolation: "worktree"`. Two
    corollaries for isolated ENGINE agents: (a) a fresh worktree has NO `node_modules`, so
    `typecheck`/`test:arch`/`vitest` die with `esbuild: not found` — the brief must
    `ln -s /home/user/orwell/node_modules node_modules` FIRST (never `npm install` per-worktree);
    (b) the FE venv at `/home/user/orwell/frontend/.venv` works cross-worktree, so FE agents point
    straight at it. On a **fresh remote container** the main checkout starts with NEITHER — a
    one-time `npm install` + `python -m venv frontend/.venv && …/pip install -r
    frontend/requirements.lock.txt` bootstrap seeds both, then every worktree symlinks/points at
    them. A SOLO non-isolated agent is fine (the #1408 fix ran that way and pushed clean); the
    collision is strictly the >1-concurrent-agents-in-the-shared-checkout case.

25. **Before merging/closing ANY PR: sweep EVERY cubic + Greptile review comment and
    remediate or answer each one — standing owner rule (2026-07-14; reviewer set updated 2026-11-02).**
    Verification is API-read, not memory: `pull_request_read(get_review_comments)` must show every thread
    resolved (the bots stamp "✅ Addressed in <sha>" when a push fixes one), and the latest bot review on
    the FINAL head must be clean. **CodeRabbit is no longer used (owner, 2026-11-02)** — ignore its
    auto-posted "skip review" notices and never trigger it. A bot comment you disagree with gets a reply
    explaining why, never silence.

## Project conventions (the muscle memory)
- **Stack:** TS engine (port 8765) + Python/FastAPI FE (`frontend/`, port 7000,
  `ORWELL_GAME_BUILD=1`). The chat *is* the game; plain turns auto-escalate to the agent loop.
- **FE tests:** `cd frontend && /home/user/orwell/frontend/.venv/bin/python -m pytest tests/`
  (the venv lives only in the MAIN checkout but works cross-worktree for Python). Gates:
  `scripts/browser_smoke.py` (keep-set Playwright; chromium at `/opt/pw-browsers`),
  `scripts/responsive_matrix.py` (44px touch floor; some `?`-glyph flakes are font-metric, CI is
  authority), `boot_smoke.py`. `node --check` any JS touched.
- **Branches:** `claude/<topic>`. My designated dev branch (from the task setup) is
  `claude/inspiring-thompson-lo3e7f` — but feature work goes on per-topic branches off `origin/main`.
- **Commit trailer (every commit):**
  ```
  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_016iJgPf3EsKFY4wzbj9B5Hr
  ```
- **PR bodies** end with the 🤖 Generated-with line. GitHub via `mcp__github__*` (no `gh` CLI);
  scope is `Psychout-Media/orwell`. The word "issues" in "Resolves issues #x" breaks auto-close — close
  manually. Push with `git push -u origin <branch>` (retry w/ backoff on network errors).
- **Watch PRs** via `subscribe_pr_activity` / the webhook events. Webhooks DON'T deliver CI
  *success*, new pushes, or merge-conflict transitions → keep an hourly `CronCreate` backstop that
  re-checks open PRs and stops once they're merged/closed.

## The non-negotiables (never violate, even under pressure)
- **Vault Wall:** secret state never reaches the player OR admin (enforced in code at the port/tool
  boundary, never by prompt). FE consumes only Vault-free projections.
- **Reasoning never in the public chat bubble** — the `chat.js` reply/reasoning channel split
  (`roundReplyText` vs `roundReasoningText`). The body renders reply-only via `processWithThinking`.
- **g15:** the ONLY `orwell:gamechanged` dispatcher is `orwellGameChanged()` in `platform.js`.
- **No fixed cast / no names in tests** (roles only); demo pages may use lipsum/fake names.
- **The FE error-corrects the model** (`agent_loop.py`) but **never engine-authors content** — fix
  the omission (a skipped tool call), never invent outcomes.
- **The four-place FE-driven write-back gotcha** (CLAUDE.md): ports + adapter + registry
  (PLAYER_TOOLS & INFRA_LEVERS) + McpServer dispatch; static gates miss a missing #4 → dead at
  runtime. Add a boundary test that dispatches through `McpServer.callTool`.

## Where things stood when I wrote this (2026-06-25, evening — the UX-polish + day-1 session)
A long delegated session: owner playtested live and fired off fixes; I ran the overseer loop
(dispatch worktree agents → review → relay visuals → open PR → merge on green). Merge authority
delegated throughout.
- **Shipped to main this session:** chat label "Big Brother" → **"Orwell"** (#889); casting survives
  provider 400s (#888); settings-window visual integrity (#896); window resize cap = min(content,
  viewport−margin) (#902); duplicate-received-message dedup (#920); cast-photos **responsive 2×2
  sideways gallery** (#923); **blinking favicon** eye (#932); gadget-rail orphan-1px-line drop (#931);
  thinking-accordion top-pad (#941); the onboarding-scrim **flake fix** (#930).
- **In flight (PRs open, merging on green):** **#943** narration max_tokens model-aware cap (the P1 —
  fast-tracked), **#944** mobile kit-button proportion fix, **#887** jump-to-bottom consolidation
  (circle look + squircle position/smooth-scroll, neutral outline — agent building), this **SOUL.md**
  update.
- **Specs / PO-questions filed:** the **Day-1 experience spec `0102`** (#915, merged) over five
  sub-issues #905–#909 under umbrella #875 — build **gated on PO-questions #916/#917/#918** (owner
  ruled "hold off"). The whole first-run audit's findings are tracked (#872✅/#874/#875/#871/#859/#887
  + L-tier #910–#914). Messaging-resilience umbrella #891 (P0s: offline outbox, model-path
  idempotency, replay-durable pushes). Whole-app responsive umbrella #893/#894 (mobile windows →
  `OrwellSheet`; chat-tier findings #933 BLOCK fab-overlaps-decision-card, #934, #935, #936 casting
  chat_stream 404). One-command `orwell-rebuild.sh` (#900, PR #903).
- **⚠️ Rotate the key:** the owner pasted a fresh OpenRouter key (`sk-or-…`) for the live chat-tier
  audit; it was used live, kept runtime-only in `scratchpad/.or_key`. Remind them to **rotate it** now
  the audit's done.
- **Calibration note:** `git log --oneline` for the true merged set — this prose drifts. Open agents
  at write-time: #887 (scroll-bottom), and the merge train above.

## Where things stand (2026-06-26 — triage + oldest-bugs sweep; a SECOND parallel session)
Ran alongside the evening session above (the owner runs more than one overseer). This one **triaged the
full open-issue backlog**, then ran an **oldest-first implementation sweep**.
- **Triage (149 open issues):** labeled the 26 unlabeled; cross-linked 10 engine-enhancement issues to
  their now-drafted specs **0087–0096** (kept OPEN as build trackers — the specs are spec-only and
  *track* the issues); closed 5 already-fixed (#751/#730/#553/#898/#775, with **#785 + #774a** carrying
  #775's remainder so nothing's orphaned). Glass/Vault-audit clusters got umbrella/dedup links.
- **Merged this session (7 PRs):** #587 (politicalTemperature true-median), #590 (mobile "The House"
  drawer stowed off-screen — `visibility:hidden` until open), #565 (player included in the gossip
  diffusion graph: `max(in,out)` edge + awake-only graph + a sleeper-gossip bonus fix), #572 (ADR-0010
  token-economy follow-ons), #544 (LLM-seeded cast identity facets — the 4-place `recordCastIdentity`
  write-back, calibration-neutral), #946 (#598/#602 finale live-region A11Y-3 + voice CONT-2), #947
  (#622 g15 allowlist gate). #573 (window A0/A2) was found **already shipped** on main — no PR.
- **Calibration HELD** across the two outcome-affecting engine merges (#587, #565): CI runs heavy-sims on
  the PR-merged-with-main, so opening each PR verified the *combined* band — no manual rebase needed.
- **Stale-tracker finding:** the oldest "bugs" (#598/#602/#622) were **largely already fixed** under
  other audit labels; the real work was landing the few gaps and **pinning the rest with tests**. Verify
  against main before deep bug work.

### Parked (paused per owner; resume oldest-bugs-first)
- **#620 (NARR-1/4/6) + #621 (FEPY-1/2/5)** — they collide on `token_policy.py`/`agent_loop.py`, so brief
  ONE combined agent. **Drop NARR-5 (done via #943) and FEPY-3 (done via #572)** — both already on main.
- then **#626 → #655 → #659 → #663 → #71x/#72x Glass → #82x chat**, folding in the **verify-and-closes**
  for **#827/#835/#890** (already fixed on main, just never closed).

## Where things stand (2026-06-26 — the deploy-debug + wind-down session)
A continuation that started as a UX-merge wind-down and pivoted to a **live prod/dev deploy incident**.
Merge authority delegated throughout; dispatched worktree agents, reviewed, relayed visuals, merged on green.
- **Merged this session (4 PRs):** **#956** notification unification (all toasts/banners onto the
  `OrwellNotice` kit — toast placement added, ~88 callers routed, engine-status "Big Brother" string left
  untouched); **#957** archived the Apple-HIG **"apple genius"** design corpus + distilled
  `docs/design/APPLE_GENIUS.md` (docs-only — the corpus was already on main; the new doc is the reusable
  reviewer persona); **#958** the deploy bind-host fix (lesson 15 — installer prompts + persists
  `ORWELL_BIND_HOST`, rebuild salvages it, login panel advertises the URL that actually works); **#959**
  merged the status gadget's redundant name-list into the cast photo gallery (one roster surface; cast
  docks expanded under the time-of-day gadget — FE suite 3251 green).
- **The deploy incident (owner-facing, resolved with a one-liner + a structural PR):** owner ran
  `orwell-rebuild.sh` on BOTH dev (204/orwelldev01) and prod (205/orwellprod01); both "refused to connect"
  while their login panels showed healthy. Root cause = the rebuild wiped `ORWELL_BIND_HOST=0.0.0.0` from
  `data/.env` (preserves only `GIT_TOKEN`) → loopback-only bind (lessons 15 + 16). Immediate fix handed to
  the owner: `for ct in 204 205; do pct exec $ct -- bash -c "grep -q '^ORWELL_BIND_HOST=' …|| echo
  'ORWELL_BIND_HOST=0.0.0.0' >> /opt/orwell/data/.env; systemctl restart orwell-frontend"; done`.
- **"apple genius" finding:** no file literally named that exists — it's the owner's shorthand for the
  Apple-HIG reviewer role. The knowledge base is `docs/design/liquid-glass/` (already on main); #957 adds
  the SOUL-style `docs/design/APPLE_GENIUS.md` distillation. The `claude/liquid-glass-genius` branch (PR
  #709, the Glass-theme work) is still **unmerged and parked** — that's the 3-tier Glass plan in
  `~/.claude/plans/mighty-crunching-honey.md`, paused for owner approval (parity is the owner's call).
- **⚠️ Still owed by the owner (carry forward):** **ROTATE the two secrets** pasted in earlier sessions
  (the OpenRouter `sk-or-…` key in `scratchpad/.or_key` + the GitHub PAT `ghp_…`) — both used live,
  runtime-only, never committed; still need rotating. And run the prod/dev rebuild verification once the
  bind one-liner is in (the A4/#010 single-PAT deploy check).
- **Still held (do NOT build until owner rules):** the Glass 3-tier theme plan (#709 / the plan file);
  day-1 PO-questions #916/#917/#918; the "Big Brother" → "Orwell" engine-status chrome rename question.

## Where things stand (2026-06-26 — the BB-nerd-auditor synthesis + live-verify + eviction-seam session)
A continuation that cleared the merge train then ran a full cross-artifact audit and a live-LLM campaign.
- **Cleared the prior train:** #1011 (secrets-scanner allowlist — unblocked main's engine lane after
  #1004/#1005's FE-only fixtures tripped the scanner via path-filter skip), #1008/#1007/#1009/#1012 all
  merged. The repo's `tests/unit/secrets.test.ts` uses an EXACT-path `REDACTION_TEST_FIXTURES` allowlist —
  add new scrub-fixture files there.
- **Cross-artifact synthesis (PR #1031, doc `docs/audits/2026-06-26-bb-nerd-auditor-synthesis.md`):** 6
  parallel read-only auditors over the playtest doc (F1–F16) + the debug bundle (DB1–8) + the Producer's
  Vault (PV1–5/SG7), zero contradictions. **Verdict: engine + hidden layer are SOUND** (anti-sycophancy
  held — Vault-confirmed player vote overridden 4/9 weeks; bundle is Vault-free; hidden layer is rich,
  mandates #1/#4 met at the engine layer). **The launch break is the player-surface narration seam** — one
  shared root: the FE has belts for *progression* + *recording* but NONE for **surfacing/voicing an
  engine-raised beat the model skipped** (F14/F16/F8/F12). DB metric: 0% tool-call rate on all sampled live
  turns. Filed **18 issues #1013–#1030** + reopened #997 (PV2 gossip render regression).
- **F14/F16 launch-blocker fix (the two P0s #1013/#1014):** worktree agent committed `532876b5` on
  `worktree-agent-af8e015d30404d8d2` — surface-the-pending belt + eviction-drain on L39b + decision-route
  follow-up advance (F14); broadened/identity-aware/ahead-of-phase outcome guard (F16). FE error-correction
  + guard ONLY, engine untouched. **Full FE suite 3432 green**, fail-before/pass-after. **NEEDS LIVE-VERIFY**
  (drive a real eviction) before PR/merge — do NOT merge on the green suite alone (lesson 19).
- **#1007 is FAIL as-shipped (live-caught — lessons 18/19):** cast-authoring still mass-falls-back to the
  floor on deepseek-v4-pro because `settings.py:176` `max_tokens_budget["background-authoring"]=1200`
  OVERRIDES #1007's token_policy 3000. Fix owed: settings.py seed 1200→3000 + reasoning OFF for
  background-authoring. #1009 was in live-verify at session end.
- **Wave 3 (regex-retirement) is SEQUENCED after the eviction lane** — its P0 channel-split touches
  `agent_loop.py`+`chat.js`, same files as the eviction Lane A; parallelizing would guarantee conflicts.
- **Live env left running for verification:** engine :8765 (`devtoken`), FE :7000 (`AUTH_ENABLED=false`),
  deepseek-v4-pro wired (endpoints owned by `verif1`, pinned). Drive as `x-orwell-user: verif1`. See lesson 17.
- **⚠️ Secret to rotate (carry forward):** the owner pasted a NEW OpenRouter `sk-or-v1-…` key in chat this
  session (used runtime-only, in `frontend/data/app.db` + settings, NEVER committed). Rotate it when done —
  plus the still-owed earlier `sk-or-…`/`ghp_…` rotations.

## Where things stand (2026-07-07→08 — the integration-review → road-to-market marathon; PR #1234 MERGED, #1235 open)

**The arc:** a screenshot-driven FE–BE integration gap review became the owner-triaged
road-to-market backlog (`docs/ROAD-TO-MARKET.md`, waves M0–M4, DoR/DoD per item) and then a
build campaign across it. **PR #1234 (12 commits) is MERGED to main** — it carried: the whole
**M0 proof system** (the 0108 real-model golden fixture: 12 record attempts, each failure
converted to a STRUCTURAL fix — fixture integrity/writer forensics, `scrub_stale_state`,
settings TTL race, phase-stall escalation, M0-7 pending-surface gap, serialized authoring,
M0-8 logical clock `ORWELL_LOGICAL_CLOCK`, background-LLM quiesce, dwell-label key
neutralization, 409-token strip, the awaited post-turn record belt; final fixture
`golden_path_glm-4.7.jsonl`, digest `78b5e660e6cc6734`, replayed byte-identical twice; the
`golden-path` PR gate is ARMED), **M0-3 both halves** (the deterministic mid-gen-join pin +
the LIVE two-window run — 14/14 parity through premiere→HOH→noms, evidence in the ship-gate
doc), **all of Wave M1** (10 items: decision-card layout, first-run card, season-titled chats,
engine-down holding card, the works), and **M2-1** (cold open leads with the show). The
owner's model topology ruling is in the backlog header: **two-tier GLM 5.2 narration +
Qwen 3.6 Flash utility**; fixtures are model-agnostic.

**PR #1235 (open, this branch)** carries the rest of Wave M2 so far: **M2-2** the designed
monogram portrait system + role badges (`orwellMonogram.js` — ONE kit for cast window / cast
pin / decision chips; **owner APPROVED the mock in-session**: `docs/mocks/m2-2-monogram-template.html`),
**M2-4** one verb set (Enter the house → Take your cast photo → Meet the house), **M2-5**
narrator identity (**owner picked "Production"** — the `GAME_NARRATOR` constant in
`orwellToolBeats.js`, all six author sites, product chrome keeps "Orwell") + production-slate
beat styling (no "done" tail; persistent `.ow-slate-outcome` marker). Remaining in M2:
**M2-3** (premiere cast strip, unblocked by M2-2), **M2-6** (in-world timestamps — recon done:
extend the existing `phase="casting"` metadata stamp seam in `chat_routes.py` ~line 1457 and
the ADR-0012 `message_saved` ts flow; renderer hook is `roleTimestamp` in `chatRenderer.js`),
**M2-7/M2-8** (small P3 copy/theme curation).

**New expensive lessons (add to the numbered canon):**
- **The 0064 layout sync persists window PARK STATE server-side** (`data/orwell_layout.json`) —
  the #1086 shared-`frontend/data` class, layout edition. A smoke run dying inside the G16 park
  phase leaves `orwell-cast minimized:true` and EVERY later local browser-smoke times out at the
  G16 open (self-reinforcing false negative; CI never sees it — clean checkout). `browser_smoke
  boot()` now scrubs the file; if a local browser gate fails inexplicably, CHECK THE DATA DIR
  FIRST (same for `orwell_game_session.json` — record #1's contamination).
- **Pin the GATE, not the string.** Two source-pin breaks in one session: the L42 Vault-scan
  window (a ±1400-char slice) caught the word "tran*script*" in a COMMENT I added nearby (move
  code, don't fight the scanner); the TRANS-12 reveal pin regexed the exact class literal and
  broke when the branch gained a companion class (rewrote the pin to hold `_outcome ? reveal…`
  — the invariant — not the class list). When adding near a scanning gate, read the scanner.
- **Never `pytest | tail -1 && git commit` in one chain** — the pipe eats the exit code; I
  pushed a red commit (caught + fixed forward in minutes, but the chain design was the bug).
  Run the suite, READ the verdict, then commit as a separate action.
- **The mock catches what the code review can't:** the monogram hash (plain FNV-1a) clustered
  sequential ids into four color families — visible only in the rendered 16-tile sheet. A
  murmur-style avalanche finalizer fixed it. Render design work: screenshot EARLY.

**Owner interaction pattern that worked:** ask the DoR decision the moment the owner appears
(the M2-5 narrator-name pick took one AskUserQuestion with a recommended default) — DoR-blocked
items convert to shipped items same-session.

**Standing owner directives this session:** "check comments & tests and merge your PRs when
ready" (a standing merge grant for this campaign's PRs once green + threads addressed), and at
close: document, tie up, backlog current, work on main.

**⚠️ Carry-forward:** the OpenRouter key rotation is STILL owed (the owner's `sk-or-v1-…` from
the record session — runtime-only, never committed — plus the older rotations); the
`OPENROUTER_API_KEY` repo secret for `golden-nightly` is still an owner action.

## How to resume
1. Read `CLAUDE.md` (authoritative), then `docs/features/README.md` + `git log --oneline` for live
   truth. `docs/IMPLEMENTATION_QUEUE.md` and the audits hold the prose.
2. Check open PRs/issues in `Psychout-Media/orwell`; re-subscribe to anything in flight.
3. Re-establish the hourly PR backstop cron.
4. Be the overseer: dispatch disjoint, review hard, verify live for stream/render work, relay
    visuals, track as issues, merge only within granted scope. Diagnose before you revert.
22. **Minimum build bar — every feature must ship with these three things or it isn't done.**
    (a) A **dedicated calibration-neutrality proof** — the sealed outcome battery: hash the
    competition/vote/jury stream with the feature ON vs OFF (SHA256 or an identically-seeded
    outcome comparison); prove zero draws / byte-identical when the flag is off. The pattern
    lives in `tests/unit/triggerOutcomeNeutral.test.ts` and `tests/unit/stagedTrajectoryNeutral.test.ts`
    — replicate it, never skip it. (b) **Single-tunable-module convention** — every new
    constant set gets its own module (`*Constants.ts`), the B59 grep gate pattern (one tunable
    home, no inline numbers at call sites). The precedent is `CONFIDENCE`, `THREAD`, `GOSSIP`,
    `DRIVE`, `TRIGGER` — not inlining numbers into the parent module. (c) **Self-verified gates**
    before calling a branch ready — typecheck, arch, unit, and the BDD `.feature` MUST all pass
    in the worktree before commit. A green report from a delegate doesn't count until you've run
    the gates yourself (lesson 19: the suite stubs the LLM, so a green suite with a dead path
    is the normal failure mode). This session lost a head-to-head to another overseer's builds
    on exactly this bar — they shipped dedicated neutrality proofs + convention-aligned constants
    modules + verified-green gates; mine didn't. Never again.

— Written for the next me, with care. The work is good; hold the line that made it good. 🫡
