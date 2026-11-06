import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import type { UserSandbox } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";
import type { ExposeResult, TradeResult } from "../../src/ports/GameSession";
import { FEATURE_FLAGS } from "../../src/featureFlags";
import { decideConfidence, type ConfidenceSignals } from "../../src/engine/confidence";
import { CONFIDENCE } from "../../src/engine/confidenceConstants";
import { LEVERAGE, SECRET_TRADE } from "../../src/engine/leverageConstants";
import { NO_HARD_CAPS } from "../../src/engine/noHardCapsConstants";
import { repetitionFactor, repetitionImpact, lieProbScale, recipientSting } from "../../src/engine/repetitionCost";

/**
 * B49 (PO ruling card 24; ORWELL_NO_HARD_CAPS, flag-off, never-flipped) - NO ARBITRARY HARD COUNTS. The NPC confide-lie cap (2), the expose cap (3) and the trade cap (5) stop being design rules:
 * ON, the only count left is a HIGH safety valve, and every further use by the same actor in the season COSTS more (a bounded, escalating, recipient-scaled hit on the relationship read; an NPC's
 * lie roll shrinks per lie it already told, floored). Flag OFF: byte-identical (whole snapshot). Roles only.
 */
type G = { setNoHardCapsEnabled(on: boolean): void; lieCount: number; confideLiesBy?: Record<string, number> };
const gOf = (sb: UserSandbox): G => sb.session as unknown as G;
function season(user: string, seed: number, enabled = true): UserSandbox {
  const sb = new GameSessionRegistry().sandboxFor(user);
  sb.session.createCharacter({ playerName: "The Player", seed });
  if (enabled) gOf(sb).setNoHardCapsEnabled(true);
  return sb;
}
const npcsOf = (sb: UserSandbox): EntityId[] => sb.session.livingIds().filter((id) => id !== PLAYER);
const edge = (sb: UserSandbox, a: EntityId, b: EntityId) => sb.engine.relationships.edge(a, b);
function learnSecretAbout(sb: UserSandbox, subject: EntityId): string {
  sb.engine.knowledge.seedBelief(subject, { content: `a learned secret about ${subject}`, originalContent: "x", factId: `seed:${subject}`, confidence: 0.9, hops: 0, distortion: 0, source: subject }, "origin");
  sb.engine.knowledge.surfaceInformationTo(PLAYER, { content: `a learned secret about ${subject}`, subject, confidence: 0.85 }, `told-by:${subject}`);
  const fact = sb.engine.knowledge.knownTo(PLAYER).find((f) => f.subject === subject)!;
  return fact.factId ?? fact.id;
}

describe("B49 - the flag", () => {
  it("is registered strict (on only when exactly '1') and the adapter default is OFF", () => {
    expect(FEATURE_FLAGS.find((f) => f.envKey === "ORWELL_NO_HARD_CAPS")?.parser).toBe("strict");
    expect(process.env.ORWELL_NO_HARD_CAPS).not.toBe("1");
  });
  it("the safety valve is a technical number, far above every old design cap", () => {
    expect(NO_HARD_CAPS.safetyValve).toBeGreaterThanOrEqual(4 * Math.max(CONFIDENCE.maxLiesPerSeason, LEVERAGE.maxExposesPerSeason, SECRET_TRADE.maxTradesPerSeason));
  });
});

