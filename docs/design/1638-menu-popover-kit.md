# 1638 — The menu / popover kit (`OrwellMenu` + `OrwellPopover`)

> 📐 **Build-ready design spec** · 2026-07-15 · for **Workflow 2 / lane W10** of the #1638
> total-kit migration (`docs/audits/2026-07-15-total-kit-migration-inventory.md` §8, the
> "menus/popovers" ruling cluster / **KM-W10**). This is a DESIGN doc — it introduces a new shared
> kit primitive so the ~14 bespoke dropdown/menu/popover surfaces stop each re-inventing anchoring,
> dismissal, keyboard nav, and a11y. It is the direct sibling of the window kit
> (`orwellWindow.js`) and the sheet kit (`orwellSheet.js`) and reuses their tokens, their Escape
> arbiter seat, and their #893 mobile-sheet philosophy.
>
> **Read first:** `orwellWindow.js` (kit shape, modal stack, `ensureCss`, clamp, focus-return),
> `orwellSheet.js` (detents, `anchored` non-modal action-sheet, focus-trap), `escMenuStack.js` (the
> transient-menu dismiss registry the Escape arbiter already drives), and the §8 ledger row.

---

## 0. Why this primitive (the problem in one paragraph)

There is **no shared menu/popover primitive**. Every dropdown re-implements the same four things
badly and inconsistently: (1) **anchored positioning** — each consumer rolls its own
`getBoundingClientRect()` + hand-written flip/clamp (or relies on CSS `top:calc(100%+Npx)` with no
viewport flip at all); (2) **dismissal** — only *three* surfaces use the shared `escMenuStack`
registry (`chatRenderer.js`'s `msg-overflow-menu`/`ctx-popup` via `bindMenuDismiss`); the rest wire
**ad-hoc document-`click` + `keydown` capture listeners** (model picker, emoji picker, color picker)
or a **global `.dropdown` display sweep** (sessions); (3) **keyboard nav** — at best a
`.kb-active` *highlight class* (model picker) with **no roving tabindex, no focus movement**; most
have **none**; (4) **a11y** — **no** `role="menu"`/`menuitem`, **no** `aria-expanded` on any trigger,
**no** focus trap, **no** focus-return. The z-index tiers are a zoo (100 / 250 / 300 / 1000 / 10000).
None reflow to a mobile sheet (#893) except the session-row menu's one bespoke "Cancel" item.

The kit collapses all of that into **one** anchoring engine, **one** dismiss seat, **one** roving
keyboard contract, and **one** a11y contract — exactly as `OrwellWindow` did for windows. (A shared
mobile bottom-sheet path is designed but **deferred** — per the owner ruling menus stay anchored on (ORW-887)
mobile in Workflow-2; see §2.3.)

---

## 1. Consumer inventory

`file:line` verified against current source. **Dismiss** column: `escMenuStack` = uses the shared
registry (`bindMenuDismiss`/`registerMenuDismiss`); `ad-hoc` = its own document listeners; `sweep` =
`document.querySelectorAll('.dropdown').forEach(d => d.style.display='none')`. **Target** column:
`Menu` = the `OrwellMenu` item-model path; `Popover` = the lower-level `OrwellPopover` (rich custom
content); `ruling` / `keep` per §6.

| # | Surface | file:line | Trigger | Current classes | Positioning | Dismiss | a11y today | Target |
|---|---|---|---|---|---|---|---|---|
| 1 | **Model-picker menu** | `index.html:1352`; built/wired `modelPicker.js:258–748` | `#model-picker-btn` (composer, `title` only) | `.model-picker-menu` + `.model-picker-list` / `.model-switch-item` rows w/ `.mp-fav-dot`, sections, provider logos, stale badges | CSS `position:absolute; bottom:calc(100%+16px); right:0` — opens **UPWARD**; z **300** | **ad-hoc** doc-`click` (`:743`) + `keydown` capture Escape; `.closing` anim | `tabindex=-1` on menu; `.kb-active` roving *highlight* (no tabindex); `_handlePickerKeydown` ↑/↓/Enter/Esc (`:55`); **no** `role=menu`, **no** `aria-expanded` | **Popover** (rich rows) |
| 2 | **Composer overflow menu** | `index.html:1374`, items `:1375,1385` | `#overflow-plus-btn` (`aria-haspopup="true"`) | `.overflow-menu` + `.overflow-menu-item` (staggered item anim) | CSS `absolute` in `.overflow-wrapper`; z **1000** | ad-hoc (app.js) | `aria-haspopup` on trigger only; **no** `role=menu`, **no** `aria-expanded` | **Menu** |
| 3 | **Session-sort dropdown** | `index.html:1068`, items `.dropdown-item.sort-option` | `#session-sort-btn` | `.dropdown.sort-dropdown` + `.dropdown-item` (+ nested Tidy/Rearrange/Select rows w/ inline styles) | CSS `absolute; top:calc(100%+6px); right:0`; z **1000** | ad-hoc / `sweep` | none | **Menu** (mixed rows — see §6) |
| 4 | **Session-actions dropdown** (hidden, shared) | `index.html:1102` | opened programmatically | `.dropdown` + `.dropdown-item` (with `<h4>`/`<p>`) | CSS `absolute` | `sweep` | none | **Menu** |
| 5 | **Model-sort dropdown** | `index.html:1144` | `#model-sort-btn` | `.dropdown.sort-dropdown` | CSS `absolute` | ad-hoc / `sweep` | none | **Menu** |
| 6 | **Session-row actions** (per row) | built `sessions.js:494–654`, toggle `:629` | per-row `.session-menu-btn` (`.hamburger`) | `.dropdown.session-dropdown.session-dropdown-menu` + `.dropdown-item-compact` (+ `.dropdown-item-danger`, `.dropdown-shortcut`, mobile `.dropdown-cancel-mobile`) | **JS fixed-coord** `getBoundingClientRect` (`:640`), **manual flip-above** (`:648`), right-align; z **1000** | `sweep` at open (`:632`) + document outside-click; **no** Escape registry | none | **Menu** |
| 7 | **Session folder submenu** | built `sessions.js:205`, toggle `:262` | `.dropdown-item-compact` "Move to folder" | `.dropdown.session-folder-submenu` | **JS fixed-coord** off parent item (`:267`); z **1001** | rides parent dropdown | none | **Menu (submenu)** |
| 8 | **Archive-row dropdown** | `sessions.js:2444` | archive row menu btn | `.dropdown.session-dropdown-menu.archive-dd` | JS fixed-coord | `sweep` | none | **Menu** |
| 9 | **Search / admin provider menu** | `index.html:2037` (search) / `:2448` (adm); items built in `settings.js`/`admin.js` | `.adm-provider-btn` (`#search-provider-btn`) | `.adm-provider-menu` + `.adm-provider-item` (logos, `.active`) | CSS `absolute; top:calc(100%+4px); left:0; right:0`; z **100**; caret rotate via `:has()` | ad-hoc | `.active` item; caret `:has()`; **no** `role=menu`, **no** `aria-expanded` | **Popover** (logo rows) or **Menu** w/ icons — §6 |
| 10 | **Message overflow menu** | built `chatRenderer.js:1495` & `:1693` | per-message `.msg-more-btn` (···) | `.msg-overflow-menu` + `.msg-overflow-item` | **JS fixed-coord**, flip-down-if-above (`:1519`), right-edge clamp (`:1522`); z **100** | ✅ **`escMenuStack`** (`bindMenuDismiss` `:1525`) | buttons; **no** `role=menu` | **Menu** |
| 11 | **Emoji picker** | built `emojiPicker.js:211`, toggle `:135` | anchor button (`.emoji-picker-btn`) | `.emoji-picker` (search + `.emoji-picker-grid` of `.emoji-picker-item`) | **JS fixed-coord** `anchor.getBoundingClientRect` (`:157`), down-only, horiz-flip (`:165`), height-cap (`:171`); z **10000** | **ad-hoc** doc-`click` + Escape capture; ghost-click guard | search input + item buttons; **no** roles | **Popover** (search + grid) |
| 12 | **Color picker** | built `colorPicker.js:98` | color swatch/input | `.cp-popover` (HSV plane, hue, hex, swatches) | JS-positioned | ad-hoc | HSV drags; **no** roles | **Popover** (or keep — §6) |
| 13 | **Message context popups** | `chatRenderer.js:687,1807` (`.ctx-popup`), `:1885` (`.ctx-detail-popup`) | metric pill / role cluster | `.ctx-popup`, `.ctx-detail-popup` | JS fixed-coord | ✅ **`escMenuStack`** (`bindMenuDismiss` `:746,1846,1987`) | informational | **Popover** (info, low-pri) or **keep** |
| 14 | **Search overlay (Ctrl+K)** | `index.html:2730` (`.search-overlay`) + `.search-popup`; `search-chat.js:13/27` | Ctrl+K / search entry | `.search-overlay` (full-viewport scrim) + `.search-popup` (centered) | **fixed centered** (NOT anchored); z **300**; `backdrop-filter` | own Escape handler; `selectedIndex` roving | input + results list | **ruling** (palette — §6; likely a **modal window**, not a menu) |
| — | *Related:* **Chat-header export popover** | `.export-dropdown-menu` + `.export-dropdown-item` (folded onto light glass by #738 item 5) | header ··· | Rename/Copy/PDF | CSS `absolute`; z **300** | ad-hoc (`.open` toggle) | none | **Menu** (fold in with the others) |
| — | *Keep as-is:* **Slash autocomplete** | `slashAutocomplete.js:107` (`.slash-autocomplete-popup`) | inline `/` typeahead | — | JS | inline | typeahead | **ACCEPTED-GAP** (inline typeahead, not a menu) |

**Count: 14 popover surfaces** (the §8 ledger count) — of which **~9 are true action menus**
(2–8, 10, export), **~4 are rich anchored popovers** (1 model-picker, 9 provider, 11 emoji, 12
color), **1 is an info popover** (13), and **1 is a command palette** (14, ruling). Slash-autocomplete
stays an accepted gap.

### 1a. The common shape every consumer duplicates

- **Anchor** — a trigger `<button>`; the surface opens beside it.
- **Position** — below the anchor, right- or left-aligned; **flip** above when it would overflow the
  bottom; **shift** inward when it would overflow the right edge. (Every consumer hand-codes some
  subset of this; the model picker prefers *up*, everyone else *down*.)
- **Dismiss** — outside-click, Escape, and item-activation all close it; a second click on the
  trigger toggles.
- **Content** — either a flat list of action rows (`.dropdown-item*` / `.overflow-menu-item` /
  `.adm-provider-item`) OR rich custom content (model rows w/ favorite dots, an emoji grid, an HSV
  plane).

The kit owns the first three for **everyone**; the fourth splits into `OrwellMenu` (list) vs
`OrwellPopover` (custom).

---

## 2. Proposed API

Two layers, mirroring `OrwellWindow` (base surface) + its `modal` option, and shipped as **one
file** `frontend/static/js/orwellMenu.js` exposing **two seams** on `window`:

- **`OrwellPopover`** — the base **anchored-surface** primitive. Owns positioning (flip/shift),
  dismissal (outside-click + Escape via `escMenuStack`), optional focus-trap + focus-return, the
  z-layer, and teardown (the mobile bottom-sheet handoff is **deferred**, §2.3 — anchored on mobile in (ORW-887)
  W2). Content is arbitrary (Node|string|builder). **Serves the rich pickers** (emoji, color,
  model-picker, provider) and info popovers.
- **`OrwellMenu`** — built **on** `OrwellPopover`; adds the item model, `role="menu"/"menuitem"`,
  roving-tabindex keyboard nav (↑/↓/Home/End/typeahead/Enter/Esc/→←-for-submenus), separators,
  danger/disabled/checkbox items, submenus, and `aria-expanded`/`aria-haspopup` wiring on the trigger.
  **Serves every true action menu.**

This is the same relationship as `OrwellWindow` ⊃ `modal`, and `OrwellSheet` (sibling). The Escape
arbiter in `ui.js` **already** calls `dismissTopMenu()` (escMenuStack) *first*, before windows,
sheets, and modals (`ui.js:1260`) — so a menu opened over Settings dismisses before Settings does,
for free, the moment the kit registers through `escMenuStack`.

### 2.1 `OrwellPopover` — the base surface

```js
// window.OrwellPopoverKit — API surface: .open(opts) → an OrwellPopover instance (opened);
//   .closeAll(); .openCount()  — bulk/introspection for gates. (NO .attach — that declarative
//   trigger-wiring helper is OrwellMenu-only, since it needs an item model. See §2.2 for the
//   exact per-kit method matrix the test plan pins.)
OrwellPopoverKit.open({
  id,                        // stable id (one live instance per id; re-open closes the prior)
  anchor,                    // REQUIRED: the trigger Element the surface positions against
  content,                  // Node | string | (popover) => Node   — mounted into .ow-popover
  placement: 'bottom',      // 'bottom' | 'top' | 'auto'  — preferred side (auto = most room)
  align: 'start',           // 'start' | 'end' | 'center' — cross-axis edge to the anchor
  offset: 6,                // px gap between anchor and surface
  matchAnchorWidth: false,  // stretch surface to the anchor's width (provider menu wants true)
  minWidth: 180, maxWidth,  // clamp; maxHeight defaults to viewport-fit w/ internal scroll
  focusTrap: false,         // trap Tab inside (pickers w/ inputs → true; plain menus manage focus)
  returnFocus: true,        // restore focus to `anchor` (or document.activeElement) on close
  sheetOnNarrow: false,     // DEFERRED / out of Workflow-2 scope (owner ruling below): menus stay
                            //   ANCHORED on mobile. The option is reserved for a future flagged sheet
                            //   mode — in W2 it is a no-op and the surface anchors on every viewport.
  role: 'dialog',           // ARIA role (OrwellMenu overrides to 'menu'; 'listbox' for the model picker)
  ariaLabel,                // REQUIRED when role === 'dialog' (a dialog surface MUST have an accessible
                            //   name, or callers create an unnamed dialog); optional only for roles that
                            //   name themselves (a 'menu'/'listbox' named via aria-labelledby/its items)
  className,                // extra class(es) on .ow-popover (e.g. 'ow-popover-emoji')
  dismissOnScroll: true,    // policy: REPOSITION on scroll while the anchor stays in view; CLOSE only
                            //   when the anchor scrolls OUT of the viewport (not on every scroll event).
                            //   See positioning-engine step 5 + the browser assertion in §5.4.
  onKeydown,                // optional (ev, popover)=>bool — the real keyboard seam for custom
                            //   listbox/roving content (the model picker wires _handlePickerKeydown
                            //   here). OrwellPopover does NOT provide roving nav itself — that lives in
                            //   OrwellMenu; a listbox consumer either wires onKeydown or uses OrwellMenu.
  onOpen, onClose,          // lifecycle hooks
});
// instance: .close(reason), .reposition(), .isOpen(), .el, .setContent(node)
```

**Positioning engine (the single flip/shift algorithm — replaces every bespoke variant):**

1. Read `anchor.getBoundingClientRect()` and the surface's natural size (mount hidden/off-screen
   first, exactly like `sessions.js:644` does today).
2. **Main axis (`placement`)**: try preferred side; if the surface would overflow that viewport
   edge **and** the opposite side has more room, **flip**. `'auto'` picks the side with more room
   outright. (Preserves the model picker's "prefer up" as `placement:'top'` — it still flips down
   near the top edge, matching today's implicit behavior.)
3. **Cross axis (`align`)**: `start` aligns the surface's leading edge to the anchor's; `end` to the
   trailing edge; then **shift** the whole surface inward so it never crosses the viewport margin
   (the `mr.right > innerWidth-8` clamp every consumer hand-codes).
4. **Fit**: cap `max-height` to the available space and let the body scroll internally (never let a
   menu run off the bottom — the emoji picker's `:171` height-cap generalized).
5. Uses `position: fixed` + viewport coords (the `session-dropdown-menu` model), so the surface is
   robust to scrolled/overflow-clipped ancestors. On `resize`/`scroll` (rAF-debounced) it
   **repositions** via `.reposition()` **while the anchor stays in view**; with `dismissOnScroll:true`
   it **closes** only when the anchor scrolls **out of the viewport** (its rect leaves the visible
   area) — not on every scroll tick. This is the exact behaviour §5.4's scroll assertion pins.

**Dismissal (one seat):** on open, register through `escMenuStack.bindMenuDismiss(el, onClose,
isOutside)` — this wires **both** the deferred outside-click listener **and** the Escape stack entry
in one call, and stashes the idempotent `close()` on `el._dismiss` so bulk removers cooperate. The
`isOutside` predicate treats the **anchor** as "inside" so the trigger's own click toggles rather
than double-fires (the `msg-overflow-menu` pattern, `chatRenderer.js:1525`). **No consumer writes its
own `document.addEventListener('click', …, true)` again.**

**Focus & return:** `returnFocus` restores focus to the opener on close (the window kit's `opener`
contract, `orwellWindow.js:749` / `_owReturnFocus`). `focusTrap:true` traps Tab inside (reuse the
sheet kit's trap, `orwellSheet.js:462`) for pickers that contain inputs.

### 2.2 `OrwellMenu` — the action-menu layer

```js
// window.OrwellMenuKit — API surface (the full matrix the test plan pins):
//   .open(opts) → opens an anchored role=menu, returns the instance;
//   .attach(triggerEl, buildItems) → declarative helper: wires the trigger's click to open/close the
//     menu and keeps aria-expanded/aria-haspopup in sync (buildItems = a static array OR a
//     () => items[] fn re-evaluated on each open — session/model menus rebuild);
//   .closeAll(); .openCount() → shared bulk/introspection (delegate to the OrwellPopover registry).
// So the matrix is: OrwellPopoverKit = {open, closeAll, openCount};
//                   OrwellMenuKit    = {open, attach, closeAll, openCount}   (.attach is Menu-only).
OrwellMenuKit.open({
  anchor,                  // REQUIRED trigger (also gets aria-haspopup='menu' + aria-expanded)
  items,                   // REQUIRED: the item model (below)
  placement, align, offset, matchAnchorWidth,   // passed through to OrwellPopover (sheetOnNarrow is
                           //   DEFERRED — anchored on mobile per the owner ruling; see §2.3)
  role: 'menu',            // 'menu' (default) | 'listbox' — a listbox consumer (the MODEL PICKER) sets
                           //   'listbox'; then items render role=option, selection is aria-selected
                           //   (not activation), and the kit's roving nav drives ↑/↓/Home/End/typeahead.
                           //   This is the a11y-correct home for the picker's key handling — NOT an
                           //   undefined OrwellPopover onKey hook.
  ariaLabel,
  onSelect(item),          // optional global select hook (in addition to per-item onSelect)
});

// The item model — a flat array; the kit renders + wires each:
items = [
  { id, label, icon,           // icon: SVG string | Node — rendered in the leading .ow-menu-icon
    onSelect(item, ev),        // fired on click/Enter/Space; menu auto-closes unless returns false
    danger: false,            // destructive styling (→ .ow-menu-item-danger, was .dropdown-item-danger)
    disabled: false,          // a disabled item is NON-INTERACTIVE on EVERY path: it cannot take roving
                              //   focus (skipped by ↑/↓/Home/End + typeahead), and pointer, Enter/Space,
                              //   submenu-open, and typeahead can NEVER invoke its onSelect — it only
                              //   carries aria-disabled='true' + dimmed styling.
    checked,                  // tri-state: true/false renders a checkmark (role=menuitemcheckbox)
    shortcut,                 // right-aligned hint text (was .dropdown-shortcut) — hidden on coarse
    description,              // OPTIONAL second line → rendered as .ow-menu-item-sub (the session-
                              //   actions two-line rows). Omit for single-line items; consumers needing
                              //   richer layout use `render:` instead.
    submenu: () => items[],   // nested menu (the folder submenu) → role=menu on →/click, ←/Esc back
    keepOpen: false,          // don't auto-close after select (Rearrange toggle, Favorite dot)
    render: (el) => {…},      // ESCAPE HATCH: custom row content (sort's inline Tidy row, logos)
  },
  { separator: true },       // → .ow-menu-sep (was the inline 1px sep div)
  { label: 'Section', header: true },  // → .ow-menu-label (non-interactive section head)
];
```

**Keyboard contract (roving tabindex — the real thing, not a highlight class):** on open, the
surface takes focus and the **first enabled item** gets `tabindex=0` (all others `-1`). The
container listens for:

- **↓ / ↑** — move active item (roving: move `tabindex=0` + `.focus()`), wrapping at ends.
- **Home / End** — first / last enabled item.
- **Typeahead** — printable keys jump to the next item whose label starts with the typed buffer
  (250ms reset) — the standard menu behavior none of the current menus have.
- **Enter / Space** — activate the active item.
- **→** — open a `submenu` item; **← / Esc** — close the submenu (or the whole menu at top level).
- **Esc** — close (already routed through `escMenuStack`; returns focus to the trigger).
- **Tab** — closes the menu and lets focus proceed (menus are not focus-trapped by default; ARIA
  APG menu-button pattern). Pickers that opt into `focusTrap` are the exception.
- **Disabled items** — never take roving focus and can't be activated by any path: ↓/↑/Home/End and
  typeahead **skip** them, and pointer / Enter/Space / submenu-open are inert on them (they carry only
  `aria-disabled='true'` + dimmed styling).

**ARIA wiring (uniform, replacing the current near-total absence):**

- surface: `role="menu"`, `aria-label`, `aria-orientation="vertical"`. **Listbox variant
  (`role:'listbox'`, the model picker):** surface `role="listbox"`, rows `role="option"` with
  `aria-selected` — selection, not activation, and the kit's roving nav drives it.
- items: `role="menuitem"` (or `menuitemcheckbox` when `checked` is defined); `aria-disabled`,
  `aria-checked`; a submenu parent gets `aria-haspopup="menu"` + `aria-expanded`.
- **trigger**: `OrwellMenuKit` sets `aria-haspopup="menu"` and toggles `aria-expanded="true|false"`
  on the anchor automatically (today only the overflow `+` sets `aria-haspopup`, and **nothing** sets
  `aria-expanded`).

### 2.3 Mobile presentation — ANCHORED (the bottom-sheet handoff is DEFERRED) (ORW-887)

**Owner ruling (below): menus stay ANCHORED on mobile — there is NO bottom-sheet reflow in
Workflow-2.** On ≤768px the surface presents as the **same anchored `.ow-popover`** as desktop
(viewport-clamped, internal scroll); `sheetOnNarrow` is a no-op in W2, and the Ctrl+K palette is
excluded from this kit entirely (it stays a centered modal).

The rest of this section documents the **deferred** sheet handoff for a *future flagged mode only*
(it is NOT built in this lane). If it is ever enabled, a menu/popover would (ORW-887)
**delegate to `OrwellSheetKit.create()`** rather than anchoring — an iOS-style **action sheet**:

- `OrwellMenu` → a **modal** `OrwellSheet` (`anchored:false`) whose body renders the same items as
  full-width, 44px-tall rows (danger items tinted, a section header as the sheet title). Scrim +
  focus-trap + swipe-to-dismiss + `Escape` all come from the sheet kit. This *generalizes* the
  session-row menu's lone bespoke mobile "Cancel" item into the standard sheet dismiss.
- `OrwellPopover` (emoji/color/model pickers) → the same `OrwellSheet`, content mounted in the sheet
  body (the emoji grid / HSV plane get real room on a phone instead of a clipped 10000-z overlay).
- The detent fractions and gesture language are the **shared pin** already held between
  `orwellSheet.js` `DETENT_FRACTION` and `orwellWindow.js` `sheetDetentPx()` (#1378) — the menu kit
  **must not** mint its own; it calls the sheet kit, which owns them. This keeps us clear of
  **F-CHROME-1 II** (never a second window/sheet family) exactly as `orwellWindow.js`'s sheet mode
  does.

(When/if that flagged mode ships, `sheetOnNarrow:true` would sheet a surface and `false` keeps it
anchored. **In Workflow-2 every surface stays anchored regardless** — the ruling holds.)

---

## 3. CSS contract

New family in `style.css`, injected-fallback in `orwellMenu.js`'s `ensureCss()` (the kit pattern:
literal fallbacks for pre-stylesheet load, the linked sheet carries the same rules — see
`orwellWindow.js:183` / `orwellSheet.js:82`). **Built by string concatenation, never a backtick
template** (the notice-kit footgun the sheet kit documents).

### 3.1 Selectors

```css
.ow-popover            /* the base anchored surface (position:fixed, the frame + shadow + glass)   */
.ow-menu               /* .ow-popover specialized for a role=menu list (padding, item flow)        */
.ow-menu-item          /* a role=menuitem row  (was .dropdown-item / .overflow-menu-item / …)       */
.ow-menu-item-danger   /* destructive tint     (was .dropdown-item-danger)                          */
.ow-menu-item[aria-disabled='true']   /* dimmed, non-interactive                                    */
.ow-menu-item.ow-active               /* roving-focus / hover highlight                             */
.ow-menu-icon          /* leading icon slot    (was .dropdown-icon / .menu-icon / .overflow-icon)   */
.ow-menu-label         /* trailing text label                                                       */
.ow-menu-item-sub      /* optional 2nd-line description under an item (item.description; was the       */
                       /* session-actions .menu-text <p>) — muted, smaller than the label            */
.ow-menu-shortcut      /* right-aligned key hint (was .dropdown-shortcut)                            */
.ow-menu-check         /* leading checkmark for menuitemcheckbox                                     */
.ow-menu-sep           /* 1px divider          (was the inline-styled sep div / .dropdown-divider)   */
.ow-menu-section       /* non-interactive section header (was inline .mp-section-label)             */
.ow-menu-submenu-caret /* trailing ▸ on a submenu parent                                            */
```

### 3.2 Tokens (reuse the window/sheet families — one visual language)

The surface frame reuses the **same `--win-*` tokens** the window kit and legacy modals consume, so
menus paint the same glass and the 0052 house themes hit them for free:

```css
background: var(--win-bg, var(--panel));            /* :root --win-bg = var(--panel)  (style.css:190) */
color:      var(--fg);
border:     1px solid var(--win-border, var(--border));
border-radius: var(--ow-menu-radius, 10px);         /* menus are tighter than windows' --win-radius   */
box-shadow: var(--win-shadow, 0 8px 32px rgba(0,0,0,.45));
font-family: var(--ow-ui-font);                     /* the shared sans stack (style.css:25)            */
font-size:  var(--ow-fs-body, .875rem);
```

Focus ring: the kit's neutral **iOS-blue** ring (`outline: 2px solid var(--ow-ios-blue, #0a84ff)`,
`style.css:21573`) on `.ow-menu-item.ow-active:focus-visible` and the surface body — **never** the
theme red/accent (the #729 rule the window kit holds: glass chrome carries no accent hue). Hover
uses `color-mix(in srgb, var(--fg) 8%, transparent)` (the neutral wash the `.adm-provider-item`
already uses); danger rows use `var(--red)`.

### 3.3 Theme / tier behaviour (frosted glass / glass / flat)

Mirror the #738 item-5 fold: under `body.theme-frosted` the surface rides the **shared light-glass
material** so it is not a dark opaque box in the light theme:

```css
@media (prefers-reduced-transparency: no-preference) {
  body.theme-frosted .ow-popover {
    background-color: var(--ow-glass-light-color, rgba(255,255,255,.6));   /* style.css:20385 */
    -webkit-backdrop-filter: blur(18px) saturate(180%); backdrop-filter: blur(18px) saturate(180%);
    color: #16191f;
  }
}
@media (prefers-reduced-transparency: reduce) { .ow-popover { backdrop-filter: none !important;
    background: var(--win-bg) !important; } }               /* a11y: opaque fill                       */
@media (prefers-contrast: more), (forced-colors: active) { .ow-popover { border-color: var(--fg) !important;
    border-width: 2px; } }                                  /* a11y: hard rim                          */
```

The **flat / Normal** tier is the literal fallback (`var(--panel)` fill, no blur) — the default
`--win-bg`. This is exactly the tri-tier story `.model-picker-menu`'s frosted override
(`style.css:3843`) and the sheet kit already tell; the menu kit centralizes it.

### 3.4 Z-index / layering

**One menu band, above the modal tier.** Menus must float above whatever opened them — a provider
menu opened *inside* the Settings modal (z 1001) must sit above it, and the Escape arbiter already
dismisses menus before modals. Define a single token:

```css
:root { --ow-z-menu: 1100; }        /* window band 500–980 < modal scrim/modal 1000/1001 < menus 1100 */
.ow-popover { z-index: var(--ow-z-menu, 1100); }
```

This replaces the current spread (adm-provider **100**, msg-overflow **100**, ctx **250**,
model-picker/search/export **300**, dropdown/overflow **1000**, emoji **10000**). (The *deferred* (ORW-887)
mobile-sheet path, §2.3, would use the sheet kit's own band — scrim 1200 / sheet 1201,
`orwellSheet.js` — but W2 anchors on mobile, so `--ow-z-menu` is the operative band.)

### 3.5 Tap targets & motion

- **Coarse-pointer floor:** `@media (pointer: coarse) { .ow-menu-item { min-height: 44px; } }`
  (WCAG 2.5.5 / HIG 44pt). The desktop density (~28–32px rows) is unchanged on fine pointers. Since
  menus stay **anchored** on mobile (no sheet, per the ruling), this floor is the **sole** guarantee
  of a 44px touch target — the anchored path must carry it. Shortcut hints hide on coarse
  (`.dropdown-shortcut` already does, `style.css:6828`).
- **Motion:** a single open keyframe (the `dropdown-in` scale+fade, `style.css:6738`) on
  `.ow-popover`, stripped under `@media (prefers-reduced-motion: reduce)` (kit rule). The staggered
  per-item entrance the overflow menu has today is **dropped** (decorative; not worth per-item CSS —
  owner may keep it as an opt-in `stagger:true`, §6).

---

## 4. Migration mapping (per consumer)

**All migration-only** (no behavior change beyond the intended a11y/keyboard uplift; anchored on
mobile — no bottom-sheet reflow, per the owner ruling). Each lane **deletes** the retired bespoke CSS
+ JS in the same PR (the F-2 wave discipline). Because
`style.css` is a shared write, W10 serializes after W1–W9 like the rest of the chain (audit §WAVE).

| Consumer | What changes | Retire |
|---|---|---|
| **2 Overflow menu** | Replace the static `#overflow-menu` markup + click wiring with `OrwellMenuKit.attach(#overflow-plus-btn, () => [ {id:'attach', label:'Attach files', icon, onSelect}, … ])`. The `+` already has `aria-haspopup`; the kit now also toggles `aria-expanded`. | `.overflow-menu*` CSS (incl. the 20 stagger rules) |
| **3 Session-sort · 5 Model-sort** | `OrwellMenuKit.attach(sortBtn, buildSortItems)`. The plain sort options → `{onSelect}` items; **Rearrange** → `{checked, keepOpen}`; **Select** → `{onSelect}`; the compound **Tidy** row (icon + split "more" button + spinners) → an item with `render:` (escape hatch) so its inline layout survives. | `.dropdown.sort-dropdown` CSS |
| **4 Session-actions (shared)** | The `<h4>/<p>` two-line items → `{label, description}` (add an optional `description` to the item model, rendered as `.ow-menu-item-sub`) or `render:`. Open via `OrwellMenuKit.open({anchor, items})` at the call site. | `.dropdown .dropdown-item .menu-text` CSS |
| **6 Session-row actions** | The biggest win: delete the hand-built `getBoundingClientRect`+flip block (`sessions.js:629–654`) and the `sweep`; call `OrwellMenuKit.open({anchor: menuBtn, items})` — Rename/Favorite/Copy/Select/Archive/Delete(danger)/folder-submenu as items. The mobile "Cancel" item is dropped (the mobile sheet's × / swipe replaces it). | `.session-dropdown-menu`, `.dropdown-cancel-mobile`, the JS position/sweep code |
| **7 Folder submenu** | Becomes a `submenu: () => folderItems` on the "Move to folder" item — the kit owns →/← nav, positioning, and (on mobile) pushes a second sheet. Delete the bespoke `sub` build + `:262` toggle. | `.session-folder-submenu` CSS |
| **8 Archive-row dropdown** | Same as #6 via `OrwellMenuKit.open`. | `.archive-dd` residual |
| **10 Message overflow menu** | Already uses `bindMenuDismiss`; swap the manual build + position (`chatRenderer.js:1495–1525`) for `OrwellMenuKit.open({anchor: moreBtn, items: overflow.map(a => ({label:a.title, icon:a.icon, onSelect:a.handler}))})`. Keep `_trackAction`. | `.msg-overflow-menu/-item` CSS |
| **export popover** | `OrwellMenuKit.attach(headerMoreBtn, [Rename, Copy, PDF])`. | `.export-dropdown-menu/-item` CSS |
| **1 Model picker** | **Listbox path (preferred): route through `OrwellMenuKit.open({anchor:#model-picker-btn, role:'listbox', placement:'top', items})`** — rows render `role=option` and the kit's roving nav (↑/↓/Home/End/typeahead, selection via `aria-selected`) drives them; a picker is a listbox, not a menu. If the rich bespoke rows (favorite dots, sections, logos, stale badges) must stay hand-built, use the **Popover path** instead — `OrwellPopoverKit.open({anchor:#model-picker-btn, placement:'top', focusTrap:false, ariaLabel:'Model picker', content: listEl})` and wire `_handlePickerKeydown` through the documented **`onKeydown`** hook (NOT an undefined `onKey`). Either way delete the ad-hoc doc-click/Escape (`:743`), the `.closing` hand-anim, and the bespoke position CSS; anchored on mobile (no sheet, per the ruling). | `.model-picker-menu` CSS + ad-hoc listeners |
| **9 Provider menu** | **Popover or Menu w/ icons.** The logo rows map cleanly to `{icon: logoSvg, label, checked}` menu items (`matchAnchorWidth:true` to keep the full-width look). Wire via `OrwellMenuKit.attach(#search-provider-btn, buildProviderItems)`; keep the hidden `<select>` mirror write in `onSelect`. The caret rotation moves to `aria-expanded`-driven CSS. | `.adm-provider-menu`/`-item` CSS (keep `.adm-provider-btn` per §7 button lane) |
| **11 Emoji picker** | **Popover path**: `OrwellPopoverKit.open({anchor, focusTrap:true, ariaLabel:'Emoji picker', content:_buildPicker()})` (anchored on mobile per the ruling — no sheet); delete `togglePicker`'s manual position + ad-hoc listeners + ghost-click guard (the kit's deferred-attach + 400ms open-guard cover it). Keep the search input + grid. | ad-hoc position/listeners; `.emoji-picker` frame CSS folds to `.ow-popover` |
| **12 Color picker** | **Popover path** (or keep, §6): `OrwellPopoverKit.open({anchor, focusTrap:true, ariaLabel:'Color picker', content:buildPopover()})` (dialog role ⇒ `ariaLabel` required). The HSV drags are internal. | ad-hoc listeners; `.cp-popover` frame folds to `.ow-popover` |
| **13 ctx-popup / detail** | **Popover (info), low-pri.** Already `bindMenuDismiss`; optionally re-home onto `.ow-popover` for one glass surface. Non-interactive → `role` stays informational (not `menu`). | optional |
| **14 Search overlay (Ctrl+K)** | **Ruling (§6).** It is a *centered modal palette*, not an anchored menu — recommend leaving it OR promoting to a **modal `OrwellWindow`** (`modal:true`, `sheet:'auto'`), NOT this kit. | n/a (ruling) |

**Note on the CSS-static consumers (2–5, 9, export):** they exist as hidden `<div>`s in `index.html`
today. The cleanest migration replaces that static markup with a **kit call built from an item
model** at the wiring site, so the markup + its bespoke CSS both delete. Where the inner content is
genuinely bespoke (the sort menu's Tidy row), the `render:` escape hatch keeps it without forcing it
into the item model.

---

## 5. Test plan

Mirrors `test_f_window_kit.py` (source-pin convention checks) + `test_0753_sheet_kit.py` +
`test_738_glass_menus_accent.py` (CSS glass pins) + the F-3 ratchet, plus browser assertions in
`browser_smoke.py`. New file **`frontend/tests/test_1638_menu_popover_kit.py`**.

### 5.1 Kit-contract source pins (pytest, no DOM)

- **Kit exists + seams (the exact per-kit method matrix):** `orwellMenu.js` present; exports
  `OrwellPopoverKit` on `window` with **`.open`/`.closeAll`/`.openCount`** (NO `.attach`), and
  `OrwellMenuKit` with **`.open`/`.attach`/`.closeAll`/`.openCount`** (`.attach` is Menu-only);
  `index.html` loads it (module script, before consumers). Assert the matrix explicitly per kit — do
  not assume `.attach` on the Popover.
- **Owns the contracts** (grep the kit source, à la `test_sourcepin_kit_owns_the_contracts`): the CSS
  selectors `ow-popover`, `ow-menu`, `ow-menu-item`, `ow-menu-item-sub`, `ow-menu-sep`; the anchoring
  engine (`getBoundingClientRect`, a flip branch, a shift/clamp branch); dismissal through
  **`escMenuStack`** (`bindMenuDismiss` or `registerMenuDismiss` imported — *not* a raw
  `document.addEventListener` `'click'` for dismissal); `role="menu"` + `role="menuitem"` +
  `aria-expanded` + `aria-haspopup`, **plus the `role:'listbox'` variant** (rows `role=option`,
  `aria-selected`) for the model picker; roving nav keys (`ArrowDown`, `ArrowUp`, `Home`, `End`,
  typeahead buffer); `prefers-reduced-motion`; `AbortController` teardown.
- **ariaLabel-for-dialog contract (C6):** when `role === 'dialog'` the kit **requires** `ariaLabel`
  (grep-assert the open path errors/warns on a dialog surface with no accessible name); a `menu`/
  `listbox` surface may name itself via items/`aria-labelledby`.
- **Disabled items are inert (C9):** the kit source shows a disabled item is skipped by roving focus
  and cannot fire `onSelect` via pointer, Enter/Space, submenu-open, or typeahead — only
  `aria-disabled='true'` + dimmed styling.
- **Anchored on mobile (the owner ruling):** assert the kit does **NOT** wire a narrow-sheet handoff —
  `OrwellSheetKit` is **not** referenced for a `sheetOnNarrow` reflow (the surface anchors on every
  viewport in W2). (This replaces the earlier "narrow-sheet handoff" pin, which contradicted the
  ruling.)
- **CSS family + tokens** (`style.css`): `.ow-menu`/`.ow-menu-item` blocks exist; consume `--win-bg`
  / `--win-shadow` / `--ow-ui-font`; the coarse-pointer 44px floor on `.ow-menu-item`; the
  `--ow-z-menu` token ≥ 1002 (above the modal tier); focus ring is `--ow-ios-blue` (assert no
  `var(--red)`/`var(--accent)` in the `.ow-menu-item:focus`/`.ow-active` rule — the #729 neutrality
  rule).
- **Glass fold** (à la `test_738`): a `.ow-popover` block under `body.theme-frosted` references
  `--ow-glass-light-color`; a `prefers-reduced-transparency: reduce` opaque override exists.
- **g15 silence:** the kit source never dispatches `orwell:gamechanged` / `new CustomEvent(` for it
  (menus don't mutate game state; the single dispatcher stays in `platform.js`).

### 5.2 Migration pins (per lane, à la `test_sourcepin_f5_… "no custom writer"`)

- The retired bespoke classes are **gone** from source: assert `style.css` no longer defines
  `.model-picker-menu`, `.overflow-menu`, `.dropdown.sort-dropdown`, `.session-dropdown-menu`,
  `.session-folder-submenu`, `.msg-overflow-menu`, `.adm-provider-menu`, `.export-dropdown-menu`
  (whichever the lane migrated), and the corresponding JS files no longer roll their own
  `document.addEventListener('click', …, true)` dismissal or `getBoundingClientRect`-based position
  block (grep-assert absence in `modelPicker.js` / `emojiPicker.js` / the migrated `sessions.js`
  block).
- Each migrated wiring site **calls the kit seam** (`OrwellMenuKit.` / `OrwellPopoverKit.`).

### 5.3 Anti-fragmentation ratchet (à la F-3, `test_f3_window_ratchet.py`)

A `test_no_new_bespoke_menu` gate: grep all `static/js/*.js` for the ad-hoc menu idiom
(`createElement('div')` whose `className` contains `menu`/`popover`/`dropdown` **and** a nearby
`document.body.appendChild` + `getBoundingClientRect`) **outside** `orwellMenu.js`, against a
shrinking allowlist (slash-autocomplete, ctx-popup if deferred). New menus MUST compose the kit. (ORW-887)

### 5.4 Browser assertions (`browser_smoke.py`, the headless keep-set gate)

Behavior the source-pins can't see — one representative menu (the composer overflow) + one picker
(emoji) + one mobile check:

1. Click trigger → `.ow-menu[role=menu]` mounts; trigger's `aria-expanded` flips to `true`.
2. **↓** moves `tabindex=0`/focus to the first→next `role=menuitem` (roving); **End** → last;
   **typeahead** jumps.
3. **Enter** on an item fires its handler + closes; focus returns to the trigger.
4. **Outside-click** closes; **Escape** closes (and does so *before* an open modal, proving the
   `escMenuStack` seat) and returns focus.
5. **Flip:** open a menu whose anchor is near the bottom edge → surface renders **above** the anchor,
   fully on-screen (no clipping).
6. **Mobile (≤768px viewport):** open a menu → it stays an **anchored `.ow-menu`** (NOT an
   `OrwellSheet`), clamped fully on-screen with 44px coarse rows; outside-tap / Escape dismiss. (Per
   the owner ruling — no bottom-sheet reflow.)
7. **Scroll policy (`dismissOnScroll`):** with the surface open, scrolling an ancestor **while the
   anchor stays in view repositions** it (tracks the anchor, stays open); scrolling until the anchor
   **leaves the viewport closes** it — it is not closed on the first scroll tick.
8. **Disabled item (C9):** a `disabled` item is skipped by ↓/↑ roving + typeahead, and
   clicking/Entering it fires no `onSelect` and does not close the menu.
9. **Dialog-role popover naming (C6):** a `role="dialog"` popover (emoji/color) exposes a non-empty
   accessible name (`ariaLabel`).

### 5.5 Whole-suite + golden-path

Run `cd frontend && python3 -m pytest tests/` (the g15 / reasoning-scrub / render / keep-set-label
convention gates can trip on class renames). **Golden-path fixture is unaffected** — pure
CSS/JS/class swaps, no prompt / tool-schema / casting-flow change (§WAVE note in the ledger).

---

## 6. Owner decisions needed

1. **Mobile bottom-sheet for ALL menus — ✅ RESOLVED by the ruling: NO.** Menus stay **anchored** on
   mobile in Workflow-2; there is **no** bottom-sheet reflow. The `sheetOnNarrow` / `OrwellSheet`
   handoff is deferred (a later flagged mode, §2.3), so the surface presents as the same anchored (ORW-887)
   `.ow-popover` on every viewport.

2. **Ctrl+K search overlay (#14) — ✅ RESOLVED by the ruling: EXCLUDED from this kit.** It stays a
   *centered modal palette* (full-viewport scrim, roving results), not an anchored menu — leave it
   as-is or promote to a `modal:true` `OrwellWindow` in its own lane. W10 scope excludes it.

3. **Model / emoji / color / provider = Popover (rich) vs Menu (item-model).** The model picker
   (favorite dots, sections, logos, stale badges) and emoji/color pickers are **not plain action
   lists** — recommend the **`OrwellPopover` path** (keep bespoke inner content, gain only
   chrome/positioning/dismiss/a11y — anchored on mobile, no sheet). The model picker is semantically a
   **listbox** — render it via `OrwellMenuKit`'s `role:'listbox'` variant (rows `role=option`, the
   kit's roving nav driving them), **not** `role=menu` and **not** an undefined `OrwellPopover.onKey`
   hook (§2.2). The provider menu *does* fit the item model (icon + label + checked) —
   confirm Menu-with-icons is acceptable there.

4. **Two minor drops:** (a) the overflow menu's decorative **staggered per-item entrance** (20 CSS
   rules) — recommend dropping (or a `stagger:true` opt-in); (b) the model picker's **prefer-up**
   placement — the kit preserves it as `placement:'top'` with auto-flip, but confirm "always open
   upward unless no room" is the intended behavior (it matches today's `bottom:calc(100%+16px)`).

---

### Appendix — where the pieces live (for the delegate)

- Kit siblings to mirror: `frontend/static/js/orwellWindow.js` (base+modal, `ensureCss`, clamp,
  focus-return, `_byId` registry, `AbortController`), `frontend/static/js/orwellSheet.js`
  (detents/`anchored`/focus-trap/scrim — the mobile-sheet delegate), `frontend/static/js/escMenuStack.js`
  (`bindMenuDismiss` — the dismiss seat).
- Escape arbiter seat (already calls `dismissTopMenu()` first): `frontend/static/js/ui.js:1260`.
- Demo: add an `.ow-menu` / `.ow-popover` section to `frontend/static/element_kit_demo.html`
  (the kit demo home named in the ledger).
- Tokens: `--win-*` `frontend/static/style.css:190`, `--ow-ui-font` `:25`, `--ow-glass-light-color`
  `:20385`, `--ow-ios-blue` `:21573`.
- Ledger row: `docs/audits/2026-07-15-total-kit-migration-inventory.md` §8 + the W10 wave entry.

---

## OWNER RULING (2026-07-15)

**Menus stay anchored on mobile — NO bottom-sheet reflow for now.** Do NOT implement the `sheetOnNarrow` / `OrwellSheet` handoff in this kit; the mobile presentation is the same anchored popover as desktop. (The detent/sheet plumbing may be added later behind a flag, but it is OUT of Workflow-2 scope.) Also confirmed: the **Ctrl+K command palette is EXCLUDED** from this kit — it stays a centered modal, not an anchored menu.
