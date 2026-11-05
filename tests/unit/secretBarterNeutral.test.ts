import { describe, it, expect } from "vitest";

// B36: this test asserts the OLD graph-diffusion path (or its neutrality / a positive control that rides it). The co-presence layer (ORWELL_GOSSIP_COPRESENCE) REPLACES that path when on, so the
// test pins the layer OFF explicitly instead of depending on the process env (the one-hop-by-scene equivalents live in copresenceSpread / copresenceScenes tests).
import { beforeAll as _b36BeforeAll, afterAll as _b36AfterAll } from "vitest";
const _b36Prev = process.env["ORWELL_GOSSIP_COPRESENCE"];
_b36BeforeAll(() => { process.env["ORWELL_GOSSIP_COPRESENCE"] = "0"; });
_b36AfterAll(() => { if (_b36Prev === undefined) delete process.env["ORWELL_GOSSIP_COPRESENCE"]; else process.env["ORWELL_GOSSIP_COPRESENCE"] = _b36Prev; });
import { createHash } from "node:crypto";
import { GameSessionRegistry } from "../../src/composition/registry";
import { Orchestrator, defaultApply } from "../../src/composition/orchestrator";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import type { RandomnessSource } from "../../src/ports/RandomnessSource";
import type { SessionSnapshot } from "../../src/engine/sessionSnapshot";
import type { LiveSeasonState } from "../../src/engine/liveSeason";
import type { EdgeRecord } from "../../src/domain/saveState";
import { PLAYER, npc } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";

/**
 * Feature 0099 (hidden half) — the CALIBRATION-NEUTRALITY GATE for the off-screen secret-barter tick
 * (the `trajectoryOutcomeNeutral` / `juryHouseAdapter` / `stagedTrajectoryNeutral` sibling). The barter
 * runs on a DEDICATED, isolated side-rng and — like `legendTick` — folds NO relationship edge, so it
 * must be PROVABLY inert to the seeded competition/vote/jury spine:
 *
 *   • Flag OFF ⇒ ZERO draws, no counter advance, and the WHOLE seeded pipeline is BYTE-IDENTICAL.
 *   • Flag ON ⇒ the barter draws ONLY from its own forked stream (it is never handed the shared rng) and
 *     folds no live edge — so the shared draw stream AND the relationship state the vote spine reads are
 *     byte-identical to the OFF run, EVEN WHEN the barter fires and secrets change hands.
 *
 * HARD rule: roles only — no names; all fixtures generated.
 */

const GIVER = npc(1);
const SUBJECT = npc(2);
const WANTER = npc(3);
const ALL_NPCS: EntityId[] = Array.from({ length: 15 }, (_, i) => npc(i + 1));
const SECRET_FACT = "sb-fact-1";

/** A wrapping rng that RECORDS every `next()` value — the exact draw stream the calibration spine shares.
 *  (The barter, by construction, is never handed this rng — it forks its own — so it can add nothing here.) */
class RecordingRandom implements RandomnessSource {
  readonly draws: number[] = [];
  constructor(private readonly inner: RandomnessSource) {}
  next(): number { const v = this.inner.next(); this.draws.push(v); return v; }
  int(maxExclusive: number): number { if (maxExclusive <= 0) return 0; return Math.floor(this.next() * maxExclusive); }
  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error("empty"); return items[this.int(items.length)]!;
  }
  fork(label: string): RandomnessSource { return this.inner.fork(label); }
}

function midGameLive(): LiveSeasonState {
  return { week: 1, beat: "hoh-competition", active: [PLAYER, ...ALL_NPCS], vetoUsed: false, evictionOrder: [], finished: false };
}

/** WANTER uniquely values a secret about SUBJECT; everyone else sits below the barter floor (see behavior test). */
function barterEdges(): EdgeRecord[] {
  const edges: EdgeRecord[] = [];
  const e = (from: EntityId, to: EntityId, o: Partial<EdgeRecord>): void => {
    edges.push({ from, to, trust: 0.3, affinity: 0.3, threat: 0.3, alignment: 0.3, confidence: 0.5, reliability: 0.3, ...o });
  };
  e(WANTER, SUBJECT, { threat: 0.9, affinity: 0.05 });
  e(WANTER, GIVER, { trust: 0.7 });
  for (const n of ALL_NPCS) {
    if (n === WANTER || n === SUBJECT || n === GIVER) continue;
    e(n, SUBJECT, { threat: 0.0, affinity: 0.9 });
    e(n, GIVER, { trust: 0.0 });
  }
  return edges;
}

/** A started game with a crafted mid-game state + edges + the giver's seeded secret about the subject. */
function barterGame(user: string, seed: number): { reg: GameSessionRegistry; sb: ReturnType<GameSessionRegistry["sandboxFor"]> } {
  const reg = new GameSessionRegistry();
  reg.sandboxFor(user).session.createCharacter({ playerName: "The Player", seed });
  const snap = reg.snapshot(user) as SessionSnapshot;
  snap.live = midGameLive();
  snap.relationships = barterEdges();
  reg.restore(user, snap);
  const sb = reg.sandboxFor(user);
  sb.engine.knowledge.seedBelief(GIVER, { content: "a real secret about the subject", factId: SECRET_FACT, subject: SUBJECT, confidence: 1 }, "origin");
  return { reg, sb };
}

const holds = (sb: ReturnType<GameSessionRegistry["sandboxFor"]>, who: EntityId): boolean =>
  sb.engine.knowledge.knownTo(who).some((k) => (k.factId ?? k.id) === SECRET_FACT);

