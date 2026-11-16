import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeRunOnSignals, RUN_PREFIX, sweepStaleRunDirs } from "./tmpRunSweep";

/**
 * Per-run temp dir (Coordinator 2026-11-04: ~7,800 leaked `orwell-*` dirs, ~8 GB, filled the 10 GB RAM-backed /tmp). ~95 test sites `mkdtemp` under os.tmpdir() without
 * cleanup; rather than patch each, the whole run gets ONE private TMPDIR that is removed at the end - every `mkdtemp(join(tmpdir(), ...))` lands inside it. Workers inherit the env.
 * a killed run (a command timeout, a dropped session, an OOM kill) used to strand its folder; now the next run sweeps stranded ones (this user's, older than 20 minutes, not in use by a
 * live process) and a SIGTERM/SIGINT removes the folder before the process exits. Guard: tests/unit/tmpRunIsolation.test.ts, tests/unit/tmpRunSweep.test.ts.
 */
export default function setup(): () => void {
  const realTmp = tmpdir();
  const run = mkdtempSync(join(realTmp, RUN_PREFIX));
  sweepStaleRunDirs(realTmp, { keep: run });
  process.env["TMPDIR"] = run;
  process.env["TMP"] = run;
  process.env["TEMP"] = run;
  removeRunOnSignals(run);
  return () => {
    try { rmSync(run, { recursive: true, force: true }); } catch { /* best effort */ }
  };
}
