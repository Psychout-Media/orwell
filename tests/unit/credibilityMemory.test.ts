import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import type { UserSandbox } from "../../src/composition/registry";
import { PLAYER, npc } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";
import { RelationshipModel } from "../../src/engine/relationships";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import { recordClaim, type BeliefStore, type BeliefClaim } from "../../src/engine/beliefStore";
import { credibilityTilt, CREDIBILITY } from "../../src/engine/credibility";
import { voteChoice, advance, hcPickBias, newLiveSeason, type LiveSeasonState } from "../../src/engine/liveSeason";
import type { AdvanceView, SubmitDecisionReq } from "../../src/ports/GameSession";
import { nominationPlan, replacementPick } from "../../src/engine/season";
import { rankApproaches } from "../../src/engine/conversation";
import { decideDealConsent } from "../../src/engine/dealConsent";
import { DECISION_SOURCES } from "../../src/engine/memorySources";
import { FEATURE_FLAGS } from "../../src/featureFlags";

/**
 * B48 (#2017 section 14.5(3) READ side; ORWELL_CREDIBILITY_MEMORY, flag-off, never-flipped) - CREDIBILITY MEMORY. The belief store's `lied-to-me` / `assured-me` claims are READ by the NPC decisions:
 * each caught lie lowers belief in the liar (the player OR an NPC), scaled by the holder's own trust in the liar (the sting) and the holder's disposition (a grudge-holder fades slower), stacked with
 * diminishing returns and bounded; a believed assurance raises it a little. A signed, deterministic (no rng) tilt `credibilityTiltFor(subject, holder)`: + = act against the subject. Roles only.
 */

type G = {
  credibilityTiltFor(subject: string, holder: string): number;
  credibilityApproachFor(npc: string): number;
  setCredibilityMemoryEnabled(on: boolean): void;
  setLiesCaughtEnabled(on: boolean): void;
  ctx(): Record<string, unknown> & { rel: RelationshipModel };
  live: { week: number; beliefs?: BeliefStore };
  dealConsentRefusal(npc: string, kind: string, direction?: string): { refused: true; reason: string } | null;
  writeLieCaught(holder: string, liar: string, confidence: number, origin: "witnessed" | "told"): void;
};
const gOf = (sb: UserSandbox): G => sb.session as unknown as G;
function season(user: string, seed = 7, enabled = true): UserSandbox {
  const sb = new GameSessionRegistry().sandboxFor(user);
  sb.session.createCharacter({ playerName: "The Player", seed });
  sb.session.advanceGame(); sb.session.advanceGame();
  if (enabled) gOf(sb).setCredibilityMemoryEnabled(true);
  return sb;
}
const npcsOf = (sb: UserSandbox): EntityId[] => sb.session.livingIds().filter((id) => id !== PLAYER);
const lie = (sb: UserSandbox, holder: EntityId, liar: EntityId, confidence = 0.9, object?: string, kind: "lied-to-me" | "assured-me" = "lied-to-me"): void => {
  const live = gOf(sb).live;
  recordClaim((live.beliefs ??= {}), { holder, kind, subject: liar, ...(object ? { object } : {}), value: true, origin: "witnessed", confidence, week: live.week });
};
/** Make a holder see x and y identically (every edge both ways), so the decision is a pure tie unless something else tilts it. */
function tie(sb: UserSandbox, holder: EntityId, x: EntityId, y: EntityId): void {
  for (const [a, b] of [[holder, x], [holder, y], [x, holder], [y, holder]] as const) {
    const e = sb.engine.relationships.edge(a, b);
    e.trust = 0.5; e.affinity = 0.5; e.threat = 0.4;
  }
}

/** A deterministic player policy to carry the live loop to the first ceremony beat (approaches stay muted before it). */
function resolvePending(sb: UserSandbox, p: NonNullable<AdvanceView["pending"]>): void {
  const submit = (req: SubmitDecisionReq): void => void sb.session.submitDecision(req);
  if (p.kind === "nominations") submit({ kind: "nominations", choice: [p.options[0]!.id, p.options[1]!.id] });
  else if (p.kind === "veto-decision") submit({ kind: "veto-decision", use: false });
  else if (p.kind === "replacement") submit({ kind: "replacement", replacement: p.options[0]!.id });
  else if (p.kind === "comp-intent") submit({ kind: "comp-intent", intent: "compete" });
  else submit({ kind: p.kind, vote: p.options[0]!.id } as SubmitDecisionReq);
}
function pastFirstHoh(sb: UserSandbox): void {
  for (let i = 0; i < 200 && sb.session.snapshot().live?.hoh === undefined; i++) { const v = sb.session.advanceGame(); if (v.pending) resolvePending(sb, v.pending); }
}

