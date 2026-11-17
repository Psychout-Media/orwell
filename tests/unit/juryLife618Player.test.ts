import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { GameSessionRegistry } from "../../src/composition/registry";
import type { McpServer } from "../../src/adapters/mcp/McpServer";
import { claimProblem, liesBy, type ClaimInput } from "../../src/engine/spokenClaims";
import { decideTellToPlayer, tellChance, toPlayerKey } from "../../src/engine/claimsToPlayer";
import { hashSeed } from "../../src/engine/characterFactory";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import { buildSandbox } from "../support/sandbox";
import { plantLiveSentinels } from "../support/liveSentinelPlanting";
import { PLAYER, npc } from "../../src/domain/ids";
import type { BeliefClaim } from "../../src/engine/beliefStore";

/** ORW-618 (0189 part 2): the player as a juror, both directions, through the existing claim machinery. Roles only. */
const OTHER_JURORS = Array.from({ length: 8 }, (_, i) => npc(i + 1));
const FINALIST = npc(14), OTHER_FINALIST = npc(9);
const PRE_JURY = [npc(10), npc(11), npc(12), npc(13), npc(15)];

function rig(seed: number, opts: { playerJuror?: boolean } = {}) {
  const sb = buildSandbox(seed);
  const session = new GameSessionAdapter();
  session.setRecordProviders({ events: () => sb.engine.events.queryAll(), hidden: () => sb.engine.vault.readHidden() });
  session.createCharacter({ playerName: "The Player", seed });
  session.noteMessage({ messageId: "m-1" } as never);
  session.setJuryHouseEnabled(true);
  const i = session as any;
  i.live.playedGame = true;
  i.live.beliefs = {};
  if (opts.playerJuror !== false) {
    i.live.evictionOrder = [...PRE_JURY, PLAYER, ...OTHER_JURORS];
    i.live.active = [OTHER_FINALIST, FINALIST];
  } else {
    i.live.evictionOrder = [...PRE_JURY, ...OTHER_JURORS, npc(9)];
  }
  return { session, i };
}
const belief = (holder: string, over: Partial<BeliefClaim> = {}): BeliefClaim =>
  ({ id: `${holder}|b`, holder, kind: "targets-me", subject: FINALIST, object: holder, value: true, origin: "told", confidence: 0.8, week: 1, ...over }) as BeliefClaim;
const input = (speaker: string, listener: string, over: Partial<ClaimInput> = {}): ClaimInput =>
  ({ speaker, listener, kind: "going-after", subject: FINALIST, object: listener, isTrue: false, intent: "inform", ...over }) as ClaimInput;
/** Ask for a juror's tell over many in-game days until one lands (bounded); each ask is a fresh decision. */
function tellUntil(i: any, juror: string, jury = true, max = 120) {
  for (let n = 0; n < max; n++) {
    i.live.dayNumber = 100 + n; i.disclosureEpoch = (i.disclosureEpoch ?? 0) + 1;
    const t = i.claimsToPlayerFor(juror, jury);
    if (t) return t;
  }
  return undefined;
}

