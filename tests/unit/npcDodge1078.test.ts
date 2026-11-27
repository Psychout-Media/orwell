import { describe, it, expect } from "vitest";
import { playedGame } from "../support/playedGame";
import { PLAYER, type EntityId } from "../../src/domain/ids";
import type { DodgeFact } from "../../src/engine/dodging";

/** ORW-1078 (Ryne 2026-11-26): houseguests dodge each other's awkward questions, with the same rules as dodging the player. Roles only. */
interface Inside {
  npcDodge(p: { actor: EntityId; kind: string; with: EntityId[] }, key: string): DodgeFact | undefined;
  rel: { edge(a: EntityId, b: EntityId): { trust: number } };
  dodgeLog: unknown[];
  house: { npcs: { id: EntityId }[] };
}
function game() {
  const g = playedGame({ seed: 3 });
  for (let i = 0; i < 5; i++) g.turn();
  const x = g.s as unknown as Inside;
  const [a, b] = x.house.npcs.map((n) => n.id) as [EntityId, EntityId];
  return { g, x, a, b };
}
const share = (x: Inside, actor: EntityId, asked: EntityId): number => Array.from({ length: 400 }, (_, i) => x.npcDodge({ actor, kind: "confront", with: [asked] }, `k${i}`)).filter(Boolean).length / 400;

describe("a houseguest confronted by another may dodge", () => {
  it("they dodge more the less they trust the asker, and the decision is the player-press one (an approach, a carriage, whether they hand it back)", () => {
    const { x, a, b } = game();
    x.rel.edge(b, a).trust = 0.05;
    const cold = share(x, a, b);
    x.rel.edge(b, a).trust = 0.95;
    const warm = share(x, a, b);
    expect(cold).toBeGreaterThan(warm + 0.15);
    expect(warm).toBeGreaterThan(0.2);
    expect(cold).toBeLessThan(0.9);
    const one = Array.from({ length: 40 }, (_, i) => x.npcDodge({ actor: a, kind: "confront", with: [b] }, `s${i}`)).find(Boolean)!;
    expect(Object.keys(one).sort()).toEqual(["approach", "openness", "pushesBack"]);
    expect(x.npcDodge({ actor: a, kind: "confront", with: [b] }, "same")).toEqual(x.npcDodge({ actor: a, kind: "confront", with: [b] }, "same"));
  });
  it("only a confrontation between two houseguests, and the player's own dodge log is untouched", () => {
    const { x, a, b } = game();
    expect(share(x, a, b)).toBeGreaterThan(0);
    for (const k of ["gossip", "check-in", "pitch"]) expect(x.npcDodge({ actor: a, kind: k, with: [b] }, "k1")).toBeUndefined();
    expect(x.npcDodge({ actor: a, kind: "confront", with: [PLAYER] }, "k1")).toBeUndefined();
    expect(x.npcDodge({ actor: PLAYER, kind: "confront", with: [b] }, "k1")).toBeUndefined();
    expect(x.dodgeLog).toHaveLength(0);
  });
  it("in play, confrontations between houseguests are recorded with their dodges", () => {
    let dodged = 0, confronts = 0;
    for (const seed of [1, 2, 3, 4]) {
      const g = playedGame({ seed });
      try { g.playUntil(() => (g.s.getGameState() as { week?: number }).week! >= 4, 3000, "week 4"); } catch { /* the season may end first */ }
      for (const e of g.sb.engine.events.queryAll() as ReadonlyArray<{ houseLife?: { action: string; dodge?: unknown }; witnessSet: readonly string[]; hidden: boolean }>) {
        if (e.houseLife?.action !== "confront" || e.witnessSet.includes(PLAYER)) continue;
        confronts++;
        if (e.houseLife.dodge) { dodged++; expect(e.hidden).toBe(true); }
      }
    }
    expect(confronts, "houseguests confront each other in play").toBeGreaterThan(5);
    expect(dodged).toBeGreaterThan(0);
    expect(dodged).toBeLessThan(confronts);
  }, 600_000);
});
