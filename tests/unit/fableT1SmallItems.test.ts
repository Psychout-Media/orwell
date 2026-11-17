import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chooseHourAction, type HourView } from "../../src/engine/houseLife";
import { recheckAgenda, isAgendaSuperset, type Agenda, type AgendaBoard, type AgendaView, type Goal } from "../../src/engine/agenda";
import { blameForTargeting, TARGETS_ME_READ } from "../../src/engine/beliefDecisions";
import { newLiveSeason, advance, type SeasonCtx, type LiveSeasonState } from "../../src/engine/liveSeason";
import { REASONS } from "../../src/engine/agendaConstants";
import { RelationshipModel } from "../../src/engine/relationships";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import { FileSaveStore } from "../../src/adapters/engine/FileSaveStore";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER, npc, type EntityId } from "../../src/domain/ids";
import type { Room } from "../../src/domain/house";

/**
 * ORW-581 (Fable audit T1-14, the smaller items). Roles only (holder, owner, HOH, nominee, candidate, NPC, player).
 *  1. a second house-life stretch in the same game hour rolls fresh dice (it used to replay the first one's choices);
 *  2. in a played game the secret-veto replacement is named with the same read as any veto replacement (shields, agenda, memory...);
 *  3. the "they are targeting me" read never writes, the claims are written at commit time, and who gets blamed comes from the holder's own read;
 *  4. week goals dropped when a week is re-formed are kept in history;
 *  5. the conflict tally and the raised-memory record survive a restart.
 */
type Any = Record<string, any>;

// --- 1. house life: a repeated hour --------------------------------------------------------------------------------------------------

const HOLDER = "npc:1", NPC_B = "npc:2", NPC_C = "npc:3", NPC_D = "npc:4";
function hourView(owner: string, over: Partial<HourView> = {}): HourView {
  const goal = (kind: Goal["kind"], target: string, commitment: number): Goal => ({
    id: `${owner}:${kind}:${target}`, owner, horizon: "week", kind, target, why: [{ kind: "character", weight: 1 }], test: { kind: "survives-week" }, commitment, status: "active", formedDay: 1, formedWeek: 1,
  });
  return {
    owner, character: { archetype: "analyst", strategyStyle: "social", secretKinds: [] },
    agenda: { owner, goals: [goal("get-them-out", NPC_C, 0.5), goal("pull-them-in", NPC_D, 0.5)], history: [], formedForWeek: 1 },
    habits: [], emotional: 0.5, room: "living-room",
    whereabouts: new Map<string, Room>([[owner, "living-room"], [NPC_B, "living-room"], [NPC_C, "kitchen"], [NPC_D, "living-room"], [PLAYER, "backyard"]]),
    affinity: new Map([[NPC_B, 0.6], [NPC_C, 0.3], [NPC_D, 0.5], [PLAYER, 0.5]]), threat: new Map([[NPC_C, 0.6], [NPC_B, 0.2]]),
    mates: [], nominees: [], timeOfDay: "afternoon", day: 3, hour: 14, inCompetition: false, candor: 0.6, ...over,
  };
}
const planKey = (p: { kind: string; with: string[]; place: string; truthful: boolean }): string => `${p.kind}|${p.with.join(",")}|${p.place}|${p.truthful}`;

describe("1. a second house-life stretch in the same game hour rolls fresh dice", () => {
  it("the first stretch of an hour keys exactly as before (repeat 0 = absent); a repeat of the hour does not replay it", () => {
    let differ = 0;
    const N = 60;
    for (let i = 0; i < N; i++) {
      const v = hourView(`npc:${10 + i}`, { hour: 8 + (i % 14), day: 2 + Math.floor(i / 14) });
      const first = chooseHourAction(v, 91);
      expect(chooseHourAction({ ...v, repeat: 0 }, 91), "repeat 0 is the old key").toEqual(first);
      if (planKey(chooseHourAction({ ...v, repeat: 1 }, 91)) !== planKey(first)) differ++;
    }
    // Same view, same hour: before ORW-581 every repeat was identical (differ = 0). Fresh dice change a good share of the hours.
    expect(differ, `hours whose repeat chose differently: ${differ}/${N}`).toBeGreaterThanOrEqual(N / 4);
  });

  it("in a played game the adapter counts the stretches lived in one game hour (and starts over in a new hour)", () => {
    const s = played(mkdtempSync(join(tmpdir(), "orw581-life-")));
    expect(s.houseLifeActiveNow(), "house life runs in a played game").toBe(true);
    const store = { count: () => 0, record: () => undefined } as Any; // the stretch's events are not under test here
    const awake = (s.livingIds() as string[]).filter((id) => id !== PLAYER);
    const abs = s.inGameAbsHour() as number;
    expect(abs).toBeDefined();
    s.houseLifeStretch(store, awake, 0);
    expect(s.live.lifeHour).toEqual({ at: abs, n: 0 });
    s.houseLifeStretch(store, awake, 1);
    expect(s.live.lifeHour, "the second stretch of the same hour is a repeat").toEqual({ at: abs, n: 1 });
    s.live.lifeHour = { at: abs - 1, n: 4 };
    s.houseLifeStretch(store, awake, 2);
    expect(s.live.lifeHour, "a new hour starts at 0").toEqual({ at: abs, n: 0 });
  });
});

