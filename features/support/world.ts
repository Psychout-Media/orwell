import { setWorldConstructor, setDefaultTimeout, World } from "@cucumber/cucumber";
import type { IWorldOptions } from "@cucumber/cucumber";
import type { Sandbox, VaultDatum } from "../../tests/support/sandbox";
import type { ToolDescriptor } from "../../src/surfaces/tools/registry";
import type { GameEvent, Visibility, EntityId } from "../../src/domain/event";
import type { SocialGraph } from "../../src/engine/gossip";
import type { LiveRichnessMetrics } from "../../src/engine/richness";
import type { GameHouse, Houseguest } from "../../src/engine/characterFactory";
import type { WeekState, VetoDraw } from "../../src/domain/eligibility";
import type { RelationshipModel } from "../../src/engine/relationships";
import type { Competitor, CompetitionType, CompetitionIntents, CompetitionResult } from "../../src/domain/competitionOutcome";
import type { GameState } from "../../src/domain/saveState";
import type { SaveStore, SaveRef } from "../../src/ports/SaveStore";
import type { RandomnessSource } from "../../src/ports/RandomnessSource";
import type { McpServer } from "../../src/adapters/mcp/McpServer";
import type { SeasonHouseguest } from "../../src/engine/season";
import type { SeasonOutcome } from "../../src/engine/calibration";
import type { EntityId as Eid } from "../../src/domain/ids";

// dependency-cruiser (architecture step) can take a few seconds on a cold cache.
setDefaultTimeout(60_000);

/** One in-game day of a live season: the ceremony beats the advances reported + its public event count. */
export interface LiveDay {
  week: number;
  day: number;
  beats: string[];
  publicEvents: number;
  /** Public ceremony broadcasts recorded that day (excluding the day's own ambient house event). */
  ceremonyEvents: number;
  /** The day's own ambient "Week N, day D:" marker events (houseEvents.ts) — recorded and public, but NOT a meaningful event (AMEND 0008). */
  markerEvents: number;
}

export class BbWorld extends World {
  sandbox!: Sandbox;
  lastOutput = "";
  lastView: unknown;
  specific?: VaultDatum;
  surfaced?: { content: string };
  question = "";
  tools: readonly ToolDescriptor[] = [];

  // Feature 0002 scratch state.
  firstEvent?: GameEvent;
  secondEvent?: GameEvent;
  hiddenEvent?: GameEvent;
  offscreen?: GameEvent[];
  npc?: EntityId;
  factContent?: string;
  classification?: Visibility;

  // Gossip-diffusion scratch state.
  graph?: SocialGraph;
  gossipNodes?: EntityId[];
  gossipOrigin?: EntityId;
  factId?: string;
  gossipOriginal?: string;

  // Behavioral-fidelity (0003) scratch state.
  /** 0003 — a LIVE stretch of season: its real event store, live richness metrics, and edge movement. */
  liveFidelity?: {
    events: GameEvent[]; metrics: LiveRichnessMetrics; edgesMoved: boolean;
    alliancesFormed: number; alliancesFractured: number; maxRevealsPerCommit: number; npcInteractionTypes: number;
  };
  seed?: number;

  // Outcomes by stats + temperature (0006) scratch state.
  variables?: string[];
  rollA?: Record<string, number>;
  rollB?: Record<string, number>;
  field?: Competitor[];
  type?: CompetitionType;
  target?: string;
  equivId?: string;
  winRates?: Record<string, number>;
  intents?: CompetitionIntents;
  result?: CompetitionResult;

  // Persistence non-degradation (0007) scratch state.
  gameState?: GameState;
  store?: SaveStore;
  rng?: RandomnessSource;
  loaded?: GameState;
  early?: GameState;
  late?: GameState;
  snapshots?: GameState[];
  saveRef?: SaveRef;
  saveRef2?: SaveRef;

  // Daily-event invariant (0008) scratch state — days of a LIVE season (see daily_event.steps.ts).
  liveDays?: LiveDay[];
  liveDay?: LiveDay;
  liveWeek?: LiveDay[];

  // MCP tool boundary (0009) scratch state.
  mcpPlayer?: McpServer;
  mcpAdmin?: McpServer;
  server?: McpServer;
  toolResult?: unknown;
  ack?: { eventId: string };

  // Weekly loop orchestration (0011) scratch state.
  roster?: SeasonHouseguest[];
  outcome?: SeasonOutcome;
  outcome2?: SeasonOutcome;
  chosenReplacement?: Eid;
  playerState?: { active: Eid[]; hoh: Eid };
  /** B55: the LIVE-loop pending-nomination fixture (the one weekly rulebook). */
  liveNom?: {
    s: import("../../src/engine/liveSeason").LiveSeasonState;
    ctx: import("../../src/engine/liveSeason").SeasonCtx;
    rng: import("../../src/adapters/random/SeededRandom").SeededRandom;
  };

  // Conversation & scene system (0012) scratch state.
  approaches?: Eid[];
  expression?: { mode: string; content?: string };
  liveVoice?: { sb: import("../../src/composition/registry").UserSandbox; untold: import("../../src/domain/ids").EntityId; told: import("../../src/domain/ids").EntityId };
  voiceUntold?: import("../../src/ports/GameSession").NpcVoiceView;
  voiceTold?: import("../../src/ports/GameSession").NpcVoiceView;
  compressed?: string;
  full?: string;
  groundTruthBefore?: string;
  pendingBefore?: unknown;
  sceneEventId?: string;

