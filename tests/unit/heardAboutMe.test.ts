import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import type { UserSandbox } from "../../src/composition/registry";
import { McpServer } from "../../src/adapters/mcp/McpServer";
import { PLAYER } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";
import { targetsMeTilt, type BeliefClaim, type BeliefStore } from "../../src/engine/beliefStore";
import { nominationPlan } from "../../src/engine/season";
import { voteChoice } from "../../src/engine/liveSeason";
import { HEARD, heardConfidence, isMisheard, tellerReliability } from "../../src/engine/heardAboutMe";
import { FEATURE_FLAGS } from "../../src/featureFlags";
import { buildSandbox } from "../support/sandbox";

/**
 * B24 (#2017 section 14.5(5), M2c; ORWELL_HEARD_ABOUT_ME, flag-off) - HEARD-ABOUT-ME. What an NPC is TOLD about the player in a recorded chat scene (`recordInteraction.heardAboutMe`, the teller an NPC
 * named by `from`) writes a belief claim for each NAMED, awake NPC listener, at the TELLER's reliability (the listener's trust in the teller, plus a bonus when they credit the teller as a word-keeper) -
 * sometimes wrong BY CONSTRUCTION (a dedicated seeded roll, bounded, less likely the more reliable the teller): a misheard tell lands on a different houseguest. Engine-only (never voiced but BY that
 * holder), no edge fold, no shared rng; needs the belief layer; flag off: byte-identical. Roles only.
 */
const on = (sb: UserSandbox): void => sb.session.setHeardAboutMeEnabled(true);
function season(user: string, seed: number, enabled = true): UserSandbox {
  const sb = new GameSessionRegistry().sandboxFor(user);
  sb.session.createCharacter({ playerName: "The Player", seed });
  sb.session.advanceGame(); sb.session.advanceGame();
  if (enabled) on(sb); else sb.session.setHeardAboutMeEnabled(false); // default ON since 2026-11-05: the OFF arm pins it explicitly
  return sb;
}
const npcsOf = (sb: UserSandbox): EntityId[] => sb.session.livingIds().filter((id) => id !== PLAYER);
const store = (sb: UserSandbox): BeliefStore => ((sb.session.snapshot().live ?? {}) as unknown as { beliefs?: BeliefStore }).beliefs ?? {};
const all = (sb: UserSandbox): BeliefClaim[] => Object.values(store(sb)).flat();
const heard = (sb: UserSandbox): BeliefClaim[] => all(sb).filter((c) => c.origin === "told" && c.source !== undefined);
const edge = (sb: UserSandbox, a: EntityId, b: EntityId) => sb.engine.relationships.edge(a, b);
const tilt = (sb: UserSandbox, subject: EntityId, holder: EntityId): number => (sb.session as unknown as { beliefNomTiltFor(a: string, b: string): number }).beliefNomTiltFor(subject, holder);
/** Seat the named houseguests with the player so a scene among them is grounded. */
function seat(sb: UserSandbox, ids: EntityId[]): void {
  (sb.session as unknown as { presence: Map<string, string> }).presence = new Map<string, string>([[PLAYER, "kitchen"], ...ids.map((i) => [i, "kitchen"] as [string, string])]);
}
function tellIn(sb: UserSandbox, teller: EntityId, listeners: EntityId[], nature: "targeting" | "betrayal" = "targeting", extra: Record<string, unknown> = {}): void {
  seat(sb, [teller, ...listeners]);
  sb.commands.recordInteraction({ initiator: PLAYER, witnessSet: [PLAYER, teller, ...listeners], content: "one houseguest tells another what they believe about the player", kind: "gossip", heardAboutMe: { nature, from: teller }, ...extra } as never);
}

