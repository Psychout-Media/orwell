import { describe, it, expect } from "vitest";
import { GRUDGES, easeGrudge, freshness, grudgeKey, halfLifeFor, noteGrudge, type GrudgeBook } from "../../src/engine/grudges";
import { GameSessionRegistry } from "../../src/composition/registry";

/** Feature 0182 (Theme 3 slice 5, PR 1): the grudge book. Roles only. */
const fresh = (): GrudgeBook => { const b: GrudgeBook = {}; noteGrudge(b, "h", "s", "cut-by-ally", 0.5, 2, 1, "ref"); return b; };

describe("the pure book", () => {
  it("fresh is sharper than old, and never zero", () => {
    const row = fresh()["h|s"]!;
    expect(freshness(row, 2)).toBeGreaterThan(freshness(row, 10));
    expect(freshness(row, 10)).toBeGreaterThan(freshness(row, 60));
    expect(freshness(row, 10_000)).toBeGreaterThan(0);
    expect(freshness(row, 10_000)).toBeCloseTo(GRUDGES.FLOOR_SHARE * 0.5, 6);
    expect(freshness(row, 2)).toBeLessThanOrEqual(1);
  });
  it("easing lowers freshness but never below the floor, and the total is capped", () => {
    const row = fresh()["h|s"]!;
    const before = freshness(row, 4);
    expect(easeGrudge(row, 0.1)).toBeCloseTo(0.1, 12);
    expect(freshness(row, 4)).toBeLessThan(before);
    for (let i = 0; i < 100; i++) easeGrudge(row, 0.3);
    expect(row.eased).toBeCloseTo(GRUDGES.EASE_CAP * row.peak, 12);
    expect(easeGrudge(row, 1)).toBe(0);
    expect(freshness(row, 2)).toBeGreaterThanOrEqual(GRUDGES.FLOOR_SHARE * row.peak);
    expect(freshness(row, 10_000)).toBeGreaterThanOrEqual(GRUDGES.FLOOR_SHARE * row.peak);
    expect(easeGrudge(row, -3)).toBe(0);
  });
  it("noting is monotone: severity and peak only grow, eased is untouched, a stronger wrong replaces the kind; a smaller newer one never resets the clock (ORW-605)", () => {
    const b = fresh(); const r = b["h|s"]!;
    easeGrudge(r, 0.1);
    const wk = r.week, dy = r.day, kd = r.kind;
    noteGrudge(b, "h", "s", "lied-to", 0.2, 3, 1, "weaker-newer");
    expect(r.severity).toBe(0.5); expect(r.peak).toBe(0.5);
    expect(r.kind).toBe(kd); expect(r.week).toBe(wk); expect(r.day).toBe(dy); // a small slight does not restart a big grudge's freshness
    noteGrudge(b, "h", "s", "lied-to", 0.5, 3, 1, "equal-newer");
    expect(r.kind).toBe("lied-to"); expect(r.week).toBe(3); // as severe and newer takes over
    noteGrudge(b, "h", "s", "blindsided", 0.9, 1, 1, "stronger-older");
    expect(r.severity).toBe(0.9); expect(r.peak).toBe(0.9); expect(r.kind).toBe("blindsided");
    noteGrudge(b, "h", "s", "vote-against", 0.1, 0, 1, "weaker-older");
    expect(r.kind).toBe("blindsided"); expect(r.severity).toBe(0.9);
    expect(r.eased).toBeCloseTo(0.1, 12);
    expect(Object.keys(b)).toEqual(["h|s"]);
  });
  it("noting the same wrong twice changes nothing; a self or zero wrong is refused", () => {
    const b = fresh();
    expect(noteGrudge(b, "h", "s", "cut-by-ally", 0.5, 2, 1, "ref")).toBe(false);
    expect(noteGrudge(b, "x", "x", "lied-to", 0.5, 1, 1, "r")).toBe(false);
    expect(noteGrudge(b, "x", "y", "lied-to", 0, 1, 1, "r")).toBe(false);
    expect(Object.keys(b)).toEqual(["h|s"]);
  });
  it("the half-life: loyalty lengthens it, paranoia a little, a keeper more; no dials is the base; bounded", () => {
    expect(halfLifeFor()).toBe(GRUDGES.HALF_LIFE_WEEKS);
    expect(halfLifeFor({ loyalty: 1.2 })).toBeGreaterThan(halfLifeFor());
    expect(halfLifeFor({ paranoia: 1.2 })).toBeGreaterThan(halfLifeFor());
    expect(halfLifeFor({ paranoia: 1.2 })).toBeLessThan(halfLifeFor({ loyalty: 1.2 }));
    expect(halfLifeFor({ keeper: true })).toBeGreaterThan(halfLifeFor({ loyalty: 1.35 }));
    expect(halfLifeFor({ loyalty: 50 })).toBe(halfLifeFor({ loyalty: GRUDGES.MAX_FACTOR }));
    const row = fresh()["h|s"]!;
    expect(freshness(row, 12, halfLifeFor({ keeper: true }))).toBeGreaterThan(freshness(row, 12));
  });
  it("the key is the directed pair", () => { expect(grudgeKey("h", "s")).toBe("h|s"); expect(grudgeKey("s", "h")).not.toBe("h|s"); });
});

