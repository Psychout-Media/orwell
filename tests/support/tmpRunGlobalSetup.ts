import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Per-run temp dir (Coordinator 2026-11-04: ~7,800 leaked `orwell-*` dirs, ~8 GB, filled the 10 GB RAM-backed /tmp). ~95 test sites `mkdtemp` under os.tmpdir() without
 * cleanup; rather than patch each, the whole run gets ONE private TMPDIR that is removed at the end - every `mkdtemp(join(tmpdir(), ...))` lands inside it. Workers inherit the env.
 * Guard: tests/unit/tmpRunIsolation.test.ts. Cucumber has the same (features/support/tmpRun.ts).
 */
export default function setup(): () => void {
  const realTmp = tmpdir();
  // A killed run (OOM, ctrl-C, a remote SSH drop) skips its teardown and strands its `orwell-run-*`; sweep ones older than 6h so they cannot pile up.
  try {
    for (const n of readdirSync(realTmp)) {
      if (!n.startsWith("orwell-run-")) continue;
      const p = join(realTmp, n);
      if (Date.now() - statSync(p).mtimeMs > 6 * 3600_000) rmSync(p, { recursive: true, force: true });
    }
  } catch { /* best effort */ }
  const run = mkdtempSync(join(realTmp, "orwell-run-"));
  process.env["TMPDIR"] = run;
  process.env["TMP"] = run;
  process.env["TEMP"] = run;
  return () => {
    try { rmSync(run, { recursive: true, force: true }); } catch { /* best effort */ }
  };
}
