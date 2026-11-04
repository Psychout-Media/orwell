import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { GameSession } from "../../src/ports/GameSession";
import type { EngineCommands } from "../../src/ports/EngineCommands";
import { PLAYER_TOOLS, ADMIN_TOOLS, DEBUG_VAULT_TOOL_NAMES } from "../../src/surfaces/tools/registry";
import { INFRA_TOOL_NAMES } from "../../src/adapters/mcp/McpServer";

/**
 * TCG-16 — the "four-place write-back" wiring gotcha (CLAUDE.md's own build brief) keeps recurring: a
 * port method ships fully implemented in the adapter (steps 1-2) but is never added to the registry
 * allowlist or given a `McpServer.callTool` dispatch case (steps 3-4), so it is DEAD at runtime with
 * nothing failing — dependency-cruiser only checks Vault edges, and the lever-manifest drift test only
 * checks prose. `worldSnapshotView` (BE-103) is the latest confirmed instance, found only by a manual
 * audit pass, not by any test. This file is the standing structural gate the audit (TCG-16) asked for:
 * it walks EVERY method on the `GameSession`/`EngineCommands` ports and proves each is BOTH (a)
 * registered on an outward tool allowlist and (b) has a real dispatch case in `McpServer.callTool` — so
 * the NEXT `worldSnapshotView`-shaped gap fails `npm test`, not a future audit.
 *
 * TypeScript has no runtime reflection over an `interface` (no `keyof` survives to runtime). The
 * `Record<keyof T, true>` literals below are the practical substitute: TypeScript itself refuses to
 * compile this file if the port GAINS or LOSES a method and this list is not updated in lockstep (a
 * missing key is a compile error; an extra/unknown key is also a compile error) — an even EARLIER gate
 * than a failing test, since `npm run typecheck` runs before a single test executes.
 */

// Every current GameSession port method, exhaustively — TS errors if this drifts from the interface.
const GAME_SESSION_METHODS: Record<keyof GameSession, true> = {
  accuseTie: true, advanceGame: true, cancelSelfEviction: true, raiseSpectatorChoice: true, competitionStagingView: true,
  askJuror: true, confide: true, confront: true,
  createCharacter: true, dailyRecap: true,
  exposeSecret: true, finaleView: true, formAlliance: true, gameStatus: true, getGameState: true,
  getMomentPrompt: true, recallSceneMemories: true, getOffscreenSceneSkeletons: true, getPortraitPrompt: true, joinAlliance: true,
  makeDeal: true, markHouseguestMet: true, movePlayer: true, npcVoice: true, playerTagline: true,
  preSeedCast: true, preSeedNextSeason: true, premiereIntros: true, producerVaultDump: true,
  recordCastGenesis: true, recordCastIdentity: true, recordCastProfile: true, recordCompetitionFiction: true, recordHouseguestMove: true,
  notorietySummary: true,
  playerDossier: true,
  playerReceipts: true,
  recordOffscreenSceneTexture: true, recordWorldSnapshot: true, recordProducerProfile: true, requestSelfEviction: true,
  runCompetition: true, sealedFromHouse: true, knowledgeScopeManifest: true, seasonRecap: true, seasonRetrospective: true,
  socialInitiatives: true, stateDelta: true, submitDecision: true, tradeSecret: true, turnIn: true, hangOut: true,
  updateCasting: true, whereabouts: true, worldSnapshotView: true,
};

// Every current EngineCommands port method, exhaustively — same TS-enforced drift guard.
const ENGINE_COMMANDS_METHODS: Record<keyof EngineCommands, true> = {
  recordInteraction: true, surfaceInformationTo: true, diaryRoom: true, recordImageBeat: true,
};

/**
 * A handful of port methods dispatch under a DIFFERENT outward tool name than the method itself — a
 * deliberate boundary-naming choice, not a gap. These are the ONLY sanctioned exceptions to "method name
 * === tool name"; anything not listed here is expected to be dispatched under its own literal name.
 */
