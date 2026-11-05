import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import { AssuranceLedger, ASSURANCE, lapseAssurancesAtRoll } from "../../src/engine/assurances";
import { claimsOf, type BeliefStore } from "../../src/engine/beliefStore";

/**
 * B4 slice 5 - a BROKEN casual assurance costs the assurer the assured's trust (ASSURANCE.brokenTrustDrop, rng-free) and, with the belief layer on, plants a `lied-to-me` claim the assured
 * holds; an OPEN assurance lapses at the week roll once past the horizon. Flag-off (ORWELL_ASSURANCES) nothing changes. Roles only.
 */
type G = { assuranceNominated(holder: string, nominee: string): void; recordAssurance(a: unknown): void; rel: { edge(a: string, b: string): { trust: number } }; setNpcBeliefsEnabled(on: boolean): void };
function started(beliefs = false) {
  const sb = new GameSessionRegistry().sandboxFor(`asrbrk-${Math.random()}`);
  sb.session.createCharacter({ playerName: "The Player", archetype: "floater", seed: 7 });
  sb.session.advanceGame(); sb.session.advanceGame();
  sb.session.setAssurancesEnabled(true);
  const g = sb.session as unknown as G;
  g.setNpcBeliefsEnabled(beliefs);
  const [holder, assured] = [...sb.session.livingIds()].filter((i) => i !== PLAYER);
  return { sb, g, holder: holder!, assured: assured! };
}
describe("a broken assurance (B4 slice 5)", () => {
  it("drops the assured's trust in the assurer by exactly the configured amount, once", () => {
    const { g, holder, assured } = started();
    g.recordAssurance({ from: holder, to: assured, kind: "safe", sincerity: 1, source: "npc" });
    const before = g.rel.edge(assured, holder).trust;
    g.assuranceNominated(holder, assured); g.assuranceNominated(holder, assured);
    expect(before - g.rel.edge(assured, holder).trust).toBeCloseTo(Math.min(before, ASSURANCE.brokenTrustDrop), 9);
  });
  it("plants a lied-to-me claim for the assured only when the belief layer is on", () => {
    const on = started(true);
    on.g.recordAssurance({ from: on.holder, to: on.assured, kind: "safe", sincerity: 1, source: "npc" });
    on.g.assuranceNominated(on.holder, on.assured);
    const live = on.sb.session.snapshot().live as { beliefs?: BeliefStore };
    expect(claimsOf(live.beliefs ?? {}, on.assured).some((c) => c.kind === "lied-to-me" && c.subject === on.holder)).toBe(true);
    const off = started(false);
    off.g.recordAssurance({ from: off.holder, to: off.assured, kind: "safe", sincerity: 1, source: "npc" });
    off.g.assuranceNominated(off.holder, off.assured);
    expect((off.sb.session.snapshot().live as { beliefs?: unknown }).beliefs).toBeUndefined();
  });
  it("a player-assured party is not folded (nothing acts on the player's hidden read)", () => {
    const { g, holder } = started();
    g.recordAssurance({ from: holder, to: PLAYER, kind: "safe", sincerity: 1, source: "npc" });
    const before = g.rel.edge(PLAYER, holder).trust;
    g.assuranceNominated(holder, PLAYER);
    expect(g.rel.edge(PLAYER, holder).trust).toBe(before);
  });
  it("flag off: no trust move", () => {
    const { sb, g, holder, assured } = started();
    g.recordAssurance({ from: holder, to: assured, kind: "safe", sincerity: 1, source: "npc" });
    sb.session.setAssurancesEnabled(false);
    const before = g.rel.edge(assured, holder).trust;
    g.assuranceNominated(holder, assured);
    expect(g.rel.edge(assured, holder).trust).toBe(before);
  });
});
describe("lapse at the week roll", () => {
  it("lapse() marks only open assurances past the horizon, never deletes", () => {
    const l = new AssuranceLedger();
    const a = l.add({ from: "npc:1", to: "npc:2", kind: "safe", week: 1, sincerity: 1, source: "npc" });
    const b = l.add({ from: "npc:1", to: "npc:3", kind: "safe", week: 1, sincerity: 1, source: "npc" });
    l.resolve(b.id, "kept");
    l.lapse(1 + ASSURANCE.horizonWeeks);
    expect(l.all.map((x) => x.status)).toEqual(["open", "kept"]);
    l.lapse(2 + ASSURANCE.horizonWeeks);
    expect(l.all.find((x) => x.id === a.id)!.status).toBe("lapsed");
    expect(l.all.length).toBe(2);
  });
});

describe("the week roll lapses stale assurances", () => {
  it("lapseAssurancesAtRoll lapses an open assurance past the horizon and is a no-op without a ledger", () => {
    const l = new AssuranceLedger();
    l.add({ from: "npc:1", to: "npc:2", kind: "safe", week: 1, sincerity: 1, source: "npc" });
    const s = { week: 2 + ASSURANCE.horizonWeeks, assurances: l.toJSON() };
    lapseAssurancesAtRoll(s);
    expect(s.assurances.items[0]!.status).toBe("lapsed");
    const none: { week: number; assurances?: undefined } = { week: 9 };
    lapseAssurancesAtRoll(none);
    expect(none.assurances).toBeUndefined();
  });
  it("liveSeason's week roll calls it exactly once, right after the week increments", () => {
    const src = readFileSync("src/engine/liveSeason.ts", "utf8");
    expect(src.match(/lapseAssurancesAtRoll\(s\)/g)?.length).toBe(1);
    expect(src).toMatch(/s\.week \+= 1; s\.beat = "hoh-competition";\n[^\n]*\n\s*lapseAssurancesAtRoll\(s\);/);
  });
});
