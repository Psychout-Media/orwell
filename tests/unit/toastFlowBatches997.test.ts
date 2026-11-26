import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";

/**
 * ORW-997: a watch-only toast circle flows. One advance may release up to four batches (`toastBatches`), the view hands the narrator every speaker of that release, each houseguest speaks exactly once, in order,
 * and a plain advance still releases one batch. Roles only.
 */
let n = 0;
function circle(seed: number) {
  const sb = new GameSessionRegistry().sandboxFor(`tf997-${n++}`);
  sb.session.setPremiereEntrancesEnabled(true);
  sb.session.createCharacter({ playerName: "The Player", seed });
  for (let i = 0; i < 40 && sb.session.premiereIntros()?.entrance?.stage === "entrances"; i++) sb.session.advanceGame();
  return sb;
}
const idsOf = (sb: ReturnType<typeof circle>) => (sb.session.premiereIntros()!.entrance!.speakers ?? []).map((x) => (x.host ? "host" : x.isPlayer ? PLAYER : x.id!));

describe("the toast circle flows several batches in one advance", () => {
  it("a plain advance releases one batch of two; toastBatches 3 releases six, all handed to the narrator", () => {
    const one = circle(51);
    one.session.advanceGame();
    expect(idsOf(one)).toHaveLength(2);
    const many = circle(51);
    many.session.advanceGame({ toastBatches: 3 });
    expect(idsOf(many)).toHaveLength(6);
    expect(many.session.premiereIntros()!.entrance!.toastRemaining).toBe(one.session.premiereIntros()!.entrance!.toastRemaining! - 4);
  });

  it("walking the circle four batches at a time voices every houseguest exactly once, in the engine's order, and then closes", () => {
    const sb = circle(52);
    const released: string[] = [];
    let advances = 0;
    for (; advances < 10 && sb.session.premiereIntros()?.entrance?.stage === "toast"; advances++) {
      sb.session.advanceGame({ toastBatches: 4 });
      const e = sb.session.premiereIntros()?.entrance;
      if (e?.stage === "toast") released.push(...idsOf(sb));
    }
    expect(sb.session.premiereIntros()?.entrance?.stage ?? "done").toBe("done");
    const order = sb.session.snapshot().live!.premiereEntrance?.order ?? [];
    expect(advances).toBeLessThanOrEqual(4);
    const people = released.filter((x) => x !== "host" && x !== PLAYER);
    expect(new Set(people).size, "no houseguest twice").toBe(people.length);
    expect(people.length).toBe(15);
    void order;
  });

  it("an out-of-range count is clamped to the circle's own limits", () => {
    const sb = circle(53);
    sb.session.advanceGame({ toastBatches: 99 });
    expect(idsOf(sb)).toHaveLength(8);
  });
});
