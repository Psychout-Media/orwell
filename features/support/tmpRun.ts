import { AfterAll, BeforeAll } from "@cucumber/cucumber";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeRunOnSignals, RUN_PREFIX, sweepStaleRunDirs } from "../../tests/support/tmpRunSweep";

// One private TMPDIR per cucumber run, removed at the end (see tests/support/tmpRunGlobalSetup.ts for why), swept of stranded ones at the start and removed on SIGTERM/SIGINT too .
let run: string | undefined;
BeforeAll(function () {
  const realTmp = tmpdir();
  run = mkdtempSync(join(realTmp, RUN_PREFIX));
  sweepStaleRunDirs(realTmp, { keep: run });
  process.env["TMPDIR"] = run; process.env["TMP"] = run; process.env["TEMP"] = run;
  removeRunOnSignals(run);
});
AfterAll(function () {
  if (run) { try { rmSync(run, { recursive: true, force: true }); } catch { /* best effort */ } }
});
