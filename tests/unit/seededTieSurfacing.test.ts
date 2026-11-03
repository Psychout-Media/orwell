import { describe, it, expect, afterEach } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { adrFixture, resolvePending } from "../support/adr0003";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { surfaceSeededTies } from "../../src/engine/seededTieSurfacing";
import { SEEDED_TIE_SURFACING } from "../../src/engine/seededRelationshipConstants";
import { RelationshipModel } from "../../src/engine/relationships";
import { InMemoryKnowledgeService } from "../../src/adapters/inmemory/InMemoryKnowledgeService";
import { InMemoryEventStore } from "../../src/adapters/inmemory/InMemoryEventStore";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import { PLAYER, npc } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";
import type { PreGameTie } from "../../src/engine/seededRelationships";

/**
 * Feature 0059 §5 — the organic pre-game-TIE surfacing scheduler (the DEFERRED follow-on). As a sealed
 * tie's live edge genuinely warms over weeks, a careful observer eventually notices the pair are
 * unusually close; a Vault-free belief diffuses NPC↔NPC (0038) and, rarely + capped, reaches the player
 * (0002). A discovered tie shifts the observer's third-party read via the 0023 fold. STRICTLY OPT-IN
 * (default-OFF `ORWELL_SEEDED_TIE_SURFACING`) and, when off, provably INERT to the calibration spine.
 *
 * Mandate #2 (Vault Wall, player AND admin) + #4 (calibration) are load-bearing here. Roles only — NO
 * names from any corpus.
 */

const SENT = "SENTINEL-0059-S5-what-the-sealed-tie-actually-is";

/** Always leave the process-global flag where the seeded sims expect it: OFF. */
afterEach(() => GameSessionAdapter.setSeededTieSurfacingEnabled(null));

function liveGame(user: string, seed: number) {
  const reg = new GameSessionRegistry();
  const sb = reg.sandboxFor(user);
  sb.session.createCharacter({ playerName: "The Player", seed });
  return { reg, sb };
}

/** A live game whose seeded layer has at least one pre-game TIE (sparseness ⇒ most seeds have none). */
function gameWithATie(prefix: string): { reg: GameSessionRegistry; sb: ReturnType<GameSessionRegistry["sandboxFor"]>; tie: PreGameTie } {
  for (let seed = 1; seed <= 300; seed++) {
    const reg = new GameSessionRegistry();
    const sb = reg.sandboxFor(`${prefix}-${seed}`);
    sb.session.createCharacter({ playerName: "The Player", seed });
    const ties = sb.session.snapshot().seededRelationships?.ties ?? [];
    if (ties.length > 0) return { reg, sb, tie: ties[0]! };
  }
  throw new Error("no seed produced a pre-game tie within the probe range");
}