  // Diary Room (0013) scratch state.
  beat?: string;
  publicStmt?: string;
  drStmt?: string;
  npcActedOn?: string[];
  npcExpressed?: { dr: import("../../src/engine/conversation").Expression };

  // Jury & endgame (0014) scratch state.
  juryRel?: { trust: number; affinity: number; threat: number };
  juryWinner?: Eid;
  juryWinner2?: Eid;
  oobeSandbox?: import("../../src/composition/registry").UserSandbox;
  juryLive?: Record<"plain" | "narrated" | "flipped", { winner: string; reveals: string[] }> & { narrations: number };
  finaleScript?: { statements: Eid[]; questions: Array<{ juror: Eid; finalist: Eid }>; revealOrder: Eid[] };

  // Replayability & naming (0004) scratch state.
  house?: GameHouse;
  housesBySeed?: Record<string, Houseguest[]>;

  // Character creation / OOBE (0015) scratch state.
  player?: import("../../src/engine/characterFactory").PlayerCharacter;
  house2?: GameHouse;
  oobeRejected?: boolean;
  privateFact?: string;
  oobeKnowledge?: import("../../src/ports/KnowledgeService").KnowledgeService;

  // God Mode / admin (0016) scratch state.
  sandbox2?: Sandbox;
  twist?: VaultDatum;
  revealRejected?: boolean;

  // Relationship model (0017) scratch state.
  relTrustBefore?: number;
  relBondBefore?: number;
  relConfBefore?: number;
  labelParanoid?: string;
  labelTrusting?: string;

  // Cast pre-warm (0065) scratch state.
  pwSession?: import("../../src/adapters/engine/GameSessionAdapter").GameSessionAdapter;
  pwServer?: import("../../src/adapters/mcp/McpServer").McpServer;
  pwWarm?: import("../../src/ports/GameSession").PreSeedCastView;
  pwView?: import("../../src/ports/GameSession").GameStateView;
  pwId?: string;
  pwAuthored?: string;
  pwWriteAccepted?: boolean;

  // Narrative & moment orchestration (0018) scratch state.
  gsView?: import("../../src/ports/GameSession").GameStateView;
  gsMoment?: string;
  // T6: a LIVE GameSessionAdapter at the nomination beat (re-points "narrator cannot advance").
  liveGame?: import("../../src/adapters/engine/GameSessionAdapter").GameSessionAdapter;
  phaseBefore?: string;

  // Agent-driven play loop (0019) scratch state.
  /** 0019/0020 — a LIVE game parked at a player decision (features/support/liveDecision.ts). */
  liveDecision?: import("./liveDecision").LiveDecisionGame;
  liveBefore?: string;
  liveOptions?: string[];
  liveBeatSeq?: number;
  liveSubmitted?: import("../../src/ports/GameSession").AdvanceView;
  liveTapped?: string;
  liveMate?: string;
  liveEdgeBefore?: string;
  decisionResult?: { recorded: boolean; choice: string[] };
  decisionRejected?: boolean;
  compResult?: import("../../src/ports/GameSession").CompetitionResultView;
  bondBaseline?: number;

  // Player experience (0020) scratch state.
  portraitHg?: Houseguest;
  portraitSeed?: number;

  // Consequence & memory (0023) scratch state.
  consequence?: import("../../src/engine/consequence").ConsequenceEngine;
  reloaded?: import("../../src/engine/consequence").ConsequenceEngine;
  relBefore?: import("../../src/engine/relationships").EdgeSignals;
  threatBefore?: number;
  snap?: import("../../src/engine/consequence").MemorySnapshot;
  noms?: Eid[];

  // Per-user sandboxes (0021) scratch state.
  registry?: import("../../src/composition/registry").GameSessionRegistry;
  userASnapshot?: string;

  // Soul storage & recall (0024) scratch state.
  soul?: import("../../src/adapters/engine/SoulStore").SoulStore;
  recalled?: import("../../src/ports/SoulProvider").Memory[];
  archViolations?: unknown[];
  hiddenMemory?: string;
  // T4: a real generated houseguest's static Character captured at premiere for byte-stability.
  premiereCharacter?: import("../../src/engine/characterFactory").Character;
  premiereCharacterBytes?: string;
  // 0024 Option B: the rendered inner-diary narrative under test.
  soulNarrative?: string;

  // Reserve twists (0025) scratch state.
  reserve?: import("../../src/engine/reserveTwists").ReserveTwist[];
  fires?: import("../../src/engine/reserveTwists").TwistEvent[];
  visibleBefore?: number;
  twistEventId?: string;
  // Reactive reserve twists (0025 redesign) scratch state.
  twistPlan?: import("../../src/engine/reserveTwists").TwistPlan;
  twistPlanB?: import("../../src/engine/reserveTwists").TwistPlan;
  deployTrace?: { crowns: { hoh: string; outgoing: string | undefined; active: number }[]; replacements: { replacement: string; vetoHolder: string }[]; fired: string[] };
  twistLive?: import("../../src/engine/liveSeason").LiveSeasonState;
  twistCtx?: import("../../src/engine/liveSeason").SeasonCtx;
  twistFiredKinds?: import("../../src/engine/reserveTwists").TwistKind[];
  twistFiredKindsB?: import("../../src/engine/reserveTwists").TwistKind[];
  twistArmedFlags?: boolean[];
  twistLastEvent?: import("../../src/engine/liveSeason").BeatEvent | null;
  twistJury?: number;
  twistFinalTwo?: number;

