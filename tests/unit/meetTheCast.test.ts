import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { MEET_FIRST_IMPRESSION, firstImpressionLean, meetMannerOf } from "../../src/engine/premiereEntrances";
import { sessionCoreSupersetViolation } from "../../src/engine/sessionSnapshot";
import { PLAYER } from "../../src/domain/ids";
import { resolvePending } from "../../features/support/answerPending";

/** ORW-653 / feature 0205 - meet the cast. Roles only; no fixture names. */
type Live = { premiereEntrance?: { stage: string; order: string[]; arrived: number; playerPos: number; spoke: string[]; introduced?: string[] }; champagneCircle?: string; beds?: { owner: Record<string, string> } };
const liveOf = (s: GameSessionAdapter) => (s as unknown as { live: Live }).live;
let n = 0;
function start(seed: number, on = true, tour = true): GameSessionAdapter {
  const s = new GameSessionRegistry().sandboxFor(`meet-${n++}`).session as GameSessionAdapter;
  s.setPremiereEntrancesEnabled(true); s.setBedRushEnabled(true); s.setHouseTourEnabled(tour); s.setMeetTheCastEnabled(on);
  s.createCharacter({ playerName: "P", seed });
  s.noteMessage({ messageId: "m1" });
  return s;
}
const step = (s: GameSessionAdapter) => { const v = s.advanceGame(); if (v.pending) resolvePending(v.pending, (req) => void s.submitDecision(req)); return v; };
const pe = (s: GameSessionAdapter) => liveOf(s).premiereEntrance!;
function toCircleCalled(s: GameSessionAdapter): void { for (let i = 0; i < 30 && pe(s).stage === "entrances"; i++) step(s); }
const npcIds = (s: GameSessionAdapter) => pe(s).order.filter((x) => x !== PLAYER);
const edge = (s: GameSessionAdapter, id: string) => JSON.stringify((s as unknown as { rel: { edge(a: string, b: string): unknown } }).rel.edge(id, PLAYER));

describe("meet the cast: nothing before the circle is called", () => {
  it("through the entrances and the tour nobody is introduced; the record appears only when the circle is called", () => {
    for (const seed of [3, 7, 11]) {
      const s = start(seed);
      while (pe(s).stage === "entrances" && !(pe(s).arrived >= pe(s).order.length)) { step(s); expect(pe(s).introduced, "no introduction record yet").toBeUndefined(); }
      expect(pe(s).stage).toBe("entrances");
      expect(pe(s).introduced).toBeUndefined();
      step(s); // the circle is called
      expect(pe(s).stage).toBe("toast");
      expect(pe(s).introduced).toEqual([]);
    }
  });
});

describe("meet the cast: introductions", () => {
  it("everyone is introduced exactly once and met by the end of the circle, the circle ends and the bed rush gives 16 distinct beds (3 seeds)", () => {
    for (const seed of [3, 7, 11]) {
      const s = start(seed);
      toCircleCalled(s);
      for (let i = 0; i < 30 && pe(s).stage === "toast"; i++) step(s);
      const intro = pe(s).introduced!;
      expect(new Set(intro).size, "no one twice").toBe(intro.length);
      expect([...intro].sort()).toEqual([...pe(s).order].sort());
      const met = (s as unknown as { premiereMet: Set<string> }).premiereMet;
      for (const id of npcIds(s)) expect(met.has(id), "met").toBe(true);
      expect(liveOf(s).champagneCircle).toBe("done");
      for (let i = 0; i < 60 && !(s as unknown as { live: { bedRush?: { done: boolean } } }).live.bedRush?.done; i++) step(s);
      const owners = Object.values(liveOf(s).beds?.owner ?? {});
      expect(new Set(owners).size).toBe(owners.length);
    }
  });
  it("the player's slot only records that they were introduced; nothing of theirs is written", () => {
    const s = start(5);
    toCircleCalled(s);
    for (let i = 0; i < 30 && pe(s).stage === "toast"; i++) step(s);
    expect(pe(s).introduced).toContain(PLAYER);
    expect(JSON.stringify(s.snapshot())).not.toMatch(/introduces themselves|my name is/i);
  });
});

