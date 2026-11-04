import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { summarize, type Arm, type SeasonMetrics } from "./calibrationArms";
import { poViolations } from "./poTargetBands";
for (const dir of process.argv.slice(2)) {
  const rows: Record<Arm, SeasonMetrics[]> = { passive: [], solid: [], reckless: [] };
  for (const n of readdirSync(dir).filter((x) => /^po-(passive|solid|reckless)-\d+-\d+\.json$/.test(x))) { const f = JSON.parse(readFileSync(join(dir, n), "utf8")); rows[f.arm as Arm].push(...f.rows); }
  const summary = { passive: summarize("passive", rows.passive), solid: summarize("solid", rows.solid), reckless: summarize("reckless", rows.reckless) };
  console.log(dir, JSON.stringify(summary), "VIOLATIONS:", JSON.stringify(poViolations(summary as never)));
}
