import { describe, it, expect, afterEach } from "vitest";
import { spreadReliableReputation } from "../../src/engine/gossip";
import { makeSocialGraph } from "../../src/engine/gossip";
import { DealLedger } from "../../src/engine/deals";
import { buildEngineCore } from "../../src/composition/engineRoot";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { GameSessionRegistry } from "../../src/composition/registry";
import { reliableFactId, reliableHonorerFrom } from "../../src/domain/deal";
import { PLAYER, npc } from "../../src/domain/ids";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import type { AdvanceView, GameSession } from "../../src/ports/GameSession";

/**
 * 0121 R1 — the diffusing "keeps their word" REPUTATION reward (the knowledge-belief design). A kept deal
 * seeds a hidden `reliable:<honorer>` belief that spreads NPC→NPC; the DEAL consequence is an explicit,
 * bounded deal-willingness lean read from that belief (`mintNpcDeal`), and a small AFFINITY-ONLY whisper
 * makes reliable players faintly more liked — kept OFF the deal-trust read so the two never double-count.
 * Gated behind the deal-depth layer (off ⇒ never seeded ⇒ byte-identical). Roles only — an
 * "honorer"/"other"/"third party" are structural roles, no names.
 */

describe("0121 R1 — the reliable-fact lineage round-trips (the read side can resolve the honorer)", () => {
  it("reliableFactId(honorer) ⇄ reliableHonorerFrom", () => {
    const honorer = npc(9);
    const fid = reliableFactId(honorer);
    expect(fid).toBe(`reliable:${honorer}`);
    expect(reliableHonorerFrom(fid)).toBe(honorer);
    // A non-reliable lineage (an ordinary gossip fact) resolves to nothing.
    expect(reliableHonorerFrom(`fact:${npc(1)}:1234`)).toBeUndefined();
  });
});

// A comp-round resolver that THROWS every comp (so the player never wins the HOH ⇒ a comp-throw promise is
// always KEPT — the honorer path fires deterministically). Every other pending resolves legally.
function resolveThrowing(s: Pick<GameSession, "submitDecision">, p: NonNullable<AdvanceView["pending"]>): void {
  if (p.kind === "comp-round") s.submitDecision({ kind: "comp-round", intent: "throw" });
  else if (p.kind === "nominations") s.submitDecision({ kind: "nominations", choice: [p.options[0]!.id, p.options[1]!.id] });
  else if (p.kind === "veto-decision") s.submitDecision({ kind: "veto-decision", use: false });
  else if (p.kind === "replacement") s.submitDecision({ kind: "replacement", replacement: p.options[0]!.id });
  else if (p.kind === "houseguests-choice") s.submitDecision({ kind: "houseguests-choice", vote: p.options[0]!.id });
  else if (p.kind === "goodbye-message") s.submitDecision({ kind: "goodbye-message", vote: p.options[0]!.id });
  else s.submitDecision({ kind: p.kind, vote: p.options[0]!.id } as never);
}

describe("0121 R1 — spreadReliableReputation (the pure helper)", () => {
  it("a third party who hears it warms in AFFINITY ONLY toward the honorer; the deal partner + honorer never do", () => {
    const core = buildEngineCore();
    const honorer = npc(9), other = npc(1);
    // A chain from the deal partner: other → npc2 → npc3. transmitProb 1 ⇒ deterministic spread.
    const graph = makeSocialGraph([[other, npc(2)], [npc(2), npc(3)]]);
    const candidates = [other, npc(2), npc(3), honorer];
    const before2 = { ...core.relationships.edge(npc(2), honorer) };

    const { leaned, factId } = spreadReliableReputation({
      knowledge: core.knowledge, rel: core.relationships, graph, rng: new SeededRandom(1),
      honorer, other, content: "the honorer keeps their word", candidates,
      factId: reliableFactId(honorer), transmitProb: 1, rounds: 6,
    });

    // The belief spread under the STABLE lineage — every holder's belief resolves back to the honorer.
    expect(factId).toBe(reliableFactId(honorer));
    for (const id of [other, npc(2), npc(3)]) {
      const heard = core.knowledge.knownTo(id).find((k) => k.factId === reliableFactId(honorer));
      expect(heard, `${id} heard it`).toBeDefined();
      expect(reliableHonorerFrom(heard!.factId!)).toBe(honorer);
    }
    // Only THIRD parties leaned — never the deal partner (`other`, who earned the direct fold) or the honorer.
    expect(leaned).toContain(npc(2));
    expect(leaned).toContain(npc(3));
    expect(leaned).not.toContain(other);
    expect(leaned).not.toContain(honorer);
    // The whisper is AFFINITY-ONLY: a third party likes the honorer a bit more, but TRUST is untouched (the
    // deal consequence lives in the explicit willingness lean, not here — so the two never double-count).
    const after2 = core.relationships.edge(npc(2), honorer);
    expect(after2.affinity).toBeGreaterThan(before2.affinity);
    expect(after2.trust).toBe(before2.trust);
  });

  it("is deterministic (same seed ⇒ same leaned set)", () => {
    const run = () => {
      const core = buildEngineCore();
      const graph = makeSocialGraph([[npc(1), npc(2)], [npc(2), npc(3)]]);
      return spreadReliableReputation({
        knowledge: core.knowledge, rel: core.relationships, graph, rng: new SeededRandom(4),
        honorer: npc(9), other: npc(1), content: "x keeps their word",
        candidates: [npc(1), npc(2), npc(3), npc(9)], transmitProb: 1, rounds: 6,
      }).leaned;
    };
    expect(run()).toEqual(run());
  });
});

