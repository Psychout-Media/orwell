import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import type { UserSandbox } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";
import { recordRumorClaim } from "../../src/engine/beliefStore";
import type { BeliefClaim, BeliefStore } from "../../src/engine/beliefStore";
import type { AccuseTieResult, ExposeResult, TradeResult } from "../../src/ports/GameSession";
import { TIE_REVEAL } from "../../src/engine/tieRevealConstants";
import { FEATURE_FLAGS } from "../../src/featureFlags";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";

/**
 * B23 (#2017 section 14.5(3), M2b; ORWELL_LIES_CAUGHT, flag-off) - the LIES-CAUGHT writer. When a lie is exposed the houseguest it was told to holds a `lied-to-me` belief claim (engine-only), at
 * the confidence of the EVIDENCE that exposed it; a bluff the houseguest BELIEVED is stored as a belief too (a low-confidence `heard-rumor`, nature "bluff") and is marked refuted once caught.
 * Live paths: the passive lie-catch (a real expose / real trade delivering a truth that contradicts an earlier believed bluff) and a landed `accuseTie`. A misfire writes nothing (a missed or capped
 * accusation, a bounced bluff, a refused trade, a truth with no earlier bluff, a `confront`). Flag off: byte-identical. Roles only.
 */
const on = (sb: UserSandbox): void => sb.session.setLiesCaughtEnabled(true);
function season(user: string, seed: number, enabled = true): UserSandbox {
  const sb = new GameSessionRegistry().sandboxFor(user);
  sb.session.createCharacter({ playerName: "The Player", seed });
  if (enabled) on(sb); else sb.session.setLiesCaughtEnabled(false); // default ON since 2026-11-05: the OFF arm pins it explicitly
  return sb;
}
const edge = (sb: UserSandbox, a: EntityId, b: EntityId) => sb.engine.relationships.edge(a, b);
const npcsOf = (sb: UserSandbox): EntityId[] => sb.session.livingIds().filter((id) => id !== PLAYER);
const store = (sb: UserSandbox): BeliefStore => ((sb.session.snapshot().live ?? {}) as unknown as { beliefs?: BeliefStore }).beliefs ?? {};
const all = (sb: UserSandbox): BeliefClaim[] => Object.values(store(sb)).flat();
const lies = (sb: UserSandbox): BeliefClaim[] => all(sb).filter((c) => c.kind === "lied-to-me");
const bluffBeliefs = (sb: UserSandbox): BeliefClaim[] => all(sb).filter((c) => c.kind === "heard-rumor" && c.nature === "bluff");

function learnSecretAbout(sb: UserSandbox, subject: EntityId): string {
  sb.engine.knowledge.seedBelief(subject, { content: `the truth about ${subject}`, originalContent: "x", factId: `seed:${subject}`, confidence: 0.9, hops: 0, distortion: 0, source: subject }, "origin");
  sb.engine.knowledge.surfaceInformationTo(PLAYER, { content: `the truth about ${subject}`, subject, confidence: 0.85 }, `told-by:${subject}`);
  const fact = sb.engine.knowledge.knownTo(PLAYER).find((f) => f.subject === subject)!;
  return fact.factId ?? fact.id;
}
/** The house trusts the player and fears the subject: a bluff about the subject is believed. */
function primeHouse(sb: UserSandbox, subject: EntityId): void {
  for (const id of npcsOf(sb)) {
    if (id === subject) continue;
    const e = edge(sb, id, PLAYER); e.trust = 0.9; e.affinity = 0.8; e.threat = 0.05;
    const es = edge(sb, id, subject); es.threat = 0.9; es.affinity = 0.05;
  }
}
const realTies = (sb: UserSandbox) => (sb.session as unknown as { seededRels: { ties: Array<{ a: EntityId; b: EntityId }> } }).seededRels.ties;

