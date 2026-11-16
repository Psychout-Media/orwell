/**
 * ORW-433 (Ryne: "deep testing on how the turn over going to bed / waking up goes, as well as crossovers from week to week"): engine-level checks on a chat-paced
 * seeded game (the same driver as the house-mix guard), across seeds, for the deterministic parts of bedtime, waking and the week crossover. No narrator.
 *   npx tsx scripts/probes/bedWakeWeek.ts [messages=1300] [seeds=12]
 * Every turn-in is made at a chosen bed hour (cycling evening, late evening, midnight, small hours) and read before and after. Prints one line per check with
 * its pass count and the first failures (seed, day, what was seen). Read-only: a throwaway game on a fake clock. Roles only.
 */
import { composeRuntime } from "../../src/composition/runtime";
import { FakeClock } from "../../src/adapters/time/FakeClock";
import { answerPending } from "../../features/support/answerPending";
import { wakeHourAfterBed, sleepDeficitForBedHour } from "../../src/engine/timeOfDay";

const MESSAGES = Number(process.argv[2] ?? 1300), SEEDS = Number(process.argv[3] ?? 12), FIRST = Number(process.argv[4] ?? 1); // argv[4]: the first seed (to split a sweep over processes)
const BED_HOURS = [21, 22.5, 24, 25.5, 26.5]; // 9pm, 10:30pm, midnight, 1:30am, 2:30am (clock hours past midnight run 24..32)
type Res = { pass: number; fail: string[] };
const R = new Map<string, Res>();
const rec = (id: string, ok: boolean, why: string): void => { const r = R.get(id) ?? { pass: 0, fail: [] }; if (ok) r.pass++; else r.fail.push(why); R.set(id, r); };

type Status = { timeOfDay?: string; dayNumber?: number; week?: number; phase?: string; asleep?: Array<{ id: string }>; awake?: Array<{ id: string }>; earlyMorning?: boolean };
type State = Status & { hoh?: { id?: string } | null; clockLabel?: string; whereabouts?: { counts?: { house?: number; room?: number } } | null; daySchedule?: { next?: string; due?: boolean } | null; started?: boolean };

/** Clock hours on the engine's 8..32 night-depth scale, from "h:mmam, Day N" (an hour before 8am belongs to the night that started the day before). */
function depthOf(label?: string): { h: number; day: number } | null {
  const m = /^(\d{1,2}):(\d{2})(am|pm), Day (\d+)$/.exec(label ?? "");
  if (!m) return null;
  let h = (Number(m[1]) % 12) + (m[3] === "pm" ? 12 : 0) + Number(m[2]) / 60;
  if (h < 8) h += 24;
  return { h, day: Number(m[4]) };
}

