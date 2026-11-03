/**
 * Default-ON feature flags (the 2026-11 default flip). The 25 deploy opt-ins plus the in-game clock used to be
 * `=== "1"` opt-ins that only `deploy/orwell-env-defaults.sh` set — so every seeded gate ran a DIFFERENT game from
 * the one production runs. They are now code defaults: ON unless explicitly `0` / `false` / `off`, and the single
 * diagnostic switch `ORWELL_FLAGS_OFF=1` forces the whole flipped set OFF (the byte-identical legacy profile).
 * Flags that are NOT flipped (SHOWRUNNER_REWEIGHT, FORESHADOW, REACTIVE_TWISTS, TIE_REVEAL, GOSSIP_CONSEQUENCE,
 * MULTI_NIGHT_FATIGUE, WIPEOUT_REEL, NPC_MEMORY pending its measurement) keep their own opt-in readers.
 */
export function flagDefaultOn(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.ORWELL_FLAGS_OFF === "1") return false;
  const v = (env[name] ?? "").trim().toLowerCase();
  return !(v === "0" || v === "false" || v === "off");
}
