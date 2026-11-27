import { describe, it, expect } from "vitest";
import { newLiveSeason, advance, type SeasonCtx, type LiveSeasonState } from "../../src/engine/liveSeason";
import { RelationshipModel } from "../../src/engine/relationships";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER, npc } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";
import { DECISION_SOURCES } from "../../src/engine/memorySources";
import type { MemoryEntry } from "../../src/engine/npcMemory";

/**
 * ORW-87 (B7 remainder) - the NPC final HOH's Final-3 eviction and the secret-veto replacement read the NPC memory ledger through `ctx.endgameMemoryFor`
 * (ORWELL_ENDGAME_MEMORY, played games only). Both ways: a held grudge/favor flips the pick; no provider (or a 0 tilt) => the pre-existing threat order. Roles only.
 */
const mk = (): SeasonCtx => ({ player: PLAYER, statsOf: () => ({ physical: 0.5, mental: 0.5, social: 0.5 }), rel: new RelationshipModel(0.5) });
const withMemory = (ctx: SeasonCtx, tilt: (s: EntityId, d: EntityId) => number): SeasonCtx => ({ ...ctx, endgameMemoryFor: tilt });

/** `playerThreat` is the HOH's read of the player; npc(2) is read at 0.6, so with no memory the higher-threat npc(2) goes. The memory values below stay inside what the ledger can really return (`memoryTiltFor`: a grudge <= 0.15, a favor >= -0.06). */
function finalThree(ctx: SeasonCtx, playerThreat = 0.5): LiveSeasonState {
  const s = newLiveSeason([PLAYER, npc(1), npc(2)]);
  s.beat = "final-eviction"; s.hoh = npc(1);
  ctx.rel.edge(npc(1), PLAYER).threat = playerThreat;
  ctx.rel.edge(npc(1), npc(2)).threat = 0.6; // npc(2) is the baseline evictee
  return s;
}
const evicted = (ctx: SeasonCtx, playerThreat = 0.5): EntityId => {
  const s = finalThree(ctx, playerThreat);
  const ev = advance(s, ctx, new SeededRandom(3))!;
  return ev.participants[1]!;
};

describe("Final-3 eviction reads the HOH's memory", () => {
  it("no memory => the higher-threat rival goes (unchanged)", () => {
    expect(evicted(mk())).toBe(npc(2));
    expect(evicted(withMemory(mk(), () => 0))).toBe(npc(2));
  });
  it("a held grudge (at most 0.15) against a near-tied rival flips the eviction; a real favor (at most 0.06) to the higher-threat rival does too", () => {
    expect(evicted(withMemory(mk(), (s) => (s === PLAYER ? 0.15 : 0)), 0.5)).toBe(PLAYER); // 0.5 + 0.15 = 0.65 > 0.6
    expect(evicted(withMemory(mk(), (s) => (s === npc(2) ? -0.06 : 0)), 0.55)).toBe(PLAYER); // 0.6 - 0.06 = 0.54 < 0.55
    expect(evicted(withMemory(mk(), (s) => (s === PLAYER ? 0.15 : 0)), 0.4), "a memory this small does not override a wide threat gap").toBe(npc(2));
  });
});

function vetoed(ctx: SeasonCtx): EntityId {
  const active = [PLAYER, npc(1), npc(2), npc(3), npc(4), npc(5), npc(6)];
  const s = newLiveSeason(active);
  s.beat = "eviction"; s.hoh = npc(6); s.finalNominees = [npc(1), npc(2)]; s.secretVeto = { holder: npc(1), used: false };
  ctx.rel.edge(npc(6), npc(3)).threat = 0.5;
  ctx.rel.edge(npc(6), npc(4)).threat = 0.4; // npc(4) trails npc(3) by 0.1: within reach of a real grudge (<= 0.15)
  advance(s, ctx, new SeededRandom(3));
  return s.finalNominees!.find((n) => n !== npc(2))!;
}
describe("secret-veto replacement reads the HOH's memory", () => {
  it("no memory => the highest nomination score is named (unchanged)", () => {
    expect(vetoed(mk())).toBe(npc(3));
    expect(vetoed(withMemory(mk(), () => 0))).toBe(npc(3));
  });
  it("a held grudge (within the ledger's 0.15) against a near-tied option flips the replacement", () => {
    expect(vetoed(withMemory(mk(), (s) => (s === npc(4) ? 0.15 : 0)))).toBe(npc(4));
  });
});