// --- 2. the secret-veto replacement read --------------------------------------------------------------------------------------------

const mkCtx = (over: Partial<SeasonCtx> = {}): SeasonCtx => ({ player: PLAYER, statsOf: () => ({ physical: 0.5, mental: 0.5, social: 0.5 }), rel: new RelationshipModel(0.5), ...over });
/** HOH npc(6); nominees npc(1) (holds the secret veto, an NPC) and npc(2); `top` is the HOH's biggest threat among the options, `next` trails it. */
function secretVetoReplacement(ctx: SeasonCtx, top: EntityId, next: EntityId, playedGame: boolean): { s: LiveSeasonState; replacement: EntityId } {
  const active = [PLAYER, npc(1), npc(2), npc(3), npc(4), npc(5), npc(6)];
  const s = newLiveSeason(active);
  s.beat = "eviction"; s.hoh = npc(6); s.nominees = [npc(1), npc(2)]; s.finalNominees = [npc(1), npc(2)]; s.secretVeto = { holder: npc(1), used: false };
  if (playedGame) s.playedGame = true;
  for (const c of active) if (c !== npc(6)) ctx.rel.edge(npc(6), c).threat = 0.1;
  ctx.rel.edge(npc(6), top).threat = 0.6;
  ctx.rel.edge(npc(6), next).threat = 0.45;
  advance(s, ctx, new SeededRandom(3));
  return { s, replacement: s.finalNominees!.find((n) => n !== npc(2))! };
}
const shielding = (shielded: EntityId) => ({ agendaPullFor: (t: EntityId) => ({ value: t === shielded ? -(REASONS.shieldFloor + 0.2) : 0 }) });

describe("2. the secret-veto replacement reads like any veto replacement in a played game", () => {
  it("the HOH's agenda shield keeps a protected houseguest off the block (the legacy threat-only read named them anyway)", () => {
    const shield = shielding(npc(3));
    expect(secretVetoReplacement(mkCtx(shield), npc(3), npc(4), false).replacement, "headless: the legacy read, byte for byte").toBe(npc(3));
    const { s, replacement } = secretVetoReplacement(mkCtx(shield), npc(3), npc(4), true);
    expect(replacement, "played: the shielded houseguest is not named while a legal alternative remains").toBe(npc(4));
    expect(s.secretVeto?.used).toBe(true);
    const why = (s.decisionWhy ?? []).filter((w) => w.kind === "secret-veto-replacement");
    expect(why.length, "the reason is filed under the secret-veto kind").toBe(1);
    expect(why[0]!.options[0]!.option).toBe(npc(4));
  });

  it("the player is read by the same rules: named when they are the HOH's top read, kept off by the same shield", () => {
    expect(secretVetoReplacement(mkCtx(), PLAYER, npc(4), true).replacement, "no exemption for the player").toBe(PLAYER);
    expect(secretVetoReplacement(mkCtx(shielding(PLAYER)), PLAYER, npc(4), true).replacement, "a shield on the player works as on anyone").toBe(npc(4));
  });

  it("the HOH's memory reaches the played read too (the normal replacement's memory term)", () => {
    const grudge = { memoryTiltFor: (t: EntityId) => (t === npc(4) ? 0.3 : 0) };
    expect(secretVetoReplacement(mkCtx(grudge), npc(3), npc(4), true).replacement).toBe(npc(4));
  });
});

// --- 3. the targets-me read ---------------------------------------------------------------------------------------------------------