// ── The pure helper: organic-only, Vault-free, never the sealed `nature` ───────────────────────────
describe("0059 §5 surfaceSeededTies — organic surfacing, never the sealed reason", () => {
  const NPCS = [npc(1), npc(2), npc(3), npc(4)];
  const tie: PreGameTie = { a: npc(1), b: npc(2), nature: "casting-callback" };
  // npc1+npc2 are the tied (and now-warm) pair; npc3/npc4 are out in the open to plausibly notice.
  const occupancy = new Map<EntityId, string>([
    [PLAYER, "living-room"], [npc(1), "kitchen"], [npc(2), "kitchen"], [npc(3), "kitchen"], [npc(4), "backyard"],
  ]) as never;
  const warm = (a: EntityId, b: EntityId): number => (a === b ? 0 : 0.85); // the tie has warmed past the floor

  function freshKnowledge(): InMemoryKnowledgeService {
    return new InMemoryKnowledgeService(new InMemoryEventStore());
  }

  it("an OBSERVABLE tie is noticed, diffuses NPC-side, and NEVER carries the sealed nature", () => {
    let fired = 0;
    let reachedPlayer = 0;
    for (let seed = 0; seed < 200; seed++) {
      const knowledge = freshKnowledge();
      let playerSurfaced = false;
      const out = surfaceSeededTies({
        ties: [tie], npcs: NPCS, player: PLAYER, affinity: warm, nameOf: (id) => `HG-${id}`,
        knowledge, occupancy,
        surfaceToPlayer: (subject, observation) => {
          // Mimic the registry seam: anchor the belief on a confidant, then surface told-by.
          const confidant = npc(3);
          knowledge.seedBelief(confidant, { content: observation, factId: `tie:${seed}`, source: confidant }, "origin");
          const f = knowledge.surfaceInformationTo(PLAYER, { content: observation, subject }, `told-by:${confidant}`);
          playerSurfaced = f !== null;
          return playerSurfaced;
        },
        foldDiscovery: () => {/* no rel in this pure-helper test */},
        alreadySurfacedToPlayer: () => false,
        playerSurfaceCount: 0,
        rng: new SeededRandom(seed),
      });
      if (out.length === 0) continue;
      fired++;
      // The observer is one of the out-in-the-open NPCs, never one of the pair.
      expect([npc(3), npc(4)]).toContain(out[0]!.observer);
      expect(out[0]!.pair).toEqual([npc(1), npc(2)]);
      // The sealed REASON ("casting-callback") never crosses to ANYONE — only the observable read.
      for (const id of [PLAYER, ...NPCS]) {
        for (const f of knowledge.knownTo(id)) {
          expect(f.content).not.toContain(SENT);
          expect(f.content.toLowerCase()).not.toContain("casting-callback");
          expect(f.content.toLowerCase()).not.toContain("pre-game-tie");
        }
      }
      if (playerSurfaced) reachedPlayer++;
    }
    expect(fired, "the gate opens a real fraction of the time").toBeGreaterThan(0);
    expect(reachedPlayer, "a chain reaches the player sometimes (the house tells them)").toBeGreaterThan(0);
  });

  it("a tie that has NOT warmed past the floor stays fully sealed (nothing rises)", () => {
    const cold = (a: EntityId, b: EntityId): number =>
      a === b ? 0 : (Math.min(SEEDED_TIE_SURFACING.observableAffinity - 0.05, 0.4)); // below the observable floor
    for (let seed = 0; seed < 80; seed++) {
      const knowledge = freshKnowledge();
      expect(surfaceSeededTies({
        ties: [tie], npcs: NPCS, player: PLAYER, affinity: cold, nameOf: (id) => `HG-${id}`,
        knowledge, occupancy,
        surfaceToPlayer: () => false, foldDiscovery: () => {}, alreadySurfacedToPlayer: () => false,
        playerSurfaceCount: 0, rng: new SeededRandom(seed),
      })).toEqual([]);
      // …and nobody learned anything.
      for (const id of [PLAYER, ...NPCS]) expect(knowledge.knownTo(id)).toHaveLength(0);
    }
  });

  it("the player-surface CAP is honored — over the budget, nothing more crosses to the player", () => {
    let attemptedOverCap = 0;
    for (let seed = 0; seed < 200; seed++) {
      const knowledge = freshKnowledge();
      surfaceSeededTies({
        ties: [tie], npcs: NPCS, player: PLAYER, affinity: warm, nameOf: (id) => `HG-${id}`,
        knowledge, occupancy,
        surfaceToPlayer: () => { attemptedOverCap++; return true; },
        foldDiscovery: () => {}, alreadySurfacedToPlayer: () => false,
        playerSurfaceCount: SEEDED_TIE_SURFACING.maxPlayerSurfacesPerSeason, // cap already spent
        rng: new SeededRandom(seed),
      });
    }
    expect(attemptedOverCap, "no to-player surfacing is even ATTEMPTED once the cap is spent").toBe(0);
  });

  it("no positioned observer (everyone else behind closed doors) ⇒ nothing rises", () => {
    const hidden = new Map<EntityId, string>([
      [PLAYER, "living-room"], [npc(1), "kitchen"], [npc(2), "kitchen"], [npc(3), "lounge"], [npc(4), "bedroom-a"],
    ]) as never;
    for (let seed = 0; seed < 50; seed++) {
      expect(surfaceSeededTies({
        ties: [tie], npcs: NPCS, player: PLAYER, affinity: warm, nameOf: (id) => `HG-${id}`,
        knowledge: freshKnowledge(), occupancy: hidden,
        surfaceToPlayer: () => false, foldDiscovery: () => {}, alreadySurfacedToPlayer: () => false,
        playerSurfaceCount: 0, rng: new SeededRandom(seed),
      })).toEqual([]);
    }
  });

  it("the discovery FOLD fires on a fresh discovery (the §5 third-party re-read)", () => {
    let folds = 0;
    for (let seed = 0; seed < 50; seed++) {
      const out = surfaceSeededTies({
        ties: [tie], npcs: NPCS, player: PLAYER, affinity: warm, nameOf: (id) => `HG-${id}`,
        knowledge: freshKnowledge(), occupancy,
        surfaceToPlayer: () => false,
        foldDiscovery: (observer, pair) => { folds++; expect([npc(3), npc(4)]).toContain(observer); expect(pair).toEqual([npc(1), npc(2)]); },
        alreadySurfacedToPlayer: () => false, playerSurfaceCount: 0, rng: new SeededRandom(seed),
      });
      if (out.length > 0) expect(folds).toBeGreaterThan(0);
    }
    expect(folds, "a discovered tie re-reads the pair for the observer").toBeGreaterThan(0);
  });
});

