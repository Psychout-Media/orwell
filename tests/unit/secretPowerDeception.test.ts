import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";
import type { UserSandbox } from "../../src/composition/registry";
import { LEVERAGE } from "../../src/engine/leverageConstants";
import type { TradeResult, ExposeResult } from "../../src/ports/GameSession";

/**
 * Features 0093 + 0099 — DECEPTION is first-class (owner direction 2026-06-27). Any use may be truthful
 * OR a BLUFF, and BOTH NPCs and the player can lie. A bluff invents a claim, reads NOTHING from the Vault,
 * folds on BELIEF (trust × plausibility), and the engine NEVER tells the player whether it matched a
 * truth; a later contradicting genuine pathway delivers a betrayal-grade, recoverable hit to the bluffer
 * (the passive lie-catch). Roles only — no names; all fixtures generated.
 */

function startedSeason(user: string, seed: number): UserSandbox {
  const reg = new GameSessionRegistry();
  const sb = reg.sandboxFor(user);
  sb.session.createCharacter({ playerName: "The Player", seed });
  return sb;
}

function learnSecretAbout(sb: UserSandbox, subject: EntityId): string {
  sb.engine.knowledge.seedBelief(subject, { content: `the truth about ${subject}`, originalContent: "x", factId: `seed:${subject}`, confidence: 0.9, hops: 0, distortion: 0, source: subject }, "origin");
  sb.engine.knowledge.surfaceInformationTo(PLAYER, { content: `the truth about ${subject}`, subject, confidence: 0.85 }, `told-by:${subject}`);
  const fact = sb.engine.knowledge.knownTo(PLAYER).find((f) => f.subject === subject)!;
  return fact.factId ?? fact.id;
}

const edge = (sb: UserSandbox, a: EntityId, b: EntityId) => sb.engine.relationships.edge(a, b);

describe("deception — the player can BLUFF (a fabricated claim), folded on belief, never Vault-read", () => {
  it("a believed bluff trade is taken; the engine never confirms whether it matched a real truth", () => {
    const sb = startedSeason("dc-bluff-believed", 1);
    const npcs = sb.session.livingIds().filter((id) => id !== PLAYER);
    const subject = npcs[0]!;
    const recipient = npcs[1]!;
    // Recipient trusts the player AND fears the subject ⇒ they believe + value the (fabricated) claim.
    const rp = edge(sb, recipient, PLAYER); rp.trust = 0.9; rp.affinity = 0.8; rp.threat = 0.05;
    const rs = edge(sb, recipient, subject); rs.threat = 0.9; rs.affinity = 0.05;
    const res = sb.session.tradeSecret({ bluff: true, subject, toNpcId: recipient, askKind: "vote" }) as TradeResult;
    expect(res.accepted).toBe(true);
    // The bluffer wielded NO real fact — nothing in their knowledge was spent (a bluff is not a learned secret).
    expect(JSON.stringify(res)).not.toMatch(/truthful|matched|wasReal|0\.\d/);
  });

  it("a disbelieved bluff bounces (no concession) — a distrustful recipient doesn't buy it", () => {
    const sb = startedSeason("dc-bluff-bounce", 2);
    const npcs = sb.session.livingIds().filter((id) => id !== PLAYER);
    const subject = npcs[0]!;
    const recipient = npcs[1]!;
    // Recipient distrusts the player and doesn't care about the subject ⇒ the fabricated claim bounces.
    const rp = edge(sb, recipient, PLAYER); rp.trust = 0.0; rp.affinity = 0.0; rp.threat = 0.9;
    const rs = edge(sb, recipient, subject); rs.threat = 0.05; rs.affinity = 0.9;
    const res = sb.session.tradeSecret({ bluff: true, subject, toNpcId: recipient, askKind: "vote" }) as TradeResult;
    expect(res.accepted).toBe(false);
  });

  it("a bluff is capped per season: the (cap+1)th bluff is REFUSED and spends nothing (the player's bluffs are rare - owner build-tuning)", () => {
    const sb = startedSeason("dc-bluff-cap", 3);
    const npcs = sb.session.livingIds().filter((id) => id !== PLAYER);
    // Make every recipient believe, so every bluff is a spend that the cap (not a disbelieving recipient) must stop.
    for (const id of npcs) { const e = edge(sb, id, PLAYER); e.trust = 0.95; e.affinity = 0.9; e.threat = 0.02; }
    const subject = npcs[0]!;
    const cap = LEVERAGE.maxPlayerBluffsPerSeason;
    const results: TradeResult[] = [];
    for (let i = 0; i < cap + 2; i++) {
      const recipient = npcs[2 + i]!;
      const rs = edge(sb, recipient, subject); rs.threat = 0.9; rs.affinity = 0.05;
      results.push(sb.session.tradeSecret({ bluff: true, subject, toNpcId: recipient }) as TradeResult);
    }
    // The first `cap` bluffs were attempted (not refused for the cap); every one past the cap is refused as capped.
    for (let i = 0; i < cap; i++) expect(results[i]!.refused, `bluff ${i + 1} is within the cap`).not.toBe("capped");
    for (let i = cap; i < results.length; i++) {
      expect(results[i]!.accepted, `bluff ${i + 1} is over the cap`).toBe(false);
      expect(results[i]!.refused, `bluff ${i + 1} is over the cap`).toBe("capped");
    }
    expect(sb.session.snapshot().secretPlayerBluffCount, "the counter stops AT the cap").toBe(cap);
  });

  it("a public bluff (exposeSecret) over the cap is refused too, and a refused bluff spends nothing", () => {
    const sb = startedSeason("dc-bluff-cap-expose", 3);
    const npcs = sb.session.livingIds().filter((id) => id !== PLAYER);
    for (const id of npcs) { const e = edge(sb, id, PLAYER); e.trust = 0.95; e.affinity = 0.9; e.threat = 0.02; }
    const cap = LEVERAGE.maxPlayerBluffsPerSeason;
    // exposeSecret is itself capped per season (LEVERAGE.maxExposesPerSeason), so exhaust the BLUFF cap through the trade route first.
    const subject = npcs[0]!;
    for (let i = 0; i < cap; i++) {
      const recipient = npcs[2 + i]!;
      const rs = edge(sb, recipient, subject); rs.threat = 0.9; rs.affinity = 0.05;
      sb.session.tradeSecret({ bluff: true, subject, toNpcId: recipient });
    }
    expect(sb.session.snapshot().secretPlayerBluffCount).toBe(cap);
    const res = sb.session.exposeSecret({ bluff: true, subject }) as { exposed: boolean; refused?: string } | null;
    expect(res?.exposed, "a bluff expose over the cap does not land").toBe(false);
    expect(res?.refused).toBe("capped");
    expect(sb.session.snapshot().secretPlayerBluffCount, "a refused bluff does not spend the counter").toBe(cap);
  });
});

