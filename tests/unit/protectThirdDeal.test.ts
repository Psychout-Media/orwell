import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import { conditionFor, actionBreaks, type Deal } from "../../src/domain/deal";
import type { DealView } from "../../src/ports/GameSession";

/**
 * ORW-88 / 0142 idea 3 (protect-a-third-person). The NPC swears NOT to move against a named THIRD houseguest. The engine decides consent like any ask, and adjudicates the break from the
 * structured action (nominate / replace / vote-evict the third), never prose. Played games with the deal-depth layer on only. Roles only.
 */
type Internals = {
  live: { playedGame?: boolean };
  deals: { open(): Deal[] };
  reconcileDeals(a: unknown): void;
  setNpcDealConsentEnabled(on: boolean): void;
  setDealDepthEnabled(on: boolean): void;
  rel: { edge(a: string, b: string): { trust: number; affinity: number; threat: number } };
};
function game(played = true, depth = true) {
  const sb = new GameSessionRegistry().sandboxFor(`pt-${Math.random()}`);
  sb.session.createCharacter({ playerName: "The Player", archetype: "floater", seed: 7 });
  sb.session.advanceGame(); sb.session.advanceGame();
  const g = sb.session as unknown as Internals;
  g.setNpcDealConsentEnabled(true); g.setDealDepthEnabled(depth);
  g.live.playedGame = played;
  const [npc, third, other] = [...sb.session.livingIds()].filter((i) => i !== PLAYER);
  const e = g.rel.edge(npc!, PLAYER); e.trust = 0.7; e.affinity = 0.7; e.threat = 0.1; // clearly willing
  return { s: sb.session, g, npc: npc!, third: third!, other: other! };
}
const ask = (x: ReturnType<typeof game>, third?: string, withId?: string) =>
  x.s.makeDeal({ with: withId ?? x.npc, kind: "protect-third", terms: "leave them alone", ...(third ? { third } : {}) } as never);

describe("the pure condition", () => {
  it("protect-third protects the THIRD person and binds only the promisor", () => {
    const c = conditionFor("protect-third", ["npc:a", "player"], "npc:c");
    expect(c).toEqual({ protect: "npc:c", promisors: ["npc:a"] });
  });
  it("only the promisor nominating/voting out the third breaks it", () => {
    const deal = { status: "open", kind: "protect-third", parties: ["npc:a", "player"], condition: conditionFor("protect-third", ["npc:a", "player"], "npc:c") } as unknown as Deal;
    expect(actionBreaks(deal, { actor: "npc:a", kind: "nominate", targets: ["npc:c"] })).toBe(true);
    expect(actionBreaks(deal, { actor: "npc:a", kind: "vote-evict", targets: ["npc:c"] })).toBe(true);
    expect(actionBreaks(deal, { actor: "npc:a", kind: "nominate", targets: ["npc:d"] })).toBe(false);
    expect(actionBreaks(deal, { actor: "npc:b", kind: "nominate", targets: ["npc:c"] })).toBe(false);
  });
});

describe("making the deal", () => {
  it("a willing NPC makes it: the NPC is the promisor and the third is protected", () => {
    const x = game();
    const v = ask(x, x.third) as DealView;
    expect(v.kind).toBe("protect-third");
    const d = x.g.deals.open().find((q) => q.kind === "protect-third")!;
    expect(d.parties).toEqual([x.npc, PLAYER]);
    expect(d.condition).toEqual({ protect: x.third, promisors: [x.npc] });
  });
  it("is refused (null) without a valid third, for the partner themself, the player, outside a played game, or with deal depth off", () => {
    const x = game();
    expect(ask(x)).toBeNull();
    expect(ask(x, x.npc)).toBeNull();
    expect(ask(x, PLAYER)).toBeNull();
    expect(ask(x, "npc:999")).toBeNull();
    const y = game(false); expect(ask(y, y.third)).toBeNull();
    const z = game(true, false); expect(ask(z, z.third)).toBeNull();
  });
  it("the NPC nominating the protected third breaks it; nominating someone else does not", () => {
    const x = game();
    ask(x, x.third);
    const d = () => x.g.deals.open().concat([]).find((q) => q.kind === "protect-third");
    x.g.reconcileDeals({ actor: x.npc, kind: "nominate", targets: [x.other] });
    expect(d()?.status).toBe("open");
    const deal = d()!;
    x.g.reconcileDeals({ actor: x.npc, kind: "nominate", targets: [x.third] });
    expect(deal.status).toBe("broken");
  });
});
