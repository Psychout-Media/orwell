import { After, Before } from "@cucumber/cucumber";

/**
 * ORW-866 (leftover of ORW-826): the BDD shard runs many scenarios in ONE cucumber process, and a few step files set or delete `process.env` flags (ORWELL_TIME_OF_DAY, ORWELL_VOTE_TALK, ORWELL_DISABLE_DIVERSITY)
 * without always putting them back, so a later scenario ran with different flags and the same seed gave a different season depending on what ran before it. Snapshot the environment before EVERY scenario and put
 * it back after: a key the scenario added is deleted, a key it removed or changed is restored. (Same idea as resetStaticOverrides.ts, for the process-wide environment.)
 */
let snapshot: NodeJS.ProcessEnv | null = null;

Before(function () {
  snapshot = { ...process.env };
});

After(function () {
  if (!snapshot) return;
  for (const k of Object.keys(process.env)) if (!(k in snapshot)) delete process.env[k];
  for (const [k, v] of Object.entries(snapshot)) if (process.env[k] !== v) process.env[k] = v;
  snapshot = null;
});