type Internals = {
  live: {
    active: string[]; week: number; evictionOrder: string[]; playedGame?: boolean;
    grudges?: GrudgeBook; grudgesSeen?: string[]; npcMemory?: Record<string, Record<string, Array<{ kind: string; week: number; severity: number }>>>;
    mannerByEvictee?: Record<string, Record<string, Record<string, unknown>>>; beliefs?: Record<string, unknown[]>;
  };
  deals: { make(p: [string, string], k: string, t: string, e?: string, w?: number): { status: string; brokenBy?: string } };
  snapshot(): unknown; restore(c: unknown): void; settleOvernight(n: number): number;
  grudgeOf(h: string, s: string): { kind: string; freshness: number; severity: number; peak: number } | null;
  setGrudgesEnabled(on: boolean): void; npcVoice(id: string): unknown;
  getMomentPrompt(a: unknown): { systemPrompt: string };
};
const start = (seed: number, n: string, on = true) => {
  const sb = new GameSessionRegistry().sandboxFor(`g182-${n}-${seed}-${on}`);
  sb.session.createCharacter({ playerName: "The Player", seed });
  sb.session.setGrudgesEnabled(on);
  sb.session.noteMessage({ messageId: "m1" });
  return { sb, s: sb.session as unknown as Internals };
};
const npcs = (s: Internals): string[] => s.live.active.filter((x) => x.startsWith("npc:"));
const PLAYER = "player";

describe("folds from each source in a played game", () => {
  it("a friend's cut (memory ledger) becomes a cut-by-ally grudge, once", () => {
    const { s } = start(3, "a"); const [H, S] = npcs(s);
    s.live.npcMemory = { [H!]: { [S!]: [{ kind: "nominated-by-friend", week: 1, severity: 0.5 }] } };
    const g = s.grudgeOf(H!, S!);
    expect(g).toMatchObject({ kind: "cut-by-ally", severity: 0.5, peak: 0.5 });
    expect(g!.freshness).toBeGreaterThan(0);
    const seen = JSON.stringify(s.live.grudgesSeen);
    s.grudgeOf(H!, S!); s.settleOvernight(1);
    expect(JSON.stringify(s.live.grudgesSeen)).toBe(seen);
    expect(Object.keys(s.live.grudges!)).toEqual([`${H}|${S}`]);
  });
  it("a broken deal: the wronged party holds it against the breaker, not the reverse", () => {
    const { s } = start(3, "b"); const [H, S] = npcs(s);
    const d = s.deals.make([H!, S!], "safety", "terms", undefined, 1);
    expect(s.grudgeOf(H!, S!)).toBeNull(); // an open deal is no grudge
    d.status = "broken"; d.brokenBy = S!;
    expect(s.grudgeOf(H!, S!)).toMatchObject({ kind: "deal-broken", severity: GRUDGES.DEAL_BREAK_SEVERITY });
    expect(s.grudgeOf(S!, H!)).toBeNull();
  });
  it("a lied-to claim and a voted-against claim", () => {
    const { s } = start(3, "c"); const [H, S, T] = npcs(s);
    s.live.beliefs = { [H!]: [{ id: "c1", holder: H, kind: "lied-to-me", subject: S, value: true, origin: "witnessed", confidence: 0.8, week: 1 }, { id: "c2", holder: H, kind: "voted-against-me", subject: T, value: true, origin: "witnessed", confidence: 0.6, week: 1 }, { id: "c3", holder: H, kind: "lied-to-me", subject: T, value: true, refuted: true, origin: "gossip", confidence: 0.9, week: 1 }] };
    expect(s.grudgeOf(H!, S!)).toMatchObject({ kind: "lied-to", severity: 0.8 });
    expect(s.grudgeOf(H!, T!)).toMatchObject({ kind: "vote-against", severity: 0.6 }); // the refuted lie adds nothing
  });
  it("a blindside and an alliance betrayal (eviction manner)", () => {
    const { s } = start(3, "d"); const [E, W, A, B] = npcs(s);
    s.live.evictionOrder = [E!];
    s.live.mannerByEvictee = { [E!]: { [W!]: { blindsided: true, intensity: 0.7 } }, [A!]: { [B!]: { betrayed: true, intensity: 0.4 } } };
    expect(s.grudgeOf(E!, W!)).toMatchObject({ kind: "blindsided", severity: 0.7 });
    expect(s.grudgeOf(A!, B!)).toMatchObject({ kind: "cut-by-ally", severity: 0.4 });
  });
  it("the player is never a holder; an NPC may hold one against the player", () => {
    const { s } = start(3, "e"); const [H] = npcs(s);
    s.live.mannerByEvictee = { [PLAYER]: { [H!]: { blindsided: true, intensity: 1 } }, [H!]: { [PLAYER]: { betrayed: true, intensity: 0.5 } } };
    expect(s.grudgeOf(PLAYER, H!)).toBeNull();
    expect(Object.keys(s.live.grudges ?? {}).some((k) => k.startsWith(`${PLAYER}|`))).toBe(false);
    expect(s.grudgeOf(H!, PLAYER)).not.toBeNull();
  });
  it("the memory fades with the weeks but is never zero", () => {
    const { s } = start(3, "f"); const [H, S] = npcs(s);
    s.live.npcMemory = { [H!]: { [S!]: [{ kind: "deal-broken", week: 1, severity: 0.8 }] } };
    const early = s.grudgeOf(H!, S!)!.freshness;
    s.live.week = 80;
    const late = s.grudgeOf(H!, S!)!.freshness;
    expect(late).toBeLessThan(early);
    expect(late).toBeGreaterThan(0);
  });
});

