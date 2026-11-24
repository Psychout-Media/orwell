import { describe, it, expect } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { EngineCommandsAdapter } from "../../src/adapters/engine/EngineCommandsAdapter";
import { McpServer } from "../../src/adapters/mcp/McpServer";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import { PLAYER_TOOLS } from "../../src/surfaces/tools/registry";
import { startNewGame } from "../../src/engine/characterFactory";
import {
  generateDiversityLayer, repairDiversityLayer, privateOrientationVaultId,
} from "../../src/engine/diversity";
import type { ProposedIdentityFacets } from "../../src/engine/diversity";
import {
  MIN_BIPOC, MIN_QUEER, MIN_PER_BINARY_GENDER, MIN_PER_AGE_BAND, MAX_NONBINARY,
  MAX_PER_ETHNICITY, AGE_BANDS, AGE_ELIGIBILITY_FLOOR, ageBandOf, ALL_ETHNICITIES,
} from "../../src/engine/diversityConstants";
import { buildSandbox } from "../support/sandbox";

/**
 * Issue #544 — the AI-driven half of the 0063 diversity floor. The FE producer-LLM PROPOSES each
 * houseguest's DESCRIPTIVE identity facets targeting U.S.-population rates and writes them BACK; the ENGINE
 * validates + REPAIRS them against the proportional targets so even a lazy/biased/monochrome model can never
 * skew the cast, and never accepts a hidden game weight. Calibration-neutral (descriptive facets ride the
 * SAME isolated sub-streams). Roles only — NO names from any corpus; no sample-save content as data.
 */

const NPCS = (seed: number) => startNewGame({ seed, playerName: "The Player" }).npcs;

// A deliberately SKEWED, monochrome proposal: a lazy/biased model returns the SAME single non-BIPOC
// heritage + all-men + all-straight for every houseguest. The engine must repair it to a realistic cast.
function monochromeProposal(seed: number): Record<string, ProposedIdentityFacets> {
  const out: Record<string, ProposedIdentityFacets> = {};
  for (const n of NPCS(seed)) {
    out[n.id] = { ethnicity: "German American", genderPresentation: "man", orientation: "straight", out: true, age: 24 };
  }
  return out;
}

describe("#544 — repair holds: a skewed proposal still meets the U.S.-rate floors (across seeds)", () => {
  const SEEDS = [1, 2, 3, 7, 13, 21, 42, 55, 99, 100, 256, 1000, 7777, 31337];

  it("the four floors + the per-heritage cap hold even when the model proposes a monochrome cast", () => {
    for (const seed of SEEDS) {
      const layer = repairDiversityLayer(seed, NPCS(seed), monochromeProposal(seed));
      const pub = Object.values(layer.public);

      // BIPOC floor — the engine repairs a monochrome non-BIPOC proposal back up to realism.
      expect(pub.filter((p) => p.bipoc).length, `seed ${seed} BIPOC`).toBeGreaterThanOrEqual(MIN_BIPOC);

      // Gender balance — both binaries held despite an all-"man" proposal.
      const men = pub.filter((p) => p.genderPresentation === "man").length;
      const women = pub.filter((p) => p.genderPresentation === "woman").length;
      expect(men, `seed ${seed} men`).toBeGreaterThanOrEqual(MIN_PER_BINARY_GENDER);
      expect(women, `seed ${seed} women`).toBeGreaterThanOrEqual(MIN_PER_BINARY_GENDER);

      // Nonbinary stays sparse.
      expect(pub.filter((p) => p.genderPresentation === "nonbinary").length, `seed ${seed} nb`).toBeLessThanOrEqual(MAX_NONBINARY);

      // LGBTQ+ floor — held despite an all-"straight" proposal.
      const nb = pub.filter((p) => p.genderPresentation === "nonbinary").length;
      const outQ = pub.filter((p) => p.outOrientation).length;
      const privQ = Object.keys(layer.privateOrientations).length;
      expect(outQ + privQ + nb, `seed ${seed} queer`).toBeGreaterThanOrEqual(MIN_QUEER);

      // Age spread — held despite an all-24 proposal (every band repaired up).
      const ages = pub.map((p) => p.age);
      for (const a of ages) expect(a, `seed ${seed} age floor`).toBeGreaterThanOrEqual(AGE_ELIGIBILITY_FLOOR);
      for (const band of AGE_BANDS) {
        expect(ages.filter((a) => ageBandOf(a) === band.id).length, `seed ${seed} band ${band.id}`)
          .toBeGreaterThanOrEqual(MIN_PER_AGE_BAND);
      }

      // Per-heritage SPREAD cap — a monochrome proposal can never pile one heritage past the cap.
      const counts = new Map<string, number>();
      for (const p of pub) counts.set(p.ethnicity, (counts.get(p.ethnicity) ?? 0) + 1);
      for (const [heritage, n] of counts) {
        expect(n, `seed ${seed} heritage ${heritage}`).toBeLessThanOrEqual(MAX_PER_ETHNICITY);
      }
    }
  });

  it("skinTone is always RE-GROUNDED from the FINAL (repaired) heritage — text + portrait agree", () => {
    for (const seed of [1, 7, 42, 1000]) {
      const layer = repairDiversityLayer(seed, NPCS(seed), monochromeProposal(seed));
      for (const pub of Object.values(layer.public)) {
        const grounded = ALL_ETHNICITIES.find((e) => e.heritage === pub.ethnicity)!.skinTone;
        expect(pub.skinTone, `seed ${seed} ${pub.ethnicity}`).toBe(grounded);
      }
    }
  });
});