  // Temperature & emotional constants (0028) scratch state.
  baseWinRate?: number;
  spikedMod?: number;
  settledMod?: number;
  surfacingRate?: number;
  tempRolls?: number[];
  compResultObj?: import("../../src/domain/competitionOutcome").CompetitionResult;

  // Strategic Diary Room (0115) scratch state.
  drSandbox?: import("../../src/composition/registry").UserSandbox;
  drContext?: string;
  drSecret?: string;
  drRetro?: import("../../src/ports/GameSession").RetrospectiveView | null;

  // Feature 0117 — the house lives in in-game time scratch state.
  igtSandbox?: import("../../src/composition/registry").UserSandbox;
  igtHourBefore?: number;
  igtScenesBefore?: Set<string>;
  igtNewScenes?: string[];
  igtTickTurns?: number;

  // Feature 0118 — ceremonies as timed interrupts scratch state.
  dscSandbox?: import("../../src/composition/registry").UserSandbox;
  dscContext?: string;

  // Feature 0119 — per-event felt durations scratch state.
  pfdFlat?: { winner?: string; order: string[] };
  pfdVariable?: { winner?: string; order: string[] };

  // Feature 0120 — strategic-drive off-screen cadence scratch state.
  scSandbox?: import("../../src/composition/registry").UserSandbox;
  scOrch?: import("../../src/composition/orchestrator").Orchestrator;
  scUser?: string;
  scSharpDrive?: number;
  scPassiveDrive?: number;
  scOffStream?: string[];
  scOnStream?: string[];
  scOnStreamB?: string[];

  // Game orchestrator & integrity checkpoint (0031) scratch state.
  orchestrator?: import("../../src/composition/orchestrator").Orchestrator;
  fakeClock?: import("../../src/adapters/time/FakeClock").FakeClock;
  advanceResult?: import("../../src/composition/orchestrator").AdvanceResult;
  hiddenBefore?: number;
  health?: import("../../src/composition/orchestrator").HealthRecord;
  stateA?: string;
  stateB?: string;

  // Live weekly progression & decision seam (0034) scratch state.
  livePlayer?: import("../../src/adapters/mcp/McpServer").McpServer;
  /** The user key the current live scenario operates on (shared restart step). */
  liveUser?: string;
  lastAdvance?: import("../../src/ports/GameSession").AdvanceView;
  beatsBeforeStop?: number;
  liveRefused?: boolean;
  liveWeekA?: number;
  liveWeekB?: number;
  livePhaseA?: string;
  livePhaseB?: string;

  // Live jury-vote choreography (0037) scratch state.
  finaleViews?: import("../../src/ports/GameSession").AdvanceView[];
  finaleViewsA?: import("../../src/ports/GameSession").AdvanceView[];
  finaleViewsB?: import("../../src/ports/GameSession").AdvanceView[];
  livePlayerB?: import("../../src/adapters/mcp/McpServer").McpServer;
  juryFinalists?: [Eid, Eid];
  juryRunMode?: "manner" | "dominance";
  /** 0128 three-part Final HOH scratch (engine-level scenarios). */
  fh?: { finalists: string[]; runs: Array<{ seed: number; events: Array<{ beat: string; participants: string[] }>; hoh?: string; evictee?: string; asked: string[][]; state: unknown }>; threePart: boolean; withPlayer: boolean };
  mannerShareRespected?: number;
  mannerShareBetrayed?: number;
  domWinRate?: number;
  domRatesByAppeal?: Record<string, number>;
  jbSandbox?: ReturnType<import("../../src/composition/registry").GameSessionRegistry["sandboxFor"]>;
  jbPending?: NonNullable<import("../../src/ports/GameSession").AdvanceView["pending"]>;
  jbTold?: string[];
  jbF1?: string;
  finaleSentinels?: string[];

  // Durable game persistence (0030) scratch state.
  saveDir?: string;
  registry2?: import("../../src/composition/registry").GameSessionRegistry;
  viewBefore?: import("../../src/ports/GameSession").GameStateView;
  viewAfter?: import("../../src/ports/GameSession").GameStateView;
  viewAfterB?: import("../../src/ports/GameSession").GameStateView;
  savedSnap?: import("../../src/engine/sessionSnapshot").SessionSnapshot;
  resumedSnap?: import("../../src/engine/sessionSnapshot").SessionSnapshot;
  durableSentinel?: string;

  // Relationship math (0026) scratch state.
  relThreatAfterBetrayal?: number;
  relEdgeBefore?: import("../../src/engine/relationshipConstants").EdgeSignals;
  relConfLow?: number;
  feels?: number[];
  harsherConstants?: import("../../src/engine/relationshipConstants").RelationshipConstants;

