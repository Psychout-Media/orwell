import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import { MOVEMENT_INTENT } from "../../src/engine/presenceConstants";
import { TELL_REACTION } from "../../src/engine/tellReactions";

/** ORW-32 (B29 follow-up): an observer who AVOIDS a visibly rattled (snapping) houseguest they dislike keeps their movement away from them. Played games only; flag off or headless => no pull. Roles only. */
type Pull = { target: EntityId; weight: number; avoid: boolean };
type Internals = {
  presence: Map<EntityId, string>;
  week: number;
  live: { playedGame?: boolean };
  rel: { applyImpactDirected(a: EntityId, b: EntityId, i: Record<string, number>, r: SeededRandom): void };
  soulObj(id: EntityId): { tells?: Array<{ kind: string; band: string; since: number }>; distress?: number } | undefined;
  setNpcTellsEnabled(on: boolean): void;
  setTellReactionsEnabled(on: boolean): void;
  tellReactionsTick(): void;
  tellReactionCountsNow(): Record<string, number>;
  movementIntentFor(id: EntityId): Pull[] | null;
  snapshot(): { tellReactions?: { avoidUntil?: Record<string, number> } };
  restore(s: unknown): void;
};

function game(opts: { reactions: boolean; played: boolean }) {
  const sb = new GameSessionRegistry().sandboxFor(`orw32-${Math.random()}`);
  sb.session.createCharacter({ playerName: "The Player", archetype: "floater", seed: 7 });
  const s = sb.session as unknown as Internals;
  s.setNpcTellsEnabled(true);
  s.setTellReactionsEnabled(opts.reactions);
  s.live.playedGame = opts.played;
  const [target, observer] = sb.session.livingIds().filter((i) => i !== PLAYER) as [EntityId, EntityId];
  const room = s.presence.get(PLAYER)!;
  s.presence.set(target, room);
  s.presence.set(observer, room);
  s.soulObj(target)!.tells = [{ kind: "snapping", band: "strong", since: 0 }];
  const rng = new SeededRandom(1);
  for (let i = 0; i < 3; i++) s.rel.applyImpactDirected(observer, target, { trust: -0.2, affinity: -0.2 }, rng); // cold but no threat: no natural movement pull
  return { s, target, observer };
}
const tickUntilAvoid = (s: Internals): boolean => {
  for (let i = 0; i < 400 && (s.tellReactionCountsNow().avoid ?? 0) === 0; i++) { s.tellReactionsTick(); s.week += 1; }
  return (s.tellReactionCountsNow().avoid ?? 0) > 0;
};
const FLOOR = MOVEMENT_INTENT.minCharge * TELL_REACTION.avoidWeight;
// Ordinary charges already include avoid pulls, all below this floor; only the tell-avoid reaches it.
const avoids = (s: Internals, observer: EntityId, target: EntityId) => !!s.movementIntentFor(observer)?.some((p) => p.target === target && p.avoid && p.weight >= FLOOR);

describe("ORW-32 avoid bends movement", () => {
  it("played game: after an avoid reaction the observer's movement intent avoids the rattled houseguest; it lapses after the avoid window", () => {
    const { s, target } = game({ reactions: true, played: true });
    expect(tickUntilAvoid(s)).toBe(true);
    const [key, until] = Object.entries(s.snapshot().tellReactions!.avoidUntil!)[0]!; // any co-present observer may be the one who avoids
    const observer = key.split("|")[0] as EntityId;
    s.week = until;
    expect(avoids(s, observer, target)).toBe(true);
    s.week += 5;
    expect(avoids(s, observer, target), "the avoid lapses").toBe(false);
  });
  it("control: same seed, reactions OFF => no avoid pull; headless (not played) => recorded as before, no pull, no extra snapshot state", () => {
    const off = game({ reactions: false, played: true });
    for (let i = 0; i < 60; i++) off.s.tellReactionsTick();
    expect(avoids(off.s, off.observer, off.target)).toBe(false);
    const headless = game({ reactions: true, played: false });
    expect(tickUntilAvoid(headless.s)).toBe(true);
    expect(avoids(headless.s, headless.observer, headless.target)).toBe(false);
    expect(headless.s.snapshot().tellReactions?.avoidUntil).toBeUndefined();
  });
  it("the avoid survives a snapshot -> restore round trip", () => {
    const a = game({ reactions: true, played: true });
    tickUntilAvoid(a.s);
    const snap = JSON.parse(JSON.stringify(a.s.snapshot()));
    const b = game({ reactions: true, played: true });
    b.s.restore(snap);
    const [key, until] = Object.entries(snap.tellReactions.avoidUntil as Record<string, number>)[0]!;
    b.s.week = until;
    expect(avoids(b.s, key.split("|")[0] as EntityId, a.target)).toBe(true);
  });
});
