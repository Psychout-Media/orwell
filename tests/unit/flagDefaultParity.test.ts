import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { FEATURE_FLAGS } from "../../src/featureFlags";

/**
 * Drift guard for the 2026-11 default flip. The set of gameplay flags that are ON by default lives in THREE places that must never disagree:
 *   (1) the deploy script `deploy/orwell-env-defaults.sh` (`orwell_optin_env_defaults` - what install + update write into a box's .env),
 *   (2) the `/health` registry `src/featureFlags.ts` (entries parsed `defaultOn`),
 *   (3) the engine's own reads in `GameSessionAdapter.ts` (each flipped flag reads `flagDefaultOn("ORWELL_X")`).
 * A flag added to one and not the others silently runs a different game on a box, in CI, and on /health. The flags that are deliberately NOT
 * flipped (opt-in; each has its own ruling) are pinned explicitly so none can be flipped by accident. Roles only.
 */
const NEVER_FLIPPED = [
  // One flag per line: concurrent flag PRs append DIFFERENT lines instead of conflicting on one.
  "ORWELL_SHOWRUNNER_REWEIGHT",
  "ORWELL_FORESHADOW",
  "ORWELL_TIE_REVEAL",
  "ORWELL_GOSSIP_CONSEQUENCE",
  "ORWELL_WIPEOUT_REEL",
  "ORWELL_JUROR_PROFILES",
  "ORWELL_GOSSIP_COPRESENCE",
] as const;

const deployKeys = execFileSync("bash", ["-c", 'source "$1" && orwell_optin_env_defaults "$2"', "_", "deploy/orwell-env-defaults.sh", "/nonexistent/orwell-data"], { encoding: "utf8" })
  .split("\n").map((l) => l.trim()).filter(Boolean)
  .map((l) => l.slice(0, l.indexOf("=")))
  .filter((k) => !/^ORWELL_(EMBEDDINGS|EMBED_CACHE)$/.test(k));

const registryDefaultOn = FEATURE_FLAGS.filter((d) => d.parser === "defaultOn").map((d) => d.envKey);
const adapterSrc = readFileSync("src/adapters/engine/GameSessionAdapter.ts", "utf8");
const adapterFlipped = [...adapterSrc.matchAll(/flagDefaultOn\("(ORWELL_[A-Z0-9_]+)"\)/g)].map((m) => m[1]!);

const diff = (a: readonly string[], b: readonly string[]): string[] => a.filter((x) => !b.includes(x)).sort();

describe("the default-on flag set agrees across the deploy script, /health and the engine", () => {
  it("the deploy script writes exactly the flags /health reports as default-on", () => {
    expect(deployKeys.length, "the deploy script lists the gameplay flags").toBeGreaterThanOrEqual(20);
    expect(diff(deployKeys, registryDefaultOn), "in the deploy script but not default-on in /health").toEqual([]);
    expect(diff(registryDefaultOn, deployKeys), "default-on in /health but not written by the deploy script").toEqual([]);
  });

  it("the engine reads every default-on flag through flagDefaultOn, and reads nothing else that way", () => {
    expect(diff(registryDefaultOn, adapterFlipped), "default-on in /health but the engine does not default it ON").toEqual([]);
    expect(diff(adapterFlipped, registryDefaultOn), "the engine defaults it ON but /health / the deploy script do not know it").toEqual([]);
    expect(new Set(adapterFlipped).size, "no flag is read through flagDefaultOn twice").toBe(adapterFlipped.length);
  });

  it("the deliberately opt-in flags are in none of the three default-on sets", () => {
    for (const k of NEVER_FLIPPED) {
      expect(deployKeys, `${k} must not be written by the deploy script`).not.toContain(k);
      expect(registryDefaultOn, `${k} must not be default-on in /health`).not.toContain(k);
      expect(adapterFlipped, `${k} must not default ON in the engine`).not.toContain(k);
    }
  });
});
