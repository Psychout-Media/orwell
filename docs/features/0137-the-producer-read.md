# 0137 - The Producer Read

> **Retrospective note (written 2026-11-03, issue #1938).** This feature shipped flag-gated before any spec existed; this documents what was actually built from the merged code, not a forward design. Issue #1792; merged in PR #1905.

## Problem
After a social scene the player had no feel for who got more out of it. Players could not tell whether they learned something or only gave something away.

## What shipped
- Pure Vault-free `src/engine/producerRead.ts` computes an `ExchangeAccounting`: `playerGained` (the player's knowledge-id set grew, keyed `factId ?? id`), `npcGained` (derived from `event.kind` only, never content: strategy/gossip/alliance/betrayal kinds mean the player disclosed), and an `asymmetry` of `even` / `player-ahead` / `npc-ahead`.
- Delivered as an always-on second-person beat: `THE EXCHANGE (voice this in second person, do NOT state numbers or edges)`, read-and-cleared in `getMomentPrompt` (`momentPrompts.ts`), never on the HUD. Wired via `EngineCommandsAdapter`, `GameSessionAdapter`, `registry.ts`.
- New dependency-cruiser rule `no-vault-in-producer-read` structurally forbids hidden-state imports.

## Flag
Flag `ORWELL_PRODUCER_READ`, deploy default ON; OFF is byte-identical.

## Vault Wall and anti-sycophancy
Structurally incapable of reading NPC knowledge or any hidden state (arch rule). It reports what happened in the scene, not how anyone feels. No outcome effect.

## Tests
`tests/unit/producerRead.test.ts`, `producerReadNeutral.test.ts`, `recordInteractionIdempotency.test.ts`; arch gate via `npm run test:arch`.

## Known gaps
npcGained is a heuristic from event kind only, so it can over- or under-report.
