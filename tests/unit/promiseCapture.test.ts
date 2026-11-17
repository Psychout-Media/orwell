import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { McpServer } from "../../src/adapters/mcp/McpServer";
import { PLAYER } from "../../src/domain/ids";
import { buildSandbox } from "../support/sandbox";
import type { OpenLedger } from "../../src/engine/openLedger";

/**
 * ORW-586 / 0187 slice 3 - the typed `promise` on a recorded scene (what the front-end scene belt extracts from the PLAYER'S OWN typed words) reaches the engine over the MCP boundary
 * (`McpServer.callTool`, the four-place rule), becomes a termed open-ledger entry plus its assurance row, and is judged by the engine at the nominations. A malformed promise is ignored,
 * never an error. Flag off: byte-identical (the scene's own casual assurance still stands). Roles only.
 */
type S = {
  setAdvanceGateEnabled(on: boolean): void; setPromiseTermsEnabled(on: boolean): void; setAssurancesEnabled(on: boolean): void;
  setNpcBeliefsEnabled(on: boolean): void; setMemoryPromisesEnabled(on: boolean): void; setLiesCaughtEnabled(on: boolean): void;
  assuranceNominated(h: string, n: string): void; assuranceKeptAtNominations(h: string, ns: readonly string[]): void;
  noteMessage(m: unknown): void; movePlayer(room: string): { present: Array<{ id: string }> } | undefined;
};
function started(flag = true) {
  const sb = new GameSessionRegistry().sandboxFor(`pc-${Math.random()}`);
  sb.session.createCharacter({ playerName: "The Player", archetype: "floater", seed: 7 });
  sb.session.advanceGame(); sb.session.advanceGame();
  const g = sb.session as unknown as S;
  (sb.session as unknown as { live: { playedGame?: boolean } }).live.playedGame = true;
  g.setAdvanceGateEnabled(false); g.setAssurancesEnabled(true); g.setNpcBeliefsEnabled(true); g.setMemoryPromisesEnabled(true); g.setLiesCaughtEnabled(true); g.setPromiseTermsEnabled(flag);
  g.noteMessage({ messageId: "m1" });
  const present = g.movePlayer("living-room")!.present.map((p) => p.id).filter((i) => i !== PLAYER);
  const [npc, other] = present as [string, string];
  const b = buildSandbox(1);
  const server = new McpServer("player", { player: b.player, admin: b.admin, summary: b.summary, commands: sb.commands, session: sb.session });
  return { sb, g, npc, other, server };
}
const ledger = (e: ReturnType<typeof started>) => (e.sb.session.snapshot() as unknown as { openLedger?: OpenLedger }).openLedger?.entries ?? [];
const rows = (e: ReturnType<typeof started>) => ((e.sb.session.snapshot().live as { assurances?: { items: { from: string; to: string; kind: string; status: string }[] } }).assurances?.items ?? []);

describe("recordInteraction.promise", () => {
  it("a typed no-nominate promise by the player writes a termed entry and ONE assurance row, judged by the engine at the nominations", async () => {
    const e = started();
    await e.server.callTool("recordInteraction", { initiator: PLAYER, witnessSet: [PLAYER, e.npc], content: "I swore I would not nominate them", kind: "alliance", promise: { what: "no-nominate" }, assurance: { kind: "loyal" } });
    const entries = ledger(e);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.term).toMatchObject({ by: PLAYER, to: e.npc, what: "no-nominate" });
    expect(rows(e)).toHaveLength(1); // the scene's own assurance is not written twice
    e.g.assuranceKeptAtNominations(PLAYER, [e.other]);
    expect(ledger(e)[0]!.status).toBe("kept");
    expect(rows(e)[0]!.status).toBe("kept");
  });
  it("a broken typed promise is judged broken by the engine (the model never rules)", async () => {
    const e = started();
    await e.server.callTool("recordInteraction", { initiator: PLAYER, witnessSet: [PLAYER, e.npc], content: "x", kind: "alliance", promise: { what: "no-nominate" } });
    e.g.assuranceNominated(PLAYER, e.npc);
    expect(ledger(e)[0]!.status).toBe("broken");
  });
  it("an NPC's promise to the player is written with the NPC as promiser", async () => {
    const e = started();
    await e.server.callTool("recordInteraction", { initiator: PLAYER, witnessSet: [PLAYER, e.npc], content: "x", kind: "alliance", promise: { what: "no-evict-vote", from: e.npc } });
    expect(ledger(e)[0]!.term).toMatchObject({ by: e.npc, to: PLAYER, what: "no-evict-vote" });
  });
  it("a bad shape is refused with a typed field at the boundary; an unknown `what` or id is ignored by the engine and the scene still records", async () => {
    const e = started();
    await expect(e.server.callTool("recordInteraction", { initiator: PLAYER, witnessSet: [PLAYER, e.npc], content: "x", promise: "no-nominate" })).rejects.toThrow(/promise/);
    await expect(e.server.callTool("recordInteraction", { initiator: PLAYER, witnessSet: [PLAYER, e.npc], content: "x", promise: { what: "" } })).rejects.toThrow(/promise/);
    const r = (await e.server.callTool("recordInteraction", { initiator: PLAYER, witnessSet: [PLAYER, e.npc], content: "x", kind: "alliance", promise: { what: "bogus" } })) as { eventId: string };
    expect(r.eventId).toBeTruthy();
    await e.server.callTool("recordInteraction", { initiator: PLAYER, witnessSet: [PLAYER, e.npc], content: "y", kind: "alliance", promise: { what: "no-nominate", subject: "npc:999" } });
    expect(ledger(e)).toHaveLength(0);
  });
  it("flag off: no entry, and the scene's own assurance still stands (byte-identical to today)", async () => {
    const e = started(false);
    await e.server.callTool("recordInteraction", { initiator: PLAYER, witnessSet: [PLAYER, e.npc], content: "x", kind: "alliance", promise: { what: "no-nominate" }, assurance: { kind: "loyal" } });
    expect(ledger(e)).toHaveLength(0);
    expect(rows(e)).toHaveLength(1);
  });
  it("an idempotent retry does not duplicate the promise", async () => {
    const e = started();
    const a = { initiator: PLAYER, witnessSet: [PLAYER, e.npc], content: "x", kind: "alliance", promise: { what: "no-nominate" }, idempotencyKey: "k-pc" };
    await e.server.callTool("recordInteraction", a); await e.server.callTool("recordInteraction", a);
    expect(ledger(e)).toHaveLength(1); expect(rows(e)).toHaveLength(1);
  });
});
