import { describe, it, expect } from "vitest";
import { PLAYER } from "../../src/domain/ids";
import { isPrivateRoom, type Room } from "../../src/domain/house";
import { talkAloneRoom } from "../../src/engine/talkAlone";
import type { AskToTalkAloneResult } from "../../src/ports/GameSession";
import { playUntil, wfScan, type Stop } from "../realpath/playedSeason";
import { NotReached, firstSeedWhere, firstSeedsWhere } from "../support/firstSeedWhere";

/**
 * ORW-727b. The player asks a houseguest for a private word, or to come over - in a PLAYED season (ORW-812: before, every test staged the house by hand: the premiere skipped, the
 * whole house moved into the yard, every bond set high or low). The season is played by the scripted talking player; each test stops at a free moment of a played day (the premiere
 * over, nothing open, nothing due, daytime) with the player in a room among houseguests, then acts only through the player's MCP channel (askToTalkAlone, recordInteraction,
 * makeDeal, moveTo, moveHouseguest, noteMessage). Who says yes is the engine's call from the real bonds. The pure room picker and the old-save load stay in
 * tests/unit/talkAlone727b.test.ts. HEAVY LANE (tests/uat/**, the `real-path` leg): about a minute of play on the runner. Roles only.
 */
const presence = (s: Stop): Map<string, string> => s.sess.presence as Map<string, string>;
const roomOf = (s: Stop, id: string): string | undefined => presence(s).get(id);
const inRoom = (s: Stop, room: string): string[] => [...presence(s)].filter(([, r]) => r === room).map(([id]) => id).sort();
const company = (s: Stop): string[] => inRoom(s, roomOf(s, PLAYER) ?? "").filter((id) => id !== PLAYER);
const freeMoment = (s: Stop, minCompany = 2): boolean => {
  const g = s.sess.getGameState() as { pending?: unknown; phase: string; daySchedule?: { due: boolean } };
  const tod = s.sess.gameStatus().timeOfDay;
  return g.phase !== "premiere" && !g.pending && !!g.daySchedule && !g.daySchedule.due && (tod === "morning" || tod === "afternoon")
    && !s.sess.live?.talkHold && !s.sess.live?.ceremony && company(s).length >= minCompany;
};
// ORW-1129: the played day's clock can sit before the 8am wake (an early-waking player), when the house is asleep: a sleeper neither answers a private ask (declined, whatever the bond) nor sees a pair leave. The rules below that
// need a houseguest who CAN act on the ask say so in their scan, instead of counting a free moment where the others are asleep.
const awakeIn = (s: Stop, id: string): boolean => (s.sess.awakeNow() as Set<string> | null)?.has(id) ?? true;
const awakeCompany = (s: Stop): string[] => company(s).filter((id) => awakeIn(s, id));
const ask = async (s: Stop, args: Record<string, unknown>) => (await s.call("askToTalkAlone", args)) as AskToTalkAloneResult | null;
type Yes = { at: Stop; npc: string; r: AskToTalkAloneResult; witnesses: string[]; from: string; expectedRoom: Room | null; key?: string };
type No = { bond: number; keys: string[]; moved: boolean; held: boolean; again: string | undefined };
/**
 * ORW-894: the seed is PICKED, not pinned: `untilYes(hint, ...)` scans seeds 1..12 (the hint first) for a played season where someone says yes, then asserts on what happened there. `playOne` is the single-seed drive.
 * Play `seed`; at every free moment the player asks the houseguests `who` picks (by default those in their room), one by one, for a private word (`args`), until one says yes.
 * Every no is recorded with what it changed (nothing, it must be) and the answer to the same ask again that hour. The room the engine's own picker would choose for the live house is
 * read just before each ask. The player asking around is the player's own act through the channel; nothing is set.
 */