describe("#544 — coherent proposals are HONORED (AI drives who the houseguests are)", () => {
  it("recognized facets that don't violate a floor flow straight through", () => {
    // A coherent, realistic single-houseguest proposal: keep the seeded floor for everyone else, and steer
    // ONE houseguest to a specific (cap-free, floor-safe) identity. The engine should honor it verbatim.
    const seed = 7;
    const npcs = NPCS(seed);
    const target = npcs[0]!.id;
    const proposal: Record<string, ProposedIdentityFacets> = {
      [target]: { ethnicity: "Korean American", genderPresentation: "woman", orientation: "bisexual", out: true, age: 41 },
    };
    const layer = repairDiversityLayer(seed, npcs, proposal);
    const pub = layer.public[target]!;
    expect(pub.ethnicity).toBe("Korean American");
    expect(pub.bipoc).toBe(true);
    expect(pub.genderPresentation).toBe("woman");
    expect(pub.age).toBe(41);
    // A proposed OUT bisexual is the public out facet (not a private orientation).
    expect(pub.outOrientation).toBe("bisexual");
    expect(layer.privateOrientations[target]).toBeUndefined();
  });

  it("a proposed PRIVATE (not-out) queer orientation is Vault-split, never a public facet", () => {
    const seed = 13;
    const npcs = NPCS(seed);
    const target = npcs[0]!.id;
    // ORW-893: a proposed label must fit the houseguest's final presentation ("gay" is a man's, "lesbian" a woman's), so the proposal is the one that fits this houseguest.
    const presentation = generateDiversityLayer(seed, npcs).public[target]!.genderPresentation;
    const label = presentation === "man" ? "gay" : presentation === "woman" ? "lesbian" : "queer";
    const layer = repairDiversityLayer(seed, npcs, {
      [target]: { orientation: label, out: false },
    });
    expect(layer.privateOrientations[target]).toBe(label);
    expect(layer.public[target]!.outOrientation).toBeUndefined();
  });

  it("the cast VARIES game-to-game (a coherent proposal yields a different cast than the bare floor)", () => {
    const seed = 21;
    const npcs = NPCS(seed);
    const floor = generateDiversityLayer(seed, npcs);
    const steered = repairDiversityLayer(seed, npcs, monochromeProposal(seed));
    // The repaired-from-proposal layer differs from the bare seeded floor (the AI shaped it) — yet both
    // satisfy the same guarantees (asserted above). Casts are not a constant.
    expect(JSON.stringify(steered.public)).not.toBe(JSON.stringify(floor.public));
  });
});

