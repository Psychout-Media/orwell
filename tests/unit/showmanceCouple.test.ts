import { describe, it, expect } from "vitest";
import { nominationPlan, nominationTermVals, NOMINATION_TERM_NAMES } from "../../src/engine/season";
import { RelationshipModel } from "../../src/engine/relationships";
import { ATTRACTION } from "../../src/engine/attraction";
import { GameSessionRegistry } from "../../src/composition/registry";
import type { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import type { GameEvent } from "../../src/domain/event";

/** 0207 Theme A, A2 (ORW-659): the couple is a target. Roles only. */
const HOH = "npc:1", X = "npc:2", Y = "npc:3";
const ids = [HOH, X, Y, "npc:4", "npc:5", "npc:6", "npc:7"];
function rel(): RelationshipModel {
  const r = new RelationshipModel(0.5);
  for (const a of ids) for (const b of ids) if (a !== b) { const e = r.edge(a, b); e.trust = 0.5; e.affinity = 0.5; e.threat = 0.3; }
  return r;
}

describe("the couple term is a real, named, bounded nomination term", () => {
  it("is a named term; absent it is exactly zero and the plan is unchanged", () => {
    expect(NOMINATION_TERM_NAMES).toContain("couple"); // ORW-694: "standing" is now appended after it
    const r = rel();
    const vals = nominationTermVals(HOH, X, r, 0.5, [], {});
    expect(vals.length, "the target read: every named term but the two pawn-seat ones").toBe(NOMINATION_TERM_NAMES.length - 2);
    for (const t of ids.slice(1)) expect(nominationTermVals(HOH, t, r, 0.5, [], { couplePush: () => 0 })).toEqual(nominationTermVals(HOH, t, r, 0.5, [], {}));
    expect(nominationPlan(HOH, ids, r, { couplePush: () => 0 })).toEqual(nominationPlan(HOH, ids, r, {}));
  });
  it("moves the block toward the pushed one, more as the push grows, and is bounded by the foundation's constant", () => {
    const r = rel();
    r.edge(HOH, X).threat = 0.2;
    r.edge(HOH, X).threat = 0.3 + ATTRACTION.coupleNomPush * 0.5 - 0.0;
    r.edge(HOH, "npc:4").threat = 0.3 + ATTRACTION.coupleNomPush * 0.5 + 0.01;
    expect(nominationPlan(HOH, ids, r, {}).target).toBe("npc:4");
    expect(nominationPlan(HOH, ids, r, { couplePush: (t) => (t === X ? ATTRACTION.coupleNomPush : 0) }).target).toBe(X);
    expect(ATTRACTION.coupleNomPush).toBeLessThanOrEqual(0.25);
  });
});

type Priv = {
  live: { active: string[]; playedGame?: boolean };
  perceivedBond(h: string, a: string, b: string): number;
  couplePushFor(t: string, h: string): number;
  romanceSeenBy(h: string, a: string, b: string): boolean;
  setRecordProviders(p: { events: () => GameEvent[]; hidden: () => [] }): void;
  rel: RelationshipModel;
};
let n = 0;
function played(flag = true): { s: GameSessionAdapter; p: Priv; ids: string[]; events: GameEvent[] } {
  const sb = new GameSessionRegistry().sandboxFor(`showmance-a2-${n++}`);
  sb.session.setShowmancesEnabled(flag);
  sb.session.createCharacter({ playerName: "The Player", seed: 7 } as never);
  sb.session.noteMessage({ messageId: "m0" });
  const p = sb.session as unknown as Priv;
  const events: GameEvent[] = [];
  p.setRecordProviders({ events: () => events, hidden: () => [] });
  return { s: sb.session, p, ids: p.live.active.filter((i) => i !== "player"), events };
}
const romance = (id: string, a: string, b: string, extra: Partial<GameEvent> = {}): GameEvent =>
  ({ id, ts: 1, type: "showmance", initiator: a, witnessSet: [a, b], hidden: true, content: "x", baseContent: "x", ...extra } as GameEvent);

describe("the reader's real own-view read can reach the couple bar (ORW-636 funnel: the bar sat above the read's ceiling)", () => {
  it("an HOH who watched a pair's romance scenes, with NO stubbed bond, reads them as a couple and pushes the bigger threat; one scene is not enough", () => {
    const { p, ids: pp, events } = played();
    const [h, a, b] = pp as [string, string, string];
    p.rel.edge(h, a).threat = 0.6; p.rel.edge(h, b).threat = 0.3;
    events.push(romance("q1", a, b, { houseLife: { action: "flirt", seenBy: [h] } as never }));
    expect(p.couplePushFor(a, h), "one watched scene: a flirtation, not yet a couple").toBe(0);
    events.push(romance("q2", a, b, { houseLife: { action: "cuddle", seenBy: [h] } as never }), romance("q3", a, b, { houseLife: { action: "flirt", seenBy: [h] } as never }));
    expect(p.perceivedBond(h, a, b)).toBeLessThan(ATTRACTION.coupleBondAtLeast); // the generic bar is above what an own-view read can ever reach
    expect(p.couplePushFor(a, h)).toBeGreaterThan(0);
    expect(p.couplePushFor(b, h)).toBe(0);
  });
});

describe("a couple is read only from what the reader saw or was told", () => {
  it("an HOH who caught the romance and sees the pair's bond pushes the bigger threat of the two, and not the other", () => {
    const { p, ids: pp, events } = played();
    const [h, a, b] = pp as [string, string, string];
    p.perceivedBond = () => 0.9;
    events.push(romance("r1", a, b, { houseLife: { action: "flirt", seenBy: [h] } as never }));
    p.rel.edge(h, a).threat = 0.6; p.rel.edge(h, b).threat = 0.3;
    expect(p.couplePushFor(a, h)).toBeGreaterThan(0);
    expect(p.couplePushFor(a, h)).toBeLessThanOrEqual(ATTRACTION.coupleNomPush);
    expect(p.couplePushFor(b, h)).toBe(0);
    p.rel.edge(h, a).threat = 0.3; p.rel.edge(h, b).threat = 0.6;
    expect(p.couplePushFor(b, h)).toBeGreaterThan(0);
    expect(p.couplePushFor(a, h)).toBe(0);
  });
  it("a romance nobody caught is no couple (the truth is not read); a pair the HOH reads as strangers is no couple", () => {
    const { p, ids: pp, events } = played();
    const [h, a, b, c] = pp as [string, string, string, string];
    p.perceivedBond = () => 0.9;
    events.push(romance("r2", a, b)); // hidden, h not in it and did not watch
    expect(p.romanceSeenBy(h, a, b)).toBe(false);
    expect(p.couplePushFor(a, h) + p.couplePushFor(b, h)).toBe(0);
    events.push(romance("r3", a, b, { houseLife: { action: "flirt", seenBy: [h] } as never }));
    expect(p.romanceSeenBy(h, a, b), "watched from the room counts").toBe(true);
    expect(p.romanceSeenBy(c, a, b), "someone else did not").toBe(false);
    p.perceivedBond = () => 0.4; // two warm scenes watched: under the own-view bar
    p.rel.edge(h, a).threat = 0.9;
    expect(p.couplePushFor(a, h)).toBe(0);
  });
  it("an HOH inside the pair, or the player as HOH, or the flag off, or a headless game, never pushes", () => {
    const { p, ids: pp, events } = played();
    const [h, a, b] = pp as [string, string, string];
    p.perceivedBond = () => 0.9;
    events.push(romance("r4", a, b, { houseLife: { action: "flirt", seenBy: [h] } as never }));
    p.rel.edge(a, b).threat = 0.9;
    expect(p.couplePushFor(b, a), "the partner is not a target to their own half").toBe(0);
    expect(p.couplePushFor(a, "player")).toBe(0);
    const off = played(false);
    off.p.perceivedBond = () => 0.9;
    off.events.push(romance("r5", off.ids[1]!, off.ids[2]!, { houseLife: { action: "flirt", seenBy: [off.ids[0]!] } as never }));
    off.p.rel.edge(off.ids[0]!, off.ids[1]!).threat = 0.9;
    expect(off.p.couplePushFor(off.ids[1]!, off.ids[0]!)).toBe(0);
    const headless = new GameSessionRegistry().sandboxFor(`showmance-a2-h-${n++}`);
    headless.session.createCharacter({ playerName: "The Player", seed: 7 } as never);
    expect((headless.session as unknown as Priv).couplePushFor("npc:2", "npc:1")).toBe(0);
  });
  it("nothing about the pair, the push or the reading reaches the player or admin surfaces", async () => {
    const sb = new GameSessionRegistry().sandboxFor(`showmance-a2-wall-${n++}`);
    sb.session.createCharacter({ playerName: "The Player", seed: 7 } as never);
    sb.session.noteMessage({ messageId: "m0" });
    for (let i = 0; i < 3; i++) sb.session.advanceGame({});
    const blob = JSON.stringify([await sb.mcp.player.callTool("getGameState", {}), await sb.mcp.player.callTool("gameStatus", {}), await sb.mcp.player.callTool("getMomentPrompt", {}), await sb.mcp.admin.callTool("inspectNonVaultState", {})]);
    expect(/couplePush|readsAsCouple|coupleNom/i.test(blob)).toBe(false);
  });
});
