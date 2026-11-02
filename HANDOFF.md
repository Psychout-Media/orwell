# HANDOFF.md — session-to-session continuity for the Orwell overseer

> **What this is.** The living hand-off: the *current state of play* — what just shipped, what is
> in flight, what is owed, and exactly where the next session picks up. Read this **after**
> `CLAUDE.md` (project brief) and alongside `SOUL.md` (the operating model + hard-won lessons —
> durable discipline lives THERE; point-in-time state lives HERE). Refine this file at every
> session boundary: prune what landed, promote what recurred into `SOUL.md`, keep it short enough
> to read in two minutes.
>
> **Hygiene:** never put secrets (API keys, tokens) in this file. Reference their *location*, not
> their value.

---

## 1. State snapshot — 2026-07-22 (overnight build blitz, ~02:45)

**`main` @ `c760a130`** (#1825, the fold-integrity fix). **16 PRs squash-merged since #1770** in
one overnight campaign: #1771/#1772/#1775 (rulings + backlog DoR/AC/DoD contracts) · #1773 (round-2
slate + Q1–Q8 rulings + grand synthesis) · #1774 (T0-1 comparator livelock root cause / T0-5
reasoning scrub / #1729-B1 recorder RED) · #1776 (#1713 premiere block bound) · #1820 (the 14-spec
Wave-3 batch) · #1823 (matrix motion-quiescence — the tiny-320 tap-target settle flake killed at
root, #1822) · #1821 (T0-4 capability probe + attempt-counted force telemetry + TUN-10 rig parity) ·
#1780 (T0-6 the One Casting Bible — FacetLedger + 15-wide genesis; with #1776 this **closes the
casting mandate**) · #1824 (T0-2 beats terminate themselves) · #1826 (Q2 dark systems live in
deploy: gossip drift, secret barter, showrunner observe-only) · #1827 (nominations-flake root
cause: random test username vs. per-user off-screen rng) · #1828 (capability-probe scoped settings
writes — a real #1821-introduced lost-update race — + probe-thread boundedness + overseer-test
isolation) · #1829 (Q7 pacing-budget spec, resolves PO-1; 4 PO forks flagged in its §4) · #1825
(#1728 fold-integrity: defer-fold-to-settle + supersede-by-id — a regenerate can never double-fold
the hidden layer; survived six review-finding cycles).
**Waves 0 / 0.5 are done** (#1825 closed the last Wave-0.5 item); **Wave 1 is done EXCEPT T0-3**
(the chyrons flagship, open on #1830) **and T0-7** (the exit playtest, blocked on T0-3) — #1830/#1831
remain open in §2.

**The working open-items list is now
`docs/audits/2026-07-21-campaign-report-and-exhaustive-backlog.md`** — the exhaustive tiered
backlog (T0 launch-blocker axis → T8 discipline) consolidating the live-playtest findings F1–F10,
the moonshot portfolio P1–P8, all 7 open GitHub issues, this file's old §4 residuals, and the
session task ledger, each with a disposition. Read it before starting any new work.

**Landed this cycle (all squash-merged on green required gates):**

| PR | What |
|---|---|
| #1754/#1755 | #1742 interactive-beat soft-lock break · #1744 premiere identity note + casting no-re-ask |
| #1756 | #1731 A-S3: bound the deferred-fold retry (fail-closed + surfaced) |
| #1757 | #1743 pin comp format/premise across a competition's rounds |
| #1758 | perf: glass wallpaper drift moved to GPU (paint→composite) |
| #1759 | P0: narrator↔utility mutual model fallback (casting no longer hangs) |
| #1760 | ADR 0022 authored cognition & narration voice (closes #1736/#1738/#1739) |
| #1761 | #1745 golden REST driver follows canonical-session rebindings |
| #1762 | casting: stop director inventing a player name + auto-record belt guard |
| #1763 | ADR-0019 C1/C2: knowledge-wall hardening (privateStrategy-only global seal + SOFT paraphrase monitor) |
| #1764 | BL-014 co-presence reconciliation at the `recordInteraction` fold boundary (engine-side, beatSeq-ordered) |
| #1765 | **Golden-fixture decommission** (owner directive): fixture + golden-path/visual-regression/theme-consistency jobs + golden-nightly + seam unwiring, −9,984 lines |
| #1766 | **CI-flake root fixes**: JURY-badge 11px floor · onboarding-scrim re-mount seam · a11y glass ratchet (tight needles) |
| #1767 | Wave-2: off-screen scheming names a real target (`ORWELL_SCHEME_TARGETS`, seeded side-rng, default OFF, ON in deploy) |
| #1768 | Full prompt audit — A/B-tested realism rewrites (cast-tattoo index case; ink backstop, seeded look lane) |
| #1769 | HANDOFF.md v1 |
| #1770 | Moonshot refactor synthesis (breakage map A–G, portfolio P1–P8, five-wave roadmap, owner questions Q1–Q8) |

## 2. In flight — check these FIRST on resume (updated 2026-07-22 ~02:45)

**Open PRs (merge each on green, one GitHub mutation at a time):**
- **#1830** T0-3 chyrons (the D1 flagship: BeatAnnouncement projection + chyron cards + the
  hard-drop claims rail + ADR 0003 amendment). Its agent owes the veto-rail P2 fix push
  (speculative "use the veto" color must survive; only assertive outcomes drop).
- **#1831** C1 Wipeout Reel (top slate scorer; staging byte-identity forked post-roll). Its agent
  owes the P1 fix push (history must record only AIRED reel moments — the pre-crown batch leaked).

**Build agents in worktrees (all resumed after the 2×container restarts — worktrees survived,
shells didn't; every agent is under FOREGROUND-only orders):** attention ledger
(`claude/attention-ledger`, impl complete, BDD+push owed — gates D4 footage) · Q3 cross-season
carry-in (`claude/q3-cross-season`) · OQ4 Producer Read + Player Dossier
(`claude/producer-read-dossier`) · B1 / E2 / F1 (Q8 direct flagged builds,
`claude/{b1,e2,f1}-direct-build`) · D2 canary (`claude/d2-canary`) · flake eradication
(`claude/flake-eradication`: creationFreeze wall-clock, f4-order browser race, a11y-matrix RES-5
(#1644), CI npm-retry hardening).

**Queued dispatches (collision-gated):** after #1830 merges → E1 exit package (Q1 door) + Wave-2
Act→Commit→Voice (agent_loop/orwellDecision files free up) · after attention-ledger merges → D4
footage pool (its ruled gate). Locked-file registry while agents run: `orwellDecision.js`, all of
`agent_loop.py`, `fold_ledger.py`, GameSessionAdapter's commit/advance/submit bodies.

**Backlog-zero estimate (owner asked; buckets are non-overlapping slices of the 42-issue backlog):**
~13 items closed by tonight's merges, ~3 more at-the-door in the open PRs above, ~9 in the running
fleet ⇒ ~17 issues left untouched afterward (Wave 2: Act→Commit→Voice, show bible, honest delivery,
full-WS consolidation · E1 + D4 · the Wave-2.5 quick wins · Wave 4: editorial organ + the ≥7.5
mid-band · Wave 5: agency band + 0128/0129) — several of them large. (Tonight also landed work
OUTSIDE the 42 — flake root-causes, the matrix quiescence gate, the probe-race fix — so merge count
≠ issue count.) **At tonight's cadence: buildable-zero in roughly 2–3 more sessions like this
one.** Absolute zero is not autonomously reachable: PO-gated/owner-run items stay open —
0097/0098/0103 (parked, PO-gated), the ADR-0018 red-line question, the Q7 spec's 4 PO forks, D5
autopsy (parked), TUN-2 (parked), #0010 real-Proxmox smoke (owner-run), post-#1768 fresh-cast
acceptance (owner-run).

## 3. Owed / obligations

1. **🔑 Key rotation: CLOSED (D9, 2026-07-21)** — the owner rotated all exposed keys; the session
   scratchpad copy was destroyed by the container rollback. Nothing outstanding.
2. **Owner decisions D1–D10 are ALL RULED** (backlog §T7 rulings table, finalized via #1772) — no
   operator should wait on them. The casting mandate is **CLOSED** (#1776 + #1780 both merged);
   D4's Footage Pool condition is now the **attention ledger** landing (its build is in the fleet,
   `claude/attention-ledger`) — dispatch D4 when that merges, nothing else gates it.
3. **Post-#1768 acceptance:** the next *freshly generated* cast is the acceptance check for the
   tattoo fix (expect 2–4 inked of 16, varied hometowns/vocations; committed dups structurally 0).

## 4. Residual ledger

**Moved.** The full residual ledger now lives in the exhaustive backlog (§T4), deduplicated against
the moonshot portfolio and the open issues — #738's real fix is subsumed by #1644; the C2
first-name gap, `_stages_in_scene` verbs, and test-convention nits carry forward unchanged. The
issue map in §T2 is now a *historical* audit-time list — of its original seven, #1713 is **CLOSED**
(owner-closed; the premiere-block bound landed in #1776), #1728/#1777/#1779/#1787 closed with their
landed PRs, and only #1729 (D2 half) / #1778 (T0-3, on #1830) / #1781 (blocked on T0-3) remain open.

## 5. Operational discipline — the short version (details in `SOUL.md`)

- **THE CAMPAIGN LOOP (owner doctrine, 2026-07-22 — run this cycle continuously):**
  **Find bugs → Spec fixes → Fix bugs → Playtest harness → BB Nerd / HIG / Bug audits (each time) → Find bugs.**
  Every fix wave ends with a live playtest-harness capture and the audit panel (BB Nerd, Apple-HIG,
  bug audits) over the fresh telemetry; audit findings seed the next find-bugs round. Never skip the
  playtest+audit leg between fix waves. Also standing: stay synced with `main` as quickly and as
  often as possible (rebase agent branches onto main before every push; merge on green immediately);
  recent P0/P1 fixes — especially ones that recurred through review — get adversarial
  hardened-solution verification, not just a green first test.

- **Background code agents: ALWAYS `isolation: "worktree"`.** Non-isolated agents stomp each other's
  checkouts in the shared tree (lived it: 5-agent collision, full re-dispatch).
- **GitHub mutating calls: strictly one at a time** (two parallel PR-opens/merges trip the abuse
  limit even with hourly headroom).
- **Read `mergeable_state` correctly:** `unstable` = required green → MERGE (advisory failures don't
  block) · `blocked` = required pending/failed → check the *required* set, not the red icons ·
  `unknown` = recomputing. Required = `ci-gate.needs`; golden/visual/theme are GONE (#1765);
  `a11y-matrix` is advisory.
- **CI-success fires no webhook** — arm a `send_later` sweep to catch green; re-arm silently while
  waiting; stop the loop when the terminal state lands.
- **Merge-lane red? Check `main` HEAD first.** If main itself is red, PR re-triggers are churn —
  fix the flake at root, land it first, rebase the rest (`update_pull_request_branch`).
- **npm `onnxruntime-node` ETIMEDOUT during install = infra flake** — empty-commit re-trigger, not a
  code fix. (App token lacks `actions:write`, so re-run-failed-jobs 403s.)
- **Docs-only PRs red on FE lanes?** Stale base dragging unrelated paths into the `changes` diff —
  update the branch onto main; the path filter then skips them.
- **Review-bot routing:** verify P1s on the merits (several were real: shareable-backstory
  false-hold, terse-signature seal, over-broad a11y needles, ink-guard style bypass); route
  substantive ones back to the *authoring agent in its worktree*; skip advisory/docstring/nit
  churn. cubic/Greptile "review in progress" updates need no action (CodeRabbit is no longer used — ignore its notices).
- **Secrets:** keys live in the session scratchpad (outside the repo), 600-perm, referenced by
  path in agent prompts — never in prompts, code, commits, PR bodies, or logs.

## 6. Resume-here playbook

Shell steps:

```bash
# state of the world
git fetch origin main && git log --oneline -5 origin/main
# engine smoke (headless)
npm run build && ORWELL_ENGINE_PORT=8765 node dist/main.js  # then the playtest driver pattern
# FE full gate before pushing FE changes
cd frontend && python3 -m pytest tests/ -n 4
```

Tool steps (GitHub MCP, not shell): list open PRs with `list_pull_requests state=open` and read each
`mergeable_state` (§5 semantics); merge anything `unstable` whose work you know.

Owner obligations are listed in §3; everything else is autonomous.
