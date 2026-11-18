import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import { claimsOf, type BeliefStore } from "../../src/engine/beliefStore";
import { PROMISE_VETO_LEAN } from "../../src/engine/promiseTerms";
import type { OpenLedger } from "../../src/engine/openLedger";

/**
 * ORW-586 / 0187 slice 4 - an NPC PROMISER's own decisions read their open termed promises (use-veto-on, not-use-veto-on, final-two) through the casual-assurance keep-or-break call (`decideKeep`),
 * and the veto and the Final 2 settle them on the same board facts the judge reads. Real engine, no model, no rng in the reads. Roles only: the promiser (holder), the promisee, a third houseguest.
 */
type SeasonHooks = {
  promiseVetoFor?: (n: string, h: string) => number;
  promiseFinalTwoFor?: (h: string, r: readonly string[]) => string | undefined;
  promiseVetoSettled?: (h: string, on: string | undefined) => void;
  promiseFinalTwoSettled?: (f: readonly string[]) => void;
};
type G = {
  recordPromiseTerm(r: unknown): { accepted: boolean; reason?: string; entryId?: string };
  ctx(): SeasonHooks;
  rel: { edge(a: string, b: string): { trust: number; threat: number } };
  setNpcBeliefsEnabled(on: boolean): void; setMemoryPromisesEnabled(on: boolean): void; setPromiseTermsEnabled(on: boolean): void; setLiesCaughtEnabled(on: boolean): void;
  movePlayer(room: string): { present: Array<{ id: string }> } | undefined;
  noteMessage(m: unknown): void; setAdvanceGateEnabled(on: boolean): void;
  snapshot(): { live: { beliefs?: BeliefStore }; openLedger?: OpenLedger };
  openLedgerHere(): unknown[];
};
function started(opts: { flag?: boolean } = {}) {
  const sb = new GameSessionRegistry().sandboxFor(`ptb-${Math.random()}`);
  sb.session.createCharacter({ playerName: "The Player", archetype: "floater", seed: 7 });
  sb.session.advanceGame(); sb.session.advanceGame();
  const g = sb.session as unknown as G;
  (sb.session as unknown as { live: { playedGame?: boolean } }).live.playedGame = true;
  g.setAdvanceGateEnabled(false);
  sb.session.setAssurancesEnabled(true);
  g.setNpcBeliefsEnabled(true); g.setMemoryPromisesEnabled(true); g.setLiesCaughtEnabled(true);
  g.setPromiseTermsEnabled(opts.flag ?? true);
  g.noteMessage({ messageId: "m1" });
  const present = g.movePlayer("living-room")!.present.map((p) => p.id).filter((i) => i !== PLAYER);
  if (present.length < 3) throw new Error("need three houseguests present");
  const [promiser, promisee, third] = present as [string, string, string];
  return { g, promiser, promisee, third };
}
const entry = (g: G, id: string) => g.snapshot().openLedger!.entries.find((e) => e.id === id)!;
const lied = (g: G, holder: string) => claimsOf(g.snapshot().live.beliefs ?? {}, holder).filter((c) => c.kind === "lied-to-me");
/** What breaking pays the promiser: the benefit is the threat (use-veto-on, final-two) or the trust (not-use-veto-on) they hold toward the subject; 0 => keeps, 1 => breaks (no character's keep weight reaches 1). */
const setThreat = (g: G, a: string, b: string, v: number): void => { g.rel.edge(a, b).threat = v; };
const setTrust = (g: G, a: string, b: string, v: number): void => { g.rel.edge(a, b).trust = v; };

