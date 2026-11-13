import { describe, it, expect } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { EngineCommandsAdapter } from "../../src/adapters/engine/EngineCommandsAdapter";
import { McpServer } from "../../src/adapters/mcp/McpServer";
import { PLAYER_TOOLS, PLAYER_AGENT_LEVERS } from "../../src/surfaces/tools/registry";
import { validateTraits, validateCulture, cleanText } from "../../src/engine/npcMindsAuthored";
import { buildSandbox } from "../support/sandbox";
import { PLAYER } from "../../src/domain/ids";

/**
 * ORW-319 (ORW-253 slice 5, spec docs/features/0146 lanes 1-2): the cast-time model-words write-backs reach the engine through the MCP
 * boundary (the CLAUDE.md four-place rule: a write-back missing its McpServer case is dead at runtime), the engine validates every value
 * against closed sets, keeps the first record (write-once), and nothing of it reaches a player surface. Roles only.
 */
function playerServer(): { server: McpServer; session: GameSessionAdapter; npcs: string[] } {
  const sb = buildSandbox(1);
  const session = new GameSessionAdapter();
  const commands = new EngineCommandsAdapter(sb.engine.events, sb.engine.knowledge);
  const server = new McpServer("player", { player: sb.player, admin: sb.admin, summary: sb.summary, commands, session });
  session.createCharacter({ playerName: "The Player", seed: 9 });
  const npcs = session.livingIds().filter((i) => i !== PLAYER);
  return { server, session, npcs };
}
type Live = { npcMindsAuthored?: { traits?: Record<string, { habits: string[]; aimHint?: string; aimWhy?: string }>; culture?: { spots: unknown[]; rituals: unknown[]; runningJoke?: string } } };
const live = (s: GameSessionAdapter): Live => (s as unknown as { live: Live }).live;

describe("the four-place wiring", () => {
  it("both write-backs are player-channel infra (FE-driven, not model levers)", () => {
    const names = PLAYER_TOOLS.map((t) => t.name);
    for (const t of ["recordNpcTraits", "recordHouseCulture"]) {
      expect(names).toContain(t);
      expect(PLAYER_AGENT_LEVERS, "infra, so not in the model's lever manifest").not.toContain(t);
    }
  });
});

describe("lane 1: habits and an aim hint per houseguest", () => {
  it("dispatches through callTool; valid values are stored, the player and unknown ids are rejected", async () => {
    const { server, session, npcs } = playerServer();
    const res = await server.callTool("recordNpcTraits", { traits: [
      { id: npcs[0], habits: ["gym-rat", "early-riser", "gym-rat"], aimHint: "win-by-comps", aimWhy: "a former college sprinter" },
      { id: PLAYER, habits: ["napper", "devout"] },
      { id: "npc:999", habits: ["napper", "devout"] },
      { id: npcs[1], habits: ["napper"] }, // fewer than two known habits: rejected
    ] }) as { accepted: number; rejected: number };
    expect(res).toEqual({ accepted: 1, rejected: 3 });
    expect(live(session).npcMindsAuthored!.traits![npcs[0]!]).toEqual({ habits: ["gym-rat", "early-riser"], aimHint: "win-by-comps", aimWhy: "a former college sprinter" });
  });

  it("is write-once: a retry can never flip or thin a stored record", async () => {
    const { server, session, npcs } = playerServer();
    await server.callTool("recordNpcTraits", { traits: [{ id: npcs[0], habits: ["gym-rat", "early-riser"] }] });
    const again = await server.callTool("recordNpcTraits", { traits: [{ id: npcs[0], habits: ["napper", "devout"] }] }) as { accepted: number };
    expect(again.accepted).toBe(0);
    expect(live(session).npcMindsAuthored!.traits![npcs[0]!]!.habits).toEqual(["gym-rat", "early-riser"]);
  });

  it("refuses a malformed request at the boundary (not an array / no id)", async () => {
    const { server } = playerServer();
    await expect(server.callTool("recordNpcTraits", { traits: "gym" })).rejects.toThrow();
    await expect(server.callTool("recordNpcTraits", { traits: [{ habits: ["napper", "devout"] }] })).rejects.toThrow();
  });
});

describe("lane 2: house culture", () => {
  it("stores a validated culture once; invalid parts are dropped", async () => {
    const { server, session } = playerServer();
    const res = await server.callTool("recordHouseCulture", {
      spots: [{ room: "backyard", nickname: "the Deck" }, { room: "diary-room", nickname: "x" }, { room: "nowhere", nickname: "y" }],
      rituals: [{ timeOfDay: "evening", action: "cook", name: "Family Dinner" }, { timeOfDay: "evening", action: "frame", name: "plot night" }],
      runningJoke: "the missing spatula",
    }) as { accepted: boolean };
    expect(res.accepted).toBe(true);
    const c = live(session).npcMindsAuthored!.culture!;
    expect(c.spots).toEqual([{ room: "backyard", nickname: "the Deck" }]);
    expect(c.rituals).toEqual([{ timeOfDay: "evening", action: "cook", name: "Family Dinner" }]);
    expect(await server.callTool("recordHouseCulture", { runningJoke: "a new joke" })).toEqual({ accepted: false, reason: "frozen" });
  });
});

describe("validation and the wall", () => {
  it("untrusted text is cleaned; ids and number-heavy text are refused", () => {
    expect(cleanText("  a\u0007 sprinter\n ", 80)).toBe("a sprinter");
    expect(cleanText("talks to npc:4 a lot", 80)).toBeUndefined();
    expect(cleanText("code 12345", 80)).toBeUndefined();
    expect(validateTraits({ habits: ["gym-rat", "napper"], aimHint: "revenge" })).toEqual({ habits: ["gym-rat", "napper"] }); // revenge is not a cast-time aim
    expect(validateCulture({})).toBeUndefined();
  });

  it("a stored aim and joke never reach the player's state, prompt or any houseguest voice", async () => {
    const { server, session, npcs } = playerServer();
    await server.callTool("recordNpcTraits", { traits: [{ id: npcs[0], habits: ["gym-rat", "napper"], aimHint: "run-the-house", aimWhy: "zzsentinelaimzz" }] });
    await server.callTool("recordHouseCulture", { runningJoke: "zzsentineljokezz" });
    const surfaces = JSON.stringify([
      await server.callTool("getGameState", {}),
      session.getMomentPrompt({}),
      ...npcs.map((n) => session.npcVoice(n)),
    ]);
    expect(surfaces).not.toContain("zzsentinelaimzz");
    expect(surfaces).not.toContain("zzsentineljokezz");
  });
});