describe("heard-about-me: the pure reliability / confidence / mishearing rules", () => {
  it("the teller's reliability is the listener's trust in them (clamped), plus a bonus when the listener credits them as a word-keeper", () => {
    expect(tellerReliability(0.4, false)).toBeCloseTo(0.4, 9);
    expect(tellerReliability(0.4, true)).toBeCloseTo(0.4 + HEARD.creditedBonus, 9);
    expect(tellerReliability(0.99, true)).toBe(1);
    expect(tellerReliability(-3, false)).toBe(0);
    expect(tellerReliability(-0.5, true), "the trust is clamped before the bonus").toBeCloseTo(HEARD.creditedBonus, 9);
    expect(tellerReliability(Number.NaN, false)).toBe(0);
  });
  it("the confidence is monotone in the teller's reliability and bounded to [floor, ceiling]", () => {
    expect(heardConfidence(0)).toBeCloseTo(HEARD.floorConfidence, 9);
    expect(heardConfidence(1)).toBeCloseTo(HEARD.ceilConfidence, 9);
    let prev = -1;
    for (let r = 0; r <= 1.0001; r += 0.1) { const c = heardConfidence(r); expect(c).toBeGreaterThanOrEqual(prev); prev = c; }
  });
  it("a tell is misheard below a roll threshold that SHRINKS with reliability, never above the configured bound; a fully reliable teller is never misheard", () => {
    expect(isMisheard(0, 1)).toBe(false);
    expect(isMisheard(0, 0)).toBe(true);
    expect(isMisheard(HEARD.misheardP - 1e-9, 0)).toBe(true);
    expect(isMisheard(HEARD.misheardP, 0)).toBe(false);          // the bound: never above misheardP, whatever the reliability
    expect(isMisheard(HEARD.misheardP * 0.5 - 1e-9, 0.5)).toBe(true);
    expect(isMisheard(HEARD.misheardP * 0.5, 0.5)).toBe(false);
  });
});

describe("heard-about-me: the writer", () => {
  it("a tell writes a targets-me claim for the listener ONLY: origin told, source the teller, the tilt reads it", () => {
    const sb = season("ham-write", 5);
    const [teller, listener] = npcsOf(sb) as [EntityId, EntityId];
    expect(tilt(sb, PLAYER, listener)).toBe(0);
    tellIn(sb, teller, [listener]);
    const got = heard(sb);
    expect(got.length, JSON.stringify(got)).toBe(1);
    const c = got[0]!;
    expect(c).toMatchObject({ holder: listener, kind: "targets-me", object: listener, value: true, origin: "told", source: teller });
    expect(c.week).toBeGreaterThan(0);
    // the subject is the player unless this exact (teller, listener, week) rolled a mishearing; this seeded setup is the faithful one
    expect(c.subject).toBe(PLAYER);
    expect(c.nature, "a targeting tell carries no free-form nature").toBeUndefined();
    expect(targetsMeTilt(store(sb), listener, PLAYER, c.week)).toBeGreaterThan(0);
  });

  it("the claim's confidence is the TELLER's reliability: a trusted teller lands harder than a distrusted one", () => {
    const conf = (trust: number): number => {
      const sb = season("ham-conf", 5);
      const [teller, listener] = npcsOf(sb) as [EntityId, EntityId];
      edge(sb, listener, teller).trust = trust;
      tellIn(sb, teller, [listener]);
      return heard(sb).find((c) => c.holder === listener)!.confidence;
    };
    const lo = conf(0.1), hi = conf(0.9);
    expect(hi).toBeGreaterThan(lo);
    expect(hi).toBeCloseTo(heardConfidence(tellerReliability(0.9, false)), 6);
    expect(lo).toBeCloseTo(heardConfidence(tellerReliability(0.1, false)), 6);
  });

  it("a betrayal tell writes a heard-rumor claim (nature betrayal) the nomination belief read also folds in", () => {
    const sb = season("ham-betray", 5);
    const [teller, listener] = npcsOf(sb) as [EntityId, EntityId];
    tellIn(sb, teller, [listener], "betrayal");
    const c = heard(sb)[0]!;
    expect(c).toMatchObject({ holder: listener, kind: "heard-rumor", nature: "betrayal", origin: "told", source: teller });
    expect(c.subject).toBe(PLAYER);
    expect(tilt(sb, PLAYER, listener), "the existing betrayal-rumor read turns it into a they-may-turn-on-me tilt").toBeGreaterThan(0);
  });

  it("the same tell twice in a week is one claim (idempotent), and writes no edge fold and no memory entry", () => {
    const sb = season("ham-idem", 5);
    const [teller, listener] = npcsOf(sb) as [EntityId, EntityId];
    const before = { e: JSON.stringify(edge(sb, listener, PLAYER)), t: JSON.stringify(edge(sb, listener, teller)) };
    tellIn(sb, teller, [listener]); tellIn(sb, teller, [listener]);
    expect(heard(sb).length).toBe(1);
    expect(JSON.stringify(edge(sb, listener, teller))).toBe(before.t);
    expect(heard(sb)[0]!.impact, "no edge delta is recorded: a told claim moves no relationship").toBeUndefined();
  });
});