describe("3a. who a houseguest blames for a campaign comes from their own read (pure)", () => {
  const BASE = { trust: 0.25, threat: 0.1 };
  const OWNER = "npc:o", OTHERS = ["npc:x", "npc:y", PLAYER];
  const rate = (trust: number, threat: number, threats: Record<string, number> = {}): number => {
    let wrong = 0;
    for (let i = 0; i < 2000; i++) {
      const rng = new SeededRandom(1000 + i);
      const read = { trust: (id: string) => (id === OWNER ? trust : 0.25), threat: (id: string) => (id === OWNER ? threat : threats[id] ?? 0.1) };
      if (blameForTargeting(OWNER, OTHERS, read, BASE, () => rng.next()) !== OWNER) wrong++;
    }
    return wrong / 2000;
  };
  it("a baseline read misattributes at the old rate; trusting the owner makes it likelier, fearing them makes it rarer", () => {
    expect(rate(0.25, 0.1)).toBeCloseTo(TARGETS_ME_READ.baseWrong, 1);
    expect(rate(0.8, 0.1)).toBeGreaterThan(rate(0.25, 0.1) + 0.1);
    expect(rate(0.1, 0.7)).toBeLessThan(rate(0.25, 0.1) - 0.1);
  });
  it("a wrong name falls on whoever they already fear most, the player included; nobody else to blame => the owner", () => {
    const blamed = new Map<string, number>();
    for (let i = 0; i < 400; i++) {
      const rng = new SeededRandom(7000 + i);
      const read = { trust: (id: string) => (id === OWNER ? 0.9 : 0.25), threat: (id: string) => (id === PLAYER ? 0.7 : 0.1) };
      const b = blameForTargeting(OWNER, OTHERS, read, BASE, () => rng.next());
      blamed.set(b, (blamed.get(b) ?? 0) + 1);
    }
    expect([...blamed.keys()].sort(), "only the owner or the most-feared other").toEqual([OWNER, PLAYER].sort());
    expect(blameForTargeting(OWNER, [], { trust: () => 1, threat: () => 0 }, BASE, () => 0)).toBe(OWNER);
  });
});

describe("3b. in a played game the scoring read never writes; the claims are written at commit time, once per campaign and week", () => {
  function planted(playedGame: boolean, campaigns = 1): { s: Any; holder: string; owner: string } {
    const s = playedGame ? played(mkdtempSync(join(tmpdir(), "orw581-bel-"))) : headless();
    s.setNpcBeliefsEnabled(true); s.setNpcBeliefNomsEnabled(true);
    const npcs = (s.live.active as string[]).filter((x) => x !== PLAYER);
    const [holder, owner] = [npcs[0]!, npcs[1]!];
    s.campaigns = Array.from({ length: campaigns }, (_, i) => ({ id: `camp-${i}`, owners: [owner], goal: "evict", target: holder, plan: [], progress: 0.4, horizon: "week", status: "active", startedBeat: 0, deadlineBeat: 99, confidence: 0.6, knownTo: [owner, holder] }));
    return { s, holder, owner };
  }
  const targetsMe = (s: Any, holder: string): Any[] => (s.live.beliefs?.[holder] ?? []).filter((c: Any) => c.kind === "targets-me");

  it("played: scoring writes nothing; the commit-time step writes the claim; the read then sees it", () => {
    const { s, holder, owner } = planted(true);
    const before = JSON.stringify(s.live.beliefs ?? null);
    expect(s.beliefNomTiltFor(owner, holder)).toBe(0);
    expect(JSON.stringify(s.live.beliefs ?? null), "a scoring read must not write").toBe(before);
    s.syncTargetsMeClaims();
    const claims = targetsMe(s, holder);
    expect(claims.length).toBe(1);
    expect(s.beliefNomTiltFor(claims[0]!.subject, holder)).toBeGreaterThan(0);
  });

  it("headless: the legacy write-on-read is unchanged (the seeded spine stays byte-identical)", () => {
    const { s, holder, owner } = planted(false);
    s.beliefNomTiltFor(owner, holder);
    expect(targetsMe(s, holder).length).toBe(1);
  });

  it("the blame is settled once per campaign and week: a later change of heart does not add a second, different name", () => {
    const { s, holder, owner } = planted(true, 24);
    s.rel.edge(holder, owner).trust = 0.0; s.rel.edge(holder, owner).threat = 0.9; // they fear the owner: almost always the right name
    s.syncTargetsMeClaims();
    expect(targetsMe(s, holder).length).toBe(24);
    s.rel.edge(holder, owner).trust = 1.0; s.rel.edge(holder, owner).threat = 0.0; // now they trust them: a fresh roll would often look elsewhere
    s.syncTargetsMeClaims(); s.syncTargetsMeClaims();
    expect(targetsMe(s, holder).length, "still one claim per campaign").toBe(24);
  });
});

// --- 4. week goals re-formed at the week boundary -----------------------------------------------------------------------------------

