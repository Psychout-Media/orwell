import { describe, it, expect } from "vitest";
import { buildComingCleanRetro, type CleanAct } from "../../src/engine/comingClean";
import { buildYourEdit, type YourEditInput } from "../../src/engine/yourEdit";
import { PLAYER } from "../../src/domain/ids";

/** ORW-747 - the pure builders behind the retrospective leftovers. The played-season real-path test is tests/uat/realPathRetroLeftovers.test.ts (the heavy `real-path` leg). Roles only. */
describe("ORW-747: the pure builders", () => {
  const nameOf = (id: string): string => (id === PLAYER ? "the player" : `guest-${id}`);
  it("coming clean: only liars with a confession or a loop-in, every version kept, deterministic, nothing without an act", () => {
    const claims = [
      { id: "c1", speaker: "a", listener: "b", kind: "k", subject: "s", isTrue: false, week: 1 },
      { id: "c2", speaker: "a", listener: "c", kind: "k", subject: "s", isTrue: false, week: 2 },
      { id: "c3", speaker: "d", listener: "b", kind: "k", subject: "s", isTrue: false, week: 2 },
    ];
    const acts: CleanAct[] = [{ kind: "confess", by: "a", to: "b", claimId: "c1", week: 2 }, { kind: "loop-in", by: "a", to: "e", claimId: "c2", toldTo: "c", week: 3 }];
    const r = buildComingCleanRetro(claims, acts, nameOf, (c) => `said ${c.id}`)!;
    expect(r.stories).toHaveLength(1);
    expect(r.stories[0]!.liar).toBe("guest-a");
    expect(r.stories[0]!.versions.map((v) => [v.to, v.confessedTo, v.loopedIn])).toEqual([["guest-b", ["guest-b"], []], ["guest-c", [], ["guest-e"]]]);
    expect(buildComingCleanRetro(claims, [], nameOf, () => "x")).toBeUndefined();
  });
  it("the edit: alliances absent changes nothing; present, they land in their week and the player's own are listed under you", () => {
    const base: YourEditInput = {
      player: PLAYER, cast: ["a", "b"], nameOf, voteRecord: [], calledPawn: () => false, events: [], eventWeeks: [], deals: [], winner: null,
      digests: [{ week: 1, hoh: "a", nominees: ["b", PLAYER], vetoHolder: null, vetoUsed: false, evictee: "b" }, { week: 2, hoh: PLAYER, nominees: ["a", "b"], vetoHolder: null, vetoUsed: false, evictee: "a" }],
    };
    const plain = buildYourEdit(base);
    expect(JSON.stringify(plain)).not.toContain("alliances");
    const withA = buildYourEdit({ ...base, alliances: [
      { name: "the pact", members: ["guest-a", "the player"], youWere: true, formedWeek: 1, endedWeek: 2, endedHow: "it faded" },
      { name: "the shadow", members: ["guest-a", "guest-b"], youWere: false, formedWeek: 1 },
    ] });
    expect(withA.episodes[0]!.alliances!.map((x) => [x.name, x.what])).toEqual([["the pact", "formed"], ["the shadow", "formed"]]);
    expect(withA.episodes[1]!.alliances).toEqual([{ name: "the pact", members: ["guest-a", "the player"], what: "ended", how: "it faded" }]);
    expect(withA.you.alliances).toEqual([{ name: "the pact", with: ["guest-a"], formedWeek: 1, endedWeek: 2, endedHow: "it faded" }]);
    const { alliances: _a, ...restEp } = withA.episodes[0]!; void _a;
    expect(restEp).toEqual(plain.episodes[0]);
  });
});
