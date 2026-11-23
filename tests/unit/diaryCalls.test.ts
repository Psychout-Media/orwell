import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSaveStore } from "../../src/adapters/engine/FileSaveStore";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import type { LiveSeasonState } from "../../src/engine/liveSeason";
import { renderGameContext } from "../../src/engine/momentPrompts";
import { DIARY_CALLS, awayHours, backEventText, callEventText, callMinutes, decideDiaryCall, playerVisitText, renderDiaryCallLines } from "../../src/engine/diaryCalls";

/** ORW-668 (0210 C2): called to the Diary Room. The call is public; what was said never is. Roles only. */
type Any = Record<string, any>;
const SENTINEL = "SENTINEL_DR_WORDS_8e1f";

function boot(seed = 5, opts: { played?: boolean; flag?: boolean; dir?: string } = {}): { sb: Any; s: Any; reg: GameSessionRegistry } {
  const reg = new GameSessionRegistry(new FileSaveStore(opts.dir ?? mkdtempSync(join(tmpdir(), "orwell-dc-"))));
  const sb = reg.sandboxFor("u") as unknown as Any;
  const s = sb.session as Any;
  s.setDiaryCallsEnabled(opts.flag ?? true);
  s.createCharacter({ playerName: "P", seed });
  if (opts.played ?? true) s.noteMessage({ messageId: "m1" });
  s.scheduleGateBypass = true;
  s.phase = "social"; // past the premiere (calls never go out during it)
  (s.live as Any).champagneCircle = "done"; (s.live as Any).pending = undefined; (s.live as Any).ceremony = undefined;
  return { sb, s, reg };
}
/** Walk the house-life stretches over many in-game hours of a quiet stretch of days; returns the diary-call events seen. */
function run(sb: Any, s: Any, days = 6): void {
  const live = s.live as LiveSeasonState;
  live.pending = undefined as never; live.ceremony = undefined as never;
  for (let d = 1; d <= days; d++) {
    for (let h = 9; h <= 22; h++) {
      live.dayNumber = d; live.nightDepth = h;
      const ids = s.livingIds().filter((x: string) => x !== PLAYER);
      s.houseLifeStretch(sb.engine.events, ids, (d - 1) * 24 + h, sb.engine.knowledge);
    }
  }
}
const callEvents = (sb: Any): Any[] => sb.engine.events.query({ type: "diary-call" });

describe("0210 C2 - the pure rules", () => {
  const cand = ["a", "b", "c", "d", "e", "f", "g", "h"];
  it("is deterministic per seed, capped per day, and never while someone is away", () => {
    const picks = (seed: number): Array<string | undefined> => Array.from({ length: 200 }, (_, abs) => decideDiaryCall({ seed, day: 1 + Math.floor(abs / 24), abs, callsToday: 0, awayNow: false, candidates: cand })?.who);
    expect(picks(7)).toEqual(picks(7));
    expect(picks(7).some((x) => x)).toBe(true);
    expect(picks(7)).not.toEqual(picks(8));
    expect(decideDiaryCall({ seed: 7, day: 1, abs: 3, callsToday: DIARY_CALLS.perDay, awayNow: false, candidates: cand })).toBeUndefined();
    for (let abs = 0; abs < 200; abs++) expect(decideDiaryCall({ seed: 7, day: 1, abs, callsToday: 0, awayNow: true, candidates: cand })).toBeUndefined();
  });
  it("a call is bounded: minutes in range, away for the hours it spans", () => {
    for (let abs = 0; abs < 100; abs++) {
      const m = callMinutes(3, "a", abs);
      expect(m).toBeGreaterThanOrEqual(DIARY_CALLS.minMinutes);
      expect(m).toBeLessThanOrEqual(DIARY_CALLS.maxMinutes);
      expect([1, 2]).toContain(awayHours(m));
    }
  });
  it("the facts carry a name and no number, id or content", () => {
    for (const t of [callEventText("N"), playerVisitText("N"), backEventText("N", { long: true, comesBack: "lighter" }), backEventText("N", { long: false, comesBack: "heavier" })]) expect(t).not.toMatch(/\d/);
    const lines = renderDiaryCallLines({ register: "fairly warm", away: ["N"], back: [{ name: "M", long: true, comesBack: "same" }], invited: true }).join("\n");
    expect(lines).not.toMatch(/\d|npc:|e\.g\./);
    expect(renderDiaryCallLines(undefined)).toEqual([]);
  });
});

