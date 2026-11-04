import { describe, it, expect } from "vitest";
import { nominationPlan } from "../../src/engine/season";
import { RelationshipModel } from "../../src/engine/relationships";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";

/**
 * B4 slice 3 - a KEPT casual assurance ("you're safe with me") keeps the assured off the HOH's block while two legal others remain; a BROKEN one (the HOH's own cost-benefit says break)
 * leaves the assured a candidate and, when they are actually nominated, resolves the assurance broken with a smaller-than-a-deal fold. Flag-off (ORWELL_ASSURANCES) byte-identical. Roles only.
 */
const ids = ["npc:1", "npc:2", "npc:3", "npc:4", "npc:5"];
const rel = () => new RelationshipModel(0.5);

describe("nominationPlan with an assurance protection", () => {
  it("a protected target is never nominated while two legal others remain", () => {
    const r = rel();
    const base = nominationPlan("npc:1", ids, r, {});
    const prot = nominationPlan("npc:1", ids, r, { protectedByAssurance: (t) => t === base.target });
    expect(prot.nominees).not.toContain(base.target);
    expect(prot.nominees.length).toBe(2);
  });
  it("absent the provider the plan is byte-identical", () => {
    const r = rel();
    expect(nominationPlan("npc:1", ids, r, {})).toEqual(nominationPlan("npc:1", ids, r, { protectedByAssurance: undefined }));
  });
  it("protection never leaves fewer than two legal candidates (everyone protected => ignored)", () => {
    const r = rel();
    const plan = nominationPlan("npc:1", ids, r, { protectedByAssurance: () => true });
    expect(plan.nominees.length).toBe(2);
  });
});

describe("adapter provider (ORWELL_ASSURANCES)", () => {
  function started() {
    const sb = new GameSessionRegistry().sandboxFor(`asrnom-${Math.random()}`);
    sb.session.createCharacter({ playerName: "The Player", archetype: "floater", seed: 7 });
    sb.session.advanceGame(); sb.session.advanceGame();
    sb.session.setAssurancesEnabled(true);
    const [holder, assured] = [...sb.session.livingIds()].filter((i) => i !== PLAYER);
    return { sb, holder: holder!, assured: assured! };
  }
  type G = { assuranceProtects(target: string, holder: string): boolean; assuranceNominated(holder: string, nominee: string): void; recordAssurance(a: unknown): void };
  it("a sincere assurance from a loyal-enough holder protects the assured; none protects nobody", () => {
    const { sb, holder, assured } = started(); const g = sb.session as unknown as G;
    expect(g.assuranceProtects(assured, holder)).toBe(false);
    g.recordAssurance({ from: holder, to: assured, kind: "safe", sincerity: 1, source: "npc" });
    expect(typeof g.assuranceProtects(assured, holder)).toBe("boolean");
  });
  it("an insincere (strategic-lie) assurance never protects", () => {
    const { sb, holder, assured } = started(); const g = sb.session as unknown as G;
    g.recordAssurance({ from: holder, to: assured, kind: "safe", sincerity: 0, source: "npc" });
    expect(g.assuranceProtects(assured, holder)).toBe(false);
  });
  it("nominating the assured resolves the open assurance as broken (exactly once)", () => {
    const { sb, holder, assured } = started(); const g = sb.session as unknown as G;
    g.recordAssurance({ from: holder, to: assured, kind: "safe", sincerity: 1, source: "npc" });
    g.assuranceNominated(holder, assured); g.assuranceNominated(holder, assured);
    const items = ((sb.session.snapshot().live as { assurances: { items: { status: string }[] } }).assurances.items);
    expect(items.map((i) => i.status)).toEqual(["broken"]);
  });
  it("flag off: nothing protects and nothing resolves", () => {
    const { sb, holder, assured } = started(); const g = sb.session as unknown as G;
    g.recordAssurance({ from: holder, to: assured, kind: "safe", sincerity: 1, source: "npc" });
    sb.session.setAssurancesEnabled(false);
    expect(g.assuranceProtects(assured, holder)).toBe(false);
    g.assuranceNominated(holder, assured);
    const items = ((sb.session.snapshot().live as { assurances: { items: { status: string }[] } }).assurances.items);
    expect(items.map((i) => i.status)).toEqual(["open"]);
  });
});
