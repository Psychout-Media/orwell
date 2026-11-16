/**
 * ORW-508 Layer 1: the job table, at real-world frequency with a casting lean.
 *
 * Source: US Bureau of Labor Statistics, Occupational Employment and Wage Statistics, national, May 2023
 * (public domain), reduced by `scripts/orw508-build-world-tables.py` to `world/jobs.json` (about 350 plain
 * job names, a weight, a minimum age by licence or seniority, and farm-style jobs that do not exist in a big
 * city). The weight is employment times an authored lean per major group (more arts, food and personal
 * care, fewer clerks and factory jobs: who the show casts), so five first responders in one cast is as
 * unlikely as it is in the world. The 124 hand-written jobs of the old list ride along as a small share of
 * the weight (the on-a-reality-show curios the government table does not have).
 */
import jobsJson from "./world/jobs.json";
import { VOCATIONS } from "./vocations";
import type { SizeClass } from "./worldPlaces";

export interface WorldJob {
  readonly job: string;
  readonly weight: number;
  readonly minAge: number;
  readonly maxSize?: SizeClass;
  /** The SOC major group ("29" health practitioners), or "legacy" for the hand-written jobs. */
  readonly group: string;
}

/** Share of all draw weight held by the hand-written jobs. */
export const LEGACY_JOB_SHARE = 0.1;
/** Exponent on the weight: 1 is the labour market's own frequency; lower lifts rarer jobs so a cast shows variety. */
export const JOB_FLATTEN = 0.3;

export const WORLD_JOBS: readonly WorldJob[] = (() => {
  const rows = (jobsJson.rows as unknown as ReadonlyArray<readonly [string, number, string, number, string]>).map(
    ([job, weight, soc, minAge, maxSize]): WorldJob => ({ job, weight, minAge, group: soc.slice(0, 2), ...(maxSize ? { maxSize: maxSize as SizeClass } : {}) }),
  );
  const have = new Set(rows.map((r) => r.job.toLowerCase()));
  const legacy = VOCATIONS.filter((v) => !have.has(v.toLowerCase()));
  const total = rows.reduce((a, r) => a + Math.pow(r.weight, JOB_FLATTEN), 0);
  // each legacy job carries an equal slice of the legacy share, in flattened weight units
  const each = legacy.length > 0 ? Math.pow((total * LEGACY_JOB_SHARE) / (1 - LEGACY_JOB_SHARE) / legacy.length, 1 / JOB_FLATTEN) : 0;
  return [...rows, ...legacy.map((job): WorldJob => ({ job, weight: each, minAge: 0, group: "legacy" }))];
})();

export const JOB_INDEX: ReadonlyMap<string, WorldJob> = new Map(WORLD_JOBS.map((j) => [j.job.toLowerCase(), j]));
