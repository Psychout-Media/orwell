/**
 * ORW-299 - the PLAYER-PROJECTION REGISTRY (test support). Every method on the `GameSession` port must be listed here with HOW the player-perspective sentinel
 * (tests/property/playerPerspective.property.test.ts) or liveSentinel.property.test.ts covers it, or why it is not a player-facing projection. The ratchet
 * (tests/unit/playerProjectionRatchet.test.ts) fails when a port method is missing, when one whose return type is not a `Record*Result` write-back receipt claims to
 * be a write-back, and when a "read" entry names a tool the sentinel does not sweep. Adding a new summary to the port = add it here AND to PLAYER_READS in the sentinel.
 */
export type Coverage =
  | "read"          // swept by the player-perspective sentinel at every phase (tool name = `tool ?? method`)
  | "advance"       // an AdvanceView / state-changing view the sentinel scans on every advanceGame + submitDecision
  | "lever"         // an action lever whose result view is swept by liveSentinel.property.test.ts
  | "sanctioned"    // deliberately returns hidden content (owner-ruled door), gated elsewhere
  | "port-only"     // no outward tool; voiced only through a swept surface
  | "pre-game"      // exists before any hidden state; swept by liveSentinel
  | "receipt"       // no player-facing text
  | "write-back";   // FE-driven write-back; result is a bare Record*Result status
export interface ProjectionEntry { method: string; tool?: string; coveredBy: Coverage; note: string }