const TOOL_NAME_OVERRIDE: Partial<Record<string, string>> = {
  movePlayer: "moveTo",                       // the player-facing verb the FE/model calls
  recordHouseguestMove: "moveHouseguest",     // ADR 0009's narrated-NPC-relocation verb
  producerVaultDump: "producerVault",         // the quarantined DEBUG_VAULT_TOOLS name (mandate #2)
};

/**
 * Port methods that have NO outward tool — they exist on the port interface but are not
 * exposed as a callable MCP tool (they may be consumed internally, or the spec deliberately
 * voices their result through an always-on context block instead of a callable lever).
 * The drift guard skips these for tool-registration and dispatch checks.
 */
const PORT_ONLY_METHODS: ReadonlySet<string> = new Set([
  "notorietySummary",  // #1791: voiced through the always-on RETURNING CAST context block
]);

/**
 * Read `McpServer.ts`'s source and collect every `case "<name>":` inside the `callTool` method's OWN
 * switch — never `requireShape`'s separate switch, which only shape-guards args and can legitimately
 * list (or omit) a name independent of whether a dispatch case exists. Scoping to `callTool` is what
 * actually proves a tool is reachable, not merely arg-shape-validated. A textual source scan (rather
 * than invoking `callTool` with synthetic args) sidesteps every tool's own required-argument shape,
 * which would otherwise make a bare `{}` call fail at `requireShape` before ever reaching the switch —
 * telling us nothing about whether a dispatch case exists.
 */
function dispatchedToolNames(): Set<string> {
  const src = readFileSync(join(__dirname, "../../src/adapters/mcp/McpServer.ts"), "utf8");
  const start = src.indexOf("async callTool(");
  if (start === -1) throw new Error("McpServer.callTool not found — has it been renamed?");
  const end = src.indexOf("unhandled tool", start);
  if (end === -1) throw new Error("McpServer.callTool's default/unhandled-tool branch not found");
  const body = src.slice(start, end);
  const names = new Set<string>();
  for (const m of body.matchAll(/case\s+"([^"]+)"\s*:/g)) names.add(m[1]!);
  return names;
}

describe("TCG-16 — every GameSession/EngineCommands port method is reachable end to end", () => {
  const allToolNames = new Set<string>([
    ...PLAYER_TOOLS.map((t) => t.name),
    ...ADMIN_TOOLS.map((t) => t.name),
    ...DEBUG_VAULT_TOOL_NAMES,
    ...INFRA_TOOL_NAMES,
  ]);
  const dispatched = dispatchedToolNames();
  const allMethods = [...Object.keys(GAME_SESSION_METHODS), ...Object.keys(ENGINE_COMMANDS_METHODS)];
  const allMethodsWithTool = allMethods.filter((m) => !PORT_ONLY_METHODS.has(m));

  it.each(allMethodsWithTool)("%s is registered on an outward tool allowlist (the missing-#3 half of BE-103)", (method) => {
    const toolName = TOOL_NAME_OVERRIDE[method] ?? method;
    expect(
      allToolNames.has(toolName),
      `"${method}" (tool "${toolName}") is not in PLAYER_TOOLS, ADMIN_TOOLS, or DEBUG_VAULT_TOOLS`,
    ).toBe(true);
  });

  it.each(allMethodsWithTool)("%s has a real McpServer.callTool dispatch case (the missing-#4 half of BE-103)", (method) => {
    const toolName = TOOL_NAME_OVERRIDE[method] ?? method;
    expect(
      dispatched.has(toolName),
      `"${method}" (tool "${toolName}") has no case "${toolName}": in McpServer.callTool's switch — it would throw "unhandled tool" at runtime`,
    ).toBe(true);
  });

  it("every ADVERTISED player/admin/debug tool name also has a dispatch case (catches drift the OTHER way)", () => {
    // A name registered in PLAYER_TOOLS/ADMIN_TOOLS/DEBUG_VAULT_TOOLS with no dispatch case hits
    // callTool's `default: throw new Error("unhandled tool ...")` at runtime — the exact silent-death
    // shape this gate exists to catch, independent of which port (if any) backs the tool.
    for (const name of allToolNames) {
      expect(dispatched.has(name), `tool "${name}" is registered but McpServer.callTool has no case for it`).toBe(true);
    }
  });
});
