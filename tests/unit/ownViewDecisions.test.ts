import { describe, it, expect } from "vitest";
import { GameSessionRegistry, type UserSandbox } from "../../src/composition/registry";
import { PLAYER, type EntityId } from "../../src/domain/ids";
import { recordClaim, type BeliefStore } from "../../src/engine/beliefStore";
import { RELATIONSHIP_CONSTANTS } from "../../src/engine/relationshipConstants";
import { ARCHETYPE_AGGRESSION } from "../../src/engine/campaigns";
import { nominationPlan, politicalTemperature } from "../../src/engine/season";
import { voteChoice, type SeasonCtx } from "../../src/engine/liveSeason";
import type { RelationshipModel } from "../../src/engine/relationships";
import type { Pitch } from "../../src/engine/lobbying";
import type { DecisionWhy } from "../../src/engine/decisionWhy";

/**
 * ORW-574 (Fable audit T1-6) + ORW-596 - NPCs decide from their OWN view (Ryne 11-03: "what each NPC believes"). In a PLAYED game a decision reads how
 * someone ELSE feels only as the decider can see it (their own reads, the public record, the scenes they saw, the beliefs they hold), never the other
 * houseguest's hidden edge. Each decision is checked both ways: it does NOT move when only the other party's hidden edge moves (the decider's view held
 * fixed), and it DOES move when the decider's own view moves. Drives the REAL adapter through a registry sandbox. TEST-ONLY seams: the private reads
 * named in `Seam`. Roles only: the decider, the HOH, a nominee, a rival, a juror, a voter, the player.
 */
type Seam = {
  live: { playedGame?: boolean; beliefs?: BeliefStore; week: number; nominees?: EntityId[]; hoh?: EntityId; resume?: Record<EntityId, number> };
  rel: RelationshipModel;
  house: { npcs: Array<{ id: EntityId; character: { archetype: string; stats: { physical: number; mental: number; social: number } } }> };
  ctx(): SeasonCtx;
  deriveCompIntent(id: EntityId, field: readonly EntityId[]): string;
  hcStrategyFor(candidate: EntityId, holder: EntityId): number;
  derivePitches(holder: EntityId): Pitch[];
  voteStillInDoubt(actor: EntityId, target: EntityId): boolean;
  finalHohMindChoice(hoh: EntityId, rivals: readonly EntityId[], jury: readonly EntityId[], why?: (w: Omit<DecisionWhy, "by" | "week">) => void): EntityId | undefined;
  perceivedBond(holder: EntityId, from: EntityId, to: EntityId): number;
  perceivedTrust(holder: EntityId, from: EntityId, to: EntityId): number;
  perceivedThreat(holder: EntityId, from: EntityId, to: EntityId): number;
};
const B = RELATIONSHIP_CONSTANTS.baseline;
let n = 0;
let seq = 0;

function game(playedGame = true, seed = 21): { sb: UserSandbox; s: Seam; npcs: EntityId[] } {
  const sb = new GameSessionRegistry().sandboxFor(`ownview574-${n++}`);
  sb.session.createCharacter({ playerName: "The Player", seed });
  const s = sb.session as unknown as Seam;
  s.live.playedGame = playedGame;
  s.live.beliefs = {};
  s.live.resume = {};
  const all = sb.session.livingIds();
  // a quiet house: every read at the edge baseline, so only what a test sets stands out
  for (const x of all) for (const y of all) if (x !== y) Object.assign(s.rel.edge(x, y), { trust: B.trust, affinity: B.affinity, threat: B.threat, reliability: B.reliability });
  return { sb, s, npcs: all.filter((id) => id !== PLAYER) };
}
function scene(sb: UserSandbox, type: string, pair: [EntityId, EntityId], seenBy: EntityId[]): void {
  sb.engine.events.record({
    id: `ownview574-scene-${seq++}`, ts: 1000 + seq, type, initiator: pair[0], witnessSet: [...pair], hidden: !pair.includes(PLAYER), content: "they talk",
    houseLife: { action: "talk", place: "kitchen", manner: "warm", truthful: true, stretch: 0, seenBy },
  });
}
function believe(s: Seam, holder: EntityId, kind: "targets-me" | "assured-me", subject: EntityId, confidence = 0.95): void {
  recordClaim((s.live.beliefs ??= {}), { holder, kind, subject, ...(kind === "targets-me" ? { object: holder } : {}), value: true, origin: "told", confidence, week: s.live.week });
}
const cautious = (s: Seam, npcs: EntityId[]): EntityId => npcs.find((id) => (ARCHETYPE_AGGRESSION[s.house.npcs.find((h) => h.id === id)!.character.archetype] ?? 0.5) < 0.55)!;

