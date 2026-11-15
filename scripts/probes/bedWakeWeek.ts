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

const MESSAGES = Number(process.argv[2] ?? 1300), SEEDS = Number(process.argv[3] ?? 12);
const BED_HOURS = [21, 22.5, 24, 25.5, 26.5]; // 9pm, 10:30pm, midnight, 1:30am, 2:30am (clock hours past midnight run 24..32)
type Res = { pass: number; fail: string[] };
const R = new Map<string, Res>();
const rec = (id: string, ok: boolean, why: string): void => { const r = R.get(id) ?? { pass: 0, fail: [] }; if (ok) r.pass++; else r.fail.push(why); R.set(id, r); };

type Status = { timeOfDay?: string; dayNumber?: number; week?: number; phase?: string; asleep?: Array<{ id: string }>; awake?: Array<{ id: string }>; earlyMorning?: boolean };
type State = Status & { clockLabel?: string; whereabouts?: { counts?: { house?: number; room?: number } } | null; daySchedule?: { next?: string; due?: boolean } | null; started?: boolean };

/** Clock hours on the engine's 8..32 night-depth scale, from "h:mmam, Day N" (an hour before 8am belongs to the night that started the day before). */
function depthOf(label?: string): { h: number; day: number } | null {
  const m = /^(\d{1,2}):(\d{2})(am|pm), Day (\d+)$/.exec(label ?? "");
  if (!m) return null;
  let h = (Number(m[1]) % 12) + (m[3] === "pm" ? 12 : 0) + Number(m[2]) / 60;
  if (h < 8) h += 24;
  return { h, day: Number(m[4]) };
}

async function main() {
  for (let seed = 1; seed <= SEEDS; seed++) {
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
      }
      const house = st.whereabouts?.counts?.house;
      const full = st as State & { house?: Array<{ status?: string }>; player?: { status?: string } };
      if (typeof house === "number" && st.phase !== "premiere" && Array.isArray(full.house)) {
        const playerIn = full.player?.status === "active";
        const inHouse = full.house.filter((r) => r.status === "active").length + (playerIn ? 1 : 0);
        rec("headcount: the house count includes the player", house === inHouse, `seed ${seed} ${where}: house ${house} vs ${inHouse} active (player ${playerIn ? "in" : "out"})`);
      }
    };

    for (let i = 0; i < MESSAGES; i++) {
      await note();
      if (i % 12 !== 11) continue;
      const adv = (await call<{ pending?: { kind: string; options?: Array<{ id: string }> }; held?: { next?: string; minutesUntil?: number } }>("advanceGame"));
      if (adv.pending) {
        const k = adv.pending.kind, o = (j: number) => adv.pending!.options?.[j]?.id;
        try {
          await call("submitDecision", (k === "nominations" ? { kind: k, choice: [o(0), o(1)] } : k === "veto-decision" ? { kind: k, use: false } : k === "comp-intent" || k === "comp-round" ? { kind: k, intent: "compete" } : { kind: k, choice: o(0), vote: o(0) }) as never);
        } catch { /* a closed-set pick this driver cannot answer is skipped; the next advance re-offers it */ }
        continue;
      }
      if (!adv.held) continue;
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
      const ti = await call<{ held?: unknown; dailyRecap?: unknown; weekChapter?: { week?: number } }>("turnIn");
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
      const ds = (await call<State>("getGameState")).daySchedule;
      if (before.phase === "hoh-competition" && (after.week ?? 0) > 1) rec("after an eviction night the next HOH is on the schedule", ds?.next === "hoh-competition", `seed ${seed} night ${nights}: next ${ds?.next}`);
    }
    console.log(`seed ${seed}: ${nights} nights, last week ${(await call<State>("getGameState")).week}`);
  }
  console.log(`\nORW-433 bed / wake / week crossover, ${SEEDS} seeds x ${MESSAGES} messages:`);
  for (const [id, r] of R) console.log(`${r.fail.length ? "FAIL" : "PASS"}  ${id}: ${r.pass} ok, ${r.fail.length} failed${r.fail.length ? "  e.g. " + r.fail.slice(0, 3).join(" | ") : ""}`);
}
main().then(() => process.exit(0));