describe("B49 - the pure repetition cost: escalating, bounded, recipient-scaled", () => {
  it("the first use costs nothing extra, each further use costs strictly more, and it saturates", () => {
    expect(repetitionFactor(0)).toBe(0);
    let prev = 0;
    for (let n = 1; n <= 4; n++) { const f = repetitionFactor(n); expect(f).toBeGreaterThan(prev); prev = f; }
    expect(repetitionFactor(1000)).toBe(NO_HARD_CAPS.repetitionMax);
    expect(repetitionFactor(Number.NaN)).toBe(0);
  });
  it("the impact is empty on the first use, scales with repetition, and stings a trusting recipient more than a cold one", () => {
    const base = { affinity: -0.06, threat: 0.08 };
    expect(repetitionImpact(base, 0, 0.9)).toEqual({});
    expect(Math.abs(repetitionImpact(base, 3, 0.5).affinity!)).toBeGreaterThan(Math.abs(repetitionImpact(base, 1, 0.5).affinity!));
    expect(Math.abs(repetitionImpact(base, 2, 0.9).affinity!)).toBeGreaterThan(Math.abs(repetitionImpact(base, 2, 0.1).affinity!));
    expect(recipientSting(2)).toBe(recipientSting(1)); // clamped
    expect(recipientSting(-1)).toBe(NO_HARD_CAPS.recipientStingFloor);
  });
  it("an NPC's lie roll shrinks per lie it already told, but never below the floor", () => {
    expect(lieProbScale(0)).toBe(1);
    expect(lieProbScale(1)).toBeLessThan(1);
    expect(lieProbScale(2)).toBeLessThan(lieProbScale(1));
    expect(lieProbScale(500)).toBe(NO_HARD_CAPS.lieRepeatFloor);
  });
});

describe("B49 - decideConfidence: personality sets the lie rate; the roll shrinks per repeat; no hard count", () => {
  const schemer: ConfidenceSignals = { npcTrust: 0, npcAffinity: 0.1, npcThreat: 0.95, playerTrust: 0, playerAffinity: 0, goodwill: 0, archetype: "mastermind" };
  const fixed = (v: number) => ({ next: () => v }) as never;
  it("a schemer lies when the roll is under the base chance, and the SAME roll no longer lies once the scale has shrunk", () => {
    expect(decideConfidence(schemer, fixed(0.5), { liesRemaining: 1 }).truthful).toBe(false);
    expect(decideConfidence(schemer, fixed(0.5), { liesRemaining: 1, lieProbScale: lieProbScale(2) }).truthful).toBe(true);
  });
  it("an honest archetype never lies however many lies remain; a scale of 1 / absent is the old roll", () => {
    expect(decideConfidence({ ...schemer, archetype: "floater" }, fixed(0), { liesRemaining: 1000 }).truthful).toBe(true);
    expect(decideConfidence(schemer, fixed(0.5), { liesRemaining: 1, lieProbScale: 1 })).toEqual(decideConfidence(schemer, fixed(0.5), { liesRemaining: 1 }));
  });
  it("no lies remaining still means no lie (the safety valve is the only count)", () => {
    expect(decideConfidence(schemer, fixed(0), { liesRemaining: 0 }).truthful).toBe(true);
  });
});

/** Press every NPC with a sealed secret as a cold schemer in a scene with the player; return the lies told. */
function pressAll(sb: UserSandbox): { lies: number; byNpc: Record<string, number> } {
  const s = sb.session as unknown as { confide(id: string): { disclosed: boolean; truthful: boolean } | null; house: { npcs: Array<{ id: string; character: { archetype: string; hiddenElements?: unknown[] } }> }; presence?: Map<string, string> };
  const byNpc: Record<string, number> = {};
  let lies = 0;
  for (const npc of s.house.npcs) {
    if (!(npc.character.hiddenElements ?? []).length) continue;
    npc.character.archetype = "mastermind";
    s.presence?.set(PLAYER, "kitchen"); s.presence?.set(npc.id, "kitchen");
    for (const [a, b] of [[npc.id, PLAYER], [PLAYER, npc.id]] as const) { const e = edge(sb, a, b); e.trust = 0; e.affinity = 0.1; e.threat = 0.95; }
    const r = s.confide(npc.id);
    if (r && r.disclosed && !r.truthful) { lies++; byNpc[npc.id] = (byNpc[npc.id] ?? 0) + 1; }
  }
  return { lies, byNpc };
}

