import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import type { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { headcountLines, MOMENT_PROMPTS } from "../../src/engine/momentPrompts";
import { resolvePending } from "../../features/support/answerPending";
import { PLAYER } from "../../src/domain/ids";

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

/**
 * ORW-447: once the player is out (jury house / watching) they are no longer in the house: `house` and `voters` count only the people still in it.
 * Built the way leftPlayerNeverScheduleHeld does it: an eviction-night state with the player put into the eviction order (still seated in presence,
 * the moment of their own eviction), restored, then read. While the player is in, the ORW-376 counts are unchanged.
 */
describe("whereabouts.counts after the player is evicted (ORW-447)", () => {
  function evictionNightPlayerVoting(): GameSessionAdapter {
    return driveTo((ss) => {
      const gs = ss.getGameState();
      return gs.pending?.kind === "eviction-vote" && gs.ceremony.hoh?.id !== PLAYER && !gs.ceremony.nominees.some((x) => x.id === PLAYER);
    });
  }
  function evictPlayer(s: GameSessionAdapter): void {
    const core = JSON.parse(JSON.stringify(s.snapshot())) as { live: { evictionOrder: string[]; active: string[] } };
    core.live.evictionOrder.push(PLAYER);
    core.live.active = core.live.active.filter((id) => id !== PLAYER);
    s.restore(core as never);
  }

  it("house and voters exclude the evicted player", () => {
    const s = evictionNightPlayerVoting();
    const before = s.whereabouts()!.counts!;
    evictPlayer(s);
    expect(s.livingIds()).toContain(PLAYER); // livingIds() itself is unchanged (many callers)
    const c = s.whereabouts()!.counts!;
    const gs = s.getGameState();
    const off = new Set([gs.ceremony.hoh!.id, ...gs.ceremony.nominees.map((x) => x.id)]);
    expect(c.house).toBe(s.livingIds().filter((id) => id !== PLAYER).length);
    expect(c.house).toBe(before.house - 1);
    expect(c.voters).toBe(s.livingIds().filter((id) => id !== PLAYER && !off.has(id)).length);
    expect(c.voters).toBe(before.voters! - 1);
  });

  it("while the player is in, the player is still counted in house and voters (ORW-376 unchanged)", () => {
    const s = evictionNightPlayerVoting();
    const c = s.whereabouts()!.counts!;
    const gs = s.getGameState();
    const off = new Set([gs.ceremony.hoh!.id, ...gs.ceremony.nominees.map((x) => x.id)]);
    expect(s.livingIds()).toContain(PLAYER);
    expect(c.house).toBe(s.livingIds().length);
    expect(c.voters).toBe(s.livingIds().filter((id) => !off.has(id)).length);
    expect(c.voters).toBe(c.house - 3);
  });
});
