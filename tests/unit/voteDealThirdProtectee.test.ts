import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import { conditionFor, actionBreaks, type Deal } from "../../src/domain/deal";

/**
 * ORW-1053. A vote deal whose terms name a houseguest outside the pair ("if X or Y goes up, vote to keep them") was filed with the PARTNER as the protectee, so the promiser's ballot against the
 * named houseguest broke nothing and the deal was graded kept. The named houseguests are now the protectees, and each promiser's ballot is graded against them. Roles only.
 */
type Internals = {
  live: { playedGame?: boolean };
  deals: { all: readonly Deal[] };
  reconcileDeals(a: unknown): void;
  setNpcDealConsentEnabled(on: boolean): void;
  house: { npcs: Array<{ id: string; name: string }> };
};
function game() {
  const sb = new GameSessionRegistry().sandboxFor(`vt-${Math.random()}`);
  sb.session.createCharacter({ playerName: "The Player", archetype: "floater", seed: 7 });
  sb.session.advanceGame(); sb.session.advanceGame();
  const g = sb.session as unknown as Internals;
  g.setNpcDealConsentEnabled(false);
  const ids = [...sb.session.livingIds()].filter((i) => i !== PLAYER);
  const nm = (id: string) => g.house.npcs.find((n) => n.id === id)!.name;
  return { s: sb.session, g, partner: ids[0]!, t1: ids[1]!, t2: ids[2]!, other: ids[3]!, nm };
}
const vote = (x: ReturnType<typeof game>, terms: string) => x.s.makeDeal({ with: x.partner, kind: "vote", terms } as never);

describe("pure condition", () => {
  it("a named third is the protectee, both parties stay bound, a second named third is also covered", () => {
    const c = conditionFor("vote", ["player", "npc:a"], "npc:c", ["npc:d"]);
    expect(c).toEqual({ protect: "npc:c", promisors: ["player", "npc:a"], alsoProtect: ["npc:d"] });
    const deal = { status: "open", kind: "vote", parties: ["player", "npc:a"], condition: c } as unknown as Deal;
    expect(actionBreaks(deal, { actor: "npc:a", kind: "vote-evict", targets: ["npc:d"] })).toBe(true);
    expect(actionBreaks(deal, { actor: "npc:a", kind: "vote-evict", targets: ["npc:e"] })).toBe(false);
  });
  it("with no third the partner stays the protectee (unchanged)", () => {
    expect(conditionFor("vote", ["player", "npc:a"])).toEqual({ protect: "npc:a", promisors: ["player", "npc:a"] });
  });
});

describe("real path: makeDeal then the ballot", () => {
  it("terms naming two houseguests protect both; the partner voting one of them is marked broken, not kept", () => {
    const x = game();
    const v = vote(x, `if ${x.nm(x.t1)} or ${x.nm(x.t2)} goes up, vote to keep them`);
    expect(v).not.toBeNull();
    const d = x.g.deals.all.find((q) => q.kind === "vote")!;
    expect(d.condition.protect).toBe(x.t1);
    expect(d.condition.alsoProtect).toEqual([x.t2]);
    expect(d.condition.promisors).toEqual([PLAYER, x.partner]);
    x.g.reconcileDeals({ actor: x.partner, kind: "vote-evict", targets: [x.t1] });
    expect(d.status).toBe("broken");
    expect(d.brokenBy).toBe(x.partner);
  });
  it("a promiser who votes someone else keeps it (graded kept at the vote)", () => {
    const x = game();
    vote(x, `vote to keep ${x.nm(x.t1)}`);
    const d = x.g.deals.all.find((q) => q.kind === "vote")!;
    x.g.reconcileDeals({ actor: x.partner, kind: "vote-evict", targets: [x.other] });
    expect(d.status).toBe("kept");
  });
  it("a promise to keep the player: the partner voting the player breaks it", () => {
    const x = game();
    vote(x, "I will vote to keep you");
    const d = x.g.deals.all.find((q) => q.kind === "vote")!;
    expect(d.condition.protect).toBe(x.partner);
    x.g.reconcileDeals({ actor: x.partner, kind: "vote-evict", targets: [PLAYER] });
    expect(d.status).toBe("broken");
  });
});
