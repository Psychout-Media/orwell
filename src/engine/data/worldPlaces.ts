/**
 * ORW-508 Layer 1: the place table the hometown deal draws from, at real-world frequency.
 *
 * Source: US Census Bureau Population Estimates, cities and towns, vintage 2023 (public domain): every
 * incorporated place with 1,000 or more residents, about 10,000 rows, reduced to name, state and
 * population by `scripts/orw508-build-world-tables.py` into `world/places.json` (about 250 KB, about 90 KB
 * gzipped). A draw weighted by residents is the frequency of where Americans live.
 *
 * Region comes from the state (Census regions). Size class comes from the population.
 */
import placesJson from "./world/places.json";

/** The four Census regions (the hometown spread key; the legacy list adds "International"). */
export type PlaceRegion = "Northeast" | "Midwest" | "South" | "West";

export type SizeClass = "big-city" | "city" | "small-city" | "town";

export interface WorldPlace {
  /** "City, ST" (the string the card and the narrator use). */
  readonly city: string;
  readonly state: string;
  readonly region: PlaceRegion;
  /** Residents in thousands (the draw weight before flattening). */
  readonly popK: number;
  readonly size: SizeClass;
}

const REGION_OF_STATE: Readonly<Record<string, PlaceRegion>> = {
  CT: "Northeast", ME: "Northeast", MA: "Northeast", NH: "Northeast", RI: "Northeast", VT: "Northeast", NJ: "Northeast", NY: "Northeast", PA: "Northeast",
  IL: "Midwest", IN: "Midwest", MI: "Midwest", OH: "Midwest", WI: "Midwest", IA: "Midwest", KS: "Midwest", MN: "Midwest", MO: "Midwest", NE: "Midwest", ND: "Midwest", SD: "Midwest",
  DE: "South", FL: "South", GA: "South", MD: "South", NC: "South", SC: "South", VA: "South", DC: "South", WV: "South", AL: "South", KY: "South", MS: "South", TN: "South", AR: "South", LA: "South", OK: "South", TX: "South",
  AZ: "West", CO: "West", ID: "West", MT: "West", NV: "West", NM: "West", UT: "West", WY: "West", AK: "West", CA: "West", HI: "West", OR: "West", WA: "West",
};

export function sizeClassOf(popK: number): SizeClass {
  return popK >= 500 ? "big-city" : popK >= 100 ? "city" : popK >= 25 ? "small-city" : "town";
}

export const WORLD_PLACES: readonly WorldPlace[] = (() => {
  const seen = new Set<string>();
  const out: WorldPlace[] = [];
  for (const [name, state, pop] of placesJson.rows as unknown as ReadonlyArray<readonly [string, string, number]>) {
    const region = REGION_OF_STATE[state];
    const city = `${name}, ${state}`;
    if (!region || seen.has(city)) continue; // a duplicate or unknown state is dropped, never thrown
    seen.add(city);
    const popK = pop / 1000;
    out.push({ city, state, region, popK, size: sizeClassOf(popK) });
  }
  return out;
})();