async function playOne(seed: number, args: Record<string, unknown> = {}, opts: { who?: (s: Stop) => string[]; when?: (s: Stop) => boolean; minCompany?: number; keyed?: boolean } = {}): Promise<{ yes: Yes; nos: No[] }> {
  const nos: No[] = [];
  let yes: Yes | undefined;
  await playUntil(seed, async (s) => {
    if (!freeMoment(s, opts.minCompany ?? 1) || (opts.when && !opts.when(s))) return false;
    const witnesses = company(s);
    const from = roomOf(s, PLAYER)!;
    for (const npc of (opts.who ?? company)(s)) {
      const before = JSON.stringify([...presence(s)]);
      const expectedRoom = talkAloneRoom({ from: from as Room, named: null, hohInvolved: false, occupiedByOthers: (room) => inRoom(s, room).some((id) => id !== PLAYER && id !== npc) });
      const key = opts.keyed ? `k-${npc}-${s.msg}` : undefined;
      const r = await ask(s, { npcId: npc, ...args, ...(key ? { idempotencyKey: key } : {}) });
      if (r?.outcome === "accepted") { yes = { at: s, npc, r, witnesses, from, expectedRoom, ...(key ? { key } : {}) }; return true; }
      if (r?.outcome === "declined") {
        const again = (await ask(s, { npcId: npc, ...args }))?.outcome;
        nos.push({ bond: s.sess.rel.edge(npc, PLAYER).trust + s.sess.rel.edge(npc, PLAYER).affinity, keys: Object.keys(r).sort(), moved: JSON.stringify([...presence(s)]) !== before, held: !!s.sess.live?.talkHold, again });
      }
    }
    return false;
  }, { user: `wf-${seed}`, maxMessages: 1500 });
  if (!yes) throw new NotReached(`seed ${seed}: nobody said yes in play`);
  return { yes, nos };
}
type UntilOpts = Parameters<typeof playOne>[2];
const untilYes = async (hint: number, args: Record<string, unknown> = {}, opts: UntilOpts = {}): Promise<{ yes: Yes; nos: No[]; seed: number }> => {
  const f = await firstSeedWhere((seed) => playOne(seed, args, opts), wfScan(hint, "a free moment where a houseguest says yes to the ask"));
  return { ...f.at, seed: f.seed };
};

