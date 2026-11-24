import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";
import type { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import type { BeliefStore } from "../../src/engine/beliefStore";
import type { ClaimLog } from "../../src/engine/spokenClaims";
import { COMING_CLEAN, versionsAbout, cleanActsSuperset, type CleanAct } from "../../src/engine/comingClean";
import { caughtLieTrustDrop, CAUGHT_LIE } from "../../src/engine/caughtLies";

/** 0203 (ORW-646) the build: the adapter acts, the NPC decision tick, the player both ways, flag-off and headless identity, save, wall. Roles only. */
type Live = { week: number; dayNumber?: number; playedGame?: boolean; beliefs?: BeliefStore; claims?: ClaimLog; cleanActs?: CleanAct[]; cleanDay?: number };
type Priv = { live: Live; onPlayerEvent?: (c: string, w: EntityId[], t?: string) => string | undefined; comingCleanTick(): void };
const START = { trust: 0.6, affinity: 0.6, threat: 0.2, alignment: 0.3, confidence: 0.4, reliability: 0.5 };

function season(tag: string, played = true) {
  const sb = new GameSessionRegistry().sandboxFor(`orw646-${tag}`);
  const s = sb.session as GameSessionAdapter;
  s.setNpcBeliefsEnabled(true); s.setLiesCaughtEnabled(true); s.setCredibilityEnabled(true);
  s.createCharacter({ playerName: "P", seed: 7 });
  const [liar, a, b, ally, subject] = s.livingIds().filter((id) => id !== PLAYER) as EntityId[];
  const p = s as unknown as Priv;
  p.live.week = 2; p.live.dayNumber = 3; if (played) p.live.playedGame = true;
  const edge = (x: EntityId, y: EntityId) => sb.engine.relationships.edge(x, y);
  for (const x of [a!, b!, ally!]) { Object.assign(edge(x, liar!), START); Object.assign(edge(liar!, x), START); }
  const events: Array<{ text: string; w: EntityId[] }> = [];
  p.onPlayerEvent = (text, w) => { events.push({ text, w }); return "e"; };
  const lie = (listener: EntityId, kind: "going-after" | "talking-about" = "going-after", speaker: EntityId = liar!) =>
    s.tellClaim({ speaker, listener, kind, subject: subject!, object: kind === "going-after" ? a! : b!, isTrue: false, intent: "mislead" })!;
  return { s, p, edge, liar: liar!, a: a!, b: b!, ally: ally!, subject: subject!, lie, events };
}
const planted = (p: Priv, holder: EntityId, id: string) => (p.live.beliefs?.[holder] ?? []).find((c) => c.id.endsWith(`|${id}`));

describe("0203 confess first", () => {
  it("costs strictly less than being caught, plants no lied-to-me, refutes the belief, and happens once", () => {
    const caught = season("caught");
    const c1 = caught.lie(caught.a);
    caught.s.tellClaim({ speaker: caught.liar, listener: caught.a, kind: "final-two-with", subject: caught.subject, object: caught.a, isTrue: false, intent: "mislead" }); // contradicts the going-after lie told earlier
    const caughtDrop = START.trust - caught.edge(caught.a, caught.liar).trust;
    expect(c1.isTrue).toBe(false);
    expect(caughtDrop).toBeGreaterThan(0);

    const owned = season("owned");
    const c = owned.lie(owned.a);
    const before = owned.edge(owned.a, owned.liar).trust;
    expect(owned.s.confess(owned.liar, owned.a, c.id)).toBe(true);
    const drop = before - owned.edge(owned.a, owned.liar).trust;
    expect(drop).toBeGreaterThan(0);
    expect(drop).toBeLessThan(caughtLieTrustDrop(CAUGHT_LIE.contradiction) + 1e-9);
    expect(drop).toBeCloseTo(COMING_CLEAN.confessShare * caughtLieTrustDrop(1), 12);
    expect(drop).toBeLessThan(caughtDrop);
    expect(planted(owned.p, owned.a, c.id)?.refuted).toBe(true);
    expect((owned.p.live.beliefs?.[owned.a] ?? []).some((x) => x.kind === "lied-to-me")).toBe(false);
    expect(owned.s.credibilityOf(owned.a, owned.liar)).toBe(1);
    expect(owned.p.live.cleanActs).toEqual([{ kind: "confess", by: owned.liar, to: owned.a, claimId: c.id, week: 2 }]);
    expect(owned.s.confess(owned.liar, owned.a, c.id)).toBe(false); // once per claim and listener
  });
  it("refuses a true claim, someone else's claim, the wrong listener, and a claim already caught", () => {
    const t = season("refuse");
    const lie = t.lie(t.a);
    const truth = t.s.tellClaim({ speaker: t.liar, listener: t.a, kind: "talking-about", subject: t.subject, object: t.b, isTrue: true, intent: "inform" })!;
    expect(t.s.confess(t.liar, t.a, truth.id)).toBe(false);
    expect(t.s.confess(t.b, t.a, lie.id)).toBe(false);
    expect(t.s.confess(t.liar, t.b, lie.id)).toBe(false);
    t.s.tellClaim({ speaker: t.liar, listener: t.a, kind: "final-two-with", subject: t.subject, object: t.a, isTrue: false, intent: "mislead" }); // caught by contradiction
    expect(t.s.confess(t.liar, t.a, lie.id)).toBe(false);
  });
});

describe("0203 loop an ally in", () => {
  it("raises the ally's trust, hands them the fact as a held rumor they can pass on, and is once per ally", () => {
    const t = season("loop");
    const c = t.lie(t.a);
    const before = t.edge(t.ally, t.liar).trust;
    expect(t.s.loopIn(t.liar, t.ally, c.id)).toBe(true);
    expect(t.edge(t.ally, t.liar).trust).toBeGreaterThan(before);
    const held = planted(t.p, t.ally, `loopin:${c.id}`)!;
    expect(held).toMatchObject({ kind: "heard-rumor", nature: "lying", subject: t.liar, object: t.a, source: t.liar, confidence: COMING_CLEAN.loopInConfidence });
    expect(planted(t.p, t.a, c.id)?.refuted).toBeFalsy(); // the listener still believes it: it is not told
    expect(t.s.loopIn(t.liar, t.ally, c.id)).toBe(false);
    expect(t.s.loopIn(t.liar, t.a, c.id)).toBe(false); // never the one lied to
    expect(t.p.live.cleanActs).toEqual([{ kind: "loop-in", by: t.liar, to: t.ally, claimId: c.id, toldTo: t.a, week: 2 }]);
  });
});

describe("0203 different versions to different people", () => {
  it("each version is tracked claim by claim: one confessed, one looped in, bounded and traceable", () => {
    const t = season("versions");
    const v1 = t.lie(t.a, "going-after"), v2 = t.lie(t.b, "talking-about");
    expect(t.s.confess(t.liar, t.a, v1.id)).toBe(true);
    expect(t.s.loopIn(t.liar, t.ally, v2.id)).toBe(true);
    expect(t.s.confess(t.liar, t.a, v1.id)).toBe(false);
    expect(t.s.loopIn(t.liar, t.ally, v2.id)).toBe(false);
    const v = versionsAbout(t.p.live.claims!.items, t.liar, t.subject, t.p.live.cleanActs!);
    expect(v.map((x) => [x.claim.listener, x.claim.kind, x.confessedTo, x.loopedIn])).toEqual([[t.a, "going-after", [t.a], []], [t.b, "talking-about", [], [t.ally]]]);
    expect(t.p.live.cleanActs).toHaveLength(2);
    expect(planted(t.p, t.b, v2.id)?.refuted).toBeFalsy(); // b still holds their version
  });
});

describe("0203 the NPC decision", () => {
  /** A lie at maximum read risk: the listener doubts it, another version reached someone close to them, the subject is close to the listener. */
  function risky(tag: string) {
    const t = season(tag);
    const c = t.lie(t.a);
    t.lie(t.b, "talking-about");
    for (const [x, y] of [[t.a, t.b], [t.b, t.a], [t.a, t.subject]] as const) Object.assign(t.edge(x, y), { trust: 0.9, affinity: 0.9 });
    planted(t.p, t.a, c.id)!.confidence = 0.2;
    return { t, c };
  }
  const run = (t: ReturnType<typeof season>, days: number) => { for (let d = 4; d < 4 + days; d++) { t.p.live.dayNumber = d; t.p.comingCleanTick(); } return t.p.live.cleanActs ?? []; };
  it("at risk, a liar eventually comes clean on their own roll; it is deterministic, at most one act per speaker per day, and only once per lie", () => {
    const a = run(risky("npc1").t, 30), b = run(risky("npc2").t, 30);
    expect(a.length).toBeGreaterThan(0);
    expect(b).toEqual(a);
    const t = risky("npc3");
    t.t.p.live.dayNumber = 9; t.t.p.comingCleanTick(); t.t.p.comingCleanTick();
    expect((t.t.p.live.cleanActs ?? []).length).toBeLessThanOrEqual(1);
    expect(run(t.t, 40).filter((x) => x.kind === "confess" && x.claimId === t.c.id).length).toBeLessThanOrEqual(1);
  });
  it("with nothing to fear nobody confesses", () => {
    const t = season("calm");
    t.lie(t.a);
    for (const x of [t.a, t.b]) Object.assign(t.edge(x, t.subject), { trust: 0.1, affinity: 0.1 });
    expect(run(t, 40)).toEqual([]);
  });
  it("flag off, or not a played game: nothing runs, nothing is written", () => {
    const off = risky("flagoff").t; off.s.setComingCleanEnabled(false);
    expect(run(off, 30)).toEqual([]); expect(off.p.live.cleanDay).toBeUndefined();
    const headless = (() => { const r = risky("headless"); r.t.p.live.playedGame = false; return r.t; })();
    expect(run(headless, 30)).toEqual([]); expect(headless.p.live.cleanDay).toBeUndefined();
    expect(headless.s.confess(headless.liar, headless.a, "claim:1")).toBe(false);
  });
});

describe("0203 the player, both directions (unit: the lie is told through the engine seam by hand; ORW-808 plays it in tests/realpath/comingCleanPlayer.test.ts)", () => {
  it("the player owns their own lie in their own words: the listener's trust moves by the confession cost; only the player's own open lie counts", () => {
    const t = season("player");
    const c = t.lie(t.a, "going-after", PLAYER);
    t.lie(t.b, "going-after", t.liar); // someone else's lie is never the player's to confess
    const before = t.edge(t.a, PLAYER).trust;
    expect(t.s.playerConfess({ to: t.b })).toEqual({ accepted: false, reason: "no-lie" });
    expect(t.s.playerConfess({ to: t.a })).toEqual({ accepted: true });
    expect(before - t.edge(t.a, PLAYER).trust).toBeCloseTo(COMING_CLEAN.confessShare * caughtLieTrustDrop(1), 12);
    expect(planted(t.p, t.a, c.id)?.refuted).toBe(true);
    expect(t.events, "the player's own words are the recorded scene; the engine authors none").toEqual([]);
    expect(t.s.playerConfess({ to: t.a })).toEqual({ accepted: false, reason: "no-lie" });
  });
  it("the player loops an ally in on their own lie to someone else", () => {
    const t = season("player-loop");
    const c = t.lie(t.a, "going-after", PLAYER);
    expect(t.s.playerLoopIn({ ally: t.ally, to: t.a })).toEqual({ accepted: true });
    expect(planted(t.p, t.ally, `loopin:${c.id}`)).toMatchObject({ nature: "lying", subject: PLAYER, object: t.a });
  });
  it("a houseguest owns a lie told to the player, and loops someone in on it; the player hears words only, no number and no engine truth", () => {
    const t = season("to-player");
    const c = t.lie(PLAYER);
    expect(t.s.confess(t.liar, PLAYER, c.id)).toBe(true);
    const c2 = t.lie(PLAYER, "talking-about");
    expect(t.s.loopIn(t.liar, t.ally, c2.id)).toBe(true);
    expect(t.events).toHaveLength(1);
    expect(t.events[0]!.w).toEqual([t.liar, PLAYER]);
    expect(t.events[0]!.text).not.toMatch(/\d|lie|lied|trust|belie|claim|isTrue|confess/i);
  });
});

describe("0203 the statement door: retracts / tellsAbout (unit; played in tests/realpath/comingCleanPlayer.test.ts)", () => {
  it("applies a valid retraction once, and drops a false, not-own, wrong-listener or flag-off one", () => {
    const t = season("door");
    const own = t.lie(t.a, "going-after", PLAYER);
    t.s.tellClaim({ speaker: PLAYER, listener: t.b, kind: "talking-about", subject: t.subject, object: t.a, isTrue: true, intent: "inform", origin: "player" }); // a TRUE claim: nothing to retract
    t.lie(t.ally, "going-after", t.liar); // a houseguest's lie, not the player's
    expect(t.s.recordPlayerStatement({ to: t.b, retracts: true })).toEqual({ accepted: false, reason: "no-lie" }); // only a true claim told there
    expect(t.s.recordPlayerStatement({ to: t.ally, retracts: true })).toEqual({ accepted: false, reason: "no-lie" }); // the houseguest's lie is not the player's
    expect(t.s.recordPlayerStatement({ to: t.subject, retracts: true })).toEqual({ accepted: false, reason: "no-lie" }); // told nothing
    expect(t.s.recordPlayerStatement({ to: t.a, retracts: true, about: t.b })).toEqual({ accepted: false, reason: "no-lie" }); // wrong subject
    expect(t.p.live.cleanActs).toBeUndefined();
    expect(t.s.recordPlayerStatement({ to: t.a, retracts: true })).toEqual({ accepted: true });
    expect(t.s.recordPlayerStatement({ to: t.a, retracts: true })).toEqual({ accepted: false, reason: "no-lie" }); // once
    expect(planted(t.p, t.a, own.id)?.refuted).toBe(true);
    expect(t.p.live.cleanActs).toHaveLength(1);
    t.s.setComingCleanEnabled(false);
    expect(t.s.recordPlayerStatement({ to: t.a, retracts: true })).toEqual({ accepted: false, reason: "off" });
  });
  it("a loop-in tells an ally about a lie told to someone ELSE; the ally can't be the one lied to; both fields together are refused", () => {
    const t = season("door2");
    const own = t.lie(t.a, "going-after", PLAYER);
    expect(t.s.recordPlayerStatement({ to: t.a, tellsAbout: t.a })).toEqual({ accepted: false, reason: "no-lie" });
    expect(t.s.recordPlayerStatement({ to: t.ally, tellsAbout: t.b })).toEqual({ accepted: false, reason: "no-lie" }); // nothing told to b
    expect(t.s.recordPlayerStatement({ to: t.ally, tellsAbout: t.a, retracts: true })).toEqual({ accepted: false, reason: "bad-shape" });
    expect(t.s.recordPlayerStatement({ to: t.ally, tellsAbout: t.a })).toEqual({ accepted: true });
    expect(t.s.recordPlayerStatement({ to: t.ally, tellsAbout: t.a })).toEqual({ accepted: false, reason: "no-lie" });
    expect(planted(t.p, t.ally, `loopin:${own.id}`)).toBeDefined();
  });
  it("the old statement form is unchanged", () => {
    const t = season("door3");
    t.s.setPromiseTermsEnabled?.(true);
    expect(t.s.recordPlayerStatement({ to: t.a, about: t.b, kind: "not-a-kind" }).accepted).toBe(false);
  });
});

describe("0203 save, restore and the wall", () => {
  it("the record is append-only: a save that lost an act is not a superset", () => {
    const a: CleanAct = { kind: "confess", by: "npc:x", to: "npc:y", claimId: "claim:1", week: 1 };
    const b: CleanAct = { kind: "loop-in", by: "npc:x", to: "npc:z", claimId: "claim:1", toldTo: "npc:y", week: 1 };
    expect(cleanActsSuperset([a, b], [a])).toBe(true);
    expect(cleanActsSuperset([a], [a, b])).toBe(false);
    expect(cleanActsSuperset(undefined, undefined)).toBe(true);
  });
  it("a snapshot round-trip keeps every act, and the player-facing reads never carry a claim id, a lie marker or a loop-in belief", async () => {
    const t = season("wall");
    const c = t.lie(t.a); const c2 = t.lie(t.b, "talking-about");
    t.s.confess(t.liar, t.a, c.id); t.s.loopIn(t.liar, t.ally, c2.id);
    const acts = JSON.parse(JSON.stringify(t.p.live.cleanActs));
    expect(acts).toHaveLength(2);
    const read = t.s as unknown as { getGameState(): unknown; gameStatus(): unknown; stateDelta(n: number): unknown; seasonRecap(): unknown; playerDossier(): unknown };
    const surfaces: unknown[] = [read.getGameState(), read.gameStatus(), read.stateDelta(0), read.seasonRecap(), read.playerDossier()];
    expect(surfaces.every((x) => x !== undefined), "every read really ran").toBe(true);
    const wire = JSON.stringify(surfaces);
    for (const needle of ["cleanActs", "loop-in", "loopin:", "confess", c.id, c2.id, "\"isTrue\"", "lying"]) expect(wire, needle).not.toContain(needle);
  });
});