  // NarrativePort LLM adapter (0027) scratch state.
  narrator?: import("../../src/ports/StreamingNarrativePort").StreamingNarrativePort;
  narrationCtx?: import("../../src/ports/NarrativePort").NarrationContext;
  narrationFull?: string;
  narrationChunks?: string[];
  narrationOut?: string;
  engineWinnerBefore?: string;
  // T5: a LIVE GameSessionAdapter competition (re-points "narration never changes an outcome").
  liveCompGame?: import("../../src/adapters/engine/GameSessionAdapter").GameSessionAdapter;
  liveCompResult?: import("../../src/ports/GameSession").CompetitionResultView;
  liveStateBefore?: string;
  narratorEnv?: Record<string, string | undefined>;
  narratorCfg?: import("../../src/adapters/narrative/narratorConfig").NarratorConfig;

  // Competition eligibility (0005) scratch state.
  week?: WeekState;
  special?: boolean;
  eligible?: EntityId[];
  selectable?: EntityId[];
  voters?: EntityId[];
  veto?: VetoDraw;
  rel?: RelationshipModel;

  // Promise & deal tracking (0039) scratch state.
  ledger?: import("../../src/engine/deals").DealLedger;
  dealRel?: RelationshipModel;
  madeDeal?: import("../../src/domain/deal").Deal;
  dealJuryDemerits?: Array<{ wronged: EntityId; breaker: EntityId }>;
  dealReveals?: Array<{ wronged: EntityId; breaker: EntityId; witnessSet: EntityId[] }>;
  dealTrustBefore?: number;
  dealThreatBefore?: number;
  dealVault?: VaultDatum;

  // Feature 0121 — active-obligation deal kinds scratch state.
  dealDepthLedger?: import("../../src/engine/deals").DealLedger;
  dealDepthLedgerB?: import("../../src/engine/deals").DealLedger;
  dealDepthDeal?: import("../../src/domain/deal").Deal;
  dealDepthDealB?: import("../../src/domain/deal").Deal;
  dealDepthRel?: RelationshipModel;
  dealDepthTrustBefore?: number;
  dealDepthDemerits?: Array<{ wronged: EntityId; breaker: EntityId }>;
  dealDepthSandbox?: import("../../src/composition/registry").UserSandbox;
  dealDepthRefused?: boolean;

  // Negotiated deal duration (0109) scratch state.
  ddLedger?: import("../../src/engine/deals").DealLedger;
  ddLedgerB?: import("../../src/engine/deals").DealLedger;
  ddRel?: RelationshipModel;
  ddRelB?: RelationshipModel;
  ddDeal?: import("../../src/domain/deal").Deal;
  ddDealB?: import("../../src/domain/deal").Deal;
  ddThreat0?: number;
  ddThreat0B?: number;
  ddTrust0?: number;
  ddEdgeAfter?: import("../../src/engine/relationshipConstants").EdgeSignals;
  ddEdgeRef?: import("../../src/engine/relationshipConstants").EdgeSignals;

  // NPC confessionals (0040) scratch state.
  confRel?: RelationshipModel;
  confessor?: EntityId;
  confessional?: import("../../src/engine/confessionals").Confessional;
  confSoul?: import("../../src/adapters/engine/SoulStore").SoulStore;
  confUserSandbox?: import("../../src/composition/registry").UserSandbox;
  confSandboxA?: import("../../src/composition/registry").UserSandbox;
  confSandboxB?: import("../../src/composition/registry").UserSandbox;

  // Deeper character evolution (0124) scratch state.
  dceSoul?: import("../../src/engine/characterFactory").Soul;
  dceHoh?: EntityId;
  dceNomsBase?: EntityId[];
  dceNomsHardened?: EntityId[];
  dceCompConfident?: number;
  dceCompDistressed?: number;
  dceClashSwing?: number;
  dceBondSwing?: number;
  dceSandbox?: import("../../src/composition/registry").UserSandbox;

  // NPC-initiated deal offers (0123) scratch state.
  dofSandbox?: import("../../src/composition/registry").UserSandbox;
  dofOffer?: import("../../src/ports/GameSession").OpenDealOfferView | null;
  dofSeqBefore?: number;
  dofFrom?: EntityId;
  dofBeforeThreat?: number;
  dofBeforeDeals?: number;

  // Deeper, daily NPC confessionals (0122) scratch state.
  ddcSandbox?: import("../../src/composition/registry").UserSandbox;
  ddcSweptBefore?: number;
  ddcLivingNpcs?: number;
  ddcBareIsSkipped?: boolean;
  ddcDepth?: import("../../src/engine/confessionals").ConfessionalDepth;

  // Reactive confessionals (0089) scratch state.
  rcRegistry?: import("../../src/composition/registry").GameSessionRegistry;
  rcRegistryB?: import("../../src/composition/registry").GameSessionRegistry;
  rcUser?: string;
  rcUserB?: string;
  rcSandbox?: import("../../src/composition/registry").UserSandbox;
  rcEvents?: GameEvent[];
  rcRecentFacts?: import("../../src/engine/confessionals").RecentEventFact[];
  rcConfessional?: import("../../src/engine/confessionals").Confessional;
  rcConfRel?: RelationshipModel;
  rcConfessor?: EntityId;