describe("0210 C2 - in a played game", () => {
  it("a call is a public event with the room as witnesses and no confessional content; the NPC leaves for a bounded stretch and returns", () => {
    const { sb, s } = boot(5);
    run(sb, s);
    const evs = callEvents(sb);
    expect(evs.length).toBeGreaterThan(0);
    const calls = evs.filter((e) => e.id.startsWith(`diary-call:${s.gameSeed ?? 0}:`));
    expect(calls.length).toBeGreaterThan(0);
    for (const e of evs) {
      expect(e.content).not.toMatch(/\d/);
      expect(e.witnessSet).toContain(e.initiator);
      expect(e.hidden).toBe(!e.witnessSet.includes(PLAYER)); // seen by the player only when the player was there
    }
    const st = (s.live as LiveSeasonState).diaryCalls!;
    expect(st.seen.length).toBeGreaterThan(0);
    for (const x of st.seen) { expect(Object.keys(x).sort()).toEqual(["at", "comesBack", "day", "long", "who"]); expect(x.who).not.toBe(PLAYER); }
    // one call a day at most, each returned or still bounded
    for (const n of Object.values(st.byDay)) expect(n).toBeLessThanOrEqual(DIARY_CALLS.perDay);
  });
  it("while away the houseguest is nowhere in the house and takes no part; a return event follows", () => {
    const { sb, s } = boot(5);
    const live = s.live as LiveSeasonState;
    let sawAway = false;
    for (let d = 1; d <= 6 && !sawAway; d++) for (let h = 9; h <= 22 && !sawAway; h++) {
      live.dayNumber = d; live.nightDepth = h;
      s.houseLifeStretch(sb.engine.events, s.livingIds().filter((x: string) => x !== PLAYER), (d - 1) * 24 + h, sb.engine.knowledge);
      const away = live.diaryCalls?.away;
      if (away) {
        sawAway = true;
        const gone = away.who;
        expect(s.diaryAwayIds().has(gone)).toBe(true);
        expect(s.notInHouseNow().has(gone)).toBe(true);
        expect(s.getGameState().diaryCall.away.length).toBe(1);
        const view = s.getGameState();
        expect(renderGameContext(view as never)).toContain("DIARY ROOM CALL");
        expect(view.diaryCall.register.length).toBeGreaterThan(0);
        // back in time
        live.nightDepth = away.until - (d - 1) * 24 + 1;
        s.houseLifeStretch(sb.engine.events, s.livingIds().filter((x: string) => x !== PLAYER), 999, sb.engine.knowledge);
        expect(live.diaryCalls!.away).toBeUndefined();
        expect(s.diaryAwayIds()).toBeNull();
        expect(callEvents(sb).some((e) => e.id.startsWith("diary-call:back:") && e.initiator === gone)).toBe(true);
      }
    }
    expect(sawAway).toBe(true);
  });
  it("ORW-789: a houseguest away in the Diary Room is still in the house and up: the awake and asleep lists together name everyone in the house", () => {
    const { sb, s } = boot(5);
    const live = s.live as LiveSeasonState;
    let checked = false;
    for (let d = 1; d <= 6 && !checked; d++) for (let h = 9; h <= 22 && !checked; h++) {
      live.dayNumber = d; live.nightDepth = h;
      s.houseLifeStretch(sb.engine.events, s.livingIds().filter((x: string) => x !== PLAYER), (d - 1) * 24 + h, sb.engine.knowledge);
      const away = live.diaryCalls?.away;
      if (!away) continue;
      checked = true;
      const st = s.getGameState();
      expect(Array.isArray(st.awake)).toBe(true);
      const listed = new Set<string>([...st.awake.map((x: Any) => x.id), ...(st.asleep ?? []).map((x: Any) => x.id)]);
      const inHouse = (st.house as Any[]).filter((r) => r.status === "active").map((r) => r.id);
      expect(inHouse.filter((id) => !listed.has(id))).toEqual([]);
      expect(st.awake.map((x: Any) => x.id)).toContain(away.who);
    }
    expect(checked).toBe(true);
  });
  it("ORW-695: while away the houseguest takes no part in any house-life stretch (no scene, no event, no witness), and the narrator's away fact names the same person", () => {
    const { sb, s } = boot(5);
    const live = s.live as LiveSeasonState;
    let checked = 0;
    for (let d = 1; d <= 8; d++) for (let h = 9; h <= 22; h++) {
      live.dayNumber = d; live.nightDepth = h;
      const before = new Set(sb.engine.events.queryAll().map((e: Any) => e.id));
      const scenes = s.houseLifeStretch(sb.engine.events, s.livingIds().filter((x: string) => x !== PLAYER), (d - 1) * 24 + h, sb.engine.knowledge) as Any[];
      const gone = [...(s.diaryAwayIds() ?? [])] as string[];
      if (!gone.length) continue;
      checked++;
      const fresh = sb.engine.events.queryAll().filter((e: Any) => !before.has(e.id) && !String(e.type).startsWith("diary-call"));
      for (const x of scenes) { expect(x.initiator).not.toBe(gone[0]); expect(x.partner).not.toBe(gone[0]); expect(x.event.witnessSet).not.toContain(gone[0]); }
      for (const e of fresh) { expect(e.initiator).not.toBe(gone[0]); expect(e.witnessSet).not.toContain(gone[0]); }
      expect(s.getGameState().diaryCall.away).toEqual(gone.map((id) => s.nameOf(id)));
    }
    expect(checked).toBeGreaterThan(0);
  });
  it("is deterministic per seed and recorded once across a save and restore", () => {
    const a = boot(5), b = boot(5);
    run(a.sb, a.s); run(b.sb, b.s);
    expect(callEvents(a.sb).map((e) => e.id)).toEqual(callEvents(b.sb).map((e) => e.id));
    const snap = JSON.parse(JSON.stringify(a.reg.snapshot("u")));
    expect(JSON.stringify(snap)).toContain("diaryCalls");
    // replaying the same hours records nothing new: a call is keyed to its hour and its houseguest
    const n = callEvents(a.sb).length, seen = JSON.stringify((a.s.live as LiveSeasonState).diaryCalls!.seen);
    run(a.sb, a.s);
    expect(callEvents(a.sb).length).toBe(n);
    expect(JSON.stringify((a.s.live as LiveSeasonState).diaryCalls!.seen)).toBe(seen);
  });
  it("the player's own visit is seen by the house once per hour, with nothing they said", () => {
    const { sb, s } = boot(5);
    const live = s.live as LiveSeasonState;
    live.dayNumber = 2; live.nightDepth = 15;
    sb.commands.diaryRoom({ entry: SENTINEL });
    sb.commands.diaryRoom({ entry: `${SENTINEL} again` });
    const mine = callEvents(sb).filter((e) => e.initiator === PLAYER);
    expect(mine.length).toBe(1);
    expect(mine[0].hidden).toBe(false);
    expect(mine[0].content).not.toContain(SENTINEL);
    // the DR -> NPC wall: the words are nowhere in any NPC's knowledge, any event another could hold, or any projection the house sees
    const npcs = s.livingIds().filter((x: string) => x !== PLAYER);
    expect(JSON.stringify(npcs.map((id: string) => sb.engine.knowledge.knownTo(id)))).not.toContain(SENTINEL);
    expect(JSON.stringify(callEvents(sb))).not.toContain(SENTINEL);
    expect(JSON.stringify(live.diaryCalls)).not.toContain(SENTINEL);
    expect(JSON.stringify(s.getGameState().diaryCall ?? null)).not.toContain(SENTINEL);
  });
  it("the player's call is an invitation: the view says so, the block says go or decline, and nothing is recorded until they go", () => {
    const { sb, s } = boot(5);
    const before = callEvents(sb).length;
    const lines = renderDiaryCallLines({ register: "fairly warm", invited: true }).join("\n");
    expect(lines).toContain("INVITATION");
    expect(lines).toMatch(/never send them/);
    expect(callEvents(sb).length).toBe(before);
    expect((s.live as LiveSeasonState).diaryCalls?.seen ?? []).toEqual([]);
  });
});

describe("0210 C2 - headless and flag-off are byte-identical", () => {
  it("flag off, or a game nobody is playing: no state, no event, no view", () => {
    for (const o of [{ flag: false }, { played: false }]) {
      const { sb, s } = boot(11, o);
      run(sb, s, 3);
      expect(callEvents(sb)).toEqual([]);
      expect((s.live as LiveSeasonState).diaryCalls).toBeUndefined();
      expect(s.getGameState().diaryCall).toBeUndefined();
    }
  });
});
