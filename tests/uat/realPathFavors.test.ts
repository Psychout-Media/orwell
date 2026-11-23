import { describe, it, expect, beforeAll } from "vitest";
import { PLAYER } from "../../src/domain/ids";
import type { FavorEntry } from "../../src/engine/favors";
import { playedGame } from "../support/playedGame";

/**
 * 0171 called-in favors, REAL PATH. A whole season is played through the player's levers only, so every favor on the ledger was banked by the house itself (a
 * courted vote, a kept deal, a counter) and every call-in happened at a real vote; played until a called favor has been repaid and one refused. Each turn the test only READS the ledger and the trust edges, and checks:
 * a favor the engine called in is answered (repaid or refused) on the beat it was called; the engine never calls in a favor the player owes; a refusal costs
 * the holder's trust in the debtor on the turn it happens. With favors off, the same seed banks nothing. Seed 5: its season calls in favors that are repaid and
 * at least one that is refused. HEAVY LANE (tests/uat/realPath*, the `real-path` leg): one played season, about 1-3 minutes. Roles only.
 */
const SEED = 5;
type Priv = { favorLedger(): readonly FavorEntry[] };

describe("0171 REAL PATH: favors the house banked, called in at real votes", () => {
  let ledger: readonly FavorEntry[] = [];
  const refusalTrust: Array<{ before: number; after: number }> = [];
  beforeAll(() => {
    const g = playedGame({ seed: SEED, user: "pf5" });
    const p = g.s as unknown as Priv;
    const rel = g.sb.engine.relationships;
    let finished = false;
    const enough = (): boolean => refusalTrust.length > 0 && p.favorLedger().some((f) => f.state === "repaid" && f.calledBeat !== undefined);
    for (let i = 0; i < 20_000 && !finished && !enough(); i++) {
      const before = new Map(p.favorLedger().map((f) => [f.id, f.state]));
      const trust = new Map(p.favorLedger().filter((f) => f.state === "owed").map((f) => [f.id, rel.edge(f.holder, f.owedBy).trust]));
      finished = g.turn().finished === true;
      for (const f of p.favorLedger()) if (f.state === "refused" && before.get(f.id) === "owed") refusalTrust.push({ before: trust.get(f.id)!, after: rel.edge(f.holder, f.owedBy).trust });
    }
    expect(enough(), "the season called in a favor that was repaid and one that was refused").toBe(true);
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
    const off = playedGame({ seed: SEED, user: "favors-real-off", before: (s) => s.setFavorsEnabled(false) });
    off.playUntil(() => (off.s.getGameState() as { week?: number }).week! >= 4, 8000, "week 4");
    expect((off.s as unknown as Priv).favorLedger()).toEqual([]);
  }, 600_000);
});
