/**
 * Default-ON feature flags (the 2026-11 default flip). The 25 deploy opt-ins plus the in-game clock used to be
 * `=== "1"` opt-ins that only `deploy/orwell-env-defaults.sh` set — so every seeded gate ran a DIFFERENT game from
 * the one production runs. They are now code defaults: ON unless explicitly `0` / `false` / `off`, and the single
 * diagnostic switch `ORWELL_FLAGS_OFF=1` forces the whole flipped set OFF (the legacy all-off profile; it also wins over
 * the front-end's persisted time-of-day push).
 * ORW-65 review (2026-11-11): TIE_REVEAL, GOSSIP_CONSEQUENCE, WIPEOUT_REEL, MULTI_NIGHT_FATIGUE and NPC_MEMORY are now default ON
 * (see `src/featureFlags.ts`); FORESHADOW is gone with the retired 0103 (ORW-267). The one flag still NOT flipped is
 * SHOWRUNNER_REWEIGHT (it perturbs the seeded outcome stream by design; its on/off is Ryne's call, tracked as a Needs Ryne card) and keeps its own opt-in reader.
 *
 * PURE: this module never touches ambient process state. The ONE parser is `defaultOnFrom`; callers pass the env values in
 * (the engine adapter passes `process.env`; `src/featureFlags.ts` reuses the same function for `/health`).
 */
export function defaultOnFrom(value: string | undefined, flagsOff: string | undefined): boolean {
  if (flagsOff === "1") return false;
  const v = (value ?? "").trim().toLowerCase();
  return !(v === "0" || v === "false" || v === "off");
}

/** `defaultOnFrom` for a named flag in an explicit env record. */
export function flagDefaultOn(name: string, env: Readonly<Record<string, string | undefined>>): boolean {
  return defaultOnFrom(env[name], env.ORWELL_FLAGS_OFF);
}