describe("heard-about-me: a FALSE claim misdirects an EVICTION VOTE (falsifiable; ORW-100 / B1 S0b bar)", () => {
  it("nobody is targeting the voter, yet after a tell that the player is, the voter evicts the PLAYER over an even rival; with no tell (or flag off) they do not", () => {
    const sb = season("ham-vote", 5);
    const [teller, voter, rival] = npcsOf(sb) as [EntityId, EntityId, EntityId];
    for (const a of sb.session.livingIds()) for (const b of sb.session.livingIds()) if (a !== b) { const e = edge(sb, a, b); e.trust = 0.5; e.affinity = 0.5; e.threat = 0.5; }
    expect((sb.session.snapshot() as unknown as { campaigns?: unknown[] }).campaigns ?? [], "precondition: no campaign exists, so the claim is false").toEqual([]);
    const ctxFor = (box: UserSandbox) => ({
      player: PLAYER, statsOf: () => ({ physical: 0.5, mental: 0.5, social: 0.5 }), rel: box.engine.relationships,
      beliefTiltFor: (t: EntityId, h: EntityId) => tilt(box, t, h),
    });
    const before = voteChoice(voter, [rival, PLAYER], ctxFor(sb));
    expect(before, "no belief: an even house does not single out the player").not.toBe(PLAYER);
    tellIn(sb, teller, [voter]);
    expect(heard(sb)[0]!.subject).toBe(PLAYER);
    expect(voteChoice(voter, [rival, PLAYER], ctxFor(sb)), "the false belief misdirects the VOTE onto the player").toBe(PLAYER);

    const off = season("ham-vote-off", 5, false);
    for (const a of off.session.livingIds()) for (const b of off.session.livingIds()) if (a !== b) { const e = edge(off, a, b); e.trust = 0.5; e.affinity = 0.5; e.threat = 0.5; }
    tellIn(off, teller, [voter]);
    expect(heard(off)).toEqual([]);
    expect(voteChoice(voter, [rival, PLAYER], ctxFor(off))).not.toBe(PLAYER);
  });
});