describe("lies-caught: the passive lie-catch writes a lied-to-me belief at the evidence's confidence", () => {
  it("a believed bluff EXPOSE is stored as a bluff belief for each houseguest who believed it (low confidence, source = the player)", () => {
    const sb = season("lc-bluff-expose", 5);
    const subject = npcsOf(sb)[0]!;
    primeHouse(sb, subject);
    expect((sb.session.exposeSecret({ bluff: true, subject }) as ExposeResult).exposed).toBe(true);
    const held = bluffBeliefs(sb);
    const holders = new Set(held.map((c) => c.holder));
    expect(holders, "every other houseguest believed it; the subject did not").toEqual(new Set(npcsOf(sb).filter((id) => id !== subject)));
    for (const c of held) {
      expect(c.subject).toBe(subject);
      expect(c.source).toBe(PLAYER);
      expect(c.confidence).toBeCloseTo(0.6, 9);
      expect(c.refuted).toBeFalsy();
    }
    expect(lies(sb), "believing a bluff is not yet catching a lie").toEqual([]);
  });

  it("a bluff belief never overwrites a gossip rumor the houseguest already holds about the same subject (distinct claim ids)", () => {
    const sb = season("lc-bluff-ids", 5);
    const [subject, witness] = npcsOf(sb) as [EntityId, EntityId];
    primeHouse(sb, subject);
    const live = sb.session.snapshot().live as unknown as { beliefs?: BeliefStore; week: number };
    const st = ((sb.session as unknown as { live: { beliefs?: BeliefStore } }).live.beliefs ??= {});
    recordRumorClaim(st, { listener: witness, subject, type: "betrayal", confidence: 0.95, delta: {} }, live.week);
    sb.session.exposeSecret({ bluff: true, subject });
    const mine = all(sb).filter((c) => c.holder === witness && c.subject === subject && c.kind === "heard-rumor");
    expect(mine.map((c) => c.nature).sort()).toEqual(["betrayal", "bluff"]);
  });

  it("a real EXPOSE after the bluff: each houseguest who believed it now holds lied-to-me about the player at the expose's evidence confidence (0.85), and the bluff belief is refuted", () => {
    const sb = season("lc-catch-expose", 5);
    const subject = npcsOf(sb)[0]!;
    primeHouse(sb, subject);
    sb.session.exposeSecret({ bluff: true, subject });
    const real = learnSecretAbout(sb, subject);
    expect((sb.session.exposeSecret({ factId: real }) as ExposeResult).exposed).toBe(true);
    const caught = lies(sb);
    const witnesses = npcsOf(sb).filter((id) => id !== subject);
    expect(new Set(caught.map((c) => c.holder))).toEqual(new Set(witnesses));
    for (const c of caught) {
      expect(c.subject).toBe(PLAYER);
      expect(c.value).toBe(true);
      expect(c.confidence).toBeCloseTo(0.85, 9);
      expect(c.origin).toBe("witnessed");
    }
    expect(bluffBeliefs(sb).length).toBe(witnesses.length);
    expect(bluffBeliefs(sb).every((c) => c.refuted === true), "a caught bluff is no longer believed").toBe(true);
  });

  it("a real TRADE after a believed bluff trade: the recipient holds lied-to-me about the player at the trade's evidence confidence (0.8), told; the bluff belief is refuted", () => {
    const sb = season("lc-catch-trade", 4);
    const [subject, recipient] = npcsOf(sb) as [EntityId, EntityId];
    const rp = edge(sb, recipient, PLAYER); rp.trust = 0.9; rp.affinity = 0.8; rp.threat = 0.05;
    const rs = edge(sb, recipient, subject); rs.threat = 0.9; rs.affinity = 0.05;
    expect((sb.session.tradeSecret({ bluff: true, subject, toNpcId: recipient }) as TradeResult).accepted).toBe(true);
    expect(bluffBeliefs(sb).map((c) => c.holder)).toEqual([recipient]);
    expect(lies(sb)).toEqual([]);
    const real = learnSecretAbout(sb, subject);
    const rp2 = edge(sb, recipient, PLAYER); rp2.trust = 0.9; rp2.affinity = 0.8; rp2.threat = 0.05;
    expect((sb.session.tradeSecret({ factId: real, toNpcId: recipient }) as TradeResult).accepted).toBe(true);
    const [c, ...rest] = lies(sb);
    expect(rest).toEqual([]);
    expect(c).toMatchObject({ holder: recipient, subject: PLAYER, kind: "lied-to-me", value: true, origin: "told" });
    expect(c!.confidence).toBeCloseTo(0.8, 9);
    expect(bluffBeliefs(sb)[0]!.refuted).toBe(true);
  });
});

describe("lies-caught: a landed accuseTie writes lied-to-me about both of the pair for the houseguests who saw it", () => {
  it("each witnessing houseguest (never the pair, never the player) holds lied-to-me about each member, at the direct-witness confidence", () => {
    const sb = season("lc-tie", 5);
    const t = realTies(sb)[0]!;
    const r = sb.session.accuseTie(t.a, t.b) as AccuseTieResult;
    expect(r.landed, "precondition: the sealed tie landed").toBe(true);
    const caught = lies(sb);
    expect(caught.length).toBeGreaterThan(0);
    const holders = new Set(caught.map((c) => c.holder));
    expect(holders.has(t.a) || holders.has(t.b) || holders.has(PLAYER)).toBe(false);
    for (const h of holders) {
      expect(new Set(caught.filter((c) => c.holder === h).map((c) => c.subject))).toEqual(new Set([t.a, t.b]));
    }
    for (const c of caught) {
      expect(c.confidence).toBeCloseTo(TIE_REVEAL.directWitnessConfidence, 9);
      expect(c.origin).toBe("witnessed");
      expect(c.value).toBe(true);
    }
  });
});

