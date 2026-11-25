# 0054 — The control-room gadget rail (right-side HUD + dockable game windows)

**Status:** **Phase 1 BUILT (2026-06-18)** — the right-side collapsible HUD rail ships: the
status / "wants a word" / "where you are" gadgets now mount into `#gadget-rail-body` (sidebar
fallback preserved), with a collapse→icon-strip toggle, a **side-swap** toggle (flex `order`),
a **mobile slide-over drawer** (768px token) with a floating opener, game-build + game-active
gating, and persisted collapse/side state (`orwellGadgetRail.js`). Browser-verified desktop +
mobile. **Phase 2 (built since; see the index row):** docking the finale / cast / retrospective windows INTO the rail
(they still float via the Lane-F kit), and per-gadget icons in the collapsed strip.
**Owner ruling:** product owner, 2026-06-18 (described twice in session). Built as its own
low-blast-radius PR.

## Why

The live house-state HUD ("status", "Wants a word", "Where you are") is genuinely useful, but
stacking every gadget into the **left** `#sidebar` (the chat/session chrome) gets crowded fast.
Give the gadgets their own home: a **collapsible right-side rail** with an **icon strip**, leaving
the left sidebar for navigation/sessions.

## The design (decisions locked)

1. **A second, right-side rail** — an icon strip (collapsed) that expands to show gadget panels.
   Collapsed = just icons; expanded = the HUD gadgets. Persists open/closed per user.
2. **HUD gadgets live here:** current house state (week/phase/HOH/noms/veto — Vault-free
   projection only), "Wants a word" (social initiatives), "Where you are" (whereabouts/presence).
   These move OUT of the left `#sidebar` chrome into the right rail.
3. **In-game window popups dock here too.** Surfaces that today open as floating windows — the
   **finale** (`orwellFinale.js`), the **cast** reference (`orwellCast.js`), the retrospective —
   become **docked panels in the right rail**, not free-floating windows. (Reduces the windowing
   surface the Lane-F kit has to manage; the kit still owns any genuinely-floating window.)
4. **Side-swap toggle.** The user can swap which side the gadget rail vs. the nav sidebar sit on.
   A single setting; both rails read it.
5. **Mobile = one drawer.** On narrow (`isNarrow()`), the two rails collapse into **one** bottom/
   side drawer with a segmented control (Nav | Gadgets), or an icon-tab strip. No two rails on
   mobile. The HUD must never cover the composer or chat (the F1/F6 clearance rules still hold).

## Conflicts to resolve (the real work)

- **Two sidebars coexisting:** layout grid must account for both rails + chat; `--composer-clearance`
  and the slot system (`orwellSlots.js`) must reckon with a right rail. No overlap with chat/composer.
- **Side-swap:** a CSS-var/`data-` attribute on `<body>` that both rails + the layout grid honour;
  no hard-coded left/right in gadget CSS.
- **Mobile collapse:** the drawer host owns position; gadgets compose it the way Lane F sheets do.
- **Finale/cast relocation:** these panels currently compose the Lane-F window kit; docking them in
  the rail means a "docked" render mode for the kit (or a rail host that adopts the panel body).
  Keep ONE position system (no regression of F5's dual-persistence era).
- **Game-build only:** the rail is part of the game surface (`data-game-build`); the full inherited
  workspace must be unaffected when `ORWELL_GAME_BUILD=0`.

## Testability (gates to add when built)

- Responsive matrix (`frontend/scripts/responsive_matrix.py`): right rail × {1440, 375} — no
  overflow/overlap, tap targets ≥ the min, HUD never covers composer/chat.
- Browser smoke: rail collapse/expand, side-swap persists, finale/cast render docked (not floating),
  mobile single-drawer segmented control.
- Vault-Wall: the HUD reads only Vault-free projections (same guard as the existing gadgets).
- Refresh-persistence: rail open/closed + side-swap + active gadget survive reload (ties to the
  reload-hardening lane).
