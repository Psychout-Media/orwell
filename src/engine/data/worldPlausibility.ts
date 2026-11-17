/**
 * ORW-508 acceptance: wide generation, narrow acceptance.
 *
 * A big table can deal a 22-year-old pharmacist from a town of 300, or a beach instructor from Nebraska.
 * Every combination of (age, job, hometown) passes these joint rules before it is kept. Each rule has a
 * name so a rejection can be counted and the generator fixed, instead of growing a ban list.
 *
 * Rules are about what is possible and ordinary, not about stereotype: they say "needs a licence, so not
 * at 22", "needs a coast", "needs a city of this size". They never say who a person of some background
 * is likely to be.
 */
import type { SizeClass } from "./worldPlaces";
import { JOB_INDEX } from "./worldJobs";

export interface PersonFacts { readonly vocation: string; readonly age: number; readonly state: string; readonly size: SizeClass }

interface Rule {
  readonly name: string;
  readonly when: RegExp;
  readonly minAge?: number;
  readonly maxAge?: number;
  /** Smallest place size the job exists in. */
  readonly minSize?: SizeClass;
  /** Largest place size the job exists in (farm work is not a big-city job). */
  readonly maxSize?: SizeClass;
  /** States where the job exists at all. */
  readonly states?: readonly string[];
}

const COAST = ["AK", "WA", "OR", "CA", "HI", "TX", "LA", "MS", "AL", "FL", "GA", "SC", "NC", "VA", "MD", "DE", "NJ", "NY", "CT", "RI", "MA", "NH", "ME"];
const SNOW = ["CO", "UT", "VT", "NH", "ME", "CA", "ID", "MT", "WY", "NM", "WA", "OR", "NY", "AK", "MI", "WI", "MN", "NV", "PA", "WV", "NC"];
const WINE = ["CA", "OR", "WA", "NY", "TX", "VA", "MI", "NM", "ID", "PA", "OH", "NC", "MO"];

export const RULES: readonly Rule[] = [
  { name: "licence-age-27", when: /^(optometrist|pharmacist)$/, minAge: 27 },
  { name: "licence-age-25", when: /^(physical therapist|occupational therapist|financial advisor|EMT supervisor|construction foreman|city planner|marine biologist)$/, minAge: 25 },
  { name: "career-age-23", when: /^(sommelier|high-school teacher|mortgage broker|small-business owner|boutique owner|college admissions counselor|cattle rancher|court reporter|customs officer|civil engineer|dental hygienist|ER nurse|account executive|pharmaceutical rep|pastry chef|novelist)$/, minAge: 23 },
  { name: "young-only-grad-student", when: /^grad student$/, maxAge: 36 },
  { name: "young-only-athlete", when: /^former college athlete$/, maxAge: 36 },
  { name: "young-only-dancer", when: /^ballet dancer$/, maxAge: 40 },
  { name: "young-only-wildland", when: /^wildland firefighter$/, maxAge: 45 },
  { name: "city-only-arts", when: /^(ballet dancer|session musician|fashion buyer)$/, minSize: "city" },
  { name: "not-tiny-town", when: /^(stand-up comedian|art-gallery assistant|hotel concierge|UX designer|customs officer|city planner|escape-room designer|court reporter|museum docent|ghost-tour guide|sommelier|radiologic technologist)$/, minSize: "small-city" },
  { name: "not-big-city-farm", when: /^(cattle rancher|organic farmer|vineyard worker|park ranger|beekeeper)$/, maxSize: "small-city" },
  { name: "needs-coast", when: /^(commercial fisherman|surf instructor|marine biologist)$/, states: COAST },
  { name: "needs-snow", when: /^ski-resort guide$/, states: SNOW },
  { name: "needs-vines", when: /^vineyard worker$/, states: WINE },
];

const ORDER: Record<SizeClass, number> = { town: 0, "small-city": 1, city: 2, "big-city": 3 };

/** The name of the first rule the person breaks, or null when the combination is plausible. */
export function implausibleBecause(p: PersonFacts): string | null {
  // the table's own facts about a job: its age floor, and farm-style jobs that do not exist in a big city
  const row = JOB_INDEX.get(p.vocation.toLowerCase());
  if (row) {
    if (p.age < row.minAge) return `min-age-${row.minAge}`;
    if (row.maxSize && ORDER[p.size] > ORDER[row.maxSize]) return "not-big-city-farm";
  }
  for (const r of RULES) {
    if (!r.when.test(p.vocation)) continue;
    if (r.minAge !== undefined && p.age < r.minAge) return r.name;
    if (r.maxAge !== undefined && p.age > r.maxAge) return r.name;
    if (r.minSize && ORDER[p.size] < ORDER[r.minSize]) return r.name;
    if (r.maxSize && ORDER[p.size] > ORDER[r.maxSize]) return r.name;
    if (r.states && !r.states.includes(p.state)) return r.name;
  }
  return null;
}

/** Only the age rules (the town cannot fix these; the job has to change). */
export function ageProblem(vocation: string, age: number): string | null {
  for (const r of RULES) {
    if (!r.when.test(vocation)) continue;
    if (r.minAge !== undefined && age < r.minAge) return r.name;
    if (r.maxAge !== undefined && age > r.maxAge) return r.name;
  }
  return null;
}

/** Plain jobs that need no licence, no coast and no particular town: the fallback when the retries run out. */
export const SAFE_VOCATIONS: readonly string[] = ["barista", "bartender", "line cook", "bank teller", "personal trainer", "hairstylist", "postal carrier", "cashier"];

/** Rejections counted per rule, for the season line. */
export interface AcceptanceReport {
  /** Draws that were thrown away, by rule name. */
  rejected: Record<string, number>;
  /** Slots that fell back to a plain safe value after the bounded retries. */
  fallbacks: number;
}
export const newAcceptanceReport = (): AcceptanceReport => ({ rejected: {}, fallbacks: 0 });
export function countRejection(r: AcceptanceReport | undefined, rule: string): void {
  if (r) r.rejected[rule] = (r.rejected[rule] ?? 0) + 1;
}