describe("ORW-727b: asking for a private word, in a played season", () => {
  it("an accepting houseguest and the player end up alone in a private room; the scene and a deal there are witnessed by exactly the two; the others saw them leave together", async () => {
    const { yes: { at, npc, r, witnesses } } = await untilYes(11, {}, { minCompany: 2, when: (s) => company(s).every((id) => awakeIn(s, id)) }); // everyone in the room is awake to see the two leave
    expect(roomOf(at, PLAYER)).toBe(r.room);
    expect(roomOf(at, npc)).toBe(r.room);
    expect(isPrivateRoom(r.room as Room)).toBe(true);
    expect(["diary-room", "landing", "hoh-room"]).not.toContain(r.room);
    expect(inRoom(at, r.room!)).toEqual([PLAYER, npc].sort());
    const left = at.engine.events.queryAll().filter((e) => /left the .* together for the/.test(String(e.content)));
    expect(left.length).toBe(1);
    expect([...left[0]!.witnessSet].sort()).toEqual([PLAYER, ...witnesses].sort()); // everyone who was in the room watched the two go
    expect(left[0]!.hidden).toBe(false);
    await at.call("recordInteraction", { initiator: PLAYER, witnessSet: [PLAYER, ...witnesses], content: "a quiet word about the week" });
    const scene = at.engine.events.queryAll().filter((e) => e.content === "a quiet word about the week");
    expect([...scene[0]!.witnessSet].sort()).toEqual([PLAYER, npc].sort());
    const d = await at.call("makeDeal", { with: npc, kind: "safety", terms: "we keep each other safe" });
    expect(d?.id, "the deal formed in private").toBeTruthy();
    const deal = at.engine.events.queryAll().filter((e) => e.type === "deal" && e.witnessSet.includes(npc));
    expect(deal.length).toBeGreaterThan(0);
    for (const x of deal) expect([...x.witnessSet].sort()).toEqual([PLAYER, npc].sort());
  }, 120_000);

  it("the room is the engine's own choice for the live house: private, empty, never the diary room or the landing; a named public room (the kitchen) falls back to it", async () => {
    const when = (s: Stop) => roomOf(s, PLAYER) !== "kitchen";
    for (const { seed, at: { yes } } of await firstSeedsWhere(2, (s) => playOne(s, { room: "kitchen" }, { when }), wfScan([3, 11], "a free moment where a houseguest says yes to a named-room ask"))) {
      expect(yes.r.room, `seed ${seed}`).toBe(yes.expectedRoom);
      expect(isPrivateRoom(yes.r.room as Room)).toBe(true);
      expect(["diary-room", "landing", "hoh-room"]).not.toContain(yes.r.room);
    }
  }, 300_000);

  it("a houseguest who says no: nobody moves, no hold, the answer is typed with nothing else, and the same hour gives the same answer; yes comes from a stronger bond than no", async () => {
    const all: No[] = []; const yesBonds: number[] = [];
    for (const { at: { yes, nos } } of await firstSeedsWhere(3, (s) => playOne(s, {}, { who: awakeCompany }), wfScan([3, 5, 11], "a free moment where an awake houseguest says yes to the ask"))) {
      all.push(...nos);
      yesBonds.push(yes.at.sess.rel.edge(yes.npc, PLAYER).trust + yes.at.sess.rel.edge(yes.npc, PLAYER).affinity);
    }
    expect(all.length, "a no happened in play").toBeGreaterThan(0);
    for (const n of all) {
      expect(n.keys).toEqual(["beatSeq", "outcome"]); // no room, no reason, no number
      expect(n.moved, "a no moves nobody").toBe(false);
      expect(n.held, "a no leaves no hold").toBe(false);
      expect(n.again, "the same hour gives the same answer").toBe("declined");
    }
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    expect(mean(yesBonds), "the bond is what decides").toBeGreaterThan(mean(all.map((n) => n.bond)));
  }, 300_000);

  it("'come here': the houseguest comes to the player's room and the player does not move; the hold keeps them there, then lapses as the hours pass and they wander again", async () => {
    // ORW-1129: the wander needs time before the day's next event: once an event is due the house waits for production's call (the test only chats, so a due event never clears), so the free moment has the hours of the hold and some more before it.
    // The player must also be in a room: at a fresh morning after a competition they have no presence entry yet (main too), and with no company needed the scan would stop there with nowhere to come to.
    // Hint 6: on seeds 1 and 7 the house is mostly still asleep at the free moment and the called houseguest stays put in the player's bedroom for the whole day (main too), so the wander is judged on a seed where the house is up.
    const roomyDay = (s: Stop): boolean => roomOf(s, PLAYER) !== undefined && ((s.sess.getGameState() as { daySchedule?: { minutesUntil?: number } }).daySchedule?.minutesUntil ?? Number.POSITIVE_INFINITY) >= 360;
    const away = (s: Stop) => (s.sess.livingIds() as string[]).filter((id) => id !== PLAYER && roomOf(s, id) !== roomOf(s, PLAYER) && roomOf(s, id) !== "diary-room");
    const { yes: { at, npc, r, from } } = await untilYes(6, { private: false }, { who: away, minCompany: 0, when: roomyDay });
    expect(r.room).toBe(from);
    expect(roomOf(at, PLAYER)).toBe(from);
    expect(roomOf(at, npc)).toBe(from);
    expect(at.sess.live.talkHold).toMatchObject({ npc, room: from, private: false });
    let m = 0;
    while (at.sess.live.talkHold && m < 200) { await at.call("noteMessage", { messageId: `hold-${m++}` }); if (at.sess.live.talkHold) expect(roomOf(at, npc), "held while it lasts").toBe(from); }
    expect(at.sess.live.talkHold, "the hold is bounded").toBeUndefined();
    let moved = false; for (let i = 0; i < 200 && !moved; i++) { await at.call("noteMessage", { messageId: `free-${i}` }); moved = roomOf(at, npc) !== from; }
    expect(moved, "released: they wander again").toBe(true);
  }, 120_000);

  it("'come find me' to a named room sends the houseguest there while the player stays put", async () => {
    const { yes: { at, npc, r, from } } = await untilYes(3, { room: "kitchen", private: false }, { when: (s) => roomOf(s, PLAYER) !== "kitchen" });
    expect(r.room).toBe("kitchen"); expect(roomOf(at, npc)).toBe("kitchen"); expect(roomOf(at, PLAYER)).toBe(from);
  }, 120_000);

  it("in a private room nobody else comes in while the hold lasts, the held houseguest does not leave, a narrated move cannot break it, and nobody steps in on the private word", async () => {
    for (const seed of [11]) {
      const { yes: { at, npc, r } } = await untilYes(seed);
      let checked = 0;
      expect(inRoom(at, r.room!), `seed ${seed}: only the two, the moment they arrive`).toEqual([PLAYER, npc].sort());
      for (let i = 0; i < 12; i++) {
        await at.call("noteMessage", { messageId: `p-${i}` });
        if (!at.sess.live.talkHold) break;
        checked++;
        expect(inRoom(at, r.room!), `seed ${seed}: only the two`).toEqual([PLAYER, npc].sort());
        expect(((await at.call("moveHouseguest", { id: npc, room: "kitchen" })) as { status: string }).status).toBe("illegal");
        const other = (at.sess.livingIds() as string[]).find((x) => x !== PLAYER && x !== npc)!;
        expect(((await at.call("moveHouseguest", { id: other, room: r.room! })) as { status: string }).status).toBe("illegal");
        expect(at.sess.desireApproach((at.sess.livingIds() as string[]).filter((x) => x !== PLAYER)), "nobody steps in on a private word (the engine's own approach read)").toBeNull();
      }
      expect(checked, `seed ${seed}: the hold lasted some messages`).toBeGreaterThan(0);
    }
  }, 300_000);

  // ORW-836 (found under ORW-812): the picker chooses an EMPTY private room, and it is closed from the moment the two arrive, on every seed (the player's walk persists, and the movement tick that runs
  // inside that persist used to seat others in the room because the hold was written after the walk).
  it("real path: the private room holds only the two from the moment they arrive, on seeds 3, 5 and 11", async () => {
    for (const seed of [3, 5, 11]) {
      const { yes: { at, npc, r } } = await untilYes(seed);
      expect(inRoom(at, r.room!), `seed ${seed}: only the two, the moment they arrive`).toEqual([PLAYER, npc].sort());
      expect(roomOf(at, PLAYER)).toBe(r.room);
    }
  }, 600_000);

  it("a hold ends when the player leaves the private room", async () => {
    const { yes: { at, r } } = await untilYes(11);
    expect(at.sess.live.talkHold).toBeDefined();
    await at.call("moveTo", { room: "living room" });
    await at.call("noteMessage", { messageId: "after-leave" });
    expect(roomOf(at, PLAYER)).not.toBe(r.room);
    expect(at.sess.live.talkHold).toBeUndefined();
  }, 120_000);

  it("the lever is at-most-once per idempotency key", async () => {
    const { yes: { at, npc, r, key } } = await untilYes(11, {}, { keyed: true });
    await at.call("moveTo", { room: "kitchen" });
    const where = roomOf(at, PLAYER);
    const again = await ask(at, { npcId: npc, idempotencyKey: key });
    expect(again).toEqual(r); expect(roomOf(at, PLAYER)).toBe(where);
  }, 120_000);

  it("an unknown or absent houseguest is null; the player cannot ask themselves", async () => {
    const at = await playUntil(11, (s) => freeMoment(s), { user: "wf-11" });
    expect(await ask(at, { npcId: "npc:nobody" })).toBeNull();
    expect(await ask(at, { npcId: PLAYER })).toBeNull();
  }, 120_000);
});