describe("credibilityTilt: the pure rule", () => {
  const claim = (over: Partial<BeliefClaim>): Omit<BeliefClaim, "id"> => ({ holder: npc(1), kind: "lied-to-me", subject: npc(2), value: true, origin: "witnessed", confidence: 0.9, week: 5, ...over });
  const withClaims = (...cs: Array<Omit<BeliefClaim, "id">>): BeliefStore => { const s: BeliefStore = {}; cs.forEach((c, i) => recordClaim(s, { ...c, object: `lie-${i}` })); return s; };

  it("no store / no claims => exactly 0", () => {
    expect(credibilityTilt(undefined, npc(1), npc(2), 5)).toBe(0);
    expect(credibilityTilt({}, npc(1), npc(2), 5)).toBe(0);
  });
  it("one caught lie tilts AGAINST the liar; each further lie costs more, never past the bound (a habitual liar is believed less, not infinitely)", () => {
    const t1 = credibilityTilt(withClaims(claim({})), npc(1), npc(2), 5);
    const t2 = credibilityTilt(withClaims(claim({}), claim({})), npc(1), npc(2), 5);
    const t6 = credibilityTilt(withClaims(...Array.from({ length: 6 }, () => claim({}))), npc(1), npc(2), 5);
    expect(t1).toBeGreaterThan(0);
    expect(t2).toBeGreaterThan(t1);
    expect(t6).toBeGreaterThan(t2);
    expect(t6).toBeLessThanOrEqual(CREDIBILITY.max);
    expect(t2 - t1, "diminishing returns").toBeLessThan(t1);
  });
  it("a surer catch counts for more; an old lie fades; a refuted or value-false claim counts for nothing", () => {
    const sure = credibilityTilt(withClaims(claim({ confidence: 0.9 })), npc(1), npc(2), 5);
    const weak = credibilityTilt(withClaims(claim({ confidence: 0.3 })), npc(1), npc(2), 5);
    expect(sure).toBeGreaterThan(weak);
    const fresh = credibilityTilt(withClaims(claim({ week: 5 })), npc(1), npc(2), 5);
    const stale = credibilityTilt(withClaims(claim({ week: 5 })), npc(1), npc(2), 5 + 2 * CREDIBILITY.halfLifeWeeks);
    expect(stale).toBeCloseTo(fresh / 3.5, 0); // ~ a quarter after two half-lives, diminishing-returns shape aside
    expect(stale).toBeLessThan(fresh);
    expect(credibilityTilt(withClaims(claim({ refuted: true })), npc(1), npc(2), 5)).toBe(0);
    expect(credibilityTilt(withClaims(claim({ value: false })), npc(1), npc(2), 5)).toBe(0);
  });
  it("isolation: only the HOLDER's own claims about the SUBJECT move it", () => {
    const s = withClaims(claim({}));
    expect(credibilityTilt(s, npc(3), npc(2), 5), "another holder was not lied to").toBe(0);
    expect(credibilityTilt(s, npc(1), npc(3), 5), "another subject was not the liar").toBe(0);
    expect(credibilityTilt(s, npc(2), npc(1), 5), "not symmetric").toBe(0);
  });
  it("only the credibility kinds count: a rumor, a targets-me belief or a voted-against-me claim never moves it", () => {
    for (const kind of ["heard-rumor", "targets-me", "voted-against-me", "allied-with", "holds-power", "will-vote"] as const) {
      expect(credibilityTilt(withClaims(claim({ kind })), npc(1), npc(2), 5), kind).toBe(0);
    }
  });
  it("relationship scales it: the closer the holder was (more trust), the more a caught lie stings", () => {
    const s = withClaims(claim({}));
    const cold = credibilityTilt(s, npc(1), npc(2), 5, { trust: 0.05 });
    const close = credibilityTilt(s, npc(1), npc(2), 5, { trust: 0.9 });
    expect(close).toBeGreaterThan(cold);
    expect(cold).toBeGreaterThan(0);
  });
  it("personality scales it: a grudge-holder (slow decay) still discounts an old lie that a forgiving holder has largely let go", () => {
    const s = withClaims(claim({ week: 1 }));
    const sticky = credibilityTilt(s, npc(1), npc(2), 9, { decayScale: 0.5 });
    const forgiving = credibilityTilt(s, npc(1), npc(2), 9, { decayScale: 1.7 });
    expect(sticky).toBeGreaterThan(forgiving);
  });
  it("a believed assurance raises credibility a little; a caught lie outweighs it; both bounded", () => {
    const assured = credibilityTilt(withClaims(claim({ kind: "assured-me" })), npc(1), npc(2), 5);
    expect(assured).toBeLessThan(0);
    expect(assured).toBeGreaterThanOrEqual(-CREDIBILITY.assuredMax);
    const both = credibilityTilt(withClaims(claim({ kind: "assured-me" }), claim({})), npc(1), npc(2), 5);
    expect(both).toBeGreaterThan(0);
    expect(both).toBeLessThan(credibilityTilt(withClaims(claim({})), npc(1), npc(2), 5));
  });
  it("deterministic and pure: the same inputs give the same number and the store is untouched", () => {
    const s = withClaims(claim({}), claim({ confidence: 0.5 }));
    const before = JSON.stringify(s);
    expect(credibilityTilt(s, npc(1), npc(2), 5)).toBe(credibilityTilt(s, npc(1), npc(2), 5));
    expect(JSON.stringify(s)).toBe(before);
  });
  it("non-finite inputs cannot poison it", () => {
    const s = withClaims(claim({ confidence: Number.NaN }));
    expect(Number.isFinite(credibilityTilt(s, npc(1), npc(2), 5, { trust: Number.NaN, decayScale: Number.NaN }))).toBe(true);
  });
});