describe("the veto read: a promiser's own save reads their open veto promises", () => {
  it("use-veto-on leans the save toward the promisee when the promiser keeps it, and not at all when they deliberately break it", () => {
    const { g, promiser, promisee } = started();
    g.recordPromiseTerm({ by: promiser, to: promisee, what: "use-veto-on" });
    setThreat(g, promiser, promisee, 0);
    expect(g.ctx().promiseVetoFor!(promisee, promiser)).toBe(PROMISE_VETO_LEAN);
    setThreat(g, promiser, promisee, 1);
    expect(g.ctx().promiseVetoFor!(promisee, promiser)).toBe(0); // a deliberate break: the holder's own read stands
  });
  it("not-use-veto-on leans the save AWAY from the promisee when kept, and not at all when the promiser would rather save a trusted friend", () => {
    const { g, promiser, promisee } = started();
    g.recordPromiseTerm({ by: promiser, to: promisee, what: "not-use-veto-on" });
    setTrust(g, promiser, promisee, 0);
    expect(g.ctx().promiseVetoFor!(promisee, promiser)).toBe(-PROMISE_VETO_LEAN);
    setTrust(g, promiser, promisee, 1);
    expect(g.ctx().promiseVetoFor!(promisee, promiser)).toBe(0);
  });
  it("only the promiser reads it, only for the one it concerns, and a promise about a third person leans toward that third person", () => {
    const { g, promiser, promisee, third } = started();
    g.recordPromiseTerm({ by: promiser, to: promisee, what: "use-veto-on", subject: third });
    setThreat(g, promiser, third, 0);
    expect(g.ctx().promiseVetoFor!(third, promiser)).toBe(PROMISE_VETO_LEAN);
    expect(g.ctx().promiseVetoFor!(promisee, promiser)).toBe(0);
    expect(g.ctx().promiseVetoFor!(third, promisee)).toBe(0);
  });
  it("a promise the player made is never read as an NPC decision (the engine never acts for the player)", () => {
    const { g, promisee } = started();
    g.recordPromiseTerm({ by: PLAYER, to: promisee, what: "use-veto-on" });
    expect(g.ctx().promiseVetoFor!(promisee, PLAYER)).toBe(0);
  });
});

describe("the veto settles its promises on the public fact", () => {
  it("kept: the holder used the veto on the promisee: the entry closes kept by the engine and the promisee keeps a favor", () => {
    const { g, promiser, promisee } = started();
    const r = g.recordPromiseTerm({ by: promiser, to: promisee, what: "use-veto-on" });
    g.ctx().promiseVetoSettled!(promiser, promisee);
    expect(entry(g, r.entryId!).status).toBe("kept");
    expect(entry(g, r.entryId!).note).toMatch(/^engine judged kept/);
  });
  it("broken: folds exactly once through foldBrokenPromise (trust drops once, one claim naming the promiser), whatever repeats", () => {
    const { g, promiser, promisee, third } = started();
    const r = g.recordPromiseTerm({ by: promiser, to: promisee, what: "use-veto-on" });
    const t0 = g.rel.edge(promisee, promiser).trust;
    g.ctx().promiseVetoSettled!(promiser, third); // used it, on someone else
    g.ctx().promiseVetoSettled!(promiser, undefined);
    g.ctx().promiseVetoSettled!(promiser, third);
    expect(entry(g, r.entryId!).status).toBe("broken");
    expect(g.rel.edge(promisee, promiser).trust).toBeCloseTo(Math.max(0, t0 - 0.12), 10);
    expect(lied(g, promisee).filter((c) => c.subject === promiser)).toHaveLength(1);
  });
  it("not-use-veto-on: using it on the promisee breaks it; leaving it unused keeps it", () => {
    const a = started();
    const ra = a.g.recordPromiseTerm({ by: a.promiser, to: a.promisee, what: "not-use-veto-on" });
    a.g.ctx().promiseVetoSettled!(a.promiser, a.promisee);
    expect(entry(a.g, ra.entryId!).status).toBe("broken");
    const b = started();
    const rb = b.g.recordPromiseTerm({ by: b.promiser, to: b.promisee, what: "not-use-veto-on" });
    b.g.ctx().promiseVetoSettled!(b.promiser, undefined);
    expect(entry(b.g, rb.entryId!).status).toBe("kept");
  });
  it("another holder's veto says nothing about this promiser", () => {
    const { g, promiser, promisee, third } = started();
    const r = g.recordPromiseTerm({ by: promiser, to: promisee, what: "use-veto-on" });
    g.ctx().promiseVetoSettled!(third, undefined);
    expect(entry(g, r.entryId!).status).toBe("open");
  });
});