// ── CALIBRATION NEUTRALITY (mandate #4 — load-bearing) ─────────────────────────────────────────────
describe("0059 §5 — calibration-neutral: flag OFF ⇒ the off-screen spine is byte-identical", () => {
  /**
   * The off-screen tick now calls `advanceSeededTies` unconditionally. With the flag OFF that call is a
   * pure no-op (proved directly in the next test). This test pins that adding it left the seeded tick
   * fully DETERMINISTIC: two identical seeded runs through the production orchestrator produce a
   * byte-identical event log + relationship serialization (no hidden nondeterminism crept in). The
   * juryReach + gradient heavy sims are the end-to-end byte-identity proof against the pre-feature numbers.
   */
  function runTicks(user: string, seed: number, ticks = 8): { events: string; rels: string } {
    GameSessionAdapter.setSeededTieSurfacingEnabled(false); // explicit OFF (default flip 2026-11-03)
    const fx = adrFixture(user, seed);
    for (let t = 0; t < ticks; t++) fx.orch.advance(user, "offscreen-tick");
    return {
      events: JSON.stringify(fx.sb.engine.events.queryAll()),
      rels: JSON.stringify(fx.sb.engine.relationships.serialize().edges),
    };
  }

  it("flag OFF: the seeded off-screen tick is fully deterministic across identical runs (no perturbation)", () => {
    // SAME (seed, user): the orchestrator's per-user rng is keyed on `seed:user`, so identical inputs must
    // reproduce byte-identical state — adding the off-default `advanceSeededTies` call must not break that.
    const a = runTicks("n-det", 7);
    const b = runTicks("n-det", 7);
    expect(b.events, "flag OFF: the seeded event stream is byte-identical across runs").toBe(a.events);
    expect(b.rels, "flag OFF: the relationship serialization is byte-identical across runs").toBe(a.rels);
    // The scheduler left NO footprint: no tie-observation event entered the log at all.
    expect(a.events).not.toMatch(/unusually tight|go back further/);
  });

  it("flag OFF: the scheduler records NO tie event and moves NO edge via discovery (provably inert)", () => {
    GameSessionAdapter.setSeededTieSurfacingEnabled(false); // explicit OFF (default flip 2026-11-03)
    const fx = adrFixture("n-inert", 11);
    // Prime an observable tie so the scheduler WOULD fire if it were on.
    fx.sb.engine.relationships.edge(npc(1), npc(2)).affinity = 0.99;
    fx.sb.engine.relationships.edge(npc(2), npc(1)).affinity = 0.99;
    const relsBefore = JSON.stringify(fx.sb.engine.relationships.serialize().edges);
    const got = fx.sb.session.advanceSeededTies(fx.sb.engine.knowledge);
    expect(got).toEqual([]); // returns immediately, surfaced nothing
    // No tie-observation event, no edge moved by the (skipped) discovery fold.
    expect(fx.sb.engine.events.queryAll().some((e) => /unusually tight|go back further/.test(e.content))).toBe(false);
    expect(JSON.stringify(fx.sb.engine.relationships.serialize().edges)).toBe(relsBefore);
    // The dedicated tick counter never advanced (no draw was made on any stream).
    expect(fx.sb.session.snapshot().tieScheduleTickCount ?? 0).toBe(0);
  });

  it("the flag is the ONLY gate: turning it ON makes the scheduler observably change the world", () => {
    // OFF: a primed tie over several ticks surfaces nothing to the player.
    GameSessionAdapter.setSeededTieSurfacingEnabled(false);
    const off = adrFixture("g-off", 5);
    off.sb.engine.relationships.edge(npc(1), npc(2)).affinity = 0.99;
    off.sb.engine.relationships.edge(npc(2), npc(1)).affinity = 0.99;
    for (let t = 0; t < 20; t++) off.sb.session.advanceSeededTies(off.sb.engine.knowledge);
    const offFired = off.sb.engine.events.queryAll().some((e) => /unusually tight|go back further/.test(e.content))
      || off.sb.engine.knowledge.knownTo(PLAYER).some((f) => /unusually tight|go back further/.test(f.content));
    expect(offFired).toBe(false);

    // ON: a SEEDED tie, primed to the ceiling, surfaces NPC-side within the bound.
    GameSessionAdapter.setSeededTieSurfacingEnabled(true);
    const { reg: _r, sb, tie } = gameWithATie("g-on");
    sb.engine.relationships.edge(tie.a, tie.b).affinity = 0.99;
    sb.engine.relationships.edge(tie.b, tie.a).affinity = 0.99;
    let surfaced = false;
    for (let t = 0; t < 60 && !surfaced; t++) {
      sb.session.advanceSeededTies(sb.engine.knowledge);
      // Anyone in the house came to hold the observable read (origin always holds it when the gate opens).
      surfaced = [tie.a, tie.b, npc(3), npc(4), PLAYER].some((id) =>
        sb.engine.knowledge.knownTo(id).some((f) => /unusually tight|go back further/.test(f.content)));
    }
    expect(surfaced, "with the flag ON, a primed seeded tie surfaces organically within the bound").toBe(true);
  });
});