describe("B49 - NPC confide lies: the cap of 2 is gone", () => {
  it("flag OFF the season holds at the old cap; flag ON more schemers lie (a manipulator lies often), counted per NPC", () => {
    const seeds = [1, 2, 3, 4, 5, 6];
    const off = seeds.map((seed) => pressAll(season(`b49-lie-off-${seed}`, seed, false)).lies);
    expect(Math.max(...off)).toBeLessThanOrEqual(CONFIDENCE.maxLiesPerSeason);
    const onSbs = seeds.map((seed) => season(`b49-lie-on-${seed}`, seed, true));
    const on = onSbs.map((sb) => pressAll(sb));
    expect(Math.max(...on.map((o) => o.lies)), "at least one season breaks the old cap").toBeGreaterThan(CONFIDENCE.maxLiesPerSeason);
    const i = on.findIndex((o) => o.lies > CONFIDENCE.maxLiesPerSeason);
    const ledger = gOf(onSbs[i]!).confideLiesBy ?? {};
    expect(Object.values(ledger).reduce((a, b) => a + b, 0), "the per-NPC ledger matches the lies told").toBe(on[i]!.lies);
    expect(gOf(onSbs[i]!).lieCount).toBe(on[i]!.lies);
  });
  it("the per-NPC ledger survives snapshot/restore (non-degradation)", () => {
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const sb = season(`b49-lie-persist-${seed}`, seed, true);
      if (pressAll(sb).lies === 0) continue;
      const snap = sb.session.snapshot();
      expect((snap as unknown as { confideLiesBy?: Record<string, number> }).confideLiesBy).toEqual(gOf(sb).confideLiesBy);
      const revived = new GameSessionRegistry().sandboxFor(`b49-lie-revived-${seed}`);
      revived.session.createCharacter({ playerName: "The Player", seed });
      (revived.session as unknown as { restore(c: unknown): void }).restore(snap);
      expect(gOf(revived).confideLiesBy).toEqual(gOf(sb).confideLiesBy);
      return;
    }
    throw new Error("no seed produced a lie to persist");
  });
});

describe("B49 - a habitual NPC liar lies less often (seeded, same NPC, many beats)", () => {
  it("the same schemer, same situation: with several lies already told its lie rate is lower than a fresh schemer's, but still real", () => {
    const rate = (prior: number): number => {
      const sb = season(`b49-habit-${prior}`, 3, true);
      const s = sb.session as unknown as { confide(id: string): { disclosed: boolean; truthful: boolean } | null; house: { npcs: Array<{ id: string; character: { archetype: string; hiddenElements?: unknown[] } }> }; presence?: Map<string, string>; week: number; confideState: Record<string, unknown>; lieCount: number; confideLiesBy: Record<string, number> };
      const npc = s.house.npcs.find((n) => (n.character.hiddenElements ?? []).length)!;
      npc.character.archetype = "mastermind";
      s.presence?.set(PLAYER, "kitchen"); s.presence?.set(npc.id, "kitchen");
      for (const [a, b] of [[npc.id, PLAYER], [PLAYER, npc.id]] as const) { const e = edge(sb, a, b); e.trust = 0; e.affinity = 0.1; e.threat = 0.95; }
      let lies = 0;
      for (let w = 1; w <= 60; w++) {
        s.week = w; s.confideState = {}; s.lieCount = 0; s.confideLiesBy = prior ? { [npc.id]: prior } : {};
        const r = s.confide(npc.id);
        if (r?.disclosed && !r.truthful) lies++;
      }
      return lies;
    };
    const fresh = rate(0); const habitual = rate(10);
    expect(habitual, "still lies sometimes (personality, not a count)").toBeGreaterThan(0);
    expect(habitual).toBeLessThan(fresh);
  });
});

