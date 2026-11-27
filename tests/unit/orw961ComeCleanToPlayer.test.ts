import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";
import type { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import type { CleanAct } from "../../src/engine/comingClean";

/**
 * ORW-961 (Ryne 2026-11-26, "Yes, same as with others"): a houseguest who lied to the PLAYER can come clean under the same pressures as with a houseguest. Before, every input of the catch risk was zeroed for a player
 * listener, so the risk was always 0 and the daily coming-clean tick never reached the confession: over 200 built days the liar confessed to the houseguest and never to the player. Built state (the lies are told through
 * `tellClaim`, the bonds and the room are set); the tick is the real adapter method. Roles only.
 */
type Priv = { live: { week: number; dayNumber?: number; playedGame?: boolean; cleanDay?: number; cleanActs?: CleanAct[] }; presence: Map<string, string>; comingCleanTick(): void; onPlayerEvent?: (c: string, w: EntityId[], t?: string) => string | undefined };
const NEAR = { trust: 0.8, affinity: 0.8, threat: 0.1, alignment: 0.3, confidence: 0.4, reliability: 0.5 };

function setup(tag: string, withOtherVersion: boolean) {
  const sb = new GameSessionRegistry().sandboxFor(`orw961-${tag}`);
  const s = sb.session as GameSessionAdapter;
  s.setNpcBeliefsEnabled(true); s.setLiesCaughtEnabled(true); s.setCredibilityEnabled(true);
  s.createCharacter({ playerName: "P", seed: 7 });
  const [liar, other, subject] = s.livingIds().filter((id) => id !== PLAYER) as EntityId[];
  const p = s as unknown as Priv;
  p.live.week = 2; p.live.dayNumber = 3; p.live.playedGame = true;
  p.onPlayerEvent = () => "e";
  const edge = (x: EntityId, y: EntityId) => sb.engine.relationships.edge(x, y);
  for (const [x, y] of [[other!, PLAYER], [PLAYER, other!], [liar!, PLAYER], [PLAYER, liar!]] as const) Object.assign(edge(x, y), NEAR);
  const room = p.presence.get(PLAYER)!; p.presence.set(liar!, room); // the two are together (a confession to the player needs the same room, awake)
  const toPlayer = s.tellClaim({ speaker: liar!, listener: PLAYER, kind: "going-after", subject: subject!, object: other!, isTrue: false, intent: "mislead" })!;
  if (withOtherVersion) s.tellClaim({ speaker: liar!, listener: other!, kind: "talking-about", subject: subject!, object: other!, isTrue: false, intent: "mislead" }); // another version, told to someone close to the player
  return { s, p, liar: liar!, other: other!, subject: subject!, toPlayer };
}
const confessedToPlayer = (p: Priv, liar: EntityId): boolean => (p.live.cleanActs ?? []).some((a) => a.kind === "confess" && a.by === liar && a.to === PLAYER);
function days(p: Priv, n: number, until: () => boolean): number {
  for (let d = 1; d <= n; d++) { p.live.dayNumber = 3 + d; p.live.cleanDay = undefined; p.comingCleanTick(); if (until()) return d; }
  return -1;
}

describe("ORW-961: a houseguest comes clean to the player on the same pressures as to a houseguest", () => {
  it("a lie told to the player, with another version told to someone close to the player, is confessed to the player within a bounded run of days", () => {
    const t = setup("near", true);
    const d = days(t.p, 120, () => confessedToPlayer(t.p, t.liar));
    expect(d, "the liar confessed the lie to the player").toBeGreaterThan(0);
  });
  it("with nothing to fear (no other version, nobody doubting, the subject not close to the player) nobody confesses: no risk, no act", () => {
    const t = setup("calm", false);
    const d = days(t.p, 60, () => confessedToPlayer(t.p, t.liar));
    expect(d, "no confession without a catch risk").toBe(-1);
  });
});
