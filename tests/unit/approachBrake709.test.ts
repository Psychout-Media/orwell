import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";
import type { Goal } from "../../src/engine/agenda";
import { nextMilestone } from "../../src/engine/daySchedule";
import { urgency } from "../../src/engine/desireClock";
import { sessionCoreSupersetViolation } from "../../src/engine/sessionSnapshot";
import { playMixGame } from "../support/houseMixDriver";

/**
 * ORW-709 (B3-3/4/5 and the approach treadmill). Played games, real path, roles only.
 * B3-3: hidden scheming about the player to a third party is never an open scene. B3-4: only a genuinely hostile approach folds a fight; a kind answer folds none.
 * B3-5 / treadmill: a houseguest asks a question once (answered or awaiting), stays with the player until the answer lands, and the Diary Room is private.
 */
type Rec = { id: string; actor: string; hostile: boolean; status: string; eventId?: string; goalId: string };
type Seam = {
  livingIds(): EntityId[]; noteMessage(a: object): unknown; houseLifeStretch(events: unknown, awake: readonly EntityId[], i: number): unknown[];
  aimedAtPlayerTick(events: unknown): void; setPlayerAimedEnabled(on: boolean): void; setGroupRolesEnabled(on: boolean): void; createCharacter(a: object): unknown;
  notePlayerTalk(withIds: readonly EntityId[], kind: string | undefined, named: EntityId | undefined): void;
  noteAimedStep(p: object, hostile: boolean, day: number): void; markAimedShown(npc: EntityId, goalId?: string): void;
  desireApproach(ids: EntityId[]): { npc: EntityId; desire: string; q?: string } | null;
  presence: Map<EntityId, string>;
  rel: { edge(a: EntityId, b: EntityId): { affinity: number; trust: number; threat: number } };
  live: { week: number; dayNumber?: number; nightDepth?: number; aimedAtPlayer?: Rec[]; goalApproaches?: Record<string, unknown>; agendas?: Record<string, { goals: Goal[] }>; interruption?: { npc: EntityId; desire: string; atHour: number }; approachAsked?: Record<string, { q: string; week: number; n: number; shownAt: number; answered?: true }> };
};
let n = 0;
function stage(seed: number) {
  const sb = new GameSessionRegistry().sandboxFor(`orw709-${n++}`);
  const s = sb.session as unknown as Seam;
  s.createCharacter({ playerName: "The Player", seed });
  s.setPlayerAimedEnabled(true); s.setGroupRolesEnabled(true); s.noteMessage({ messageId: "m1" });
  const ids = s.livingIds().filter((i) => i !== PLAYER);
  const holder = ids[0]!;
  s.live.agendas![holder]!.goals.push({ id: `${holder}:week:get-them-out:d1`, owner: holder, horizon: "week", kind: "get-them-out", target: PLAYER, why: [{ kind: "character", weight: 1 }], test: { kind: "survives-week" }, commitment: 1, status: "active", formedDay: 1, formedWeek: s.live.week } as unknown as Goal);
  for (const id of [...s.presence.keys()]) s.presence.set(id, "backyard");
  s.presence.set(PLAYER, "kitchen"); s.presence.set(holder, "backyard");
  const e = s.rel.edge(holder, PLAYER); e.trust = 0.1; e.affinity = 0.1; e.threat = 0.9;
  return { sb, s, holder, awake: [...ids.slice(0, 4), PLAYER] as EntityId[] };
}
const goalOf = (h: string) => `${h}:week:get-them-out:d1`;
const step = (h: string) => ({ actor: h, goalId: goalOf(h), goalKind: "get-them-out", kind: "confront", with: [PLAYER] });

