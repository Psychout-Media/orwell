import { describe, it } from "vitest";

/**
 * ORW-229 flaky-test rule (docs/CI.md). A flaky engine test can be QUARANTINED for at most 7 days while its Plane card is worked:
 *
 *   import { quarantine } from "../support/quarantine";
 *   quarantine({ card: "ORW-123", added: "2026-11-06" }).it("does the thing", async () => { ... });
 *
 * It is SKIPPED in PR, merge-queue and main runs and RUNS in the nightly workflow (ORWELL_RUN_QUARANTINED=1). Its name carries the card, so the
 * flake reporter (tests/support/flakyReporter.ts) lists it. tests/unit/ciQuarantineGuard.test.ts fails the build when a quarantine has no Plane card,
 * no added-on date, or is more than 7 days old. Write the object literally, as above: the guard reads it from the source.
 */
export interface Quarantine {
  /** The Plane card that tracks the fix, e.g. "ORW-123". */
  card: string;
  /** The day the test was quarantined, YYYY-MM-DD (UTC). */
  added: string;
}

export const RUN_QUARANTINED = process.env.ORWELL_RUN_QUARANTINED === "1";
export const MAX_QUARANTINE_DAYS = 7;
export const PLANE_CARD = /^[A-Z][A-Z0-9]*-\d+$/;

type TestFn = Parameters<typeof it>[1];
type TestOpts = Parameters<typeof it>[2];

export function quarantine(q: Quarantine): {
  it: (name: string, fn?: TestFn, options?: TestOpts) => void;
  describe: (name: string, fn: () => void) => void;
} {
  const tag = ` [quarantined ${q.card} since ${q.added}]`;
  return {
    it: (name, fn, options) => (RUN_QUARANTINED ? it : it.skip)(name + tag, fn, options),
    describe: (name, fn) => (RUN_QUARANTINED ? describe : describe.skip)(name + tag, fn),
  };
}

// ── the rule, as data (used by the guard test) ───────────────────────────────────────────────────────────────────────────────────────────────
export interface FoundQuarantine {
  file: string;
  line: number;
  card?: string;
  added?: string;
}

const CALL = /\bquarantine\(/g;
const LITERAL = /^quarantine\(\s*\{\s*card:\s*"([^"]*)",\s*added:\s*"([^"]*)"\s*,?\s*\}\s*\)/;

/** Every `quarantine(` call in a source file, with the card and date when written in the literal form. */
export function findQuarantines(file: string, source: string): FoundQuarantine[] {
  const out: FoundQuarantine[] = [];
  for (const m of source.matchAll(CALL)) {
    const at = m.index ?? 0;
    const lit = LITERAL.exec(source.slice(at));
    out.push({ file, line: source.slice(0, at).split("\n").length, ...(lit ? { card: lit[1], added: lit[2] } : {}) });
  }
  return out;
}

const DAY_MS = 86_400_000;

/** The problems with one quarantine on `today` (UTC). Empty means it follows the rule. */
export function quarantineProblems(q: FoundQuarantine, today: Date): string[] {
  const where = `${q.file}:${q.line}`;
  if (q.card === undefined || q.added === undefined)
    return [`${where}: write it as quarantine({ card: "ORW-123", added: "YYYY-MM-DD" }) so the card and the date can be checked`];
  const problems: string[] = [];
  if (!PLANE_CARD.test(q.card)) problems.push(`${where}: "${q.card}" is not a Plane card id (like ORW-123)`);
  const added = /^\d{4}-\d{2}-\d{2}$/.test(q.added) ? new Date(`${q.added}T00:00:00Z`) : new Date(NaN);
  if (Number.isNaN(added.getTime()) || added.toISOString().slice(0, 10) !== q.added) {
    problems.push(`${where}: added "${q.added}" is not a date (YYYY-MM-DD)`);
    return problems;
  }
  const midnight = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const age = Math.round((midnight - added.getTime()) / DAY_MS);
  if (age < -1) problems.push(`${where}: added ${q.added} is in the future`);
  if (age > MAX_QUARANTINE_DAYS)
    problems.push(
      `${where}: quarantined ${age} days ago (${q.added}, ${q.card}); the rule allows ${MAX_QUARANTINE_DAYS}. Fix the test and remove the quarantine, or delete the test.`,
    );
  return problems;
}
