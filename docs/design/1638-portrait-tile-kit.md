# 1638 — `.ow-portrait` / `.ow-portrait-tile` kit primitive (G4 / G5 / G6)

> 📐 **Build-ready design spec** · 2026-07-15 · for **Workflow 2** of the #1638 total-kit migration
> (owner DoD: *everything migrates*). Closes the three portrait/headshot ACCEPTED-GAP rows in the
> [total-kit inventory](../audits/2026-07-15-total-kit-migration-inventory.md) §10:
> **G4** headshot image tiles (`.hs-cand`/`.hs-libitem`), **G5** house-status portrait tiles
> (`.os-tile`), **G6** cast portrait cards (`.oc-hg`/`.oc-portrait`).
> **DOC-ONLY** — no source edits ride with this spec.

## 1. What this primitive is (and is not)

A **portrait tile** is the square, clipped, radiused framing that wraps a houseguest's *face* — a real
generated portrait **or** the designed monogram fallback — plus the interaction/selection/loading
chrome the framing owns. It is the missing kit-branded wrapper around the face content the kit
**already** produces.

**Load-bearing prior art — do not reinvent the face:** `OrwellMonogram.face(card, opts)`
(`orwellMonogram.js:178-214`, CSS injected at `:142-168`) already returns a `.ow-mono-face` element
that resolves the whole *inner* content problem cross-surface:

- portrait `<img loading="lazy">` when `card.portrait` exists, else the id-seeded designed monogram
  SVG (`svg()`, `:84`);
- the **broken/still-generating heal** — `img.onerror` rebuilds the monogram inner and re-composites
  the badge (`:194-206`), so a 404/mid-generation ref never shows the broken-image glyph;
- the composited **role badge** (`badgeSvg`, `:127`; hoh/nominee/veto/winner);
- the **evicted** monochrome rule (`.ow-mono-face.ow-mono-evicted`, `:153`);
- the optional tight **crop** for tiny avatars (`.ow-mono-crop`, `:160`);
- a Vault-free shared **portrait cache** (`portraitFor(id)`, `:254`) refreshed off the one
  `orwell:gamechanged` dispatcher.

