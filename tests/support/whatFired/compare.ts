import type { TraceRow } from "./player";

/** ORW-729: the save/restart comparer. Two traces of the same seeded season: the first row that differs is a finding. Pure; no game content (rows are counts and hashes). */
export interface Difference { at: number; field: "events" | "last-event" | "state" | "length" }

export function firstDifference(a: readonly TraceRow[], b: readonly TraceRow[]): Difference | null {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i]!, y = b[i]!;
    if (x.ev !== y.ev) return { at: x.i, field: "events" };
    if (x.last !== y.last) return { at: x.i, field: "last-event" };
    if (x.st !== undefined && y.st !== undefined && x.st !== y.st) return { at: x.i, field: "state" };
  }
  if (a.length !== b.length) return { at: n, field: "length" };
  return null;
}

/** Seeded restart points: spread over the first 90% of the season so the restart lands mid-play, never in the last message. Deterministic per (seed, count). */
export function restartPoints(seed: number, count: number, seasonMessages: number): number[] {
  let s = (seed * 2654435761) >>> 0;
  const next = (): number => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
  const hi = Math.max(2, Math.floor(seasonMessages * 0.9));
  return Array.from({ length: count }, () => 1 + Math.floor(next() * (hi - 1))).sort((x, y) => x - y);
}

/**
 * What a restart difference MEANS. The off-screen random stream is created per sandbox from the seed and is not part of the save (orchestrator `rngFor`), so a restarted season is not byte-identical
 * to the uninterrupted one from the first tick after the restart: that is "continues-differently" (reported, but kept apart). "state-lost" is the finding that matters: the restarted game differs AT or
 * BEFORE the restart point, or its event count falls (a save that dropped something).
 */
export type RestartVerdict = "identical" | "continues-differently" | "state-lost";
export function restartVerdict(point: number, diff: Difference | null, restartTrace: readonly TraceRow[]): RestartVerdict {
  const before = restartTrace[point]?.ev ?? 0;
  for (let i = point + 1; i < restartTrace.length; i++) if (restartTrace[i]!.ev < before) return "state-lost";
  if (!diff) return "identical";
  return diff.at <= point ? "state-lost" : "continues-differently";
}
