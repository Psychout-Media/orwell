import { describe, it, expect } from "vitest";
import { PLAYER } from "../../src/domain/ids";
import { nextMilestone } from "../../src/engine/daySchedule";
import { playMixGame } from "../support/houseMixDriver";
import { firstStop, wfScan, type Stop } from "../realpath/playedSeason";
import { firstSeedWhere } from "../support/firstSeedWhere";

/** The last mix-driver seed known to show a hostile approach (ORW-856): tried first, then 11, then 1..12. */
const HOSTILE_HINT = 3;

/**
 * ORW-709 (B3-3/4/5 and the approach treadmill) - in PLAYED games (ORW-812: before, a get-them-out goal was pushed into a houseguest's agenda, the house moved into the yard, the bond
 * set hostile and the clock stepped by hand). The games are played by the house-mix driver (a quiet player: a message each turn, events advanced and answered on a fixed cadence,
 * held nights lived through); the checks only READ the live session after each message, and the player's own acts go through the channel. HEAVY LANE (tests/uat/**, the
 * `real-path` leg): over a minute of play on the runner. Roles only.
 */
type Rec = { id: string; actor: string; hostile: boolean; status: string; eventId?: string; goalId: string; hour: number };
type Sess = { live: { aimedAtPlayer?: Rec[]; interruption?: { npc: string; desire: string; atHour: number }; approachAsked?: Record<string, { q: string; answered?: true }>; dayNumber?: number; week: number; goalApproaches?: Record<string, unknown> }; presence: Map<string, string>; record?: { events(): Array<{ id: string; type: string; hidden: boolean; initiator: string; witnessSet: string[]; content: string; houseLife?: { about?: string; at?: number } }> }; livingIds(): string[]; desireApproach(ids: string[]): { npc: string } | null };
const events = (s: Sess) => s.record?.events() ?? [];

describe("B3-3: a houseguest scheming about the player to a third party stays hidden, in played games", () => {
  it("no hidden step about the player becomes an aimed record, an approach or an open scene; every record the player is shown is an open scene they were in", async () => {
    let aboutSteps = 0, records = 0;
    for (const seed of [11, 12, 13]) {
      let last: Sess | undefined;
      await playMixGame(seed, 700, { user: `mixdrv-${seed}`, onStep: (sess) => { last = sess as Sess; } });
      const s = last!;
      const about = events(s).filter((e) => e.hidden && e.houseLife?.about === PLAYER);
      aboutSteps += about.length;
      const recs = s.live.aimedAtPlayer ?? [];
      records += recs.length;
      for (const e of about) {
        expect(recs.some((r) => r.actor === e.initiator && Math.abs(r.hour - (e.houseLife!.at ?? -1)) < 1e-9), `seed ${seed}: a hidden step about the player became a record`).toBe(false);
        expect(e.witnessSet.includes(PLAYER), "the player never witnesses it").toBe(false);
      }
      for (const r of recs.filter((x) => x.eventId)) {
        const scene = events(s).find((e) => e.id === r.eventId);
        if (!scene) continue; // a record not yet shown has no scene
        expect(scene.hidden, "a shown record is an open scene").toBe(false);
        expect(scene.witnessSet.includes(PLAYER), "the player was in it").toBe(true);
      }
    }
    expect(aboutSteps, "the control: houseguests did scheme about the player, off screen").toBeGreaterThan(0);
    expect(records, "non-vacuous: the player was approached on records of their own").toBeGreaterThan(0);
  }, 300_000);
});

