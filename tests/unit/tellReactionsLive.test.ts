import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import { TELL_REACTION } from "../../src/engine/tellReactions";

/**
 * B29 (#2017 15.4 E3, flag ORWELL_TELL_REACTIONS, needs ORWELL_NPC_TELLS): observers in the SAME room react to a visibly rattled houseguest - comfort / exploit - chosen by the observer's personality and bond, seeded,
 * bounded. Same board with the rattled houseguest in the room vs absent changes the observer. Flag off => nothing. Roles only.
 */
type Internals = {
  presence: Map<EntityId, string>;
  house: { npcs: Array<{ id: EntityId; character: { strategyStyle?: string } }> };
  rel: { applyImpactDirected(a: EntityId, b: EntityId, impact: Record<string, number>, rng: SeededRandom): void; edge(a: EntityId, b: EntityId): { trust: number; affinity: number } };
  soulObj(id: EntityId): { distress?: number; confidence?: number; emotionalState: number; volatility: number; tells?: Array<{ kind: string; band: string; since: number }> } | undefined;
  inflect(id: EntityId, event: string): void;
  setNpcTellsEnabled(on: boolean): void;
  setTellReactionsEnabled(on: boolean): void;
  tellReactionsTick(): void;
  tellReactionCountsNow(): Record<string, number>;
  moodTiltFor(subject: EntityId, holder: EntityId): number;
  ctx(): { moodTiltFor?: unknown };
  snapshot(): { tellReactions?: unknown };
  restore(s: unknown): void;
  week: number;
};

function game(opts: { tells: boolean; reactions: boolean; style?: string; bond?: "warm" | "cold"; together?: boolean }) {
  const sb = new GameSessionRegistry().sandboxFor(`b29-${Math.random()}`);
  sb.session.createCharacter({ playerName: "The Player", archetype: "floater", seed: 7 });
  const s = sb.session as unknown as Internals;
  s.setNpcTellsEnabled(opts.tells);
  s.setTellReactionsEnabled(opts.reactions);
  const [target, observer] = sb.session.livingIds().filter((i) => i !== PLAYER) as [EntityId, EntityId];
  const room = s.presence.get(PLAYER)!;
  s.presence.set(target, room);
  s.presence.set(observer, opts.together === false ? (room === "kitchen" ? "bedroom-a" : "kitchen") : room);
  const so = s.soulObj(target)!;
  Object.assign(so, { distress: 0.92, confidence: 0.08, emotionalState: 0.1, volatility: 0.8 });
  s.inflect(target, "betrayed"); // persists a strong tell on the arc (flag on)
  if (opts.style) s.house.npcs.find((n) => n.id === observer)!.character.strategyStyle = opts.style;
  const rng = new SeededRandom(1);
  const imp = opts.bond === "cold" ? { trust: -0.5, affinity: -0.5 } : { trust: 0.5, affinity: 0.5 };
  for (let i = 0; i < 6; i++) s.rel.applyImpactDirected(observer, target, imp, rng);
  return { sb, s, target, observer, so };
}
/** Tick across several weeks/beats until `done()` or the budget runs out (each (pair, week) is one seeded draw). */
function tickUntil(s: Internals, done: () => boolean, n = 400): boolean {
  for (let i = 0; i < n && !done(); i++) { s.tellReactionsTick(); (s as unknown as { live: { week: number } }).live.week += 1; }
  return done();
}

describe("B29 observer reactions", () => {
  it("OFF: nothing reacts, nothing is written, the snapshot carries no reaction state, and no provider is registered", () => {
    const { s } = game({ tells: true, reactions: false, style: "social", bond: "warm" });
    for (let i = 0; i < 40; i++) s.tellReactionsTick();
    expect(s.tellReactionCountsNow()).toEqual({});
    expect("tellReactions" in s.snapshot()).toBe(false);
    expect(s.ctx().moodTiltFor).toBeUndefined();
  });
  it("ON, warm bond, same room: the observer COMFORTS - the rattled one's distress drops and their trust in the observer rises", () => {
    const { s, so, target, observer } = game({ tells: true, reactions: true, style: "social", bond: "warm" });
    const d0 = so.distress!, t0 = s.rel.edge(target, observer).trust;
    expect(tickUntil(s, () => (s.tellReactionCountsNow().comfort ?? 0) > 0), "a comfort reaction happens within a season's worth of ticks").toBe(true);
    expect(so.distress!).toBeLessThan(d0);
    expect(s.rel.edge(target, observer).trust).toBeGreaterThan(t0);
    expect(s.tellReactionCountsNow().exploit ?? 0).toBe(0);
  });
  it("ON, same board but the rattled houseguest is in ANOTHER room: no reaction at all (the co-presence gate)", () => {
    const { s } = game({ tells: true, reactions: true, style: "social", bond: "warm", together: false });
    tickUntil(s, () => false, 120);
    expect(s.tellReactionCountsNow()).toEqual({});
  });
  it("ON, cunning observer without a warm bond: EXPLOIT - a small, bounded, decaying tilt the nomination and vote providers read; it fades once the tell is gone", () => {
    const { s, so, target, observer } = game({ tells: true, reactions: true, style: "strategic", bond: "cold" });
    expect(s.ctx().moodTiltFor, "the decision provider is registered when the flag is on").toBeTypeOf("function");
    expect(tickUntil(s, () => (s.tellReactionCountsNow().exploit ?? 0) > 0)).toBe(true);
    expect(s.moodTiltFor(target, observer)).toBeGreaterThan(0);
    expect(s.moodTiltFor(target, observer)).toBeLessThanOrEqual(TELL_REACTION.exploitCap);
    expect(s.moodTiltFor(observer, target), "directional: the rattled one holds no tilt toward the observer").toBe(0);
    so.tells = []; // the tell is gone: no new exploit, the old one decays away
    for (let i = 0; i < 30; i++) s.tellReactionsTick();
    expect(s.moodTiltFor(target, observer)).toBe(0);
  });
  it("the reaction state survives a snapshot -> restore round trip", () => {
    const { s, target, observer } = game({ tells: true, reactions: true, style: "strategic", bond: "cold" });
    tickUntil(s, () => (s.tellReactionCountsNow().exploit ?? 0) > 0);
    const tilt = s.moodTiltFor(target, observer);
    const snap = JSON.parse(JSON.stringify(s.snapshot()));
    expect(snap.tellReactions).toBeDefined();
    const fresh = game({ tells: true, reactions: true });
    fresh.s.restore(snap);
    expect(fresh.s.moodTiltFor(target, observer)).toBe(tilt);
    expect(fresh.s.tellReactionCountsNow()).toEqual(s.tellReactionCountsNow());
  });
});