describe("heard-about-me: a FALSE claim misdirects a nomination (falsifiable)", () => {
  /** A house where the HOH feels the same about everyone, so ONLY a belief can move the pick. The player is last in the order, so with no belief the pick is never the player. */
  function even(sb: UserSandbox): EntityId[] {
    const ids = sb.session.livingIds();
    for (const a of ids) for (const b of ids) if (a !== b) { const e = edge(sb, a, b); e.trust = 0.5; e.affinity = 0.5; e.threat = 0.5; }
    return [...ids.filter((i) => i !== PLAYER), PLAYER];
  }
  const target = (sb: UserSandbox, hoh: EntityId, active: EntityId[]): EntityId =>
    nominationPlan(hoh, active, sb.engine.relationships, { beliefPush: (t) => tilt(sb, t, hoh) }).target;

  it("nobody is actually targeting the HOH, yet after a tell that the player is, the HOH puts the PLAYER up; with no tell (or flag off) they do not", () => {
    const sb = season("ham-misdirect", 5);
    const [teller, hoh] = npcsOf(sb) as [EntityId, EntityId];
    const active = even(sb);
    expect((sb.session.snapshot() as unknown as { campaigns?: unknown[] }).campaigns ?? [], "precondition: no campaign exists, so the claim is false").toEqual([]);
    expect(target(sb, hoh, active), "no belief: the even house never picks the player").not.toBe(PLAYER);
    tellIn(sb, teller, [hoh]);
    expect(heard(sb)[0]!.subject).toBe(PLAYER);
    expect(target(sb, hoh, active), "the false belief misdirects the nomination onto the player").toBe(PLAYER);

    const off = season("ham-misdirect-off", 5, false);
    const activeOff = even(off);
    tellIn(off, teller, [hoh]);
    expect(heard(off)).toEqual([]);
    expect(target(off, hoh, activeOff)).not.toBe(PLAYER);
  });

  it("a MISHEARD tell (some tells, by construction) lands on an innocent houseguest and misdirects the nomination onto THEM", () => {
    let seen: { sb: UserSandbox; hoh: EntityId; claim: BeliefClaim } | undefined;
    for (let seed = 1; seed <= 60 && !seen; seed++) {
      const sb = season(`ham-misheard-${seed}`, seed);
      const [teller, hoh] = npcsOf(sb) as [EntityId, EntityId];
      edge(sb, hoh, teller).trust = 0; // an unreliable teller is the likeliest to be misheard
      tellIn(sb, teller, [hoh]);
      const c = heard(sb)[0];
      if (c && c.subject !== PLAYER) seen = { sb, hoh, claim: c };
    }
    expect(seen, "some tells are misheard across seeds").toBeDefined();
    const { sb, hoh, claim } = seen!;
    expect(claim.subject).not.toBe(hoh);
    expect(claim.subject).not.toBe(claim.source);
    const active = even(sb);
    expect(nominationPlan(hoh, active, sb.engine.relationships, { beliefPush: (t) => tilt(sb, t, hoh) }).target, "the innocent third is the misdirected pick").toBe(claim.subject);
  });

  it("mishearing is seeded and bounded: deterministic per game, and over every (teller, listener) pair of a distrusted house the rate sits under the configured bound (most tells are faithful)", () => {
    const run = (seed: number): { wrong: number; total: number; subjects: string } => {
      const sb = season(`ham-rate-${seed}`, seed);
      const ids = npcsOf(sb);
      for (const a of ids) for (const b of ids) if (a !== b) edge(sb, a, b).trust = 0; // the likeliest case to be misheard
      seat(sb, ids);
      for (const teller of ids) for (const listener of ids) if (teller !== listener) {
        sb.commands.recordInteraction({ initiator: PLAYER, witnessSet: [PLAYER, teller, listener], content: "x", kind: "gossip", heardAboutMe: { nature: "targeting", from: teller } } as never);
      }
      const told = heard(sb);
      for (const c of told) { expect(c.subject, "a misheard tell never lands on its own holder").not.toBe(c.holder); expect(c.subject, "...nor on the teller").not.toBe(c.source); }
      return { wrong: told.filter((c) => c.subject !== PLAYER).length, total: told.length, subjects: told.map((c) => c.subject).join(",") };
    };
    let wrong = 0, total = 0;
    for (const seed of [1, 2, 3]) {
      const r = run(seed);
      expect(run(seed).subjects, "same game, same outcome").toBe(r.subjects);
      wrong += r.wrong; total += r.total;
    }
    expect(total).toBeGreaterThan(300);
    expect(wrong).toBeGreaterThan(0);
    expect(HEARD.misheardP, "the configured bound itself is pinned").toBeLessThanOrEqual(0.2);
    expect(wrong / total, "bounded: never above the configured chance (with sampling slack)").toBeLessThan(0.28);
    expect(wrong / total, "and it does happen at about that rate").toBeGreaterThan(0.12);
  });
});

describe("heard-about-me: per-holder isolation", () => {
  it("one listener's heard claim never shows in another houseguest's store or read (not a non-listener, not the teller, not the player)", () => {
    const sb = season("ham-iso", 5);
    const [teller, listener, bystander, other] = npcsOf(sb) as [EntityId, EntityId, EntityId, EntityId];
    seat(sb, [teller, listener, bystander, other]);
    tellIn(sb, teller, [listener]);
    expect(Object.keys(store(sb))).toEqual([listener]);
    for (const h of [teller, bystander, other, PLAYER]) {
      expect(store(sb)[h] ?? [], `${h} holds nothing`).toEqual([]);
      expect(tilt(sb, PLAYER, h), `${h} reads nothing`).toBe(0);
    }
  });

  it("two listeners of one tell each hold their OWN claim, at their OWN trust in the teller", () => {
    const sb = season("ham-iso2", 5);
    const [teller, a, b] = npcsOf(sb) as [EntityId, EntityId, EntityId];
    edge(sb, a, teller).trust = 0.9; edge(sb, b, teller).trust = 0.2;
    tellIn(sb, teller, [a, b]);
    const ca = store(sb)[a]!.find((c) => c.source === teller)!, cb = store(sb)[b]!.find((c) => c.source === teller)!;
    expect(ca.holder).toBe(a); expect(cb.holder).toBe(b);
    expect(ca.confidence).toBeGreaterThan(cb.confidence);
    expect(ca.object).toBe(a); expect(cb.object).toBe(b);
  });
});

