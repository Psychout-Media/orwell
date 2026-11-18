import { describe, it, expect } from "vitest";
import { atCommit } from "../support/commitFold";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import { BOND, type BondStore } from "../../src/engine/bondRecord";

/**
 * ORW-609 (widened): a recorded scene carries its REAL actor. The same act done by the player to a houseguest and by a houseguest to the player (or another houseguest) moves the same stores
 * with the roles substituted; a houseguest who acts is the one the witnesses sour toward and the one remembered, never the player. Roles only.
 */
type Internals = { live: { active: string[]; bonds?: BondStore }; bondReader(): unknown; setBondRecordEnabled(on: boolean): void; setBondRatesEnabled(on: boolean): void };
type Ledger = Record<string, Record<string, { kind: string; severity: number }[]>>;
function start(n: string, seed = 3) {
  const sb = new GameSessionRegistry().sandboxFor(`g609p-${n}-${seed}`);
  sb.session.createCharacter({ playerName: "The Player", seed });
  const s = sb.session as unknown as Internals;
  s.setBondRecordEnabled(true);
  s.setBondRatesEnabled(false); // pins the flat BASE fold; ORW-605 has its own file
  sb.session.noteMessage({ messageId: "m1" });
  const [A, B, C] = s.live.active.filter((x) => x.startsWith("npc:")) as [string, string, string];
  (sb.session as unknown as { presence: Map<string, string> }).presence = new Map([[PLAYER, "kitchen"], [A, "kitchen"], [B, "kitchen"], [C, "kitchen"]]);
  const rel = sb.engine.relationships;
  const memory = (holder: string, subject: string) => ((sb.session.snapshot().live as { npcMemory?: Ledger }).npcMemory?.[holder]?.[subject] ?? []).map((e) => ({ kind: e.kind, severity: e.severity }));
  const act = (initiator: string, witnessSet: string[], kind: string) =>
    sb.commands.recordInteraction({ initiator, witnessSet, content: "a scene", kind: kind as never } as never);
  return { sb, s, A, B, C, rel, memory, act };
}

describe("the same act moves the same stores whoever does it", () => {
  for (const kind of ["conflict", "betrayal", "bonding"]) {
    it(`${kind}: the player to a houseguest and a houseguest to a houseguest (the player watching) write the same memory and move the same edge the same way`, () => {
      const p = start(`p-${kind}`), n = start(`n-${kind}`);
      const pBefore = p.rel.edge(p.A, PLAYER).trust, nBefore = n.rel.edge(n.A, n.B).trust;
      p.act(PLAYER, [PLAYER, p.A], kind);
      n.act(n.B, [n.B, n.A, PLAYER], kind);
      expect(n.memory(n.A, n.B)).toEqual(p.memory(p.A, PLAYER)); // the one acted upon remembers the ACTOR, with the same kind and weight
      expect(n.memory(n.A, PLAYER)).toEqual([]); // and never the player, who only watched
      const dP = p.rel.edge(p.A, PLAYER).trust - pBefore, dN = n.rel.edge(n.A, n.B).trust - nBefore;
      expect(Math.sign(dN)).toBe(Math.sign(dP));
      expect(dP).not.toBe(0);
    });
  }
  it("bond record: the recipient's view of the actor moves by the full weight, the actor's view by the share, in either direction of the player", () => {
    const p = start("bp"), n = start("bn");
    p.act(PLAYER, [PLAYER, p.A], "conflict"); atCommit(p.s).bondReader();
    n.act(n.A, [n.A, PLAYER], "conflict"); atCommit(n.s).bondReader();
    const toPlayer = p.s.live.bonds![`${p.A}|${PLAYER}`]!, byPlayer = p.s.live.bonds![`${PLAYER}|${p.A}`]!;
    const toNpc = n.s.live.bonds![`${PLAYER}|${n.A}`]!, byNpc = n.s.live.bonds![`${n.A}|${PLAYER}`]!;
    expect(toNpc.resentment).toBeCloseTo(toPlayer.resentment, 12);
    expect(toNpc.resentment).toBeCloseTo(BOND.resentPerConflict, 12);
    expect(byNpc.resentment).toBeCloseTo(byPlayer.resentment, 12);
  });
});