  // Endgame structure (0045) scratch state.
  egSession?: import("../../src/adapters/engine/GameSessionAdapter").GameSessionAdapter;
  egBallots?: string[];
  egTieBreakAsked?: boolean;
  egState?: import("../../src/engine/liveSeason").LiveSeasonState;
  egCtx?: import("../../src/engine/liveSeason").SeasonCtx;
  egWeek?: import("../../src/domain/eligibility").WeekState;
  egVetoFieldOk?: boolean;
  egReplacementsSeen?: number;
  egReplacementIsVetoHolder?: boolean;
  egLastReplacement?: string;
  egLastReplacementWeek?: number;
  egEmptyElectorate?: boolean;
  egFinished?: boolean;
  egSawFinalEviction?: boolean;
  egPending?: import("../../src/engine/liveSeason").PendingDecision;
  egIllegalRefused?: boolean;
  egEvictee?: Eid;

  // Eviction night live (0047) scratch state.
  enRegistry?: import("../../src/composition/registry").GameSessionRegistry;
  enUser?: string;
  enSandbox?: import("../../src/composition/registry").UserSandbox;
  enViews?: import("../../src/ports/GameSession").AdvanceView[];
  enRevealOrderA?: string;
  enRevealOrderB?: string;
  enSentinel?: string;
  /** T2: the staged eviction's electorate size, read from the engine's own state. */
  enElectorate?: number;
  enPreReveal?: number;
  // --- exit interviews (0130) scratch state (exit_interview.steps.ts) ---
  xiSession?: import("../../src/adapters/engine/GameSessionAdapter").GameSessionAdapter;
  xiRetro?: import("../../src/ports/GameSession").RetrospectiveView | null;
  xiPending?: NonNullable<import("../../src/ports/GameSession").AdvanceView["pending"]>;
  xiBetrayed?: string;
  xiRespected?: string;
  xiThrew?: boolean;
  xiBlob?: string;
  xiOrderA?: string[];
  xiOrderB?: string[];
  // --- E34/E37 player-agency beats (player_agency.steps.ts) ---
  agS?: import("../../src/engine/liveSeason").LiveSeasonState;
  agCtx?: import("../../src/engine/liveSeason").SeasonCtx;
  agBeats?: import("../../src/engine/liveSeason").BeatEvent[];
  agFinalists?: Eid[];
  agQuestioned?: Eid[];
  enResumedEvictee?: string;
  enOriginalEvictee?: string;
  /** Live eviction-night scratch (0047 goodbye / warm-vs-cold / secret-ballot deal break, 0130 restart): see liveEvictionNight.ts. */
  night?: import("./liveEvictionNight").NightScratch;

  // Player eviction & the juror's seat (0046) scratch state.
  peRegistry?: import("../../src/composition/registry").GameSessionRegistry;
  peUser?: string;
  peSandbox?: import("../../src/composition/registry").UserSandbox;
  peView?: import("../../src/ports/GameSession").GameStateView;
  peWitnessedAtEviction?: number;
  peSentinel?: string;
  peSawJurorVote?: boolean;

  // House presence & lingering play (0049) scratch state.
  hpRegistry?: import("../../src/composition/registry").GameSessionRegistry;
  hpUser?: string;
  hpSandbox?: import("../../src/composition/registry").UserSandbox;
  hpRegistryA?: import("../../src/composition/registry").GameSessionRegistry;
  hpUserA?: string;
  hpSandboxA?: import("../../src/composition/registry").UserSandbox;
  hpViolations?: string[];
  hpTrailA?: string[];
  hpTrailB?: string[];
  hpWhereabouts?: import("../../src/ports/GameSession").WhereaboutsView;
  hpSentinel?: string;
  hpEventId?: string;
  hpOverheardFact?: import("../../src/domain/knowledge").KnowledgeFact;
  hpGateSamples?: number;
  hpGateHits?: number;
  hpClock?: { t: number };
  hpOrch?: import("../../src/composition/orchestrator").Orchestrator;
  hpBefore?: { week: number; phase: string; kind: string };
  hpEventsBefore?: number;
  hpClockTouched?: boolean;
  hpAsleep?: Eid[];
  hpAwake?: Eid[];
  hpNamed?: Eid;
  hpInRoom?: Eid;
  hpNextDoor?: Eid;
  hpUpInRoom?: Eid;
  hpUpNextDoor?: Eid;
  hpWitnessSets?: string[][];

  // House map, privacy & eyeshot (0077) scratch state.
  pmRegistry?: import("../../src/composition/registry").GameSessionRegistry;
  pmUser?: string;
  pmSandbox?: import("../../src/composition/registry").UserSandbox;
  pmWhereabouts?: import("../../src/ports/GameSession").WhereaboutsView;
  pmSubjects?: import("../../src/domain/ids").EntityId[];
  pmBedroom?: import("../../src/domain/house").Room;
  pmEventId?: string;
  pmWitnessSet?: import("../../src/domain/ids").EntityId[];
  pmHiddenContent?: string;
  pmSuspectId?: import("../../src/domain/ids").EntityId;
  pmSuspicionPathway?: string;

