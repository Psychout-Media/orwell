/**
 * ORW-306 (ORW-253 prep): a BEFORE report of today's off-screen house life, from seeded seasons through the production composition.
 * Run: `npx tsx scripts/offscreen-baseline-report.ts [seeds=5] [outDir=docs/audits]`. Deterministic (seeded), no model calls (the
 * engine-side narrator is the echo port), not a gate. Writes a markdown report and the raw JSON.
 *
 * Two drivers, because the off-screen tick is clocked by the PLAYER'S play: (1) "advance": a passive player who only advances the game and turns in at once
 * when held (the calibration drivers' mode); (2) "chat": the same player passes held time with chat messages (5 in-game minutes each)
 * until the scheduled event is due, which is closer to live play (ticks every SOCIETY_TICK_HOURS of elapsed game time); first 21 days.
 * Off-screen scenes are the engine's hidden NPC-to-NPC events with an `offscreen:` id.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { composeRuntime } from "../src/composition/runtime";
import { FakeClock } from "../src/adapters/time/FakeClock";
import { PLAYER } from "../src/domain/ids";
import type { SessionSnapshot } from "../src/engine/sessionSnapshot";
import { passiveAnswer } from "../tests/property/juryReachShared";
import { endHeldNight } from "../tests/support/heldNight";

type Mode = "advance" | "chat";
/** The chat driver measures the first CHAT_DAYS game days only (each chat message is a real engine commit; a full season is slow). */
const CHAT_DAYS = 21;
interface Scene { day: number; type: string; a: string; b: string; driveMatch: boolean | null }
interface SeasonData { seed: number; mode: Mode; days: number; npcs: string[]; scenes: Scene[]; otherHidden: Record<string, number> }

const DRIVE_TYPES: Record<string, string[]> = {
  target: ["conflict", "strategy", "betrayal", "gossip"], build: ["alliance", "bonding", "strategy", "showmance"],
  "lay-low": ["gossip", "bonding"], "self-preserve": ["strategy", "alliance"], "win-power": ["strategy"],
};

async function playOne(seed: number, mode: Mode): Promise<SeasonData> {
  process.env.ORWELL_BEDTIME_GATE = "0";
  const runtime = composeRuntime({ clock: new FakeClock(), seed });
  const user = `offscreen-baseline-${mode}-${seed}`;
  const mcp = runtime.registry.resolver()("player", user);
  await mcp.callTool("createCharacter", { playerName: "The Player", seed, archetype: "floater" });
  const session = runtime.registry.sandboxFor(user).session as unknown as { drives?: Map<string, { motivation: string; target?: string }> };
  let seen = 0;
  let maxDay = 1;
  const scenes: Scene[] = [];
  const otherHidden: Record<string, number> = {};
  let harvestedDay = 1;
  // Snapshot (a full clone) only when the in-game day turns, attributing the new events to the day that just ended: cheap and exact
  // enough for per-day rates. `force` harvests at the end of the season.
  const harvest = async (force = false): Promise<void> => {
    const st = (await mcp.callTool("gameStatus", {})) as { dayNumber?: number };
    const now = st.dayNumber ?? maxDay;
    maxDay = Math.max(maxDay, now);
    if (!force && now === harvestedDay) return;
    const day = harvestedDay;
    harvestedDay = now;
    const snap = runtime.registry.snapshot(user) as SessionSnapshot;
    for (const e of snap.events.slice(seen)) {
      if (!e.hidden) continue;
      if (e.id.startsWith("offscreen:")) {
        const a = e.witnessSet[0]!, b = e.witnessSet[1]!;
        const d = session.drives?.get(a);
        const driveMatch = d ? (DRIVE_TYPES[d.motivation]?.includes(e.type) ?? false) || d.target === b : null;
        scenes.push({ day, type: e.type, a, b, driveMatch });
      } else {
        const k = e.id.split(":")[0] ?? "other";
        otherHidden[k] = (otherHidden[k] ?? 0) + 1;
      }
    }
    seen = snap.events.length;
  };
  let finished = false;
  for (let i = 0; i < 5_000 && !finished; i++) {
    const adv = (await mcp.callTool("advanceGame", {})) as { finished: boolean; pending?: unknown; held?: unknown };
    finished = adv.finished;
    // advance: turn in at once when the engine holds (the calibration drivers' way). chat: pass the held time by chat messages until the
    // scheduled event is due (5 in-game minutes each), turning in only at night - the production schedule as a chatting player lives it.
    if (adv.held) await endHeldNight((n, a) => mcp.callTool(n, a), `ob${mode}${seed}`, undefined, mode === "advance" ? { direct: true } : undefined);
    if (mode === "chat" && maxDay > CHAT_DAYS) break; // the chat driver is slow: measure its first weeks
    if (adv.pending) finished = ((await mcp.callTool("submitDecision", passiveAnswer(adv.pending as never))) as { finished: boolean }).finished;
    await harvest();
    if (i % 200 === 0) process.stderr.write(`[baseline] ${mode} seed ${seed} step ${i} day ${maxDay}\n`);
  }
  await harvest(true);
  const snap = runtime.registry.snapshot(user) as unknown as { house: { npcs: Array<{ id: string }> } };
  return { seed, mode, days: maxDay, npcs: snap.house.npcs.map((n) => n.id).filter((n) => n !== PLAYER), scenes, otherHidden };
}

