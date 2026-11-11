import { describe, it, expect } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { PLAYER } from "../../src/domain/ids";
import type { RelationshipModel } from "../../src/engine/relationships";
import type { GameHouse } from "../../src/engine/characterFactory";

/**
 * ORW-261 / spec 0141 - a private orientation may reach the player ONLY by the houseguest's own choice, through a pressed confide the engine let through. Roles only.
 */
type Priv = { privateOrientations: Record<string, string> };
function started(seed: number, trust: number, played = true) {
  const session = new GameSessionAdapter();
  const told: string[] = [];
  session.setOnConfide((_n, content) => { told.push(content); return true; });
  session.createCharacter({ playerName: "The Player", seed });
  const house = (session as unknown as { house: GameHouse }).house;
  const npc = house.npcs.find((n) => (n.character.hiddenElements ?? []).length > 0)!;
  (session as unknown as Priv).privateOrientations = { [npc.id]: "gay" };
  const presence = (session as unknown as { presence?: Map<string, string> }).presence;
  if (presence) { presence.set(PLAYER, "kitchen"); presence.set(npc.id, "kitchen"); }
  const rel = (session as unknown as { rel: RelationshipModel }).rel;
  for (const [a, b] of [[npc.id, PLAYER], [PLAYER, npc.id]] as const) { const e = rel.edge(a, b); e.trust = trust; e.affinity = trust; e.threat = 0.05; }
  for (let i = 0; i < 3; i++) session.makeDeal({ with: npc.id, kind: "final-two", terms: "ride or die" });
  if (played) session.noteMessage({ messageId: "first" });
  return { session, npc: npc.id, told };
}
const heard = (told: string[]) => told.some((t) => t.includes("they are gay"));
const rate = (trust: number, n = 40): number => {
  let c = 0;
  for (let seed = 1; seed <= n; seed++) { const { session, npc, told } = started(seed, trust); session.confide(npc); if (heard(told)) c++; }
  return c / n;
};

describe("ORW-261 private orientation by the houseguest's own choice", () => {
  it("a trusted player can learn it on some seeds, never on all, and the same seed reproduces it", () => {
    const r = rate(0.95);
    expect(r).toBeGreaterThan(0);
    expect(r).toBeLessThan(1);
    const a = started(5, 0.95); a.session.confide(a.npc);
    const b = started(5, 0.95); b.session.confide(b.npc);
    expect(heard(a.told)).toBe(heard(b.told));
  });
  it("a distrusting houseguest tells less often (monotone in trust)", () => {
    expect(rate(0.95)).toBeGreaterThan(rate(0.55));
    expect(rate(0.2)).toBe(0);
  });
  it("one beat, one decision: six presses never flip a hold into a tell, and a tell happens once", () => {
    for (let seed = 1; seed <= 20; seed++) {
      const { session, npc, told } = started(seed, 0.95);
      session.confide(npc);
      const first = heard(told);
      for (let i = 0; i < 5; i++) session.confide(npc);
      expect(heard(told)).toBe(first);
      expect(told.filter((t) => t.includes("they are gay")).length).toBeLessThanOrEqual(1);
    }
  });
  it("a held press hands over nothing about orientation (the result never mentions it)", () => {
    for (let seed = 1; seed <= 30; seed++) {
      const { session, npc, told } = started(seed, 0.95);
      const r = session.confide(npc)!;
      if (!heard(told)) expect(JSON.stringify(r)).not.toMatch(/gay|orientation/i);
    }
  });
  it("headless (no one playing) never tells, so calibration sims are unchanged", () => {
    for (let seed = 1; seed <= 20; seed++) {
      const { session, npc, told } = started(seed, 0.95, false);
      session.confide(npc);
      expect(heard(told)).toBe(false);
    }
  });
  it("without a press the orientation never reaches the player (no told-by fact)", () => {
    const { told } = started(3, 0.95);
    expect(told).toHaveLength(0);
  });
});

describe("ORW-261 persistence", () => {
  it("who has already told is saved with the live season, so a reload never re-tells", () => {
    for (let seed = 1; seed <= 30; seed++) {
      const { session, npc, told } = started(seed, 0.95);
      session.confide(npc);
      if (!heard(told)) continue;
      const live = (session as unknown as { live: { orientationTold?: Record<string, true> } }).live;
      expect(live.orientationTold?.[npc]).toBe(true);
      expect(JSON.parse(JSON.stringify(live)).orientationTold[npc]).toBe(true);
      return;
    }
    throw new Error("no seed produced a tell");
  });
});
