import { describe, it, expect } from "vitest";
import { playedGame } from "../support/playedGame";
import { CEREMONY_IMPACTS, PLAYED_COMP_THREAT } from "../../src/engine/relationshipConstants";
import { PLAYER, type EntityId } from "../../src/domain/ids";
import type { RelationshipModel } from "../../src/engine/relationships";
import type { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";

/**
 * ORW-779 (Ryne 2026-11-26: "Social play can definitely work. Comps shouldn't be the only reason someone is a threat."): in a PLAYED game one competition win
 * raises the house's threat read without sending it to the top for everyone. Roles only.
 */
interface Inside { rel: RelationshipModel; live: { playedGame?: boolean; resume?: Record<string, number>; active: EntityId[]; hoh?: EntityId; week: number; playerPitch?: unknown } }
const inside = (s: GameSessionAdapter): Inside => s as unknown as Inside;

describe("ORW-779: one competition win is a factor in the threat read, not the top of it", () => {
  it("after the first competition of a played season, the winner's threat rises by about half a full comp-won fold", () => {
    let reads = 0, atTop = 0, rise = 0;
    for (const seed of [1, 2, 3]) {
      const g = playedGame({ seed });
      const x = inside(g.s);
      let before = new Map<string, number>();
      g.playUntil(() => {
        if (Object.keys(x.live?.resume ?? {}).length > 0) return true;
        before = new Map();
        for (const h of x.live?.active ?? []) for (const o of x.live.active) if (h !== o) before.set(`${h}>${o}`, x.rel.edge(h, o).threat);
        return false;
      }, 4000, "the first competition win");
      const winner = Object.keys(x.live.resume!)[0] as EntityId;
      for (const h of x.live.active) {
        if (h === winner || h === PLAYER) continue;
        const now = x.rel.edge(h, winner).threat;
        reads++;
        if (now >= 0.95) atTop++;
        rise += now - (before.get(`${h}>${winner}`) ?? now);
      }
    }
    const full = CEREMONY_IMPACTS["comp-won"].threat!;
    expect(rise / reads, "the win still counts").toBeGreaterThan(0.1);
    expect(rise / reads, "but not as a full fold").toBeLessThan(full * (PLAYED_COMP_THREAT.win + 0.2));
    expect(atTop / reads, "no single win puts the winner at the top of most houseguests' lists").toBeLessThan(0.25);
  });
});