describe("B3-3: a houseguest framing the player to a third party is hidden scheming, not an open scene", () => {
  it("no seed turns a get-them-out step ABOUT the player (said to someone else) into a record, an approach or a witnessed scene", () => {
    let aboutSteps = 0;
    for (let seed = 11; seed < 23; seed++) {
      const { sb, s, holder, awake } = stage(seed);
      for (let i = 0; i < 16; i++) { s.live.nightDepth = (s.live.nightDepth ?? 8) + 1; s.houseLifeStretch(sb.engine.events, awake, i); }
      aboutSteps += sb.engine.events.queryAll().filter((e) => e.hidden === true && (e.houseLife as { about?: string } | undefined)?.about === PLAYER && e.initiator === holder).length;
      expect(JSON.stringify((s.live.aimedAtPlayer ?? []).filter((r) => r.actor === holder || r.hostile))).toBe("[]"); // (another houseguest's own friendly step with the player is a different thing)
      expect(s.live.goalApproaches?.[holder]).toBeUndefined();
      s.aimedAtPlayerTick(sb.engine.events);
      expect(sb.engine.events.queryAll().filter((e) => e.hidden === false && /steps up to/.test(String(e.content)) && e.initiator === holder)).toEqual([]);
    }
    expect(aboutSteps).toBeGreaterThan(0); // the control: the scheming did happen, off screen
  });
});

describe("B3-4: only a genuinely hostile approach folds a fight; a kind answer folds none", () => {
  it("an ordinary approach by the same houseguest (a vote ask) does not surface their aimed record", () => {
    const { s, holder } = stage(11);
    s.noteAimedStep(step(holder), true, 1);
    s.markAimedShown(holder, undefined); // a milestone ask carries no goal of theirs
    expect(s.live.aimedAtPlayer![0]!.status).toBe("open");
    s.markAimedShown(holder, goalOf(holder)); // their own goal's approach does
    expect(s.live.aimedAtPlayer![0]!.status).toBe("shown");
  });
  it("a hostile approach answered kindly writes no fight; the same one ignored does", () => {
    const kind = stage(11), ignored = stage(11);
    for (const w of [kind, ignored]) { w.s.noteAimedStep(step(w.holder), true, 1); w.s.markAimedShown(w.holder, goalOf(w.holder)); w.s.aimedAtPlayerTick(w.sb.engine.events); }
    kind.s.notePlayerTalk([kind.holder], "conversation", undefined);
    for (const w of [kind, ignored]) { w.s.live.dayNumber = (w.s.live.dayNumber ?? w.s.live.week) + 5; w.s.aimedAtPlayerTick(w.sb.engine.events); }
    expect(kind.sb.engine.events.queryAll().filter((e) => e.type === "conflict" && /steps up to/.test(String(e.content)))).toEqual([]);
    expect(ignored.sb.engine.events.queryAll().filter((e) => e.type === "conflict" && /steps up to/.test(String(e.content))).length).toBe(1);
  });
});

