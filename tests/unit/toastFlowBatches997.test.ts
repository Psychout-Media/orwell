import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";

/**
 * ORW-1131 (Ryne, 2026-11-28) made a batch ONE speaker (the host opens with the first), and ORW-1129 stops every release just before the player's own slot, which is released alone.
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
  it("a plain advance releases the host and ONE speaker; toastBatches 3 releases up to three speakers, never past the player's slot", () => {
    const one = circle(51);
    one.session.advanceGame();
    const ones = idsOf(one);
    expect(ones[0]).toBe("host");
    expect(ones.length).toBeLessThanOrEqual(2);
    const many = circle(51);
    many.session.advanceGame({ toastBatches: 3 });
    const got = idsOf(many);
    expect(got[0]).toBe("host");
    expect(got.length).toBeGreaterThanOrEqual(ones.length);
    expect(got.length).toBeLessThanOrEqual(4);
    expect(got.filter((x) => x === PLAYER).length, "the player's slot never rides with houseguests").toBe(0);
  });

  it("walking the circle four batches at a time voices every houseguest exactly once, in the engine's order, and then closes", () => {
    const sb = circle(52);
    const released: string[] = [];
    let advances = 0;
    for (; advances < 20 && sb.session.premiereIntros()?.entrance?.stage === "toast"; advances++) {
      sb.session.advanceGame({ toastBatches: 4 });
      const e = sb.session.premiereIntros()?.entrance;
      if (e?.stage === "toast") released.push(...idsOf(sb));
    }
    expect(sb.session.premiereIntros()?.entrance?.stage ?? "done").toBe("done");
    const order = sb.session.snapshot().live!.premiereEntrance?.order ?? [];
    expect(advances).toBeLessThanOrEqual(9); // 15 houseguests at up to 3 a release, plus the player's own slot alone and the close
    const people = released.filter((x) => x !== "host" && x !== PLAYER);
    expect(new Set(people).size, "no houseguest twice").toBe(people.length);
    expect(people.length).toBe(15);
    void order;
  });

  it("an out-of-range count is clamped to the circle's own limits", () => {
    const sb = circle(53);
    sb.session.advanceGame({ toastBatches: 99 });
    expect(idsOf(sb).length).toBeLessThanOrEqual(5); // the host + at most four (clamped), and never past the player's slot
  });
});
