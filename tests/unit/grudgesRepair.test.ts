import { describe, it, expect } from "vitest";
import { atCommit } from "../support/commitFold";
import { GameSessionRegistry } from "../../src/composition/registry";
import { GRUDGES, REPAIR, combineSalience, repairAmount, type GrudgeBook } from "../../src/engine/grudges";
import { AGENDA } from "../../src/engine/agendaConstants";
import { recheckAgenda, seedAgenda, type AgendaBoard, type AgendaView } from "../../src/engine/agenda";
import { bondKey, emptyBond, foldBreak, foldRepair, foldScene } from "../../src/engine/bondRecord";
import { hesitation } from "../../src/engine/bondFeelings";
import type { GameEvent } from "../../src/domain/event";

/** Feature 0182 (Theme 3 slice 5, PR 2): revenge reads the grudge book; repairs ease it. Roles only. */
type Row = { eased: number; peak: number; severity: number };
type Internals = {
  live: { active: string[]; week: number; playedGame?: boolean; grudges?: GrudgeBook; grudgesSeen?: string[]; grudgesCursor?: number; bonds?: import("../../src/engine/bondRecord").BondStore;
    npcMemory?: Record<string, Record<string, Array<{ kind: string; week: number; severity: number }>>>; houseLeans?: unknown };
  deals: { make(p: [string, string], k: string, t: string, e?: string, w?: number): { id: string; status: string; brokenBy?: string } };
  snapshot(): unknown; restore(c: unknown): void; settleOvernight(n: number): number;
  grudgeOf(h: string, s: string): { freshness: number; severity: number; peak: number } | null;
  agendaView(id: string): AgendaView; agendaBoard(): AgendaBoard; setGrudgesEnabled(on: boolean): void;
  setRecordProviders(p: { events: () => GameEvent[]; hidden: () => [] }): void;
  bondReader(): { bond(h: string, o: string): { resentment: number; peakResentment: number; strain: number; warmth: number } };
  npcVoice(id: string): unknown; getMomentPrompt(a: unknown): { systemPrompt: string };
};
const start = (seed: number, n: string, on = true) => {
  const sb = new GameSessionRegistry().sandboxFor(`g182r-${n}-${seed}-${on}`);
  sb.session.createCharacter({ playerName: "The Player", seed });
  sb.session.setGrudgesEnabled(on);
  sb.session.noteMessage({ messageId: "m1" });
  const s = sb.session as unknown as Internals;
  s.live.houseLeans = { leans: [] }; // a neutral house unless a test says otherwise
  return { sb, s };
};
const npcs = (s: Internals): string[] => s.live.active.filter((x) => x.startsWith("npc:"));
const cut = (s: Internals, h: string, who: string, severity = 0.5): void => { s.live.npcMemory = { ...(s.live.npcMemory ?? {}), [h]: { ...(s.live.npcMemory?.[h] ?? {}), [who]: [{ kind: "nominated-by-friend", week: 1, severity }] } }; };
const salOf = (s: Internals, h: string, who: string): number => s.agendaView(h).grudges.find((g) => g.toward === who)?.salience ?? 0;
const row = (s: Internals, h: string, who: string): Row => s.live.grudges![`${h}|${who}`] as unknown as Row;
const keptDeal = (s: Internals, a: string, b: string): void => { const d = s.deals.make([a, b], "safety", "terms", undefined, 1); d.status = "kept"; };

describe("pure helpers", () => {
  it("combine is a probabilistic-or: never below the memory, never above 1, never a sum", () => {
    expect(combineSalience(0.5, 0)).toBe(0.5);
    expect(combineSalience(0, 0)).toBe(0);
    for (const s of [0, 0.3, 0.6, 1]) for (const w of [0, 0.4, 1]) { const c = combineSalience(s, w); expect(c).toBeGreaterThanOrEqual(s); expect(c).toBeLessThanOrEqual(1); expect(c).toBeLessThanOrEqual(s + w * GRUDGES.revengeWeight * GRUDGES.MAX_FACTOR + 1e-12); }
    expect(combineSalience(0.5, 1, 1.35)).toBeGreaterThan(combineSalience(0.5, 1, 1));
    expect(combineSalience(0.5, 1, 1 / 1.35)).toBeLessThan(combineSalience(0.5, 1, 1));
    expect(combineSalience(0.5, 1, 50)).toBe(combineSalience(0.5, 1, 1.35));
  });
  it("a keeper and a loyal house forgive slower; a neutral one gets the base", () => {
    expect(repairAmount(REPAIR.kept)).toBe(REPAIR.kept);
    expect(repairAmount(REPAIR.kept, { keeper: true })).toBeLessThan(REPAIR.kept);
    expect(repairAmount(REPAIR.kept, { loyalty: 1.2 })).toBeLessThan(REPAIR.kept);
    expect(repairAmount(REPAIR.kept, { loyalty: 50 })).toBe(repairAmount(REPAIR.kept, { loyalty: GRUDGES.MAX_FACTOR }));
  });
});

