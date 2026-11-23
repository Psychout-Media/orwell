import { describe, it, expect } from "vitest";
import { COUPLE_TOLD, coupleBeliefId, coupleFactId, couplePair, passableCouples, retold, writeCouple } from "../../src/engine/coupleTold";
import type { BeliefStore } from "../../src/engine/beliefStore";
import { tellChance } from "../../src/engine/claimsToPlayer";

/** ORW-767: the pure rules of the told couple. Roles only (holder, pair, bystander); nothing here knows whether a pair is true. */
describe("ORW-767 the couple rules", () => {
  it("a pair is one unordered key, whichever way it is named", () => {
    expect(couplePair("y", "x")).toEqual(["x", "y"]);
    expect(coupleFactId("y", "x")).toBe(coupleFactId("x", "y"));
    expect(coupleBeliefId("h", "y", "x")).toBe(coupleBeliefId("h", "x", "y"));
  });

  it("writes one belief per holder per pair, keeps the surer read, and never lets a pair member hold it", () => {
    const store: BeliefStore = {};
    expect(writeCouple(store, "h", "y", "x", { origin: "told", source: "t", confidence: 0.4, week: 1 })).toBe(true);
    expect(writeCouple(store, "h", "x", "y", { origin: "witnessed", confidence: 0.8, week: 2 })).toBe(true); // surer: replaces in place
    expect(writeCouple(store, "h", "x", "y", { origin: "told", source: "t", confidence: 0.5, week: 3 })).toBe(false); // weaker: nothing changes
    expect(store.h).toHaveLength(1);
    expect(store.h![0]).toMatchObject({ kind: "couple", subject: "x", object: "y", value: true, origin: "witnessed", confidence: 0.8 });
    expect(writeCouple(store, "x", "x", "y", { origin: "told", confidence: 0.9, week: 1 })).toBe(false);
    expect(store.x).toBeUndefined();
  });

  it("a holder keeps a bounded number of couple beliefs, so a retelling that names a new pair each time cannot crowd the store", () => {
    const store: BeliefStore = {};
    for (let i = 0; i < COUPLE_TOLD.perHolderCap + 3; i++) writeCouple(store, "h", `p${i}`, `q${i}`, { origin: "told", source: "t", confidence: 0.6, week: 1 });
    expect(store.h).toHaveLength(COUPLE_TOLD.perHolderCap);
    expect(writeCouple(store, "h", "p0", "q0", { origin: "witnessed", confidence: 0.9, week: 2 })).toBe(true); // a held pair can still be strengthened
  });

  it("only a sure-enough, live, unrefuted belief about someone else is passed on, the surest first", () => {
    const store: BeliefStore = {};
    writeCouple(store, "h", "a", "b", { origin: "told", source: "t", confidence: 0.5, week: 1 });
    writeCouple(store, "h", "c", "d", { origin: "witnessed", confidence: 0.8, week: 1 });
    writeCouple(store, "h", "e", "f", { origin: "told", source: "t", confidence: COUPLE_TOLD.passFloor - 0.05, week: 1 });
    const refuted = store.h!.find((b) => b.subject === "a")!;
    expect(passableCouples(store.h, "h").map((b) => b.subject)).toEqual(["c", "a"]);
    refuted.refuted = true;
    expect(passableCouples(store.h, "h").map((b) => b.subject)).toEqual(["c"]);
    expect(passableCouples(store.h, "c").map((b) => b.subject)).toEqual([]); // a pair the holder is in is never theirs to pass on as gossip (the refuted one is already out)
  });

  it("a retelling is the pair as heard unless the mishear roll lands, and a misheard pair names someone else", () => {
    const pool = ["a", "b", "c", "d", "e"];
    expect(retold(["a", "b"], COUPLE_TOLD.mishearChance, 0.5, pool)).toEqual(["a", "b"]); // the roll at the bound is not a mishear
    const heard = retold(["a", "b"], 0, 0.5, pool);
    expect(heard).not.toEqual(["a", "b"]);
    expect(heard.some((x) => x === "a" || x === "b")).toBe(true); // one of the pair is still named: the partner is what was misheard
    expect(retold(["a", "b"], 0, 0.5, pool)).toEqual(heard); // deterministic in its inputs
    expect(retold(["a", "b"], 0, 0.5, ["a", "b"])).toEqual(["a", "b"]); // nobody else to mishear as
  });

  it("the telling rides the claims-to-player gates: no trust or a crowd means no telling", () => {
    expect(tellChance({ trustInPlayer: 0.1, audience: 0, candor: 1 })).toBe(0);
    expect(tellChance({ trustInPlayer: 0.9, audience: 9, candor: 1 })).toBe(0);
    expect(tellChance({ trustInPlayer: 0.9, audience: 0, candor: 0.5 })).toBeGreaterThan(0);
  });
});
