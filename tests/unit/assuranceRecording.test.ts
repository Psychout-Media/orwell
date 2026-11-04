import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { McpServer } from "../../src/adapters/mcp/McpServer";
import { PLAYER } from "../../src/domain/ids";
import { buildSandbox } from "../support/sandbox";

/**
 * B4 slice 2 - a casual assurance ("you're safe with me") rides on a RECORDED scene (`recordInteraction.assurance`), so only a recorded assurance exists to the engine. Dispatched
 * THROUGH `McpServer.callTool` (the four-place boundary rule: a write-back with the port + adapter done but the MCP guard/dispatch missing is dead at runtime). Behind
 * ORWELL_ASSURANCES (default OFF): off => nothing recorded, byte-identical state. Roles only.
 */
function started(on: boolean) {
  const sb = new GameSessionRegistry().sandboxFor(`asr-${on}-${Math.random()}`);
  sb.session.createCharacter({ playerName: "The Player", archetype: "floater", seed: 7 });
  sb.session.advanceGame(); sb.session.advanceGame();
  sb.session.setAssurancesEnabled(on);
  const npc = [...sb.session.livingIds()].find((id) => id !== PLAYER)!;
  (sb.session as unknown as { presence: Map<string, string> }).presence = new Map([[PLAYER, "kitchen"], [npc, "kitchen"]]); // seat them together so the scene is grounded (co-presence)
  const server = new McpServer("player", { player: buildSandbox(1).player, admin: buildSandbox(1).admin, summary: buildSandbox(1).summary, commands: sb.commands, session: sb.session });
  return { sb, npc, server };
}
const items = (s: ReturnType<typeof started>["sb"]["session"]) => ((s.snapshot().live as { assurances?: { items: { from: string; to: string; kind: string; source: string; status: string }[] } }).assurances?.items ?? []);

describe("recordInteraction.assurance", () => {
  it("records the player's assurance to the NPC it was made to, through the MCP boundary", async () => {
    const e = started(true);
    await e.server.callTool("recordInteraction", { initiator: PLAYER, witnessSet: [PLAYER, e.npc], content: "I tell them they are safe with me", kind: "alliance", assurance: { kind: "safe" } });
    const got = items(e.sb.session);
    expect(got.length, JSON.stringify(got)).toBe(1);
    expect(got[0]).toMatchObject({ from: PLAYER, to: e.npc, kind: "safe", source: "player", status: "open" });
  });
  it("an NPC's assurance to the player is recorded with source npc (from = the named speaker)", async () => {
    const e = started(true);
    await e.server.callTool("recordInteraction", { initiator: PLAYER, witnessSet: [PLAYER, e.npc], content: "they swear they have my vote", kind: "alliance", assurance: { kind: "vote", from: e.npc, sincerity: 0.3 } });
    expect(items(e.sb.session)).toEqual([expect.objectContaining({ from: e.npc, to: PLAYER, kind: "vote", source: "npc" })]);
  });
  it("is OFF by default behaviour: with the flag off nothing is recorded", async () => {
    const e = started(false);
    await e.server.callTool("recordInteraction", { initiator: PLAYER, witnessSet: [PLAYER, e.npc], content: "safe with me", kind: "alliance", assurance: { kind: "safe" } });
    expect(items(e.sb.session)).toEqual([]);
  });
  it("refuses a malformed descriptor with a typed field name", async () => {
    const e = started(true);
    await expect(e.server.callTool("recordInteraction", { initiator: PLAYER, witnessSet: [PLAYER, e.npc], content: "x", assurance: "safe" })).rejects.toThrow(/assurance/);
    await expect(e.server.callTool("recordInteraction", { initiator: PLAYER, witnessSet: [PLAYER, e.npc], content: "x", assurance: { kind: "bogus" } })).rejects.toThrow(/assurance/);
  });
  it("one recorded scene records one assurance (an idempotent retry does not duplicate)", async () => {
    const e = started(true);
    const args = { initiator: PLAYER, witnessSet: [PLAYER, e.npc], content: "safe with me", kind: "alliance", assurance: { kind: "safe" }, idempotencyKey: "k-asr" };
    await e.server.callTool("recordInteraction", args); await e.server.callTool("recordInteraction", args);
    expect(items(e.sb.session).length).toBe(1);
  });
});