Six surfaces already compose `face()` (orwellDecision, orwellDossier, orwellFinale, orwellRoomStrip,
orwellStatusPanel, orwellToolBeats — grep `OrwellMonogram.face`). **The gap is the outer tile**: the
three consumer families below each re-author the *framing* (aspect / radius / border / focus ring /
selected ring / loading skeleton / broken fallback / hit-target) in their own bespoke CSS, so the
frame drifts (three different radii, three different selected affordances, one has a skeleton, one
doesn't). `.ow-portrait` **unifies the frame** and standardizes on `face()` as its content.

> **Scope boundary.** `.ow-portrait` is the frame + states. `OrwellMonogram.face()` stays the content
> engine. The primitive is *not* a new image system, *not* a lightbox, and does *not* absorb the
> monogram/badge/cache logic — it composes them. `.ow-mono-face` keeps `width/height:100%` and inherits
> the tile's radius via `border-radius: inherit` (already true, `:149`), so the frame owns geometry and
> the face fills it.

## 2. Consumer inventory (file:line + current bespoke framing)

### G6 — Cast portrait cards (`orwellCast.js`) — the richest consumer, **not** on `face()`

| Concern | file:line | Current bespoke |
|---|---|---|
| Tile shell (door button) | `orwellCast.js:156-165` | `.oc-hg` — `border-radius:10px`, hover `rgba(255,255,255,.06)`, focus-visible `box-shadow 0 0 0 2px --ow-ios-blue` |
| Portrait holder | `:178-182,218` | `.oc-portrait` — `aspect-ratio:1/1; border-radius:10px; overflow:hidden; border:1px solid --border; position:relative` |
| Image layer + reveal seam | `:186-199` | `.oc-portrait img` absolute inset:0 object-fit:cover; `.oc-img-pending{opacity:0}`; `.oc-justin` `@keyframes ocFadeIn .35s` |
| Monogram base | `:201-217` | `.oc-ph.oc-monogram` (renders `OrwellMonogram.svg()` **directly**, not `face()`); `.oc-mono-fallback` no-kit letter tile |
| Narrow cap | `:219-227` | `.oc-portrait.oc-portrait-ph { max-width:min(88px,26vw) }` on portrait-LESS cards ≤768px |
| Evicted | `:234-238` | `.oc-hg.oc-evicted .oc-portrait img{filter:grayscale(1)}` (duplicates `face()`'s own rule) |
| Caption / status | `:228-232` | `.oc-name`, `.oc-status` |
| Markup + reveal JS | `makeCard():560-607`, `setPortrait():455-542`, `syncBadge():546-558` | hand-rolled two-layer reveal (monogram base + img fade), `.ow-mono-badge` composited manually |

G6 hand-rolls its **own** two-layer reveal (monogram base → decoded-img crossfade) and its own badge
composite because it predates `face()`'s onerror-heal. It is the richest *frame* consumer — but under
the **frame-only ruling (§6.1)** G6 keeps this reveal seam and gains only the `.ow-portrait` frame +
states; the ~80-line `face()` consolidation is **deferred**, not part of this lane. (ORW-888)

### G4 — Headshot studio tiles (`orwellHeadshot.js`) — image thumbnails, own skeleton

| Concern | file:line | Current bespoke |
|---|---|---|
| Candidate grid tile | `orwellHeadshot.js:121-147` | `.hs-cand` — `aspect-ratio:1; height:auto` (OWN-4 load-bearing); `border-radius:8px; overflow:hidden; border:2px solid transparent`; `.sel` = system-blue ring (`:142-146`) |
| Candidate image | `:147` | `.hs-cand img { width/height:100%; object-fit:cover }` |
| **Loading skeleton** | `:152-159` | `.hs-cand.hs-loading` shimmer `@keyframes hsSkeleton 1.1s`; img `opacity:0` |
| **Broken state** | `:162-164` | `.hs-cand.hs-broken` static token fill (no shimmer) |
| Reduced-motion | `:166-169` | freezes shimmer to static fill |
| Focus | `:170-171` | `.hs-cand:focus-visible { outline: 2px solid --brand-color }` — **inconsistent** (brand, not `--ow-ios-blue`) |
| Library strip tile | `:174-181` | `.hs-libitem` 56×56 + `.hs-libpick` (absolute-inset pick button) + `.hs-libdel` (corner delete) |
| Preview thumbnail | `:97-103` | `.hs-preview` 92×92 idle tile |
| Loading/broken wiring | `:391-400` | mounts `.hs-loading`, clears on `img.load`, swaps `.hs-broken` on error |
| Markup | grid `:445`, library `:386-388`, preview `:428,:464` | `<button class="hs-cand hs-loading"><img></button>` |

G4's tiles are **selection buttons over raw image refs** (not roster cards) — they don't use `face()`
and shouldn't (there's no monogram fallback for an unnamed candidate). But the **frame + loading +
broken + selected + focus states** are exactly what `.ow-portrait` standardizes. G4 keeps its
`.hs-cand`/`.hs-libitem` semantic classes and gains the shared state classes.

### G5 — House-status premiere tiles (`orwellStatusPanel.js`) — already on `face()`

| Concern | file:line | Current bespoke |
|---|---|---|
| Strip tile button | `orwellStatusPanel.js:266-270` | `.os-tile` — 30×30, `border-radius:7px; overflow:hidden`, transition |
| Face inner | `:271` | `.os-tile .ow-mono-face { border-radius:7px }` (already `face()`) |
| Hover / focus | `:272-273` | `translateY(-1px)`; focus-visible `box-shadow 0 0 0 2px --ow-ios-blue` |
| Met / unmet state | `:274-275` | `.os-tile-unmet { opacity:.34; filter:grayscale(.7) }` |
| 44px hit target | `:280-297` | coarse-pointer `::after` 44×44 invisible hit expander |
| Markup | `:644-670` | `<button class="os-tile">` wrapping `OrwellMonogram.face(...)` |

G5 is the **cleanest** consumer — already `face()`-backed. Migration is mostly a class rename +
adopting the shared radius/focus/hit-target so the three tiers agree. Its **met/unmet** dim is a
G5-specific state modifier the primitive should host as `.ow-portrait--muted` (generalizing `oc-out`
too).

## 3. Proposed markup + CSS contract

### 3.1 Structure

```html
<!-- interactive tile (cast door, premiere tile, headshot candidate) -->
<button type="button" class="ow-portrait ow-portrait-tile" aria-label="Open …'s dossier">
  <!-- inner content = OrwellMonogram.face(card, opts) → .ow-mono-face (img|monogram + badge) -->
  <span class="ow-mono-face">…</span>
</button>

<!-- display-only tile (ceremony slate, dossier hero) -->
<div class="ow-portrait">
  <span class="ow-mono-face">…</span>
</div>

<!-- optional caption row (cast card) -->
<div class="ow-portrait-caption"><b>Name</b> <span class="ow-portrait-sub">HOH</span></div>
```

The tile is a bare `<button>` (interactive) or `<div>` (display). The inner is **always**
`OrwellMonogram.face()` where a roster card exists; G4 candidates (no card) put a bare `<img>` /
skeleton inside the same frame.

### 3.2 Selectors, tokens, states

| Selector | Role | Key declarations (token-driven) |
|---|---|---|
| `.ow-portrait` | the frame | `aspect-ratio: var(--ow-portrait-aspect, 1/1); border-radius: var(--ow-portrait-radius, var(--ow-radius-inner)); overflow: hidden; position: relative; background: var(--ow-control-fill); border: 1px solid var(--ow-glass-rim-border)` |
| `.ow-portrait > .ow-mono-face, .ow-portrait > img` | content fill | `width/height:100%; object-fit:cover; border-radius:inherit` |
| `.ow-portrait-tile` | interactive variant | resets native button chrome (`padding:0; font:inherit; cursor:pointer; -webkit-appearance:none`); pins `height:auto` (the **OWN-4** aspect-ratio fix — the app-wide `button{height}` reset otherwise letterboxes it) |
| `.ow-portrait-tile:hover` | hover | subtle lift `translateY(-1px)` / `background` bump (reduced-motion-guarded) |
| `.ow-portrait-tile:focus-visible` | focus | `outline: none; box-shadow: 0 0 0 2px var(--ow-focus-ring, var(--ow-ios-blue))` — **the one sanctioned focus color**, replacing G4's `--brand-color` drift |
| `.ow-portrait.is-selected` / `[aria-pressed="true"]` | selected | system-blue ring `outline: 3px solid var(--ow-ios-blue); outline-offset:1px` (G4's `.sel` pattern, kit-owned) |
| `.ow-portrait.is-loading` | skeleton | shimmer gradient over `--ow-control-fill`/`--ow-glass-rim-border`, `@keyframes owPortraitSkeleton`; inner img `opacity:0` |
| `.ow-portrait.is-broken` | hard failure | static token fill, no shimmer (mirrors `.hs-broken`; note `face()` heals to monogram before this fires) |
| `.ow-portrait--muted` | out (dim only) | `opacity: var(--ow-portrait-muted-opacity, .5)` (generalizes `oc-out`) |
| `.ow-portrait--muted-grey` | not-yet-met (dim **and** desaturate) | carries **BOTH** `opacity: .34` **and** `filter: grayscale(.7)` — the full `os-tile-unmet` state in one class (do **not** drop the grayscale; map `.os-tile-unmet` to `--muted-grey`, or to `--muted --muted-grey`, so neither the .34 opacity nor the grayscale is lost) |
| `.ow-portrait--reveal` | arrival fade | `@keyframes owPortraitFadeIn .35s` (generalizes `oc-justin`), reduced-motion → none |
| `.ow-portrait--sm` | compact cap | `max-width: var(--ow-portrait-cap)` for narrow-tier portrait-less tiles (generalizes `oc-portrait-ph`) |

**Sizing is caller-owned** via the grid track + three tokens (`--ow-portrait-aspect`,
`--ow-portrait-radius`, `--ow-portrait-cap`) — no fixed width/height on the primitive (same 310
"don't hard-code control heights" rule the button kit follows). G5 sets radius 7px + 30px track; G4
sets radius 8px; G6 sets radius 10px — all via the token, one primitive.

### 3.3 Two-tier + a11y behavior (mandatory, mirrors the ELEMENT KIT pattern)

The primitive lives in the **ELEMENT KIT** region (`style.css:21751-22368`) with a **frosted** author
and a **flat/Normal** author (`22371-22781`), exactly like every other kit primitive:

- **Frosted** (`body.theme-frosted .ow-portrait`): translucent `--ow-control-fill` + the luminous
  `--ow-glass-rim` edge; the tile does **not** stack a second backdrop-filter (glass-on-glass ban) —
  the face inside is opaque image/monogram, so the frame only needs the rim.
- **Flat**: solid `color-mix(--panel …)` fill + `--border`, no blur (the `.og-card` cross-tier idiom).
- **a11y trio** (the test_0773 contract): `@media (prefers-reduced-motion: reduce)` freezes hover
  lift / reveal fade / skeleton shimmer; `@media (prefers-contrast: more)` strengthens the selected
  ring + border; `@media (prefers-reduced-transparency: reduce)` swaps the frosted rim for a solid
  border. Eviction monochrome stays owned by `.ow-mono-face.ow-mono-evicted` (do **not** duplicate).
- **Tap target**: interactive tiles below 44px (G5's 30px) keep the coarse-pointer invisible-`::after`
  hit expander idiom (`orwellStatusPanel.js:292-297`) — host it as `.ow-portrait-tile` `@media
  (pointer:coarse)` so all three consumers inherit it instead of re-authoring.

## 4. Migration mapping per consumer

### G6 — Cast (`orwellCast.js`) — the deep one

| Current | → Target |
|---|---|
| `.oc-hg` door button | `.ow-portrait-tile` **+** keep `.oc-hg` for cast-grid layout only (dual-class, like `.oc-pin`) |
| `.oc-portrait` holder | fold into `.ow-portrait` (aspect/radius/border/overflow/position) |
| `.oc-ph.oc-monogram` + manual `svg()` + `setPortrait()` two-layer reveal + `syncBadge()` | **KEEP as-is (frame-only ruling, §6.1)** — G6 retains its hand-rolled two-layer reveal (`oc-img-pending`, `ocFadeIn`/`.oc-justin`, the retire timer) and manual badge composite; it does **not** swap to `OrwellMonogram.face()`. Only the outer frame moves to `.ow-portrait`. |
| `.oc-portrait.oc-portrait-ph` narrow cap | `.ow-portrait--sm` (token cap) |
| `.oc-hg.oc-evicted .oc-portrait img{grayscale}` | delete — `face()` owns eviction via `card.status` |
| `.oc-out` dim | `.ow-portrait--muted` |
| `.oc-name` / `.oc-status` | `.ow-portrait-caption` / `.ow-portrait-sub` (or keep bespoke — caption is layout, low priority) |

> **Owner-visible behavior preserved by the frame-only ruling:** the OWN-9 "never a bare grey holder"
> guarantee (a slow/hung portrait shows the designed monogram, never an empty box) and the G22 arrival
> fade are **untouched** — G6 keeps its existing two-layer reveal (img layered over a live monogram,
> crossfaded). Because the reveal seam does **not** migrate to `face()`, there is **no** behavioral risk
> and nothing to live-verify in this lane: it is a pure frame/state-class swap. (`.ow-portrait--reveal`
> remains available as a generic primitive fade for *future* consumers, but G6 does not switch to it.)

### G4 — Headshot (`orwellHeadshot.js`)

| Current | → Target |
|---|---|
| `.hs-cand` frame + `aspect-ratio;height:auto;overflow;radius` | `.ow-portrait-tile` (keep `.hs-cand` for grid semantics/selectors) |
| `.hs-cand.sel` system-blue ring | `.ow-portrait.is-selected` (identical pattern, now kit-owned) |
| `.hs-cand.hs-loading` shimmer + `@keyframes hsSkeleton` | `.ow-portrait.is-loading` + `@keyframes owPortraitSkeleton` (delete the dup keyframes) |
| `.hs-cand.hs-broken` | `.ow-portrait.is-broken` |
| `.hs-cand:focus-visible { --brand-color }` | inherits `.ow-portrait-tile:focus-visible` (**fixes the focus-color drift** to `--ow-ios-blue`) |
| `.hs-libitem`/`.hs-libpick`/`.hs-libdel` | `.hs-libitem` → `.ow-portrait` (frame); `.hs-libpick`/`.hs-libdel` stay bespoke (pick-overlay + corner-delete are not the tile) |
| `.hs-preview` 92×92 | `.ow-portrait` with `--ow-portrait-radius:8px` (display variant) |
| loading/broken wiring `:391-400` | **update the handlers to toggle the kit state classes** `.ow-portrait.is-loading` / `.is-broken` on the img load/error events. Today they toggle the legacy `.hs-loading`/`.hs-broken`; the wiring must emit the real `is-*` classes (or dual-emit both), or the shared kit states never activate. Test both the load→cleared and error→broken transitions. |

### G5 — House status (`orwellStatusPanel.js`)

| Current | → Target |
|---|---|
| `.os-tile` frame | `.ow-portrait-tile` (keep `.os-tile` for strip layout) |
| `.os-tile .ow-mono-face { radius:7px }` | drop — `--ow-portrait-radius:7px` on the tile, face inherits |
| `.os-tile:focus-visible` box-shadow | inherits `.ow-portrait-tile:focus-visible` |
| `.os-tile-unmet` (`opacity:.34; grayscale(.7)`) | `.ow-portrait--muted-grey` — which carries **BOTH** the opacity dim (.34) **and** `grayscale(.7)`, preserving the met/unmet look exactly (drop neither) |
| coarse `::after` 44px hit | inherits `.ow-portrait-tile` coarse rule |
| `OrwellMonogram.face(...)` inner | unchanged |

## 5. Test plan (`frontend/tests/test_1638_portrait_tile_kit.py`)

Source-pinned convention checks, mirroring `test_1638_compact_icon_kit.py` /
`test_0773_element_kit.py` (the FE pytest lane has no DOM runtime; visual correctness rides
`element_kit_demo.html` + browser_smoke). Bind the KIT region only.

```python
KIT = CSS[CSS.index("── ELEMENT KIT ──"):CSS.index("── END ELEMENT KIT ──")]
```

1. **`test_portrait_primitive_exists`** — `.ow-portrait` and `.ow-portrait-tile` are authored in KIT,
   with `aspect-ratio`, `overflow: hidden`, and a `border-radius: var(--ow-portrait-radius` token
   (no hard-coded radius on the base).
2. **`test_portrait_full_state_set`** — `.ow-portrait.is-selected`, `.is-loading`, `.is-broken`,
   `.ow-portrait--muted`, `.ow-portrait--muted-grey`, `.ow-portrait-tile:hover`,
   `.ow-portrait-tile:focus-visible` all present; assert `.ow-portrait--muted-grey` carries **both** an
   `opacity` dim **and** `filter: grayscale(…)` (the `os-tile-unmet` state loses neither).
3. **`test_focus_ring_is_system_blue_not_brand`** — the tile focus uses `--ow-focus-ring`/`--ow-ios-blue`,
   and the KIT block contains **no** `--brand-color`/`--accent` on any `.ow-portrait` focus/selected
   rule (the G4 drift-fix pin).
4. **`test_selected_is_ring_not_accent_fill`** — `.is-selected` uses `outline`/`box-shadow` with
   `--ow-ios-blue`, never an accent background fill.
5. **`test_no_size_hardcode_on_primitive`** — no standalone `width:`/`height:` on `.ow-portrait`
   (aspect + caller track drive size); `height:auto` present on `.ow-portrait-tile` (the OWN-4 pin).
6. **`test_two_tier_authored`** — a `body.theme-frosted .ow-portrait` rule **and** a flat-tier rule in
   the NORMAL region; frosted composes `--ow-control-fill`/`--ow-glass-rim`, flat composes
   `--panel`/`--border`, and no `.ow-portrait` rule stacks a second `backdrop-filter` (glass-on-glass ban).
7. **`test_honors_a11y_trio`** — reduced-motion freezes the reveal/skeleton/hover; contrast + reduced-
   transparency branches exist for the primitive.
8. **`test_eviction_not_duplicated`** — assert `.ow-portrait` does **not** re-declare a
   `grayscale` eviction filter (owned by `.ow-mono-face.ow-mono-evicted`); prevents the G6 dup returning.
9. **Per-consumer adoption pins:**
   - `orwellCast.js` **keeps** its hand-rolled `ocFadeIn`/`oc-img-pending` two-layer reveal seam
     (frame-only ruling §6.1 — do **not** assert it was deleted or that it composes
     `OrwellMonogram.face`); assert only that `.oc-hg` carries `ow-portrait-tile` (the frame swap landed).
   - `orwellHeadshot.js` `.hs-cand` markup carries `ow-portrait-tile`; the local `hsSkeleton`
     keyframes are deleted (moved to the kit `owPortraitSkeleton`); and the load/error handlers
     (`:391-400`) toggle the kit `is-loading`/`is-broken` classes (not only the legacy `hs-*`), so the
     shared states actually activate.
   - `orwellStatusPanel.js` `.os-tile` carries `ow-portrait-tile`; the local `.os-tile .ow-mono-face`
     radius override is gone.
10. **`test_demo_and_docs_reference_the_primitive`** — `element_kit_demo.html` gains a
    "Portrait tile — .ow-portrait" section showing image / monogram-fallback / selected / loading /
    broken / muted; `docs/design/liquid-glass/ELEMENT_KIT.md` documents `.ow-portrait` + the three tokens.
11. **`test_coarse_pointer_tap_floor`** — the `.ow-portrait-tile` `@media (pointer:coarse)` `::after`
    (or min-size) delivers the 44px hit target so G5's 30px tile stays tappable.

Also **re-run** `test_g22_cast_progressive_render.py`, `test_own3456_headshot_dialog.py`,
`test_m1_9_portrait_honesty.py`, and `browser_smoke` (the "no placeholder glyph on provider-on cards"
gate) as a regression check on the frame swap. With the **frame-only ruling (§6.1)** G6's reveal
behavior does not change, so these should stay green without a live-verify gate.

## 6. Owner decisions needed

1. **G6 reveal swap — ✅ RESOLVED by the ruling: migrate FRAME-ONLY.** G6 does **not** adopt
   `OrwellMonogram.face()`'s reveal-seam swap. It keeps its existing bespoke
   *crossfade-monogram-under-decoding-img* two-layer reveal — which already satisfies OWN-9 ("never a
   bare grey holder") and the G22 arrival fade — and gains **only** the `.ow-portrait` frame + state
   classes. This moots the `face()` OWN-9 / slow-portrait / G22-fade behavioral risk entirely: there is
   no reveal-model change to live-verify and no ~80-line deletion in this lane. (The deeper `face()`
   consolidation can be revisited as its own later lane if ever wanted.)
2. **Caption scope.** Fold `.oc-name`/`.oc-status` into `.ow-portrait-caption`/`-sub`, or leave
   captions consumer-owned (they are layout, not the tile)? Recommend **leave captions bespoke** —
   keeps the lane tight (frame + states only) and avoids touching cast-grid typography.
3. **G4 library pick/delete overlays.** `.hs-libpick` (absolute-inset select) and `.hs-libdel` (corner
   delete) are overlay controls *on* a tile, not the tile. Confirm they stay bespoke (recommended;
   `.hs-libdel` is already a 44px coarse-pointer control).