/** ORW-920: a houseguest's own ask is standing and shown to the player. The seed is picked (hint 3), not pinned: a gameplay change moves which season gets there. */
const askStanding = () => firstSeedWhere((seed) => playUntil(seed, (s) => !!s.sess.live?.talkAsk && !s.sess.getGameState().pending && !!(s.sess.getGameState() as { openTalkAsk?: unknown }).openTalkAsk, { user: `wf-${seed}`, maxMessages: 3000 }), { ...wfScan([2, 5, 1, 3], "a houseguest's own ask standing and shown to the player"), to: 30, wide: { maxSeasons: 30, budgetMs: 3_000_000, reason: "ORW-1007: the faster premiere bed rush moved every season, and a houseguest's unprompted ask standing is a rare moment, so seeds 1..12 may not reach it" } });

describe("ORW-727b: a houseguest asks the player for a private word (parity), in a played season", () => {
  it("their own ask stands as an open, non-blocking offer the player sees; the player's yes through the same lever is accepted; it then clears", async () => {
    const { at } = await askStanding();
    const npc = at.sess.live.talkAsk.npc as string;
    const view = at.sess.getGameState() as { openTalkAsk?: { from: { id: string } } };
    expect(view.openTalkAsk?.from.id).toBe(npc);
    expect(JSON.stringify(view.openTalkAsk)).not.toMatch(/trust|affinity|threat/);
    const r = (await ask(at, { npcId: npc }))!;
    expect(r.outcome).toBe("accepted");
    expect(at.sess.live.talkAsk).toBeUndefined();
    expect((at.sess.getGameState() as { openTalkAsk?: unknown }).openTalkAsk).toBeUndefined();
  }, 3_600_000);
});

describe("ORW-727b: a houseguest's ask lapses, in a played season", () => {
  it("left unanswered, their ask stops showing once its hours have passed", async () => {
    const { at } = await askStanding();
    const npc = at.sess.live.talkAsk.npc as string;
    const until = at.sess.live.talkAsk.until as number;
    const abs = () => ((at.sess.live.dayNumber ?? 1) - 1) * 24 + (at.sess.live.nightDepth ?? 8);
    for (let i = 0; i < 400 && abs() < until; i++) await at.call("noteMessage", { messageId: `lapse-${i}` });
    expect(abs()).toBeGreaterThanOrEqual(until);
    const view = at.sess.getGameState() as { openTalkAsk?: { from: { id: string } } };
    expect(view.openTalkAsk?.from.id === npc, "a lapsed ask no longer shows").toBe(false);
  }, 3_600_000);
});

describe("ORW-727b: saves, in a played season", () => {
  it("a save taken while a hold is open restores it", async () => {
    const { yes } = await untilYes(11);
    const at = yes.at;
    const snap = at.sess.snapshot();
    expect(snap.live.talkHold.npc).toBe(yes.npc);
    const { GameSessionRegistry } = await import("../../src/composition/registry");
    const restored = new GameSessionRegistry().sandboxFor("orw727b-restore").session as unknown as { restore(s: unknown): void; live: { talkHold?: { npc: string } } };
    restored.restore(JSON.parse(JSON.stringify(snap)));
    expect(restored.live.talkHold?.npc).toBe(yes.npc);
  }, 120_000);
});
