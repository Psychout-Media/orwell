import { AfterAll, BeforeAll } from "@cucumber/cucumber";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// One private TMPDIR per cucumber run, removed at the end (see tests/support/tmpRunGlobalSetup.ts for why).
let run: string | undefined;
BeforeAll(function () {
  run = mkdtempSync(join(tmpdir(), "orwell-run-"));
  process.env["TMPDIR"] = run; process.env["TMP"] = run; process.env["TEMP"] = run;
});
AfterAll(function () {
  if (run) { try { rmSync(run, { recursive: true, force: true }); } catch { /* best effort */ } }
});
