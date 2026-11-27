import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { McpServer } from "../../src/adapters/mcp/McpServer";
import { PLAYER } from "../../src/domain/ids";
import { buildSandbox } from "../support/sandbox";
import type { OpenLedger } from "../../src/engine/openLedger";

/**
 * ORW-860 - the front end writes a promise typed on a turn the MODEL recorded itself as a content-only `recordInteraction` (no `kind`, no consequence) carrying the `assurance` or the typed
 * `promise`. The engine must still write the promise rows from it (the model's own scene already folded the relationship impact, so nothing is counted twice). Through
 * `McpServer.callTool`. Roles only.
 */
type S = {
  setAdvanceGateEnabled(on: boolean): void; setPromiseTermsEnabled(on: boolean): void; setAssurancesEnabled(on: boolean): void;
  setNpcBeliefsEnabled(on: boolean): void; setMemoryPromisesEnabled(on: boolean): void; setLiesCaughtEnabled(on: boolean): void;
  noteMessage(m: unknown): void; movePlayer(room: string): { present: Array<{ id: string }> } | undefined;
};
function started() {
  const sb = new GameSessionRegistry().sandboxFor(`orw860-${Math.random()}`);
  sb.session.createCharacter({ playerName: "The Player", archetype: "floater", seed: 7 });
  sb.session.advanceGame(); sb.session.advanceGame();
  const g = sb.session as unknown as S;
  (sb.session as unknown as { live: { playedGame?: boolean } }).live.playedGame = true;
  g.setAdvanceGateEnabled(false); g.setAssurancesEnabled(true); g.setNpcBeliefsEnabled(true); g.setMemoryPromisesEnabled(true); g.setLiesCaughtEnabled(true); g.setPromiseTermsEnabled(true);
  g.noteMessage({ messageId: "m1" });
  const present = g.movePlayer("living-room")!.present.map((p) => p.id).filter((i) => i !== PLAYER);
  const npc = present[0]!;
  const b = buildSandbox(1);
  const server = new McpServer("player", { player: b.player, admin: b.admin, summary: b.summary, commands: sb.commands, session: sb.session });
  return { sb, npc, server };
}
const ledger = (e: ReturnType<typeof started>) => (e.sb.session.snapshot() as unknown as { openLedger?: OpenLedger }).openLedger?.entries ?? [];
const rows = (e: ReturnType<typeof started>) => ((e.sb.session.snapshot().live as { assurances?: { items: { from: string; to: string; kind: string; source: string; status: string }[] } }).assurances?.items ?? []);

describe("a kind-less recordInteraction carrying a promise (ORW-860)", () => {
  it("writes the casual assurance to the houseguest it was said to", async () => {
    const e = started();
    await e.server.callTool("recordInteraction", { initiator: PLAYER, witnessSet: [PLAYER, e.npc], content: "You're safe with me this week.", assurance: { kind: "safe" } });
    expect(rows(e)).toHaveLength(1);
    expect(rows(e)[0]).toMatchObject({ from: PLAYER, to: e.npc, kind: "safe", source: "player", status: "open" });
  });

  it("writes the typed promise as a termed entry and its assurance row", async () => {
    const e = started();
    await e.server.callTool("recordInteraction", { initiator: PLAYER, witnessSet: [PLAYER, e.npc], content: "I won't put you up.", promise: { what: "no-nominate" } });
    expect(ledger(e)).toHaveLength(1);
    expect(ledger(e)[0]!.term).toMatchObject({ by: PLAYER, to: e.npc, what: "no-nominate" });
    expect(rows(e)).toHaveLength(1);
  });
});