describe("lies-caught: a misfire writes nothing", () => {
  it("a MISSED accusation (no sealed tie) writes no claim", () => {
    const sb = season("lc-miss", 5);
    const ids = npcsOf(sb);
    const isTie = (a: EntityId, b: EntityId) => realTies(sb).some((t) => (t.a === a && t.b === b) || (t.a === b && t.b === a));
    let miss: [EntityId, EntityId] | undefined;
    for (const a of ids) for (const b of ids) if (!miss && a < b && !isTie(a, b)) miss = [a, b];
    const before = JSON.stringify(store(sb));
    expect((sb.session.accuseTie(miss![0], miss![1]) as AccuseTieResult).landed).toBe(false);
    expect(JSON.stringify(store(sb))).toBe(before);
    expect(lies(sb)).toEqual([]);
  });

  it("a CAPPED accusation of a real tie (the season's exposure quota is spent) writes no claim", () => {
    const sb = season("lc-capped", 5);
    (sb.session as unknown as { tieExposureCount: number }).tieExposureCount = TIE_REVEAL.maxExposuresPerSeason;
    const t = realTies(sb)[0]!;
    const before = JSON.stringify(store(sb));
    expect((sb.session.accuseTie(t.a, t.b) as AccuseTieResult).landed).toBe(false);
    expect(JSON.stringify(store(sb))).toBe(before);
  });

  it("a BOUNCED bluff expose and a REFUSED bluff trade store no bluff belief and no lie", () => {
    const sb = season("lc-bounce", 7);
    const [subject, recipient] = npcsOf(sb) as [EntityId, EntityId];
    for (const id of npcsOf(sb)) { const e = edge(sb, id, PLAYER); e.trust = 0; e.affinity = 0; e.threat = 0.9; const s = edge(sb, id, subject); s.threat = 0.05; s.affinity = 0.9; }
    expect((sb.session.tradeSecret({ bluff: true, subject, toNpcId: recipient, askKind: "vote" }) as TradeResult).accepted).toBe(false);
    sb.session.exposeSecret({ bluff: true, subject });
    expect(bluffBeliefs(sb)).toEqual([]);
    expect(lies(sb)).toEqual([]);
  });

  it("a TRUE expose / trade with NO earlier bluff catches nobody: no lie is written", () => {
    const sb = season("lc-nobluff", 6);
    const [subject, recipient] = npcsOf(sb) as [EntityId, EntityId];
    const real = learnSecretAbout(sb, subject);
    const rp = edge(sb, recipient, PLAYER); rp.trust = 0.9; rp.affinity = 0.8; rp.threat = 0.05;
    expect((sb.session.tradeSecret({ factId: real, toNpcId: recipient }) as TradeResult).accepted).toBe(true);
    const sb2 = season("lc-nobluff2", 6);
    const subject2 = npcsOf(sb2)[0]!;
    expect((sb2.session.exposeSecret({ factId: learnSecretAbout(sb2, subject2) }) as ExposeResult).exposed).toBe(true);
    expect(lies(sb)).toEqual([]);
    expect(lies(sb2)).toEqual([]);
  });

  it("a bluff caught by a houseguest who never believed it writes nothing for them (only the believer holds the lie)", () => {
    const sb = season("lc-onlybeliever", 4);
    const [subject, believer, bystander] = npcsOf(sb) as [EntityId, EntityId, EntityId];
    const rp = edge(sb, believer, PLAYER); rp.trust = 0.9; rp.affinity = 0.8; rp.threat = 0.05;
    const rs = edge(sb, believer, subject); rs.threat = 0.9; rs.affinity = 0.05;
    sb.session.tradeSecret({ bluff: true, subject, toNpcId: believer });
    const rb = edge(sb, bystander, PLAYER); rb.trust = 0.9; rb.affinity = 0.8; rb.threat = 0.05;
    sb.session.tradeSecret({ factId: learnSecretAbout(sb, subject), toNpcId: bystander });
    expect(lies(sb), "the bystander was never lied to").toEqual([]);
  });

  it("`confront` (landed or not) writes no lie: the one lied to is the player, who holds no claim", () => {
    const sb = season("lc-confront", 5);
    const target = npcsOf(sb)[0]!;
    const fact = learnSecretAbout(sb, target);
    const before = JSON.stringify(store(sb));
    GameSessionAdapter.setGossipConsequenceEnabled(true);
    try { expect(sb.session.confront(target, fact)).not.toBeNull(); } finally { GameSessionAdapter.setGossipConsequenceEnabled(null); }
    expect(JSON.stringify(store(sb))).toBe(before);
  });

  it("with the belief layer OFF nothing is written even with the lies flag on", () => {
    const sb = season("lc-nobeliefs", 5);
    sb.session.setNpcBeliefsEnabled(false);
    const subject = npcsOf(sb)[0]!;
    primeHouse(sb, subject);
    sb.session.exposeSecret({ bluff: true, subject });
    sb.session.exposeSecret({ factId: learnSecretAbout(sb, subject) });
    const t = realTies(sb)[0]!;
    sb.session.accuseTie(t.a, t.b);
    expect(all(sb)).toEqual([]);
  });
});

