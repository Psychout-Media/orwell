import { describe, it, expect, beforeAll } from "vitest";
import { PLAYER } from "../../src/domain/ids";
import type { FavorEntry } from "../../src/engine/favors";
import { playedGame } from "../support/playedGame";
import { firstSeedWhereSync } from "../support/firstSeedWhere";

/**
 * 0171 called-in favors, REAL PATH. A whole season is played through the player's levers only, so every favor on the ledger was banked by the house itself (a
 * courted vote, a kept deal, a counter) and every call-in happened at a real vote; played until a called favor has been repaid and one refused. Each turn the test only READS the ledger and the trust edges, and checks:
 * a favor the engine called in is answered (repaid or refused) on the beat it was called; the engine never calls in a favor the player owes; a refusal costs
 * the holder's trust in the debtor on the turn it happens. With favors off, the same seed banks nothing. The seed is scanned from 5 (ORW-880): the first whose season
 * calls in a favor that is repaid and one that is refused (the precondition). HEAVY LANE (tests/uat/realPath*, the `real-path` leg): one played season, about 1-3 minutes. Roles only.
 */
type Priv = { favorLedger(): readonly FavorEntry[] };

describe("0171 REAL PATH: favors the house banked, called in at real votes", () => {
  let ledger: readonly FavorEntry[] = [];
  let seed = 0;
  const refusalTrust: Array<{ before: number; after: number }> = [];
  beforeAll(() => {
    const found = firstSeedWhereSync((seed, sandbox) => {
      const g = playedGame({ seed, user: sandbox });
      const p = g.s as unknown as Priv;
      const rel = g.sb.engine.relationships;
      const refused: Array<{ before: number; after: number }> = [];
      let finished = false;
      const enough = (): boolean => refused.length > 0 && p.favorLedger().some((f) => f.state === "repaid" && f.calledBeat !== undefined);
      for (let i = 0; i < 20_000 && !finished && !enough(); i++) {
        const before = new Map(p.favorLedger().map((f) => [f.id, f.state]));
        const trust = new Map(p.favorLedger().filter((f) => f.state === "owed").map((f) => [f.id, rel.edge(f.holder, f.owedBy).trust]));
        finished = g.turn().finished === true;
        // ORW-892: a refusal can only cost trust that is there to lose (a holder already at the floor is not a case of this claim)
        for (const f of p.favorLedger()) if (f.state === "refused" && before.get(f.id) === "owed" && trust.get(f.id)! > 0) refused.push({ before: trust.get(f.id)!, after: rel.edge(f.holder, f.owedBy).trust });
      }
      return enough() ? { p, refused } : undefined;
    }, { from: 1, to: 12, hint: [1, 5], sandbox: (s) => (s === 5 ? "pf5" : `pf-${s}`), what: "a season that calls in a favor that is repaid and one that is refused" });
    seed = found.seed;
    refusalTrust.push(...found.at.refused);
    const p = found.at.p;
    ledger = p.favorLedger();
  }, 900_000);

  it("called-in favors are answered, repaid or refused; the engine never calls one the player owes", () => {
    const called = ledger.filter((f) => f.calledBeat !== undefined);
    expect(called.length, "the season called in favors").toBeGreaterThan(0);
    for (const f of called) expect(["repaid", "refused"]).toContain(f.state);
    expect(called.some((f) => f.state === "repaid")).toBe(true);
    expect(ledger.filter((f) => f.owedBy === PLAYER && f.calledBeat !== undefined)).toEqual([]);
  });

  it("a refusal costs the holder's trust in the debtor on the turn it happens", () => {
    expect(refusalTrust.length, "a favor was refused this season").toBeGreaterThan(0);
    for (const r of refusalTrust) expect(r.after).toBeLessThan(r.before);
  });

  it("favors off: the same seed banks nothing", () => {
    // not as shipped: the control arm, the same seed with this feature off, proves the feature is what makes the difference
    const off = playedGame({ seed, user: `favors-real-off-${seed}`, before: (s) => s.setFavorsEnabled(false) });
    off.playUntil(() => (off.s.getGameState() as { week?: number }).week! >= 4, 8000, "week 4");
    expect((off.s as unknown as Priv).favorLedger()).toEqual([]);
  }, 600_000);
});