describe("B3-4: only a genuinely hostile approach folds a fight; a kind answer folds none (played)", () => {
  it("ORW-839: a milestone ask by a houseguest who holds an open record of their own leaves that record open (the scripted talking player, the first seed that gets there)", async () => {
    // PRECONDITION (the scan): a houseguest steps up to the player with a milestone question (not their goal's) while holding an open record aimed at the player. The house-mix
    // games above (seeds 11-13, 700 messages) never got there; with the scripted talking player a 2026-11-24 search found it in 18 of 40 seeds, so the scan finds one in 1..12.
    type Seen = { npc: string; asked: string; open: string[] };
    const memo = new WeakMap<object, { last: string; open: Map<string, string[]>; goal: Set<string> }>();
    let seen: Seen | undefined;
    const milestoneAskOnOpenRecord = (st: Stop): boolean => {
      const s = st.sess as Sess;
      const m = memo.get(s) ?? { last: "", open: new Map<string, string[]>(), goal: new Set<string>() };
      memo.set(s, m);
      let hit = false;
      const it2 = s.live.interruption;
      if (it2) {
        const key = `${it2.npc}:${it2.atHour}`;
        if (key !== m.last) {
          m.last = key;
          const q = s.live.approachAsked?.[it2.npc]?.q;
          // still open NOW as well as at the last stop: a record the asker's own earlier approach surfaced a step ago (a goal approach, then a plea in the next stretch) is not the ask's to answer for
          const nowOpen = new Set((s.live.aimedAtPlayer ?? []).filter((r) => r.status === "open").map((r) => r.id));
          const had = (m.open.get(it2.npc) ?? []).filter((id) => nowOpen.has(id));
          // a PURE milestone ask: not the goal's own question, and carrying no goal's words (a houseguest with a goal approach pending voices that goal whatever they step up
          // for, and that goal's record surfaces by design: ORW-709's "only that record's own goal does")
          if (q && !q.startsWith("goal:") && !(it2 as { say?: unknown }).say && had.length > 0 && !m.goal.has(it2.npc) && !s.live.goalApproaches?.[it2.npc]) { seen = { npc: it2.npc, asked: q, open: had }; hit = true; }
        }
      }
      const open = new Map<string, string[]>();
      for (const r of s.live.aimedAtPlayer ?? []) if (r.status === "open") (open.get(r.actor) ?? open.set(r.actor, []).get(r.actor)!).push(r.id);
      m.open = open;
      // ORW-905: a houseguest holding a goal approach of their own voices that goal whatever they step up for (the engine marks the record of the PENDING goal approach as shown), with or without words; so the
      // precondition needs "no goal approach pending" for the asker, read from the step before as well as now (the approach is consumed as the ask surfaces).
      m.goal = new Set(Object.keys(s.live.goalApproaches ?? {}));
      return hit;
    };
    const at = await firstStop(milestoneAskOnOpenRecord, wfScan([6, 2, 1], "a milestone ask by a houseguest who holds an open record"));
    expect(seen, "the stop recorded the ask").toBeDefined();
    const recs = ((at.sess as Sess).live.aimedAtPlayer ?? []).filter((r) => seen!.open.includes(r.id));
    expect(recs.length).toBe(seen!.open.length);
    // the claim is that the ask does not SURFACE the record (only that record's own goal does): never "shown". A record can still close as "answered" in the same message when the
    // player answered an earlier question from that houseguest (answerAimedFrom closes the asker's records): that is the player's answer, recorded, not the ask surfacing it.
    const answeredByPlayer = (at.sess as Sess).live.approachAsked?.[seen!.npc]?.answered === true;
    for (const r of recs) {
      expect(r.status, "a milestone ask does not surface the asker's own record (only that record's own goal does)").not.toBe("shown");
      if (r.status !== "open") expect({ status: r.status, answeredByPlayer }, "closed only by the player's own answer").toEqual({ status: "answered", answeredByPlayer: true });
    }
  }, 900_000);

  it("a hostile approach answered kindly writes no fight FOR THAT APPROACH; the same approach ignored does (a scanned mix-driver seed, the same game played twice up to the approach; was pinned to seed 11, ORW-791/872/1002)", async () => {
    // ORW-856 / ORW-1002: a pinned seed broke each time a played-fold change moved the trajectory, so the seed is SCANNED. The claim is about ONE approach: the first hostile record shown to the player. A fight is that approach's
    // when its scene event is that record's own (`<record id>:scene`): a later, separate approach by the same houseguest is another record with its own fight and says nothing about the answer. The precondition of the
    // kind play is that the answer LANDED (the record closes as "answered"); a seed where the player's answer did not register (e.g. the record has already been ignored) is no evidence either way, so the scan skips it.
    type Run = { shownId?: string; status?: string; own: number; all: number };
    const play = async (seed: number, user: string, answer: boolean): Promise<Run> => {
      let target: string | undefined; let shownId: string | undefined; let answered = false; let after = 0; let s: Sess | undefined;
      await playMixGame(seed, 1400, { user: user,
        onStep: (sess) => { s = sess as Sess; if (!target) { const r = (s.live.aimedAtPlayer ?? []).find((x) => x.hostile && x.status === "shown"); if (r) { target = r.actor; shownId = r.id; } } else after++; },
        onMessage: async (call) => { if (answer && target && !answered) { answered = true; await call("recordInteraction", { initiator: PLAYER, witnessSet: [PLAYER, target], content: "I hear you, let's talk it through", kind: "conversation" }); } },
        stopWhen: () => after > 500,
      });
      if (!s || !target || !shownId) return { own: 0, all: 0 };
      const status = (s.live.aimedAtPlayer ?? []).find((r) => r.id === shownId)?.status;
      const fights = events(s).filter((e) => e.type === "conflict" && /steps up to/.test(String(e.content)) && e.initiator === target);
      return { shownId, ...(status ? { status } : {}), own: fights.filter((e) => String((e as { id?: string }).id ?? "").startsWith(`${shownId}:`)).length, all: fights.length };
    };
    // ORW-1104: BOTH arms are part of the precondition (the same approach is shown to the player in both plays, the kind answer closes it as answered, and the ignored play's record ends "ignored"): a seed where the ignored play
    // still shows the record at the stop (its window not yet elapsed) says nothing about the claim, so the scan skips it.
    const found = await firstSeedWhere(async (seed, sandbox) => {
      const k = await play(seed, sandbox, true); if (k.status !== "answered") return undefined;
      const i = await play(seed, sandbox, false); return i.shownId === k.shownId && i.status === "ignored" ? { seed, kind: k, ignored: i } : undefined;
    }, { from: 1, to: 12, hint: [HOSTILE_HINT, 1, 11], sandbox: (x) => `mixdrv-${x}`, what: "a hostile approach shown to the player that the kind answer closes as answered and the ignored play leaves ignored (mix driver, 1400 messages)" });
    const kind = found.at.kind, ignored = found.at.ignored;
    expect(ignored.shownId, "the same approach is shown in the same game when the player ignores it").toBe(kind.shownId);
    expect(ignored.status, "ignored: the record is ignored").toBe("ignored");
    expect(ignored.own, "ignored: the fight folds for that approach").toBe(1);
    expect(kind.own, "answered kindly: no fight for that approach").toBe(0);
  }, 900_000);
});

