/**
 * ORW-480: how well a style family fits a life. The engine deals each houseguest a style family; dealt blind it put "minimalist
 * monochrome: no accessories, one tone head to toe" on a line cook from a Nebraska town. The weight below (data in castRealism.json,
 * "look-fit"; the front-end check `look_fit_weight` in frontend/src/orwell_cast_realism.py computes the same number) leans the deal toward
 * looks that person could own and buy where they live. A LEAN, not a costume: no uniforms, no work gear, and the job never decides alone.
 */
import table from "./castRealism.json";
import { tagKind } from "./castRealism";
import { STYLE_FAMILIES } from "./styleFamilies";

interface LookFit {
  "family-affluence": Record<string, number>;
  "family-age": Record<string, [number, number]>;
  "family-town": Record<string, string>;
  "sector-affluence": Record<string, number>;
  "sector-families": Record<string, string[]>;
  "big-cities": string[];
  "upscale-words": string[];
  "min-weight": number;
}
export const LOOK_FIT = (table as unknown as { "look-fit": LookFit })["look-fit"];

export interface Life { vocation?: string; hometown?: string; age?: number }

export function isBigCity(hometown: string | undefined): boolean {
  const city = String(hometown ?? "").split(",")[0]!.trim().toLowerCase();
  return LOOK_FIT["big-cities"].some((c) => c.toLowerCase() === city);
}

/** The person's affluence from the job sector (0 modest to 2 polished). */
export function lifeAffluence(life: Life): number {
  const sector = tagKind("sector", { vocation: life.vocation ?? "" })[0] ?? "other";
  return LOOK_FIT["sector-affluence"][sector] ?? 1;
}

/** The fit of a style family (by id) to a life: 1 is neutral, below about 0.3 is a poor fit, above 1 is a good one. */
export function styleFitWeight(familyId: string, life: Life): number {
  let w = 1;
  const fam = LOOK_FIT["family-affluence"][familyId];
  if (fam !== undefined) {
    const gap = Math.abs(fam - lifeAffluence(life));
    w *= gap <= 0.5 ? 1 : gap <= 1 ? 0.4 : 0.12;
  }
  const band = LOOK_FIT["family-age"][familyId];
  if (band && life.age !== undefined && (life.age < band[0] || life.age > band[1])) w *= 0.25;
  const town = LOOK_FIT["family-town"][familyId];
  if (town === "small" && isBigCity(life.hometown)) w *= 0.4;
  if (town === "big" && life.hometown && !isBigCity(life.hometown)) w *= 0.4;
  const sector = tagKind("sector", { vocation: life.vocation ?? "" })[0] ?? "other";
  if ((LOOK_FIT["sector-families"][sector] ?? []).includes(familyId)) w *= 2;
  return w;
}

/** The weight of a presentation LABEL to a life (1 for a label that is no known family). */
export function labelFitWeight(label: string, life: Life): number {
  const fam = STYLE_FAMILIES.find((f) => f.label === label);
  return fam ? styleFitWeight(fam.id, life) : 1;
}