  // Live reserve twists (0025/B53) scratch state.
  twistRegistry?: import("../../src/composition/registry").GameSessionRegistry;
  twistUser?: string;
  twistSandbox?: import("../../src/composition/registry").UserSandbox;
  twistSentinel?: string;
  twistTrace?: {
    reveals: number[];
    hohWinsByWeek: Map<number, string[]>;
    evictionsByWeek: Map<number, number>;
    preRevealSweeps: string[];
  };
  twistFinal?: import("../../src/ports/GameSession").AdvanceView;

  // Season retrospective & the Vault unsealing (0048) scratch state.
  rtRegistry?: import("../../src/composition/registry").GameSessionRegistry;
  rtUser?: string;
  rtSandbox?: import("../../src/composition/registry").UserSandbox;
  rtSandboxB?: import("../../src/composition/registry").UserSandbox;
  rtRetro?: import("../../src/ports/GameSession").RetrospectiveView | null;
  rtRetroB?: import("../../src/ports/GameSession").RetrospectiveView | null;
  rtRecap?: import("../../src/ports/GameSession").SeasonRecapView;
  rtArchive?: import("../../src/engine/sessionSnapshot").SessionSnapshot;

  // Live off-screen society (0038) + running watcher (0035) scratch state.
  osRegistry?: import("../../src/composition/registry").GameSessionRegistry;
  osUser?: string;
  osSandbox?: import("../../src/composition/registry").UserSandbox;
  osOrch?: import("../../src/composition/orchestrator").Orchestrator;
  osSandboxA?: import("../../src/composition/registry").UserSandbox;
  osOrchA?: import("../../src/composition/orchestrator").Orchestrator;
  osUserA?: string;
  osFactOrigin?: Eid;
  osFactId?: string;
  osPlayerRumor?: import("../../src/domain/knowledge").KnowledgeFact;
  /** T11: per-user unique hidden sentinels for genuine cross-user content/knowledge-absence checks. */
  osSentinelA?: string;
  osSentinelB?: string;

  // Emergent blocs (0043) scratch state.
  blRel?: import("../../src/engine/relationships").RelationshipModel;
  blActive?: Eid[];
  blBlocs?: import("../../src/engine/blocs").Bloc[];
  blSandbox?: import("../../src/composition/registry").UserSandbox;
  blRegistry?: import("../../src/composition/registry").GameSessionRegistry;
  blMembers?: Eid[];
  blViolations?: string[];
  blEnemyTargeted?: number;
  blLoyaltyOf?: (id: Eid) => number;
  blSoulState?: Record<Eid, number>;
  blCalmStrength?: number;
  blSerialized?: string;

  // Character evolution & season arc (0041) scratch state.
  evoSoul?: import("../../src/engine/characterFactory").Soul;
  evoStart?: { state: number; volatility: number };
  evoSpiked?: number;
  evoSoulStore?: import("../../src/adapters/engine/SoulStore").SoulStore;
  evoCompCalm?: number;
  evoCompRattled?: number;
  evoNomsCalm?: [Eid, Eid];
  evoNomsRattled?: [Eid, Eid];
  evoHoh?: Eid;
  evoCharStart?: Map<string, string>;
  evoArcA?: number[];
  evoArcB?: number[];

  // Strategic nomination & vote refinements (0044) scratch state.
  sdRel?: import("../../src/engine/relationships").RelationshipModel;
  sdActive?: Eid[];
  sdDisposition?: import("../../src/engine/relationshipConstants").RelationshipDisposition;
  sdNoms?: [Eid, Eid];
  sdNomsLoyal?: [Eid, Eid];
  sdVoter?: Eid;
  sdNominees?: Eid[];
  sdLedger?: import("../../src/engine/deals").DealLedger;
  sdCalmVote?: Eid;
  sdRattledVote?: Eid;
  sdBlocVote?: Eid;
  sdSandbox?: import("../../src/composition/registry").UserSandbox;
  sdRegistryA?: import("../../src/composition/registry").GameSessionRegistry;
  sdRegistryB?: import("../../src/composition/registry").GameSessionRegistry;
  sdTrailA?: string[];
  sdTrailB?: string[];

  // Competition library (0042) scratch state.
  clRun?: { history: { hoh: string[]; veto: string[] }; vetoFieldSizes: number[]; compViews: string };
  clTrail?: string[];
  clDef?: import("../../src/engine/competitionLibrary").CompetitionDef;
  clWinRate?: number;
  clPlayerRate?: number;
  clViews?: string;

  // The casting interview (0050) scratch state.
  castSession?: import("../../src/adapters/engine/GameSessionAdapter").GameSessionAdapter;
  castView?: import("../../src/ports/GameSession").GameStateView;
  castPrompt?: string;
  castRestoredPlayer?: import("../../src/engine/characterFactory").PlayerCharacter;
  castStatus?: import("../../src/ports/GameSession").CastingStatusView;
  castResumed?: import("../../src/adapters/engine/GameSessionAdapter").GameSessionAdapter;
  castError?: Error;

