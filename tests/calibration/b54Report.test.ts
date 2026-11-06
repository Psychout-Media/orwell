import { it } from "vitest";
import { composeRuntime } from "../../src/composition/runtime";
import { FakeClock } from "../../src/adapters/time/FakeClock";
import { playSeason, summarize, type Arm, type SeasonMetrics } from "./calibrationArms";
import { poViolations } from "./poTargetBands";
// B36 REPORT-ONLY (untracked scratch): plays passive/solid/reckless for seeds 1..N on the current env profile and PRINTS the summary + band violations. Never asserts.
const N = Number.parseInt(process.env.ORWELL_PO_SEEDS ?? "100", 10);
it("b54 report", async () => {
  const rows: Record<string, SeasonMetrics[]> = {};
  for (const arm of ["passive", "solid", "reckless"] as Exclude<Arm, "managed">[]) {
    rows[arm] = [];
    for (let start = 1; start <= N; start += 10) {
      const rt = composeRuntime({ clock: new FakeClock(), seed: 1 });
      const res = rt.registry.resolver();
      for (let seed = start; seed < Math.min(N + 1, start + 10); seed++) rows[arm]!.push(await playSeason(res, seed, arm));
    }
  }
  const summary = { passive: summarize("passive", rows.passive!), solid: summarize("solid", rows.solid!), reckless: summarize("reckless", rows.reckless!) };
  console.log("B54REPORT " + JSON.stringify({ copresence: process.env.ORWELL_GOSSIP_COPRESENCE, seeds: N, summary, violations: poViolations(summary) }));
}, { timeout: 4 * 3_600_000 });
