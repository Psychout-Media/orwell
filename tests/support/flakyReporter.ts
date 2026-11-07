import { appendFileSync } from "node:fs";
import type { File, Reporter, Task } from "vitest";

/**
 * ORW-229 flaky-test rule (docs/CI.md): CI retries a failed engine test once (`--retry=1`). A test that passes only on that retry is a FLAKE, and a
 * flake must be counted, not hidden. This reporter lists every test that needed a retry (and any test that stayed red after it) in the GitHub job
 * summary and as a warning annotation, and lists the quarantined tests that were skipped. Wired in vitest.config.ts when GITHUB_ACTIONS is set, and
 * passed explicitly where a lane replaces the reporters (`--reporter=blob` in coverage-shard). Pinned by tests/unit/flakyReporter.test.ts.
 */
export interface RetryRow {
  file: string;
  test: string;
  retries: number;
}
export interface FlakeReport {
  flaky: RetryRow[];
  stillRed: RetryRow[];
  quarantined: { file: string; test: string }[];
}

const QUARANTINE_TAG = /\[quarantined [A-Z][A-Z0-9]*-\d+ since \d{4}-\d{2}-\d{2}\]/;

function fullName(task: Task, file: File): string {
  const parts: string[] = [];
  for (let t: Task | undefined = task; t && t !== file; t = t.suite) parts.unshift(t.name);
  return parts.join(" > ");
}

function walk(task: Task, out: Task[]): void {
  if (task.type === "test" || task.type === "custom") out.push(task);
  if ("tasks" in task) for (const child of task.tasks) walk(child, out);
}

export function collectFlakes(files: readonly File[]): FlakeReport {
  const report: FlakeReport = { flaky: [], stillRed: [], quarantined: [] };
  for (const file of files) {
    const tests: Task[] = [];
    walk(file, tests);
    for (const t of tests) {
      const retries = t.result?.retryCount ?? 0;
      const row = { file: file.name, test: fullName(t, file), retries };
      if (retries > 0 && t.result?.state === "pass") report.flaky.push(row);
      else if (retries > 0 && t.result?.state === "fail") report.stillRed.push(row);
      // the full name, so a test inside a quarantine(...).describe(...) (the tag is on the suite's name) is listed too (#2279 review)
      const skipped = t.mode === "skip" || t.result?.state === "skip"; // vitest 2.1.9 sets the mode; the result covers a version that does not (#2305 review)
      if (skipped && QUARANTINE_TAG.test(row.test)) report.quarantined.push({ file: file.name, test: row.test });
    }
  }
  return report;
}

const cell = (s: string): string => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

export function summaryMarkdown(r: FlakeReport, lane: string): string {
  if (r.flaky.length + r.stillRed.length + r.quarantined.length === 0) return "";
  let md = `### Flaky tests (vitest${lane ? `, ${lane}` : ""})\n\n`;
  if (r.flaky.length) {
    md += `**${r.flaky.length} test(s) failed, then passed on the automatic retry.** Each is a flake: fix it, or quarantine it with a Plane card (docs/CI.md).\n\n`;
    md += "| file | test | retries |\n|---|---|---|\n" + r.flaky.map((x) => `| ${cell(x.file)} | ${cell(x.test)} | ${x.retries} |`).join("\n") + "\n\n";
  }
  if (r.stillRed.length) {
    md += `**${r.stillRed.length} test(s) were still red after the retry** (a real failure, or a hard flake).\n\n`;
    md += "| file | test |\n|---|---|\n" + r.stillRed.map((x) => `| ${cell(x.file)} | ${cell(x.test)} |`).join("\n") + "\n\n";
  }
  if (r.quarantined.length) {
    md += `${r.quarantined.length} quarantined test(s) skipped here (they run in the nightly workflow):\n\n`;
    md += r.quarantined.map((x) => `- ${cell(x.file)}: ${cell(x.test)}`).join("\n") + "\n\n";
  }
  return md;
}

export default class FlakyReporter implements Reporter {
  onFinished(files: File[] = []): void {
    const r = collectFlakes(files);
    const lane = process.env.ORWELL_FLAKE_LANE ?? "";
    console.log(`[flaky-report] ${r.flaky.length} passed only on a retry, ${r.stillRed.length} still red after a retry, ${r.quarantined.length} quarantined and skipped`);
    for (const x of r.flaky) console.log(`::warning title=Flaky test (passed on retry)::${x.file} > ${x.test}`);
    for (const x of r.quarantined) console.log(`[flaky-report] quarantined, skipped here (runs nightly): ${x.file} > ${x.test}`);
    const md = summaryMarkdown(r, lane);
    if (md && process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
  }
}