describe("ORW-618 part 2 (1): the sequester holds", () => {
  it("the player is a juror: claims pass only between two jurors, never with anyone still in the house", () => {
    const { i } = rig(7001);
    expect(i.juryHouseView()).toBeDefined();
    expect(i.tellClaim(input(npc(1), PLAYER, { object: npc(1) } as never)) ?? i.tellClaim(input(npc(1), PLAYER))).toBeDefined();
    expect(i.tellClaim(input(PLAYER, npc(2), { subject: FINALIST, object: npc(2) }))).toBeDefined(); // the player tells a juror
    expect(i.tellClaim(input(FINALIST, PLAYER, { subject: npc(3), object: PLAYER }))).toBeUndefined(); // a houseguest never speaks to the juror-player
    expect(i.tellClaim(input(PLAYER, FINALIST, { subject: npc(3), object: FINALIST }))).toBeUndefined(); // nor the player to them
    expect(i.tellClaim(input(npc(1), FINALIST, { subject: npc(3), object: FINALIST }))).toBeUndefined(); // nor a juror
    expect(i.tellClaim(input(FINALIST, npc(1), { subject: npc(3), object: npc(1) }))).toBeUndefined();
  });
  it("the player still in the house: nothing passes either way, and no juror confides", () => {
    const { i } = rig(7002, { playerJuror: false });
    expect(i.juryHouseView()).toBeUndefined();
    expect(i.juryPool()).toBeUndefined();
    i.live.beliefs[npc(1)] = [belief(npc(1))];
    Object.assign(i.rel.edge(npc(1), PLAYER), { trust: 0.95 });
    expect(i.tellClaim(input(npc(1), PLAYER))).toBeUndefined();
    expect(i.tellClaim(input(PLAYER, npc(1), { object: npc(1) }))).toBeUndefined();
    expect(tellUntil(i, npc(1), true, 40)).toBeUndefined();
  });
  it("the rule itself: without a jury the house rule is exactly as before; with one, only jury pairs widen", () => {
    expect(claimProblem(input("a", "b"), ["a", "b", FINALIST])).toBeUndefined();
    expect(claimProblem(input("a", "b"), [FINALIST])).toBe("not in the house");
    expect(claimProblem(input("a", "b"), [FINALIST], ["a", "b"])).toBeUndefined();
    expect(claimProblem(input("a", "b"), [FINALIST, "b"], ["a"])).toBe("not in the house");
    expect(claimProblem(input("a", FINALIST), [FINALIST], ["a", "b"])).toBe("not in the house");
  });
  it("a played-game, flag-on gate: off means the plain house rule", () => {
    const { i } = rig(7003);
    i.setJuryHouseEnabled(false);
    expect(i.juryPool()).toBeUndefined();
    expect(tellUntil(i, npc(1), true, 5)).toBeUndefined();
    i.setJuryHouseEnabled(true); i.live.playedGame = false;
    expect(i.juryPool()).toBeUndefined();
  });
});

describe("ORW-618 part 2 (2): juror to player carries only what the juror holds", () => {
  it("what is told is a held belief, as a band only: no truth, no intent, no claim id", () => {
    const { i } = rig(7004);
    i.live.beliefs[npc(1)] = [belief(npc(1))];
    Object.assign(i.rel.edge(npc(1), PLAYER), { trust: 0.95 });
    const t = tellUntil(i, npc(1));
    expect(t).toBeDefined();
    expect(Object.keys(t!).sort()).toEqual(["certainty", "kind", "object", "subject"]);
    expect(JSON.stringify(t)).not.toMatch(/isTrue|intent|claim:|"id"/);
    expect(["sure", "fairly-sure", "not-sure"]).toContain(t!.certainty);
  });
  it("the real ballot is never the source: with no belief held, a juror who voted tells nothing", () => {
    const { i } = rig(7005);
    i.live.voteRecord = [{ week: 3, evictee: npc(1), voteOf: { [npc(2)]: npc(1), [npc(3)]: npc(1), [OTHER_FINALIST]: npc(1) } }];
    i.live.finale = { stage: "vote", finalists: [OTHER_FINALIST, FINALIST], jury: [...OTHER_JURORS], votes: { [npc(2)]: FINALIST }, revealIx: 0 };
    for (const j of OTHER_JURORS) Object.assign(i.rel.edge(j, PLAYER), { trust: 0.95 });
    for (const j of OTHER_JURORS) expect(tellUntil(i, j, true, 60)).toBeUndefined();
    expect((i.live.claims?.items ?? []).length).toBe(0);
  });
  it("no lie is planted on the player in the jury house", () => {
    const { i } = rig(7006);
    i.live.agendas = { [npc(1)]: { goals: [{ kind: "get-them-out", target: FINALIST, status: "active" }] } };
    Object.assign(i.rel.edge(npc(1), PLAYER), { trust: 0.1 });
    expect(tellUntil(i, npc(1), true, 60)).toBeUndefined();
  });
  it("a juror tells only about what they hold, never a refuted belief", () => {
    const { i } = rig(7007);
    i.live.beliefs[npc(1)] = [belief(npc(1), { refuted: true })];
    Object.assign(i.rel.edge(npc(1), PLAYER), { trust: 0.95 });
    expect(tellUntil(i, npc(1), true, 60)).toBeUndefined();
  });
});

