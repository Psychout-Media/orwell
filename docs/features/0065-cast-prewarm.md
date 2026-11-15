# 0065 — Cast pre-warm: deep-author the cast *before* portraits

> **Two features carry the number 0065.** This is cast pre-warm (it owns `0065-cast-prewarm.feature`). The other is [0065 — The LLM↔engine sync spine](./0065-llm-engine-sync-spine.md) (no `.feature`).

**Status:** building (engine + FE). **Priority:** after 0058/0051 (depends on both).
**Owner ruling:** the player must start the actual game with a **fully warmed authorship**
*before any portrait is ever generated.* Author warm starts at the earliest possible moment (a
working model is selectable, before the season begins); portrait warm is held until the first
interview turn, runs in the background during the interview, and **waits for author warm to finish**.

## Why

People should "walk in" as **fully-formed, deeply-authored characters with veiled backstories**.
Cast portraits are generated **off the deep character store**, so that store must already have its
full §3 depth (the LLM-authored physical facet + biography) by the time a face is shot — otherwise
the picture is drawn from the thin seeded floor and never matches the finished person.

Two concrete defects this fixes:

1. **The authoring write-back never reached the engine.** `recordCastProfile` (0058 Phase 2) is a
   `GameSession` port method with a live adapter, *but it was never on the player channel's tool
   allowlist nor dispatched in `McpServer`* — so the FE's per-houseguest authoring calls were
   rejected at the MCP boundary (`tool "recordCastProfile" is not available on channel "player"`).
   Every season has therefore shipped the **seeded floor only**; the LLM authoring silently 400'd.
   (`recordWorldSnapshot`, 0062, has the same gap — left unwired here; 0062 is spec-only.)
2. **Authoring raced portraits.** Even once wired, authoring (15 sequential LLM calls) ran *in
   parallel* with portrait generation from the seeded facets, so faces locked to the thin store
   before the rich one landed. Portraits must read a **finished** character, not a half-seeded one.

## The shape

The whole NPC cast — composition (`generateHouse`), the deep layer (`generateCastDeepLayer`), the
diversity floor (`generateDiversityLayer`), **and** the LLM authoring — is **player-independent and
deterministic off the season seed** (enforced for anti-sycophancy). So the cast can exist, and be
deep-authored, **before the player's name does**. Pre-warm hoists the cast half of season start
earlier and decouples it from the player:

1. **Seed early.** The season seed is minted + **persisted** the moment casting opens, not at
   `createCharacter`. The cast is reproducible and prep can start immediately.
2. **`preSeedCast(seed)` — new player-channel tool.** Off that seed, generate the NPC house +
   diversity + deep layer and seal the hidden layer to the Vault — the cast half of season start,
   run early into an engine-side **pre-game holding store** (`prewarm`). Returns the Vault-free
   roster + portrait prompts. Idempotent; durable (a half-warmed cast survives a restart, 0030).
3. **Author warm (early).** As soon as a model is selectable, the FE runs the 15-call authoring
   against the pre-seeded cast; each write-back (`recordCastProfile`, now wired) lands on the
   `prewarm` store. Runs through the casting interview.
4. **Portrait warm (gated).** Held until the first interview turn; runs in the background **but
   blocks on author warm being fully finished** — no face is generated until authorship is 100%
   complete ("a fully warmed authorship before photos are warmed, ever").
5. **`createCharacter` adopts.** At finalize it binds *only the player* (player character + the
   player-dependent seeding: first impressions, pre-game ties, rooms) and **adopts the already-
   authored cast** from `prewarm` — idempotent, reusing the warmed seed, never re-seeding or
   re-authoring. Portraits already match because they were shot from the authored store.

**Absence (no key / no model):** `preSeedCast` is never called, so `createCharacter` takes the unchanged path.
*(Amended 2026-11-12, ORW-286 item 3, Ryne BDD card 30: "I don't want a fallback".)* Under the default `strict`
enrichment policy there is **no fallback cast**: a missing or failed authoring run is a loud refusal to start the game (0058,
0116). Only the keyless-CI / `ORWELL_ALLOW_FLOOR_START=1` / `soft` lanes keep the deterministic seeded floor, so tests never depend on a live
model. A facet **fingerprint backstop** in the FE re-shoots a portrait only if the deep store later
changes, so even a no-key→key transition can't leave a stale face.

## Invariants (BDD/unit)

- **The authoring write-back reaches the engine.** `recordCastProfile` is available on the player
  channel and seals authored detail; it is an *infra lever* (FE-driven), never a model-pulled lever.
- **Pre-warm is Vault-free.** `preSeedCast`'s output carries no secret/hidden content (sentinel-free,
  like every outward surface) — only the public roster facets + portrait prompts.
- **Pre-warm is deterministic + player-independent.** Same seed ⇒ the same warmed cast; no player
  field is read.
- **`createCharacter` adopts the warmed cast.** After `preSeedCast` + `recordCastProfile`, finalizing
  starts the season with the **authored** biography on the live house, the **same seed**, and the
  seeded floor un-regenerated (the authored detail is not lost).
- **Durability.** A warmed-but-not-finalized cast persists and re-hydrates (0030).
- **Non-degradation + byte-stability hold.** The static `CHARACTER` is byte-stable across the warm →
  adopt boundary; the no-prewarm path is byte-identical to today (no seeded-floor change).
