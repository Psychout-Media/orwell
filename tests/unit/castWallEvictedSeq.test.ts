import { describe, it, expect } from "vitest";
import { PLAYER } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";
import { McpServer } from "../../src/adapters/mcp/McpServer";
import { EngineCommandsAdapter } from "../../src/adapters/engine/EngineCommandsAdapter";
import { buildSandbox } from "../support/sandbox";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";

/**
 * ORW-641: the cast wall orders the departed latest-out first, so the public state read carries each
 * departed houseguest's 1-based place in the public eviction order (absent while in the house).
 * Dispatched through McpServer.callTool, the player channel's real door. Roles only.
 */
type S = { live: { evictionOrder: EntityId[] }; livingIds(): EntityId[] };

describe("the public state read carries the eviction place (ORW-641)", () => {
  it("present only for the departed, in eviction order, never a hidden value", async () => {
    const sb = buildSandbox(1);
    const session = new GameSessionAdapter();
    const commands = new EngineCommandsAdapter(sb.engine.events, sb.engine.knowledge);
    const server = new McpServer("player", { player: sb.player, admin: sb.admin, summary: sb.summary, commands, session });
    session.createCharacter({ playerName: "The Player", seed: 3, archetype: "floater" });
    const s = session as unknown as S;
    const [first, second, stays] = s.livingIds().filter((i) => i !== PLAYER) as [EntityId, EntityId, EntityId];
    s.live.evictionOrder.push(first, second);
    const view = (await server.callTool("getGameState", {})) as { house: Array<{ id: string; evictedSeq?: number }>; player: { evictedSeq?: number } };
    const seq = (id: string) => view.house.find((h) => h.id === id)!.evictedSeq;
    expect(seq(first)).toBe(1);
    expect(seq(second)).toBe(2);
    expect(seq(stays)).toBeUndefined();
    expect(view.player.evictedSeq).toBeUndefined();
  });
});