describe("ORW-618 part 2 (3): player to juror is the player's own words", () => {
  it("a spoken claim by the player lands as the juror's told belief, with its truth from engine records; a false one is a lie on the record", () => {
    const { i } = rig(7008);
    const told = i.tellNarratedClaim({ kind: "going-after", subject: FINALIST, object: npc(2) }, PLAYER, [npc(2)], [npc(2)]);
    expect(told.length).toBe(1);
    expect(told[0].speaker).toBe(PLAYER);
    const held = (i.live.beliefs[npc(2)] ?? []).find((b: BeliefClaim) => b.source === PLAYER);
    expect(held?.origin).toBe("told");
    expect(liesBy(i.live.claims, PLAYER).length).toBe(1); // the engine found it false: on the record, catchable like anyone's
  });
  it("through the open ledger: accepted among jurors; refused when it names anyone still in the house", () => {
    const { i } = rig(7009);
    const base = { text: "told them what I heard", kind: "claim", speaker: PLAYER, claim: { kind: "going-after", subject: FINALIST, object: npc(2) } };
    expect(i.recordOpenLedger({ ...base, addressedTo: [npc(2)] }).accepted).toBe(true);
    expect(i.recordOpenLedger({ ...base, text: "told the finalist", addressedTo: [FINALIST] }).accepted).toBe(false);
  });
  it("source: the engine never authors the player's claim (the player is only ever a speaker the narrator wrote)", () => {
    const src = readFileSync("src/adapters/engine/GameSessionAdapter.ts", "utf8");
    expect(src.match(/speaker: PLAYER, listener/g) ?? []).toEqual([]);
  });
});

describe("ORW-618 part 2 (4): one side stream, salted in the jury house", () => {
  const first = (i: any, id: string, jury: boolean) => {
    const live = i.live;
    const key = `${jury ? "jury:" : ""}${id}:${live.week}:${live.dayNumber ?? 0}:${live.timeOfDay ?? ""}`; // ORW-594: one roll per part of the day
    return new SeededRandom(hashSeed(`${i.gameSeed ?? 0}:claims-to-player:${key}`)).next();
  };
  it("the house keeps its own key (unchanged) and the jury house a salted one", () => {
    const house = rig(7010, { playerJuror: false });
    house.i.live.evictionOrder = [...PRE_JURY]; // the house is still full
    const n = npc(4);
    house.i.live.beliefs[n] = [belief(n)];
    Object.assign(house.i.rel.edge(n, PLAYER), { trust: 0.95 });
    house.i.live.dayNumber = 5; house.i.disclosureEpoch = 1;
    const chance = tellChance({ trustInPlayer: 0.95, audience: house.i.audienceAround(n), candor: house.i.candorOf(n) });
    const expectTold = first(house.i, n, false) < chance;
    const got = house.i.claimsToPlayerFor(n, false);
    // a held belief + the old key: told exactly when the old roll says so (or a planted lie, only with an agenda: none here)
    expect(got !== undefined).toBe(expectTold);
    const j = rig(7011);
    j.i.live.beliefs[npc(1)] = [belief(npc(1))];
    Object.assign(j.i.rel.edge(npc(1), PLAYER), { trust: 0.95 });
    j.i.live.dayNumber = 5; j.i.disclosureEpoch = 1;
    const c2 = tellChance({ trustInPlayer: 0.95, audience: 0, candor: j.i.candorOf(npc(1)) });
    expect(j.i.claimsToPlayerFor(npc(1), true) !== undefined).toBe(first(j.i, npc(1), true) < c2);
  });
  it("a house with no jury: the in-house call is the same whether or not the jury argument exists (byte-identical default)", () => {
    expect(readFileSync("src/adapters/engine/GameSessionAdapter.ts", "utf8")).toContain('const attemptKey = `${jury ? "jury:" : ""}${id}:${live.week}:${day}:${live.timeOfDay ?? ""}`;');
  });
});