describe("#544 — graceful degradation: with NO proposal the deterministic floor stands byte-identically", () => {
  it("an EMPTY proposal is byte-identical to the seeded floor (no model ⇒ floor)", () => {
    for (const seed of [1, 42, 7777]) {
      const npcs = NPCS(seed);
      const floor = generateDiversityLayer(seed, npcs);
      const empty = repairDiversityLayer(seed, npcs, {});
      expect(JSON.stringify(empty)).toBe(JSON.stringify(floor));
    }
  });

  it("an UNRECOGNIZED facet value falls back to the seeded deal for that houseguest", () => {
    const seed = 42;
    const npcs = NPCS(seed);
    const floor = generateDiversityLayer(seed, npcs);
    // Gibberish heritage / orientation / sub-floor age — all ignored; the layer equals the bare floor.
    const garbage: Record<string, ProposedIdentityFacets> = {};
    for (const n of npcs) {
      garbage[n.id] = { ethnicity: "Atlantean", orientation: "not-a-real-orientation" as never, age: 12 };
    }
    expect(JSON.stringify(repairDiversityLayer(seed, npcs, garbage))).toBe(JSON.stringify(floor));
  });
});

describe("#544 — the write-back reaches the engine over the MCP boundary (the four-place gate)", () => {
  function playerServer(): { server: McpServer; session: GameSessionAdapter } {
    const sb = buildSandbox(1);
    const session = new GameSessionAdapter();
    const commands = new EngineCommandsAdapter(sb.engine.events, sb.engine.knowledge);
    const server = new McpServer("player", { player: sb.player, admin: sb.admin, summary: sb.summary, commands, session });
    return { server, session };
  }

  it("recordCastIdentity is on the player channel (the boundary bug)", () => {
    expect(PLAYER_TOOLS.map((t) => t.name)).toContain("recordCastIdentity");
  });

  it("dispatches recordCastIdentity onto a pre-warmed cast — it is not rejected as 'not available'", async () => {
    const { server, session } = playerServer();
    const warm = (await server.callTool("preSeedCast", { seed: 5 })) as { warmed: boolean; house: { id: string }[] };
    expect(warm.warmed).toBe(true);
    const facets: Record<string, ProposedIdentityFacets> = {
      [warm.house[0]!.id]: { ethnicity: "Mexican American", genderPresentation: "woman", age: 38 },
    };
    const res = (await server.callTool("recordCastIdentity", { facets })) as { accepted: boolean; applied: number };
    expect(res.accepted).toBe(true);
    expect(res.applied).toBeGreaterThanOrEqual(1);
    // It folded onto the warmed cast: the re-warm read reflects the (validated) heritage.
    const reread = session.preSeedCast({}) as unknown as { house: Array<{ id: string; ethnicity?: string }> };
    const card = reread.house.find((h) => h.id === warm.house[0]!.id)!;
    expect(card.ethnicity).toBe("Mexican American");
  });

  it("a no-op before any cast is warmed still dispatches cleanly (fail-soft)", async () => {
    const { server } = playerServer();
    const res = (await server.callTool("recordCastIdentity", { facets: {} })) as { accepted: boolean; reason?: string };
    expect(res.accepted).toBe(false);
  });

  it("refuses a malformed facets (an array where an object is expected) with a typed field name", async () => {
    const { server } = playerServer();
    await expect(server.callTool("recordCastIdentity", { facets: ["not", "an", "object"] })).rejects.toThrow(/facets/);
  });
});

