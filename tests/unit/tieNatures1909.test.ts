import { describe, it, expect } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import {
  TIE_NATURES, LEGACY_TIE_NATURE_ALIASES, normalizeTieNature, migrateSeededRelationships, tieNatureProse,
  loadSeededRelationships, preGameTieToRetrospectiveProse, type SeededRelationships, type TieNature,
} from "../../src/engine/seededRelationships";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import { RelationshipModel } from "../../src/engine/relationships";
import { GameSessionRegistry } from "../../src/composition/registry";
import type { SessionSnapshot } from "../../src/engine/sessionSnapshot";
import { npc } from "../../src/domain/ids";

/**
 * #1909 — (A) the pre-show-romance tie NATURE is `prior-romance` (the word "showmance" belongs to the in-house ARC only);
 * (B) the nature set was broadened (PO ruling 2026-11-03: family, exes, old friends, rivals/bad blood + a few more); (C) every
 * reader/loader aliases the legacy spelling. Calibration-neutral: a nature is flavour only — the bias is identical for all. Roles only.
 */
const NEW_NATURES: TieNature[] = ["family", "ex", "old-friend", "rival", "former-teammate", "online-acquaintance"];

describe("the tie nature set (#1909 A + B)", () => {
  it("the romance nature no longer shares the arc's word, and the owner's requested kinds are all present", () => {
    expect(TIE_NATURES).not.toContain("showmance" as never);
    expect(TIE_NATURES).toContain("prior-romance");
    for (const n of NEW_NATURES) expect(TIE_NATURES, n).toContain(n);
    expect(new Set(TIE_NATURES).size).toBe(TIE_NATURES.length);
  });

  it("every nature has distinct, readable prose that carries no name, id or number", () => {
    const prose = TIE_NATURES.map((n) => tieNatureProse(n));
    expect(new Set(prose).size).toBe(TIE_NATURES.length);
    for (const p of prose) {
      expect(p.length).toBeGreaterThan(8);
      expect(p).not.toMatch(/npc:|\d/);
    }
    expect(tieNatureProse("prior-romance")).toBe("came in with a pre-show romantic spark"); // unchanged text for the renamed nature
    expect(tieNatureProse("rival")).toMatch(/bad blood/);
  });

  it("a retrospective line for a family / rival / ex tie reads in plain prose with both names", () => {
    for (const nature of ["family", "rival", "ex"] as const) {
      const line = preGameTieToRetrospectiveProse({ a: npc(1), b: npc(2), nature }, (id) => (id === npc(1) ? "Alex" : "Blake"));
      expect(line).toContain("Alex");
      expect(line).toContain("Blake");
      expect(line).not.toMatch(/npc:/);
    }
  });
});

describe("the legacy alias and the load-time migration (#1909 C)", () => {
  it("normalizeTieNature: today's names pass, the legacy spelling aliases forward, anything else is undefined", () => {
    expect(LEGACY_TIE_NATURE_ALIASES["showmance"]).toBe("prior-romance");
    expect(normalizeTieNature("showmance")).toBe("prior-romance");
    expect(normalizeTieNature(" prior-romance ")).toBe("prior-romance");
    expect(normalizeTieNature("family")).toBe("family");
    expect(normalizeTieNature("not-a-nature")).toBeUndefined();
    expect(normalizeTieNature(7)).toBeUndefined();
  });

  it("migrateSeededRelationships re-reads a legacy tie as prior-romance, defaults an unknown one, and leaves the showmance ARC alone", () => {
    const legacy = {
      ties: [
        { a: npc(1), b: npc(2), nature: "showmance", exposure: "surfaced-to-house" },
        { a: npc(3), b: npc(4), nature: "mutual-friend" },
        { a: npc(5), b: npc(6), nature: "something-else" },
      ],
      showmances: [{ a: npc(7), b: npc(8), stage: "bond" }],
    } as unknown as SeededRelationships;
    const out = migrateSeededRelationships(legacy);
    expect(out.ties.map((t) => t.nature)).toEqual(["prior-romance", "mutual-friend", "old-acquaintance"]);
    expect(out.ties[0]!.exposure).toBe("surfaced-to-house"); // exposure is monotonic state — never reset by the migration
    expect(out.showmances).toEqual([{ a: npc(7), b: npc(8), stage: "bond" }]); // the arc keeps its word and its stage
  });

  it("an OLD SAVE carrying a 'showmance' tie restores as prior-romance (non-degradation: the tie survives)", () => {
    const reg = new GameSessionRegistry();
    const user = "tie-legacy";
    reg.sandboxFor(user).session.createCharacter({ playerName: "The Player", seed: 91 });
    const snap = reg.snapshot(user) as SessionSnapshot;
    snap.seededRelationships = {
      ties: [{ a: npc(1), b: npc(2), nature: "showmance" as never }],
      showmances: [],
    };
    reg.restore(user, snap);
    const restored = reg.snapshot(user) as SessionSnapshot;
    expect(restored.seededRelationships?.ties).toHaveLength(1);
    expect(restored.seededRelationships!.ties[0]!.nature).toBe("prior-romance");
  });
});

