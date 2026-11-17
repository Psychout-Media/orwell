/**
 * ORW-508 Layer 1 + acceptance: deal a cast's jobs from the world job table.
 *
 * One `rng.next()` per attempt on the caller's own side stream. A draw is kept only when the person can be
 * that age in that job (licence and seniority floors from the table and the named rules), the job is not
 * already in the cast (at most `maxEach` of one job), no more than `MAX_PER_GROUP` of one occupation group
 * sit in a cast, and the recent-seasons memory has not just used it. Bounded retries loosen those one at a
 * time; the last resort is a plain job that needs no licence and no particular town.
 */
import type { RandomnessSource } from "../../ports/RandomnessSource";
import type { AvoidSets } from "../../domain/recentSeasons";
import { WORLD_JOBS, JOB_FLATTEN, type WorldJob } from "./worldJobs";
import { buildTable, drawConstrained } from "./worldSampler";
import { ageProblem, countRejection, SAFE_VOCATIONS, type AcceptanceReport } from "./worldPlausibility";

/** No more than this many jobs from one occupation group in a cast (health practitioners, food service, ...). */
export const MAX_PER_JOB_GROUP = 4;
const TABLE = buildTable(WORLD_JOBS, (j) => j.weight, JOB_FLATTEN);

/** The name of the rule a (job, age) breaks, or null. */
export function jobAgeProblem(job: WorldJob, age: number): string | null {
  if (age < job.minAge) return `min-age-${job.minAge}`;
  return ageProblem(job.job, age);
}

export function dealWorldVocations(
  rng: RandomnessSource, ages: readonly number[], maxEach: number, avoid?: AvoidSets, report?: AcceptanceReport,
): string[] {
  const uses = new Map<string, number>();
  const groups = new Map<string, number>();
  return ages.map((age, i) => {
    const ageOk = (j: WorldJob): boolean => {
      const why = jobAgeProblem(j, age);
      if (why) countRejection(report, why);
      return why === null;
    };
    const fresh = (j: WorldJob): boolean => (uses.get(j.job) ?? 0) < maxEach;
    const spread = (j: WorldJob): boolean => j.group === "legacy" || (groups.get(j.group) ?? 0) < MAX_PER_JOB_GROUP;
    const avoided = (j: WorldJob): boolean => !!avoid && avoid.vocations.has(j.job.toLowerCase());
    const ok = (j: WorldJob): boolean => jobAgeProblem(j, age) === null;
    const row = drawConstrained(rng, TABLE, [
      (j) => ageOk(j) && fresh(j) && spread(j) && !avoided(j),
      (j) => ok(j) && fresh(j) && !avoided(j),
      (j) => ok(j) && fresh(j),
    ], 80);
    let job = row.job;
    if (jobAgeProblem(row, age) !== null || !fresh(row)) { job = SAFE_VOCATIONS[i % SAFE_VOCATIONS.length]!; if (report) report.fallbacks++; }
    uses.set(job, (uses.get(job) ?? 0) + 1);
    const g = WORLD_JOBS.find((x) => x.job === job)?.group ?? "legacy";
    groups.set(g, (groups.get(g) ?? 0) + 1);
    return job;
  });
}
