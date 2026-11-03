# 0138 - The Player Dossier

> **Retrospective note (written 2026-11-03, issue #1938).** This feature shipped flag-gated before any spec existed; this documents what was actually built from the merged code, not a forward design. Issue #1793; merged in PR #1901.

## Problem
The player's Diary-Room reads on each houseguest (0013/0113 DR) were a flat journal; there was no way to recall everything one wrote about a single person.

## What shipped
- New player-channel read tool `playerDossier` (optional `subjectId` focus): the player's own Diary-Room reads grouped per houseguest. DR entries can now optionally carry the houseguest they concern.
- Seams: `GameSession` port method + adapter read, `EngineCommands`/`KnowledgeService` (incl. `InMemoryKnowledgeService`), `registry.ts` `PLAYER_TOOLS`, `McpServer.ts` `requireShape` guard + `callTool` dispatch, and a bullet in the master-prompt lever manifest (`momentPrompts.ts`).
- Flag visibility added to `/health`.

## Flag
Flag `ORWELL_PLAYER_DOSSIER`, deploy default ON.

## Vault Wall and anti-sycophancy
Returns only the player's own words, never engine truth or hidden state (`readsVault: false`). Diary Room stays OOC with no NPC pathway.

## Tests
`tests/unit/playerDossier.test.ts` (6 cases: grouping, filtering, feature boundary, privacy), `portDispatchCoverage.test.ts`, lever-manifest test.

## Known gaps
None open. FE wiring verified present for `playerDossier`: `tool_schemas.py`, `agent_tools.py`, `orwell_engine.py`, `tool_execution.py`, `tool_implementations.py` (`do_player_dossier`), plus `orwellToolBeats.js` (landed after #1901, which touched no `frontend/` files).