describe("a houseguest who wrongs the player is the one blamed", () => {
  it("witnesses sour toward the houseguest, not the player, and the scene is remembered against the houseguest", () => {
    const g = start("blame");
    const toActor = g.rel.edge(g.B, g.A).trust, toPlayer = g.rel.edge(g.B, PLAYER).trust, playerView = g.rel.edge(PLAYER, g.A).trust;
    g.act(g.A, [g.A, g.B, PLAYER], "betrayal");
    expect(g.rel.edge(g.B, g.A).trust).toBeLessThan(toActor); // a witness's view of the actor drops
    expect(g.rel.edge(g.B, PLAYER).trust).toBe(toPlayer); // the wronged player is not blamed
    expect(g.rel.edge(PLAYER, g.A).trust).toBeLessThan(playerView); // the player-side view of the actor drops
    expect(g.memory(g.B, g.A).map((m) => m.kind)).toEqual(["scene-betrayal"]);
    expect(g.memory(g.A, PLAYER)).toEqual([]);
    expect(g.memory(g.B, PLAYER)).toEqual([]);
  });
  it("a houseguest who acted is a witness of their own scene even when the caller left them out", () => {
    const g = start("witness");
    const { eventId } = g.act(g.A, [g.B, PLAYER], "conflict");
    const ev = ((g.sb.session as unknown as { record: { events(): { id: string; witnessSet: string[]; initiator: string }[] } }).record.events()).find((e) => e.id === eventId)!;
    expect(ev.initiator).toBe(g.A);
    expect(ev.witnessSet).toContain(g.A);
  });
  it("an unknown actor is refused, never trusted", () => {
    const g = start("unknown");
    expect(() => g.act("npc:9999", ["npc:9999", PLAYER], "conflict")).toThrow();
  });
  it("a warm scene the player shares with a houseguest eases that houseguest's grudge against the player; a clash does not", () => {
    const ease = (kind: string) => {
      const g = start(`repair-${kind}`);
      const gs = g.s as unknown as { live: { week: number; grudges?: Record<string, { eased: number }> }; grudgeOf(h: string, s: string): unknown };
      (gs.live as { npcMemory?: unknown }).npcMemory = { [g.A]: { [PLAYER]: [{ kind: "deal-broken", week: gs.live.week, severity: 0.8 }] } };
      atCommit(gs).grudgeOf(g.A, PLAYER); const before = gs.live.grudges![`${g.A}|${PLAYER}`]!.eased;
      g.act(PLAYER, [PLAYER, g.A], kind);
      atCommit(gs).grudgeOf(g.A, PLAYER); return { before, after: gs.live.grudges![`${g.A}|${PLAYER}`]!.eased };
    };
    const warm = ease("bonding"), clash = ease("conflict");
    expect(warm.after).toBeGreaterThan(warm.before);
    expect(clash.after).toBe(clash.before);
  });
});

describe("the wall", () => {
  it("a houseguest-acted scene reaches no player, admin or prompt surface as a kind or an actor field", async () => {
    const g = start("wall");
    g.act(g.A, [g.A, g.B, PLAYER], "conflict"); atCommit(g.s).bondReader();
    const dump = JSON.stringify([
      await g.sb.mcp.admin.callTool("inspectNonVaultState", {}),
      await g.sb.mcp.player.callTool("getGameState", {}),
      (g.s as unknown as { getMomentPrompt(a: unknown): { systemPrompt: string } }).getMomentPrompt({ moment: "social" }).systemPrompt,
    ]);
    for (const w of ["interactionKind", "peakResentment", "\"bonds\"", "\"actor\""]) expect(dump).not.toContain(w);
  });
});