describe("the adapter's endgame memory provider (ORWELL_ENDGAME_MEMORY)", () => {
  type G = { endgameMemoryFor(s: string, d: string): number; setEndgameMemoryEnabled(on: boolean): void; live: { playedGame?: boolean; week: number; npcMemory?: Record<string, Record<string, MemoryEntry[]>> } };
  function started() {
    const sb = new GameSessionRegistry().sandboxFor(`egm-${Math.random()}`);
    sb.session.createCharacter({ playerName: "The Player", archetype: "floater", seed: 7 });
    sb.session.advanceGame(); sb.session.advanceGame();
    const [h, c] = [...sb.session.livingIds()].filter((i) => i !== PLAYER);
    const g = sb.session as unknown as G;
    g.live.npcMemory = { [h!]: { [c!]: [{ kind: "deal-broken", week: g.live.week, severity: 1 }] } };
    return { g, holder: h!, cand: c! };
  }
  it("is 0 for a game nobody is playing (headless stays byte-identical), on for a played game, bounded, never for the player, and 0 when off", () => {
    const { g, holder, cand } = started();
    g.live.playedGame = false;
    expect(g.endgameMemoryFor(cand, holder)).toBe(0);
    g.live.playedGame = true;
    const t = g.endgameMemoryFor(cand, holder);
    expect(t).toBeGreaterThan(0); // a held grudge tilts toward acting against
    expect(t).toBeLessThanOrEqual(1);
    expect(g.endgameMemoryFor(cand, PLAYER)).toBe(0);
    g.setEndgameMemoryEnabled(false);
    expect(g.endgameMemoryFor(cand, holder)).toBe(0);
  });
});

describe("the adapter's own ctx carries the endgame memory into the live loop", () => {
  type A = {
    live: { week: number; playedGame?: boolean; npcMemory?: Record<string, Record<string, MemoryEntry[]>> };
    setNpcMemoryEnabled(on: boolean): void; setEndgameMemoryEnabled(on: boolean): void;
    ctx(): { endgameMemoryFor?: (s: EntityId, d: EntityId) => number; memoryTiltFor?: (s: EntityId, h: EntityId) => number };
  };
  function played() {
    const sb = new GameSessionRegistry().sandboxFor(`egm-ctx-${Math.random()}`);
    sb.session.createCharacter({ playerName: "The Player", archetype: "floater", seed: 7 });
    sb.session.advanceGame(); sb.session.advanceGame();
    const g = sb.session as unknown as A;
    const [holder, cand] = sb.session.livingIds().filter((i) => i !== PLAYER);
    g.setNpcMemoryEnabled(true); g.setEndgameMemoryEnabled(true);
    g.live.playedGame = true;
    g.live.npcMemory = { [holder!]: { [cand!]: [{ kind: "deal-broken", week: g.live.week, severity: 1 }] } };
    return { g, holder: holder!, cand: cand! };
  }
  it("the ctx the loop reads carries the provider (removing the wiring turns this red), a real grudge stays inside the ledger's own bound, and switching it off drops it", () => {
    const { g, holder, cand } = played();
    const c = g.ctx();
    expect(typeof c.endgameMemoryFor, "the loop gets the endgame memory").toBe("function");
    const tilt = c.endgameMemoryFor!(cand, holder);
    expect(tilt).toBeGreaterThan(0);
    expect(tilt, "a real grudge is small - the unit tests above use values this size").toBeLessThanOrEqual(0.15);
    g.setEndgameMemoryEnabled(false);
    expect(g.ctx().endgameMemoryFor).toBeUndefined();
  });
});

describe("the decision x source table", () => {
  it("lists both endgame decisions with their provider", () => {
    expect(DECISION_SOURCES.final3Eviction).toEqual(["endgameMemoryFor", "promiseFinalTwoFor"]);
    // ORW-581: a played game's secret-veto replacement goes through the full replacement read (the endgame memory still among its sources)
    expect(DECISION_SOURCES.secretVetoReplacement).toContain("endgameMemoryFor");
    expect(DECISION_SOURCES.secretVetoReplacement).toEqual(["campaignPushFor", "memoryTiltFor", "beliefTiltFor", "moodTiltFor", "drivePushFor", "feelingKeepFor", "endgameMemoryFor", "dealNomPushFor", "tieNomPushFor", "pitchTiltFor", "assuranceProtects", "couplePushFor", "standingPushFor"]); // ORW-694 B1-9: the house's informal leader is a bigger target in the replacement read too
  });
});
