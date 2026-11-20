import { describe, it, expect } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { EngineCommandsAdapter } from "../../src/adapters/engine/EngineCommandsAdapter";
import { McpServer } from "../../src/adapters/mcp/McpServer";
import { PLAYER_TOOLS, PLAYER_AGENT_LEVERS } from "../../src/surfaces/tools/registry";
import { PLAYER } from "../../src/domain/ids";
import { buildSandbox } from "../support/sandbox";

// ORW-727b: askToTalkAlone is a MODEL-called lever, so it must be dispatchable through McpServer.callTool (the boundary static gates do not check), in the model's manifest (not INFRA_LEVERS), and shape-guarded.
describe("askToTalkAlone reaches the engine over the MCP boundary", () => {
  function playerServer(): { server: McpServer; session: GameSessionAdapter } {
    const sb = buildSandbox(1);
    const session = new GameSessionAdapter();
    const commands = new EngineCommandsAdapter(sb.engine.events, sb.engine.knowledge);
    return { server: new McpServer("player", { player: sb.player, admin: sb.admin, summary: sb.summary, commands, session }), session };
  }

  it("is on the player channel and a model lever (in the manifest, not an infrastructure seam)", () => {
    expect(PLAYER_TOOLS.map((t) => t.name)).toContain("askToTalkAlone");
    expect(PLAYER_AGENT_LEVERS).toContain("askToTalkAlone");
  });

  it("dispatches (not rejected as unavailable); before a game it returns null, with a typed result once played", async () => {
    const { server, session } = playerServer();
    expect(await server.callTool("askToTalkAlone", { npcId: "npc:1" })).toBeNull();
    session.createCharacter({ playerName: "The Player", seed: 11 });
    session.noteMessage({ messageId: "m1" });
    const live = (session as unknown as { live: Record<string, unknown> }).live;
    Object.assign(live, { champagneCircle: "done", pending: undefined, ceremony: undefined, dayNumber: 2, nightDepth: 12 });
    (session as unknown as { phase: string }).phase = "social";
    const npc = (session as unknown as { livingIds(): string[] }).livingIds().find((i) => i !== PLAYER)!;
    const edge = (session as unknown as { rel: { edge(a: string, b: string): { trust: number; affinity: number; threat: number } } }).rel.edge(npc, PLAYER);
    edge.trust = 0.9; edge.affinity = 0.9; edge.threat = 0.1;
    const res = (await server.callTool("askToTalkAlone", { npcId: npc })) as { outcome: string; room?: string };
    expect(res.outcome).toBe("accepted");
    expect(typeof res.room).toBe("string");
    expect(Object.keys(res).sort()).toEqual(["beatSeq", "outcome", "room", "roomName"]); // an outcome and a room: no number, no reason
  });

  it("refuses a malformed call at the boundary", async () => {
    const { server } = playerServer();
    await expect(server.callTool("askToTalkAlone", {})).rejects.toThrow();
    await expect(server.callTool("askToTalkAlone", { npcId: "npc:1", private: "no" })).rejects.toThrow();
    await expect(server.callTool("askToTalkAlone", { npcId: "npc:1", room: 5 })).rejects.toThrow();
  });
});
