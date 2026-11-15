# 0072 — Multi-platform gateway: play your game from messaging platforms

**Status:** spec (BDD-first). **Priority:** Wave 3 of the Hermes→Orwell integration
(`docs/HERMES-INTEGRATION-PLAN.md` A2/A3). After 0070; coordinates with ADR 0007 (public exposure), 0021
(per-user isolation), 0064 (cross-device sync), and 0071 (URL guards). **In scope per owner ruling (2026-06-22).**
**Provenance:** adapts the gateway adapter+registry+pairing+delivery patterns from hermes-agent
`gateway/` (MIT © 2025 Nous Research — **attribution retained**). `gateway/pairing.py` is adopted near-verbatim;
the per-platform adapter contract and delivery channel-split are adapted; `gateway/run.py` is **pattern-only**
(reimplemented against orwell's stack, not lifted).

## Why

The chat **is** the game (ADR 0003). A messaging platform is pure chat — so letting a player reach **their own
game** from Telegram/Discord/Slack/WhatsApp/Signal *strengthens* the chat-is-the-game contract while extending
reach off the browser. The Vault Wall is **not** at risk: orwell's player tier already consumes only Vault-free
engine projections, so any new surface over the same MCP player channel inherits the wall by construction.

The two things that turn this from "win" into "leak/violation" are both tractable and both have hermes assets:

1. **Reasoning must never reach a public bubble.** orwell's reasoning/reply split is enforced in the **browser**
   (`static/js/chat.js`). A messaging transport has no accordion — so reasoning deltas (`json.thinking` truthy),
   operator-asides, and raw `npc:<id>` leaks must be filtered **server-side before delivery**.
2. **One human must not become many games.** hermes keys sessions per-platform; the same person on Telegram and
   web would get two games — a breach of the one-game-per-user isolation guarantee (0021). Pairing fixes this.

## The shape

A new **non-Vault player adapter** — a `frontend/gateway/` package that lives *beside* the web FE and talks to
the engine over the **same Vault-free MCP player channel** (`orwell_engine.py`), never importing a TS port.

1. **Platform adapter contract + registry** (adapted from `gateway/platforms/base.py` +
   `platform_registry.py`): each platform is a self-registering adapter normalizing inbound messages and
   delivering outbound text. Adding a platform never touches core.
2. **Identity pairing** (adopted from `gateway/pairing.py`, near-verbatim): a code-approval flow (salted hash,
   TTL, rate-limit, lockout) binds a platform identity (`telegram:<user_id>`) to **one orwell account**. The
   adapter thereafter asserts that account's `x-orwell-user` on every engine call — regardless of platform — so
   the same human shares **one** game across web + every platform.
3. **Server-side reasoning/censor chokepoint** (the Python analog of `markdown.js processWithThinking`,
   modeled on hermes' `stream_dispatch.py` "eat the events you can't render"): a single outbound filter before
   `delivery.send` strips reasoning, operator-asides, and `npc:<id>` leaks for **every** platform. This is what
   makes the accordion-less transport leak-safe.
4. **Chat only for now (Ryne, BDD card 33, 2026-11-11: "Chat only for now.").** A gateway turn is ONE narrated turn plus the scene
   fold. The system prompt tells the model to present a pending decision's options as a numbered list in plain text, but the gateway
   does NOT submit decisions and does NOT advance the game; deciding and advancing happen in the web client. (This item used to promise
   decision-card text degradation with the reply routed to the decision-submit path; that was never built. Finishing it is a future card if Ryne asks.)
5. **Game-build tool-gating respected:** platform players can reach only the keep-set tools; the
   `ORWELL_GAME_BUILD` drop-set stays unreachable (no inherited-workspace tools over a platform).
6. **Cross-device reconcile reuses 0064:** a platform turn is just another device; existing `_publish_game_updated`
   server-push + the `orwell:gamechanged` single-dispatcher keep a web tab fresh.

## Invariants (BDD/unit)

- **Vault-safe by inheritance.** A platform reply contains no Vault/secret content, no relationship number, no
  `npc:<id>`, no operator-aside, and no reasoning text — proven by an outbound-delivery boundary test.
- **One game per human across platforms.** After pairing two platform identities to one account, both reach the
  **same** game and the **same** `x-orwell-user`; an unpaired identity cannot reach any game.
- **Cross-user isolation holds.** No platform call returns another user's game (secret or not).
- **Reasoning never reaches the public bubble.** A turn whose narration carries reasoning/operator-aside/`npc:<id>`
  is delivered scrubbed; the chokepoint fires regardless of which prompt produced the leak.
- **Chat only.** One narrated turn plus the scene fold; no decision submission and no advancing over the gateway (Ryne, 2026-11-11). A pending decision is only described in plain text; the player decides in the web client.
- **Game build respected.** A platform player cannot invoke a drop-set / inherited-workspace tool.
- **Pairing is hardened.** Codes are salted-hashed, TTL-bounded, rate-limited, and lock out after repeated
  failures; an expired/incorrect code is refused.

## Implementer handoff / open questions

- **Auth posture vs ADR 0007.** Coordinate the platform-exposure auth with the public-exposure model; pairing is
  the identity primitive both want.
- **Per-platform SDK deps.** Start with **Telegram** (simplest) end-to-end behind the registry; add others as
  thin adapters. Keep SDKs optional extras so the core FE install is unchanged.
- **Streaming vs single delivery.** Decide per-platform whether to stream partial deltas or deliver the final
  scrubbed reply; the chokepoint must run either way.
- **Attribution.** Nous Research MIT entry in `frontend/ACKNOWLEDGMENTS.md` + `frontend/licenses/` (gateway + pairing).
