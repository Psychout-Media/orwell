import { describe, it, expect } from "vitest";
import { buildSandbox } from "../support/sandbox";
import { EngineCommandsAdapter } from "../../src/adapters/engine/EngineCommandsAdapter";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { McpServer } from "../../src/adapters/mcp/McpServer";
import { toolsFor } from "../../src/surfaces/tools/registry";
import type { OutwardChannel } from "../../src/surfaces/tools/registry";
import { PLAYER, npc } from "../../src/domain/ids";

function sampleArgs(name: string): Record<string, unknown> {
  switch (name) {
    case "createCharacter": return { playerName: "The Player", seed: 7 };
    case "getGameState": return {};
    case "gameStatus": return {};
    case "getMomentPrompt": return { moment: "nominations" };
    case "getVisibleStateFor": return { entity: PLAYER };
    case "renderScene": return { mode: "scene" };
    case "askProducers": return { question: "is it true?" };
    case "recordInteraction": return { initiator: PLAYER, witnessSet: [PLAYER, npc(1)], content: "chat" };
    case "runCompetition": return { type: "endurance" };
    case "surfaceInformationTo": return { entity: PLAYER, fact: { content: "x" }, pathway: "told-by:npc:1" };
    case "inspectNonVaultState": return { query: "all" };
    case "overrideMechanic": return { mechanic: "pace", value: 1 };
    case "npcVoice": return { id: npc(1) };
    default: return {};
  }
}

describe("MCP tool boundary — every tool is Vault-free across seeds", () => {
  it("no player or admin tool ever returns a Vault sentinel", async () => {
    for (let seed = 1; seed <= 25; seed++) {
      const sb = buildSandbox(seed);
      const commands = new EngineCommandsAdapter(sb.engine.events, sb.engine.knowledge);
      const session = new GameSessionAdapter();
      const deps = { player: sb.player, admin: sb.admin, summary: sb.summary, commands, session };

      for (const channel of ["player", "admin/God Mode"] as OutwardChannel[]) {
        const server = new McpServer(channel, deps);
        expect(server.listTools()).toEqual(toolsFor(channel));
        for (const t of server.listTools()) {
          // E31 default-deny arg shapes: a typed refusal is a legitimate, Vault-free outcome —
          // the property then asserts the refusal MESSAGE itself carries no sentinel either.
          const blob = await server.callTool(t.name, sampleArgs(t.name)).then(
            (out) => JSON.stringify(out),
            (err: unknown) => String((err as Error).message ?? err),
          );
          // A tool must return a JSON value: `undefined` serializes to nothing, which once crashed this
          // sweep mid-loop (#1901 playerDossier) and left every later tool unscanned. Name the tool.
          expect(blob, `seed ${seed} tool ${t.name} returned undefined (no JSON) — unscannable`).toBeTypeOf("string");
          for (const s of sb.sentinels) {
            expect(blob.includes(s), `seed ${seed} tool ${t.name} leaked ${s}`).toBe(false);
          }
        }
      }
    }
  });

  it("channels are isolated — a player server cannot call an admin tool", async () => {
    const sb = buildSandbox(1);
    const commands = new EngineCommandsAdapter(sb.engine.events, sb.engine.knowledge);
    const session = new GameSessionAdapter();
    const player = new McpServer("player", { player: sb.player, admin: sb.admin, summary: sb.summary, commands, session });
    await expect(player.callTool("inspectNonVaultState", { query: "all" })).rejects.toThrow();
  });
});
