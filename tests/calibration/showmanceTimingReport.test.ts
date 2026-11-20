import { appendFileSync } from "node:fs";
import { describe, it } from "vitest";
import { playMixGame } from "../support/houseMixDriver";

/**
 * REPORT, NOT A GATE (ORW-736): how fast a showmance builds in PLAYED, chat-paced seasons. Skipped unless ORWELL_SHOWMANCE_TIMING_REPORT=1
 * (ORWELL_SHOWMANCE_TIMING_SEEDS default 10, _MESSAGES default 1500). Per season it prints, for each seeded showmance pair and for the player's own romance, the in-game DAY (and week)
 * each stage was first reached, and the days between stages; then a summary (min / median / max, pairs per stage, public couples and when, stalls and fades). Roles only; no names.
 * An active player runs a romance scene with the person in the room every 40 messages (the player's presentation is a seeded pick so no run assumes one).
 */
const RUN = process.env.ORWELL_SHOWMANCE_TIMING_REPORT === "1";
const N = Number.parseInt(process.env.ORWELL_SHOWMANCE_TIMING_SEEDS ?? "10", 10);
const FROM = Number.parseInt(process.env.ORWELL_SHOWMANCE_TIMING_FROM ?? "1", 10);
const MSGS = Number.parseInt(process.env.ORWELL_SHOWMANCE_TIMING_MESSAGES ?? "1500", 10);
const PRESENTATIONS = ["woman", "man", "nonbinary"] as const;
const OUT = process.env.ORWELL_SHOWMANCE_TIMING_OUT;
/** print, and also append to a file when asked (a long run buffers its console until the end) */
const say = (line: string): void => { console.log(line); if (OUT) appendFileSync(OUT, `${line}\n`); };
type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const ORDER = ["spark", "bond", "visible", "resolved"];
const median = (xs: number[]): number => { if (!xs.length) return NaN; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2; };
const stats = (xs: number[]): string => (xs.length ? `n=${xs.length} min=${Math.min(...xs)} med=${median(xs)} max=${Math.max(...xs)}` : "n=0");