describe("deception — the PASSIVE LIE-CATCH: a later contradicting truth punishes the bluffer", () => {
  it("a believed bluff, then the REAL truth reaching the same houseguest, deals the bluffer a betrayal-grade hit", () => {
    const sb = startedSeason("dc-catch", 4);
    const npcs = sb.session.livingIds().filter((id) => id !== PLAYER);
    const subject = npcs[0]!; // the player lies ABOUT this houseguest
    const recipient = npcs[1]!; // ...to this one
    // 1) The recipient believes a bluff about the subject (trusts the player, fears the subject).
    const rp = edge(sb, recipient, PLAYER); rp.trust = 0.9; rp.affinity = 0.8; rp.threat = 0.05;
    const rs = edge(sb, recipient, subject); rs.threat = 0.9; rs.affinity = 0.05;
    const bluff = sb.session.tradeSecret({ bluff: true, subject, toNpcId: recipient }) as TradeResult;
    expect(bluff.accepted).toBe(true);
    expect(sb.session.snapshot().secretPlayerBluffBelief?.[recipient]).toContain(subject);

    // 2) Later the player learns the REAL secret about the subject and TRADES the truth to the same recipient.
    const real = learnSecretAbout(sb, subject);
    const before = { ...edge(sb, recipient, PLAYER) };
    // Keep the recipient willing so the real trade lands (so the catch fires on delivery).
    const rp2 = edge(sb, recipient, PLAYER); rp2.trust = 0.9; rp2.affinity = 0.8; rp2.threat = 0.05;
    const truth = sb.session.tradeSecret({ factId: real, toNpcId: recipient }) as TradeResult;
    expect(truth.accepted).toBe(true);
    const after = edge(sb, recipient, PLAYER);
    // The recipient realizes the player lied to them — a betrayal-grade trust blow (recoverable, never a number).
    expect(after.trust).toBeLessThan(before.trust - 0.15);
    expect(after.threat).toBeGreaterThan(before.threat);
    // The caught bluff is cleared (it can't re-fire).
    expect(sb.session.snapshot().secretPlayerBluffBelief?.[recipient] ?? []).not.toContain(subject);
  });

  it("a real EXPOSE catches an earlier bluff the player told the house about the same subject", () => {
    const sb = startedSeason("dc-catch-expose", 5);
    const npcs = sb.session.livingIds().filter((id) => id !== PLAYER);
    const subject = npcs[0]!;
    // Make the house believe a public bluff about the subject (high trust in player + fear of subject).
    for (const id of npcs) {
      if (id === subject) continue;
      const e = edge(sb, id, PLAYER); e.trust = 0.9; e.affinity = 0.8; e.threat = 0.05;
      const es = edge(sb, id, subject); es.threat = 0.9; es.affinity = 0.05;
    }
    const bluff = sb.session.exposeSecret({ bluff: true, subject }) as ExposeResult;
    expect(bluff.exposed).toBe(true);
    const witness = npcs.find((id) => id !== subject)!;
    expect(sb.session.snapshot().secretPlayerBluffBelief?.[witness]).toContain(subject);

    // Now the player exposes the REAL secret about the subject — delivering the contradicting truth.
    const real = learnSecretAbout(sb, subject);
    const before = { ...edge(sb, witness, PLAYER) };
    sb.session.exposeSecret({ factId: real });
    const after = edge(sb, witness, PLAYER);
    expect(after.trust).toBeLessThan(before.trust); // the witness caught the earlier lie
  });
});
