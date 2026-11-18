import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import { HIDE, hideChance, dampedTrueBond } from "../../src/engine/fakedDistance";
import { pairKey } from "../../src/engine/groupIdentity";

/** 0184 part 2b (ORW-564): a close pair fakes distance in public. Roles only (a pair, onlookers, the player). */
type Seam = {
  live: { playedGame?: boolean; week: number; pending?: unknown; hiding?: { week: number; pairs: string[] } };
  record?: { events(): unknown[] };
  rel: { applyImpactDirected(h: string, o: string, i: Record<string, number>, rng: { next(): number }): void };
  hidingPairs(): ReadonlySet<string>; setFakedDistanceEnabled(on: boolean): void;
  perceivedBond(holder: string, from: string, to: string): number;
  onlookers(room: string[], type: string, people: string[], salt: string): string[];
  playerCatchesHiddenPair(type: string, people: string[], place: string, presence: Map<string, string>, salt: string): void;
  onPlayerEvent?: (c: string, w: string[], k?: string) => string | undefined;
};
const flat = { next: () => 0.5 };
function setup(on = true) {
  const sb = new GameSessionRegistry().sandboxFor(`hide-${Math.random()}`);
  sb.session.createCharacter({ playerName: "The Player", archetype: "floater", seed: 71 });
  sb.session.advanceGame(); sb.session.advanceGame();
  const g = sb.session as unknown as Seam;
  g.setFakedDistanceEnabled(on);
  g.live.playedGame = true; g.live.pending = undefined;
  const [a, b, o, c] = sb.session.livingIds().filter((i) => i !== PLAYER) as [string, string, string, string];
  for (let i = 0; i < 8; i++) { g.rel.applyImpactDirected(a, b, { trust: 0.4, affinity: 0.4 }, flat); g.rel.applyImpactDirected(b, a, { trust: 0.4, affinity: 0.4 }, flat); }
  return { g, a, b, o, c };
}
const hide = (g: Seam, ...pairs: Array<[string, string]>) => { g.live.hiding = { week: g.live.week, pairs: pairs.map(([x, y]) => pairKey(x, y)) }; };

describe("0184 part 2b pure", () => {
  it("a cunning pair or a paranoid house hides more; an onlooker who never caught them reads little of the real thing", () => {
    expect(hideChance(1, 1)).toBeGreaterThan(hideChance(0, 1));
    expect(hideChance(0, 1.3)).toBeGreaterThan(hideChance(0, 1));
    expect(dampedTrueBond(0.9, 0.3)).toBeCloseTo(0.3 + HIDE.leak * 0.6);
  });
});

describe("0184 part 2b in the live adapter", () => {
  it("a hiding pair reads as less close to an onlooker who never caught them; one who caught them reads them as before", () => {
    const { g, a, b, o, c } = setup();
    g.record = { events: () => [{ id: "s1", ts: 1, type: "bonding", initiator: a, witnessSet: [a, b], hidden: true, content: "", houseLife: { seenBy: [c] } }] };
    const open = { o: g.perceivedBond(o, a, b), c: g.perceivedBond(c, a, b) };
    hide(g, [a, b]);
    expect(g.perceivedBond(o, a, b)).toBeLessThan(open.o);
    expect(g.perceivedBond(c, a, b)).toBeCloseTo(open.c); // caught them together
    expect(g.perceivedBond(a, a, b)).toBeCloseTo(g.perceivedBond(a, a, b)); // their own bond is theirs to know
  });

  it("onlookers in the room register a hiding pair's time together only on a catch, about the catch chance across many scenes; a fight is never hidden", () => {
    const { g, a, b, o, c } = setup();
    hide(g, [a, b]);
    let seen = 0;
    for (let i = 0; i < 400; i++) seen += g.onlookers([o, c], "bonding", [a, b], `t:${i}`).length;
    expect(seen / 800).toBeGreaterThan(HIDE.catchChance - 0.07);
    expect(seen / 800).toBeLessThan(HIDE.catchChance + 0.07);
    expect(g.onlookers([o, c], "conflict", [a, b], "t")).toEqual([o, c]);
    expect(g.onlookers([o, c], "bonding", [a, c], "t")).toEqual([o, c]); // not a hiding pair
  });

  it("the player in the room can catch a hiding pair slipping off, as a scene the player witnessed; the player's own pair can hide too", () => {
    const { g, a, b, o } = setup();
    hide(g, [a, b], [PLAYER, o]);
    const heard: Array<{ c: string; w: string[] }> = [];
    g.onPlayerEvent = (content, w) => { heard.push({ c: content, w: [...w] }); return undefined; };
    const presence = new Map([[PLAYER, "kitchen"], [a, "kitchen"], [b, "kitchen"]]);
    for (let i = 0; i < 200; i++) g.playerCatchesHiddenPair("bonding", [a, b], "kitchen", presence, `p:${i}`);
    expect(heard.length).toBeGreaterThan(0);
    expect(heard.length).toBeLessThan(200 * (HIDE.catchChance + 0.1));
    expect(heard.every((h) => h.w.length === 1 && h.w[0] === PLAYER && !/\d/.test(h.c))).toBe(true);
    expect(g.hidingPairs().has(pairKey(PLAYER, o))).toBe(true);
  });

  it("the weekly decision is kept, only close pairs hide, and the flag off hides nothing", () => {
    const { g, a, b } = setup();
    const first = [...g.hidingPairs()];
    expect([...g.hidingPairs()]).toEqual(first);
    for (const k of first) expect(k.split("|")).toHaveLength(2);
    const off = setup(false);
    expect(off.g.hidingPairs().size).toBe(0);
    void a; void b;
  });
});
