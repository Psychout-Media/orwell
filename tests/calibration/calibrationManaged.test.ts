import { describe, it, expect } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { composeRuntime } from "../../src/composition/runtime";
import { FakeClock } from "../../src/adapters/time/FakeClock";
import { playSeason, type Arm, type SeasonMetrics } from "./calibrationArms";

/**
 * A1 measurement SHARD (opt-in, not in the default suite): plays the `solid` and the jury-managing `managed` arms over seeds [FROM, TO) on the current flag profile and writes
 * `<OUT>/managed-<LABEL>-<from>-<to>.json` for `juryConversionReport.ts` to combine. LABEL is just a name for the flag profile the run used (e.g. "off" / "profiles-on").
 *   ORWELL_MANAGED_FROM / _TO (default 1 / 31), ORWELL_MANAGED_OUT (default tmp/managed), ORWELL_MANAGED_LABEL (default "run"), ORWELL_MANAGED_ARMS (default "solid,managed").
 * Run only when ORWELL_MANAGED=1.
 */
const ON = process.env.ORWELL_MANAGED === "1";
const FROM = Number.parseInt(process.env.ORWELL_MANAGED_FROM ?? "1", 10);
const TO = Number.parseInt(process.env.ORWELL_MANAGED_TO ?? "31", 10);
const LABEL = process.env.ORWELL_MANAGED_LABEL ?? "run";
const OUT = process.env.ORWELL_MANAGED_OUT ?? join("tmp", "managed");
const ARMS = (process.env.ORWELL_MANAGED_ARMS ?? "solid,managed").split(",") as Arm[];
const PER_RUNTIME = 10; // bound memory: a fresh runtime every few seasons (the registry keeps finished sandboxes alive)

(ON ? describe : describe.skip)(`A1 managed-arm measurement shard [${FROM}, ${TO}) ${LABEL}`, () => {
  it("plays its slice and writes the shard file", async () => {
    const rows: Record<string, SeasonMetrics[]> = {};
    for (const arm of ARMS) {
      rows[arm] = [];
      for (let start = FROM; start < TO; start += PER_RUNTIME) {
        const resolver = composeRuntime({ clock: new FakeClock(), seed: 1 }).registry.resolver();
        for (let seed = start; seed < Math.min(TO, start + PER_RUNTIME); seed++) rows[arm]!.push(await playSeason(resolver, seed, arm));
      }
    }
    mkdirSync(OUT, { recursive: true });
    writeFileSync(join(OUT, `managed-${LABEL}-${FROM}-${TO}.json`), JSON.stringify({ label: LABEL, from: FROM, to: TO, rows }));
    expect(Object.values(rows).every((r) => r.length === TO - FROM)).toBe(true);
  }, { timeout: 3_600_000 });
});
