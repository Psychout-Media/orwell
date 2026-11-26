import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { McpServer } from "../../src/adapters/mcp/McpServer";
import { PLAYER } from "../../src/domain/ids";
import { buildSandbox } from "../support/sandbox";

/**
 * ORW-860 - a casual promise the player gave a houseguest ("you're safe with me") is kept where the narrator reads (the open ledger, shown in the brief
 * while that houseguest is here), not only in the assurance ledger. With only the assurance row the houseguest was re-asked as if nothing had been given
 * whenever the separate open-ledger extraction skipped it. Real engine, through the MCP boundary, no model. Roles only.
 */
function started() {
  const sb = new GameSessionRegistry().sandboxFor(`pab-${Math.random()}`);
  sb.session.createCharacter({ playerName: "The Player", archetype: "floater", seed: 7 });
  sb.session.advanceGame(); sb.session.advanceGame();
  (sb.session as unknown as { live: { playedGame?: boolean } }).live.playedGame = true;
  sb.session.setAssurancesEnabled(true);
  const npc = [...sb.session.livingIds()].find((id) => id !== PLAYER)!;
  (sb.session as unknown as { presence: Map<string, string> }).presence = new Map([[PLAYER, "kitchen"], [npc, "kitchen"]]);
  const server = new McpServer("player", { player: buildSandbox(1).player, admin: buildSandbox(1).admin, summary: buildSandbox(1).summary, commands: sb.commands, session: sb.session });
  return { sb, npc, server };
}
type Item = { speaker: string; kind: string; parties: string[]; text: string };
const here = (s: ReturnType<typeof started>["sb"]["session"]) => (s as unknown as { openLedgerHere(): Item[] }).openLedgerHere();

describe("the player's casual promise reaches the brief's open ledger", () => {
  it("a recorded assurance by the player is an open-ledger promise to that houseguest, once", async () => {
    const e = started();
    await e.server.callTool("recordInteraction", { initiator: PLAYER, witnessSet: [PLAYER, e.npc], content: "I tell them they are safe with me", kind: "alliance", assurance: { kind: "safe" } });
    const mine = here(e.sb.session).filter((i) => i.speaker === PLAYER && i.kind === "promise" && i.parties.includes(e.npc));
    expect(mine.length, JSON.stringify(here(e.sb.session))).toBe(1);
    await e.server.callTool("recordInteraction", { initiator: PLAYER, witnessSet: [PLAYER, e.npc], content: "I swear it again, safe with me", kind: "alliance", assurance: { kind: "safe" } });
    expect(here(e.sb.session).filter((i) => i.speaker === PLAYER && i.kind === "promise" && i.parties.includes(e.npc)).length).toBe(1);
  });
  it("a houseguest's own assurance to the player is not turned into a player promise", async () => {
    const e = started();
    await e.server.callTool("recordInteraction", { initiator: PLAYER, witnessSet: [PLAYER, e.npc], content: "they swear they have my vote", kind: "alliance", assurance: { kind: "vote", from: e.npc } });
    expect(here(e.sb.session).filter((i) => i.speaker === PLAYER).length).toBe(0);
  });
});