describe("#544 — the boundary holds: descriptive only, never a hidden weight; Vault-walled", () => {
  function liveGame(user: string, seed: number) {
    const reg = new GameSessionRegistry();
    const sb = reg.sandboxFor(user);
    sb.session.createCharacter({ playerName: "The Player", seed });
    return { reg, sb };
  }

  it("folds a proposal onto the LIVE house and re-grounds skinTone from the final heritage", () => {
    const { sb } = liveGame("id-live", 5);
    const card = sb.session.getGameState().house.find((h) => h.status === "active")!;
    const res = sb.session.recordCastIdentity({ facets: { [card.id]: { ethnicity: "Caribbean American" } } });
    expect(res.accepted).toBe(true);
    const after = sb.session.getGameState().house.find((h) => h.id === card.id)!;
    expect(after.ethnicity).toBe("Caribbean American");
    const grounded = ALL_ETHNICITIES.find((e) => e.heritage === "Caribbean American")!.skinTone;
    expect(after.physicalCharacteristics!.skinTone).toBe(grounded);
    // The portrait reads the re-grounded facet too.
    const pp = sb.session.getPortraitPrompt(card.id)!;
    expect(pp.prompt).toContain(grounded);
  });

  it("a proposed PRIVATE orientation is sealed into the Vault and NEVER reaches player or admin", () => {
    const { sb } = liveGame("id-vault", 1);
    const card = sb.session.getGameState().house.find((h) => h.status === "active")!;
    sb.session.recordCastIdentity({ facets: { [card.id]: { orientation: "lesbian", out: false } } });

    // Sealed into the Vault (engine-only audit copy) under the private-orientation id.
    const sealed = sb.engine.vault.readHidden().some((r) => r.id === privateOrientationVaultId(card.id));
    expect(sealed).toBe(true);
    // And it is the authoritative in-memory private map (drives 0059 eligibility; persists).
    expect(sb.session.snapshot().privateOrientations?.[card.id]).toBe("lesbian");

    // Never on any player projection, the moment prompt, npcVoice, or the admin inspect.
    const playerSurface = JSON.stringify(sb.session.getGameState())
      + JSON.stringify(sb.player.getVisibleState())
      + sb.session.getMomentPrompt({}).systemPrompt
      + JSON.stringify(sb.session.npcVoice(card.id));
    expect(playerSurface.toLowerCase()).not.toContain("private-orientation");
    // The public card never carries the privately-held orientation as an out facet.
    const after = sb.session.getGameState().house.find((h) => h.id === card.id)!;
    expect(after.outOrientation).toBeUndefined();
    sb.syncAdmin();
    expect(JSON.stringify(sb.admin.inspect()).toLowerCase()).not.toContain("private-orientation");
  });

  it("the proposal carries NO field for a hidden weight — the engine keeps its seeded NPC→player leans", () => {
    // The seeded Day-1 read / competition leans are engine-owned; a cast-identity write-back must not move
    // them (anti-sycophancy #3 + the juryReach calibration). The session adapter shares the engine's
    // relationship graph (registry: `new GameSessionAdapter(engine.relationships)`), so the serialized edges
    // are the authoritative hidden NPC↔player leans — they must be byte-identical across the fold. The
    // engine-owned Day-1 PERCEPTION (the seed of the NPC→player edge) likewise must not move.
    const { sb } = liveGame("id-weights", 9);
    const card = sb.session.getGameState().house.find((h) => h.status === "active")!;
    const edgesBefore = JSON.stringify(sb.engine.relationships.serialize().edges);
    const perceptionBefore = JSON.stringify(sb.session.snapshot().deepProfiles);
    sb.session.recordCastIdentity({ facets: { [card.id]: { ethnicity: "Italian American", genderPresentation: "man", orientation: "gay", out: true, age: 47 } } });
    expect(JSON.stringify(sb.engine.relationships.serialize().edges)).toBe(edgesBefore);
    expect(JSON.stringify(sb.session.snapshot().deepProfiles)).toBe(perceptionBefore);
  });

  it("is idempotent — re-folding the same proposal never duplicates the soul-memory note", () => {
    const { sb } = liveGame("id-idem", 2);
    const card = sb.session.getGameState().house.find((h) => h.status === "active")!;
    const facets = { [card.id]: { orientation: "queer" as const, out: false } };
    sb.session.recordCastIdentity({ facets });
    sb.session.recordCastIdentity({ facets });
    const npcs = sb.session.snapshot().house!.npcs;
    const target = npcs.find((n) => n.id === card.id)!;
    const noteCount = target.soul.memory.filter((m) => m.startsWith(`private-orientation ${card.id}:`)).length;
    expect(noteCount).toBe(1);
  });
});