describe.skipIf(!RUN)("showmance timing report (not a gate)", () => {
  it("prints stage timing per season and a summary", async () => {
    const reach: Record<string, number[]> = { spark: [], bond: [], visible: [] }; // first day each stage was reached, over all pairs
    const reachWeek: Record<string, number[]> = { spark: [], bond: [], visible: [] };
    const gaps: Record<string, number[]> = { "spark>bond": [], "bond>visible": [] };
    const romanceDays: number[] = [], playerRomanceDays: number[] = [], playerSceneDays: number[] = [], playerDrawnDays: number[] = [];
    const paceFirst: Record<number, number[]> = { 1: [], 2: [], 3: [], 4: [] }, playerPaceFirst: Record<number, number[]> = { 1: [], 2: [], 3: [], 4: [] };
    let paceRecords = 0, paceFades = 0, playerPaceRecords = 0, pairs = 0, regressions = 0, resolvedBeforeVisible = 0, seasons = 0, seasonDays = 0, publicCouples = 0, playerSeasons = 0, playerWithRomance = 0, visibleNarratorByWk1 = 0;
    for (let seed = FROM; seed < FROM + N; seed++) {
      const gender = PRESENTATIONS[seed % PRESENTATIONS.length]!;
      const first = new Map<string, Record<string, { day: number; week: number }>>();
      const lastStage = new Map<string, string>();
      let playerScene: { day: number; week: number } | undefined, playerDrawn: { day: number; week: number } | undefined, playerRom: { day: number; week: number } | undefined;
      let lastDay = 1;
      const onMessage = async (call: (n: string, a: Record<string, unknown>) => Promise<unknown>, i: number): Promise<void> => {
        if (i % 40 !== 39) return;
        const wa = (await call("whereabouts", {}).catch(() => null)) as { present?: Array<{ id: string }> } | null;
        const others = (wa?.present ?? []).map((x) => x.id).filter((id) => id !== "player");
        if (!others.length) return;
        // the same person each time while they are around (a romance the player keeps up), else whoever is in the room
        const keep = (globalThis as Any).__tmPartner as string | undefined;
        const npc = keep && others.includes(keep) ? keep : others[(i / 40 | 0) % others.length]!;
        (globalThis as Any).__tmPartner = npc;
        await call("recordInteraction", { initiator: "player", witnessSet: ["player", npc], content: "we flirt and sit close, a long warm evening", kind: "showmance" }).catch(() => null);
      };
      (globalThis as Any).__tmPartner = undefined;
      await playMixGame(seed, MSGS, { advanceEvery: 6, playerGender: gender, onMessage, onStep: (s: Any) => {
        const live = s.live; if (!live) return;
        const day = live.dayNumber ?? lastDay; lastDay = day; const week = live.week ?? 1;
        for (const sm of s.seededRels?.showmances ?? []) {
          const k = `${sm.a}|${sm.b}`;
          const f = first.get(k) ?? first.set(k, {}).get(k)!;
          if (!f[sm.stage]) f[sm.stage] = { day, week };
          const prev = lastStage.get(k);
          if (prev && ORDER.indexOf(sm.stage) < ORDER.indexOf(prev)) regressions++;
          lastStage.set(k, sm.stage);
        }
        for (const [pk, d] of Object.entries(live.romances ?? {}) as Array<[string, number]>) {
          if (pk.includes("player")) { if (!playerRom) playerRom = { day: d, week }; } else if (!(globalThis as Any).__tmSeen?.has(`${seed}:${pk}`)) { ((globalThis as Any).__tmSeen ??= new Set()).add(`${seed}:${pk}`); romanceDays.push(d); }
        }
        if (!playerScene) { const evs = s.record?.events?.() ?? []; if (evs.some((e: Any) => e.type === "conversation" && e.interactionKind === "showmance" && e.initiator === "player")) playerScene = { day, week }; }
        if (week <= 1 && (s.visibleShowmances?.().length ?? 0) > 0) visibleNarratorByWk1++;
      }, inspect: (s: Any) => {
        seasons++; seasonDays += s.live?.dayNumber ?? 0;
        for (const sm of s.seededRels?.showmances ?? []) {
          pairs++;
          const f = first.get(`${sm.a}|${sm.b}`) ?? {};
          const line: string[] = [];
          for (const st of ["spark", "bond", "visible"]) { if (f[st]) { reach[st]!.push(f[st]!.day); reachWeek[st]!.push(f[st]!.week); line.push(`${st}=d${f[st]!.day}/w${f[st]!.week}`); } }
          if (f.spark && f.bond) gaps["spark>bond"]!.push(f.bond.day - f.spark.day);
          if (f.bond && f.visible) gaps["bond>visible"]!.push(f.visible.day - f.bond.day);
          if (f.visible) publicCouples++;
          if (sm.stage === "resolved" && !f.visible) resolvedBeforeVisible++;
          say(`TIMING seed=${seed} pair ${line.join(" ") || "no-stage"} final=${sm.stage}`);
        }
        for (const [pk, rec] of Object.entries(s.live?.showmancePace ?? {}) as Array<[string, Any]>) { // ORW-736: the paced levels (flag on): each level's first day, per pair; the player's pair counted apart
          const isPlayer = pk.includes("player");
          paceRecords++; if (isPlayer) playerPaceRecords++;
          const firstTo: Record<number, number> = {};
          for (const st of rec.steps) { if (st.to > st.from && firstTo[st.to] === undefined) firstTo[st.to] = st.day; if (st.to < st.from) paceFades++; }
          for (const lv of [1, 2, 3, 4]) if (firstTo[lv] !== undefined) (isPlayer ? playerPaceFirst : paceFirst)[lv]!.push(firstTo[lv]!);
          say(`TIMING seed=${seed} pace ${isPlayer ? "PLAYER-PAIR" : "pair"} level=${rec.level} steps=${rec.steps.map((x: Any) => `${x.from}>${x.to}@d${x.day}(seen ${x.seenBy.length})`).join(" ") || "none"}`);
        }
        playerSeasons++;
        if (playerScene) playerSceneDays.push(playerScene.day);
        if (playerDrawn) { playerDrawnDays.push(playerDrawn.day); playerWithRomance++; }
        if (playerRom) playerRomanceDays.push(playerRom.day);
        say(`TIMING seed=${seed} days=${s.live?.dayNumber} week=${s.live?.week} player(${gender}->${s.house?.player?.character?.genderPresentation ?? "unset"}) firstScene=${playerScene ? `d${playerScene.day}` : "-"} inRomance(A4)=${playerDrawn ? `d${playerDrawn.day}` : "-"} romanceRecorded=${playerRom ? `d${playerRom.day}` : "-"}`);
      } });
    }
    say(`TIMING SUMMARY seasons=${seasons} meanSeasonDays=${(seasonDays / Math.max(1, seasons)).toFixed(1)} seededPairs=${pairs} publicCouples=${publicCouples} regressions=${regressions} resolvedBeforeVisible=${resolvedBeforeVisible} narratorVisibleInWeek1Steps=${visibleNarratorByWk1}`);
    for (const st of ["spark", "bond", "visible"]) say(`TIMING first day ${st}: ${stats(reach[st]!)} | week: ${stats(reachWeek[st]!)}`);
    for (const g of Object.keys(gaps)) say(`TIMING days ${g}: ${stats(gaps[g]!)}`);
    if (paceRecords) {
      say(`TIMING PACE records=${paceRecords} (player pairs ${playerPaceRecords}) fades=${paceFades}`);
      for (const lv of [1, 2, 3, 4]) say(`TIMING PACE first day at level ${lv} (1 bond, 2 sensed, 3 noticed, 4 known): pairs ${stats(paceFirst[lv]!)} | player ${stats(playerPaceFirst[lv]!)}`);
    }
    say(`TIMING NPC-pair romance recorded (bond record reads showmance) day: ${stats(romanceDays)}`);
    say(`TIMING player: first own scene day ${stats(playerSceneDays)} | A4 in-romance day ${stats(playerDrawnDays)} (${playerWithRomance}/${playerSeasons} seasons) | romance recorded day ${stats(playerRomanceDays)}`);
  }, 3_600_000);
});