export const PLAYER_PROJECTION_REGISTRY: readonly ProjectionEntry[] = [
  { method: "gameStatus", coveredBy: "read", note: "public board status" },
  { method: "getGameState", coveredBy: "read", note: "roster + player card + daySchedule + weekDigests + juryHouse" },
  { method: "stateDelta", coveredBy: "read", note: "player-visible events since beatSeq" },
  { method: "getMomentPrompt", coveredBy: "read", note: "the narrator prompt (systemPrompt + hardConstraints), incl. RETURNING CAST legend (0136), producer read (0137), Show Brief / room canon / open threads (ORW-223)" },
  { method: "recallSceneMemories", coveredBy: "read", note: "journal / scene recall" },
  { method: "whereabouts", coveredBy: "read", note: "who is where (eyeshot-scoped)" },
  { method: "premiereIntros", coveredBy: "read", note: "premiere entrances + champagne toast (0111)" },
  { method: "seasonRecap", coveredBy: "read", note: "season recap" },
  { method: "dailyRecap", coveredBy: "read", note: "daily recap + hint (0102/ORW-254)" },
  { method: "dayLedger", coveredBy: "read", note: "day ledger (ORW-271)" },
  { method: "npcVoice", coveredBy: "read", note: "one NPC's voiceable view (own knowledge layer only)" },
  { method: "playerTagline", coveredBy: "read", note: "state-aware tagline" },
  { method: "finaleView", coveredBy: "read", note: "finale staging projection" },
  { method: "playerDossier", coveredBy: "read", note: "player dossier (0138)" },
  { method: "playerReceipts", coveredBy: "read", note: "booth receipts (0139)" },
  { method: "worldSnapshotView", coveredBy: "read", note: "public real-world flavor" },
  { method: "competitionStagingView", coveredBy: "read", note: "fixed public drop order" },
  { method: "getPortraitPrompt", coveredBy: "read", note: "public-facets-only portrait prompt" },
  { method: "getOffscreenSceneSkeletons", coveredBy: "read", note: "public participants + nature of off-screen scenes (never content)" },
  { method: "sealedFromHouse", coveredBy: "read", note: "FE guard support (ids sealed from the house)" },
  { method: "knowledgeScopeManifest", coveredBy: "read", note: "FE guard support: who legitimately knows what (knowledge layer only)" },
  { method: "createCharacter", coveredBy: "advance", note: "GameStateView at start" },
  { method: "advanceGame", coveredBy: "advance", note: "AdvanceView: pending cards, staged ceremony step texts (ORW-281/291), week chapter recap (ORW-275), week digests (0133), exit interview (0130), finale interview, held" },
  { method: "submitDecision", coveredBy: "advance", note: "AdvanceView" },
  { method: "requestSelfEviction", coveredBy: "advance", note: "AdvanceView" },
  { method: "raiseSpectatorChoice", coveredBy: "advance", note: "AdvanceView" },
  { method: "cancelSelfEviction", coveredBy: "advance", note: "AdvanceView" },
  { method: "turnIn", coveredBy: "advance", note: "AdvanceView" },
  { method: "hangOut", coveredBy: "advance", note: "HangOutView (swept by liveSentinel; same advance machinery)" },
  { method: "updateCasting", coveredBy: "advance", note: "pre-game casting status (no hidden state exists pre-game; liveSentinel sweeps it)" },
  { method: "runCompetition", coveredBy: "advance", note: "CompetitionResultView (liveSentinel sweeps per beat)" },
  { method: "movePlayer", coveredBy: "advance", note: "WhereaboutsView (moveTo; liveSentinel)" },
  { method: "markHouseguestMet", coveredBy: "advance", note: "PremiereIntrosView (liveSentinel)" },
  { method: "makeDeal", coveredBy: "lever", note: "lever result view, swept by liveSentinel.property.test.ts" },
  { method: "formAlliance", coveredBy: "lever", note: "lever result view, swept by liveSentinel.property.test.ts" },
  { method: "joinAlliance", coveredBy: "lever", note: "lever result view, swept by liveSentinel.property.test.ts" },
  { method: "confide", coveredBy: "lever", note: "lever result view, swept by liveSentinel.property.test.ts" },
  { method: "askJuror", coveredBy: "lever", note: "lever result view, swept by liveSentinel.property.test.ts" },
  { method: "accuseTie", coveredBy: "lever", note: "lever result view, swept by liveSentinel.property.test.ts" },
  { method: "confront", coveredBy: "lever", note: "lever result view, swept by liveSentinel.property.test.ts" },
  { method: "callInFavor", coveredBy: "lever", note: "lever result view, swept by liveSentinel.property.test.ts" },
  { method: "exposeSecret", coveredBy: "lever", note: "lever result view, swept by liveSentinel.property.test.ts" },
  { method: "tradeSecret", coveredBy: "lever", note: "lever result view, swept by liveSentinel.property.test.ts" },
  { method: "socialInitiatives", coveredBy: "lever", note: "NPC-initiated openings" },
  { method: "seasonRetrospective", coveredBy: "sanctioned", note: "0048 post-season unsealing: hidden content by design once finished" },
  { method: "producerVaultDump", coveredBy: "sanctioned", note: "mandate #2 DEBUG door, admin-only, out-of-band; producerVault.test.ts is the gate" },
  { method: "notorietySummary", coveredBy: "port-only", note: "voiced via the RETURNING CAST block in getMomentPrompt, which is swept" },
  { method: "preSeedCast", coveredBy: "pre-game", note: "pre-game warm of the cast; a no-op refusal once started (liveSentinel sweeps)" },
  { method: "preSeedNextSeason", coveredBy: "pre-game", note: "next-season warm; liveSentinel sweeps" },
  { method: "noteMessage", coveredBy: "receipt", note: "{accepted, beatSeq} - no text" },
  { method: "recordDaySummary", coveredBy: "write-back", note: "FE write-back; bare status result" },
  { method: "recordWorldSnapshot", coveredBy: "write-back", note: "FE write-back; bare status result" },
  { method: "recordRoomCanon", coveredBy: "write-back", note: "FE write-back; bare status result" },
  { method: "recordProducerProfile", coveredBy: "write-back", note: "FE write-back; bare status result" },
  { method: "recordCompetitionFiction", coveredBy: "write-back", note: "FE write-back; bare status result" },
  { method: "recordCastProfile", coveredBy: "write-back", note: "FE write-back; bare status result" },
  { method: "recordCastIdentity", coveredBy: "write-back", note: "FE write-back; bare status result" },
  { method: "recordCastGenesis", coveredBy: "write-back", note: "FE write-back; bare status result" },
  { method: "recordOffscreenSceneTexture", coveredBy: "write-back", note: "FE write-back; bare status result" },
  { method: "recordHouseguestMove", coveredBy: "write-back", note: "FE write-back; bare status result" },
];
