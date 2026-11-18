import { describe, it, expect } from "vitest";
import { atCommit } from "../support/commitFold";
import { readFileSync } from "node:fs";
import { GameSessionRegistry } from "../../src/composition/registry";
import { BOND, bondKey, bondOf, emptyBond, foldBreak, foldRepair, foldScene, grievanceOf, peakGrievanceOf, withGrievance, kindOf, strandsOf, bondStrengthOf, type BondStore } from "../../src/engine/bondRecord";
import { recordBondReader } from "../../src/engine/bonds";

/** ORW-607 part 2: the bond record's resentment split. Wrongs live in the grudge book (on its curve); the record keeps friction. grievanceOf = the two, summed once. Roles only. */
const rec = (over: Partial<ReturnType<typeof emptyBond>> = {}) => ({ ...emptyBond(), ...over });

describe("foldBreak (pure)", () => {
  it("with the book holding the wrong it writes no resentment or peak, but still the strain and history", () => {
    const store: BondStore = {};
    foldBreak(store, "breaker", "wronged", { bookHoldsWrong: true });
    const w = bondOf(store, "wronged", "breaker");
    expect(w.resentment).toBe(0); expect(w.peakResentment).toBe(0);
    expect(w.strain).toBe(BOND.strainPerBreak); expect(w.history).toBe(1);
    expect(bondOf(store, "breaker", "wronged").strain).toBe(BOND.breakerStrain);
  });
  it("without it (headless, flag off) it is exactly the old fold", () => {
    const a: BondStore = {}, b: BondStore = {};
    foldBreak(a, "x", "y"); foldBreak(b, "x", "y", { bookHoldsWrong: false });
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    expect(bondOf(a, "y", "x").resentment).toBe(BOND.resentPerBreak);
  });
});

describe("grievanceOf (pure)", () => {
  it("is the record's resentment with no book wrong, the book's weight with no friction, and their sum once, clamped", () => {
    expect(grievanceOf(rec({ resentment: 0.2 }))).toBe(0.2);
    expect(grievanceOf(rec(), { weight: 0.35, peak: 0.35 })).toBeCloseTo(0.35 * BOND.wrongShare, 12);
    expect(grievanceOf(rec({ resentment: 0.2 }), { weight: 0.35, peak: 0.35 })).toBeCloseTo(0.2 + 0.35 * BOND.wrongShare, 12);
    expect(grievanceOf(rec({ resentment: 0.9 }), { weight: 0.8, peak: 0.8 })).toBe(1);
    expect(peakGrievanceOf(rec({ peakResentment: 0.1 }), { weight: 0.1, peak: 0.35 })).toBeCloseTo(0.1 + 0.35 * BOND.wrongShare, 12);
  });
  it("withGrievance is the identity with no book wrong, and feeds kind, strands and strength", () => {
    const r = rec({ warmth: 0.6, resentment: 0.1, peakResentment: 0.1 });
    expect(withGrievance(r)).toBe(r);
    const e = withGrievance(r, { weight: 0.3, peak: 0.35 });
    expect(strandsOf(e).rivalry).toBeCloseTo(0.4, 12);
    expect(bondStrengthOf(0.5, e)).toBeLessThan(bondStrengthOf(0.5, r));
    expect(kindOf(e)).toBe("friendship"); // a fresh 0.4 grievance is not a settled rivalry
    expect(kindOf(withGrievance(r, { weight: 0.05, peak: 0.35 }))).toBe("rivals-turned-allies"); // the book's peak counts: a faded wrong between warm friends
  });
});