describe("the adapter provider (ORWELL_CREDIBILITY_MEMORY)", () => {
  it("flag off => 0 and NO ctx provider, whatever the store holds; on => the provider exists", () => {
    const sb = season("cm-flag", 7, false);
    const [h, liar] = npcsOf(sb) as [EntityId, EntityId];
    lie(sb, h, liar);
    expect(gOf(sb).credibilityTiltFor(liar, h)).toBe(0);
    expect(gOf(sb).credibilityApproachFor(h)).toBe(0);
    expect("credibilityTiltFor" in gOf(sb).ctx()).toBe(false);
    gOf(sb).setCredibilityMemoryEnabled(true);
    expect(gOf(sb).credibilityTiltFor(liar, h)).toBeGreaterThan(0);
    expect(typeof gOf(sb).ctx().credibilityTiltFor).toBe("function");
  });
  it("the PLAYER can be the liar (an NPC holder discounts them), an NPC can be the liar, and the player is never a holder or self-tilted", () => {
    const sb = season("cm-who");
    const [h, other] = npcsOf(sb) as [EntityId, EntityId];
    lie(sb, h, PLAYER); lie(sb, h, other);
    expect(gOf(sb).credibilityTiltFor(PLAYER, h)).toBeGreaterThan(0);
    expect(gOf(sb).credibilityTiltFor(other, h)).toBeGreaterThan(0);
    expect(gOf(sb).credibilityTiltFor(h, PLAYER), "the player's hidden read drives nothing").toBe(0);
    recordClaim((gOf(sb).live.beliefs ??= {}), { holder: PLAYER, kind: "lied-to-me", subject: h, value: true, origin: "witnessed", confidence: 0.9, week: gOf(sb).live.week });
    expect(gOf(sb).credibilityTiltFor(h, PLAYER), "even a claim somehow held by the player is never read").toBe(0);
    expect(gOf(sb).credibilityTiltFor(h, h)).toBe(0);
  });
  it("per-holder isolation: a lie told to one houseguest does not change what another believes", () => {
    const sb = season("cm-iso");
    const [h, bystander, liar] = npcsOf(sb) as [EntityId, EntityId, EntityId];
    lie(sb, h, liar);
    expect(gOf(sb).credibilityTiltFor(liar, h)).toBeGreaterThan(0);
    expect(gOf(sb).credibilityTiltFor(liar, bystander)).toBe(0);
  });
  it("the B23 writer feeds it: a lie caught through the real writer lowers belief in the liar", () => {
    const sb = season("cm-b23");
    const [h, liar] = npcsOf(sb) as [EntityId, EntityId];
    gOf(sb).setLiesCaughtEnabled(true);
    expect(gOf(sb).credibilityTiltFor(liar, h)).toBe(0);
    gOf(sb).writeLieCaught(h, liar, 0.8, "witnessed");
    expect(gOf(sb).credibilityTiltFor(liar, h)).toBeGreaterThan(0);
  });
  it("the flag is registered strict (on only when exactly '1')", () => {
    expect(FEATURE_FLAGS.find((f) => f.envKey === "ORWELL_CREDIBILITY_MEMORY")?.parser).toBe("strict");
  });
});