describe("ORW-574 / ORW-596: NPC decisions read the decider's own view (played games)", () => {
  it("1. comp intent: a rival's hidden threat read of the decider does not make them play safe; their own view (public wins, a believed threat) does", () => {
    const { s, npcs } = game();
    const me = cautious(s, npcs);
    expect(me, "the cast holds a cautious houseguest").toBeDefined();
    const field = [me, ...npcs.filter((id) => id !== me).slice(0, 3), PLAYER];
    const before = s.deriveCompIntent(me, field);
    expect(before).toBe("compete");
    for (const o of field) if (o !== me) s.rel.edge(o, me).threat = 0.98; // every rival (the player too) secretly reads them as a huge threat
    expect(s.deriveCompIntent(me, field), "only the others' hidden edges moved").toBe(before);
    s.live.resume![me] = 3; // the house watched them win three comps
    believe(s, me, "targets-me", field[1]!);
    expect(s.deriveCompIntent(me, field), "their own view: public wins + a believed target").toBe("play-safe");
  });

  it("1b. unplayed (headless) games keep the old hidden read, byte-identical", () => {
    const { s, npcs } = game(false);
    const me = cautious(s, npcs);
    const field = [me, ...npcs.filter((id) => id !== me).slice(0, 3)];
    expect(s.deriveCompIntent(me, field)).toBe("compete");
    s.rel.edge(field[1]!, me).threat = 0.98;
    expect(s.deriveCompIntent(me, field)).toBe("play-safe");
    expect(s.ctx().perceivedTrustFor).toBeUndefined();
    expect(s.ctx().perceivedThreatFor).toBeUndefined();
  });

  it("2. Houseguest's Choice: the candidate's hidden trust and hidden stats do not move the holder's strategy; the holder's own read and what they saw do", () => {
    const { s, npcs } = game();
    const [holder, other, candidate, hoh] = npcs;
    s.live.nominees = [holder!, other!];
    s.live.hoh = hoh!;
    const base = s.hcStrategyFor(candidate!, holder!);
    s.rel.edge(candidate!, holder!).trust = 0.99; // the candidate secretly trusts the nominee
    const c = s.house.npcs.find((h) => h.id === candidate)!.character.stats;
    Object.assign(c, { physical: 0.99, mental: 0.99 }); // and is secretly a comp monster
    expect(s.hcStrategyFor(candidate!, holder!), "only the candidate's hidden state moved").toBe(base);
    s.rel.edge(holder!, candidate!).trust = 0.95; // the nominee trusts THEM (and reads it back)
    expect(s.hcStrategyFor(candidate!, holder!)).toBeGreaterThan(base);
    // the HOH's branch: who would rescue a nominee, as the HOH saw it
    const hohBase = s.hcStrategyFor(candidate!, hoh!);
    for (const nom of [holder!, other!]) { s.rel.edge(candidate!, nom).trust = 0.99; s.rel.edge(candidate!, nom).affinity = 0.99; }
    expect(s.hcStrategyFor(candidate!, hoh!), "the candidate's hidden bonds with the nominees").toBe(hohBase);
  });

  it("2b. Houseguest's Choice (HOH): the HOH watching the candidate bond with a nominee makes them a worse pick", () => {
    const { sb, s, npcs } = game();
    const [nomA, nomB, candidate, hoh] = npcs;
    s.live.nominees = [nomA!, nomB!];
    s.live.hoh = hoh!;
    const before = s.hcStrategyFor(candidate!, hoh!);
    for (let i = 0; i < 4; i++) scene(sb, "bonding", [candidate!, nomA!], [hoh!]);
    expect(s.hcStrategyFor(candidate!, hoh!)).toBeLessThan(before);
  });

  it("3. political temperature: the house's hidden threat reads do not force a runaway week; the HOH's own read of the house does", () => {
    const { s, npcs } = game();
    const hoh = npcs[0]!;
    const subject = npcs[1]!;
    const active = [PLAYER, ...npcs];
    const threatOf = (f: EntityId, t: EntityId) => s.ctx().perceivedThreatFor!(hoh, f, t);
    const read = { disposition: "bond" as const, threatOf };
    const before = nominationPlan(hoh, active, s.rel, read);
    expect(politicalTemperature(active, s.rel, threatOf).runaway).toBe(false);
    for (const r of active) if (r !== subject && r !== hoh) s.rel.edge(r, subject).threat = 1; // the whole house secretly fears one houseguest
    expect(politicalTemperature(active, s.rel).runaway, "the hidden read would call it a runaway week").toBe(true);
    expect(politicalTemperature(active, s.rel, threatOf).runaway, "only the others' hidden edges moved").toBe(false);
    expect(nominationPlan(hoh, active, s.rel, read)).toEqual(before);
    s.rel.edge(hoh, subject).threat = 1; // the HOH fears them
    s.live.resume![subject] = 4; // and watched them win four comps
    expect(politicalTemperature(active, s.rel, threatOf).runaway, "the HOH's own view").toBe(true);
  });

  it("4. pitch strength: the HOH's hidden threat read of a pitcher does not move their pitch; the pitcher's own belief does", () => {
    const { s, npcs } = game();
    const hoh = npcs[0]!;
    const strength = (p: EntityId) => s.derivePitches(hoh).find((x) => x.from === p)?.strength;
    const pitcher = s.derivePitches(hoh)[0]!.from;
    const before = strength(pitcher);
    s.rel.edge(hoh, pitcher).threat = 0.95;
    expect(strength(pitcher), "only the HOH's hidden edge moved").toBe(before);
    believe(s, pitcher, "targets-me", hoh);
    expect(strength(pitcher)!).toBeGreaterThan(before!);
  });

  it("5. the vote's jury-management term reads how much the nominee trusts the voter AS THE VOTER SEES IT; the HOH's target is the voter's read", () => {
    const { s, npcs } = game();
    const [voter, a, b, hoh] = npcs;
    const juryTerm = (): number => {
      let w: Omit<DecisionWhy, "by" | "week"> | undefined;
      const ctx: SeasonCtx = { ...s.ctx() };
      voteChoice(voter!, [a!, b!], ctx, [], hoh, (x) => { w = x; });
      const opt = w!.options.find((o) => o.option === a)!;
      return opt.terms.find(([name]) => name === "jury-management")?.[1] ?? 0;
    };
    const before = juryTerm();
    s.rel.edge(a!, voter!).trust = 0.99; // the nominee secretly trusts the voter
    expect(juryTerm(), "only the nominee's hidden edge moved").toBe(before);
    believe(s, voter!, "assured-me", a!); // the nominee told the voter they are keeping them
    expect(juryTerm()).toBeLessThan(before);
    // the HOH's target, as the voter reads it: the HOH's hidden threat edges do not decide it
    const hohRead = s.ctx().perceivedThreatFor!(voter!, hoh!, a!);
    s.rel.edge(hoh!, a!).threat = 0.99;
    expect(s.ctx().perceivedThreatFor!(voter!, hoh!, a!), "only the HOH's hidden edge moved").toBe(hohRead);
  });

  it("5c. the vote's HOH-referendum term lands on the nominee the VOTER reads as the HOH's target, not the HOH's hidden pick", () => {
    const { s, npcs } = game();
    const [voter, a, b, hoh] = npcs;
    Object.assign(s.rel.edge(voter!, hoh!), { trust: 0.9, affinity: 0.9 }); // the voter is with the HOH, so the referendum term is live
    const target = (): EntityId | undefined => {
      let w: Omit<DecisionWhy, "by" | "week"> | undefined;
      voteChoice(voter!, [a!, b!], s.ctx(), [], hoh, (x) => { w = x; });
      return w!.options.find((o) => (o.terms.find(([nm]) => nm === "hoh-referendum")?.[1] ?? 0) !== 0)?.option;
    };
    const before = target();
    expect(before, "the voter reads one nominee as the HOH's target").toBeDefined();
    const other = before === a ? b! : a!;
    s.rel.edge(hoh!, other).threat = 1; s.rel.edge(hoh!, before!).threat = 0; // the HOH secretly fears the OTHER nominee
    expect(target(), "only the HOH's hidden edges moved").toBe(before);
    s.rel.edge(voter!, other).threat = 1; s.live.resume![other] = 5; // the voter fears the other one, who has won five comps
    expect(target()).toBe(other);
  });

  it("5b. the player as the other party: an NPC's read of the player's trust and threat is its perception, not the player's hidden edges", () => {
    const { s, npcs } = game();
    const me = npcs[0]!;
    const t0 = s.perceivedTrust(me, PLAYER, me), th0 = s.perceivedThreat(me, PLAYER, me);
    s.rel.edge(PLAYER, me).trust = 0.99; s.rel.edge(PLAYER, me).threat = 0.99;
    expect([s.perceivedTrust(me, PLAYER, me), s.perceivedThreat(me, PLAYER, me)]).toEqual([t0, th0]);
    believe(s, me, "targets-me", PLAYER);
    expect(s.perceivedTrust(me, PLAYER, me)).toBeLessThan(t0);
    expect(s.perceivedThreat(me, PLAYER, me)).toBeGreaterThan(th0);
  });

  it("6. vote counting: the voters' hidden feelings about the target do not move the actor's count; the actor's own view does", () => {
    const { sb, s, npcs } = game();
    const [actor, target] = npcs;
    const voters = [PLAYER, ...npcs].filter((v) => v !== actor && v !== target);
    const set = (threat: number, trust: number) => { for (const v of voters) Object.assign(s.rel.edge(v, target!), { threat, trust }); };
    for (const v of voters) for (let i = 0; i < 4; i++) scene(sb, "bonding", [v, target!], [actor!]); // the actor has watched everyone bond with the target
    set(1, 0);
    const a = s.voteStillInDoubt(actor!, target!);
    set(0.0625, 0.25); // a dead-even house (0.5 + 0.6 x (0.0625 - 0.125) ~ 0.46) vs a certain one: the old read flips between these
    expect(s.voteStillInDoubt(actor!, target!), "only the voters' hidden edges moved").toBe(a);
    expect(a, "the actor sees a close count").toBe(true);
    s.rel.edge(actor!, target!).threat = 1; // the actor fears the target
    s.live.resume![target!] = 5; // who has won five comps
    expect(s.voteStillInDoubt(actor!, target!), "the actor's own view: they now count the target as gone").toBe(false);
  });

  it("7. the final HOH's own jury estimate reads the rival's closeness to each juror as the HOH saw it", () => {
    const { sb, s, npcs } = game();
    const [hoh, r1, r2, ...rest] = npcs;
    const jury = rest.slice(0, 5);
    const odds = (): number[] => {
      let w: Omit<DecisionWhy, "by" | "week"> | undefined;
      s.finalHohMindChoice(hoh!, [r1!, r2!], jury, (x) => { w = x; });
      return [...w!.options].sort((x, y) => x.option.localeCompare(y.option)).map((o) => o.terms.find(([nm]) => nm === "jury-odds")?.[1] ?? 0);
    };
    const before = odds();
    for (const j of jury) Object.assign(s.rel.edge(r1!, j), { trust: 0.99, affinity: 0.99 }); // one rival is secretly close to every juror
    expect(odds(), "only the rival's hidden edges moved").toEqual(before);
    for (const j of jury) for (let i = 0; i < 4; i++) scene(sb, "bonding", [r1!, j], [hoh!]); // the HOH watched them bond
    expect(odds()).not.toEqual(before);
  });

  it("8. (ORW-596) the floater/duo bond read is only what the holder saw: the hidden bond does not move it; a witnessed warm or cold scene does", () => {
    const { sb, s, npcs } = game();
    const [holder, a, b] = npcs;
    const base = s.perceivedBond(holder!, a!, b!);
    for (const [x, y] of [[a!, b!], [b!, a!]]) Object.assign(s.rel.edge(x, y), { trust: 0.95, affinity: 0.95 });
    expect(s.perceivedBond(holder!, a!, b!), "only the pair's hidden bond moved").toBe(base);
    scene(sb, "bonding", [a!, b!], [holder!]);
    const warm = s.perceivedBond(holder!, a!, b!);
    expect(warm).toBeGreaterThan(base);
    scene(sb, "conflict", [a!, b!], [holder!]);
    scene(sb, "conflict", [a!, b!], [holder!]);
    expect(s.perceivedBond(holder!, a!, b!)).toBeLessThan(warm);
    // how warm someone is to the HOLDER is the holder's perception, never the other's hidden edge (the player included)
    const toMe = s.perceivedBond(holder!, PLAYER, holder!);
    Object.assign(s.rel.edge(PLAYER, holder!), { trust: 0.99, affinity: 0.99 });
    expect(s.perceivedBond(holder!, PLAYER, holder!)).toBe(toMe);
  });

  it("8b. unplayed (headless) games keep the ORW-539 v2 blend with the true bond, byte-identical", () => {
    const { s, npcs } = game(false);
    const [holder, a, b] = npcs;
    const base = s.perceivedBond(holder!, a!, b!);
    for (const [x, y] of [[a!, b!], [b!, a!]]) Object.assign(s.rel.edge(x, y), { trust: 0.95, affinity: 0.95 });
    expect(s.perceivedBond(holder!, a!, b!)).toBeGreaterThan(base);
  });
});
