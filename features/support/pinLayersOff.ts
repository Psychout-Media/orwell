import type { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";

/**
 * The strategy layers PO ruling 2026-11-05 turned ON by default. A scenario whose PREMISE is the old flag-off profile (a hand-set threat edge that must drive a campaign, a seed search for an early
 * eviction, ...) pins them OFF on ITS OWN session with this helper, instead of depending on the process default. Call it right after `createCharacter` (or before, for the import-time-default layers
 * the adapter also exposes setters for). Scenarios that exercise the shipped profile do NOT call it.
 */
export function pinLayersOff(s: GameSessionAdapter): void {
  s.setAssurancesEnabled(false); s.setVoteCountEnabled(false); s.setVetoMemoryEnabled(false); s.setDealNomsEnabled(false); s.setCampaignMemoryEnabled(false);
  s.setApproachMemoryEnabled(false); s.setHcMemoryEnabled(false); s.setMemoryPromisesEnabled(false); s.setForgivenessEnabled(false); s.setLobbyingEnabled(false);
  s.setDesireClockEnabled(false); s.setWantMovementEnabled(false); s.setMultiNightFatigueEnabled(false); s.setMorningApproachEnabled(false); s.setNpcTellsEnabled(false);
  s.setTellReactionsEnabled(false); s.setMoodVetoEnabled(false); s.setMoodApproachEnabled(false); s.setMoodDealEnabled(false); s.setMoodCampaignEnabled(false);
  s.setDriftFixEnabled(false); s.setNpcMemorySpeechEnabled(false); s.setDriveDecisionsEnabled(false);
}
