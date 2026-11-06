import { describe, it, expect, vi } from "vitest";

// P0 flip: the adapter tests assert the flag-off/ON-only behaviour of the tells layer in isolation. Those layers now default ON, so this file pins them OFF explicitly (hoisted: some adapter consts read env at import). Tests that need a layer ON turn it on through its setter.
vi.hoisted(() => { for (const k of ["ORWELL_ASSURANCES", "ORWELL_VOTE_COUNT", "ORWELL_VETO_MEMORY", "ORWELL_DEAL_NOMS", "ORWELL_CAMPAIGN_MEMORY", "ORWELL_APPROACH_MEMORY", "ORWELL_HC_MEMORY", "ORWELL_MEMORY_PROMISES", "ORWELL_FORGIVENESS", "ORWELL_LOBBYING", "ORWELL_DESIRE_CLOCK", "ORWELL_WANT_MOVEMENT", "ORWELL_MULTI_NIGHT_FATIGUE", "ORWELL_MORNING_APPROACH", "ORWELL_NPC_TELLS", "ORWELL_TELL_REACTIONS", "ORWELL_MOOD_VETO", "ORWELL_MOOD_APPROACH", "ORWELL_MOOD_DEAL", "ORWELL_MOOD_CAMPAIGN", "ORWELL_DRIFT_FIX", "ORWELL_NPC_MEMORY_SPEECH", "ORWELL_DRIVE_DECISIONS"]) process.env[k] = "0"; });
import { GameSessionRegistry } from "../../src/composition/registry";
import { refreshTells, tellsOf, type PersistedTell } from "../../src/engine/tells";
import { sessionCoreCounts, sessionCoreCountsNonDecreasing } from "../../src/engine/sessionSnapshot";
import type { SessionSnapshot } from "../../src/engine/sessionSnapshot";
import { PLAYER } from "../../src/domain/ids";
import type { Soul } from "../../src/engine/characterFactory";

/**
 * B28 (#2017 15.2 E0b, flag ORWELL_NPC_TELLS): tells PERSIST on the soul - `{kind, since, band}` - and follow the emotional arc with `tellsOf`'s hysteresis against the PREVIOUS record, so the same houseguest is
 * still brittle tomorrow. A monotonic `tellOnsetCount` rides the session so the checkpoint can prove the layer never loses history. Flag off => nothing written (byte-identical). No narrator wiring here (A49 reads it).
 * Roles only.
 */
const soul = (over: Partial<Soul> = {}): Soul => ({ emotionalBaseline: 0.5, volatility: 0.5, emotionalState: 0.5, emotionalHistory: [], memory: [], ...over });
const rattled = (): Soul => soul({ distress: 0.9, confidence: 0.1, emotionalState: 0.1, volatility: 0.8 });

describe("refreshTells (pure)", () => {
  it("a calm soul has no record and no onset", () => {
    expect(refreshTells(soul(), 3)).toEqual({ tells: [], onsets: 0 });
  });
  it("new kinds are stamped with the week they began and counted as onsets; they keep `since` while they persist, even as the band changes", () => {
    const s = rattled();
    const first = refreshTells(s, 2);
    expect(first.onsets).toBe(first.tells.length);
    expect(first.tells.length).toBeGreaterThan(0);
    expect(first.tells.every((t) => t.since === 2)).toBe(true);
    s.tells = first.tells;
    const later = refreshTells(s, 7);
    expect(later.onsets, "nothing new began").toBe(0);
    expect(later.tells.map((t) => [t.kind, t.since])).toEqual(first.tells.map((t) => [t.kind, t.since]));
  });
  it("a tell that fades is dropped from the record, and a later return counts as a NEW onset with a new `since`", () => {
    const s = rattled();
    s.tells = refreshTells(s, 1).tells;
    Object.assign(s, { distress: 0.1, confidence: 0.5, emotionalState: 0.5, volatility: 0.2 });
    const calm = refreshTells(s, 4);
    expect(calm.tells).toEqual([]);
    s.tells = calm.tells;
    Object.assign(s, { distress: 0.9, confidence: 0.1, emotionalState: 0.1, volatility: 0.8 });
    const back = refreshTells(s, 9);
    expect(back.onsets).toBeGreaterThan(0);
    expect(back.tells.every((t) => t.since === 9)).toBe(true);
  });
  it("hysteresis across the day boundary: a wobble just below the show edge keeps a tell that was already visible, a fresh read would drop it", () => {
    // find a distress level where the fresh read shows nothing but a previous record keeps the tell (the margin the hysteresis exists for)
    let found = false;
    for (let d = 0.50; d <= 0.80 && !found; d += 0.005) {
      const base = (dd: number): Soul => soul({ distress: dd, confidence: 0.15, emotionalState: 0.2, volatility: 0.4 });
      const high = refreshTells(base(d + 0.06), 1).tells;
      if (!high.length) continue;
      const wobble = base(d);
      const fresh = tellsOf(wobble).map((t) => t.kind);
      wobble.tells = high;
      const kept = refreshTells(wobble, 2).tells.map((t) => t.kind);
      if (high.some((h) => !fresh.includes(h.kind) && kept.includes(h.kind))) { found = true; expect(refreshTells(wobble, 2).tells.find((t) => kept.includes(t.kind))!.since).toBe(1); }
    }
    expect(found, "there is a band where the persisted record holds a tell a fresh read would drop").toBe(true);
  });
});

