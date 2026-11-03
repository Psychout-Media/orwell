# 0139 - The Booth Has Receipts

> **Retrospective note (written 2026-11-03, issue #1938).** This feature shipped flag-gated before any spec existed; this documents what was actually built from the merged code, not a forward design. Issue #1800; merged in PR #1907 (fixed by #1914).

## Problem
The Diary Room could not hold the player to their own record: deals made, stated targets, and private-versus-public statements went unreconciled.

## What shipped
- Pure `src/engine/receipts.ts` deterministically extracts candidate self-contradictions from ONLY the player's own record (deals, events they took part in, their Diary-Room statements). Three classes: `divergent-commitment` (multiple open final-two deals), `target-vote-mismatch` (stated target differs from actual vote that week), `dr-public-flip` (a DR statement contradicts a later public one). Each `Receipt` has a `summary` and `sourceEventIds`. No LLM.
- Exposed as the player-channel read `playerReceipts()` on the OOC channel (port, adapter, `registry.ts`, `McpServer.ts` dispatch, lever-manifest bullet), mirroring 0138.
- #1914 fixed `target-vote-mismatch`, which could never fire in a real game (it read `e.kind` rather than `type` and looked for a non-existent vote event): it now reads the player's ballot from `live.voteRecord`, windows the player's words between eviction results, detects a target by name plus a targeting phrase (`statesTarget()`), prints names not `npc:N`, and excludes hidden events.

## Flag
Flag `ORWELL_BOOTH_RECEIPTS`, deploy default ON; OFF makes `playerReceipts()` return `[]`. #1914 also made `/health` report flags truthfully.

## Vault Wall and anti-sycophancy
Pure over plain data with no Vault/soul/edge handle; dependency-cruiser rule `no-vault-in-receipts` plus a no-Vault-handle unit test. OOC with no NPC pathway; the engine reports, never judges.

## Tests
`tests/unit/receipts.test.ts`, `receiptsLive.test.ts` (plays a real season), `portDispatchCoverage.test.ts`, `healthFlags.test.ts`.

## Known gaps
FE tool wiring verified present for `playerReceipts` (the five C13 paths plus `orwellToolBeats.js`; see 0138). The DR-vs-public flip detector is text-heuristic.