describe("B49 - expose: past the old cap of 3, each further outing costs more", () => {
  /** Expose one fresh secret per subject with the bystander's read of the player reset first; return the bystander's affinity/threat deltas per expose and the refusals. */
  function run(user: string, enabled: boolean, count: number): { dAff: number[]; dThr: number[]; refused: Array<string | undefined> } {
    const sb = season(user, 10, enabled);
    const ids = npcsOf(sb);
    const bystander = ids[ids.length - 1]!;
    const dAff: number[] = []; const dThr: number[] = []; const refused: Array<string | undefined> = [];
    for (let i = 0; i < count; i++) {
      const e = edge(sb, bystander, PLAYER); e.trust = 0.6; e.affinity = 0.5; e.threat = 0.3;
      const f = learnSecretAbout(sb, ids[i]!);
      const r = sb.session.exposeSecret({ factId: f }) as ExposeResult;
      refused.push(r.refused);
      const after = edge(sb, bystander, PLAYER);
      dAff.push(after.affinity - 0.5); dThr.push(after.threat - 0.3);
    }
    return { dAff, dThr, refused };
  }
  it("flag OFF the 4th expose is refused 'capped' (the old behaviour); flag ON a 4th, 5th and 6th land", () => {
    expect(run("b49-x-off", false, 4).refused[3]).toBe("capped");
    const on = run("b49-x-on", true, 6);
    expect(on.refused).toEqual([undefined, undefined, undefined, undefined, undefined, undefined]);
  });
  it("the first expose is identical flag on or off; every later one costs the house's read of the exposer strictly more, and the extra grows with each repeat", () => {
    const off = run("b49-x-cmp", false, 3);
    const on = run("b49-x-cmp", true, 3);
    expect(on.dAff[0]).toBe(off.dAff[0]);
    expect(on.dThr[0]).toBe(off.dThr[0]);
    const extra = [0, 1, 2].map((k) => off.dAff[k]! - on.dAff[k]!); // extra affinity lost vs the flag-off run
    expect(extra[0]).toBeCloseTo(0, 12);
    expect(extra[1]).toBeGreaterThan(0);
    expect(extra[2]).toBeGreaterThan(extra[1]!);
    expect(on.dThr[1]).toBeGreaterThan(off.dThr[1]!);
    expect(on.dThr[2]).toBeGreaterThan(on.dThr[1]! - 1e-9 + (off.dThr[2]! - off.dThr[1]!));
  });
  it("the safety valve holds: after the valve's worth of exposes the next is refused 'capped'", () => {
    const sb = season("b49-x-valve", 10, true);
    (sb.session as unknown as { exposeCount: number }).exposeCount = NO_HARD_CAPS.safetyValve;
    const subject = npcsOf(sb)[0]!;
    expect((sb.session.exposeSecret({ factId: learnSecretAbout(sb, subject) }) as ExposeResult).refused).toBe("capped");
  });
  it("a spent secret is still spent (the natural limit is unchanged)", () => {
    const sb = season("b49-x-spent", 10, true);
    const f = learnSecretAbout(sb, npcsOf(sb)[0]!);
    expect((sb.session.exposeSecret({ factId: f }) as ExposeResult).exposed).toBe(true);
    expect((sb.session.exposeSecret({ factId: f }) as ExposeResult).refused).toBe("already-spent");
  });
});

describe("B49 - trade: past the old cap of 5, each further trade costs the recipient's read of the player more", () => {
  function run(user: string, enabled: boolean, count: number): { dTrust: number[]; refused: Array<string | undefined>; accepted: boolean[] } {
    const sb = season(user, 10, enabled);
    const ids = npcsOf(sb);
    const recipient = ids[0]!;
    const dTrust: number[] = []; const refused: Array<string | undefined> = []; const accepted: boolean[] = [];
    for (let i = 0; i < count; i++) {
      const subject = ids[i + 1]!;
      const e = edge(sb, recipient, PLAYER); e.trust = 0.9; e.affinity = 0.9; e.threat = 0;
      const es = edge(sb, recipient, subject); es.threat = 0.95; es.affinity = 0.05; es.trust = 0.05;
      const f = learnSecretAbout(sb, subject);
      const r = sb.session.tradeSecret({ factId: f, toNpcId: recipient }) as TradeResult;
      refused.push(r.refused); accepted.push(r.accepted);
      dTrust.push(edge(sb, recipient, PLAYER).trust - 0.9);
    }
    return { dTrust, refused, accepted };
  }
  it("flag OFF the 6th trade is refused 'capped'; flag ON it is not", () => {
    expect(run("b49-t-off", false, 6).refused[5]).toBe("capped");
    expect(run("b49-t-on", true, 7).refused.filter((r) => r === "capped")).toEqual([]);
  });
  it("an accepted repeat trade costs the recipient's trust strictly more than the same trade flag-off, growing with each repeat; the first is identical", () => {
    const off = run("b49-t-cmp", false, 4);
    const on = run("b49-t-cmp", true, 4);
    const ks = [0, 1, 2, 3].filter((k) => off.accepted[k] && on.accepted[k]);
    expect(ks.length, "enough accepted trades to compare").toBeGreaterThanOrEqual(2);
    expect(on.dTrust[ks[0]!]).toBe(off.dTrust[ks[0]!]);
    let prev = 0;
    for (const k of ks.slice(1)) {
      const extra = off.dTrust[k]! - on.dTrust[k]!;
      expect(extra, `trade #${k + 1}`).toBeGreaterThan(prev);
      prev = extra;
    }
  });
  it("a secret already known to the recipient is still refused 'already-spent' (the natural limit is unchanged)", () => {
    const sb = season("b49-t-spent", 10, true);
    const ids = npcsOf(sb);
    const e = edge(sb, ids[0]!, PLAYER); e.trust = 0.9; e.affinity = 0.9; e.threat = 0;
    const es = edge(sb, ids[0]!, ids[1]!); es.threat = 0.95;
    const f = learnSecretAbout(sb, ids[1]!);
    const first = sb.session.tradeSecret({ factId: f, toNpcId: ids[0]! }) as TradeResult;
    expect(first.accepted).toBe(true);
    expect((sb.session.tradeSecret({ factId: f, toNpcId: ids[0]! }) as TradeResult).refused).toBe("already-spent");
  });
});