describe("4. week goals dropped when the week is re-formed stay in history", () => {
  it("a week goal still held from last week ends 'failed: week closed' in history, and the agenda stays a superset", () => {
    const H = "npc:1", T = "npc:2";
    const house = [H, T, "npc:3", "npc:4", "npc:5", PLAYER];
    const old: Goal = { id: `${H}:get-them-out:${T}:w1`, owner: H, horizon: "week", kind: "get-them-out", target: T, why: [{ kind: "threat-read", about: T, weight: 0.7 }],
      test: { kind: "evicted", who: T }, commitment: 0.7, status: "active", formedDay: 1, formedWeek: 1 };
    const season: Goal = { id: `${H}:reach-jury`, owner: H, horizon: "season", kind: "reach-jury", why: [{ kind: "character", weight: 0.6 }], test: { kind: "survives-week" }, commitment: 0.6, status: "active", formedDay: 1, formedWeek: 1 };
    const prev: Agenda = { owner: H, goals: [season, old], history: [], formedForWeek: 1 };
    const view: AgendaView = { owner: H, character: { archetype: "analyst", strategyStyle: "social", secretKinds: [] }, threats: [{ toward: T, threat: 0.7 }], affinity: [], grudges: [], emotional: 0.5,
      allianceMates: [], secretExposed: false, openQuestions: [], answered: [], powerWins: 0 };
    const board: AgendaBoard = { day: 8, week: 2, inHouse: house, evicted: [], juryStarted: false, finalFive: false, nominees: [], weekClosed: false };
    const next = recheckAgenda(prev, view, board, "night", 4242);
    expect(next.formedForWeek).toBe(2);
    expect(next.goals.some((g) => g.id === old.id), "last week's goal is no longer held").toBe(false);
    const kept = next.history.find((g) => g.id === old.id);
    expect(kept, "and it is not lost: it is in history").toBeDefined();
    expect(kept).toMatchObject({ status: "failed", endNote: "week closed", resolvedDay: 8 });
    expect(isAgendaSuperset(prev, next)).toBe(true);
  });
});

// --- 5. restart parity ------------------------------------------------------------------------------------------------------------

function played(d: string): Any {
  const s = new GameSessionRegistry(new FileSaveStore(d)).sandboxFor("u").session as unknown as Any;
  s.createCharacter({ playerName: "P", seed: 5 });
  s.noteMessage({ messageId: "m1" });
  s.advanceGame(); s.advanceGame();
  return s;
}
function headless(): Any {
  const s = new GameSessionRegistry().sandboxFor(`orw581-${Math.random()}`).session as unknown as Any;
  s.createCharacter({ playerName: "P", seed: 5 });
  s.advanceGame(); s.advanceGame();
  return s;
}
const reload = (d: string): Any => new GameSessionRegistry(new FileSaveStore(d)).sandboxFor("u").session as unknown as Any;

describe("5. tonight's conflicts and the raised memories survive a restart", () => {
  it("the per-night conflict tally is saved and restored: the same houseguests turn in at the same hour after a reload", () => {
    const d = mkdtempSync(join(tmpdir(), "orw581-nc-"));
    const s = played(d);
    const [a, b] = (s.live.active as string[]).filter((x) => x !== PLAYER);
    s.nightConflicts.set(a, 2); s.nightConflicts.set(b, 1);
    s.persist();
    const r = reload(d);
    expect(Object.fromEntries(r.nightConflicts)).toEqual(Object.fromEntries(s.nightConflicts));
    expect(r.nightConflicts.get(a)).toBeGreaterThanOrEqual(2);
    expect(r.effectiveBedDepth(a)).toBe(s.effectiveBedDepth(a));
  });

  it("a memory already raised today is not raised again after a reload (the record is saved, not process memory)", () => {
    const d = mkdtempSync(join(tmpdir(), "orw581-bu-"));
    const s = played(d);
    const npcs = (s.live.active as string[]).filter((x) => x !== PLAYER);
    let speaker: string | undefined;
    for (const id of npcs) {
      (s.live.npcMemory ??= {})[id] = { [PLAYER]: [{ kind: "deal-broken", week: s.live.week, severity: 1 }] };
      if (s.memorySpeechFor(id).bringUp) { speaker = id; break; }
    }
    expect(speaker, "some houseguest raises the memory").toBeDefined();
    expect(s.memorySpeechFor(speaker!).bringUp, "not twice").toBeUndefined();
    s.persist();
    const r = reload(d);
    expect(r.memorySpeechFor(speaker!)).toEqual(s.memorySpeechFor(speaker!));
    expect(r.memorySpeechFor(speaker!).bringUp, "the reloaded house does not raise it again").toBeUndefined();
  });
});
