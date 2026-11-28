import { describe, it, expect } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { EngineCommandsAdapter } from "../../src/adapters/engine/EngineCommandsAdapter";
import { McpServer } from "../../src/adapters/mcp/McpServer";
import { PLAYER_TOOLS, PLAYER_AGENT_LEVERS } from "../../src/surfaces/tools/registry";
import { buildSandbox } from "../support/sandbox";

// ORW-419 - intent-first moves: the engine resolves the player's own move from their words BEFORE the narrator.
// Roles only. The boundary test dispatches through McpServer.callTool (the four-place wiring rule).

function started(seed: number): { s: GameSessionAdapter; here: string } {
  const s = new GameSessionAdapter();
  s.createCharacter({ playerName: "The Player", seed });
  // 0111: clear the premiere's gathered champagne-circle flag so no house event is in session (as in a real game).
  ((s as unknown as { live: { champagneCircle?: string } }).live).champagneCircle = undefined;
  s.movePlayer("backyard"); // a known starting room
  return { s, here: "backyard" };
}
const room = (s: GameSessionAdapter): string => s.whereabouts()!.room;

describe("ORW-419 resolvePlayerMove (engine)", () => {
  it("moves the player from their words and the state shows from/to", () => {
    const { s } = started(21);
    const r = s.resolvePlayerMove({ text: "I go to the kitchen" });
    expect(r.playerMove).toMatchObject({ from: "backyard", to: "kitchen" });
    expect(room(s)).toBe("kitchen");
    expect(s.getGameState().playerMove).toMatchObject({ from: "backyard", to: "kitchen" });
  });

  it("'leave the backyard' lands on the adjacent room; 'go inside' too", () => {
    const a = started(22).s;
    expect(a.resolvePlayerMove({ text: "I want to leave the backyard" }).playerMove).toMatchObject({ from: "backyard", to: "kitchen" });
    const b = started(23).s;
    expect(b.resolvePlayerMove({ text: "I go inside" }).playerMove).toMatchObject({ from: "backyard", to: "kitchen" });
  });

  it("a future / conditional phrase never moves the player and clears last turn's move", () => {
    const { s } = started(24);
    s.resolvePlayerMove({ text: "I go to the kitchen" });
    const r = s.resolvePlayerMove({ text: "I'll go to the hallway later" });
    expect(r.playerMove).toBeNull();
    expect(room(s)).toBe("kitchen");
    expect(s.getGameState().playerMove).toBeUndefined();
  });

  it("is refused in fiction during a house event: no move, presence and the clock unchanged", () => {
    const { s } = started(25);
    const live = (s as unknown as { live: { pending?: unknown; nightDepth?: number; timeOfDay?: string } }).live;
    live.pending = { kind: "eviction-vote", by: s.snapshot().house!.player.id };
    const clockBefore = JSON.stringify([live.nightDepth, live.timeOfDay]);
    const presBefore = JSON.stringify(s.whereabouts());
    const r = s.resolvePlayerMove({ text: "I go to the kitchen" });
    expect(r.playerMove).toMatchObject({ refused: true });
    expect((r.playerMove as { reason: string }).reason.length).toBeGreaterThan(5);
    expect(JSON.stringify([live.nightDepth, live.timeOfDay])).toBe(clockBefore);
    expect(JSON.stringify(s.whereabouts())).toBe(presBefore);
  });

  it("is idempotent per idempotencyKey (a repeat does not re-move or re-resolve)", () => {
    const { s } = started(26);
    const first = s.resolvePlayerMove({ text: "I go to the kitchen", idempotencyKey: "m1" });
    s.movePlayer("hallway");
    const again = s.resolvePlayerMove({ text: "I go to the kitchen", idempotencyKey: "m1" });
    expect(again).toEqual(first);
    expect(room(s)).toBe("hallway");
  });

  it("round-trips through a save", () => {
    const { s } = started(27);
    s.resolvePlayerMove({ text: "head to the kitchen" });
    const core = s.snapshot();
    const s2 = new GameSessionAdapter();
    s2.restore(core);
    expect(s2.getGameState().playerMove).toMatchObject({ from: "backyard", to: "kitchen" });
  });

  it("is null before a game starts", () => {
    expect(new GameSessionAdapter().resolvePlayerMove({ text: "I go to the kitchen" })).toEqual({ playerMove: null, whereabouts: null });
  });
});

describe("ORW-419 resolvePlayerMove (the MCP boundary)", () => {
  function server(): { server: McpServer; session: GameSessionAdapter } {
    const sb = buildSandbox(1);
    const session = new GameSessionAdapter();
    const commands = new EngineCommandsAdapter(sb.engine.events, sb.engine.knowledge);
    return { server: new McpServer("player", { player: sb.player, admin: sb.admin, summary: sb.summary, commands, session }), session };
  }
  it("is a player tool and an INFRA lever (not a model lever)", () => {
    expect(PLAYER_TOOLS.map((t) => t.name)).toContain("resolvePlayerMove");
    expect(PLAYER_AGENT_LEVERS).not.toContain("resolvePlayerMove");
  });
  it("dispatches through McpServer.callTool, moves the player, and refuses a bad shape", async () => {
    const { server: srv, session } = server();
    session.createCharacter({ playerName: "The Player", seed: 31 });
    ((session as unknown as { live: { champagneCircle?: string } }).live).champagneCircle = undefined;
    session.movePlayer("backyard");
    const res = (await srv.callTool("resolvePlayerMove", { text: "take me to the kitchen", idempotencyKey: "k1" })) as { playerMove: { from: string; to: string } };
    expect(res.playerMove).toMatchObject({ from: "backyard", to: "kitchen" });
    await expect(srv.callTool("resolvePlayerMove", {})).rejects.toThrow(/text/);
  });
});