  // Deep character profiles (0058) scratch state.
  dpRegistry?: import("../../src/composition/registry").GameSessionRegistry;
  dpSandbox?: import("../../src/composition/registry").UserSandbox;
  dpSandboxB?: import("../../src/composition/registry").UserSandbox;
  dpSentinel?: string;
  dpWriteResult?: import("../../src/ports/GameSession").RecordCastProfileResult;

  // Casting diversity floor (0063) scratch state.
  dvRegistry?: import("../../src/composition/registry").GameSessionRegistry;
  dvSandbox?: import("../../src/composition/registry").UserSandbox;
  dvSeed?: number;
  dvSentinel?: string;
  dvSurfacedBefore?: boolean;

  // Player self-eviction (0061) scratch state.
  svRegistry?: import("../../src/composition/registry").GameSessionRegistry;
  svUser?: string;
  svSandbox?: import("../../src/composition/registry").UserSandbox;
  svView?: import("../../src/ports/GameSession").AdvanceView;
  svGameState?: import("../../src/ports/GameSession").GameStateView;
  svEventsBefore?: number;
  svWitnessedBefore?: number;
  svStateBefore?: string;
  svSentinel?: string;
  svPresent?: Eid[];

  // Story-thread scheduler (0060) scratch state.
  stRegistry?: import("../../src/composition/registry").GameSessionRegistry;
  stSandbox?: import("../../src/composition/registry").UserSandbox;
  stSandboxB?: import("../../src/composition/registry").UserSandbox;
  stOrch?: import("../../src/composition/orchestrator").Orchestrator;
  stOrchB?: import("../../src/composition/orchestrator").Orchestrator;
  stUser?: string;
  stUserB?: string;
  stSentinel?: string;
  stThreadSourceId?: import("../../src/domain/ids").EntityId;
  stTransitionsA?: string;
  stTransitionsB?: string;
  stStaticA?: string;
  stStaticB?: string;

  // Secret-pacing drip (0092) scratch state.
  spRegistry?: import("../../src/composition/registry").GameSessionRegistry;
  spSandbox?: import("../../src/composition/registry").UserSandbox;
  spSandboxB?: import("../../src/composition/registry").UserSandbox;
  spOrch?: import("../../src/composition/orchestrator").Orchestrator;
  spOrchB?: import("../../src/composition/orchestrator").Orchestrator;
  spUser?: string;
  spUserB?: string;
  spSeed?: number;

  // Feature 0062 — the move-in zeitgeist snapshot scratch state.
  wsFix?: { reg: import("../../src/composition/registry").GameSessionRegistry; sb: import("../../src/composition/registry").UserSandbox; orch: import("../../src/composition/orchestrator").Orchestrator; user: string };
  wsFixB?: { reg: import("../../src/composition/registry").GameSessionRegistry; sb: import("../../src/composition/registry").UserSandbox; orch: import("../../src/composition/orchestrator").Orchestrator; user: string };
  wsView?: import("../../src/ports/GameSession").WorldSnapshotView | null;
  wsPrompt?: string;
  wsOffscreen?: string;
  wsOutcomeA?: string;
  wsOutcomeB?: string;
  wsPairA?: import("../../src/ports/GameSession").HouseguestCard;
  wsPairB?: import("../../src/ports/GameSession").HouseguestCard;
  wsWeek?: number;

  // Feature 0070 — off-screen scene texture enrichment scratch state.
  txRegistry?: import("../../src/composition/registry").GameSessionRegistry;
  txUser?: string;
  txSandbox?: import("../../src/composition/registry").UserSandbox;
  txOrch?: import("../../src/composition/orchestrator").Orchestrator;
  txServer?: import("../../src/adapters/mcp/McpServer").McpServer;
  txSkeletons?: import("../../src/ports/GameSession").OffscreenSceneSkeleton[];
  txWriteOk?: boolean;
  txRefusedReason?: string;
  txSeedA?: string;
  txSeedB?: string;

  // Feature 0078 — motivated off-screen society & intentional movement scratch state. One bag (the
  // scenario's "house lives" action is a closure so the shared When stays faithful across its rules).
  ms?: {
    reg?: import("../../src/composition/registry").GameSessionRegistry;
    user?: string;
    orch?: import("../../src/composition/orchestrator").Orchestrator;
    sandbox?: import("../../src/composition/registry").UserSandbox;
    live?: () => void;
    scenes?: import("../../src/engine/offscreen").OffscreenScene[];
    pairA?: Eid;
    pairB?: Eid;
    trend?: { motiveless: number; bonder: number; worker: number; shuffled: number };
    nature?: { warmFriendly: number; warmConflict: number; threatGame: number; threatConflict: number };
    recordsBefore?: number;
    edgesBefore?: string;
    awake?: Eid[];
    asleep?: Eid[];
    seasonResult?: { seed: number; status: string; f2Win: boolean; playerCompWins: number };
  };