describe("lies-caught: flag off is byte-identical", () => {
  const script = (sb: UserSandbox): void => {
    const subject = npcsOf(sb)[0]!;
    primeHouse(sb, subject);
    sb.session.exposeSecret({ bluff: true, subject });
    sb.session.exposeSecret({ factId: learnSecretAbout(sb, subject) });
    const t = realTies(sb)[0]!;
    sb.session.accuseTie(t.a, t.b);
  };
  const strip = (sb: UserSandbox): string => {
    const snap = JSON.parse(JSON.stringify(sb.session.snapshot())) as { live?: { beliefs?: unknown } };
    if (snap.live) delete snap.live.beliefs;
    return JSON.stringify(snap);
  };
  it("flag unset == flag explicitly off, whole snapshot; and no lie/bluff claim exists", () => {
    const a = season("lc-off-a", 5, false); script(a);
    const b = season("lc-off-a", 5, false); b.session.setLiesCaughtEnabled(false); script(b);
    expect(JSON.stringify(a.session.snapshot())).toBe(JSON.stringify(b.session.snapshot()));
    expect(lies(a)).toEqual([]);
    expect(bluffBeliefs(a)).toEqual([]);
  });
  it("flag on changes ONLY the belief store: edges, ledger and every other field are identical (no rng, no fold)", () => {
    const off = season("lc-cmp", 5, false); script(off);
    const onSb = season("lc-cmp", 5, true); script(onSb);
    expect(strip(onSb)).toBe(strip(off));
    expect(lies(onSb).length).toBeGreaterThan(0);
  });
  it("the flag is registered defaultOn (ON unless set to 0; PO 2026-11-05)", () => {
    const d = FEATURE_FLAGS.find((f) => f.envKey === "ORWELL_LIES_CAUGHT");
    expect(d?.parser).toBe("defaultOn");
  });
});

describe("lies-caught: Vault sentinel across memory", () => {
  it("no hidden datum reaches a claim or any outward projection, and no claim carries free text", () => {
    const sb = season("lc-vault", 5);
    const sentinel = "SENTINEL-LIES-CAUGHT-4242";
    const ids = npcsOf(sb);
    sb.engine.vault.writeHidden({ id: "lc:hidden", kind: "hidden-attribute", subject: ids[0]!, content: `[hidden-attribute] ${sentinel}` });
    sb.engine.vault.writeHidden({ id: "lc:thread", kind: "hidden-thread", content: `[hidden-thread] ${sentinel}` });
    const subject = ids[0]!;
    primeHouse(sb, subject);
    sb.session.exposeSecret({ bluff: true, subject });
    sb.session.exposeSecret({ factId: learnSecretAbout(sb, subject) });
    const t = realTies(sb)[0]!;
    sb.session.accuseTie(t.a, t.b);
    expect(lies(sb).length).toBeGreaterThan(0);
    // the claims are structured, Vault-free values only
    for (const c of all(sb)) expect(Object.keys(c).every((k) => ["id", "holder", "kind", "subject", "object", "value", "origin", "nature", "source", "confidence", "week", "impact", "refuted", "reversed"].includes(k))).toBe(true);
    expect(JSON.stringify(store(sb))).not.toContain(sentinel);
    // outward: the narrator prompt, every houseguest's voice view and the visible game state never carry a claim or the sentinel
    const outward = JSON.stringify([
      sb.session.getMomentPrompt({}), ...ids.map((id) => sb.session.npcVoice(id)), sb.session.getGameState(),
    ]);
    expect(outward).not.toContain(sentinel);
    expect(outward).not.toContain("lied-to-me");
    expect(outward).not.toMatch(/"nature":\s*"bluff"/);
  });
});
