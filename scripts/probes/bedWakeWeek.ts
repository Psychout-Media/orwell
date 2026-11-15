/**
 * ORW-433 (Ryne: "deep testing on how the turn over going to bed / waking up goes, as well as crossovers from week to week"): engine-level checks on a chat-paced
 * seeded game (the same driver as the house-mix guard), across seeds, for the deterministic parts of bedtime, waking and the week crossover. No narrator.
 *   npx tsx scripts/probes/bedWakeWeek.ts [messages=1300] [seeds=12]
 * Every turn-in is made at a chosen bed hour (cycling evening, late evening, midnight, small hours) and read before and after. Prints one line per check with
 * its pass count and the first failures (seed, day, what was seen). Read-only: a throwaway game on a fake clock. Roles only.
 */
import { composeRuntime } from "../../src/composition/runtime";
import { FakeClock } from "../../src/adapters/time/FakeClock";
import { wakeHourAfterBed } from "../../src/engine/timeOfDay";

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
      const mo = (st as State & { moment?: string }).moment;
      const mw = typeof mo === "string" ? /Week (\d+)/.exec(mo) : null;
      if (mw && typeof st.week === "number" && st.week > 0) rec("W10 the week in the moment label = the engine week", Number(mw[1]) === st.week, `seed ${seed} ${where}: moment "${mo}" vs week ${st.week}`);
      const house = st.whereabouts?.counts?.house;
      const full = st as State & { house?: Array<{ status?: string }>; player?: { status?: string } };
      if (typeof house === "number" && st.phase !== "premiere" && Array.isArray(full.house)) {
        const playerIn = full.player?.status === "active";
        const inHouse = full.house.filter((r) => r.status === "active").length + (playerIn ? 1 : 0);
        rec("headcount: the house count includes the player", house === inHouse, `seed ${seed} ${where}: house ${house} vs ${inHouse} active (player ${playerIn ? "in" : "out"})`);
      }
    };

    let lastHoh: string | null = null, hohWeek = 0;
    for (let i = 0; i < MESSAGES; i++) {
      await note();
      if (i % 12 !== 11) continue;
      {
        const gs = await call<{ hoh?: { id?: string } | null; week?: number; whereabouts?: { houseEvent?: { kind?: string; competing?: Array<{ id: string }> } } }>("getGameState");
        const he = gs.whereabouts?.houseEvent;
        if (he?.kind === "hoh-competition" && Array.isArray(he.competing) && lastHoh && (gs.week ?? 0) > hohWeek)
          rec("W4 the outgoing HOH does not play the next HOH comp", !he.competing.some((c) => c.id === lastHoh), `seed ${seed} week ${gs.week}: outgoing HOH ${lastHoh} is in the field`);
        const st2 = await call<{ hoh?: { id?: string } | null; week?: number }>("gameStatus");
        if (st2.hoh?.id && (st2.week ?? 0) > hohWeek) { lastHoh = st2.hoh.id; hohWeek = st2.week ?? hohWeek; }
      }
      const adv = (await call<{ pending?: { kind: string; options?: Array<{ id: string }> }; held?: { next?: string; minutesUntil?: number } }>("advanceGame"));
      if (adv.pending) {
        const k = adv.pending.kind, o = (j: number) => adv.pending!.options?.[j]?.id;
        try {
          await call("submitDecision", (k === "nominations" ? { kind: k, choice: [o(0), o(1)] } : k === "veto-decision" ? { kind: k, use: false } : k === "comp-intent" || k === "comp-round" ? { kind: k, intent: "compete" } : { kind: k, choice: o(0), vote: o(0) }) as never);
        } catch { /* a closed-set pick this driver cannot answer is skipped; the next advance re-offers it */ }
        continue;
      }
      if (!adv.held) continue;
      // A DAYTIME "not due yet" hold names the event and the minutes until it: let that time pass (going to bed instead skipped the event's day, so the game
      // never left Week 1). Only a night hold (or a hold with nothing named) is a bed.
      if (adv.held.next && adv.held.next !== "bedtime" && typeof adv.held.minutesUntil === "number" && adv.held.minutesUntil > 0) {
        const st0 = await call<State>("getGameState");
        if (st0.timeOfDay !== "night" && st0.timeOfDay !== "late-night") { for (let k = 0; k < Math.ceil(adv.held.minutesUntil / 5) + 1 && k < 300; k++) await note(); continue; }
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
      const ti = await call<{ held?: unknown; dailyRecap?: unknown; weekChapter?: { week?: number } }>("turnIn", { idempotencyKey: key });
      if (!ti.held && nights % 4 === 0) {
        const dayA = (await call<State>("getGameState")).clockLabel;
        const ti2 = await call<{ held?: unknown }>("turnIn", { idempotencyKey: key });
        const dayB = (await call<State>("getGameState")).clockLabel;
        rec("N3 a repeated bed (same key) replays and never rolls a second day", JSON.stringify(ti2) === JSON.stringify(ti) && dayA === dayB, `seed ${seed} night ${nights}: clock ${dayA} -> ${dayB}, same view ${JSON.stringify(ti2) === JSON.stringify(ti)}`);
      }
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
      rec("every bedtime carries a day recap", !!ti.dailyRecap, `seed ${seed} night ${nights}: bed ${before.clockLabel} (${before.phase}) had no dailyRecap`);
      const weekNow = after.week ?? before.week ?? 1;
      const chapterDue = (before.week ?? 1) > lastBedWeek;
      rec("the week chapter rolls exactly at the first bed of a new week", !!ti.weekChapter === chapterDue, `seed ${seed} night ${nights}: week ${before.week} (last bed in week ${lastBedWeek}) chapter ${ti.weekChapter ? "given" : "absent"}`);
      lastBedWeek = before.week ?? lastBedWeek;
      void weekNow;
      await checkState("after wake");
      // N5: before 6am nobody is up (an early riser's own wake can come before 8am - "no houseguest awake until their own wake" - so 6-8am is not checked here).
      if (a && ((a.h >= 24 && a.h - 24 < 6) || a.h < 6)) rec("N5 an early bed wakes alone (no houseguest awake before 6am)", (after.awake ?? []).length === 0, `seed ${seed} night ${nights}: woke ${after.clockLabel} with ${(after.awake ?? []).length} awake`);
      if (nights % 3 === 1) { // N1: a goodnight right after waking (the morning) is refused and the clock does not move
        const again = await call<{ held?: unknown }>("turnIn");
        const st3 = await call<State>("getGameState");
        rec("N1 a morning goodnight is refused and the clock stays", !!again.held && st3.clockLabel === after.clockLabel, `seed ${seed} night ${nights}: held ${!!again.held}, clock ${after.clockLabel} -> ${st3.clockLabel}`);
      }
      const ds = (await call<State>("getGameState")).daySchedule;
      if (before.phase === "hoh-competition" && (after.week ?? 0) > 1) {
        rec("W3 after an eviction night the next HOH is on the schedule", ds?.next === "hoh-competition", `seed ${seed} night ${nights}: next ${ds?.next}`);
        rec("W3 the HOH comp is in the afternoon of the new day", (ds as { phase?: string } | null)?.phase === "afternoon", `seed ${seed} night ${nights}: scheduled ${(ds as { phase?: string } | null)?.phase}`);
        rec("W1 eviction night ended on the player's bed (no HOH on the eviction night)", !before.hoh, `seed ${seed} night ${nights}: HOH already crowned before the bed`);
      }
    }
    console.log(`seed ${seed}: ${nights} nights, last week ${(await call<State>("getGameState")).week}`);
  }
  console.log(`\nORW-433 bed / wake / week crossover, ${SEEDS} seeds x ${MESSAGES} messages:`);
  for (const [id, r] of R) console.log(`${r.fail.length ? "FAIL" : "PASS"}  ${id}: ${r.pass} ok, ${r.fail.length} failed${r.fail.length ? "  e.g. " + r.fail.slice(0, 3).join(" | ") : ""}`);
}
main().then(() => process.exit(0));