describe("B3-5 / the approach treadmill, over a played game", () => {
  it("a question is asked once; the asker is with the player when they ask and stays until it is answered; nobody approaches a player in the Diary Room", async () => {
    const seen: string[] = []; const perDay: Record<number, number> = {}; let asked = 0, away = 0, waitedAndLeft = 0, inDiary = 0;
    for (const seed of [3, 11]) {
      let last: { npc: string; at: string } | undefined; let waiting: { npc: string; room: string | undefined } | undefined;
      let answerNext: string | undefined; let diaryNext = false; let backTo: string | undefined; let steps = 0;
      await playMixGame(seed, 360, { user: `mixdrv-${seed}`,
        onMessage: async (call) => {
          if (answerNext) { await call("recordInteraction", { initiator: PLAYER, witnessSet: [PLAYER, answerNext], content: "fair question, here is my answer", kind: "conversation" }); answerNext = undefined; }
          if (backTo) { await call("moveTo", { room: backTo.replace(/-/g, " ") }); backTo = undefined; } // a short visit: back to where they were
          else if (diaryNext) { diaryNext = false; await call("moveTo", { room: "diary room" }); }
        },
        onStep: (sess) => {
          const s = sess as Sess;
          const it = s.live.interruption; const ask = it ? s.live.approachAsked?.[it.npc] : undefined;
          if (waiting && s.live.approachAsked?.[waiting.npc]?.answered === true) waiting = undefined;
          if (waiting && s.live.approachAsked?.[waiting.npc]?.answered !== true && s.presence.get(waiting.npc) !== s.presence.get(PLAYER) && s.presence.get(PLAYER) === waiting.room) waitedAndLeft++;
          const at = it ? `${s.live.dayNumber}:${it.atHour}` : "";
          if (it && (!last || last.npc !== it.npc || last.at !== at)) {
            last = { npc: it.npc, at }; asked++;
            if (s.presence.get(it.npc) !== s.presence.get(PLAYER)) away++; // they step up in the player's room
            const key = `${seed}|${it.npc}|${ask?.q ?? `${it.desire}:${nextMilestone(s as never)?.beat}:${s.live.week}`}`;
            expect(seen).not.toContain(key); seen.push(key); // never the same question twice by the same houseguest
            perDay[seed * 100 + (s.live.dayNumber ?? 0)] = (perDay[seed * 100 + (s.live.dayNumber ?? 0)] ?? 0) + 1;
            waiting = { npc: it.npc, room: s.presence.get(PLAYER) };
            if (asked % 2 === 0) answerNext = it.npc; // every other one the player answers (their own act, next message)
          } else if (!it && !waiting && ++steps % 25 === 0 && s.presence.get(PLAYER) !== "diary-room") diaryNext = true; // now and then, with nobody waiting on them, the player pops into the Diary Room
          if (s.presence.get(PLAYER) === "diary-room" && !backTo && !diaryNext) backTo = waiting?.room ?? "living-room";
          if (s.presence.get(PLAYER) === "diary-room") { inDiary++; expect(s.desireApproach(s.livingIds().filter((i) => i !== PLAYER)), "nobody approaches a player in the Diary Room").toBeNull(); }
        },
      });
    }
    expect(asked).toBeGreaterThan(0);
    expect(away).toBe(0);
    expect(waitedAndLeft).toBe(0);
    expect(inDiary, "non-vacuous: the player was in the Diary Room").toBeGreaterThan(0);
    expect(Math.max(0, ...Object.values(perDay))).toBeLessThanOrEqual(8);
  }, 300_000);
});
