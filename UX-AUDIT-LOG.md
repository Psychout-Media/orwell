# UX Refactor Audit — Persistent Ledger

Subject: **Orwell** — immersive single-player Big Brother social-game web app (chat-centric "game build"; Python/FastAPI front-end + TypeScript engine over MCP). Visuals fully included. The conversation IS the game (ADR 0003); the Vault Wall (secret state never reaches the player) is absolute.

**Status legend:** `OPEN` → `VIEWED` (seen in telemetry) → `FIXED` (remediated, awaiting re-capture) → `VERIFIED` (re-seen clean).
**Severity:** `LAUNCH-BLOCKING UX` · `HIGH-PRIORITY POLISH` · `UX REFACTOR BACKLOG` · `OUT-OF-LANE` (non-experiential; deferred).

**Device matrix:** desktop = 1440×900, fine pointer · mobile = 390×844, touch, DPR≥2 · spot checks: small-Android 360, landscape, tablet 820/1024.
**Passes:** normal + `prefers-reduced-motion`. **Two windows on one clock** for same-viewport parity.

---

## 🔗 GitHub issue tracking (added 2026-06-23)

The remaining open **UX Phase-4 polish** `J*` items in this ledger are tracked as one umbrella issue,
[**#606**](https://github.com/Psychout-Media/orwell/issues/606) (decision-card copy, wayfinding, premiere
motion, theme/cast IA, contrast misses, incl. **J1-30**). This ledger stays the per-finding evidence
record; #606 is the live status tracker for the open set. `J*` items already marked `FIXED`/`VERIFIED`
below (and in `docs/audits/2026-06-21-open-items-verification.md`) need no issue. A few cross-cutting
UX findings escalated to their own issues (e.g. **UX-1** → [#616](https://github.com/Psychout-Media/orwell/issues/616);
the **UX-2..10** roundup → [#626](https://github.com/Psychout-Media/orwell/issues/626)); the full
finding-code → issue map lives at the top of `ROAST-LOG.md`.

---

## 📌 OPEN ITEMS — consolidated (reconciled 2026-06-21)

> The single up-to-date view of what's left. The per-journey tables below are the source detail; this section
> reconciles their (often stale) status markers and rolls in the cross-cutting forward work. **All the
> launch-relevant blockers and the real-LLM season-transition backlog are CLOSED** — what remains is a
> UX/a11y **polish backlog** + standing engineering forward-work.
>
> **Source-verification reconciliation (2026-06-21):** a code-level sweep
> (`docs/audits/2026-06-21-open-items-verification.md`) confirmed several per-journey table cells below
> are **stale OPEN → actually FIXED**: **R2-01** (`c7ff13d` re-tap no-op), **J2-07** (shared
> cue-skip seam), **J3-18** (focus-on-mount, `e461139`), **J3-21** (`msg-ooc` demarcation, L36),
> **J3-24** (aria-hidden rhythm emoji, `fef04af`). Those cells are corrected inline below.

**Closed this campaign (no longer open):**
- **Real-LLM season-transition + endgame:** R1-01 (premiere soft-lock), R3-01 (eviction re-prompt prompt fix), R4-01 (finale auto-advance) — all **merged + VERIFIED live**; R5-01 (prestige keep-path) **resolved by owner ruling**; R6-01/02/03/04 (cast-photo prewarm) **resolved**, with **ADR 0013** (cast photos require a model-authored identity) built.
- **J5 endgame surfaces:** J5-01…J5-17 (gated set #6, #475) + **J5-18/19/20/21** (#491/#496) — placement on recap, endgame responsive-matrix coverage, juror-vote risk signal, dismiss tab-order. J5-23 = NOFIX (design ruling).
- **Engine-progression "stall" cluster (J3-05/06, J4-05/06/18):** **superseded by R1-01/R1-02** — the FE error-correction belts (premiere-intro belt fix + the L39b forced-advance escalation) now drive progression; the **full weekly loop + multi-week play VERIFIED live**. (The original captures predate the belt fixes.) Residual is the *UI-signal* polish below, not engine progression.
- **J4-15 / J4-27** (tutorial dismiss size + stale "premiere week" header) → gated set #6 (J5-16). Earlier J1 launch-polish (J1-04/23/25/34) → #468.

**Still genuinely open:**

| Bucket | Items | Notes |
|---|---|---|
| **HIGH — decision-card UX/a11y (general card, not just endgame)** | J4-16, J4-17, J4-20, J4-23, J4-24, J4-26 | J4-16 dismiss re-arm gap (needs an **owner decision** on re-arm semantics); J4-17 binding vs non-binding comp-round share a title; J4-20 disabled-confirm has no hint (WCAG 3.3.2); J4-23 card scrim/figure-ground (the endgame card got `box-shadow` via J5-03 — the **general** card still lacks a scrim); J4-24 chips identical by kind (endgame high-stakes kinds got the risk skin via J5-20 — **other kinds** still undifferentiated); J4-26 no persistent phase label after the card closes. |
| **HIGH — premiere/phase wayfinding** | J3-06, J3-07, J3-08 | J3-06 met-progress feedback (engine side now belt-driven, but the **progress UI** is still mute); J3-07 no persistent game-phase indicator; J3-08 no "X of 15 met" counter. |
| **MED/LOW — J3 polish backlog** | J3-09…J3-25 (excl. resolved) | Tutorial copy/graduation/recovery, decision-card target-size + contrast + focus-mgmt on desktop, OOC double-paren demarcation, thumbnail breakage at casting (J3-15), roster met/unmet state (J3-20), emoji text-alternatives. See the **Journey 3** table. |
| **MED/LOW — J4 polish backlog** | J4-04, J4-07, J4-19, J4-21, J4-28 | `data-binding` on non-binding cards; static bar-fill; prescriptive post-confirm prefill; no ambient pending indicator post-dismiss (J4-21); no signpost from card → cast panel. |
| **POLISH — J5/J2 tail** | J5-22, J5-24, J2-04 | Decision-card error copy is system-language; retro `aria-label` reads "📼" verbatim; duplicate cast-roster control (LOW, needs confirm). |
| **POLISH / VERIFY — real-LLM tail** | ~~R2-01~~, R5-02, R7-01 | ~~R2-01~~ **FIXED** (`c7ff13d` — single-pick chip re-tap is a no-op, `orwellDecision.js:311-318`); **R5-02 (VERIFY)** — on the KEEP path the new cast must carry **zero** prior-season knowledge of the player (owner ruling; needs a deterministic callTool check); R7-01 the season-2 casting probe couldn't drive the casting-screen send affordance (harness gap, not confirmed product). |

**Cross-cutting forward work (from `CLAUDE.md` → Open forward work; new work starts as a new spec/queue item):**
- **Calibration** — primary goal **MET** (active wins 20% vs passive 7%); do **not** lower `gameRespect` further. Optional low-pri reach-side lever only.
- **ADR 0006 / 0066 Phase-2** (deferred time/sleep extensions: NPC next-day fatigue, multi-night meter, per-conversation clock) — on the PO review list.
- **ADR 0012 — two-window "Messenger mirror"** — *parallel session, active WIP*: FE landed #497–#499; ADR/README still read **Proposed** and the binding **live-LLM lockstep gate** wants a re-run post-§3.1. Owned by that track — flagged here only so the status drift is visible.
- **0022** (MVP-2 rich UI, deferred by ADR 0003) and **0059** (hidden seeded relationships, spec-only) — unbuilt specs.
- **0010** container smoke on a real Proxmox host (+ the A4 single-PAT deploy verification) — do during the private-repo flip.
- **Postgres + pgvector** relational tier — post-launch scale-out (SQLite + sqlite-vec shipped opt-in, #330).

---

## Environment / rig (Phase 1)

| Item | Value |
|---|---|
| Engine | TS, built to `dist/main.js`; HTTP MCP on `ORWELL_ENGINE_PORT` (8765 here) |
| Front-end | `frontend/`, `uvicorn app:app`; `ORWELL_GAME_BUILD=1 AUTH_ENABLED=false LOCALHOST_BYPASS=true` |
| LLM | OpenRouter `deepseek-v4-pro` wired via `/api/model-endpoints` (key kept in gitignored env only — never committed) |
| Telemetry rig | `./.audit-telemetry/` (gitignored) — Playwright two-window × device matrix, video→ffmpeg filmstrip, mutation/event log, interaction traces, A/B + reduced-motion |
| Tooling | Node 22, Python 3.11, Playwright 1.60 + chromium, ffmpeg 6.1 |

---

## Findings index

| ID | Journey | Severity | Status | One-line |
|---|---|---|---|---|
| J1-01 | J1 | HIGH-PRIORITY POLISH | VIEWED | Raw LLM model slug "deepseek-v4-pro" leaks to player (session title in sidebar/header + composer indicator) |
| J1-02 | J1 | HIGH-PRIORITY POLISH | VIEWED | Composer placeholder reads "Message Orwell…" while narrator/header is "Big Brother" — brand/voice mismatch |
| J1-03 | J1 | LAUNCH-BLOCKING UX | VIEWED | Auto-sent "(production cue — begin the casting interview … do not wait for me to speak.)" stage-direction rendered in the player's transcript |
| J1-04 | J1 | HIGH-PRIORITY POLISH | FIXED (#468) | "Your Cast Photo" card overlaps/occludes the streaming narration that explains it (figure-ground) |
| J1-05 | J1 | HIGH-PRIORITY POLISH | VIEWED | Narration says "the camera panel next to the chat box" — a desktop-spatial reference that breaks on mobile |
| J1-06 | J1 | HIGH-PRIORITY POLISH | VIEWED | Theme picker exposes 21+ themes; only ~5 are house themes — choice overload + brand dilution |
| J1-07 | J1 | UX REFACTOR BACKLOG | VIEWED | Settings exposes many inherited-workspace toggles irrelevant to a BB player (extraneous load) |
| J1-08 | J1 | HIGH-PRIORITY POLISH | VIEWED | "No file chosen" clips to "No fil…" in the cast-photo card on mobile (text overflow) |
| J1-09 | J1 | UX REFACTOR BACKLOG | VIEWED | Welcome modal has no visible dismiss/secondary action; Escape works but is undiscoverable |
| J1-10 | J1 | UX REFACTOR BACKLOG | VIEWED | Welcome card fills only ~10% of desktop viewport — vast dead space, low visual weight on large screens |
| J1-11 | J1 | UX REFACTOR BACKLOG | VIEWED | Welcome secondary paragraph is low-contrast/dimmed — WCAG 1.4.3 contrast candidate |
| J1-12 | J1 | UX REFACTOR BACKLOG | VIEWED | Mobile: settings + theme reachable only via hamburger→drawer→gear (extra steps; gear/theme not directly visible) |
| J1-13 | J1 | HIGH-PRIORITY POLISH | VIEWED | Cold-load loader window not yet visually verified; first paint is a long dark hold before welcome (status-visibility) |

### J1 consolidated additions (5 specialists, de-duped) — J1-14…J1-34

| ID | Sev | Status | Finding (principle → consequence) | Evidence / source |
|---|---|---|---|---|
| J1-14 | HIGH | VIEWED | Settings opens to **Account** tab, not Appearance (recognition/Hick) — wrong default for a zero-data player who wants look/feel. | flows-F3, visual-F8; `desktop/normal/shots/06-settings.png` |
| J1-15 | BACKLOG | VIEWED | **Redundant dual theme paths** (standalone `#tool-theme-btn` popup + Settings→Appearance "Theme" row + Shortcuts "Open Theme") — Tesler. | flows-F2; `07-theme-picker.png`, `06-settings-appearance.png` |
| J1-16 | LAUNCH-BLOCKING | VIEWED | **Session auto-titled "Casting Interview Production Cue"** in sidebar + header — the leaked cue propagates into a persistent player-facing label (match-to-real-world). Part of the J1-03 cluster but distinct (persists beyond transcript). | IA-F1, interaction-F3, content-#1; header/sidebar crops |
| J1-17 | BACKLOG | VIEWED | **Heavyweight Account IA** (Logout/Change Password/2FA) for "Unknown/User" single-player — enterprise furniture mismatched to task. | IA-F5; `06-settings-account.png` |
| J1-18 | HIGH | VIEWED | **Settings gear has no `aria-label`** (only `title`); icon-only nav recognition load (theme btn has aria-label, gear doesn't — inconsistent). WCAG 4.1.2. | IA-F3, content-#9; `index.html:1012` vs `:1009` |
| J1-19 | BACKLOG | VIEWED | **Duplicate profile-photo entry points** (casting card + Settings→Account) with near-identical copy — consistency/which-is-canonical. | IA-F6; `06-settings-account.png` |
| J1-20 | HIGH | VIEWED | **Under-animated marquee beats** — welcome entrance, welcome→casting, narration reveal are hard cuts/pop-ins (no staging/streaming); reduced-motion therefore only trivially compliant. Peak-end + game-feel. | visual-F3, interaction; frames `f_0003→f_0004`, `f_0037→f_0039`, narration mass flat from `f_0040` |
| J1-21 | HIGH | VIEWED | **Composer placeholder "Message Orwell…" contrast ~2.79:1** — WCAG 1.4.3 FAIL. | content-#5, visual-F4; `08-composer-empty.png` (sampled) |
| J1-22 | HIGH | VIEWED | **Streaming meta strip "tok/s · ⟳ 12%" contrast ~1.5–2:1** + tiny — the only "producers working / progress" feedback is near-invisible; also an OOC artifact in-fiction. WCAG 1.4.3. | visual-F4, interaction-F7, content-#8; `05-casting-kickoff.png` meta-row |
| J1-23 | HIGH | FIXED (#468) | **No scrim / triple-stacked overlays** — cast-photo card (and theme popup over it) have no backdrop dim, so live narration competes for figure status; Settings modal proves the scrim exists. Gestalt figure/ground. | visual-F1/F6, interaction-F4/F8; `f_0041`, `f_0080`, `07-theme-picker.png`; contrast `f_0061` |
| J1-24 | BACKLOG | VIEWED | **Theme swatch dots vanish on dark tiles** (the feed/midnight) + abstract 3-dot preview undersells themes. Signifier quality. | visual-F7; `07-theme-picker.png` |
| J1-25 | LAUNCH-BLOCKING | FIXED (#468) | **Cast Photo dialog: no `aria-modal`, no focus trap, background not inert** — focus escapes into chat (confirmed: mobile Escape landed on `body`). Welcome modal does this correctly — reuse it. WCAG 2.1.2/4.1.2. | content-#4; `orwellWindow.js:340-341`; `mobile/normal/mutation-event-log.jsonl` t=16743 |
| J1-26 | LAUNCH-BLOCKING | VIEWED | **Cast-photo portrait/library tiles are non-semantic clickable `<div>`s** (no role/tabindex/key handler/name) — keyboard- & SR-only players cannot pick/regenerate a portrait in OOBE. WCAG 2.1.1/4.1.2. | content-#3; `orwellHeadshot.js:272, 227` |
| J1-27 | HIGH | VIEWED | **Cast-photo status messages have no live region** ("Generating…/Upload failed/photo service offline" silent to SR). WCAG 4.1.3. | content-#6; `orwellHeadshot.js:242, 298` |
| J1-28 | HIGH | VIEWED | **Settings helper/description text contrast ~2.68:1** — WCAG 1.4.3 FAIL (toggle descriptions unreadable for low-vision). | content-#2; `06-settings-appearance.png` (sampled) |
| J1-29 | HIGH | VIEWED | **Loader: ~6s near-black, no spinner/skeleton/status text, no `role=status`/`aria-live`, ASCII-wave ignores reduced-motion.** H1 + WCAG 4.1.3 + 2.3.3. (Extends J1-13.) | interaction-F1, content-#10, visual-F9; `index.html:285-298`; `f_0001-0003`; trace 1555→7424ms |
| J1-30 | HIGH | VIEWED | **No "producers are thinking" pre-token state** between dismiss (7703ms) and first token — reads as lag after the player's only deliberate action. H1/Doherty. | interaction-F5; mutation-log gap 7703→11544ms |
| J1-31 | BACKLOG | VIEWED | **Welcome CTA: weak/inconsistent `:focus-visible` ring + empty `aria`** on the journey's first interactive element. WCAG 2.4.7/4.1.2 (minor — visible text mitigates). | interaction-F6; `trace.json` welcome_ctas `aria:""`; `f_0015` vs `04-welcome-overlay.png` |
| J1-32 | BACKLOG | VIEWED | **Redundant cast-photo lead** — title "Your Cast Photo" then body "**Your cast photo.** Upload…". Content concision. | content-#11; `orwellHeadshot.js:346` |
| J1-33 | BACKLOG | VIEWED | **Vocabulary drift** — Settings/Shortcuts say "sessions/conversations/Toggle Window" vs in-app "Chats". Consistency. | content-#12; `06-settings-shortcuts.png` |
| J1-34 | HIGH | FIXED (#468) | **Casting-kickoff cognitive overload (composite)** — long live stream + leaked "You" cue + floating 4-option photo card overlapping the text, all at once, no lead-in. Sweller extraneous load at the marquee moment. | interaction-F4; `05-casting-kickoff.png` |

**Positives confirmed (keep as patterns):** welcome modal a11y is exemplary (`role=dialog`+`aria-modal`+focus-trap+inert+initial-focus, `orwellOnboarding.js:110-130,233,264-269`); `#chat-history` is `role=log aria-live=polite` with `aria-busy` gating the stream (`index.html:1064`, `chat.js:1117/3189`); two-window same-viewport parity is pixel-identical (0.0% — deterministic); welcome copy + "Meet the producers" CTA are strong, on-voice; mobile DPR2 is crisp.

### De-dup / cluster map
- **The kickoff-cue cluster** (the #1 launch-blocker, all 5 lenses): **J1-03** (visible "You" bubble) + **J1-16** (auto-title) + content-#1 + interaction-F2/F3 + IA-F1 → fix together.
- **Cast-photo surface cluster:** J1-04/J1-23 (scrim) + J1-25 (modal a11y) + J1-26 (tile semantics) + J1-27 (live region) + J1-08 (file clip) + J1-32 (lead) + J1-34 (overload) → fix together.
- **Contrast cluster:** J1-11 (welcome 2ndary — re-measured **PASS ~7.35:1**, drop) + J1-21 (placeholder FAIL) + J1-22 (meta FAIL) + J1-28 (settings helper FAIL).
- **OOC-artifact cluster:** J1-01 (model slug) + J1-22 (tok/s) + content-#8 (version/"Unknown/User").
- **Loader cluster:** J1-13 + J1-29.
- **Theme cluster:** J1-06 + IA-F4 (GPT/claude) + J1-24 (swatches) + J1-15 (dual paths).
- **Note:** J1-11 (welcome secondary contrast) was a *visual estimate*; content-a11y re-measured it at **~7.35:1 (PASS)** → **downgraded/closed**, no longer a finding. Differential resolved in favor of "not a defect."

---

## Detailed entries

### J1-01 — Model slug leaks to the player  · HIGH-PRIORITY POLISH · VIEWED
- **Principle:** Nielsen H2 (match system↔real world) / immersion. The game build gates the model *picker* (`game-trim.css:69` hides `#model-select` for non-admins) but not the model *name*.
- **Consequence:** The Big Brother fiction is broken by a technical id. The session auto-title shows "deepseek-v4-pro 12:12:53 AM" in the **Chats sidebar** and (early) the chat header; the composer shows "deepseek-v4-p…". A player reads an LLM slug where a story label belongs.
- **Evidence:** desktop `runs/j1/desktop/normal/shots/06-theme-picker.png` (sidebar + header), `07…` (composer); mobile `…/mobile/normal/shots/06-composer-empty.png` (composer "deepseek-v4-p…"). Gating: `frontend/static/css/game-trim.css:69`.
- **Differential:** Not a harness/admin artifact — title + composer label are not admin-gated (only `#model-select` is). The header *is* later renamed to "Casting Interview", so the leak is persistent in **sidebar + composer**, transient in the header.
- **Confidence:** H. **Fix:** In game build, suppress the model name in composer/header and title game sessions in-fiction (e.g., "Casting Interview", "Big Brother — Week N").

### J1-02 — Composer placeholder "Message Orwell…" vs "Big Brother" voice · HIGH-PRIORITY POLISH · VIEWED
- **Principle:** Voice/tone consistency; match to real world. The composer placeholder is the inherited workspace brand ("Orwell"); the in-fiction interlocutor is "Big Brother"/the producers (header reads "Big Brother"/"Casting Interview").
- **Consequence:** Immersion wobble at the exact input the player uses every turn; mixed mental model of "who am I talking to."
- **Evidence:** desktop `07-composer-empty.png`, mobile `06-composer-empty.png` — placeholder "Message Orwell …".
- **Differential:** Could be intentional product branding, but it conflicts with the game header/narrator. Confidence: H. **Fix:** game-build composer placeholder → in-fiction ("Talk to the house…", or context-aware "Answer the producers…").

### J1-03 — Production-cue stage direction rendered in the transcript · LAUNCH-BLOCKING UX · VIEWED
- **Principle:** Vault/fourth-wall + content clarity. The onboarding kickoff auto-sends a message ("(production cue — begin the casting interview now. Reach out to me first, in character as the producers; do not wait for me to speak.)") through the normal submit path (`orwellOnboarding.js` ~417–429); it renders as a visible bubble.
- **Consequence:** The player's very first transcript line is a behind-the-scenes prompt instruction "spoken" by them. It exposes the scaffolding, is confusing (the player didn't type it), and damages the first-impression immersion the welcome just built.
- **Evidence:** mobile `06-composer-empty.png` + `05-casting-kickoff.png` (top bubble "(production cue — begin the casting interview now…)"). Visible at first paint of the interview.
- **Differential:** Confirmed render, not a desync — it persists in the transcript. **Confidence:** H. **Fix:** send the kickoff as a hidden/system trigger (not via the visible composer path), or style+suppress it as a non-rendered control message. Verify the auto-send doesn't enter `chat-history`.

### J1-04 — Cast-photo card occludes the narration explaining it · HIGH-PRIORITY POLISH · VIEWED
- **Principle:** Gestalt figure/ground + common region; progressive disclosure. The floating "Your Cast Photo" card overlays the streaming producer narration that describes the photo step.
- **Consequence:** The player reads a card and a half-hidden paragraph saying the same thing; the explanatory text is covered at the moment it's most needed.
- **Evidence:** desktop `07-composer-empty.png`, mobile `05-casting-kickoff.png` (card sits over "…camera panel next to the chat box … Skip for now").
- **Confidence:** H. **Fix:** dock the cast-photo affordance inline below the narration (in flow), or delay the card until the narration beat completes; don't float it over live text.

### J1-05 — Narration references desktop UI geography on mobile · HIGH-PRIORITY POLISH · VIEWED
- **Principle:** Gulf of evaluation (Norman); match to real world. Narration: "See that little camera panel next to the chat box? 📷". On mobile (390px) there is no panel "next to" the composer.
- **Consequence:** The instruction points at UI that isn't where it says on mobile → the player hunts for a control that isn't there.
- **Evidence:** mobile `05-casting-kickoff.png`, `06-composer-empty.png` (narration text vs mobile layout).
- **Differential:** Content/engine-prompt issue surfacing as a UX mismatch — the moment prompt hard-codes desktop spatial language. **Confidence:** M-H. **Fix:** make the photo affordance the diegetic anchor (the card itself, wherever it renders) and avoid spatial deixis in copy; OR ensure a consistent camera affordance position across breakpoints. *(Likely [Out-of-lane] for the engine prompt wording — but the FE placement contract is in-lane.)*

### J1-06 — Theme picker: 21+ themes, ~5 house themes · HIGH-PRIORITY POLISH · VIEWED
- **Principle:** Hick's law (choice overload); brand/immersion coherence; recognition. The picker shows house themes (the feed, telescreen, room 101, memory wall, sequester) **plus** many inherited workspace themes (original, light, midnight, paper, cyberpunk, retrowave, forest, ocean, urne, copper, terminal, organs, lavender, GPT, claude, cute).
- **Consequence:** The curated 5 house themes (0052) are diluted by 16+ off-brand options; "GPT/claude/cute" shatter the Big Brother fiction.
- **Evidence:** desktop `06-theme-picker.png` (full grid).
- **Confidence:** H. **Fix:** in game build, scope the default theme grid to the 5 house themes (keep Customize for power users); or visually section "House themes" first.

### J1-07 — Settings exposes irrelevant inherited toggles · UX REFACTOR BACKLOG · VIEWED
- **Principle:** Tesler's conservation of complexity / extraneous cognitive load; relevance. Appearance shows Chat-Area, Chat-Bar (Agent/Chat switcher, Attach Files), Sidebar brand-name toggles, Text-only Emojis, etc. — workspace controls, several meaningless for a single-player narrative game.
- **Consequence:** A first-timer scanning Settings wades through chat-workspace plumbing to find the few game-relevant controls (theme/density/reduced-motion).
- **Evidence:** desktop `05-settings-appearance.png`.
- **Confidence:** M. **Fix (backlog):** curate a game-build Settings set; hide/relegate workspace-only toggles.

### J1-08 — "No file chosen" clipped on mobile · HIGH-PRIORITY POLISH · VIEWED
- **Principle:** Reflow (WCAG 1.4.10) / no clipping. The native file input label truncates to "No fil…" in the cast-photo card at 390px.
- **Consequence:** Minor, but reads as broken; the file-state text is unreadable.
- **Evidence:** mobile `05-casting-kickoff.png`.
- **Confidence:** H. **Fix:** custom file-control layout that wraps/abbreviates gracefully, or hide the native "no file chosen" text.

### J1-09 — Welcome has no visible escape hatch · UX REFACTOR BACKLOG · VIEWED
- **Principle:** Nielsen H3 (user control/freedom) + discoverability. Single CTA "Meet the producers", `dismiss:false`; Escape dismisses but is undiscoverable; no way to reach settings/model/theme before committing.
- **Consequence:** A player who wants to set theme/model first (or just look around) has no signposted path; the only forward door is the interview.
- **Evidence:** `trace.json` welcome_ctas (one CTA, dismiss:false); `03-welcome-overlay.png`.
- **Differential:** Single-funnel is arguably intended (steelman: focus). **Confidence:** M. **Fix (backlog):** add a low-emphasis "Settings"/"Look around first" affordance, or confirm intent.

### J1-10 — Welcome card tiny on desktop (~10% fill) · UX REFACTOR BACKLOG · VIEWED
- **Principle:** Visual hierarchy / use of space. 420×295 card in 1440×900 = ~10% area; vast empty dark field.
- **Consequence:** The product's first impression reads as sparse/under-confident on desktop; weak visual anchor.
- **Evidence:** `trace.json` welcome_geometry desktop {fill:10} vs mobile {fill:30}; `03-welcome-overlay.png`.
- **Differential:** Cinematic minimalism (steelman). **Confidence:** M. **Fix (backlog):** add atmospheric framing (house imagery/vignette/eyes motif) or scale the card/typography up on ≥1024.

### J1-11 — Welcome secondary text low contrast · UX REFACTOR BACKLOG · VIEWED
- **Principle:** WCAG 1.4.3 (contrast ≥4.5:1). The "producers are due any minute…" paragraph is visibly dimmer than the primary line.
- **Consequence:** Harder to read for low-vision users / bright environments.
- **Evidence:** `03-welcome-overlay.png` (visual estimate — needs token/ratio confirmation).
- **Confidence:** M (estimate). **Fix:** verify the muted-fg token ratio on `--panel`; lift to AA.

### J1-12 — Mobile settings/theme behind drawer · UX REFACTOR BACKLOG · VIEWED
- **Principle:** Wayfinding / Fitts. On mobile the gear (`#user-bar-settings`) and theme (`#tool-theme-btn`) live in the collapsed sidebar — not visible; reachable only via hamburger→drawer.
- **Consequence:** +1–2 taps and a hidden affordance for the two most-likely first-launch controls.
- **Evidence:** capture log (both "not visible" on mobile); hamburger present in `05/06` mobile shots.
- **Differential:** Standard mobile nav pattern (steelman: acceptable). **Confidence:** H (behavior), M (severity). **Fix (backlog):** confirm the drawer is the intended path; ensure the hamburger is obvious during onboarding.

### J1-13 — Loader / first-paint hold · HIGH-PRIORITY POLISH · VIEWED (needs frame confirm)
- **Principle:** Nielsen H1 (system status visibility) / Doherty. First paint is a dark field; welcome appears only after ~6s of probes in capture.
- **Consequence:** A multi-second dark screen with no status risks reading as "broken/blank" on first launch.
- **Evidence:** filmstrip first frames near-black; `02-loader.png` (to confirm whether `#app-loader` spinner shows). Needs frame-level read by visual specialist.
- **Confidence:** M. **Fix:** ensure the loader/spinner is visible during the probe window; cap perceived wait.

---

## Cross-reference with main (other auditors land UX fixes fast — re-checked each journey)

- Another auditor's **live-walkthrough log LW1–LW15** lives in `docs/audits/2026-06-10-full-product-audit.md` (~L1901). Reconciliation:
  - **LW1** (unstyled native file input on casting/headshot gate + Settings pic) [#411, marked fixed] **overlaps my J1-08** ("No file chosen" clipping). → **Re-verify J1-08 against current main before fixing**; only report if it still reproduces on 390px.
  - LW9 (stale prose after silent forced-advance), LW10 (pre-jury eviction has no terminal recap — *largest open gap*), LW11 (eviction night pacing), LW12 (premiere welcome/tutorial lingers into HOH) → **carry into J3/J4** audit; do not duplicate.
  - LW13/LW14 verified clear; LW2–LW8 fixed.
- **#436 WCAG/polish cluster** touched `settings.js, style.css, orwellStatusPanel.js, orwellRetrospective.js, login.html`. My J1 captures predate it → reconcile any settings/contrast finding against current source.
- Last integrated main: `ae12c5c` (will re-fetch before remediation + each new journey).

## Journey 1 — remediation applied (gated set #1)

**Applied (status → FIXED, awaiting re-capture):**
| ID | Fix | File(s) |
|---|---|---|
| J1-03 | Skip `(Production cue …)` user turns in history render (live hide already via `sendHiddenCue`) | `chat.js` |
| J1-16 | Auto-title skips cue/control turns → titles from first real player message | `chat_helpers.py` |
| J1-26 | Portrait candidate + library tiles → real `<button>`s (`aria-label`/`aria-pressed`, focus-visible, focus-within reveal of delete) | `orwellHeadshot.js` |
| J1-27 | Singleton SR `role=status aria-live=polite` live region for portrait status | `orwellHeadshot.js` |
| J1-08 | File input → themed `<label>` button + visually-hidden native input (kills "No fil…chosen") | `orwellHeadshot.js` |
| J1-18 | Settings gear `aria-label="Settings"` | `index.html` |
| J1-29 | Loader `role=status aria-label="Loading the house"` (attribute name, **no injected child node**) + `prefers-reduced-motion` guard on the wave | `index.html` |
| J1-21 | Composer placeholder contrast 35%→60% alpha (~4.7:1) | `style.css` |
| J1-28 | `.vis-hint` toggle-desc 30%→62% alpha (~5:1). **Contrast-only** — the `10px`→`--fs-2xs` floor bump reflowed the panel; deferred (sub-floor ships on `main` too). | `style.css` |
| **J1-35** | **NEW** (found during validation): danger-zone "Reset" button nowrap-overflows at 390px (`space-between` flex row, default `flex-shrink:1` squeezed it below its content) → `flex-shrink:0`. Borderline on `main`; any index.html perturbation tipped it. | `index.html` |

**Deferred — needs scoped work (NOT in this set):**
- ✅ **J1-25 / J1-23 / J1-04 / J1-34 — RESOLVED (window-kit modal option, PR #468).** The per-window
  `modal` option this deferral called for shipped on `OrwellWindow` (opt-in `modal:true`: `aria-modal` +
  focus-trap + inert background + a backdrop scrim), WITHOUT forcing it on the floating/lingering windows.
  The cast-photo dialog opts in — so focus no longer escapes into the chat (J1-25), the live narration
  recedes behind a scrim (J1-23/J1-04), and the floating-card overload is contained (J1-34). Scope + plan:
  `docs/audits/2026-06-21-window-system-scope.md`.
- **J1-22** (hide tok/s meta strip in game build), **J1-01/J1-02** (model slug + composer voice),
  **J1-06** (theme scoping), **J1-14** (settings default tab), **J1-05/J1-09/J1-10/J1-12/J1-17/J1-20/
  J1-24/J1-30/J1-31/J1-32/J1-33** → Phase-4 backlog / later gated sets.

**Validation (this set):**
- Local pytest **1663 passed**; the 2 pytest + the browser-smoke failures **reproduce on the pre-change baseline** (stash-compare) — artifacts of the shared dev `frontend/data/` (a casting game in progress + the OpenRouter endpoint) the engine-down/zero-data smoke assumes absent. **Not regressions** (confirmed clean on CI's clean checkout).
- **CI clean checkout caught a real regression**: `responsive_matrix` `phone-390+settings nowrap-overflow: Reset`. Binary-searched it to index.html (pure `main` passes 3/3; my other files innocent — matrix passes with them). Root cause = J1-35 (borderline `flex-shrink` squeeze), not the a11y attrs. **Fixed** with `flex-shrink:0`; matrix now **43 pass · 0 FAIL** locally (2 runs). J1-29 reworked to an attribute-only `aria-label` (no child node) as defense-in-depth.
- Post-merge: visual re-capture of the fixed surfaces is the remaining validation step.

## Journey 2 — capture-phase findings (lead, live-LLM walkthrough)

**Status: CAPTURE DONE → SPECIALIST FAN-OUT TRIAGED. ⚠️ MAJOR CAPTURE-INTEGRITY CORRECTION (see J2-CI below).**

> ### ⚠️ J2-CI — Capture-integrity correction: the "blank transcript / void game" is a HEADLESS RIG ARTIFACT, not a product defect
> **Four of five specialists (interaction IF-01, flows FJ-01, IA IA-01, visual VM-02) independently reported a
> LAUNCH-BLOCKING "blank casting + premiere transcript — the conversation that IS the game renders nothing."
> The content-a11y specialist (CA-06) dissented, calling it "most likely a rig scroll/timing artifact" and asked
> the lead to confirm with a DOM dump. The lead investigated and CA-06 is CORRECT — it is a headless-Chromium
> capture artifact; the chat renders perfectly for real users.**
>
> **Definitive diagnosis (lead, live reproduction on `0583f36`):**
> 1. DOM probe: `#chat-history` holds visible bubbles (`display:flex`, `visibility:visible`, `opacity:1`, non-zero rects), auto-scrolled to bottom — NOT `display:none` (so the `chat.js:2111` L6b suppression hypothesis is **wrong**).
> 2. `elementFromPoint` at the chat-stage center returns a real `msg-ai` bubble (render tree + hit-testing intact).
> 3. Full-page screenshot is blank; **pixel-sample of the chat region = a single uniform color (page bg), 0 light pixels**, while sidebar/header/composer render text normally (300–400 light px). No `backdrop-filter`/`contain`/`content-visibility`/`transform`/overlay on the bubbles (all ruled out by probe).
> 4. **`element.screenshot()` of one bubble = 12,930 light pixels** (renders fully); **full-page screenshot AFTER `scroll_into_view` = 22,072 light pixels** (content paints once the scroll container is forced to composite).
> 5. The rendered bubble shows rich, in-character narration (producer "Isaiah" interviewing), masked **"👁 Big Brother"** sender (not the model slug), collapsed "View thinking process" accordion — the operator-aside `"Let me record this with updateCasting…"` is correctly INSIDE the accordion, NOT the visible reply (scrub works).
>
> **Root cause:** the `#chat-history` scroll container (`overflow:hidden auto`) does not composite into headless full-page screenshots unless freshly scrolled — so the rig's `settle → shot` captured blank. **Real users see the chat fine.**
> **Consequence for the audit:** IF-01/FJ-01/IA-01/VM-02 (and the transcript-region parts of others) are **INVALIDATED as product defects**. ALL J2 transcript-region visual evidence is compromised → **rig fix required** (force scroll/repaint before each shot) + **re-capture** of transcript-dependent items. Non-transcript findings (finalize traces, IA/source a11y, mobile roster, non-scroll contrast/motion) remain valid. Credit: CA-06.

The entries below: J2-01…06 are the lead's direct observations (live-LLM); the consolidated, **re-triaged** specialist
findings (valid vs. artifact-invalidated) follow under "J2 specialist consolidation". Logged as observed.

| ID | Sev | Status | Finding |
|---|---|---|---|
| J2-01 | LAUNCH-BLOCKING (candidate) | VIEWED | **Casting finalize is non-deterministic — the model can deflect an explicit player readiness signal and keep interviewing, so the season fails to start.** Identical cooperative answers + "I'm ready, put me in the house": one run deflected ("you skipped the question again"), state stayed `character-creation` (never started); other runs finalized at turn-4 / persona / ready1. The FE safety-net (`agent_loop.py` `_CASTING_FORCE_LEVEL = len(_CASTING_NUDGES) = 2`) needs ~3 readiness *lull* turns to FORCE `createCharacter`; a single "put me in the house" only NUDGES. |
| J2-02 | HIGH (root-cause of J2-01) | VIEWED | **`createCharacter` is dropped from the tools actually SENT to the model during casting** — present in `relevant_tools` (candidate pool) but absent from `tool_names` in `[agent-debug]`. It IS in `ORWELL_GAME_TOOLS`, passed as `pinned_tools` when `engine_available` (`chat_routes.py:1190`) and unioned into `_relevant_tools` (`agent_loop.py:2560`), yet filtered out of the final schema. So the finalize NUDGES ("call createCharacter NOW") are unactionable; only the deterministic force (model-bypassing) can start the season. |
| ~~J2-02~~ | **INVALIDATED** (log artifact) | RESOLVED | **NOT A BUG — a log-truncation misread.** `agent_loop.py:3032` logs `tool_names={_tool_names_sent[:15]}` (insertion order) and `relevant_tools={sorted(...)[:15]}` (alphabetical). `createCharacter` ("c…") shows in the *sorted* relevant_tools[:15] but sits at **index 23** of the actually-sent game-tool slice — past the `[:15]` cutoff. Verified by importing `FUNCTION_TOOL_SCHEMAS`+`ORWELL_GAME_TOOLS`: `createCharacter` HAS a schema AND is in the sent set. **The model HAS the tool during casting; it just under-calls it.** ⇒ the real J2-01 fix is the FE finalize-fallback threshold (force sooner on an explicit "I'm ready" + engine-`finalizable`), NOT adding a tool. |
| J2-03 | LOW (content) | VIEWED | **Casting front-loads the name ask; a biography-first answer is re-asked every turn.** Producer asks "what do the feeds call you?" right after the photo and re-asks until a literal name is given (a rich "I'm a bartender from Chicago" loops). Model handles it gracefully (escalating mild exasperation — good in-fiction, steelman), but a player answering naturally can loop 1–3 turns before realizing only a *name* advances. |
| J2-04 | LOW (IA/a11y — needs confirm) | OPEN | **Two cast-roster controls with overlapping matchers; the icon-rail mirror `#rail-cast` is present-but-HIDDEN while the sidebar is expanded.** `[id*='cast']` resolves to 2 elements (`#rail-cast` hidden mirror *first* in DOM order + the visible `#sidebar-cast-btn`). Player clicks the visible one fine — but verify the hidden mirror is `aria-hidden`/not tab-focusable, else SR/keyboard users hit a dead control. Confirm in responsive captures. |
| J2-05 | MEDIUM (mobile IA) | VIEWED | **Cast roster unreachable on mobile without first opening the nav drawer.** At the premiere on 390px, `#sidebar-cast-btn` (a `div[role=button]` in the sidebar) is `:hidden` — the mobile sidebar is collapsed by default, so the "who's who" reference is hamburger → drawer → Cast (≥2 taps, off-screen). Reproduced: mobile/normal reached premiere (`house:15`) but the roster step could not run (button not visible). Same pattern as J1-12 (mobile settings/theme behind drawer). Steelman: drawer-nav is standard mobile IA — but the cast reference is *most* needed on mobile precisely while meeting 15 strangers. |
| J2-06 | LOW (a11y, minor) | VIEWED | **Portrait-tile delete `×` tap target 36–38px wide** on the cast-photo studio (height 44 OK; width < the app's own `--tap-min:44px` token). Passes WCAG 2.5.8 AA (24×24) but misses the project target and the AAA 2.5.5 44×44. Seen on android-360 (36), tablet-820 (37), landscape (38). Minor — the `×` only appears once portrait candidates exist (not on the skip path). |

**Verified WORKING (steelman / negative findings — do NOT "fix"):** casting profile recording (`updateCasting`) accrues name/backstory/strategy/motivation/persona correctly; the cast roster opens via `#sidebar-cast-btn` and renders all 15 houseguests (`tiles:87`); the premiere is reliably reached with cooperative answers and the premiere tutorial card (`#orwell-premiere-tutorial`) is present; the #457 hardening middleware (TrustedHost / rate-limit) does not break loopback capture (FE root 200 for `127.0.0.1`+`localhost` Hosts). **Spot-check viewports (android-360 / tablet-820 / landscape-844×390):** the pre-game welcome card and cast-photo studio card show **no H/V overflow** (even on the 390px-tall landscape) and primary buttons are ≥44px — the J1 fixes + responsive kit hold on odd viewports (`runs/j2-spot-*` geometry, 0 page-errors).

**Methodology caveats (rig, not product):** Playwright `networkidle` never settles against the app (persistent polling) → use `domcontentloaded` + explicit settle. The J2 `_settle` waits on `chat-history[aria-busy]` + `chatModule.hasActiveStream` (≤45–75s, reasoning model is slow). Finalize timing varies run-to-run (LLM non-determinism) — J2-01 reproduced across ≥2 of the validation walks.

### Detailed entries — J2

#### J2-01 — Casting finalize non-deterministic; explicit readiness can be deflected · LAUNCH-BLOCKING (candidate) · VIEWED
- **Principle + consequence:** Nielsen *User control & freedom* + Doherty — the single highest-stakes conversion gate (getting INTO the game) can stall *after* the player explicitly asks to start. A player who says "put me in the house" once and is met with another interview question reads it as the game ignoring them; worst case it feels like a soft-lock.
- **Differential diagnosis:** (a) *scenario artifact* — RULED OUT: reproduced with a cooperative player giving a literal name + full answers; (b) *hard soft-lock* — RULED OUT: the season DOES start eventually (the per-user force counter persists across turns; reached premiere at turn-4 / persona / ready1 in other runs); (c) **model under-call + shallow safety-net escalation** — CONFIRMED: model declines to self-call `createCharacter` (see J2-02) and the deterministic force needs `_clv ≥ 2` (i.e. ~3 readiness lulls).
- **Evidence:** validation runs v2 (deflected, `started:False`), v3 (finalized turn-4), v4/desktop-normal (finalized at `persona`). `frontend/src/agent_loop.py:3705-3758` (fallback), `:1488-1496` (nudge rungs / force level), `:1528-1541` (`_player_turn_is_lull`).
- **Confidence:** HIGH it occurs; MEDIUM on frequency (LLM variance). **Severity pending** the specialist read + whether a single readiness push *should* force (product call).

#### J2-02 — `createCharacter` absent from the sent tool schema during casting · HIGH (root-cause) · VIEWED
- **Principle + consequence:** structural — the narration model is told (by prompt + nudges) to "call createCharacter NOW" but the function is **not in its tool list**, so compliance is impossible; the game can only start via the model-bypassing deterministic force. Brittle, and it defeats the documented "always able to call createCharacter" pinning.
- **Evidence:** `[agent-debug]` lines — `relevant_tools=[…,'createCharacter',…]` but `tool_names=[…15 tools, NO createCharacter/updateCasting…]`. Pin path: `tool_schemas.py:1740 ORWELL_GAME_TOOLS` (contains it) → `chat_routes.py:1190 pinned_tools=(… if engine_available)` → `agent_loop.py:2560 _relevant_tools.update(pinned_tools)`. The drop is downstream of the union (final schema build: `disabled_tools` filter / schema lookup / cap — TBD).
- **Next:** code-trace the final schema array construction to find where the pinned game tools are filtered. (Remediation-phase.)

#### J2-03 — Casting front-loads the name ask; biography-first answers loop · LOW (content) · VIEWED
- **Principle + consequence:** *Match between system and the real world* / input affordance — "what do the feeds call you?" invites a persona answer, but only a literal **name** advances; a natural answer loops 1–3 turns. The model's graceful, in-character re-asking (mild exasperation) is a **steelman positive** (texture, not a break), so this is expectation-setting, not a defect.
- **Evidence:** producer replies across v1 ("That's a lot of biography and not one syllable of a name"), repeated re-asks until a name lands.

#### J2-04 — Duplicate cast-roster control; hidden icon-rail mirror · LOW (IA/a11y) · OPEN (needs confirm)
- **Principle + consequence:** consistency + WCAG 4.1.2 — a present-but-hidden duplicate control (`#rail-cast`, `data-rail-source="sidebar-cast-btn"`) sits *first* in DOM order while the visible `#sidebar-cast-btn` is the real target. Sighted pointer users are unaffected; the risk is a hidden-but-focusable dead control for keyboard/SR users.
- **Evidence:** rig click on `[id*='cast']` resolved to 2 elements, picked the hidden `#rail-cast` (Playwright "element is not visible"). `orwellCast.js:23 BTN_ID="sidebar-cast-btn"` (display toggled by live-poll); `sidebar-layout.js` icon-rail.
- **Verify:** check `tabindex`/`aria-hidden` on `#rail-cast` while the sidebar is expanded (desktop) in the matrix captures.

#### J2-05 — Cast roster buried behind the mobile drawer at the premiere · MEDIUM (mobile IA) · VIEWED
- **Principle + consequence:** *Recognition over recall* / accessibility of key info — the cast "who's who" is the player's memory aid for 15 brand-new houseguests, and on mobile it's hidden behind hamburger → drawer (≥2 taps, off-screen) exactly when it's most needed (premiere introductions). On desktop the visible `#sidebar-cast-btn` is one click; mobile loses that.
- **Evidence:** `j2-mobile-normal` reached `premiere`/`house:15` but `#sidebar-cast-btn:visible` timed out (button `:hidden` in the collapsed mobile sidebar); element is `div[role=button][tabindex=0] id="sidebar-cast-btn" data-a11y-enhanced="1"`. Desktop/normal opened it fine (`tiles:87`).
- **Relationship:** instance of the J1-12 "mobile key surfaces behind drawer" pattern → consider a premiere-week persistent cast affordance on mobile (Phase-4 backlog candidate).
- **Confidence:** HIGH (reproduced desktop-vs-mobile).

## J2 specialist consolidation (5 read-only specialists, de-duped + re-triaged against J2-CI)

Five specialists analyzed the 4-combo matrix + FE source. Their findings are triaged below into **VALID**
(survive the J2-CI capture-artifact correction) and **INVALIDATED** (rested on the blank-transcript artifact).
Lead findings J2-01…06 above stand. Specialist IDs: FJ (flows), IA (ia), IF (interaction), VM (visual), CA (content/a11y).

### VALID — confirmed product findings (de-duped)

| ID | Sev | Finding (heuristic → consequence) | Evidence |
|---|---|---|---|
| **J2-07** | HIGH | **Production cues render as the player's own "You" messages on the LIVE path.** `#chat-history` holds `msg-user` bubbles `"(Production cue — begin the casting interview now…)"` and `"(Production cue — the cast photo step is done…)"` — visible (`display:flex`). J1-03 fixed *history re-render*; the LIVE send path still leaks them. Vault/immersion break (match-to-real-world): the player sees stage-directions as their own dialogue. | lead DOM probe (`#chat-history` children); cf. J1-03/J1-16 |
| **J2-08 (=CA-01)** | HIGH | **Raw model id `deepseek-v4-pro` is the chat TITLE through all of casting** (header renders outside the scroll container). `sessions.js` materialize auto-names `${modelBase} ${time}` with **no game-build guard** (the sidebar list IS guarded). Immersion/Vault corollary; 100% of players, until narration renames the chat. Same class as J1-01. | shots header (`02/03/04/08/20`); `sessions.js:1833-1834` vs guarded `:352` |
| **J2-09 (=IA-03/J2-04)** | MED | **Up to four "Cast" surfaces, inconsistent labels** — sidebar "Cast" (`div[role=button]`), right-rail "The House" list, **two** registry rows both titled "The Cast" (`orwellGadgetRail.js:44,47`), + hidden `#rail-cast`; roster reports **87 tiles for 16** houseguests. Findability/Tesler — no single home for "who's who". | `trace.json cast_roster.tiles:87`, `premiere_dom.castBtn`; `orwellGadgetRail.js` |
| **J2-10 (=VM-01)** | HIGH | **Premiere is a single-frame hard-cut pop-in** — the whole apparatus (House panel, 16-roster, presence, tutorial) materializes in one 250ms tick, **normal AND reduce** (nothing to strip; never authored). Peak-end/game-feel: the season's biggest beat lands with zero weight. Same class as J1-20. | frames f320→f321 (normal), f300→f302 (reduce); no premiere keyframe in source |
| **J2-11 (=VM-03)** | MED | **Onboarding holding/empty-state copy near-invisible** — "Tip: Just talk…" **1.52:1**, "The house is waiting." **2.23:1** (WCAG 1.4.3 FAIL). The line teaching the whole interaction model is unreadable. (Ironically its low contrast helped *sell* the blank-stage illusion in J2-CI.) | frame f30; sampled ratios; bdf_after.png confirms the card renders |
| **J2-12 (=CA-03)** | MED | **Premiere tutorial silent to screen readers** — injected `role="note"`, no `aria-live`, no focus move (WCAG 4.1.3). The journey's key expectation-setter is never announced. | `orwellPremiereTutorial.js:97-112` |
| **J2-13 (=IA-05)** | MED | **Premiere tutorial orients on RHYTHM not ACTION** — names the loop ("Meet the house → HOH → …") but gives no affordance to *do* the first move (meet someone / wander). Gulf-of-execution. | `orwellPremiereTutorial.js:103-109`; shot 23 |
| **J2-14 (=IF-03/J1-22)** | MED | **`tok/s` meta strip shows in-game** ("36.39 tok/s · … 12%", dim) — OOC developer telemetry under in-character narration; low contrast. Confirmed rendered. | element screenshot `/tmp/elem_bubble.png` (bubble footer) |
| **J2-15 (=VM-04)** | MED | **16 identical silhouette avatars at premiere** — "meet 15 distinct people" pays off as interchangeable placeholders. Steelman: zero-data, portraits (0051) backfill post-premiere; severity drops if fast. | shot 27 zoom; reduce f576 |
| **J2-16 (=VM-05)** | LOW-MED | **Red/coral focus border (`--accent #e06c75`) on benign onboarding windows** (cast-photo) reads as a warning/error; red = eviction elsewhere → cross-signal. | shots 03/04; `orwellWindow.js:85,94` |
| **J2-17 (=VM contrast)** | MED | **"Make AI studio portraits" CTA ~3.29:1** (WCAG 1.4.3 FAIL for normal text). | shot 04 (sampled) |
| **J2-18 (=IA-07)** | LOW | **Mobile control-room FAB overlaps the premiere tutorial card** content. Responsive overlap (ruling #16). | mobile shots 22/26 |
| **J2-19 (=CA-04)** | LOW | **Sidebar cast control is a `div[role=button]` with only text-derived name** ("Cast"), terser than its rail twin's `aria-label="Cast — the houseguests"` (4.1.2 parity). | `trace.json castBtn`; `orwellCast.js:57-66` |
| **J2-20 (=CA-05)** | LOW | **Premiere-tutorial dismiss fade not reduced-motion-guarded** (`transition: opacity .2s`, no `@media reduce`), inconsistent with `orwellCast.js` which guards. | `orwellPremiereTutorial.js:76` |
| **J2-01 refine (FJ-02/IF-07)** | — | Finalize quantified: **5 turns (3 runs) vs 4 (desktop-reduce)** — non-deterministic; irreversible season start fires with **no confirmation/undo**. Corroborates J2-01. | `state_after_*` across 4 traces |
| **J2-04 refine (IA-02)** | — | **a11y-phantom RULED OUT**: `#rail-cast` is `display:none`-gated when the sidebar is expanded (removed from tab/AX tree, trace `vis:false`). J2-04 residual = label/duplication only (→ J2-09). | `sidebar-layout.js:58`; trace |
| **J2-05 corrob (IA-04/FJ-06/IF-06)** | — | Mobile premiere: BOTH cast controls `vis:false`; no on-screen "Cast" label while the tutorial says "meet the cast"; entire house readout behind drawer + generic 📋 FAB. | mobile `trace.json premiere_dom`; `orwellStatusPanel.js:12` |

### INVALIDATED by J2-CI (rested on the headless blank-transcript artifact — NOT product defects)
- **IF-01** (empty transcript + "no progress feedback") — INVALID re "blank"; a `Processing request ▃▄▅` spinner + `tok/s` DO render. *Residual valid:* real LLM latency (name ~30s; meet-house **48.8–62.8s**) — but feedback exists; re-capture to judge its sufficiency.
- **FJ-01 / IA-01 / VM-02** (invisible casting+premiere transcript / "void game") — INVALID (artifact).
- **FJ-03** (dead "Meet the producers" handoff / no producer greeting) — INVALID: the producer opener renders (element screenshot shows producer "Isaiah" narration).
- **FJ-04** (30–64s "blank-spinner" turns) — latency real, "blank" INVALID (spinner present).
- **CA-06** — correctly flagged the artifact; resolved as J2-CI.

### NEEDS RE-CAPTURE (after rig fix — force chat scroll/repaint before each shot)
Transcript-dependent items to (re)assess on true captures: narration quality/voice & any in-bubble OOC leak; the operator-aside scrub (looked OK in the one element-shot); pre-token wait feedback sufficiency (IF-01/IF-04 residual); whether premiere "meet-the-house" intros narrate well; J2-07 cue-leak across more turns; CA-02 composer model-picker (verify NON-admin build hides it — likely admin-rig).

**Rig-fix outcome (J2-CI follow-up):** A full-page headless screenshot composites the `#chat-history` scroll
container only when it actually *scrolls* (overflow) — `scroll_into_view_if_needed()` no-ops when content fits, so
short casting turns still capture blank. **Reliable method adopted: an ELEMENT screenshot of `#chat-history`** (saved
to `runs/<tag>/.../transcript/*.chat.png`), which always renders (proven: 12,930 light px). Banked in `rig.py` for
J3/J4. **Transcript evidence already sufficient** to assess J2: the element-screenshot shows rich in-character
narration (producer "Isaiah"), masked "👁 Big Brother" sender, and the operator-aside correctly inside the collapsed
"thinking" accordion (scrub OK); DOM probes confirmed J2-07 (cue-as-You-message). No further full re-capture needed for J2.

## Journey 2 — remediation applied (gated set #2)

Scope authorized by the owner ("include the finalize fix in this set"). Six confirmed-clean fixes:

| ID | Fix | File |
|---|---|---|
| **J2-01** | Casting finalize: an EXPLICIT readiness signal ("I'm ready / put me in the house") + engine-`finalizable` now force-finalizes that turn instead of needing ~3 lulls (a mere short/disengaged lull keeps the gentle ramp; still gated on `finalizable`, never mints a floater). | `src/agent_loop.py` |
| **J2-08** | Game build no longer shows the raw model slug as the chat title — `materializePendingSession` names the session "Casting interview" under `data-game-build` (mirrors the sidebar-list guard) instead of `${modelBase} ${time}`. | `static/js/sessions.js` |
| **J2-11** | Onboarding holding-card tagline/tip raised from ~1.5:1 to ≥4.5:1 — explicit `color-mix(--fg 82–88%)` instead of `opacity:.7` over an inherited dim color (WCAG 1.4.3). | `static/js/orwellOnboarding.js` |
| **J2-12** | Premiere tutorial card gets `aria-live="polite"` so screen-reader users are told the journey's key expectation-setter appeared (no focus theft; stays a `role=note`). | `static/js/orwellPremiereTutorial.js` |
| **J2-19** | Sidebar cast control gets `aria-label="Cast — the houseguests"` (parity with the rail twin; 4.1.2). | `static/js/orwellCast.js` |
| **J2-20** | Premiere tutorial dismiss fade guarded by `@media (prefers-reduced-motion: reduce)` (2.3.3). | `static/js/orwellPremiereTutorial.js` |

**Validation:** JS `node --check` + `py_compile` clean; FE pytest **1765 passed / 2 failed** — the 2 (`test_h2b_all_model_pools`, `test_h2h3_settings`) are the SAME environmental failures as the J1 baseline (model-pool/image-subset assertions against the dev OpenRouter endpoint), NOT regressions; CI's clean checkout passes them. Casting/finalize/onboarding/premiere suites (87 tests) all green.

**Deferred from this set (need more work — NOT shipped):**
- **J2-02** — INVALIDATED (log-truncation artifact; createCharacter IS sent). No fix needed.
- **J2-07** — production-cue-as-"You"-bubble: both known render paths (live `_hideUserBubble`, `softReloadHistory` skip) ARE guarded; my probe likely hit a pre-existing-session state. Needs clean-session reproduction to find the leaking path before fixing.
- **J2-14** (tok/s in-game), **J2-16** (red focus border on benign cards) — judgment calls (is the telemetry/red intended?) — owner ruling needed.
- **J2-17** (themed-accent CTA contrast 3.29:1), **J2-18** (mobile FAB overlaps tutorial) — per-theme / responsive-fiddly; need a token-level on-color solution + responsive testing.
- **Design-level:** J2-05/09 cast IA, J2-10 premiere staging, J2-13 tutorial affordance, J2-15 avatar identity → Phase-4 backlog.

## Phase-4 — premiere motion / visual / staging cluster (gated set, issue #606)

The premiere/tutorial polish cluster (J2-10, J1-20, J2-13, J2-15, J2-18, J3-15). All fixes are FE
presentation only, theme-token-driven, and reduced-motion guarded.

| ID | Disposition | Fix | File |
|---|---|---|---|
| **J2-13** | FIXED | The premiere tutorial named the weekly rhythm but offered no way to ACT (gulf-of-execution). Added a "Meet the house →" CTA that seeds the composer (`#message`) with an opener and focuses it — it never sends, so the player stays the author (ADR 0003); never clobbers an in-progress draft. | `static/js/orwellPremiereTutorial.js` |
| **J2-10 / J1-20** | FIXED (FE half) | The premiere card hard-cut in. Added a gentle rise+fade entrance (`orwellPremiereIn`), self-removing after one play; stripped under `prefers-reduced-motion` alongside the existing dismiss-fade guard. Purely presentational — byte-identical once settled. (The fuller engine-staged premiere apparatus remains backlog; this addresses the FE tutorial-card pop-in.) | `static/js/orwellPremiereTutorial.js` |
| **J2-15** | FIXED (FE presentation) | 16 identical 👤 silhouettes at premiere → a per-houseguest monogram (name initial over a name-derived, Vault-free hue, stable across polls) so a portrait-less roster reads as distinct people from frame one. Portraits (0051) still backfill on top. | `static/js/orwellCast.js` |
| **J3-15** | FIXED | Casting cast-photo thumbnails showed broken/placeholder states with no loading affordance. Added a token-driven (`--panel`/`--border`) skeleton shimmer driven off each `<img>`'s real load result (`hs-loading` until load, `hs-broken` on error) for both the candidate grid and the saved-headshots strip; reduced-motion freezes the sweep. | `static/js/orwellHeadshot.js` |
| **J2-18** | FIXED / already-mitigated | The "mobile FAB overlaps the tutorial card" evidence predated #551, which moved the gadget opener to a small icon-only top-right control (the tutorial card sits at the bottom above the composer — no overlap). Also bumped the tutorial's `Close guide` (and the new CTA) from 36px to the 44px tap floor (WCAG 2.5.5). | `static/js/orwellPremiereTutorial.js` |

**Validation:** `node --check` clean; the full FE pytest suite green (2 environmental model-pool skips,
unchanged from baseline); `responsive_matrix.py` green; source-pin tests added/extended
(`test_l31_premiere_tutorial.py`, `test_g22_cast_progressive_render.py`, `test_g26_headshot_fe.py`).

## Journey 3 — capture-phase findings + specialist consolidation (DONE)

**Status: COMPLETE.** Capture `b7tiic1vg` / desktop/normal / deepseek-v4-pro. 16 shots, 97 mutation events.
Specialist fan-out (5 read-only): flows/journeys · IA/wayfinding · interaction/feedback · visual/motion · content/a11y — all complete. Gated remediation set #3 pending (below).

### J3 capture — what actually happened

The game started fresh at premiere. The scenario walked through: casting → game-start → 2 HG-meeting turns → "I'm ready for HOH" (hoh-leadup) → 4 HOH-nudge turns → post-comp-narration → veto-leadup → veto-ceremony → eviction-night → post-eviction. Key outcomes:
- `decision_card_comp_intent: null` — the HOH competition decision card **never appeared**
- `hud_final.barFill: "0%"` — bar stayed at 0% even after "eviction night" scenario steps
- Mutation log: only `turn-settled` events after `tool:createCharacter` — no `tool:advanceGame`, `tool:runCompetition`, `tool:markHouseguestMet`
- The engine stayed frozen in premiere; the HOH/veto/eviction steps were narration-only, with no engine backing

### J3 findings index

| ID | Sev | Status | Finding |
|---|---|---|---|
| J3-01 | MED (corroboration) | VIEWED | **`tok/s` telemetry strip visible in every AI bubble in-game.** `26.9 tok/s \| icons \| 17%` confirmed in shot `17-06-meet-hg1.chat.png`. Corroborates J2-14. |
| J3-02 | — (negative) | VERIFIED CLEAR | **J2-07 production cue as "You" bubble does NOT reproduce on clean session.** Both guarded paths working. Requires pre-existing session with cue in history to reproduce; clean path clear. |
| J3-03 | — (positive) | VERIFIED | **Narration quality excellent; rich, immersive, no leaks.** Distinct HG personalities, room geography, no model slug, no OOC leaks. J2-08 fix confirmed (title "Casting interview"). |
| J3-04 | — (positive) | VERIFIED | **Premiere tutorial card present and correct.** Rhythm guide + "Got it" dismiss, per J2-12 fix. |
| **J3-05** | **LAUNCH-BLOCKING** | OPEN | **Model narrated a fictional HOH winner and continued through veto/eviction without engine backing.** After 4 HOH nudges blocked by the premiere gate, the model responded to "who won HOH?" with a named fictional result (`post-comp-narration` shot). The engine never called `runCompetition` or `advanceGame` — mutation log confirms only `turn-settled` events, bar stayed at 0% through "eviction night." Anti-sycophancy mandate violated at the narration layer: the model fabricated a closed-set outcome the engine never computed. A player who trusted the narration would believe the game advanced and be confused when the bar reads 0% and HOH/noms/veto/eviction produce no state change. Reference: CLAUDE.md "anti-sycophancy" mandate + the pre-emission outcome guard in `frontend/routes/chat_helpers.py`. |
| **J3-06** | **HIGH** | OPEN | **`markHouseguestMet` never dispatched — premiere progress bar stays at 0% and player has no feedback on HG-meeting progress.** Mutation log shows zero `tool:markHouseguestMet` events across 22+ `turn-settled` events. The premiere auto-belt (`_auto_mark_premiere_intros` in `agent_loop.py:~1878`) should fire when `_moment == "premiere"` and the model narrates HG names, but no `gamechanged` event with reason `tool:markHouseguestMet` appears. Either the belt is not firing or its backend tool call does not dispatch a `gamechanged` event (so the JS mutation log never sees it). The bar fills on evictions (not HG meetings) — so 0% is technically correct for premiere — but the HOH gate requires all-15-met, and there is zero FE signal that the belt is making progress. Confidence: H that the mutation log is missing evidence; M on root cause (backend-silent vs. not-firing). |
| **J3-07** | HIGH | OPEN | **No persistent game phase indicator in UI.** "Week 1 / Premiere" appears in small secondary sidebar text but there is no phase label + current objective displayed in the main chrome. All game-state orientation comes from in-chat narration. At frames 44 and 47 (veto/eviction asks), the model's OOC aside `((We're still on Premiere Night…))` was the ONLY signal correcting the player's drifted mental model. |
| **J3-08** | HIGH | OPEN | **No visible premiere progress counter ("X of 15 met").** The premiere unlock condition (all 15 houseguests must be met) has no persistent tracker in any UI surface. The only count appears mid-narration ("Eleven faces met — just five left"). After 4 HOH pushes the player has no independent confirmation of why the game isn't advancing. Sidebar cast roster shows names but no met/unmet state. |
| **J3-09** | MED | OPEN | **Tutorial copy omits the meet-all-15 unlock condition.** "Take your time meeting the cast" names the activity but not the gate (all 15 required) or the exit condition. "Take your time" actively implies no urgency. A player who dismisses with "Got it" holds no model of why HOH is gated. Source: `orwellPremiereTutorial.js:107-115`. WCAG 3.3.2 (instructions don't describe required completion condition). |
| **J3-10** | MED | OPEN | **"Got it" dismisses tutorial with no recovery path; no forward-navigation affordance.** Dismiss writes a localStorage key (persists across sessions). The guide never reappears. No re-open affordance, no suggested next action when dismissed. A player who dismisses before reading has no recovery. Source: `orwellPremiereTutorial.js:27-33, 110`. |
| **J3-11** | MED | OPEN | **Tutorial banner persists through all game phases with no graduation cue.** Present in every game-phase frame through "eviction night" scenario steps. Static "Welcome to the house — premiere week" copy is stale once the player has progressed; no dismiss control visible; narrow zone competes with the progress bar slot. Source: `orwellPremiereTutorial.js`; visible in shots 14–53. |
| **J3-12** | MED | OPEN | **HOH decision card never appeared; no pending-state affordance when expected.** `comp_intent_skip: "card absent after nudges"`. When the card is expected but absent (pre-gate-clear), there is no "decision pending" placeholder or status message. The 15s `rearmFromStatus` polling loop (`orwellDecision.js`) only arms when the engine returns a `pending` object — until then, the card zone is silent. |
| **J3-13** | MED | OPEN | **Premiere redirect responses inconsistently include the remaining-HG count.** The best redirect pattern ("Eleven met, five left: Avery, Amelia, Elliot, Darren, Grant") appeared at frame 41. But frames 44/47 (veto/eviction redirect) described a nearby scene without naming the gap. Without the count, the player cannot form an action plan. Should be a consistent requirement in the stall-nudge / premiere redirect framing (`routes/chat_helpers.py` `apply_game_framing`). |
| **J3-14** | MED | OPEN | **Progress bar perceptually absent at 4px height with no label or entrance animation.** Bottom of viewport, 0% fill, no label, no motion on first fill. Below Weber's Law threshold of casual visual attention. Even when it fills in later weeks, the 4px flat change will not register as a milestone without a micro-animation or label. Source: `orwellSeasonProgress.js:87-101`. |
| **J3-15** | MED | OPEN | **Broken portrait thumbnails in cast-photo modal at casting.** Screenshot `03-02-casting-start.png`: 4 of 6 thumbnail slots show broken/placeholder states with no shimmer or loading indicator. High-investment onboarding moment undermined. No loading state defined — a shimmer using `--panel`+`--border` tokens would fix. |
| **J3-16** | MED | OPEN | **Decision card chips and confirm button below project target-size floor on desktop.** Chips (`odec-opt`): `padding: .3rem .8rem`, no `min-height` → ~24px tall. Confirm: `padding: .42rem .95rem` → ~26-27px on desktop. Project floor is 44×36px (coarse-pointer). Mobile stacks full-width — adequate. Source: `orwellDecision.js:63-66, 75-78`. Consequential action (nomination, eviction vote) on an undersized target. |
| **J3-17** | MED | OPEN | **Decision card dismiss "×" and note text low-contrast.** Dismiss `×` at `opacity: .55`; note text (`odec-note`) at `opacity: .65; font-size: .78em`. Both sit on `--panel` dark background — stacked opacity on a dim base likely sub-4.5:1 for the small note text. Source: `orwellDecision.js:56, 80`. WCAG 1.4.3. |
| **J3-18** | MED | ✅ FIXED (`e461139`) | **Decision card has no focus management on render.** RESOLVED: `render()` sets `tabindex=-1` + `card.focus()` on mount (`orwellDecision.js:508-509`) and the post-stream override now re-focuses the present card instead of the composer (`chat.js:3402-3406`, J4-01). Pinned by `test_j5_20_21_decision_polish.py::test_j5_21_focus_on_mount_unaffected`. |
| **J3-19** | MED | OPEN | **Right-panel cast roster visual weight competes with primary chat column.** Similar text density and color weight to narration bubbles; no opacity subordination or reduced type step. Eye is split between reading narration and processing roster. Visual hierarchy gap — not a contrast failure. |
| **J3-20** | LOW | OPEN | **Sidebar cast roster shows no met/unmet distinction.** All 15 HG names visible but no state — met (spoke to) vs. unmet (stranger). The one reference a player might consult during premiere gives no premiere-progress signal. |
| **J3-21** | LOW | ✅ FIXED (L36) | **OOC double-paren asides appear inside narration bubbles with no visual demarcation.** RESOLVED: `((…))` / `ooc:` asides get `msg-ooc` (player) / `msg-ooc-producer` (model) classes in the game build (`chatRenderer.js:2186-2192`) with tinted bg + dashed border + a "production" badge (`style.css:2284-2328`). Pinned by `test_l36_ooc_aside.py`. |
| **J3-22** | LOW | OPEN | **"Confirm — this is binding" on decision card lacks first-timer context.** No explanation of what "binding" means in BB game terms (cannot change after submit, permanent in-game consequence). Dismiss title attribute has the fuller hint but `title` is unreliable. Source: `orwellDecision.js`. Low severity — the label + note are already better than most. |
| **J3-23** | LOW | OPEN | **"View thinking process" accordion rendered inside the AI narration bubble.** Frames 38-13, 44-18 show it inside the Big Brother bubble border. A first-timer may misread it as in-fiction content. Consider moving the accordion slot to below the bubble, outside the bubble border. |
| **J3-24** | LOW | ✅ FIXED (`fef04af`) | **Tutorial rhythm-line emoji are informational with no text alternative.** RESOLVED: each rhythm-line emoji is wrapped in `<span aria-hidden="true">` (`orwellPremiereTutorial.js:115-118`), so SRs skip the Unicode names. WCAG 1.1.1. |
| **J3-25** | LOW | OPEN | **Season progress bar lacks supplementary description.** `aria-label="Season progress"` only; no hint that 0% during premiere is expected and correct. SR users hear "Season progress, 0 percent" with no framing. One-liner: `aria-description="Advances as houseguests are evicted"`. Source: `orwellSeasonProgress.js:94-101`. |
| **J3-26** | — (positive) | VERIFIED | **Model correctly holds premiere gate against 4 explicit HOH pushes.** Engine never called `advanceGame` prematurely; premiere constraint held deterministically. Anti-sycophancy working at the engine level. |
| **J3-27** | — (positive) | VERIFIED | **In-chat narration delivers explicit progress counts when redirecting.** Best redirect (frame 41): "Eleven faces met — just five left: Avery, Amelia, Elliot, Darren, and Grant" with room context. The chat-is-the-game model is doing genuine wayfinding work when the redirect fires correctly. |
| **J3-28** | — (positive) | VERIFIED | **In-narrative gate explanations are consistent and diegetic.** OOC `((…))` aside pattern used consistently for meta-game info; the model never broke character gratuitously. Deliberate OOC is distinguishable from narration by the double-paren convention (though visual demarcation is missing — J3-21). |
| **J3-29** | — (positive) | VERIFIED | **Welcome card + AI sender label consistent and strong.** Clean first-paint hierarchy; "Big Brother" sender label unambiguously identifies every AI bubble throughout the journey. |

### J3 de-dup / cluster map

- **The premiere-gate cluster** (J3-05…J3-13): all five lenses converge on the same failure surface — the HOH gate is engine-enforced but the player-facing signal layer is almost entirely absent. Fix together: anti-sycophancy guardrail extension (J3-05) + `markHouseguestMet` belt investigation (J3-06) + tutorial gate-copy (J3-09) + phase label (J3-07) + progress counter (J3-08) + redirect consistency (J3-13) + "Got it" forward-nav (J3-10) + tutorial graduation (J3-11).
- **Decision card a11y cluster** (J3-16/17/18/22): touch targets + contrast + focus management. Fix together in `orwellDecision.js`.
- **Progress bar signal cluster** (J3-14/J3-25): visual salience + aria-description. Fix together in `orwellSeasonProgress.js`.
- **Emoji a11y** (J3-24): isolated one-liner in `orwellPremiereTutorial.js`.
- **J3-19/20/21/23**: low-severity design polish → Phase-4 backlog.

### Positives to keep as patterns

Welcome card first-paint (clean hierarchy), "Big Brother" sender label (consistent channel ID), `role=note aria-live="polite"` tutorial card pattern (J2-12), premiere gate determinism (anti-sycophancy working at engine), in-chat count redirect when fired correctly.

---

## Journey 3 — remediation (gated set #3)

**Scope: J3 findable FE fixes — decision card a11y, progress bar signal, tutorial gate-copy, progress counter, emoji a11y. Engine-adjacent issues (J3-05 anti-sycophancy, J3-06 belt investigation) are flagged HIGH for the owner but require engine investigation, not quick FE fixes.**

> ⚠️ J3-05 and J3-06 are NOT in this set — they need investigation first:
> - J3-05: the pre-emission outcome guard (`chat_helpers.py`) already catches phantom closed-set claims but may not cover the premiere-stall hallucination path. Needs inspection before patching.
> - J3-06: `_auto_mark_premiere_intros` existence confirmed in CLAUDE.md but whether it fires and dispatches `gamechanged` needs tracing before any fix.
> Owner should investigate J3-05/06 as part of the next engine/agent-loop work session.

**Applied:**

| ID | Fix | File |
|---|---|---|
| **J3-09** | Tutorial body: add "You'll need to cross paths with all fifteen houseguests before Production calls the first HOH competition." Replace "Meet the house" in rhythm line with "HOH" (it's a prerequisite, not a phase). | `static/js/orwellPremiereTutorial.js` |
| **J3-10** | Dismiss label: "Got it" → "Close guide" (action label, not affirmation). Add `title="Won't show again"` on the button. | `static/js/orwellPremiereTutorial.js` |
| **J3-14** | Progress bar: add `aria-label="Season progress — 0 of 15 evictions"` dynamically; add `transition-duration: 400ms` ease-out for first-fill animation (guarded by reduced-motion). | `static/js/orwellSeasonProgress.js` |
| **J3-16** | Decision card chips: `min-height: 36px`. Confirm button: `min-height: 44px`. | `static/js/orwellDecision.js` |
| **J3-17** | Dismiss "×": `opacity: .55` → `.75`. Note text: `opacity: .65` → `.80`; remove `font-size: .78em` (use `.85rem` base). | `static/js/orwellDecision.js` |
| **J3-18** | After `chatBox.appendChild(card)` + `scrollIntoView`: add `card.setAttribute("tabindex", "-1"); card.focus()`. | `static/js/orwellDecision.js` |
| **J3-24** | Rhythm emoji: wrap each in `<span aria-hidden="true">`. | `static/js/orwellPremiereTutorial.js` |
| **J3-25** | Progress bar: add `aria-description="Advances as houseguests are evicted"`. | `static/js/orwellSeasonProgress.js` |

**Deferred from this set:**
- J3-05 (anti-sycophancy / fictional HOH narration) — engine investigation required
- J3-06 (`markHouseguestMet` belt) — agent_loop investigation required
- J3-07/J3-08 (phase label / progress counter) — needs design decision on what persistent indicator to add and where
- J3-11 (tutorial graduation) — depends on J3-06 resolution (when does the belt fire → when to dismiss)
- J3-12 (card pending state) — engine `pending` object availability
- J3-13 (redirect consistency) — prompt/framing in `apply_game_framing`
- J3-15 (portrait skeleton loading) — portrait feature scope
- J3-19/20/21/23 — Phase-4 design backlog

## Journey progress

- [x] **J1 — First launch → main menu / settings / zero-data** — DONE: 34 findings; gated remediation set #1 (9 fixes: launch-blockers J1-03/J1-16 + cast-photo a11y + contrast + J1-35 390px hardening) **merged PR #449** (CI green).
- [x] **J2 — Onboarding → first understanding (casting interview, premiere, meeting houseguests)** — DONE: 20 findings (J2-01…J2-20). ⚠️ J2-CI: blank-transcript was headless artifact, not product defect. Gated remediation set #2 (6 fixes: J2-01/08/11/12/19/20) **merged PR #465** (CI green). **J2-07 since FIXED** (production-cue-as-"You" filtered by one shared `isSkippableUserPrompt` seam on both the live + history-render paths; `test_issue2_production_cues_filtered_by_one_shared_seam`). Deferred: J2-14/16/17/18 + design-level J2-05/09/10/13/15 → Phase-4 backlog.
- [x] **J3 — Core loop → playing a round (lingering, talking, live narration, reveals)** — DONE: 25 findings (J3-01…J3-25). Gated remediation set #3 (8 fixes: J3-09/10/16/17/18/24/25 + progress bar aria-description). Deferred: J3-05/06 (engine investigation) + J3-07/08/11/12/13/14/15/19/20/21/23 → Phase-4 backlog / engine work queue.
- [x] **J4 — Weekly loop decision-card deep-dive (HOH comp-intent, nominations, veto, eviction-vote)** — DONE: 28 findings (J4-01…J4-28). Gated remediation set #4 (3 fixes: J4-01 focus / J4-02 role / J4-03 dismiss label) **merged PR #470** (CI green). Gated remediation set #5 (7 fixes: J4-08 confirm label / J4-09 alert region / J4-10 contrast / J4-11 tap target / J4-12 describedby / J4-13 copy / J4-14 aria-describedby) **merged PR #473** (CI green). J4-22/25 closed (dup). Deferred: J4-04/05/06/07/15…21/23/24/26/27/28 → Phase-4 backlog / engine work queue.

> **⚠️ Parallel-auditor numbering collision at "J5".** Two independent audit tracks both reached J5: the **Control Room** track (kit windows / gadget-rail, in progress on main) and the **Endgame** track (this session, gated set #6, merged via PR #475). Both are kept below; finding IDs are scoped *within* each track (a "J5-01" exists in both — read it with its track). A future journey should pick the next free number (J6).

- [~] **J5 (Control Room track) — The Control Room (the kit windows + gadget-rail "control room" surfaces — finale, cast, retrospective, status, presence)** — IN PROGRESS. Captured headless against the real FE (kit windows mounted + rail revealed/collapsed). **J5-01** (HIGH-PRIORITY POLISH — FIXED): the control-room chrome controls render BELOW the 44px coarse-pointer tap-target floor — rail header buttons 30×32, kit-window dock/min/close 24×32, collapsed-strip icons 38×38 (all properly labelled). Same class as J4-11/J2-06/J4-15. Fix: a touch-only `@media (hover:none) and (pointer:coarse)` floor (44px) — desktop stays compact. Verified headless (44×44 on touch, ~30×32 fine-pointer). Note: the responsive-matrix touch check doesn't reach these (rail drawer closed + kit windows unmounted during its run). *Also recorded this session: A1/#468 closed J1-25/23/04/34 (the cast-photo modal cluster); #472 fixed the ⇄ side-swap (stranded-hamburger overlap).*
- [x] **J5 (Endgame track) — The ENDGAME (eviction → jury → Final 2 → finale → retrospective/unsealing)** — DONE: 24 findings (J5-01…J5-24) across 5 specialists. Real season fast-forwarded to completion (week 13, player evicted-to-jury). Gated remediation set #6 (17 fixes: 2 launch-blocking textarea-card a11y items + figure/ground + chip contrast + motion + 2 real bugs + retrospective hierarchy/headings/contrast/tap + finale a11y + tutorial graduation) **merged PR #475** (CI green). Deferred: J5-18 (player placement — high-value follow-up), J5-19 (responsive-matrix fixture), J5-20/21/22/24 (design/polish), J5-23 (no-fix). Confirmed gated #4/#5 hold in the endgame + the Wall holds. *(Detailed sections below are headed "Journey 5 — the ENDGAME".)*

Each journey: capture → fan out to 5 specialists → synthesize/de-dupe → consolidated remediation → **GATE (peer review)** → validate → compact → advance.

---

## Journey 4 — findings

**Date:** 2026-06-21 · **Rig run:** `j4` desktop/normal (1440×900) · **Scenario:** `j4_weekly_loop` · **LLM:** deepseek-v4-pro via OpenRouter · **Steps:** 47 · **Events:** 99 · **Frames:** 1759 · **Errors:** 0

### What J4 captured

J4 used a targeted premiere-gate clearing strategy: after `createCharacter`, `/api/orwell/state` was fetched to get all 15 NPC names; three group intro messages (5 names each) were sent so the auto-belt (`_auto_mark_premiere_intros`) could match names against each turn's narration. After the groups + 1 HOH nudge, the HOH competition started and the comp-intent decision card appeared.

**Verified working (J3 fixes confirmed in live capture):**
- Chip min-height: 36px ✓ (`minH: "36px"` on all 3 comp-intent chips)
- Confirm min-height: 44px ✓ (`h: 44, minH: "44px"` on confirm)
- Dismiss opacity: 0.75 ✓ (was 0.55)
- Note opacity: 0.8, font-size: ~15px ✓ (was 0.65 / 0.78em)
- Progress bar `role="progressbar"`, `aria-valuemin/max/now` ✓
- Progress bar `aria-description="Advances as houseguests are evicted"` ✓ (J3-25)
- Tutorial copy: "Close guide", "fifteen houseguests", emoji aria-hidden ✓

**Decision card behaviour confirmed:**
- Confirm is `disabled=true` before any chip selection ✓
- Confirm enables (`disabled=false`) after chip selection ✓
- Tab from the card lands on an `odec-opt` button ✓
- Non-binding comp-round auto-selects "compete" + enables confirm ✓
- Comp-round note says "Just color…" vs binding round "This sets how you play the comp." ✓

### Findings index (J4)

#### Gated set #4 (lead capture + J4-01…03 specialist de-dup)

| ID | Severity | Status | One-line |
|---|---|---|---|
| J4-01 | HIGH-PRIORITY POLISH | FIXED | Post-stream `messageInput.focus()` in `chat.js:3232` unconditionally overrides `card.focus()` — focus lands on the composer, not the decision card |
| J4-02 | HIGH-PRIORITY POLISH | FIXED | Decision card `role="group"` wrong for a binding form — SR users have no landmark cue that this requires action; changed to `role="form"` |
| J4-03 | HIGH-PRIORITY POLISH | FIXED | Dismiss button `aria-label="Dismiss"` too vague; title says "Dismiss — you can decide in conversation instead"; brought label in line |
| J4-04 | UX REFACTOR BACKLOG | OPEN | `data-binding` attribute absent on non-binding staged comp-round cards (`c.dataset.binding === null` instead of `"false"`) |
| J4-05 | OUT-OF-LANE | OPEN | Premiere gate clears (targeted group intro strategy works) but `state_post_intros.moment` is still "premiere" before the HOH nudge; gate progress not surfaced to the player in real-time (J3-07/08 deferred) |
| J4-06 | OUT-OF-LANE | OPEN | Game remained at `hoh-competition` at end of run — model didn't call `advanceGame` enough times to resolve HOH; same root cause as J3-05 (anti-sycophancy stall) |
| J4-07 | UX REFACTOR BACKLOG | OPEN | `barFill: "0%"` throughout run; correct (no evictions occurred), but confirms no dynamic update happened — bar will only update when the first eviction fires (expected) |

#### Gated set #5 (5-specialist consolidation, de-duped)

| ID | Specialist | Severity | Status | One-line |
|---|---|---|---|---|
| J4-08 | content/a11y | LAUNCH-BLOCKING | FIXED | Confirm label revert in catch block drops the `self-evict` irreversibility signal — "Confirm — this is binding" replaces "Confirm — leave the game (final)" on error retry |
| J4-09 | content/a11y | HIGH | FIXED | `.odec-err` has no `role="alert"` / `aria-live` — SR users get no announcement when a submission fails (WCAG 4.1.3) |
| J4-10 | content/a11y | HIGH | FIXED | `.odec-err` uses `--red` (#e06c75 on #fff ≈ 3.0:1) — WCAG 1.4.3 FAIL in light theme; dark theme passes (6.4:1) |
| J4-11 | content/a11y + visual | HIGH | FIXED | Dismiss `×` is 32×31px — below the project's 44×36 coarse-pointer floor; WCAG 2.5.5 fail |
| J4-12 | content/a11y | HIGH | FIXED | Card focus lands on `role="form"` container with no `aria-describedby` to the instruction note — SR user hears title but not the "your selection only" instruction (WCAG 4.1.2) |
| J4-13 | content/a11y | POLISH | FIXED | "Just color" in non-binding comp-round note is film/TV production jargon; new players may not parse it |
| J4-14 | content/a11y | POLISH | FIXED | Progress bar uses `aria-description` (draft ARIA 1.3, inconsistent AT support) — replaced with `aria-describedby` + hidden `<span>` |
| J4-15 | content/a11y | POLISH | **FIXED (gated set #6 / J5-16)** | Premiere tutorial dismiss button `min-height: 24px` is the WCAG 2.5.8 floor, not a safe touch target; project floor is 44×36 → lifted 24→36px |
| J4-16 | flows | HIGH | OPEN | Dismiss re-arm gap — after dismiss, the `rearmFromStatus` polling loop (15s) re-shows the card if the engine still reports `pending`; player who dismisses to "decide in conversation" gets the card back unexpectedly |
| J4-17 | flows | HIGH | OPEN | Binding vs non-binding comp-round title is identical ("Competition round — your approach this round") — the only distinction is in the button label and note text; a binding first-round card looks identical to a non-binding flavor round |
| J4-18 | flows | HIGH | OPEN | Engine stall (J3-05/J4-06) produces zero FE signal — the card disappears, the bar stays at 0%, and there is no "decision processing" or "something went wrong" state; player has no way to know if the game is frozen or just slow |
| J4-19 | flows | POLISH | OPEN | Post-confirm prefill "I've made my decision — let's see how the house takes it." is prescriptive — it puts words in the player's mouth; an empty box (or prompt-only placeholder) better preserves player voice |
| J4-20 | interaction | HIGH | OPEN | Disabled confirm has no hint — `opacity: .4; cursor: not-allowed` but no tooltip, no `aria-describedby` on the disabled state, no explanation of why it's disabled or what to do (WCAG 3.3.2 — instructions for user input) |
| J4-21 | interaction | POLISH | OPEN | No ambient pending indicator post-dismiss — after the player dismisses to decide in conversation, there is no persistent "decision pending" signal anywhere; the only cue is memory |
| J4-22 | interaction | BACKLOG | CLOSED (J4-08) | Error state confirm button text inconsistency — addressed by the `confirmLabelFor()` fix in J4-08 |
| J4-23 | visual | HIGH | OPEN | Card has no scrim / figure-ground isolation — the decision card blends into the `#chat-history` background with no shadow, backdrop, or overlay; the `box-shadow` token `--win-shadow` is defined but not applied |
| J4-24 | visual | HIGH | OPEN | All option chips are visually identical regardless of decision kind — no risk differentiation between a "compete" comp chip and an "eviction vote" chip; eviction stakes are visually indistinguishable from a practice round |
| J4-25 | visual | POLISH | CLOSED (→ J4-11) | Dismiss button 31×32px below 44px — merged with J4-11 (same finding from two lenses) |
| J4-26 | IA | HIGH | OPEN | No persistent phase label after card closes — the player sees "Week 1 / HOH competition" only while in the sidebar; once the decision card closes there is no on-screen reminder of where in the week's flow they are (same class as J3-07) |
| J4-27 | IA | HIGH | **FIXED (gated set #6 / J5-16)** | Tutorial card header "Welcome to the house — premiere week" is stale in non-premiere phases → `removeTutorial()` now graduates the banner past week 1 (also closes J3-11) |
| J4-28 | IA | POLISH | OPEN | No signpost from decision card to cast panel — the nomination/eviction cards show houseguest names but no affordance to open the cast roster for context |

### J4-01 — Post-stream `messageInput.focus()` overrides decision card focus · HIGH-PRIORITY POLISH · FIXED

- **Principle:** WCAG 2.4.3 (focus order) / Nielsen H1 (visibility of system status). The decision card calls `card.focus()` (J3-18 fix) when it renders, but this focus is immediately overridden.
- **Root cause:** `chat.js:3226–3234` — when the stream ends and `aria-busy` clears, the post-stream cleanup unconditionally calls `messageInput.focus()` on desktop (non-narrow) viewports. The decision card appears during streaming (the `orwell:pending` event fires from the `advanceGame` tool result mid-stream), gets focused, then loses focus the moment the stream ends.
- **Evidence:** `decision_card_comp_intent.focused: false` despite `tabindex: "-1"` being set. Mutation log confirms `advanceGame` (t=272175ms) + `orwell:pending` (t=272255ms) fire before the stream settles (t=292892ms). Post-stream focus restoration overwrites the card's focus every time.
- **Fix:** In `chat.js:3232`, check for a visible decision card before focusing the composer. If a card is present, focus it (re-asserting the J3-18 intent) instead of returning to the composer. The composer is re-focused when the card is confirmed or dismissed.
- **Confidence:** H.

### J4-02 — `role="group"` wrong for a binding decision card · HIGH-PRIORITY POLISH · FIXED

- **Principle:** WCAG 4.1.2 (name, role, value). `role="group"` groups form controls but is not a form landmark; screen reader users navigating by landmark will never reach the card via landmark nav, and the AT will not announce that this requires a binding response.
- **Consequence:** Keyboard/SR-only players may not know a binding HOH/nomination/eviction decision is pending; they only know if they happen to Tab into it or read through the entire `role="log"` chat history.
- **Evidence:** `decision_card_comp_intent.role: "group"` — confirmed in live J4 capture. ARIA best practice for an inline form that requires a submit action: `role="form"` with an accessible name becomes a named form landmark, reachable via AT landmark navigation.
- **Fix:** `orwellDecision.js:155` — change `card.setAttribute("role", "group")` → `card.setAttribute("role", "form")`. Existing `aria-label` (the title) provides the accessible name.
- **Confidence:** H.

### J4-03 — Dismiss `aria-label="Dismiss"` does not explain the intent · HIGH-PRIORITY POLISH · FIXED

- **Principle:** WCAG 2.4.6 (headings and labels); content/clarity. The `title` tooltip already says "Dismiss — you can decide in conversation instead" — the right signal. The `aria-label` overrides the title for AT users, giving them only "Dismiss" with no context.
- **Consequence:** Screen reader users hear "Dismiss, button" and have no cue that they can instead decide through conversation (the main game path). Two players — sighted (tooltip) and non-sighted (aria-label) — hear different things.
- **Evidence:** `decision_card_comp_intent.dismiss.ariaLabel: "Dismiss"` vs `title: "Dismiss — you can decide in conversation instead"`.
- **Fix:** `orwellDecision.js:167` — update `aria-label` to match the intent: `"Dismiss — decide in conversation instead"`.
- **Confidence:** H.

### J4-04 — `data-binding` absent on non-binding comp-round cards · UX REFACTOR BACKLOG · OPEN

- **Root cause:** `orwellDecision.js:273` pre-selects "compete" when `pending.binding === false`, but doesn't set `card.dataset.binding` — the probe reads `c.dataset.binding` as `null` rather than `"false"`. The visual behavior is correct (button says "Push through this round"), but the attribute isn't exposed for external inspection/testing.
- **Deferred:** Low-severity; the UX is correct. Add `card.dataset.binding = String(pending.binding !== false)` in a future pass.

### J4-05 / J4-06 — Engine progression stall (same root as J3-05) · OUT-OF-LANE · OPEN

- Game never advanced past `hoh-competition` moment; model narrated fictional nominations/veto/eviction without engine backing. `state_final: {moment: "hoh-competition", evicted: 0}`.
- Deferred: engine-side investigation (J3-05 / anti-sycophancy) + agent loop work queue.

---

## Journey 4 — remediation (gated set #4)

**Scope: J4 FE fixes — post-stream focus, decision card role, dismiss label. Verified: J3-16/17/18/25 fixes confirmed in live capture.**

| Fix | File | J4 Finding |
|---|---|---|
| Post-stream: if decision card present, focus card (not composer) | `static/js/chat.js` | J4-01 |
| Decision card: `role="group"` → `role="form"` | `static/js/orwellDecision.js` | J4-02 |
| Dismiss `aria-label="Dismiss"` → descriptive | `static/js/orwellDecision.js` | J4-03 |

**Deferred from J4 gated set #4:**
- J4-04 (`data-binding` attribute) — cosmetic, behavior correct
- J4-05/06 (engine progression stall) — engine investigation

---

## Journey 4 — remediation (gated set #5)

**Scope:** 5-specialist consolidation: J4-08 (launch-blocking confirm label revert) + J4-09/10/11/12/13/14 (a11y fixes from content/a11y specialist). Closes the top items from all 5 lenses; defers design-level and engine-adjacent items.

| Fix | File | J4 Finding |
|---|---|---|
| Add `confirmLabelFor(kind, binding)` helper; use in catch block | `static/js/orwellDecision.js` | J4-08 |
| Pre-declare `role="alert" aria-live="assertive" aria-atomic="true"` error container in render | `static/js/orwellDecision.js` | J4-09 |
| `.odec-err` color: `var(--red)` → `var(--color-error, var(--red))`; add `--color-error: #b83245` in `:root.light` | `static/js/orwellDecision.js` + `static/style.css` | J4-10 |
| `.odec-x` dismiss: add `min-width: 44px; min-height: 44px; display: inline-flex; align-items: center; justify-content: center;` | `static/js/orwellDecision.js` | J4-11 |
| `card.setAttribute("aria-describedby", CARD_ID + "-note")` + `note.id = CARD_ID + "-note"` | `static/js/orwellDecision.js` | J4-12 |
| "Just color" → "No stakes here" in non-binding comp-round note | `static/js/orwellDecision.js` | J4-13 |
| Replace `aria-description` with `aria-describedby` + hidden `<span>` on progress bar | `static/js/orwellSeasonProgress.js` | J4-14 |

**Validation:** 13 new source-pinned tests in `tests/test_j4s5_decision_card_a11y.py` — 13/13 passed. Full FE suite: **1814 passed** (0 failures).

**Deferred from gated set #5:**
- J4-15 (tutorial dismiss tap target 24px) — low-priority polish; separate ticket
- J4-16 (dismiss re-arm gap) — needs owner decision on re-arm semantics
- J4-17 (binding badge visual) — design-level; Phase-4 backlog
- J4-18 (engine stall zero FE signal) — engine investigation (J3-05 / J4-06 cluster)
- J4-19 (prefill prescriptive) — owner preference call
- J4-20 (disabled confirm no hint) — requires design for the hint placement
- J4-21 (ambient pending indicator) — design-level
- J4-23 (card no scrim) — design-level; Phase-4 backlog
- J4-24 (chips identical no risk signal) — design-level
- J4-26/27 (phase label / tutorial graduation) — J3-07/J3-11 cluster; needs design decision
- J4-28 (cast panel signpost) — Phase-4 backlog

---

## Journey 5 — the ENDGAME (capture phase)

**Date:** 2026-06-21 · **Rig run:** `j5` desktop/normal (1440×900) · **Scenario:** `j5_endgame` · **Steps:** 17 · **Frames:** 120 · **Errors:** 0

### Capture method (new, reusable — leverages the committed playtest harness)

The recurring J3/J4 blocker — the LLM under-calls `advanceGame`, so a real-LLM playthrough stalls at HOH and never reaches the endgame — makes a *conversational* drive to the finale impractical. J5 adopts the committed harness's `s4ff.mjs` technique: **drive the ENGINE directly via player-channel `callTool` (EchoNarrator, no LLM cost) on the same engine user the FE renders** (auth-disabled ⇒ engine user `default`), fast-forwarding `advanceGame`/`submitDecision`; at each NEW endgame-class pending, **pause and load the FE** so `rearmFromStatus` (the boot re-arm, ≤5s) renders that *real* card for capture; post-finish, capture the finale + retrospective surfaces. This is the efficient endgame-UX capture path and is banked in `journeys.py:j5_endgame`.

### What J5 reached

- Season fast-forwarded to **completion in 354 iterations**: **winner crowned, week 13**, 9-juror finale.
- **Player fate: evicted to the JURY** (the most common real outcome — most players don't win) → captured the *losing player's* endgame arc.
- **Endgame decision cards captured (real, rearm-rendered):** `goodbye-message` (week 1, as a weekly voter), `juror-question` (week 13 finale — the player's own question to a finalist), `juror-vote` (week 13 finale — the player crowns the winner).
- **Retrospective (0048) captured:** the `📼 The Season, Watched Back` window opened post-season (`role="complementary"`, on-screen, 380×426 top-right), showing the per-juror finale tally, then the **🔓 Open the Producer's Vault** unseal → the off-screen story ("a double-eviction fired in week 12", "[secret thread] …").

### Confirmed working in the endgame context (gated #3/#4/#5 fixes hold — do NOT re-report)

From the live probes on all three endgame cards: `role="form"` ✓ · `aria-describedby="orwell-decision-card-note"` ✓ · card receives focus on mount ✓ · dismiss × **44×44** ✓ (J4-11) · error container `role="alert" aria-live="assertive"` ✓ (J4-09) · chips **36px** / confirm **44px** ✓ (J3-16). The fixes generalize across every decision-card kind, as designed (one renderer).

### Wall integrity (positive — verified)

The retrospective shows **per-juror FINALE vote attribution** ("X votes for Eli Underwood") — correct: the finale jury vote is *public* (the crowning). Per-voter **weekly** eviction attribution appears **only after** the Vault unseal (0048 post-season), never in a live player projection. The Wall holds at the endgame.

### Lead's direct leads (handed to the specialist fan-out for confirmation/depth)

- **L-a (HIGH, content):** the textarea cards (`goodbye-message`, `finale-statement`, `juror-question`) show the generic note **"Your selection only — never read from prose."** directly under a **prose `<textarea>`** — the note contradicts the affordance. (Confirmed in probes for goodbye-message + juror-question.)
- **L-b (HIGH, a11y):** the endgame `<textarea>`s have **no accessible name** (`aria-label: null`, `aria-labelledby: null`) — placeholder-only (WCAG 4.1.2 / 3.3.2).
- **L-c (MED):** `juror-question` confirm is **enabled with an empty textarea** — the player's single jury question can submit blank.
- **L-d (MED):** `goodbye-message` confirm stays disabled until a **tone chip** is picked, with no hint that a tone is required (WCAG 3.3.2; sharper instance of J4-20).
- **L-e (MED/POLISH):** the retrospective **unseal button is 32px tall** — below the 44px project floor (same class as J4-11).
- **L-f (corroborates J4-23):** decision card `box-shadow: none` — no figure/ground isolation even when crowning the winner; `--win-shadow` token exists, unapplied.
- **L-g (corroborates J4-27):** the **"premiere week" tutorial card is still rendered at the week-13 finale** (visible in shot `01-02`) — content-driven visibility never graduates.
- **L-h (Tab order):** first Tab from the focused card lands on the **dismiss ×** (it's first in DOM) — a keyboard user reaches "skip this binding decision" before the options (WCAG 2.4.3).

### Findings index (J5) — 5-specialist consolidation (de-duped)

Lenses: **content-a11y (CA)**, **visual-motion (VM)**, **transient-animation (TR)**, **social-game (SG)**, **responsive-crossplatform (RX)**. Convergent findings carry every lens that found them.

| ID | Lens(es) | Sev | Status | One-line |
|---|---|---|---|---|
| J5-01 | CA · SG | LAUNCH-BLOCKING | FIXED | Textarea cards (`juror-question`, `finale-statement`, `goodbye-message`) showed the generic note **"never read from prose"** (announced via `aria-describedby`) directly above a **prose textarea** — instructs SR users NOT to use the only input |
| J5-02 | CA | LAUNCH-BLOCKING | FIXED | The three endgame `<textarea>`s have **no accessible name** (`aria-label`/`labelledby` null) — placeholder-only (WCAG 4.1.2) |
| J5-03 | VM · TR | HIGH | FIXED | Decision card has **no `box-shadow`** — the only window-like surface missing figure/ground; even when crowning the winner it reads as a narration block (the `--win-shadow` token existed, unused) |
| J5-04 | CA | HIGH | FIXED | Chip border `--border` on the dark chip fill is **~2.25:1** — below WCAG 1.4.11's 3:1 for the UI-component boundary that is the only way to make the pick |
| J5-05 | VM · TR | HIGH | FIXED | Decision card has **no entrance/transition** — binding decisions pop in and flip to "✓ Locked in" as silent text swaps (peak-end fail) |
| J5-06 | TR | HIGH-if-triggered (LATENT) | FIXED | A confirmed card's **un-cleared `setTimeout(removeCard, 4000)`** + removal-by-id can **delete a freshly-armed next decision card** (back-to-back endgame decisions trigger it) |
| J5-07 | CA | HIGH | FIXED | Retrospective section labels are `<strong>`, not headings — invisible to SR heading navigation (WCAG 1.3.1) |
| J5-08 | CA · VM · SG | HIGH | FIXED | Vault unseal button: dark-ink `--on-accent` on the purple accent ≈ **3.56:1** (WCAG 1.4.3 fail) **and** 32px tall (below the 44px tap floor) |
| J5-09 | VM · SG | HIGH | FIXED | Retrospective hierarchy: winner line has no apex weight (same 13px/0.9 as a mid-season highlight); the per-voter "how the votes really fell" payoff renders **last**, below the 40-line confessional dump |
| J5-10 | TR | HIGH | FIXED | Retrospective `replaceChildren()`-rebuilds its **whole body every 30s** with no scroll/focus preservation — snaps a reader to the top, drops focus to `<body>`, on terminal immutable content |
| J5-11 | CA | POLISH | FIXED | Hidden-story entries render as `[confessional] …` — reads as debug metadata, not producer-voice prose |
| J5-12 | CA · TR | HIGH | FIXED | `orwellFinalizing.js`'s **infinite pulse ignores `prefers-reduced-motion`** (runs 30–60s; WCAG 2.2.2) |
| J5-13 | CA | HIGH | FIXED | Finale move buttons (`.ofin-btn`) ~27px tall at `.74rem` — below the tap floor at the most time-pressured moment |
| J5-14 | CA | MED | FIXED | Finale finalist tally is a bare number with **no accessible name** (WCAG 4.1.2) |
| J5-15 | CA | MED | FIXED | Finale stage label is not a live region — stage transitions (incl. "the votes are read") aren't announced |
| J5-16 | VM · IA | HIGH | FIXED | The **"premiere week" tutorial still renders at the week-13 finale** — content-gated to week 1 but only ever mounted, never removed (corroborates J4-27); also lifts its dismiss button 24→36px (J4-15) |
| J5-17 | CA | POLISH | FIXED | `finale-statement` card title ("Finale — your statement…") didn't match the finale panel's "Opening statements" vocabulary |
| J5-18 | SG | HIGH (common case) | **FIXED (#491)** | The retrospective never states the **player's own placement or the jury margin** — headlines only the winner; the most common outcome (losing player on jury) reads as audience to someone else's story. → `/recap` now surfaces `placement` + `margin`; the retro renders "You finished Nth — runner-up/jury/evicted" under the crown (gate `test_j5_18_placement.py`) |
| J5-19 | RX | LAUNCH-BLOCKING (coverage) | **FIXED (#491)** | The CI **responsive-matrix never advances past a fresh game** so the endgame surfaces were rendered at **zero mobile viewports**. → opt-in `ORWELL_MATRIX_FINISH` finished-season pass (fail-soft) fast-forwards via callTool and mounts the retro + decision card at phone-390/tiny-320 (gate `test_j5_19_matrix_endgame.py`) |
| J5-20 | VM | MED | **FIXED (#496)** | `juror-vote` chips were visually identical to a comp-intent chip — crowning the winner had no risk signal. → `HIGH_STAKES_KINDS` → `.odec-risk` skin + "⚠ Irreversible — binding" badge (not color-only, `role=note`); gate `test_j5_20_21_decision_polish.py` |
| J5-21 | CA | MED | **FIXED (#496)** | Dismiss × was the **first Tab stop** on a binding card. → dismiss × moved last in DOM (absolute-positioned top-right); Escape/44×44/aria preserved; gate `test_j5_20_21_decision_polish.py` |
| J5-22 | CA | POLISH | DEFERRED | Decision-card error copy "your move wasn't allowed" is system-language |
| J5-23 | SG | LATENT (design ruling) | NOFIX | Player-juror's question is scoreless free-text while a player-finalist's answers are engine-scored — defensible BB fidelity (the juror's power is the vote); flagged for a product ruling, not a defect |
| J5-24 | CA | POLISH | DEFERRED | Retrospective window `aria-label` includes the 📼 emoji, read verbatim ("video cassette …") by SR |

**Verified WORKING (steelman — keep as patterns):** the Wall holds at the endgame (per-voter **weekly** attribution unseals only post-season; the finale jury tally is public, as designed); **jury management is genuinely wired** (goodbye-message tone folds into the evictee's `manner` → jury lean); gated #4/#5 a11y fixes hold across every endgame card kind (one renderer); the `OrwellWindow` kit is an exemplary reduced-motion baseline; the vault unseal delivers real off-screen drama with no slug leaks.

**Caveats for the lead (re-probe targets):**
- **The narrated finale + losing-player jury-seat arc in CHAT were NOT exercised** (the fast-forward used EchoNarrator + direct-engine drive). SG/TR-1's "the crowning has no ceremony" stands *structurally* (no FE reveal beat), but the lived feel depends on the narration the harness skipped → a **real-LLM J5** (CLAUDE.md "Live (real-LLM) manual testing") is the right next probe, and would also resolve whether J5-18 is a window gap or covered by narration.
- **Telemetry method:** `_capture_card` reloads per card, so the mutation log only retained the final session — drive consecutive endgame cards in one page session next time to capture mount/unmount timestamps.

### Journey 4 — remediation (gated set #6)

**Scope:** the J5 endgame surfaces — decision card (endgame kinds), retrospective, finale, finalizing indicator, premiere tutorial. 17 fixes across 5 files; all low-risk source edits, source-pinned-tested. The two LAUNCH-BLOCKING content items + the strongest HIGH a11y/contrast/tap/motion items + two real bugs (J5-06 timer, J5-10 churn).

| Fix | File | J5 Finding |
|---|---|---|
| Per-kind notes for textarea cards (affirm prose; tone-binds; blank-to-pass) | `static/js/orwellDecision.js` | J5-01 |
| `aria-label` on the 3 endgame textareas | `static/js/orwellDecision.js` | J5-02 |
| `box-shadow: var(--win-shadow)` on the card | `static/js/orwellDecision.js` | J5-03 |
| Chip border `color-mix` toward `--fg` (≥3:1 in dark) | `static/js/orwellDecision.js` | J5-04 |
| `@keyframes odec-in` entrance + done-state transition, reduced-motion-guarded | `static/js/orwellDecision.js` | J5-05 |
| Tracked + identity-checked `_doneTimer` (cancel on re-arm) | `static/js/orwellDecision.js` | J5-06 |
| `<strong>` → `<h3>` vault section headings | `static/js/orwellRetrospective.js` | J5-07 |
| Unseal button `color:#fff` + `min-height:44px` + 13px | `static/js/orwellRetrospective.js` | J5-08 |
| Winner-line apex weight + reorder votes above hidden-story | `static/js/orwellRetrospective.js` | J5-09 |
| `_lastSig` render-signature guard (skip redundant 30s rebuilds) | `static/js/orwellRetrospective.js` | J5-10 |
| Prose annotation (drop `[brackets]`) on hidden-story | `static/js/orwellRetrospective.js` | J5-11 |
| `prefers-reduced-motion` guard on the finalizing pulse | `static/js/orwellFinalizing.js` | J5-12 |
| `.ofin-btn` `min-height:36px` + `.82rem` | `static/js/orwellFinale.js` | J5-13 |
| Finalist tally `aria-label` ("N votes") | `static/js/orwellFinale.js` | J5-14 |
| Stage label `aria-live="polite"` | `static/js/orwellFinale.js` | J5-15 |
| `removeTutorial()` graduation past week 1 + dismiss 24→36px | `static/js/orwellPremiereTutorial.js` | J5-16 / J4-27 / J4-15 |
| `finale-statement` title → "Opening statement — address the jury" | `static/js/orwellDecision.js` | J5-17 |

**Validation:** 19 new source-pinned tests in `tests/test_j5_endgame_a11y.py` — 19/19 passed. Full FE suite **1834 passed** (1 pre-existing flaky `test_h2b_all_model_pools` — passes in isolation, unrelated). Live re-capture confirmed the retrospective renders clean (0 errors), unseal button now **44px** (was 32px), winner line at apex weight.

**Deferred (recorded above):** J5-18 (player placement in retrospective — high-value follow-up; needs the GET route to surface `_derive_placement`/`_last_finale_margin`), J5-19 (responsive-matrix finished-season fixture — test-infra), J5-20/21/22/24 (design/polish), J5-23 (no-fix design ruling).
---

## Real-LLM deep pass (R1) — the premiere soft-lock (LAUNCH-BLOCKING)

**Date:** 2026-06-21 · **Rig:** `j6_realllm` desktop/normal · **Model:** deepseek/deepseek-v4-pro (OpenRouter, real) · the one seam every automated gate stubs the LLM for, so it can't see this.

### Finding R1-01 — the meet-everyone gate never progresses with the real model → player soft-locked at premiere · **LAUNCH-BLOCKING** · FIXED

- **Symptom (engine oracle, not FE render):** after the real model narrated meeting ~13 houseguests across 3 turns, `premiereIntros` reported **`metCount: 1 of 16, complete: false`**. The game stayed in `moment: premiere` across every turn; the first HOH (gated on all-met) was unreachable. The model narrates richly but **under-calls the engine tools** — and it isn't even sent `markHouseguestMet` (confirmed in `[agent-debug] tool_names`), so the FE belt is the *only* mechanism that can register intros.
- **Root cause (FE, `src/agent_loop.py`):** the compensating belt `_auto_mark_premiere_intros` early-returned on `if not narration or not owner`. The **anonymous / localhost-bypass / single-tenant** path — the deploy default — resolves `owner=None` (the engine maps a missing user header to its one `default` sandbox). The sibling belts (`_auto_record_scene`, `_auto_move_player`) pass `None` straight through and work; only the premiere belt refused, so it **silently never ran** for that whole class of deploy. FE-log proof: the sibling belts fired (`auto-recorded scene … user=None`) but there was **zero** `auto-marked premiere intro` activity, and the E22 fallback-digest guard fired every turn (a turn narrated with no engine write).
- **Why no gate caught it:** every automated gate stubs the LLM (`Echo`/`DeterministicNarrator`), which doesn't reproduce the under-call; and the belt's failure is silent (fail-open, early-return). Only a real-LLM run against engine truth exposes it. This is precisely the J3-05/J3-06/J4-06/J4-18 cluster, now **root-caused** with the real model.
- **Fix:** relax the guard to `if not narration` — tolerate a `None` owner exactly as the sibling belts do (the engine maps it to `default`). 2 regression tests in `tests/test_premiere_meet_everyone.py` (belt marks named intros with `owner=None`; only missing narration is a no-op).
- **Validation:** unit 7/7; full FE suite 1837 passed (1 pre-existing flaky, unrelated). **Live end-to-end re-run in progress** to confirm the premiere clears and the game reaches HOH with the fix.

### Positives confirmed (real model)
- **Narration fidelity is strong** (deepseek-v4-pro): in-character producer voice, no model-slug/OOC leaks in the public bubble, the reasoning split held (thinking stayed in the accordion). The model is a good narrator — the gap is purely the engine-tool *under-call*, which the FE belts exist to error-correct.
- `_auto_record_scene` (the 0055 consequence belt) **did** fire on the social turn (`kind=bonding`), so the consequence loop works for an anonymous owner — it was specifically the premiere belt that had the `owner` guard bug.

### Finding R1-02 — the FULL weekly loop holds end-to-end with the real model · VERIFIED (positive)

Continuation probe (`j6_weekloop`) drove the live game from `hoh-competition` through a complete weekly cycle with deepseek-v4-pro, confirming each decision card via the real `/api/orwell/decision` seam. **Moment path:** `hoh-competition → (staged comp rounds) → nominations → veto-competition → veto-ceremony → eviction → (eviction-vote) → (goodbye-message) → week-2 hoh-competition`. Engine truth: **Keith Bell nominated → voted out → goodbye messages folded (incl. the player's *warm* tone) → evicted → week 2** (14 active / 1 evicted; `seasonRecap` shows the full sequence). `advanceGame` fired throughout, the comp-round / eviction-vote / goodbye-message cards surfaced + submitted, and the 0064 `sync:game-updated` server-push fired on mutations. With the premiere belt fix (R1-01), **the game is playable through a complete weekly loop with the real model.**

### Finding R2-01 — non-binding comp-round: clicking the pre-selected chip deselects it and disables Confirm · POLISH · ✅ FIXED (`c7ff13d`)

> **RESOLVED (2026-06-21):** on a single-pick `comp-round`/`comp-intent` card, re-tapping the lit chip is now a no-op (early `return` before deselect, `orwellDecision.js:311-318`), so Confirm stays enabled. Original finding retained below for history.

On a non-binding (flavor) staged comp-round the card pre-selects "compete" and enables Confirm ("Push through this round") for one-click pass-through. But the chips keep single-select **toggle** semantics, so a player who taps the already-selected "compete" chip **deselects** it → Confirm goes disabled with no explanation. (Surfaced when the probe's generic fill clicked the pre-selected chip — CARD 01/03 came back `still-disabled`.) The intended path is to confirm without touching the chips, but tapping the only lit chip is a natural move. **Fix candidate:** on a single-pick card, clicking the sole selected chip should be a no-op (stay selected) rather than toggle off; or a non-binding comp-round should keep Confirm enabled regardless. Low severity (the card re-arms and the loop recovers).

### Finding R2-02 — the eviction-night staging leans on the forced-advance belt · NOTE (working as designed)

The eviction phase needed several turns and the FE forced-advance escalation (L39b) to push through — one turn fired a burst of 9 `advanceGame` calls. It DID progress (the guardrail caught the model's under-call and drove the staged eviction to completion), so this is the error-correction working, not a defect — but it confirms the eviction-night staging depends on the forced-advance belt with the real model, the same family as the premiere belt. Worth keeping an eye on if that belt is ever changed.

### Finding R3-01 — eviction-night: the staged reveal is INTENDED; the real residual is the model re-prompting an already-cast vote · MED (REVISED DOWN after reading the code) · FIXED (#496) + VERIFIED live

Multi-week probe (`j6_multiweek`): the loop advanced week 2 → week 3 (real evictions: Paul Pierce, Keith Bell) — **multi-week play is stable.** The probe's stall-detector tripped at the week-3 eviction, but **reading the code corrected my first read** (and is why I investigate before fixing):

- **The one-beat-per-turn eviction reveal is BY DESIGN.** `routes/chat_helpers.py:_pre_resolve_npc_ceremony` advances exactly one beat per turn *on purpose* — its own comments: *"One advance per turn preserves the staged eviction-vote reveal (E12)"* and it explicitly never re-holds "a staged eviction reveal ticking ballots." The eviction is a ~9–10-beat dramatic reveal (one anonymized `"a vote to evict X"` per voter), and walking it one ballot/turn is the intended BB cadence, **not** a stall. Driving `advanceGame` directly rolls it cleanly in ~10 calls → next week, so the engine is healthy.
- **My probe over-flagged it.** The per-turn ballot advance happens server-side (the pre-resolve belt) and does *not* change `moment`/`pending`, so my JS-event "progressed" check didn't count it — a **probe-measurement limitation**, not a product stall. (Methodology fix for next time: count a `beatSeq` increase as progress, not just a `gamechanged` reason / moment change.)
- **⚠️ The "obvious fix" would be a REGRESSION.** A forced roll-through of the whole reveal in one turn (what I'd sketched) would *destroy* the intended E12 ballot-by-ballot staging. Do **not** do it.
- **The genuine residual (narrow, MED):** during the multi-beat reveal the real model sometimes **re-prompts the player to cast an eviction vote already submitted** (`ask_user: "You're in the Diary Room casting your eviction vote… who do you vote to evict?"`). It's confusing but **non-blocking** — the pre-resolve belt advances the reveal regardless. The right fix is **prompt-side** (the eviction-reveal moment prompt should tell the model the player's vote is in and to narrate/advance the reveal, not re-collect a vote), not a pacing change. Same family as the casting "headshot already on file" framing fix.

**Severity:** MED (a confusing model re-prompt on eviction night), **not** HIGH and **not** launch-blocking — the prior HIGH framing was based on the probe's mis-measurement of the intended staging. The live game was unstuck to week 4 for continued testing.

---

## Real-LLM season-transition continuity (R4/R5) — the "black-ops-prestige" model

**Owner design clarification (2026-06-21):** each season is a **totally new existence — the persona is ERASED**; the **only** thing that carries across seasons is an **incremented level/season number** (like CoD Black Ops *prestige*). The continuity test verifies exactly that: meta-counter persists, everything else is wiped.

### Finding R4-01 — the FINALE doesn't complete with the real model (long staged sequence, model loops) · MED–HIGH · FIXED (#491) + VERIFIED live
> **Resolution:** added `"finale"` to `_CEREMONY_RESOLVE_PHASES` (`chat_helpers.py`) so the per-turn one-beat belt carries the staged finale reveal exactly as it carries nominations/veto/eviction — no one-turn roll-through (which would wreck the staged reveal, like R3-01). Verified live post-fix (the R4-01+R3-01 entry below): `finished=true`, winner crowned, `moment=post-season`.
The real-LLM finale probe (`j6_finale`) stalled at `moment=jury-finale` (week 14, `finished=false`, no winner) after 12 turns; the retrospective never appeared. Driving `advanceGame` directly completed it cleanly in ~29 beats → **winner crowned (the player, Audit Probe 2, won 7–2)**, so **the engine is healthy.** The finale is a long *intended* staged sequence — F2 opening statements → each finalist answers all 9 jurors (`finale-answer` per juror) → the jury vote revealed one juror at a time → winner. The real model **under-drives it and loops** ("let me check the game state… we haven't reached the vote yet"), partly aggravated by the probe pushing "read the votes" early (the model correctly resisted). **Same family as R3-01:** check whether the finale phase is covered by `_pre_resolve_npc_ceremony`'s per-turn auto-advance (`_CEREMONY_RESOLVE_PHASES`) — if the `finale`/`jury-finale` phase isn't in that set, it relies entirely on the model's under-called `advanceGame` and won't reliably finish. **Do NOT** roll-through in one turn (it would wreck the staged reveal, like R3-01). Positive: **J5-18 live check passed** — the narration referenced the player's own standing (`placementNarrated=true`).

### Finding R5-01 — the post-season hand-off offers "Keep this houseguest", contradicting the prestige model · HIGH (design conflict) · RESOLVED (owner ruling — keep the option + isolation constraint; see R5-02)
`orwellNewSeason.js` renders two buttons: **"Keep this houseguest"** (`data-keep="1"` → feature 0056, `next-season {keep:true}` carries the prior CHARACTER) and "Recast from scratch" (`data-keep="0"`). Under the owner's stated model (*persona erased, totally new existence, only the level number carries*), the **keep path should not exist** — it carries a persona across the prestige boundary. **Recommend** removing the keep affordance (and the `keep:true` path) so every season is a clean recast; flagged for an owner ruling since it removes shipped functionality (0056).

### Transition mechanics — VERIFIED prestige-correct (recreate path)
Triggered `POST /api/orwell/next-season {keep:false, confirm:true}` from the finished season 1 (player won). Engine/ledger truth, before → after:

| Property | Before (S1) | After (S2) | Prestige-correct? |
|---|---|---|---|
| season counter (ledger `default`) | 1 | **2** | ✅ the one carry-over |
| `/api/orwell/season` (player-facing) | — | `{"season":2}` (the "Season 2" chip shows past S1) | ✅ visible |
| engine moment | `post-season` | **`character-creation`** (fresh casting) | ✅ persona erased |
| player record | `Audit Probe 2` | **`None`** | ✅ erased |
| cast | Paul Pierce, Sage Hahn, … | **`[]`** (regenerated fresh) | ✅ new existence |
| season-1 leakage | — | none (`started=false`) | ✅ clean |

The recreate path is exactly the black-ops-prestige model. **Season-2 playthrough (casting → premiere → end of day 1) with the real model: in progress** (`j6_season2`) — re-validates the R1-01 premiere belt fix holds *across* the transition.

### Finding R6-01 — the next-season recreate cutover likely DISCARDS the finale-prewarmed cast photos · HIGH (needs live confirm) · RESOLVED via code-trace (NOT a bug — see R6-01→RESOLVED below)
**Owner requirement (2026-06-21):** the next-season cast **identities + photos prewarmed during the finale** (0065 `preSeedNextSeason` / the finale-day warm poll + `warm-portraits`) must be **KEPT/adopted** by the new season — they're the whole point of warming ahead. (This is consistent with the prestige model: the *player persona* is erased, but the *NPC cast* the player will meet was prepared during the finale and should carry.)
- **Code-trace concern:** the recreate route (`/next-season {keep:false}`) calls `orwell_portraits.scrub_user(user)` → `shutil.rmtree(user_portrait_dir(user))` (deletes the **whole** portrait dir) **and** `orwell_prewarm.reset(user)` *before* the new cast generates (`orwell_routes.py:1136-1147`). If the prewarmed next-season photos live in that same per-user dir, the cutover **deletes them**, defeating the warm — the new season then re-generates from scratch (slow, and the prepared faces are lost). The engine intends adoption via a held seed + a re-warm poll (`orwell_prewarm.py:73-78` keeps the finale-day warm alive across `reset()`), but whether the recreate path **adopts** the held IDENTITIES vs **regenerates** a new cast is unconfirmed.
- **Severity:** HIGH if confirmed (wastes the finale prewarm + breaks the "instant, ready next season" the warm exists for). **Not yet confirmed live** — see limits below.
- **Test limits in this environment:** (1) **no image provider is wired** (only the LLM; portraits use the Noop adapter), so the PHOTO side can't be generated/compared here; (2) the finale was direct-driven via `callTool`, so the FE finale poll that fires `preSeedNextSeason`/`warm-portraits` never ran — there was no held set to adopt. A clean test needs an image-capable provider + an FE-driven finale.

### Finding R7-01 — season-2 casting could not be driven by the rig (probe gap, not confirmed product) · INFO · OPEN
The `j6_season2` probe errored on `Page.click(".send-btn")` (30s timeout) at the `character-creation` casting screen — the rig's send selector isn't present/clickable there (likely a different composer state or an onboarding overlay). So season-2 casting itself is **untested** (the "Season 2" prestige chip + apiSeason=2 DID render correctly before the error). Needs a probe fix (the casting-screen send affordance) to test season-2 casting → premiere → day 1.

### Owner rulings (2026-06-21) on the season transition
- **R5-01 → RESOLVED (keep the option, with an isolation constraint):** the "Keep this houseguest" path **stays** — the player MAY carry their persona across seasons — **BUT nobody in the new cast may know the player from before.** The carried player must be a total STRANGER to the new cast: zero prior-season relationship/knowledge bleed (no carried trust/affinity/threat edges, no NPC awareness of the player's prior-season history). New verification target (R5-02 below).
- **R6-01 → VERIFY FIRST:** confirm whether the recreate/keep cutover ADOPTS the finale-prewarmed cast identities (and intends to keep the photos) vs regenerates, BEFORE any fix. (Photo side untestable here — no image provider; identity side is testable via callTool.)

### Finding R5-02 (NEW, from the ruling) — on the KEEP path, the new cast must not know the carried player · VERIFY · OPEN
Isolation requirement: when the player keeps their persona into season N+1, the season N+1 cast (fresh NPCs) must have **no relationship state and no knowledge** of the player carried from season N — every NPC meets them as a stranger. To verify (callTool, deterministic): after a KEEP cutover, the new NPCs' relationship edges toward the player are empty/neutral, the event/knowledge store carries no prior-season player↔NPC history, and premiere intros treat the player as unmet. (Distinct from the Vault Wall, but the same isolation spirit — prior-life leakage into a new existence.)

### R6-01 → RESOLVED via code-trace (NOT a bug) + R6-02 (photo-timing design question)
**"Verify first" outcome.** Tracing `orwell_prewarm.prewarm_next_season` (its docstring is definitive):
- **Identity/cast-DATA carry is correctly wired.** The next season's cast (names + deep profiles) is warmed during the finale into a **per-user HOLDING STORE at the ENGINE registry level + a durable mirror that SURVIVES the cutover (even across an engine restart); the cutover ADOPTS it.** No model ⇒ the engine still warms a deterministic floor. This is exactly the "keep the prewarmed identities" the owner asked for — **met by design.** (Wiring confirmed by trace; a full live warm→cutover→compare needs a season-long fast-forward + the durable-mirror read, deferred.)
- **My earlier "scrub_user deletes prewarmed photos" concern was a WRONG ASSUMPTION — withdrawn.** Photos are NOT finale-prewarmed into the portrait dir. They are a **SEPARATE Phase-2 warm fired AT the next-season confirm** (the cutover), gated off Phase-1. So `scrub_user` correctly clears the OLD cast's photos, and Phase-2 then generates the NEW (already-adopted) cast's photos. Identities live at engine level — `scrub_user` never touches them. No data loss.
- **The `/api/orwell/prewarm-next-season` 404 was FE staleness**, not a route bug — it returns 200 on a fresh FE. (Lesson: restart the FE after each `main` merge for valid live tests; the engine state persists across FE restarts.)

### Finding R6-02 (NEW, design question for the owner) — photos are CUTOVER-warmed, not FINALE-prewarmed · DESIGN · WITHDRAWN (superseded by R6-04/ADR 0013 — photos are strictly downstream of authoring and cannot be warmed ahead of identities)
The owner said "the prewarmed identities **and photos** from the finale are important to keep." The implementation prewarms **identities** during the finale but generates **photos at the cutover** (Phase-2). So at the instant the new season opens, the cast data is ready but the **faces are still being generated** (a short window of placeholder portraits). If the intent is that the new season opens with faces *already* ready (truly instant, like the identities), that's an **enhancement**: fire the Phase-2 portrait warm during the finale too (alongside Phase-1), so both are held and adopted at cutover. Flagged for an owner ruling — not a bug against the current design.

### Finding R6-03 — "photos must match prewarmed identities": invariant is robustly enforced, with ONE narrow pathological gap · LOW · SUPERSEDED by R6-04 → ADR 0013 (the timeout-shoot gap is now closed)
**Owner invariant (2026-06-21):** a cast photo must NEVER be generated before its identity is authored — photos must always match the prewarmed identities (a face fed before the text is written is inconsistent later). Verified the Phase-2 portrait warm (`orwell_prewarm.warm_portraits` + the authoring gates):
- **Enforced (the happy + failure paths):** each face waits on its **per-NPC authoring gate** (`npc_event(hid)`) — *"never before a character is authored."* `_on_done` fires on **success OR failure** and opens any NPC gate that never fired, so an un-authored NPC shoots from the **seeded floor** (the deterministic identity that exists) — still consistent. Phase-2 declines entirely if author-warm never started (`author-warm-not-started`). So the invariant holds across authored / per-NPC-fail / whole-cast-fail.
- **The one gap:** `_shoot_one` wraps `gate.wait()` in `asyncio.wait_for(..., timeout=_AUTHOR_WARM_TIMEOUT=15min)`; on timeout it **shoots the portrait anyway** (logging "re-shoot backstop covers a later store change"). This fires ONLY if the whole authoring **hangs indefinitely >15min** (never completing AND never hitting `_on_done`'s success-or-failure release) — at which point the face shoots from a mid-write store and can mismatch the later-written identity, relying on the re-shoot to reconcile. Pathological, but it is the single path that violates the absolute "always match" invariant.
- **Transition/prewarm specifically:** even safer — Phase-1 identity authoring runs across the whole finale before the cutover's Phase-2, so the 15-min timeout is very unlikely to fire.
- **Fix (only if the invariant must be absolute):** on timeout, do NOT shoot from the mid-write store — either shoot from the **seeded floor** (deterministic, consistent) or leave a placeholder and let the backfill/re-shoot land the matched face. Keeps liveness (a face still appears) without ever emitting one that contradicts the written identity. Low priority (narrow trigger); flagged because the owner stated the invariant as absolute.

### Finding R6-04 → FIXED (ADR 0013) — a cast photo requires a model-authored identity
**Owner ruling (2026-06-21):** *a photo should always have a model-authored NPC, otherwise no photo* — photos must always match the prewarmed identities; a face fed before its identity is written is inconsistent with the text later. This **overturns** my prior "✓ still consistent" read of the seeded-floor fallback (the seeded floor is NOT an authored identity). Two paths violated it: `_on_done`'s force-open of un-fired per-NPC gates (shot un-authored NPCs from the seeded floor) and the `_shoot_one` timeout-shoot. **Fixed** (`frontend/src/orwell_prewarm.py`): a face shoots iff its own per-NPC authoring gate fired; `_on_done` releases only the whole-cast gate; the timeout never shoots; the portrait backfill fills a late-authored NPC. Documented as **ADR `docs/decisions/0013`** (renumbered from a 0012 collision with the parallel two-window-mirror ADR); gate `tests/test_adr0013_photo_requires_authoring.py` + the updated `test_0065_cast_prewarm.py` (the old "whole-cast fallback shoots an unauthored NPC" test is replaced by its inverse). Supersedes R6-03 (the narrow timeout gap is now closed by the same change). The earlier R6-02 "finale-prewarm the photos" suggestion is **withdrawn** — photos are strictly downstream of authoring and cannot be warmed ahead of identities.

### R4-01 + R3-01 — LIVE real-LLM re-verification (post-fix) · VERIFIED ✓
Rebuilt the engine (with the merged R3-01 prompt change) + rebooted the stack + real model (deepseek-v4-pro). Fast-forwarded a fresh game to the finale threshold (the exact point that STALLED pre-fix) and drove the finale through the FE with the real model (`journeys.py:j6_finale_verify`).
- **R4-01 ✓ (finale completes):** the jury vote read out one juror at a time to a crowned winner — `finished=true`, winner = the player, `moment=post-season`, week 14. The FE belt (now covering the `finale` phase) auto-advanced the ~staged reveal beat-by-beat; no stall. (Pre-fix: stuck at `jury-finale`, no winner.)
- **R3-01 ✓ (no reveal re-prompt):** the jury-vote reveal was NARRATED ("Brynn Chambers votes… Finale Verifier", "Iris Duran votes… Finale Verifier (2–0)", … "the house is yours") with ZERO re-prompts and no "we haven't reached the vote" loop; the model even self-corrected toward advancing. The automated detector's one hit (`"diary room"`/an `ask_user`) was a FALSE POSITIVE on the **legitimate final-eviction** decision ("Who do you evict tonight as the final HOH?") — a real pending, not a re-prompt of an already-cast vote. Wall held (Vault sealed; only the real public tally voiced, no invented margin).
Both season-transition fixes hold end-to-end with the live model.
