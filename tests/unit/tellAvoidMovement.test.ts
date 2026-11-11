import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";

/**
 * ORW-32 (B29 follow-up): an observer who reacted `avoid` to a visibly rattled houseguest keeps away from them - a movement avoid pull on the target, sharpened; played games only; same-seed
 * control (rattled target absent => no reaction); decays; survives a snapshot. Roles only.
 */
type Pull = { target: EntityId; weight: number; avoid: boolean };
type Internals = {
  presence: Map<EntityId, string>;
  live: { playedGame?: boolean; week: number };
  rel: { applyImpactDirected(a: EntityId, b: EntityId, i: Record<string, number>, r: SeededRandom): void };
  soulObj(id: EntityId): { distress?: number; confidence?: number; emotionalState: number; volatility: number; tells?: Array<{ kind: string; band: string; since: number }> } | undefined;
  setNpcTellsEnabled(on: boolean): void;
  setTellReactionsEnabled(on: boolean): void;
  tellReactionsTick(): void;
  tellReactionCountsNow(): Record<string, number>;
  movementIntentFor(id: EntityId): Pull[] | null;
  snapshot(): unknown;
  restore(s: unknown): void;
};
type Ledger = { tellAvoid: Record<string, number> };

function game(opts: { played: boolean; rattled?: boolean }) {
  const sb = new GameSessionRegistry().sandboxFor(`orw32-${Math.random()}`);
  sb.session.createCharacter({ playerName: "The Player", archetype: "floater", seed: 7 });
  const s = sb.session as unknown as Internals;
  s.setNpcTellsEnabled(true);
  s.setTellReactionsEnabled(true);
  s.live.playedGame = opts.played;
  const [target, observer] = sb.session.livingIds().filter((i) => i !== PLAYER) as [EntityId, EntityId];
  const room = s.presence.get(PLAYER)!;
  s.presence.set(target, room);
  s.presence.set(observer, room);
  const so = s.soulObj(target)!;
  Object.assign(so, { distress: 0.9, confidence: 0.1, emotionalState: 0.1, volatility: 0.8 });
  so.tells = opts.rattled === false ? [] : [{ kind: "snapping", band: "strong", since: 0 }];
  const rng = new SeededRandom(1);
  for (let i = 0; i < 6; i++) s.rel.applyImpactDirected(observer, target, { trust: -0.5, affinity: -0.5 }, rng);
  return { s };
}
function tickUntilAvoid(s: Internals): boolean {
  for (let i = 0; i < 400 && (s.tellReactionCountsNow().avoid ?? 0) === 0; i++) { s.tellReactionsTick(); s.live.week += 1; }
  return (s.tellReactionCountsNow().avoid ?? 0) > 0;
}
const pullOn = (s: Internals, observer: EntityId, target: EntityId) => (s.movementIntentFor(observer) ?? []).find((p) => p.target === target);

/** The (observer, target) pair that reacted `avoid`, and the observer's pull on the target WITH vs WITHOUT that ledger entry (a same-state counterfactual). */
function withVsWithout(s: Internals) {
  const led = s as unknown as Ledger;
  const key = Object.keys(led.tellAvoid)[0]!;
  const [observer, target] = key.split("|") as [EntityId, EntityId];
  const withIt = pullOn(s, observer, target);
  const saved = led.tellAvoid[key]!;
  delete led.tellAvoid[key];
  const without = pullOn(s, observer, target);
  led.tellAvoid[key] = saved;
  return { key, withIt, without };
}

describe("ORW-32 avoid reaction changes movement", () => {
  it("played game: after an avoid reaction the observer carries a sharper AVOID pull on the rattled houseguest than the same state without it", () => {
    const { s } = game({ played: true });
    expect(tickUntilAvoid(s), "an avoid reaction happens (cold bond + snapping)").toBe(true);
    const { withIt, without } = withVsWithout(s);
    expect(withIt!.avoid).toBe(true);
    expect(withIt!.weight).toBeGreaterThan(without?.weight ?? 0);
  });
  it("same-seed control: no rattled houseguest => no avoid reaction", () => {
    const { s } = game({ played: true, rattled: false });
    for (let i = 0; i < 100; i++) { s.tellReactionsTick(); s.live.week += 1; }
    expect(s.tellReactionCountsNow().avoid ?? 0).toBe(0);
  });
  it("headless (not a played game): the reaction is counted but no avoid is stored, so movement is unchanged and nothing extra is persisted", () => {
    const { s } = game({ played: false });
    expect(tickUntilAvoid(s)).toBe(true);
    expect(Object.keys((s as unknown as Ledger).tellAvoid)).toEqual([]);
    expect(JSON.stringify(s.snapshot())).not.toContain('"avoid":{');
  });
  it("the avoid survives a snapshot -> restore and fades once no tell is left", () => {
    const { s } = game({ played: true });
    tickUntilAvoid(s);
    const { key } = withVsWithout(s);
    const snap = JSON.parse(JSON.stringify(s.snapshot()));
    const fresh = game({ played: true, rattled: false });
    fresh.s.restore(snap);
    expect((fresh.s as unknown as Ledger).tellAvoid[key]).toBeGreaterThan(0);
    for (const id of s.presence.keys()) { const so = s.soulObj(id); if (so) so.tells = []; }
    for (let i = 0; i < 30; i++) s.tellReactionsTick();
    expect((s as unknown as Ledger).tellAvoid[key]).toBeUndefined();
  });
});