describe("heard-about-me: a misfire writes nothing", () => {
  it("the player as the 'teller', a scene with no other NPC to hear it, a missing / unknown `from`, and an unknown nature each write nothing", () => {
    const sb = season("ham-misfire", 5);
    const [teller, listener] = npcsOf(sb) as [EntityId, EntityId];
    seat(sb, [teller, listener]);
    sb.commands.recordInteraction({ initiator: PLAYER, witnessSet: [PLAYER, listener], content: "x", kind: "gossip", heardAboutMe: { nature: "targeting", from: PLAYER } } as never);
    sb.commands.recordInteraction({ initiator: PLAYER, witnessSet: [PLAYER, teller], content: "x", kind: "gossip", heardAboutMe: { nature: "targeting", from: teller } } as never);
    sb.commands.recordInteraction({ initiator: PLAYER, witnessSet: [PLAYER, teller, listener], content: "x", kind: "gossip", heardAboutMe: { nature: "bogus", from: teller } } as never);
    expect(all(sb)).toEqual([]);
  });
  it("a teller who is not a named witness of the scene, and the writer called directly with the player (or the listener) as teller, write nothing", () => {
    const sb = season("ham-teller", 5);
    const [teller, listener, absent] = npcsOf(sb) as [EntityId, EntityId, EntityId];
    seat(sb, [teller, listener, absent]);
    sb.commands.recordInteraction({ initiator: PLAYER, witnessSet: [PLAYER, listener], content: "x", kind: "gossip", heardAboutMe: { nature: "targeting", from: absent } } as never);
    const direct = sb.session as unknown as { recordHeardAboutMe(h: { teller: string; listeners: string[]; nature: string }): void };
    direct.recordHeardAboutMe({ teller: PLAYER, listeners: [listener], nature: "targeting" });
    direct.recordHeardAboutMe({ teller: listener, listeners: [listener], nature: "targeting" });
    expect(all(sb)).toEqual([]);
  });
  it("with the belief layer OFF nothing is written even with the heard flag on", () => {
    const sb = season("ham-nobeliefs", 5);
    sb.session.setNpcBeliefsEnabled(false);
    const [teller, listener] = npcsOf(sb) as [EntityId, EntityId];
    tellIn(sb, teller, [listener]);
    expect(all(sb)).toEqual([]);
  });
  it("the tell writes nothing for a houseguest who is not a NAMED witness of the scene", () => {
    const sb = season("ham-named", 5);
    const [teller, listener, absent] = npcsOf(sb) as [EntityId, EntityId, EntityId];
    tellIn(sb, teller, [listener]);
    expect(store(sb)[absent] ?? []).toEqual([]);
  });
});

