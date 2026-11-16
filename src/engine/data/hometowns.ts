/**
 * Vendored HOMETOWN corpus (L28, 2026-06-19): a real Big Brother cast comes from ALL OVER — never
 * three houseguests from the player's hometown, never one region's accent on the whole house. Each
 * entry pairs a CITY with its REGION so the `CharacterFactory` can spread the cast geographically
 * (capping how many share a region) and so the stored hometown reads concrete and persists airtight
 * (the narrator voices THIS city, never an invented or drifting one).
 *
 * Composition: 130+ cities across the US census regions (Northeast, Midwest, South, West) plus a
 * handful of international origins — the geographic variety a producer-filtered cast actually shows.
 * Raw material only: which city lands on which houseguest is the seed's draw, never a fixed pairing.
 * `region` is the spread key for the diversity cap; `city` is what the narrator speaks. A few cities
 * repeat across the corpus is fine — the engine caps PER REGION so no single area dominates a house.
 */
import { WORLD_PLACES } from "./worldPlaces";

export interface Hometown {
  /** "City, ST" (or "City, Country") — the concrete origin the narrator voices. */
  city: string;
  /** The spread key the factory caps on, so no one region dominates the cast. */
  region:
    | "Northeast" | "Midwest" | "South" | "West" | "International";
}

/**
 * The original hand list. Kept ONLY so the legacy deal in `generateBackstoryFacets` still consumes the same
 * draws from its stream (every other seeded value stays byte-identical); the surfaced hometown comes from
 * the world place table (ORW-508).
 */
