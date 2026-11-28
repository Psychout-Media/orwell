import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";

/**
 * ORW-1130: the narrator voiced a run of toasts past the released batch (the prod case: one reply voiced most of the circle). The front end reports those houseguests as `toastVoiced`; the engine marks them and
 * never releases them again, so each houseguest toasts exactly once. Roles only.
 */
let n = 0;
function circle(seed: number) {
  const sb = new GameSessionRegistry().sandboxFor(`tv1130-${n++}`);
  sb.session.setPremiereEntrancesEnabled(true);
  sb.session.createCharacter({ playerName: "The Player", seed });
  for (let i = 0; i < 40 && sb.session.premiereIntros()?.entrance?.stage === "entrances"; i++) sb.session.advanceGame();
  return sb;
}
const idsOf = (sb: ReturnType<typeof circle>) => (sb.session.premiereIntros()!.entrance!.speakers ?? []).map((x) => (x.host ? "host" : x.isPlayer ? PLAYER : x.id!));
const nameMap = (sb: ReturnType<typeof circle>) => {
  const e = sb.session.premiereIntros()!.entrance!;
  const order = sb.session.snapshot().live!.premiereEntrance!.order;
  const names = (e as { arrivedNames?: string[] }).arrivedNames ?? [];
  return new Map(order.map((id, i) => [id, names[i]!]));
};

describe("a toast the narrator voiced ahead is never released again", () => {
  it("the speakers reported voiced ahead are skipped by every later release; each houseguest toasts once", () => {
    const sb = circle(61);
    sb.session.advanceGame(); // the first batch
    const released: string[] = [...idsOf(sb)];
    const order = sb.session.snapshot().live!.premiereEntrance!.order;
    const names = nameMap(sb);
    const done = new Set(released);
    const ahead = order.filter((id) => id !== PLAYER && !done.has(id)).slice(0, 5);
    expect(ahead).toHaveLength(5);
    for (const id of ahead) expect(names.get(id)).toBeTruthy();
    for (let i = 0; i < 30 && sb.session.premiereIntros()?.entrance?.stage === "toast"; i++) {
      sb.session.advanceGame(i === 0 ? { toastVoiced: ahead.map((id) => names.get(id)!) } : {});
      if (sb.session.premiereIntros()?.entrance?.stage === "toast") released.push(...idsOf(sb));
    }
    for (const id of ahead) expect(released, `${id} is not released after being voiced`).not.toContain(id);
    const counts = new Map<string, number>();
    for (const id of released) counts.set(id, (counts.get(id) ?? 0) + 1);
    for (const [id, c] of counts) expect(c, `${id} released once`).toBe(1);
    // everyone else (host, player slot, and the rest) still speaks once
    const expected = ["host", ...order].filter((id) => !ahead.includes(id));
    expect(new Set(released)).toEqual(new Set(expected));
  });

  it("a name already released, the host or an unknown name changes nothing", () => {
    const a = circle(62), b = circle(62);
    a.session.advanceGame(); b.session.advanceGame();
    const first = idsOf(b).filter((x) => x !== "host" && x !== PLAYER).map((id) => nameMap(b).get(id)!);
    a.session.advanceGame({ toastVoiced: [...first, "host", "Nobody Atall"] }); b.session.advanceGame();
    expect(idsOf(a)).toEqual(idsOf(b));
  });
});
