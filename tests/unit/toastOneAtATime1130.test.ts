import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import { nextToastRelease } from "../../src/engine/premiereEntrances";

/**
 * Ryne's prod premiere, 2026-11-28 (session 9faff772):
 *  - ORW-1130: one reply voiced 14 toasts while the engine had released two; every later message re-released the next pair and they toasted AGAIN (12 repeats).
 *  - ORW-1129: "it has skipped me in the champagne circle": the player's slot was one line inside a batch, and the circle "does NOT wait for the player".
 *  - ORW-1131 (Ryne approved): "each turn is like one person going ... people responding and kind of playing off of it".
 * The engine now releases ONE toast a turn, never past the player's slot (released alone, and the circle waits on it), and records the toasts the narration already showed so it never releases them again.
 */
let n = 0;
function circle(seed: number) {
  const sb = new GameSessionRegistry().sandboxFor(`t1130-${n++}`);
  sb.session.setPremiereEntrancesEnabled(true);
  sb.session.createCharacter({ playerName: "The Player", seed });
  for (let i = 0; i < 40 && sb.session.premiereIntros()?.entrance?.stage === "entrances"; i++) sb.session.advanceGame();
  return sb;
}
type Sp = { id?: string; name: string; host?: true; isPlayer?: true };
const speakersOf = (sb: ReturnType<typeof circle>): Sp[] => (sb.session.premiereIntros()?.entrance?.speakers ?? []) as Sp[];
const toastLine = (sb: ReturnType<typeof circle>) => sb.session.getMomentPrompt({ moment: "premiere" }).systemPrompt.split("\n").find((l) => l.includes("THE TOAST (engine truth)")) ?? "";

describe("nextToastRelease (pure)", () => {
  const all = ["host", "a", "b", PLAYER, "c", "d"];
  it("opens with the host and one speaker, never past the player, the player alone, then on", () => {
    expect(nextToastRelease(all, [], PLAYER, 1)).toEqual(["host", "a"]);
    expect(nextToastRelease(all, ["host", "a"], PLAYER, 1)).toEqual(["b"]);
    expect(nextToastRelease(all, ["host", "a"], PLAYER, 3)).toEqual(["b"]); // stops just before the player
    expect(nextToastRelease(all, ["host", "a", "b"], PLAYER, 3)).toEqual([PLAYER]);
    expect(nextToastRelease(all, ["host", "a", "b", PLAYER], PLAYER, 1)).toEqual(["c"]);
  });
  it("a speaker already done (voiced out of order) is skipped", () => {
    expect(nextToastRelease(all, ["host", "a", "c", "b", PLAYER], PLAYER, 1)).toEqual(["d"]);
    expect(nextToastRelease(all, ["host", "a", "b", PLAYER, "c", "d"], PLAYER, 1)).toEqual([]);
  });
});

describe("the champagne circle: one toast a turn, the player's slot waits, nobody toasts twice", () => {
  for (const seed of [41, 42, 43]) {
    it(`seed ${seed}: every plain release carries at most one houseguest; the player's slot comes alone, the circle waits on it, and the room answers it next`, () => {
      const sb = circle(seed);
      let sawPlayer = false;
      let answered = false;
      for (let i = 0; i < 40 && sb.session.premiereIntros()?.entrance?.stage === "toast"; i++) {
        sb.session.advanceGame();
        const e = sb.session.premiereIntros()?.entrance;
        if (!e || e.stage !== "toast") break;
        const sp = speakersOf(sb);
        const people = sp.filter((x) => !x.host && !x.isPlayer);
        expect(people.length, JSON.stringify(sp)).toBeLessThanOrEqual(1);
        const line = toastLine(sb);
        if (sp.some((x) => x.isPlayer)) {
          sawPlayer = true;
          expect(people, "the player's slot is never released with a houseguest").toHaveLength(0);
          expect(line).toMatch(/PLAYER'S TURN TO TOAST, AND THE CIRCLE WAITS/);
          expect(line).toMatch(/No houseguest gives a toast/);
          expect(line).not.toMatch(/Call advanceGame for the next batch/);
        } else if (sawPlayer && !answered) {
          answered = true;
          expect(e.playerJustToasted, "the release after the player's slot follows their toast").toBe(true);
          expect(line).toMatch(/THE PLAYER HAS JUST GIVEN THEIR TOAST/);
        } else {
          expect(e.playerJustToasted).toBeUndefined();
        }
        if (people.length === 1) {
          expect(line).toMatch(/react to it and play off it/);
          expect(line).toMatch(/ONLY the speaker named in this batch toasts/);
        }
      }
      expect(sawPlayer).toBe(true);
    });
  }

  it("toasts the narration already showed are recorded as spoken and never released again (the 11-28 overrun)", () => {
    const sb = circle(44);
    sb.session.advanceGame(); // the host + the first speaker
    const pe = sb.session.snapshot().live!.premiereEntrance!;
    const ahead = pe.order.filter((x) => x !== PLAYER && !pe.spoke.includes(x)).slice(0, 6);
    const names = ahead.map((id) => {
      const h = sb.session.snapshot().house!.npcs.find((x) => x.id === id)! as unknown as { name?: string; character?: { name?: string } };
      return String(h.character?.name ?? h.name ?? "");
    });
    expect(names.every((x) => x.length > 0)).toBe(true);
    const released: string[] = [];
    for (let i = 0; i < 40 && sb.session.premiereIntros()?.entrance?.stage === "toast"; i++) {
      const v = sb.session.advanceGame(i === 0 ? { toastVoiced: names } : {});
      for (const x of ((v.event?.detail as { speakers?: Array<string | { id: string; isPlayer?: boolean }> } | undefined)?.speakers) ?? []) {
        if (typeof x !== "string" && !x.isPlayer) released.push(x.id);
      }
    }
    expect(sb.session.premiereIntros()?.entrance?.stage ?? "done").toBe("done");
    for (const id of ahead) expect(released, `${id} was voiced already; never released again`).not.toContain(id);
    expect(new Set(released).size, "no houseguest released twice").toBe(released.length);
    const spoke = sb.session.snapshot().live!.premiereEntrance!.spoke;
    expect(new Set(spoke.filter((x) => x !== "host" && x !== PLAYER)).size, "every houseguest is in the done list once").toBe(15);
  });

  it("an unknown or player name in toastVoiced records nothing", () => {
    const sb = circle(45);
    sb.session.advanceGame();
    const before = [...sb.session.snapshot().live!.premiereEntrance!.spoke];
    sb.session.advanceGame({ toastVoiced: ["Nobody Here", "The Player"] });
    const after = sb.session.snapshot().live!.premiereEntrance!.spoke;
    expect(after.length - before.length, "only this advance's own release was added").toBeLessThanOrEqual(1);
    expect(after.slice(0, before.length)).toEqual(before);
  });
});