export const LEGACY_HOMETOWNS: readonly Hometown[] = [
  // — Northeast —
  { city: "Boston, MA", region: "Northeast" },
  { city: "Providence, RI", region: "Northeast" },
  { city: "Hartford, CT", region: "Northeast" },
  { city: "Portland, ME", region: "Northeast" },
  { city: "Buffalo, NY", region: "Northeast" },
  { city: "Albany, NY", region: "Northeast" },
  { city: "Queens, NY", region: "Northeast" },
  { city: "Newark, NJ", region: "Northeast" },
  { city: "Trenton, NJ", region: "Northeast" },
  { city: "Philadelphia, PA", region: "Northeast" },
  { city: "Pittsburgh, PA", region: "Northeast" },
  { city: "Scranton, PA", region: "Northeast" },
  { city: "Manchester, NH", region: "Northeast" },
  { city: "Burlington, VT", region: "Northeast" },
  { city: "Worcester, MA", region: "Northeast" },
  // — Midwest —
  { city: "Chicago, IL", region: "Midwest" },
  { city: "Peoria, IL", region: "Midwest" },
  { city: "Detroit, MI", region: "Midwest" },
  { city: "Grand Rapids, MI", region: "Midwest" },
  { city: "Cleveland, OH", region: "Midwest" },
  { city: "Columbus, OH", region: "Midwest" },
  { city: "Cincinnati, OH", region: "Midwest" },
  { city: "Indianapolis, IN", region: "Midwest" },
  { city: "Milwaukee, WI", region: "Midwest" },
  { city: "Green Bay, WI", region: "Midwest" },
  { city: "Minneapolis, MN", region: "Midwest" },
  { city: "Duluth, MN", region: "Midwest" },
  { city: "Des Moines, IA", region: "Midwest" },
  { city: "Kansas City, MO", region: "Midwest" },
  { city: "St. Louis, MO", region: "Midwest" },
  { city: "Omaha, NE", region: "Midwest" },
  { city: "Wichita, KS", region: "Midwest" },
  { city: "Fargo, ND", region: "Midwest" },
  { city: "Sioux Falls, SD", region: "Midwest" },
  // — South —
  { city: "Atlanta, GA", region: "South" },
  { city: "Savannah, GA", region: "South" },
  { city: "Miami, FL", region: "South" },
  { city: "Tampa, FL", region: "South" },
  { city: "Orlando, FL", region: "South" },
  { city: "Jacksonville, FL", region: "South" },
  { city: "Charlotte, NC", region: "South" },
  { city: "Raleigh, NC", region: "South" },
  { city: "Charleston, SC", region: "South" },
  { city: "Nashville, TN", region: "South" },
  { city: "Memphis, TN", region: "South" },
  { city: "Knoxville, TN", region: "South" },
  { city: "Louisville, KY", region: "South" },
  { city: "Birmingham, AL", region: "South" },
  { city: "Mobile, AL", region: "South" },
  { city: "New Orleans, LA", region: "South" },
  { city: "Baton Rouge, LA", region: "South" },
  { city: "Jackson, MS", region: "South" },
  { city: "Little Rock, AR", region: "South" },
  { city: "Houston, TX", region: "South" },
  { city: "Dallas, TX", region: "South" },
  { city: "San Antonio, TX", region: "South" },
  { city: "Austin, TX", region: "South" },
  { city: "El Paso, TX", region: "South" },
  { city: "Oklahoma City, OK", region: "South" },
  { city: "Richmond, VA", region: "South" },
  { city: "Virginia Beach, VA", region: "South" },
  { city: "Baltimore, MD", region: "South" },
  { city: "Charleston, WV", region: "South" },
  { city: "Louisville, KY", region: "South" },
  // — West —
  { city: "Los Angeles, CA", region: "West" },
  { city: "San Diego, CA", region: "West" },
  { city: "San Francisco, CA", region: "West" },
  { city: "Sacramento, CA", region: "West" },
  { city: "Fresno, CA", region: "West" },
  { city: "Oakland, CA", region: "West" },
  { city: "Phoenix, AZ", region: "West" },
  { city: "Tucson, AZ", region: "West" },
  { city: "Las Vegas, NV", region: "West" },
  { city: "Reno, NV", region: "West" },
  { city: "Denver, CO", region: "West" },
  { city: "Colorado Springs, CO", region: "West" },
  { city: "Salt Lake City, UT", region: "West" },
  { city: "Boise, ID", region: "West" },
  { city: "Albuquerque, NM", region: "West" },
  { city: "Santa Fe, NM", region: "West" },
  { city: "Seattle, WA", region: "West" },
  { city: "Spokane, WA", region: "West" },
  { city: "Portland, OR", region: "West" },
  { city: "Eugene, OR", region: "West" },
  { city: "Billings, MT", region: "West" },
  { city: "Cheyenne, WY", region: "West" },
  { city: "Anchorage, AK", region: "West" },
  { city: "Honolulu, HI", region: "West" },
  // — International —
  { city: "Toronto, Canada", region: "International" },
  { city: "Vancouver, Canada", region: "International" },
  { city: "Montreal, Canada", region: "International" },
  { city: "London, UK", region: "International" },
  { city: "Manchester, UK", region: "International" },
  { city: "Dublin, Ireland", region: "International" },
  { city: "Sydney, Australia", region: "International" },
  { city: "Melbourne, Australia", region: "International" },
  { city: "Auckland, New Zealand", region: "International" },
  { city: "Mexico City, Mexico", region: "International" },
  { city: "Guadalajara, Mexico", region: "International" },
  { city: "San Juan, Puerto Rico", region: "International" },
  { city: "Manila, Philippines", region: "International" },
  { city: "Mumbai, India", region: "International" },
  { city: "Lagos, Nigeria", region: "International" },
  { city: "Cape Town, South Africa", region: "International" },
  { city: "São Paulo, Brazil", region: "International" },
  { city: "Berlin, Germany", region: "International" },
];

/** Every hometown the engine can deal: the legacy hand list plus the world place table (union, no duplicates). */
export const HOMETOWNS: readonly Hometown[] = (() => {
  const seen = new Set(LEGACY_HOMETOWNS.map((h) => h.city));
  const extra = WORLD_PLACES.filter((p) => !seen.has(p.city)).map((p): Hometown => ({ city: p.city, region: p.region }));
  return [...LEGACY_HOMETOWNS, ...extra];
})();

/** Every region key present in the corpus — the spread axis (exported for the diversity test). */
export const HOMETOWN_REGIONS: readonly Hometown["region"][] =
  [...new Set(HOMETOWNS.map((h) => h.region))];
