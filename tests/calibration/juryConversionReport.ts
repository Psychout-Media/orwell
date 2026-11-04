/**
 * A1 report: combine shard files and print conversion (F2 wins / F2 reached) by arm, by juror archetype and by opponent.
 *   npx tsx tests/calibration/juryConversionReport.ts <dir-with-shards> [more dirs...]   (labels come from the shard files)
 * Roles only. Archetypes are re-derived with `jurorProfile(juror, seed)` (the same hash the engine uses when ORWELL_JUROR_PROFILES=1, so "archetype" is meaningful even for a
 * label that ran with profiles off - it is then a purely descriptive grouping of the same jurors).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { jurorProfile } from "../../src/engine/jurorProfile";
import type { SeasonMetrics } from "./calibrationArms";

interface Shard { label: string; rows: Record<string, SeasonMetrics[]> }
const shards: Shard[] = [];
for (const dir of process.argv.slice(2)) for (const f of readdirSync(dir).filter((n) => /^managed-.*\.json$/.test(n))) shards.push(JSON.parse(readFileSync(join(dir, f), "utf8")) as Shard);

const pct = (k: number, n: number): string => (n ? `${(100 * k / n).toFixed(0)}%` : "n/a");
const labels = [...new Set(shards.map((s) => s.label))];
for (const label of labels) {
  console.log(`\n## profile run: ${label}`);
  const byArm: Record<string, SeasonMetrics[]> = {};
  for (const s of shards.filter((x) => x.label === label)) for (const [arm, rows] of Object.entries(s.rows)) (byArm[arm] ??= []).push(...rows);
  console.log("| arm | seasons | reached F2 | won | conversion (won / F2) |\n|---|---|---|---|---|");
  for (const [arm, rows] of Object.entries(byArm)) {
    const f2 = rows.filter((r) => r.finaleDetail), won = rows.filter((r) => r.won).length;
    console.log(`| ${arm} | ${rows.length} | ${f2.length} (${pct(f2.length, rows.length)}) | ${won} (${pct(won, rows.length)}) | ${won}/${f2.length} = ${pct(won, f2.length)} |`);
  }
  for (const [arm, rows] of Object.entries(byArm)) {
    const f2 = rows.filter((r) => r.finaleDetail);
    if (f2.length === 0) continue;
    const arch: Record<string, { for: number; n: number }> = {};
    for (const r of f2) for (const b of r.finaleDetail!.ballots) { const a = jurorProfile(b.juror, r.seed).archetype; const c = (arch[a] ??= { for: 0, n: 0 }); c.n++; if (b.forPlayer) c.for++; }
    console.log(`\n${arm}: ballot share for the player by juror archetype (${f2.length} finales)`);
    for (const [a, c] of Object.entries(arch).sort()) console.log(`  - ${a}: ${c.for}/${c.n} = ${pct(c.for, c.n)}`);
    const opp: Record<string, { won: number; n: number }> = {};
    for (const r of f2) { const d = r.finaleDetail!; const gap = d.rivalCompWins - d.playerCompWins; const k = gap >= 2 ? "rival has 2+ more comp wins" : gap <= -2 ? "player has 2+ more comp wins" : "comp resumes within 1"; const c = (opp[k] ??= { won: 0, n: 0 }); c.n++; if (r.won) c.won++; }
    console.log(`${arm}: conversion by opponent's resume`);
    for (const [k, c] of Object.entries(opp).sort()) console.log(`  - ${k}: ${c.won}/${c.n} = ${pct(c.won, c.n)}`);
    const margin = f2.map((r) => (r.finale ? r.finale.playerVotes - r.finale.rivalVotes : 0));
    console.log(`${arm}: mean vote margin (player - rival) ${(margin.reduce((a, b) => a + b, 0) / margin.length).toFixed(2)}`);
  }
}