describe("ORW-618 part 2 (5): the wall, through the tool boundary", () => {
  it("the juror-player's moment prompt and views carry the tellsYou fields only and no sentinel", async () => {
    const reg = new GameSessionRegistry();
    const user = "u7020";
    const player = reg.resolver()("player", user) as McpServer;
    await player.callTool("createCharacter", { playerName: "The Player", seed: 7020 });
    const sentinels = plantLiveSentinels(reg, user, 7020);
    const sess = reg.sandboxFor(user).session as any;
    sess.setJuryHouseEnabled(true);
    sess.live.playedGame = true;
    sess.live.evictionOrder = [...PRE_JURY, PLAYER, ...OTHER_JURORS];
    sess.live.active = [OTHER_FINALIST, FINALIST];
    sess.live.beliefs[npc(1)] = [...(sess.live.beliefs[npc(1)] ?? []), belief(npc(1))];
    Object.assign(sess.rel.edge(npc(1), PLAYER), { trust: 0.95 });
    tellUntil(sess, npc(1));
    sess.live.dayNumber += 1; sess.disclosureEpoch += 1;
    const present = sess.presentKnowledgeForPrompt() as Array<{ id: string; tellsYou?: Record<string, unknown> }>;
    const jurorIds = new Set([...OTHER_JURORS]);
    for (const e of present) expect(jurorIds.has(e.id), "only jurors are present").toBe(true);
    for (const e of present) if (e.tellsYou) expect(Object.keys(e.tellsYou).every((k) => ["kind", "subject", "object", "certainty"].includes(k))).toBe(true);
    const sweep = async (): Promise<string> => {
      const seen: string[] = [JSON.stringify(sess.presentKnowledgeForPrompt())];
      for (const [tool, args] of [["getMomentPrompt", { moment: "social" }], ["gameStatus", {}], ["getGameState", {}]] as const) seen.push(JSON.stringify(await player.callTool(tool, args as never)));
      return seen.join("\n");
    };
    const all = await sweep();
    // The jury house takes the same disclosure gate as the house: a juror's off-screen knowledge (the planted `npcknow` sentinel) never reaches the narrator, with the new tells on or off.
    for (const s of sentinels) expect(all.includes(s), `${s} leaked`).toBe(false);
    sess.setClaimsToPlayerEnabled(false);
    sess.claimsToPlayerDecided.clear();
    for (const s of sentinels) expect((await sweep()).includes(s), `${s} leaked (tells off)`).toBe(false);
    expect(all).not.toMatch(/claim:\d|isTrue/);
  });
});

describe("ORW-618 part 2 (6): the finale stays the engine's", () => {
  it("what jurors say never depends on, and never names, a juror's sealed final vote", () => {
    const run = (votes: Record<string, string>) => {
      const { i } = rig(7030);
      i.live.finale = { stage: "vote", finalists: [OTHER_FINALIST, FINALIST], jury: [...OTHER_JURORS], votes, revealIx: 0 };
      i.live.beliefs[npc(1)] = [belief(npc(1))];
      i.live.beliefs[npc(2)] = [belief(npc(2), { subject: OTHER_FINALIST })];
      for (const j of OTHER_JURORS) Object.assign(i.rel.edge(j, PLAYER), { trust: 0.95 });
      const out = OTHER_JURORS.map((j) => tellUntil(i, j, true, 60));
      return JSON.stringify([out, i.live.claims?.items ?? []]);
    };
    const a = run(Object.fromEntries(OTHER_JURORS.map((j) => [j, FINALIST])));
    const b = run(Object.fromEntries(OTHER_JURORS.map((j) => [j, OTHER_FINALIST])));
    expect(a).toBe(b);
    // no spoken-claim kind can carry a jury ballot, and the tally is read only by the finale code
    const claimKinds = readFileSync("src/engine/spokenClaims.ts", "utf8");
    expect(claimKinds).not.toMatch(/jury-vote|juror-vote|will-vote/);
    expect(readFileSync("src/engine/claimsToPlayer.ts", "utf8")).not.toMatch(/finale|votes\b/);
  });
});