describe("heard-about-me: through the MCP boundary (the four-place rule)", () => {
  function server(sb: UserSandbox): McpServer {
    return new McpServer("player", { player: buildSandbox(1).player, admin: buildSandbox(1).admin, summary: buildSandbox(1).summary, commands: sb.commands, session: sb.session });
  }
  it("recordInteraction carrying heardAboutMe writes the claim; a malformed descriptor is refused with the field name", async () => {
    const sb = season("ham-mcp", 5);
    const [teller, listener] = npcsOf(sb) as [EntityId, EntityId];
    seat(sb, [teller, listener]);
    const s = server(sb);
    await s.callTool("recordInteraction", { initiator: PLAYER, witnessSet: [PLAYER, teller, listener], content: "x", kind: "gossip", heardAboutMe: { nature: "targeting", from: teller } });
    expect(heard(sb).map((c) => c.holder)).toEqual([listener]);
    await expect(s.callTool("recordInteraction", { initiator: PLAYER, witnessSet: [PLAYER, teller, listener], content: "x", heardAboutMe: "targeting" })).rejects.toThrow(/heardAboutMe/);
    await expect(s.callTool("recordInteraction", { initiator: PLAYER, witnessSet: [PLAYER, teller, listener], content: "x", heardAboutMe: { nature: "bogus" } })).rejects.toThrow(/heardAboutMe/);
    await expect(s.callTool("recordInteraction", { initiator: PLAYER, witnessSet: [PLAYER, teller, listener], content: "x", heardAboutMe: { nature: "targeting", from: 7 } })).rejects.toThrow(/heardAboutMe/);
  });
});

describe("heard-about-me: flag off is byte-identical", () => {
  const script = (sb: UserSandbox): void => {
    const [teller, listener, third] = npcsOf(sb) as [EntityId, EntityId, EntityId];
    tellIn(sb, teller, [listener, third]);
    tellIn(sb, listener, [teller], "betrayal");
  };
  const strip = (sb: UserSandbox): string => {
    const snap = JSON.parse(JSON.stringify(sb.session.snapshot())) as { live?: { beliefs?: unknown } };
    if (snap.live) delete snap.live.beliefs;
    return JSON.stringify(snap);
  };
  it("flag unset == flag explicitly off, whole snapshot; and no heard claim exists", () => {
    const a = season("ham-off", 5, false); script(a);
    const b = season("ham-off", 5, false); b.session.setHeardAboutMeEnabled(false); script(b);
    expect(JSON.stringify(a.session.snapshot())).toBe(JSON.stringify(b.session.snapshot()));
    expect(heard(a)).toEqual([]);
  });
  it("flag on changes ONLY the belief store: edges, ledger, events and every other field are identical (no rng, no fold)", () => {
    const off = season("ham-cmp", 5, false); script(off);
    const onSb = season("ham-cmp", 5, true); script(onSb);
    expect(strip(onSb)).toBe(strip(off));
    expect(heard(onSb).length).toBeGreaterThan(0);
  });
  it("the flag is registered defaultOn (ON unless set to 0; PO 2026-11-05)", () => {
    expect(FEATURE_FLAGS.find((f) => f.envKey === "ORWELL_HEARD_ABOUT_ME")?.parser).toBe("defaultOn");
  });
});

describe("heard-about-me: Vault sentinel across memory, prompt, npcVoice and getGameState", () => {
  it("no hidden datum reaches a claim or any outward projection, and no claim carries free text", () => {
    const sb = season("ham-vault", 5);
    const sentinel = "SENTINEL-HEARD-ABOUT-ME-4242";
    const ids = npcsOf(sb);
    sb.engine.vault.writeHidden({ id: "ham:hidden", kind: "hidden-attribute", subject: ids[0]!, content: `[hidden-attribute] ${sentinel}` });
    sb.engine.vault.writeHidden({ id: "ham:thread", kind: "hidden-thread", content: `[hidden-thread] ${sentinel}` });
    const [teller, listener] = ids as [EntityId, EntityId];
    tellIn(sb, teller, [listener], "targeting", { content: `the teller says ${sentinel}` });
    tellIn(sb, teller, [listener], "betrayal", { content: `the teller says ${sentinel}` });
    expect(heard(sb).length).toBeGreaterThan(0);
    for (const c of all(sb)) expect(Object.keys(c).every((k) => ["id", "holder", "kind", "subject", "object", "value", "origin", "nature", "source", "confidence", "week", "impact", "refuted", "reversed"].includes(k))).toBe(true);
    expect(JSON.stringify(store(sb)), "the scene's free text never enters a claim").not.toContain(sentinel);
    const outward = JSON.stringify([
      sb.session.getMomentPrompt({}), ...ids.map((id) => sb.session.npcVoice(id)), sb.session.getGameState(),
    ]);
    expect(outward).not.toContain(sentinel);
    expect(outward).not.toContain("targets-me");
    expect(outward).not.toMatch(/"origin":\s*"told"/);
  });
});