describe("DECISIONS change because of a caught lie (and are byte-identical flag-off)", () => {
  it("the eviction vote: a tied voter sends home the houseguest who lied to them; flag off => unchanged; another voter is unaffected", () => {
    const off = season("cm-vote-off", 7, false);
    const on = season("cm-vote-on");
    for (const sb of [off, on]) {
      const [v, other, x, y] = npcsOf(sb) as [EntityId, EntityId, EntityId, EntityId];
      tie(sb, v, x, y); tie(sb, other, x, y);
      const fn: [EntityId, EntityId] = [x, y];
      expect(voteChoice(v, fn, gOf(sb).ctx() as never), "a clean tie").toBe(x);
      lie(sb, v, y);
      const after = voteChoice(v, fn, gOf(sb).ctx() as never);
      if (sb === on) expect(after, "the liar goes home").toBe(y); else expect(after, "flag off: byte-identical").toBe(x);
      expect(voteChoice(other, fn, gOf(sb).ctx() as never), "the bystander was not lied to").toBe(x);
    }
  });
  it("the HOH's nominations and replacement: the liar is the target", () => {
    const sb = season("cm-noms");
    const [hoh, a, b, c] = npcsOf(sb) as [EntityId, EntityId, EntityId, EntityId];
    const rel = new RelationshipModel(0.5);
    const active = [hoh, a, b, c];
    const base = nominationPlan(hoh, active, rel, { disposition: "neutral", style: "threat-hunter" });
    const liar = [a, b, c].find((x) => x !== base.target)!;
    lie(sb, hoh, liar);
    const ctx = gOf(sb).ctx() as unknown as { credibilityTiltFor: (s: string, h: string) => number };
    const read = { disposition: "neutral" as const, style: "threat-hunter" as const, credibilityPush: (t: EntityId) => ctx.credibilityTiltFor(t, hoh) };
    expect(nominationPlan(hoh, active, rel, read).target).toBe(liar);
    // the replacement: both the pawn path (the target is still up) and the target path (the target was saved) lean to the liar
    const opts = [a, b, c];
    for (const remaining of [base.target, liar]) {
      const options = opts.filter((o) => o !== remaining);
      const plain = replacementPick(hoh, remaining, options, active, rel, { target: base.target });
      const withLie = replacementPick(hoh, remaining, options, active, rel, { ...read, target: base.target });
      if (options.includes(liar)) { expect(withLie, `remaining ${remaining === liar ? "liar" : "target"}`).toBe(liar); }
      else expect(withLie).toBe(plain);
    }
    // pawn seat, in a fresh house where ONLY the baseline's runner-up lied: the HOH names the one who lied
    const sb2 = season("cm-noms-pawn");
    const noTarget = opts.filter((o) => o !== base.target);
    const baselinePick = replacementPick(hoh, base.target, noTarget, active, rel, { target: base.target });
    const other = noTarget.find((o) => o !== baselinePick)!;
    lie(sb2, hoh, other);
    const ctx2 = gOf(sb2).ctx() as unknown as { credibilityTiltFor: (s: string, h: string) => number };
    const read2 = { credibilityPush: (t: EntityId) => ctx2.credibilityTiltFor(t, hoh), target: base.target };
    expect(replacementPick(hoh, base.target, noTarget, active, rel, read2), "pawn seat: the one who lied is the one named").toBe(other);
  });
  it("the veto save (the real beat): a holder who was lied to by a nominee does not use the veto on them", () => {
    const run = (enabled: boolean, liarIs: "x" | "none"): { saved?: EntityId; used: boolean } => {
      const sb = season(`cm-veto-${enabled}-${liarIs}`, 7, enabled);
      const [hoh, holder, x, y, ...rest] = npcsOf(sb) as EntityId[];
      const rel = gOf(sb).ctx().rel;
      for (const n of [x!, y!]) { const e = rel.edge(holder!, n); e.trust = 0.8; e.affinity = 0.8; e.threat = 0.1; }
      if (liarIs === "x") lie(sb, holder!, x!);
      const s: LiveSeasonState = { ...newLiveSeason([PLAYER, hoh!, holder!, x!, y!, ...rest]), beat: "veto-ceremony", hoh: hoh!, nominees: [x!, y!], vetoHolder: holder!, nominationTarget: x! } as LiveSeasonState;
      for (let i = 0; i < 3 && s.beat === "veto-ceremony"; i++) advance(s, gOf(sb).ctx() as never, new SeededRandom(3)); // the first step may be the one-shot day-break
      return { saved: s.saved, used: s.vetoUsed };
    };
    const clean = run(true, "none");
    expect(clean.used, "two equal friends: the holder uses the veto").toBe(true);
    const x = clean.saved!;
    const lied = run(true, "x");
    expect(lied.used).toBe(true);
    expect(lied.saved, "the nominee who lied is not the one saved").not.toBe(x);
    expect(run(false, "x"), "flag off: byte-identical to no lie").toEqual(run(false, "none"));
  });
  it("the Houseguest's Choice pick: the holder does not choose the one who lied to them as the sixth player", () => {
    const sb = season("cm-hc");
    const [holder, x, y] = npcsOf(sb) as [EntityId, EntityId, EntityId];
    const rel = new RelationshipModel(0.5);
    for (const n of [x, y]) { rel.edge(holder, n).trust = 0.6; rel.edge(holder, n).affinity = 0.6; }
    const ctx = gOf(sb).ctx() as unknown as { credibilityTiltFor: (s: string, h: string) => number };
    expect(hcPickBias(undefined, undefined, holder), "neither provider => no bias at all").toBeUndefined();
    const liar = rel.chooseStrongestBond(holder, [x, y], new SeededRandom(3))!;
    lie(sb, holder, liar);
    const bias = hcPickBias(undefined, ctx.credibilityTiltFor, holder)!;
    expect(bias(liar)).toBeLessThan(0);
    expect(bias(liar === x ? y : x)).toBe(0);
    expect(rel.chooseStrongestBond(holder, [x, y], new SeededRandom(3), undefined, bias)).not.toBe(liar);
    // composes with the memory read: a favor-sized hcMemory bias is still just added to the credibility term
    const both = hcPickBias((c) => (c === liar ? 0.05 : 0), ctx.credibilityTiltFor, holder)!;
    expect(both(liar)).toBeCloseTo(0.05 + bias(liar), 12);
    expect(hcPickBias((c) => (c === liar ? 0.05 : 0), undefined, holder)!(liar)).toBe(0.05);
  });
  it("deal consent: an NPC who caught the player lying refuses a deal they would otherwise take; flag off => still agrees", () => {
    for (const enabled of [false, true]) {
      const sb = season(`cm-deal-${enabled}`, 7, enabled);
      const h = npcsOf(sb)[0]!;
      const e = sb.engine.relationships.edge(h, PLAYER);
      e.trust = 0.6; e.affinity = 0.6; e.threat = 0.2;
      expect(gOf(sb).dealConsentRefusal(h, "veto-save", "ask"), "accepts before the lie").toBeNull();
      for (let i = 0; i < 3; i++) lie(sb, h, PLAYER, 0.9, `bluff-${i}`);
      const after = gOf(sb).dealConsentRefusal(h, "veto-save", "ask");
      if (enabled) { expect(after?.refused).toBe(true); expect(after?.reason).toBe("distrust"); } else expect(after).toBeNull();
    }
  });
  it("deal consent (pure): the credibility input is a bounded drag that only ever lowers willingness, and absent/0 is byte-identical", () => {
    const i = { kind: "veto-save" as const, trust: 0.6, affinity: 0.6, threat: 0.2, grudge: 0, favor: 0, targetsMe: 0, jitter: 0, direction: "ask" as const };
    expect(decideDealConsent({ ...i, credibility: 0 })).toEqual(decideDealConsent(i));
    expect(decideDealConsent(i).accept).toBe(true);
    expect(decideDealConsent({ ...i, credibility: CREDIBILITY.max }).accept).toBe(false);
    expect(decideDealConsent({ ...i, credibility: -1 }).accept, "an assurance is never a drag").toBe(true);
    const marginal = { ...i, trust: 0.25, affinity: 0.25, threat: 0.3 };
    expect(decideDealConsent(marginal).accept, "a typical newcomer does not take a veto-save ask").toBe(false);
    expect(decideDealConsent({ ...marginal, credibility: -1 }), "a believed assurance never buys an ask either").toEqual(decideDealConsent(marginal));
  });
  it("approaches: an NPC who caught the player lying is less drawn to seek them out", () => {
    const sb = season("cm-approach");
    const ids = npcsOf(sb).slice(0, 4);
    const rel = new RelationshipModel(0.5);
    for (const id of ids) { rel.edge(id, PLAYER).trust = 0.5; rel.edge(id, PLAYER).affinity = 0.5; rel.edge(id, PLAYER).threat = 0.1; }
    const order = (bias?: (n: string) => number) => rankApproaches(PLAYER, ids, rel, new SeededRandom(5), undefined, bias).map((a) => a.npc);
    const lead = order()[0]!;
    lie(sb, lead, PLAYER, 0.9, "a"); lie(sb, lead, PLAYER, 0.9, "b");
    expect(gOf(sb).credibilityApproachFor(lead)).toBeLessThan(0);
    expect(order((n) => gOf(sb).credibilityApproachFor(n))[0]).not.toBe(lead);
  });
  it("approaches (the real ranking): who seeks the player out drops for an NPC who caught them lying; flag off => unchanged", () => {
    const lead = (enabled: boolean, lies: boolean): { first?: string; ids: string[] } => {
      const sb = season(`cm-approach-live-${enabled}`, 7, false);
      pastFirstHoh(sb);
      const base = sb.session.socialInitiatives().map((a) => a.houseguest.id);
      if (enabled) gOf(sb).setCredibilityMemoryEnabled(true);
      if (lies) for (let i = 0; i < 3; i++) lie(sb, base[0]!, PLAYER, 0.95, `bluff-${i}`);
      const ids = sb.session.socialInitiatives().map((a) => a.houseguest.id);
      return { first: base[0], ids };
    };
    const off = lead(false, true);
    expect(off.ids, "flag off: the lies change nothing").toEqual(lead(false, false).ids);
    const on = lead(true, true);
    expect(on.first).toBeDefined();
    expect(on.ids[0], "the NPC who caught the player lying no longer leads").not.toBe(on.first);
  });
  it("a season played with the flag OFF is byte-identical whether or not lies are on the books", () => {
    const run = (withLies: boolean): string => {
      const sb = season("cm-bi", 11, false);
      if (withLies) { const [h, l] = npcsOf(sb) as [EntityId, EntityId]; lie(sb, h, l); lie(sb, h, PLAYER, 0.9, "x"); }
      const log: string[] = [];
      for (let i = 0; i < 40; i++) { try { sb.session.advanceGame(); } catch { break; } log.push(JSON.stringify((sb.session.getGameState() as unknown as { evictionOrder?: unknown }).evictionOrder ?? null)); }
      return log.join("|");
    };
    expect(run(true)).toBe(run(false));
  });
});

