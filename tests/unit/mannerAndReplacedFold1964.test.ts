import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import type { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { mergeManner, recordDealBetrayal } from "../../src/engine/liveSeason";
import type { LiveSeasonState } from "../../src/engine/liveSeason";
import type { EntityId } from "../../src/domain/ids";

/**
 * #1964 — `recordEvictionManner` MERGES into the manner already on file (a `recordDealBetrayal` flag survives).
 * #1965 — the `replaced` ceremony fold lands the betrayal shock only on a replacement who TRUSTED the HOH (read
 * PRE-fold), graded by that trust; a replacement who never trusted them takes the plain nomination conflict.
 * Roles only — HOH, replacement, evictee, breaker.
 */

type Priv = {
  live: LiveSeasonState & { hoh: EntityId | null; replacement: EntityId | null };
  foldCeremonyConsequence(ev: { beat: string; participants: EntityId[] }): void;
};

function newSession(seed: number): { session: GameSessionAdapter; reg: ReturnType<GameSessionRegistry["sandboxFor"]> } {
  const reg = new GameSessionRegistry();
  const sb = reg.sandboxFor(`manner-${seed}`);
  sb.session.createCharacter({ playerName: "P", seed });
  return { session: sb.session as GameSessionAdapter, reg: sb };
}

describe("#1964 — mergeManner keeps an earlier grievance", () => {
  it("ORs the booleans and keeps the strongest intensity (absent = full strength)", () => {
    expect(mergeManner(undefined, { respected: true, intensity: 0.2 })).toEqual({ respected: true, intensity: 0.2 });
    const m = mergeManner({ betrayed: true }, { respected: true, intensity: 0.2 });
    expect(m.betrayed).toBe(true);
    expect(m.respected, "a grievance supersedes respected (one eviction never counts toward both facets)").toBeUndefined();
    expect(m.intensity, "a boolean-only demerit is full strength and dominates a faint graded read").toBe(1);
    expect(mergeManner({ betrayed: true, intensity: 0.6 }, { blindsided: true, intensity: 0.9 })).toMatchObject({
      betrayed: true, blindsided: true, intensity: 0.9,
    });
  });

  it("a deal break followed by the wronged party's eviction still reads `betrayed` in mannerByEvictee", () => {
    const { session, reg } = newSession(9);
    const p = session as unknown as Priv;
    // Reach the eviction stage the way the existing eviction-consequence suite does.
    let staged = false;
    for (let i = 0; i < 400 && !staged; i++) {
      let adv = session.advanceGame();
      if (adv.pending) {
        const q = adv.pending;
        adv = q.kind === "nominations" ? session.submitDecision({ kind: "nominations", choice: [q.options[0]!.id, q.options[1]!.id] })
          : q.kind === "veto-decision" ? session.submitDecision({ kind: "veto-decision", use: false })
          : q.kind === "replacement" ? session.submitDecision({ kind: "replacement", replacement: q.options[0]!.id })
          : q.kind === "comp-intent" ? session.submitDecision({ kind: "comp-intent", intent: "compete" })
          : q.kind === "comp-round" ? session.submitDecision({ kind: "comp-round", intent: "compete" })
          : session.submitDecision({ kind: q.kind, vote: q.options[0]!.id } as never);
      }
      staged = adv.status.phase === "eviction" && !!session.snapshot().live!.finalNominees;
    }
    expect(staged).toBe(true);
    const live = p.live;
    const [evictee] = live.finalNominees!;
    const living = session.livingIds().filter((id) => id !== evictee && id !== live.hoh);
    const breaker = living.find((id) => id !== "player")!;
    // Everyone reads the evictee as the bigger threat so they certainly go; the evictee read the breaker as a
    // known rival (⇒ the eviction read alone would be `respected`, NOT `betrayed`).
    for (const id of session.livingIds()) if (id !== evictee) reg.engine.relationships.edge(id, evictee!).threat = 0.95;
    const e = reg.engine.relationships.edge(evictee!, breaker);
    e.trust = 0.05; e.threat = 0.9;
    recordDealBetrayal(live, evictee!, breaker); // the broken deal came FIRST
    expect(live.mannerByEvictee![evictee!]![breaker]!.betrayed).toBe(true);
    for (let i = 0; i < 200 && !live.evictionOrder.includes(evictee!); i++) {
      const adv = session.advanceGame();
      if (adv.pending) session.submitDecision({ kind: adv.pending.kind, vote: adv.pending.options[0]!.id } as never);
    }
    expect(live.evictionOrder.at(-1)).toBe(evictee);
    const manner = live.mannerByEvictee![evictee!]![breaker]!;
    expect(manner.betrayed, "the earlier deal-break flag survives the eviction read").toBe(true);
    expect(manner.respected, "…and supersedes the clean read, so it counts once").toBeUndefined();
  });
});

describe("#1965 — the `replaced` betrayal shock is gated on the replacement's pre-fold trust in the HOH", () => {
  function reliabilityDrop(trust: number): { drop: number; trustDrop: number } {
    const { session, reg } = newSession(11);
    const p = session as unknown as Priv;
    const ids = session.livingIds().filter((id) => id !== "player");
    const [hoh, replacement] = [ids[0]!, ids[1]!];
    p.live.hoh = hoh;
    p.live.replacement = replacement;
    const edge = reg.engine.relationships.edge(replacement, hoh);
    edge.trust = trust;
    const before = { rel: edge.reliability, trust: edge.trust };
    p.foldCeremonyConsequence({ beat: "veto-ceremony", participants: [] });
    const after = reg.engine.relationships.edge(replacement, hoh);
    return { drop: before.rel - after.reliability, trustDrop: before.trust - after.trust };
  }

  it("a trusting replacement is shocked as betrayed; a non-trusting one only takes the nomination conflict", () => {
    const trusting = reliabilityDrop(0.95);
    const distrusting = reliabilityDrop(0.1);
    expect(trusting.drop, "betrayal tears the evidence signal").toBeGreaterThan(0.12);
    expect(distrusting.drop, "no betrayal shock without the trust").toBeLessThan(trusting.drop / 3);
    expect(trusting.trustDrop).toBeGreaterThan(0);
  });

  it("the shock is graded: deeper pre-fold trust lands harder than trust just over the bar", () => {
    const deep = reliabilityDrop(0.99);
    const shallow = reliabilityDrop(0.55);
    expect(deep.drop).toBeGreaterThan(shallow.drop);
  });
});