describe("revenge reads the book", () => {
  it("a fresh grudge crosses the bar that the memory alone does not; flag off it does not", () => {
    const on = start(3, "r1").s; const off = start(3, "r1", false).s;
    const [H, S] = npcs(on); cut(on, H!, S!); atCommit(on).grudgeOf(H!, S!); cut(off, npcs(off)[0]!, npcs(off)[1]!); atCommit(off).grudgeOf(npcs(off)[0]!, npcs(off)[1]!);
    expect(salOf(off, npcs(off)[0]!, npcs(off)[1]!)).toBeLessThan(AGENDA.revengeGrudge);
    expect(salOf(on, H!, S!)).toBeGreaterThanOrEqual(AGENDA.revengeGrudge);
    const board = on.agendaBoard();
    const seeded = seedAgenda(on.agendaView(H!), board, 7);
    const goals = recheckAgenda(seeded, on.agendaView(H!), board, "week-start", 7).goals.filter((g) => g.kind === "revenge" && g.status === "active");
    expect(goals.map((g) => g.target)).toContain(S);
    const offV = off.agendaView(npcs(off)[0]!);
    const offGoals = recheckAgenda(seedAgenda(offV, off.agendaBoard(), 7), offV, off.agendaBoard(), "week-start", 7).goals.filter((g) => g.kind === "revenge");
    expect(offGoals).toEqual([]);
  });
  it("an old grudge does not cross; a repaired one falls below the bar and opens no revenge goal", () => {
    const { s } = start(3, "r2"); const [H, S] = npcs(s); cut(s, H!, S!); atCommit(s).grudgeOf(H!, S!);
    const before = salOf(s, H!, S!);
    s.live.week = 40;
    expect(salOf(s, H!, S!)).toBeLessThan(before);
    s.live.week = 1;
    const board = s.agendaBoard();
    const seeded = seedAgenda(s.agendaView(H!), board, 7);
    const open = recheckAgenda(seeded, s.agendaView(H!), board, "week-start", 7);
    expect(open.goals.some((g) => g.kind === "revenge" && g.target === S && g.status === "active")).toBe(true);
    keptDeal(s, H!, S!); atCommit(s).grudgeOf(H!, S!);
    expect(salOf(s, H!, S!)).toBeLessThan(AGENDA.revengeGrudge);
    const v = s.agendaView(H!);
    const fresh = recheckAgenda(seedAgenda(v, board, 7), v, board, "week-start", 7);
    expect(fresh.goals.some((g) => g.kind === "revenge" && g.target === S)).toBe(false);
  });
  it("a loyal, paranoid house holds it deeper than a neutral one", () => {
    const a = start(3, "r3").s; const b = start(3, "r3b").s;
    const [H, S] = npcs(a); cut(a, H!, S!); cut(b, H!, S!); atCommit(a).grudgeOf(H!, S!); atCommit(b).grudgeOf(H!, S!);
    b.live.houseLeans = { leans: [{ id: "ride-or-die", w: 1 }] };
    expect(salOf(b, H!, S!)).toBeGreaterThan(salOf(a, H!, S!));
  });
});

