/**
 * ORW-353: does drama BUILD across the weeks? Per game week, pooled over the seeds (NPC life regardless of the player's status): house-life scenes, conflict scenes (and how many were `confront`, a goal turning into a clash), alliance betrayals, and rates per
 * 1000 scenes. Usage: npx tsx scripts/probes/dramaByWeek.ts [messages=800] [seeds=12]
 */
import { playMixGame } from "../../tests/support/houseMixDriver";

const MESSAGES = Number(process.argv[2] ?? 800), SEEDS = Number(process.argv[3] ?? 12);
(async () => {
  const wk = new Map<number, { scenes: number; conflict: number; confront: number; betray: number; seeds: Set<number> }>();
  const row = (w: number) => { let r = wk.get(w); if (!r) { r = { scenes: 0, conflict: 0, confront: 0, betray: 0, seeds: new Set() }; wk.set(w, r); } return r; };
  for (let seed = 1; seed <= SEEDS; seed++) {
    const g = await playMixGame(seed, MESSAGES);
    for (const s of g.scenes) { const r = row(s.week); r.scenes++; r.seeds.add(seed); if (s.type === "conflict") { r.conflict++; if (s.action === "confront") r.confront++; } }
    for (const [w, n] of Object.entries(g.betrayalsByWeek)) row(Number(w)).betray += n;
  }
  console.log(`DRAMA BY WEEK (${SEEDS} seeds x ${MESSAGES} msgs): week | seeds still playing | scenes | conflict (confront) per 1000 scenes | betrayals per 1000 scenes`);
  for (const [w, r] of [...wk.entries()].sort((a, b) => a[0] - b[0])) {
    console.log(`  week ${w}: seeds ${r.seeds.size}  scenes ${r.scenes}  conflict ${r.conflict} (${r.confront} confront) = ${(1000 * r.conflict / Math.max(1, r.scenes)).toFixed(0)}/1000   betrayals ${r.betray} = ${(1000 * r.betray / Math.max(1, r.scenes)).toFixed(1)}/1000`);
  }
})();
