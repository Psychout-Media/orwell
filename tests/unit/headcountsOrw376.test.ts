import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import type { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { headcountLines, MOMENT_PROMPTS } from "../../src/engine/momentPrompts";
import { resolvePending } from "../../features/support/answerPending";

/** ORW-376: the engine hands the narrator the headcounts, the player INCLUDED. Roles only. */
let n = 0;
function fresh(seed = 1): GameSessionAdapter {
  const s = new GameSessionRegistry().sandboxFor(`hc376-${n++}`).session;
  s.createCharacter({ playerName: "P", seed });
  return s;
}
function driveTo(pred: (s: GameSessionAdapter) => boolean): GameSessionAdapter {
  for (let seed = 1; seed <= 40; seed++) {
    const s = fresh(seed);
    for (let i = 0; i < 4000; i++) {
      const v = s.advanceGame();
      if (pred(s)) return s;
      if (v.pending) resolvePending(v.pending, (req) => void s.submitDecision(req));
      if (v.finished) break;
    }
  }
  throw new Error("never");
}

describe("whereabouts.counts (engine)", () => {
  it("room counts the player: room = others + 1, and the house includes the player", () => {
    const s = driveTo((ss) => ss.getGameState().phase === "nominations");
    const wa = s.whereabouts()!;
    expect(wa.counts).toBeDefined();
    expect(wa.counts!.others).toBe(wa.present.length);
    expect(wa.counts!.room).toBe(wa.present.length + 1);
    const living = s.livingIds().length;
    expect(wa.counts!.house).toBe(living);
    expect(wa.counts!.voters).toBeUndefined();
  });

  it("voters on eviction night = house - HOH - nominees, correct after an eviction (not 16)", () => {
    const s = driveTo((ss) => ss.getGameState().pending?.kind === "eviction-vote");
    const gs = s.getGameState();
    const c = s.whereabouts()!.counts!;
    const off = new Set([gs.ceremony.hoh!.id, ...gs.ceremony.nominees.map((x) => x.id)]);
    expect(c.voters).toBe(s.livingIds().filter((id) => !off.has(id)).length);
    expect(c.voters).toBe(c.house - 3);
    // a later week: after at least one eviction the voter count is no longer the week-one number
    const later = driveTo((ss) => ss.getGameState().pending?.kind === "eviction-vote" && ss.livingIds().length < 15);
    const lc = later.whereabouts()!.counts!;
    expect(lc.house).toBeLessThan(16);
    expect(lc.voters).toBe(lc.house - 3);
  });

  it("is a read: whereabouts() twice leaves the state identical (digest)", () => {
    const s = driveTo((ss) => ss.getGameState().phase === "nominations");
    const a = JSON.stringify(s.getGameState());
    s.whereabouts(); s.whereabouts();
    expect(JSON.stringify(s.getGameState())).toBe(a);
  });

  it("carries no Vault field: counts holds only the numeric keys (ORW-386 adds asleep)", () => {
    const s = driveTo((ss) => ss.getGameState().phase === "nominations");
    expect(Object.keys(s.whereabouts()!.counts!).sort().every((k) => ["room", "others", "house", "voters", "asleep"].includes(k))).toBe(true);
  });
});

describe("the prompt states the count, player included", () => {
  it("headcountLines: 'N people, you included (you + M houseguests)'", () => {
    const l = headcountLines({ counts: { room: 4, others: 3, house: 12, voters: 9 } }).join("\n");
    expect(l).toContain("In this room: 4 people, you included (you + 3 houseguests)");
    expect(l).toContain('"all of us" means 4');
    expect(l).toContain("In the house: 12 people remain, you included");
    expect(l).toContain("Voting tonight: 9 people");
    expect(l).toMatch(/NEVER count the room yourself/);
  });

  it("the live hard-constraints block carries it, matching the engine", () => {
    const s = driveTo((ss) => ss.getGameState().phase === "nominations");
    const wa = s.whereabouts()!;
    const hc = s.getMomentPrompt({}).hardConstraints ?? "";
    expect(hc).toContain(`In this room: ${wa.counts!.room} people, you included`);
  });

  it("the vote moment prompt no longer hard-codes a house of 16", () => {
    const all = JSON.stringify(MOMENT_PROMPTS);
    expect(all).not.toMatch(/the house is 16/);
  });

  it("renderHardConstraints is unchanged when the view has no counts", () => {
    expect(headcountLines(null)).toEqual([]);
    expect(headcountLines({})).toEqual([]);
  });
});