describe("the reader", () => {
  const reader = (store: BondStore, wrong?: (h: string, o: string) => { weight: number; peak: number } | undefined) =>
    recordBondReader({ peek: () => ({ trust: 0, affinity: 0, threat: 0, reliability: 0 }), peekBondStrength: () => 0.5 } as never, () => store, () => ["h", "s"], () => 1, wrong ? { wrong } : {});
  it("every reader of BondView.resentment sees the grievance when a wrong source is given, and the raw record otherwise", () => {
    const store: BondStore = { [bondKey("h", "s")]: rec({ warmth: 0.5, resentment: 0.1, peakResentment: 0.1 }) };
    const old = reader(store).bond("h", "s");
    const split = reader(store, () => ({ weight: 0.3, peak: 0.35 })).bond("h", "s");
    expect(old.resentment).toBe(0.1);
    expect(split.resentment).toBeCloseTo(0.4, 12);
    expect(split.peakResentment).toBeCloseTo(0.45, 12);
    expect(split.strands.rivalry).toBeCloseTo(0.4, 12);
    expect(split.strength).toBeLessThan(old.strength);
  });
});

type G = {
  live: { active: string[]; week: number; playedGame?: boolean; bonds?: BondStore; grudges?: Record<string, { eased: number; peak: number }> };
  deals: { make(p: [string, string], k: string, t: string, e?: string, w?: number): { id: string; status: string; brokenBy?: string; learned?: boolean } };
  grudgeOf(h: string, s: string, fold?: boolean): { weight: number; peak: number } | null;
  grievanceOf(h: string, s: string): number;
  bondReader(): { bond(h: string, o: string): { resentment: number; peakResentment: number; strain: number } };
  repairGrudge(h: string, s: string, base: number): void;
  setGrudgesEnabled(on: boolean): void; snapshot(): unknown;
};
const start = (seed: number, tag: string, grudges = true) => {
  const sb = new GameSessionRegistry().sandboxFor(`r607-${tag}-${seed}-${grudges}`);
  sb.session.createCharacter({ playerName: "The Player", seed });
  sb.session.setGrudgesEnabled(grudges);
  sb.session.noteMessage({ messageId: "m1" });
  const s = sb.session as unknown as G;
  const [H, S] = s.live.active.filter((x) => x.startsWith("npc:"));
  return { s, H: H!, S: S! };
};
const breakDeal = (s: G, H: string, S: string) => { const d = s.deals.make([H, S], "safety", "terms", undefined, 1); d.status = "broken"; d.brokenBy = S; d.learned = true; };

