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

function finalThree(ctx: SeasonCtx): LiveSeasonState {
  const s = newLiveSeason([PLAYER, npc(1), npc(2)]);
  s.beat = "final-eviction"; s.hoh = npc(1);
  ctx.rel.edge(npc(1), PLAYER).threat = 0.4;
  ctx.rel.edge(npc(1), npc(2)).threat = 0.6; // npc(2) is the baseline evictee
  return s;
}
const evicted = (ctx: SeasonCtx): EntityId => {
  const s = finalThree(ctx);
  const ev = advance(s, ctx, new SeededRandom(3))!;
  return ev.participants[1]!;
};

describe("Final-3 eviction reads the HOH's memory", () => {
  it("no memory => the higher-threat rival goes (unchanged)", () => {
    expect(evicted(mk())).toBe(npc(2));
    expect(evicted(withMemory(mk(), () => 0))).toBe(npc(2));
  });
  it("a held grudge against the lower-threat rival flips the eviction; a favor to the higher-threat rival does too", () => {
    expect(evicted(withMemory(mk(), (s) => (s === PLAYER ? 0.5 : 0)))).toBe(PLAYER);
    expect(evicted(withMemory(mk(), (s) => (s === npc(2) ? -0.5 : 0)))).toBe(PLAYER);
  });
});

function vetoed(ctx: SeasonCtx): EntityId {
  const active = [PLAYER, npc(1), npc(2), npc(3), npc(4), npc(5), npc(6)];
  const s = newLiveSeason(active);
  s.beat = "eviction"; s.hoh = npc(6); s.finalNominees = [npc(1), npc(2)]; s.secretVeto = { holder: npc(1), used: false };
  ctx.rel.edge(npc(6), npc(3)).threat = 0.5;
  advance(s, ctx, new SeededRandom(3));
  return s.finalNominees!.find((n) => n !== npc(2))!;
}
describe("secret-veto replacement reads the HOH's memory", () => {
  it("no memory => the highest nomination score is named (unchanged)", () => {
    expect(vetoed(mk())).toBe(npc(3));
    expect(vetoed(withMemory(mk(), () => 0))).toBe(npc(3));
  });
  it("a held grudge against another option flips the replacement", () => {
    expect(vetoed(withMemory(mk(), (s) => (s === npc(4) ? 0.9 : 0)))).toBe(npc(4));
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

describe("the decision x source table", () => {
  it("lists both endgame decisions with their provider", () => {
    expect(DECISION_SOURCES.final3Eviction).toEqual(["endgameMemoryFor"]);
    expect(DECISION_SOURCES.secretVetoReplacement).toEqual(["endgameMemoryFor"]);
  });
});