describe("B3-5 / the approach treadmill, over a played game", () => {
  it("a question is asked once; the asker is with the player when they ask and stays until it is answered; the answer closes it; the Diary Room is private", async () => {
    const seen: string[] = []; const perDay: Record<number, number> = {}; let ripe = 0, away = 0, asked = 0, waitedAndLeft = 0;
    for (const seed of [3, 11]) {
      let last: { npc: string; at: string } | undefined; let waiting: { npc: string; room: string | undefined } | undefined;
      await playMixGame(seed, 360, { onStep: (sess) => {
        const s = sess as Seam;
        const sp = s as unknown as { noteApproach(npc: EntityId, d?: string, capped?: boolean, q?: string): void; __spied?: true };
        if (!sp.__spied) { sp.__spied = true; const orig = sp.noteApproach.bind(s); sp.noteApproach = (npc, d, capped, q) => { orig(npc, d, capped, q); if (q !== undefined && !capped && s.presence.get(npc) !== s.presence.get(PLAYER)) away++; }; } // the moment they step up, they are in the player's room
        const it = s.live.interruption; const ask = it ? s.live.approachAsked?.[it.npc] : undefined;
        if (waiting && s.live.approachAsked?.[waiting.npc]?.answered !== true && s.presence.get(waiting.npc) !== s.presence.get(PLAYER) && s.presence.get(PLAYER) === waiting.room) waitedAndLeft++;
        const at = it ? `${s.live.dayNumber}:${it.atHour}` : "";
        if (it && (!last || last.npc !== it.npc || last.at !== at)) {
          last = { npc: it.npc, at }; asked++;
          const key = `${seed}|${it.npc}|${ask?.q ?? `${it.desire}:${nextMilestone(s as never)?.beat}:${s.live.week}`}`;
          expect(seen).not.toContain(key); seen.push(key); // never the same question twice by the same houseguest
          perDay[seed * 100 + (s.live.dayNumber ?? 0)] = (perDay[seed * 100 + (s.live.dayNumber ?? 0)] ?? 0) + 1;
          // it happens in the player's room, never an empty one
          waiting = { npc: it.npc, room: s.presence.get(PLAYER) };
          if (asked % 2 === 0) { s.notePlayerTalk([it.npc], "conversation", undefined); expect(s.live.approachAsked![it.npc]!.answered).toBe(true); } // every other one the player answers: it is recorded and closed
        }
        // the Diary Room: nobody approaches a player who is in it, and nobody who is in it approaches
        const ids = s.livingIds().filter((i) => i !== PLAYER);
        const was = s.presence.get(PLAYER);
        const live = s.desireApproach(ids);
        if (live) { ripe++; s.presence.set(PLAYER, "diary-room"); expect(s.desireApproach(ids)).toBeNull(); s.presence.set(PLAYER, was ?? "kitchen");
          const prev = s.presence.get(live.npc); s.presence.set(live.npc, "diary-room"); expect(s.desireApproach(ids)?.npc).not.toBe(live.npc); s.presence.set(live.npc, prev ?? "kitchen"); }
      } });
    }
    console.log("ORW709 asked", asked, "perDay", JSON.stringify(perDay), "away", away, "ripe", ripe);
    expect(asked).toBeGreaterThan(0);
    expect(ripe).toBeGreaterThan(0);
    expect(away).toBe(0);
    expect(waitedAndLeft).toBe(0);
    expect(Math.max(0, ...Object.values(perDay))).toBeLessThanOrEqual(8);
  }, 240000);

  it("their wish to press rises slower each time in a week (a pure clock read)", () => {
    const base = { desire: "plea" as const, drive: 0.4, hoursUntil: 1, hoursSinceApproach: undefined };
    const u = [0, 1, 2, 3].map((presses) => urgency({ ...base, presses }));
    for (let k = 1; k < u.length; k++) expect(u[k]!).toBeLessThan(u[k - 1]!);
    expect(urgency(base)).toBe(u[0]); // no presses: unchanged
  });

  it("the asked-question store is superset-guarded: a restore cannot reopen a closed question, and an old save without it loads", () => {
    const { sb, s, holder } = stage(11);
    s.live.approachAsked = { [holder]: { q: "plea:x:1", week: s.live.week, n: 1, shownAt: 0, answered: true } };
    const later = JSON.parse(JSON.stringify(sb.session.snapshot()));
    const earlier = JSON.parse(JSON.stringify(later)); delete earlier.live.approachAsked;
    expect(sessionCoreSupersetViolation(later as never, earlier as never)).toBeNull();
    const reopened = JSON.parse(JSON.stringify(later)); reopened.live.approachAsked[holder].answered = undefined;
    expect(sessionCoreSupersetViolation(reopened as never, later as never)).toBe("approachAsked");
    const gone = JSON.parse(JSON.stringify(later)); delete gone.live.approachAsked;
    expect(sessionCoreSupersetViolation(gone as never, later as never)).toBe("approachAsked");
    const sb2 = new GameSessionRegistry().sandboxFor("orw709-old"); sb2.session.restore(earlier);
    expect((sb2.session as unknown as Seam).live.approachAsked).toBeUndefined();
  });
});