describe("a played game", () => {
  it("a deal break leaves no resentment or peak in the record, the book row exists, and grievanceOf is the book's weight", () => {
    const { s, H, S } = start(3, "a");
    breakDeal(s, H, S);
    const v = atCommit(s).bondReader().bond(H, S);
    const rec = bondOf(s.live.bonds, H, S);
    expect(rec.resentment).toBe(0); expect(rec.peakResentment).toBe(0);
    expect(rec.strain).toBeGreaterThan(0);
    const book = atCommit(s).grudgeOf(H, S, false)!;
    expect(book.weight).toBeGreaterThan(0);
    expect(atCommit(s).grievanceOf(H, S)).toBeCloseTo(book.weight * BOND.wrongShare, 12);
    expect(v.resentment).toBeCloseTo(book.weight * BOND.wrongShare, 12);
  });
  it("a friction conflict still writes the record's resentment, and a wrong plus friction sum once (clamped)", () => {
    const { s, H, S } = start(3, "b");
    foldScene((s.live.bonds ??= {}), "conflict", [H, S]);
    const friction = bondOf(s.live.bonds, H, S).resentment;
    expect(friction).toBeGreaterThan(0);
    expect(atCommit(s).grievanceOf(H, S)).toBeCloseTo(friction, 12);
    breakDeal(s, H, S);
    const w = atCommit(s).grudgeOf(H, S)!.weight;
    expect(atCommit(s).grievanceOf(H, S)).toBeCloseTo(Math.min(1, friction + w), 12);
    expect(atCommit(s).grievanceOf(H, S)).toBeLessThanOrEqual(1);
  });
  it("repair eases the wrong once (in the book) and the friction part by its half rate; the wrong is never in the record to be eased twice", () => {
    const { s, H, S } = start(3, "c");
    foldScene((s.live.bonds ??= {}), "conflict", [H, S]);
    breakDeal(s, H, S);
    atCommit(s).grudgeOf(H, S);
    const f0 = bondOf(s.live.bonds, H, S).resentment, w0 = atCommit(s).grudgeOf(H, S, false)!.weight;
    s.repairGrudge(H, S, 0.1);
    const eased = s.live.grudges![`${H}|${S}`]!.eased;
    expect(eased).toBeGreaterThan(0);
    expect(bondOf(s.live.bonds, H, S).resentment).toBeCloseTo(Math.max(0, f0 - eased * BOND.repairResentShare), 12);
    expect(atCommit(s).grudgeOf(H, S, false)!.weight).toBeLessThan(w0);
  });
  it("flag off: the record keeps the old resentment for a deal break and grievanceOf is just it", () => {
    const { s, H, S } = start(3, "d", false);
    breakDeal(s, H, S);
    atCommit(s).bondReader();
    expect(bondOf(s.live.bonds, H, S).resentment).toBe(BOND.resentPerBreak);
    expect(atCommit(s).grievanceOf(H, S)).toBe(BOND.resentPerBreak);
  });
  it("headless (not a played game): the old record resentment, byte for byte", () => {
    const { s, H, S } = start(11, "e");
    s.live.playedGame = false;
    breakDeal(s, H, S);
    atCommit(s).bondReader();
    expect(bondOf(s.live.bonds, H, S).resentment).toBe(BOND.resentPerBreak);
    expect(atCommit(s).grievanceOf(H, S)).toBe(BOND.resentPerBreak);
  });
  it("the player as the wronged party keeps the record's resentment (the book never holds a player's grudge)", () => {
    const { s, S } = start(3, "f");
    const d = s.deals.make(["player", S], "safety", "terms", undefined, 1); d.status = "broken"; d.brokenBy = S; d.learned = true;
    atCommit(s).bondReader();
    expect(bondOf(s.live.bonds, "player", S).resentment).toBe(BOND.resentPerBreak);
  });
  it("the wall: no grievance or peak field in a snapshot", () => {
    const { s, H, S } = start(3, "g");
    breakDeal(s, H, S); atCommit(s).bondReader();
    const dump = JSON.stringify(s.snapshot());
    for (const w of ["grievance", "wrongShare", "bookHoldsWrong"]) expect(dump).not.toContain(w);
  });
});

describe("source pins: every reader takes the grievance", () => {
  const bonds = readFileSync("src/engine/bonds.ts", "utf8");
  const adapter = readFileSync("src/adapters/engine/GameSessionAdapter.ts", "utf8");
  it("the record reader builds every view, strength, kind and strand from the grievance-bearing record", () => {
    expect(bonds).toContain("withGrievance(bondOf(store(), holder, other), opts.wrong?.(holder, other))");
    expect(bonds).toContain("const r = seen(holder, other)");
    expect(bonds).toContain("bondStrengthOf(edgeStrength(rel, holder, other), seen(holder, other))");
    expect(bonds).not.toMatch(/resentment: r\.resentment, peakResentment: r\.peakResentment[^\n]*bondOf\(/);
  });
  it("the adapter hands the book to the reader in played games and the break folds pass the split (a deal break, a refused favor and, since the Theme A breakup, the heartbreak)", () => {
    expect(adapter).toContain("wrong: (h: EntityId, o: EntityId) => this.bookWrongOf(h, o)");
    expect((adapter.match(/bookHoldsWrong: true/g) ?? []).length).toBe(3); // deal break, refused favor, and the showmance breakup (its heartbreak lives in the book)
  });
  it("no feeling, jealousy, triad or house-graph reader reads the record's raw resentment", () => {
    for (const f of ["bondFeelings", "bondJealousy", "houseGraph", "triadsConstants"]) expect(readFileSync(`src/engine/${f}.ts`, "utf8")).not.toMatch(/bondOf\(|\.bonds\b\??\.\[/);
    expect(adapter).not.toMatch(/bondOf\(\s*(?:s|live|this\.live)\??\.bonds[^)]*\)\.resentment/);
  });
});