describe("B49 - flag off is byte-identical (whole snapshot)", () => {
  const script = (sb: UserSandbox): void => {
    const ids = npcsOf(sb);
    for (let i = 0; i < 4; i++) sb.session.exposeSecret({ factId: learnSecretAbout(sb, ids[i]!) });
    for (let i = 5; i < 11; i++) sb.session.tradeSecret({ factId: learnSecretAbout(sb, ids[i]!), toNpcId: ids[4]! });
    pressAll(sb);
  };
  it("flag unset == flag explicitly off; no per-NPC lie ledger appears", () => {
    const a = season("b49-bi", 5, false); script(a);
    const b = season("b49-bi", 5, false); gOf(b).setNoHardCapsEnabled(false); script(b);
    expect(JSON.stringify(a.session.snapshot())).toBe(JSON.stringify(b.session.snapshot()));
    expect(JSON.stringify(a.session.snapshot())).not.toContain("confideLiesBy");
  });
  it("flag on diverges from flag off once the old caps are passed (the flag is live)", () => {
    const a = season("b49-bi2", 5, false); script(a);
    const b = season("b49-bi2", 5, true); script(b);
    expect(JSON.stringify(a.session.snapshot())).not.toBe(JSON.stringify(b.session.snapshot()));
  });
});

describe("B49 - Vault sentinel", () => {
  it("nothing about the repetition cost, the valve or the per-NPC lie ledger reaches an outward projection", () => {
    const sb = season("b49-vault", 10, true);
    const sentinel = "SENTINEL-NOCAPS-4242";
    const ids = npcsOf(sb);
    sb.engine.vault.writeHidden({ id: "nc:hidden", kind: "hidden-attribute", subject: ids[0]!, content: `[hidden-attribute] ${sentinel}` });
    sb.engine.vault.writeHidden({ id: "nc:thread", kind: "hidden-thread", content: `[hidden-thread] ${sentinel}` });
    const results: unknown[] = [];
    for (let i = 0; i < 5; i++) results.push(sb.session.exposeSecret({ factId: learnSecretAbout(sb, ids[i + 1]!) }));
    pressAll(sb);
    const outward = JSON.stringify([results, sb.session.getMomentPrompt({}), ...ids.map((id) => sb.session.npcVoice(id)), sb.session.getGameState()]);
    expect(outward).not.toContain(sentinel);
    for (const w of ["confideLiesBy", "repetition", "safetyValve", "noHardCaps", "lieRepeat"]) expect(outward, w).not.toContain(w);
    expect(JSON.stringify(results)).not.toMatch(/\d\.\d/); // no raw magnitude crosses
  });
});