describe("0121 R1 — the ledger fires the reputation hook only under the deal-depth flag", () => {
  const PROMISOR = npc(2), OTHER = npc(3);
  function keptComp(dealDepth: boolean) {
    const ledger = new DealLedger();
    ledger.make([PROMISOR, OTHER], "comp-throw", "throw the HOH", "evt:1", 1);
    const calls: Array<{ honorer: string; other: string }> = [];
    ledger.reconcile(
      { actor: PROMISOR, kind: "compete", targets: [], outcome: "threw" },
      { rel: undefined, rng: new SeededRandom(1), dealDepth, reputation: (honorer: string, other: string) => calls.push({ honorer, other }) } as never,
    );
    return calls;
  }
  it("kept deal + deal-depth ON ⇒ reputation(honorer, other) fires", () => {
    const calls = keptComp(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ honorer: PROMISOR, other: OTHER });
  });
  it("kept deal + deal-depth OFF ⇒ reputation never fires (byte-identical)", () => {
    expect(keptComp(false)).toHaveLength(0);
  });
});

describe("0121 R1 — the registry seam is live end-to-end (a kept deal seeds the reputation)", () => {
  afterEach(() => GameSessionAdapter.setTimeOfDayEnabled(null));

  function playKeptCompThrow(user: string, dealDepth: boolean): { sb: ReturnType<GameSessionRegistry["sandboxFor"]>; other?: string } {
    const reg = new GameSessionRegistry();
    const sb = reg.sandboxFor(user);
    sb.session.createCharacter({ playerName: "The Player", seed: 9 });
    sb.session.setNpcDealConsentEnabled(false); // these tests exercise deal MECHANICS, not NPC consent (dealConsent*.test.ts cover that)
    sb.session.setDealDepthEnabled(dealDepth);
    let other: string | undefined;
    for (let i = 0; i < 40; i++) {
      const snap = sb.session.snapshot();
      if (other === undefined && snap.live && snap.live.hoh === undefined && dealDepth) {
        const npcId = sb.session.livingIds().find((id) => id !== PLAYER);
        if (npcId && sb.session.makeDeal({ with: npcId, kind: "comp-throw", terms: "I'll throw the HOH for you" })) other = npcId;
      }
      if (sb.session.snapshot().live?.hoh !== undefined) break; // the player threw ⇒ an NPC crowned ⇒ deal kept
      const v = sb.session.advanceGame();
      if (v.pending) resolveThrowing(sb.session, v.pending);
      if (v.finished) break;
    }
    return { sb, other };
  }

  it("a kept comp-throw seeds the honorer's 'keeps their word' reputation under the stable, resolvable lineage", () => {
    const { sb, other } = playKeptCompThrow("dr-on", true);
    expect(other, "a comp-throw was struck").toBeDefined();
    expect(sb.session.snapshot().live!.hoh, "an NPC crowned (the player threw)").not.toBe(PLAYER);
    // The seam fired: the deal partner (the diffusion origin) holds the Vault-free reputation belief about the
    // HONORER (the player, who kept the throw) under the STABLE `reliable:<honorer>` lineage the read side needs.
    const belief = sb.engine.knowledge.knownTo(other!).find((k) => k.factId === reliableFactId(PLAYER));
    expect(belief, "the registry reputation seam is wired end-to-end").toBeDefined();
    expect(reliableHonorerFrom(belief!.factId!), "resolves back to the honorer").toBe(PLAYER);
    // Idempotent: a single honoring seeds the belief exactly once (no duplicate on the partner).
    const count = sb.engine.knowledge.knownTo(other!).filter((k) => k.factId === reliableFactId(PLAYER)).length;
    expect(count).toBe(1);
    // The read side resolves it: replicating the registry's reliabilityReader over the partner's knowledge
    // yields the honorer as a credited "keeps their word" partner — the input to `mintNpcDeal`'s deal lean.
    const credited = new Set(
      sb.engine.knowledge.knownTo(other!)
        .map((k) => (k.factId ? reliableHonorerFrom(k.factId) : undefined))
        .filter((h): h is string => h !== undefined),
    );
    expect(credited.has(PLAYER)).toBe(true);
  });

  it("with the deal-depth layer OFF, no reputation belief is ever seeded (byte-identical)", () => {
    const { sb } = playKeptCompThrow("dr-off", false);
    const anyReliable = sb.session.livingIds().some((id) =>
      sb.engine.knowledge.knownTo(id).some((k) => k.content.includes("keeps their word")));
    expect(anyReliable).toBe(false);
  });
});
