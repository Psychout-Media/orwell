import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { runJurySequesterScenario } from "../support/jurySequesterScenario";

// The FULL deployed flag profile (26 flags + TIME_OF_DAY), read from its single source —
// `deploy/orwell-env-defaults.sh`, the same function install + update write the box's .env from and the
// `heavy-sims` CI lane plays (the code defaults ARE the deployed profile since the 2026-11 default flip) ("the gate tests what prod runs", ADR 0016). The adapters read these env
// flags at MODULE LOAD, so they are applied BEFORE the dynamic import below. Embedding settings are dropped (they
// would fetch the ONNX model; tests use the deterministic fake). A malformed line fails loudly.
const deployedProfile = execFileSync(
  "bash",
  ["-c", 'source "$1" && orwell_optin_env_defaults "$2"', "_", "deploy/orwell-env-defaults.sh", "/nonexistent/orwell-data"],
  { encoding: "utf8" },
)
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => l !== "")
  .map((l) => {
    if (!/^ORWELL_[A-Z0-9_]+=\S+$/.test(l)) throw new Error(`unexpected line from orwell_optin_env_defaults: ${l}`);
    return l;
  })
  .filter((l) => !/^ORWELL_(EMBEDDINGS|EMBED_CACHE)=/.test(l));
for (const line of deployedProfile) {
  const i = line.indexOf("=");
  process.env[line.slice(0, i)] = line.slice(i + 1);
}
// A65/ORW-97: this driver plays the season with raw advanceGame loops, which the (default-ON, deployed) engine advance gate refuses by design - the profile's gate is pinned off here; advanceScheduleGate.test.ts covers it.
process.env.ORWELL_ADVANCE_GATE = "0";
const { composeRuntime } = await import("../../src/composition/runtime");

/** 0129 — see `jurySequester.test.ts`; this is the same scenario on the profile production runs (jury house ON). */
describe("0129 — the jury house is sequestered from a non-juror player (full deployed profile)", () => {
  it("no tool reaches a juror, a pre-jury evictee goes home, and jurors mix only with jurors", async () => {
    expect(deployedProfile.length, "the full deployed profile loaded").toBeGreaterThanOrEqual(20);
    expect(deployedProfile).toContain("ORWELL_JURY_HOUSE=1");
    await runJurySequesterScenario(composeRuntime);
  }, 600_000);
});
