import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import { ASSURANCE } from "../../src/engine/assurances";

/**
 * B22 (ORWELL_MEMORY_PROMISES, flag-off) - houseguests who HEARD a casual assurance remember its keeping or breaking too, at ASSURANCE.witnessFactor of the assured's own weight; the assurer and the
 * assured are not "witnesses"; flag off => no witness stored and none remembers. Deterministic, no rng. Roles only.
 */
type G = {
  recordAssurance(a: unknown): void; setAssurancesEnabled(on: boolean): void; setMemoryPromisesEnabled(on: boolean): void;
  assuranceNominated(h: string, n: string): void; assuranceKeptAtTally(fn: string[]): void;
};
function started(promises: boolean) {
  const sb = new GameSessionRegistry().sandboxFor(`asrwit-${Math.random()}`);
  sb.session.createCharacter({ playerName: "The Player", archetype: "floater", seed: 7 });
  sb.session.advanceGame(); sb.session.advanceGame();
  const g = sb.session as unknown as G;
  g.setAssurancesEnabled(true); g.setMemoryPromisesEnabled(promises);
  const [holder, assured, witness, other] = [...sb.session.livingIds()].filter((i) => i !== PLAYER);
  return { sb, g, holder: holder!, assured: assured!, witness: witness!, other: other! };
}
type Snap = { session: { snapshot(): { live?: unknown } } };
const mem = (sb: Snap, holder: string, subject: string) => ((sb.session.snapshot().live as { npcMemory?: Record<string, Record<string, { kind: string; severity: number }[]>> }).npcMemory?.[holder]?.[subject] ?? []);
const heard = (sb: Snap) => ((sb.session.snapshot().live as { assurances?: { items: { heardBy?: string[] }[] } }).assurances?.items ?? []).map((i) => i.heardBy);

describe("witnesses remember a heard assurance (B22)", () => {
  it("a broken assurance: the witness remembers a grudge about the breaker at half weight; the assured at full; the assured is not double-counted", () => {
    const { sb, g, holder, assured, witness } = started(true);
    g.recordAssurance({ from: holder, to: assured, kind: "safe", sincerity: 1, source: "npc", heardBy: [witness, assured, holder] });
    g.assuranceNominated(holder, assured);
    expect(mem(sb, witness, holder).map((e) => e.kind)).toEqual(["deal-broken"]);
    expect(mem(sb, witness, holder)[0]!.severity).toBeCloseTo(ASSURANCE.brokenMemorySeverity * ASSURANCE.witnessFactor, 9);
    expect(mem(sb, assured, holder).map((e) => e.kind)).toEqual(["deal-broken"]);
    expect(mem(sb, assured, holder)[0]!.severity).toBeCloseTo(ASSURANCE.brokenMemorySeverity, 9);
    expect(mem(sb, holder, holder)).toEqual([]);
  });
  it("a kept assurance: the witness remembers a favor about the keeper at half weight", () => {
    const { sb, g, holder, assured, witness, other } = started(true);
    g.recordAssurance({ from: holder, to: assured, kind: "safe", sincerity: 1, source: "npc", heardBy: [witness] });
    g.assuranceKeptAtTally([other, PLAYER]);
    expect(mem(sb, witness, holder).map((e) => e.kind)).toEqual(["deal-kept"]);
    expect(mem(sb, witness, holder)[0]!.severity).toBeCloseTo(ASSURANCE.keptMemorySeverity * ASSURANCE.witnessFactor, 9);
  });
  it("flag off: no witness is stored on the ledger row and nobody but the assured remembers", () => {
    const { sb, g, holder, assured, witness } = started(false);
    g.recordAssurance({ from: holder, to: assured, kind: "safe", sincerity: 1, source: "npc", heardBy: [witness] });
    expect(heard(sb)).toEqual([undefined]);
    g.assuranceNominated(holder, assured);
    expect(mem(sb, witness, holder)).toEqual([]);
    expect(mem(sb, assured, holder).map((e) => e.kind)).toEqual(["deal-broken"]);
  });
  it("a second break/keep call changes nothing (resolved once)", () => {
    const { sb, g, holder, assured, witness } = started(true);
    g.recordAssurance({ from: holder, to: assured, kind: "safe", sincerity: 1, source: "npc", heardBy: [witness] });
    g.assuranceNominated(holder, assured); g.assuranceNominated(holder, assured);
    expect(mem(sb, witness, holder).length).toBe(1);
  });
});
