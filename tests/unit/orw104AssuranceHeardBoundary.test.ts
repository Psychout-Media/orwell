import { describe, it, expect } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { EngineCommandsAdapter } from "../../src/adapters/engine/EngineCommandsAdapter";
import { McpServer } from "../../src/adapters/mcp/McpServer";
import { buildSandbox } from "../support/sandbox";
import { PLAYER, npc } from "../../src/domain/ids";

/** ORW-104 - the FE-sent `assurance` / `heardAboutMe` descriptors cross the MCP boundary: well-formed ones reach the engine's recordInteraction intact, malformed ones are refused. Roles only. */
describe("ORW-104 - recordInteraction accepts assurance / heardAboutMe through McpServer.callTool", () => {
  function setup() {
    const sb = buildSandbox(1);
    const commands = new EngineCommandsAdapter(sb.engine.events, sb.engine.knowledge);
    const seen: unknown[] = [];
    const orig = commands.recordInteraction.bind(commands);
    commands.recordInteraction = ((req: Parameters<typeof orig>[0]) => { seen.push(req); return orig(req); }) as typeof orig;
    const server = new McpServer("player", { player: sb.player, admin: sb.admin, summary: sb.summary, commands, session: new GameSessionAdapter() });
    return { server, seen };
  }
  const base = { initiator: PLAYER, witnessSet: [PLAYER, npc(1), npc(2)], content: "A scene." };

  it("dispatches a well-formed assurance and heardAboutMe to the engine", async () => {
    const { server, seen } = setup();
    await server.callTool("recordInteraction", { ...base, assurance: { kind: "safe" }, heardAboutMe: { nature: "targeting", from: npc(1) } });
    const req = seen[0] as { assurance?: unknown; heardAboutMe?: unknown };
    expect(req.assurance).toEqual({ kind: "safe" });
    expect(req.heardAboutMe).toEqual({ nature: "targeting", from: npc(1) });
  });

  it("refuses malformed ones at the boundary", async () => {
    const { server } = setup();
    await expect(server.callTool("recordInteraction", { ...base, assurance: { kind: "bribe" } })).rejects.toThrow(/assurance/);
    await expect(server.callTool("recordInteraction", { ...base, heardAboutMe: { nature: "gossip" } })).rejects.toThrow(/heardAboutMe/);
    await expect(server.callTool("recordInteraction", { ...base, heardAboutMe: { nature: "betrayal", from: "bad" } })).rejects.toThrow(/heardAboutMe/);
  });
});
