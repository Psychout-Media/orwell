import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import { conditionFor, actionBreaks, actionHonors, horizonOf, type Deal } from "../../src/domain/deal";
import type { DealView } from "../../src/ports/GameSession";

/**
 * ORW-88 / 0142 idea 3 (conditional): a mutual "if either of us is on the block at the vote, the other votes to keep them". It binds only at the VOTE: nominating the partner is not a break,
 * evicting them is; a week with no such vote lapses without a break. Played games with deal depth on only. Roles only.
 */
const mk = (): Deal => ({ id: "d", status: "open", kind: "conditional", terms: "t", parties: ["npc:a", "npc:b"], condition: conditionFor("conditional", ["npc:a", "npc:b"]) }) as Deal;

describe("the pure rule", () => {
  it("is week-scoped and mutual", () => {
    expect(horizonOf("conditional")).toBe("week");
    expect(mk().condition.promisors).toEqual(["npc:a", "npc:b"]);
  });
  it("nominating or replacing the partner is NOT a break; voting them out is, for either party", () => {
    const d = mk();
    expect(actionBreaks(d, { actor: "npc:a", kind: "nominate", targets: ["npc:b"] })).toBe(false);
    expect(actionBreaks(d, { actor: "npc:a", kind: "replace", targets: ["npc:b"] })).toBe(false);
    expect(actionBreaks(d, { actor: "npc:a", kind: "vote-evict", targets: ["npc:b"] })).toBe(true);
    expect(actionBreaks(d, { actor: "npc:b", kind: "vote-evict", targets: ["npc:a"] })).toBe(true);
    expect(actionBreaks(d, { actor: "npc:a", kind: "vote-evict", targets: ["npc:c"] })).toBe(false);
  });
  it("only a vote that spares the partner (a real alternative) honors it", () => {
    const d = mk();
    expect(actionHonors(d, { actor: "npc:a", kind: "vote-evict", targets: ["npc:c"], alternatives: ["npc:b", "npc:c"] })).toBe(true);
    expect(actionHonors(d, { actor: "npc:a", kind: "nominate", targets: ["npc:c"], alternatives: ["npc:b", "npc:c"] })).toBe(false);
    expect(actionHonors(d, { actor: "npc:a", kind: "vote-evict", targets: ["npc:c"], alternatives: ["npc:c", "npc:d"] })).toBe(false); // the partner was never on the block
  });
});

describe("making it", () => {
  type Internals = { live: { playedGame?: boolean }; setNpcDealConsentEnabled(on: boolean): void; setDealDepthEnabled(on: boolean): void; rel: { edge(a: string, b: string): { trust: number; affinity: number; threat: number } } };
  function game(played = true, depth = true) {
    const sb = new GameSessionRegistry().sandboxFor(`cond-${Math.random()}`);
    sb.session.createCharacter({ playerName: "The Player", archetype: "floater", seed: 7 });
    sb.session.advanceGame(); sb.session.advanceGame();
    const g = sb.session as unknown as Internals;
    g.setNpcDealConsentEnabled(true); g.setDealDepthEnabled(depth); g.live.playedGame = played;
    const npc = [...sb.session.livingIds()].find((i) => i !== PLAYER)!;
    const e = g.rel.edge(npc, PLAYER); e.trust = 0.7; e.affinity = 0.7; e.threat = 0.1;
    return { s: sb.session, npc };
  }
  const ask = (x: ReturnType<typeof game>) => x.s.makeDeal({ with: x.npc, kind: "conditional", terms: "keep each other if on the block" } as never);
  it("a willing NPC makes it in a played game with deal depth on", () => {
    const x = game();
    expect((ask(x) as DealView).kind).toBe("conditional");
  });
  it("is refused (null) when nobody is playing or deal depth is off", () => {
    expect(ask(game(false))).toBeNull();
    expect(ask(game(true, false))).toBeNull();
  });
});
