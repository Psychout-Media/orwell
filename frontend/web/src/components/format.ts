import type { GameState, NamedRef } from '../api/types';

export function refName(r: NamedRef | string | null | undefined): string | null {
  if (!r) return null;
  return typeof r === 'string' ? r : r.name;
}

export function titleCase(s: string): string {
  return s.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export interface StatusView {
  day: string | null;
  timeOfDay: string | null;
  phase: string | null;
  week: string | null;
}

/** Status bar contents from the shared game slice. Missing fields simply leave their chip out. */
export function statusView(g: GameState | null): StatusView {
  if (!g || !g.started) return { day: null, timeOfDay: null, phase: null, week: null };
  return {
    week: typeof g.week === 'number' ? `Week ${g.week}` : null,
    day: typeof g.dayNumber === 'number' && g.dayNumber > 0 ? `Day ${g.dayNumber}` : null,
    timeOfDay: g.timeOfDay ? titleCase(g.timeOfDay) : null,
    phase: g.phase ? titleCase(g.phase) : null,
  };
}