describe("0099 — the barter takes ZERO shared-stream draws (dedicated side-rng, even when firing)", () => {
  it("calling secretBarterTick — even as it transfers a secret — never advances the shared rng", () => {
    const { sb } = barterGame("iso", 7);
    sb.session.setSecretBarterEnabled(true);
    // A stand-in for the orchestrator's shared per-user stream: the barter is NEVER handed this rng.
    const shared = new RecordingRandom(new SeededRandom(1));
    shared.next(); shared.next(); shared.next();
    const before = shared.draws.length;
    for (let t = 0; t < 30; t++) sb.session.secretBarterTick(sb.engine.events, sb.engine.knowledge);
    expect(shared.draws.length, "the barter draws NOTHING from the shared stream").toBe(before);
    // Non-vacuous: the barter genuinely fired (a secret changed hands on its OWN forked stream).
    expect(holds(sb, WANTER), "the barter DID fire on its dedicated stream").toBe(true);
  });

  it("flag OFF ⇒ the dedicated stream never advances (the counter stays absent)", () => {
    const { sb } = barterGame("nodraw", 3);
    sb.session.setSecretBarterEnabled(false); // explicit OFF (default flip 2026-11-03)
    for (let t = 0; t < 30; t++) sb.session.secretBarterTick(sb.engine.events, sb.engine.knowledge);
    expect(sb.session.snapshot().secretBarterTickCount, "no draw when off").toBeUndefined();
    expect(sb.session.snapshot().secretBarterCount, "no secret spent when off").toBeUndefined();
  });
});

describe("0099 — the real off-screen tick's SHARED draw stream + relationship state are byte-identical OFF vs ON", () => {
  /** Drive the REAL orchestrator off-screen apply (`defaultApply`, which now calls `secretBarterTick`) on a
   *  RECORDING shared rng, and capture the shared-draw stream + the relationship state the vote spine reads. */
  function runDefaultApply(seed: number, enable: boolean): { draws: number[]; relSha: string; wanterHolds: boolean } {
    const user = "barter-apply"; // same user across OFF/ON (fresh registries) — the ONLY difference is the flag
    const { reg, sb } = barterGame(user, seed);
    sb.session.setSecretBarterEnabled(enable);
    const shared = new RecordingRandom(new SeededRandom(seed));
    for (let t = 0; t < 20; t++) defaultApply(sb, "offscreen-tick", shared as unknown as SeededRandom, seed, 3);
    const rels = ((reg.snapshot(user) as SessionSnapshot).relationships ?? [])
      .map((e: EdgeRecord) => `${e.from}|${e.to}|${e.trust}|${e.affinity}|${e.threat}|${e.alignment}|${e.reliability ?? ""}`)
      .sort();
    return { draws: shared.draws, relSha: createHash("sha256").update(JSON.stringify(rels)).digest("hex"), wanterHolds: holds(sb, WANTER) };
  }

  it("the shared draw stream is byte-identical, and the relationship state (which the vote spine reads) is unmoved", () => {
    for (const seed of [1, 7, 42]) {
      const off = runDefaultApply(seed, false);
      const on = runDefaultApply(seed, true);
      expect(on.draws, `seed ${seed}: the shared draw stream is byte-identical with the barter ON`).toEqual(off.draws);
      expect(on.relSha, `seed ${seed}: the barter moves NO relationship edge the vote spine reads`).toBe(off.relSha);
      // Sanity (not vacuous): ON the barter fired and moved a secret; OFF it never did.
      expect(on.wanterHolds, `seed ${seed}: the barter fired when ON`).toBe(true);
      expect(off.wanterHolds, `seed ${seed}: nothing bartered when OFF`).toBe(false);
    }
  });
});

describe("0099 — the WHOLE seeded pipeline is byte-identical (SHA256) OFF vs ON before any secret exists", () => {
  /** The whole-pipeline proof (the jury-house `shaWholeSnapshot` analog): drive the REAL orchestrator
   *  off-screen tick over a fresh game. The off-screen society mints only subject-LESS gossip/overhear
   *  beliefs, so the barter self-gates to a STRUCTURAL no-op (no draw, no counter advance) ⇒ the entire
   *  seeded pipeline — every shared draw, every recorded event, the whole snapshot — is byte-identical to
   *  the flag-OFF run. This is exactly the property the heavy `juryReach` gate rests on (the calibration
   *  harness never sets the flag). */
  function shaWholeSnapshot(seed: number, enable: boolean): string {
    const reg = new GameSessionRegistry();
    const orch = new Orchestrator(reg, { now: () => seed }, { seed });
    const user = "barter-whole"; // OFF/ON share the SAME user name in fresh registries — only the flag differs
    const sb = reg.sandboxFor(user);
    sb.session.createCharacter({ playerName: "The Player", seed });
    sb.session.setSecretBarterEnabled(enable);
    for (let t = 0; t < 30; t++) orch.advance(user, "offscreen-tick");
    return createHash("sha256").update(JSON.stringify(sb.session.snapshot())).digest("hex");
  }

  it("enabling the barter does not perturb the seeded pipeline until a subject-bearing secret exists", () => {
    for (const seed of [1, 7, 42]) {
      const off = shaWholeSnapshot(seed, false);
      const on = shaWholeSnapshot(seed, true);
      expect(on, `seed ${seed}: the barter self-gates to a no-op ⇒ byte-identical pipeline`).toBe(off);
    }
  });
});
