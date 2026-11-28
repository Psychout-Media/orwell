import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import { conditionFor, actionBreaks, actionHonors, type Deal } from "../../src/domain/deal";
import { polarityAt } from "../../src/engine/dealTermPolarity";

/**
 * ORW-1053 / ORW-1069. The polarity of a vote deal's terms decides who is protected and who is the promised target, and the kept / broken grade compares the ACTUAL ballot with the promised one.
 * "we both vote Lorenzo out" must not protect Lorenzo; a promiser who votes the wrong nominee breaks it; a promiser who votes the right one keeps it. Roles only.
 */
const pol = (terms: string, name: string) => polarityAt(terms, terms.indexOf(name));

describe("polarity of a named houseguest in the spoken terms (table)", () => {
  const rows: Array<[string, string, "protect" | "evict"]> = [
    ["I am voting Lorenzo out, I swear", "Lorenzo", "evict"],
    ["we both vote out Lorenzo", "Lorenzo", "evict"],
    ["send Lorenzo home this week", "Lorenzo", "evict"],
    ["we go after Lorenzo", "Lorenzo", "evict"],
    ["put up Lorenzo", "Lorenzo", "evict"],
    ["vote to keep Valentina", "Valentina", "protect"],
    ["I won't put Valentina up", "Valentina", "protect"],
    ["I've got Valentina's back", "Valentina", "protect"],
    ["I will not vote Valentina out", "Valentina", "protect"],
    ["if Valentina or Robert goes up, vote to keep them", "Valentina", "protect"],
    ["Valentina stays safe", "Valentina", "protect"],
    ["vote Lorenzo out and keep Valentina", "Lorenzo", "evict"],
    ["vote Lorenzo out and keep Valentina", "Valentina", "protect"],
  ];
  for (const [terms, name, want] of rows) it(`${terms} -> ${name} is ${want}`, () => expect(pol(terms, name)).toBe(want));
});

describe("pure grading against the actual ballot", () => {
  const deal = (c: ReturnType<typeof conditionFor>) => ({ status: "open", kind: "vote", parties: ["player", "npc:a"], condition: c }) as unknown as Deal;
  it("a promise to vote npc:t out: voting npc:t keeps it, voting the other nominee breaks it", () => {
    const d = deal(conditionFor("vote", ["player", "npc:a"], undefined, undefined, ["npc:t"]));
    expect(d.condition.evict).toEqual(["npc:t"]);
    const ok = { actor: "npc:a", kind: "vote-evict", targets: ["npc:t"], alternatives: ["npc:t", "npc:o"] } as const;
    const bad = { actor: "npc:a", kind: "vote-evict", targets: ["npc:o"], alternatives: ["npc:t", "npc:o"] } as const;
    expect(actionBreaks(d, ok)).toBe(false);
    expect(actionHonors(d, ok)).toBe(true);
    expect(actionBreaks(d, bad)).toBe(true);
    expect(actionHonors(d, bad)).toBe(false);
  });
  it("a promised evictee who is not on the ballot binds nothing", () => {
    const d = deal(conditionFor("vote", ["player", "npc:a"], undefined, undefined, ["npc:t"]));
    const a = { actor: "npc:a", kind: "vote-evict", targets: ["npc:o"], alternatives: ["npc:o", "npc:p"] } as const;
    expect(actionBreaks(d, a)).toBe(false);
  });
  it("a promise to keep npc:c is honored only by sparing npc:c (not the partner) when npc:c was a choice", () => {
    const d = deal(conditionFor("vote", ["player", "npc:a"], "npc:c"));
    expect(actionHonors(d, { actor: "npc:a", kind: "vote-evict", targets: ["npc:o"], alternatives: ["npc:c", "npc:o"] })).toBe(true);
    expect(actionHonors(d, { actor: "npc:a", kind: "vote-evict", targets: ["npc:o"], alternatives: ["npc:o", "npc:p"] })).toBe(false);
    expect(actionBreaks(d, { actor: "npc:a", kind: "vote-evict", targets: ["npc:c"], alternatives: ["npc:c", "npc:o"] })).toBe(true);
  });
});

type Internals = { deals: { all: readonly Deal[] }; reconcileDeals(a: unknown): void; setNpcDealConsentEnabled(on: boolean): void; house: { npcs: Array<{ id: string; name: string }> } };
function game() {
  const sb = new GameSessionRegistry().sandboxFor(`pg-${Math.random()}`);
  sb.session.createCharacter({ playerName: "The Player", archetype: "floater", seed: 7 });
  sb.session.advanceGame(); sb.session.advanceGame();
  const g = sb.session as unknown as Internals;
  g.setNpcDealConsentEnabled(false);
  const ids = [...sb.session.livingIds()].filter((i) => i !== PLAYER);
  const nm = (id: string) => g.house.npcs.find((n) => n.id === id)!.name;
  return { s: sb.session, g, partner: ids[0]!, t1: ids[1]!, t2: ids[2]!, nm };
}
const vote = (x: ReturnType<typeof game>, terms: string) => x.s.makeDeal({ with: x.partner, kind: "vote", terms } as never);

describe("real path: makeDeal then the ballot", () => {
  it("'we both vote T1 out' does not protect T1; the partner voting T2 breaks it, voting T1 keeps it", () => {
    const x = game();
    expect(vote(x, `we both vote out ${x.nm(x.t1)}`)).not.toBeNull();
    const d = x.g.deals.all.find((q) => q.kind === "vote")!;
    expect(d.condition.evict).toEqual([x.t1]);
    expect(d.condition.protect).toBe(x.partner);
    x.g.reconcileDeals({ actor: x.partner, kind: "vote-evict", targets: [x.t2], alternatives: [x.t1, x.t2] });
    expect(d.status).toBe("broken");
    expect(d.brokenBy).toBe(x.partner);
    const y = game();
    vote(y, `we both vote out ${y.nm(y.t1)}`);
    const e = y.g.deals.all.find((q) => q.kind === "vote")!;
    y.g.reconcileDeals({ actor: y.partner, kind: "vote-evict", targets: [y.t1], alternatives: [y.t1, y.t2] });
    expect(e.status).toBe("kept");
  });
  it("'vote to keep T1': the partner voting T1 is broken; sparing T1 for T2 is kept at that ballot", () => {
    const x = game();
    vote(x, `vote to keep ${x.nm(x.t1)}`);
    const d = x.g.deals.all.find((q) => q.kind === "vote")!;
    expect(d.condition.protect).toBe(x.t1);
    x.g.reconcileDeals({ actor: x.partner, kind: "vote-evict", targets: [x.t2], alternatives: [x.t1, x.t2] });
    expect(d.status).toBe("kept");
    const y = game();
    vote(y, `vote to keep ${y.nm(y.t1)}`);
    const e = y.g.deals.all.find((q) => q.kind === "vote")!;
    y.g.reconcileDeals({ actor: y.partner, kind: "vote-evict", targets: [y.t1], alternatives: [y.t1, y.t2] });
    expect(e.status).toBe("broken");
  });
});
