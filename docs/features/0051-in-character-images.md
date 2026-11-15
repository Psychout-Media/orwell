# 0051 — In-character images (analyze in, generate out)

> **Status:** **Built (2026-06-11).** Mixed tier, both halves shipped: the engine side
> (`ImageGenerationPort`, the Vault-free `portraitPrompts` builder, the seeded photorealistic
> style anchor, `getPortraitPrompt` + `recordImageBeat` tools) is unit-gated (`tests/unit/
> portraitPrompts.test.ts`) and swept by the live sentinel property test; the front-end
> (move-in portrait pipeline, per-user persistence, the Cast roster sidebar, inline rendering,
> reset scrub) is pytest-gated (`frontend/tests/test_orwell_portraits.py`). The image tools are
> `INFRA_LEVERS` (FE pipeline calls them directly), not advertised in the GM lever manifest.
> Not in `cucumber.cjs` (no BDD scenario — unit + pytest gated, like 0033/0036). Settings reuse
> the existing `image_gen_enabled`/`image_model`/`image_quality` card (unhidden, text-to-image
> filter). *(Amended 2026-11-12, ORW-286 item 4, Ryne: "I don't want pictures of scenes.")* Only **cast portraits** are in scope: the scene-still promises (camera stills, "an image may depict only what the player knows", "no image asserts an unresolved outcome", production-frame declines for those) are removed. The old "browser-smoke render check is still owed" note is retired: Playwright runs in CI and the portraits path is covered by `frontend/tests/test_orwell_portraits.py` and the browser lane.
> **Executable spec:** [`0051-in-character-images.feature`](./0051-in-character-images.feature)
> **Provenance:** `docs/audits/2026-06-10-full-product-audit.md` "Future specs" — 0051
> (per the 2026-06-10 ruling, a feature spec, not a defect) · **ruling #9** (image attach —
> the analyze-in half, specced at E94 and shipped FE-side) · D9/E64 portrait surfaces ·
> ADR 0003 (the conversation is the game) · the Vault Wall (CLAUDE.md mandate #2).

## 1. Summary

The model can *produce* images as part of play — a houseguest's sketch, the memory-wall
portrait — rendered **inline in the chat**. *(Scene stills / "camera stills" were cut 2026-11-12: Ryne wants cast portraits, not pictures of scenes.)* This completes the
analysis loop ruling #9 opened: E94 made attaching an image a first-class in-character input
("the player is showing something to whoever is present"); 0051 is the output direction.

The first deliverable fires **automatically at move-in**: as part of the `createCharacter` /
season-start beat, the engine generates a **photorealistic cast portrait set** (reality-TV-style
headshots) for each houseguest — no player prompt needed. The portraits appear inline in the
chat as the cast is introduced, then are **persisted to the engine data dir** (`ORWELL_DATA_DIR`)
so they are never lost and never re-generated on restart.

Persisted portraits feed a **cast roster sidebar** — a dedicated "who is who" reference the
player can open at any time. Each card shows the houseguest's portrait, name, and current game
status (active / jury / evicted). This replaces the prior external-document workaround and
gives the player a durable face-to-name reference throughout the season.

**Planned future extension (not in this spec's DoD):** small portrait thumbnails in the chat
window when the model is voicing a specific houseguest — the face appears naturally beside the
message. Specced here so the storage + port design plans for it; built separately.

## 2. Why this is a design pass, not a feature toggle

The audit names the questions this spec must answer (and the .feature pins):

1. **Which moments may generate** — the producer-beat that auto-fires at move-in for cast
   portraits, plus a player-requested portrait or in-character sketch (e.g. "draw me the memory
   wall portrait"). Neither is unbounded. *(Scene stills such as an eviction "camera still" were
   cut 2026-11-12.)*
2. **How generation stays Vault-free** — image prompts are built **only from the player's
   visible state** (the same projection the chat narrator gets). The E11/E15 discipline
   applies to image prompts too: no hidden stat, edge, soul, confessional, or off-screen
   scene content may reach the image model, structurally — the prompt builder lives on the
   outward side of the wall and is sentinel-swept like every player surface.
3. **Seed/style consistency per season** — the house must look like itself: a per-season
   photorealistic style anchor (seeded at `createCharacter`, persisted in the snapshot) plus
   each houseguest's stable public appearance facets (0004 §8) feed every prompt, so the same
   houseguest renders recognizably as a photorealistic individual across the season and
   across restarts.
4. **Cost/latency gating** — generation is the most expensive lever in the game; budgets
   (per-turn / per-week caps, declared in a constants module, never inline) bound it, and
   an over-budget request is declined **in the production/show frame** ("production is hoarding
   the cameras tonight"). Move-in portrait generation is exempt from the per-turn cap (it is
   a bounded, one-time season-start cost).
5. **Graceful absence** — when no image-capable model is configured, the game plays
   identically: in-fiction refusal in the production frame ("the feeds can't render that"),
   no error surface, no broken affordance. Mirror of E94(c). The cast roster falls back to
   name + status cards with no portrait image.

## 3. Decisions (locked 2026-06-11)

| Decision | Choice | Notes |
|---|---|---|
| **Portrait trigger** | Auto on move-in — fires as part of `createCharacter` / season-start beat, no player prompt | The cast is introduced; their faces appear with them |
| **Visual style** | Photorealistic — reality-TV-style headshots | The per-season style anchor is a photorealistic descriptor seeded at cast time |
| **Image provider** | Provider-agnostic `ImageGenerationPort` | First concrete adapter (DALL-E, Stability AI, etc.) wired at build time |
| **Settings location** | Existing image gen card in the Settings modal (AI section) — currently hidden; unhide and update model filter to text-to-image models | `image_gen_enabled`, `image_model`, `image_quality` already exist in `settings.py` and `settings.js`; the card just needs to be made visible and the model filter corrected |
| **Decline framing** | Production / show metaphor for all decline paths | "feeds are down," "production is holding the cameras" — never a technical message, never a hint about hidden state |
| **Image persistence** | Engine data dir — `{ORWELL_DATA_DIR}/{user}/portraits/{houseguest-id}.*` | Co-located with the save; managed by the FE; `orwell-factory-reset.sh` must scrub the portraits dir |
| **Cast roster** | Sidebar panel — portrait + name + status (active / jury / evicted) | Status from the Vault-free public projection; evicted houseguests remain visible (dimmed/marked) for jury management reference |
| **Chat avatars** | Planned future extension — out of this spec's DoD | The storage and port design must not preclude it; built as a follow-on |

## 4. The rules that bind (non-negotiable)

- **Vault Wall:** the image-prompt builder takes the visible projection only; a structural
  test proves no Vault/engine-only handle is reachable from it, and a sentinel sweep proves
  no hidden content appears in any assembled image prompt.
- **Knowledge scope (portraits only):** a portrait is built from a houseguest's **public**
  appearance facets (see the Vault Wall rule above), so it can never depict anything the player
  does not know. *(2026-11-12: the scene-still rules, "an image may depict only what the player
  knows" for off-screen scenes and "no image asserts an unresolved outcome", were removed with
  scene stills: there are no scene pictures to gate.)*
- **Recorded or it didn't happen:** a generated image shown in character is a beat — it is
  recorded (player-witnessed event referencing the image and its subject) like any scene.
  The E22 guard applies to image turns.
- **ADR 0003 — augment, never replace:** images render inline in the chat; the cast roster
  is a companion reference panel (sidebar), not a game-primary surface; no interaction that
  builds or progresses the game may *require* the image path; reduced/absent image capability
  never blocks play (cast roster falls back gracefully).
- **No number crosses:** portrait prompts use qualitative public facets (appearance,
  presentation, archetype-flavored wording) — never stats, edges, or tier internals. The cast
  roster status field comes from the public game projection, never the Vault.
- **Decline framing is always the production frame:** when a portrait cannot be produced
  (budget, no image-capable model), the in-fiction explanation is drawn from the BB production
  aesthetic — never a technical message, never a hint about what the hidden state contains.
- **Portraits are generated once per season start:** on restart, the stored portrait is served;
  re-generation is not triggered. If the portrait file is missing (first run or after a reset),
  it is regenerated on demand, not on every restart.
- **Factory reset must scrub portraits:** `orwell-factory-reset.sh` must delete the portraits
  dir alongside `.orwell-data` — a reset is a full reset.

## 5. Scope

**In:**
- The per-season photorealistic style anchor (seeded at `createCharacter`, persisted in the snapshot)
- The `ImageGenerationPort` (provider-agnostic; adapter wired at build time)
- The Vault-free image-prompt builder over visible state + public appearance facets
- Auto-firing cast portrait set at move-in (first deliverable, no player prompt)
- Player-requested portraits / in-character sketches (not scene stills)
- Budget gating (constants module; move-in portraits exempt from per-turn cap)
- Inline chat rendering of generated images
- Portrait persistence: `{ORWELL_DATA_DIR}/{user}/portraits/`; survive restart; no re-generation if stored
- Cast roster sidebar: portrait + name + current status (active / jury / evicted); Vault-free; graceful fallback when no images
- Production-frame decline and absence paths (budget / no image model)
- Recording of image beats as player-witnessed events
- Factory reset integration (scrub portraits dir)

**Out:**
- Image *analysis* (that is E94, shipped/landing separately — this spec only pairs with it)
- General image gallery or editing of past stills (E93's no-rewriting rule covers depicted history too)
- NPC-to-NPC "images" (off-screen life stays textual in the hidden layer)
- Chat avatar thumbnails (planned future extension — storage + port must not preclude it)

## 6. Test strategy (at build time)

- **Engine/TS:** prompt-builder structural isolation (dependency-cruiser scope extension);
  sentinel sweep over assembled prompts; style-anchor persistence + same-seed reproducibility;
  budget constants honored; production-frame decline on budget exhaustion and a missing image model; image beats recorded; `ImageGenerationPort` wired behind the outward root.
- **FE/pytest + smoke:** auto-portrait generation at move-in (once per season start, not on
  restart); portrait persistence to data dir; cast roster renders with portrait + name + status;
  roster status reflects live game state (active / jury / evicted); roster graceful fallback when
  no image-capable model; no re-generation on restart when portrait already stored; factory reset
  scrubs portraits dir; no new chrome surface beyond the roster sidebar.

## 7. Definition of Done

All .feature scenarios green under their decided gates; the Vault-free prompt path proven
structurally; portraits generated once at move-in, persisted, and served from storage on
subsequent loads; cast roster accessible from a sidebar with portrait + name + status; play
unaffected when generation is unavailable; factory reset scrubs portraits; the README index
row flipped to Done.