describe("flag off, headless, persistence, wall", () => {
  const wrong = (s: Internals): void => {
    const [H, S] = npcs(s);
    s.live.npcMemory = { [H!]: { [S!]: [{ kind: "deal-broken", week: 1, severity: 0.8 }] } };
  };
  it("flag off: no grudges key, snapshot byte-identical, seeds 3 and 11", () => {
    for (const seed of [3, 11]) {
      const off = start(seed, "g", false).s; wrong(off);
      const base = start(seed, "g2", false).s; wrong(base);
      for (const x of [off, base]) { x.grudgeOf(npcs(x)[0]!, npcs(x)[1]!); x.settleOvernight(1); }
      expect(off.live.grudges).toBeUndefined();
      expect(off.live.grudgesSeen).toBeUndefined();
      expect(JSON.stringify(off.snapshot())).toBe(JSON.stringify(base.snapshot()));
      expect(JSON.stringify(off.snapshot())).not.toContain("\"grudges\":");
    }
  });
  it("flag on with nothing wrong adds no key (byte-identical to flag off)", () => {
    for (const seed of [3, 11]) {
      const on = start(seed, "h", true).s; const off = start(seed, "h", false).s;
      on.settleOvernight(1); off.settleOvernight(1);
      expect(on.live.grudges).toBeUndefined();
      expect(JSON.stringify(on.snapshot())).toBe(JSON.stringify(off.snapshot()));
    }
  });
  it("headless (playedGame false): nothing folds", () => {
    const { s } = start(3, "i"); wrong(s); s.live.playedGame = false;
    expect(s.grudgeOf(npcs(s)[0]!, npcs(s)[1]!)).toBeNull();
    expect(s.live.grudges).toBeUndefined();
  });
  it("the book and its seen-marks survive save and restore", () => {
    const { s } = start(3, "j"); wrong(s);
    const [H, S] = npcs(s);
    s.grudgeOf(H!, S!);
    const snap = JSON.parse(JSON.stringify(s.snapshot()));
    expect(JSON.stringify(snap)).toContain("grudgesSeen");
    const { s: t } = start(3, "j2");
    t.restore(snap);
    expect(t.live.grudges).toEqual(s.live.grudges);
    expect(t.live.grudgesSeen).toEqual(s.live.grudgesSeen);
    const before = JSON.stringify(t.live.grudges);
    t.grudgeOf(H!, S!);
    expect(JSON.stringify(t.live.grudges)).toBe(before); // idempotent after restore
    expect(t.grudgeOf(H!, S!)).toMatchObject({ kind: "deal-broken", severity: 0.8 });
  });
  it("the wall: no grudge field in any projection, prompt or admin read", async () => {
    const { sb, s } = start(3, "k"); wrong(s);
    const [H, S] = npcs(s);
    s.grudgeOf(H!, S!);
    const dump = JSON.stringify([
      s.live.active.map((id) => s.npcVoice(id)),
      s.getMomentPrompt({ moment: "social" }).systemPrompt,
      await sb.mcp.admin.callTool("inspectNonVaultState", {}),
      await sb.mcp.player.callTool("getGameState", {}),
    ]);
    for (const w of ["grudges", "grudgesSeen", "grudgeOf", "freshness", "cut-by-ally", "deal-broken\",\"week"]) expect(dump).not.toContain(w);
  });
});
