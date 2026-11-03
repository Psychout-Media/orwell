# 0070 — Off-screen society texture enrichment

**Status:** ✅ Built as a write-back seam (#507 engine, #511 FE driver); **the enrichment does not yet reach the player.** `recordOffscreenSceneTexture` stores the voiced prose in `textureOverrides`, whose only reader is `getOffscreenSceneSkeletons` (it feeds the FE driver back). Overhears, gossip and the retrospective still render the deterministic template content, so the "reaches the player through overhear/gossip" lines below describe the intended design, not shipped behavior. Gated by `tests/unit/offscreenTextureBoundary.test.ts` + the BDD feature. *(Original status:)* spec (BDD-first). **Priority:** Wave 1 of the Hermes→Orwell integration
(`docs/HERMES-INTEGRATION-PLAN.md` A1). Depends on the live off-screen society (0038),
gossip diffusion (0038), the consequence fold (0023), and the FE-driven write-back seam (0058/0062/0065).
**Provenance:** adopts the *parallel isolated-subagent orchestration pattern* from hermes-agent
`tools/delegate_tool.py` (MIT © 2025 Nous Research — attribution retained; **pattern only, no code lift**).

## Why

Mandate priority #1 is behavioral fidelity — specifically the **off-screen NPC-to-NPC scheming the player
never witnesses**. Today the live off-screen society *records* those scenes, but their player-visible
residue is a deterministic template string built in `src/engine/offscreen.ts`
(`` `${a} ${RICH_VERBS[type]} ${b}` `` — e.g. "two houseguests clashed"). When such a scene later reaches
the player via an overhear or a gossip retelling, it arrives as a thin label, not a voiced fragment of a
real argument with motive. The richness exists in the engine's *bookkeeping* but not in the *texture*.

This feature enriches the **prose `content`** of already-recorded hidden off-screen events with model-voiced
texture, produced by a best-effort FE driver that fans out parallel utility-LLM calls (the hermes
subagent-fan-out shape: many isolated, summary-only children) — one per scene skeleton the engine has
**already decided**. The volume that parallel fan-out makes affordable is the point: a tick can voice
several concurrent scenes, directly serving the daily-event richness threshold (`src/engine/richness.ts`).

## The shape

The engine remains the single authority over the **closed set** of every off-screen scene — *which*
co-present pair (occupancy-gated), *what nature* (edge-driven `natureWeights`), the *seeded magnitude* of the
relationship fold, the *gossip rise*, and the *overhear pathways*. All of that is computed and committed
**before** the FE is involved. Then:

1. **The engine exposes the already-decided scene skeletons** for a tick as a Vault-free projection
   (public participants by engine id + their public personas + room + nature label). No hidden attribute,
   no relationship number, no true goal crosses — same public-facets-only constraint as `portraitPrompts.ts`.
2. **`recordOffscreenSceneTexture(eventId, content)` — a new FE-driven write-back tool** (an *infra lever*,
   not a model-pulled lever) that **only replaces the prose `content` of an already-recorded hidden event**.
   It cannot create an event, change a witness set, flip the hidden flag, or carry a number.
3. **A best-effort FE driver** (`frontend/src/orwell_offscreen_texture.py`, modeled on
   `orwell_zeitgeist.py`): resolve a utility LLM via `_resolve_llm_fn`; for each scene skeleton, fan out a
   parallel constrained call ("voice this scene's texture — what was said, the mood — given these two public
   personas and this nature"); write each result back via the tool. Idempotent, fail-soft, budget-capped.
4. **Graceful absence:** no model/key ⇒ the driver is never called ⇒ the deterministic template `content`
   simply stands (byte-identical to today). The enrichment is purely additive.

Because the enrichment lands on an event that is **already hidden** (witness set excludes the player), it is
**downstream of the Vault boundary, not across it**. It reaches the player **only** through the *existing*
`rollOverhears` / `diffuseGossip` pathways, which already filter through `KnowledgeService` with drift +
confidence — so a distorted, sourced belief, never the raw hidden scene.

## Wiring (the four-place write-back + its boundary test)

Per the recurring gotcha (CLAUDE.md): (1) `src/ports/GameSession.ts` method + req/result types; (2)
`src/adapters/engine/GameSessionAdapter.ts` impl (enrich `content` of the addressed hidden event only); (3)
`src/surfaces/tools/registry.ts` — add to `PLAYER_TOOLS` **and** `INFRA_LEVERS`; (4) `src/adapters/mcp/
McpServer.ts` — `requireShape` arg-guard case **and** `callTool` dispatch case. The static gates do **not**
catch a missing #4, so a `McpServer.callTool` boundary test is mandatory (template:
`tests/unit/worldSnapshotBoundary.test.ts`).

## Invariants (BDD/unit)

- **The texture write-back reaches the engine** over the player channel and enriches the addressed scene.
- **The enriched scene stays hidden** — it does not enter player knowledge until a pathway (overhear/gossip)
  terminates at the player; player + admin surfaces never leak the raw hidden scene or any number.
- **The scene skeleton projection is Vault-free** — public participants/personas/room/nature only; no hidden
  attribute, true goal, weakness, perception, or relationship number.
- **The write-back is content-only** — it cannot create an event, alter a witness set, flip the hidden flag,
  or carry a `consequence`/number; an attempt is refused at the boundary.
- **Open/closed non-collapse holds (ADR 0005).** No texture ⇒ byte-identical deterministic fold and template
  `content` (`expressiveNonCollapse` stays green). Texture changes prose only, never the seeded magnitude.
- **Budget-capped + fail-soft.** Fan-out respects a per-tick generation cap (the `imageConstants.ts` pattern);
  a failed/absent driver leaves the deterministic floor intact.
- **Richness rises.** With the driver on, scenes that reach the player carry multi-clause voiced texture; the
  off-screen richness threshold (`src/engine/richness.ts`) is met or exceeded.

## Implementer handoff / open questions

- **Scenes per tick / cost:** what cap balances richness vs. cost and gossip-pathway flooding? (start
  conservative, tune; turn-driven ticks bound it).
- **Skeleton projection placement:** reuse an existing off-screen read or add a thin Vault-free
  `getOffscreenSceneSkeletons(sinceBeat)` projection? Prefer reusing what 0038 already surfaces if sufficient.
- **Attribution:** add the Nous Research MIT entry to `frontend/ACKNOWLEDGMENTS.md` + `frontend/licenses/`
  when this (or 0071) first lands.
