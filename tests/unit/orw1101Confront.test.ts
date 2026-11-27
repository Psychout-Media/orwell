import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { PLAYER } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";

/**
 * ORW-1101 (audit 11-27 A9): `confront` landed for ANY houseguest with ANY learned fact (no subject check), left no trace (no event, no fold, no memory) and could be repeated for free, a misfire stacking another betrayal
 * each time. Now: a fact about someone else is refused (null, like any non-learned fact); a landed confrontation is a recorded scene the confronted houseguest was in; one confrontation per (houseguest, fact, phase) and a
 * repeat answers what the first did without a second scene or a second betrayal. Roles only.
 */
beforeEach(() => GameSessionAdapter.setGossipConsequenceEnabled(true));
afterEach(() => GameSessionAdapter.setGossipConsequenceEnabled(null));
type Rel = { rel: { edge: (a: EntityId, b: EntityId) => { trust: number } } };
function start(tag: string) {
  const sb = new GameSessionRegistry().sandboxFor(`orw1101-${tag}`);
  sb.session.createCharacter({ playerName: "The Player", seed: 1 });
  const [a, b] = sb.session.snapshot().house!.npcs.map((n) => n.id);
  const seen: Array<{ text: string; w: EntityId[] }> = [];
  (sb.session as unknown as { onPlayerEvent: (t: string, w: EntityId[]) => string }).onPlayerEvent = (text, w) => { seen.push({ text, w }); return "e"; };
  const seed = (npc: EntityId, factId: string, distortion: number, confidence: number) => sb.engine.knowledge.seedBelief(PLAYER, { content: `word is ${npc} is scheming`, factId, subject: npc, distortion, confidence }, "witnessed");
  return { sb, a: a!, b: b!, seen, seed, trust: (x: EntityId) => (sb.session as unknown as Rel).rel.edge(x, PLAYER).trust };
}

describe("ORW-1101: confront", () => {
  it("a fact about someone else is refused; the houseguest it is about is confronted", () => {
    const t = start("subject");
    t.seed(t.a, "fact:about-a", 0, 1);
    expect(t.sb.session.confront(t.b, "fact:about-a"), "not the fact's subject").toBeNull();
    expect(t.seen).toHaveLength(0);
    expect(t.sb.session.confront(t.a, "fact:about-a")).toEqual({ landed: true });
  });
  it("a landed confrontation is a recorded scene with the confronted houseguest in it, and a repeat in the same phase is a no-op", () => {
    const t = start("trace");
    t.seed(t.a, "fact:trace", 0, 1);
    expect(t.sb.session.confront(t.a, "fact:trace")).toEqual({ landed: true });
    expect(t.seen).toHaveLength(1);
    expect(t.seen[0]!.w).toEqual([PLAYER, t.a]);
    expect(t.seen[0]!.text, "the scene names no fact").not.toMatch(/scheming|fact:/);
    expect(t.sb.session.confront(t.a, "fact:trace")).toEqual({ landed: true });
    expect(t.seen, "no second scene").toHaveLength(1);
  });
  it("a misfire stacks no second betrayal on a repeat", () => {
    const t = start("misfire");
    t.seed(t.a, "fact:bad", 3, 0.35); // materially distorted (past the floor, under the ceiling)
    const before = t.trust(t.a);
    expect(t.sb.session.confront(t.a, "fact:bad")).toEqual({ landed: false });
    const once = t.trust(t.a);
    expect(once).toBeLessThan(before);
    expect(t.sb.session.confront(t.a, "fact:bad")).toEqual({ landed: false });
    expect(t.trust(t.a), "the repeat folds nothing more").toBe(once);
  });
});