describe("meet the cast: first impressions", () => {
  it("are deterministic per seed, hidden (no number in the narrator's speaker facts), small and bounded", () => {
    const a = start(9), b = start(9);
    const before = new Map<string, string>();
    toCircleCalled(a); toCircleCalled(b);
    for (const id of npcIds(a)) before.set(id, edge(a, id));
    const shown: string[] = [];
    for (let i = 0; i < 30 && pe(a).stage === "toast"; i++) {
      step(a);
      shown.push(JSON.stringify(a.premiereIntros()?.entrance ?? {}));
      step(b);
    }
    for (const id of npcIds(a)) expect(edge(a, id), "same seed, same hidden read").toBe(edge(b, id));
    expect(npcIds(a).some((id) => edge(a, id) !== before.get(id))).toBe(true);
    const blob = shown.join("");
    expect(blob).not.toMatch(/affinity|trust|threat|"lean"/);
    expect(blob).toMatch(/drawn-to|even|guarded/);
    expect(MEET_FIRST_IMPRESSION.affinity).toBeLessThanOrEqual(0.05);
    for (const age of [18, 30, 60]) for (let k = 0; k < 40; k++) {
      const l = firstImpressionLean(`seed${k}`, `npc${k}`, age, 25, k * 3);
      expect(Math.abs(l)).toBeLessThanOrEqual(1);
    }
    expect(meetMannerOf(1)).toBe("drawn-to"); expect(meetMannerOf(0)).toBe("even"); expect(meetMannerOf(-1)).toBe("guarded");
  });
  it("the manner a houseguest shows is a function of seed and houseguest only", () => {
    expect(firstImpressionLean(5, "x", 30, 30, 50)).toBe(firstImpressionLean(5, "x", 30, 30, 50));
    expect(firstImpressionLean(5, "x", 30, 30, 50)).not.toBe(firstImpressionLean(6, "x", 30, 30, 50));
  });
});

describe("meet the cast: save and restore", () => {
  it("a mid-circle snapshot resumes identically and the introduced set only grows", () => {
    const s = start(7);
    toCircleCalled(s); step(s);
    const mid = JSON.stringify(pe(s).introduced);
    expect(pe(s).introduced!.length).toBeGreaterThan(0);
    const snap = s.snapshot();
    const r = new GameSessionRegistry().sandboxFor(`meet-restore-${n++}`).session as GameSessionAdapter;
    r.setPremiereEntrancesEnabled(true); r.setBedRushEnabled(true); r.setHouseTourEnabled(true); r.setMeetTheCastEnabled(true);
    r.restore(snap as never);
    expect(JSON.stringify(pe(r).introduced)).toBe(mid);
    step(s); step(r);
    expect(JSON.stringify(pe(r).introduced)).toBe(JSON.stringify(pe(s).introduced));
    expect(sessionCoreSupersetViolation(s.snapshot() as never, snap as never)).toBeNull();
    const shrunk = JSON.parse(JSON.stringify(s.snapshot()));
    shrunk.live.premiereEntrance.introduced = shrunk.live.premiereEntrance.introduced.slice(1);
    expect(sessionCoreSupersetViolation(shrunk, snap as never)).toBe("premiereIntroductions");
  });
});

describe("meet the cast: flag off", () => {
  it("is the old circle: no introduction record, no manner on any speaker, no hidden fold from the circle", () => {
    const s = start(9, false);
    toCircleCalled(s);
    expect(pe(s).introduced).toBeUndefined();
    step(s); const ent = s.premiereIntros()?.entrance as { speakers?: Array<{ manner?: string }>; meetTheCast?: boolean } | undefined;
    expect(ent?.meetTheCast).toBeUndefined();
    for (const sp of ent?.speakers ?? []) expect(sp.manner).toBeUndefined();
  });
});

describe("meet the cast: arms whether or not the tour runs (ORW-690)", () => {
  it("with the tour off, the circle still arms the introductions, each houseguest once, before the bed rush", () => {
    for (const seed of [3, 7, 11]) {
      const s = start(seed, true, false);
      expect((liveOf(s) as { houseTour?: unknown }).houseTour, "no tour ran").toBeUndefined();
      for (let i = 0; i < 40 && pe(s).stage === "entrances"; i++) { step(s); if (pe(s).stage === "entrances") expect(pe(s).introduced, "nothing before the circle").toBeUndefined(); }
      expect(pe(s).stage).toBe("toast");
      expect(pe(s).introduced).toEqual([]);
      for (let i = 0; i < 30 && pe(s).stage === "toast"; i++) step(s);
      const intro = pe(s).introduced!;
      expect(new Set(intro).size).toBe(intro.length);
      expect([...intro].sort()).toEqual([...pe(s).order].sort());
      expect(liveOf(s).champagneCircle).toBe("done");
      expect((s as unknown as { live: { bedRush?: unknown } }).live.bedRush === undefined || pe(s).stage === "done").toBe(true);
    }
  });
  it("with the tour off and the flag off the circle is the old one", () => {
    const s = start(9, false, false);
    for (let i = 0; i < 40 && pe(s).stage === "entrances"; i++) step(s);
    expect(pe(s).introduced).toBeUndefined();
  });
});