// ── VAULT WALL (mandate #2 — player AND admin) + monotonicity + persistence ────────────────────────
describe("0059 §5 — Vault Wall (player AND admin) holds through surfacing, persistence is monotonic", () => {
  it("even with the scheduler ON and a tie surfaced, no surface leaks the sealed nature (player + admin + npcVoice + moment prompt)", () => {
    GameSessionAdapter.setSeededTieSurfacingEnabled(true);
    const { sb, tie } = gameWithATie("wall-on");
    // Plant a sentinel into the sealed seeded-relationship Vault layer (the secret reason).
    sb.engine.vault.writeHidden({ id: "sr:s5:sent", kind: "seeded-relationship", subject: tie.a, content: `${SENT}` });
    // Prime + drive the tie to surface (so we test the wall AFTER a real surfacing, not only at rest).
    sb.engine.relationships.edge(tie.a, tie.b).affinity = 0.99;
    sb.engine.relationships.edge(tie.b, tie.a).affinity = 0.99;
    for (let t = 0; t < 60; t++) sb.session.advanceSeededTies(sb.engine.knowledge);

    // EVERY outward surface is sentinel-free — and free of the sealed-layer structural markers.
    const everySurface = JSON.stringify(sb.session.getGameState())
      + JSON.stringify(sb.player.getVisibleState())
      + JSON.stringify(sb.session.gameStatus())
      + sb.session.getMomentPrompt({}).systemPrompt
      + sb.session.getMomentPrompt({ moment: "social" }).systemPrompt
      + sb.session.getGameState().house.filter((h) => h.status === "active")
          .map((h) => JSON.stringify(sb.session.npcVoice(h.id))).join("");
    expect(everySurface).not.toContain(SENT);
    // The DATA projections never carry the sealed-layer markers OR the secret nature slug.
    const dataSurface = JSON.stringify(sb.session.getGameState())
      + JSON.stringify(sb.player.getVisibleState())
      + JSON.stringify(sb.session.gameStatus())
      + sb.session.getGameState().house.filter((h) => h.status === "active")
          .map((h) => JSON.stringify(sb.session.npcVoice(h.id))).join("");
    expect(dataSurface).not.toMatch(/pre-game-tie|seeded-relationship/);
    expect(dataSurface).not.toMatch(/casting-callback|mutual-friend|shared-hometown|old-acquaintance/);
    // ADMIN / God Mode is walled too.
    sb.syncAdmin();
    expect(JSON.stringify(sb.admin.inspect())).not.toContain(SENT);
    expect(JSON.stringify(sb.admin.inspect())).not.toMatch(/pre-game-tie|seeded-relationship/);
    expect(JSON.stringify(sb.admin.inspect())).not.toMatch(/casting-callback|mutual-friend|shared-hometown|old-acquaintance/);
  });

  it("the surfacing CAP + discovered-subjects persist across a restart and never reset (non-degradation)", () => {
    GameSessionAdapter.setSeededTieSurfacingEnabled(true);
    const { sb, tie } = gameWithATie("persist-on");
    sb.engine.relationships.edge(tie.a, tie.b).affinity = 0.99;
    sb.engine.relationships.edge(tie.b, tie.a).affinity = 0.99;
    // Drive until at least one tie has surfaced TO THE PLAYER (the cap is keyed on that), or the bound.
    for (let t = 0; t < 200 && (sb.session.snapshot().playerTieSurfaceCount ?? 0) === 0; t++) {
      sb.session.advanceSeededTies(sb.engine.knowledge);
    }
    const before = sb.session.snapshot();
    const cap = before.playerTieSurfaceCount ?? 0;
    expect(cap).toBeGreaterThan(0); // the to-player surfacing actually happened within the bound
    // Round-trip: the cap counter + surfaced subjects survive byte-identical (monotonic — never reset).
    sb.session.restore(before);
    const after = sb.session.snapshot();
    expect(after.playerTieSurfaceCount).toBe(cap);
    expect(JSON.stringify(after.surfacedTieSubjects)).toBe(JSON.stringify(before.surfacedTieSubjects));
    // A further drive never EXCEEDS the hard cap (monotone, bounded).
    for (let t = 0; t < 50; t++) sb.session.advanceSeededTies(sb.engine.knowledge);
    expect(sb.session.snapshot().playerTieSurfaceCount).toBeLessThanOrEqual(SEEDED_TIE_SURFACING.maxPlayerSurfacesPerSeason);
  });
});