describe("repair sources", () => {
  it("a kept promise eases once, in the wronged-to-breaker direction only, and the memory stays", () => {
    const { s } = start(3, "p1"); const [H, S] = npcs(s); cut(s, H!, S!);
    atCommit(s).grudgeOf(H!, S!);
    foldBreak(s.live.bonds ??= {}, S!, H!); // the wronged side holds resentment
    const peakBefore = atCommit(s).bondReader().bond(H!, S!).peakResentment;
    const resBefore = atCommit(s).bondReader().bond(H!, S!).resentment;
    expect(peakBefore).toBeGreaterThan(0);
    keptDeal(s, H!, S!);
    atCommit(s).grudgeOf(H!, S!);
    expect(row(s, H!, S!).eased).toBeCloseTo(REPAIR.kept, 9);
    expect(s.live.grudges![`${S}|${H}`]).toBeUndefined();
    expect(atCommit(s).bondReader().bond(H!, S!).resentment).toBeLessThan(resBefore);
    expect(atCommit(s).bondReader().bond(H!, S!).peakResentment).toBe(peakBefore);
    expect(atCommit(s).grudgeOf(H!, S!)!.peak).toBe(0.5);
    const seen = JSON.stringify(s.live.grudges);
    atCommit(s).grudgeOf(H!, S!); s.settleOvernight(1);
    expect(JSON.stringify(s.live.grudges)).toBe(seen); // no second ease
  });
  it("the dedupe survives save and restore", () => {
    const { s } = start(3, "p2"); const [H, S] = npcs(s); cut(s, H!, S!); keptDeal(s, H!, S!); atCommit(s).grudgeOf(H!, S!);
    const snap = JSON.parse(JSON.stringify(s.snapshot()));
    const { s: t } = start(3, "p2b"); t.restore(snap);
    const eased = row(t, H!, S!).eased;
    atCommit(t).grudgeOf(H!, S!); t.settleOvernight(1);
    expect(row(t, H!, S!).eased).toBe(eased);
  });
  const apology = (s: Internals, who: string, h: string, id: string): GameEvent => ({ id, ts: 1, type: "bonding", initiator: who, witnessSet: [who, h], hidden: true, content: "scene" } as unknown as GameEvent);
  it("the wrongdoer's own bonding scene with the wronged eases it, once per pair and week; the wronged's own does not", () => {
    const { s } = start(3, "p3"); const [H, S] = npcs(s); cut(s, H!, S!); atCommit(s).grudgeOf(H!, S!);
    const evs: GameEvent[] = [apology(s, H!, S!, "e0")]; // the wronged reaching out is not an apology
    s.setRecordProviders({ events: () => evs, hidden: () => [] });
    atCommit(s).grudgeOf(H!, S!);
    expect(row(s, H!, S!).eased).toBe(0);
    evs.push(apology(s, S!, H!, "e1"), apology(s, S!, H!, "e2"));
    atCommit(s).grudgeOf(H!, S!);
    expect(row(s, H!, S!).eased).toBeCloseTo(REPAIR.scene, 9);
    evs.push(apology(s, S!, H!, "e3"));
    atCommit(s).grudgeOf(H!, S!);
    expect(row(s, H!, S!).eased).toBeCloseTo(REPAIR.scene, 9); // the same week: once
    s.live.week += 1;
    evs.push(apology(s, S!, H!, "e4"));
    atCommit(s).grudgeOf(H!, S!);
    expect(row(s, H!, S!).eased).toBeCloseTo(2 * REPAIR.scene, 9);
  });
  it("a scene long after the wrong does not read as an apology", () => {
    const { s } = start(3, "p4"); const [H, S] = npcs(s); cut(s, H!, S!); atCommit(s).grudgeOf(H!, S!);
    s.live.week += 5;
    s.setRecordProviders({ events: () => [apology(s, S!, H!, "e1")], hidden: () => [] });
    atCommit(s).grudgeOf(H!, S!);
    expect(row(s, H!, S!).eased).toBe(0);
  });
  it("a shared enemy eases both directions of a pair that fell out, once a week", () => {
    const { s } = start(3, "p5"); const [A, B, T] = npcs(s);
    cut(s, A!, T!); cut(s, B!, T!);
    s.live.npcMemory![A!]![B!] = [{ kind: "nominated-by-friend", week: 1, severity: 0.5 }];
    s.live.npcMemory![B!]![A!] = [{ kind: "nominated-by-friend", week: 1, severity: 0.5 }];
    atCommit(s).grudgeOf(A!, B!);
    expect(row(s, A!, B!).eased).toBeCloseTo(REPAIR.enemy, 9);
    expect(row(s, B!, A!).eased).toBeCloseTo(REPAIR.enemy, 9);
    atCommit(s).grudgeOf(A!, B!); s.settleOvernight(1);
    expect(row(s, A!, B!).eased).toBeCloseTo(REPAIR.enemy, 9);
    s.live.week += 1;
    atCommit(s).grudgeOf(A!, B!);
    expect(row(s, A!, B!).eased).toBeCloseTo(2 * REPAIR.enemy, 9);
    expect(row(s, A!, T!).eased).toBe(0); // the common enemy is not eased
  });
  it("the total is capped at 0.6 of the peak and the peak never falls", () => {
    const { s } = start(3, "p6"); const [H, S] = npcs(s); cut(s, H!, S!, 0.8);
    for (let i = 0; i < 30; i++) keptDeal(s, H!, S!);
    atCommit(s).grudgeOf(H!, S!);
    expect(row(s, H!, S!).eased).toBeCloseTo(GRUDGES.EASE_CAP * 0.8, 9);
    expect(atCommit(s).grudgeOf(H!, S!)!.peak).toBe(0.8);
    expect(atCommit(s).grudgeOf(H!, S!)!.freshness).toBeGreaterThan(0);
  });
  it("a loyal house forgives slower than a neutral one", () => {
    const a = start(3, "p7").s; const b = start(3, "p7b").s;
    const [H, S] = npcs(a); cut(a, H!, S!); cut(b, H!, S!);
    b.live.houseLeans = { leans: [{ id: "ride-or-die", w: 1 }] };
    keptDeal(a, H!, S!); keptDeal(b, H!, S!);
    atCommit(a).grudgeOf(H!, S!); atCommit(b).grudgeOf(H!, S!);
    expect(row(b, H!, S!).eased).toBeLessThan(row(a, H!, S!).eased);
    expect(row(b, H!, S!).eased).toBeGreaterThan(0);
  });
  it("the player is never a holder; a repair needs an open row", () => {
    const { s } = start(3, "p8"); const [H, S] = npcs(s);
    keptDeal(s, H!, S!); atCommit(s).grudgeOf(H!, S!);
    expect(s.live.grudges).toBeUndefined();
    expect(s.live.grudgesCursor).toBeUndefined();
  });
});