describe("the decision x source table names the provider", () => {
  it("lists credibilityTiltFor on the decisions that read it", () => {
    for (const d of ["evictionVote", "hohNominations", "replacementNominee", "vetoSave", "houseguestsChoice"] as const) expect(DECISION_SOURCES[d], d).toContain("credibilityTiltFor");
    expect(DECISION_SOURCES.approaches).toContain("credibilityApproachFor");
  });
});

describe("Vault sentinel", () => {
  it("the credibility read is a plain bounded number; nothing about it, no claim kind and no hidden datum reaches an outward projection", () => {
    const sb = season("cm-vault");
    const sentinel = "SENTINEL-CREDIBILITY-9191";
    const ids = npcsOf(sb);
    sb.engine.vault.writeHidden({ id: "cm:hidden", kind: "hidden-attribute", subject: ids[0]!, content: `[hidden-attribute] ${sentinel}` });
    sb.engine.vault.writeHidden({ id: "cm:thread", kind: "hidden-thread", content: `[hidden-thread] ${sentinel}` });
    const [h, liar] = ids as [EntityId, EntityId];
    lie(sb, h, liar); lie(sb, h, PLAYER, 0.9, "p");
    const t = gOf(sb).credibilityTiltFor(liar, h);
    expect(Number.isFinite(t) && Math.abs(t) <= CREDIBILITY.max).toBe(true);
    const outward = JSON.stringify([sb.session.getMomentPrompt({}), ...ids.map((id) => sb.session.npcVoice(id)), sb.session.getGameState()]);
    expect(outward).not.toContain(sentinel);
    expect(outward).not.toContain("lied-to-me");
    expect(outward).not.toContain("assured-me");
    expect(outward).not.toContain("credibility");
  });
});