// ── PLAYER SHOWMANCE IS EARNED (anti-sycophancy) — the §5 discipline, asserted via the built arc ────
describe("0059 §5 — a passive player accrues no showmance the engine wasn't cultivated into", () => {
  it("with the flag ON and a passive player, no player-involving showmance becomes visible", () => {
    GameSessionAdapter.setSeededTieSurfacingEnabled(true);
    const fx = adrFixture("earned", 9);
    // A passive player: never cultivates any romance. Advance several weeks of the real loop.
    for (let i = 0; i < 120; i++) {
      const v = fx.sb.session.advanceGame();
      if (v.pending) resolvePending(fx.sb.session, v.pending);
      fx.orch.advance("earned", "offscreen-tick");
      if (v.finished) break;
    }
    // No VISIBLE showmance ever names the player — a player showmance must be earned, never given.
    const player = fx.sb.session.snapshot().house!.player.id;
    for (const sm of fx.sb.session.visibleShowmances()) {
      expect(sm.a).not.toBe(player);
      expect(sm.b).not.toBe(player);
    }
    // And the player never silently acquired a seeded showmance partner in the sealed layer either.
    const sealed = fx.sb.session.snapshot().seededRelationships?.showmances ?? [];
    for (const s of sealed) { expect(s.a).not.toBe(player); expect(s.b).not.toBe(player); }
  });
});
