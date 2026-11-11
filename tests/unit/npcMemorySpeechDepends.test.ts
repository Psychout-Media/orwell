import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";

/** ORW-131 (Ryne 2026-11-06, "depends on them"): how often / which memory a houseguest raises depends on personality, relationship and how much the memory matters - not a fixed once-a-day cap. Roles only. */
type Mem = { kind: string; week: number; severity: number };
type S = {
  live: { week: number; dayNumber?: number; npcMemory?: Record<string, Record<string, Mem[]>> };
  house: { npcs: { id: string; character: { stats: { social: number } }; soul: { volatility: number } }[] };
  rel: { edge(a: string, b: string): { trust: number; affinity: number } };
  setNpcMemoryEnabled(on: boolean): void;
  setNpcMemorySpeechEnabled(on: boolean): void;
  npcVoice(id: EntityId): { rememberedAboutYou?: string[]; bringUp?: true } | null;
};
function game() {
  const sb = new GameSessionRegistry().sandboxFor(`mem2-${Math.random()}`);
  sb.session.createCharacter({ playerName: "The Player", archetype: "floater", seed: 11 });
  const s = sb.session as unknown as S;
  const [talker, quiet] = sb.session.livingIds().filter((i) => i !== PLAYER);
  s.setNpcMemoryEnabled(true); s.setNpcMemorySpeechEnabled(true);
  s.live.npcMemory = {};
  const set = (id: string, social: number, vol: number) => { const n = s.house.npcs.find((q) => q.id === id)!; n.character.stats.social = social; n.soul.volatility = vol; };
  set(talker!, 0.95, 0.9); set(quiet!, 0.05, 0.05);
  return { s, talker: talker!, quiet: quiet! };
}
const put = (s: S, holder: string, e: Mem[]) => { (s.live.npcMemory![holder] ??= {})[PLAYER] = e; };
/** days on which the houseguest raised something, over 40 days, each day asked a few times */
function raises(s: S, id: string, calls = 4): { days: number; total: number; maxPerDay: number } {
  let days = 0, total = 0, maxPerDay = 0;
  for (let d = 1; d <= 40; d++) {
    s.live.dayNumber = d;
    const n = Array.from({ length: calls }, () => s.npcVoice(id)!.bringUp === true).filter(Boolean).length;
    total += n; maxPerDay = Math.max(maxPerDay, n); if (n > 0) days++;
  }
  return { days, total, maxPerDay };
}
// several distinct memories so a repeat-guard never starves the test
const FAVORS = (w: number): Mem[] => ["scene-kindness", "veto-saved", "deal-kept", "secret-given"].flatMap((kind, i) => [{ kind, week: w, severity: 0.95 - i * 0.05 }, { kind, week: w - 1, severity: 0.9 - i * 0.05 }]);
const RICH = (w: number): Mem[] => FAVORS(w);

describe("memory in speech depends on the houseguest (ORW-131)", () => {
  it("a talkative houseguest raises things more often than a reserved one holding the same memories", () => {
    const { s, talker, quiet } = game();
    put(s, talker, RICH(s.live.week)); put(s, quiet, RICH(s.live.week));
    for (const id of [talker, quiet]) { const e = s.rel.edge(id, PLAYER); e.trust = 0.9; e.affinity = 0.9; } // equally close: only personality differs
    const t = raises(s, talker), q = raises(s, quiet);
    expect(t.total).toBeGreaterThan(q.total);
    expect(t.days).toBeGreaterThan(q.days);
  });
  it("a talkative houseguest may raise more than once in a day (up to the ceiling); a reserved one stays at one", () => {
    const { s, talker, quiet } = game();
    put(s, talker, RICH(s.live.week)); put(s, quiet, RICH(s.live.week));
    expect(raises(s, talker, 6).maxPerDay).toBeGreaterThan(1);
    expect(raises(s, talker, 6).maxPerDay).toBeLessThanOrEqual(3);
    for (const id of [talker, quiet]) { const e = s.rel.edge(id, PLAYER); e.trust = 0.9; e.affinity = 0.9; }
    expect(raises(s, quiet, 6).maxPerDay).toBeLessThanOrEqual(1); // favors only: no grievance bonus
  });
  it("an aggrieved houseguest (a fresh grievance) raises it more than one holding only a mild favor of the same weight", () => {
    const g = game();
    put(g.s, g.talker, [{ kind: "scene-betrayal", week: g.s.live.week, severity: 0.6 }]);
    put(g.s, g.quiet, [{ kind: "scene-kindness", week: g.s.live.week, severity: 0.6 }]);
    g.s.house.npcs.find((n) => n.id === g.quiet)!.character.stats.social = 0.95; g.s.house.npcs.find((n) => n.id === g.quiet)!.soul.volatility = 0.9; // equally chatty
    g.s.rel.edge(g.quiet, PLAYER).trust = 0; g.s.rel.edge(g.quiet, PLAYER).affinity = 0;
    expect(raises(g.s, g.talker, 1).total).toBeGreaterThan(raises(g.s, g.quiet, 1).total);
  });
  it("never robotic: the same memory is not raised again within the repeat window, then can return", () => {
    const { s, talker } = game();
    put(s, talker, [{ kind: "scene-betrayal", week: s.live.week, severity: 1 }]); // ONE memory
    const dayHits: number[] = [];
    for (let d = 1; d <= 12; d++) { s.live.dayNumber = d; dayHits.push(s.npcVoice(talker)!.bringUp === true ? d : 0); }
    const hits = dayHits.filter(Boolean);
    expect(hits.length).toBeGreaterThan(0);
    for (let i = 1; i < hits.length; i++) expect(hits[i]! - hits[i - 1]!).toBeGreaterThanOrEqual(3);
  });
  it("only held memories: a houseguest who holds none raises none; the facts never name anyone else's memory", () => {
    const { s, talker, quiet } = game();
    put(s, talker, RICH(s.live.week));
    for (let d = 1; d <= 20; d++) { s.live.dayNumber = d; expect(s.npcVoice(quiet)!.bringUp).toBeUndefined(); expect("rememberedAboutYou" in s.npcVoice(quiet)!).toBe(false); }
  });
  it("is deterministic for a given seed and day, and Vault-free (no number or slug crosses)", () => {
    const a = game(), b = game();
    put(a.s, a.talker, RICH(a.s.live.week)); put(b.s, b.talker, RICH(b.s.live.week));
    expect(raises(a.s, a.talker)).toEqual(raises(b.s, b.talker));
    expect(JSON.stringify(a.s.npcVoice(a.talker)!.rememberedAboutYou)).not.toMatch(/\d|scene-|deal-broken|severity/);
  });
});