describe("the final HOH's read and the Final 2", () => {
  it("a final-two promise the HOH keeps names the rival they owe; a deliberate break names nobody", () => {
    const { g, promiser, promisee, third } = started();
    g.recordPromiseTerm({ by: promiser, to: promisee, what: "final-two" });
    setThreat(g, promiser, promisee, 0);
    expect(g.ctx().promiseFinalTwoFor!(promiser, [promisee, third])).toBe(promisee);
    expect(g.ctx().promiseFinalTwoFor!(promiser, [third, promiser])).toBeUndefined(); // the promisee is no longer a rival
    setThreat(g, promiser, promisee, 1);
    expect(g.ctx().promiseFinalTwoFor!(promiser, [promisee, third])).toBeUndefined();
  });
  it("the Final 2 settles it: kept when both are in it, broken (folded once) when the promisee is out", () => {
    const k = started();
    const rk = k.g.recordPromiseTerm({ by: k.promiser, to: k.promisee, what: "final-two" });
    k.g.ctx().promiseFinalTwoSettled!([k.promiser, k.promisee]);
    expect(entry(k.g, rk.entryId!).status).toBe("kept");
    const b = started();
    const rb = b.g.recordPromiseTerm({ by: b.promiser, to: b.promisee, what: "final-two" });
    const t0 = b.g.rel.edge(b.promisee, b.promiser).trust;
    b.g.ctx().promiseFinalTwoSettled!([b.promiser, b.third]);
    b.g.ctx().promiseFinalTwoSettled!([b.promiser, b.third]);
    expect(entry(b.g, rb.entryId!).status).toBe("broken");
    expect(b.g.rel.edge(b.promisee, b.promiser).trust).toBeCloseTo(Math.max(0, t0 - 0.12), 10);
    expect(lied(b.g, b.promisee)).toHaveLength(1);
  });
});

describe("the flag, the wall and the wiring", () => {
  it("flag off: no hook is on the season context and nothing is recorded (today's behaviour)", () => {
    const { g, promiser, promisee } = started({ flag: false });
    const c = g.ctx();
    expect(c.promiseVetoFor).toBeUndefined();
    expect(c.promiseFinalTwoFor).toBeUndefined();
    expect(c.promiseVetoSettled).toBeUndefined();
    expect(c.promiseFinalTwoSettled).toBeUndefined();
    expect(g.recordPromiseTerm({ by: promiser, to: promisee, what: "use-veto-on" })).toEqual({ accepted: false, reason: "off" });
  });
  it("wall sentinel: no player view carries the term, the keep-or-break inputs or the engine's note", () => {
    const { g, promiser, promisee } = started();
    g.recordPromiseTerm({ by: promiser, to: promisee, what: "use-veto-on" });
    setThreat(g, promiser, promisee, 0.37);
    g.ctx().promiseVetoSettled!(promiser, undefined);
    const view = JSON.stringify(g.openLedgerHere());
    expect(view).not.toMatch(/term|engine judged|breakBenefit|keepWeight|0\.37|"what"|subject/);
  });
  it("the pure loop reads the hooks at the veto save, the Final 3 eviction and settles at the veto and the Final 2 (source pin)", () => {
    const src = readFileSync("src/engine/liveSeason.ts", "utf8");
    expect(src).toMatch(/ctx\.promiseVetoFor \? \[ctx\.promiseVetoFor\(n, holder\)\]/);
    expect(src).toMatch(/ctx\.promiseFinalTwoFor\?\.\(s\.hoh!, rivals\)/);
    expect(src).toMatch(/ctx\.promiseVetoSettled\?\.\(s\.vetoHolder, s\.vetoUsed \? s\.saved : undefined\)/);
    expect(src).toMatch(/s\.active\.length === 2\) ctx\.promiseFinalTwoSettled\?\./);
  });
});