async function main() {
  for (let seed = FIRST; seed < FIRST + SEEDS; seed++) {
    const user = `bww-${seed}`;
    const reg = composeRuntime({ clock: new FakeClock(), seed }).registry;
    const mcp = reg.resolver()("player", user);
    const call = async <T>(n: string, a: Record<string, unknown> = {}): Promise<T> => (await mcp.callTool(n, a)) as T;
    // A read-only TEST seam on the hidden sleep state (as in tests/unit): the probe never writes it and prints it only to this console.
    type Sleep = { lastSleepDepth?: number; playerFatigue?: number; napHoursToday?: number };
    const napDays = new Set<number>();
    const live = async (): Promise<Sleep> => ((await reg.sandboxFor(user)) as unknown as { session: { live?: Sleep } }).session.live ?? {};
    let lastInHouse: number | null = null;
    const weekStart: Record<number, number> = {}; // the first day each week was seen on (information: how long a week runs in days)
    // Headcount -1: when the number of people in the house changes, it drops by exactly one (one eviction at a time) and the stated house count follows.
    const checkEviction = async (where: string): Promise<void> => {
      const st = await call<State & { house?: Array<{ status?: string }>; player?: { status?: string } }>("getGameState");
      if (!Array.isArray(st.house) || st.phase === "premiere") return;
      const inHouse = st.house.filter((r) => r.status === "active").length + (st.player?.status === "active" ? 1 : 0);
      if (lastInHouse !== null && inHouse !== lastInHouse) {
        const delta = inHouse - lastInHouse;
        if (delta === 1 || delta === -2) rec(`INFO a reserve twist changed the house (${delta === 1 ? "battle-back: +1" : "double eviction: -2"})`, true, "");
        else rec("headcount -1: an eviction removes exactly one person", delta === -1, `seed ${seed} ${where}: ${lastInHouse} -> ${inHouse} (phase ${st.phase}, week ${st.week}, player ${st.player?.status}, statuses ${JSON.stringify(st.house.reduce((m: Record<string, number>, r) => { m[String(r.status)] = (m[String(r.status)] ?? 0) + 1; return m; }, {}))})`);
        const h = st.whereabouts?.counts?.house;
        if (typeof h === "number") rec("headcount -1: the stated house count follows the eviction", h === inHouse, `seed ${seed} ${where}: house count ${h} vs ${inHouse} in`);
      }
      lastInHouse = inHouse;
    };
    await call("createCharacter", { playerName: "The Player", seed, archetype: "floater" });
    let nights = 0, lastBedWeek = 1, msg = 0;
    const note = async (): Promise<void> => { await call("noteMessage", { messageId: `${user}-${msg++}` }); };

    const checkState = async (where: string): Promise<void> => {
      const st = await call<State>("getGameState");
      if (!st.timeOfDay) return;
      const awake = new Set((st.awake ?? []).map((x) => x.id)), asleep = new Set((st.asleep ?? []).map((x) => x.id));
      if (st.awake) {
        rec("awake list never names the player", !awake.has("player"), `seed ${seed} ${where}: player in awake`);
        rec("awake and asleep never overlap", [...awake].every((id) => !asleep.has(id)), `seed ${seed} ${where}: ${[...awake].filter((id) => asleep.has(id)).join(",")}`);
        const npcsIn = ((st as State & { house?: Array<{ id: string; status?: string }> }).house ?? []).filter((r) => r.status === "active").length;
        if (st.phase !== "premiere") rec("N7 awake + asleep = everyone in the house", awake.size + asleep.size === npcsIn, `seed ${seed} ${where}: ${awake.size} awake + ${asleep.size} asleep vs ${npcsIn} houseguests in`);
      }
      // W10: every week number the player's surfaces state agrees - the game state, the status panel, and each "Week N" in the narrator's moment prompt.
      // (The old check read `moment`, which is the beat name and never carries a week, so it never fired.)
      if (typeof st.week === "number" && st.week > 0 && typeof st.dayNumber === "number" && weekStart[st.week] === undefined) weekStart[st.week] = st.dayNumber;
      if (typeof st.week === "number" && st.week > 0) {
        const gs = await call<{ week?: number }>("gameStatus");
        rec("W10 the status panel's week = the game state's week", gs.week === st.week, `seed ${seed} ${where}: status week ${gs.week} vs state week ${st.week}`);
        const mp = await call<{ systemPrompt?: string }>("getMomentPrompt", {});
        const stated = [...(mp.systemPrompt ?? "").matchAll(/\bWeek (\d+)\b/g)].map((m) => Number(m[1]));
        if (stated.length) rec("W10 every 'Week N' in the narrator prompt = the game state's week", stated.every((w) => w === st.week), `seed ${seed} ${where}: prompt says week ${[...new Set(stated)].join("/")} vs state week ${st.week}`);
      }
      const house = st.whereabouts?.counts?.house;
      const full = st as State & { house?: Array<{ status?: string }>; player?: { status?: string } };
      if (typeof house === "number" && st.phase !== "premiere" && Array.isArray(full.house)) {
        const playerIn = full.player?.status === "active";
        const inHouse = full.house.filter((r) => r.status === "active").length + (playerIn ? 1 : 0);
        rec("headcount: the house count includes the player", house === inHouse, `seed ${seed} ${where}: house ${house} vs ${inHouse} active (player ${playerIn ? "in" : "out"})`);
      }
    };

    let lastHoh: string | null = null, hohWeek = 0;
    // A staged ceremony (e.g. the eviction reveal, one ballot per advance) is driven every message, as the narrator advances it each turn; at the probe's usual
    // one-advance-per-12-messages pace a 14-ballot reveal took the whole night.
    let ceremonyOpen = false; const ceremonyBedTried = new Set<number>();
    for (let i = 0; i < MESSAGES; i++) {
      await note();
      if (i % 12 !== 11 && !ceremonyOpen) continue;
      {
        const gs = await call<{ hoh?: { id?: string } | null; week?: number; whereabouts?: { houseEvent?: { kind?: string; competing?: Array<{ id: string }> } } }>("getGameState");
        const he = gs.whereabouts?.houseEvent;
        if (he?.kind === "hoh-competition" && Array.isArray(he.competing) && lastHoh && (gs.week ?? 0) > hohWeek)
          rec("W4 the outgoing HOH does not play the next HOH comp", !he.competing.some((c) => c.id === lastHoh), `seed ${seed} week ${gs.week}: outgoing HOH ${lastHoh} is in the field`);
        const st2 = await call<{ hoh?: { id?: string } | null; week?: number }>("gameStatus");
        if (st2.hoh?.id && (st2.week ?? 0) > hohWeek) { lastHoh = st2.hoh.id; hohWeek = st2.week ?? hohWeek; }
      }
      const adv = (await call<{ pending?: { kind: string; options?: Array<{ id: string }> }; held?: { next?: string; minutesUntil?: number } }>("advanceGame"));
      await checkEviction(`message ${i}`);
      ceremonyOpen = !!(adv as { ceremony?: unknown }).ceremony && !adv.pending && !adv.held;
      if (process.env.BWW_DEBUG) { const g = await call<State>("getGameState"); console.log(`#${i} ${g.clockLabel} wk${g.week} ${g.phase} ${g.timeOfDay} pend=${adv.pending?.kind ?? "-"} held=${adv.held ? JSON.stringify(adv.held) : "-"}`); }
      if (adv.pending?.kind === "ceremony-step") { // a watch step: the engine wants it answered with advanceGame, not submitDecision
        for (let k = 0; k < 40; k++) { const nx = await call<{ pending?: { kind: string } }>("advanceGame"); if (nx.pending?.kind !== "ceremony-step") break; }
        await checkEviction(`message ${i} (ceremony)`);
        continue;
      }
      if (adv.pending) {
        // The shared BDD answerer covers every pending kind (the old inline one could not answer the player's own exit interview, so an evicted player froze the game).
        const req = answerPending(adv.pending as never);
        if (req) { try { await call("submitDecision", req as never); } catch (e) { rec("probe: every pending decision is answerable", false, `seed ${seed} message ${i}: ${adv.pending.kind} refused: ${String(e).slice(0, 120)}`); } }
        else await call("advanceGame");
        continue;
      }
      if (!adv.held) {
        // An idle NIGHT (nothing held, nothing pending - e.g. eviction night after the ceremony) is also a bed, as a real player says goodnight; without this the
        // probe stayed up until the night ran out at 8am. Only while the player is still in the house (an evictee has no bed to go to).
        const st0 = await call<State & { player?: { status?: string } }>("getGameState");
        if (!((st0.timeOfDay === "night" || st0.timeOfDay === "late-night") && st0.player?.status === "active")) continue;
        if (ceremonyOpen) {
          // INFO (needs a ruling, not pass/fail): what a goodnight does in the middle of an open ceremony, once per week. The bed is real if it goes through.
          if (!ceremonyBedTried.has(st0.week ?? 0)) {
            ceremonyBedTried.add(st0.week ?? 0);
            const tb = await call<{ held?: unknown; weekChapter?: unknown }>("turnIn", { idempotencyKey: `${user}-cer-${st0.week}` });
            const st1 = await call<State>("getGameState");
            rec(`INFO a goodnight during an open ceremony was ${tb.held ? "held (refused)" : "taken"}`, true, `seed ${seed} week ${st0.week}: bed at ${st0.clockLabel} went through mid-ceremony, woke ${st1.clockLabel}, phase ${st1.phase}`);
            if (!tb.held) { // a real bed: hold it to the same chapter rule and move the probe's own week cursor (it consumed the chapter otherwise)
              nights++;
              rec("the week chapter rolls exactly at the first bed of a new week", !!tb.weekChapter === ((st0.week ?? 1) > lastBedWeek), `seed ${seed} mid-ceremony bed: week ${st0.week} (last bed in week ${lastBedWeek}) chapter ${tb.weekChapter ? "given" : "absent"}`);
              lastBedWeek = st0.week ?? lastBedWeek;
            }
          }
          continue;
        }
      }
      // A DAYTIME "not due yet" hold names the event and the minutes until it: let that time pass (going to bed instead skipped the event's day, so the game
      // never left Week 1). Only a night hold (or a hold with nothing named) is a bed.
      if (adv.held?.next && adv.held.next !== "bedtime" && typeof adv.held.minutesUntil === "number" && adv.held.minutesUntil > 0) {
        const st0 = await call<State>("getGameState");
        // Only a MORNING/AFTERNOON hold is waited out: an evening hold names tomorrow's event (e.g. 780 minutes), and waiting it out kept the player up all night
        // without a bed (4 nights in 2600 messages, never past Week 1). From the evening on, the hold is a bed.
        if ((st0.timeOfDay === "morning" || st0.timeOfDay === "afternoon") && st0.dayNumber && st0.dayNumber % 2 === 1 && !napDays.has(st0.dayNumber)) {
          // 0148 nap lines, once on every other day, in a daytime hold (an event is coming: it should wake the player on the dot).
          napDays.add(st0.dayNumber);
          const h0 = depthOf(st0.clockLabel), credit0 = (await live()).napHoursToday ?? 0;
          const nv = await call<{ ok: boolean; slept: number; wokenBy?: string; reason?: string }>("nap", { hours: 2, idempotencyKey: `${user}-nap-${st0.dayNumber}` });
          const st1 = await call<State>("getGameState"); const h1 = depthOf(st1.clockLabel), credit1 = (await live()).napHoursToday ?? 0;
          const moved = h0 && h1 ? Math.round((((h1.h - h0.h) % 24 + 36) % 24 - 12) * 100) / 100 : NaN; // a nap is at most a few hours: fold the two clock scales (an early-morning hour reads 24+) into -12..12
          if (st0.earlyMorning) rec("nap: refused in the early-morning band (ORW-451)", !nv.ok, `seed ${seed} day ${st0.dayNumber}: a nap at ${st0.clockLabel} was accepted`);
          if (!nv.ok) {
            rec(`INFO nap refused (${nv.reason})`, true, "");
            rec("nap: a refused nap leaves the clock and the nap credit as they were", moved === 0 && credit1 === credit0, `seed ${seed} day ${st0.dayNumber}: ${nv.reason}, clock moved ${moved}h, credit ${credit0} -> ${credit1}`);
          } else {
            rec("nap: the clock moves by exactly the time slept, never more than asked", Math.abs(moved - nv.slept) < 0.02 && nv.slept <= 2 + 1e-9, `seed ${seed} day ${st0.dayNumber}: slept ${nv.slept}h, clock moved ${moved}h`);
            rec("nap: the slept time is added to today's nap credit", Math.abs(credit1 - credit0 - nv.slept) < 0.01, `seed ${seed} day ${st0.dayNumber}: slept ${nv.slept}, credit ${credit0} -> ${credit1}`);
            if (!nv.wokenBy) rec("nap: an unbroken nap sleeps the full length", Math.abs(nv.slept - 2) < 0.01, `seed ${seed} day ${st0.dayNumber}: slept ${nv.slept}h of 2 with no wake reason`);
            if (nv.wokenBy === "event") rec("nap: an event always wakes the player - it is due when they wake", st1.daySchedule?.due === true, `seed ${seed} day ${st0.dayNumber}: woken by an event at ${st1.clockLabel}, schedule ${JSON.stringify(st1.daySchedule)}`);
            rec(`INFO nap woken by ${nv.wokenBy ?? "nothing (full length)"}`, true, "");
          }
          continue;
        }
        if (st0.timeOfDay === "morning" || st0.timeOfDay === "afternoon") { for (let k = 0; k < Math.ceil(adv.held.minutesUntil / 5) + 1 && k < 300; k++) await note(); continue; }
      }
      // A held advance: bed at this night's chosen hour (time passes by messages until then), from the night period on (the bedtime gate).
      const target = BED_HOURS[nights % BED_HOURS.length]!;
      for (let k = 0; k < 400; k++) {
        const st = await call<State>("getGameState");
        const d = depthOf(st.clockLabel);
        if (d && d.h >= target && (st.timeOfDay === "night" || st.timeOfDay === "late-night")) break;
        await note();
      }
      const before = await call<State>("getGameState");
      await checkState("before bed");
      const b = depthOf(before.clockLabel);
      const key = `${user}-bed-${nights}`;
      const meterBefore = (await live()).playerFatigue ?? 0;
      const ti =await call<{ held?: unknown; dailyRecap?: unknown; weekChapter?: { week?: number } }>("turnIn", { idempotencyKey: key });
      if (!ti.held && nights % 4 === 0) {
        const dayA = (await call<State>("getGameState")).clockLabel;
        const ti2 = await call<{ held?: unknown }>("turnIn", { idempotencyKey: key });
        const dayB = (await call<State>("getGameState")).clockLabel;
        rec("N3 a repeated bed (same key) replays and never rolls a second day", JSON.stringify(ti2) === JSON.stringify(ti) && dayA === dayB, `seed ${seed} night ${nights}: clock ${dayA} -> ${dayB}, same view ${JSON.stringify(ti2) === JSON.stringify(ti)}`);
      }
      if (process.env.BWW_DEBUG) console.log(`   turnIn at ${before.clockLabel} (${before.timeOfDay}) -> ${ti.held ? "HELD " + JSON.stringify(ti.held) : "slept"}`);
      if (ti.held) { await note(); continue; } // not bedtime yet (the gate): the next held advance tries again
      nights++;
      const after = await call<State>("getGameState");
      const a = depthOf(after.clockLabel);
      if (b && a) {
        const want = wakeHourAfterBed(b.h);
        rec("wake hour = min(8am, bed + 8h)", Math.abs(a.h - want) < 0.09 || (a.h >= 24 && Math.abs(a.h - 24 - want) < 0.09), `seed ${seed} night ${nights}: bed ${before.clockLabel} -> woke ${after.clockLabel} (want ${want}h)`);
        rec("the day number moves by exactly one", a.day === (before.dayNumber ?? b.day) + 1 || a.day === b.day + 1, `seed ${seed} night ${nights}: ${before.clockLabel} -> ${after.clockLabel}`);
        const early = a.h < 8 || (a.h >= 24 && a.h - 24 < 8);
        if (early && after.timeOfDay) rec("an early wake (before 8am) reads Early morning", after.earlyMorning === true || after.timeOfDay === "early-morning", `seed ${seed} night ${nights}: woke ${after.clockLabel}, timeOfDay ${after.timeOfDay}, earlyMorning ${String(after.earlyMorning)}`);
      }
      if (b) { // sleep debt: tonight's debt is graded by the bed hour (0 by midnight, growing after), and a late night raises the multi-night meter
        const sl = await live(), meterAfter = sl.playerFatigue ?? 0;
        rec("sleep debt: the engine records the bed hour as the night's last-awake hour", typeof sl.lastSleepDepth === "number" && Math.abs(sl.lastSleepDepth - b.h) < 0.09, `seed ${seed} night ${nights}: bed ${b.h.toFixed(2)}h, recorded ${sl.lastSleepDepth}`);
        const debt = sleepDeficitForBedHour(sl.lastSleepDepth ?? b.h);
        const recH = sl.lastSleepDepth ?? b.h; // branch on the hour the engine recorded (the label rounds to the minute)
        rec("sleep debt: none for a bed by midnight, some for a bed after", recH <= 24 ? debt === 0 : debt > 0, `seed ${seed} night ${nights}: bed ${b.h.toFixed(2)}h -> debt ${debt.toFixed(3)}`);
        if (sl.playerFatigue !== undefined) {
          rec("sleep debt: the multi-night meter moves once, at the bed", meterAfter !== meterBefore || (debt === 0 && meterBefore === 0), `seed ${seed} night ${nights}: meter ${meterBefore.toFixed(3)} -> ${meterAfter.toFixed(3)}`);
          if (debt > meterBefore) rec("sleep debt: a night later than the running meter raises it", meterAfter > meterBefore, `seed ${seed} night ${nights}: debt ${debt.toFixed(3)}, meter ${meterBefore.toFixed(3)} -> ${meterAfter.toFixed(3)}`);
        }
      }
      rec("every bedtime carries a day recap", !!ti.dailyRecap, `seed ${seed} night ${nights}: bed ${before.clockLabel} (${before.phase}) had no dailyRecap`);
      const weekNow = after.week ?? before.week ?? 1;
      const chapterDue = (before.week ?? 1) > lastBedWeek;
      rec("the week chapter rolls exactly at the first bed of a new week", !!ti.weekChapter === chapterDue, `seed ${seed} night ${nights}: week ${before.week} (last bed in week ${lastBedWeek}) chapter ${ti.weekChapter ? "given" : "absent"}, phase ${before.phase}, player ${(before as State & { player?: { status?: string } }).player?.status}, keys ${Object.keys(ti).join(",")}`);
      lastBedWeek = before.week ?? lastBedWeek;
      void weekNow;
      await checkState("after wake");
      // N5: before 6am nobody is up (an early riser's own wake can come before 8am - "no houseguest awake until their own wake" - so 6-8am is not checked here).
      if (a && ((a.h >= 24 && a.h - 24 < 6) || a.h < 6)) rec("N5 an early bed wakes alone (no houseguest awake before 6am)", (after.awake ?? []).length === 0, `seed ${seed} night ${nights}: woke ${after.clockLabel} with ${(after.awake ?? []).length} awake`);
      { // N1 / turnIn once: a second goodnight right after waking (a NEW key, so not a replay) is refused, the clock stays and the sleep meter does not move again
        const m0 = (await live()).playerFatigue;
        const again = await call<{ held?: unknown }>("turnIn", { idempotencyKey: `${key}-again` });
        const st3 = await call<State>("getGameState");
        rec("N1 a morning goodnight is refused and the clock stays", !!again.held && st3.clockLabel === after.clockLabel, `seed ${seed} night ${nights}: held ${!!again.held}, clock ${after.clockLabel} -> ${st3.clockLabel}`);
        rec("turnIn once: a second bed the same night moves no sleep state", (await live()).playerFatigue === m0, `seed ${seed} night ${nights}: meter ${m0} -> ${(await live()).playerFatigue}`);
      }
      const ds = (await call<State>("getGameState")).daySchedule;
      if (before.phase === "hoh-competition" && (after.week ?? 0) > 1) {
        rec("W3 after an eviction night the next HOH is on the schedule", ds?.next === "hoh-competition", `seed ${seed} night ${nights}: next ${ds?.next}`);
        rec("W3 the HOH comp is in the afternoon of the new day", (ds as { phase?: string } | null)?.phase === "afternoon", `seed ${seed} night ${nights}: scheduled ${(ds as { phase?: string } | null)?.phase}`);
        rec("W1 eviction night ended on the player's bed (no HOH on the eviction night)", !before.hoh, `seed ${seed} night ${nights}: HOH already crowned before the bed`);
      }
    }
    { const fin = await call<State & { player?: { status?: string } }>("getGameState"); console.log(`seed ${seed}: ${nights} nights, last week ${fin.week}, day ${fin.dayNumber}, player ${fin.player?.status ?? "?"}; weeks start on days ${Object.entries(weekStart).map(([w, d]) => `W${w}:D${d}`).join(" ")}`); }
  }
  console.log(`\nORW-433 bed / wake / week crossover, ${SEEDS} seeds x ${MESSAGES} messages:`);
  for (const [id, r] of R) console.log(`${r.fail.length ? "FAIL" : "PASS"}  ${id}: ${r.pass} ok, ${r.fail.length} failed${r.fail.length ? "  e.g. " + r.fail.slice(0, 3).join(" | ") : ""}`);
}
main().then(() => process.exit(0));
