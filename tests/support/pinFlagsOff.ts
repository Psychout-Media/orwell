/**
 * Import this FIRST (side-effect only) in a test that asserts a flag-OFF / flag-off-baseline / calibration-neutrality property of the strategy layers that PO ruling 2026-11-05 turned ON by default.
 * ES imports evaluate in order, so the env is pinned BEFORE the adapter module reads its import-time defaults (DESIRE_CLOCK, WANT_MOVEMENT, MULTI_NIGHT_FATIGUE are module-level consts).
 * Never restores: each vitest file runs in its own module graph; tests that need a layer ON turn it on explicitly with the adapter setters.
 */
for (const f of ["ASSURANCES", "VOTE_COUNT", "VETO_MEMORY", "DEAL_NOMS", "CAMPAIGN_MEMORY", "APPROACH_MEMORY", "HC_MEMORY", "MEMORY_PROMISES", "FORGIVENESS", "LOBBYING", "DESIRE_CLOCK", "WANT_MOVEMENT",
  "MULTI_NIGHT_FATIGUE", "MORNING_APPROACH", "NPC_TELLS", "TELL_REACTIONS", "MOOD_VETO", "MOOD_APPROACH", "MOOD_DEAL", "MOOD_CAMPAIGN", "DRIFT_FIX", "NPC_MEMORY_SPEECH", "DRIVE_DECISIONS",
  "LIES_CAUGHT", "HEARD_ABOUT_ME", "NO_HARD_CAPS", "GOSSIP_COPRESENCE", "CREDIBILITY", "JURY_MEMORY", "MEMORY_FRIENDS", "ACCUSE_COST", "WIPEOUT_REEL", "JUROR_PROFILES", "PHILOSOPHIES", "CALM_PRESENCE"]) {
  process.env[`ORWELL_${f}`] = "0";
}