  // Feature 0066 — in-game time of day & the nightly sleep economy scratch state (one bag).
  sleep?: {
    clockEnabled?: boolean;
    perConversation?: boolean;
    socialFatigue?: boolean;
    multiNight?: boolean;
    session?: import("../../src/adapters/engine/GameSessionAdapter").GameSessionAdapter;
    reg?: import("../../src/composition/registry").GameSessionRegistry;
    orch?: import("../../src/composition/orchestrator").Orchestrator;
    user?: string;
    phasesSeen?: Set<string>;
    restCue?: string;
    timeOfDay?: string;
    asleep?: string[];
    bedHour?: number;
    restedWinRate?: number;
    tiredWinRate?: number;
    favoriteCanLose?: boolean;
    depthBefore?: number;
    depthAfter?: number;
    phaseBefore?: string;
    phaseAfter?: string;
    fatigueN1?: number;
    fatigueN3?: number;
    fatigueRecovered?: number;
    swayOff?: number;
    swayTired?: number;
  };

  // Feature 0100 — the jury grudge book scratch state (one bag).
  jh?: {
    reg?: import("../../src/composition/registry").GameSessionRegistry;
    user?: string;
    sandbox?: import("../../src/composition/registry").UserSandbox;
    jurors?: Eid[];
    finalist?: Eid;
    otherFinalist?: Eid;
    grievanceJuror?: Eid;
    closeJuror?: Eid;
    isolatedJuror?: Eid;
    preJurorEvictee?: Eid;
    enabled?: boolean;
    sentinels?: string[];
    closeGrudgeBefore?: number;
    closeGrudgeAfter?: number;
    isolatedGrudgeAfter?: number;
    bitterWinRate?: number;
    snapshotWinRate?: number;
    cleanWinRate?: number;
    seededHashA?: string;
    seededHashB?: string;
    finaleBlob?: string;
  };

  // Feature 0101 — NPC myth-making scratch state (one bag).
  myth?: {
    reg?: import("../../src/composition/registry").GameSessionRegistry;
    user?: string;
    sandbox?: import("../../src/composition/registry").UserSandbox;
    origin?: Eid;
    chain?: Eid[];
    factId?: string;
    actClass?: string;
    minted?: boolean;
    beforeEdgesJson?: string;
    playerEdgesBeforeJson?: string;
    seededOutcomeA?: string;
    seededOutcomeB?: string;
    legendsA?: string[];
    legendsB?: string[];
  };

  // Feature 0111 — the Day-1 experience scratch state (one bag).
  d1?: {
    reg?: import("../../src/composition/registry").GameSessionRegistry;
    user?: string;
    sandbox?: import("../../src/composition/registry").UserSandbox;
    seed?: number;
    castPrompt?: string;
    needle?: string;
    hotReads?: import("../../src/domain/ids").EntityId[];
    premiere?: import("../../src/ports/GameSession").PremiereIntrosView;
    firstHohWinnerA?: string;
    firstHohWinnerB?: string;
    consequence?: import("../../src/engine/consequence").ConsequenceEngine;
    npc?: import("../../src/domain/ids").EntityId;
    edgeBefore?: import("../../src/engine/relationships").EdgeSignals;
    edgeAfter?: import("../../src/engine/relationships").EdgeSignals;
    baselineRel?: string;
    noBeatRel?: string;
    drConfession?: string;
    playerSurface?: string;
    adminSurface?: string;
    sentinels?: string[];
    seasonBaseline?: import("./seasonOutcome").SeasonOutcome;
    seasonRead?: import("./seasonOutcome").SeasonOutcome;
    drResult?: unknown;
    /** P4b — the clock-on Day-1 premiere scratch state. */
    fm?: {
      session: import("../../src/adapters/engine/GameSessionAdapter").GameSessionAdapter;
      exit?: import("../../src/ports/GameSession").AdvanceView;
      hour?: number;
      next?: import("../../src/ports/GameSession").AdvanceView;
    };
  };

  // A9 - premiere entrances scratch state (one bag).
  pe?: {
    session?: import("../../src/adapters/engine/GameSessionAdapter").GameSessionAdapter;
    sandbox?: import("../../src/composition/registry").UserSandbox;
    seed?: number;
    sentinel?: string;
    positions?: number[];
    orderB?: string[];
    gateAlwaysTrue?: boolean;
    hohDuringEntrances?: boolean;
  };

  // Feature 0125 — competition theme variety scratch state (one bag).
  ctv?: {
    on?: { views: import("../../src/ports/GameSession").CompetitionResultView[]; evictionOrder: readonly string[] };
    off?: { views: import("../../src/ports/GameSession").CompetitionResultView[]; evictionOrder: readonly string[] };
    themes?: { hoh: (string | undefined)[]; veto: (string | undefined)[] };
    det?: string[];
    detB?: string[];
  };

  // Feature 0127 — mixed-type competitions scratch state (one bag).
  mix?: {
    pureRate?: number;
    hybridRate?: number;
    a?: readonly string[];
    b?: readonly string[];
    diverged?: boolean;
    views?: string;
  };

  // Feature 0126 — expanded competition mechanics scratch state (one bag).
  cmp?: {
    hoh?: string[];
    veto?: string[];
    evictionOrder?: readonly string[];
    a?: { hoh: string[]; veto: string[]; evictionOrder: readonly string[] };
    b?: { hoh: string[]; veto: string[]; evictionOrder: readonly string[] };
    views?: string;
  };

  constructor(options: IWorldOptions) {
    super(options);
  }
}

setWorldConstructor(BbWorld);
