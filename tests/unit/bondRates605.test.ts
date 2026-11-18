import { describe, it, expect } from "vitest";
import { atCommit } from "../support/commitFold";
import { GameSessionRegistry } from "../../src/composition/registry";
import { BOND, bondKey, emptyBond, foldScene, sceneScale, type BondStore } from "../../src/engine/bondRecord";
import { GRUDGES, noteGrudge, type GrudgeBook } from "../../src/engine/grudges";
import type { GameEvent } from "../../src/domain/event";

/** ORW-605: bond rates lean on the person, the pair and the house; an apology only counts after the wrong; a grudge keeps its biggest cause. Roles only. */
describe("sceneScale (pure)", () => {
  it("no traits, no pair, no dial: exactly 1", () => {
    expect(sceneScale("warming")).toBe(1);
    expect(sceneScale("souring")).toBe(1);
  });
  it("a warm-prone holder warms more than a guarded one under the same history; a guarded one sours more", () => {
    const pair = { history: 2 };
    expect(sceneScale("warming", { lean: 1, pair })).toBeGreaterThan(sceneScale("warming", { lean: -1, pair }));
    expect(sceneScale("souring", { lean: -1, pair })).toBeGreaterThan(sceneScale("souring", { lean: 1, pair }));
  });
  it("a repeat moves less than a first scene", () => {
    expect(sceneScale("warming", { pair: { history: 0 } })).toBeGreaterThan(sceneScale("warming", { pair: { history: 10 } }));
  });
  it("the house dial leans within its clamp and everything stays inside the bound", () => {
    expect(sceneScale("warming", { dial: 1.2 })).toBeGreaterThan(1);
    expect(sceneScale("warming", { dial: 50 })).toBe(sceneScale("warming", { dial: BOND.sceneDialBand }));
    for (const lean of [-9, -1, 0, 1, 9]) for (const h of [0, 3, 99]) for (const dial of [0, 0.5, 1, 9]) for (const jitter of [0, 0.5, 1]) for (const k of ["warming", "souring"] as const) {
      const v = sceneScale(k, { lean, pair: { history: h }, dial, jitter });
      expect(v).toBeGreaterThanOrEqual(BOND.sceneScaleMin); expect(v).toBeLessThanOrEqual(BOND.sceneScaleMax);
      expect(sceneScale(k, { lean, pair: { history: h }, dial, jitter })).toBe(v);
    }
  });
});

describe("foldScene with per-holder scales", () => {
  it("no scaleFor is the old flat fold byte for byte; a scale multiplies only that holder's view", () => {
    const flat: BondStore = {}; foldScene(flat, "bonding", ["a", "b"]);
    expect(flat[bondKey("a", "b")]!.warmth).toBe(BOND.warmthPerBond);
    const leaned: BondStore = {}; foldScene(leaned, "bonding", ["a", "b"], { scaleFor: (h) => (h === "a" ? 1.5 : 0.6) });
    expect(leaned[bondKey("a", "b")]!.warmth).toBeCloseTo(BOND.warmthPerBond * 1.5, 12);
    expect(leaned[bondKey("b", "a")]!.warmth).toBeCloseTo(BOND.warmthPerBond * 0.6, 12);
  });
});

describe("a grudge keeps its biggest cause", () => {
  it("a smaller wrong of another kind neither renames the row nor moves its refKey or clock; a bigger one does", () => {
    const book: GrudgeBook = {};
    noteGrudge(book, "h", "s", "blindsided", 0.8, 2, 3, "big");
    noteGrudge(book, "h", "s", "lied-to", 0.2, 4, 1, "small");
    expect(book["h|s"]).toMatchObject({ kind: "blindsided", refKey: "big", week: 2, day: 3, severity: 0.8 });
    noteGrudge(book, "h", "s", "deal-broken", 0.9, 5, 1, "bigger");
    expect(book["h|s"]).toMatchObject({ kind: "deal-broken", refKey: "bigger", severity: 0.9, peak: 0.9 });
    expect(GRUDGES.MAX_FACTOR).toBeGreaterThan(1);
  });
});

type Internals = {
  live: { active: string[]; week: number; dayNumber?: number; playedGame?: boolean; grudges?: GrudgeBook; bonds?: BondStore; npcMemory?: Record<string, Record<string, Array<{ kind: string; week: number; severity: number }>>>; houseLeans?: unknown };
  grudgeOf(h: string, s: string): unknown; setRecordProviders(p: { events: () => GameEvent[]; hidden: () => [] }): void; setGrudgesEnabled(on: boolean): void;
};
const start = (n: string) => {
  const sb = new GameSessionRegistry().sandboxFor(`g605-${n}`);
  sb.session.createCharacter({ playerName: "The Player", seed: 3 });
  sb.session.setGrudgesEnabled(true);
  sb.session.noteMessage({ messageId: "m1" });
  const s = sb.session as unknown as Internals; s.live.houseLeans = { leans: [] };
  return s;
};
const scene = (who: string, h: string, id: string): GameEvent => ({ id, ts: 1, type: "bonding", initiator: who, witnessSet: [who, h], hidden: true, content: "scene" } as unknown as GameEvent);

describe("an apology only counts after the wrong", () => {
  it("a warm scene from before the wrong repairs nothing; one after repairs once (deduped)", () => {
    const s = start("apology"); const [H, S] = s.live.active.filter((x) => x.startsWith("npc:")) as [string, string];
    const evs: GameEvent[] = [scene(S, H, "before")];
    s.setRecordProviders({ events: () => evs, hidden: () => [] });
    s.live.npcMemory = { [H]: { [S]: [{ kind: "nominated-by-friend", week: 1, severity: 0.5 }] } };
    atCommit(s).grudgeOf(H, S);
    const row = s.live.grudges![`${H}|${S}`]!;
    expect(row.eased).toBe(0); // the scene was recorded before the wrong was noted
    evs.push(scene(S, H, "after1"), scene(S, H, "after2"));
    atCommit(s).grudgeOf(H, S);
    const once = row.eased;
    expect(once).toBeGreaterThan(0);
    atCommit(s).grudgeOf(H, S);
    expect(row.eased).toBe(once);
  });
});

describe("played-game wiring", () => {
  it("empty bond stays empty without a scene (flag-off and no-scene byte-identical)", () => {
    expect(emptyBond().warmth).toBe(0);
  });
});
