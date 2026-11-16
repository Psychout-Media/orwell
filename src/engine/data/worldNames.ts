/**
 * ORW-508 Layer 1: given names at real frequency, by birth decade and sex.
 *
 * Source: US Social Security Administration national baby-name counts (public domain), births 1966 to 2005 in four
 * decade buckets, reduced by `scripts/orw508-build-world-tables.py` to `world/given-names.json` (about 90 KB):
 * 1,840 female and 1,209 male names that reached 1,500 births in some decade. A 50-year-old is dealt from the
 * 1976 bucket and a 22-year-old from the 2005 bucket, so a name fits the person's age the way it does in life.
 * A name that is common for both sexes (Jordan, Taylor) appears in both tables with its own counts.
 *
 * Counts are softened by `NAME_FLATTEN` (the table's own frequency would put Jacob in one cast in five).
 */
import type { RandomnessSource } from "../../ports/RandomnessSource";
import type { AvoidSets } from "../../domain/recentSeasons";
import namesJson from "./world/given-names.json";
import { buildTable, drawConstrained, type WeightedTable } from "./worldSampler";

/** The year a season's ages are counted from. */
export const NAMES_REFERENCE_YEAR = 2026;
export const NAME_FLATTEN = 0.5;
/** Names the show never uses (the old fixed sample names). */
const DENIED = new Set(["Ryne", "Marcus", "Felix"]);

type Row = readonly [string, ...number[]];
const count = (r: Row, d: number): number => (r[1 + d] as number | undefined) ?? 0;
const DECADES = namesJson.decades as unknown as ReadonlyArray<readonly [number, number]>;

export function decadeIndexFor(age: number): number {
  const birth = NAMES_REFERENCE_YEAR - age;
  return Math.max(0, Math.min(DECADES.length - 1, Math.floor((birth - DECADES[0]![0]) / 10)));
}

const tables = new Map<string, WeightedTable<Row>>();
function tableFor(sex: "F" | "M", d: number): WeightedTable<Row> {
  const k = `${sex}${d}`;
  let t = tables.get(k);
  if (!t) {
    const rows = (namesJson[sex] as unknown as Row[]).filter((r) => count(r, d) > 0 && !DENIED.has(r[0]));
    t = buildTable(rows, (r) => count(r, d), NAME_FLATTEN);
    tables.set(k, t);
  }
  return t;
}

/** Births of `name` (one sex) in the person's decade bucket; 0 when the name is not in the table. */
export function birthsInDecade(name: string, sex: "F" | "M", age: number): number {
  const row = (namesJson[sex] as unknown as Row[]).find((r) => r[0] === name);
  return row ? count(row, decadeIndexFor(age)) : 0;
}

export interface NamePerson { readonly age: number; readonly gender?: "man" | "woman" | "nonbinary" }

/**
 * Deal one given name per person: unique across `taken` and the cast, not on the recent-seasons memory, drawn
 * from the person's birth decade and sex. One `rng.next()` per attempt (plus one per nonbinary person to pick a
 * table). Bounded retries loosen the memory first; the last level only insists on a fresh name.
 */
export function dealEraGivenNames(
  rng: RandomnessSource, people: readonly NamePerson[], taken: ReadonlySet<string>, avoid?: AvoidSets,
): string[] {
  const used = new Set(taken);
  const avoidedGiven = new Set<string>();
  if (avoid) for (const n of avoid.names) avoidedGiven.add(n.split(" ")[0]!.toLowerCase());
  return people.map((p) => {
    const sex: "F" | "M" = p.gender === "woman" ? "F" : p.gender === "man" ? "M" : rng.next() < 0.5 ? "F" : "M";
    const table = tableFor(sex, decadeIndexFor(p.age));
    const fresh = (r: Row): boolean => !used.has(r[0]);
    const row = drawConstrained(rng, table, [(r) => fresh(r) && !avoidedGiven.has(r[0].toLowerCase()), fresh], 80);
    let name = row[0];
    if (used.has(name)) name = table.rows.find((r) => !used.has(r[0]))![0]; // every attempt hit a used name: take the first free one
    used.add(name);
    return name;
  });
}
