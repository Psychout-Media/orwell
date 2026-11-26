# Front-end rebuild plan (ORW-994)

Status: PLAN FOR APPROVAL. No code is written until Kevin and Ryne approve it. Date: 2026-11-26. Card: ORW-994 (Kevin's ask, ORW-146 option 3).

Plain summary: rebuild the player front end as a typed React app, one screen at a time, beside the classic UI, with the game playable at every step. Start from the parked `/play` app (PR #2269). Gate every step with budgets and fit tests that fail the build. The classic UI is deleted only after Ryne has played on the new one.

Standing decisions this plan builds on (not reopened here):
- React, TypeScript and Vite were chosen by Kevin on 2026-11-06. See `docs/FE-REBUILD-SCOPE.md`.
- The engine, the MCP player channel and the Vault Wall do not change. The browser sees only closed, Vault-free shapes.
- The game build is WebSocket only (ADR 0017, amended 2026-11-12).
- Acceptance bar: the golden flows (`docs/FE-GOLDEN-FLOWS.md`, ORW-191) and the ship gate F1 to F5 (`docs/audits/2026-06-27-ship-gate.md`).

## 1. The problems, with numbers

Measured on main (this worktree, 2026-11-26) unless marked.

- Size of the code. `frontend/static/js` holds 131 files and about 4.15 MB of JavaScript (about 80,000 lines). `index.html` has 82 script tags. No bundler, no minifier, no tree shaking.
- God files. `chat.js` 6,349 lines, `slashCommands.js` 6,171, `settings.js` 6,111, `theme.js` 3,469, `sessions.js` 3,248, `admin.js` 3,158, `chatRenderer.js` 2,848. The window kit alone (`orwellWindow.js`) is 1,829 lines and 27 files use it.
- CSS. `style.css` is 22,191 lines and 895 KB, pinned under a 915,000 byte ceiling (ORW-159). A further 56 KB sits in `static/css`. Many windows also inject their own CSS from JS.
- Raw HTML. 564 `innerHTML` uses across the scripts. Each one is a place where the wall and the sanitiser must be right by hand.
- Load and idle (measured 2026-11-06 at 4x CPU throttle, in PR #2269's harness, before the ORW-146 quick wins): 222 requests, 6.5 MB on the wire, 91 requests per minute with nobody touching it.
- One reply streaming (same harness): 4,513 ms of main-thread work, 2,464 ms of style recalculation, 31 long tasks (2.9 s in total, longest 485 ms). That is the lag Kevin and Ryne felt.
- The reload bug class. Live rendering and reload rendering are two paths (issue #1413, ADR 0015). Duplicate bubbles and mid-reply joins have cost many cards.
- Fit. On a large TV (ORW-993) kit windows ran off screen, had sideways scrollbars, photos wider than the window, and the empty send showed the browser's own bubble. Root cause was in the kit, not in each window.
- No GPU on Ryne's VM. Blur and animation are drawn by the CPU over remote desktop. Low-power mode (ORW-154, ORW-190) now defaults on for software rendering.

What the quick wins (ORW-146 slices, merged) already bought: gzip on static files (ORW-164), highlight.js lazy (ORW-160), lazy Settings DOM (ORW-161), idle timers stopped (ORW-162), one shared game-state store (ORW-165), a state ETag (ORW-166), one end-of-turn ping (ORW-167), paged history (ORW-172), request-count budgets in CI (ORW-181), O(new text) streaming (ORW-156), observer storm fixed (ORW-157). These cut the cost per feature. They do not change the shape: 82 hand-ordered global scripts and one 22,000 line stylesheet. The first job of the build is to re-measure classic main with the same harness (see section 8, question 1) so the comparison is fair.

## 2. Target stack, and why

Target:
- React 19 and TypeScript (strict), built with Vite.
- One small store (Zustand in #2269) with named slices and one writer per slice.
- CSS modules plus design tokens. No global stylesheet.
- Vitest for units, Playwright for browser lanes.
- Served by FastAPI under `/play` first (route already written in #2269), with hashed, immutable, gzip assets.

Compared with keeping vanilla JS and adding a bundler:

| Question | Vanilla plus a bundler | React plus TypeScript plus Vite |
|---|---|---|
| Bytes and requests | Fixes load size and the 82 tags. Does not fix the 22,000 line CSS. | Same load win, plus CSS scoped per component. |
| The 564 `innerHTML` sites | Stay. Each is hand-sanitised. | Gone by default. One audited Markdown component is the only raw HTML. A lint rule forbids it elsewhere. |
| Live versus reload render paths (#1413) | Needs a hand-built single path. | One render function over state. Live and reload are the same code by construction. |
| Types across the wall | Closed shapes live in Python; the page reads them untyped. | TypeScript types per closed shape. A key the page reads but the wall dropped fails the build. |
| Streaming cost | Hand-tuned DOM patching, already done once (ORW-156). | Memoised blocks. #2269 measured 339 ms main-thread versus 4,513 ms. |
| Window kit | Keep 1,829 lines of imperative code. | A component with one fit contract (ORW-993) for every window. |
| Risk | Lowest per step. Keeps the god files and the global state. | A rewrite. Mitigated by the strangler path below. |
| Team fit | Two people who read this code today. | Larger ecosystem, many tools and agents know it. |

Verdict: vanilla plus a bundler is a real option and the cheapest first step. It would fix load, and nothing else on the list. It leaves the render-path split, the untyped wall and the CSS as they are. Kevin already chose React on 2026-11-06 and the evidence supports it, so this plan assumes React. If Kevin or Ryne want the cheap option first, the bundler step can be done in a week and does not block this plan (open question 2).

Not chosen: a UI framework with a server renderer (Next, Remix). The game is one authenticated app over a WebSocket; server rendering adds a Node tier we do not want to run. Not chosen: a component library. The kit and the glass look are ours; a library would fight them.

## 3. The wall: what the browser may see

Rules the new app must keep (from ADR 0005, the Vault Wall, and audits ORW-769, ORW-964, ORW-975, and the open ORW-965):
- The browser receives only Vault-free projections through the front-end server. It never talks to the engine. The new app calls the same routes the classic UI calls.
- Closed shapes. Decision and ceremony replies (ORW-769) and the tool events in chat (ORW-964, ORW-975) are cut to allowlists on the server. The new app types exactly those shapes and nothing more.
- Still open when this was written: ORW-965 (closed shapes for retrospective, knowledge, hall-of-fame and cast-progress). Those four screens must not be ported until their shapes are closed, or the port would hard-code leaky fields. This sets the order in section 5.
- The public bubble wall (leak scrubs, reasoning boxes, machinery and real-world-denial scrubs) lives in classic `markdown.js`. #2269 imports it through a build alias so there is one source of truth. The plan keeps that alias until the wall is ported once, with its tests, and then deletes the classic copy. Two copies must never ship at the same time.
- No Vault, soul or hidden-impact field is ever added to a TypeScript type to make a screen work. If a screen needs it, that is a server-side card first.
- Browser guard: a test records every JSON response the app reads in a full golden flow and asserts each key is in the typed allowlist.

## 4. Migration path: strangler, screen by screen

Principle: the classic UI at `/` stays the default and stays complete until the end. The new app grows at `/play`. A player can switch at any time and the game, session and cookie are the same, so the game is always playable. Nothing is turned off until its replacement has passed the gates.

Seam: route level first (done in #2269: `/play` beside `/`), then a per-screen "Open in classic" link in the new shell for any screen not yet ported. This avoids running two frameworks on one page, which is the usual source of strangler pain here (global scripts, shared `window` state).

Steps. After each step the game is playable on `/` and on `/play`.

1. Rebase and revive #2269. Re-point its send path onto the WebSocket turn frame (it uses `POST /api/chat_stream`, which the game build now answers with 426 ws-only; see section 6). Ship `/play` behind opt-in. Screens: load, transcript, composer, streaming, status bar, room strip, decision cards, reload.
2. Transport and mirror. One multiplexed WebSocket client with resync on `beatSeq`, the two-window mirror, the send outbox (F1 to F5 green on `/play`). This is the hardest step and the cutover blocker.
3. Window kit as React. One `Window` component with the fit contract (clamp to the visible viewport, never over persistent chrome, no sideways scroll, images fit). Port the cast card and the knowledge window first because they failed on the TV.
4. Diary room and the remaining play screens: gadget rail, where-you-are, deals, headshot studio, cast and dossier. These need ORW-965 closed first for any screen that reads retrospective, knowledge or hall-of-fame data.
5. Sessions sidebar, account bar, settings (lazy, split by tab), themes and low-power mode. Settings is the biggest single port and the lowest value; it goes late.
6. Finale and retrospective screens. Slash commands and developer tools: ported only if Ryne still uses them.
7. Cutover. `/` serves the new app, `/classic` serves the old one for one release, with a one-line route change as rollback. Ryne signs off after three full sessions on `/play` as his daily driver with no lost or doubled message and no regression he can name (the criterion in #2269).
8. Delete. After one release with no use of `/classic`, delete the 131 scripts, `style.css`, and their tests. Admin pages may stay classic or move last (open question 5).

Each step is a small series of PRs, each one mergeable on its own, each with its own gate (section 5 and 6).

## 5. What to reuse from PR #2269

Reuse (it is a good base and already measured):
- Vite, TypeScript strict, CSS modules, tokens, the `/play` route and its path-contained, hashed, immutable asset serving (`frontend/routes/play_routes.py`, 5 tests).
- The store model: one store, named slices, one writer per slice, components read by selector. The history merge by `_seq`, the send outbox keyed by `clientMsgId`, the frame batcher (at most one store write per animation frame) and the stream controller. 72 Vitest tests and 5 Playwright smokes come with them.
- Markdown through the classic wall by alias, per-block memoisation, "Production notes" reasoning box.
- Decision cards for every pending kind with stable idempotency keys.
- The perf harness (`perf-compare.mjs`), the size report and the `fe-web` CI job with path filtering. The `fake_model_server` repeat option.
- `docs/design/fe-api-contract.md`: every endpoint and message shape used, and the delta design (section 6 there).

Change or drop:
- Send and stream path. It uses `POST /api/chat_stream` and SSE. The game build is WebSocket only (ADR 0017 amendment, 2026-11-12), so this must be rewritten on the WS `turn` frame and mirror. The frame batcher and stream controller survive; the transport under them changes.
- The 20 second poller. Replace with the delta applier from the same PR's design notes; keep a 60 second safety poll only if the measured idle budget allows.
- The PR is 20 days old (last update 2026-11-07). It needs a rebase on main and a re-run of its measurements. Several ORW-146 slices and ORW-1008 and ORW-1014 changes touch the same routes.
- Initials chips instead of portraits, and no attachments, tool beats, slash commands, diary room, cast, dossier, settings. Those are steps 3 to 6.
- The page-wide thinking observer stub for `markdown.js` goes away when the wall is ported once.
- The login page still returns to `/`. Fix at cutover.

## 6. Test and HIG guards

Every step must pass these before merge. Guards are never loosened to pass; a ceiling is only raised with Kevin's say-so.

Functional:
- The golden flows (ORW-191) run unchanged against `/play`. The DOM contract hooks (`#message`, `#chat-history`, `.msg-user`, `.msg-ai`, `#orwell-decision-card`) are kept, or an equivalent hook is added and the doc updated in the same PR.
- F1 to F5 (reload, outbox, mirror, mid-generation join, resume) on `/play`, on the WebSocket transport only.
- Vitest per component and store slice. Fault cases for 401, 409, 413, 426 and a dropped socket.
- The typed-shape wall test (section 3).

Fit and HIG (extends ORW-993 and the window convention gate #1268):
- The window fit test runs against every `Window` in the new app: no horizontal overflow (`scrollWidth <= clientWidth`), the rectangle inside the visible viewport and clear of persistent chrome, images inside their container, no native validation bubble.
- Viewport matrix: 1280x720 (a 4K TV at 150%), 1920x1080, 3840x2160, 390x844 phone portrait, 844x390 phone landscape (safe-area insets).
- Tap targets at least 44 pt on coarse pointers; contrast floor held by the existing matrix (13.1 to 15.7:1 measured on reasoning text); reduced motion, reduced transparency and increased contrast honoured; focus ring neutral.
- Lint: no `dangerouslySetInnerHTML` outside the Markdown component; no `backdrop-filter` without the low-power guard.

Browser lanes:
- Chromium, as in `fe-web` today.
- WebKit (Safari engine proxy) in the smoke.
- A software-rendering profile that matches Ryne's VM: Chromium with the GPU off and software GL, 4x to 6x CPU throttle, running the perf harness with hard budgets.
- A manual iPhone checklist per phase (load, send, stream, rotate, decision card, background and return).
- An opt-in report beacon (INP, long tasks, script errors, no content) so Ryne's real VM sends real numbers during normal play.

## 7. Performance budgets

Hard gates in CI from step 1. Numbers below are proposed starting values; where #2269 already measured, that is the baseline.

Load (cold, 4x CPU throttle):
- JS at most 200 KB gzip for the first screen (#2269: 107 KB). CSS at most 40 KB gzip (#2269: 2.8 KB). At most 15 requests (#2269: 9).
- Later screens load on demand and each has its own size line: Settings, finale, retrospective and the headshot studio cost nothing until opened.
- Time to a usable composer: budget to be set from the first software-rendering run; target no worse than 3 s on the VM profile.

Interaction:
- INP at most 200 ms at 4x throttle for send, open window, close window, card choice.
- Streaming one reply: no long task over 100 ms, style recalculation under 50 ms per reply, frame p95 under 33 ms (#2269: one long task of 71 ms, 7 ms of style recalc).
- Idle: at most 6 requests per minute with polling, zero extra with the WebSocket (#2269: 3 per minute).
- Memory: a 300-turn transcript stays under a ceiling set from the first measurement (virtualised list is planned for step 4).

TV (1280x720 to 3840x2160):
- Every window passes the fit test at every size; text stays readable at 150% scaling; no layout shift when a window opens.
- No blur or animated wallpaper on by default on software rendering (low-power mode, ORW-154).

Phone (390x844 and 844x390):
- No horizontal page scroll; dvh units and safe-area insets everywhere; sheets on transform; bottom composer not covered by the keyboard.
- Same JS budget as desktop. Tap floor 44 pt.

Budgets apply to the new app only. Classic is left as is and is measured for comparison.

## 8. Order, size and risks

Sizes are rough, in working days for one focused agent lane with Kevin's review cycle. They are a guide for ordering, not a promise, and Kevin's rule is milestones without dates.

| Step | What | Size | Gate that ends it |
|---|---|---|---|
| 0 | Re-measure classic main with the #2269 harness | 1 | Numbers on this card |
| 1 | Revive #2269 on the WebSocket, ship `/play` opt-in | 5 to 8 | Golden flows, size and perf budgets |
| 2 | Transport, mirror, outbox, resync | 8 to 12 | F1 to F5 on `/play` |
| 3 | `Window` kit and the TV fit | 5 to 8 | Fit matrix green |
| 4 | Diary room, gadgets, deals, cast, dossier, headshot studio (after ORW-965) | 10 to 15 | Golden flows plus screen tests |
| 5 | Sessions, account bar, settings, themes | 8 to 12 | HIG lanes green |
| 6 | Finale, retrospective, slash commands | 5 to 8 | Ship gate F1 to F5 plus finale walk |
| 7 | Cutover with rollback | 2 to 3 | Ryne's three sessions |
| 8 | Delete classic | 3 to 5 | One release with no `/classic` use |

Total: roughly 45 to 70 working days of lane time, spread over several weeks of calendar time because the engine lanes keep changing the same routes.

Risks:
- Wall drift. A second copy of the leak scrubs would be the worst outcome. Mitigation: one source via alias until a single port with the full test set.
- A rebuild that never ends. Mitigation: the strangler path keeps `/` shipping; each step is mergeable alone; step 8 is a real delete with a date-free exit criterion.
- Engine lanes keep moving the routes (ORW-1008, ORW-1014, ORW-934 and others). Mitigation: types generated or checked against the server closed shapes, so a changed shape fails CI instead of a player.
- The WebSocket work (step 2) is the largest unknown: resync, the 64-delta ring and the mirror. Mitigation: do it before any screen port beyond step 1.
- No real iPhone or Ryne's VM in CI. Mitigation: WebKit, the software-rendering profile, the manual checklist and the report beacon.
- Two UIs mean two sets of tests for a while. Mitigation: shared golden-flow suite; classic tests are frozen, not extended.
- Ryne's play sessions are the real test. A bug on `/play` must never cost him a session; `/` stays one click away until cutover.

## 9. Open questions for Kevin and Ryne

1. Re-measure first? Approve step 0 (classic main on the #2269 harness) before any build, so the "before" numbers include the ORW-146 quick wins.
2. Cheap option first? Do you want the vanilla plus bundler step (about one week, fixes load only) in the meantime, or go straight to React as decided on 2026-11-06?
3. Is the bar for cutover right? Ryne: three full sessions on `/play` as the daily driver with no lost or doubled message and no regression you can name. Is three the right number, and do you want a longer soak?
4. Which screens must be in before Ryne plays on it? Proposed: transcript, composer, decision cards, status, room, cast and dossier, diary room, deals, settings basics. Anything missing or safe to leave for classic?
5. Admin pages: port them, leave them classic forever, or drop them from the game build?
6. Slash commands and developer tools: does anyone still use them? If not, they are not ported.
7. Priority against the engine lanes. This is about 45 to 70 lane-days. Should it run in parallel with the current engine work, or only in gaps?
8. Real-device numbers. Ryne: are you willing to run the opt-in report beacon (no content, only timings and errors) on your VM and send a screen recording of one session per phase?
9. Pace for ORW-965. The four retrospective, knowledge, hall-of-fame and cast-progress shapes should be closed before steps 4 and 6. Should that card move up now?
10. Deleting classic. Is "one release with no `/classic` use" enough, or do you want it kept longer as a fallback?