type Internals = {
  inflect(id: string, event: string): void;
  soulObj(id: string): Soul | undefined;
  setNpcTellsEnabled(on: boolean): void;
  snapshot(): SessionSnapshot;
  restore(s: SessionSnapshot): void;
};
function game(on: boolean) {
  const sb = new GameSessionRegistry().sandboxFor(`b28-${Math.random()}`);
  sb.session.createCharacter({ playerName: "The Player", archetype: "floater", seed: 7 });
  const s = sb.session as unknown as Internals;
  s.setNpcTellsEnabled(on);
  const npc = sb.session.livingIds().filter((i) => i !== PLAYER)[0]!;
  return { sb, s, npc };
}
const rattle = (s: Internals, id: string) => { const so = s.soulObj(id)!; Object.assign(so, { distress: 0.92, confidence: 0.08, emotionalState: 0.1, volatility: 0.8 }); };

describe("the adapter keeps the record on the arc", () => {
  it("OFF: an arc event writes no tells and the snapshot carries no tellOnsetCount (byte-identical)", () => {
    const { s, npc } = game(false);
    rattle(s, npc);
    s.inflect(npc, "betrayed");
    expect(s.soulObj(npc)!.tells).toBeUndefined();
    expect("tellOnsetCount" in s.snapshot()).toBe(false);
  });
  it("ON: an arc event refreshes the record, counts the onset, and the whole thing survives a snapshot -> restore round trip", () => {
    const { s, npc } = game(true);
    rattle(s, npc);
    s.inflect(npc, "betrayed");
    const rec = s.soulObj(npc)!.tells as PersistedTell[];
    expect(rec && rec.length).toBeGreaterThan(0);
    expect(rec.every((t) => Object.keys(t).sort().join() === "band,kind,since")).toBe(true);
    const snap = s.snapshot();
    expect(snap.tellOnsetCount).toBe(rec.length);
    const fresh = game(true);
    fresh.s.restore(JSON.parse(JSON.stringify(snap)));
    expect(fresh.s.soulObj(npc)!.tells).toEqual(rec);
    expect(fresh.s.snapshot().tellOnsetCount).toBe(rec.length);
  });
  it("ON: the persisted record is what npcVoice reads (the tell is stable until the arc moves it), and a second arc event on the same kind adds no onset", () => {
    const { s, npc } = game(true);
    rattle(s, npc);
    s.inflect(npc, "betrayed");
    const n1 = s.snapshot().tellOnsetCount;
    s.inflect(npc, "betrayed");
    expect(s.snapshot().tellOnsetCount, "the same kinds persisted: no new onset").toBe(n1);
  });
});

describe("the session checkpoint knows the tells counter", () => {
  it("sessionCoreCounts reads tellOnsetCount and a drop is flagged as a non-monotonic regression", () => {
    const snap = (n?: number) => ({ started: true, week: 1, phase: "x", ceremony: { nominees: [], vetoUsed: false }, house: null, events: [], relationships: [], ...(n === undefined ? {} : { tellOnsetCount: n }) }) as SessionSnapshot;
    expect(sessionCoreCounts(snap()).tellOnsetCount).toBe(0);
    expect(sessionCoreCounts(snap(3)).tellOnsetCount).toBe(3);
    expect(sessionCoreCountsNonDecreasing(sessionCoreCounts(snap(3)), sessionCoreCounts(snap(2)))).toBe(true);
    expect(sessionCoreCountsNonDecreasing(sessionCoreCounts(snap(1)), sessionCoreCounts(snap(2)))).toBe(false);
  });
});
