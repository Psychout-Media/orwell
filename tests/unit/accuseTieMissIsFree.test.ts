import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import type { UserSandbox } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";
import type { AccuseTieResult } from "../../src/ports/GameSession";

/**
 * A44 / AMEND 3a item 2 - TODAY's behavior of `accuseTie`, pinned (not endorsed): a MISS costs nothing and is UNCAPPED, so `landed` is a free oracle on any pair. Only HITS are capped (TIE_REVEAL.maxExposuresPerSeason);
 * a miss changes no relationship edge, records no event, spends no cap, and may be repeated without limit. The .md calls accuseTie a sanctioned lever, but "wield only a held fact; the engine never confirms a guess"
 * is in tension with this. Whether to rate-limit misses or make them cost standing/trust is RYNE'S decision (card 24); this file only makes the current behavior visible, so a later decision flips a red test on purpose
 * rather than changing it silently. Roles only.
 */
function season(seed: number): UserSandbox {
  const sb = new GameSessionRegistry().sandboxFor(`atf-${seed}-${Math.random()}`);
  sb.session.createCharacter({ playerName: "The Player", archetype: "floater", seed });
  return sb;
}
const npcIds = (sb: UserSandbox): EntityId[] => sb.session.livingIds().filter((i) => i !== PLAYER);
const allEdges = (sb: UserSandbox, ids: EntityId[]): string =>
  JSON.stringify(ids.flatMap((a) => [PLAYER, ...ids].filter((b) => b !== a).map((b) => { const e = sb.engine.relationships.edge(a, b); return [a, b, e.trust, e.affinity, e.threat]; })));

describe("accuseTie: a miss is free and uncapped (current behavior, pending Ryne's decision)", () => {
  it("a wrong accusation changes no edge, records no event, spends no cap - and can be repeated without limit", () => {
    const sb = season(5);
    const ids = npcIds(sb);
    const ties = (sb.session as unknown as { seededRels: { ties: Array<{ a: string; b: string }> } }).seededRels.ties;
    const isTie = (a: string, b: string) => ties.some((t) => (t.a === a && t.b === b) || (t.a === b && t.b === a));
    // find a pair that is NOT a tie
    let miss: [EntityId, EntityId] | undefined;
    for (const a of ids) for (const b of ids) if (!miss && a < b && !isTie(a, b)) miss = [a, b];
    expect(miss, "precondition: a non-tie pair exists").toBeDefined();

    const edgesBefore = allEdges(sb, ids);
    const eventsBefore = sb.engine.events.count();
    const beatBefore = sb.session.beatSeqNow();
    const results: AccuseTieResult[] = [];
    for (let i = 0; i < 100; i++) results.push(sb.session.accuseTie(miss![0], miss![1]) as AccuseTieResult);

    expect(results.every((r) => r.landed === false), "every one of 100 repeated misses is answered, none refused").toBe(true);
    expect(allEdges(sb, ids), "a miss moves no relationship edge").toBe(edgesBefore);
    expect(sb.engine.events.count(), "a miss records no event").toBe(eventsBefore);
    expect(sb.session.beatSeqNow(), "a miss commits nothing").toBe(beatBefore);
  });

  it("so `landed` is a free oracle: sweeping every pair reveals exactly the sealed ties (the hit cap bites only after the season's quota)", () => {
    const sb = season(5);
    const ids = npcIds(sb);
    const ties = (sb.session as unknown as { seededRels: { ties: Array<{ a: string; b: string }> } }).seededRels.ties;
    const trueTies = new Set(ties.map((t) => [t.a, t.b].sort().join("|")));
    const found = new Set<string>();
    let calls = 0;
    for (const a of ids) for (const b of ids) {
      if (!(a < b)) continue;
      calls++;
      const r = sb.session.accuseTie(a, b) as AccuseTieResult;
      if (r.landed) found.add([a, b].sort().join("|"));
    }
    expect(calls, "every pair could be asked").toBe((ids.length * (ids.length - 1)) / 2);
    // Hits are capped per season, so the sweep recovers min(cap, ties) of them - never anything that is NOT a tie, and no miss was ever refused or priced.
    for (const f of found) expect(trueTies.has(f), "landed:true only ever names a real tie").toBe(true);
    expect(found.size).toBeGreaterThan(0);
  });
});