describe("slice 4 interaction: hesitation only reads resentment", () => {
  it("hesitation never falls when a repair lowers resentment, warmth is untouched, and it rises slowly", () => {
    const store = {} as Parameters<typeof foldScene>[0];
    foldScene(store, "bonding", ["h", "s"]); foldScene(store, "bonding", ["h", "s"]); foldScene(store, "bonding", ["h", "s"]);
    foldBreak(store, "s", "h");
    const rec = (): ReturnType<typeof emptyBond> => store[bondKey("h", "s")] as ReturnType<typeof emptyBond>;
    const warmth = rec().warmth; const peak = rec().peakResentment;
    let prev = hesitation(rec()); const first = prev;
    for (let i = 0; i < 12; i++) {
      const r0 = rec().resentment; foldRepair(store, "h", "s", 0.05);
      expect(rec().resentment).toBeLessThanOrEqual(r0);
      const h = hesitation(rec());
      expect(h).toBeGreaterThanOrEqual(prev - 1e-12); prev = h;
      expect(rec().warmth).toBe(warmth); expect(rec().peakResentment).toBe(peak);
    }
    expect(prev).toBeGreaterThan(first);
    expect(prev - first).toBeLessThan(0.3); // slow: far from a full forgiveness
  });
});

describe("flag off, headless, wall", () => {
  const wrong = (s: Internals): void => { const [H, S] = npcs(s); cut(s, H!, S!); keptDeal(s, H!, S!); };
  it("flag off: nothing new is written, byte-identical, seeds 3 and 11", () => {
    for (const seed of [3, 11]) {
      const a = start(seed, "f1", false).s; const b = start(seed, "f2", false).s; wrong(a); wrong(b);
      for (const x of [a, b]) { atCommit(x).grudgeOf(npcs(x)[0]!, npcs(x)[1]!); x.agendaView(npcs(x)[0]!); x.settleOvernight(1); }
      expect(JSON.stringify(a.snapshot())).toBe(JSON.stringify(b.snapshot()));
      const dump = JSON.stringify(a.snapshot());
      for (const k of ["\"grudges\":", "grudgesSeen", "grudgesCursor", "repair:"]) expect(dump).not.toContain(k);
    }
  });
  it("flag on with nothing wrong adds no key", () => {
    for (const seed of [3, 11]) {
      const on = start(seed, "n1", true).s; const off = start(seed, "n1", false).s;
      on.agendaView(npcs(on)[0]!); on.settleOvernight(1); off.settleOvernight(1);
      expect(JSON.stringify(on.snapshot())).toBe(JSON.stringify(off.snapshot()));
    }
  });
  it("headless: nothing folds", () => {
    const { s } = start(3, "h1"); wrong(s); s.live.playedGame = false;
    atCommit(s).grudgeOf(npcs(s)[0]!, npcs(s)[1]!); s.agendaView(npcs(s)[0]!);
    expect(s.live.grudges).toBeUndefined();
  });
  it("the wall: no grudge, repair or freshness field in any projection, prompt or admin read", async () => {
    const { sb, s } = start(3, "w1"); wrong(s);
    const [H, S] = npcs(s); atCommit(s).grudgeOf(H!, S!);
    const dump = JSON.stringify([
      s.live.active.map((id) => s.npcVoice(id)),
      s.getMomentPrompt({ moment: "social" }).systemPrompt,
      await sb.mcp.admin.callTool("inspectNonVaultState", {}),
      await sb.mcp.player.callTool("getGameState", {}),
    ]);
    for (const w of ["grudges", "grudgesSeen", "grudgesCursor", "grudgeOf", "freshness", "repair:", "eased", "peakResentment"]) expect(dump).not.toContain(w);
  });
});