function summarize(runs: SeasonData[]) {
  const scenes = runs.flatMap((r) => r.scenes);
  const days = runs.reduce((s, r) => s + r.days, 0);
  const npcDays = runs.reduce((s, r) => s + r.days * r.npcs.length, 0);
  const perNpcDay = new Map<string, number>();
  for (const r of runs) for (const s of r.scenes) for (const p of [s.a, s.b]) { const k = `${r.seed}|${p}|${s.day}`; perNpcDay.set(k, (perNpcDay.get(k) ?? 0) + 1); }
  const types: Record<string, number> = {};
  for (const s of scenes) types[s.type] = (types[s.type] ?? 0) + 1;
  // Persistence of intent: an initiator's partner on one day is again their partner (as initiator) the next day.
  let pairs = 0, kept = 0;
  for (const r of runs) {
    const byDay = new Map<string, Set<string>>();
    for (const s of r.scenes) { const k = `${s.a}|${s.day}`; (byDay.get(k) ?? byDay.set(k, new Set()).get(k)!).add(s.b); }
    for (const [k, partners] of byDay) {
      const [a, d] = k.split("|");
      const next = byDay.get(`${a}|${Number(d) + 1}`);
      if (!next) continue;
      pairs++;
      if ([...partners].some((p) => next.has(p))) kept++;
    }
  }
  const withDrive = scenes.filter((s) => s.driveMatch !== null);
  const distinctPartners = runs.flatMap((r) => r.npcs.map((n) => new Set(r.scenes.filter((s) => s.a === n || s.b === n).map((s) => (s.a === n ? s.b : s.a))).size));
  const other: Record<string, number> = {};
  for (const r of runs) for (const [k, v] of Object.entries(r.otherHidden)) other[k] = (other[k] ?? 0) + v;
  return {
    seasons: runs.length, gameDays: days, scenes: scenes.length,
    scenesPerGameDay: +(scenes.length / Math.max(1, days)).toFixed(2),
    scenesPerNpcPerDay: +((scenes.length * 2) / Math.max(1, npcDays)).toFixed(2),
    npcDaysWithZeroScenes: +(1 - perNpcDay.size / Math.max(1, npcDays)).toFixed(3),
    typeShare: Object.fromEntries(Object.entries(types).sort((x, y) => y[1] - x[1]).map(([k, v]) => [k, +(v / Math.max(1, scenes.length)).toFixed(3)])),
    distinctSceneTypes: Object.keys(types).length,
    meanDistinctPartnersPerNpcPerSeason: +(distinctPartners.reduce((s, x) => s + x, 0) / Math.max(1, distinctPartners.length)).toFixed(2),
    sameTargetNextDay: pairs ? +(kept / pairs).toFixed(3) : null,
    sceneMatchesInitiatorsDrive: withDrive.length ? +(withDrive.filter((s) => s.driveMatch).length / withDrive.length).toFixed(3) : null,
    otherHiddenEvents: other,
  };
}

async function main(): Promise<void> {
  const n = Number(process.argv[2] ?? 5);
  const outDir = process.argv[3] ?? "docs/audits";
  const out: Record<Mode, SeasonData[]> = { advance: [], chat: [] };
  for (const mode of ["advance", "chat"] as Mode[]) for (let seed = 1; seed <= n; seed++) {
    out[mode].push(await playOne(seed, mode));
    process.stderr.write(`[baseline] ${mode} seed ${seed} done\n`);
  }
  const summary = { advance: summarize(out.advance), chat: summarize(out.chat) };
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "2026-11-13-offscreen-life-baseline.json"), JSON.stringify({ summary, perSeason: { advance: out.advance.map((r) => ({ seed: r.seed, days: r.days, scenes: r.scenes.length })), chat: out.chat.map((r) => ({ seed: r.seed, days: r.days, scenes: r.scenes.length })) } }, null, 2));
  const row = (k: keyof ReturnType<typeof summarize>) => `| ${k} | ${JSON.stringify(summary.advance[k])} | ${JSON.stringify(summary.chat[k])} |`;
  const keys: Array<keyof ReturnType<typeof summarize>> = ["seasons", "gameDays", "scenes", "scenesPerGameDay", "scenesPerNpcPerDay", "npcDaysWithZeroScenes", "distinctSceneTypes", "typeShare", "meanDistinctPartnersPerNpcPerSeason", "sameTargetNextDay", "sceneMatchesInitiatorsDrive", "otherHiddenEvents"];
  writeFileSync(join(outDir, "2026-11-13-offscreen-life-baseline.md"), [
    "# Off-screen life: the BEFORE baseline (ORW-306, 2026-11-13)", "",
    "Generated by `npx tsx scripts/offscreen-baseline-report.ts " + n + "` on main before ORW-312/315 change NPC behaviour. Seeded, no model calls, not a gate.",
    "Two drivers: **advance** (a passive player who only advances: the calibration mode) and **chat** (the same player passes waiting time by chat messages, 5 in-game minutes each, until the scheduled event is due, and turns in only at night: closer to live play; first 21 game days).",
    "", "| metric | advance | chat |", "|---|---|---|", ...keys.map(row), "",
    "**How to read it.** `scenesPerNpcPerDay` counts each scene for both participants. `npcDaysWithZeroScenes` is the share of houseguest-days with no off-screen scene at all. `sameTargetNextDay` is how often an initiator seeks out a partner again the next day (persistence of intent). `sceneMatchesInitiatorsDrive` is how often the scene type fits the initiator's current drive (the 7-type weight table picks the type after the pair, so a low value is expected today).",
    "", "Re-run after ORW-315 (hour-by-hour house life) with the same command for the AFTER numbers.",
  ].join("\n") + "\n");
  process.stderr.write(JSON.stringify(summary, null, 2) + "\n");
}

void main();
