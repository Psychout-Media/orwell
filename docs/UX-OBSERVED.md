# UX-OBSERVED — living record of observed flow/interaction/visual behavior

Captured during the UX refactor audit. This documents experience behavior the design docs do NOT cover, so it can feed back into the audit baseline. Append-only; persists across `/compact`.

## Baseline (synthesized from design docs, Phase 0)

- **The game is the main chat.** No separate game page; onboarding + in-character play happen in the real chat app (`frontend/INTEGRATION.md`). Character creation is a **casting interview in the chat** (feature 0050), not a form.
- **Vault Wall:** the player never sees stats, threat reads, off-screen scheming, NPC emotions, relationship numbers, confessionals, hidden twists, jury leans. They infer standing from witnessed events, surfaced facts, overheard fragments, and behavior.
- **MVP-002 / feature 0022 (rich game UI: house view, houseguest cards, browsable journal, competition visuals) was REMOVED (2026-06-28 PO review).** Per ADR 0003 the chat is the UI; any companion surface is read-only, never a control panel. The included visual scope is: in-character portraits (0051), house themes (0052), the status/presence/cast/finale/retrospective HUD panels, ceremonies/reveals as paced experiences, and the `.ow-*` windowing kit.
- **Critical journeys:** (J1) first launch / zero-data / settings; (J2) casting interview → premiere → meeting houseguests; (J3) core weekly loop (linger, talk, live narration, consequence, reveals, competitions); (J4) nomination → veto → vote → eviction → finale/jury → retrospective/unsealing → new season; plus empty/loading/error states.

## Surface map (Phase 0)

- **Boot:** `GET /` serves `static/index.html`; `<body data-game-build>`; `#app-loader` wave spinner; gates on `GET /api/orwell/state` (no game → onboarding overlay) and engine health (engine down → "The house is dark" holding card).
- **Game panels (`.ow-*` window kit, slot-anchored):** `#orwell-status` (ceremony HUD), `#orwell-presence` (whereabouts), `#orwell-cast` (roster) + `#orwell-cast-pin`, `#orwell-finale`, `#orwell-decision-card`, `#orwell-retro`, `#orwell-new-season`, `#orwell-season-progress` (bottom bar), `#minimized-dock`, `#gadget-rail-body`.
- **Refresh seam:** `window` event `orwell:gamechanged` (single debounced dispatcher `orwellGameChanged()` in `platform.js`); panels poll 15–45s and listen for it.
- **Tokens:** colors `--bg/--fg/--panel/--border/--red`; type `--fs-2xs`(~11px floor)…`--fs-xl`; spacing `--space-1..6`; frame `--win-*`; breakpoints 480/768/1024/1440 (container 360/620); `--tap-min:44px`; safe-area insets.

---

## Observed behavior log (filled during capture)

<!-- Append observations here as journeys are walked. Format:
### [Journey] — <date>
- Observation (with frame/window/device/timestamp evidence)
-->