describe("calibration neutrality: the nature is flavour only (#1909)", () => {
  it("a FRIENDLY tie folds the SAME hidden edges whatever its nature; an ex / rival starts COLD instead, from the pair's own temperaments (ORW-132, Ryne 2026-11-06)", () => {
    const edgesFor = (nature: TieNature | null): string => {
      const rel = new RelationshipModel(0.5);
      const session = new GameSessionAdapter(rel);
      session.createCharacter({ playerName: "The Player", seed: 93 });
      // Re-run the seeding fold with an authored (genesis) tie of this nature on top of the floor layer.
      const priv = session as unknown as { genesisTies: unknown; seedSeededRelationships(seed: number): void };
      priv.genesisTies = nature ? [{ a: npc(1), b: npc(2), nature, exposure: "sealed" }] : [];
      priv.seedSeededRelationships(93);
      return JSON.stringify(rel.allBondStrengths()); // every directed edge's bond after the seeded fold
    };
    const baseline = edgesFor("old-acquaintance");
    for (const nature of TIE_NATURES) {
      if (nature === "ex" || nature === "rival") expect(edgesFor(nature), `${nature} starts cold, not like a plain acquaintance`).not.toBe(baseline);
      else expect(edgesFor(nature), nature).toBe(baseline);
    }
    expect(baseline, "a tie really folds the standing bias (vs no tie at all)").not.toBe(edgesFor(null));
  });

  it("a loaded tie draws its nature from the CURRENT set and the layer is deterministic per seed", () => {
    const npcs = Array.from({ length: 15 }, (_, i) => ({ id: npc(i + 1), name: `N${i}` })) as never;
    let ties = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const one = loadSeededRelationships(npcs, 2, 2, new SeededRandom(seed), undefined);
      const two = loadSeededRelationships(npcs, 2, 2, new SeededRandom(seed), undefined);
      expect(two).toEqual(one);
      for (const t of one.ties) { expect(TIE_NATURES).toContain(t.nature); ties++; }
    }
    expect(ties).toBeGreaterThan(0);
  });
});

describe("review hardening (#1985)", () => {
  it("normalizeTieNature honours own alias keys only — inherited Object members are unknown, never 'natures'", () => {
    for (const bad of ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"]) {
      expect(normalizeTieNature(bad), bad).toBeUndefined();
    }
    expect(normalizeTieNature("showmance")).toBe("prior-romance");
  });

  it("the family prose is exposure-neutral (it reads the same in a sealed audit and an exposed reveal)", () => {
    expect(tieNatureProse("family")).not.toMatch(/doesn't know|does not know|secret|hidden/i);
  });

  it("a pre-#1909 casting save (prewarm.genesisTies still spelled 'showmance') is aliased on adoption", async () => {
    const { McpServer } = await import("../../src/adapters/mcp/McpServer");
    const { EngineCommandsAdapter } = await import("../../src/adapters/engine/EngineCommandsAdapter");
    const { buildSandbox } = await import("../support/sandbox");
    const sb = buildSandbox(1);
    const session = new GameSessionAdapter();
    const commands = new EngineCommandsAdapter(sb.engine.events, sb.engine.knowledge);
    const server = new McpServer("player", { player: sb.player, admin: sb.admin, summary: sb.summary, commands, session });
    const warm = (await server.callTool("preSeedCast", { seed: 9 })) as { house: { id: string; name: string }[] };
    const ids = warm.house.map((h) => h.id);
    // Keep each warmed NPC's OWN generated name (id-keyed; no hard-coded names in a test).
    const npcs = warm.house.map(({ id, name }) => ({
      id, name, stats: { physical: 5, mental: 5, social: 5 }, hiddenElements: ["a", "b", "c"],
      identityConcept: "concept",
    }));
    await server.callTool("recordCastGenesis", { npcs, ties: [{ a: ids[0], b: ids[1], nature: "casting-callback" }] });
    // Simulate the old save: the persisted prewarm buffer carries the legacy spelling.
    const priv = session as unknown as { prewarm: { genesisTies: { nature: string }[] } };
    expect(priv.prewarm.genesisTies.length, "genesis ties were authored").toBeGreaterThan(0);
    priv.prewarm.genesisTies[0]!.nature = "showmance";
    session.createCharacter({ playerName: "The Player" });
    const natures = (session as unknown as { seededRels: SeededRelationships }).seededRels.ties.map((t) => t.nature);
    expect(natures.length).toBeGreaterThan(0);
    for (const n of natures) expect(TIE_NATURES, n).toContain(n);
    expect(natures).toContain("prior-romance");
  });
});
