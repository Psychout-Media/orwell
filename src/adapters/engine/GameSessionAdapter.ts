import type {
  GameSession, CreateCharacterReq, GameStateView, MomentPromptReq, MomentPromptView,
  RecallSceneMemoriesReq, RecallSceneMemoriesView,
  RunCompetitionReq, CompetitionResultView, PublicGameStatus,
  AdvanceView, HangOutReq, HangOutView, SubmitDecisionReq, PendingDecisionView, OpenDealOfferView, NamedRef, SocialInitiative, PlayerTaglineView,
  FinaleView, EvictionView, MakeDealReq, DealView, DealRefusal, FormAllianceReq, JoinAllianceReq, AllianceView, WhereaboutsView, HouseguestMoveResult,
  SeasonRecapView, RetrospectiveView, NpcVoiceView, ConfideResult, AskJurorResult, SealedFact, AccuseTieResult, ConfrontResult,
  DailyRecapView,
  ExposeSecretReq, ExposeResult, TradeSecretReq, TradeResult, SecretLeverDescriptor,
  UpdateCastingReq, CastingStatusView, PortraitPromptEntry, HouseguestCard,
  PreSeedCastReq, PreSeedCastView,
  PreSeedNextSeasonReq, PreSeedNextSeasonView,
  RecordCastProfileReq, RecordCastProfileResult, FinaleFastForwardView, WeekDigestView, JuryHouseView, JuryHouseJurorView, JurorBearing,
  RecordCastIdentityReq, RecordCastIdentityResult, ProposedCastIdentityFacets,
  RecordCastGenesisReq, RecordCastGenesisResult, GenesisViolationDTO,
  WorldSnapshotView, RecordWorldSnapshotReq, RecordWorldSnapshotResult,
  RecordProducerProfileReq, RecordProducerProfileResult,
  PremiereIntrosView, FirstImpressionView, MarkHouseguestMetOpts,
  StateDeltaView, DeltaEventView,
  BehavioralFlags,
  BeatAnnouncementView,
  NotorietyLegendView,
} from "../../ports/GameSession";
import { randomBytes } from "node:crypto";
import { applyClosedFacetGuard, monitorLegacyInkGuard } from "../../engine/facetDiff";
import { humanizeIds, humanizeForRetrospective } from "./humanize";
import { singlePickId } from "./decisionFields";
import type { GameEvent } from "../../domain/event";
import { assignRooms, zoneFor, type MovementIntent, type MovementPull } from "../../engine/presence";
import { moodWord, voiceFingerprint } from "../../engine/voice";
import { tellsOf, refreshTells, tellChannel } from "../../engine/tells";
import { chooseTellReaction, addExploit, decayExploit, TELL_REACTION, moodVetoTerm, moodApproachTerm, moodDealTerm, moodUnsteady } from "../../engine/tellReactions";
import type { VoiceProfile } from "../../domain/voiceProfile";
import { NO_NPC_PATHWAY, beatForMoment, producerPrompt, playerDiaryStrategy } from "../../engine/diaryRoom";
import { computePlayerReceipts, type Receipt } from "../../engine/receipts";
import { nextMilestone, milestoneDue as milestoneDueOf, minutesUntilDue, beatFeltHours } from "../../engine/daySchedule";
import { driveSuspicion } from "../../engine/suspicion";
import {
  formCampaigns, advanceCampaign, replan, campaignTilt, campaignPushFor, CAMPAIGN_PUSH_INCLUDES_PLAYER_OWNED, CAMPAIGN, PLAN_FOR, advancePlayerCampaign,
  deriveDrive, ownBallotLean, drivePushFor, ARCHETYPE_AGGRESSION,
  selectNemesis, NEMESIS, NO_NEMESIS,
  type Campaign, type CampaignActor, type Influence, type Drive, type NemesisTrack, type NemesisCandidate,
} from "../../engine/campaigns";
import { whisperConspicuousPairings } from "../../engine/houseSuspicion";
import { runJuryHouseStretch, bearingWord } from "../../engine/juryHouse";
import { JURY_HOUSE } from "../../engine/juryHouseConstants";
import type { KnowledgeService } from "../../ports/KnowledgeService";
import type { EventStore } from "../../ports/EventStore";
import { PRESENCE, PRIVACY, MOVEMENT_INTENT, CALM_PRESENCE } from "../../engine/presenceConstants";
import { dayOfWeek } from "../../engine/houseEvents";
import { HOUSE_SIGHTLINE, areVisible, isPrivateRoom, roomDisplayName, resolveRoom, WALKABLE_ROOMS, zonesFor } from "../../domain/house";
import type { Room, Zone, Occupancy } from "../../domain/house";
import type { RandomnessSource } from "../../ports/RandomnessSource";
import type { CastingIntake, DossierForCoherence } from "../../engine/castingIntake";
import { castingStatusOf, emptyIntake, ignoredCastingKeys, intakeIsEmpty, mergeCastingUpdate, overwrittenScalars, validateDossierCoherence, repairDossierCoherence } from "../../engine/castingIntake";
import { DealLedger, breakSeverityScale, boundDealTerm } from "../../engine/deals";
import { believedMargin, inDoubt } from "../../engine/voteEstimate";
import { NPC_MEMORY, SCENE_MEMORY_SEVERITY, recordMemory, memoryTilt, memoryTiltStandalone, nominationMemorySeverity, vetoWithheldSeverity, memoryGrudge, memoryFavor, friendSeverity, type MemoryKind, type MemoryEntry } from "../../engine/npcMemory";
import { pitchTilt, chooseOffer, type Pitch } from "../../engine/lobbying";
import { applyForgiveness, forgivenessTraitFor } from "../../engine/forgiveness";
import { ACCUSE, hitReaction, sourChance } from "../../engine/accuseConstants";
import { DEAL_NOMS } from "../../engine/dealNomConstants";
import { confideToDisclosure, dripToDisclosure, type DisclosureEvent } from "../../engine/disclosureRoute";
import { AssuranceLedger, type Assurance, assuranceKeepWeight, decideKeep, ASSURANCE, npcAssuranceSincerity, isRumoredBreak } from "../../engine/assurances";
import type { BindingAction, Deal } from "../../engine/deals";
import { isPositiveObligation } from "../../domain/deal";
import type { DealKind } from "../../domain/deal";
import { AllianceStore, allianceTieBoost, allianceFavor, willingMembers, pickAllianceName, sameMembers, ALLIANCE } from "../../engine/alliances";
import type { Alliance } from "../../engine/alliances";
import { confessionalFor, involvedConfessionals, isBareGame, recordConfessionalToSoul, selectRecentForConfessional } from "../../engine/confessionals";
import type { ConfessionalContext, ConfessionalDepth } from "../../engine/confessionals";
import { CONFESSIONAL } from "../../engine/confessionalConstants";
import { buildPullQuoteReel } from "../../engine/pullQuoteReel";
import { rankApproaches, applyApproachCooldown, APPROACH_OWED } from "../../engine/conversation";
import { runHangOut, hangOutBedtime } from "../../engine/hangOut";
import { SEEK } from "../../engine/copresenceSpread";
import { desireFor, mostUrgent, urgency as desireUrgency, wantScale, type Candidate } from "../../engine/desireClock";
import { decideDealConsent } from "../../engine/dealConsent";
import { DEAL_CONSENT, DEAL_REFUSAL_LINE } from "../../engine/dealConsentConstants";
import { DECISION, NOMINATION_STYLE_BY_ARCHETYPE } from "../../engine/decisionConstants";
import { drawPhilosophy, styleOfPhilosophy } from "../../engine/philosophy";
import type { GamePhilosophy } from "../../engine/philosophyConstants";
import type { EvictionManner } from "../../engine/jury";
import type { NarrativePort } from "../../ports/NarrativePort";

/** Player public standing — the only axis the snarky hero tagline (0033) keys on. Vault-free. */
type Standing = "pre-game" | "hoh" | "nominee" | "veto-holder" | "houseguest";

/**
 * Curated, state-aware snarky Big Brother taglines (0033). Anti-sycophantic: a weak standing is
 * ribbed, not flattered. These are also the FAIL-OPEN fallback when no real narrator is wired (the
 * live narrator is a stub today) — so the hero line is always good, never a JSON dump, never blank.
 */
const SNARKY_TAGLINES: Record<Standing, string> = {
  "pre-game": "Sixteen strangers, one house, zero privacy — ready to lie to everyone you haven't met yet?",
  hoh: "Head of Household: for one week the whole house adores you and means none of it.",
  nominee: "On the block and on camera. Smile — someone you trusted put you here.",
  "veto-holder": "You're holding the veto, so suddenly everybody remembers your name.",
  houseguest: "Another day in the house. Trust no one — especially the ones being nice.",
};

const TAGLINE_INSTRUCTION =
  "Write ONE biting Big Brother welcome line for the player at this moment. One sentence, no spoilers, no quotes.";

/** First line, trimmed, length-capped — a hero line is one short line. */
function oneLine(s: string): string {
  return (s.split("\n")[0] ?? "").trim().slice(0, 120);
}

/**
 * Is `s` a reasonable, real-sounding two-token human name? The structural gate on an LLM-authored
 * replacement display name (`recordCastProfile.name`): exactly two whitespace-separated tokens, each a
 * plausible capitalized name part (optional hyphen/apostrophe compound, e.g. "O'Neil"), 2–12 chars, with at least one
 * vowel and no run of 4+ consecutive consonants. Rejects fantasy/gibberish ("Nerighrengeinen
 * Herneingenenin"); accepts "Marcus Webb", "Priya Anand", "Mary-Kate O'Neil". Vault-free, pure.
 */
export function isReasonableName(s: string): boolean {
  const tokens = s.trim().split(/\s+/);
  if (tokens.length !== 2) return false;
  const tokenRe = /^[A-Z][a-z]*([-'][A-Z]?[a-z]+)?$/;
  const vowelRe = /[aeiouy]/i;
  const consonantRunRe = /[bcdfghjklmnpqrstvwxz]{4,}/i;
  for (const token of tokens) {
    if (token.length < 2 || token.length > 12) return false;
    if (!tokenRe.test(token)) return false;
    if (!vowelRe.test(token)) return false;
    if (consonantRunRe.test(token)) return false;
  }
  return true;
}

/**
 * Sanitize an authored VOICE fingerprint (feature 0084 / the 2026-07-11 expressive-e2e authoring
 * widening of `recordCastProfile`). Voice is IDENTITY (owner ruling 2026-06-25): it folds WHOLE or not
 * at all — never spliced field-by-field over the seeded floor. Well-formed = all six dials + the prose
 * signature are non-empty bounded strings, and `lexicon` cleans to a small list (1–4) of short habitual
 * fillers. Returns the trimmed, whitespace-collapsed profile, or null when anything is missing or
 * malformed — the engine's seeded deterministic voice (the floor) then simply stands, exactly like a
 * dropped name/vocation. Pure and Vault-free by construction: voice is a PUBLIC, observable facet
 * (how a person talks), never a stat or hidden weight.
 *
 * #1395 — the OPTIONAL `catchphrases` (up to 3 short characteristic phrasings). Unlike the six dials +
 * signature + lexicon (the required whole), catchphrases are a BONUS: present + well-formed ⇒ they fold
 * in; absent/garbage ⇒ they are simply omitted (NEVER a whole-voice failure), so a model that authors a
 * good core voice but no catchphrases still lands its voice. Same bounds/whole-or-nothing philosophy at
 * the entry level (each phrase trimmed, collapsed, dropped if empty/over-long), capped small.
 */
const AUTHORED_VOICE_DIAL_MAX = 80;
const AUTHORED_VOICE_SIGNATURE_MAX = 200;
const AUTHORED_VOICE_LEXICON_MAX_ENTRIES = 4;
const AUTHORED_VOICE_LEXICON_ENTRY_MAX = 32;
const AUTHORED_VOICE_CATCHPHRASE_MAX_ENTRIES = 3;
const AUTHORED_VOICE_CATCHPHRASE_ENTRY_MAX = 48;
export function sanitizeAuthoredVoice(v: unknown): VoiceProfile | null {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
  const raw = v as Record<string, unknown>;
  const field = (key: string, cap: number): string | null => {
    const val = raw[key];
    if (typeof val !== "string") return null;
    const s = val.trim().replace(/\s+/g, " ");
    return s.length > 0 && s.length <= cap ? s : null;
  };
  const register = field("register", AUTHORED_VOICE_DIAL_MAX);
  const rhythm = field("rhythm", AUTHORED_VOICE_DIAL_MAX);
  const energy = field("energy", AUTHORED_VOICE_DIAL_MAX);
  const directness = field("directness", AUTHORED_VOICE_DIAL_MAX);
  const humor = field("humor", AUTHORED_VOICE_DIAL_MAX);
  const stressTell = field("stressTell", AUTHORED_VOICE_DIAL_MAX);
  const signature = field("signature", AUTHORED_VOICE_SIGNATURE_MAX);
  if (!register || !rhythm || !energy || !directness || !humor || !stressTell || !signature) return null;
  if (!Array.isArray(raw["lexicon"])) return null;
  const lexicon = (raw["lexicon"] as unknown[])
    .map((x) => (typeof x === "string" ? x.trim().replace(/\s+/g, " ") : ""))
    .filter((x) => x.length > 0 && x.length <= AUTHORED_VOICE_LEXICON_ENTRY_MAX)
    .slice(0, AUTHORED_VOICE_LEXICON_MAX_ENTRIES);
  if (lexicon.length === 0) return null;
  // #1395 — OPTIONAL catchphrases: fold a well-formed small set, omit otherwise (never fails the voice).
  const catchphrases = Array.isArray(raw["catchphrases"])
    ? (raw["catchphrases"] as unknown[])
        .map((x) => (typeof x === "string" ? x.trim().replace(/\s+/g, " ") : ""))
        .filter((x) => x.length > 0 && x.length <= AUTHORED_VOICE_CATCHPHRASE_ENTRY_MAX)
        .slice(0, AUTHORED_VOICE_CATCHPHRASE_MAX_ENTRIES)
    : [];
  return {
    register, rhythm, energy, directness, humor, stressTell, signature, lexicon,
    ...(catchphrases.length > 0 ? { catchphrases } : {}),
  };
}

/** Order-sensitive id-list equality (0065 Part E ceremony-diff): same length + same ids in order. */
function sameIds(a: readonly EntityId[], b: readonly EntityId[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}
/** Reject empty/over-long output and the Echo stub's context dump (so we fall open to the template). */
function isUsableTagline(s: string): boolean {
  return s.length > 0 && s.length <= 120 && !/[{}]/.test(s) && !/forEntity|visibleEvents|systemPrompt/i.test(s);
}
import { buildPortraitPrompt, buildCastPortraitPrompts, physicalFacetToAppearance } from "../../engine/portraitPrompts";
import { STYLE_ANCHOR_VARIANTS } from "../../engine/imageConstants";
import { planEntrances, toastSpeakers, TOAST_BATCH, PREMIERE_FIRST_READ } from "../../engine/premiereEntrances";
import { startNewGame, resolveStrategyStyle, hashSeed, isPlausibleArchetype, strengthTier, dispositionOf, archetypeMenace, VOL_OF } from "../../engine/characterFactory";
import type { Disposition } from "../../engine/characterFactory";
import type { GameHouse, StrategyStyle, Soul, HiddenElement, Character } from "../../engine/characterFactory";
import { evolveEmotion, arcNote, offscreenEmotion, composedEmotion, effectiveDisposition, settleScaleOf } from "../../engine/emotionalArc";
import { strategicDriveWeight } from "../../engine/offscreen";
import type { EmotionalEvent } from "../../engine/emotionalArc";
import type { SoulProvider } from "../../ports/SoulProvider";
import type { InteractionType } from "../../engine/relationships";
import { MANNER_GRADING, MANNER_THRESHOLDS, JURY_MEMORY } from "../../engine/juryConstants";
import {
  CEREMONY_IMPACTS, DEAL_REPUTATION, EVICTION_MANNER_SCALE, RELATIONSHIP_CONSTANTS, clamp01, scaleImpact,
} from "../../engine/relationshipConstants";
import type { CeremonyAct } from "../../engine/relationshipConstants";
import { ToldLedger } from "../../engine/heldFacts";
import { producerReadPrompt, type ExchangeAccounting } from "../../engine/producerRead";
import { notorietyBias, recognitionFor } from "../../engine/notoriety";
import type { NotorietySummary, OpenSetSeasonOutcome } from "../../engine/notoriety";
import {
  deriveTrajectory, decayTrajectory, STEADY,
  type Trajectory, type FoldSignal,
} from "../../engine/trajectory";
import { TRAJECTORY_CONSTANTS } from "../../engine/trajectoryConstants";
import { buildSystemPrompt, momentForPhase, requiredLeverForPhase, renderStoryFacts, renderSurfacedFacts, renderHardConstraints } from "../../engine/momentPrompts";
import {
  producerForSeed, renderProducerVoice, mergeProducer, validateProducerProfile,
  type Producer, type ProducerProfileOverlay,
} from "../../engine/producerPersona";
import { buildWorldSnapshot, renderZeitgeist, hasZeitgeist, ZEITGEIST, type WorldSnapshot, type ZeitgeistSlice } from "../../engine/zeitgeist";
import type { CompetitionType, Intent } from "../../domain/competitionOutcome";
import { strain as triggerStrain, shouldFire, eruptionEvent } from "../../engine/triggers";
import { TRIGGER, type EruptionKind } from "../../engine/triggerConstants";
import { SeededRandom } from "../random/SeededRandom";
import { PLAYER } from "../../domain/ids";
import type { EntityId } from "../../domain/ids";
import { EngineRefusal, StaleBeatError } from "../../domain/errors";
import { credibility, type CaughtLie } from "../../engine/credibility";
import { markTieVisibility, tieDirectedBias, publicTieAnnouncement } from "../../engine/tieVisibility";
import { recordRumorClaim, recordClaim, claimsOf, targetsMeTilt, type EdgeDelta } from "../../engine/beliefStore";
import { RelationshipModel, relationshipLabel, currentReadOf } from "../../engine/relationships";
import type { Stats } from "../../engine/season";
import {
  newLiveSeason, advance as advanceBeat, applyDecision, autoDecision, recordDealBetrayal, peekCompetition, COMP_INTENTS, deriveNpcCompIntent, GOODBYE_TONES, EXIT_STANCES, SPECTATOR_MODES,
  firstCeremonyBeatResolved,
  raiseSpectatorChoice as raiseSpectatorChoiceState, requestSelfEviction as requestSelfEvict, cancelSelfEviction as cancelSelfEvict, applySelfEviction, playerHasLeft,
  advanceClock, advanceClockPerConversation, advanceClockPerMessage, playerTurnIn, playerRestDeficit, npcRestDeficit, isInertBeat, eventBeatHours,
  nightBreakPending, nightHeld, tickPremiereClock, PREMIERE_ENTRY_HOUR, PREMIERE_STEP_HOURS, competitionStagingData, validateCompetitionFiction, competitionPresentation,
  type LiveSeasonState, type SeasonCtx, type BeatEvent, type DecisionInput, type PendingDecision, type GoodbyeTone, type ExitStance, type SpectatorMode,
  type FinaleProgress, type EvictionProgress, type DailyRecapHook,
} from "../../engine/liveSeason";
import { buildBeatAnnouncements, announcementHeadline, type BeatAnnouncement } from "../../engine/beatAnnouncement";
import { genCompetitionsEnvDefault } from "../../engine/genCompetitionConstants";
import { themeForWeek, applyTheme } from "../../engine/competitionThemes";
import type { CompetitionDef } from "../../engine/competitionLibrary";
import { formatClockLabel, restStatusFor, TIME_OF_DAY_LABEL, DAY_START, WAKE_HOUR, phaseForHour, DAY_END_HOUR, awakeSet, bedtimeDepthFor, socialSwayScale, soreSwayScale, CONFLICT_BEDTIME_DRAIN, BEDTIME_DEPTH_FLOOR, accrueFatigue, combinedRestDeficit, conversationHours, eventSpanHours, CLOCK, SCENE, type ConversationKind } from "../../engine/timeOfDay";
import { MINUTES_PER_MESSAGE } from "../../engine/sleepConstants";
import { APPROACH_GATE, APPROACH_COOLDOWN_STRETCHES } from "../../engine/decisionConstants";
import { FINALE_APPEALS, type FinaleAppeal } from "../../engine/jury";
import { loadReserveTwists, planReserveTwists, RESERVE_POOL } from "../../engine/reserveTwists";
import {
  generateCastDeepLayer, deepProfileToVaultContent, generateDeepProfile, deriveStoryThreads,
  defaultTriggerConditionFor, triggerMet, sourceWindowClosed, threadRumor,
  storyThreadToRetrospectiveProse,
  type SeasonPosition,
} from "../../engine/deepProfile";
import { THREAD } from "../../engine/threadConstants";
import { flagDefaultOn as flagDefaultOnIn } from "../../domain/flagDefaults";
/** The engine's default-on flag read: the pure domain parser over the process env (the one ambient read lives here, in the adapter). */
const flagDefaultOn = (name: string): boolean => flagDefaultOnIn(name, process.env);
import {
  loadSeededRelationships, migrateSeededRelationships, normalizeTieNature, type TieNature, TIE_AFFINITY_BIAS, SHOWMANCE_SPARK_BIAS,
  DEFAULT_TIE_BUDGET, DEFAULT_SHOWMANCE_BUDGET, nextShowmanceStage,
  preGameTieToRetrospectiveProse, showmanceToRetrospectiveProse,
  tieExposureOf, tieNatureProse, exposedTies, nextTieExposure,
} from "../../engine/seededRelationships";
import type { SeededRelationships, PreGameTie } from "../../engine/seededRelationships";
import { TIE_BEHAVIOR } from "../../engine/tieBehavior";
import { validateCastGenesis, generateSeasonBrief } from "../../engine/castGenesis";
import type { CastGenesisProposal, SeasonBrief, GenesisContext } from "../../engine/castGenesis";
import { surfaceSeededTies } from "../../engine/seededTieSurfacing";
import type { SurfacedTie } from "../../engine/seededTieSurfacing";
import { overhearTieReveal } from "../../engine/tieReveal";
import type { TieRevealEvent } from "../../engine/tieReveal";
import { TIE_REVEAL } from "../../engine/tieRevealConstants";
import { isMateriallyDistorted } from "../../engine/beliefReliability";
import { heardConfidence, isHeardNature, isMisheard, tellerReliability, type HeardNature } from "../../engine/heardAboutMe";
import type { DeepProfile, StoryThread } from "../../engine/deepProfile";
import {
  generateDiversityLayer, repairDiversityLayer, privateOrientationToVaultContent, showmancePlausible,
} from "../../engine/diversity";
import type { ProposedIdentityFacets } from "../../engine/diversity";
import { nameGenderOf, pickGivenNameFor } from "../../engine/data/nameGender";
import type { Orientation, GenderPresentation } from "../../engine/diversityConstants";
import { ALL_ETHNICITIES, GENDER_PRESENTATIONS } from "../../engine/diversityConstants";
import { isGenderPresentation } from "../../domain/gender"; // #1326
import { foldHiddenImpact } from "../../engine/consequence";
import {
  decideConfidence, disclosureMotive, disclosureTier, discloseTrue, fabricate,
  type ConfidenceSignals,
} from "../../engine/confidence";
import { CONFIDENCE, type DisclosureTier } from "../../engine/confidenceConstants";
import {
  severityOf, leverageStrength, leverageDealBoost, dealAcceptance, exposeOutcome,
  tradeValue, tradeDealBoost, tradeOutcome, bluffBelieved,
  type LeverageSignals, type TradeSignals, type BarterCandidate,
} from "../../engine/leverage";
import { SECRET_BARTER } from "../../engine/secretBarterConstants";
import { LEVERAGE, SECRET_TRADE } from "../../engine/leverageConstants";
import { NO_HARD_CAPS } from "../../engine/noHardCapsConstants";
import { repetitionImpact, lieProbScale } from "../../engine/repetitionCost";
import {
  rankPlayerBoundThreads, dripBudget, recencyFromAge, relationshipReads,
  type PlayerBoundThread, type RankedThread,
} from "../../engine/secretPacing";
import { SECRET_PACING } from "../../engine/secretPacingConstants";
import {
  composeShowrunnerNote, emphasisForThread, reweightThreadOrder, showrunnerNoteToProse,
  type ShowrunnerNote, type ThreadSignal,
} from "../../engine/showrunner";
import { SHOWRUNNER } from "../../engine/showrunnerConstants";
import { derivedLoyalty } from "../../engine/blocs";
import type { ReserveTwist, TwistKind } from "../../engine/reserveTwists";
import type { CeremonyState, SessionCore, TrackedSighting } from "../../engine/sessionSnapshot";
import { cloneSession, fastClone } from "../../engine/sessionSnapshot";
import { diffuseGossip, makeSocialGraph, gossipEdgeAffinity, GOSSIP, LEGEND, legendFrom } from "../../engine/gossip";
import { notablePlayerActs } from "../../engine/legends";

const COMP_TYPES: ReadonlySet<string> = new Set<CompetitionType>([
  "endurance", "physical", "puzzle", "quiz", "memory", "mental", "social",
]);

/**
 * A READABLE category label for a hidden record's machine kind/type, for the post-season retrospective
 * (0048). The FE renders each unsealed row as "[type] content", so a raw slug (`hidden-thread`,
 * `seeded-relationship`, `offscreen-event`) becomes a debug tag; this maps it to plain words instead.
 * Pure / Vault-free (a category name reveals nothing). Unknown kinds fall back to a de-slugged title.
 */
const RETROSPECTIVE_LABELS: Readonly<Record<string, string>> = {
  "hidden-thread": "Secret thread",
  "seeded-relationship": "Hidden tie",
  "hidden-attribute": "Hidden side",
  confessional: "Confessional",
  "offscreen-event": "Off-screen",
  gossip: "Whisper",
  conversation: "Off-screen",
  scheme: "Off-screen",
};
function retrospectiveLabel(kind: string): string {
  if (RETROSPECTIVE_LABELS[kind]) return RETROSPECTIVE_LABELS[kind]!;
  // Fallback: de-slug an unmapped kind ("some-kind" → "Some kind") so no raw machine slug ever shows.
  const words = kind.replace(/[:_-]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "Hidden";
}

/**
 * #996 — a houseguest's hidden story threads are derived from THREE distinct sources (2–3 secrets, the
 * weakness, the first true goal). Labeling them all "Secret thread" stacked 4–5 contradictory "secrets"
 * in the dump. Derive the row label from the thread's SOURCE CLASS instead — read off the premise tag
 * (`secret —` / `weakness —` / `true goal —`, set at derive time in `deriveStoryThreads`), matching the
 * prose naturalization in `storyThreadToRetrospectiveProse` ("Secretly… / Their blind spot… / Their real
 * game…"). So the rows read as {2–3 secrets + 1 blind-spot + 1 real-game}, not 5 "secrets". Vault-free
 * (a category label reveals nothing); a missing/unknown tag falls back to "Secret thread" (the prior
 * behavior). Label-only — the thread content/derivation is untouched.
 */
function storyThreadLabel(premise: string): string {
  if (premise.startsWith("weakness")) return "Blind spot";
  if (premise.startsWith("true goal")) return "Real game";
  return "Secret thread";
}

/**
 * The MUTUAL off-screen interaction verbs (mirroring the public `RICH_VERBS` phrasing in
 * `src/engine/offscreen.ts`). A scene recorded as `A <verb> B` and its counterpart `B <verb> A` are the
 * SAME mutual happening seen from each side — the dump should show it ONCE (#842). Render-time
 * recognition of PUBLIC content only (no engine coupling, no Vault data); kept local + ordered
 * longest-first so a contained phrase can't shadow a longer one.
 */
const MUTUAL_OFFSCREEN_VERBS: readonly string[] = [
  "formed an alliance with",
  "gossiped about the house with",
  "talked strategy with",
  "quietly turned on",
  "grew close to",
  "clashed with",
  "bonded with",
];

/**
 * Coalesce the unsealed dump rows for readability (#841/#842) — a PURE render-time pass that NEVER
 * changes what the engine recorded (no event/RNG touch), only what the operator is shown:
 *   - #841: drop a byte-identical `{type, content}` row (keep the first occurrence);
 *   - #842: collapse a SYMMETRIC off-screen pair (`A <mutual-verb> B` + `B <mutual-verb> A`, ignoring any
 *           ` — detail` tail) into ONE row — the same mutual scene from each side.
 * Order-stable: the first row of any duplicate/mirror set is kept in place.
 */
function coalesceDumpRows(
  rows: ReadonlyArray<{ type: string; content: string; ts?: number }>,
): Array<{ type: string; content: string; ts?: number }> {
  const out: Array<{ type: string; content: string; ts?: number }> = [];
  const seenExact = new Set<string>();
  const seenMutual = new Set<string>();
  for (const r of rows) {
    // #841 — exact duplicate.
    const exactKey = `${r.type}\u0000${r.content}`;
    if (seenExact.has(exactKey)) continue;
    seenExact.add(exactKey);
    // #842 — symmetric mutual off-screen scene. Strip a trailing " — detail" before matching the pair so
    // two mirrored scenes with different flavor tails still coalesce on the parties + verb.
    const core = r.content.replace(/\s+—\s.*$/, "").trim();
    let mutualKey: string | null = null;
    for (const verb of MUTUAL_OFFSCREEN_VERBS) {
      const at = core.indexOf(` ${verb} `);
      if (at <= 0) continue;
      const a = core.slice(0, at).trim();
      const b = core.slice(at + verb.length + 2).trim();
      if (!a || !b) continue;
      const pair = [a, b].sort();
      mutualKey = `${r.type}\u0000${verb}\u0000${pair[0]}\u0000${pair[1]}`;
      break;
    }
    if (mutualKey) {
      if (seenMutual.has(mutualKey)) continue;
      seenMutual.add(mutualKey);
    }
    out.push(r.ts !== undefined ? { type: r.type, content: r.content, ts: r.ts } : { type: r.type, content: r.content });
  }
  return out;
}

/**
 * A fresh entropy seed for a game created WITHOUT an explicit seed (E39/C7): a uint32 from
 * `crypto` randomness, persisted in the snapshot (`gameSeed`) so the season stays reproducible
 * AFTER creation. This is an adapter (not the pure core) — the one sanctioned place real
 * entropy enters; everything downstream still flows through the seeded `RandomnessSource`.
 */
function entropySeed(): number {
  return randomBytes(4).readUInt32LE(0);
}

/**
 * 0065 — the pre-game holding store for a PRE-WARMED cast (see `GameSessionAdapter.prewarm`). Holds
 * exactly the player-INDEPENDENT cast state that `createCharacter` would otherwise generate at finalize:
 * the NPC roster (with their PUBLIC facets + any AUTHORED enrichment), the HIDDEN deep layer, the derived
 * story threads, the sealed private orientations, the grounded skin tones, and the per-season portrait
 * style anchor. ENGINE-ONLY (it carries the hidden layer); persisted in the snapshot so a half-warmed
 * cast survives a restart.
 */
interface PrewarmCast {
  seed: number;
  npcs: GameHouse["npcs"];
  deepProfiles: Record<EntityId, DeepProfile>;
  storyThreads: StoryThread[];
  privateOrientations: Record<EntityId, Orientation>;
  groundedSkinTones: Record<EntityId, string>;
  portraitStyleAnchor: string;
  // 0116 — model-authored cast genesis: present once `recordCastGenesis` authored the warmed skeleton.
  // The validated tie graph rides here so createCharacter's adopt path can prefer it over the floor draw;
  // the seeded brief + provenance persist with the warm. Absent ⇒ the deterministic floor cast (byte-neutral).
  genesisTies?: PreGameTie[];
  seasonBrief?: SeasonBrief;
  genesisAuthored?: boolean;
}

/**
 * 0065 — the throwaway player name `preSeedCast` builds its temporary house with. The pre-warm cast is
 * player-INDEPENDENT, so this never reaches the warmed NPCs (their generation runs before any player
 * material) and the placeholder player is discarded the instant the cast is captured.
 */
const PREWARM_PLAYER_NAME = "(pre-warm)";

/**
 * Flatten untrusted FE text before it rides into a SYSTEM prompt (the C8 pattern): collapse ALL
 * whitespace (newlines/tabs/control chars that could forge a prompt line) into single spaces and cap the
 * length. Used by the 0062 zeitgeist write-back (`recordWorldSnapshot`) — the snapshot is non-secret
 * public flavor, but it is still player/FE-sourced text woven into the moment prompt.
 */
function sanitizeFlavor(s: string, max = 160): string {
  return s.replace(/\s+/g, " ").trim().slice(0, max);
}

/**
 * 0085 B2 — whether the live campaign layer runs by DEFAULT. ON unless `ORWELL_CAMPAIGNS=0` (or the diagnostic `ORWELL_FLAGS_OFF=1`) (since the 2026-11 default flip it is ON in code, so the seeded gates, the UAT and the deploy all play the same game; `ORWELL_FLAGS_OFF=1` restores the legacy all-off profile). Read once at
 * module load, like the watcher cadence; a test overrides per-session via `setCampaignsEnabled`.
 */
/** Spell a week number in words (no digits in a recorded pitch line) - pitch events carry it so a hidden pitch is never a verbatim twin of a witnessed one from another week (the vault-leak checkpoint matches text). */
const WEEK_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty"];
const weekWords = (n: number): string => (n >= 0 && n < WEEK_WORDS.length ? WEEK_WORDS[n]! : `no ${n.toString(36).replace(/[0-9]/g, (d) => "abcdefghij"[Number(d)]!)}`);
const CAMPAIGNS_ENABLED_DEFAULT = flagDefaultOn("ORWELL_CAMPAIGNS");
/** 0107 Phase B — the binding-action kinds that count as a betrayal of a named co-ally. */
const ALLIANCE_ADVERSE = new Set(["nominate", "replace", "vote-evict"]);

/**
 * 0087 — whether the RELATIONSHIP-TRAJECTORY layer runs by DEFAULT. ON unless `ORWELL_TRAJECTORIES=0` (or the diagnostic `ORWELL_FLAGS_OFF=1`).
 * A DEDICATED flag (not a reuse of `ORWELL_CAMPAIGNS`) so calibration neutrality is provable in isolation:
 * with it unset, NO trajectory is computed, `natureWeights` is the identity, and every seeded gate
 * (juryReach/gradient/UAT) is byte-identical. The calibration/UAT harness never sets it; the live deploy
 * does. Read once at module load (like the watcher cadence + the campaign flag); a test overrides
 * per-session via `setTrajectoriesEnabled`.
 */
const TRAJECTORIES_ENABLED_DEFAULT = flagDefaultOn("ORWELL_TRAJECTORIES");

/**
 * 0120 — whether the STRATEGIC-DRIVE INITIATOR CADENCE runs by DEFAULT. ON unless
 * `ORWELL_STRATEGIC_CADENCE=0` (or the diagnostic `ORWELL_FLAGS_OFF=1`). A DEDICATED flag (sibling to `ORWELL_TRAJECTORIES`/`ORWELL_CAMPAIGNS`) so
 * calibration neutrality is provable in isolation: unset ⇒ the off-screen initiator is drawn with the
 * uniform `rng.pick` exactly (no `initiatorDriveOf` is passed), and every seeded gate is byte-identical.
 * The calibration/UAT harness never sets it; the live deploy does. A test overrides per-session via
 * `setStrategicCadenceEnabled`. When on, sharper/more-strategic houseguests scheme a touch more often.
 */
const STRATEGIC_CADENCE_ENABLED_DEFAULT = flagDefaultOn("ORWELL_STRATEGIC_CADENCE");

/**
 * Wave-2 off-screen-society fidelity — whether OFF-SCREEN SCHEMING NAMES A REAL TARGET runs by DEFAULT.
 * ON unless `ORWELL_SCHEME_TARGETS=0` (or the diagnostic `ORWELL_FLAGS_OFF=1`). A DEDICATED flag (sibling to `ORWELL_STRATEGIC_CADENCE`/
 * `ORWELL_TRAJECTORIES`) so calibration neutrality is provable in isolation: unset ⇒ the off-screen tick
 * passes no `nameSchemeTargets` ⇒ no target clause is appended and every seeded gate is byte-identical (the
 * clause rides a per-scene SIDE rng, so even ON the main stream is byte-identical — the flag keeps the
 * hidden CONTENT byte-identical when off too). The calibration/UAT harness never sets it; the live deploy
 * does. A test overrides per-session via `setSchemeTargetsEnabled`.
 */
const SCHEME_TARGETS_ENABLED_DEFAULT = flagDefaultOn("ORWELL_SCHEME_TARGETS");

/**
 * 0121 — whether the DEAL-DEPTH layer runs by DEFAULT (the active-obligation kinds `comp-throw`/`veto-save`
 * + the reliability rewards). ON unless `ORWELL_DEAL_DEPTH=0` (or the diagnostic `ORWELL_FLAGS_OFF=1`). A DEDICATED flag (sibling to
 * `ORWELL_STRATEGIC_CADENCE`/`ORWELL_CAMPAIGNS`) so calibration neutrality is provable in isolation: unset ⇒
 * the new kinds can't be made and every deal fold is exactly 0039/0109 ⇒ byte-identical. NOT yet in the
 * deploy — the live-loop reconciliation of the new kinds + the reward folds land before it opts in.
 */
const DEAL_DEPTH_ENABLED_DEFAULT = flagDefaultOn("ORWELL_DEAL_DEPTH");
/**
 * 0024 — whether the NPC MEMORY layer runs by DEFAULT. ON unless `ORWELL_NPC_MEMORY=0` (or the diagnostic
 * `ORWELL_FLAGS_OFF=1`) — PO ruling 2026-11-03: memories ON. A DEDICATED flag (sibling to `ORWELL_DEAL_DEPTH`) so
 * calibration neutrality stays provable in isolation: with it OFF NO memory is written, `memoryTiltFor` is absent
 * from the ctx, and every seeded decision is byte-identical. Toggleable per session via `setNpcMemoryEnabled`.
 * (Measured 2026-11-03: ON vs OFF is outcome-identical over 200 seeds × 3 arms — the residual floor means the
 * relationship edge already carries a fresh betrayal, so the tilt reads 0 within a season; see the #2017 design.)
 */
const NPC_MEMORY_ENABLED_DEFAULT = flagDefaultOn("ORWELL_NPC_MEMORY");
const NPC_MEMORY_STANDALONE_ENABLED_DEFAULT = flagDefaultOn("ORWELL_NPC_MEMORY_STANDALONE");
const NPC_MEMORY_WRITERS_ENABLED_DEFAULT = flagDefaultOn("ORWELL_NPC_MEMORY_WRITERS");

/**
 * 0122 — whether the DEEPER, DAILY confessional layer runs by DEFAULT (the five triggered facets +
 * the once-per-in-game-day sweep where most living NPCs confess unless their game is bare). ON unless
 * `ORWELL_CONFESSIONAL_DEPTH=0` (or the diagnostic `ORWELL_FLAGS_OFF=1`). A DEDICATED flag (sibling to `ORWELL_DEAL_DEPTH`/`ORWELL_STRATEGIC_CADENCE`)
 * so calibration neutrality is provable in isolation: unset ⇒ no daily sweep runs, no depth context is
 * passed, and every confessional is exactly 0040/0089/0090 ⇒ byte-identical. The sweep additionally gates
 * on `perConversationClockLive()` (pinned off in the golden driver), so the golden fixture never stales.
 */
const CONFESSIONAL_DEPTH_ENABLED_DEFAULT = flagDefaultOn("ORWELL_CONFESSIONAL_DEPTH");

/**
 * 0123 — whether the NPC-initiated deal-OFFER layer runs by DEFAULT (a motivated houseguest floats the
 * player a deal at a lull; accept → a real deal, decline → a cooling). ON unless `ORWELL_NPC_DEAL_OFFERS=0` (or the diagnostic `ORWELL_FLAGS_OFF=1`).
 * A DEDICATED flag (sibling to `ORWELL_DEAL_DEPTH`/`ORWELL_CONFESSIONAL_DEPTH`) so calibration neutrality is
 * provable in isolation: unset ⇒ no offer is generated, no pending is raised, nothing folds ⇒ byte-identical.
 */
const NPC_DEAL_OFFERS_ENABLED_DEFAULT = flagDefaultOn("ORWELL_NPC_DEAL_OFFERS");

/**
 * 0124 — whether the DEEPER character-evolution layer runs by DEFAULT (independent distress/confidence
 * axes + strategic-temperament drift + disposition-tuned reactivity). ON unless `ORWELL_SOUL_DEPTH=0` (or the diagnostic `ORWELL_FLAGS_OFF=1`).
 * A DEDICATED flag (sibling to `ORWELL_CONFESSIONAL_DEPTH`/`ORWELL_DEAL_DEPTH`) so calibration neutrality
 * is provable in isolation: unset ⇒ `evolveEmotion` moves only the single 0041 scalar, the behavior reads
 * use the plain `emotionalState`/static disposition, and NPC volatility is the legacy random draw ⇒
 * byte-identical (the seeded `juryReach`/golden spine untouched).
 */
const SOUL_DEPTH_ENABLED_DEFAULT = flagDefaultOn("ORWELL_SOUL_DEPTH");

/**
 * 0125 — whether the competition THEME/skin layer runs by DEFAULT. ON for real play unless
 * `ORWELL_COMP_THEMES=0` (default-on, like the per-conversation clock — real players want the variety).
 * It is a pure Vault-free PROJECTION: the seeded theme is chosen on a dedicated hash (never the beat rng)
 * and only reskins the SURFACED name/premise — the mechanic, the governing stat, and the winner are
 * unchanged — so the seeded spine (juryReach/gradient/UAT) is byte-identical whether it is on or off. The
 * golden driver pins `=0` so the committed fixture (recorded theme-free) replays byte-identically without a
 * re-record; a fresh re-cut can drop the pin to capture themed scaffolds.
 */
const COMP_THEMES_ENABLED_DEFAULT = process.env.ORWELL_COMP_THEMES !== "0";

/**
 * 0126 — whether the EXPANDED competition-mechanic pool (9 HOH + 9 veto extra, 30 total) runs by DEFAULT.
 * ON unless `ORWELL_COMP_MECHANICS_PLUS=0` (or the diagnostic `ORWELL_FLAGS_OFF=1`). Unlike the 0125 THEME layer (a pure projection, default-on),
 * this changes WHICH mechanic a fixed seed draws — and the def's `type` selects the resolution stat — so it
 * changes seeded winners (the COMP-4 cost). A DEDICATED default-off flag so calibration neutrality is
 * provable in isolation: unset ⇒ `ctx().expandedComps` is false, the draw pool is the bare base 12, and
 * every seeded gate (juryReach / gradient / UAT / golden / the fixed-seed 0043 BDD) is byte-identical. The
 * deploy turns it on for real play; the new mechanics preserve the base stat mix so the band still holds.
 */
const COMP_MECHANICS_PLUS_ENABLED_DEFAULT = flagDefaultOn("ORWELL_COMP_MECHANICS_PLUS");

/**
 * 0127 — whether HYBRID competitions blend their SECONDARY aptitude into the outcome by DEFAULT (a
 * physical-with-a-puzzle-element veto rewards a well-rounded houseguest). ON unless `ORWELL_COMP_MIXED=0` (or the diagnostic `ORWELL_FLAGS_OFF=1`).
 * Like 0126, this changes seeded winners (the score base becomes a stat blend), so it is DEFAULT-OFF: unset
 * ⇒ `ctx().mixedComps` is false, every comp resolves on its pure single stat, and every seeded gate
 * (juryReach / gradient / UAT / golden) is byte-identical. The primary stat still dominates (weight
 * `1 − mixedSecondaryWeight`); the deploy turns it on and the band is re-confirmed on.
 */
const COMP_MIXED_ENABLED_DEFAULT = flagDefaultOn("ORWELL_COMP_MIXED");

/**
 * C1 (#1788, Q8 hybrid-greenlit small+reversible build) — whether the WIPEOUT REEL runs by DEFAULT (ON since 2026-11-06, ORW-16: finished, presentation-only, Q8-greenlit; `=0` turns it off): a
 * seeded, archetype-flavored `failureStyle` fact-to-voice attached to each pre-rolled staged-comp drop
 * (`liveSeason.ts`'s `beginStaged`/`advanceCompetition`). ON unless `ORWELL_WIPEOUT_REEL=0`.
 * PRESENTATION ONLY, like 0125's theme layer: the failure-style text is drawn from a stream FORKED
 * (`rng.fork`) AFTER the single up-front `resolveCompetition` roll that fixes the crown + drop order —
 * it never advances or reads the parent stream, so the OUTCOME axis (winner, `dropOrder`, every
 * downstream seeded draw) is byte-identical whether this is on or off
 * (`tests/unit/stagedTrajectoryNeutral.test.ts` is the guard). Off ⇒ `ctx().wipeoutReelEnabled` is
 * false ⇒ no failure-style fact is computed or appended ⇒ byte-identical to the pre-feature
 * `comp-elimination` content.
 */
const WIPEOUT_REEL_ENABLED_DEFAULT = flagDefaultOn("ORWELL_WIPEOUT_REEL");

/**
 * 0128 (issue #2045) - the THREE-PART Final HOH (endurance for all three -> a physical+mental hybrid between the two Part-1 losers -> a quiz between the two part-winners)
 * instead of the single Final-3 competition. ON unless `ORWELL_FINAL_HOH_THREE_PART=0` (or the diagnostic `ORWELL_FLAGS_OFF=1`) - flipped ON 2026-11-04 (PO: Ryne wants it) after
 * `juryReach` + `calibrationGradient` held their bands ON. Off => `ctx().finalHohThreePart` is absent and the 0045 single-comp path runs byte-identically.
 */
const FINAL_HOH_THREE_PART_ENABLED_DEFAULT = flagDefaultOn("ORWELL_FINAL_HOH_THREE_PART");

/**
 * A2 (design §13) - PER-JUROR vote profiles (archetype weights + friend-forgives) instead of one global ballot weight vector. ON unless `ORWELL_JUROR_PROFILES=0` (flipped 2026-11-06, ORW-16 / A2 / A63: measured calibration-neutral, passive wins 3% both ways): it changes
 * how individual jurors weigh the terms (the house-mean weight per term is preserved by construction), so it is calibration-gated. Off => `ctx().jurorProfiles` is absent and the
 * ballot is byte-identical.
 */
const JUROR_PROFILES_ENABLED_DEFAULT = flagDefaultOn("ORWELL_JUROR_PROFILES");
/**
 * A9 - the staged PREMIERE ENTRANCES + champagne toast (`docs/design/premiere-entrances.md`). OFF unless
 * `ORWELL_PREMIERE_ENTRANCES=1`; read at `createCharacter` (season start). Off => nothing new is written.
 */
const PREMIERE_ENTRANCES_ENABLED_DEFAULT = flagDefaultOn("ORWELL_PREMIERE_ENTRANCES");

/**
 * "Hang out until X" (PO 2026-11-04) - the safe fast-forward lever (`hangOut`). ON unless `ORWELL_HANGOUT=0` (or the diagnostic `ORWELL_FLAGS_OFF=1`) - flipped ON 2026-11-04 (PO: Ryne) after the live rerun showed it stops exactly at the scheduled event and the HOH comp stages when due. Off => `hangOut()` returns `{ ok:false }` with no state change and the spine is byte-identical.
 */
/** Per-beat chances for the hang-out interruptions (side-stream draws). Tunable here. */
// `ORWELL_HANGOUT_P_SCALE` multiplies the three chances for live on-screen VERIFICATION only (A15: make the rarer stop reasons fire within one short playthrough); the deploy never sets it => x1.
const _hoScale = Number(process.env.ORWELL_HANGOUT_P_SCALE);
const HANGOUT_P_SCALE = process.env.ORWELL_HANGOUT_P_SCALE !== undefined && Number.isFinite(_hoScale) && _hoScale > 0 ? _hoScale : 1;
const HANGOUT_PULL_P = Math.min(0.9, 0.03 * HANGOUT_P_SCALE), HANGOUT_APPROACH_P = Math.min(0.9, 0.08 * HANGOUT_P_SCALE), HANGOUT_OBSERVED_P = Math.min(0.9, 0.07 * HANGOUT_P_SCALE);
/**
 * A8 - NPC approaches keyed to elapsed in-game HOURS and each NPC's own desire clock (urgency rises toward the event they care about; an hours-based cooldown). OFF unless
 * `ORWELL_DESIRE_CLOCK=1`. Off => nothing is written to the live state and the hang-out keeps its flat per-beat approach roll, so the spine is byte-identical.
 */
const DESIRE_CLOCK_ENABLED_DEFAULT = flagDefaultOn("ORWELL_DESIRE_CLOCK");
/**
 * A10 - NPC MOVEMENT from one internal WANT (docs/design/npc-want-movement.md): an NPC's pull toward the person its current want points at (the HOH to campaign to / plead with,
 * the nominees to sound out) is scaled up by the want's urgency (the A8 desire clock). OFF unless `ORWELL_WANT_MOVEMENT=1`; off => `movementIntentFor` is untouched (byte-identical).
 */
const WANT_MOVEMENT_ENABLED_DEFAULT = flagDefaultOn("ORWELL_WANT_MOVEMENT");
const HANGOUT_ENABLED_DEFAULT = flagDefaultOn("ORWELL_HANGOUT");

/**
 * 0091 — whether the TRIGGER-ERUPTION layer runs by DEFAULT. ON unless `ORWELL_TRIGGERS=0` (or the diagnostic `ORWELL_FLAGS_OFF=1`). A DEDICATED
 * flag (sibling to `ORWELL_CAMPAIGNS`/`ORWELL_TRAJECTORIES`) so calibration neutrality is provable in
 * isolation: with it unset, the orchestrator never runs the trigger check ⇒ ZERO draws on any rng ⇒ every
 * seeded gate (juryReach/gradient/UAT) is byte-identical (the load-bearing determinism guarantee). The
 * calibration/UAT harness never sets it; the live deploy does. Read once at module load; a test overrides
 * per-session via `setTriggersEnabled`.
 */
const TRIGGERS_ENABLED_DEFAULT = flagDefaultOn("ORWELL_TRIGGERS");
/**
 * 0092 — whether the SECRET-PACING DRIP runs by DEFAULT. ON unless `ORWELL_SECRET_PACING=0` (or the diagnostic `ORWELL_FLAGS_OFF=1`). A DEDICATED
 * flag (sibling to `ORWELL_CAMPAIGNS` / `ORWELL_TRAJECTORIES` / `ORWELL_SEEDED_TIE_SURFACING`) so
 * calibration neutrality is provable in isolation: with it unset, the pacing pass takes ZERO draws, 0060's
 * own flat surface-to-player path is the only one that runs, and every seeded gate (juryReach/gradient/UAT)
 * is byte-identical to the pre-feature build. The calibration/UAT harness never sets it; the live deploy
 * may. Read once at module load (like the watcher cadence + the sibling flags); a test overrides
 * per-session via `setSecretPacingEnabled`. Default-off until the cadence is tuned against the UAT.
 */
const SECRET_PACING_ENABLED_DEFAULT = flagDefaultOn("ORWELL_SECRET_PACING");
/**
 * 0006b (PO review 2026-06-28) — whether NPCs carry a derived COMPETITION INTENT by DEFAULT. ON unless
 * `ORWELL_COMP_INTENT=0` (or the diagnostic `ORWELL_FLAGS_OFF=1`). A DEDICATED flag (sibling to `ORWELL_CAMPAIGNS` etc.) so calibration neutrality
 * is provable in isolation: with it unset, `ctx().compIntentOf` is absent, every NPC "compete"s (the
 * pre-feature path), and every seeded gate (juryReach/gradient/UAT) is BYTE-IDENTICAL. The calibration/UAT
 * harness never sets it; the live deploy may. A test overrides per-session via `setCompIntentEnabled`.
 */
const COMP_INTENT_ENABLED_DEFAULT = flagDefaultOn("ORWELL_COMP_INTENT");
/**
 * 0110 (PO review 2026-06-28) — whether the eviction jury grudge folds on the evictee's DEDUCED belief
 * (process of elimination) instead of the true secret ballot. ON unless `ORWELL_VOTE_DEDUCTION=0` (or the diagnostic `ORWELL_FLAGS_OFF=1`). A
 * DEDICATED flag (sibling of the others) so calibration neutrality is provable in isolation: with it
 * unset, `ctx().voteDeduction` is false, the grudge folds the true `votesToEvict` exactly as before, no
 * deduction sub-rng is drawn, and every seeded gate (juryReach/gradient/UAT) is BYTE-IDENTICAL. The
 * calibration/UAT harness never sets it; the live deploy may. A test overrides via `setVoteDeductionEnabled`.
 */
const VOTE_DEDUCTION_ENABLED_DEFAULT = flagDefaultOn("ORWELL_VOTE_DEDUCTION");
/**
 * 0100 — whether the JURY-HOUSE grudge layer runs by DEFAULT. ON unless `ORWELL_JURY_HOUSE=0` (or the diagnostic `ORWELL_FLAGS_OFF=1`). A
 * DEDICATED flag (sibling to `ORWELL_CAMPAIGNS`/`ORWELL_TRAJECTORIES`) so calibration neutrality is
 * provable in isolation: with it unset NO jury-house stretch runs, NO draw is taken (the dedicated
 * stream never advances), and NO grudge is applied ⇒ the seeded `juryReach`/UAT spine is byte-identical
 * to today. The calibration/UAT harness never sets it; the live deploy does. Read once at module load
 * (like the campaign/trajectory flags); a test overrides per-session via `setJuryHouseEnabled`.
 */
const JURY_HOUSE_ENABLED_DEFAULT = flagDefaultOn("ORWELL_JURY_HOUSE");

/**
 * #1790 — whether the TRAITORS'-FURY juror-bearing word layer runs by DEFAULT. ON unless
 * `ORWELL_TRAITORS_FURY=0` (or the diagnostic `ORWELL_FLAGS_OFF=1`). A DEDICATED flag (sibling to `ORWELL_JURY_HOUSE`) so calibration
 * neutrality is provable in isolation: with it unset, bearingWord returns a constant default
 * ("settled") and the seeded jury-read spine is byte-identical. A test overrides per-session
 * via `setTraitorsFuryEnabled`.
 */
const TRAITORS_FURY_ENABLED_DEFAULT = flagDefaultOn("ORWELL_TRAITORS_FURY");
/**
 * #1792 — whether the Producer Read (post-scene exchange-accounting beat) runs
 * by DEFAULT. ON unless `ORWELL_PRODUCER_READ=0` (or the diagnostic `ORWELL_FLAGS_OFF=1`). Flag-gated so a disabled
 * flag means the `recordInteraction` sink is never wired ⇒ nothing computed ⇒
 * byte-identical. A test overrides per-session via `setProducerReadEnabled`.
 */
const PRODUCER_READ_ENABLED_DEFAULT = flagDefaultOn("ORWELL_PRODUCER_READ");
/**
 * #1802 — whether the DEAL WITNESSES (formation-witness collateral on deals) layer runs
 * by DEFAULT. ON unless `ORWELL_DEAL_WITNESSES=0` (or the diagnostic `ORWELL_FLAGS_OFF=1`). Flag-gated so a disabled flag means
 * `formationWitnesses` is either unpopulated or ignored, trust-fold magnitude and breach
 * diffusion behave exactly as today ⇒ byte-identical. A test overrides per-session
 * via `setDealsWitnessesEnabled`.
 */
const DEALS_WITNESSES_ENABLED_DEFAULT = flagDefaultOn("ORWELL_DEAL_WITNESSES");
/**
 * 0101 — whether NPC MYTH-MAKING runs by DEFAULT. ON unless `ORWELL_MYTH_MAKING=0` (or the diagnostic `ORWELL_FLAGS_OFF=1`). A DEDICATED flag
 * (sibling to `ORWELL_CAMPAIGNS`/`ORWELL_JURY_HOUSE`) so calibration neutrality is provable in isolation:
 * with it unset, `legendTick` no-ops before drawing anything (the dedicated legend-rng stream never
 * advances) and no legend is ever seeded ⇒ the seeded `juryReach`/gradient/UAT spine is byte-identical to
 * today. The calibration/UAT harness never sets it; the live deploy may. Read once at module load (like
 * the sibling flags); a test overrides per-session via `setMythMakingEnabled`.
 */
const MYTH_MAKING_ENABLED_DEFAULT = flagDefaultOn("ORWELL_MYTH_MAKING");

/**
 * 0101 (#1401) — whether the AI SHOWRUNNER runs by DEFAULT. ON unless `ORWELL_SHOWRUNNER=0` (or the diagnostic `ORWELL_FLAGS_OFF=1`). A DEDICATED
 * flag (sibling to `ORWELL_MYTH_MAKING`/`ORWELL_SECRET_PACING`) so calibration neutrality is provable in
 * isolation: with it unset, `showrunnerTick` no-ops before composing anything (no note is stored) and
 * `scheduleStoryThreads` sees no note ⇒ it iterates in the unchanged derive order at the unchanged
 * `THREAD.surfaceProb` ⇒ the seeded `juryReach`/gradient/UAT spine is byte-identical to today. The
 * showrunner is doubly-neutral BY CONSTRUCTION: it composes on a PURE scoring pass (no rng at all) and the
 * scheduler it biases runs entirely on per-thread SIDE rngs (keyed by thread id, never the shared stream),
 * so even the layer ON cannot perturb any competition/vote/eligibility roll. The calibration/UAT harness
 * never sets it; the live deploy may. A test overrides per-session via `setShowrunnerEnabled`.
 */
const SHOWRUNNER_ENABLED_DEFAULT = flagDefaultOn("ORWELL_SHOWRUNNER");

/**
 * 0101/#1401 Phase-2 (#1455) — whether the OUTCOME-AFFECTING showrunner REWEIGHT runs by DEFAULT. OFF
 * unless `ORWELL_SHOWRUNNER_REWEIGHT=1`. A DEDICATED sub-flag, DISTINCT from the Phase-1 `ORWELL_SHOWRUNNER`
 * above, because — unlike Phase-1 (which only routes an emphasized surfaced thread's belief to the player,
 * fold-free) — the reweight RE-ORDERS which simmering thread wins the scheduler's SCARCE per-tick slot, and
 * a thread's activate/surface/resolve transitions FOLD hidden relationship weights that feed the
 * competition/vote spine. So it necessarily PERTURBS the seeded outcome stream and CANNOT be
 * outcome-neutral by construction — which is exactly why it ships behind its own flag, gated by the
 * calibration heavy-sims (juryReach / gradient / UAT run ON) rather than an on/off SHA256 identity.
 *
 * WITH IT UNSET (the default), `scheduleStoryThreads` never re-orders (it iterates the unchanged derive
 * order) ⇒ the seeded `juryReach`/gradient/UAT spine is BYTE-IDENTICAL to today AND to Phase-1 (proven by
 * `showrunnerReweight.test.ts`'s off-vs-today SHA256, on top of the still-green `showrunnerOutcomeNeutral`).
 * The reweight IMPLIES note composition (you cannot re-weight without a note): when ON it composes notes
 * itself, so `ORWELL_SHOWRUNNER_REWEIGHT=1` alone yields the full arc-pacing showrunner. Read once at
 * module load (like the sibling flags), with a PROCESS-GLOBAL static override (mirroring `secretPacing` /
 * `seededTieSurfacing`) so the calibration ON-run flips it once for every session it plays.
 */
const SHOWRUNNER_REWEIGHT_ENABLED_DEFAULT = process.env.ORWELL_SHOWRUNNER_REWEIGHT === "1";

/**
 * 0099 (hidden half) — whether the off-screen NPC↔NPC SECRET BARTER runs by DEFAULT. ON unless
 * `ORWELL_SECRET_BARTER=0` (or the diagnostic `ORWELL_FLAGS_OFF=1`). A DEDICATED flag (sibling to `ORWELL_JURY_HOUSE`/`ORWELL_MYTH_MAKING`) so
 * calibration neutrality is provable in isolation: with it unset, `secretBarterTick` returns before
 * drawing anything (the dedicated barter-rng stream never advances) and no secret changes hands ⇒ the
 * seeded `juryReach`/gradient/UAT spine is byte-identical to today. The calibration/UAT harness never
 * sets it; the live deploy may. Read once at module load (like the sibling flags); a test overrides
 * per-session via `setSecretBarterEnabled`.
 */
const SECRET_BARTER_ENABLED_DEFAULT = flagDefaultOn("ORWELL_SECRET_BARTER");

/**
 * Issue #1397 — whether CHARACTER-MEDIATED gossip drift runs by DEFAULT. ON unless `ORWELL_GOSSIP_DRIFT=0` (or the diagnostic `ORWELL_FLAGS_OFF=1`).
 * A DEDICATED flag (sibling of `ORWELL_MYTH_MAKING`) so calibration neutrality is provable in isolation:
 * with it unset the orchestrator passes NO `voiceOf` to `diffuseGossip`, so the gossip distortion stays
 * personality-AGNOSTIC — byte-identical to the pre-feature drift, and the seeded juryReach/gradient/UAT
 * spine is unchanged. Read once at module load (like the sibling flags); a test overrides per-session via
 * `setGossipDriftEnabled`. (Drift is re-weighted on a per-hop FORK regardless, so even ON the parent
 * competition/vote/jury draw stream is byte-identical — the flag gates only whether VOICE colors the drift.)
 */
const GOSSIP_DRIFT_ENABLED_DEFAULT = flagDefaultOn("ORWELL_GOSSIP_DRIFT");

/**
 * 0066 Phase-2 (#1125) — the three sleep-economy EXTENSIONS, each behind its OWN dedicated flag
 * (sibling to `ORWELL_CAMPAIGNS`/`ORWELL_TRAJECTORIES`/`ORWELL_JURY_HOUSE`), independently toggleable so
 * calibration neutrality is provable for EACH in isolation (the brief: "each behind its own flag,
 * byte-identical when off"). **All three now default ON** (opt-out via `=0`: items 1–2 per the 2026-07-12
 * owner ruling that a real playtest needs them live, item 3 per the 2026-11-05 PO ruling "if it's built,
 * turn it on"); see each item's own annotation below for the authoritative polarity. All three only mean anything while the master clock is
 * running (`ORWELL_TIME_OF_DAY`); each gates ON TOP of it, and when its own flag is off its effect is the
 * identity (scale 1 / meter 0 / no extra advance) ⇒ every seeded gate (juryReach/gradient/UAT) is
 * BYTE-IDENTICAL regardless of any of the three (the calibration/UAT harness leaves `ORWELL_TIME_OF_DAY`
 * off). None adds a draw to ANY rng — the social-fatigue + multi-night terms are pure functions of
 * already-decided state (no side-stream needed; the main competition/vote/jury stream is never
 * re-phased). A test flips each per-session.
 *
 *  1. `ORWELL_TIME_PER_CONVERSATION` — the per-conversation clock advance (the day's finite scheming time,
 *     felt turn-by-turn). Pacing-only; never rushes an engaged scene (clamps at late-night, never wraps).
 *     **Default ON** (set `=0` to disable): without it the clock only lurches on ceremony beats (~3h each),
 *     so the player's social play costs zero in-game time and a day collapses into a handful of beats — the
 *     "fast-forward" playtest bug. It rides the MASTER clock (`timeOfDayEnabled`), so the seeded sims (which
 *     leave `ORWELL_TIME_OF_DAY` off) never advance it ⇒ byte-identical calibration regardless of this flag.
 *  2. `ORWELL_SOCIAL_FATIGUE` — a tired houseguest sways the house LESS next day + a conflict drains them
 *     to an earlier bedtime (social, not just comps). **Default ON** (set `=0` to disable) — see the
 *     per-flag comment above its const below.
 *  3. `ORWELL_MULTI_NIGHT_FATIGUE` — the compounding multi-night fatigue meter (consecutive late nights
 *     stack a deeper deficit; rested nights recover). **Default ON** (set `=0` to disable) — flipped
 *     2026-11-05 (PO: "if it's built, turn it on").
 */
// Default ON — a real playtest runs the master clock (the FE flips `time_of_day_enabled` on at boot), and
// with per-conversation advance OFF the day had no in-fiction time between ceremonies (the fast-forward
// bug). `=0` is the escape hatch. Still self-gated on `timeOfDayEnabled`, so the clock-off sims are byte-identical.
const PER_CONVERSATION_CLOCK_ENABLED_DEFAULT = process.env.ORWELL_TIME_PER_CONVERSATION !== "0";
// Default ON — sleep cost must reach social play, not just competitions. When tired, warming folds are
// dampened (harder to bond/scheme) and souring folds are amplified (spats cut deeper) — an asymmetric bias
// toward negative consequence (owner ruling 2026-07-12). `=0` is the escape hatch. Self-gated on
// `timeOfDayEnabled`, so the clock-off calibration sims stay byte-identical.
const SOCIAL_FATIGUE_ENABLED_DEFAULT = process.env.ORWELL_SOCIAL_FATIGUE !== "0";
const MULTI_NIGHT_FATIGUE_ENABLED_DEFAULT = flagDefaultOn("ORWELL_MULTI_NIGHT_FATIGUE");
/**
 * #1793 — the Player Dossier grouping player diary-room reads per subject (houseguest).
 * ON unless `ORWELL_PLAYER_DOSSIER=0` (or the diagnostic `ORWELL_FLAGS_OFF=1`). OFF ⇒ byte-identical: no `playerDossier` field on the view.
 */
const PLAYER_DOSSIER_ENABLED_DEFAULT = flagDefaultOn("ORWELL_PLAYER_DOSSIER");

/**
 * #1800 — whether the Booth Has Receipts (deterministic player-record contradiction extraction) runs
 * by DEFAULT. ON unless `ORWELL_BOOTH_RECEIPTS=0` (or the diagnostic `ORWELL_FLAGS_OFF=1`). Flag-gated so a disabled flag means
 * `playerReceipts()` returns [] immediately — byte-identical to not having the method at all.
 * A test overrides per-session via `setBoothReceiptsEnabled`.
 */
const BOOTH_RECEIPTS_ENABLED_DEFAULT = flagDefaultOn("ORWELL_BOOTH_RECEIPTS");

/**
 * NPC deal CONSENT (anti-sycophancy) - before a player-proposed deal is recorded the ENGINE decides whether the NPC agrees, from the NPC's own reads (`dealConsent.ts`).
 * ON unless `ORWELL_NPC_DEAL_CONSENT=0` (or the diagnostic `ORWELL_FLAGS_OFF=1`). OFF => `makeDeal` records every valid deal exactly as before (byte-identical).
 */
const NPC_DEAL_CONSENT_ENABLED_DEFAULT = flagDefaultOn("ORWELL_NPC_DEAL_CONSENT");

/**
 * T0-2 ("beats terminate themselves", moonshot P1 stage 1 / #27a) — the CLOSED-SET ceremony/comp
 * pending kinds whose resolution deterministically implies further server-side progress, so
 * `submitDecision` auto-advances ONE more beat step in the SAME committed transaction instead of
 * leaving the loop sitting at "resolved, but nothing moved" until a separate `advanceGame` call
 * arrives. This is the exact class of pending the weekly ceremony loop raises for itself (HOH →
 * nominations → veto → veto ceremony → eviction) — every option is engine-enumerated and legality-
 * checked, there is no free-text/expressive content to capture, and the natural next step is either
 * another closed-set fact (a day-break, a chip draw, a ballot reveal) or a new pending that would be
 * reached on the very next `advanceGame` call regardless.
 *
 * DELIBERATELY EXCLUDED (kept at CURRENT semantics — resolving them does NOT auto-advance):
 *   - `goodbye-message`, `exit-interview` — the player's OWN expressive content (E34/0130); the
 *     engine never authors it and never rushes past it to the next stage on the player's behalf.
 *   - `finale-statement`, `finale-answer`, `juror-question`, `juror-vote` — the interactive finale
 *     (0037) is paced deliberately, one reveal/question at a time, for the format's suspense.
 *   - `self-evict` — an OOC player-level confirmation, not a ceremony beat.
 *   - `secret-veto` — a player STRATEGY choice (play/hold a one-time safety) with real stakes,
 *     paced like the other exposed twists rather than folded away invisibly.
 *   - `deal-offer` — an NPC-initiated SOCIAL approach (0123), not a weekly-loop ceremony fact.
 *
 * `comp-intent`/`comp-round` are listed for completeness/documentation even though their own
 * `applyDecision` case ALREADY re-enters `resolveHohBeat`/`resolveVetoComp` internally (staged-round
 * resume) — auto-advancing after them is a harmless, already-covered no-op most of the time (see
 * `advanceOneBeat`'s own `pending` guard).
 */
const AUTO_ADVANCE_PENDING_KINDS: ReadonlySet<PendingDecisionView["kind"]> = new Set([
  "nominations", "veto-decision", "comp-intent", "comp-round", "houseguests-choice",
  "replacement", "tie-break", "final-eviction",
  // "eviction-vote" is DELIBERATELY NOT here (PO ruling 2026-11-04, the one-turn vote reveal): the vote's own apply already reads EVERY ballot in one
  // beat, and the RESULT must be a separate, VISIBLE beat (its `eviction` event + chyron reach the client from the next advance). Chaining it here
  // would commit the evictee silently inside the submit and drop its announcement.
]);

/**
 * Engine-side implementation of the Vault-free game-session port. It runs the
 * OOBE (the one human-authored profile) and holds the active house, then projects
 * it to a Vault-free view: the player's own authored card plus a name-only house
 * roster — NO stats, NO souls, NO archetypes, NO hidden attributes cross the wall.
 *
 * Lives on the ENGINE side (like `EngineCommandsAdapter`); the outward MCP server
 * depends on the `GameSession` port, never on this class or the prompt module.
 */
/**
 * #1793 — Group the player's own diary-room/subject-tagged knowledge facts per houseguest.
 * Reads ONLY the player's NO_NPC_PATHWAY knowledge facts that have a `subject` field,
 * groups them by subject into Record<EntityId, { content: string; ts: number }[]>,
 * sorted within each group by ts (oldest first — insertion order).
 * NEVER reads engine truth, Vault, or NPC knowledge.
 */
function groupPlayerDossier(
  playerKnowledge: readonly { content: string; pathway?: string; subject?: EntityId; ts?: number }[]
): Record<EntityId, { content: string; ts: number }[]> {
  const grouped: Record<EntityId, { content: string; ts: number }[]> = {};
  for (const k of playerKnowledge) {
    if (k.pathway !== 'diary-room') continue;
    if (k.subject === undefined) continue;
    const entry = { content: k.content, ts: k.ts ?? 0 };
    if (!grouped[k.subject]) grouped[k.subject] = [];
    grouped[k.subject].push(entry);
  }
  // Sort each group by ts (oldest first)
  for (const subject of Object.keys(grouped)) {
    grouped[subject].sort((a, b) => a.ts - b.ts);
  }
  return grouped;
}

export class GameSessionAdapter implements GameSession {
  private house: GameHouse | null = null;
  /**
   * R3 — per-houseguest cache for the append-only soul arrays the snapshot export deep-clones every
   * turn (`memory`/`emotionalHistory`). Both are append-only (every off-screen scene pushes a note; the
   * arc samples grow each tick) — the ONLY in-place memory write is `replaceMemoryNote`, which now swaps
   * the array reference so this `(ref,len)`-keyed cache invalidates. Keyed by houseguest id, each entry
   * holds the LIVE source array ref + length + the produced clone. On the next export an UNCHANGED soul
   * (same ref, same length) reuses its clone by reference — O(1) — so the export re-clones only the
   * handful of souls actually touched that turn instead of every soul's full history (audit R3). The
   * cached clone is never mutated (a grown source rebuilds a NEW array), so a baseline snapshot that
   * still references the old clone keeps its point-in-time length — the non-degradation check stays
   * exact. Cleared on `restore` (the live houseguest objects are replaced wholesale).
   */
  private readonly soulCloneCache = new Map<EntityId, {
    memSrc: readonly string[]; memLen: number; memClone: string[];
    histSrc: readonly number[]; histLen: number; histClone: number[];
  }>();
  private week = 0;
  private phase = "setup";
  /**
   * The casting interview's incremental intake (0050). OOBE is no longer atomic: the producer
   * records answers as they land (`updateCasting`), this accumulates them pre-game, and
   * `createCharacter` finalizes FROM it. Snapshot-durable so a half-done interview survives a
   * restart (0030); cleared once the season starts.
   */
  private intake: CastingIntake = emptyIntake();
  // Public ceremony state for the status panel (0020). Vault-free: ids → public names only.
  private ceremony: CeremonyState = { nominees: [], vetoUsed: false };
  /**
   * The monotonic per-sandbox beat counter (feature 0065 Part A). Bumped exactly ONCE per committed
   * state mutation by the registry's commit funnel (`bumpBeatSeq`, called before the candidate
   * snapshot is exported), so it increments by one per beat / aux commit and stays stable on a no-op
   * (a no-op never fires `onPersist`). Persisted in the snapshot (restart-safe; co-versioned with the
   * save). Surfaced on every read/advance view; a mutating call may carry `expectedBeatSeq` and is
   * refused (`stale-beat`/409) when it no longer matches. A rolled-back commit restores the pre-commit
   * value through `restore` (the baseline snapshot carries it). NOT secret — a counter has no Vault
   * content, so it crosses the wall freely.
   */
  private beatSeq = 0;
  /**
   * The at-most-once idempotency cache (feature 0065 Part B) — a small bounded per-sandbox LRU
   * `idempotencyKey → AdvanceView` for `advanceGame`/`submitDecision`. A repeated key returns the
   * ORIGINAL view (its `beatSeq` included) WITHOUT advancing again, so a flaky-socket retry never
   * double-applies. Best-effort + in-memory (a restart drops it and degrades safely — Part A's
   * `expectedBeatSeq` still guards a double-apply); insertion-ordered so the oldest evicts first.
   */
  private readonly idempotencyCache = new Map<string, AdvanceView>();
  private static readonly IDEMPOTENCY_CACHE_MAX = 32;
  /**
   * T0-3 (issue #1778) — the STABLE, NEVER-REUSED per-sandbox announcement-id counter. Persisted
   * (unlike `announcementLog`/`pendingAnnouncements` below) so an id is never reused even across a
   * restart — the FE's per-id dedup (F4: a chyron renders exactly once) would otherwise be able to
   * collide a post-restart fact against a pre-restart id. Bumped once per emitted announcement.
   */
  private announcementSeq = 0;
  /**
   * T0-3 — the announcement(s) `commit()` just produced for the CURRENT mutation, read (and the array
   * reference kept) by `advanceView()` when it builds `AdvanceView.announcements`, then cleared. Each
   * `beatSeq` here is provisional (captured pre-bump, like `out.beatSeq` — see `inOneCommit`'s doc
   * comment) and corrected IN PLACE by `inOneCommit`'s post-persist patch, which also flushes these
   * same object references into `announcementLog` below — so the corrected value is visible from
   * BOTH the returned `AdvanceView` and the delta-catch-up log without a second pass.
   */
  private pendingAnnouncements: BeatAnnouncementView[] = [];
  /**
   * T0-3 — a bounded, IN-MEMORY-ONLY ring of recently-committed announcements, sliced by `stateDelta`
   * for a reconnecting/second window's catch-up (`StateDeltaView.announcements`). Deliberately NOT
   * persisted: `beatCheckpoints` (the ring it is indexed against) is ALSO cleared on every restore
   * (`seedDeltaBaseline`'s doc comment) — any token from before a restart already forces a full
   * refresh, so an empty post-restart log is exactly as consistent as the existing `events` delta
   * already is. The underlying facts are never lost (they're durable, ordinary `EventStore` events
   * via `onEvent`, same as always) — this is a presentation-layer catch-up convenience only.
   */
  private readonly announcementLog: BeatAnnouncementView[] = [];
  private static readonly ANNOUNCEMENT_LOG_MAX = 200;
  /**
   * A10 / #591 / R1c — the at-most-once ledger for the FOLD-BEARING PLAYER LEVERS `makeDeal` / `confide`
   * / `exposeSecret` / `tradeSecret` (the `recordInteraction` siblings, `EngineCommandsAdapter`'s
   * `recordIdempotency` mirrored on this port). Each of these RECORDS/creates state AND folds a hidden
   * relationship-layer impact, so — exactly like `recordInteraction` — the FE's stale-409 re-drive under
   * sustained two-window concurrency (two turns draining the SAME deferred fold, each carrying a valid,
   * freshly-reconciled CAS token) can DOUBLE-apply: CAS alone cannot stop it. A caller-minted
   * `idempotencyKey` does — a repeat key returns the prior result WITHOUT re-folding, checked BEFORE the
   * CAS guard so a duplicate is a no-op SUCCESS regardless of how far the board has since moved. Keyed by
   * a LEVER-NAMESPACED key (`foldLedgerKey`: `${verb}:${idempotencyKey}`) → the verb's prior return value
   * (heterogeneous, so `unknown` + a cast at the call site, mirroring the `AdvanceView`/`eventId`
   * siblings). The namespace is load-bearing: the ledger is SHARED across the four levers, so the same key
   * reused across two different verbs would otherwise return one's cached result under another's type AND
   * skip its own mutation (a cross-lever collision). Bounded LRU, in-memory per-sandbox and
   * Vault-free — NOT persisted (like `recordIdempotency`, and unlike the `advanceGame` progression cache):
   * the retry window is seconds and a restart drops the FE's in-flight deferred queue, so there is nothing
   * to dedup across one. Absent key ⇒ every call folds (byte-identical to the pre-key path).
   */
  private readonly foldIdempotency = new Map<string, unknown>();
  private static readonly FOLD_IDEMPOTENCY_MAX = 256;
  // The incremental weekly-loop state (0011); null until a game starts.
  private live: LiveSeasonState | null = null;
  /** Save-on-mutation hook (0030); the registry wires it to persist the user's snapshot. */
  private onPersist?: () => void;
  /**
   * R-BND (#628): the BACKGROUND persist hook for fail-soft FE-driven write-backs (0062 zeitgeist,
   * 0070 off-screen texture). These enrich PROSE only (no closed-set board change), so they must NOT
   * route through the commit funnel — that would bump the `beatSeq` the FE reconciles on and make a
   * background enrichment look like a board mutation (a phantom single-tab stale-409, the A-S3 fold-
   * drop). The registry wires this to invalidate the snapshot cache + blind-save (the next-season-warm
   * precedent), persisting durably WITHOUT a beat bump or integrity checkpoint. Absent on a standalone
   * adapter ⇒ the write-backs fall back to the ordinary `persist()` (still correct; just no game loop).
   */
  private onBackgroundPersist?: () => void;
  /** Beat-event sink (wired by the registry to record player-witnessed events into the EventStore). */
  private onEvent?: (ev: BeatEvent) => void;
  /** Tracked promises (0039). Player-party deals only here; NPC↔NPC deals live off-screen in the Vault. */
  private readonly deals = new DealLedger();
  /** 0107 — live NAMED alliances (engine-only, Vault-sealed). Empty unless the player/NPCs name one ⇒ the
   *  cement provider returns 0 for every pair ⇒ the seeded bloc/vote spine is byte-identical. */
  private readonly alliances = new AllianceStore();
  /**
   * Live NPC CAMPAIGNS (0085) — persistent strategic agendas. ENGINE-ONLY hidden strategy (targets/
   * plans/progress + the per-perspective `knownTo`): it never crosses any outward seam. Phase A holds
   * the field + persistence plumbing; Phase B populates it from the off-screen tick + feeds the tilt.
   */
  private campaigns: Campaign[] = [];
  /**
   * 0085 Phase B2 — whether the live campaign layer RUNS. DEFAULT OFF: the calibration/UAT harness
   * composes its runtime without enabling it, so every seeded gate (juryReach/gradient/UAT) is
   * BYTE-IDENTICAL; the live deploy enables it via `composeRuntime({ campaigns: true })`. When off,
   * no campaign forms/advances and `ctx().campaignTiltFor` is absent ⇒ the seeded vote is unchanged.
   */
  private campaignsEnabled = CAMPAIGNS_ENABLED_DEFAULT;
  /** B5 / #2017 - vote counting: an evict campaign forms only while the actor believes the count is IN DOUBT (`voteEstimate.ts`). OFF unless exactly `ORWELL_VOTE_COUNT=1`; never-flipped. OFF => no gate => byte-identical. */
  private voteCountEnabled = flagDefaultOn("ORWELL_VOTE_COUNT");
  /** A22 - NPCs may APPROACH the player during the Day-1 social morning AFTER the toast (never during the entrances or the toast). OFF unless exactly `ORWELL_MORNING_APPROACH=1`; never-flipped. OFF => the approach gate is `started` only, byte-identical. */
  private morningApproachEnabled = flagDefaultOn("ORWELL_MORNING_APPROACH");
  setMorningApproachEnabled(on: boolean): void { this.morningApproachEnabled = on; }
  /** A22 - the premiere is fully over (entrances done or never staged, the champagne toast released): the Day-1 social morning, where an NPC's own wants may bring them to the player. */
  private premiereSocialOpen(): boolean {
    const live = this.live;
    if (!live) return false;
    const entrancesOver = !live.premiereEntrance || live.premiereEntrance.stage === "done";
    return entrancesOver && live.champagneCircle !== "gathered"; // the circle is cleared once released
  }
  /** B10 / B11 slice 3 - information spreads only by co-presence, by the holder's choice. OFF unless exactly `ORWELL_GOSSIP_COPRESENCE=1`; never-flipped. The told ledger is engine-private (ids only; persisted in the snapshot since B20 - the old note said not yet persisted: a restart re-decides, and a listener who already holds the fact is never a candidate). */
  private copresenceEnabled = flagDefaultOn("ORWELL_GOSSIP_COPRESENCE");
  private copresenceTold = new ToldLedger();
  setCopresenceEnabled(on: boolean): void { this.copresenceEnabled = on; }
  copresenceEnabledNow(): boolean { return this.copresenceEnabled; }
  copresenceToldLedger(): ToldLedger { return this.copresenceTold; }
  /** B48 - credibility memory (`credibility.ts`): how far houseguests believe a speaker's word, from the lies THEY caught. ON unless `ORWELL_CREDIBILITY=0`. */
  private credibilityEnabled = flagDefaultOn("ORWELL_CREDIBILITY");
  setCredibilityEnabled(on: boolean): void { this.credibilityEnabled = on; }
  credibilityEnabledNow(): boolean { return this.credibilityEnabled && this.npcBeliefsEnabled; }
  /**
   * B48 - how far `observer` believes `speaker` (0..1; 1 with no caught lies). Reads ONLY the observer's own `lied-to-me` claims about the speaker (a lie the observer caught: a broken assurance, a
   * refuted rumor) - never the Vault, never another holder's claims. `repeatsToListener` = lies the speaker already told this ear. Pure read: no rng, no writes.
   */
  credibilityOf(observer: EntityId, speaker: EntityId, repeatsToListener = 0): number {
    const week = this.live?.week ?? 0;
    const evidence: CaughtLie[] = [];
    for (const c of claimsOf(this.live?.beliefs, observer)) {
      if (c.kind !== "lied-to-me" || c.subject !== speaker || c.refuted || !c.value) continue;
      evidence.push({ speaker, week: c.week, severity: Math.max(0, Math.min(1, c.confidence)) });
    }
    return credibility(evidence, repeatsToListener, week);
  }
  setVoteCountEnabled(on: boolean): void { this.voteCountEnabled = on; }
  /**
   * URGENT clock-per-message (Coordinator 2026-11-05): the clock bills ONE message-step per PLAYER MESSAGE, not per committed engine mutation. The front-end announces each player message once with
   * `noteMessage({ messageId })` (idempotent per id); the announcement ITSELF steps the clock (a plain chat line commits nothing else, and an event must be able to come due mid-conversation).
   * From the first announcement on (`messageMode`) a commit bills the clock NOTHING (`billClockForCommit`) - a message that makes any number of tool calls was already billed once. Before any
   * announcement (BDD / UAT / legacy FE) billing is the old per-commit step, byte-identical. Memory-only: a restart falls back to legacy billing until the next announcement.
   */
  private messageMode = false;
  private seenMessageIds: string[] = [];
  noteMessage(req: { messageId: string }): { accepted: boolean; beatSeq: number } {
    const id = String(req.messageId);
    if (this.seenMessageIds.includes(id)) return { accepted: false, beatSeq: this.beatSeq };
    this.seenMessageIds.push(id);
    if (this.seenMessageIds.length > 256) this.seenMessageIds.shift();
    this.disclosureEpoch++; // a new player turn: last turn's disclosure events are over
    // PLAYTEST BUG: freeze WHO IS IN THE ROOM at the moment the player sends - the turn-driven tick that follows this very commit re-seats the house, and a scene recorded later in the reply must
    // not treat a houseguest who walked in AFTER the player spoke as a witness. A frozen copy; cleared if the player changes rooms; replaced by the next send.
    const nowOcc = this.witnessOccupancy();
    this.sendOccupancy = nowOcc ? new Map(nowOcc) as Occupancy : null;
    this.messageMode = true;
    this.ensurePremiereClock(); // ORW-116: a player talking during the premiere starts the clock (afternoon) - never a later jump
    if (this.live) this.live.clockInteractive = true; // ORW-116 (b): the player is really talking - from here the night is theirs (see nightHeld)
    this.hangOutSkipStepAt = undefined; // a hang-out's one-shot skip is for the legacy per-commit follow-up; every announced message bills its own step
    this.advanceClockPerConversation();
    this.persist(); // the clock moved: one persisted commit (integrity checkpoint + beatSeq), survives a reload
    return { accepted: true, beatSeq: this.beatSeq }; // post-commit token: the FE refreshes its last-seen beatSeq from it (no self-inflicted stale-beat 409)
  }
  /** The occupancy frozen at the player's last SEND (see `noteMessage`); null before any send or after the player moved rooms. Memory-only, never persisted. */
  private sendOccupancy: Occupancy | null = null;
  /**
   * The occupancy the WITNESS grounding reads for a recorded scene: the send-time roster while it still applies (the player is still in the room they sent from), else the live witness occupancy.
   * Anyone who arrived after the player spoke is placed elsewhere here, so the engine drops them as a phantom witness; anyone who was there and left still heard it.
   */
  sendTimeOccupancy(): Occupancy | null {
    const live = this.witnessOccupancy();
    const sent = this.sendOccupancy;
    if (!sent || !live || !this.house) return live;
    const me = this.house.player.id;
    if (sent.get(me) !== live.get(me)) { this.sendOccupancy = null; return live; } // the player changed rooms: the old roster is stale
    return sent;
  }
  /** True once the front-end has announced a player message (clock billing is per message from then on). */
  messageModeNow(): boolean { return this.messageMode; }
  /** The orchestrator's single clock-billing seam for a committed player turn (see `noteMessage`): legacy per-commit step until messages are announced, then nothing. */
  billClockForCommit(): void {
    if (!this.messageMode) this.advanceClockPerConversation();
    else this.hangOutSkipStepAt = undefined; // message mode: a hang-out must not leave a stale skip that makes the NEXT note bill 0
  }
  /**
   * 0006b — whether NPCs carry a derived COMPETITION INTENT. DEFAULT OFF: the calibration/UAT harness
   * never enables it, so `ctx().compIntentOf` is absent and every NPC "compete"s ⇒ every seeded gate is
   * BYTE-IDENTICAL; the live deploy enables it via `ORWELL_COMP_INTENT=1` / `setCompIntentEnabled`.
   */
  private compIntentEnabled = COMP_INTENT_ENABLED_DEFAULT;
  /**
   * 0110 — whether the eviction jury grudge folds on the evictee's DEDUCED belief. DEFAULT OFF: the
   * calibration/UAT harness never enables it, so `ctx().voteDeduction` is false and the true `votesToEvict`
   * is folded ⇒ every seeded gate is BYTE-IDENTICAL; the live deploy enables it via `ORWELL_VOTE_DEDUCTION=1`.
   */
  private voteDeductionEnabled = VOTE_DEDUCTION_ENABLED_DEFAULT;
  /**
   * #2017 S0a — record NPC belief claims (`beliefStore.ts`): data model + plumbing only, read by nothing. ON unless `ORWELL_NPC_BELIEFS=0` (or
   * `ORWELL_FLAGS_OFF=1`) - flipped ON 2026-11-04 (PO: Ryne, "turn it on") after the PO bands held. Off ⇒ no store is created and the season
   * state is byte-identical; on, it only mirrors values the engine already computed (no rng), so it is calibration-neutral either way.
   */
  private npcBeliefsEnabled = flagDefaultOn("ORWELL_NPC_BELIEFS");
  /**
   * B2 / #2017 — read the 0024 NPC memory ON ITS OWN (no edge-carry subtraction) so a remembered betrayal/favor VISIBLY sways nominations and votes (PO ruling 2026-11-03). ON unless
   * `ORWELL_NPC_MEMORY_STANDALONE=0` (flipped ON with the memories, #2059; the 3-arm PO bands held). OFF ⇒ the
   * residual-floor read, byte-identical; it only matters while `ORWELL_NPC_MEMORY` is on (no memory is written otherwise).
   */
  private npcMemoryStandaloneEnabled = NPC_MEMORY_STANDALONE_ENABLED_DEFAULT;
  /**
   * B2 follow-on — WRITE the memories a season actually produces (an NPC remembers being nominated by the HOH, graded by prior trust). The ledger was measured ~empty (all `veto-saved`
   * with holder===subject, dropped). DEFAULT-ON since 2026-11-04 with the standalone read (3-arm PO bands held); `=0` / `ORWELL_FLAGS_OFF=1` opts out. Only matters while `ORWELL_NPC_MEMORY` is on. OFF ⇒ no new entry.
   */
  private npcMemoryWritersEnabled = NPC_MEMORY_WRITERS_ENABLED_DEFAULT;
  /**
   * B3 / #2017 — the HOH's nomination reads their BELIEF about who is targeting them (`targets-me` claims, derived from the campaigns they are AWARE of — sometimes misattributed —
   * and from betrayal rumors they heard), instead of re-reading the edge. ON unless `ORWELL_NPC_BELIEF_NOMS=0` (needs `ORWELL_NPC_BELIEFS`); flipped ON 2026-11-04 (PO: Ryne, "turn it on"). OFF ⇒ no ctx provider,
   * no claim written ⇒ byte-identical. The writer draws only from a DEDICATED seeded rng (never the shared stream).
   */
  private npcBeliefNomsEnabled = flagDefaultOn("ORWELL_NPC_BELIEF_NOMS");
  /** B6 / #2017 - NPC-to-NPC lobbying of the HOH: a bounded pitch tilt in the nomination score. OFF unless exactly `ORWELL_LOBBYING=1`; never-flipped. OFF => no ctx provider => byte-identical. */
  private lobbyingEnabled = flagDefaultOn("ORWELL_LOBBYING");
  setLobbyingEnabled(on: boolean): void { this.lobbyingEnabled = on; }
  /**
   * B6 slice 2 - the pitch tilt for `subject` in `holder`'s (the HOH's) nomination score. Pitches are derived ON DEMAND, deterministically, from the live edges (no rng, no stored state): every
   * other awake NPC the HOH reads as a threat has a stake and pitches for their own safety, with the offer their personality picks (`chooseOffer`) and a strength equal to how threatened they are;
   * the HOH weighs each by how much it trusts the pitcher. Capped by `LOBBY.maxTilt`. Recording each pitch as a hidden event, minting NPC deals and surfacing via pathways are later slices.
   */
  pitchTiltFor(subject: EntityId, holder: EntityId): number {
    if (!this.lobbyingEnabled || !this.house || holder === PLAYER) return 0;
    return pitchTilt(subject, this.derivePitches(holder), (p) => Math.max(0, Math.min(1, this.rel.edge(holder, p).trust)));
  }
  /** B6/B38 - the pitches `holder` (the HOH) faces, derived deterministically from the live edges (no rng, no stored state). Shared by the nomination tilt and the pitch-event recorder, so what is RECORDED is exactly what is WEIGHED. */
  private derivePitches(holder: EntityId): Pitch[] {
    if (!this.house) return [];
    const evicted = new Set(this.live?.evictionOrder ?? []);
    const awake = this.awakeNow();
    const pitches: Pitch[] = [];
    for (const npc of this.house.npcs) {
      const id = npc.id;
      if (id === holder || evicted.has(id) || (awake && !awake.has(id))) continue;
      const threat = Math.max(0, Math.min(1, this.rel.edge(holder, id).threat));
      if (threat <= 0) continue;
      const loyalty = Math.max(0, Math.min(1, derivedLoyalty(this.dispositionReadOf(id), this.emotionalReadOf(id))));
      const cunning = Math.max(0, Math.min(1, npc.character.stats.mental));
      pitches.push({ from: id, kind: chooseOffer({ loyalty, cunning, chaos: 1 - loyalty }), strength: threat, protects: id });
    }
    return pitches;
  }
  /**
   * B38 (ORWELL_LOBBYING, slice 3) - make the pitches REAL EVENTS. Once per HOH crowning (the week), each pitch the new HOH faces is recorded as an event whose witness set is the pitcher, the HOH and
   * whoever is genuinely co-present; it is HIDDEN (Vault-held) unless the player is in that set, so a pitch the player did not witness never reaches them except through a pathway (gossip, a confidant). A
   * safety pitch from someone the HOH trusts enough also seals an NPC-NPC safety deal (the existing deal store; bounded, once per pair). No lobby log is ever projected; the content is a vague paraphrase. Idempotent per
   * (week, HOH). Flag off => returns before anything.
   */
  private recordLobbyPitches(hoh: EntityId): void {
    const s = this.live;
    if (!this.lobbyingEnabled || !s || !this.house || !this.onPlayerEvent || hoh === PLAYER) return;
    const key = `${s.week}:${hoh}`;
    if (this.lobbyRecordedFor.has(key)) return;
    this.lobbyRecordedFor.add(key);
    for (const p of this.derivePitches(hoh)) {
      const witnesses = [...new Set([p.from, hoh, ...this.coPresentWitnessesOf(p.from)])];
      const verb = p.kind === "safety" ? "asks for safety" : p.kind === "info" ? "trades information" : p.kind === "threat" ? "makes a veiled threat" : "makes a pitch";
      this.onPlayerEvent(`${this.nameOf(p.from)} ${verb} with ${this.nameOf(hoh)} before nominations (week ${weekWords(s.week)})`, witnesses, "lobbying");
      const trust = this.rel.edge(hoh, p.from).trust;
      if (p.kind === "safety" && trust >= DECISION.npcDeal.mutualTrustMin && !this.deals.open().some((d) => d.parties.includes(p.from) && d.parties.includes(hoh))) {
        const evId = this.onPlayerEvent(`${this.nameOf(p.from)} and ${this.nameOf(hoh)} quietly seal a safety pact (week ${weekWords(s.week)})`, [p.from, hoh], "deal");
        this.deals.make([p.from, hoh], "safety", "a quiet pact sealed away from the cameras", evId, s.week);
      }
    }
  }
  /** B38: the (week:HOH) crownings whose pitches are already recorded. Session-local: a restart mid-week may re-record once, which is idempotent for deals (bound-pair check) and only repeats a hidden line. */
  private lobbyRecordedFor = new Set<string>();

  /** B4 - record casual assurances (`assurances.ts`) on recorded scenes. OFF unless exactly `ORWELL_ASSURANCES=1`; never-flipped. OFF => no ledger on the live state => byte-identical. */
  private assurancesEnabled = flagDefaultOn("ORWELL_ASSURANCES");
  setAssurancesEnabled(on: boolean): void { this.assurancesEnabled = on; }
  /**
   * B4 slice 3 - does `holder` KEEP an open casual assurance (safe|loyal) made to `target`? Self-interested and personality-scaled (`decideKeep`): the benefit of breaking is how threatening
   * the assured reads to the holder; the cost is the holder's keepWeight (loyalty, aggression) x the assurance's sincerity. Deterministic, no rng. Flag off / none open => false.
   */
  assuranceProtects(target: EntityId, holder: EntityId): boolean {
    if (!this.assurancesEnabled || !this.live?.assurances) return false;
    const open = AssuranceLedger.fromJSON(this.live.assurances).openFor(holder).filter((a) => a.to === target && (a.kind === "safe" || a.kind === "loyal"));
    if (open.length === 0) return false;
    const stats = this.house?.npcs.find((n) => n.id === holder)?.character.stats;
    const loyalty = Math.max(0, Math.min(1, derivedLoyalty(this.dispositionReadOf(holder), this.emotionalReadOf(holder))));
    const aggression = stats ? Math.max(0, Math.min(1, 1 - stats.social)) : 0.5;
    const keepWeight = assuranceKeepWeight({ loyalty, aggression });
    const breakBenefit = Math.max(0, Math.min(1, this.rel.edge(holder, target).threat));
    return open.every((a) => decideKeep({ keepWeight, sincerity: a.sincerity, breakBenefit }));
  }

  /** B4 slice 4 - the eviction-vote shield `voter` owes nominee `n` from a KEPT 'vote'/'safe' assurance (0 when none, a strategic lie, or the voter decides to break it). Half a deal's honor weight. */
  assuranceVoteFor(n: EntityId, voter: EntityId): number {
    if (!this.assurancesEnabled || !this.live?.assurances) return 0;
    const open = AssuranceLedger.fromJSON(this.live.assurances).openFor(voter).filter((a) => a.to === n && (a.kind === "vote" || a.kind === "safe"));
    if (open.length === 0) return 0;
    const stats = this.house?.npcs.find((x) => x.id === voter)?.character.stats;
    const loyalty = Math.max(0, Math.min(1, derivedLoyalty(this.dispositionReadOf(voter), this.emotionalReadOf(voter))));
    const keepWeight = assuranceKeepWeight({ loyalty, aggression: stats ? Math.max(0, Math.min(1, 1 - stats.social)) : 0.5 });
    const breakBenefit = Math.max(0, Math.min(1, this.rel.edge(voter, n).threat));
    return open.every((a) => decideKeep({ keepWeight, sincerity: a.sincerity, breakBenefit })) ? 0.5 * DECISION.vote.dealHonorWeight : 0;
  }

  /** B4 slice 4 - `voter` voted `nominee` out: break the open assurance(s) they made to them (once) and the assured remembers. */
  assuranceVotedOut(voter: EntityId, nominee: EntityId, sealedAmong?: readonly EntityId[]): void { this.assuranceNominated(voter, nominee, sealedAmong); }

  /** B4 slice 3 - the HOH nominated an assured houseguest: resolve the open assurance(s) BROKEN (once) and the assured remembers it (a smaller grudge than a broken deal). */
  assuranceNominated(holder: EntityId, nominee: EntityId, sealedAmong?: readonly EntityId[]): void {
    if (!this.assurancesEnabled || !this.live?.assurances) return;
    const ledger = AssuranceLedger.fromJSON(this.live.assurances);
    let broke = false;
    const witnesses: EntityId[] = [];
    for (const a of ledger.openFor(holder).filter((x) => x.to === nominee)) { if (ledger.resolve(a.id, "broken")) { broke = true; witnesses.push(...(a.heardBy ?? [])); } }
    if (!broke) return;
    this.live.assurances = ledger.toJSON();
    if (sealedAmong) {
      // ORW-15 / E12 / #1963: an eviction ballot is SECRET, so a broken assurance must not single out the voter. The engine truth (the ledger) resolves BROKEN, but what the assured carries is shared across every
      // voter who could have cast it (the real breaker is one of them and carries only its share): a smaller deal-broken memory and trust drop each, NO named lied-to-me claim and NO witness fold (a witness
      // who learned the breaker would deanonymize the ballot). HOH tie-break (a public act) takes the attributed path below.
      const pool = [...new Set([...sealedAmong, holder])].filter((id) => id !== nominee).sort();
      for (const s of pool) this.remember(nominee, s, "deal-broken", ASSURANCE.brokenMemorySeverity / pool.length);
      if (nominee !== PLAYER) for (const s of pool) { const e = this.rel.edge(nominee, s); e.trust = Math.max(0, e.trust - ASSURANCE.brokenTrustDrop / pool.length); }
      return;
    }
    this.remember(nominee, holder, "deal-broken", ASSURANCE.brokenMemorySeverity);
    this.rememberAsWitnesses(witnesses, holder, "deal-broken", ASSURANCE.brokenMemorySeverity, nominee);
    // B4 slice 5: the break also costs the assurer the assured's TRUST (smaller than a deal break; rng-free, clamped >= 0) and, with the belief layer on, the assured now believes the assurer lied
    // to them (engine-only claim, voiced only BY that holder). Never for a player-assured party: nothing acts on the player's hidden read (the #1963 rule).
    if (nominee !== PLAYER) {
      const e = this.rel.edge(nominee, holder);
      e.trust = Math.max(0, e.trust - ASSURANCE.brokenTrustDrop);
      if (this.npcBeliefsEnabled) recordClaim((this.live.beliefs ??= {}), { holder: nominee, kind: "lied-to-me", subject: holder, value: true, origin: "witnessed", confidence: 0.8, week: this.live.week });
    }
  }

  /** B22 - houseguests who merely HEARD a promise remember its keeping / breaking too, at `ASSURANCE.witnessFactor` of the assured's own weight (the assured and the assurer themselves are not witnesses). OFF unless exactly `ORWELL_MEMORY_PROMISES=1`; never-flipped. */
  private memoryPromisesEnabled = flagDefaultOn("ORWELL_MEMORY_PROMISES");
  setMemoryPromisesEnabled(on: boolean): void { this.memoryPromisesEnabled = on; }

  /**
   * B23 / #2017 14.5(3) - LIES CAUGHT. When a lie is exposed the houseguest it was told to holds a `lied-to-me` belief claim (engine-only, voiced only BY that holder), at the confidence of the evidence
   * that exposed it; a bluff a houseguest BELIEVED is stored as a belief too (a low-confidence `heard-rumor`, nature "bluff") and marked refuted once caught. Writers: the passive lie-catch
   * (`catchPlayerBluff`) and a landed `accuseTie`. No rng, no edge fold; absent a belief layer nothing is written. OFF unless exactly `ORWELL_LIES_CAUGHT=1`; never-flipped. OFF => byte-identical.
   */
  private liesCaughtEnabled = flagDefaultOn("ORWELL_LIES_CAUGHT");
  setLiesCaughtEnabled(on: boolean): void { this.liesCaughtEnabled = on; }
  private get liesCaughtWriting(): boolean { return this.liesCaughtEnabled && this.npcBeliefsEnabled && !!this.live; }
  /** The believed-bluff belief id for (holder, subject): its own id (never the gossip rumor's) so catching it can refute exactly this claim. */
  private bluffBeliefId(holder: EntityId, subject: EntityId, week: number): string { return `${holder}|heard-rumor|${subject}|bluff:${PLAYER}|${week}`; }
  /** `holder` was lied to by `liar`, caught with evidence of the given confidence. Never for the player as holder (nothing acts on the player's hidden read). */
  private writeLieCaught(holder: EntityId, liar: EntityId, confidence: number, origin: "witnessed" | "told"): void {
    if (!this.liesCaughtWriting || holder === PLAYER) return;
    recordClaim((this.live!.beliefs ??= {}), { holder, kind: "lied-to-me", subject: liar, value: true, origin, confidence: Math.max(0, Math.min(1, confidence)), week: this.live!.week });
  }
  /**
   * B24 / #2017 14.5(5) - HEARD-ABOUT-ME. What a houseguest is TOLD about the player in a recorded chat scene is a belief they hold (engine-only, voiced only BY that holder), at the TELLER's reliability (the
   * listener's trust in them, plus a word-keeper bonus), and sometimes wrong by construction: a dedicated seeded roll (bounded, less likely the more reliable the teller) makes the listener mishear it onto a
   * different houseguest. No edge fold, no memory entry, no shared rng; absent a belief layer nothing is written. OFF unless exactly `ORWELL_HEARD_ABOUT_ME=1`; never-flipped. OFF => byte-identical.
   */
  private heardAboutMeEnabled = flagDefaultOn("ORWELL_HEARD_ABOUT_ME");
  setHeardAboutMeEnabled(on: boolean): void { this.heardAboutMeEnabled = on; }
  recordHeardAboutMe(h: { teller: EntityId; listeners: readonly EntityId[]; nature: HeardNature }): void {
    if (!this.heardAboutMeEnabled || !this.npcBeliefsEnabled || !this.live || !isHeardNature(h.nature)) return;
    const living = this.livingIds();
    if (h.teller === PLAYER || !living.includes(h.teller)) return;
    const live = this.live;
    const credited = (id: EntityId): boolean => this.reliabilityReader?.(id).has(h.teller) ?? false;
    for (const listener of new Set(h.listeners)) {
      if (listener === PLAYER || listener === h.teller || !living.includes(listener)) continue;
      const reliability = tellerReliability(this.rel.edge(listener, h.teller).trust, credited(listener));
      const rng = new SeededRandom(hashSeed(`${this.gameSeed ?? 0}:heard-about-me:${live.week}:${h.teller}:${listener}:${h.nature}`));
      const pool = living.filter((id) => id !== PLAYER && id !== listener && id !== h.teller);
      const subject = isMisheard(rng.next(), reliability) && pool.length > 0 ? pool[Math.floor(rng.next() * pool.length)]! : PLAYER;
      const confidence = heardConfidence(reliability);
      const store = (live.beliefs ??= {});
      if (h.nature === "targeting") {
        recordClaim(store, { id: `${listener}|targets-me|${subject}|told:${h.teller}|${live.week}`, holder: listener, kind: "targets-me", subject, object: listener, value: true, origin: "told", source: h.teller, confidence, week: live.week });
      } else {
        recordClaim(store, { id: `${listener}|heard-rumor|${subject}|told:${h.teller}|${live.week}`, holder: listener, kind: "heard-rumor", subject, value: true, origin: "told", nature: "betrayal", source: h.teller, confidence, week: live.week });
      }
    }
  }
  private rememberAsWitnesses(witnesses: readonly EntityId[], about: EntityId, kind: "deal-kept" | "deal-broken", severity: number, assured: EntityId): void {
    if (!this.memoryPromisesEnabled) return;
    for (const w of new Set(witnesses)) if (w !== about && w !== assured) this.remember(w, about, kind, severity * ASSURANCE.witnessFactor);
  }
  /** B4 slice 8 - resolve every OPEN assurance matching `match` as KEPT (once each) and the assured remembers a (weaker-than-a-grudge) favor. Flag off / none open => nothing. */
  private keepAssurances(match: (a: Assurance) => boolean, sealedAmong?: readonly EntityId[]): void {
    if (!this.assurancesEnabled || !this.live?.assurances) return;
    const ledger = AssuranceLedger.fromJSON(this.live.assurances);
    const kept: Assurance[] = [];
    for (const a of ledger.all.filter((x) => x.status === "open" && match(x))) if (ledger.resolve(a.id, "kept")) kept.push(a);
    if (kept.length === 0) return;
    this.live.assurances = ledger.toJSON();
    for (const a of kept) {
      const holder = a.from, to = a.to;
      if (sealedAmong) {
        // ORW-15 / E12: keeping at the SEALED ballot (voting the other nominee out) must not tell the assured who voted; the favor is shared across every voter who could have cast it, with no witness fold and no
        // rumored-break claim naming the keeper.
        const pool = [...new Set([...sealedAmong, holder])].filter((id) => id !== to).sort();
        for (const s of pool) this.remember(to, s, "deal-kept", ASSURANCE.keptMemorySeverity / pool.length);
        continue;
      }
      // B39: sometimes the assured WRONGLY believes a kept assurance was broken (a rumor - wrong by construction). The engine's truth stays "kept"; only the assured's belief is false: a low-confidence
      // `lied-to-me` claim instead of the favor, from a DEDICATED seeded roll. Needs the belief layer; never for a player-assured party (nothing acts on the player's hidden read).
      if (to !== PLAYER && this.npcBeliefsEnabled && isRumoredBreak(new SeededRandom(hashSeed(`${this.gameSeed ?? 0}:asr-rumor:${this.live.week}:${holder}:${to}`)).next())) {
        recordClaim((this.live.beliefs ??= {}), { holder: to, kind: "lied-to-me", subject: holder, value: true, origin: "gossip", nature: "rumored-break", confidence: ASSURANCE.rumoredBreakConfidence, week: this.live.week });
        continue;
      }
      this.remember(to, holder, "deal-kept", ASSURANCE.keptMemorySeverity);
      this.rememberAsWitnesses(a.heardBy ?? [], holder, "deal-kept", ASSURANCE.keptMemorySeverity, to);
    }
  }
  /** B4 slice 8 - the HOH finalized nominations without the houseguests they had assured 'loyal': kept. ('safe' is NOT resolved here: the veto and the replacement can still put the assured on the block, so it is settled at the vote tally.) */
  assuranceKeptAtNominations(holder: EntityId, nominees: readonly EntityId[]): void {
    this.keepAssurances((a) => a.from === holder && a.kind === "loyal" && !nominees.includes(a.to));
  }
  /** B4 slice 8 - `voter` voted the other nominee out and so spared `spared`: an open 'vote'/'safe' assurance to them was KEPT. */
  assuranceKeptAtVote(voter: EntityId, spared: EntityId, sealedAmong?: readonly EntityId[]): void {
    this.keepAssurances((a) => a.from === voter && (a.kind === "vote" || a.kind === "safe") && a.to === spared, sealedAmong);
  }
  /** B4 slice 8 - the eviction nominees are FINAL (after the veto and any replacement): every open 'safe' assurance whose assured is not on the block was kept. */
  assuranceKeptAtTally(finalNominees: readonly EntityId[]): void {
    this.keepAssurances((a) => a.kind === "safe" && !finalNominees.includes(a.to));
  }

  /** B4 - append one recorded assurance to the live ledger (persisted with the season). */
  recordAssurance(a: { from: EntityId; to: EntityId; kind: "safe" | "vote" | "loyal"; sincerity: number; source: "player" | "npc"; heardBy?: EntityId[] }): void {
    if (!this.assurancesEnabled || !this.live) return;
    const ledger = AssuranceLedger.fromJSON(this.live.assurances ?? { seq: 0, items: [] });
    // B4 slice 7: an NPC's sincerity is the ENGINE's call (loyalty + a dedicated seeded roll), never the model's proposal; the player's own stays as recorded.
    let sincerity = a.sincerity;
    if (a.source === "npc") {
      const loyalty = Math.max(0, Math.min(1, derivedLoyalty(this.dispositionReadOf(a.from), this.emotionalReadOf(a.from))));
      // Review lead 5: a repeat same-kind assurance (same week, from, to) used to get the SAME roll; the 2nd, 3rd... salt the seed with how many already stand (the first keeps its exact seed).
      const prior = ledger.all.filter((x) => x.week === this.live!.week && x.from === a.from && x.to === a.to && x.kind === a.kind).length;
      const roll = new SeededRandom(hashSeed(`${this.gameSeed ?? 0}:asr-sincere:${this.live.week}:${a.from}:${a.to}:${a.kind}${prior > 0 ? `:${prior}` : ""}`)).next();
      sincerity = npcAssuranceSincerity(loyalty, roll);
    }
    const { heardBy, ...rest } = a;
    ledger.add({ ...rest, sincerity, week: this.live.week, ...(this.memoryPromisesEnabled && heardBy && heardBy.length > 0 ? { heardBy: [...heardBy] } : {}) });
    this.live.assurances = ledger.toJSON();
  }
  /** The DEDICATED campaign rng tick counter — campaign draws fork off the game seed + this, never the
   * shared society/vote stream (the L21/L24 isolation), so even live campaigns don't re-phase calibration. */
  private campaignTickCount = 0;
  /**
   * Phase 2 of "the player can play offense" (0085 follow-on) — the DEDICATED rng draw counter for the
   * player's OWN campaign moves (`foldPlayerCampaignMove`), forked off the game seed exactly like
   * `campaignTickCount` — never the shared society/vote stream, so the player's offense never re-phases
   * calibration. Monotonic (++ only); tracked in `SessionCoreCounts` for the non-degradation checkpoint.
   */
  private playerCampaignMoveCount = 0;
  /**
   * Phase 2 — the BEAT the player's own campaign last earned progress (throttle: at most one
   * progress-earning pitch per beat, the SAME cadence an NPC's own campaign advances at — listing many
   * holders in one scene grows `knownTo` for each but earns no extra speed). `null` before any pitch.
   */
  private playerCampaignProgressBeat: number | null = null;
  /**
   * 0100 — whether the JURY-HOUSE grudge layer RUNS. DEFAULT OFF: the calibration/UAT harness leaves it
   * off, so with it unset NO jury-house stretch runs, NO draw is taken, and NO grudge is applied ⇒ every
   * seeded gate (juryReach/gradient/UAT) is BYTE-IDENTICAL; the live deploy enables it. A test flips it
   * via `setJuryHouseEnabled`.
   */
  private juryHouseEnabled = JURY_HOUSE_ENABLED_DEFAULT;
  /**
   * 0066 Phase-2 (#1125) — the three sleep-economy extension flags, each DEFAULT ON (its dedicated env
   * default; `=0` disables) and each self-gated: when off, its effect is the identity so the seeded calibration spine is
   * BYTE-IDENTICAL (proven per-extension by the dedicated neutrality tests). All three also require the
   * master clock (`timeOfDayEnabled`). A test flips each via its `set*Enabled` setter.
   *   1. per-conversation clock advance · 2. NPC next-day social fatigue · 3. compounding multi-night meter.
   */
  private perConversationClockEnabled = PER_CONVERSATION_CLOCK_ENABLED_DEFAULT;
  private socialFatigueEnabled = SOCIAL_FATIGUE_ENABLED_DEFAULT;
  private multiNightFatigueEnabled = MULTI_NIGHT_FATIGUE_ENABLED_DEFAULT;
  /**
   * Feature #1400 — generative competition design. DEFAULT OFF (its `ORWELL_GEN_COMPETITIONS` env
   * default): when off, `competitionStagingView` returns null and `recordCompetitionFiction` refuses, so
   * NO fiction is ever authored/stored ⇒ the deterministic 0042 library floor stands, byte-identical to
   * the pre-feature model (the `genCompetitionNeutral` proof pins it). Flipped by a test's setter (below).
   */
  private genCompetitionsEnabled = genCompetitionsEnvDefault();
  /** The DEDICATED jury-house rng tick counter — jury-house draws fork off the game seed + this, NEVER the
   * orchestrator's shared society/competition/vote stream, so even with the layer ON the main house's seeded
   * outcomes stay in phase (only the hidden finale lean changes). Persisted so the stream is restart-stable. */
  private juryHouseTickCount = 0;
  /** 0100 limbo — NPC evictions the jury house has processed (one stretch per arrival). `null` = not yet
   *  known (a fresh game, or a pre-limbo save): derived on the first tick. Persisted as `juryHouseArrivals`. */
  private juryHouseArrivals: number | null = null;
  /**
   * 0101 — whether NPC MYTH-MAKING runs. DEFAULT OFF: the calibration/UAT harness never enables it, so
   * with it unset `legendTick` draws nothing and mints no legend ⇒ every seeded gate (juryReach/gradient/
   * UAT) is BYTE-IDENTICAL; the live deploy may enable it. A test flips it via `setMythMakingEnabled`.
   */
  private mythMakingEnabled = MYTH_MAKING_ENABLED_DEFAULT;
  /** Issue #1397 — whether the RETELLER's public voice colors gossip drift (character-mediated distortion).
   *  ON by default (2026-11 flip); the orchestrator reads this to decide whether to hand `diffuseGossip` a `voiceOf`. */
  private gossipDriftEnabled = GOSSIP_DRIFT_ENABLED_DEFAULT;
  /** The DEDICATED legend-rng tick counter — legend draws fork off the game seed + this, NEVER the
   *  orchestrator's shared society/competition/vote stream (the same isolation `juryHouseTickCount`
   *  uses), so even with the layer ON the main house's seeded outcomes stay in phase. Persisted so the
   *  stream is restart-stable. */
  private legendTickCount = 0;
  /** The per-season HARD CAP on legends minted (0101, sibling of `surfacedThreadCount`) — monotonic. */
  private legendCount = 0;
  /** The watermark — the highest consumed notable-act's `GameEvent.ts` — so a used act is never
   *  re-selected into a second legend (0101). Monotonic (non-decreasing). */
  private legendLastActTick = 0;
  /**
   * 0101 (#1401) — the AI SHOWRUNNER. `showrunnerEnabled` gates the whole layer (DEFAULT OFF ⇒
   * calibration byte-identical). `showrunnerNotes` is the Vault-held, APPEND-ONLY production bible (one
   * note per (week, phase) beat — the once-per-beat dedupe mirrors the scheduler's own cadence);
   * `showrunnerNoteCount` is its monotonic per-season count (a `SessionCoreCounts` dimension). Both reset
   * only at a season boundary. ENGINE-ONLY / Vault-held — a note reaches NO player/admin projection and
   * unseals only in the 0048 retrospective. NB: a note is composed on a PURE pass (no rng) and consumed by
   * the scheduler's own side rngs, so the shared society/competition/vote stream is untouched ON or OFF. */
  private showrunnerEnabled = SHOWRUNNER_ENABLED_DEFAULT;
  private showrunnerNotes: ShowrunnerNote[] = [];
  private showrunnerNoteCount = 0;
  /**
   * 0101/#1401 Phase-2 (#1455) — the monotonic per-season count of off-screen ticks on which the reweight
   * actually RE-ORDERED the scheduler (the producer's shortlist genuinely jumped a thread ahead of the
   * derive order). A `SessionCoreCounts` dimension (++-only, reset only at a season boundary), so the ON
   * calibration run can prove the layer is non-vacuous and the non-degradation checkpoint keeps it durable.
   * Stays 0 whenever the reweight sub-flag is off ⇒ byte-shaped like a pre-Phase-2 save. */
  private showrunnerReweightCount = 0;
  /**
   * 0099 (hidden half) — whether the off-screen NPC↔NPC SECRET BARTER runs. DEFAULT OFF: the
   * calibration/UAT harness never enables it, so with it unset `secretBarterTick` returns before drawing
   * anything and no secret changes hands ⇒ every seeded gate (juryReach/gradient/UAT) is BYTE-IDENTICAL;
   * the live deploy may enable it. A test flips it via `setSecretBarterEnabled`.
   */
  private secretBarterEnabled = SECRET_BARTER_ENABLED_DEFAULT;
  /** The DEDICATED secret-barter rng tick counter — barter draws fork off the game seed + this, NEVER the
   *  orchestrator's shared society/competition/vote stream (the same isolation `legendTickCount` uses), so
   *  even with the layer ON the main house's seeded outcomes stay in phase. Persisted so the stream is
   *  restart-stable. */
  private secretBarterTickCount = 0;
  /** The monotonic count of secrets SPENT into the hidden economy this season (0099, sibling of
   *  `legendCount`/`tradeCount`) — the knowledge layer only deepens as secrets change hands (++ only). */
  private secretBarterCount = 0;
  /**
   * 0086 — every active houseguest's current DRIVE (motivation + intensity), keyed by id. Computed each
   * campaignTick (sticky — carried from the prior tick), engine-only + Vault-sealed, never projected. The
   * loudest promote to campaigns; the quiet `target` ones add only a small own-ballot lean to their owner's
   * vote. Empty unless the campaign layer is enabled ⇒ no drives ⇒ no lean ⇒ calibration byte-identical.
   */
  private drives: Map<EntityId, Drive> = new Map();
  /**
   * 0096 — the emergent NEMESIS bookkeeping: at most one NPC elevated into a felt recurring antagonist
   * by a SUSTAINED (not spike) threat-toward-player read + a sticky `target`-the-player drive. Derived
   * each `campaignTick` (after drives, `selectNemesis`) from signals the campaign layer already computes
   * — no new hidden attribute. Engine-only + Vault-sealed (never on any player OR admin projection except
   * the Vault-safe `rivalry` tone hint on `npcVoice`). Empty unless the campaign layer is enabled ⇒ no
   * nemesis ⇒ no bias ⇒ calibration byte-identical.
   */
  private nemesisTrack: NemesisTrack = NO_NEMESIS;
  /**
   * 0087 — whether the RELATIONSHIP-TRAJECTORY layer RUNS. DEFAULT OFF (the dedicated `ORWELL_TRAJECTORIES`
   * flag): when off, no momentum is computed, the off-screen tick passes no `trajectoryOf` ⇒ `natureWeights`
   * is the identity, and every seeded gate is BYTE-IDENTICAL (the calibration-neutrality guarantee). Per
   * instance; a test flips it via `setTrajectoriesEnabled`.
   */
  private trajectoriesEnabled = TRAJECTORIES_ENABLED_DEFAULT;
  /** 0120 — strategic-drive initiator cadence (off ⇒ uniform off-screen initiator draw, byte-identical). */
  private strategicCadenceEnabled = STRATEGIC_CADENCE_ENABLED_DEFAULT;
  /** Wave-2 — off-screen scheming names a real target (off ⇒ no target clause; byte-identical hidden content). */
  private schemeTargetsEnabled = SCHEME_TARGETS_ENABLED_DEFAULT;
  /** 0121 — deal-depth layer (active-obligation kinds + reliability rewards); off ⇒ 0039/0109 exactly. */
  private dealDepthEnabled = DEAL_DEPTH_ENABLED_DEFAULT;
  private npcMemoryEnabled = NPC_MEMORY_ENABLED_DEFAULT;
  /** 0121 R1 — seed a diffusing "keeps their word" reputation when a deal is kept (registry-wired; it holds
   *  the KnowledgeService `reconcileDeals` does not). Unset (standalone) ⇒ no reputation ⇒ byte-identical. */
  private dealReputationSink?: (honorer: EntityId, other: EntityId) => void;
  /** 0121 R1 — the Vault-free reliability-reputation READER (registry-wired from the KnowledgeService): for a
   *  holder, the set of honorer ids they believe "keep their word" (the diffusing `reliable:<honorer>` belief
   *  lineage). A knowledge-layer read, NEVER a Vault read. Unset (a bare adapter) ⇒ no reputation is read ⇒ no
   *  deal-willingness lean, so `mintNpcDeal` is byte-identical. */
  private reliabilityReader?: (holder: EntityId) => ReadonlySet<EntityId>;
  /** 0122 — deeper+daily NPC confessionals (triggered facets + the day-close sweep); off ⇒ 0040 exactly. */
  private compThemesEnabled = COMP_THEMES_ENABLED_DEFAULT;

  /**
   * #1790 — whether the TRAITORS'-FURY juror-bearing word layer RUNS. DEFAULT OFF: the
   * calibration/UAT harness leaves it off, so `bearingWord` returns a constant ("settled")
   * and the seeded jury-read spine is byte-identical. A test flips it via `setTraitorsFuryEnabled`.
   */
  private traitorsFuryEnabled = TRAITORS_FURY_ENABLED_DEFAULT;
  /** #1792 — whether the Producer Read (post-scene exchange-accounting beat) runs. ON by default (2026-11 flip). */
  private producerReadEnabled = PRODUCER_READ_ENABLED_DEFAULT;
  /** #1802 — whether formation-witness deal collateral is active (ORWELL_DEAL_WITNESSES). */
  private dealsWitnessesEnabled = DEALS_WITNESSES_ENABLED_DEFAULT;
  /** #1800 — whether the Booth Has Receipts runs (deterministic player-contradiction extraction). OFF by default. */
  private boothReceiptsEnabled = BOOTH_RECEIPTS_ENABLED_DEFAULT;
  private npcDealConsentEnabled = NPC_DEAL_CONSENT_ENABLED_DEFAULT;
  /** #1793 — the Player Dossier read (ORWELL_PLAYER_DOSSIER); per-instance so the prompt + tool follow it. */
  private playerDossierEnabled = PLAYER_DOSSIER_ENABLED_DEFAULT;
  private compMechanicsPlusEnabled = COMP_MECHANICS_PLUS_ENABLED_DEFAULT;

  private compMixedEnabled = COMP_MIXED_ENABLED_DEFAULT;
  /** C1 (#1788) — the Wipeout Reel presentation layer; off ⇒ `comp-elimination` content is untouched. */
  private wipeoutReelEnabled = WIPEOUT_REEL_ENABLED_DEFAULT;
  private premiereEntrancesEnabled = PREMIERE_ENTRANCES_ENABLED_DEFAULT;
  private finalHohThreePartEnabled = FINAL_HOH_THREE_PART_ENABLED_DEFAULT;
  private jurorProfilesEnabled = JUROR_PROFILES_ENABLED_DEFAULT;
  private hangOutEnabled = HANGOUT_ENABLED_DEFAULT;
  /** A65 (ORWELL_ADVANCE_GATE, default OFF): an ordinary `advanceGame` before the next milestone is due returns a typed `held` and commits nothing. Engine-internal fast-forwards (admin `advanceToFinale`) bypass it. */
  private advanceGateEnabled = process.env.ORWELL_ADVANCE_GATE === "1";
  setAdvanceGateEnabled(on: boolean): void { this.advanceGateEnabled = on; }
  private scheduleGateBypass = false;
  private desireClockEnabled = DESIRE_CLOCK_ENABLED_DEFAULT;
  private wantMovementEnabled = WANT_MOVEMENT_ENABLED_DEFAULT;
  /** The clock hour a hang-out just ended at: the orchestrator's follow-up per-conversation step skips ONCE if the clock has not moved since. */
  private hangOutSkipStepAt: number | undefined;
  /** Hours the last hang-out spent (consumed by the orchestrator to run extra society ticks). */
  private hangOutPendingHours = 0;

  private confessionalDepthEnabled = CONFESSIONAL_DEPTH_ENABLED_DEFAULT;
  /** 0123 — NPC-initiated deal offers to the player; off ⇒ no offer/pending/fold ever (byte-identical). */
  private npcDealOffersEnabled = NPC_DEAL_OFFERS_ENABLED_DEFAULT;
  /** 0124 — deeper character evolution (multi-axis affect + temperament drift + tuned reactivity); off ⇒ 0041 exactly. */
  private soulDepthEnabled = SOUL_DEPTH_ENABLED_DEFAULT;
  /** 0122 — the last in-game day the daily confessional sweep ran, so it fires at most once per day. */
  private lastConfessionalSweepDay = 0;
  /**
   * 0087 — the hidden MOMENTUM per directed pair, keyed `a->b`. VAULT-CLASS hidden engine state (mandate
   * #2): it appears on NO player- or admin-facing projection — it reaches the player only as the KINDS of
   * off-screen scenes the arc produces (overheard/told). Persisted in the snapshot so an arc resumes
   * mid-curdle (0007/0030); absent on a pre-0087 save ⇒ every pair resumes at `steady`/0.
   */
  private trajectories: Map<string, Trajectory> = new Map();
  /**
   * 0087 — the tiny per-pair ring buffer of recent FOLD signals (the last `recencyWindow`), from which
   * `deriveTrajectory` reads the arc's current direction. Engine-only; Vault-free (each entry is a signed
   * bond/threat DELTA + a betrayal flag derived from the scene's nature, never a raw edge number). Persisted
   * beside `trajectories` so a restored game derives the same phase; absent on a pre-0087 save ⇒ empty.
   */
  private trajectoryFolds: Map<string, FoldSignal[]> = new Map();
  /** Records a one-off witnessed event (deal made/broken) and returns its id. Wired by the registry. */
  private onPlayerEvent?: (content: string, witnessSet: EntityId[], type?: string) => string | undefined;
  /** Optional narrator for the snarky tagline (0033); none ⇒ the curated state-aware fallback. */
  private narrator?: NarrativePort;
  /**
   * ENGINE-ONLY dynamic soul (0024) wired into the LIVE sandbox (the 0041 linchpin). When present,
   * consequential beats + off-screen scenes `recordToSoul` so each NPC's arc deepens and their voice
   * can be grounded by `recall`. Optional — standalone adapters (onboarding/tests) still evolve the
   * house's emotional state (modulating competitions) without the recall index.
   */
  private soul?: SoulProvider;
  /** Per-moment tagline cache (regenerate when week/phase/standing changes, not per page load). */
  private readonly taglineCache = new Map<string, string>();
  /**
   * Who is in which room (0049) — every ACTIVE houseguest, exactly one room; the evicted are
   * NOWHERE. Seeded at game start, re-assigned by the off-screen tick (`presenceTick`); grounds
   * witnessing, overhearing, and the player's `whereabouts()` read.
   */
  private presence: Map<EntityId, Room> | null = null;
  /**
   * Room TENURE (L21/L24) — consecutive presence ticks each houseguest has held their CURRENT room
   * (0 = moved this tick). Bumped/reset in `presenceTick` alongside `presence`; grounds scene
   * continuity in `whereabouts()` so the narrator voices who has lingered vs. who just arrived.
   */
  private presenceTenure: Map<EntityId, number> | null = null;
  /**
   * The CALIBRATION-NEUTRAL base occupancy (L21/L24). The off-screen society pairs co-present NPCs to
   * generate hidden scenes whose relationship folds feed (downstream) nominations/votes — so the
   * society's occupancy is calibration-LOAD-BEARING. To keep the seeded competition/vote outcomes
   * BYTE-IDENTICAL to the pre-personality build, the society reads THIS base assignment (the un-weighted
   * 0049 movement, exactly as before L21/L24) via `societyOccupancy()`, while the player-facing positions
   * (`this.presence`, used by `whereabouts`/witnessing) carry the personality-weighted result. The two
   * differ only in WHICH room NPCs roam to — the player never observes the hidden society's pairing, so
   * there is no observable contradiction (one place at a time still holds for everything the player sees).
   */
  private presenceBase: Map<EntityId, Room> | null = null;
  /**
   * The presence-tick COUNTER (L21/L24 isolation). Movement randomness rides a DEDICATED stream forked
   * off the game seed + this counter (`presenceTick`) — never the orchestrator's shared per-user stream
   * that drives the off-screen society + relationship folds + votes — so personality-weighted movement
   * can never perturb the seeded competition/vote calibration (`tests/property/juryReach`). Persisted, so
   * the movement trajectory stays reproducible across a restart. Advances ONCE per `presenceTick`.
   */
  private presenceTickCount = 0;
  /** B28: monotonic count of tell onsets (persisted as `tellOnsetCount`). */
  private tellOnsetCount = 0;
  /** B29 (ORWELL_TELL_REACTIONS, default OFF, never-flipped): observers react to a visible tell (comfort / exploit / avoid). Engine-only state, persisted (`tellReactions`). */
  private tellReactionsEnabled = flagDefaultOn("ORWELL_TELL_REACTIONS");
  setTellReactionsEnabled(on: boolean): void { this.tellReactionsEnabled = on; }
  /** B30 (ORWELL_MOOD_VETO / ORWELL_MOOD_APPROACH, default OFF, never-flipped; each needs ORWELL_NPC_TELLS): emotion into the veto save and into who seeks the player out. */
  private moodVetoEnabled = flagDefaultOn("ORWELL_MOOD_VETO");
  setMoodVetoEnabled(on: boolean): void { this.moodVetoEnabled = on; }
  private moodApproachEnabled = flagDefaultOn("ORWELL_MOOD_APPROACH");
  setMoodApproachEnabled(on: boolean): void { this.moodApproachEnabled = on; }
  /** B31 (ORWELL_MOOD_DEAL / ORWELL_MOOD_CAMPAIGN, default OFF, never-flipped; each needs ORWELL_NPC_TELLS): visible mood into deal consent and campaign formation. */
  private moodDealEnabled = flagDefaultOn("ORWELL_MOOD_DEAL");
  setMoodDealEnabled(on: boolean): void { this.moodDealEnabled = on; }
  private moodCampaignEnabled = flagDefaultOn("ORWELL_MOOD_CAMPAIGN");
  setMoodCampaignEnabled(on: boolean): void { this.moodCampaignEnabled = on; }
  moodDealFor(npc: EntityId, kind: string): number {
    if (!this.moodDealEnabled || !this.npcTellsEnabled || npc === PLAYER) return 0;
    return moodDealTerm(this.soulObj(npc)?.tells, kind);
  }
  moodSteady(npc: EntityId): boolean {
    if (!this.moodCampaignEnabled || !this.npcTellsEnabled) return true;
    return !moodUnsteady(this.soulObj(npc)?.tells);
  }
  /** B51 (ORWELL_DRIVE_DECISIONS, default OFF, never-flipped; needs campaigns on): the HOH's / veto holder's OWN drive feeds their nomination and veto-save scores. */
  private driveDecisionsEnabled = flagDefaultOn("ORWELL_DRIVE_DECISIONS");
  setDriveDecisionsEnabled(on: boolean): void { this.driveDecisionsEnabled = on; }
  drivePushForDecider(target: EntityId, decider: EntityId): number {
    if (!this.driveDecisionsEnabled || !this.campaignsEnabled || decider === PLAYER || target === decider) return 0;
    const own = this.campaigns.find((c) => c.status === "active" && c.owners.includes(decider) && c.target === target);
    return drivePushFor(this.drives.get(decider), target, own ? { goal: own.goal, progress: own.progress } : undefined);
  }
  moodVetoFor(nominee: EntityId, holder: EntityId): number {
    if (!this.moodVetoEnabled || !this.npcTellsEnabled || holder === PLAYER) return 0;
    const e = this.rel.edge(holder, nominee);
    return moodVetoTerm(this.soulObj(holder)?.tells, (e.trust + e.affinity) / 2);
  }
  moodApproachFor(npc: EntityId): number {
    if (!this.moodApproachEnabled || !this.npcTellsEnabled || npc === PLAYER) return 0;
    return moodApproachTerm(this.soulObj(npc)?.tells);
  }
  /** "holder|subject" -> the holder's decaying exploit tilt toward the visibly rattled subject. */
  private tellExploit: Record<string, number> = {};
  /** "observer|target" -> the week the observer last reacted to that target (the per-pair cooldown). */
  private tellReactedWeek: Record<string, number> = {};
  /** Reaction counts by kind (observability + tests; monotonic). */
  private tellReactionCounts: Record<string, number> = {};
  /** Monotonic count of observer-reaction passes: keys the dedicated stream so each pass draws fresh, reproducibly (persisted). */
  private tellReactionTicks = 0;
  tellReactionCountsNow(): Readonly<Record<string, number>> { return { ...this.tellReactionCounts }; }
  /** B29: the exploit tilt `holder` carries toward `subject` (0 when none / flag off). Bounded by `TELL_REACTION.exploitCap`. */
  private moodTiltFor(subject: EntityId, holder: EntityId): number {
    return this.tellExploit[`${holder}|${subject}`] ?? 0;
  }
  /**
   * B29 - one observer-reaction pass, driven by the orchestrator's per-turn off-screen tick. For every houseguest who is VISIBLY rattled (a persisted tell from B28) and shares a room with an awake NPC
   * observer, the observer may react (comfort / exploit / avoid) - chosen by the observer's strategy style, disposition and bond to the target, drawn from a DEDICATED stream, once per pair per week.
   * Comfort lowers the target's distress a little and builds their trust in the observer; exploit adds a small decaying tilt read by the nomination/vote providers; avoid is recorded (no effect yet).
   * Observability gate = the existing co-presence (ADR 0019): only the same room. Flag off => returns before anything (zero draws, nothing written).
   */
  tellReactionsTick(): void {
    if (!this.tellReactionsEnabled || !this.npcTellsEnabled || !this.house || !this.presence) return;
    for (const k of Object.keys(this.tellExploit)) { const v = decayExploit(this.tellExploit[k]!); if (v > 0) this.tellExploit[k] = v; else delete this.tellExploit[k]; }
    const awake = this.awakeNow();
    const week = this.week;
    this.tellReactionTicks += 1;
    const rng = new SeededRandom(hashSeed(`${this.gameSeed ?? 0}:tell-react:${this.tellReactionTicks}:${week}`));
    const npcs = this.house.npcs.map((n) => n.id).filter((id) => this.livingIds().includes(id) && (!awake || awake.has(id)));
    for (const target of npcs) {
      const so = this.soulObj(target);
      const tell = so?.tells?.find((t) => TELL_REACTION.rattled.includes(t.kind)); // the first VISIBLY RATTLED tell (a restless or giddy one invites no reaction)
      if (!so || !tell) continue;
      const room = this.presence.get(target);
      if (room === undefined) continue;
      for (const observer of npcs) {
        if (observer === target || this.presence.get(observer) !== room) continue;
        const key = `${observer}|${target}`;
        const roll = rng.next(); // one draw per (target, observer) pair in a fixed order => reproducible regardless of the cooldown
        if ((this.tellReactedWeek[key] ?? -99) > week - TELL_REACTION.cooldownWeeks) continue;
        const e = this.rel.edge(observer, target);
        const hg = this.house.npcs.find((n) => n.id === observer);
        const reaction = chooseTellReaction({
          tell: { kind: tell.kind, band: tell.band }, bond: (e.trust + e.affinity) / 2,
          style: hg?.character.strategyStyle, disposition: this.baselineDispositionOf(observer), roll,
        });
        if (!reaction) continue;
        this.tellReactedWeek[key] = week;
        this.tellReactionCounts[reaction] = (this.tellReactionCounts[reaction] ?? 0) + 1;
        if (reaction === "comfort") {
          if (typeof so.distress === "number") so.distress = Math.max(0, so.distress - TELL_REACTION.comfortDistress);
          this.rel.applyImpactDirected(target, observer, { trust: TELL_REACTION.comfortTrust }, rng);
        } else if (reaction === "exploit") {
          const k = `${observer}|${target}`;
          this.tellExploit[k] = addExploit(this.tellExploit[k] ?? 0);
        }
      }
    }
  }
  /**
   * SEATED sub-zones (issue #792 — the PO ruling: sub-zones are SEATED into `assignRooms`, not computed
   * on-read). Each houseguest in a zoned big room (backyard/lounge) holds a per-id sub-zone here — the
   * player-facing weighted view — so a long stay can organically DRIFT corner-to-corner and two bonded
   * houseguests can CLUSTER into one corner (affinity-weighted, like the room-level clustering). Seeded
   * from the deterministic `zoneFor` on a fresh seat (the on-read helper becomes the seeding fallback),
   * then evolved on the DEDICATED movement stream (never the shared spine) so it is calibration-neutral.
   * Persisted tenure-style beside `presence` (0007 — only-forward); absent on a pre-feature save ⇒ the
   * next tick seats everyone fresh (no error). Vault-free presence projection, never Vault content.
   */
  private presenceZone: Map<EntityId, Zone> | null = null;
  /**
   * TRACKED OCCUPANCY (0077 Phase 2 — the privacy payoff): the PLAYER's beliefs about who is behind a
   * CLOSED door. NOT the live map — acquired knowledge: a sighting lands only when the player WITNESSES
   * a houseguest head into a private room (their origin was in the player's eyeshot), keyed by the
   * subject. It carries a pathway + confidence (the 0002 model applied to position), goes STALE with age
   * (NEVER read off the secret live position — that would leak that they left), decays out past the
   * horizon, and is CORRECTED early when the player next sees the subject somewhere visible. Persisted
   * (0007 — acquired knowledge accumulates), Vault-free (position, never the scene's content).
   */
  private trackedSightings: Map<EntityId, TrackedSighting> | null = null;
  /** The game's seed (B60/E12): per-moment rng keys off it — two same-named games never share streams. */
  private gameSeed: number | null = null;
  /** The per-season style anchor for portrait prompts (0051): seeded at cast time, stable through the season. */
  private portraitStyleAnchor: string | null = null;
  /**
   * The move-in zeitgeist snapshot (feature 0062): the ONE frozen, shared real-world flavor the cast
   * moved in WITH — captured once at season creation, FROZEN, persisted, and recalled all season. It
   * colors BOTH the player's moment prompts AND the off-screen society/gossip prompts (§5) and goes
   * stale as the weeks pass (§7). OUTWARD-SAFE public flavor (§6) — never a Vault handle, never a game
   * input. Null pre-game / when no snapshot was captured (the §8 fail-soft skip).
   */
  private worldSnapshot: WorldSnapshot | null = null;
  /**
   * The PRODUCER persona's seed (producer-persona feature). The producer is a REAL generated
   * character — as deep a persona as any houseguest, built by the same `CharacterFactory` machinery —
   * but OFF-CAMERA: no headshot, never one of the 16, never in the roster/portraits/whereabouts. The
   * casting interview voices it CONSISTENTLY. It must be stable BEFORE the season starts (the interview
   * is pre-game) AND through the game, so its seed is established LAZILY the first time it's needed
   * (pre-game) via real entropy, PERSISTED in the snapshot, and reused at `createCharacter`. Same seed
   * → same producer (reproducible across turns and a restart). Null until first established.
   */
  private producerSeed: number | null = null;
  /** Memoized producer for `producerSeed` + `producerProfile` (rebuilt on restore / when either changes). */
  private producerCache: Producer | null = null;
  /**
   * The AI-authored producer-DEEPENING overlay (increment 3 of #1626): an OPTIONAL Vault-free overlay
   * (backstory / temperament / disposition / wit / quirk) the FE writes back via `recordProducerProfile`
   * to enrich the seeded producer WITHOUT touching the seeded NAME (the byline stays byte-stable). It
   * ACCUMULATES (a later authoring adds fields, never loses one) and MERGES over the seeded floor
   * (`mergeProducer`), so a field the model never authored keeps its seeded value (non-degradation).
   * Persisted in the snapshot alongside `producerSeed`; null (⇒ the seeded floor stands) until authored.
   */
  private producerProfile: ProducerProfileOverlay | null = null;
  /**
   * 0070 — the additive prose texture layer: model-voiced content indexed by event id.
   * Persisted (serialized to/from `SessionCore.textureOverrides`). Absent on pre-0070 saves.
   */
  private textureOverrides: Map<string, string> = new Map();
  /**
   * 0070 — the event ids of the off-screen scenes recorded in the most recent tick, in order.
   * Used by `getOffscreenSceneSkeletons` to return a Vault-free summary. TRANSIENT (not persisted —
   * refreshed on each tick, empty between ticks). The event store remains the source of truth.
   */
  private lastTickOffscreenIds: string[] = [];

  // ─── PREMIERE meet-everyone tracker (feature #380 follow-on) — NEW BLOCK ─────────────────────────
  /**
   * The houseguests the player has been INTRODUCED to during the premiere. The STRUCTURAL guarantee
   * that every NPC is met before the first HOH does NOT rely on the model to remember (it failed — it
   * skipped people): the engine tracks who's met here, surfaces "who's left to introduce" into the
   * premiere moment prompt, and exposes a `complete` gate. The player is implicitly met (they ARE the
   * player); only NPCs accumulate here. Seeded empty at move-in; persisted (0030) so a half-done
   * premiere resumes; cleared once the premiere is over. PUBLIC ids only — no Vault data.
   */
  private premiereMet: Set<EntityId> = new Set();
  /**
   * A1 (ship-blocker, "the phantom-houseguest root") — the DURABLE, never-cleared superset of
   * `premiereMet`: every houseguest id the player has EVER been introduced to (by name, in narration
   * they witnessed) this season. Unlike `premiereMet` (vestigial-cleared once the premiere ends,
   * §above), this set is the permanent name-lock signal: `recordCastProfile`'s PUBLIC NAME acceptance
   * (below) refuses to rename any houseguest already in this set, no matter when or how many times an
   * async authoring write-back later arrives. This closes the race where deep cast-authoring
   * (`recordCastProfile`, an FE-driven write-back that can complete asynchronously — during the
   * premiere, or even later via the authoring backfill) renamed a houseguest AFTER the player had
   * already met them under the seeded floor name, so the GM appeared to "correct" the player about the
   * game's own prior words. Populated in lockstep with `premiereMet` (the same structural
   * introduction event); reset to empty at every season start alongside it. PUBLIC ids only.
   */
  private introducedNames: Set<EntityId> = new Set();
  /**
   * #1318 — the PLAYER-FORMED HOT-READ set: the subset of `premiereMet` reached through GENUINE
   * engagement (a model-driven `markHouseguestMet` the player was part of, or a recorded player↔NPC
   * scene routed through `notePremiereReads`) — NOT the FE regex name-belt, which fills `premiereMet`
   * alone. ONLY this set feeds `premiereIntros().hotReads` / `powerReachable`, so the asymmetric first-
   * power gate unlocks on real engagement, never on two names heard in a move-in narration (#1318 root).
   * Premiere-scoped exactly like `premiereMet` (cleared once the first HOH begins); persisted (0030) so a
   * half-done premiere resumes with its EARNED power state intact. PUBLIC ids only — a pure count, no Vault.
   */
  private premiereHotReads: Set<EntityId> = new Set();
  // ─────────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * The live relationship model drives NPC decisions (threat/trust). The registry
   * injects the SAME instance the consequence fold writes to, so the player's actions
   * shape how the house nominates and votes over time. Standalone (tests/onboarding)
   * it owns a fresh model — the loop still runs, just without cross-fold history.
   */
  constructor(private readonly rel: RelationshipModel = new RelationshipModel(0.5)) {}

  /** Feature 0088 — per-NPC current-read anchor bonds (Vault-only; persisted in snapshot). */
  private readAnchors = new Map<EntityId, number>();

  /**
   * Issue #1322 (P2) — the approach-rotation anti-recency cooldown: per-NPC remaining STRETCHES
   * before they are eligible to lead `socialInitiatives`'s top-3 again (persisted; see
   * `sessionSnapshot.ts`'s `approachCooldown`). PLAYER-FACING PROJECTION state only.
   */
  private approachCooldown = new Map<EntityId, number>();
  /** The stretch key the cooldown map above was last advanced for (see `advanceApproachCooldown`). */
  private approachStretchKey: string | undefined;
  /**
   * The top-3 initiators `socialInitiatives()` itself last computed, and the stretch key they were
   * computed FOR. `socialInitiatives()` is a pure, poll-safe read (the SAME stretch always
   * reproduces the SAME ranking, 0012), so the cooldown can only rotate at an ACTUAL stretch
   * transition (`syncProjection`, once per committed beat via `commit()`) — and that rotation needs
   * to know who was actually SHOWN to the player during the stretch that just ended. If the surface
   * was never read during a stretch, no one is penalized for it (correct: nothing was ever shown).
   * PERSISTED (`sessionSnapshot.ts` `approachShown` — the #1322 P1 follow-up, Greptile/PR #1335): a
   * save+restart between a read and the next committed beat previously cleared this (it was
   * ephemeral), so the transition re-armed nobody and the just-shown NPCs could lead again
   * immediately — the exact monopolization #1322 fixed, reopened through the restart door.
   */
  private lastApproachStretch: { key: string; initiators: EntityId[] } | undefined;

  /** Wire a persistence callback invoked after every mutation (durable save, 0030). */
  setOnPersist(fn: () => void): void {
    this.onPersist = fn;
  }

  /** R-BND (#628): wire the non-committing background-persist hook (durable save, no beatSeq bump). */
  setOnBackgroundPersist(fn: () => void): void {
    this.onBackgroundPersist = fn;
  }

  /**
   * R-BND (#628): persist a fail-soft FE-driven enrichment WITHOUT bumping the closed-set `beatSeq`.
   * Routes through the background hook (invalidate + blind save) when composed in the registry; falls
   * back to the ordinary `persist()` on a standalone adapter (no game loop ⇒ nothing to desync).
   */
  private backgroundPersist(): void {
    (this.onBackgroundPersist ?? this.onPersist)?.();
  }

  /**
   * The ONE restart door (audit E1/D1/R1): when composed in the registry, a CONFIRMED
   * `createCharacter` over a started game is delegated here — the registry routes it through the
   * same `resetUser` the admin reset uses (orchestrator baseline forgotten, dead season's saves
   * rotated, a clean sandbox) and season 2 is created in the fresh sandbox. Standalone adapters
   * (tests/onboarding fixtures with no registry) keep the legacy in-place restart.
   */
  private onRestart?: (req: CreateCharacterReq) => GameStateView;

  setOnRestart(fn: (req: CreateCharacterReq) => GameStateView): void {
    this.onRestart = fn;
  }

  /**
   * 0065 (advance-warm) — the NEXT-season warm delegate, wired by the registry (mirrors `onRestart`).
   * `preSeedCast` warms onto THIS adapter's pre-game store and is refused while a season runs; the
   * next-season warm must instead land in a per-user buffer that OUTLIVES the cutover rotation (this
   * adapter is discarded at reset). The registry owns that buffer + the scratch generation/authoring,
   * so the adapter just routes the call out. Absent on a standalone adapter (tests/fixtures) — there
   * the call falls back to an in-process detached generation (no buffer to survive, but fully testable).
   */
  private onNextSeasonWarm?: (req: PreSeedNextSeasonReq) => PreSeedNextSeasonView;

  setOnNextSeasonWarm(fn: (req: PreSeedNextSeasonReq) => PreSeedNextSeasonView): void {
    this.onNextSeasonWarm = fn;
  }

  /**
   * One persisted commit per player mutation (audit E3): a beat used to fire `onPersist` mid-method
   * (a broken deal inside the tally) and again at the end — and since the commit hook can SWAP the
   * sandbox on a fault, the old instance kept executing against rolled-back state. Mutations run
   * inside `inOneCommit`, which defers every interior `persist()` to a single hook call at the end;
   * a refused commit then throws OUT of the mutation (nothing narrates a beat that never happened).
   */
  private persistDepth = 0;
  private persistDeferred = false;

  private persist(): void {
    if (this.persistDepth > 0) {
      this.persistDeferred = true;
      return;
    }
    this.onPersist?.();
  }

  // Greptile P2 (issue #1725 follow-up) — constrained to `{ beatSeq: number }` (every real caller
  // already returns an `AdvanceView`, which requires it) so the compiler enforces the invariant the
  // post-commit patch below relies on, instead of a runtime duck-type check.
  private inOneCommit<T extends { beatSeq: number }>(fn: () => T): T {
    this.persistDepth++;
    let out: T;
    try {
      out = fn();
    } finally {
      this.persistDepth--;
    }
    if (this.persistDepth === 0 && this.persistDeferred) {
      this.persistDeferred = false;
      this.onPersist?.(); // may throw (a refused/failed commit) — AFTER all state mutation (E3)
      // Issue #1725 (C1) — `fn()` built `out` (and read `this.beatSeq` into it via `advanceView`)
      // BEFORE the deferred `onPersist` above ran, so `out.beatSeq` was captured PRE-commit-funnel:
      // stale by the ONE bump this very mutation just earned, and it would stay stale by any FURTHER
      // bump a supplementary off-screen tick folds into the SAME commit (`onPersist` synchronously
      // drives the registry's commit funnel → the orchestrator's turn-driven tick, all inside this
      // call, all before we reach this line). The FE caches whatever this method returns as its next
      // compare-and-swap token — a response reporting the PRE-commit counter makes the FE's own very
      // next mutation self-409 as stale, even with zero concurrency (audit finding: 5 closed-set
      // reconciliations / a false-positive desync-burst alarm in a single-window session). Patch it to
      // the counter's CURRENT (fully-committed, post-tick) value now that the whole commit has landed —
      // a VALUE correction, never a new field — and it only runs after a successful commit (a refused/
      // failed `onPersist` throws on the line above, before this runs, so `out` is never returned then).
      out.beatSeq = this.beatSeq;
      // T0-3 — the SAME staleness applies to each buffered announcement's `beatSeq` (captured in
      // `recordAnnouncements`, before this bump). `out` is not always an `AdvanceView` (other mutating
      // methods share this helper), so the announcements array is read defensively; when present, its
      // entries are the SAME object references pushed into `announcementLog`, so correcting them here
      // in place fixes both the returned view and the persisted delta-catch-up log in one pass.
      const withAnnouncements = out as { announcements?: BeatAnnouncementView[] };
      if (withAnnouncements.announcements) {
        for (const a of withAnnouncements.announcements) a.beatSeq = this.beatSeq;
      }
    }
    return out;
  }

  /** The current monotonic beat counter (0065 Part A) — surfaced on every read/advance view. */
  beatSeqNow(): number {
    return this.beatSeq;
  }

  /**
   * Bump the beat counter (0065 Part A) — the registry's commit funnel calls this exactly ONCE per
   * committed mutation, BEFORE the candidate snapshot is exported, so the new value is persisted. A
   * commit that is then refused/rolled back is restored from the baseline snapshot (which carries the
   * pre-commit value), so a refused write never leaves the counter advanced. (Bumping here, not inside
   * `persist`, keeps an interior deferred `persist` from double-counting one logical commit.)
   */
  bumpBeatSeq(): void {
    this.beatSeq++;
    this.captureBeatCheckpoint();
  }

  /**
   * 0065 Part E — seed the delta ring's BASELINE checkpoint at the CURRENT `beatSeq` (the resumed value),
   * capturing the current event-log length + board. The registry calls this once after a resume finishes
   * loading the events (`restore` clears the ring; the events arrive AFTER it), so the very FIRST delta a
   * resumed session serves — keyed on the resumed `beatSeq` — can slice its tail instead of full-refreshing
   * forever. A no-op if a checkpoint for the current beat already exists (a fresh game's first commit
   * captured it). Vault-free (ids/counts only).
   */
  seedDeltaBaseline(): void {
    if (!this.beatCheckpoints.has(this.beatSeq)) this.captureBeatCheckpoint();
  }

  /**
   * 0065 Part E — snapshot the lightweight board state AT the new `beatSeq` so the delta feed can later
   * slice the event tail (O(Δ)) and diff the ceremony WITHOUT re-deriving "what existed then". Called
   * once per committed mutation (right after the counter bumps), the events for this commit are already
   * recorded, so `count()` here is the event-log length AS OF this beat. Bounded to the last
   * `DELTA_WINDOW` beats (the oldest checkpoint evicts) so a busy season's ring stays small; a token
   * older than the retained window correctly full-refreshes. Vault-free (ids/counts only).
   */
  private captureBeatCheckpoint(): void {
    const eventCount = this.deltaSource?.count() ?? this.record?.events().length ?? 0;
    this.beatCheckpoints.set(this.beatSeq, {
      eventCount,
      // T0-3 — same timing contract as `eventCount` above: this beat's `commit()` already ran (and
      // already pushed onto `announcementLog`, if it produced any) by the time the commit funnel calls
      // this, so the captured count is "AS OF this beat" — a later `stateDelta` slices from it cleanly.
      announcementCount: this.announcementLog.length,
      week: this.week,
      phase: this.phase,
      ...(this.ceremony.hoh !== undefined ? { hoh: this.ceremony.hoh } : {}),
      nominees: [...this.ceremony.nominees],
      ...(this.ceremony.vetoHolder !== undefined ? { vetoHolder: this.ceremony.vetoHolder } : {}),
      vetoUsed: this.ceremony.vetoUsed,
      finished: !!this.live?.finished,
      ...(this.live?.winner !== undefined ? { winner: this.live.winner } : {}),
    });
    // Evict the oldest beyond the window (insertion-ordered Map ⇒ the first key is the oldest).
    while (this.beatCheckpoints.size > GameSessionAdapter.DELTA_WINDOW) {
      const oldest = this.beatCheckpoints.keys().next().value as number | undefined;
      if (oldest === undefined) break;
      this.beatCheckpoints.delete(oldest);
    }
  }

  /**
   * Compare-and-swap stale-write guard (0065 Part A). When a mutating call supplies `expectedBeatSeq`
   * and it no longer matches the committed `beatSeq`, the board moved under it (the 0064 queued-turn
   * case) — refuse BEFORE any mutation with a typed `stale-beat` conflict carrying the CURRENT counter
   * and the Vault-free current board, so the caller can re-ground immediately. `undefined` ⇒ opt out
   * (byte-identical to the pre-0065 path). The board is the same ceremony-level public status
   * `gameStatus()` exposes — no Vault content.
   */
  private guardBeatSeq(expected: number | undefined): void {
    if (expected !== undefined && expected !== this.beatSeq) {
      throw new StaleBeatError(this.beatSeq, this.gameStatus());
    }
  }

  /** 0065 Part B — remember an `AdvanceView` under its idempotency key (bounded LRU; oldest evicts). */
  private rememberIdempotent(key: string, view: AdvanceView): AdvanceView {
    const isNew = !this.idempotencyCache.has(key);
    this.idempotencyCache.delete(key); // re-insert at the tail (insertion-ordered = LRU)
    this.idempotencyCache.set(key, view);
    while (this.idempotencyCache.size > GameSessionAdapter.IDEMPOTENCY_CACHE_MAX) {
      const oldest = this.idempotencyCache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.idempotencyCache.delete(oldest);
    }
    // PERSIST-9 — the cache is populated AFTER the commit's persist already fired (the funnel defers the
    // hook to `inOneCommit`'s tail, which runs before this remember), so the snapshot that just saved
    // MISSED this entry. Durably re-persist NOW (only for a genuinely new entry, so a pure replay adds no
    // I/O) so at-most-once survives a restart/LRU-unload that lands right after this progression. Best-
    // effort + fail-soft: a persist hiccup must never turn an already-committed progression into an error.
    if (isNew) {
      try {
        this.persist(); // outside any `inOneCommit` depth ⇒ fires `onPersist` DIRECTLY, a SECOND real commit
        // Issue #1725 (C1) — this is a genuine SECOND bump through the SAME commit funnel (the idempotency
        // entry is durable state, so backfilling it commits again), landing AFTER `inOneCommit` already
        // built+corrected `view.beatSeq` for the FIRST commit. Without this, the cached/returned view would
        // report a counter one commit further behind current — the same "FE caches a stale token, its own
        // next mutation self-409s" failure mode, just via the idempotency path instead of the tick. `view`
        // is the SAME object reference stored in `idempotencyCache` above, so this also keeps a later
        // verbatim replay of this key correct.
        view.beatSeq = this.beatSeq;
      } catch {
        /* the cache is a durability optimization; a persist failure must not break the committed view */
      }
    }
    return view;
  }

  /**
   * A10 / #591 / R1c — namespace a caller-minted `idempotencyKey` by the LEVER it was passed to, so the
   * SHARED `foldIdempotency` ledger can't COLLIDE across verbs. Without this, the same key reused on two
   * different levers (`makeDeal` then `confide`, say) would make the second lever return the FIRST's cached
   * result under its own type cast AND skip its own mutation — a real cross-lever bug. Prefixing with a
   * stable per-lever constant keeps same-lever+same-key de-dup (at-most-once) while cross-lever+same-key
   * stays distinct. An `undefined` OR EMPTY key ⇒ `undefined` (opt-out; the call sites skip the ledger
   * entirely). Empty is rejected as a dedup token: a `""` key identifies no operation, so treating it as
   * one would falsely de-dup unrelated calls (the MCP arg-guard also refuses an empty key at the boundary).
   */
  private foldLedgerKey(verb: string, key: string | undefined): string | undefined {
    return key ? `${verb}:${key}` : undefined;
  }

  /**
   * A10 / #591 / R1c — the at-most-once REPLAY lookup for the fold levers. On a HIT it REFRESHES the key's
   * LRU recency (re-inserts at the tail, mirroring `EngineCommandsAdapter.recordInteraction`'s replay path)
   * so a key that is actively being re-driven can't be evicted out from under its own retry window. Takes
   * the already-namespaced key (or `undefined` to opt out). Vault-free (an opaque token, never secret state).
   */
  private foldReplay<T>(idemKey: string | undefined): { hit: true; value: T } | { hit: false } {
    if (idemKey !== undefined && this.foldIdempotency.has(idemKey)) {
      const value = this.foldIdempotency.get(idemKey) as T;
      this.rememberFoldIdempotent(idemKey, value); // refresh LRU recency on replay
      return { hit: true, value };
    }
    return { hit: false };
  }

  /**
   * A10 / #591 / R1c — remember a fold-bearing lever's committed result under its (namespaced) idempotency
   * key (bounded LRU; oldest evicts). The `recordIdempotency`/`rememberIdempotent` sibling for the
   * `makeDeal`/`confide`/`exposeSecret`/`tradeSecret` port. In-memory only (not persisted) — the retry
   * window is seconds and a restart drops the FE's in-flight deferred queue, so there is nothing to dedup
   * across one. Returns the value so a caller can `return this.rememberFoldIdempotent(key, result)` inline.
   */
  private rememberFoldIdempotent<T>(key: string, result: T): T {
    this.foldIdempotency.delete(key); // re-insert at the tail (insertion-ordered = LRU)
    this.foldIdempotency.set(key, result);
    while (this.foldIdempotency.size > GameSessionAdapter.FOLD_IDEMPOTENCY_MAX) {
      const oldest = this.foldIdempotency.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.foldIdempotency.delete(oldest);
    }
    return result;
  }

  /** Wire the beat-event sink (the registry records each as a player-witnessed event). */
  setOnEvent(fn: (ev: BeatEvent) => void): void {
    this.onEvent = fn;
  }

  /** Wire the one-off witnessed-event recorder (deal made/broken reveals, 0039). */
  setOnPlayerEvent(fn: (content: string, witnessSet: EntityId[], type?: string) => string | undefined): void {
    this.onPlayerEvent = fn;
  }

  /** Wire a narrator for the snarky tagline (0033). Without one, the curated fallback is used. */
  setNarrator(narrator: NarrativePort): void {
    this.narrator = narrator;
  }

  /** Wire the engine-only soul store (0041) so the live loop deepens souls + can recall (0024). */
  setSoul(soul: SoulProvider): void {
    this.soul = soul;
  }

  /**
   * Feature #1394 — the Vault-free scene-memory recall closure, wired by the registry from the
   * OUTWARD `VisibleStateService` (the player's witness-filtered projection) + the shared embedder.
   * The provenance lives at the wiring site ON PURPOSE: this adapter never reaches the Vault or the
   * raw event store for recall — it delegates to a closure that reads only the player projection.
   * Unwired ⇒ recall returns `[]` (a standalone adapter / test with no live projection).
   */
  private sceneRecall?: (npcIds: readonly EntityId[], cue: string) => string[];

  setSceneRecall(fn: (npcIds: readonly EntityId[], cue: string) => string[]): void {
    this.sceneRecall = fn;
  }

  /** Reserve-twist slots for a new game (0016 knob: the admin sets the COUNT, never the content). */
  private twistCount = 2;

  setTwistCount(n: number): void {
    this.twistCount = Math.max(0, Math.floor(n));
  }

  /**
   * 0016 — apply the God-Mode knobs the LIVE engine honors (a Vault-free count-only surface; never content). Recognized: `reserveTwists`
   * (the reserve-twist COUNT, 0-5), `tieBudget` and `showmanceBudget` (the pre-game tie / showmance COUNTS, 0-6; 0059 "the admin may
   * override the COUNT like the twist budget"). They shape the NEXT season's setup (a season in flight keeps what it was dealt). Anything else
   * (phase, week, temperature...) is the engine's own state or a constant it does not expose and is reported as not applied.
   */
  applyAdminKnobs(knobs: Record<string, unknown>): { applied: string[]; notApplied: string[] } {
    const applied: string[] = [];
    const notApplied: string[] = [];
    const count = (v: unknown, max: number): number | undefined =>
      typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= max ? Math.floor(v) : undefined;
    for (const [k, v] of Object.entries(knobs ?? {})) {
      // `reserveTwists` is the LEGACY pre-scheduled path's slot count (the engine loads at most `RESERVE_POOL.length`); the reactive
      // planner (ORWELL_REACTIVE_TWISTS) arms the standing pool and never reads it, so there it is reported NOT applied.
      const n = k === "reserveTwists" ? (this.reactiveTwistsEnabled ? undefined : count(v, RESERVE_POOL.length))
        : k === "tieBudget" || k === "showmanceBudget" ? count(v, 6) : undefined;
      if (n === undefined) { notApplied.push(k); continue; }
      if (k === "reserveTwists") this.setTwistCount(n);
      else if (k === "tieBudget") this.tieBudget = n;
      else this.showmanceBudget = n;
      applied.push(k);
    }
    return { applied, notApplied };
  }

  /**
   * 0025 reactive redesign (PO ruling 2026-07-06): when on, a NEW season arms the standing reactive
   * pool (all three twists watch the live house, per-season seeded triggers) instead of the legacy
   * pre-scheduled double-eviction-only path. Default ON (PO ruling 2026-11-03, "I want to know if this breaks the game");
   * `ORWELL_REACTIVE_TWISTS=0` or `ORWELL_FLAGS_OFF=1` restores the legacy path byte-identically; the whole reactive path is gated by whether
   * `s.twistPlan` is set at setup, so an in-flight legacy game never changes shape.
   */
  private reactiveTwistsEnabled = flagDefaultOn("ORWELL_REACTIVE_TWISTS");

  setReactiveTwistsEnabled(on: boolean): void {
    this.reactiveTwistsEnabled = on;
  }

  /** Vault audit-copy hook (0025/B53): the registry seals the loaded twists into the engine's Vault. */
  private onSeal?: (reserve: readonly ReserveTwist[]) => void;

  setOnSeal(fn: (reserve: readonly ReserveTwist[]) => void): void {
    this.onSeal = fn;
  }

  /**
   * Deep-profile seal hook (feature 0058): the registry seals each NPC's HIDDEN profile + story
   * threads into the engine's Vault AND indexes them into the soul for full-fidelity recall (L27b) —
   * exactly the seam `setOnSeal` uses for reserve twists. Engine-only: the sealed content is a secret
   * (off the player AND admin), so it rides this hook, never an outward projection.
   */
  private onSealProfiles?: (
    profiles: ReadonlyArray<{ id: EntityId; profile: DeepProfile }>,
    threads: readonly StoryThread[],
  ) => void;

  setOnSealProfiles(
    fn: (profiles: ReadonlyArray<{ id: EntityId; profile: DeepProfile }>, threads: readonly StoryThread[]) => void,
  ): void {
    this.onSealProfiles = fn;
  }

  /**
   * RE-seal ONE houseguest's authored profile + threads (L28b write-back) — REPLACING that subject's
   * prior Vault records (idempotent, no duplication), unlike `onSealProfiles` which appends the cast at
   * birth. Engine-only by construction (the registry wires it to the Vault via `replaceHidden`).
   */
  private onResealProfile?: (id: EntityId, profile: DeepProfile, threads: readonly StoryThread[]) => void;

  setOnResealProfile(fn: (id: EntityId, profile: DeepProfile, threads: readonly StoryThread[]) => void): void {
    this.onResealProfile = fn;
  }

  /**
   * The engine-only HIDDEN deep layer (0058) — the §3 secrets/goals/weakness/Day-1 perception per NPC
   * and the derived story threads. NEVER projected (the view/npcVoice/portrait paths never read this);
   * sealed into the Vault at seal time and persisted through the Vault snapshot. Kept here so the
   * thread-activation fold (`activateThread`) and the Day-1 edge seeding can read them in-process.
   */
  private deepProfiles: Record<EntityId, DeepProfile> = {};
  private storyThreads: StoryThread[] = [];

  /**
   * 0065 — the engine-side pre-game holding store for a PRE-WARMED cast. Before the casting interview
   * ends, `preSeedCast` generates the player-INDEPENDENT cast (composition + diversity + deep layer)
   * off the season seed into here; the FE then authors it deeply (`recordCastProfile` lands HERE
   * pre-game), and the portrait prompts read it. When `createCharacter` finalizes it ADOPTS this
   * finished cast (the SAME seed) instead of regenerating the thin seeded floor — so portraits, shot
   * from the warmed store, match the finished person. Null until a warm happens; cleared on adoption.
   * Durable (0030): a warmed-but-not-finalized cast survives a restart. ENGINE-ONLY — it holds the
   * hidden deep layer + private orientations (sealed at warm time; never projected).
   */
  private prewarm: PrewarmCast | null = null;

  /**
   * 0065 (advance-warm) — the per-user NEXT-season holding store, mirrored onto the LIVE sandbox so it
   * is DURABLE (it persists in this sandbox's snapshot and survives an engine restart mid-finale). The
   * registry owns the working/scratch copy + the cutover adoption; this field is the durable mirror it
   * writes through `holdNextSeasonWarm` (and reads back via `takeNextSeasonWarm` on a resume). It is
   * INVISIBLE to active play — no view/projection/portrait/moment path reads it — exactly like `prewarm`.
   * Cleared at the cutover (the registry adopts it into the fresh sandbox, then drops the buffer). Holds
   * the hidden deep layer (engine-only, like `prewarm`); the snapshot never crosses the wall.
   */
  private nextSeasonWarm: PrewarmCast | null = null;

  /**
   * The engine-only HIDDEN seeded relationship layer (0059): sparse pre-game ties + showmances, sealed
   * off the player AND admin. NEVER projected (no view/npcVoice/portrait/moment path reads it); sealed
   * into the Vault at seed time and persisted in the snapshot. The admin may set the per-season COUNT
   * budget (0016-style) — never the content.
   */
  private seededRels: SeededRelationships = { ties: [], showmances: [] };

  /**
   * Feature 0116 — the model-authored pre-show tie graph (validated by the genesis envelope). When
   * non-null, `seedSeededRelationships` PREFERS it over the floor draw at createCharacter (folding the
   * engine-owned `TIE_AFFINITY_BIAS` + sealing, exactly as for a floor tie); showmances stay engine-seeded.
   * Null ⇒ the deterministic floor tie draw stands, so the seeded sims are byte-identical (byte-neutral).
   */
  private genesisTies: PreGameTie[] | null = null;
  /** 0116 — the seeded season brief the genesis proposal was steered by (persisted as part of the world-gen artifact). */
  private seasonBrief: SeasonBrief | null = null;
  /** 0116 — provenance: true once cast genesis authored this cast's skeleton (distinguishes an authored cast from the floor). */
  private genesisAuthored = false;
  private tieBudget = DEFAULT_TIE_BUDGET;
  private showmanceBudget = DEFAULT_SHOWMANCE_BUDGET;

  /**
   * 0059 §5 — the per-season count of pre-game TIES that have surfaced TO THE PLAYER (the L40-style hard
   * cap, `SEEDED_TIE_SURFACING.maxPlayerSurfacesPerSeason`). Persisted (monotonic within a season; reset
   * by a fresh `createCharacter`). Only ever advanced by `advanceSeededTies`, and only when the flag is on.
   */
  private playerTieSurfaceCount = 0;
  /** 0059 §5 — the subjects of ties already surfaced to the player, so a tie never re-spends the cap. */
  private surfacedTieSubjects = new Set<EntityId>();
  /**
   * 0059 §5 — a DEDICATED scheduler tick counter for the tie-surfacing rng (off the game seed). Varies the
   * dedicated stream each tick WITHOUT ever touching the shared society/vote stream (calibration spine).
   * Bumped per `advanceSeededTies` call (only when the opt-in flag is on). Persisted so the stream is
   * stable across a restart. Distinct from `presenceTickCount` so the two dedicated streams never alias.
   */
  private tieScheduleTickCount = 0;

  /**
   * Feature 0095 — the pre-show-TIE REVEAL layer (a SEPARATE, distinct pathway from 0059 §5 above, which
   * only ever produces ambient suspicion and folds nothing but a mild third-party re-read). `tieExposureCount`
   * is the per-season hard cap (ties ever promoted past `sealed`, by ANY pathway including `accuseTie`);
   * `tieRevealTickCount` is the DEDICATED scheduler tick counter (off the game seed, never the shared
   * society/vote stream). Both persisted; both zero unless the opt-in `ORWELL_TIE_REVEAL` flag is on.
   */
  private tieExposureCount = 0;
  private tieRevealTickCount = 0;

  /**
   * 0059 §5 — the tie-surfacing SEAMS (the session holds no events/knowledge handle, exactly like the
   * 0060 thread scheduler). `onTieSurfaceToPlayer` lands the Vault-free observation in the player's
   * knowledge through an anchored `told-by` pathway (the registry wires the in-game pathway); it returns
   * whether the player came to hold it. NPC↔NPC diffusion is done in-helper against the `knowledge`
   * handed to `advanceSeededTies`. Nothing crosses but the observable read "they seem unusually close"
   * (never the sealed `nature`). Unwired ⇒ the to-player surfacing is simply skipped (NPC-side only).
   */
  private onTieSurfaceToPlayer?: (subject: EntityId, observation: string) => boolean;

  setOnTieSurfaceToPlayer(fn: (subject: EntityId, observation: string) => boolean): void {
    this.onTieSurfaceToPlayer = fn;
  }

  /**
   * The engine-only HIDDEN private-orientation map (feature 0063): the orientation of each houseguest
   * who holds it PRIVATELY (closeted / not-yet-out). NEVER projected — no view/npcVoice/portrait/moment
   * path reads it; sealed into the Vault at cast time (via `onSealPrivateOrientations`) and persisted in
   * the snapshot. It surfaces to the player ONLY through a modeled 0002 pathway, exactly as a 0058 secret
   * does. PUBLIC (out) orientations are NOT here — they ride on the Character as `outOrientation`.
   */
  private privateOrientations: Record<EntityId, Orientation> = {};

  /**
   * The ethnicity-grounded skin-tone cue per NPC id (feature 0063) — set by `seedDiversity`, read by
   * `seedDeepProfiles` to ground `physicalCharacteristics.skinTone` so the text and the portrait agree
   * with the guaranteed heritage. PUBLIC, Vault-free (it's a complexion phrase, already on the card);
   * transient (re-derivable from the ethnicity facet), so it is NOT separately persisted.
   */
  private groundedSkinTones: Record<EntityId, string> = {};

  /**
   * #1140 — RE-PICKED display names per NPC id (a given-name token swapped to match the final gender
   * presentation; surname kept). Computed by `seedDiversity` but APPLIED to `n.character.name` only AFTER
   * `seedDeepProfiles` (via `applyDiversityRenames`): the deep layer keys its sub-streams off `hg.name`
   * (`deepProfile.ts`), so renaming the Character before it runs would shift the deep profile / Day-1
   * perception / story threads — and therefore the seeded vote/jury outcomes. Deferring the write keeps the
   * deep layer (and the whole outcome stream) byte-identical with the rename on vs. off. Transient
   * (re-derivable from the diversity layer); not separately persisted — the renamed name lives on the
   * byte-stable Character once applied.
   */
  private pendingRenames: Record<EntityId, string> = {};

  /**
   * Seal hook for the HIDDEN private orientations (feature 0063) — the registry writes the Vault audit
   * copy + recall index, exactly like `onSealProfiles`. Engine-only: a private orientation is a secret
   * (off the player AND admin), so it rides this hook, never an outward projection.
   */
  private onSealPrivateOrientations?: (entries: ReadonlyArray<{ id: EntityId; orientation: Orientation }>) => void;

  setOnSealPrivateOrientations(fn: (entries: ReadonlyArray<{ id: EntityId; orientation: Orientation }>) => void): void {
    this.onSealPrivateOrientations = fn;
  }
  private onSealSeededRels?: (rels: SeededRelationships) => void;

  setOnSealSeededRels(fn: (rels: SeededRelationships) => void): void {
    this.onSealSeededRels = fn;
  }

  /**
   * 0059/L40 — fired when a seeded showmance crosses into `visible`: the registry wires this to record
   * a PLAYER-witnessed (public, non-hidden) house event, so the player learns of the romance through a
   * real pathway (0002) and the narrator may voice it. Engine-only seam (the adapter holds no events).
   */
  private onShowmanceSurfaced?: (sm: { a: EntityId; b: EntityId; aName: string; bName: string }) => void;

  setOnShowmanceSurfaced(fn: (sm: { a: EntityId; b: EntityId; aName: string; bName: string }) => void): void {
    this.onShowmanceSurfaced = fn;
  }

  /**
   * 0060 §4.2 — the surfacing seams the thread scheduler uses (NPC↔NPC gossip vs. a rare to-the-player
   * pathway). The adapter holds NO events/knowledge handle, so it hands the registry a Vault-SAFE
   * paraphrase (never the premise — `threadRumor` keyed by source class) and the registry runs the
   * 0038 gossip diffusion / 0002 `surfaceInformationTo` (with genuine content lineage, E9). Returns
   * whether the surfacing actually reached the player (so the scheduler can count it for restraint).
   */
  private onThreadGossip?: (origin: EntityId, rumor: string, subject: EntityId) => void;
  private onThreadSurfaceToPlayer?: (subject: EntityId, rumor: string) => boolean;

  setOnThreadGossip(fn: (origin: EntityId, rumor: string, subject: EntityId) => void): void {
    this.onThreadGossip = fn;
  }

  /** B33 - the latest closed-set disclosure event per NPC, valid for the beat it happened in (memory only; cleared when the board moves). A52 reads it to hand the narrator only what the engine rolled. */
  private beatDisclosures = new Map<EntityId, { epoch: number; event: DisclosureEvent }>();
  /** The disclosure window: bumped on every announced player message and every advance, so an event lives for the player turn / beat it happened in (a commit's beatSeq bump does not end it). */
  private disclosureEpoch = 0;
  private noteDisclosure(npc: EntityId, event: DisclosureEvent): void { this.beatDisclosures.set(npc, { epoch: this.disclosureEpoch, event }); }
  /** What `npc` did about telling the player something THIS beat (confirm / slip / deflect), or undefined when the engine rolled nothing for them. */
  disclosureThisBeat(npc: EntityId): DisclosureEvent | undefined {
    const e = this.beatDisclosures.get(npc);
    return e && e.epoch === this.disclosureEpoch ? e.event : undefined;
  }

  /** N-17 vs 0092 - the delivery MARKER: a Vault-free counter + the source's PUBLIC id, set whenever a thread surfaces to the player OFF the tool path (the confidant slip / gossip chain run inside the orchestrator tick). Memory only (a restart resets it; the front-end reads a change, not an order). Never content. */
  private playerSurfaceN = 0;
  private playerSurfaceSource?: EntityId;
  setOnThreadSurfaceToPlayer(fn: (subject: EntityId, rumor: string) => boolean): void {
    this.onThreadSurfaceToPlayer = (subject, rumor) => {
      const told = fn(subject, rumor);
      if (told) { this.playerSurfaceN += 1; this.playerSurfaceSource = subject; this.noteDisclosure(subject, dripToDisclosure()); }
      return told;
    };
  }

  /** 0075 — wire the confidence-recording pathway (the composition root owns the KnowledgeService). */
  setOnConfide(fn: (npcId: EntityId, content: string, confidence: number) => boolean): void {
    this.onConfide = fn;
  }

  /** 0129 slice 3 — wire the juror-telling pathway (the composition root owns the KnowledgeService). */
  setOnJurorTell(fn: (jurorId: EntityId, factId: string, confidence: number) => string | null): void {
    this.onJurorTell = fn;
  }

  /** 0093/0099 — wire the player's own knowledge reader (validate a wielded factId; resolve its subject).
   *  A0: `pathway` rides along (additive) so the knowledge-wall manifest can select the Diary-Room-tagged
   *  facts — the class provably sealed from the whole house. */
  setPlayerKnowledgeReader(fn: () => ReadonlyArray<{
    id: string; content: string; subject?: EntityId; factId?: string; pathway?: string;
    distortion?: number; confidence?: number;
  }>): void {
    this.playerKnowledgeReader = fn;
  }

  /** 0093/0099 — wire the in-game pathway that surfaces an exposed/traded secret into a houseguest's knowledge. */
  setOnSurfaceToHouseguest(fn: (npcId: EntityId, content: string, subject: EntityId | undefined, pathway: string, confidence: number) => boolean): void {
    this.onSurfaceToHouseguest = fn;
  }

  /**
   * 0060 §3 (`nominated-twice`) — engine-only, hidden bookkeeping: the DISTINCT weeks each houseguest
   * has been on the block, accrued each schedule tick from the live ceremony nominees. Persisted in the
   * snapshot so the count survives a restart (0030); never projected. Absent on pre-0060 saves (rebuilt
   * from the current ceremony onward — at worst a thread waits one extra block to ripen, never leaks).
   */
  private nominationWeeks: Record<EntityId, number[]> = {};
  /** 0060 — the count of threads that have ever SURFACED this season (the hard restraint cap, §5). */
  private surfacedThreadCount = 0;
  /**
   * 0104 — the returning player's accumulated season-over-season NOTORIETY, set ONLY when the player
   * chose to come back as the SAME character (the diegetic opt-in, R4 — the registry hands it in via
   * `setNotoriety` on a `keepCharacter` restart). Null on a fresh / new-character / no-prior-season
   * game ⇒ `seedFirstImpressions` folds NO bias and is BYTE-IDENTICAL (the calibration-neutrality
   * guarantee). It is a bounded OPEN-SET summary — never a Vault read, never a number to the player.
   * Folded ONCE at `seedFirstImpressions`; thereafter it is just the move-in edges. Not persisted on
   * THIS session (it lives at the account level in the `UserNotorietyStore`); held only to seed day one.
   */
  private notoriety: NotorietySummary | null = null;
  /**
   * 0091 — whether the TRIGGER-ERUPTION layer RUNS. DEFAULT ON (the dedicated `ORWELL_TRIGGERS` flag; `=0` opts out):
   * when off, the orchestrator never calls `runTriggerEruptions` ⇒ ZERO draws on any rng ⇒ every seeded
   * gate is byte-identical (the calibration-neutrality guarantee). Per instance; a test flips it via
   * `setTriggersEnabled`.
   */
  private triggersEnabled = TRIGGERS_ENABLED_DEFAULT;
  /**
   * 0091 — the per-season count of volatile triggers that have FIRED (sibling to `surfacedThreadCount`).
   * MONOTONIC; the hard `eruptionCapPerSeason` reads it so a few-per-season pacing holds and a reload never
   * re-opens the cap (0007/0030). ENGINE-ONLY (a count carries no Vault content). Reset to 0 on a season
   * restart, like `surfacedThreadCount`.
   */
  private eruptionCount = 0;
  /** 0091 — the DEDICATED trigger-rng tick counter: the trigger check forks off the game seed + this, never
   *  the shared society/vote stream, so even with the layer ON the seeded calibration spine is untouched.
   *  Bumped once per `runTriggerEruptions`. Persisted so the dedicated stream stays reproducible (absent ⇒ 0). */
  private triggerTickCount = 0;
  /**
   * 0092 — the secret-pacing drip's hidden weekly bookkeeping (engine-only; the pace is per-WEEK, not a
   * per-tick probability). `pacingDripWeek` is the week `pacingDripCount` is FOR — a new week resets the
   * count to 0; `pacingDripCount` is how many player-bound drips have fired this week (the hard weekly
   * ceiling `SECRET_PACING.maxDripsPerWeek`); `pacingTickCount` is the DEDICATED rng's tick counter (so
   * the seeded eligibility stream is reproducible and never aliases another dedicated stream). Persisted
   * so the cadence + anti-spam survive a restart and the pace RESUMES (never resets). Absent on saves
   * with pacing off / pre-0092 ⇒ 0 (non-degradation; the season cap `surfacedThreadCount` still binds).
   */
  private pacingDripWeek = 0;
  private pacingDripCount = 0;
  private pacingTickCount = 0;
  /**
   * 0092 — per-thread, the WEEK that thread last dripped toward the player (so the already-told penalty +
   * the no-re-spam rule survive a restart). A thread's id ⇒ the last week it edged toward the player.
   * Persisted alongside the counter above (siblings to 0060's `surfacedThreadCount`). Engine-only.
   */
  private pacingLastDrippedWeek: Record<string, number> = {};
  /**
   * 0075 — what each houseguest has CONFIDED to the player, by id. The tier is MONOTONIC for a true
   * confidence (never re-told at a lower tier than already reached); `truthful: false` marks a lie
   * (engine-side only — never a player-facing tell). Persisted in the snapshot so a restored game
   * remembers exactly what the player has been told (non-degradation, 0007/0030).
   */
  private confideState: Record<EntityId, { tier: DisclosureTier; truthful: boolean }> = {};
  /** 0129 slice 4 — contents the player was told by a juror through `askJuror` (persisted; append-only). */
  private jurorTold = new Set<string>();
  /** 0075 — the per-season count of lies told TO the player (the hard `CONFIDENCE.maxLiesPerSeason` cap). */
  private lieCount = 0;
  /** B49 - per NPC, the confide lies it has told this season (only populated with `ORWELL_NO_HARD_CAPS`; shrinks that NPC's next lie roll). Persisted when non-empty. */
  private confideLiesBy: Record<EntityId, number> = {};
  /** B49 / PO ruling card 24 - NO HARD PER-SEASON COUNTS: the confide-lie (2), expose (3) and trade (5) caps become a high safety valve plus an escalating repetition cost. OFF unless exactly `ORWELL_NO_HARD_CAPS=1`. */
  private noHardCapsEnabled = flagDefaultOn("ORWELL_NO_HARD_CAPS");
  setNoHardCapsEnabled(on: boolean): void { this.noHardCapsEnabled = on; }
  /**
   * 0075 — the in-game pathway that records a confidence as the player's knowledge (set by the
   * composition root, like `onThreadSurfaceToPlayer`). The houseguest is the teller (`told-by:<id>`):
   * the engine writes the belief through `surfaceInformationTo` (0002) so it is correctly the
   * player's knowledge, not Vault content. Returns whether the player came to hold the belief.
   */
  private onConfide?: (npcId: EntityId, content: string, confidence: number) => boolean;
  /** 0129 slice 3 — surface ONE fact a juror already holds to the player (`told-by:<juror>`, content-anchored). */
  private onJurorTell?: (jurorId: EntityId, factId: string, confidence: number) => string | null;

  /**
   * Features 0093 + 0099 — secrets as power. Per learned `factId` the player has WIELDED, a monotonic
   * `usedAs` marker (`leverage` | `exposed` | `traded`) so a secret can't be re-wielded after it's spent
   * (exposing makes it public; trading widens who knows). Persisted (non-degradation, 0007/0030) so a
   * restored game remembers exactly which secrets the player has spent. Engine-only — never projected.
   */
  private secretUsedAs: Record<string, "leverage" | "exposed" | "traded"> = {};
  /** 0093 — the per-season count of exposes (the hard `LEVERAGE.maxExposesPerSeason` cap). Persisted. */
  private exposeCount = 0;
  /** 0099 — the per-season count of trades (the hard `SECRET_TRADE.maxTradesPerSeason` cap). Persisted. */
  private tradeCount = 0;
  /** deception — the per-season count of the PLAYER's bluffs (the `LEVERAGE.maxPlayerBluffsPerSeason` cap). Persisted. */
  private playerBluffCount = 0;
  /**
   * deception — the PASSIVE LIE-CATCH ledger (owner direction): per NPC who BELIEVED a player BLUFF, the
   * subject(s) the player lied about. When a genuine contradicting pathway later reaches that NPC (the
   * REAL truth about the same subject — an honest expose/trade), the bluff is caught and the bluffer takes
   * a betrayal-grade, recoverable hit from that NPC. Engine-only; persisted (non-degradation, 0007/0030).
   */
  private playerBluffBelief: Record<EntityId, EntityId[]> = {};
  /**
   * 0093/0099 — the player's own KNOWLEDGE reader (wired by the composition root, like the npc-knowledge
   * providers): returns the player's learned facts so the lever can VALIDATE that a wielded `factId` is
   * one the player legitimately holds (the Vault bright line — a non-learned secret is rejected, no
   * Vault-minting) and resolve which houseguest it is about. Returns [] when unwired. 0094 additively
   * widens the shape with `distortion`/`confidence` (already on every `KnowledgeFact`) so `confront`
   * can classify a cited belief via `isMateriallyDistorted` — no new seam, no new store.
   */
  private playerKnowledgeReader?: () => ReadonlyArray<{
    id: string; content: string; subject?: EntityId; factId?: string; pathway?: string;
    distortion?: number; confidence?: number; hops?: number;
  }>;
  /**
   * 0093/0099 — surface a fact INTO another houseguest's (or the house's) knowledge through the in-game
   * pathway (wired by the composition root, mirroring `onConfide`). The player is the teller for an
   * expose/trade (`told-by:player` / `overheard`): the engine records the witnessed pathway event so the
   * recipient correctly comes to KNOW the secret — never a Vault read. Returns whether it surfaced.
   */
  private onSurfaceToHouseguest?: (npcId: EntityId, content: string, subject: EntityId | undefined, pathway: string, confidence: number) => boolean;
  /** 0066 Phase-2: per-NIGHT conflict tally per houseguest (cleared at each new day). A character conflict
   *  drains the people in it ⇒ they turn in earlier tonight. In-memory + ephemeral (a mid-day reload simply
   *  resets it); only ever populated on the clock-ON path, so the calibration spine is unaffected. */
  private nightConflicts = new Map<EntityId, number>();

  /**
   * The season record providers (0048/B56): the full event record + the Vault's hidden records,
   * wired by the registry. The recap reads only the PUBLIC record; the retrospective reads the
   * hidden side and is gated on the finished terminal state in `seasonRetrospective`.
   */
  private record?: {
    events: () => GameEvent[];
    hidden: () => ReadonlyArray<{ kind: string; content: string }>;
  };

  setRecordProviders(p: {
    events: () => GameEvent[];
    hidden: () => ReadonlyArray<{ kind: string; content: string }>;
  }): void {
    this.record = p;
  }

  /**
   * 0065 Part E — the delta feed's O(Δ) providers, wired by the registry. `count` is the O(1) event-log
   * length (used to anchor each beat checkpoint at commit time). `visibleEventsSince(fromCount)` returns
   * the PLAYER-VISIBLE events appended AT OR AFTER `fromCount` — the registry slices the immutable log
   * tail (O(Δ)) and runs the SAME witness-filter + roster scrub the player surface uses, so the delta is
   * Vault-free by construction and never re-scans the whole log. Absent on a standalone adapter (no
   * registry) ⇒ the delta degrades to a full refresh (it cannot fetch a Vault-safe tail without them).
   */
  private deltaSource?: {
    count: () => number;
    visibleEventsSince: (fromCount: number) => DeltaEventView[];
  };

  setDeltaProviders(p: {
    count: () => number;
    visibleEventsSince: (fromCount: number) => DeltaEventView[];
  }): void {
    this.deltaSource = p;
  }

  /**
   * 0065 Part E — a per-turn beat checkpoint ring: `beatSeq → { eventCount, ceremony/board snapshot,
   * finished/winner }` captured at each `bumpBeatSeq` (the single commit funnel). The delta looks up the
   * checkpoint AT `sinceBeatSeq` to slice the event tail (O(Δ)) and diff the ceremony — so it never
   * re-derives "what existed then" by scanning. Bounded (the last `DELTA_WINDOW` beats); a token older
   * than the oldest retained checkpoint (or after a restart, which starts the ring empty) ⇒ a full
   * refresh, never a guessed partial delta. NOT persisted — it is a process-local read accelerator; on a
   * resume the FE's last-seen token resets too, so an unknown token correctly full-refreshes.
   */
  private readonly beatCheckpoints = new Map<number, {
    eventCount: number;
    /** T0-3 — `announcementLog.length` AS OF this beat (mirrors `eventCount`'s slicing contract). */
    announcementCount: number;
    week: number;
    phase: string;
    hoh?: EntityId;
    nominees: EntityId[];
    vetoHolder?: EntityId;
    vetoUsed: boolean;
    finished: boolean;
    winner?: EntityId;
  }>();
  private static readonly DELTA_WINDOW = 64;

  /**
   * 0065 Part E — an OPTIONAL diagnostic seam (Vault-free, no behavior change): reports how many tail
   * events the last `stateDelta` MATERIALIZED, so a complexity test can assert the work is bounded by Δ
   * (never O(events)). Off by default; set only in tests. It carries a count, never any event content.
   */
  private deltaScanProbe?: (scanned: number) => void;

  setDeltaScanProbe(fn: ((scanned: number) => void) | undefined): void {
    this.deltaScanProbe = fn;
  }

  /** Per-NPC knowledge readers (B65), wired by the registry from the KnowledgeService. `known` carries
   *  the originating `sourceEventId` (#843) so the Vault dump can join a gossip/surfacing breadcrumb
   *  event back to the real belief it lodged — voicing only ever reads `content`, so this is additive. */
  private npcKnowledge?: {
    // ADR 0019 Layer 3 widens this read with `factId`/`pathway`/`ts` (already on every `KnowledgeFact`
    // — the registry passes the full fact through) so the knowledge-scope manifest can group a fact by
    // lineage across holders and skip the Diary-Room class. Optional ⇒ back-compatible with any caller.
    known: (id: EntityId) => ReadonlyArray<{ content: string; sourceEventId?: string; factId?: string; pathway?: string; ts?: number }>;
    suspicions: (id: EntityId) => ReadonlyArray<{ content: string }>;
  };

  setNpcKnowledgeProviders(p: {
    known: (id: EntityId) => ReadonlyArray<{ content: string; sourceEventId?: string; factId?: string; pathway?: string; ts?: number }>;
    suspicions: (id: EntityId) => ReadonlyArray<{ content: string }>;
  }): void {
    this.npcKnowledge = p;
  }

  /** Caps so a long season's voicing context stays tight (prefer removing context — ADR 0003). */
  private static readonly VOICE_KNOWS_CAP = 20;
  private static readonly VOICE_SUSPECTS_CAP = 8;

  /** Resolve a houseguest id by id, else exact name, else an UNAMBIGUOUS first name (audit 2026-06-18
   *  — the model calls npcVoice with a name as often as an id; tolerate both, but never guess between
   *  two people who share a first name). Returns null when unknown/ambiguous. */
  private resolveHouseguestVoiceId(key: string): EntityId | null {
    if (!this.house) return null;
    const npcs = this.house.npcs;
    if (npcs.some((n) => n.id === key)) return key as EntityId;
    const k = key.trim().toLowerCase();
    const byName = npcs.filter((n) => n.name.toLowerCase() === k);
    if (byName.length === 1) return byName[0]!.id;
    const byFirst = npcs.filter((n) => n.name.toLowerCase().split(" ")[0] === k);
    return byFirst.length === 1 ? byFirst[0]!.id : null;
  }

  /**
   * The knowledge-bounded voicing projection for ONE active houseguest (B65 / ADR 0003 §8). The
   * model is HANDED a bounded person: their stable public persona (byte-stable, B61), their room +
   * co-presence (0049), what THEY legitimately know (0002 — which they may, in character, choose
   * to reveal: that is the game), their hunches, and ORGANIC stances (labels through their own
   * disposition — never a number). Everything any OTHER houseguest privately knows, the Vault,
   * and the souls stay out by construction — the model cannot voice what this NPC never learned.
   */
  /** A49 - narrator-side observable tells (E1a). OFF unless exactly `ORWELL_NPC_TELLS=1`; never-flipped. */
  private npcTellsEnabled = flagDefaultOn("ORWELL_NPC_TELLS");
  /** A54 (#2017 M5, ORWELL_NPC_MEMORY_SPEECH, default OFF; needs the memory ledger): npcVoice hands the narrator what this houseguest remembers about the PLAYER (top 3, plain words) and an engine-decided `bringUp`. */
  private npcMemorySpeechEnabled = flagDefaultOn("ORWELL_NPC_MEMORY_SPEECH");
  setNpcMemorySpeechEnabled(on: boolean): void { this.npcMemorySpeechEnabled = on; }
  /** In-game day of the last `bringUp` per houseguest (the once-per-day rate cap). Process-local: a restart may allow one extra mention, never a second leak. */
  private bringUpDay = new Map<EntityId, number>();
  private static readonly MEMORY_SPEECH = { top: 3, floor: 0.08, bar: 0.35, chanceScale: 0.8 } as const; // ASSUMED, pending Ryne (design 14.10)
  private static readonly MEMORY_ABOUT_YOU: Readonly<Record<MemoryKind, string>> = {
    "deal-broken": "you broke a deal with them", "nominated-by-friend": "you put them on the block while they trusted you",
    "replaced-by-friend": "you named them the replacement while they trusted you", "veto-saved": "you saved them with the veto",
    "veto-withheld": "you left them on the block when you held the veto", "deal-kept": "you kept a deal with them",
    "scene-betrayal": "you betrayed them", "scene-conflict": "you clashed with them", "scene-kindness": "you were kind to them",
    "nominated-by-hoh": "you put them on the block",
    "secret-exposed": "you exposed their secret to the house", "secret-given": "you traded them a secret they wanted",
  };
  /** The houseguest's top live memories OF THE PLAYER as plain recency-worded facts (no kind slug, severity or number), plus the seeded, once-per-day, salience-barred `bringUp`. */
  private memorySpeechFor(id: EntityId): { rememberedAboutYou?: string[]; bringUp?: true } {
    const live = this.live;
    const entries = live?.npcMemory?.[id]?.[PLAYER];
    if (!live || !entries || entries.length === 0) return {};
    const half = NPC_MEMORY.halfLifeWeeks;
    const scored = entries.map((e) => ({ e, w: e.severity * Math.pow(0.5, Math.max(0, live.week - e.week) / half) }))
      .filter((x) => x.w >= GameSessionAdapter.MEMORY_SPEECH.floor).sort((a, b) => b.w - a.w).slice(0, GameSessionAdapter.MEMORY_SPEECH.top);
    if (scored.length === 0) return {};
    const when = (age: number): string => (age <= 0 ? "this week" : age <= 2 ? "recently" : "a while back");
    const facts = scored.map((x) => `${GameSessionAdapter.MEMORY_ABOUT_YOU[x.e.kind]} (${when(live.week - x.e.week)})`);
    const day = live.dayNumber ?? live.week;
    let bring = false;
    if (scored[0]!.w >= GameSessionAdapter.MEMORY_SPEECH.bar && this.bringUpDay.get(id) !== day) {
      const roll = new SeededRandom(hashSeed(`${this.gameSeed ?? 0}:bring-up:${id}:${day}`)).next();
      if (roll < Math.min(1, scored[0]!.w * GameSessionAdapter.MEMORY_SPEECH.chanceScale)) { bring = true; this.bringUpDay.set(id, day); }
    }
    return { rememberedAboutYou: facts, ...(bring ? { bringUp: true as const } : {}) };
  }
  setNpcTellsEnabled(on: boolean): void { this.npcTellsEnabled = on; }
  /** Present in the player's room and awake - the only houseguests whose carriage the player can observe. */
  private tellsVisibleFor(id: EntityId): boolean {
    if (!this.house || !this.presence) return false;
    const mine = this.presence.get(this.house.player.id);
    const theirs = this.presence.get(id);
    if (mine === undefined || theirs === undefined || mine !== theirs) return false;
    const awake = this.awakeNow();
    return !awake || awake.has(id);
  }
  private tellsFor(id: EntityId): { tells?: ReadonlyArray<{ kind: string; band: string; channel: string }> } {
    const soul = this.soulObj(id);
    if (!soul) return {};
    // B28: the persisted record (hysteresis against the previous tells) when the arc has refreshed it; a houseguest the arc has not touched yet falls back to a fresh read of the soul.
    const t = soul.tells ? soul.tells.map((x) => ({ kind: x.kind, band: x.band, channel: tellChannel(x.kind) })) : tellsOf(soul);
    return t.length ? { tells: t.map((x) => ({ kind: x.kind, band: x.band, channel: x.channel })) } : {};
  }
  npcVoice(idOrName: EntityId): NpcVoiceView | null {
    if (!this.house) return null;
    // Name-tolerant lookup (audit 2026-06-18): the narration model reliably calls this with a
    // NAME ("Griffin Suarez") instead of the id ("npc:8"); a strict id-only match returned null and
    // the model then narrated the dead call out loud to the player ("the voice report didn't come
    // back"). Resolve by id first, then exact name, then an unambiguous first-name — so a sensible
    // call always lands and never leaks a backstage miss into the fiction.
    const rid = this.resolveHouseguestVoiceId(idOrName);
    const npc = rid ? this.house.npcs.find((n) => n.id === rid) : undefined;
    if (!npc) return null;
    const id = npc.id;
    const seat = this.seatOf(id);
    // NARR-7 (#542): a JURY/EVICTED seat is still VOICED — at the finale the prompt directs the
    // model to stage all 9 jurors questioning the finalists, so a null voice anchor forced the model
    // to FABRICATE juror biographies that contradict their seeded selves. The persona block below is
    // the SAME byte-stable PUBLIC facets an active houseguest exposes (archetype/biography/demeanor/
    // heritage…) — all freely on the public card all season — so this is no Vault widening: only
    // whereabouts (a live in-house field) goes null, since a juror is no longer in the house.
    const isActive = seat === "active";

    const room = isActive ? (this.presence?.get(id) ?? null) : null;
    const present: NamedRef[] = [];
    if (room && this.presence) {
      for (const [other, where] of this.presence) {
        if (where === room && other !== id) present.push({ id: other, name: this.nameOf(other) });
      }
    }
    const evicted = new Set(this.live?.evictionOrder ?? []);
    const others = [this.house.player.id, ...this.house.npcs.map((n) => n.id)]
      .filter((h) => h !== id && !evicted.has(h));
    return {
      houseguest: { id, name: npc.name },
      seat,
      persona: {
        archetype: npc.character.archetype,
        strategyStyle: npc.character.strategyStyle,
        background: npc.character.background,
        age: npc.character.age,
        presentation: npc.character.presentation,
        // L28: voice them in their STORED observable register (blunt / deadpan / anxious…), not a default.
        ...(npc.character.demeanor !== undefined ? { demeanor: npc.character.demeanor } : {}),
        // 0058: voice the STORED biography, never invent (and drift) it. Public facet only — the hidden
        // deep profile is never on this projection (the §8 wall).
        ...(npc.character.biography !== undefined ? { biography: npc.character.biography } : {}),
        // L29 single physical descriptor (appearance/physicalCharacteristics consistency): the STRUCTURED
        // facet is the ONE source of truth the portrait + narration share; the prose `appearance` rides
        // ONLY as the pre-0058 fallback — NEVER both at once (they were independently generated and could
        // contradict on build/skin/hair). When the facet is present it alone is voiced.
        ...(npc.character.physicalCharacteristics !== undefined
          ? { physicalCharacteristics: npc.character.physicalCharacteristics }
          : npc.character.appearance !== undefined ? { appearance: npc.character.appearance } : {}),
        // 0063: voice the PUBLIC identity facets — heritage, gender presentation, and a PUBLICLY-OUT
        // orientation only. A PRIVATELY-held orientation is NEVER here (it's Vault-sealed; the houseguest
        // would never lead with it until a pathway surfaces it, §5). One true facet, never the character.
        ...(npc.character.ethnicity !== undefined ? { ethnicity: npc.character.ethnicity } : {}),
        ...(npc.character.genderPresentation !== undefined ? { genderPresentation: npc.character.genderPresentation } : {}),
        ...(npc.character.outOrientation !== undefined ? { outOrientation: npc.character.outOrientation } : {}),
        // 0084: voice them in their STORED voice fingerprint — how THIS houseguest talks, all season. A
        // PUBLIC, byte-stable facet (no Vault, no number); absent only on a pre-0084 save.
        ...(npc.character.voice !== undefined ? { voice: npc.character.voice } : {}),
      },
      // 0084: the current MOOD as a Vault-safe affect word, derived live from the soul on two timescales
      // (acute + marinated baseline). ACTIVE houseguests only (a juror is out of the house); observable
      // carriage only — never a number, never the hidden cause.
      ...(isActive ? (() => {
        const s = this.soulObj(id);
        return s ? { mood: moodWord(s.emotionalState, s.volatility, s.emotionalHistory) } : {};
      })() : {}),
      // A49 (ORWELL_NPC_TELLS, default OFF): the observable carriage of a houseguest who is PRESENT in the player's room and awake - words only (kind / band / channel). Flag off => no key.
      ...(this.npcTellsEnabled && isActive && this.tellsVisibleFor(id) ? this.tellsFor(id) : {}),
      // A54 (ORWELL_NPC_MEMORY_SPEECH + the memory ledger, default OFF): what an ACTIVE houseguest remembers about the player. Flag off => no key.
      ...(this.npcMemorySpeechEnabled && this.npcMemoryEnabled && isActive ? this.memorySpeechFor(id) : {}),
      whereabouts: room ? { room, present } : null,
      knows: (this.npcKnowledge?.known(id) ?? [])
        .slice(-GameSessionAdapter.VOICE_KNOWS_CAP)
        .map((f) => this.humanize(f.content)),
      suspects: (() => {
        const base = (this.npcKnowledge?.suspicions(id) ?? [])
          .slice(-GameSessionAdapter.VOICE_SUSPECTS_CAP)
          .map((f) => this.humanize(f.content));
        // 0105: a houseguest's DRIVE (0086) gives them a specific, Vault-safe suspicion — the wary
        // threat-READ behind the sealed plan, surfaced as a behavioral hunch so the narrator has someone
        // specific to voice them watching (anchoring the 0084 mood). Present ONLY when the drive layer is
        // live (⇒ campaigns off ⇒ no drive ⇒ this is absent ⇒ byte-identical projection). The PLAN, the
        // intensity, the campaign never cross — only the hunch the houseguest would act out anyway.
        if (isActive) {
          const drv = this.drives.get(id);
          const hunch = drv ? driveSuspicion(drv, drv.target !== undefined ? this.nameOf(drv.target) : undefined) : null;
          if (hunch && !base.includes(hunch)) base.push(hunch);
        }
        return base;
      })(),
      stances: others.map((other) => ({
        toward: { id: other, name: this.nameOf(other) },
        stance: relationshipLabel(this.rel.edge(id, other), dispositionOf(npc.character.archetype)),
      })),
      // 0075: the Vault-safe emergent confidence hint (reason + warmth word only) — present ONLY for an
      // ACTIVE houseguest the player has earned a confidence from, and only when the scene precipitates it.
      ...(isActive ? (() => { const m = this.mayConfideFor(npc); return m ? { mayConfide: m } : {}; })() : {}),
      // 0088: the living CURRENT read of the player — a Vault-safe carriage word + drift word, derived
      // live from the evolving NPC→player edge (distinct from the frozen dayOnePerception). ACTIVE only;
      // the anchor is Vault-only (persisted in the snapshot, never crossed). Sibling of 0084's `mood`.
      ...(isActive && this.house ? (() => {
        const playerId = this.house!.player.id;
        const edge = this.rel.edge(id, playerId);
        const disp = dispositionOf(npc.character.archetype);
        const soul = this.soulObj(id);
        const anchor = this.readAnchors.get(id);
        const read = currentReadOf(edge, disp, soul?.emotionalState, anchor);
        return { currentRead: read };
      })() : {}),
      // 0096: the Vault-safe `rivalry` tone hint — present ONLY for the held nemesis, ONLY inside a live
      // scene with them. Never a number, never a stated motivation, never a cold-open announcement.
      ...(isActive ? (() => { const r = this.rivalryFor(id); return r ? { rivalry: r } : {}; })() : {}),
    };
  }

  /**
   * A0 — the knowledge-wall manifest: the player's private disclosures that are sealed from the house,
   * for the front-end narration guard to enforce (no houseguest may voice what no pathway ever gave
   * them). Vault-free by construction — it reads the PLAYER's OWN knowledge (never a Vault read, never
   * an NPC's hidden layer). It surfaces the classes provably sealed from the WHOLE house (`knownTo`
   * empty ⇒ the guard's rule is absolute with zero false positives):
   *   • the Diary-Room-tagged player knowledge (`NO_NPC_PATHWAY` — an OOC channel with no in-game
   *     pathway to ANY npc, ever); and
   *   • ADR 0019 guardian caveat C1 — the player's `privateStrategy` (`producerOnlyCastingSeals`): the
   *     one casting field private BY DEFINITION (never voluntarily spoken in-house — the DR-class
   *     analog), told to production with NO in-game pathway to any houseguest. It lives on the player
   *     object, never in the knowledge layer, so neither the `NO_NPC_PATHWAY` player-knowledge facts
   *     above nor `knowledgeScopeManifest` covered it — a staged houseguest reciting it had NOTHING
   *     downstream to drop it (Layer 1 was its sole, un-backstopped defense); this is that backstop.
   *     Deliberately NARROW: motivation / backstory / open-ended interview notes are SHAREABLE and are
   *     NOT sealed (a global seal would false-hold legitimate open-set narration — ADR 0005 #1; see
   *     `producerOnlyCastingSeals`). The ADR's "camp counselor" leak was backstory — now Layer 1's job.
   * Non-diary player knowledge is deliberately NOT surfaced here: a player-witnessed secret can
   * legitimately diffuse NPC-to-NPC as gossip, so a blunt content scrub would fight the very pathway
   * model that makes it legal — that class is enforced through the per-NPC `npcVoice.knows` manifest
   * (Layer 2) and `knowledgeScopeManifest` (Layer 3) instead.
   */
  sealedFromHouse(): SealedFact[] {
    if (!this.house) return [];
    const facts = this.playerKnowledgeReader?.() ?? [];
    const out: SealedFact[] = [];
    for (const f of facts) {
      if (f.pathway !== NO_NPC_PATHWAY) continue;
      const content = this.humanize(f.content).trim();
      if (content) out.push({ content, knownTo: [] });
    }
    // ADR 0019 C1 — append the producer-only casting class as globally-sealed facts (knownTo empty).
    for (const content of this.producerOnlyCastingSeals()) out.push({ content, knownTo: [] });
    return out;
  }

  /** A seal needs ≥ this many words to be distinctive enough for the FE shingle guard (Greptile/CR
   *  #1763): a terse answer ("revenge", "the money") would otherwise mint a broad single-word signature
   *  that `_sentence_leaks_sealed`'s substring match hard-drops in EVERY sentence carrying that common
   *  word all season — a false hold on the open set (ADR 0005 #1). A short answer relies on Layer 1
   *  (context removal) alone; only distinctive prose earns the Layer-3 global seal. */
  private static readonly MIN_SEAL_WORDS = 3;

  /**
   * ADR 0019 guardian caveat C1 — the ONE producer-only casting field that is private BY DEFINITION and
   * so is never voluntarily spoken in the house: `privateStrategy` (the casting intake records it as the
   * player's TRUE gameplan, prompted "assure them it stays with production" — the DR-class analog). It
   * lives on the player object (never seeded into the knowledge layer), so the ADR 0019 Layer 2/3
   * knowledge manifests never saw it; this collects it as prose so `sealedFromHouse` can seal it GLOBALLY
   * (`knownTo` empty ⇒ no houseguest may ever voice it) — the defense-in-depth backstop behind Layer 1.
   * Vault-free by construction: the player's OWN authored words — never a stat, a soul number, or any
   * hidden layer. Absent ⇒ [].
   *
   * THE SEAL SET IS DELIBERATELY NARROW — only what the player would NEVER voluntarily say in-house.
   * DELIBERATELY EXCLUDED (all SHAREABLE, so a global `knownTo:[]` seal would FALSE-HOLD legitimate
   * open-set narration all season — a false hold worse than a missed phantom, ADR 0005 #1, the same
   * principle the C2 arm cites; a global seal cannot tell "no one told yet" from "this houseguest was
   * told" — that IS the pathway model's job, and these fields are not in it, so it can only over-reach):
   *   • `character.background` (BACKSTORY) — public bio; the player tells houseguests where they're from
   *     / what they do, so a houseguest they told legitimately references it.
   *   • `motivation` ("why I came on the show") — ordinary house small-talk a player openly discusses.
   *     VERIFIED (#1763 repro): sealing it globally hard-dropped a legitimate shared-motivation line.
   *   • the open-ended casting `interviewNotes` — a mixed bag (some private, some shareable like "I'm a
   *     nurse"); indistinguishable, so the safe default is NOT to globally seal them.
   * Their casting-turn recital is Layer 1's job (context removal + tool-result redaction); any LATER
   * reference belongs to the pathway model, never a global seal. The short public persona labels stay
   * out for the same reason (also #1727 drops them from context). Distinctive prose only.
   */
  private producerOnlyCastingSeals(): string[] {
    if (!this.house) return [];
    const content = this.humanize((this.house.player.privateStrategy ?? "").trim()).trim();
    // Distinctiveness floor — a too-terse value can't be safely shingle-matched (see MIN_SEAL_WORDS):
    // a short private strategy relies on Layer 1 (context removal) alone rather than earning the seal.
    if (content && content.split(/\s+/).length >= GameSessionAdapter.MIN_SEAL_WORDS) return [content];
    return [];
  }

  /** Cap the scope manifest so a long season's guard payload stays bounded (most-recent facts kept). */
  private static readonly SCOPE_MANIFEST_CAP = 80;

  /**
   * ADR 0019 Layer 3 — the generalized knowledge-scope manifest. Every distinctive fact currently held
   * by a BOUNDED subset of the house (someone who could hold it does NOT), grouped by lineage
   * (`factId`, else normalized content), each with its complete pathway-holder set as houseguest
   * DISPLAY NAMES. The FE narration guard drops any sentence in which a STAGED houseguest voices a fact
   * whose `knownTo` excludes them — closing the room-to-room asymmetry the ADR names (the player tells
   * B in one room; A must not "recall" it elsewhere).
   *
   * Vault-free by construction: reads ONLY the KnowledgeService `known(id)` projection (the legitimate
   * "witnessed-or-told" layer `npcVoice.knows` already surfaces per-NPC), never the Vault/soul. The
   * Diary-Room class is left to `sealedFromHouse` (its holder set is empty by definition), and facts the
   * WHOLE living house holds are omitted (no non-holder could leak them ⇒ nothing to guard).
   */
  knowledgeScopeManifest(): SealedFact[] {
    if (!this.house || !this.npcKnowledge) return [];
    // Everyone who could legitimately hold a fact right now: the player + every non-evicted houseguest.
    const evicted = new Set(this.live?.evictionOrder ?? []);
    const holderIds: EntityId[] = [this.house.player.id, ...this.house.npcs.map((n) => n.id)]
      .filter((id) => !evicted.has(id));
    const universe = new Set(holderIds);
    // Group by lineage across holders: representative content, the holder-id set, and a recency stamp.
    const groups = new Map<string, { content: string; raw: string; holders: Set<EntityId>; ts: number }>();
    for (const id of holderIds) {
      // Scan EVERY fact each holder holds — NEVER a per-holder pre-cap. A pre-cap (reverted, Greptile
      // #1723) truncated `knownTo` MEMBERSHIP: if A learned fact X long ago (sliced off A's capped list)
      // and B learned it recently, the group would record `knownTo: [B]` only, and the FE wall would then
      // DROP a legitimate A sentence voicing X — a false hold on real speech (ADR 0005 #1, worse than a
      // missed phantom). The final POST-grouping `SCOPE_MANIFEST_CAP` bounds the manifest's DISTINCT-fact
      // count WITHOUT dropping any holder from a surviving fact. The read is fetched once per turn and
      // TTL-cached FE-side, and total knowledge is bounded by season length, so the O(total) scan is fine.
      for (const f of this.npcKnowledge.known(id)) {
        // The Diary-Room OOC class is `sealedFromHouse`'s job (empty holder set); never here.
        if (f.pathway === NO_NPC_PATHWAY) continue;
        const raw = (f.content ?? "").trim();
        if (!raw) continue;
        const key = f.factId ?? raw.toLowerCase().replace(/\s+/g, " ");
        const g = groups.get(key);
        if (g) {
          g.holders.add(id);
          if ((f.ts ?? 0) > g.ts) g.ts = f.ts ?? g.ts;
        } else {
          groups.set(key, { content: this.humanize(raw).trim(), raw, holders: new Set([id]), ts: f.ts ?? 0 });
        }
      }
    }
    const out: Array<SealedFact & { ts: number }> = [];
    for (const g of groups.values()) {
      if (!g.content) continue;
      // Public facts the whole living house holds have no non-holder to leak them — nothing to guard.
      let bounded = false;
      for (const id of universe) if (!g.holders.has(id)) { bounded = true; break; }
      if (!bounded) continue;
      // Holder DISPLAY NAMES — the FE guard matches a staged speaker by name.
      const knownTo = [...g.holders].map((id) => this.nameOf(id));
      out.push({ content: g.content, knownTo, ts: g.ts });
    }
    // Most-recent first, capped — a backstop guard needs the live secrets, not the whole history.
    out.sort((a, b) => b.ts - a.ts);
    return out.slice(0, GameSessionAdapter.SCOPE_MANIFEST_CAP).map(({ content, knownTo }) => ({ content, knownTo }));
  }

  /**
   * The portrait prompt for one houseguest by id (0051) — Vault-free. Built from PUBLIC appearance
   * facets only + the per-season style anchor. No stats, soul, or hidden element ever reaches the prompt.
   *
   * Serves the LIVE house when a season runs. PRE-GAME it falls back to the WARMED pre-seed cast
   * (0065/ADR 0013, 2026-07-13): the pre-game `recordCastProfile` write-backs mutate the prewarm
   * store, so the FE's per-NPC authored shoot must fetch the prompt AS THE STORE STANDS when that
   * houseguest's authoring gate fires — never a snapshot captured before authoring landed (a face
   * shot from a stale captured prompt is exactly the identity-mismatch ADR 0013 forbids). Returns
   * null when neither a live house nor a warmed cast holds the id.
   */
  getPortraitPrompt(id: EntityId): { houseguestId: string; name: string; prompt: string } | null {
    if (this.house && this.portraitStyleAnchor) {
      const npc = this.house.npcs.find((n) => n.id === id);
      const subject = id === this.house.player.id ? this.house.player : npc;
      if (!subject) return null;
      // #529: the human authors no look, so the player's appearance stays empty — NEVER improvise a
      // player portrait from a name hash. With no authored appearance (and no structured facet), there
      // is nothing to draw, so emit no prompt at all rather than a fabricated one.
      if (id === this.house.player.id
        && !subject.character.appearance
        && subject.character.physicalCharacteristics === undefined) {
        return null;
      }
      return this.portraitPromptFor(subject, this.portraitStyleAnchor);
    }
    // Pre-game: the warmed pre-seed roster (NPCs only — no player exists yet). Same builder, same
    // public facets, the warm's own anchor — Vault-free by the same construction as the live path.
    if (this.prewarm) {
      const warmed = this.prewarm.npcs.find((n) => n.id === id);
      if (warmed) return this.portraitPromptFor(warmed, this.prewarm.portraitStyleAnchor);
    }
    return null;
  }

  /** The shared Vault-free prompt build for one subject (live or prewarm) — PUBLIC facets only. */
  private portraitPromptFor(
    subject: { id: EntityId; name: string; character: GameHouse["npcs"][number]["character"] },
    styleAnchor: string,
  ): { houseguestId: string; name: string; prompt: string } {
    return buildPortraitPrompt(
      subject.id,
      subject.name,
      {
        appearance: subject.character.appearance,
        age: subject.character.age,
        presentation: subject.character.presentation,
        ...(subject.character.physicalCharacteristics !== undefined
          ? { physicalCharacteristics: subject.character.physicalCharacteristics } : {}),
        // 0063: feed the PUBLIC diversity + personality facets so the shot is uniquely this person — the
        // heritage (an authentic likeness), how they present, and their observable demeanor (vibe/energy).
        // A PRIVATE orientation is NEVER read here (it lives in the engine-only map, not on the Character),
        // so it can never enter a prompt — the §5 Vault rule holds by construction.
        ...(subject.character.ethnicity !== undefined ? { ethnicity: subject.character.ethnicity } : {}),
        ...(subject.character.genderPresentation !== undefined ? { genderPresentation: subject.character.genderPresentation } : {}),
        ...(subject.character.demeanor !== undefined ? { demeanor: subject.character.demeanor } : {}),
        // The AUTHORED storyline facets (2026-07-13) — both PUBLIC HouseguestCard fields: the 0116
        // freeform identity + the L28/0058 vocation, so the shot's wardrobe/vibe match the person's
        // actual storyline (owner report: portraits didn't match storylines/aesthetics).
        ...(subject.character.identityConcept !== undefined ? { identityConcept: subject.character.identityConcept } : {}),
        ...(subject.character.vocation !== undefined ? { vocation: subject.character.vocation } : {}),
      },
      styleAnchor,
    );
  }

  /**
   * The deep-profile write-back seam (feature 0058 / ledger L28b) — the FE producer-LLM authors a
   * houseguest's rich §3 profile and writes it BACK here so the ENGINE becomes the airtight source of
   * truth (mirrors the 0051 portrait handshake). NOW LIVE: it validates (non-player-mirroring),
   * SPLITS across the Vault Wall (PUBLIC biography/physical facet → the byte-stable Character; HIDDEN
   * secrets/goals/weakness/Day-1 perception → the engine-only deep layer + the Vault), re-derives the
   * story threads, re-seeds the NPC→player edge from the new Day-1 read, and re-indexes for full
   * recall — REPLACING the seeded floor for that houseguest (idempotent; no stale/duplicated records).
   *
   * The split is ENFORCED by construction: the result reports PUBLIC and HIDDEN field NAMES on separate
   * lists and NEVER echoes a hidden value — so the seam can never become a wall leak (§8). Any field the
   * author omits keeps its prior (seeded) value, so the profile always stays complete.
   */
  recordCastProfile(req: RecordCastProfileReq): RecordCastProfileResult {
    // 0065: the authored profile lands on the PRE-WARMED cast pre-game (the cast is generated before the
    // player finishes the interview — `preSeedCast` → `prewarm`), or on the live house once a season is
    // running (e.g. a season-2 re-author). Same split/seal logic either way; the only difference is which
    // store holds the cast + which name guards the non-mirroring check (the live player, or the intake name).
    const ctx = this.house
      ? {
        npcs: this.house.npcs, playerName: (this.house.player.name ?? "").trim(), prewarm: false,
        profiles: this.deepProfiles,
        getThreads: (): StoryThread[] => this.storyThreads,
        setThreads: (t: StoryThread[]): void => { this.storyThreads = t; },
      }
      : this.prewarm
      ? {
        npcs: this.prewarm.npcs, playerName: (this.intake.playerName ?? "").trim(), prewarm: true,
        profiles: this.prewarm.deepProfiles,
        getThreads: (): StoryThread[] => this.prewarm!.storyThreads,
        setThreads: (t: StoryThread[]): void => { this.prewarm!.storyThreads = t; },
      }
      : null;
    if (!ctx) return { accepted: false, publicFields: [], hiddenFields: [], reason: "no game started" };
    const target = ctx.npcs.find((n) => n.id === req.houseguestId);
    if (!target) return { accepted: false, publicFields: [], hiddenFields: [], reason: "unknown houseguest" };

    // Validate — non-player-mirroring (L28 + the anti-sycophancy mandate #3): the cast is INDEPENDENT
    // of the player, so NEITHER the authored PUBLIC material NOR the hidden STORYLINE material (secrets,
    // true goals, weakness) may be built around the player — an NPC's drama must not echo the player's
    // name. This is the airtight guard: even if an authoring model ignores the prompt and weaves the
    // player into an NPC's secret/goal/weakness, the engine refuses it here so no player-centric story
    // material is ever sealed. The Day-1 read of the player is the ONE legitimately player-facing field
    // and is excluded from this check (the engine owns its seeded value regardless). Vault-safe: the
    // refusal echoes no authored value. (A short player name is ignored to avoid false positives.)
    const playerName = ctx.playerName;
    const mentionsPlayer = (text: string): boolean =>
      playerName.length >= 3 && text.toLowerCase().includes(playerName.toLowerCase());
    // The authored voice (0084 widening) is a PUBLIC facet too — its text joins the mirror guard so a
    // model that weaves the player into the idiolect ("always brings up <player>") is refused whole.
    const voiceGuardText = req.voice !== null && typeof req.voice === "object"
      ? Object.values(req.voice as unknown as Record<string, unknown>).flat().filter((x): x is string => typeof x === "string").join(" ")
      : "";
    const publicText = `${req.biography ?? ""} ${req.physicalCharacteristics ? Object.values(req.physicalCharacteristics).join(" ") : ""} ${voiceGuardText}`;
    const storylineText = `${(req.secrets ?? []).join(" ")} ${(req.trueGoals ?? []).join(" ")} ${req.weakness ?? ""}`;
    if (mentionsPlayer(publicText) || mentionsPlayer(storylineText)) {
      return { accepted: false, publicFields: [], hiddenFields: [], reason: "authored profile mirrors the player" };
    }

    // CROSS-CHARACTER guard (RCA hardening, mirrors `mentionsPlayer`): authored HIDDEN storyline prose
    // (secrets / true goals / weakness / Day-1 read) may name an NPC's OWN ex / colleague / rival from
    // BEFORE the house (a genuinely-external person the engine doesn't model) — that is legitimate and
    // stays. What it must NOT do is name ANOTHER CURRENT houseguest: the engine models inter-houseguest
    // dynamics through the relationship layer, not through one NPC's authored secret, so a cross-character
    // claim baked into a sealed thread ("npc:5's secret is that they're plotting with <peer name>") would
    // be an ungrounded board assertion the engine never produced (anti-sycophancy #3). We strip any
    // storyline FIELD that names a peer (fall back to the seeded floor for that field — the profile stays
    // complete) rather than failing the whole call. Word-boundary match on each OTHER houseguest's current
    // display name (length floor like the player guard, to avoid false positives on a one-syllable name).
    const peerNames = ctx.npcs
      .filter((n) => n.id !== target.id)
      .map((n) => (n.name ?? "").trim())
      .filter((nm) => nm.length >= 3);
    const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const mentionsOtherHouseguest = (text: string): boolean => {
      if (!text) return false;
      return peerNames.some((nm) => new RegExp(`\\b${escapeRe(nm)}\\b`, "i").test(text));
    };
    // Sanitize each authored HIDDEN storyline field: drop it (⇒ fall back to the seeded floor below) when it
    // names another current houseguest. An ARRAY field is dropped wholesale if ANY element names a peer (a
    // single cross-character line poisons the field; the seeded floor is coherent and complete). `undefined`
    // means "the author supplied nothing" AND "the author supplied a peer-naming value we refuse" alike — the
    // `next` merge already treats `undefined` as "keep the prior/floor value", so this is the natural fallback.
    const safeSecrets = req.secrets !== undefined && !req.secrets.some(mentionsOtherHouseguest) ? req.secrets : undefined;
    const safeGoals = req.trueGoals !== undefined && !req.trueGoals.some(mentionsOtherHouseguest) ? req.trueGoals : undefined;
    const safeWeakness = req.weakness !== undefined && !mentionsOtherHouseguest(req.weakness) ? req.weakness : undefined;
    const safePerception = req.dayOnePerception !== undefined && !mentionsOtherHouseguest(req.dayOnePerception)
      ? req.dayOnePerception : undefined;

    // Field NAMES only — never the values (a hidden value must never ride out on the result, §8). The hidden
    // list reports what was actually SEALED, so a peer-naming field that was refused above is not listed.
    // `biography` is pushed CONDITIONALLY below (T0-6: it may be dropped whole by the closed-facet guard),
    // mirroring the "name" field's conditional push a few lines down — `physicalCharacteristics` always
    // folds (per-field reverted, never dropped wholesale) so it stays unconditional here.
    const publicFields = (["physicalCharacteristics"] as const).filter((f) => req[f] !== undefined) as string[];
    const hiddenFields = ([
      ["secrets", safeSecrets], ["trueGoals", safeGoals], ["weakness", safeWeakness], ["dayOnePerception", safePerception],
    ] as const).filter(([, v]) => v !== undefined).map(([f]) => f);

    // (0) PUBLIC NAME — the LLM-authored, real-sounding replacement display name. Accept it ONLY if it is a
    // reasonable two-token human name AND it does not collide (case-insensitive) with any OTHER current
    // houseguest or the player; otherwise the seeded corpus name (the deterministic floor) simply stands.
    // A rejected name NEVER fails the whole call — the rest of the authored profile still applies.
    //
    // A1 (ship-blocker, "the phantom-houseguest root"): a PUBLIC name is structurally FROZEN the instant
    // the player has been introduced to this houseguest (`introducedNames`, populated by
    // `markHouseguestMet`) — never on the prewarm/pre-game path (that set is always empty pre-game).
    // `recordCastProfile` is an FE-driven write-back that can complete ASYNCHRONOUSLY relative to
    // premiere narration (deep cast-authoring kicked off in the background at season start, or an even
    // later authoring backfill) — without this guard a late-arriving authored name silently RENAMES a
    // houseguest the player already met and was told the name of, and the GM then reads as "correcting"
    // the player about the game's own prior words. This is enforced HERE, structurally, not by timing
    // the FE's background call — the smaller, surgical fix over trying to serialize an inherently
    // best-effort background task ahead of narration.
    if (req.name !== undefined && this.introducedNames.has(target.id)) {
      // Silently drop — mirrors the cross-character guard's per-field drop above: the rest of the
      // authored profile still applies, only the name is refused so the seeded/already-shown name stands.
    } else if (req.name !== undefined) {
      const name = req.name.trim();
      const collides = name.toLowerCase() === ctx.playerName.toLowerCase()
        || ctx.npcs.some((n) => n.id !== target.id && (n.name ?? "").trim().toLowerCase() === name.toLowerCase());
      if (isReasonableName(name) && !collides) {
        target.name = name;
        publicFields.push("name");
      }
    }

    // (1) PUBLIC fold onto the byte-stable Character — these cross to the player.
    // OCCUPATION/VOCATION LOCKSTEP (#849): the public `vocation` is the job the player reads — and the
    // hidden secret STAKE is keyed off it (deepProfile's `sectorOf(vocation)`). The authoring LLM can
    // re-write the public cover (biography → a NEW occupation) without re-grounding `vocation`, leaving
    // the seeded hidden stakes keyed to the OLD job (the Producer's-Vault audit: a "court reporter" bio
    // over business-owner stakes). So when the author supplies a new `vocation`, fold it onto the public
    // Character FIRST — in lockstep with the biography — so both public facets agree AND the seeded-floor
    // re-derive below (step 2) reads the corrected occupation. A blank/non-string value is ignored (the
    // seeded `vocation` stands). Trim to a clean noun phrase; the cast-mirror guard already ran above on
    // the biography (the occupation noun is too short to meaningfully mirror a player name).
    const priorVocation = target.character.vocation;
    if (typeof req.vocation === "string" && req.vocation.trim().length > 0) {
      target.character.vocation = req.vocation.trim();
      if (target.character.vocation !== priorVocation) publicFields.push("vocation");
    }
    // Did the occupation the player infers actually change? Drives the hidden-stake re-ground in step 2.
    const occupationChanged = target.character.vocation !== priorVocation;
    // T0-6 — the ONE generic closed-facet-diff validator (`src/engine/facetDiff.ts`) replaces the
    // hand-rolled, ink-only inline guard that used to live here (the 2026-07-21 #1768 INK-BUDGET
    // backstop). It is table-driven (a future closed facet is one registry row, never a new bespoke
    // guard) and — unlike the old guard — ALSO covers the authored BIOGRAPHY: a tattoo mention smuggled
    // into the prose used to bypass the physicalCharacteristics-only check entirely. Run it against
    // whichever fields the author actually supplied (either may be `undefined` on a partial call).
    const priorPhysical = target.character.physicalCharacteristics;
    const facetGuard = applyClosedFacetGuard(priorPhysical, req.physicalCharacteristics, req.biography);
    // T9 (owner resiliency ruling): the demoted per-facet INK_RE guard survives as an ALARMED MONITOR —
    // a canary proving the generic validator above is doing its job. It never corrects anything itself.
    monitorLegacyInkGuard(
      target.id, priorPhysical, facetGuard.physicalCharacteristics,
      facetGuard.dropBiography ? undefined : req.biography,
    );
    if (req.biography !== undefined && !facetGuard.dropBiography) {
      target.character.biography = req.biography;
      publicFields.push("biography");
    }
    if (req.physicalCharacteristics !== undefined) {
      target.character.physicalCharacteristics = facetGuard.physicalCharacteristics as typeof req.physicalCharacteristics;
      // 0063 RE-GROUND (the "olive-skin collapse" fix, 2026-06-23): the FE authoring LLM re-authors the
      // WHOLE physicalCharacteristics block — including skinTone — but it is NOT given the houseguest's
      // guaranteed heritage, so it reliably defaults skinTone to a generic "olive" and silently discards
      // the engine's ethnicity-grounded, diversity-floored complexion. The diversity floor is an ENGINE
      // GUARANTEE (text + portrait must agree with the seeded heritage, 0063 §3.2), so the engine — not
      // the LLM — owns skinTone: overwrite the authored value back to the grounded cue. Prefer the live
      // `groundedSkinTones` map (set by seedDiversity); fall back to deriving it from the houseguest's
      // own ethnicity label (covers a post-restart author when the transient map is empty). The LLM still
      // authors all the OTHER facets (build/hair/features/mark/style/ageLook) freely.
      const grounded = this.groundedSkinTones[target.id]
        ?? ALL_ETHNICITIES.find((e) => e.heritage === target.character.ethnicity)?.skinTone;
      if (grounded) target.character.physicalCharacteristics.skinTone = grounded;
    }
    // VOICE (0084 / the 2026-07-11 expressive-e2e widening): fold the authored idiolect/voice
    // fingerprint ONLY when it is a complete, well-formed profile (`sanitizeAuthoredVoice` — voice is
    // IDENTITY, owner ruling 2026-06-25: replaced whole at the season-start authoring upgrade or not at
    // all, never spliced). Partial/malformed ⇒ dropped, the seeded deterministic voice stands — exactly
    // the name/vocation per-field-drop rule, never a whole-call failure. PUBLIC + Vault-free (the roster
    // card's `voice` clause re-derives from it via `voiceFingerprint`); NEVER outcome math — no stat,
    // lean, or hidden weight is touched, so the anti-sycophancy calibration (juryReach) is untouched.
    if (req.voice !== undefined) {
      const authoredVoice = sanitizeAuthoredVoice(req.voice);
      if (authoredVoice) {
        target.character.voice = authoredVoice;
        publicFields.push("voice");
      }
    }
    // #1067 — MARK the season-start floor→authored UPGRADE of the PUBLIC deep-profile facets. The seeded
    // floor (`seedDeepProfiles`) sets `biography`/`physicalCharacteristics`/`vocation` to a placeholder and
    // the orchestrator persists it as the byte-stable baseline; this write-back replaces them with a richer
    // authored version. Replacing a byte-stable Character facet would otherwise read as DEGRADATION at the
    // 0031 checkpoint (the live-verify's "integrity checkpoint failed (degradation)" refusals — #1067) even
    // though it ACCRETES detail. The provenance flag (persisted in the snapshot, read by `isSuperset`) makes
    // the upgrade a SANCTIONED one-way transition — never a hole in non-degradation: once authored, the bio
    // is byte-stable forever and a later thinning is still refused. Set whenever a public facet is authored.
    if (req.biography !== undefined || req.physicalCharacteristics !== undefined
        || (typeof req.vocation === "string" && req.vocation.trim().length > 0)) {
      target.character.deepProfileAuthored = true;
    }

    // (2) HIDDEN: merge the authored fields over the prior profile so it stays complete. The prior is
    // the seeded floor (always present after seedDeepProfiles; regenerate deterministically if missing).
    // The author supplies the Day-1 read as PROSE only — the engine KEEPS the calibrated seeded leans
    // (anti-sycophancy: the LLM authors flavor, never the hidden weights; this also preserves the
    // net-zero perception balance the juryReach gate depends on). Only the read TEXT is authored.
    // The CHARACTER-CONDITIONED seeded floor (P1): coherent off the target's own archetype/vocation/age
    // (never the player). The narrative text rides a DEDICATED sub-stream (#392 RNG-isolation), matching
    // the cast-layer key so the fallback agrees with it.
    const seededFloor = (): DeepProfile => generateDeepProfile(
      new SeededRandom(hashSeed(`${this.gameSeed ?? 0}:deep-hidden:${target.name}`)),
      undefined,
      target.character,
      hashSeed(`${this.gameSeed ?? 0}:deep-narrative:${target.name}`),
    );
    // #849 RE-GROUND: when the occupation changed, the EXISTING seeded floor (in `ctx.profiles`) was
    // composed off the OLD vocation, so its secrets/goals/weakness cohere with the WRONG job. Re-derive
    // the floor off the now-corrected `target.character` so any hidden field the author leaves to the
    // engine reads like the occupation the player will infer. The re-derive is TEXT-ONLY by construction:
    // vocation feeds only deepProfile's isolated narrative stream (#392), so the calibrated Day-1 leans
    // are byte-identical — and we carry the PRIOR `dayOnePerception` across regardless, so the move-in
    // NPC→player edge (the juryReach calibration) is provably untouched.
    const prior: DeepProfile | undefined = ctx.profiles[target.id];
    const prev: DeepProfile = occupationChanged
      ? { ...seededFloor(), dayOnePerception: (prior ?? seededFloor()).dayOnePerception }
      : (prior ?? seededFloor());
    const next: DeepProfile = {
      secrets: safeSecrets ?? prev.secrets,
      trueGoals: safeGoals ?? prev.trueGoals,
      weakness: safeWeakness ?? prev.weakness,
      dayOnePerception: safePerception !== undefined
        ? { ...prev.dayOnePerception, read: safePerception }
        : prev.dayOnePerception,
    };
    ctx.profiles[target.id] = next;

    // (3) Re-derive THIS source's story threads (replace), deterministic off the name. The NPC→player
    // edge keeps its seeded lean (the engine owns the numbers — see above), so no edge re-seed here.
    const thrRng = new SeededRandom(hashSeed(`${this.gameSeed ?? 0}:deep-thread-authored:${target.name}`));
    ctx.setThreads(ctx.getThreads().filter((t) => t.sourceId !== target.id)
      .concat(deriveStoryThreads(thrRng, target.id, next)));

    // (4) Full-fidelity recall (L27b): replace the prior deep-profile note in the authoritative soul
    // memory (engine-only; never crosses) so the authored detail is recall-able in full and persists +
    // re-indexes on restore. Also index it NOW for same-session recall.
    // The note to REPLACE is the one ACTUALLY stored — the genuine prior profile (`prior`), NOT the
    // possibly re-grounded floor in `prev`: when the occupation changed, `prev` is the re-derived floor
    // and would not match the stored note, so we'd leak a stale old-vocation note (a non-degradation
    // regression). Anchoring on `prior` keeps the swap idempotent. (`prior` undefined ⇒ nothing to
    // replace, so the new note is appended below — same as a first-time seal.)
    const oldNote = deepProfileToVaultContent(target.id, prior ?? prev);
    const newNote = deepProfileToVaultContent(target.id, next);
    const idx = target.soul.memory.lastIndexOf(oldNote);
    if (idx >= 0) {
      // R3 — the ONLY in-place same-length memory write. Swap the array REFERENCE (not just the slot)
      // so the snapshot clone cache's `(ref,len)` reuse key invalidates and the authored note is not
      // lost behind a stale clone. The replacement is content-preserving in spirit (re-derived authored
      // detail, never a deletion), so non-degradation still holds.
      target.soul.memory = target.soul.memory.slice();
      target.soul.memory[idx] = newNote;
    } else {
      target.soul.memory.push(newNote);
    }
    this.soul?.recordToSoul(target.id, newNote);

    // (5) Re-seal into the Vault — REPLACING this subject's prior profile + thread records (idempotent).
    this.onResealProfile?.(target.id, next, ctx.getThreads().filter((t) => t.sourceId === target.id));

    // PERSIST — through the BACKGROUND seam on BOTH paths (the 2026-07-13 prod deadlock fix). A LIVE
    // authored profile (#1067) is a SEASON-START FE-driven enrichment of byte-stable IDENTITY facets,
    // exactly like the 0062 `recordWorldSnapshot` zeitgeist write-back: it must persist DURABLY but must
    // NOT bump the closed-set `beatSeq` or run the integrity checkpoint. Previously the live path persisted
    // NOTHING here and relied on a later, unrelated player-turn commit to flush it — which (a) could
    // silently drop the write if no commit followed, and (b) made that commit's checkpoint compare the
    // authored biography against the floor baseline and REFUSE the whole turn as degradation (the
    // live-verify's "integrity checkpoint failed (degradation)" losses). Routing through
    // `backgroundPersist` blind-saves the upgrade without a checkpoint (like the zeitgeist), and the
    // `deepProfileAuthored` provenance flag lets the NEXT genuine player-turn commit's `isSuperset`
    // recognize the floor→authored facet change as a sanctioned upgrade rather than a regression.
    //
    // The PRE-GAME (prewarm) path is the SAME enrichment class and must ride the SAME seam. It used to
    // route through `persist()` — the orchestrator's CHECKPOINTED player-turn commit — and step (5)'s
    // re-seal REPLACES this subject's derived story threads in the Vault: an authored profile with FEWER
    // secrets than the seeded floor derives fewer `thread:<id>:<n>` records, so `thread:` Vault ids
    // vanish against the post-genesis baseline ⇒ a DETERMINISTIC `TurnRefusedError (degradation)` on
    // every 0116-flow pre-create write-back (the 2026-07-13 prod deadlock: authoring could never land,
    // the #1313 house-entry hold starved forever, and the fault streak opened the corruption circuit).
    // The replacement is the sanctioned floor→authored accretion, not memory-thinning — the checkpoint
    // byte-compare simply cannot see that pre-game (prewarm NPCs are not in the GameState projection;
    // only the Vault ids are), so the background seam (blind durable save + `seedBaseline` re-seed, the
    // #1067/R-BND discipline) is the correct one here too. Non-degradation is intact: once the season
    // starts, every commit checkpoints against the authored baseline as before. On a STANDALONE adapter
    // (tests, the 0065 next-season scratch) `backgroundPersist` falls back to `onPersist` — byte-identical.
    this.backgroundPersist();

    return { accepted: true, publicFields: [...publicFields], hiddenFields: [...hiddenFields], reason: "authored profile sealed (live)" };
  }

  /**
   * The AI-driven cast-identity write-back (issue #544 — the deferred AI half of the 0063 diversity floor).
   * The FE producer-LLM PROPOSES the whole cast's DESCRIPTIVE identity facets (heritage / gender
   * presentation / orientation / disclosure / age) targeting U.S.-population rates; this RUNS them through
   * the engine's `repairDiversityLayer` (the SAME floors/caps/weighted-expectation as the seeded floor), so
   * even a lazy/biased/monochrome proposal is REPAIRED to a realistic cast before anything folds. The PUBLIC
   * facets fold onto the byte-stable Characters; `skinTone` is RE-GROUNDED from the FINAL heritage (the PR
   * #527 hinge, so text + portrait agree); each PRIVATE orientation is rebuilt + re-sealed into the Vault.
   *
   * Lands on the PRE-WARMED cast pre-game (the common case — replaces the seeded identity floor BEFORE deep
   * authoring shoots portraits) or the live house once a season runs (same fold either way). Idempotent. The
   * HARD BOUNDARY: only descriptive identity facets are touched — NEVER a hidden game weight (the seeded
   * Day-1 read / competition leans stay engine-owned; anti-sycophancy #3 + the juryReach calibration depend
   * on the net-zero-balanced seed). Calibration-neutral: the layer rides the SAME isolated descriptive
   * sub-streams as the floor, never a competition/vote input (the #338 golden test stays the proof). With NO
   * proposal the engine never receives this call and the deterministic floor stands.
   */
  recordCastIdentity(req: RecordCastIdentityReq): RecordCastIdentityResult {
    // Resolve the target cast + its seed: the live house (a season is running) or the pre-warmed holding
    // store (the common pre-game case). Same fold logic either way; only the npcs/seed/maps differ. (Mirrors
    // the recordCastProfile ctx split.)
    const ctx = this.house && this.gameSeed !== null
      ? {
        npcs: this.house.npcs, seed: this.gameSeed, prewarm: false,
        setPrivate: (m: Record<EntityId, Orientation>): void => { this.privateOrientations = m; },
        setGrounded: (id: EntityId, tone: string): void => { this.groundedSkinTones[id] = tone; },
      }
      : this.prewarm
      ? {
        npcs: this.prewarm.npcs, seed: this.prewarm.seed, prewarm: true,
        setPrivate: (m: Record<EntityId, Orientation>): void => { this.prewarm!.privateOrientations = m; },
        setGrounded: (id: EntityId, tone: string): void => { this.prewarm!.groundedSkinTones[id] = tone; },
      }
      : null;
    if (!ctx) return { accepted: false, applied: 0, reason: "no cast to fold identity onto" };

    // Map the LOOSE port facets → the engine's STRICT proposal shape. Unrecognized values are dropped HERE
    // (and again, defensively, inside repairDiversityLayer) so the engine never trusts a bad value — the
    // floors/caps then guarantee realism regardless. The proposal is DESCRIPTIVE-ONLY by type: there is no
    // field on it for a hidden weight, so a model can never author the Day-1 read / competition leans.
    const known = new Set(ctx.npcs.map((n) => n.id));
    const proposed: Record<EntityId, ProposedIdentityFacets> = {};
    for (const [rawId, raw] of Object.entries(req.facets ?? {})) {
      const id = rawId as EntityId;
      if (!known.has(id) || typeof raw !== "object" || raw === null) continue;
      const f = raw as ProposedCastIdentityFacets;
      const one: ProposedIdentityFacets = {};
      if (typeof f.ethnicity === "string" && f.ethnicity.trim()) one.ethnicity = f.ethnicity.trim();
      if (f.genderPresentation === "man" || f.genderPresentation === "woman" || f.genderPresentation === "nonbinary") {
        one.genderPresentation = f.genderPresentation;
      }
      if (typeof f.orientation === "string" && f.orientation.trim()) one.orientation = f.orientation.trim() as Orientation;
      if (typeof f.out === "boolean") one.out = f.out;
      if (typeof f.age === "number" && Number.isFinite(f.age)) one.age = f.age;
      if (Object.keys(one).length > 0) proposed[id] = one;
    }

    // Validate + REPAIR the whole-cast proposal against the proportional targets (diversityConstants.ts).
    // Off the SAME dedicated, isolated sub-stream the floor uses (forked off the cast seed via hashSeed
    // inside repairDiversityLayer) — never the shared house/competition/vote stream. An EMPTY proposal makes
    // this byte-identical to the seeded floor (the deterministic no-model path).
    const layer = repairDiversityLayer(ctx.seed, ctx.npcs, proposed);

    // PUBLIC fold — onto the byte-stable Character (mirrors seedDiversity's fold). `skinTone` comes from the
    // FINAL (possibly repaired) heritage, so text + portrait agree (the PR #527 / 0063 §3.2 hinge). The
    // engine — not the model — owns skinTone here too.
    let applied = 0;
    for (const n of ctx.npcs) {
      const pub = layer.public[n.id];
      if (!pub) continue;
      n.character.ethnicity = pub.ethnicity;
      n.character.genderPresentation = pub.genderPresentation;
      // A houseguest may have FLIPPED out↔private on a re-fold: set the public out facet when present, and
      // CLEAR it otherwise (a now-private orientation must never linger on the public Character).
      if (pub.outOrientation !== undefined) n.character.outOrientation = pub.outOrientation;
      else delete n.character.outOrientation;
      n.character.age = pub.age;
      ctx.setGrounded(n.id, pub.skinTone);
      if (n.character.physicalCharacteristics) n.character.physicalCharacteristics.skinTone = pub.skinTone;
      // #1140 — apply the gender-coherent re-pick directly: a recordCastIdentity fold lands on an
      // ALREADY-BUILT cast (the name-keyed deep layer is already seeded), so there's no re-seeding to defer —
      // writing the name now closes the UNCAPPED, UNFLAGGED AI-override hole (a proposal could flip the facet
      // off the name and leave the portrait rendering the name's gender). The given-name token is swapped to
      // the final presentation, surname kept, so name + portrait + narration read the same gender. (The
      // display name lives on the Houseguest wrapper — `n.name` — not on the static Character.)
      if (pub.name !== undefined) n.name = pub.name;
      if (proposed[n.id]) applied++;
    }

    // HIDDEN — rebuild the AUTHORITATIVE private-orientation map (engine-only; the in-memory map drives
    // 0059 showmance eligibility + persists in the snapshot, never the Vault audit copy). The private-
    // orientation soul note is PER-HOUSEGUEST idempotent: for every NPC, drop any STALE prior note (a re-fold
    // may CHANGE the orientation, or flip private→public), then add the current note iff the NPC is now
    // private. This keeps recall lossless without piling up duplicate/stale notes (non-degradation: the note
    // is replaced in spirit, never silently dropped — the current truth is always present).
    const nextPrivate: Record<EntityId, Orientation> = { ...layer.privateOrientations };
    ctx.setPrivate(nextPrivate);
    const PRIVATE_NOTE_PREFIX = "private-orientation ";
    for (const n of ctx.npcs) {
      const orientation = nextPrivate[n.id];
      const note = orientation ? privateOrientationToVaultContent(n.id, orientation) : null;
      const stale = n.soul.memory.some((m) => m.startsWith(`${PRIVATE_NOTE_PREFIX}${n.id}:`) && m !== note);
      if (!stale && (note === null || n.soul.memory.includes(note))) continue; // already correct — no change
      // Swap the array REFERENCE (R3 clone-cache invalidation) and rewrite this NPC's private-orientation
      // note: keep all OTHER memory, drop this NPC's stale private note, append the current one (if private).
      n.soul.memory = n.soul.memory.filter((m) => !m.startsWith(`${PRIVATE_NOTE_PREFIX}${n.id}:`));
      if (note) {
        n.soul.memory.push(note);
        this.soul?.recordToSoul(n.id, note);
      }
    }
    // Re-seal the current private orientations into the Vault (engine-only audit copy; idempotent replace by
    // the private-orientation Vault id, so a re-fold overwrites rather than duplicates).
    const entries = Object.entries(nextPrivate).map(([id, orientation]) => ({ id: id as EntityId, orientation }));
    if (entries.length) this.onSealPrivateOrientations?.(entries);

    // A pre-game fold lands on `prewarm`, which is durable state — persist it. A LIVE fold (a season-2
    // re-author) is the SAME class as the #1067 `recordCastProfile` upgrade: it re-grounds byte-stable
    // public facets (e.g. `physicalCharacteristics.skinTone`) and re-seals the private orientation, so it
    // must persist DURABLY without a beatSeq bump or the integrity checkpoint — route it through
    // `backgroundPersist` (which re-seeds the non-degradation baseline) just like the profile write-back,
    // rather than relying on an unrelated later commit (which would refuse the skinTone change as degradation).
    if (ctx.prewarm) this.persist();
    else this.backgroundPersist();

    return { accepted: true, applied };
  }

  /**
   * Feature 0116 — the model-authored cast-genesis write-back. Validate the whole-cast SKELETON proposal
   * through the engine's envelope (`castGenesis.validateCastGenesis`) and fold the COMMITTED skeleton onto
   * the PRE-WARMED cast: names (validated, not pooled), the freeform identity (verbatim), the derived
   * archetype tag, the banded stats (no raw number escapes the clamp), the closed-kind C9-gated hidden
   * elements, the persona prose, and the sanity-validated pre-show tie graph. Generalizes ADR 0005 to
   * world-gen: identity is OPEN-set (recorded faithfully), power is CLOSED-set (engine-owned, banded,
   * clamped). Hidden game weights are never proposable (stripped + flagged); the descriptive 0063 identity
   * facets (ethnicity/gender/orientation/age) continue to route through the UNCHANGED `recordCastIdentity`
   * pipeline, not this call.
   *
   * A PRE-GAME operation ONLY (the §4 decided lifecycle: genesis runs async DURING the casting interview,
   * onto the `preSeedCast` warm). Refused once a season runs — never mutate a live cast's stats/identity
   * mid-game (the calibration/fairness hazard). Player-BLIND: the player NAME (from the in-flight intake)
   * feeds ONLY the post-hoc name near-duplicate NUDGE, never the accepted identity. Idempotent; durable
   * pre-game state (0030). With NO proposal this call is never made and the deterministic floor stands
   * (byte-neutral). Returns the structured, Vault-free violations for the bounded FE re-roll.
   */
  recordCastGenesis(req: RecordCastGenesisReq): RecordCastGenesisResult {
    // Refused mid-season: genesis is a pre-game operation (never mutate a live cast's stats/identity).
    if (this.house) {
      return { accepted: false, committed: 0, violations: [], varianceOk: true,
        reason: this.live?.finished ? "over" : "a season is already running" };
    }
    // Requires a pre-warmed cast to fold onto (preSeedCast mints + warms the deterministic floor first).
    if (!this.prewarm) {
      return { accepted: false, committed: 0, violations: [], varianceOk: true, reason: "no warmed cast — call preSeedCast first" };
    }
    const cast = this.prewarm;

    // The player-BLIND validation context, built from the warmed FLOOR cast (the per-NPC fallback source).
    // The in-flight intake NAME feeds ONLY the post-hoc name near-duplicate NUDGE — it is never woven into
    // any accepted identity (sycophancy-proof by construction). The player carries no vocation/hometown
    // facet in the current model, so the vocation+hometown nudge is dormant until that is added.
    const gctx: GenesisContext = {
      npcs: cast.npcs.map((n) => ({
        id: n.id, floorArchetype: n.character.archetype,
        floorStats: { ...n.character.stats }, floorName: n.name,
      })),
      playerId: PLAYER,
      ...(this.intake.playerName && this.intake.playerName.trim() ? { playerName: this.intake.playerName.trim() } : {}),
    };
    const result = validateCastGenesis(req as unknown as CastGenesisProposal, gctx);

    // Fold the committed skeleton onto each byte-stable warmed Character (the recordCastIdentity /
    // recordCastProfile per-field-fallback discipline): an absent committed field keeps the floor value,
    // so a proposal that failed a re-roll validator for one facet never breaks the whole houseguest.
    let committed = 0;
    for (const c of result.npcs) {
      const target = cast.npcs.find((n) => n.id === c.id);
      if (!target) continue;
      let touched = false;
      if (c.name !== undefined) { target.name = c.name; touched = true; }
      if (c.identityConcept !== undefined) { target.character.identityConcept = c.identityConcept; touched = true; }
      if (c.archetype !== undefined) { target.character.archetype = c.archetype; touched = true; }
      if (c.stats !== undefined) { target.character.stats = { ...c.stats }; touched = true; }
      if (c.hiddenElements !== undefined) { target.character.hiddenElements = c.hiddenElements; touched = true; }
      if (c.vocation !== undefined) { target.character.vocation = c.vocation; touched = true; }
      if (c.hometown !== undefined) { target.character.hometown = c.hometown; touched = true; }
      if (c.demeanor !== undefined) { target.character.demeanor = c.demeanor; touched = true; }
      if (c.background !== undefined) { target.character.background = c.background; touched = true; }
      // Authoring the biography over the floor placeholder is the same season-start UPGRADE as
      // recordCastProfile (#1067): mark the provenance so the 0031 superset check reads it as an
      // accretion, not degradation, once the cast goes live.
      if (c.biography !== undefined) { target.character.biography = c.biography; target.character.deepProfileAuthored = true; touched = true; }
      if (c.presentation !== undefined) { target.character.presentation = c.presentation; touched = true; }
      if (c.appearance !== undefined) { target.character.appearance = c.appearance; touched = true; }
      if (touched) committed++;
    }

    // F2 — re-cohere each committed given name against its pinned `genderPresentation` BY CONSTRUCTION,
    // right here after the model's NAMES land. `recordCastGenesis` folds the AI name but NEVER re-ran the
    // #1140 name↔gender re-pick — it relied ENTIRELY on the LATER, best-effort FE-driven `recordCastIdentity`
    // call to repair an incoherent name. When that identity call degrades (no utility model, or its reply
    // fails to parse — the exact gender-drop failure this branch also hardens), a clearly-wrong-gender name
    // ("Emma" on a man) shipped straight into the portrait + narration. Running the SAME re-pick machinery
    // the identity fold uses closes that hole even when the identity call never arrives. Idempotent: a later
    // `recordCastIdentity` fold re-runs the identical re-pick against the (possibly repaired) gender and
    // converges; a name that already coheres — every UNISEX name (coherent with any presentation) and every
    // nonbinary pin — is left untouched, so the deterministic floor cast is a byte-identical no-op.
    this.cohereGenesisNames(cast);

    // The validated tie graph → stored for `seedSeededRelationships` to prefer over the floor draw at
    // createCharacter (where the move-in edges exist, so TIE_AFFINITY_BIAS folds + the ties seal). The
    // seeded season brief + provenance ride the prewarm as the persisted world-gen artifact (mandate #4).
    this.genesisTies = result.ties;
    this.seasonBrief = generateSeasonBrief(cast.seed);
    this.genesisAuthored = true;
    cast.genesisTies = result.ties;
    cast.seasonBrief = this.seasonBrief;
    cast.genesisAuthored = true;

    this.persist(); // durable pre-game state (0030), exactly like preSeedCast / a prewarm recordCastIdentity fold

    const violations: GenesisViolationDTO[] = result.violations.map((v) => ({
      scope: v.scope, ...(v.npcId ? { npcId: v.npcId } : {}), field: v.field, rule: v.rule, action: v.action,
    }));
    return { accepted: true, committed, violations, varianceOk: result.varianceOk };
  }

  /**
   * F2 — re-pick any warmed given name that reads UNAMBIGUOUSLY as the OPPOSITE binary gender of its
   * pinned `genderPresentation`, keeping the surname, off a dedicated descriptive-only sub-stream (never
   * the outcome/vote stream — calibration-neutral, the `decollidePriorNames`/#1140 discipline). Only a
   * clear man↔woman mismatch is re-picked: a UNISEX name (coherent with ANY presentation) and a
   * `nonbinary` pin are left untouched, so nonbinary is never flattened and a coherent cast is a
   * byte-identical no-op. This is the SAME machinery `recordCastIdentity` runs, hoisted so gender
   * coherence holds BY CONSTRUCTION at genesis — not only if the later identity call succeeds.
   */
  private cohereGenesisNames(cast: PrewarmCast): void {
    const rng = new SeededRandom(hashSeed(`${cast.seed}:genesis-gender-cohere`));
    // Keep given names unique across the cast, mirroring the main-stream draw (a re-pick avoids collisions).
    const used = new Set<string>();
    for (const n of cast.npcs) used.add(n.name.split(" ")[0]!);
    for (const n of cast.npcs) {
      const gender = n.character.genderPresentation;
      if (gender !== "man" && gender !== "woman") continue; // only a binary pin can be contradicted by a name
      const parts = n.name.split(" ");
      const given = parts[0]!;
      const opposite = gender === "man" ? "woman" : "man";
      if (nameGenderOf(given) !== opposite) continue; // coherent (same-gender OR unisex) — leave the name
      used.delete(given); // free the wrong-gender given before picking its replacement
      const next = pickGivenNameFor(gender, rng, used);
      used.add(next);
      n.name = parts.length > 1 ? `${next} ${parts.slice(1).join(" ")}` : next;
    }
  }

  /** The season's public arc from the event record (0048) — Vault-free, stores-not-memory. */
  seasonRecap(): SeasonRecapView {
    const events = this.record?.events() ?? [];
    // The structural filter: ceremony beats land as `season:` events; deals/betrayal reveals are
    // their own recorded types. All player-witnessed by construction — this is the public record.
    const highlights = events
      .filter((e) => !e.hidden && (e.id.startsWith("season:") || e.type === "deal" || e.type === "betrayal"))
      .map((e) => e.content);
    return {
      started: this.house !== null,
      finished: !!this.live?.finished,
      winner: this.named(this.live?.winner),
      weeksPlayed: this.week,
      highlights,
      evicted: (this.live?.evictionOrder ?? []).map((id) => ({ id, name: this.nameOf(id) })),
      deals: this.deals.forParty(PLAYER).map((d) => this.dealView(d)),
      ...(this.alliances.forMember(PLAYER).length ? { alliances: this.playerAllianceViews() } : {}),
    };
  }

  /**
   * The Vault unsealing (0048 §1) — the Wall's ONE sanctioned exception, and THE GATE lives here:
   * a live (or unstarted) season returns null, enforced by the terminal state in code, never by
   * prompt. Post-season it returns the real story: every hidden event (off-screen scheming, NPC
   * confessionals, gossip) plus the producer's sealed twists — fired and unfired alike.
   */
  seasonRetrospective(): RetrospectiveView | null {
    if (!this.live?.finished) return null; // the structural gate: no finished season, no unsealing
    return this.buildVaultUnseal();
  }

  /**
   * DEBUG producer's vault — the owner-ruled OVERRIDE of mandate #2 (admin/God Mode is otherwise
   * walled from the Vault). This unseals the LIVE hidden layer for operator debugging WITHOUT the
   * post-season `finished` gate above: the ONE sanctioned LIVE Vault reveal, admin-channel only and
   * fired only behind an explicit FE "unseal" action, so it can never spoil a game by accident. It
   * reuses the retrospective render below, so every row is the same scrubbed, name-resolved plain
   * data (no raw ids/slugs). Returns null only when there is no game at all.
   */
  producerVaultDump(): RetrospectiveView | null {
    if (!this.live) return null;
    return this.buildVaultUnseal();
  }

  /** The shared Vault-unseal render used by BOTH the post-season retrospective and the debug dump. */
  private buildVaultUnseal(): RetrospectiveView {
    if (!this.live) throw new Error("buildVaultUnseal called without a live season");
    const nameOf = (id: EntityId): string => this.nameOf(id);
    const events = this.record?.events() ?? [];
    // #843 — a gossip/surfacing event's CONTENT is an internal breadcrumb (`gossip <pathway> reaches
    // <to>` / `surfaced to <entity> via <pathway>`), not the belief itself. Join each back to the
    // KnowledgeFact it lodged (by `sourceEventId`) so the dump shows the real, name-resolvable
    // paraphrase. Build the index ONCE from every houseguest's known facts (the recipient holds it).
    const beliefByEvent = new Map<string, string>();
    if (this.npcKnowledge && this.house) {
      for (const hg of [this.house.player, ...this.house.npcs]) {
        for (const f of this.npcKnowledge.known(hg.id)) {
          if (f.sourceEventId && !beliefByEvent.has(f.sourceEventId)) beliefByEvent.set(f.sourceEventId, f.content);
        }
      }
    }
    // The FE renders each row as "[type] content", so `type` must be a READABLE label (not a raw kind
    // slug) and `content` clean, name-resolved prose — this is the Wall's ONE sanctioned reveal, shown
    // readably (audit: the live dump leaked "[hidden-thread] story-thread thread:npc:8:0 …").
    const hiddenStory: Array<{ type: string; content: string; ts?: number }> = events
      .filter((e) => e.hidden)
      .map((e) => {
        // For a gossip/surfacing breadcrumb, prefer the joined belief (the concrete paraphrase) over the
        // internal "reaches <to>" plumbing; fall back to the scrubbed breadcrumb if no fact joined (#843).
        const belief = (e.type === "gossip" || e.type === "surfacing") ? beliefByEvent.get(e.id) : undefined;
        // #852 — carry the event's monotonic time marker so the dump can order chronologically.
        return { type: retrospectiveLabel(e.type), content: this.retroScrub(belief ?? e.content), ts: e.ts };
      });
    // The structured hidden layers (threads + seeded relationships) render from the IN-MEMORY objects,
    // not their engine-only Vault audit strings — so every id is a NAME and no machine slug crosses. They
    // are therefore SKIPPED below when iterating the Vault records (rendered here once, readably, instead).
    for (const t of this.storyThreads) {
      // #996 — label by SOURCE CLASS (secret → "Secret thread", weakness → "Blind spot", goal → "Real
      // game"), not a flat "Secret thread", so a houseguest's {secrets + weakness + goal} threads don't all
      // read as stacked contradictory secrets. The class is read off the premise tag; the prose body is
      // already class-naturalized by `storyThreadToRetrospectiveProse`.
      hiddenStory.push({ type: storyThreadLabel(t.premise), content: storyThreadToRetrospectiveProse(t, nameOf) });
    }
    // 0101/#1401 — the SHOWRUNNER's production bible unseals HERE (0048), the same Wall exception as the
    // threads above: each beat's producer note rendered readably from the IN-MEMORY notes — source NAMES
    // (public facts) + the class/position rationale, emphasis described qualitatively (never a premise,
    // never a raw number). Pre-finale this is unreachable (the retrospective gate returns null), so a note
    // never crosses to a live player/admin surface (the Vault-held boundary test proves it).
    const threadSourceName = (threadId: string): string => {
      const t = this.storyThreads.find((x) => x.id === threadId);
      return t ? nameOf(t.sourceId) : "a houseguest";
    };
    for (const snote of this.showrunnerNotes) {
      hiddenStory.push({ type: "Producer's note", content: showrunnerNoteToProse(snote, threadSourceName) });
    }
    // #847 — the deep profile's secrets / true-goals / weakness are ALSO the source of the secret
    // threads above (each thread is derived from one of them), so re-rendering the deep-profile blob would
    // print the same secret TWICE. The threads are the canonical, live (status-bearing) representation of
    // those three; the deep profile uniquely carries the houseguest's DAY-ONE READ OF THE PLAYER, which no
    // thread carries. So render the deep profile here as exactly that one non-duplicated, labeled line
    // (from the IN-MEMORY structured object, never the raw Vault string) — and skip its Vault record below.
    for (const [id, profile] of Object.entries(this.deepProfiles)) {
      const read = profile.dayOnePerception?.read?.trim();
      if (read) hiddenStory.push({ type: "Hidden side", content: `${nameOf(id)} — day-one read of you: ${read}` });
    }
    for (const tie of this.seededRels.ties) {
      hiddenStory.push({ type: "Hidden tie", content: preGameTieToRetrospectiveProse(tie, nameOf) });
    }
    for (const s of this.seededRels.showmances) {
      hiddenStory.push({ type: "Hidden tie", content: showmanceToRetrospectiveProse(s, nameOf) });
    }
    for (const r of this.record?.hidden() ?? []) {
      // Rendered structurally elsewhere: twists via `twists` below; threads + seeded relationships from
      // the structured objects above (their raw Vault strings carry ids/slugs we must not echo).
      if (r.kind === "reserved-twist" || r.kind === "hidden-thread" || r.kind === "seeded-relationship") continue;
      // #846/#847 — the deep-profile `hidden-attribute` blob is rendered structurally above (its day-one
      // read) and its secrets/goals/weakness live in the threads, so SKIP the raw blob to avoid the
      // semicolon run-on AND the double-printed secret. Other `hidden-attribute` records (e.g. a private
      // orientation) are NOT deep profiles — they keep rendering normally.
      if (r.kind === "hidden-attribute" && /^deep-profile\b/.test(r.content)) continue;
      hiddenStory.push({ type: retrospectiveLabel(r.kind), content: this.retroScrub(r.content) });
    }
    const fired = new Map((this.live.firedTwists ?? []).map((t) => [t.kind as string, t.beat]));
    // Legacy path: list the pre-scheduled reserve (fired or not). Reactive path (0025 redesign): the
    // pool is a standing plan with no pre-scheduled entries, so the retrospective lists what ACTUALLY
    // fired (`firedTwists`) — the "sealed twist that never fired" is simply absent, as it was invisible.
    const twists = this.live.reserve?.length
      ? this.live.reserve.map((t) => ({ kind: t.kind as string, firedWeek: fired.get(t.kind) ?? null }))
      : [
        ...[...fired].map(([kind, week]) => ({ kind, firedWeek: week })),
        // Reactive path, unsealed AFTER the crown (0048: "any unfired twist"): the twists the sealed plan had ARMED this season but the house never earned —
        // named with a null week, exactly like an unfired legacy reserve entry. (An unarmed one was never in play, so it is not listed.)
        ...this.armedUnfiredReactiveTwists(fired),
      ];
    // E12: the weekly secret ballots unseal HERE — and only here, behind the same terminal gate.
    const evictionVotes = (this.live.voteRecord ?? []).map((r) => ({
      week: r.week,
      evictee: { id: r.evictee, name: this.nameOf(r.evictee) },
      votes: Object.entries(r.voteOf).map(([voter, votedFor]) => ({
        voter: { id: voter as EntityId, name: this.nameOf(voter as EntityId) },
        votedFor: { id: votedFor, name: this.nameOf(votedFor) },
      })),
    }));
    // SG7/#1030: the finale jury vote unseals HERE — per-juror attribution, mirroring `evictionVotes`,
    // behind the same terminal gate. Read the already-tallied finale votes off the live state (juror →
    // finalist); never recomputed. Absent until the finale's vote stage has set `finale.votes`.
    const finale = this.live.finale;
    const juryVotes = finale?.votes
      ? {
          finalists: finale.finalists.map((id) => this.named(id)!),
          votes: Object.entries(finale.votes).map(([juror, votedFor]) => ({
            juror: this.named(juror as EntityId)!,
            votedFor: this.named(votedFor as EntityId)!,
          })),
        }
      : undefined;
    // #852 — order the dump CHRONOLOGICALLY. Pre-season setup (threads, seeded ties, the day-one reads,
    // sealed orientations) carries no event time marker, so it sorts FIRST (as setup); the live hidden
    // layer then follows by its monotonic `ts`. A stable sort keeps same-`ts` rows in assembly order.
    // (Week GROUPING is intentionally not attempted: events carry a monotonic tick, not a week number, so
    // reconstructing week boundaries here would be fragile — chronological order is the robust win.)
    const TS_FLOOR = Number.NEGATIVE_INFINITY;
    const ordered = hiddenStory
      .map((row, i) => ({ row, i }))
      .sort((a, b) => (a.row.ts ?? TS_FLOOR) - (b.row.ts ?? TS_FLOOR) || a.i - b.i)
      .map((x) => x.row);
    // #841/#842 — a pure render-time coalesce: drop byte-identical rows and collapse a symmetric
    // off-screen pair (A↔B) into one. After the chronological sort, the kept row is the EARLIEST.
    // Never changes what was recorded — only what the operator sees.
    // 0115 — the player's OWN Diary-Room confessionals, their side of the story, in the order they
    // recorded them. NOT a Vault read: it is the player's own `NO_NPC_PATHWAY` knowledge (it never
    // reached any NPC in life and does not now); surfaced here as the retrospective through-line.
    const playerConfessionals = (this.playerKnowledgeReader?.() ?? [])
      .filter((k) => k.pathway === NO_NPC_PATHWAY)
      .map((k) => k.content);
    // #1396 — the weekly pull-quote reel: a curated, BY-WEEK montage of the most notable Diary-Room lines
    // (the player's own AND the NPCs' confessionals). A PURE read-time selection over the SAME `events`
    // log the hidden story above reads — it draws no rng, records nothing, and mutates no state, so the
    // seeded spine is byte-identical whether or not it runs (`pullQuoteReelNeutral.test.ts`). It reaches
    // the player ONLY here, at this one sanctioned unseal seam — the NPC lines never touch a per-turn
    // surface (the Vault Wall, mandate #2; `pullQuoteReel.test.ts` sentinel). Names/ids resolved through
    // the same `retroScrub` the rest of the unseal uses, so no raw id crosses.
    const pullQuoteReel = buildPullQuoteReel(events, { nameOf, scrub: (c) => this.retroScrub(c) });
    // 0130 — the exit-interview reel: each evictee's posture leaving (+ the player's own words), the
    // season told through its exits. A witnessed, public beat (not a Vault read); the free-text message
    // is scrubbed like every other unsealed line so no raw id crosses. Empty when nothing was interviewed.
    const exitInterviews = (this.live.exitInterviews ?? []).map((x) => ({
      week: x.week,
      evictee: { id: x.evictee, name: this.nameOf(x.evictee) },
      stance: x.stance,
      ...(x.message ? { message: this.retroScrub(x.message) } : {}),
    }));
    return {
      winner: this.live.winner ? this.named(this.live.winner) : null,
      hiddenStory: coalesceDumpRows(ordered),
      twists,
      evictionVotes,
      ...(juryVotes ? { juryVotes } : {}),
      playerConfessionals,
      pullQuoteReel,
      ...(exitInterviews.length ? { exitInterviews } : {}),
      // 0133 — the early-evicted player's own finale-night interview (public; their words scrubbed like the rest).
      ...(this.live.finaleInterview
        ? { finaleInterview: { stance: this.live.finaleInterview.stance,
            ...(this.live.finaleInterview.message ? { message: this.retroScrub(this.live.finaleInterview.message) } : {}) } }
        : {}),
    };
  }

  /**
   * ADMIN fast-forward to the finale (L38) — the dev-only "finish my season so the post-season
   * retrospective unseals" lever. It DRIVES the existing deterministic loop: it loops `advanceGame`,
   * and whenever the loop stops on a PLAYER pending decision it auto-resolves it with the loop's OWN
   * legal NPC policy (`autoDecision` — the same rulebook the live game already uses, no second one),
   * until a winner is crowned (or the game is already finished). The player can legitimately lose on
   * the way — that is fine, the season still finishes for the rest, and the retrospective opens.
   *
   * VAULT-FREE BY CONSTRUCTION: it reads NO Vault state and returns NO Vault content — only PUBLIC
   * ceremony facts (the crowned winner's NAME, weeks, the player's seat). It does NOT touch
   * `seasonRetrospective`'s gate: that still fires ONLY post-finale through its own code path — this
   * just makes the live season reach the terminal state legitimately. BOUNDED: a hard max-iterations
   * guard means it can never spin forever (a stuck loop returns the unfinished summary, never hangs).
   *
   * Engine-side, ADMIN-channel only (wired through `AdminPort.advanceToFinale`, never the player
   * channel). Each beat still flows through the normal `commit` (consequence fold + persistence),
   * so the finished season is GENUINE — the integrity is preserved absolutely.
   */
  advanceToFinale(): FinaleFastForwardView {
    if (!this.house || !this.live) {
      return { finished: false, winnerName: null, weeks: this.week, playerPlacement: "unknown", started: false };
    }
    // The loop is bounded: a full 16-cast season is well under a few thousand beats+decisions; the
    // cap is generously above that so a legitimately long game still finishes, but a wedged loop
    // (the engine somehow never advancing) can NEVER spin forever — it falls out with the current
    // (unfinished) summary instead of hanging the request.
    const MAX_ITERS = 20_000;
    this.scheduleGateBypass = true; // A65: the engine's own fast-forward is not a player ask - the schedule gate must not stall it
    try {
    for (let i = 0; i < MAX_ITERS && !this.live.finished; i++) {
      if (this.live.pending) {
        // Auto-resolve the player's pending with the loop's own legal NPC policy (no second rulebook,
        // B55/D12). `submitDecision` runs the SAME commit path a live decision does (folds + persist).
        const input = autoDecision(this.live, this.ctx(), this.beatRng());
        this.submitDecision(this.fromDecisionInput(input));
      } else {
        this.advanceGame();
      }
    }
    } finally { this.scheduleGateBypass = false; }
    return this.fastForwardSummary();
  }

  /** Map the engine's internal `DecisionInput` (autoDecision's output) back onto the outward
   *  `SubmitDecisionReq` the adapter accepts — so the fast-forward drives the SAME `submitDecision`
   *  path a live player decision does (one decision rulebook; no bypass of validation or the fold). */
  private fromDecisionInput(input: DecisionInput): SubmitDecisionReq {
    switch (input.kind) {
      case "nominations":
        return { kind: "nominations", choice: [...input.choice] };
      case "veto-decision":
        return { kind: "veto-decision", use: input.use, ...(input.save ? { save: input.save } : {}) };
      case "comp-intent":
        return { kind: "comp-intent", intent: input.intent };
      case "comp-round":
        return { kind: "comp-round", intent: input.intent };
      case "houseguests-choice":
        return { kind: "houseguests-choice", vote: input.pick };
      case "replacement":
        return { kind: "replacement", replacement: input.replacement };
      case "eviction-vote":
        return { kind: "eviction-vote", vote: input.vote };
      case "tie-break":
        return { kind: "tie-break", vote: input.evict };
      case "final-eviction":
        return { kind: "final-eviction", vote: input.evict };
      case "goodbye-message":
        return { kind: "goodbye-message", vote: input.tone, ...(input.message ? { statement: input.message } : {}) };
      case "exit-interview":
        return { kind: "exit-interview", vote: input.stance, ...(input.message ? { statement: input.message } : {}) };
      case "spectator-choice":
        return { kind: "spectator-choice", vote: input.mode };
      case "finale-interview":
        return { kind: "finale-interview", vote: input.stance, ...(input.message ? { statement: input.message } : {}) };
      case "finale-statement":
        return { kind: "finale-statement", statement: input.statement };
      case "finale-answer":
        return { kind: "finale-answer", appeal: input.appeal };
      case "juror-question":
        return { kind: "juror-question", statement: input.question ?? "" };
      case "juror-vote":
        return { kind: "juror-vote", vote: input.vote };
      case "self-evict": // 0061: the auto-driver never produces a self-evict (it's a deliberate quit) — mapped for exhaustiveness.
        return { kind: "self-evict", confirmed: input.confirmed };
      case "secret-veto": // 0025: the fast-forward plays a player-held safety exactly as a live decision does.
        return { kind: "secret-veto", use: input.use };
    }
  }

  /** The Vault-free fast-forward summary (L38): public ceremony facts ONLY — winner NAME, weeks,
   *  and the player's seat. No hidden state, no soul, no relationship number ever rides out. */
  private fastForwardSummary(): FinaleFastForwardView {
    const finished = !!this.live?.finished;
    const winner = this.live?.winner;
    const finalTwo = this.live?.finalTwo ?? null;
    const me = this.house?.player.id ?? PLAYER;
    let placement: FinaleFastForwardView["playerPlacement"] = "unknown";
    if (finished) {
      if (winner === me) placement = "winner";
      else if (finalTwo && finalTwo.includes(me)) placement = "runner-up";
      else placement = this.playerStatus() === "jury" ? "jury" : "evicted";
    }
    return {
      finished,
      winnerName: winner ? this.nameOf(winner) : null,
      weeks: this.week,
      playerPlacement: placement,
      started: this.house !== null,
    };
  }

  /** The durable session core (0030): the live house + week/phase/ceremony + loop, losslessly. */
  snapshot(): SessionCore {
    return {
      started: this.house !== null,
      // 0065 Part A — persist the monotonic beat counter so the CAS token is restart-safe (co-versioned
      // with the save). Conditional spread keeps a never-bumped (pre-game/legacy) snapshot byte-shaped
      // as before (absent ⇒ 0 on restore), so a pre-0065 save round-trips unchanged.
      ...(this.beatSeq > 0 ? { beatSeq: this.beatSeq } : {}),
      // PERSIST-9 — persist the at-most-once cache (insertion-ordered) so at-most-once survives a
      // restart AND the routine LRU unload/resume cycle. Conditional spread keeps an empty cache
      // (pre-game / no progression yet) byte-shaped as before (absent ⇒ empty on restore).
      ...(this.idempotencyCache.size > 0
        ? { idempotency: [...this.idempotencyCache.entries()] as Array<[string, AdvanceView]> }
        : {}),
      // T0-3 (issue #1778) — persist the announcement-id counter (NOT the log/ring itself, which is
      // deliberately in-memory-only, see its own field comment) so an id is never reused even across a
      // restart. Absent ⇒ 0 on restore (byte-shaped as a pre-T0-3 save).
      ...(this.announcementSeq > 0 ? { announcementSeq: this.announcementSeq } : {}),
      week: this.week,
      phase: this.phase,
      ceremony: { ...this.ceremony, nominees: [...this.ceremony.nominees] },
      // R3 — the house is the per-turn export's dominant cost (each houseguest's append-only
      // `soul.memory` is deep-cloned every turn). `cloneHouse` is byte-identical to `cloneSession`
      // (JSON round-trip) but shares the unchanged souls' clones by reference, so the export re-clones
      // only the souls touched this turn — not the whole, ever-growing history. See `soulCloneCache`.
      house: this.house ? this.cloneHouse(this.house) : null,
      live: this.live ? fastClone(this.live) : null,
      deals: this.deals.serialize(),
      // 0107: persist named alliances so they survive a restart (accumulate, never thin). Engine-only.
      ...(this.alliances.all().length ? { alliances: this.alliances.serialize() } : {}),
      // 0085: persist live campaigns so a multi-week agenda + its history survive a restart (accumulate,
      // never thin). Engine-only hidden strategy — already inside the never-outward snapshot.
      ...(this.campaigns.length ? { campaigns: this.campaigns.map((c) => ({ ...c, owners: [...c.owners], plan: [...c.plan], knownTo: [...c.knownTo] })) } : {}),
      ...(this.drives.size ? { drives: Object.fromEntries([...this.drives].map(([k, v]) => [k, { ...v }])) as Record<EntityId, Drive> } : {}),
      ...(this.campaignTickCount > 0 ? { campaignTickCount: this.campaignTickCount } : {}),
      // 0096: persist the emergent-nemesis arc + its sustain history so it survives a restart and
      // accumulates (never re-guessed). Absent ⇒ byte-shaped as a pre-0096 save.
      ...(this.nemesisTrack.current !== undefined ? { nemesis: this.nemesisTrack.current } : {}),
      ...(Object.keys(this.nemesisTrack.streak).length ? { nemesisStreak: { ...this.nemesisTrack.streak } } : {}),
      // Phase 2 ("the player can play offense") — the player's OWN dedicated campaign-rng draw counter
      // + its per-beat progress throttle, persisted so both stay reproducible/consistent across a
      // restart (absent ⇒ 0 / null, byte-shaped as a pre-Phase-2 save).
      ...(this.playerCampaignMoveCount > 0 ? { playerCampaignMoveCount: this.playerCampaignMoveCount } : {}),
      ...(this.playerCampaignProgressBeat !== null ? { playerCampaignProgressBeat: this.playerCampaignProgressBeat } : {}),
      // 0100 — the DEDICATED jury-house rng tick counter, persisted so the isolated grudge stream stays
      // reproducible across a restart (the accumulated grudge itself rides on `live.juryGrudge`). Absent ⇒
      // 0 on restore (byte-shaped as a pre-0100 save).
      ...(this.juryHouseTickCount > 0 ? { juryHouseTickCount: this.juryHouseTickCount } : {}),
      ...(this.juryHouseArrivals !== null ? { juryHouseArrivals: this.juryHouseArrivals } : {}),
      // 0101 — the DEDICATED legend-rng tick counter, the per-season legend cap, and the notable-act
      // watermark, persisted so the isolated myth-making stream + its cap + its no-repeat guard survive a
      // restart (0007/0030). Absent ⇒ 0 on restore (byte-shaped as a pre-0101 save / the layer off).
      ...(this.legendTickCount > 0 ? { legendTickCount: this.legendTickCount } : {}),
      ...(this.legendCount > 0 ? { legendCount: this.legendCount } : {}),
      ...(this.legendLastActTick > 0 ? { legendLastActTick: this.legendLastActTick } : {}),
      ...(this.lastConfessionalSweepDay > 0 ? { lastConfessionalSweepDay: this.lastConfessionalSweepDay } : {}),
      // 0099 (hidden half) — the DEDICATED secret-barter rng tick counter + the monotonic count of secrets
      // spent into the hidden economy, persisted so the isolated barter stream + the non-degradation count
      // survive a restart (0007/0030). Absent ⇒ 0 on restore (byte-shaped as a pre-0099-barter save / off).
      ...(this.secretBarterTickCount > 0 ? { secretBarterTickCount: this.secretBarterTickCount } : {}),
      ...(this.secretBarterCount > 0 ? { secretBarterCount: this.secretBarterCount } : {}),
      // 0087: persist the hidden relationship-trajectory momentum + its recent-fold ring buffers, so a
      // multi-week arc RESUMES mid-curdle (0007/0030) and ACCUMULATES, never thins. Vault-class hidden state
      // (no player/admin-visible number) — already inside the never-outward snapshot. Absent ⇒ byte-shaped
      // as a pre-0087 save (resume at steady/0).
      ...(this.trajectories.size ? { trajectories: Object.fromEntries([...this.trajectories].map(([k, v]) => [k, { ...v }])) } : {}),
      ...(this.trajectoryFolds.size ? { trajectoryFolds: Object.fromEntries([...this.trajectoryFolds].map(([k, v]) => [k, v.map((f) => ({ ...f }))])) } : {}),
      ...(this.presence ? { presence: Object.fromEntries(this.presence) as Record<EntityId, Room> } : {}),
      // L21/L24: the calibration-neutral base occupancy the off-screen society pairs on — persisted so the
      // society's positions stay reproducible across a restart and never reseed from the weighted view.
      ...(this.presenceBase ? { presenceBase: Object.fromEntries(this.presenceBase) as Record<EntityId, Room> } : {}),
      ...(this.presenceTenure ? { presenceTenure: Object.fromEntries(this.presenceTenure) as Record<EntityId, number> } : {}),
      // L21/L24: the dedicated movement stream's tick counter — persisted so the personality-weighted
      // movement trajectory stays reproducible across a restart (absent ⇒ 0).
      ...(this.presenceTickCount > 0 ? { presenceTickCount: this.presenceTickCount } : {}),
      ...(this.tellOnsetCount > 0 ? { tellOnsetCount: this.tellOnsetCount } : {}),
      ...(this.tellReactionTicks > 0 ? { tellReactions: { exploit: { ...this.tellExploit }, reactedWeek: { ...this.tellReactedWeek }, counts: { ...this.tellReactionCounts }, ticks: this.tellReactionTicks } } : {}),
      // issue #792: the SEATED sub-zones (player-facing view) — persisted tenure-style so drift/cluster
      // history survives a restart (0007, only-forward) and never reseeds from scratch. Absent/empty ⇒
      // omitted (byte-identical to a pre-feature save; the next tick seats fresh). Vault-free position.
      ...(this.presenceZone && this.presenceZone.size > 0
        ? { presenceZone: Object.fromEntries(this.presenceZone) as Record<EntityId, Zone> }
        : {}),
      // 0077: the player's tracked closed-door beliefs — persisted so the privacy payoff accumulates
      // across a restart (0007). Absent/empty ⇒ omitted (byte-identical to a pre-0077 save).
       ...(this.trackedSightings && this.trackedSightings.size > 0
         ? { trackedSightings: Object.fromEntries(this.trackedSightings) as Record<EntityId, TrackedSighting> }
         : {}),
       // 0088: persist per-NPC current-read anchor bonds so drift reads warming/cooling/steady across
       // a restart. Vault-only (derived convenience — never a label, never crossed). Absent ⇒ steady.
       ...(this.readAnchors.size > 0 ? { readAnchors: Object.fromEntries(this.readAnchors) as Record<EntityId, number> } : {}),
       // #1322: persist the approach-rotation cooldown + the stretch key it was last advanced for, so
       // the anti-recency rotation survives a restart instead of re-favoring the same top NPC. Absent
       // ⇒ every NPC starts eligible (byte-identical to a pre-feature load).
       ...(this.approachCooldown.size > 0 ? { approachCooldown: Object.fromEntries(this.approachCooldown) as Record<EntityId, number> } : {}),
       ...(this.approachStretchKey !== undefined ? { approachStretchKey: this.approachStretchKey } : {}),
       // #1322 P1 follow-up (Greptile/PR #1335): persist WHO the current stretch has already shown, so
       // a save+restart between a `socialInitiatives()` read and the next committed beat still cools
       // those NPCs down at the coming stretch transition. Absent ⇒ nothing was shown this stretch.
       ...(this.lastApproachStretch !== undefined
         ? { approachShown: { key: this.lastApproachStretch.key, initiators: [...this.lastApproachStretch.initiators] } }
         : {}),
       // P0g: the noteMessage dedupe ring survives a restart (a retry then bills nothing). Absent until the first announcement ⇒ old saves round-trip byte-identical.
       ...(this.seenMessageIds.length > 0 ? { seenMessageIds: [...this.seenMessageIds] } : {}),
       // B20: the co-presence told ledger survives a restart (a telling already decided is not re-rolled). Absent when empty => old saves round-trip byte-identical.
       ...(this.copresenceTold.size > 0 ? { toldLedger: this.copresenceTold.snapshot() } : {}),
       ...(this.gameSeed !== null ? { seed: this.gameSeed } : {}),
      // The producer persona's seed (producer-persona feature) — persisted so the SAME off-camera casting
      // producer is voiced across turns and a restart (it is established pre-game, before any season seed).
      ...(this.producerSeed !== null ? { producerSeed: this.producerSeed } : {}),
      // The AI-authored producer-DEEPENING overlay (increment 3 of #1626) — persisted alongside the seed so
      // an authored persona survives a restart and only ever deepens (#4). Absent ⇒ the seeded floor stands.
      ...(this.producerProfile ? { producerProfile: { ...this.producerProfile } } : {}),
      ...(this.portraitStyleAnchor !== null ? { portraitStyleAnchor: this.portraitStyleAnchor } : {}),
      // PREMIERE (feature #380 follow-on): persist who the player has met so a half-done premiere
      // resumes after a restart (0030) — the producer never re-introduces someone or loses track of
      // who's still to meet. Public ids; absent once the premiere is over (the set is then empty).
      ...(this.premiereMet.size > 0 ? { premiereIntros: [...this.premiereMet] } : {}),
      // #1318: the player-formed HOT-READ subset — persisted so a half-done premiere resumes with its
      // EARNED first-power state (never re-derivable from `premiereIntros`, which mixes in belt marks).
      // Premiere-scoped like `premiereIntros` (empty once the first HOH begins ⇒ absent).
      ...(this.premiereHotReads.size > 0 ? { premiereHotReads: [...this.premiereHotReads] } : {}),
      // A1: the DURABLE name-lock companion to `premiereIntros` above — never cleared once the premiere
      // ends, so `recordCastProfile`'s name-race guard survives a restart. Public ids only.
      ...(this.introducedNames.size > 0 ? { introducedNames: [...this.introducedNames] } : {}),
      // 0062 — the FROZEN move-in zeitgeist snapshot persists so it is RECALLED (never re-searched) all
      // season and survives a restart byte-identical (§3/§9). Outward-safe public flavor (§6).
      ...(this.worldSnapshot ? { worldSnapshot: cloneSession(this.worldSnapshot) } : {}),
      // A half-done casting interview is durable state too (0050/0030).
      ...(intakeIsEmpty(this.intake) ? {} : { casting: cloneSession(this.intake) }),
      // 0065 — a pre-warmed (possibly FE-authored) cast is durable pre-game state: persist it so a
      // half-warmed cast resumes after a restart rather than re-warming from scratch. Cleared on adoption.
      ...(this.prewarm ? { prewarm: cloneSession(this.prewarm) } : {}),
      // 0065 (advance-warm) — the durable NEXT-season holding store mirror. Persisted so an advance-warm
      // begun during the finale survives an engine restart and is adopted at the cutover. Engine-only
      // (the snapshot never crosses the wall); cleared once the cutover consumes it.
      ...(this.nextSeasonWarm ? { nextSeasonWarm: cloneSession(this.nextSeasonWarm) } : {}),
      // 0058: the engine-only HIDDEN deep layer — persisted so an ACTIVATED thread stays activated and
      // the Day-1 perception re-seeds identically. ENGINE-ONLY (the snapshot never crosses the wall).
      ...(Object.keys(this.deepProfiles).length ? { deepProfiles: cloneSession(this.deepProfiles) } : {}),
      ...(this.storyThreads.length ? { storyThreads: cloneSession(this.storyThreads) } : {}),
      // 0060 — the scheduler's hidden bookkeeping (nominated-twice ledger + the season surfacing cap),
      // persisted so a driven thread stays driven and the cap is never re-opened by a reload.
      ...(Object.keys(this.nominationWeeks).length ? { nominationWeeks: cloneSession(this.nominationWeeks) } : {}),
      ...(this.surfacedThreadCount > 0 ? { surfacedThreadCount: this.surfacedThreadCount } : {}),
      // 0101/#1401 — the showrunner's Vault-held production bible (append-only per beat) + its monotonic
      // count, persisted so the season's producer notes survive a restart and only ever deepen (#4).
      ...(this.showrunnerNotes.length ? { showrunnerNotes: cloneSession(this.showrunnerNotes) } : {}),
      ...(this.showrunnerNoteCount > 0 ? { showrunnerNoteCount: this.showrunnerNoteCount } : {}),
      // 0101/#1401 Phase-2 (#1455) — the monotonic reweight-fired count (a `SessionCoreCounts` dimension).
      // Absent ⇒ 0 (byte-shaped like a pre-Phase-2 save / the reweight sub-flag off).
      ...(this.showrunnerReweightCount > 0 ? { showrunnerReweightCount: this.showrunnerReweightCount } : {}),
      // 0091 — the per-season trigger-eruption count (the hard cap) + the dedicated trigger-rng tick counter,
      // persisted so the cap is never re-opened by a reload and the dedicated stream stays reproducible
      // (0007/0030). The per-trigger fired/lastFiredWeek flags ride on the byte-stable house above. Absent ⇒
      // 0 (byte-shaped like a pre-0091 save / the layer off).
      ...(this.eruptionCount > 0 ? { eruptionCount: this.eruptionCount } : {}),
      ...(this.triggerTickCount > 0 ? { triggerTickCount: this.triggerTickCount } : {}),
      // 0092 — the secret-pacing drip's hidden weekly bookkeeping (the per-week drip counter + the
      // per-thread last-dripped week), persisted so the CADENCE and the no-re-spam penalty survive a
      // restart — the pace resumes, it never resets (non-degradation, 0007/0030). Each field is gated
      // INDEPENDENTLY on its own non-zero/non-empty value (never on a sibling), so the per-week context
      // is never silently dropped after the count lazily rolls to 0 on a new week. Absent when pacing is
      // off / nothing has dripped ⇒ start fresh (0/empty); the season cap above still binds either way.
      ...(this.pacingDripWeek > 0 ? { pacingDripWeek: this.pacingDripWeek } : {}),
      ...(this.pacingDripCount > 0 ? { pacingDripCount: this.pacingDripCount } : {}),
      ...(this.pacingTickCount > 0 ? { pacingTickCount: this.pacingTickCount } : {}),
      ...(Object.keys(this.pacingLastDrippedWeek).length ? { pacingLastDrippedWeek: cloneSession(this.pacingLastDrippedWeek) } : {}),
      // 0075 — the confidence ledger (what each houseguest has confided + the season lie count),
      // persisted so a restored game remembers exactly what the player was told and never re-opens the
      // lie cap or re-tells a secret at a lower tier (non-degradation, 0007/0030).
      ...(Object.keys(this.confideState).length ? { confideState: cloneSession(this.confideState) } : {}),
      ...(this.jurorTold.size ? { jurorTold: [...this.jurorTold] } : {}),
      ...(this.lieCount > 0 ? { confideLieCount: this.lieCount } : {}),
      ...(Object.keys(this.confideLiesBy).length ? { confideLiesBy: { ...this.confideLiesBy } } : {}),
      // 0093/0099 — secrets as power: which learned secrets the player has SPENT (`usedAs`) + the per-
      // season expose/trade/bluff counts. Persisted so a restored game remembers a spent secret can't be
      // re-wielded and the season caps don't reopen (non-degradation, 0007/0030). Engine-only.
      ...(Object.keys(this.secretUsedAs).length ? { secretUsedAs: cloneSession(this.secretUsedAs) } : {}),
      ...(this.exposeCount > 0 ? { secretExposeCount: this.exposeCount } : {}),
      ...(this.tradeCount > 0 ? { secretTradeCount: this.tradeCount } : {}),
      ...(this.playerBluffCount > 0 ? { secretPlayerBluffCount: this.playerBluffCount } : {}),
      ...(Object.keys(this.playerBluffBelief).length ? { secretPlayerBluffBelief: cloneSession(this.playerBluffBelief) } : {}),
      ...(this.seededRels.ties.length || this.seededRels.showmances.length
        ? { seededRelationships: cloneSession(this.seededRels) } : {}),
      // 0116 — the model-authored world-gen artifact: the seeded season brief (mandate #4 — the committed
      // genesis is the persisted artifact, recalled never regenerated) + the authored-skeleton provenance.
      // (The genesis TIE graph is NOT persisted here — pre-game it rides the `prewarm`, and post-createCharacter
      // it lives in `seededRelationships` above with exposure "sealed"; so it is durable without a third copy.)
      ...(this.seasonBrief ? { seasonBrief: cloneSession(this.seasonBrief) } : {}),
      ...(this.genesisAuthored ? { genesisAuthored: true } : {}),
      // 0059 §5 — the tie-surfacing scheduler's hidden bookkeeping: the season player-surface cap counter,
      // the subjects already surfaced to the player (so a tie never re-spends the cap), and the dedicated
      // stream's tick counter. Persisted so a discovered tie stays discovered, the cap is never re-opened
      // by a reload, and the dedicated rng stays reproducible across a restart (non-degradation, 0007).
      ...(this.playerTieSurfaceCount > 0 ? { playerTieSurfaceCount: this.playerTieSurfaceCount } : {}),
      ...(this.surfacedTieSubjects.size > 0 ? { surfacedTieSubjects: [...this.surfacedTieSubjects] } : {}),
      ...(this.tieScheduleTickCount > 0 ? { tieScheduleTickCount: this.tieScheduleTickCount } : {}),
      // 0095 — the tie-REVEAL pathway's own bookkeeping (a SEPARATE counter/cap from §5 above): the
      // per-season exposure count (ties promoted past `sealed` by ANY pathway, incl. `accuseTie`) and the
      // dedicated scheduler's own tick counter. The `exposure` field on each tie already rides inside the
      // `seededRelationships` blob above. Absent ⇒ byte-shaped as a pre-0095 save.
      ...(this.tieExposureCount > 0 ? { tieExposureCount: this.tieExposureCount } : {}),
      ...(this.tieRevealTickCount > 0 ? { tieRevealTickCount: this.tieRevealTickCount } : {}),
      // 0063: the engine-only HIDDEN private-orientation map — persisted so a closeted houseguest's
      // sealed orientation survives a restart losslessly and never silently resets. ENGINE-ONLY (the
      // snapshot never crosses the wall). The PUBLIC facets ride on the persisted Character (byte-stable).
      ...(Object.keys(this.privateOrientations).length
        ? { privateOrientations: cloneSession(this.privateOrientations) } : {}),
      // 0070 — the additive prose texture layer: persisted so voiced scenes survive a restart
      // byte-identical (0030). Absent when no texture has been written back (pre-0070 saves).
      ...(this.textureOverrides.size > 0
        ? { textureOverrides: Object.fromEntries(this.textureOverrides) } : {}),
    };
  }

  /**
   * R3 — clone the house byte-identically to `cloneSession(house)` while reusing each UNCHANGED soul's
   * append-only array clones (`memory`/`emotionalHistory`) by reference. The per-turn export used to
   * JSON-serialize every houseguest's entire (ever-growing) memory every turn — the O(events) cost
   * behind the late-season latency (audit R3). Per houseguest only the small bounded parts (character +
   * soul scalars) are re-cloned each turn; the two big append-only arrays are re-sliced ONLY when their
   * live source grew (or was rewritten — `replaceMemoryNote` swaps the array ref, invalidating the
   * cache). An unchanged soul (same array ref + length) reuses its prior clone, so the export's
   * per-turn work tracks the souls TOUCHED this turn, not the total accumulated history.
   *
   * Correctness: a cached clone is NEVER mutated in place — a grown source produces a fresh array — so a
   * baseline snapshot still holding the old clone keeps its point-in-time length and the non-degradation
   * checkpoint stays exact (baseline vs candidate counts differ precisely by what grew). Every cloned
   * leaf is an immutable primitive (string/number), so sharing it across snapshots is safe.
   */
  private cloneHouse(house: GameHouse): GameHouse {
    return {
      player: this.cloneHouseguest(house.player),
      npcs: house.npcs.map((n) => this.cloneHouseguest(n)),
    } as GameHouse;
  }

  private cloneHouseguest<T extends GameHouse["player"] | GameHouse["npcs"][number]>(hg: T): T {
    const memSrc = hg.soul.memory;
    const histSrc = hg.soul.emotionalHistory ?? [];
    const cached = this.soulCloneCache.get(hg.id as EntityId);
    // Reuse the prior clone iff the live array is the SAME object at the SAME length (an append grows
    // the length; `replaceMemoryNote` swaps the reference) — otherwise re-slice and re-cache. A slice
    // is a faithful, independent clone of a `string[]`/`number[]` (immutable elements; no deep work).
    const memClone = cached && cached.memSrc === memSrc && cached.memLen === memSrc.length
      ? cached.memClone : memSrc.slice();
    const histClone = cached && cached.histSrc === histSrc && cached.histLen === histSrc.length
      ? cached.histClone : histSrc.slice();
    this.soulCloneCache.set(hg.id as EntityId, {
      memSrc, memLen: memSrc.length, memClone,
      histSrc, histLen: histSrc.length, histClone,
    });
    // Clone the houseguest WITHOUT re-cloning the two big append-only arrays (the whole point — they are
    // handled above). To stay BYTE-identical to `cloneSession(hg)` we must preserve the soul's ORIGINAL
    // key ORDER (JSON.stringify is order-sensitive), so we clone each key in place and merely SUBSTITUTE
    // the (reused-or-fresh) array clone for memory/emotionalHistory at their existing positions — never
    // reorder. `fastClone` handles every other small, bounded field (the static character + soul scalars).
    const soulSrc = hg.soul as unknown as Record<string, unknown>;
    const soul: Record<string, unknown> = {};
    for (const k in soulSrc) {
      if (!Object.prototype.hasOwnProperty.call(soulSrc, k)) continue;
      soul[k] = k === "memory" ? memClone
        : k === "emotionalHistory" ? histClone
        : fastClone(soulSrc[k]);
    }
    const hgSrc = hg as unknown as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k in hgSrc) {
      if (!Object.prototype.hasOwnProperty.call(hgSrc, k)) continue;
      out[k] = k === "soul" ? soul : fastClone(hgSrc[k]);
    }
    return out as unknown as T;
  }

  /** Rebuild the live session from a durable snapshot (0030) — resume instead of reset. */
  restore(core: SessionCore): void {
    // R3 — the live houseguest objects are replaced wholesale below, so the per-soul clone cache (keyed
    // on the OLD array references) must be dropped; a stale clone could otherwise be reused for a new
    // soul that happens to match a length, persisting the wrong history.
    this.soulCloneCache.clear();
    // 0065 Part A — resume the beat counter at the saved value (restart-safe CAS). Absent on a pre-0065
    // save ⇒ 0 (the next commit bumps it).
    this.beatSeq = core.beatSeq ?? 0;
    // T0-3 — resume the announcement-id counter (restart-safe: an id is never reused). The log/ring
    // itself is process-local (like `beatCheckpoints` just below) and resets empty on a resume — the
    // FE's pre-restart delta token resets too, so it correctly full-refreshes rather than slicing
    // against a window whose checkpoint no longer exists.
    this.announcementSeq = core.announcementSeq ?? 0;
    this.announcementLog.length = 0;
    this.pendingAnnouncements = [];
    // PERSIST-9 — RESTORE the at-most-once cache instead of clearing it. An `AdvanceView` is plain JSON
    // (a player-witnessed progression view — no reference to a dead in-memory houseguest object, no Vault
    // content), so it round-trips safely; restoring it keeps at-most-once intact across a restart AND the
    // routine LRU sandbox-unload/resume cycle (both run through here). Before this, the clear defeated the
    // exact retry Part B exists for whenever the retry straddled an unload (a re-applied vote/nomination).
    // Absent (pre-fix / no progression yet) ⇒ empty, byte-identical to the old clear.
    this.idempotencyCache.clear();
    if (Array.isArray(core.idempotency)) {
      for (const entry of core.idempotency) {
        if (Array.isArray(entry) && typeof entry[0] === "string" && entry[1]) {
          this.idempotencyCache.set(entry[0], entry[1] as AdvanceView);
        }
      }
    }
    // 0065 Part E — the delta ring is a process-local read accelerator (not persisted); a resume starts
    // it empty, so the FE's pre-restart token (which also resets across a restart) correctly full-
    // refreshes rather than slicing against a window that no longer holds its checkpoint.
    this.beatCheckpoints.clear();
    this.house = core.house ? cloneSession(core.house) : null;
    // #1326 — legacy-save backfill for NPCs ONLY: an NPC's `genderPresentation` is always dealt by the
    // 0063 diversity floor at cast time, so an unset facet on a resumed NPC means a save that predates
    // that floor (or a non-standard creation path that skipped it) — a genuine gap worth repairing.
    // Left unset, the narration prompt (momentPrompts.ts) already falls back to an explicit
    // "unconfirmed" guidance clause rather than silently dropping the pronoun line — but a RESUMED save
    // can do better: repair it once, right here, deterministically, off a DEDICATED sub-stream keyed on
    // the houseguest's own id (never the shared game-seed stream, so no seeded competition/vote roll is
    // perturbed — mirrors the `portraitStyleAnchor` legacy-backfill precedent a few lines below). Logged
    // once per repair (the `relationships.ts` `sanitize`-on-load precedent) so a legacy/non-standard
    // save stays VISIBLE instead of silently self-healing. Purely descriptive (0063: "never a
    // competition input"), so this can never perturb calibration, and it is not part of the 0007/0031
    // byte-compared save surface (`genderPresentation` never rides `PersistedCharacter`), so it cannot
    // trip the non-degradation gate.
    //
    // The PLAYER is deliberately EXCLUDED: their facet is player-authored and OPTIONAL BY DESIGN (a
    // human may decline to answer at casting) — an absent player facet is a legitimate, permanent
    // state, never a gap to force-fill. Backfilling it here would silently assign a player a gender
    // they never chose. `momentPrompts.ts` mirrors this: the player's line simply omits the pronoun
    // clause when unset, with no "unconfirmed" fallback either.
    if (this.house) {
      for (const npc of this.house.npcs) {
        if (npc.character.genderPresentation !== undefined) continue;
        // Keyed on the game seed + id + name: ids are positional (`npc-1`…`npc-15`) and repeat
        // across every season/save, so id alone would deal the same repair to the same SLOT in
        // every restored cast; the seed + name tie the derivation to the actual saved game and
        // character (review, PR #1346 — `core.seed`, not `this.gameSeed`, which is assigned
        // later in restore(), matching the portraitStyleAnchor backfill precedent).
        const derived = GENDER_PRESENTATIONS[new SeededRandom(hashSeed(`${core.seed}:${npc.id}:${npc.name}:genderPresentation-backfill`)).int(GENDER_PRESENTATIONS.length)]!;
        npc.character.genderPresentation = derived;
        console.warn(`[orwell] ${npc.id} (${npc.name}) had no genderPresentation facet on load; backfilled to "${derived}" deterministically (#1326)`);
      }
    }
    this.week = core.week;
    this.phase = core.phase;
    this.ceremony = { ...core.ceremony, nominees: [...core.ceremony.nominees] };
    this.live = core.live ? cloneSession(core.live) : null;
    this.deals.load(core.deals ?? []);
    // 0107: restore named alliances (absent on pre-0107 saves ⇒ none).
    this.alliances.load(core.alliances ?? []);
    // 0085: restore live campaigns (absent on pre-0085 saves ⇒ none).
    this.campaigns = (core.campaigns ?? []).map((c) => ({ ...c, owners: [...c.owners], plan: [...c.plan], knownTo: [...c.knownTo] }));
    this.campaignTickCount = core.campaignTickCount ?? 0;
    // Phase 2 ("the player can play offense") — restore the player's own dedicated campaign-rng counter
    // + its per-beat progress throttle (absent on pre-Phase-2 saves ⇒ 0 / null).
    this.playerCampaignMoveCount = core.playerCampaignMoveCount ?? 0;
    this.playerCampaignProgressBeat = core.playerCampaignProgressBeat ?? null;
    // 0100: restore the dedicated jury-house rng tick counter (absent on pre-0100 saves ⇒ 0). The
    // accumulated grudge itself rides on `live.juryGrudge`, restored with the live state above.
    this.juryHouseTickCount = core.juryHouseTickCount ?? 0;
    this.juryHouseArrivals = core.juryHouseArrivals ?? null;
    // 0101: restore the dedicated legend-rng tick counter, the per-season legend cap, and the notable-act
    // watermark (absent on pre-0101 saves ⇒ 0).
    this.legendTickCount = core.legendTickCount ?? 0;
    this.legendCount = core.legendCount ?? 0;
    this.legendLastActTick = core.legendLastActTick ?? 0;
    this.lastConfessionalSweepDay = core.lastConfessionalSweepDay ?? 0; // 0122 — restore the sweep watermark
    // 0101/#1401: restore the showrunner's production bible + its monotonic count (absent on a pre-0101
    // save / when the layer is off ⇒ []/0 — byte-identical to a pre-feature load).
    this.showrunnerNotes = core.showrunnerNotes ? cloneSession(core.showrunnerNotes) : [];
    this.showrunnerNoteCount = core.showrunnerNoteCount ?? 0;
    this.showrunnerReweightCount = core.showrunnerReweightCount ?? 0; // Phase-2 (#1455) — absent ⇒ 0
    // 0099 (hidden half): restore the dedicated secret-barter rng counter + the spent-secret count
    // (absent on pre-0099-barter saves ⇒ 0).
    this.secretBarterTickCount = core.secretBarterTickCount ?? 0;
    this.secretBarterCount = core.secretBarterCount ?? 0;
    // 0086: restore live drives (absent on pre-0086 saves ⇒ none ⇒ re-derived on the next campaign tick).
    this.drives = core.drives ? new Map(Object.entries(core.drives) as [EntityId, Drive][]) : new Map();
    // 0096: restore the emergent-nemesis arc + its sustain history (absent on a pre-0096 save / when the
    // campaign layer is off ⇒ no nemesis, cleanly re-derived on the next campaign tick).
    this.nemesisTrack = { current: core.nemesis, streak: core.nemesisStreak ? { ...core.nemesisStreak } : {} };
    // 0087: restore the hidden relationship-trajectory momentum + recent-fold ring buffers (absent on
    // pre-0087 saves ⇒ empty ⇒ every pair resumes at steady/0, byte-identical to a pre-feature load).
    this.trajectories = core.trajectories ? new Map(Object.entries(core.trajectories)) : new Map();
    this.trajectoryFolds = core.trajectoryFolds
      ? new Map(Object.entries(core.trajectoryFolds).map(([k, v]) => [k, v.map((f) => ({ ...f }))]))
      : new Map();
    // Pre-0049 saves carry no presence — migrate forward (the next tick seats everyone afresh).
    this.presence = core.presence ? new Map(Object.entries(core.presence) as [EntityId, Room][]) : null;
    // L21/L24: restore the calibration-neutral base occupancy (absent on pre-L21/L24 saves — the next tick
    // re-seeds it from the weighted positions, which `societyOccupancy` falls back to in the meantime).
    this.presenceBase = core.presenceBase ? new Map(Object.entries(core.presenceBase) as [EntityId, Room][]) : null;
    this.presenceTenure = core.presenceTenure ? new Map(Object.entries(core.presenceTenure) as [EntityId, number][]) : null;
    // L21/L24: restore the dedicated movement stream's tick counter (absent on older saves ⇒ 0).
    this.presenceTickCount = core.presenceTickCount ?? 0;
    this.tellOnsetCount = core.tellOnsetCount ?? 0;
    this.tellExploit = { ...(core.tellReactions?.exploit ?? {}) };
    this.tellReactedWeek = { ...(core.tellReactions?.reactedWeek ?? {}) };
    this.tellReactionCounts = { ...(core.tellReactions?.counts ?? {}) };
    this.tellReactionTicks = core.tellReactions?.ticks ?? 0;
    // issue #792: restore the SEATED sub-zones (acquired drift/cluster history survives a restart). A
    // pre-feature save carries none ⇒ null ⇒ the next tick seats everyone fresh from `zoneFor`, NO error.
    this.presenceZone = core.presenceZone ? new Map(Object.entries(core.presenceZone) as [EntityId, Zone][]) : null;
    // 0077: restore the player's tracked closed-door beliefs (acquired knowledge survives a restart).
    this.trackedSightings = core.trackedSightings
      ? new Map(Object.entries(core.trackedSightings) as [EntityId, TrackedSighting][])
      : null;
    // 0088: restore per-NPC current-read anchor bonds (absent on pre-0088 saves ⇒ empty ⇒ drift "steady").
    this.readAnchors = core.readAnchors ? new Map(Object.entries(core.readAnchors) as [EntityId, number][]) : new Map();
    // #1322: restore the approach-rotation cooldown bookkeeping (absent on a pre-feature save ⇒ every
    // NPC starts eligible). The P1 follow-up (Greptile/PR #1335): `approachShown` — whom the current
    // stretch already showed — is restored too, so a save+restart BETWEEN a `socialInitiatives()`
    // read and the next committed beat still re-arms the cooldown for those NPCs at the coming
    // stretch transition (previously it was ephemeral and a mid-stretch restart re-armed nobody).
    this.approachCooldown = core.approachCooldown
      ? new Map(Object.entries(core.approachCooldown) as [EntityId, number][])
      : new Map();
    this.approachStretchKey = core.approachStretchKey;
    this.lastApproachStretch = core.approachShown
      ? { key: core.approachShown.key, initiators: [...core.approachShown.initiators] }
      : undefined;
    this.seenMessageIds = core.seenMessageIds ? [...core.seenMessageIds].slice(-256) : [];
    this.messageMode = this.seenMessageIds.length > 0; // a restart after announcements stays in message mode (no fall back to per-commit billing)
    this.copresenceTold = ToldLedger.restore(core.toldLedger);
    this.gameSeed = core.seed ?? null; // pre-B60 saves: fall back to the legacy name-keyed streams
    // The producer persona's seed (producer-persona feature): restore so the SAME off-camera casting
    // producer is voiced after a restart. Persisted on feature+ saves; on a started game that predates
    // it, fall back to the season seed (the producer becomes the season's producer, exactly as at cast
    // time). A fresh pre-interview session restores none and re-mints lazily on first need.
    this.producerSeed = core.producerSeed ?? core.seed ?? null;
    // The AI-authored producer-DEEPENING overlay (increment 3 of #1626): restore so an authored persona
    // resumes after a restart. Absent on pre-feature saves / an unauthored session ⇒ the seeded floor stands.
    this.producerProfile = core.producerProfile ? { ...core.producerProfile } : null;
    this.producerCache = null; // rebuilt from the (possibly new) seed + overlay on next read
    // 0051: restore the per-season portrait style anchor. On a legacy save that predates it, re-seed
    // from the game seed (so the look stays stable for a resumed game), or fall back to the first
    // variant when there's no seed either — either way the season looks like itself.
    this.portraitStyleAnchor = core.portraitStyleAnchor
      ?? (core.house
        ? (core.seed !== undefined
          ? STYLE_ANCHOR_VARIANTS[new SeededRandom(hashSeed(`${core.seed}:portrait-style`)).int(STYLE_ANCHOR_VARIANTS.length)]
          : STYLE_ANCHOR_VARIANTS[0])
        : null);
    this.intake = core.casting ? cloneSession(core.casting) : emptyIntake();
    // 0065 — restore a half-warmed (possibly FE-authored) cast so author/portrait warm resume rather than
    // re-warming from scratch. Engine-only; absent on all prior saves and once the season has started.
    this.prewarm = core.prewarm ? cloneSession(core.prewarm) : null;
    // 0065 (advance-warm) — restore the durable NEXT-season holding store mirror so an advance-warm begun
    // during the finale survives the restart and is still adopted at the cutover. Engine-only; absent on
    // all prior saves and once the cutover consumed it.
    this.nextSeasonWarm = core.nextSeasonWarm ? cloneSession(core.nextSeasonWarm) : null;
    // PREMIERE (feature #380 follow-on): restore who's been met so a half-done premiere resumes (0030).
    // Absent on a pre-feature save OR once the premiere is over ⇒ empty (no one outstanding to re-meet).
    this.premiereMet = new Set(core.premiereIntros ?? []);
    // #1318: restore the player-formed HOT-READ subset. Absent on a pre-#1318 save ⇒ empty (no earned
    // reads yet, so the gate simply waits for the first genuine one — never a spurious early unlock).
    this.premiereHotReads = new Set(core.premiereHotReads ?? []);
    // A1: restore the DURABLE name-lock companion set. Absent on a pre-A1 save ⇒ empty (a save made
    // before this fix simply has no locked names yet; any houseguest introduced from here on locks
    // going forward exactly as a fresh season does — no regression, no false lock on old saves).
    this.introducedNames = new Set(core.introducedNames ?? []);
    // 0062 — restore the FROZEN move-in zeitgeist snapshot (recalled, never re-searched, §9). Persisted on
    // 0062+ saves; on a pre-0062 save WITH a seed, re-derive the deterministic `model-framed` snapshot off
    // the SAME seed hinge (seed-stable & player-independent, so it returns identically). Without a seed
    // (pre-B60 legacy) or a house, it stays absent — the game degrades to C32's per-reference behavior (§8).
    this.worldSnapshot = core.worldSnapshot
      ? cloneSession(core.worldSnapshot)
      : (core.house && core.seed !== undefined
        ? buildWorldSnapshot({ seed: core.seed, capturedFor: "move-in day" })
        : null);
    // 0058: restore the engine-only HIDDEN deep layer (secrets/goals/weakness/perception + thread
    // status). Persisted on 0058+ saves; on a pre-0058 (or twist-less legacy) save it is re-derived
    // deterministically from the seed + cast below — seed-stable & player-independent, so the floor
    // returns identically. The PUBLIC facets ride on the persisted Character (byte-stable), so they
    // are NOT re-derived here; only the hidden half + thread status are rehydrated.
    // PERSIST-13: the two fields used to be gated by a single OR — "either is present ⇒ trust BOTH
    // as persisted, re-deriving neither." A save where `storyThreads` survived but `deepProfiles`
    // was absent/empty (a partial write, an interrupted re-seal, a future migration bug that clears
    // one but not the other) took the "trust the persisted layer" branch and set `deepProfiles = {}`
    // — silently discarding every houseguest's secrets/goals/weakness/day-one-perception for the
    // rest of the game, with no re-derivation and no error. Each field is now independently either
    // trusted (present) or re-derived from the seed (absent) — a partial/inconsistent save
    // self-heals deterministically instead of silently going empty.
    const needsRederive = (!core.deepProfiles || !core.storyThreads) && core.house && core.seed !== undefined;
    const layer = needsRederive ? generateCastDeepLayer(core.seed!, core.house!.npcs) : null;
    this.deepProfiles = core.deepProfiles ? cloneSession(core.deepProfiles) : (layer ? layer.hidden : {});
    this.storyThreads = core.storyThreads ? cloneSession(core.storyThreads) : (layer ? layer.threads : []);
    // 0060 §3 back-compat: a thread restored from a pre-0060 save carries no structured `triggerCondition`
    // / `lifecycleWeek` — default them by source class / the live week (idempotent), so the scheduler has
    // a gate and the windows have a base. This is a NON-mutating re-derive (the byte-stable PUBLIC facets
    // are untouched); the hidden thread gains a field that was always implied by its prose trigger.
    for (const t of this.storyThreads) {
      if (t.triggerCondition === undefined) t.triggerCondition = defaultTriggerConditionFor(t);
      if (t.lifecycleWeek === undefined) t.lifecycleWeek = this.week;
    }
    // 0060 — restore the scheduler's hidden bookkeeping (nominated-twice ledger + the season cap). Absent
    // on pre-0060 saves ⇒ start fresh (rebuilt forward; the cap re-baselines to 0 — a benign, never-leaky
    // relaxation on a legacy resume, since pre-0060 saves carried no surfaced threads to over-count).
    this.nominationWeeks = core.nominationWeeks ? cloneSession(core.nominationWeeks) : {};
    this.surfacedThreadCount = core.surfacedThreadCount ?? 0;
    // 0091 — restore the per-season eruption count + dedicated trigger-rng tick counter (absent on pre-0091
    // saves / the layer off ⇒ 0). The per-trigger fired/lastFiredWeek flags are restored with the house above.
    this.eruptionCount = core.eruptionCount ?? 0;
    this.triggerTickCount = core.triggerTickCount ?? 0;
    // 0092 — restore the secret-pacing drip's weekly bookkeeping (absent on pacing-off / pre-0092 saves
    // ⇒ 0/empty, so the pace resumes from a clean slate and nothing re-spams; the season cap above still
    // binds). The pace RESUMES across a restart, it never resets (non-degradation).
    this.pacingDripWeek = core.pacingDripWeek ?? 0;
    this.pacingDripCount = core.pacingDripCount ?? 0;
    this.pacingTickCount = core.pacingTickCount ?? 0;
    this.pacingLastDrippedWeek = core.pacingLastDrippedWeek ? cloneSession(core.pacingLastDrippedWeek) : {};
    // 0075 — restore the confidence ledger (absent on pre-0075 saves ⇒ empty/zero, never re-confides
    // a secret the player already heard, the cap intact).
    this.confideState = core.confideState ? cloneSession(core.confideState) : {};
    this.jurorTold = new Set(core.jurorTold ?? []);
    this.lieCount = core.confideLieCount ?? 0;
    this.confideLiesBy = core.confideLiesBy ? { ...core.confideLiesBy } : {};
    // 0093/0099 — restore the secrets-as-power ledger (absent on pre-0093 saves ⇒ empty/zero): which
    // secrets the player has spent + the per-season caps, so a spent secret stays spent across a restart.
    this.secretUsedAs = core.secretUsedAs ? cloneSession(core.secretUsedAs) : {};
    this.exposeCount = core.secretExposeCount ?? 0;
    this.tradeCount = core.secretTradeCount ?? 0;
    this.playerBluffCount = core.secretPlayerBluffCount ?? 0;
    this.playerBluffBelief = core.secretPlayerBluffBelief ? cloneSession(core.secretPlayerBluffBelief) : {};
    // 0063 — restore the engine-only HIDDEN private orientations (a closeted orientation must never
    // silently reset) FIRST, so the 0059 showmance re-derive below can read them for its eligibility gate.
    // Persisted on 0063+ saves; on a pre-0063 (or legacy) save with a seed, re-derive deterministically —
    // the diversity layer keys off the cast names + seed, so it returns identically (and the PUBLIC facets
    // already ride on the persisted Character, byte-stable). No re-seal on restore: the Vault already
    // holds the audit copy from cast time (idempotent).
    if (core.privateOrientations) {
      this.privateOrientations = cloneSession(core.privateOrientations);
    } else if (core.house && core.seed !== undefined && !core.house.npcs.some((n) => n.character.ethnicity)) {
      // Only re-derive for a TRULY pre-0063 cast (no ethnicity folded). A 0063 cast with an empty
      // private map simply had everyone publicly out — keep it empty, never invent a secret.
      this.privateOrientations = { ...generateDiversityLayer(core.seed, core.house.npcs).privateOrientations };
    } else {
      this.privateOrientations = {};
    }
    // 0059 — the seeded relationship layer persists explicitly (a showmance STAGE must never silently
    // reset on restore). Absent on pre-0059 saves ⇒ re-seed deterministically off the persisted seed,
    // gated by the 0063 showmance-eligibility predicate (which reads the just-restored identities).
    if (core.seededRelationships) {
      this.seededRels = migrateSeededRelationships(cloneSession(core.seededRelationships)); // #1909: a legacy tie nature aliases forward
    } else if (core.house && core.seed !== undefined) {
      this.seededRels = loadSeededRelationships(
        core.house.npcs, this.tieBudget, this.showmanceBudget,
        new SeededRandom(hashSeed(`${core.seed}:seeded-relationships`)),
        this.showmanceEligiblePredicate(),
      );
    } else {
      this.seededRels = { ties: [], showmances: [] };
    }
    // 0116 — restore the model-authored world-gen artifact. The seeded season brief + the authored-skeleton
    // provenance are recalled, never regenerated (mandate #4). `genesisTies` is NOT a persisted top-level
    // field (pre-game it rides the restored `prewarm`; post-createCharacter the ties live in `seededRels`
    // above, already folded + sealed), so it stays null here — the floor-vs-genesis choice was made at
    // createCharacter and is baked into `seededRels`. Absent on a pre-0116 save ⇒ null/false (the floor cast).
    this.seasonBrief = core.seasonBrief ? cloneSession(core.seasonBrief) : null;
    this.genesisAuthored = core.genesisAuthored ?? false;
    this.genesisTies = null;
    // 0059 §5 — restore the tie-surfacing bookkeeping (absent on pre-§5 saves ⇒ zero/empty: the cap is
    // intact, no tie has surfaced, the dedicated stream restarts at 0). Never silently re-opens the cap.
    this.playerTieSurfaceCount = core.playerTieSurfaceCount ?? 0;
    this.surfacedTieSubjects = new Set(core.surfacedTieSubjects ?? []);
    this.tieScheduleTickCount = core.tieScheduleTickCount ?? 0;
    // 0095 — restore the tie-REVEAL bookkeeping (absent on a pre-0095 save ⇒ zero: every tie's `exposure`
    // already defaults to `sealed` via `tieExposureOf`, and the cap is intact — never silently re-opened).
    this.tieExposureCount = core.tieExposureCount ?? 0;
    this.tieRevealTickCount = core.tieRevealTickCount ?? 0;
    this.rebuildSoulIndex();
    this.wireDispositions(); // re-derive archetype dispositions from the persisted Character (B55)
    // 0070 — restore the prose texture layer (persisted so voiced scenes survive a restart byte-identical).
    // Absent on pre-0070 saves ⇒ empty (the deterministic template content simply stands, no regression).
    this.textureOverrides = core.textureOverrides ? new Map(Object.entries(core.textureOverrides)) : new Map();
    // lastTickOffscreenIds is TRANSIENT (never persisted) — starts empty on every restore; the FE
    // re-fans-out on the next off-screen tick.
    this.lastTickOffscreenIds = [];
  }

  /**
   * Rebuild the (derived) soul recall index from the persisted arc after a restore (0030/0041). The
   * AUTHORITATIVE arc lives in each houseguest's `soul.memory`/`emotionalHistory` (persisted
   * losslessly with the house); the vector index is re-derived so `recall` keeps working post-restart.
   */
  private rebuildSoulIndex(): void {
    if (!this.house || !this.soul) return;
    for (const hg of [this.house.player, ...this.house.npcs]) {
      for (const note of hg.soul.memory) this.soul.recordToSoul(hg.id, note);
    }
  }

  /** Engine/loop-internal: record the public ceremony facts the status panel projects. */
  updateCeremony(partial: Partial<CeremonyState>): void {
    this.ceremony = { ...this.ceremony, ...partial };
    this.persist();
  }

  private nameOf(id: EntityId): string {
    if (!this.house) return id;
    if (this.house.player.id === id) return this.house.player.name;
    return this.house.npcs.find((n) => n.id === id)?.name ?? id;
  }

  /**
   * PUBLIC roster name → outward name resolver (non-Vault: names are public). Returns undefined
   * for an id NOT on the live roster, so outward prose can fall back rather than echo a raw id.
   * Wired into the player surface (registry) so socialRead names the houseguest instead of "npc:N".
   */
  publicName(id: EntityId): string | undefined {
    if (!this.house) return undefined;
    if (this.house.player.id === id) return this.house.player.name;
    return this.house.npcs.find((n) => n.id === id)?.name;
  }

  /**
   * The PUBLIC house roster (id → public name) — non-Vault: names are public roster facts, nothing
   * else crosses. Wired into the outward `VisibleStateService` (registry) so player-facing event /
   * knowledge content names houseguests instead of echoing raw `npc:N` ids (audit R4-03 / C-01).
   * Empty before the house exists.
   */
  publicRoster(): { id: EntityId; name: string }[] {
    if (!this.house) return [];
    return [
      { id: this.house.player.id, name: this.house.player.name },
      ...this.house.npcs.map((n) => ({ id: n.id, name: n.name })),
    ];
  }

  private card(id?: EntityId): { id: EntityId; name: string } | null {
    return id ? { id, name: this.nameOf(id) } : null;
  }

  gameStatus(): PublicGameStatus {
    return {
      beatSeq: this.beatSeq, // 0065 Part A — the monotonic CAS token; Vault-free
      week: this.week,
      phase: this.phase,
      ...(this.timeOfDayEnabled && this.live?.timeOfDay ? { timeOfDay: this.live.timeOfDay, dayNumber: this.live.dayNumber ?? 1, asleep: this.asleepNpcs() ?? [] } : {}), // ADR 0006: the public day-phase + who's turned in (observable); ORW-115: + the day number the HUD shows
      day: dayOfWeek(this.phase), // E58: the canonical beat→day index (hoh=1 … eviction=5), or null off-ladder
      hoh: this.card(this.ceremony.hoh),
      nominees: this.ceremony.nominees.map((id) => ({ id, name: this.nameOf(id) })),
      veto: {
        holder: this.card(this.ceremony.vetoHolder),
        used: this.ceremony.vetoUsed,
        // E35/audit C-03: the drawn six (the witnessed chip draw) — empty before the draw, so the
        // narrator names THESE exact players rather than inventing who competes. Read straight off
        // the live field (persisted, 0030); cleared with the rest of the week's ceremony state.
        players: (this.live?.vetoField ?? []).map((id) => ({ id, name: this.nameOf(id) })),
      },
      // The live pending (Vault-free legal options) so the decision card re-arms from engine truth
      // on reload — not the FE's process-local last-seen cache, which a FE restart wipes.
      pending: this.pendingView(),
      // 0123 (PO ruling 2026-11-01) — a standing NPC deal offer, voiced in-scene by the narrator (no card).
      // Present ONLY while one stands, so the flag-off payload is byte-identical (no `openDealOffer: null`).
      ...(this.live?.dealOffer ? { openDealOffer: this.openDealOfferView() } : {}),
      // F3: the same public over-signal + broadcast winner the AdvanceView/SeasonRecap expose, so a
      // status-only client learns the season ended (and who won) without separately hitting /state or
      // /recap — otherwise it hangs on the last ceremony state post-season. Vault-free (public winner).
      finished: !!this.live?.finished,
      winner: this.named(this.live?.winner),
      ...(this.alliances.forMember(PLAYER).length ? { alliances: this.playerAllianceViews() } : {}),
      // 0107 Phase B: alliances an NPC has pitched the player (aware of, not yet in) — accept via joinAlliance.
      ...(this.alliances.pitchesFor(PLAYER).length ? { alliancePitches: this.alliances.pitchesFor(PLAYER).map((a) => this.allianceView(a)) } : {}),
    };
  }

  /** The houseguests still in the game (player + non-evicted NPCs) — the legal references for an
   *  interaction (B39). Empty before a game starts. */
  livingIds(): EntityId[] {
    if (!this.house) return [];
    const evicted = new Set(this.live?.evictionOrder ?? []);
    return [this.house.player.id, ...this.house.npcs.filter((n) => !evicted.has(n.id)).map((n) => n.id)];
  }

  /** The houseguests presence tracks: the living, MINUS an evicted player (the evicted are nowhere). */
  private presenceActive(): EntityId[] {
    const evicted = new Set(this.live?.evictionOrder ?? []);
    return this.livingIds().filter((id) => !evicted.has(id));
  }

  /**
   * The room-assignment deps. `affinity` (allies drift together) + the HOH-room pull are always present;
   * the per-NPC MOVEMENT PERSONALITY (L21/L24) is included ONLY when `weighted` — it reads the static
   * CHARACTER `stats.social` and the dynamic SOUL `volatility` (facts the engine already holds) so a
   * social butterfly roams and seeks company while a low-social/settled one holds a room. The profile
   * NEVER draws rng; it only re-weights the move-gate threshold and the affinity pull (the L21/L24
   * isolation guarantee). No number crosses the Vault Wall — presence reads stay Vault-free.
   *
   * ONLY NPCs are personality-weighted — the PLAYER returns `null` (no profile). The player is a person
   * the engine never relocates (moved only by `movePlayer`), so weighting their movement is meaningless;
   * keeping them un-weighted ALSO makes the player's room identical in the weighted and base views, which
   * keeps the calibration-neutral base fully invariant to the personality constants (the NPCs cluster
   * around the same player room in both).
   */
  private presenceDeps(
    rng: RandomnessSource,
    weighted: boolean,
    sceneRoom?: Room | null,
    // issue #792: SEATED sub-zone output + the prior seating, supplied ONLY on the weighted, player-facing
    // pass (so zone drift/cluster draws ride the DEDICATED movement stream, never the shared spine).
    zonesOut?: Map<EntityId, Zone>,
    previousZones?: ReadonlyMap<EntityId, Zone> | null,
  ): Parameters<typeof assignRooms>[2] {
    const playerId = this.house?.player.id;
    return {
      rng,
      affinity: (a, b) => this.rel.edge(a, b).affinity,
      hoh: this.ceremony.hoh ?? null,
      // issue #792: seat sub-zones on the weighted pass only (calibration-neutral, dedicated stream).
      ...(zonesOut ? { zonesOut, previousZones: previousZones ?? null, zoneSalt: this.gameSeed ?? "" } : {}),
      // 0078: INTENTIONAL movement — supplied on BOTH passes (the base AND the weighted view). Unlike the
      // L21/L24 personality `movement` (calibration-NEUTRAL, weighted-only), intent is DELIBERATELY
      // calibration-load-bearing (owner ruling: location must affect play), so the off-screen society
      // (which pairs on the BASE occupancy) sees the same motivated clustering the player observes. The
      // PLAYER returns null (a person, never engine-driven by an agenda; `movePlayer` owns their moves),
      // which keeps the player's room identical in both views (the base pass pins them either way).
      intent: (id: EntityId) => (id === playerId ? null : this.movementIntentFor(id)),
      ...(weighted
        ? {
            movement: (id: EntityId) => (id === playerId ? null : {
              social: this.statsOf(id).social,
              // A live soul carries the current turbulence; fall back to the settled center (0.5) when
              // there is none (e.g. a standalone adapter without souls) so the term is a no-op there.
              volatility: this.soulObj(id)?.volatility ?? 0.5,
            }),
            // 0076: only the player-facing WEIGHTED pass holds present company in the live scene. The
            // calibration-neutral BASE pass NEVER gets a sceneRoom, so its shared-stream draw count is
            // byte-identical to the pre-0076 build (the juryReach spine is untouched).
            ...(sceneRoom ? { sceneRoom, sceneMoveProb: PRESENCE.companionMoveProb } : {}),
            // ORW-212 / ORW-210: calm, non-magnetic movement on the player-facing pass (ORWELL_CALM_PRESENCE, default ON; OFF => the previous behaviour).
            ...(this.calmPresenceEnabled && weighted
              ? { calm: { moveScale: CALM_PRESENCE.moveScale, maxMovers: Math.max(1, Math.floor(this.presenceActive().length * CALM_PRESENCE.maxMoverShare)), startOffset: this.presenceTickCount, holdIds: this.conversationHold(), playerId: playerId ?? PLAYER, excludePlayerPull: !CALM_PRESENCE.playerPullsDestinations } }
              : {}),
          }
        : {}),
    };
  }

  /**
   * A houseguest's MOTIVATED movement targets this tick (feature 0078) — WHERE their agenda points,
   * read off the directed relationship model (the same Vault-free edges presence already uses; no
   * number crosses the wall, and this draws NO rng). An NPC is drawn toward whoever they have a strong
   * CHARGED tie with — a bond to deepen OR a threat to WORK (any reason to seek them out) — and softly
   * AWAY from a pure danger they have no bond to leverage. Co-presence thus reflects agenda, not luck.
   *
   * The signal is a BOUNDED read of the existing edge signals (no new state): toward-pull rises with
   * `max(bondStrength, threat)` above the neutral baseline; a pull becomes `avoid` only when threat
   * clearly dominates the bond (a houseguest you fear and have nothing to gain from — you keep distance).
   * Returns only the meaningfully-charged others (a small set), so a typical tick steers an NPC toward
   * the one or two houseguests their game actually centers on, leaving the rest to seeded drift.
   */
  private movementIntentFor(id: EntityId): MovementIntent | null {
    if (!this.house) return null;
    const C = RELATIONSHIP_CONSTANTS;
    const neutralBond = (C.baseline.trust + C.baseline.affinity) / 2;
    const pulls: MovementPull[] = [];
    for (const other of this.presenceActive()) {
      if (other === id) continue;
      const e = this.rel.edge(id, other);
      const bond = this.rel.bondStrength(id, other); // trust+affinity, shaded by demonstrated loyalty
      const threat = e.threat;
      // Charge = how far the strongest signal sits above neutral. Bond and threat BOTH pull you toward
      // them (an ally to keep close, a rival to corner). Below-neutral on both ⇒ no agenda (skip).
      const bondCharge = Math.max(0, bond - neutralBond);
      const threatCharge = Math.max(0, threat - C.baseline.threat);
      const charge = Math.max(bondCharge, threatCharge);
      if (charge < MOVEMENT_INTENT.minCharge) continue; // not charged enough to bend movement — let drift rule
      // AVOID only when a real danger clearly outweighs any bond to work — you keep distance from a pure
      // threat, but you still CLOSE on a rival you can scheme against (a charged threat WITH some bond).
      const avoid = threatCharge >= bondCharge * MOVEMENT_INTENT.avoidThreatDominance && bondCharge < MOVEMENT_INTENT.workableBondFloor;
      pulls.push({ target: other, weight: charge, avoid });
    }
    if (this.wantMovementEnabled) this.applyWantToPulls(id, pulls);
    if (this.copresenceEnabled && this.heldSeeker) this.applyHeldFactsToPulls(id, pulls);
    return pulls.length ? pulls : null;
  }

  /** B35 - reads the holder's undelivered high-motive facts (wired by the registry; absent => no seeking). */
  private heldSeeker?: (holder: EntityId, listeners: readonly EntityId[]) => Array<{ listener: EntityId; motive: number }>;
  setHeldFactSeeker(fn: (holder: EntityId, listeners: readonly EntityId[]) => Array<{ listener: EntityId; motive: number }>): void { this.heldSeeker = fn; }
  /**
   * B35 - SEEKING (design B10 S4): a houseguest holding a high-motive fact they have not yet decided to tell someone leans their movement toward that listener, through the same pull channel as the A10
   * want, so the right audience is likelier to be in the room when the spread runs. Never lowers a pull; no rng; the player is never a listener (off-screen spreads exclude them). Only while the
   * co-presence layer is ON (the told ledger is empty and nothing is decided otherwise). Pure read of knowledge + the told ledger.
   */
  private applyHeldFactsToPulls(id: EntityId, pulls: MovementPull[]): void {
    const listeners = this.presenceActive().filter((o) => o !== id && o !== PLAYER);
    for (const t of this.heldSeeker!(id, listeners)) {
      if (t.motive < SEEK.minMotive) continue;
      const scale = 1 + SEEK.k * t.motive;
      const existing = pulls.find((p) => p.target === t.listener);
      if (existing) existing.weight *= scale;
      else pulls.push({ target: t.listener, weight: MOVEMENT_INTENT.minCharge * scale, avoid: false });
    }
  }

  /**
   * A10 - fold the NPC's current WANT into its movement pulls. The want (A8 `desireFor`) points at a target - the HOH for a campaign/plea, the nominees for a probe - and its
   * urgency (A8 `urgency`: rising toward the event, spent by an approach) scales the pull. Never lowers an existing pull; a want whose target had no pull ADDS one. No rng (movement
   * stays on its isolated stream); a check-in has no target. Pure read of public standing + the clock.
   */
  private applyWantToPulls(id: EntityId, pulls: MovementPull[]): void {
    const live = this.live;
    if (!live || !firstCeremonyBeatResolved(live)) return;
    const m = nextMilestone(live);
    const noms = new Set<EntityId>(this.ceremony.nominees ?? []);
    const desire = desireFor(m?.beat, { isHoh: this.ceremony.hoh === id, isNominee: noms.has(id) });
    if (!desire || desire === "check-in") return;
    const targets: EntityId[] = desire === "probe" ? [...noms] : (this.ceremony.hoh !== undefined ? [this.ceremony.hoh] : []);
    const until = m ? Math.max(0, m.targetHour - (live.nightDepth ?? WAKE_HOUR)) : null;
    const since = live.desireApproachedAt?.[id];
    const drive = pulls.reduce((a, p) => Math.max(a, p.weight), MOVEMENT_INTENT.minCharge);
    const scale = wantScale(desireUrgency({ desire, drive, hoursUntil: until, hoursSinceApproach: since === undefined ? undefined : this.absHour() - since }));
    for (const t of targets) {
      if (t === id) continue;
      const existing = pulls.find((p) => p.target === t);
      if (existing) existing.weight *= scale;
      else if (scale > 1) pulls.push({ target: t, weight: MOVEMENT_INTENT.minCharge * scale, avoid: false }); // a spent want (scale 1) adds nothing: back to exactly today's intent
    }
  }

  /**
   * The DEDICATED, isolated movement RNG stream (L21/L24). Forked off the GAME seed + the persisted
   * presence-tick counter, so it is fully reproducible AND completely separate from the orchestrator's
   * shared per-user stream that drives the off-screen society + relationship folds + competitions/votes.
   * Both the base and the personality-weighted assignment draw from THIS stream — never the shared one —
   * so the movement weighting cannot perturb the seeded competition/vote calibration.
   */
  private movementRng(): SeededRandom {
    const root = this.gameSeed ?? this.house?.player.name ?? "season";
    return new SeededRandom(hashSeed(`${root}:presence-move:${this.presenceTickCount}`));
  }

  /**
   * Re-seat the house for a new off-screen tick (0049): every active houseguest stays put or moves
   * to an ADJACENT room, clustered by affinity + personality (L21/L24). The orchestrator calls this
   * once per tick; lingering player turns never move the week — only the rooms.
   *
   * THE CALIBRATION INVARIANT (L21/L24 — the jury-reach root cause). The off-screen society pairs
   * CO-PRESENT NPCs, so its occupancy is calibration-LOAD-BEARING (it feeds relationship folds →
   * nominations/votes downstream). Before this feature, `presenceTick` drew its room rolls straight
   * from the orchestrator's SHARED per-user `rng` — so the move/room draws were part of the calibrated
   * spine, and every later shared-stream consumer (society/gossip/confessional/votes) saw a specific
   * sequence. To stay byte-identical to that spine, the BASE (un-weighted) assignment STILL draws from
   * the SHARED `rng`, with the exact same algorithm and draw count as before — so the shared stream is
   * advanced identically and the seeded competition/vote outcomes are byte-for-byte unchanged. (The
   * prior reverted attempt added EXTRA shared-stream draws for weighting; the first ship of this feature
   * over-corrected and drew NONE from the shared stream — both re-phased the spine and broke juryReach.)
   *
   * TWO assignments:
   *   • the BASE (un-weighted) occupancy — `presenceBase`, what `societyOccupancy()` feeds the society.
   *     Drawn from the SHARED `rng`, un-weighted, identical to the pre-L21/L24 build ⇒ INVARIANT to the
   *     personality constants AND byte-identical to the calibrated spine (proven by `movementStreamIsolation`
   *     + `juryReach`).
   *   • the personality-WEIGHTED occupancy — `presence`, the player-facing positions (`whereabouts`,
   *     witnessing). Drawn from a DEDICATED `movementRng()` stream (never the shared one), so however the
   *     weighting moves the house it cannot perturb calibration. The player never observes the hidden
   *     society's pairing, so one-place-at-a-time still holds for everything the player sees.
   */
  /**
   * ORW-212 / ORW-210 - CALM, non-magnetic movement (Ryne: "they are all moving too fast" / "NPCs gravitate to wherever the player is"). ON unless `ORWELL_CALM_PRESENCE=0`; OFF => the previous
   * 0076 behaviour. Player-facing (weighted) view only: the calibration-neutral base is untouched. The 0076 scene-hold now keeps only the houseguests the player is actually talking to (the partners of the
   * last recorded scene, for `CALM_PRESENCE.holdTicks` ticks); the player no longer pulls NPC destinations; the house moves gradually (a per-tick mover cap) and at a calmer rate.
   */
  private calmPresenceEnabled = flagDefaultOn("ORWELL_CALM_PRESENCE");
  setCalmPresenceEnabled(on: boolean): void { this.calmPresenceEnabled = on; }
  private convoPartners: { ids: EntityId[]; tick: number } | null = null;
  /** A recorded player scene's NPC partners: the houseguests the player is talking to (memory-only). */
  noteConversationPartners(ids: readonly EntityId[]): void {
    this.convoPartners = { ids: ids.filter((i) => i !== PLAYER), tick: this.presenceTickCount };
  }
  private conversationHold(): ReadonlySet<EntityId> {
    const c = this.convoPartners;
    return c && this.presenceTickCount - c.tick <= CALM_PRESENCE.holdTicks ? new Set(c.ids) : new Set<EntityId>();
  }
  presenceTick(rng?: RandomnessSource): void {
    if (!this.house) return;
    // Advance the dedicated movement stream by one tick FIRST, so the WEIGHTED pass draws a fresh,
    // reproducible sub-stream (and a resumed game continues the deterministic sequence from the counter).
    this.presenceTickCount += 1;
    const me = this.house.player.id;
    const prev = this.presence;
    // The PLAYER's room is authoritative and IDENTICAL in both views — the player is never personality-
    // weighted (only NPCs are); they move only by their own `movePlayer`. So both passes pin the player at
    // the SAME real room; only NPC positions differ between the calibration-neutral base and the weighted view.
    const playerRoom = prev?.get(me) ?? null;
    // The base evolves from its OWN history (so it is INVARIANT to the personality constants — the society's
    // occupancy, and thus the seeded competition/vote outcomes, are byte-identical whether weighting is on
    // or off). Pre-L21/L24 saves have no separate base — seed it from the only positions we have.
    const prevBase = this.presenceBase ?? prev;

    // Compute one assignment for a given weighting. `weighted` ⇒ the DEDICATED movement stream (isolated
    // from calibration); un-weighted ⇒ the caller's SHARED `rng` (the calibrated spine the society reads),
    // falling back to the dedicated stream only when no shared rng is supplied (standalone/test callers).
    // issue #792: the weighted pass seats sub-zones into THIS map (drift reads the prior seating). The base
    // pass passes no `zonesOut` ⇒ seats nothing ⇒ draws nothing extra on the shared stream (calibration-safe).
    const nextZone = new Map<EntityId, Zone>();
    const assign = (previous: Occupancy | null, weighted: boolean): Map<EntityId, Room> => {
      const stream = weighted ? this.movementRng() : (rng ?? this.movementRng());
      // 0076: present company holds the player's live scene — but ONLY in the weighted, player-facing view
      // (the base pass stays calibration-neutral). No scene exists at premiere seating (no player room yet).
      const sceneRoom = weighted ? playerRoom : null;
      const zonesOut = weighted ? nextZone : undefined;
      const prevZones = weighted ? this.presenceZone : null;
      if (!previous) {
        // Premiere seating — the ONE time everyone (the player included) is placed at once.
        return assignRooms(this.presenceActive(), null, this.presenceDeps(stream, weighted, sceneRoom, zonesOut, prevZones));
      }
      // L21/L24: the PLAYER is a person — the engine NEVER auto-relocates them. Pin them (in BOTH views) at
      // their real room; the engine drives only the NPCs around the held player.
      const pinned = playerRoom ? new Map<EntityId, Room>([[me, playerRoom]]) : null;
      return assignRooms(this.presenceActive().filter((id) => id !== me), previous, this.presenceDeps(stream, weighted, sceneRoom, zonesOut, prevZones), pinned);
    };

    // The BASE draws from the SHARED `rng` FIRST — the same single un-weighted `assignRooms` call (same
    // active set, same `prev`, same pinned player) the pre-L21/L24 build made, so the shared stream is
    // advanced byte-identically to the calibrated spine.
    const nextBase = assign(prevBase, false);   // calibration spine — the society's occupancy
    const next = assign(prev, true);            // personality-weighted — the player's positions
    // The player's position is authoritative and identical in both views (never personality-weighted) —
    // force the base to agree with the weighted player room so a player overhear of an off-screen scene
    // reads the player's REAL room, and the two views never disagree about where the player is.
    const realPlayerRoom = next.get(me);
    if (realPlayerRoom) nextBase.set(me, realPlayerRoom);

    // L21/L24: room tenure (player-facing) — a houseguest who held their room this tick keeps
    // accumulating; a mover resets to 0. Grounds scene continuity in `whereabouts`.
    const tenure = new Map<EntityId, number>();
    for (const [id, room] of next) {
      const stayed = prev?.get(id) === room;
      tenure.set(id, stayed ? (this.presenceTenure?.get(id) ?? 0) + 1 : 0);
    }
    // issue #792: commit the freshly-seated sub-zones (player-facing view) BEFORE the tracked-sighting
    // observe loop, so a sighting into a zoned private room (the lounge) records this tick's seated zone.
    // `seatZones` only writes ids in zoned rooms, so a houseguest who left a zoned room simply drops out.
    this.presence = next;
    this.presenceBase = nextBase;
    this.presenceTenure = tenure;
    this.presenceZone = nextZone;
    // 0077: the player TRACKS any houseguest they watched head into a closed room this tick — their
    // origin was in the player's eyeshot. Pure read-side (no rng), so the calibration spine is untouched.
    const meRoom = next.get(me);
    if (prev && meRoom) {
      for (const [id, room] of next) {
        const from = prev.get(id);
        if (from && from !== room) this.observeMoveIntoPrivate(id, from, room, meRoom);
      }
    }
  }

  /**
   * The player DIRECTS their own movement (L21/L24 — the player is a person, not engine-relocated):
   * walk to a room they NAMED. The name is resolved FORGIVINGLY (`resolveRoom`) — case/space/hyphen-
   * insensitive, natural aliases ("living room"/"lounge", "backyard"/"yard", "HOH", "pantry"), and a
   * bare "bedroom" disambiguated to the player's current/adjacent bedroom — so a guessed room never
   * silently no-ops into the narrator's 5-retry "isn't mapping" loop (the real-log bug). Sets the
   * player's room, resets their tenure; the engine holds them there (NPCs drive around them) until the
   * next directed move. For a truly UNKNOWN name it leaves the player put and returns the current
   * whereabouts unchanged (the model knows the valid rooms from the moment prompt, so this is rare).
   * Returns the resulting whereabouts so the caller can voice the move. Vault-free.
   */
  movePlayer(room: string, expectedBeatSeq?: number): WhereaboutsView | null {
    // 0065 Part A — refuse a move computed against a superseded board BEFORE any mutation.
    this.guardBeatSeq(expectedBeatSeq);
    if (!this.house || !this.presence) return null;
    // 0106: during a whole-house event (a comp or a ceremony) the player is gathered with the house — they
    // cannot wander off into a side room until it resolves. Report the gathered scene unchanged (a no-op).
    if (this.houseEventInSession()) return this.whereabouts();
    const me = this.house.player.id;
    const here = this.presence.get(me) ?? null;
    // Forgiving resolution (Vault-free, deterministic): natural names → a canonical room id; the
    // player's current room sharpens an ambiguous "bedroom". An ambiguous result still moves (we take
    // the best-guess first candidate) rather than no-op — never a silent failure into a retry loop.
    const resolved = resolveRoom(room, here);
    const dest =
      resolved.kind === "ok" ? resolved.room
      : resolved.kind === "ambiguous" ? resolved.candidates[0]!
      : null;
    if (dest === null) return this.whereabouts(); // truly unknown — stay put, report where they are
    if (here === dest) return this.whereabouts(); // already there — nothing to move
    this.presence.set(me, dest);
    // L21/L24: the player's position is identical in both views — keep the calibration-neutral base in sync
    // so the society's player-overhears and `whereabouts` always agree about where the player is.
    this.presenceBase?.set(me, dest);
    (this.presenceTenure ??= new Map()).set(me, 0); // a fresh arrival
    this.persist();
    return this.whereabouts();
  }

  /**
   * ADR 0009 — RECORD a narrated houseguest relocation (the "fold" path: the model narrates the open
   * texture of who wanders where; the engine records it so the board agrees with the prose and there
   * is never a visible historic conflict). Mutates ONLY the open, player-facing `presence` map (and
   * that NPC's tenure) — NEVER `presenceBase`, the calibration-neutral baseline that feeds the seeded
   * off-screen society/comp/vote stream — so recording a move is byte-identical for every seeded
   * outcome (ADR 0005 split-authority; mandate #3). Vault-free.
   *
   * LEGAL-MOVES-ONLY (the ADR-0009 D3 contract): the return distinguishes a recorded move from an
   * IMPOSSIBLE claim the surface must instead catch BEFORE emission —
   *   • `moved`   — the houseguest is now in `room`;
   *   • `noop`    — already there (still consistent, nothing to persist);
   *   • `illegal` — an unknown/evicted houseguest, the PLAYER (their own agency is `movePlayer`), or an
   *                 unresolvable / non-walkable room (the diary room is a ceremony beat, never a
   *                 hangout). Never silently mutates on an illegal input.
   */
  recordHouseguestMove(id: EntityId, room: string): HouseguestMoveResult {
    if (!this.house || !this.presence) return { status: "illegal", whereabouts: this.whereabouts() };
    // The player directs their OWN movement (movePlayer); this path records a NARRATED NPC relocation.
    if (id === this.house.player.id) return { status: "illegal", whereabouts: this.whereabouts() };
    // Only an ACTIVE houseguest currently in the live house can be relocated (evicted ⇒ not in presence).
    const here = this.presence.get(id);
    if (here === undefined) return { status: "illegal", whereabouts: this.whereabouts() };
    // Forgiving resolution, then reject the unknown AND the non-walkable so the open occupancy stays
    // coherent (no one "hangs out" in the diary room — assignRooms/WALKABLE_ROOMS exclude it).
    const resolved = resolveRoom(room, here);
    const dest =
      resolved.kind === "ok" ? resolved.room
      : resolved.kind === "ambiguous" ? resolved.candidates[0]!
      : null;
    if (dest === null || !WALKABLE_ROOMS.includes(dest)) return { status: "illegal", whereabouts: this.whereabouts() };
    if (here === dest) return { status: "noop", whereabouts: this.whereabouts() };
    // OPEN set only — `presenceBase` is deliberately NOT touched (calibration neutrality, see above).
    this.presence.set(id, dest);
    (this.presenceTenure ??= new Map()).set(id, 0); // a fresh arrival
    // 0077: a NARRATED relocation the player can see into a closed room is tracked, same as a drift.
    const myRoom = this.presence.get(this.house.player.id);
    if (myRoom) this.observeMoveIntoPrivate(id, here, dest, myRoom);
    this.persist();
    return { status: "moved", whereabouts: this.whereabouts(), beatSeq: this.beatSeqNow() }; // A29: the post-commit token
  }

  /**
   * The player-facing occupancy ground truth (engine/registry wiring — never projected raw to the player).
   * Carries the personality-WEIGHTED NPC positions (L21/L24) — what the player observes via `whereabouts`
   * and what witnessing a player scene reads.
   */
  occupancy(): Occupancy | null {
    return this.presence;
  }

  /**
   * The occupancy the WITNESS grounding reads (registry presence provider). `occupancy()` stays the raw open-set map (the ADR 0009 record contract: a recorded NPC move lands in it);
   * this adds the premiere overlay on top, a read-only copy.
   */
  witnessOccupancy(): Occupancy | null {
    // A11 (finding from #2088): while a WHOLE-HOUSE premiere event is on (the gathered champagne circle / toast, or the staged entrances) `whereabouts()` shows everyone convened in the
    // player's room, but this base map still held the underlying wander positions - so a chat during the toast hit the phantom-witness check ("not in the room") and folded nothing. The
    // witness grounding must read the SAME overlay the player sees. Only the two premiere events; every other path (and flag-off) returns the base map untouched.
    const base = this.presence;
    const live = this.live;
    if (!base || !live || !this.house) return base;
    const entrances = live.premiereEntrance?.stage === "entrances";
    if (!entrances && live.champagneCircle !== "gathered") return base;
    const me = this.house.player.id;
    const room = base.get(me) ?? "living-room";
    const inside = entrances ? new Set<EntityId>(live.premiereEntrance!.order.slice(0, live.premiereEntrance!.arrived)) : null;
    const overlay = new Map(base) as Map<EntityId, Room>;
    for (const n of this.house.npcs) {
      if (this.seatOf(n.id) !== "active") continue;
      if (inside && !inside.has(n.id)) overlay.delete(n.id); // not arrived yet: not in the house, so not a witness
      else overlay.set(n.id, room);
    }
    return overlay;
  }

  /**
   * The houseguests still AWAKE right now (ADR 0006 — the diegetic bound, the SOCIAL half of the sleep
   * economy). When the clock is running, anyone past their character-driven bedtime has turned in for
   * the night and drops out of the living house; as the night thins the set shrinks toward the player +
   * the night owls. The PLAYER is awake unless THEY chose to turn in (never auto-slept — §Principle 6).
   * Returns `null` when the clock is OFF (or hasn't started) ⇒ "everyone is awake" ⇒ every caller below
   * is the IDENTITY ⇒ byte-identical to the pre-feature model (the seeded juryReach/UAT calibration spine
   * is unmoved). Pure read off the shared phase + the STATIC aptitudes (`bedtimeFor`): draws no rng, and
   * reads no soul/Vault number.
   */
  /** ADR 0006 — the awake set for the command port's witness/overhear grounding (`null` ⇒ clock off ⇒ everyone up). */
  awakeIds(): ReadonlySet<EntityId> | null {
    return this.awakeNow();
  }

  private awakeNow(): Set<EntityId> | null {
    if (!this.timeOfDayEnabled || !this.live?.timeOfDay || !this.house) return null;
    return new Set(
      awakeSet({
        active: this.presenceActive(),
        hour: this.live.nightDepth ?? WAKE_HOUR, // the clock-HOUR (8..32) — the 24-hour model (#1125)
        player: this.house.player.id,
        playerRetired: this.live.playerRetired ?? false,
        bedtimeOf: (id) => this.effectiveBedDepth(id), // chronotype bedtime HOUR, conflict-drained (0066 Phase-2)
      }),
    );
  }

  /**
   * The subset of `ids` still awake (ADR 0006) — the off-screen society pairs only houseguests who are
   * UP, so the night owls scheme on while the early-to-bed (and a turned-in player) miss it. The
   * orchestrator's off-screen tick routes the living NPCs through here. IDENTITY (a stable-order copy)
   * when the clock is off ⇒ the hidden society + its calibration spine are byte-identical.
   */
  awakeAmong(ids: readonly EntityId[]): EntityId[] {
    const awake = this.awakeNow();
    return awake ? ids.filter((id) => awake.has(id)) : [...ids];
  }

  /**
   * 0066 Phase-2 (Extension 2 — NPC next-day social fatigue): the off-screen fold-magnitude scale (≤1) for
   * a scene's INITIATOR — a tired houseguest sways the house LESS (reduced EFFECTIVENESS, never a
   * personality change; the scene's nature is unchanged). Returns 1 (NO scaling) unless the dedicated
   * social-fatigue flag is on (AND the clock is running) ⇒ the hidden society + its seeded calibration
   * spine are BYTE-IDENTICAL; reduced sway only on that live path, keyed off the same hidden rest deficit
   * the competition fold consumes. Pure — no rng. No number crosses the wall.
   */
  socialFoldScale(id: EntityId): number {
    if (!this.socialFatigueEnabled) return 1; // Extension 2 off ⇒ the off-screen fold is byte-identical
    return socialSwayScale(this.restDeficitOf(id));
  }

  /**
   * #1419 — the ASYMMETRIC social-fatigue scale for a scene's INITIATOR: a tired houseguest is worse at
   * charm (`warm` < 1 dampens WARMING folds — bonding, trust, warming a bond) while their barbs cut DEEPER
   * (`sore` ≥ 1 amplifies SOURING folds — conflict, threat, souring). "A bias for negative consequence":
   * harder to scheme when you aren't sleeping. `{ warm: 1, sore: 1 }` (no change) unless the social-fatigue
   * flag is on AND the clock is running ⇒ the hidden society + its seeded calibration spine are BYTE-
   * IDENTICAL; the asymmetric fold fires only on the live clock-ON game. Pure — no rng, no number crosses.
   */
  socialFoldValence(id: EntityId): { warm: number; sore: number } {
    if (!this.socialFatigueEnabled) return { warm: 1, sore: 1 };
    const deficit = this.restDeficitOf(id);
    return { warm: socialSwayScale(deficit), sore: soreSwayScale(deficit) };
  }

  /** The hidden rest deficit (0..1) a houseguest carries TODAY: tonight's immediate deficit (graded by how
   *  late they were up — conflict-drained when Extension 2 is on) plus, ONLY when Extension 3 is on, the
   *  compounding multi-night fatigue meter. 0 when the clock is off ⇒ byte-identical to the calibration
   *  spine. Feeds the comp fold (Phase-1) and the social sway (Extension 2). Pure — no rng. */
  private restDeficitOf(id: EntityId): number {
    if (!this.timeOfDayEnabled || !this.live?.timeOfDay) return 0;
    const immediate = id === PLAYER
      ? playerRestDeficit(this.live)
      : npcRestDeficit(this.live, this.statsOf(id), id, this.effectiveBedDepth(id), this.lateCompanyFor(id));
    // Extension 3 (compounding multi-night meter): only ADD the accumulated meter when its own flag is
    // on; off ⇒ just the single-night immediate deficit (byte-identical to the Phase-1 comp term).
    if (!this.multiNightFatigueEnabled) return immediate;
    const fatigue = id === PLAYER ? (this.live.playerFatigue ?? 0) : (this.live.npcFatigue?.[id] ?? 0);
    return combinedRestDeficit(immediate, fatigue);
  }

  /** 0066 Phase-2 (Extension 3): roll every houseguest's multi-night fatigue meter at a genuine NIGHT-END
   *  (the player turned in, or the house ran to the bitter end). EMA: decay the prior, add the night just
   *  ended. Fires once per night. A NO-OP unless Extension 3 is enabled ⇒ the meter stays absent ⇒ 0 ⇒
   *  byte-identical. Pure — no rng. */
  private accrueNightFatigue(): void {
    if (!this.multiNightFatigueEnabled || !this.live || !this.house) return;
    const lastNight = (id: EntityId): number => id === PLAYER
      ? playerRestDeficit(this.live!)
      : npcRestDeficit(this.live!, this.statsOf(id), id, this.effectiveBedDepth(id), this.lateCompanyFor(id));
    this.live.playerFatigue = accrueFatigue(this.live.playerFatigue ?? 0, lastNight(PLAYER));
    const next: Record<EntityId, number> = { ...(this.live.npcFatigue ?? {}) };
    for (const n of this.house.npcs) next[n.id] = accrueFatigue(next[n.id] ?? 0, lastNight(n.id));
    this.live.npcFatigue = next;
  }

  /** 0066 Phase-2: an NPC's effective turn-in HOUR tonight = their chronotype bedtime hour, pulled EARLIER
   *  by any conflicts they were in this night (Extension 2 — a fight drains you to bed). Floored at the
   *  early-evening hour. Drives both who is awake late (`awakeNow`) and their next-day sleep deficit,
   *  coherently. With Extension 2 off the conflict tally is never populated, so this is just the base
   *  chronotype bedtime hour ⇒ byte-identical. */
  private effectiveBedDepth(id: EntityId): number {
    const base = bedtimeDepthFor(this.statsOf(id), id); // clock-HOUR (24-hour model)
    const conflicts = this.nightConflicts.get(id) ?? 0;
    return Math.max(BEDTIME_DEPTH_FLOOR, base - CONFLICT_BEDTIME_DRAIN * conflicts);
  }

  /** 0066 Extension 4 — the count of OTHER active NPCs who are natural night-owls tonight (their own
   *  conflict-drained chronotype bedtime runs past midnight) and would be up as late company. Feeds the
   *  EMERGENT bedtime (`npcRestDeficit`): an owl only lingers (and pays sleep debt) when they had company
   *  to stay up with — alone on a dead night they wind down early and carry none (never a flat archetype
   *  tax). The player is excluded (their staying-up is the separate `nightEnd`/social-floor extension).
   *  Pure — reads the same deterministic chronotype math; no rng. */
  private lateCompanyFor(id: EntityId): number {
    let n = 0;
    for (const other of this.presenceActive()) {
      if (other === id || other === PLAYER) continue;
      if (this.effectiveBedDepth(other) > CLOCK.midnightHour) n++;
    }
    return n;
  }

  /** Clear the per-night conflict tally at the moment the day rolls over (a fresh morning at the 8am wake) —
   *  tonight's fights don't follow anyone into tomorrow. Called right after the clock advances / the player
   *  turns in; a no-op mid-day (still the same night) and harmless at game start (empty). */
  private rollNightConflicts(): void {
    if (this.live?.timeOfDay === DAY_START && (this.live?.nightDepth ?? WAKE_HOUR) === (this.live?.wakeHour ?? WAKE_HOUR)) this.nightConflicts.clear();
  }

  /**
   * The living houseguests who have TURNED IN for the night (ADR 0006) — the complement of the awake set
   * among the NPCs. Vault-free and OBSERVABLE (you'd see who's no longer around / an empty bed); the
   * bedtime DERIVATION stays hidden. `undefined` when the clock is off (dormant) ⇒ the projection omits
   * the field. The player is never listed — their own night is the `turnIn` lever + their rest cue.
   */
  private asleepNpcs(): NamedRef[] | undefined {
    const awake = this.awakeNow();
    if (!awake) return undefined;
    return this.presenceActive()
      .filter((id) => id !== PLAYER && !awake.has(id))
      .map((id) => ({ id, name: this.nameOf(id) }));
  }

  /**
   * The CALIBRATION-NEUTRAL occupancy the OFF-SCREEN SOCIETY pairs on (L21/L24). The society's co-present
   * pairing feeds relationship folds → (downstream) nominations/votes, so it must be INVARIANT to the
   * personality-movement constants — the base assignment is, which keeps the seeded competition/vote
   * outcomes byte-identical whether or not the weighting is enabled. Falls back to the weighted positions
   * for pre-L21/L24 saves (no base yet) or before the first tick.
   */
  societyOccupancy(): Occupancy | null {
    const base0 = this.presenceBase ?? this.presence;
    if (!base0) return base0;
    // A9: during the staged entrances the un-arrived are not in the house - the society never pairs them.
    const notHere = this.notYetArrived();
    let base = base0;
    if (notHere) { base = new Map(); for (const [id, room] of base0) if (!notHere.has(id)) base.set(id, room); }
    const awake = this.awakeNow();
    if (!awake) return base; // clock off ⇒ identity ⇒ byte-identical society + calibration spine
    // ADR 0006: asleep houseguests have left the floor for the night — drop them so the off-screen
    // society pairs (and overhears) only happen among those still up. A fresh map; `presenceBase` is never mutated.
    const up = new Map<EntityId, Room>();
    for (const [id, room] of base) if (awake.has(id)) up.set(id, room);
    return up;
  }

  /** Drop anyone presence still seats who is no longer active (the just-evicted are nowhere). */
  private prunePresence(): void {
    if (!this.presence) return;
    const active = new Set(this.presenceActive());
    for (const id of [...this.presence.keys()]) if (!active.has(id)) this.presence.delete(id);
    // L21/L24: prune the calibration-neutral base in lockstep so the society never pairs an evictee.
    if (this.presenceBase) for (const id of [...this.presenceBase.keys()]) if (!active.has(id)) this.presenceBase.delete(id);
    if (this.presenceTenure) for (const id of [...this.presenceTenure.keys()]) if (!active.has(id)) this.presenceTenure.delete(id);
    // 0077: forget a tracked sighting once its subject leaves the house (an evictee is nowhere).
    if (this.trackedSightings) for (const id of [...this.trackedSightings.keys()]) if (!active.has(id)) this.trackedSightings.delete(id);
  }

  /**
   * 0106 — is a whole-house EVENT the LIVE, unresolved beat (an EXCLUSIVE set-piece: a competition, or a
   * nomination / veto / eviction ceremony)? True while the event's player decision is pending (or a comp
   * is staging). For a COMPETITION it also returns the eligible competitor FIELD (the outgoing HOH sits
   * out the HOH comp; the veto is the drawn six). A PURE read of the live state — it never mutates the
   * seeded sim, so everything built on it is calibration-identical.
   */
  private houseEventInSession(): { kind: NonNullable<WhereaboutsView["houseEvent"]>["kind"]; field?: EntityId[] } | null {
    const s = this.live;
    if (!s) return null;
    // FEATURE 0111 — THE CHAMPAGNE CIRCLE: while the premiere toast is GATHERED, the whole house is
    // convened in the living room. This is a whole-house event exactly like a comp/ceremony (no field
    // split — nobody competes, the house simply toasts), so the pin (movePlayer no-op) + gathered
    // whereabouts come for free. Released to `"done"` on the model's first advanceGame (see advanceGame).
    if (s.premiereEntrance?.stage === "entrances") return { kind: "premiere-entrances" }; // A9
    if (s.champagneCircle === "gathered") return { kind: "champagne-circle" };
    if (s.competition) { // a staged comp is running ⇒ its real field is authoritative
      return { kind: s.competition.comp, field: [...s.competition.field] };
    }
    const p = s.pending;
    if (!p) return null;
    if (p.kind === "comp-intent" || p.kind === "comp-round") { // a comp surfaced but not yet staged
      if (p.comp === "veto-competition") return { kind: "veto-competition", field: s.vetoField ? [...s.vetoField] : [] };
      const finalThree = s.active.length === 3; // Final 3 lifts the outgoing-HOH restriction
      return { kind: "hoh-competition", field: s.active.filter((id) => finalThree || id !== s.outgoingHoh) };
    }
    if (p.kind === "nominations") return { kind: "nominations" };
    if (p.kind === "veto-decision" || p.kind === "replacement" || p.kind === "houseguests-choice") return { kind: "veto-ceremony" };
    if (p.kind === "eviction-vote" || p.kind === "tie-break" || p.kind === "final-eviction") return { kind: "eviction" };
    return null;
  }

  whereabouts(): WhereaboutsView | null {
    if (!this.house || !this.presence) return null;
    const me = this.house.player.id;
    const room = this.presence.get(me);
    if (!room) return null; // the player is nowhere (out of the house)
    // 0106: a whole-house EVENT (a comp or a ceremony) is an EXCLUSIVE set-piece — the whole house is
    // gathered, there are NO side rooms to slip into, and nobody is off scheming. For a comp the field is
    // split into competitors + spectators (the outgoing HOH among the watchers). A purely observational
    // override of the live presence read (it never touches the seeded sim).
    const ev = this.houseEventInSession();
    if (ev) {
      const named = (id: EntityId): NamedRef => ({ id, name: this.nameOf(id) });
      const notHere = this.notYetArrived(); // A9: un-arrived houseguests are nowhere during the entrances
      const others = this.livingIds().filter((id) => id !== me && !notHere?.has(id));
      const compSplit = ev.field
        ? (() => {
            const field = new Set(ev.field!);
            return {
              competing: others.filter((id) => field.has(id)).map(named),
              spectating: others.filter((id) => !field.has(id)).map(named), // incl. the outgoing HOH
              youAreCompeting: field.has(me),
            };
          })()
        : {};
      // L-F4 (#1743): pin the drawn comp's presentation (name + format + premise) onto the house event so
      // EVERY comp-beat turn's ground truth carries ONE consistent format across the comp's rounds. Only
      // for a competition, and only once its def is drawn (the HOH comp before it stages carries none).
      const compPin = (ev.kind === "hoh-competition" || ev.kind === "veto-competition")
        ? this.pinnedCompView() : undefined;
      return {
        room,
        present: others.map(named),       // the whole house is gathered for the event
        nearby: [],                       // no side rooms during a whole-house event
        turnsHere: this.presenceTenure?.get(me) ?? 0,
        companions: others.map((id) => ({ ...named(id), turnsHere: 0 })),
        tracked: [],
        houseEvent: { kind: ev.kind, ...compSplit, ...(compPin ? { comp: compPin } : {}) },
      };
    }
    // ADR 0006: as the night thins, houseguests who have turned in are no longer "around" — the house
    // empties for the player. `null` when the clock is off ⇒ everyone shows ⇒ byte-identical whereabouts.
    const awake = this.awakeNow();
    const notHere2 = this.notYetArrived();
    const isUp = (id: EntityId): boolean => !awake || awake.has(id);
    const inRoom = (r: Room): NamedRef[] => {
      const out: NamedRef[] = [];
      for (const [id, where] of this.presence!) {
        if (where === r && id !== me && isUp(id) && !notHere2?.has(id)) out.push({ id, name: this.nameOf(id) });
      }
      return out;
    };
    // The player's room + each room they have SIGHTLINE into (0077 Phase 2 — eyeshot, NOT raw
    // adjacency): the open public core sees across itself + into the hallway mouth, but a CLOSED door
    // (a bedroom, the bathroom/lounge, the HOH/storage/diary) is opaque — standing one room over no
    // longer leaks who is behind it. Who is behind a closed door is earned by watching, never ambient.
    const presentPlain = inRoom(room);
    // A51 (#2017 E2, flag ORWELL_NPC_TELLS, default OFF): the strongest observable tell KIND (a closed word, no band/number/cause) rides on each in-room houseguest so the FE can show one chip. In-room + awake only (tellsVisibleFor); absent flag => byte-identical.
    const present = this.npcTellsEnabled
      ? presentPlain.map((p) => { const t = this.tellsVisibleFor(p.id) ? this.tellsFor(p.id).tells?.[0] : undefined; return t ? { ...p, tell: t.kind } : p; })
      : presentPlain;
    // 0077: the TRACKED layer — who the player BELIEVES is behind a closed door (acquired by watching a
    // doorway), with age + a Vault-safe `stale` flag. NEVER the live map — the bedrooms stay blanks in
    // `nearby` (sightline). The player's own sub-zone rides along as flavor ("over by the pool").
    const now = this.trackedNow();
    const tracked = now.map((t) => ({
      id: t.id,
      name: this.nameOf(t.id),
      room: t.sighting.room,
      ...(t.sighting.zone ? { zone: t.sighting.zone } : {}),
      sinceTurns: t.age,
      stale: t.stale,
      pathway: t.sighting.pathway,
      confidence: t.sighting.confidence,
    }));
    // CONSPICUOUSNESS (two alone too long) is DERIVED from the same beliefs — Vault-free who/where/how-long.
    const conspicuous = this.conspicuousFrom(now);
    const myZone = this.seatedZone(me, room);
    return {
      room,
      ...(myZone ? { zone: myZone } : {}),
      present,
      nearby: (HOUSE_SIGHTLINE.get(room) ?? []).map((r) => ({ room: r, present: inRoom(r) })),
      // L21/L24: duration — the player's tenure in this room + each companion's, so the narrator
      // voices continuity (who has lingered with you vs. who just walked in) instead of resetting.
      turnsHere: this.presenceTenure?.get(me) ?? 0,
      companions: presentPlain.map((p) => ({ ...p, turnsHere: this.presenceTenure?.get(p.id) ?? 0 })),
      tracked,
      ...(conspicuous.length ? { conspicuous } : {}),
    };
  }

  /** 0077: a houseguest's live sub-zone in a zoned big room (Vault-free flavor); undefined elsewhere. */
  currentZone(id: EntityId): Zone | undefined {
    const r = this.presence?.get(id);
    return r ? this.seatedZone(id, r) : undefined;
  }

  /**
   * issue #792: a houseguest's SEATED sub-zone for the room they are in — the persisted seat from
   * `presenceTick` (enables drift + clustering). Falls back to the deterministic on-read `zoneFor`
   * (the seeding fallback) when no seat exists yet (a pre-feature save before the next tick re-seats, or
   * a read between game-start and the first tick). Validates the seat against the room's zones (a stale
   * cross-room seat ⇒ fall back), so the result is always a valid zone of `room` or undefined (un-zoned).
   */
  private seatedZone(id: EntityId, room: Room): Zone | undefined {
    const seat = this.presenceZone?.get(id);
    if (seat !== undefined && zonesFor(room).includes(seat)) return seat;
    return zoneFor(id, room, this.gameSeed ?? "");
  }

  /**
   * 0077: record a TRACKED sighting when the player WITNESSED `subject` head from `origin` into a closed
   * `dest`. "Witnessed" = the origin was in the player's eyeshot (or was the player's own room) — so a
   * houseguest who slips off down a hallway you can see becomes acquired knowledge, while one who was
   * already out of view does not. Pure, Vault-free, draws NO rng (calibration untouched).
   */
  private observeMoveIntoPrivate(subject: EntityId, origin: Room, dest: Room, playerRoom: Room): void {
    if (subject === this.house?.player.id || !isPrivateRoom(dest)) return;
    if (origin !== playerRoom && !areVisible(playerRoom, origin)) return; // the player didn't see them go
    (this.trackedSightings ??= new Map()).set(subject, {
      room: dest,
      zone: this.seatedZone(subject, dest),
      tick: this.presenceTickCount,
      pathway: `tracked:${subject}:${this.presenceTickCount}`,
      confidence: PRIVACY.trackedConfidence,
    });
  }

  /**
   * 0077: the player's CURRENT tracked beliefs — pruned of decayed (past-horizon) sightings, of subjects
   * no longer in the house, and of any the player has since DISPROVEN by seeing the subject somewhere
   * visible (a correcting pathway). Each carries its age + a `stale` flag derived from AGE ALONE — never
   * the secret live position (reading that would leak that they left). Mutates the persisted map lazily
   * (drops dead beliefs) so it never grows without bound. Vault-free.
   */
  private trackedNow(): Array<{ id: EntityId; sighting: TrackedSighting; age: number; stale: boolean }> {
    if (!this.trackedSightings || !this.presence) return [];
    const me = this.house?.player.id;
    const myRoom = me ? this.presence.get(me) : undefined;
    const out: Array<{ id: EntityId; sighting: TrackedSighting; age: number; stale: boolean }> = [];
    for (const [id, s] of [...this.trackedSightings]) {
      const age = this.presenceTickCount - s.tick;
      if (age > PRIVACY.trackedHorizonTicks || !this.presence.has(id)) { this.trackedSightings.delete(id); continue; }
      // A correcting pathway: the player can now SEE the subject (their room or a sightline-connected
      // room) ⇒ the closed-door belief is resolved by direct observation; drop it.
      const live = this.presence.get(id);
      if (myRoom && live && (live === myRoom || areVisible(myRoom, live))) { this.trackedSightings.delete(id); continue; }
      out.push({ id, sighting: s, age, stale: age >= PRIVACY.staleAfterTicks });
    }
    return out;
  }

  /**
   * 0077 CONSPICUOUSNESS — "two alone too long is a tell." A Vault-free read, DERIVED per call (never
   * stored — ADR 0002, like blocs 0043): a private room the player has tracked EXACTLY `conspicuousPairSize`
   * houseguests into, both sightings aged at least `conspicuousMinTenureTicks`, surfaces as "you saw A and
   * B slip into the lounge a while ago and haven't seen them come out." Names + room + "a while" — NEVER
   * the content of whatever they are doing in there (the scene stays sealed; earshot is rare/partial/muffled).
   */
  conspicuousReads(): string[] {
    return this.conspicuousFrom(this.trackedNow());
  }

  /** Pure conspicuousness derivation over an already-computed tracked-belief list (shared by `whereabouts`). */
  private conspicuousFrom(now: ReturnType<GameSessionAdapter["trackedNow"]>): string[] {
    const byRoom = new Map<Room, EntityId[]>();
    for (const t of now) {
      if (t.age < PRIVACY.conspicuousMinTenureTicks) continue;
      const list = byRoom.get(t.sighting.room) ?? [];
      list.push(t.id);
      byRoom.set(t.sighting.room, list);
    }
    const reads: string[] = [];
    for (const [room, who] of byRoom) {
      if (who.length !== PRIVACY.conspicuousPairSize) continue;
      const names = who.map((id) => this.nameOf(id));
      reads.push(`(You saw ${names.join(" and ")} slip into the ${roomDisplayName(room)} a while ago and haven't seen them come out.)`);
    }
    return reads;
  }

  /**
   * 0077 NPC-side increment — the HOUSE whispers about closed-door pairings. When two NPCs are
   * conspicuously holed up in a private room, a plausibly-positioned third houseguest notices and a
   * Vault-free POSITION suspicion (who/where, never the content) diffuses NPC-to-NPC and can reach the
   * player. Called once per off-screen tick by the orchestrator, AFTER all society/gossip work.
   *
   * CALIBRATION: runs on a DEDICATED rng (off the game seed + presence-tick counter — NEVER the shared
   * society/competition/vote stream the orchestrator passes), and the diffusion takes NO relationship
   * fold (`whisperConspicuousPairings` → `diffuseGossip` without `rel`/`subjects`). So it moves no edge
   * and consumes no shared draw ⇒ the seeded `juryReach` + gradient outcomes are byte-identical with
   * this on or off. Reads the WEIGHTED player-facing occupancy (what the house observably looks like).
   */
  whisperPairings(knowledge: KnowledgeService): void {
    if (!this.house || !this.presence) return;
    const player = this.house.player.id;
    const evicted = new Set(this.live?.evictionOrder ?? []);
    const awake = this.awakeNow();
    const npcs = this.house.npcs
      .map((n) => n.id)
      .filter((id) => !evicted.has(id) && (!awake || awake.has(id)));
    if (npcs.length < 2) return;
    // DEDICATED stream — zero touch to the orchestrator's shared per-user rng (the calibration spine).
    const rng = new SeededRandom(hashSeed(`house-suspicion:${this.gameSeed ?? ""}:${this.presenceTickCount}`));
    whisperConspicuousPairings({
      occupancy: this.presence,
      tenureOf: (id) => this.presenceTenure?.get(id) ?? 0,
      npcs,
      player,
      affinity: (a, b) => this.rel.edge(a, b).affinity,
      nameOf: (id) => this.nameOf(id),
      knowledge,
      rng,
    });
  }

  socialInitiatives(): SocialInitiative[] {
    if (!this.house) return [];
    // E89 (ruling #5): no approach fires before the house has actually started playing —
    // empty until the season's first ceremony beat (the week-1 HOH result) has resolved.
    // Structural engine gate; the FE's started-gate is only the belt.
    if (
      APPROACH_GATE.requireFirstCeremonyBeat &&
      (!this.live || !firstCeremonyBeatResolved(this.live))
    ) {
      return [];
    }
    const player = this.house.player.id;
    // B52/audit D5: an evicted houseguest can't pull you aside — only LIVING NPCs approach.
    const evicted = new Set(this.live?.evictionOrder ?? []);
    const notHere = this.notYetArrived(); // A9: un-arrived houseguests cannot approach
    const npcIds0 = this.house.npcs.filter((n) => !evicted.has(n.id) && !notHere?.has(n.id)).map((n) => n.id);
    // ADR 0006: a houseguest who has turned in for the night won't pull you aside at 3am — only those
    // still up approach. Identity when the clock is off ⇒ byte-identical approach ranking.
    const npcAwake = this.awakeNow();
    const npcIds = npcAwake ? npcIds0.filter((id) => npcAwake.has(id)) : npcIds0;
    // Deterministic per moment (the temperature roll cannot flip a clear relationship gap, 0012),
    // so the same week/phase reproduces the same approaches. The hidden drive NUMBER is NOT
    // surfaced — only the name + the coarse motive category (E60: the fact the GM voices in its
    // own words, never a canned pretext line), so no trust/threat read leaks across the wall.
    const stretchKey = `${this.week}:${this.phase}`;
    const rng = new SeededRandom(hashSeed(`approaches:${this.gameSeed ?? ""}:${stretchKey}`));
    const ranked = rankApproaches(player, npcIds, this.rel, rng, undefined, this.approachBiasHook(player));
    // #1322: a player-facing-projection-only anti-recency filter — an NPC who led a recent stretch
    // sinks below everyone still eligible, so the same seeded-affinity NPC can't monopolize every
    // stretch. `rankApproaches` itself is untouched/pure; see `applyApproachCooldown`'s own doc.
    const initiators = applyApproachCooldown(ranked, this.approachCooldown).slice(0, 3);
    // Remember what THIS stretch actually showed, so the next stretch transition (`syncProjection`)
    // knows whom to cool down — a stretch never read here penalizes no one (nothing was ever shown).
    this.lastApproachStretch = { key: stretchKey, initiators: initiators.map((a) => a.npc) };
    return initiators.map((a) => ({
      houseguest: { id: a.npc, name: this.nameOf(a.npc) },
      motive: a.motive,
    }));
  }

  /** The player's current public standing — Vault-free (ceremony facts only). */
  private standing(): Standing {
    if (!this.house) return "pre-game";
    const me = this.house.player.id;
    if (this.ceremony.hoh === me) return "hoh";
    if (this.ceremony.nominees.includes(me)) return "nominee";
    if (this.ceremony.vetoHolder === me) return "veto-holder";
    return "houseguest";
  }

  playerTagline(): PlayerTaglineView {
    const standing = this.standing();
    const key = `${this.week}|${this.phase}|${standing}`;
    const cached = this.taglineCache.get(key);
    if (cached !== undefined) return { text: cached };

    // The curated, state-aware line is both the default and the fail-open fallback.
    let text = SNARKY_TAGLINES[standing];
    if (this.narrator) {
      try {
        const line = oneLine(this.narrator.narrate({
          forEntity: this.house?.player.id ?? PLAYER,
          mode: "scene",
          visibleEvents: [],
          knowledge: [],
          systemPrompt: `${TAGLINE_INSTRUCTION} Standing: ${standing}. Week ${this.week}, phase ${this.phase}.`,
        }));
        if (isUsableTagline(line)) text = line; // else fail open to the curated line
      } catch {
        /* narrator error/timeout ⇒ keep the curated themed line (never blank, never blocking) */
      }
    }
    this.taglineCache.set(key, text);
    return { text };
  }

  // ─── PREMIERE meet-everyone (feature #380 follow-on) — NEW BLOCK ─────────────────────────────────
  /**
   * Is the game in the premiere moment (move-in, before the first HOH)? The tracker is meaningful ONLY
   * here — once the first HOH begins (`phase` leaves "premiere") there is nothing left to meet, so the
   * read methods return `null` and the (now-vestigial) set is lazily cleared so it never lingers in the
   * persisted snapshot. Never reads `live`/the advance path — purely the public phase.
   */
  private inPremiere(): boolean {
    return this.house !== null && this.phase === "premiere";
  }

  /** Lazily clear a stale tracker once the premiere is over (keeps the snapshot clean; idempotent). */
  private clearPremiereIfOver(): void {
    const staleCircle = this.live?.champagneCircle !== undefined || this.live?.premiereEntrance !== undefined;
    if (!this.inPremiere() && (this.premiereMet.size > 0 || this.premiereHotReads.size > 0 || staleCircle)) {
      this.premiereMet.clear();
      // #1318: the hot-read set is premiere-scoped too — clear it alongside so it never lingers in the
      // snapshot (the DURABLE name-lock `introducedNames` is intentionally NOT cleared here).
      this.premiereHotReads.clear();
      // 0111: the champagne-circle flag is premiere-scoped — clear it so a post-premiere `live` never
      // reports a stale `champagne-circle` house event (which would wrongly pin the player).
      if (this.live) { this.live.champagneCircle = undefined; delete this.live.premiereEntrance; }
      this.persist();
    }
  }

  /** The OBSERVABLE public read of one active houseguest (PUBLIC facets only — no Vault, no numbers). */
  private firstImpressionOf(n: GameHouse["npcs"][number]): FirstImpressionView {
    // Exactly the Vault-free facets the roster card already exposes (B61/L28/#1140): archetype, strategy
    // style, background, age, presentation, demeanor, genderPresentation. NEVER the soul, hiddenElements,
    // or a number; gender PRESENTATION only (a private orientation stays Vault-sealed).
    return {
      houseguest: { id: n.id, name: n.name },
      met: this.premiereMet.has(n.id),
      ...(n.character.archetype !== undefined ? { archetype: n.character.archetype } : {}),
      ...(n.character.strategyStyle !== undefined ? { strategyStyle: n.character.strategyStyle } : {}),
      ...(n.character.background !== undefined ? { background: n.character.background } : {}),
      ...(n.character.age !== undefined ? { age: n.character.age } : {}),
      ...(n.character.presentation !== undefined ? { presentation: n.character.presentation } : {}),
      ...(n.character.demeanor !== undefined ? { demeanor: n.character.demeanor } : {}),
      ...(n.character.vocation !== undefined ? { vocation: n.character.vocation } : {}), // ORW-194: public job + hometown for the toast
      ...(n.character.hometown !== undefined ? { hometown: n.character.hometown } : {}),
      ...(n.character.identityConcept !== undefined ? { identityConcept: n.character.identityConcept } : {}),
      ...(n.character.genderPresentation !== undefined ? { genderPresentation: n.character.genderPresentation } : {}),
    };
  }

  /**
   * The premiere's meet-everyone progress (feature #380 follow-on) — the engine-tracked, Vault-free
   * answer to "who's met, who's still to introduce?". Only ACTIVE NPCs count (the cast at move-in);
   * the player is implicitly met (counted in `metCount`/`total`), so `total` is the whole cast. `null`
   * outside the premiere.
   *
   * CHAMPAGNE CIRCLE (owner ruling 2026-07-14): `premiereMet`/`premiereHotReads` are SEEDED at premiere
   * entry (`meetWholeHouseAtChampagneCircle`) — the whole house is introduced at once at the toast, so
   * during a live premiere every active NPC is already met: `remaining` is empty, `complete` is true, and
   * `powerReachable` is true (the first HOH is ready the moment the toast is done — no manual roll-call).
   * The narrator reads `met` (the whole cast) for the observable reads it voices at the circle.
   */
  premiereIntros(): PremiereIntrosView | null {
    this.clearPremiereIfOver();
    if (!this.house || !this.inPremiere()) return null;
    const activeNpcs = this.house.npcs.filter((n) => this.seatOf(n.id) === "active");
    const remaining: FirstImpressionView[] = [];
    const met: FirstImpressionView[] = [];
    for (const n of activeNpcs) {
      const fi = this.firstImpressionOf(n);
      (fi.met ? met : remaining).push(fi);
    }
    // FEATURE 0111 (Pillar 3) — THE CHAMPAGNE CIRCLE (owner ruling 2026-07-14). The premiere's opening
    // set-piece: the producers convene the WHOLE house for champagne-circle introductions, and every
    // houseguest is met right there, at once (`meetWholeHouseAtChampagneCircle`, at premiere entry). So
    // the meet-everyone tracker is `complete` for the whole premiere and the first HOH is REACHABLE the
    // moment the toast is done — no manual roll-call, no milling about to stumble on strangers. `hotReads`
    // is the reads formed at the circle (every met NPC); `powerReachable` === the circle introduced
    // everyone (`remaining` empty) AND everyone is visible/seated in the house. The HOH itself stays a
    // real, un-rigged seeded competition — only the GATE is reframed, never the outcome (mandate #3).
    // (The `premiereHotReads`/name-belt machinery from #1318 stays wired but is dormant under this flow —
    // the circle pre-registers every hot read, so any stray belt/model mark is an idempotent no-op.)
    const hotReads = activeNpcs.filter((n) => this.premiereHotReads.has(n.id)).length;
    const everyoneVisible = activeNpcs.every((n) => this.presence === null || this.presence.has(n.id));
    const pe = this.live?.premiereEntrance;
    // A9: during the staged entrances the roll-call gate is GONE (not re-added): un-arrived houseguests are not
    // "remaining" and `complete`/`powerReachable` stay TRUE exactly as under the old circle.
    if (pe) remaining.length = 0;
    const everyoneMet = remaining.length === 0;
    // +1 on both counts for the player (they ARE met — they're playing). total = the whole cast.
    return {
      complete: everyoneMet,
      metCount: met.length + 1,
      total: activeNpcs.length + 1,
      remaining,
      met,
      hotReads,
      powerReachable: everyoneMet && (pe ? true : everyoneVisible),
      // 0111: surface the champagne-circle sub-state so the moment prompt knows whether the toast is
      // still GATHERED (voice the toast, house pinned) or DONE (released to bedroom pick / settling in).
      ...(this.live?.champagneCircle !== undefined ? { champagneCircle: this.live.champagneCircle } : {}),
      ...(pe ? { entrance: this.entranceView(pe) } : {}),
    };
  }

  /** ORW-116 (Ryne): the clock STARTS at the premiere entry (afternoon) when the clock pacing is on - no later jump starts it. Idempotent; no-op once it is running or with the clock pacing off. */
  private ensurePremiereClock(): void {
    const s = this.live;
    if (!s || s.nightDepth !== undefined || !(this.perConversationClockEnabled && this.timeOfDayEnabled)) return;
    if (s.week !== 1 || s.firstNightPassed || (s.dayNumber ?? 1) >= 2) return;
    s.nightDepth = PREMIERE_ENTRY_HOUR;
    s.timeOfDay = phaseForHour(PREMIERE_ENTRY_HOUR);
  }

  /** A9 - season start (flag on): plan the seeded order and seat those who are already inside when the player walks in. */
  private startPremiereEntrances(seed: number | string): void {
    if (!this.house || !this.live) return;
    const ids = [this.house.player.id, ...this.house.npcs.map((n) => n.id)];
    const plan = planEntrances(ids, this.house.player.id, seed);
    this.live.premiereEntrance = { order: plan.order, playerPos: plan.playerPos, arrived: 0, stage: "entrances", spoke: [] };
    for (let i = 0; i < plan.playerPos; i++) this.recordArrival(i);
    this.live.premiereEntrance.arrived = plan.playerPos;
  }

  /** A9 - the Vault-free public projection of the staged-entrances state (names only; never ids in prose). */
  private entranceView(pe: NonNullable<LiveSeasonState["premiereEntrance"]>): NonNullable<PremiereIntrosView["entrance"]> {
    const me = this.house!.player.id;
    const arrivedIds = pe.order.slice(0, pe.arrived);
    const lastId = pe.arrived > 0 ? pe.order[pe.arrived - 1] : undefined;
    const speakerOf = (x: string): { id?: string; name: string; host?: true; isPlayer?: true } =>
      x === "host" ? { name: "The host", host: true } :
      x === me ? { id: x, name: this.nameOf(x), isPlayer: true } : { id: x, name: this.nameOf(x) };
    let speakers: Array<{ id?: string; name: string; host?: true; isPlayer?: true }> | undefined;
    if (pe.stage !== "entrances" && pe.spoke.length > 0) {
      const len = pe.spoke.length;
      const from = len % TOAST_BATCH === 0 ? len - TOAST_BATCH : len - (len % TOAST_BATCH);
      speakers = pe.spoke.slice(from).map(speakerOf);
    }
    return {
      stage: pe.stage,
      index: pe.arrived,
      total: pe.order.length,
      playerPosition: pe.playerPos + 1,
      insideCount: pe.arrived,
      playerInside: pe.arrived > pe.playerPos,
      headcount: `${pe.arrived} of ${pe.order.length} are inside` + (pe.arrived > pe.playerPos ? " (the player is one of them)" : " (the player has NOT walked in yet; they are not counted)"),
      arrivedNames: arrivedIds.filter((id) => id !== me).map((id) => this.nameOf(id)),
      ...(lastId && lastId !== me ? { justArrived: { id: lastId, name: this.nameOf(lastId) } } : {}),
      ...(lastId && lastId === me ? { playerJustEntered: true as const } : {}),
      ...(speakers ? { speakers } : {}),
    };
  }

  /** A9 - the houseguests who have NOT yet entered during the staged entrances (else null: nothing hidden). */
  private notYetArrived(): Set<EntityId> | null {
    const pe = this.live?.premiereEntrance;
    if (!pe || pe.stage !== "entrances") return null;
    return new Set(pe.order.slice(pe.arrived));
  }

  /**
   * A9 - record ONE arrival (event + met-marks + the bounded first-read fold). The witness set is everyone
   * already inside + the arriver (the player only when already inside, or when it is the player's own
   * entrance). The first read rides a SEEDED SIDE stream (never the shared season spine). No persist (caller's).
   */
  private recordArrival(i: number): { id: EntityId; inside: EntityId[]; playerEntrance: boolean } {
    const pe = this.live!.premiereEntrance!;
    const me = this.house!.player.id;
    const id = pe.order[i]!;
    const inside = pe.order.slice(0, i);
    const witness = [...inside, id];
    this.onPlayerEvent?.(`${this.nameOf(id)} arrives`, witness, "premiere-entrance");
    if (id !== me) {
      this.premiereMet.add(id);
      this.premiereHotReads.add(id);
      this.introducedNames.add(id);
    }
    const rng = new SeededRandom(hashSeed(`${this.gameSeed ?? 0}:premiere-read:${i}`));
    for (const holder of inside) this.rel.applyImpactDirected(holder, id, PREMIERE_FIRST_READ, rng);
    return { id, inside, playerEntrance: id === me };
  }

  /** A9 - the staged premiere's entrances + toast, one `advanceGame` per release. */
  private advancePremiereEntrance(): AdvanceView {
    const s = this.live!;
    this.ensurePremiereClock();
    if (this.perConversationClockLive()) { s.clockInteractive = true; tickPremiereClock(s, PREMIERE_STEP_HOURS); } // ORW-116 (b): a staged premiere with the clock on IS real play - the night is held from the first entrance, never only after the first message // ORW-116: the entrances take real time
    const pe = s.premiereEntrance!;
    const me = this.house!.player.id;
    if (pe.stage === "entrances") {
      const r = this.recordArrival(pe.arrived);
      pe.arrived += 1;
      if (pe.arrived >= pe.order.length) {
        pe.stage = "toast";
        s.champagneCircle = "gathered"; // the existing whole-house pin
      }
      this.persist();
      const view = this.advanceView(null);
      return {
        ...view,
        event: {
          beat: "premiere-entrance",
          content: `${this.nameOf(r.id)} arrives`,
          participants: [{ id: r.id, name: this.nameOf(r.id) }],
          detail: {
            arriver: { id: r.id, name: this.nameOf(r.id) },
            index: pe.arrived,
            of: pe.order.length,
            insideNames: r.inside.filter((x) => x !== me).map((x) => this.nameOf(x)),
            playerEntrance: r.playerEntrance,
          },
        },
      };
    }
    // stage "toast": release the next batch of speakers.
    const all = toastSpeakers(pe.order);
    const batch = all.slice(pe.spoke.length, pe.spoke.length + TOAST_BATCH);
    for (const sp of batch) {
      if (sp === "host") this.onPlayerEvent?.("The host opens the toast", [...pe.order], "toast-speech");
      else if (sp !== me) this.onPlayerEvent?.(`${this.nameOf(sp)} gives a toast`, [...pe.order], "toast-speech");
      pe.spoke.push(sp); // the player's slot is a marker only - chat-authored, never recorded here
    }
    if (pe.spoke.length >= all.length) {
      pe.stage = "done";
      s.champagneCircle = "done"; // the existing release
    }
    this.persist();
    const view = this.advanceView(null);
    return {
      ...view,
      event: {
        beat: "premiere-toast",
        content: "The champagne toast",
        detail: {
          speakers: batch.map((sp) => (sp === "host" ? "host" : sp === me ? { id: sp, name: this.nameOf(sp), isPlayer: true } : { id: sp, name: this.nameOf(sp) })),
          index: pe.spoke.length,
          of: all.length,
        },
      },
    };
  }

  /**
   * Mark a houseguest as introduced/met during the premiere (feature #380 follow-on).
   *
   * CHAMPAGNE CIRCLE (owner ruling 2026-07-14): the whole house is met at the toast at premiere entry
   * (`meetWholeHouseAtChampagneCircle`), so this is no longer the PRIMARY tracker — it is now an
   * idempotent BACKSTOP (the model or the FE name-belt may still call it, but every active NPC is already
   * met, so it is a no-op in the normal flow). Still a no-op for an unknown houseguest, the player
   * (auto-met), an evicted/departed seat, or once the premiere is over. Persists only on a real change
   * (durable resume, 0030) and returns the resulting progress (or `null` outside the premiere).
   */
  markHouseguestMet(id: EntityId, opts?: MarkHouseguestMetOpts): PremiereIntrosView | null {
    this.clearPremiereIfOver();
    if (!this.house || !this.inPremiere()) return null;
    // Only a real, active NPC can be "met" — the player is implicitly met; an unknown/departed id is a no-op.
    const isActiveNpc = this.house.npcs.some((n) => n.id === id && this.seatOf(n.id) === "active") && !this.notYetArrived()?.has(id);
    if (isActiveNpc) {
      let changed = false;
      if (!this.premiereMet.has(id)) {
        this.premiereMet.add(id);
        // A1: the DURABLE name-lock companion — never cleared (unlike `premiereMet`). From this moment
        // the player has witnessed this houseguest's name; `recordCastProfile` must never change it.
        this.introducedNames.add(id);
        changed = true;
      }
      // #1318 — SOURCE distinction: a `belt` mark (the FE regex name-belt) fills the meet-list ONLY, so the
      // intro list keeps shrinking (its anti-soft-lock job) WITHOUT unlocking power off a bare name mention.
      // A `player` mark (the default — a model-driven introduction the player was part of) is a genuine hot
      // read. `notePremiereReads` feeds the same set from recorded player↔NPC scenes.
      if ((opts?.via ?? "player") !== "belt" && !this.premiereHotReads.has(id)) {
        this.premiereHotReads.add(id);
        changed = true;
      }
      if (changed) this.persist();
    }
    return this.premiereIntros();
  }

  /**
   * #1318 — register genuine player↔NPC reads from RECORDED premiere scenes (wired by the registry off
   * `EngineCommandsAdapter.recordInteraction`). A recorded scene is the RELIABLE engagement signal (the
   * 0055 auto-record belt guarantees an engaged premiere turn is recorded even when the model skips the
   * tool), so this is what lets power become reachable after real play — not after a name is merely heard.
   * Each named NPC counts as met (name-lock included) AND as a hot read. No-op outside the premiere, for a
   * non-active/unknown id, or the player. Idempotent.
   *
   * Persistence is DELIBERATELY the caller's: this is invoked ONLY from the registry's read-sink, DURING
   * `EngineCommandsAdapter.recordInteraction`'s own commit — which always fires `onPersist` right after,
   * capturing this session mutation in the SAME commit. Calling `persist()` here would fire a SECOND
   * commit funnel and double-bump `beatSeq` (one logical mutation → two beats), so it must not.
   */
  notePremiereReads(npcIds: readonly EntityId[]): void {
    // Guard on the phase directly (not `clearPremiereIfOver`, whose lazy snapshot-clean would fire a
    // stray persist INSIDE the enclosing recordInteraction commit on the premiere→HOH transition turn).
    // Other read paths (premiereIntros/getGameState) still lazily clear the vestigial sets post-premiere.
    if (!this.house || !this.inPremiere()) return;
    for (const id of npcIds) {
      if (!this.house.npcs.some((n) => n.id === id && this.seatOf(n.id) === "active")) continue;
      if (this.notYetArrived()?.has(id)) continue; // A9: not in the house yet
      if (!this.premiereMet.has(id)) { this.premiereMet.add(id); this.introducedNames.add(id); }
      this.premiereHotReads.add(id);
    }
  }

  /**
   * FEATURE 0111 (Pillar 3) — THE CHAMPAGNE CIRCLE (owner ruling 2026-07-14). The premiere's opening
   * set-piece: the producers convene the WHOLE house for champagne-circle introductions, and every
   * houseguest is met right there, at once — DETERMINISTICALLY, and RECORDED by the engine (not the
   * model's progressive `markHouseguestMet` calls, and never engine-authored prose — the model still
   * NARRATES the toast; the engine only records the meetings, ADR 0003). This is what makes meeting the
   * whole house AUTO-HAPPEN at the toast: the player never mills about to stumble on strangers, and the
   * meet-everyone tracker is `complete` (and first power reachable) the moment the premiere begins.
   *
   * Marks every active NPC met (`premiereMet`), a genuine read (`premiereHotReads`), and name-locked
   * (`introducedNames`, the A1 durable companion). Vault-FREE (only public roster ids move) and
   * seed-NEUTRAL (populates projection sets only — no rng draw, no relationship fold, no seeded stream),
   * so it can never perturb a competition/vote/jury outcome. Does NOT persist (the caller, `createCharacter`,
   * persists once at the end of season start). Idempotent; a no-op outside a live house.
   */
  private meetWholeHouseAtChampagneCircle(): void {
    if (!this.house) return;
    for (const n of this.house.npcs) {
      if (this.seatOf(n.id) !== "active") continue; // at genesis this is every NPC (nobody evicted yet)
      this.premiereMet.add(n.id);
      this.premiereHotReads.add(n.id);
      this.introducedNames.add(n.id);
    }
  }
  // ─────────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * RC5 (feature 0116 / #1599) — ENFORCE cast-identity coherence at game start. The model-authored
   * dossier is assembled across THREE async write-backs (`recordCastGenesis` skeleton +
   * `recordCastIdentity` gender pin + `recordCastProfile` body), so a houseguest can go LIVE internally
   * contradictory — the pinned `genderPresentation` reads one sex while a self-referential field ("her
   * shyness" / "his forearm") names the other (the Lily Evans object), a biography states a life span
   * implausible for the age (Donna), or a public vocation disagrees with the cover story. This is the ONE
   * point the WHOLE assembled dossier exists (season start, after adopt/seeders), so it is where the pure
   * `validateDossierCoherence`/`repairDossierCoherence` (castingIntake.ts) become REACHED IN PRODUCTION:
   *   • validate each committed Character against its pinned `genderPresentation` (authoritative);
   *   • on a hard contradiction REPAIR it — clear ONLY the offending self-referential field (the gender
   *     spine is never cleared), re-validate;
   *   • if a contradiction SURVIVES repair, FLOOR the remaining self-referential prose (strip it so the
   *     narrator falls back to the coherent structured facets) — never ship a contradictory cast (#1599);
   *   • record a RED-eligible, Vault-free coherence event per corrected/floored houseguest (a WARN + the
   *     returned `castCoherence` summary the FE routes to the #1599 health rollup — a correction is not a
   *     cloak). The deterministic FLOOR cast is always coherent, so this is a no-op there (byte-neutral).
   * Runs BEFORE the season-start persist, so the corrected dossier is what durably lands. Vault-free: it
   * touches only PUBLIC identity facets and reports only ids + field names, never a secret value.
   */
  private enforceCastCoherence(): GameStateView["castCoherence"] {
    if (!this.house) return undefined;
    const affected: Array<{ id: EntityId; fields: string[]; action: "repaired" | "floored" }> = [];
    for (const n of this.house.npcs) {
      const c = n.character;
      // A floor cast carries no model-authored genesis pin/prose contradiction; only a model-authored cast
      // (genesisAuthored / deepProfileAuthored) can ship one. Still validate all — cheap, and the guard is
      // the safety net, not a fast-path — but the byte-neutrality of the floor path is what keeps golden green.
      const project = (): DossierForCoherence => ({
        ...(c.genderPresentation ? { genderPresentation: c.genderPresentation } : {}),
        ...(n.name ? { name: n.name } : {}), // F5 — the name↔gender SOFT assertion (never fails ok/floors)
        ...(c.appearance ? { appearance: c.appearance } : {}),
        ...(c.demeanor ? { demeanor: c.demeanor } : {}),
        ...(c.background ? { background: c.background } : {}),
        ...(c.biography ? { biography: c.biography } : {}),
        ...(typeof c.age === "number" && Number.isFinite(c.age) ? { age: c.age } : {}),
        ...(c.vocation ? { vocation: c.vocation } : {}),
        ...(c.physicalCharacteristics
          ? {
            physicalCharacteristics: {
              distinguishingMark: c.physicalCharacteristics.distinguishingMark,
              facialFeatures: c.physicalCharacteristics.facialFeatures,
              hair: c.physicalCharacteristics.hair,
              heightBuild: c.physicalCharacteristics.heightBuild,
            },
          }
          : {}),
      });
      const first = validateDossierCoherence(project());
      // Skip ONLY when there is genuinely nothing to do. A SOFT-but-repairable result (a nonbinary pin
      // carrying a stray binary self-pronoun) returns ok:true WITH a non-empty `repairFields` — it must
      // still fall through to repair, or the nonbinary houseguest keeps "his …/her …" prose into the
      // portrait. Short-circuiting on `ok` alone would defeat that (Greptile P1 — soft repairs skipped).
      if (first.ok && first.repairFields.length === 0) continue;
      // REPAIR — clear only the contradicting self-referential fields, then RE-VALIDATE. The repaired
      // dossier is a projection; write the cleared fields back onto the byte-stable Character.
      const { repaired, repairedFields } = repairDossierCoherence(project());
      this.clearCoherenceFields(c, repairedFields);
      // F5 — restore the portrait-facing prose the repair SCRUBBED to the pin (appearance + distinguishing
      // mark). `clearCoherenceFields` blanked them just above; write the pronoun-corrected text back so the
      // descriptive detail ("… left eyebrow") survives coherent into the portrait prompt instead of being
      // lost. Non-repair-field prose is byte-identical here (a harmless no-op).
      if (typeof repaired.appearance === "string" && repaired.appearance.trim()) c.appearance = repaired.appearance;
      const scrubbedMark = repaired.physicalCharacteristics?.distinguishingMark;
      if (c.physicalCharacteristics && typeof scrubbedMark === "string" && scrubbedMark.trim()) {
        c.physicalCharacteristics.distinguishingMark = scrubbedMark;
      }
      const after = validateDossierCoherence(project());
      let action: "repaired" | "floored" = "repaired";
      let fields = [...repairedFields];
      if (!after.ok) {
        // A contradiction SURVIVED the surgical repair (defensive — clearing a field removes it from the
        // scan, so this is rare): FLOOR the NPC by stripping EVERY remaining hard-contradiction field, which
        // is guaranteed coherent (an absent field cannot contradict the pin). Never ship a contradictory cast.
        action = "floored";
        const floorFields = after.repairFields;
        this.clearCoherenceFields(c, floorFields);
        fields = [...new Set([...fields, ...floorFields])];
      }
      affected.push({ id: n.id, fields, action });
      // #1599 — a genuine fault, surfaced even though auto-corrected (never swallowed). Vault-free: ids +
      // public field names only, never a secret value or the offending prose.
      // eslint-disable-next-line no-console
      console.warn(
        `[cast-coherence] ${action} internally-contradictory dossier for ${n.id} ` +
        `(fields: ${fields.join(", ") || "none"}) — pinned genderPresentation is authoritative (#1599)`,
      );
    }
    if (affected.length === 0) return undefined;
    return {
      repaired: affected.filter((a) => a.action === "repaired").length,
      floored: affected.filter((a) => a.action === "floored").length,
      houseguests: affected,
    };
  }

  /**
   * Clear the coherence-repair fields on a byte-stable Character (the `repairDossierCoherence` contract:
   * the offending field is cleared so it can no longer contradict the pinned gender). Maps the validator's
   * flat field labels onto the Character's real locations — `distinguishingMark` and the
   * `physicalCharacteristics.*` leaves live inside the structured facet. The pinned `genderPresentation`
   * spine is NEVER a repair field (the validator never returns it), so it is always preserved.
   */
  private clearCoherenceFields(c: Character, fields: readonly string[]): void {
    for (const field of fields) {
      switch (field) {
        case "appearance": c.appearance = ""; break;
        case "demeanor": delete c.demeanor; break;
        case "background": c.background = ""; break;
        case "biography": delete c.biography; break;
        case "vocation": delete c.vocation; break;
        case "distinguishingMark":
          if (c.physicalCharacteristics) c.physicalCharacteristics.distinguishingMark = "";
          break;
        case "physicalCharacteristics.distinguishingMark":
          if (c.physicalCharacteristics) c.physicalCharacteristics.distinguishingMark = "";
          break;
        case "physicalCharacteristics.facialFeatures":
          if (c.physicalCharacteristics) c.physicalCharacteristics.facialFeatures = "";
          break;
        case "physicalCharacteristics.hair":
          if (c.physicalCharacteristics) c.physicalCharacteristics.hair = "";
          break;
        case "physicalCharacteristics.heightBuild":
          if (c.physicalCharacteristics) c.physicalCharacteristics.heightBuild = "";
          break;
        default: break; // an unknown/`genderPresentation` label is never cleared (spine preserved)
      }
    }
  }

  createCharacter(req: CreateCharacterReq): GameStateView {
    // 0056 — "keep the existing character": on a CONFIRMED restart with `keepCharacter`, capture the
    // prior player's AUTHORED fields HERE (the only point the prior season still exists, before any
    // reset) and fold them under the explicit req. The static CHARACTER is seed-independent, so re-
    // supplying these regenerates the SAME houseguest in the new season; explicit fields still win,
    // so the player may tweak on the way through. No hidden number is read.
    const carried = (this.house && req.confirmRestart && req.keepCharacter) ? this.carryOverFields() : null;
    // NAME-1 (#547): on ANY confirmed restart capture the dead season's cast names so the next season's
    // corpus-sampled cast avoids them (cross-season diversity). This is the only point the prior cast
    // still exists, before the reset; it rides `effReq` through `onRestart` into the fresh sandbox.
    const priorCastNames = (this.house && req.confirmRestart)
      ? this.priorSeasonNames(req.priorCastNames)
      : req.priorCastNames;
    const effReq: CreateCharacterReq = {
      ...(carried ?? {}),
      ...req,
      ...(carried ? { keepCharacter: false } : {}),
      ...(priorCastNames && priorCastNames.length ? { priorCastNames } : {}),
      // 0104 (R4) — signal a SAME-CHARACTER return so the registry folds this user's notoriety into the
      // new cast's day-one reads. Derived from `keepCharacter` here because the line above strips it to
      // false (the fresh session has no prior house to carry from, so the flag would otherwise be lost).
      ...(carried ? { carriesNotoriety: true } : {}),
    };
    // Non-degradation at its single most destructive point (B36/audit A2): an already-started game is
    // NEVER silently wiped. Without an explicit `confirmRestart`, a second createCharacter (a stray GM
    // call, a network caller) is a no-op returning the current state — the prior save is left intact.
    if (this.house) {
      // The no-op returns the PRIOR season's view — but now SIGNALS the refusal (audit R4-05) so the
      // caller can tell "created" from "left untouched". Without it the model read the unchanged view
      // as success and narrated a new season the engine never started.
      if (!req.confirmRestart) return {
        ...this.view(),
        createRefused: this.live?.finished ? "over" : "in-progress",
        createRefusedReason: this.live?.finished
          ? "a season already finished for this player — start a new game from the menu (a confirmed restart) before casting again"
          : "a season is already in progress for this player — it was left untouched; use the menu to restart rather than re-casting",
      };
      // A CONFIRMED restart routes through the ONE sanctioned door (audit E1/D1/R1): the registry's
      // reset delegate — the SAME hinge the admin reset uses — forgets the orchestrator baseline,
      // rotates the dead season's saves, and creates season 2 in a clean sandbox. Without that the
      // fresh week-1 snapshot read as a count regression against the finished season ⇒ a degradation
      // fault on every commit, nothing persisted, and the dead season resurrected on engine restart.
      if (this.onRestart) return this.onRestart({ ...effReq, confirmRestart: false });
      // Standalone (no registry composed — tests/onboarding fixtures): legacy in-place restart.
    }
    // Finalize FROM the interview's incremental intake (0050): everything updateCasting recorded
    // is the base; explicit args override field-by-field. OOBE can arrive half-done or fully done —
    // the one hard requirement is a name from SOMEWHERE.
    const merged = mergeCastingUpdate(this.intake, {
      ...effReq,
      ...(effReq.interviewNotes ? { interviewNotes: effReq.interviewNotes } : {}),
    });
    const playerName = merged.playerName;
    if (!playerName) {
      // Issue #1033 / F-2: the rejection MUST surface a clear reason. The name may have been written
      // under a synonym key (`name`) that the engine now aliases (issue #1033 / F-1) — if it STILL
      // isn't here, the intake genuinely has no name. Name the field explicitly so the GM re-asks and
      // records it with `updateCasting` rather than looping with no diagnosis (the message is the 400
      // body the FE surfaces).
      throw new EngineRefusal(
        "casting cannot finalize: no player name is on file — ask the player their name and record it with updateCasting(playerName) before createCharacter",
      );
    }
    // Completeness backstop (the mobile short-circuit fix, 0050): the forced FE finalize fires
    // `createCharacter("{}")` — empty args that pull the whole identity from a thin, name-only intake
    // (name+photo, no real interview), minting the default-archetype "floater with no stats." Refuse
    // that exact shape (typed) so the interview continues instead of silently minting a floater.
    // The guard fires ONLY when BOTH are true: (a) zero authored substance anywhere in `merged`
    // (cast photo is NOT substance), and (b) the explicit args carried no identity intent of their own
    // (no `playerName`/`seed`/`archetype`). That keeps every direct, intentional creation working — the
    // admin debug door (archetype), tests/fixtures (an explicit name+seed), and a real interview (which
    // arrives with backstory/motivation/persona substance) — and blocks only the empty-args bug path.
    const hasSubstance =
      !!merged.archetype ||
      !!merged.strategyStyle ||
      !!merged.backstory ||
      !!merged.motivation ||
      !!merged.personaArchetype ||
      !!merged.personaStrategyStyle ||
      !!merged.privateStrategy ||
      merged.interviewNotes.length > 0;
    const argsCarriedIdentity =
      !!effReq.playerName || effReq.seed !== undefined || !!effReq.archetype || !!effReq.strategyStyle;
    if (!hasSubstance && !argsCarriedIdentity) {
      return {
        ...this.view(),
        createRefused: "casting-incomplete",
        createRefusedReason:
          "the casting interview needs more than a name before the season can start — capture a backstory, a motivation, and how they'll play (updateCasting) and finalize again",
      };
    }
    // 0065 — ADOPT a pre-warmed cast. If `preSeedCast` already generated (and the FE deeply authored)
    // the cast during the interview, finalize ATOP it: reuse its seed so the warmed cast is the cast that
    // ships, and skip re-seeding the thin floor below. An explicit seed that DIFFERS discards the stale
    // warm (the caller asked for a specific cast); same/absent seed adopts.
    const adopt = this.prewarm && (effReq.seed === undefined || effReq.seed === this.prewarm.seed)
      ? this.prewarm : null;
    // E39/C7/D8: the DEFAULT seed is real entropy, persisted with the snapshot — the same player
    // name must never replay the byte-identical season (incl. its hidden elements and twist
    // schedule: a restarting player would replay secrets they already know). Explicit seeds stay
    // first-class for tests and replays. An adopted warm reuses its already-minted seed.
    const seed = adopt ? adopt.seed : (effReq.seed ?? entropySeed());
    this.gameSeed = seed; // B60/E12: every per-moment rng below keys off the GAME's seed
    // The producer persona (producer-persona feature): keep the producer the player has been interviewing
    // with if one was already established pre-game; otherwise bind it to the season seed so a direct
    // `createCharacter` (no prior interview, e.g. tests) still has a deterministic, reproducible producer.
    // Either way the off-camera producer is NEVER one of the 16 — it is not added to the house below.
    if (this.producerSeed === null) this.producerSeed = seed;
    this.producerCache = null;
    // 0051: draw ONE per-season portrait style anchor, seeded off the game seed — same seed always
    // draws the same anchor, so the house looks like itself across restarts and through the season.
    // (An adopted warm already drew it off the same seed — reuse it so it is byte-identical.)
    this.portraitStyleAnchor = adopt ? adopt.portraitStyleAnchor : STYLE_ANCHOR_VARIANTS[
      new SeededRandom(hashSeed(`${seed}:portrait-style`)).int(STYLE_ANCHOR_VARIANTS.length)
    ];
    // 0062 — capture the move-in zeitgeist snapshot ONCE, here, off the SAME season-seed hinge as the
    // cast, then FREEZE it (§3/§9). This is the deterministic `model-framed` fallback (the no-provider
    // path, §8) — reproducible-by-seed and byte-stable across every turn/restart; the FE may REPLACE it
    // with a real `web_search` capture via `recordWorldSnapshot` (FE-owned provider, like the 0051 image
    // port). It NEVER reaches the deterministic core — pure outward flavor (§6). `capturedFor` is the
    // in-fiction move-in marker; the snapshot freezes the house there for the whole season.
    this.worldSnapshot = buildWorldSnapshot({ seed, capturedFor: "move-in day" });
    const archetype = merged.archetype && isPlausibleArchetype(merged.archetype) ? merged.archetype : undefined;
    const strategyStyle = merged.strategyStyle as StrategyStyle | undefined;
    // #1326 — the player's OWN pronouns/presentation, validated against the same enum a houseguest's
    // public `genderPresentation` facet uses (an unrecognized/garbled value is dropped, never stored
    // raw — mirrors the `archetype` validation immediately above).
    const genderPresentation = merged.genderPresentation && isGenderPresentation(merged.genderPresentation)
      ? merged.genderPresentation : undefined;
    // Keep the player's RAW typed words as their public persona (narrative/display), even when they
    // don't match a canonical archetype/style — so the game master voices them as they described
    // themselves. The canonical `archetype`/`strategyStyle` above still drive hidden stats (0006).
    // The casting interview (0050) carries both halves: the canonical mapping in
    // `archetype`/`strategyStyle` and the player's OWN words in `personaArchetype`/`personaStrategyStyle`.
    this.house = startNewGame({
      seed, playerName, archetype, strategyStyle,
      ...(merged.personaArchetype ? { personaArchetype: merged.personaArchetype }
        : merged.archetype ? { personaArchetype: merged.archetype } : {}),
      ...(merged.personaStrategyStyle ? { personaStrategyStyle: merged.personaStrategyStyle }
        : merged.strategyStyle ? { personaStrategyStyle: merged.strategyStyle } : {}),
      ...(merged.backstory ? { backstory: merged.backstory } : {}),
      ...(merged.privateStrategy ? { privateStrategy: merged.privateStrategy } : {}),
      ...(merged.motivation ? { motivation: merged.motivation } : {}),
      ...(merged.interviewNotes.length ? { interviewNotes: merged.interviewNotes } : {}),
      ...(genderPresentation ? { genderPresentation } : {}),
      // NAME-1 (#547): the corpus-sampled cast avoids prior seasons' names (bounded, fail-soft).
      ...(effReq.priorCastNames && effReq.priorCastNames.length ? { priorCastNames: effReq.priorCastNames } : {}),
    });
    // 0065 — when adopting a pre-warmed cast, keep the freshly-built PLAYER but swap in the warmed NPCs
    // (which carry any FE-authored §3 depth). The warmed NPCs are byte-identical to the floor
    // `startNewGame` just regenerated PLUS the authoring, so the seeded competition/vote calibration is
    // unchanged; only the authored prose/secrets differ. The cast is consumed — clear the holding store.
    if (adopt) this.house = { player: this.house.player, npcs: adopt.npcs };
    this.intake = emptyIntake(); // the interview is over — its material lives on the player now
    this.week = 1;
    this.phase = "premiere";
    // PREMIERE (feature #380 follow-on; owner ruling 2026-07-14 — THE CHAMPAGNE CIRCLE): reset the
    // meet-everyone trackers empty, then `meetWholeHouseAtChampagneCircle()` (below, after the live
    // season exists) fills them deterministically — the premiere opens on the producers convening the
    // whole house for champagne-circle introductions, so EVERY houseguest is met at the toast, at once
    // (the engine records the meetings; the model still narrates the toast). No manual roll-call, no
    // milling about to stumble on strangers; the first HOH is reachable the moment the toast is done.
    this.premiereMet = new Set();
    // #1318: reset the earned hot-read set too — the champagne circle refills it (a genuine group intro).
    this.premiereHotReads = new Set();
    // A1: reset the durable name-lock — the champagne circle re-locks each houseguest's name as it introduces them.
    this.introducedNames = new Set();
    // #1322: a fresh season starts with no approach-rotation cooldown either — a reused adapter
    // instance (the one sanctioned restart door) must not carry a prior season's rotation forward.
    this.approachCooldown = new Map();
    this.approachStretchKey = undefined;
    this.lastApproachStretch = undefined;
    this.seenMessageIds = []; // a fresh season forgets the prior season's message ids and returns to legacy billing until announced
    this.messageMode = false;
    // Start the incremental weekly loop over the live house (player + NPCs).
    this.live = newLiveSeason([this.house.player.id, ...this.house.npcs.map((n) => n.id)]);
    // THE CHAMPAGNE CIRCLE (owner ruling 2026-07-14): mark the whole house met at the toast — deterministic,
    // engine-recorded, Vault-free and seed-neutral (projection sets only; no rng, no fold). The premiere's
    // introductions auto-happen at the champagne toast (the first thing that happens), NOT via a manual
    // roll-call. Done after `this.live` exists so seat resolution is unambiguous (every NPC is active at genesis).
    if (!this.premiereEntrancesEnabled) this.meetWholeHouseAtChampagneCircle(); // A9: entrances meet them one at a time
    // FEATURE 0111 — GATHER the whole house for the champagne circle: the toast is a whole-house EVENT,
    // not free prose. Marking the live season `"gathered"` makes `houseEventInSession()` report a
    // `champagne-circle` event, so `whereabouts()` seats the whole house co-present in the living room
    // and `movePlayer` no-ops — the narrator cannot stage the toast elsewhere, and it cannot fire while
    // the player has wandered off (the reported bug: "the champagne circle fired and I wasn't in the
    // room"). The player's living-room seat itself is forced below at the `assignRooms` override (the
    // social heart of the house), so this is purely a projection flag: seed-NEUTRAL (no rng, no fold),
    // and the whole change persists in the same season-start commit (no extra beatSeq bump). Released to
    // free-roam premiere on the model's first `advanceGame` (`champagneCircle = "done"`), which does NOT
    // start the first HOH — the bedroom pick + settling-in premiere beats still run.
    if (!this.premiereEntrancesEnabled) this.live.champagneCircle = "gathered"; // A9: the entrances gather the house themselves
    if (this.reactiveTwistsEnabled) {
      // 0025 REACTIVE (PO ruling 2026-07-06): arm the standing pool — all three twists watch the live
      // house, each fires when the house EARNS its (per-season seeded) trigger, at most once, and all
      // three may fire in one season. The sealed plan rides the engine-only loop state (persisted,
      // 0030) — no projection selects it — so it is invisible to player AND admin until a twist fires.
      this.live.twistPlan = planReserveTwists(new SeededRandom(hashSeed(`${seed}:twist-plan`)));
    } else {
      // 0025/B53 legacy path — load + SEAL the pre-scheduled reserve twists. BE-3: `loadReserveTwists`
      // now draws the KIND only from `IMPLEMENTED_TWISTS` itself (never the full curated pool), so no
      // post-hoc filter is needed. Byte-identical to the pre-redesign setup.
      const reserve = loadReserveTwists(this.twistCount, new SeededRandom(hashSeed(`${seed}:twists`)))
        .filter((t, i, all) => all.findIndex((o) => o.fireAtBeat === t.fireAtBeat) === i); // one twist per week
      if (reserve.length > 0) {
        this.live.reserve = reserve;
        this.onSeal?.(reserve);
      }
    }
    if (adopt) {
      // 0065 — adopt the warmed cast's already-sealed layers wholesale (the diversity floor + the §3
      // deep layer + threads were generated and sealed to the Vault at `preSeedCast` time, and the FE
      // may have authored over them). Re-running the seeders here would regenerate the thin floor and
      // CLOBBER the authoring, so they are SKIPPED — the warm is the source of truth from here.
      this.deepProfiles = adopt.deepProfiles;
      this.storyThreads = adopt.storyThreads;
      this.privateOrientations = adopt.privateOrientations;
      this.groundedSkinTones = adopt.groundedSkinTones;
      this.nominationWeeks = {};
      this.surfacedThreadCount = 0;
      this.eruptionCount = 0; // 0091 — a fresh season starts with no eruptions + an unspent cap
      this.triggerTickCount = 0;
      this.confideState = {};
    this.jurorTold = new Set();
      this.lieCount = 0; this.confideLiesBy = {};
      this.resetSecretPower(); // 0093/0099 — a fresh season has spent no secrets and an unspent cap
      this.resetTieSurfacing(); // 0059 §5 — a fresh season: no tie discovered, the player-surface cap unspent
      this.resetSecretPacing(); // 0092 — a fresh season: the weekly drip cadence + anti-spam start clean
      this.resetLegends(); // 0101 — a fresh season has minted no legend, the cap unspent
      this.resetJuryHouse(); // 0100 — a fresh season's jury house has processed no arrivals
    this.lastConfessionalSweepDay = 0; // 0122 — a fresh season hasn't swept any in-game day yet
      this.resetSecretBarter(); // 0099 — a fresh season has bartered no secret off-screen
      this.resetShowrunner(); // 0101/#1401 — a fresh season's production bible is empty
      // 0116 — carry the model-authored genesis layer off the warm: the validated tie graph (preferred
      // over the floor draw by seedSeededRelationships below), the seeded season brief, and the provenance.
      // Absent on a non-genesis warm ⇒ null/false, so seedSeededRelationships draws the floor ties.
      // #1909: a pre-#1909 casting save paused mid-casting carries authored ties under `prewarm.genesisTies` with the old
      // spelling — re-read each nature through the same alias so `seedSeededRelationships` never sees an invalid one.
      this.genesisTies = adopt.genesisTies
        ? adopt.genesisTies.map((t) => ({ ...t, nature: normalizeTieNature(t.nature) ?? "old-acquaintance" }))
        : null;
      this.seasonBrief = adopt.seasonBrief ?? null;
      this.genesisAuthored = adopt.genesisAuthored ?? false;
      this.prewarm = null; // consumed
    } else {
      // 0063 — the casting diversity floor: deal the engine-GUARANTEED diversity layer off a DEDICATED
      // isolated sub-stream (never the shared house/competition stream — the #338 RNG-isolation lesson),
      // validate/repair to the four floors (BIPOC / gender balance / age spread / LGBTQ+), fold the PUBLIC
      // facets (ethnicity, gender presentation, an out orientation) onto each byte-stable Character, GROUND
      // physicalCharacteristics.skinTone from the ethnicity, and SEAL each private orientation into the
      // Vault. Done BEFORE seedDeepProfiles so the deep layer's skin-tone reads the grounded ethnicity.
      this.seedDiversity(seed);
      // 0058 — born deep: generate the cast's deterministic DEEP layer (the seeded floor + offline
      // fallback), then SPLIT it across the Vault Wall. The PUBLIC facets (biography + the structured
      // physical characteristics) fold onto each byte-stable Character; the HIDDEN profile + the derived
      // story threads are sealed engine-side (into the Vault + the recall index) via `onSealProfiles`.
      // Done BEFORE seedFirstImpressions so the Day-1 perception can seed the NPC→player edge.
      this.seedDeepProfiles(seed);
      // #1140 — NOW the name-keyed deep layer is fixed off the original names; apply the deferred gender-
      // coherent renames onto the byte-stable Character (no-op when nothing was renamed).
      this.applyDiversityRenames();
      // 0116 — a plain (non-adopted) start has no model-authored genesis: the floor tie draw stands.
      this.genesisTies = null;
      this.seasonBrief = null;
      this.genesisAuthored = false;
      // A stale warm whose seed didn't match an explicit one is discarded (the season is now started).
      this.prewarm = null;
    }
    // #1140 ∩ NAME-1 (#547): cross-season de-collision of the gender-coherent re-pick — run for BOTH the
    // adopt and plain branches with the SAME prior names, so a re-pick never reintroduces a prior-season
    // given name AND the warm-cast/plain-restart casts stay byte-identical (the diversity-layer rename is
    // prior-season-UNAWARE on purpose; this is where cross-season memory is restored). No-op without priors.
    this.decollidePriorNames(seed, effReq.priorCastNames);
    // Seed first impressions so NPC decisions are differentiated from move-in (without this,
    // empty relationships make every HOH nominate the same first-in-roster houseguests). These
    // are starting beliefs; the consequence fold (0023) evolves them as the player acts.
    this.seedFirstImpressions(seed);
    // 0059 — born with a few HIDDEN ties: seed the sparse pre-game ties + showmances (0–2 each, often
    // none), fold their small standing affinity bias on top of the move-in edges, and SEAL them into the
    // Vault (engine-only; invisible to player AND admin — they surface only organically). Done AFTER
    // first impressions so the bias rides the scattered baseline; persisted so a showmance never resets.
    this.seedSeededRelationships(seed);
    if (this.premiereEntrancesEnabled) this.startPremiereEntrances(seed); // A9 (after the seeded ties exist)
    this.wireDispositions(); // archetype → disposition (B55): grudges stick, loyalists forgive
    // 0124 (part C): tune each houseguest's starting reactivity to their disposition (temperamental ⇒ more
    // volatile + slower to settle) instead of the flat random draw. Off ⇒ skipped ⇒ the draw stands (byte-identical).
    if (this.soulDepthEnabled) this.applyDispositionReactivity();
    // Move-in (0049): seat everyone somewhere (first assignment may place anyone anywhere). L21/L24:
    // seed BOTH views from the SAME premiere stream — the player-facing WEIGHTED positions (`presence`)
    // and the calibration-neutral BASE the off-screen society pairs on (`presenceBase`). The player's
    // room is forced identical in both (they are never personality-weighted).
    // issue #792: seat the initial sub-zones on the weighted premiere pass (no prior seating ⇒ fresh
    // deterministic seats from `zoneFor`, the seeding fallback); rides the premiere stream, not the spine.
    const premiereZone = new Map<EntityId, Zone>();
    this.presence = assignRooms(
      this.presenceActive(), null,
      this.presenceDeps(new SeededRandom(hashSeed(`${seed}:presence`)), true, null, premiereZone, null),
    );
    this.presenceZone = premiereZone;
    this.presenceBase = assignRooms(
      this.presenceActive(), null,
      this.presenceDeps(new SeededRandom(hashSeed(`${seed}:presence`)), false),
    );
    const meId = this.house!.player.id;
    // Post-0085 diagnostic fix: the player ENTERS into the social heart of the house (the living room),
    // never the seeded dead-end a premiere roll might drop them in (a passive player stranded in the
    // bathroom sees an empty house all season). Override the PLAYER's slot only — no rng draw changes, so
    // the NPC seating + the seeded society/calibration spine are byte-identical. They move by movePlayer next.
    this.presence.set(meId, "living-room");
    const pr = this.presence.get(meId);
    if (pr) this.presenceBase.set(meId, pr);
    // RC5 (#1599) — ENFORCE cast-identity coherence at the ONE point the whole assembled dossier exists
    // (genesis skeleton + identity pin + authored body all folded), BEFORE the season-start persist so the
    // corrected dossier is what durably lands. This is the production caller that makes the pure
    // castingIntake validator/repair REACHED — a model-authored cast can never go live internally
    // contradictory (Lily Evans). A deterministic floor cast is always coherent ⇒ a no-op (byte-neutral).
    const castCoherence = this.enforceCastCoherence();
    // ORW-208: report (never silently swallow) a requested strategy style the chosen archetype does not offer.
    const _res = resolveStrategyStyle(archetype, strategyStyle);
    const styleAdjusted = _res.adjusted && archetype ? { ..._res.adjusted, archetype } : undefined;
    this.persist(); // durable save (0030): a started game must survive a restart
    // 0051: attach the season-start portrait prompts — present ONLY on this response (the FE calls
    // the image API once at move-in and stores the results). Built from PUBLIC appearance facets
    // only (id/name/appearance/age/presentation) — never stats, soul, or hidden elements.
    return {
      ...this.view(),
      portraitPrompts: this.castPortraitPrompts(),
      ...(castCoherence ? { castCoherence } : {}),
      ...(styleAdjusted ? { strategyStyleAdjusted: styleAdjusted } : {}), // ORW-208: never a silent coercion
    };
  }

  /**
   * 0056 — the prior player's AUTHORED, Vault-free fields: everything needed to recreate the SAME
   * static CHARACTER next season. The character is seed-independent (aptitudes = the authored
   * archetype's bias, appearance = hash of the authored name), so re-supplying these regenerates the
   * identical houseguest under a new cast. The dynamic SOUL is deliberately NOT carried — the new
   * season starts at move-in — but the ORIGINAL casting-interview material (motivation + notes) is
   * reconstructed from the seeded Soul memory so the new season's memory re-seeds identically. No
   * hidden number is read or returned.
   */
  private carryOverFields(): CreateCharacterReq {
    const p = this.house!.player;
    // The interview seeded Soul memory as "casting interview — <note>" entries (and one
    // "casting interview — why I came: <motivation>"); reconstruct the original notes, dropping the
    // motivation line (carried separately) and any non-casting memory accrued during the season.
    const PREFIX = "casting interview — ";
    const notes = (p.soul?.memory ?? [])
      .filter((m) => typeof m === "string" && m.startsWith(PREFIX) && !m.startsWith(`${PREFIX}why I came: `))
      .map((m) => m.slice(PREFIX.length));
    return {
      playerName: p.name,
      archetype: p.character.archetype,
      strategyStyle: p.character.strategyStyle,
      ...(p.persona?.archetype ? { personaArchetype: p.persona.archetype } : {}),
      ...(p.persona?.strategyStyle ? { personaStrategyStyle: p.persona.strategyStyle } : {}),
      ...(p.character.background ? { backstory: p.character.background } : {}),
      ...(p.privateStrategy ? { privateStrategy: p.privateStrategy } : {}),
      ...(p.motivation ? { motivation: p.motivation } : {}),
      ...(notes.length ? { interviewNotes: notes } : {}),
      // #1326 — season-to-season continuity (0056): the returning player keeps their own recorded
      // pronouns/presentation into the new season, exactly like the rest of their authored profile.
      ...(p.character.genderPresentation ? { genderPresentation: p.character.genderPresentation } : {}),
    };
  }

  /**
   * NAME-1 (#547) — the names the NEXT season's corpus-sampled cast should AVOID: the dead season's
   * full cast roster (player + NPCs) merged with any names already carried over from earlier seasons
   * (so the exclusion accumulates across a multi-season game). BOUNDED: capped at `MAX_PRIOR_NAMES`
   * (most-recent-wins) so it can never grow unbounded; the engine floor honors it fail-soft (it relaxes
   * the exclusion rather than starving the sampler when the corpus runs short). No hidden state is read.
   */
  private priorSeasonNames(carried?: readonly string[]): string[] {
    const MAX_PRIOR_NAMES = 240; // ~15 seasons of names — generous headroom, still bounded
    const names: string[] = [];
    if (this.house) {
      names.push(this.house.player.name);
      for (const n of this.house.npcs) names.push(n.name);
    }
    if (carried) names.push(...carried);
    // De-dup, keep the MOST RECENT (this season's roster first) within the cap.
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of names) {
      const name = (raw ?? "").trim();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      out.push(name);
      if (out.length >= MAX_PRIOR_NAMES) break;
    }
    return out;
  }

  /**
   * Build the Vault-free cast portrait prompts (0051) from the PUBLIC house facets — the same
   * fields the visible projection exports on the HouseguestCard. No stats, no soul, no hidden
   * elements ever reach `buildCastPortraitPrompts`.
   */
  private castPortraitPrompts(roster?: GameHouse["npcs"], anchor?: string): PortraitPromptEntry[] {
    // 0065: pre-warm passes the NPC-only roster + the warmed anchor (no player exists yet); the live
    // path defaults to the whole house (player + NPCs). Same builder either way.
    const styleAnchor = anchor ?? this.portraitStyleAnchor;
    const everyone = roster ?? (this.house ? [this.house.player, ...this.house.npcs] : []);
    if (!styleAnchor || everyone.length === 0) return [];
    const publicCast = everyone.map((h) => ({
      id: h.id,
      name: h.name,
      appearance: h.character.appearance,
      age: h.character.age,
      presentation: h.character.presentation,
      // L29: the structured physical facet (0058) AUTHORS the face so it matches the person and never
      // drifts from the narration. PUBLIC by construction; falls back to the prose appearance if unseeded.
      ...(h.character.physicalCharacteristics !== undefined
        ? { physicalCharacteristics: h.character.physicalCharacteristics } : {}),
      // 0063: feed the PUBLIC diversity + personality facets — heritage, presentation, demeanor — so each
      // shot is visibly that unique person. A PRIVATE orientation is NOT a Character field, so it never
      // reaches here (the §5 Vault rule, enforced by construction + the portrait sentinel sweep).
      ...(h.character.ethnicity !== undefined ? { ethnicity: h.character.ethnicity } : {}),
      ...(h.character.genderPresentation !== undefined ? { genderPresentation: h.character.genderPresentation } : {}),
      ...(h.character.demeanor !== undefined ? { demeanor: h.character.demeanor } : {}),
      // The AUTHORED storyline facets (2026-07-13): the 0116 freeform identity + the L28/0058 vocation —
      // both already on the public HouseguestCard — so the face matches the person's storyline/aesthetic.
      ...(h.character.identityConcept !== undefined ? { identityConcept: h.character.identityConcept } : {}),
      ...(h.character.vocation !== undefined ? { vocation: h.character.vocation } : {}),
    }));
    return buildCastPortraitPrompts(publicCast, styleAnchor);
  }

  /**
   * 0065 — the Vault-free public roster card for ONE houseguest: exactly the observable facets the
   * visible projection's `house` array ships (id/name/persona/age/presentation/diverse facets/the public
   * biography + physical facet). NO stats, soul, hidden elements, or relationship number. Shared by the
   * live `view()` mapping AND `preSeedCast` (the pre-warm roster) so the FE authors/shoots against the
   * same shape it will see at season start. `status` defaults to ACTIVE (pre-game everyone is in).
   */
  private castCard(n: GameHouse["npcs"][number], status: HouseguestCard["status"] = "active"): HouseguestCard {
    return {
      id: n.id, name: n.name, status,
      archetype: n.character.archetype,
      strategyStyle: n.character.strategyStyle,
      background: n.character.background,
      age: n.character.age,
      presentation: n.character.presentation,
      ...(n.character.vocation !== undefined ? { vocation: n.character.vocation } : {}),
      ...(n.character.hometown !== undefined ? { hometown: n.character.hometown } : {}),
      ...(n.character.demeanor !== undefined ? { demeanor: n.character.demeanor } : {}),
      ...(n.character.identityConcept !== undefined ? { identityConcept: n.character.identityConcept } : {}),
      ...(n.character.biography !== undefined ? { biography: n.character.biography } : {}),
      ...(n.character.physicalCharacteristics !== undefined
        ? { physicalCharacteristics: n.character.physicalCharacteristics }
        : n.character.appearance !== undefined ? { appearance: n.character.appearance } : {}),
      ...(n.character.ethnicity !== undefined ? { ethnicity: n.character.ethnicity } : {}),
      ...(n.character.genderPresentation !== undefined ? { genderPresentation: n.character.genderPresentation } : {}),
      ...(n.character.outOrientation !== undefined ? { outOrientation: n.character.outOrientation } : {}),
      // #1067: PUBLIC, Vault-free provenance — `true` once the FE deep-profile authoring landed for this
      // houseguest, otherwise absent (still on the seeded floor). NOT secret content; lets the FE backfill
      // target the still-floor cards.
      ...(n.character.deepProfileAuthored === true ? { authored: true } : {}),
      // I6 distinct-voices fix: the SAFE rendered voice-fingerprint clause (0084) the live `view()`
      // mapping now carries — keeps this pre-warm/portrait shape in sync with the live roster card
      // (this docstring's own "same shape" contract). A player-surface-safe STRING (dial vocab only),
      // never the raw VoiceProfile object.
      ...(n.character.voice !== undefined ? { voice: voiceFingerprint(n.character.voice) } : {}),
    } as HouseguestCard;
  }

  /**
   * 0065 — pre-warm the cast. Generate the player-INDEPENDENT cast off the season seed into the
   * `prewarm` holding store BEFORE the interview ends, so the FE can deeply author it
   * (`recordCastProfile` lands on `prewarm` pre-game) and portraits read the FINISHED store. The whole
   * cast is deterministic off the seed (no player field is read), so this is safe the instant a model
   * is selectable. Idempotent (a second call returns the already-warmed cast); durable (0030). The
   * SAME seed is adopted by `createCharacter`, so the warmed cast is the cast that ships. Vault-free out.
   */
  preSeedCast(req: PreSeedCastReq): PreSeedCastView {
    // A season is already running (or crowned): casting is closed — refuse honestly, change nothing.
    if (this.house) {
      return { warmed: false, seed: this.gameSeed ?? 0, house: [], portraitPrompts: [],
        refused: this.live?.finished ? "over" : "in-progress" };
    }
    // Idempotent: a cast is already warmed. Re-warm only if an explicit seed DIFFERS (tests/replays);
    // otherwise return the existing warm so author/portrait warm never restart mid-flight.
    if (this.prewarm && (req.seed === undefined || req.seed === this.prewarm.seed)) {
      return {
        warmed: true, alreadyWarmed: true, seed: this.prewarm.seed,
        house: this.prewarm.npcs.map((n) => this.castCard(n)),
        portraitPrompts: this.castPortraitPrompts(this.prewarm.npcs, this.prewarm.portraitStyleAnchor),
      };
    }
    // Mint + persist the season seed NOW (E39/C7 entropy by default) so the warmed cast is reproducible
    // and `createCharacter` adopts THIS seed. An explicit seed stays first-class (tests/replays).
    const seed = req.seed ?? entropySeed();
    this.gameSeed = seed;
    if (this.producerSeed === null) this.producerSeed = seed; // keep the casting producer stable pre-game
    const portraitStyleAnchor = STYLE_ANCHOR_VARIANTS[
      new SeededRandom(hashSeed(`${seed}:portrait-style`)).int(STYLE_ANCHOR_VARIANTS.length)
    ]!;
    this.portraitStyleAnchor = portraitStyleAnchor;
    // Generate the cast by REUSING the exact live seeding path against a temporary house — so the warmed
    // seeded floor is BYTE-IDENTICAL to what `createCharacter` would produce un-warmed (no golden-test
    // drift). The NPC roster is player-independent: `generateHouse(rng)` runs fully BEFORE `runPlayerOOBE`
    // (which never consumes the rng), so these NPCs equal the ones `createCharacter` regenerates off the
    // same seed. The placeholder player is type-scaffolding ONLY — discarded below; `seedDiversity` /
    // `seedDeepProfiles` touch `npcs` exclusively, never the player.
    const temp = startNewGame({ seed, playerName: PREWARM_PLAYER_NAME });
    const npcs = temp.npcs;
    this.house = { player: temp.player, npcs };
    this.seedDiversity(seed);    // folds public diversity facets + seals private orientations to the Vault
    this.seedDeepProfiles(seed); // folds the §3 deep layer + seals the hidden profile/threads to the Vault
    this.applyDiversityRenames(); // #1140 — apply gender-coherent renames AFTER the name-keyed deep layer
    // Capture the finished cast into the holding store, then RESET back to a clean pre-game state (the
    // cast lives in `prewarm` from here; the live house does not exist until `createCharacter`).
    this.prewarm = {
      seed, npcs,
      deepProfiles: this.deepProfiles,
      storyThreads: this.storyThreads,
      privateOrientations: this.privateOrientations,
      groundedSkinTones: this.groundedSkinTones,
      portraitStyleAnchor,
    };
    this.house = null;
    this.deepProfiles = {};
    this.storyThreads = [];
    this.privateOrientations = {};
    this.groundedSkinTones = {};
    this.nominationWeeks = {};
    this.surfacedThreadCount = 0;
    this.eruptionCount = 0; // 0091 — a fresh season starts with no eruptions + an unspent cap
    this.triggerTickCount = 0;
    this.confideState = {};
    this.jurorTold = new Set();
    this.lieCount = 0; this.confideLiesBy = {};
    this.resetSecretPower(); // 0093/0099 — a warmed/fresh cast has spent no secrets, the caps unspent
    this.resetTieSurfacing(); // 0059 §5 — a warmed/fresh cast carries no tie-surfacing history
    this.resetSecretPacing(); // 0092 — a warmed/fresh cast carries no secret-pacing drip history
    this.resetLegends(); // 0101 — a warmed/fresh cast has minted no legend, the cap unspent
    this.resetJuryHouse(); // 0100 — a fresh season's jury house has processed no arrivals
    this.lastConfessionalSweepDay = 0; // 0122 — a fresh/warmed season hasn't swept any in-game day yet
    this.resetSecretBarter(); // 0099 — a warmed/fresh cast has bartered no secret off-screen
    this.resetShowrunner(); // 0101/#1401 — a warmed/fresh cast carries no producer notes yet
    // 0116 — a freshly-warmed cast carries no model-authored genesis yet (recordCastGenesis, if the FE
    // wires a model, authors it AFTER this warm). The floor tie draw stands until then (byte-neutral).
    this.genesisTies = null;
    this.seasonBrief = null;
    this.genesisAuthored = false;
    this.persist(); // a warmed cast is durable pre-game state (0030)
    return {
      warmed: true, seed,
      house: npcs.map((n) => this.castCard(n)),
      portraitPrompts: this.castPortraitPrompts(npcs, portraitStyleAnchor),
    };
  }

  /**
   * 0065 (advance-warm) — pre-warm the NEXT season's cast DURING the current season's finale, into a
   * per-user HOLDING STORE that survives the cutover. `preSeedCast` is refused mid-season (it warms
   * onto THIS adapter, which is discarded at reset); this is its mid-season counterpart.
   *
   * When the registry has wired `onNextSeasonWarm`, the call routes OUT to the registry, which owns the
   * survivor buffer + the scratch generation/authoring. Standalone (no registry — tests/fixtures), this
   * falls back to a detached in-process generation so the seam is fully testable without a registry: a
   * throwaway scratch `GameSessionAdapter` runs the SAME `preSeedCast`/`recordCastProfile` machinery, and
   * its Vault-free view is returned. Either way the ACTIVE season (`this.house`, every projection) is
   * untouched — the warm never reads or writes the live game. Vault-free out.
   */
  preSeedNextSeason(req: PreSeedNextSeasonReq): PreSeedNextSeasonView {
    if (this.onNextSeasonWarm) return this.onNextSeasonWarm(req);
    // Standalone fallback: warm a detached scratch in process (no buffer to survive a reset here — that
    // is the registry's job — but the generation + authoring + Vault-free view are exercised identically).
    const scratch = new GameSessionAdapter();
    return scratch.warmNextSeasonScratch(req);
  }

  /**
   * 0065 (advance-warm) — the scratch-side warm used by the registry's per-user holding-store adapter
   * (and the standalone fallback above). The scratch is a FRESH adapter with no live house, so the
   * existing pre-game machinery applies verbatim: `preSeedCast` generates the player-INDEPENDENT cast
   * off a NEW seed into `this.prewarm`, and an optional `profile` deep-authors ONE houseguest of it via
   * `recordCastProfile` — both landing on the holding store, never on any live season. Returns the same
   * Vault-free roster shape `preSeedCast` does (no secret crosses; the scratch has no Vault hooks wired,
   * so the hidden layer simply rides in `this.prewarm` until the cutover re-seals it into the new sandbox).
   */
  warmNextSeasonScratch(req: PreSeedNextSeasonReq): PreSeedNextSeasonView {
    const warm = this.preSeedCast({ ...(req.seed !== undefined ? { seed: req.seed } : {}) });
    if (!warm.warmed) {
      // A scratch adapter has no live house, so preSeedCast cannot refuse "in-progress"/"over" — this is
      // purely defensive (a future refusal would surface as a Vault-free decline, never a throw).
      return { warmed: false, seed: warm.seed, house: [], portraitPrompts: [], refused: "no-active-season" };
    }
    let authored: RecordCastProfileResult | undefined;
    if (req.profile) authored = this.recordCastProfile(req.profile);
    return {
      warmed: true, seed: warm.seed,
      house: warm.house, portraitPrompts: warm.portraitPrompts,
      ...(warm.alreadyWarmed ? { alreadyWarmed: true } : {}),
      ...(authored ? { authored } : {}),
    };
  }

  /**
   * 0065 (advance-warm) — read the scratch adapter's holding store so the registry can (a) persist it on
   * the LIVE sandbox's snapshot for engine-restart durability and (b) hand it to the fresh sandbox at the
   * cutover. A deep clone (the registry must not alias the scratch's live arrays). Null until a warm runs.
   */
  exportHeldPrewarm(): PrewarmCast | null {
    return this.prewarm ? cloneSession(this.prewarm) : null;
  }

  /**
   * 0065 (advance-warm) — the registry writes the freshly-warmed next-season cast THROUGH the LIVE
   * sandbox so it is DURABLE (persisted in this sandbox's snapshot, surviving an engine restart). A deep
   * clone in; persisted on the next commit. Invisible to active play (no projection reads it). `null`
   * clears the durable mirror (e.g. after the cutover consumed it).
   */
  holdNextSeasonWarm(store: PrewarmCast | null): void {
    this.nextSeasonWarm = store ? cloneSession(store) : null;
  }

  /** 0065 (advance-warm) — the durable next-season warm mirror, deep-cloned out (rehydrates the registry's buffer on resume). Null if none. */
  takeNextSeasonWarm(): PrewarmCast | null {
    return this.nextSeasonWarm ? cloneSession(this.nextSeasonWarm) : null;
  }

  /**
   * 0065 (advance-warm) — inject a held next-season cast onto THIS (fresh, pre-game) sandbox's pre-game
   * store at the cutover, so the immediately-following `createCharacter` ADOPTS it exactly as it adopts a
   * same-session `preSeedCast` warm. Refused if a season is already running here (the cutover always
   * injects into a clean sandbox; this guards the invariant).
   *
   * The held cast was warmed on a DETACHED scratch adapter with NO Vault/soul hooks wired, so its hidden
   * layer was never sealed into a Vault or indexed for recall. The same-session `preSeedCast` warm seals
   * at warm time (this sandbox's hooks fire), and `createCharacter`'s adopt branch relies on that. So on a
   * cross-sandbox advance-warm we re-create that precondition HERE: seal the held hidden layer into THIS
   * fresh sandbox's Vault + re-index each NPC's deep-profile/orientation note into its soul recall — so
   * the 0048 retrospective unsealing + full-fidelity recall behave byte-identically to a same-session warm.
   */
  adoptHeldPrewarm(store: PrewarmCast): boolean {
    if (this.house) return false; // never overwrite a live season's cast
    const held = cloneSession(store);
    this.prewarm = held;
    // Seal the held hidden layer into THIS sandbox's Vault (engine-only audit copy) — the scratch sealed
    // nowhere. Idempotent into a fresh, empty Vault; mirrors what seedDeepProfiles/seedDiversity seal.
    this.onSealProfiles?.(
      Object.entries(held.deepProfiles).map(([id, profile]) => ({ id: id as EntityId, profile })),
      held.storyThreads,
    );
    const orientations = Object.entries(held.privateOrientations)
      .map(([id, orientation]) => ({ id: id as EntityId, orientation }));
    if (orientations.length) this.onSealPrivateOrientations?.(orientations);
    // Re-index each NPC's hidden notes into THIS sandbox's soul recall index (the scratch's soul.memory
    // arrays rode in on the cloned NPCs, but were indexed in the scratch's soul store, not here). The
    // notes are already PRESENT in each NPC's soul.memory; this only (re)indexes them for semantic recall.
    for (const n of held.npcs) {
      const profile = held.deepProfiles[n.id];
      if (profile) this.soul?.recordToSoul(n.id, deepProfileToVaultContent(n.id, profile));
      const orientation = held.privateOrientations[n.id];
      if (orientation) this.soul?.recordToSoul(n.id, privateOrientationToVaultContent(n.id, orientation));
    }
    return true;
  }

  /**
   * Record casting-interview answers as they land (0050). Any subset of fields, any number of
   * times pre-game; notes append, scalars overwrite. Persisted on every update so a half-done
   * interview survives a restart (0030). Once a season is running this is a no-op that returns
   * the (complete) status — a stray call can never disturb a live game.
   */
  updateCasting(req: UpdateCastingReq): CastingStatusView {
    // Season already running: casting is CLOSED. Refuse HONESTLY (audit R4-05) instead of the old
    // fake `ready:true` that recorded nothing yet looked like success — that silent success let the
    // model narrate a fresh casting interview post-season while the engine never started one. The
    // refusal names whether a season is live (`in-progress`) or already crowned (`over`).
    if (this.house) {
      return { known: {}, missing: [], next: null, ready: false, finalizable: false, refused: this.live?.finished ? "over" : "in-progress" };
    }
    const before = this.intake;
    // C8: which already-captured scalars this update replaces — computed against the PRIOR intake,
    // surfaced so the producer confirms the change rather than silently clobbering an answer.
    const overwrote = overwrittenScalars(before, req);
    // R4-01: keys that are NOT casting fields (a recording filed under `name`/`notes`/a typo would
    // otherwise vanish). Echo them so the producer re-files rather than stalling on a lost answer.
    const ignoredKeys = ignoredCastingKeys(req);
    this.intake = mergeCastingUpdate(this.intake, req);
    if (JSON.stringify(before) !== JSON.stringify(this.intake)) {
      this.persist(); // a half-done interview is durable state (0030)
    }
    const status = castingStatusOf(this.intake, overwrote);
    if (ignoredKeys.length > 0) status.ignoredKeys = ignoredKeys;
    return status;
  }

  /**
   * Realistic move-in reads (B55/audit C5+C6). Day one nobody KNOWS anyone: signals start near the
   * relationship BASELINE with a small seeded scatter (not uniform noise), the threat read leans on
   * the target's PUBLIC archetype menace (a comp-beast looks dangerous across the kitchen counter —
   * never their hidden numbers), and confidence sits BELOW the knowledge threshold, so every
   * day-one read is a HUNCH the season then firms or breaks. Deterministic per game.
   */
  private seedFirstImpressions(seed: number): void {
    const all = this.house ? [this.house.player, ...this.house.npcs] : [];
    const rng = new SeededRandom(hashSeed(`${seed}:relationships`));
    const { baseline, MOVE_IN } = RELATIONSHIP_CONSTANTS;
    const scatter = (): number => (rng.next() - 0.5) * 2 * MOVE_IN.spread;
    for (const a of all) for (const b of all) {
      if (a.id === b.id) continue;
      const e = this.rel.edge(a.id, b.id);
      e.trust = clamp01(baseline.trust + scatter());
      e.affinity = clamp01(baseline.affinity + scatter());
      e.threat = clamp01(baseline.threat + MOVE_IN.threatWeight * archetypeMenace(b.character.archetype) + scatter());
      e.confidence = MOVE_IN.confidence;
    }
    // 0058 §3: the AUTHORED Day-1 perception seeds the NPC→player edge — each NPC walks in already
    // reading the player as something (warm ally / undecided / threat), not from a blank slate. The
    // signed leans nudge the (already-scattered) move-in edge; the player NEVER sees a number — only
    // the later behavior. Hidden by construction (the leans live in the Vault-only deep profile).
    for (const n of this.house?.npcs ?? []) {
      const p = this.deepProfiles[n.id]?.dayOnePerception;
      if (!p) continue;
      const e = this.rel.edge(n.id, PLAYER);
      e.trust = clamp01(e.trust + MOVE_IN.spread * p.trustLean);
      e.affinity = clamp01(e.affinity + MOVE_IN.spread * p.affinityLean);
      e.threat = clamp01(e.threat + MOVE_IN.spread * p.threatLean);
    }
    // 0104 — a reputation that PRECEDES the player into a NEW cast. ONLY when the player returned as
    // the SAME character (the diegetic opt-in, R4) is `this.notoriety` set; otherwise this whole block
    // is skipped and the move-in edges are BYTE-IDENTICAL (the calibration-neutrality guarantee). The
    // bias rides a DEDICATED `:notoriety` sub-rng forked off the seed — NEVER the shared `:relationships`
    // stream above — so even with a notoriety folded, the move-in SCATTER of every edge is unchanged
    // (the only edges that move are the NPC→player ones, and only their direction tilts). Each NPC draws
    // ONE recognition level (R2: not everyone has heard about the player; some hold a distorted version),
    // then the bounded, archetype-shaded, signed direction nudges the NPC→player edge INSIDE the existing
    // `MOVE_IN.spread` envelope — never a number to the player, never a comp/vote roll, never the player's
    // OWN edges. The engine still owns every outcome magnitude (mandate #3). Folded once, here.
    if (this.notoriety) {
      const nrng = new SeededRandom(hashSeed(`${seed}:notoriety`));
      for (const n of this.house?.npcs ?? []) {
        const archetype = n.character.archetype;
        const recognition = recognitionFor(nrng); // ONE per-NPC awareness, applied across all signals
        const e = this.rel.edge(n.id, PLAYER);
        e.trust = clamp01(e.trust + MOVE_IN.spread * notorietyBias(this.notoriety, archetype, "trust", recognition));
        e.affinity = clamp01(e.affinity + MOVE_IN.spread * notorietyBias(this.notoriety, archetype, "affinity", recognition));
        e.threat = clamp01(e.threat + MOVE_IN.spread * notorietyBias(this.notoriety, archetype, "threat", recognition));
      }
    }
  }

  /**
   * 0058 — born deep. Generate the cast's DETERMINISTIC deep layer (the seeded floor + offline
   * fallback the live LLM author is validated against, ledger L28b) and SPLIT it across the Vault:
   *   • PUBLIC facets (biography + the structured physical characteristics) fold onto each byte-stable
   *     Character — they cross to the player and are guarded byte-stable (0007/0031);
   *   • the HIDDEN profile (2–3 secrets, true goals, weakness, Day-1 perception) + the derived story
   *     threads are kept ENGINE-ONLY here and sealed into the Vault + the recall index via the hook.
   * Deterministic per seed and player-INDEPENDENT (the layer keys off the cast's seeded names, never
   * the player's profile — same seed ⇒ same deep cast regardless of who the player is, L28).
   */
  /**
   * 0063 — the casting diversity floor. Deal the engine-GUARANTEED diversity layer off a DEDICATED
   * isolated sub-stream (forked off the seed via `hashSeed` inside `generateDiversityLayer` — NEVER the
   * shared house/competition/vote stream, the #338 RNG-isolation lesson), validate/repair to the four
   * floors, SPLIT across the Vault:
   *   • PUBLIC facets (ethnicity, gender presentation, an OUT orientation) fold onto each byte-stable
   *     Character — they cross to the player and are superset-guarded (0007/0031); the ethnicity ALSO
   *     grounds `physicalCharacteristics.skinTone` (applied in seedDeepProfiles, which runs next), so the
   *     text and the portrait agree;
   *   • each PRIVATE orientation (closeted / not-yet-out) is kept engine-only here and sealed into the
   *     Vault — it surfaces to the player ONLY via a 0002 pathway, never on any projection.
   * Deterministic per seed and player-INDEPENDENT (the sub-stream keys off the seeded cast names). The
   * diversity attributes are DESCRIPTIVE ONLY — never a competition/vote/outcome input.
   */
  private seedDiversity(seed: number): void {
    if (!this.house) return;
    // TEST SEAM (the #338 RNG-isolation golden test): `ORWELL_DISABLE_DIVERSITY=1` skips the entire
    // diversity layer. Because the layer runs on a DEDICATED sub-stream and folds ONLY descriptive
    // fields (never a competition/vote input), the public OUTCOME stream must be byte-identical with it
    // on vs. off — the golden test proves exactly that. Never set in production (the deploy default is on).
    if (process.env.ORWELL_DISABLE_DIVERSITY === "1") return;
    const layer = generateDiversityLayer(seed, this.house.npcs);
    // PUBLIC fold — onto the static Character (byte-stable from here on; superset-guarded).
    this.pendingRenames = {};
    for (const n of this.house.npcs) {
      const pub = layer.public[n.id];
      if (!pub) continue;
      n.character.ethnicity = pub.ethnicity;
      n.character.genderPresentation = pub.genderPresentation;
      if (pub.outOrientation !== undefined) n.character.outOrientation = pub.outOrientation;
      // The age-spread floor may have repaired the age into a short band (descriptive only — age is NOT a
      // competition/vote input, so this never perturbs the seeded outcome stream). Write it back so the
      // card, the ageLook (0058), and the portrait all agree with the guaranteed spread.
      n.character.age = pub.age;
      this.groundedSkinTones[n.id] = pub.skinTone;
      // If the structured physical facet already exists (e.g. on a re-run path), ground its skin tone
      // now; otherwise seedDeepProfiles applies the grounding when it builds the facet.
      if (n.character.physicalCharacteristics) n.character.physicalCharacteristics.skinTone = pub.skinTone;
      // #1140 — STASH the re-picked name (when the layer changed it to match the final gender presentation);
      // DON'T write it to the Character yet — applyDiversityRenames does that AFTER seedDeepProfiles so the
      // name-keyed deep layer (and the outcome stream it feeds) stays byte-identical. (See pendingRenames.)
      if (pub.name !== undefined) this.pendingRenames[n.id] = pub.name;
    }
    // HIDDEN — engine-only, sealed off the player AND admin (a private orientation is a secret).
    this.privateOrientations = { ...layer.privateOrientations };
    // Full-fidelity recall + persistence (L27b): record each private orientation into the NPC's
    // AUTHORITATIVE soul memory (engine-only — never crosses) so it persists losslessly with the house,
    // counts toward non-degradation (0007), and re-indexes on restore. Also index NOW for same-session.
    for (const [id, orientation] of Object.entries(layer.privateOrientations)) {
      const note = privateOrientationToVaultContent(id as EntityId, orientation);
      const n = this.house.npcs.find((x) => x.id === id);
      n?.soul.memory.push(note);
      this.soul?.recordToSoul(id as EntityId, note);
    }
    // Seal the private orientations into the Vault (engine-only audit copy, the §5 wall).
    const entries = Object.entries(layer.privateOrientations).map(([id, orientation]) => ({ id: id as EntityId, orientation }));
    if (entries.length) this.onSealPrivateOrientations?.(entries);
  }

  /**
   * #1140 — apply the deferred diversity RENAMES onto the byte-stable Character. Called AFTER
   * `seedDeepProfiles` so the name-keyed deep layer was seeded off the ORIGINAL drawn names (keeping the
   * deep profile / Day-1 perception / story threads — and the seeded outcome stream they feed —
   * byte-identical with the rename on vs. off). From here the renamed name is the houseguest's stable
   * public name. A no-op when no draft was renamed (the common case). Mirrors at both seed sites.
   */
  private applyDiversityRenames(): void {
    if (!this.house) return;
    for (const n of this.house.npcs) {
      const renamed = this.pendingRenames[n.id];
      // The display name lives on the Houseguest wrapper (`n.name`), not on the static Character.
      if (renamed) n.name = renamed;
    }
    this.pendingRenames = {};
  }

  /**
   * #1140 ∩ NAME-1 (#547) — cross-season de-collision of the gender-coherent re-pick. The diversity rename
   * (step 7.5 in `diversity.ts`) keeps given names unique WITHIN the cast but is prior-season-UNAWARE (so the
   * advance-warm and plain-restart paths, which adopt vs. re-seed, stay byte-identical there). This pass —
   * run in `createCharacter` for BOTH paths AFTER the cast is finalized, with the SAME `priorCastNames` — is
   * where cross-season memory is restored: any houseguest whose GIVEN name collides with a prior-season name
   * is re-picked to a SAME-GENDER name that avoids both the prior-season set AND the current cast. So a re-pick
   * never reintroduces a prior name, AND warm == plain (identical inputs ⇒ identical output). Deterministic
   * off a dedicated `:rename-decollide` sub-stream; a no-op when nothing collides (the common case).
   */
  private decollidePriorNames(seed: number, priorCastNames?: readonly string[]): void {
    if (!this.house || !priorCastNames || priorCastNames.length === 0) return;
    const priorGiven = new Set<string>();
    for (const full of priorCastNames) { const g = (full ?? "").trim().split(" ")[0]; if (g) priorGiven.add(g); }
    if (priorGiven.size === 0) return;
    const rng = new SeededRandom(hashSeed(`${seed}:rename-decollide`));
    // Avoid every given name currently in the cast AND every prior-season given name.
    const used = new Set<string>(priorGiven);
    for (const n of this.house.npcs) used.add(n.name.split(" ")[0]!);
    for (const n of this.house.npcs) {
      const parts = n.name.split(" ");
      const given = parts[0]!;
      if (!priorGiven.has(given)) continue; // no cross-season collision — keep the name
      // Re-pick a SAME-GENDER name (gender coherence holds through the de-collision). The stored facet is
      // always present after seedDiversity; the `nameGenderOf` fallback only covers a legacy missing facet
      // (and a unisex/legacy read maps to a nonbinary-coherent unisex pick — never a wrong-gender name).
      const facet = n.character.genderPresentation;
      const g: "man" | "woman" | "nonbinary" =
        facet ?? (nameGenderOf(given) === "man" ? "man" : nameGenderOf(given) === "woman" ? "woman" : "nonbinary");
      used.delete(given); // free the colliding given before picking the replacement
      const next = pickGivenNameFor(g, rng, used);
      used.add(next);
      n.name = parts.length > 1 ? `${next} ${parts.slice(1).join(" ")}` : next;
    }
  }

  private seedDeepProfiles(seed: number): void {
    if (!this.house) return;
    const layer = generateCastDeepLayer(seed, this.house.npcs);
    // PUBLIC fold — onto the static Character (byte-stable from here on; superset-guarded).
    for (const n of this.house.npcs) {
      const pub = layer.public[n.id];
      if (!pub) continue;
      n.character.biography = pub.biography;
      n.character.physicalCharacteristics = pub.physicalCharacteristics;
      // 0063: GROUND the skin tone from the houseguest's ethnicity identity facet, so the structured
      // physical characteristics (which drive BOTH the narration and the portrait, L29/L23) agree with
      // the heritage the cast was guaranteed — the text and the picture never contradict the identity.
      const grounded = this.groundedSkinTones[n.id];
      if (grounded) n.character.physicalCharacteristics.skinTone = grounded;
      // L29 single-source reconciliation (appearance/physicalCharacteristics consistency fix): the prose
      // `appearance` is the OLDER 0004 descriptor, generated from INDEPENDENT pools — it could contradict
      // the structured facet (different build/skin/hair/age-look). Re-derive it FROM the structured facet
      // (the SAME builder the portrait uses) so the persisted prose can never disagree with the source of
      // truth, and any pre-0058 fallback reader stays consistent. Done at generation, before the first
      // persist, so the static Character still round-trips byte-stable (0007).
      n.character.appearance = physicalFacetToAppearance(n.character.physicalCharacteristics);
    }
    // HIDDEN — engine-only, sealed off the player AND admin.
    this.deepProfiles = layer.hidden;
    this.storyThreads = layer.threads;
    // 0060 — a fresh season starts with no nomination history and an unspent surfacing cap.
    this.nominationWeeks = {};
    this.surfacedThreadCount = 0;
    // 0091 — a fresh season starts with no eruptions, an unspent cap, and a fresh trigger-rng stream.
    this.eruptionCount = 0;
    this.triggerTickCount = 0;
    // 0075 — a fresh season has heard no confidences and spent no lies.
    this.confideState = {};
    this.jurorTold = new Set();
    this.lieCount = 0; this.confideLiesBy = {};
    this.resetSecretPower(); // 0093/0099 — a fresh season has spent no secrets, the caps unspent
    // 0059 §5 — a fresh season: no tie discovered, the player-surface cap unspent, the stream at 0.
    this.resetTieSurfacing();
    // 0092 — a fresh season: the secret-pacing weekly cadence + anti-spam start clean.
    this.resetSecretPacing();
    this.resetLegends(); // 0101 — a fresh season has minted no legend, the cap unspent
    this.resetJuryHouse(); // 0100 — a fresh season's jury house has processed no arrivals
    this.lastConfessionalSweepDay = 0; // 0122 — a fresh season hasn't swept any in-game day yet
    this.resetSecretBarter(); // 0099 — a fresh season has bartered no secret off-screen
    this.resetShowrunner(); // 0101/#1401 — a fresh season's production bible is empty
    // Full-fidelity recall (L27b): the authored hidden detail is recorded into each NPC's AUTHORITATIVE
    // soul memory (engine-only — soul memory never crosses the wall, B65) so it (a) persists losslessly
    // with the house, (b) is counted toward non-degradation (0007), and (c) is re-indexed on restore by
    // `rebuildSoulIndex` (which replays `soul.memory`) — so a detail established at cast time is
    // recall-able in full FOREVER, across restarts. Also indexed NOW for same-session recall.
    for (const n of this.house.npcs) {
      const profile = layer.hidden[n.id];
      if (!profile) continue;
      const note = deepProfileToVaultContent(n.id, profile);
      n.soul.memory.push(note);
      this.soul?.recordToSoul(n.id, note);
    }
    // Seal the HIDDEN profile + threads into the Vault (engine-only audit copy, the §8 wall).
    this.onSealProfiles?.(
      Object.entries(layer.hidden).map(([id, profile]) => ({ id: id as EntityId, profile })),
      layer.threads,
    );
  }

  /**
   * 0059 — seed the sparse HIDDEN relationship layer (pre-game ties + showmances) off a SIDE rng, fold
   * each pair's small standing affinity BIAS onto the (already-scattered) move-in edges, and SEAL the
   * layer into the Vault. Engine-only by construction (the bias is the ONLY observable — as later
   * behavior — and no tie/partner/stage is ever projected). Deterministic per seed + player-independent.
   */
  /**
   * 0063 (owner decision #3) — the orientation-aware showmance ELIGIBILITY predicate the 0059 seeder uses,
   * assembled from each NPC's PUBLIC gender presentation + their FULL orientation (the out facet on the
   * Character OR the engine-only private orientation). Engine-only by construction (it reads the private
   * map but never surfaces it). A QUEER showmance is a first-class plausible pairing; it never forces one.
   */
  private showmanceEligiblePredicate(): (a: EntityId, b: EntityId) => boolean {
    const identityOf = (id: EntityId): { orientation: Orientation; genderPresentation: GenderPresentation } | null => {
      const n = this.house?.npcs.find((x) => x.id === id);
      if (!n || !n.character.genderPresentation) return null;
      const orientation = (n.character.outOrientation as Orientation | undefined)
        ?? this.privateOrientations[id] ?? "straight";
      return { orientation, genderPresentation: n.character.genderPresentation };
    };
    return (a, b) => {
      const ia = identityOf(a); const ib = identityOf(b);
      if (!ia || !ib) return true; // unknown identity (pre-0063 cast) ⇒ no gating (back-compat)
      return showmancePlausible(ia, ib);
    };
  }

  /**
   * #840 — the gate the off-screen society (the orchestrator's `defaultApply` tick) uses so a LIVE
   * off-screen `showmance` scene obeys the SAME discipline the SEEDED layer (0059/0063) does:
   *
   *   • `plausible(a, b)` — orientation-aware eligibility (reuses `showmanceEligiblePredicate`): a live
   *     showmance only forms between an orientation-plausible pair (a queer showmance is first-class).
   *   • `hasActiveShowmance(id)` — whether the houseguest ALREADY holds an active (non-`resolved`,
   *     non-evicted) seeded showmance partner, so the off-screen tick never gives anyone a SECOND
   *     active showmance (the within-tick half of the one-partner cap lives in `richOffscreenStretch`).
   *
   * Engine-only by construction (it reads the Vault-sealed private orientations + seeded showmances but
   * surfaces neither — only the demotion's later BEHAVIOR is observable). The off-screen layer doesn't
   * mint a persistent showmance record, so "active partner" is sourced from the seeded showmance layer.
   */
  offscreenShowmanceGate(): { plausible: (a: EntityId, b: EntityId) => boolean; hasActiveShowmance: (id: EntityId) => boolean } {
    const plausible = this.showmanceEligiblePredicate();
    const evicted = new Set(this.live?.evictionOrder ?? []);
    const partnered = new Set<EntityId>();
    for (const s of this.seededRels.showmances) {
      if (s.stage === "resolved" || evicted.has(s.a) || evicted.has(s.b)) continue;
      partnered.add(s.a);
      partnered.add(s.b);
    }
    return { plausible, hasActiveShowmance: (id) => partnered.has(id) };
  }

  /** 0059 §5 — clear the tie-surfacing bookkeeping (a fresh season: nothing discovered, the cap unspent). */
  private resetTieSurfacing(): void {
    this.playerTieSurfaceCount = 0;
    this.surfacedTieSubjects = new Set();
    this.tieScheduleTickCount = 0;
  }

  /** 0093/0099 — clear the secrets-as-power ledger (a fresh season: no secret spent, every cap unspent). */
  private resetSecretPower(): void {
    this.secretUsedAs = {};
    this.exposeCount = 0;
    this.tradeCount = 0;
    this.playerBluffCount = 0;
    this.playerBluffBelief = {};
  }

  /** 0092 — clear the secret-pacing drip bookkeeping (a fresh season: the weekly counter + the per-thread
   *  last-dripped week start empty, so the cadence + anti-spam begin from scratch). */
  private resetSecretPacing(): void {
    this.pacingDripWeek = 0;
    this.pacingDripCount = 0;
    this.pacingTickCount = 0;
    this.pacingLastDrippedWeek = {};
  }

  /** 0100 — clear the jury-house bookkeeping (a fresh season: no arrival processed, the dedicated stream
   *  restarted). Without this, an in-place season restart kept the prior season's arrival watermark and
   *  skipped the new season's first stretches (#1932 review). */
  private resetJuryHouse(): void {
    this.juryHouseTickCount = 0;
    this.juryHouseArrivals = null;
  }

  /** 0101 — clear the myth-making bookkeeping (a fresh season: no legend minted, the cap unspent, no
   *  notable act yet consumed). */
  private resetLegends(): void {
    this.legendTickCount = 0;
    this.legendCount = 0;
    this.legendLastActTick = 0;
  }

  /** 0101/#1401 — clear the showrunner's production bible + its monotonic count (a fresh season starts
   *  with no producer notes). Reset only at a season boundary, never mid-season (non-degradation #4). */
  private resetShowrunner(): void {
    this.showrunnerNotes = [];
    this.showrunnerNoteCount = 0;
    this.showrunnerReweightCount = 0; // Phase-2 (#1455) — a fresh season has re-ordered nothing yet
  }

  /** 0099 (hidden half) — clear the off-screen secret-barter bookkeeping (a fresh season: no secret
   *  spent, the dedicated barter stream starts from zero). */
  private resetSecretBarter(): void {
    this.secretBarterTickCount = 0;
    this.secretBarterCount = 0;
  }

  private seedSeededRelationships(seed: number): void {
    if (!this.house) return;
    const rng = new SeededRandom(hashSeed(`${seed}:seeded-relationships`));
    const floor = loadSeededRelationships(
      this.house.npcs, this.tieBudget, this.showmanceBudget, rng, this.showmanceEligiblePredicate());
    // 0116 — when cast genesis authored the pre-show tie graph, PREFER it over the floor draw (already
    // envelope-validated: ≤ budget, distinct pairs, no NPC doubled, never the player, exposure "sealed").
    // SHOWMANCES stay engine-seeded (§2 — a showmance seed is outcome-adjacent dynamics, not identity).
    // No genesis ties (the floor / no-model path) ⇒ the floor layer stands verbatim, so the seeded sims
    // (which never wire a model) are BYTE-IDENTICAL to before this feature. A defensive id-filter guards
    // against a persisted tie referencing a since-evicted/unknown id.
    const knownIds = new Set(this.house.npcs.map((n) => n.id));
    const ties: PreGameTie[] = this.genesisTies
      ? this.genesisTies.filter((t) => knownIds.has(t.a) && knownIds.has(t.b))
      : floor.ties;
    // ORW-132: every tie is marked SECRET or PUBLIC here, at season start, from a DEDICATED seeded draw (never the loader's or the shared stream). A PUBLIC tie starts at exposure `public` (a settled house fact).
    const marked = markTieVisibility(ties, new SeededRandom(hashSeed(`${seed}:tie-visibility`)))
      .map((t) => (t.visibility === "public" ? { ...t, exposure: "public" as const } : t));
    this.seededRels = { ties: marked, showmances: floor.showmances };
    // Fold the small standing affinity bias between each seeded pair (both directions). NEVER a
    // deterministic advantage — just unconscious warmth a careful player reads only as behavior (§3).
    const bias = (a: EntityId, b: EntityId, amount: number): void => {
      this.rel.edge(a, b).affinity = clamp01(this.rel.edge(a, b).affinity + amount);
      this.rel.edge(b, a).affinity = clamp01(this.rel.edge(b, a).affinity + amount);
    };
    // ORW-132: friendly natures keep the original warm bias (byte-identical); an ex / rival starts COLD, each direction scaled by that houseguest's OWN temperament.
    const npcById = new Map(this.house.npcs.map((n) => [n.id, n] as const));
    for (const t of this.seededRels.ties) {
      for (const [from, to] of [[t.a, t.b], [t.b, t.a]] as const) {
        const hg = npcById.get(from);
        const amount = tieDirectedBias(t.nature, hg?.character.strategyStyle, hg?.soul.volatility ?? 0.3);
        this.rel.edge(from, to).affinity = clamp01(this.rel.edge(from, to).affinity + amount);
      }
    }
    for (const s of this.seededRels.showmances) bias(s.a, s.b, SHOWMANCE_SPARK_BIAS);
    if (this.seededRels.ties.length || this.seededRels.showmances.length) {
      this.onSealSeededRels?.(this.seededRels);
    }
    // ORW-132: a PUBLIC tie is a house fact from Day 1 - recorded as a witnessed event the WHOLE house (and the player) saw, so it lives in the normal knowledge layer. A secret tie stays sealed (above).
    if (this.onPlayerEvent) {
      const everyone: EntityId[] = [this.house.player.id, ...this.house.npcs.map((n) => n.id)];
      for (const t of this.seededRels.ties) {
        if (t.visibility !== "public") continue;
        this.onPlayerEvent(publicTieAnnouncement(this.nameOf(t.a), this.nameOf(t.b), tieNatureProse(t.nature)), everyone, "pre-show-tie");
      }
    }
  }

  /**
   * 0059 / L40 — advance the seeded showmances by the pair's CURRENT mutual affinity (the off-screen
   * tick calls this after its scenes move the edges). A showmance climbs spark → bond → visible only as
   * the two genuinely grow close over weeks (never instant); it RESOLVES when one of the pair leaves.
   * Returns the pairs that JUST became `visible` — the PUBLIC moment the house notices — so the caller
   * can record a witnessed beat the player can see. Pre-`visible` stages stay Vault-sealed (no surface).
   */
  advanceShowmances(): Array<{ a: EntityId; b: EntityId; aName: string; bName: string }> {
    if (!this.house) return [];
    const evicted = new Set(this.live?.evictionOrder ?? []);
    const nameOf = (id: EntityId): string => this.house!.npcs.find((n) => n.id === id)?.name ?? id;
    const surfaced: Array<{ a: EntityId; b: EntityId; aName: string; bName: string }> = [];
    for (const s of this.seededRels.showmances) {
      if (s.stage === "resolved") continue;
      if (evicted.has(s.a) || evicted.has(s.b)) { s.stage = "resolved"; continue; }
      const mutual = Math.min(this.rel.edge(s.a, s.b).affinity, this.rel.edge(s.b, s.a).affinity);
      const next = nextShowmanceStage(s.stage, mutual);
      if (next !== s.stage) {
        s.stage = next;
        if (next === "visible") {
          const sm = { a: s.a, b: s.b, aName: nameOf(s.a), bName: nameOf(s.b) };
          surfaced.push(sm);
          this.onShowmanceSurfaced?.(sm); // record the PUBLIC house beat (engine-only seam)
        }
      }
    }
    return surfaced;
  }

  /**
   * 0059 §5 — whether the organic pre-game-TIE surfacing scheduler runs. Default ON since the 2026-11 flip (`=0`/`ORWELL_FLAGS_OFF=1` turn it off) — like
   * the ADR-0006 in-game clock. When off (the default, and the state the seeded
   * juryReach / gradient / UAT sims run in) `advanceSeededTies` returns IMMEDIATELY: it draws nothing,
   * records nothing, and folds nothing, so the off-screen tick's draw count/order and every seeded
   * outcome are BYTE-IDENTICAL to the pre-feature build. The deploy turns it on for the texture; the
   * showmance arc (`advanceShowmances`) is unaffected by this flag (it ships in the 0059 core).
   */
  private static seededTieSurfacingOverride: boolean | null = null;

  /** Flip the 0059 §5 tie-surfacing scheduler at runtime (admin-only, via the composition delegate). `null` ⇒ env. */
  static setSeededTieSurfacingEnabled(enabled: boolean | null): void {
    GameSessionAdapter.seededTieSurfacingOverride = enabled;
  }

  /** The per-SANDBOX God-Mode override (the admin `setBehavioralFlags` dial). It wins over the process-
   *  global static, which stays only as the test / default seam — so an admin flip on one user's game can
   *  never change another user's (cross-user isolation, #1922). `null` ⇒ fall through. */
  private seededTieSurfacingSandboxOverride: boolean | null = null;

  private get seededTieSurfacingEnabled(): boolean {
    if (this.seededTieSurfacingSandboxOverride !== null) return this.seededTieSurfacingSandboxOverride;
    if (GameSessionAdapter.seededTieSurfacingOverride !== null) return GameSessionAdapter.seededTieSurfacingOverride;
    return flagDefaultOn("ORWELL_SEEDED_TIE_SURFACING");
  }

  /**
   * 0059 §5 — the per-tick pre-game-TIE surfacing scheduler (the DEFERRED follow-on; mirrors 0058's
   * dormant-thread scheduler + 0077's `whisperPairings`). As a sealed tie's live edge genuinely warms
   * over weeks, a careful observer eventually NOTICES the pair are unusually close and a Vault-free
   * belief diffuses NPC↔NPC (0038); a chain reaching the player lands a player belief (0002), capped per
   * season. A freshly discovered tie shifts the observer's third-party read via the 0023 fold (§5).
   *
   * STRICTLY OPT-IN + CALIBRATION-NEUTRAL: returns `[]` immediately unless the flag is on (so the seeded
   * sims never enter it). When on, every roll is on a DEDICATED rng (off the game seed + a private tick
   * counter — NEVER the shared society/vote stream the orchestrator passes), the NPC↔NPC diffusion takes
   * NO relationship fold, and only the discovery fold (flag-gated) moves an edge. Nothing crosses but the
   * observable read "they seem unusually close" — never the sealed `nature`, never a banner.
   */
  advanceSeededTies(knowledge: KnowledgeService): SurfacedTie[] {
    if (!this.seededTieSurfacingEnabled) return []; // off ⇒ fully inert (the legacy profile)
    if (!this.house || this.seededRels.ties.length === 0) return [];
    this.tieScheduleTickCount += 1;
    const evicted = new Set(this.live?.evictionOrder ?? []);
    const awake = this.awakeNow();
    const npcs = this.house.npcs
      .map((n) => n.id)
      .filter((id) => !evicted.has(id) && (!awake || awake.has(id)));
    if (npcs.length < 2) return [];
    // DEDICATED stream — keyed off the game seed + a PRIVATE tick counter (distinct from presenceTickCount
    // so the two dedicated streams never alias). Zero touch to the orchestrator's shared per-user rng.
    const rng = new SeededRandom(hashSeed(`seeded-tie-surfacing:${this.gameSeed ?? ""}:${this.tieScheduleTickCount}`));
    const surfaced = surfaceSeededTies({
      ties: this.seededRels.ties,
      npcs,
      player: this.house.player.id,
      affinity: (a, b) => this.rel.edge(a, b).affinity,
      nameOf: (id) => this.nameOf(id),
      knowledge,
      occupancy: this.presence ?? undefined,
      surfaceToPlayer: (subject, observation) => {
        const reached = this.onTieSurfaceToPlayer?.(subject, observation) ?? false;
        if (reached) { this.playerTieSurfaceCount += 1; this.surfacedTieSubjects.add(subject); }
        return reached;
      },
      // §5 consequence fold — the OBSERVER re-reads the pair as a hidden duo (a strategic realization):
      // their directed read of EACH of the pair moves by the 0023 `strategy` fold. Reuses foldHiddenImpact
      // (one fold implementation, zero drift); engine-only (moves a hidden edge — the player sees only the
      // observer's later behavior). Runs on a DEDICATED fold rng (never the shared stream).
      foldDiscovery: (observer, pair) => {
        const foldRng = new SeededRandom(hashSeed(`tie-discovery-fold:${this.gameSeed ?? ""}:${this.tieScheduleTickCount}:${observer}`));
        for (const member of pair) foldHiddenImpact(this.rel, foldRng, member, [observer], "strategy", [observer]);
      },
      alreadySurfacedToPlayer: (subject) => this.surfacedTieSubjects.has(subject),
      playerSurfaceCount: this.playerTieSurfaceCount,
      rng,
    });
    return surfaced;
  }

  /**
   * Feature 0095 — whether the pre-show-TIE REVEAL pathway runs. OPT-IN, default OFF, exactly like 0059
   * §5 above — but a DISTINCT flag/gate: turning on §5's ambient suspicion does NOT turn this on, and
   * vice versa (they are separate pathways with separate rng streams, never aliased).
   */
  private static tieRevealOverride: boolean | null = null;

  /** Flip the 0095 tie-reveal pathway at runtime (admin-only, via the composition delegate). `null` ⇒ env. */
  static setTieRevealEnabled(enabled: boolean | null): void {
    GameSessionAdapter.tieRevealOverride = enabled;
  }

  private get tieRevealEnabled(): boolean {
    if (GameSessionAdapter.tieRevealOverride !== null) return GameSessionAdapter.tieRevealOverride;
    const v = process.env.ORWELL_TIE_REVEAL;
    return v === "1" || v === "true" || v === "on";
  }

  /**
   * Feature 0095 — the per-tick pre-show-TIE REVEAL scheduler (the OVERHEAR pathway; `accuseTie` below
   * is the player-reachable lever). A sealed tie stays sealed until a real spark (the pair conspicuously
   * close) lets an observer catch the ACTUAL connection — not 0059 §5's vague "seem close" — which then
   * diffuses as a genuine, confidence-scaled betrayal-grade belief. Exposure promotes monotonically and
   * is capped per season (`TIE_REVEAL.maxExposuresPerSeason`, counting `accuseTie` hits too).
   *
   * STRICTLY OPT-IN + CALIBRATION-NEUTRAL: returns `[]` immediately unless `ORWELL_TIE_REVEAL` is on (so
   * the seeded sims never enter it). When on, every roll is on a DEDICATED rng (off the game seed + its
   * own private tick counter — never the shared society/vote stream, never §5's own stream).
   */
  advanceTieReveal(knowledge: KnowledgeService): TieRevealEvent[] {
    if (!this.tieRevealEnabled) return []; // off ⇒ fully inert (the legacy profile)
    if (!this.house || this.seededRels.ties.length === 0) return [];
    if (this.tieExposureCount >= TIE_REVEAL.maxExposuresPerSeason) return [];
    this.tieRevealTickCount += 1;
    const evicted = new Set(this.live?.evictionOrder ?? []);
    const awake = this.awakeNow();
    const npcs = this.house.npcs
      .map((n) => n.id)
      .filter((id) => !evicted.has(id) && (!awake || awake.has(id)));
    if (npcs.length < 2) return [];
    // DEDICATED stream — its OWN namespace + private tick counter, distinct from §5's `tieScheduleTickCount`
    // and from `presenceTickCount`, so none of the three dedicated streams ever alias.
    const rng = new SeededRandom(hashSeed(`tie-reveal:${this.gameSeed ?? ""}:${this.tieRevealTickCount}`));
    const events = overhearTieReveal({
      ties: this.seededRels.ties,
      npcs,
      player: this.house.player.id,
      affinity: (a, b) => this.rel.edge(a, b).affinity,
      nameOf: (id) => this.nameOf(id),
      natureProse: (t) => tieNatureProse(t.nature),
      knowledge,
      rel: this.rel,
      occupancy: this.presence ?? undefined,
      exposureCount: this.tieExposureCount,
      rng,
    });
    for (const ev of events) {
      const tie = this.seededRels.ties.find((t) => (t.a === ev.pair[0] && t.b === ev.pair[1]) || (t.a === ev.pair[1] && t.b === ev.pair[0]));
      if (!tie) continue;
      tie.exposure = ev.exposure;
      if (ev.firstExposure) this.tieExposureCount += 1;
    }
    if (events.length) this.persist();
    return events;
  }

  /** B50 - accusing a pre-show tie has consequences (Ryne's accuseTie ruling). OFF unless exactly `ORWELL_ACCUSE_COST=1`; never-flipped. OFF => accuseTie is exactly today's (a miss is free, a hit costs the accuser nothing). */
  private accuseCostEnabled = flagDefaultOn("ORWELL_ACCUSE_COST");
  setAccuseCostEnabled(on: boolean): void { this.accuseCostEnabled = on; }
  /** B50 - a MISS: each accused houseguest's read of the accuser takes a bounded dent (+ a tiny witness ripple) and remembers it (a conflict). Engine-decided, rng-free; the accuser is the player. */
  private accuseMissCost(aId: EntityId, bId: EntityId): void {
    if (!this.accuseCostEnabled || !this.house) return;
    const rng = new SeededRandom(hashSeed(`${this.gameSeed ?? 0}:accuse-miss:${aId}:${bId}:${this.week}:${this.phase}`));
    for (const member of [aId, bId]) {
      if (member === PLAYER) continue;
      this.rel.applyImpactDirected(member, PLAYER, ACCUSE.missImpact, rng);
      this.remember(member, PLAYER, "scene-conflict", 0.3);
    }
    const here = this.whereabouts();
    const inRoom = here ? new Set(here.present.map((p) => p.id)) : null;
    for (const w of this.awakeAmong(this.livingIds().filter((id) => id !== PLAYER && id !== aId && id !== bId && (!inRoom || inRoom.has(id))))) {
      this.rel.applyImpactDirected(w, PLAYER, ACCUSE.missRipple, rng);
    }
    this.persist();
  }
  /** B50 - an honest HIT: each exposed member either RESENTS it or RESPECTS the read, by the engine (a dedicated seeded roll weighted by their distrust of the accuser, their temperament and what the tie was). */
  private accuseHitReactions(aId: EntityId, bId: EntityId, nature: TieNature): void {
    if (!this.accuseCostEnabled || !this.house) return;
    for (const member of [aId, bId]) {
      if (member === PLAYER) continue;
      const stats = this.house.npcs.find((n) => n.id === member)?.character.stats;
      const prickly = stats ? Math.max(0, Math.min(1, 1 - stats.social)) : 0.5;
      const p = sourChance(this.rel.edge(member, PLAYER).trust, prickly, nature);
      const roll = new SeededRandom(hashSeed(`${this.gameSeed ?? 0}:accuse-react:${member}:${aId}:${bId}:${this.week}:${this.phase}`)).next();
      const rng = new SeededRandom(hashSeed(`${this.gameSeed ?? 0}:accuse-react-fold:${member}:${this.week}:${this.phase}`));
      if (hitReaction(roll, p) === "sour") {
        this.rel.applyImpactDirected(member, PLAYER, ACCUSE.hitSourImpact, rng);
        this.remember(member, PLAYER, "scene-conflict", 0.3);
      } else {
        this.rel.applyImpactDirected(member, PLAYER, ACCUSE.hitRespectImpact, rng);
        this.remember(member, PLAYER, "scene-kindness", 0.2);
      }
    }
  }

  /**
   * Feature 0095 — `accuseTie`, the single player-reachable authority for exposing a pre-show tie (the
   * `confide` sibling: the model previews/voices "you two knew each other, didn't you?", the ENGINE
   * decides + commits). Checks the SEALED 0059 layer: a real tie between the pair LANDS (jumps straight
   * to `public` — a landed accusation is a witnessed, public confrontation) and folds the betrayal-grade
   * fallout on the houseguests actually present; a pair with no tie MISSES (no Vault read beyond the
   * check itself, no edge touched — the scene itself is recorded by the FE's 0055 auto-record belt, not
   * here). Returns a Vault-safe `{ landed }` — no number, no tell on a miss.
   */
  accuseTie(aId: EntityId, bId: EntityId, expectedBeatSeq?: number): AccuseTieResult | null {
    this.guardBeatSeq(expectedBeatSeq);
    if (!this.house) return null;
    const tie = this.seededRels.ties.find((t) => (t.a === aId && t.b === bId) || (t.a === bId && t.b === aId));
    if (!tie) { this.accuseMissCost(aId, bId); return { landed: false }; } // no sealed tie exists ⇒ an ordinary wrong guess, no Vault read (B50: it dings the accuser when the layer is on)
    if (this.tieExposureCount >= TIE_REVEAL.maxExposuresPerSeason && tieExposureOf(tie) === "sealed") {
      this.accuseMissCost(aId, bId);
      return { landed: false }; // the season cap is spent — a real tie can still miss (rare, capped)
    }
    const wasSealed = tieExposureOf(tie) === "sealed";
    tie.exposure = nextTieExposure(tieExposureOf(tie), "accusation");
    if (wasSealed) this.tieExposureCount += 1;
    // A LANDED accusation always jumps straight to `public` — a witnessed, public confrontation, not
    // hearsay — so every OTHER living houseguest (not just the player) who was present re-reads the
    // pair, at near-full confidence (they saw it themselves). Bounded: the SAME per-listener magnitude
    // as any other betrayal fold, applied once per learner (never additively stacked, never a flat
    // house-wide FLAG — each learner's own directed edge moves by the same seeded amount).
    const rng = new SeededRandom(hashSeed(`${this.gameSeed ?? 0}:accuse-tie:${aId}:${bId}:${this.week}:${this.phase}`));
    const impact = scaleImpact(RELATIONSHIP_CONSTANTS.BETRAYAL_SHOCK, TIE_REVEAL.directWitnessConfidence);
    // Audit 2026-10-25 (band D F5): only houseguests who were actually THERE react — those in the
    // player's room (the whole house during a gathered event, via `whereabouts`) and awake. Fails OPEN to
    // every living houseguest when there is no presence read (a placeless/standalone session).
    const here = this.whereabouts();
    const inRoom = here ? new Set(here.present.map((p) => p.id)) : null;
    const learners = this.awakeAmong(
      this.livingIds().filter((id) => id !== aId && id !== bId && (id === PLAYER || !inRoom || inRoom.has(id))),
    );
    for (const learner of learners) {
      for (const member of [aId, bId] as const) this.rel.applyImpactDirected(learner, member, impact, rng);
    }
    this.accuseHitReactions(aId, bId, tie.nature);
    // B23: a landed (public, witnessed) accusation catches the pair out - each houseguest who saw it holds that each member kept it from them (the tie's exposure confidence). Misses/capped returned above.
    for (const learner of learners) for (const member of [aId, bId] as const) this.writeLieCaught(learner, member, TIE_REVEAL.directWitnessConfidence, "witnessed");
    // Record it as the PLAYER's own knowledge through the in-game pathway (0002) — the accusation
    // landing is the player's own confirmed read, not a Vault read (they made the accusation).
    this.onConfide?.(
      aId,
      `You called it: ${this.nameOf(aId)} and ${this.nameOf(bId)} ${tieNatureProse(tie.nature)}.`,
      TIE_REVEAL.directWitnessConfidence,
    );
    this.persist();
    return { landed: true };
  }

  /**
   * Feature 0094 — whether the belief-vs-reality DIVERGENCE runs. Default OFF (`ORWELL_GOSSIP_CONSEQUENCE`).
   * Off is NOT "the lever is unavailable" — `confront` still validates the cited `factId` against what
   * the player legitimately holds (the Vault bright line always applies) and always resolves `landed:
   * true` with no fold, so a distorted belief simply cannot misfire. On, `isMateriallyDistorted`
   * classifies + the misfire fold can fire. Since `confront` is reachable ONLY via the player MCP
   * channel (never the seeded off-screen tick/vote/competition spine, exactly like `confide`), this flag
   * is a rollout/product lever, not a load-bearing calibration guard — but it keeps the family's "opt-in,
   * off ⇒ no divergence, no fold" discipline uniform across 0094/0095/0096.
   */
  private static gossipConsequenceOverride: boolean | null = null;

  static setGossipConsequenceEnabled(enabled: boolean | null): void {
    GameSessionAdapter.gossipConsequenceOverride = enabled;
  }

  private get gossipConsequenceEnabled(): boolean {
    if (GameSessionAdapter.gossipConsequenceOverride !== null) return GameSessionAdapter.gossipConsequenceOverride;
    const v = process.env.ORWELL_GOSSIP_CONSEQUENCE;
    return v === "1" || v === "true" || v === "on";
  }

  /**
   * Feature 0094 — `confront`, the single closed-set authority a player confrontation resolves through
   * (the `confide`/`accuseTie` sibling). Validates the cited `factId` against what the player
   * LEGITIMATELY holds (`playerKnowledgeReader` — the same Vault bright line 0093/0099 already enforce;
   * an unrecognized fact ⇒ `null`, never minted) REGARDLESS of the flag, then — only when
   * `gossipConsequenceEnabled` — classifies it via `isMateriallyDistorted` (reading ONLY the belief's own
   * already-existing `distortion`/`confidence` — no new belief model, no Vault read of "reality") and
   * resolves the outcome: a FAITHFUL belief lands with no divergence; a MATERIALLY DISTORTED one
   * misfires — the confronted houseguest's own read of the player takes the SAME betrayal-grade blow a
   * real betrayal folds (0026 `IMPACT.betrayal`), seeded per (npc, week, phase). Off ⇒ always `landed:
   * true`, no fold. The engine never states why a misfire happened; no confidence/distortion value ever crosses.
   */
  confront(npcId: EntityId, factId: string, expectedBeatSeq?: number): ConfrontResult | null {
    this.guardBeatSeq(expectedBeatSeq);
    if (!this.house || !this.live) return null;
    const evicted = new Set(this.live.evictionOrder);
    if (evicted.has(npcId) || !this.house.npcs.some((n) => n.id === npcId)) return null;
    // BDD audit D2: a Diary Room note is never confrontable — confronting with it would put booth content in front of
    // a houseguest (a DR→NPC pathway the wall forbids).
    const belief = (this.playerKnowledgeReader?.() ?? []).find((f) => f.pathway !== "diary-room" && ((f.factId ?? f.id) === factId || f.id === factId));
    if (!belief) return null; // the Vault bright line — a non-learned belief is never minted
    const landed = !this.gossipConsequenceEnabled || !isMateriallyDistorted(belief);
    if (!landed) {
      // The move misfires against REALITY, not the belief: the wrongly-confronted houseguest's own
      // read of the player takes the same betrayal-grade blow a real betrayal folds — seeded,
      // deterministic, and NEVER narrated as "because the belief was wrong."
      const rng = new SeededRandom(hashSeed(`${this.gameSeed ?? 0}:confront:${npcId}:${this.week}:${this.phase}`));
      this.rel.applyDirected(npcId, PLAYER, "betrayal", rng);
      this.persist();
    }
    return { landed };
  }

  /**
   * 0059 / L40 — the Vault-free projection of the PUBLIC showmances (stage `visible`): once a showmance
   * is visible the whole house knows it, so naming the pair is a public fact, not a Vault leak. This is
   * what lets the narrator voice romance for THESE pairs ONLY (the L40 restraint). Pre-visible (sealed)
   * showmances and the pre-game ties never appear here.
   */
  visibleShowmances(): Array<{ a: string; b: string }> {
    if (!this.house) return [];
    const nameOf = (id: EntityId): string => this.house!.npcs.find((n) => n.id === id)?.name ?? id;
    return this.seededRels.showmances
      .filter((s) => s.stage === "visible")
      .map((s) => ({ a: nameOf(s.a), b: nameOf(s.b) }));
  }

  /**
   * Activate ONE dormant story thread and FOLD its hidden weight (0058 §5) — reusing the 0023
   * consequence fold (`foldHiddenImpact`), NOT a parallel subsystem. The thread's source houseguest
   * acts toward the player (the witness/partner), moving the hidden relationship layer by the thread's
   * `weightImpact` interaction. Returns the activated thread (or undefined when none is dormant for
   * that source). The player sees only the later BEHAVIOR; no number, no premise ever crosses (§8).
   * This is the directly-callable activation+fold hook; the full automatic trigger/resolution scheduler
   * is LIVE in `scheduleStoryThreads` (feature 0060), wired into the off-screen tick — both share the
   * one `foldThreadActivation` step, zero drift.
   */
  activateThread(sourceId: EntityId, rng: RandomnessSource = new SeededRandom(hashSeed(`${this.gameSeed}:thread:${sourceId}`))): StoryThread | undefined {
    const thread = this.storyThreads.find((t) => t.sourceId === sourceId && t.status === "dormant");
    if (!thread) return undefined;
    this.foldThreadActivation(thread, rng);
    this.persist();
    return thread;
  }

  /** The shared activation step (0058 §5 / 0060 §4.1): flip dormant→active + fold the 0023 hidden weight.
   *  `activateThread` (the directly-callable hook) and the 0060 scheduler both go through here — one fold
   *  implementation, zero drift. NEVER persists itself (the scheduler batches one persist per tick). */
  private foldThreadActivation(thread: StoryThread, rng: RandomnessSource): void {
    thread.status = "active";
    thread.lifecycleWeek = this.week;
    // The source acts toward the player by the thread's nature — the hidden delta folds into the
    // relationship layer (engine-only). `toward: [PLAYER]` makes the player's read of the source move.
    foldHiddenImpact(this.rel, rng, thread.sourceId, [thread.sourceId, PLAYER], thread.weightImpact, [PLAYER]);
  }

  /**
   * 0092 — whether the SECRET-PACING DRIP runs. Default ON since the 2026-11 flip (`=0`/`ORWELL_FLAGS_OFF=1` turn it off) — exactly like the ADR-0006 clock,
   * the campaign layer, the trajectory layer, and the 0059 §5 tie-surfacing scheduler. When off (the
   * default, and the state the seeded juryReach / gradient / UAT sims run in) `pacingDrip` returns
   * IMMEDIATELY: it draws nothing and routes nothing, so 0060's own flat surface path is the only one
   * that runs and every seeded outcome is BYTE-IDENTICAL to the pre-feature build. The deploy may turn
   * it on once the cadence is tuned. A test overrides per-session via `setSecretPacingEnabled`.
   */
  private static secretPacingOverride: boolean | null = null;

  /** The per-session override seam for the 0092 drip (a test flips it; reserved for a future admin toggle,
   *  like its `setCampaignsEnabled`/`setTrajectoriesEnabled` siblings — not yet wired to an admin tool).
   *  `null` ⇒ fall back to the `ORWELL_SECRET_PACING` env default. */
  static setSecretPacingEnabled(enabled: boolean | null): void {
    GameSessionAdapter.secretPacingOverride = enabled;
  }

  /** The per-SANDBOX God-Mode override (the admin `setBehavioralFlags` dial). It wins over the process-
   *  global static, which stays only as the test / default seam — so an admin flip on one user's game can
   *  never change another user's (cross-user isolation, #1922). `null` ⇒ fall through. */
  private secretPacingSandboxOverride: boolean | null = null;

  private get secretPacingEnabled(): boolean {
    if (this.secretPacingSandboxOverride !== null) return this.secretPacingSandboxOverride;
    if (GameSessionAdapter.secretPacingOverride !== null) return GameSessionAdapter.secretPacingOverride;
    return SECRET_PACING_ENABLED_DEFAULT;
  }

  /**
   * 0092 — how much the player has ALREADY caught wind of one thread's secret ∈ [0,1] (the already-told
   * penalty input; engine-only, never shown). Reads ONLY existing sealed state:
   *   • THIS thread's own state — whether it has already SURFACED (0060) or this pacing layer dripped it
   *     before. Either ⇒ the full 1.0 (the player already caught THIS secret; the drip moves on).
   *   • The SOURCE-level 0075 confidence — a source authors several DISTINCT threads, so a confidence on
   *     ANY one only DAMPENS their others (a fraction of the tier), never fully floors them. A LIE
   *     (`truthful: false`) contributes NOTHING — the player was deceived, so the real secret's payoff
   *     stays fully available (the "I knew it" lands hardest when you were lied to).
   * The MAX of the two — once a secret has reached the player by a real route, the drip moves ON
   * (anti-spam + non-degradation), but a single unrelated disclosure never permanently buries a source's
   * other secrets.
   */
  private threadAlreadyTold(thread: StoryThread): number {
    const tierFraction: Record<DisclosureTier, number> = { none: 0, tease: 0.4, partial: 0.7, full: 1 };
    const confided = this.confideState[thread.sourceId];
    // Only a TRUTHFUL confidence dampens; a lie leaves the real secret fully ripe. Source-level ⇒ a
    // fraction (it's a related, not the same, disclosure); the thread's OWN state below carries the full weight.
    const confidedTold = confided && confided.truthful
      ? tierFraction[confided.tier] * SECRET_PACING.confidedSourceFraction
      : 0;
    const ownTold = (thread.status === "surfaced" || thread.id in this.pacingLastDrippedWeek) ? 1 : 0;
    return Math.max(confidedTold, ownTold);
  }

  /**
   * 0092 — can the chosen 0060 pathway ACTUALLY deliver this drip (audit deliverability guard)? Mirrors
   * the conditions inside `surfaceThread`'s two branches: the `player` (confidant slip) channel needs the
   * to-player seam wired; the `gossip` channel needs a living NPC OTHER than the source to whisper it AND
   * the gossip seam wired. A drip only commits (spending the scarce weekly/season budget + setting the
   * anti-spam state) when its channel can deliver — never burn a season slot on a silent no-op (e.g. a
   * tension-ripe secret at Final-2 with no third party to carry it). The secret stays ripe for later.
   */
  private canDeliverDrip(sourceId: EntityId, channel: "player" | "gossip", pos: SeasonPosition): boolean {
    if (channel === "player") return this.onThreadSurfaceToPlayer !== undefined;
    const livingNpcs = (this.house?.npcs ?? [])
      .map((n) => n.id)
      .filter((id) => id !== sourceId && !pos.evicted.has(id));
    return livingNpcs.length > 0 && this.onThreadGossip !== undefined;
  }

  /**
   * Feature 0092 — the SECRET-PACING DRIP. Runs ONCE per bounded off-screen tick, BEFORE 0060's own
   * surface-to-player decision (`scheduleStoryThreads`), and PACES which sealed secret edges toward THIS
   * player and how fast. It is a thin scheduling/eligibility layer over 0060 — it adds NO new pathway:
   * a chosen drip crosses through 0060's EXISTING anchored organs (`surfaceThread` → the confidant slip
   * / `surfaceInformationTo` / the 0038 gossip chain), as the same Vault-safe belief 0060 already
   * produces. The engine owns the schedule (which secret is ripe, whether the weekly budget allows it,
   * whether the seeded eligibility roll passes); the model never selects or invents a secret (mandate #3).
   *
   * CALIBRATION (the load-bearing guarantee): returns `[]` immediately unless the flag is on, so the
   * seeded sims never enter it. When on, EVERY roll is on a DEDICATED rng (off the game seed + a private
   * tick counter — NEVER the shared society/competition/vote stream the orchestrator passes to
   * `scheduleStoryThreads`), and the only thing it changes is WHICH already-Wall-safe surface 0060 picks
   * and WHETHER the weekly budget allows it. The seeded comp/vote/jury spine is untouched.
   *
   * THE PACE: a per-WEEK budget (the heart of the feature), not a per-tick probability — a hard weekly
   * ceiling (`maxDripsPerWeek`) layered UNDER 0060's `maxSurfacedPerSeason` season cap. The weekly budget
   * can never push the season total past 0060's ceiling; it only SHAPES those scarce reveals into a
   * paced, relationship-weighted cadence (about one a week, about people the player is circling).
   */
  pacingDrip(): RankedThread[] {
    if (!this.secretPacingEnabled) return []; // off ⇒ fully inert (the legacy profile)
    if (!this.house || this.storyThreads.length === 0) return [];

    // Roll the per-WEEK counter over FIRST (a new live week resets the spent count to 0 — the cadence is
    // per-week), so the persisted bookkeeping never trails the live week. Then read the (now-synced) budget.
    if (this.pacingDripWeek !== this.week) { this.pacingDripWeek = this.week; this.pacingDripCount = 0; }
    const budget = dripBudget({ week: this.pacingDripWeek, spentThisWeek: this.pacingDripCount, currentWeek: this.week });
    // Two layered ceilings: the per-week budget (the pace) AND 0060's hard SEASON cap (the true ceiling on
    // total payoff). Either spent ⇒ no player-bound drip this tick (surplus ripe threads still play out
    // off-screen NPC↔NPC via 0060's own flat path — only the player-bound channel is paced here).
    if (!budget.allowed || this.surfacedThreadCount >= THREAD.maxSurfacedPerSeason) return [];

    const pos = this.seasonPosition();
    // The drip rides the SAME freshly-moved house 0060 reads; only ACTIVE threads whose source is still in
    // the house are eligible to edge toward the player (a dormant secret hasn't broken loose; an evicted
    // source's secret isn't slipping). Build each candidate's already-read, Vault-hidden ripeness inputs.
    const candidates: PlayerBoundThread[] = [];
    for (const thread of this.storyThreads) {
      if (thread.status !== "active") continue;
      if (sourceWindowClosed(thread, pos)) continue;
      // proximity + tension from the BOTH-WAY player↔source edges (the engine's own directed reads).
      const reads = relationshipReads(
        this.rel.edge(PLAYER, thread.sourceId),
        this.rel.edge(thread.sourceId, PLAYER),
      );
      candidates.push({
        id: thread.id,
        sourceId: thread.sourceId,
        proximity: reads.proximity,
        tension: reads.tension,
        recency: recencyFromAge(this.week - (thread.lifecycleWeek ?? this.week)),
        alreadyTold: this.threadAlreadyTold(thread),
      });
    }
    if (candidates.length === 0) return [];

    // Seed-stable ranking (pure; no rng) — most-ripe first, the relevance floor drops secrets about people
    // the player has no proximity AND no tension with (they keep churning off-screen, never edge over).
    const ranked = rankPlayerBoundThreads(candidates);
    if (ranked.length === 0) return [];
    const top = ranked[0]!;
    const channel: "player" | "gossip" = top.channel === "confidant" ? "player" : "gossip";
    // DELIVERABILITY guard (audit): a drip must only commit when its chosen 0060 pathway can ACTUALLY
    // deliver — the confidant slip needs the to-player seam wired; the gossip chain needs a living NPC
    // origin to whisper it. If the chosen channel can't deliver, the secret stays ripe (no budget/cap
    // burned on a reveal that reaches no one) — never spend a scarce season slot on a silent no-op.
    if (!this.canDeliverDrip(top.sourceId, channel, pos)) return [];

    // The DEDICATED stream — keyed off the game seed + the PRIVATE tick counter (distinct slug from every
    // other dedicated stream so they never alias). Bump the tick counter HERE, adjacent to the only rng it
    // keys (so the eligibility-roll stream is `one key per deliverable candidate`, gap-free + restart-
    // stable). Zero touch to the orchestrator's shared per-user rng (the calibration spine).
    this.pacingTickCount += 1;
    const rng = new SeededRandom(hashSeed(`secret-pacing:${this.gameSeed ?? ""}:${this.pacingTickCount}`));
    // A single bounded, seeded eligibility roll on the TOP candidate (a quiet tick — and a quiet week — is
    // intentional; the season cap is the true ceiling). On a miss nothing crosses; the secret stays ripe.
    if (rng.next() >= SECRET_PACING.dripEligibilityRate) return [];

    const thread = this.storyThreads.find((t) => t.id === top.id);
    if (!thread) return [];
    // Route the ripe secret into 0060's EXISTING surface-to-player path — proximity-ripe prefers the
    // confidant slip (a close source TELLS the player), tension-ripe prefers the gossip chain (a third
    // party brings it). Either way it is the unchanged anchored organ; the drip only CHOSE and PACED it.
    // It counts against 0060's season cap inside surfaceThread (surfacedThreadCount++), so the pace can
    // never add payoff past the season ceiling.
    this.surfaceThread(thread, pos, rng, channel);
    // Charge the weekly budget + record the per-thread last-dripped week (the anti-spam state). Persistence
    // is the orchestrator's batched commit (this rides its bounded tick) — no `persist()` here (R3).
    this.pacingDripCount += 1;
    this.pacingLastDrippedWeek[thread.id] = this.week;
    return [top];
  }

  /**
   * Feature 0060 — the per-tick story-thread SCHEDULER. Rides the EXISTING bounded off-screen tick
   * (`orchestrator.defaultApply`), runs AFTER the tick's society/gossip/confessional steps so it reads
   * the freshly-moved house, and walks each thread's lifecycle once:
   *
   *   dormant  & triggerCondition met & roll < activateProb    → activate (reuse the 0023 fold, §4.1)
   *   active   & roll < surfaceProb & under the season cap      → surface (reuse 0038 gossip / 0002, §4.2)
   *   surfaced / active beyond resolveAfterWeeks                → resolve (one final 0023 fold, §4.3)
   *   source evicted / expireAfterWeeks elapsed dormant         → expire  (record, never delete, §4.4)
   *
   * It AUTHORS nothing and adds NO parallel subsystem — it only decides WHICH transition fires. Every
   * roll is a seeded SIDE rng (`seed:thread-scheduler:…`), so it never perturbs the main house stream
   * (0007 byte-stability) and the same seed + trigger sequence ⇒ the same thread drama (§4.5). Restraint
   * is structural: a hard season SURFACING cap (§5), at most one activation + one surface per tick, and
   * NPC↔NPC surfacing far more common than to-the-player. The Vault Wall holds (§7): nothing crosses but
   * a class-keyed paraphrase belief — never the premise, never a number.
   */
  scheduleStoryThreads(rng: RandomnessSource): void {
    if (!this.house || this.storyThreads.length === 0) return;
    this.recordNominationWeeks();
    const pos = this.seasonPosition();

    // Back-compat (§3): a thread restored from a pre-0060 save has no structured condition / lifecycle
    // week — default them in place (idempotent), so the predicate has a gate and the windows have a base.
    for (const t of this.storyThreads) {
      if (t.triggerCondition === undefined) t.triggerCondition = defaultTriggerConditionFor(t);
      if (t.lifecycleWeek === undefined) t.lifecycleWeek = this.week;
    }

    let activations = 0;
    let surfaces = 0;
    // 0101/#1401 — the AI SHOWRUNNER's two effects on this loop, split by sub-flag:
    //
    //  • PHASE-1 (`ORWELL_SHOWRUNNER`, fold-free): the note NEVER re-orders this loop and NEVER changes a
    //    surface/activate roll. Its ONLY Phase-1 effect is on the OPEN-SET, FOLD-FREE knowledge layer —
    //    routing a surfaced emphasized thread's belief ALSO to the player (inside `surfaceThread`), which
    //    moves no relationship edge and no outcome. Provably byte-identical (`showrunnerOutcomeNeutral`).
    //
    //  • PHASE-2 (`ORWELL_SHOWRUNNER_REWEIGHT`, #1455 — OUTCOME-AFFECTING, default OFF): the note RE-ORDERS
    //    which thread the loop visits FIRST (`reweightedThreadOrder`), so an emphasized RIPE thread wins a
    //    SCARCE per-tick slot (activation / surface — both capped at 1) or the season surfacing cap ahead of
    //    a lower-priority thread that merely sits earlier in the derive order. Because the FOLD-PRODUCING
    //    transitions (dormant→active, active→resolved, active→surfaced — all move the hidden relationship
    //    layer that feeds the competition/vote spine) are slot-scarce, changing WHICH ripe thread wins the
    //    slot changes which folds land this tick and thus perturbs the seeded stream. That is the sanctioned
    //    reweight (ADR 0005: re-weight which OPEN-SET storyline surfaces) — it NEVER bypasses a cap, changes
    //    a roll, relaxes an eligibility test (`triggerMet`/`sourceWindowClosed`), scales a fold magnitude, or
    //    touches any CLOSED-SET decision (nomination/vote/eviction/competition). It is gated by the
    //    calibration heavy-sims run ON, not by an on/off identity. OFF ⇒ `order` IS `this.storyThreads`.
    //
    // Either way the per-thread side rng keys off the game seed + thread id + the live (week, phase), so
    // each thread's roll is deterministic and INVARIANT to iteration order (re-ordering never re-rolls a
    // thread), advances as the game POSITION advances (§4.5), and never perturbs the main house stream
    // (0007). Within one (week, phase) repeated ticks reuse the same roll — a thread fires at most once
    // per beat, and the reweight order is stable within a beat (the note is fixed per beat).
    const { order, reordered } = this.reweightedThreadOrder();
    if (reordered) this.showrunnerReweightCount += 1; // monotonic — this tick genuinely re-prioritized a slot
    for (const thread of order) {
      const side = new SeededRandom(hashSeed(`${this.gameSeed ?? ""}:thread-scheduler:${thread.id}:${this.week}:${this.phase}`));
      if (thread.status === "dormant") {
        // §4.4 — a dormant thread whose window has closed (source evicted, or expireAfterWeeks elapsed
        // since seed without ever triggering) EXPIRES: recorded, never deleted (non-degradation, §7).
        if (sourceWindowClosed(thread, pos)
          || this.week - (thread.lifecycleWeek ?? 0) >= THREAD.expireAfterWeeks) {
          thread.status = "expired";
          thread.lifecycleWeek = this.week;
          continue;
        }
        // §4.1 — ripe + a bounded roll + under the per-tick activation cap ⇒ activate (reuse 0023).
        if (activations < THREAD.maxActivationsPerTick
          && triggerMet(thread, pos)
          && side.next() < THREAD.activateProb) {
          this.foldThreadActivation(thread, side);
          activations++;
        }
        continue;
      }
      if (thread.status === "active") {
        // §4.3 — an active thread that has burned down (active longer than resolveAfterWeeks without
        // surfacing) RESOLVES off-screen with one final bounded 0023 fold; OR the source has left.
        if (sourceWindowClosed(thread, pos)
          || this.week - (thread.lifecycleWeek ?? 0) >= THREAD.resolveAfterWeeks) {
          this.foldThreadResolution(thread, side);
          continue;
        }
        // §4.2 / §5 — surface this tick (bounded roll, the season cap not yet spent, under the per-tick
        // surface cap). Surfacing is belief-level: NPC↔NPC gossip the common path, to-the-player rarer.
        // The WHICH-thread + WHETHER-to-surface decision is byte-identical to the pre-showrunner scheduler
        // (the roll is exactly `THREAD.surfaceProb`); the showrunner only re-weights the FOLD-FREE routing
        // INSIDE `surfaceThread` (whether an emphasized surfaced thread reaches the PLAYER).
        if (surfaces < THREAD.maxSurfacesPerTick
          && this.surfacedThreadCount < THREAD.maxSurfacedPerSeason
          && side.next() < THREAD.surfaceProb) {
          this.surfaceThread(thread, pos, side);
          surfaces++;
        }
        continue;
      }
    }
    // No `persist()` here: the scheduler runs INSIDE the orchestrator's bounded off-screen tick, whose
    // own commit exports + persists the candidate snapshot (which includes the mutated `storyThreads`).
    // Persisting again would force a redundant O(events) re-serialization on the hot tick (R3/spineHardening).
  }

  /** §4.3 — resolve an active/surfaced thread: one FINAL bounded 0023 fold (the closing beat), then inert. */
  private foldThreadResolution(thread: StoryThread, rng: RandomnessSource): void {
    foldHiddenImpact(this.rel, rng, thread.sourceId, [thread.sourceId, PLAYER], thread.weightImpact, [PLAYER]);
    thread.status = "resolved";
    thread.lifecycleWeek = this.week;
  }

  /**
   * §4.2 — surface an active thread through an in-game pathway ONLY (never exposition). NPC↔NPC is the
   * common case (a vague class-keyed paraphrase handed to the 0038 gossip engine); surfacing TO the
   * player is rarer (gated behind `surfaceToPlayerProb` AND a real modeled pathway via the registry's
   * `surfaceInformationTo`, E9). Either way it counts ONCE against the hard season cap (§5). What
   * crosses is a belief with source + confidence — never the premise, never a number (§7).
   *
   * FIDELITY by pathway (2026-06-20): when the source is a genuine CONFIDANT of the player — the
   * player→source bond (the engine's own trust+affinity read) sits at/above `THREAD.confidantBondThreshold`
   * — the player hears a FULLER, less-glossed version (`confidantThreadRumor`), the way a close ally
   * actually confides. A stranger's gossip stays the ordinary vague `threadRumor`. The fuller variant is
   * STILL Vault-safe: keyed only by the public source CLASS (the same `weakness`/`true goal`/secret
   * prefix the class gloss already uses), never the verbatim premise/trigger, never a number (§7).
   *
   * `force` (0092): the secret-pacing drip selects a ripe thread and forces its CHANNEL — `player` routes
   * straight to the existing to-player path (a confidant slip / anchored `surfaceInformationTo`), `gossip`
   * routes straight to the existing NPC↔NPC diffusion (a chain that may reach the player). It changes ONLY
   * which already-Wall-safe surface is chosen — NEVER the content (the same `threadRumor`/confidant
   * paraphrase) and never a number. Absent (the default + the flag-off path) ⇒ the seeded
   * `surfaceToPlayerProb` roll decides exactly as before, so 0060 is byte-identical when pacing is off.
   */
  private surfaceThread(
    thread: StoryThread, pos: SeasonPosition, rng: RandomnessSource, force?: "player" | "gossip",
  ): void {
    const name = this.nameOf(thread.sourceId);
    const rumor = threadRumor(thread, name);
    // Choose an NPC ORIGIN for the rumor: a living NPC other than the source (someone who'd whisper it).
    // #1913 — only someone AWAKE can whisper it (ADR 0006). Clock off ⇒ `awakeNow()` is null ⇒ every
    // living NPC, byte-identical.
    const awake = this.awakeNow();
    const livingNpcs = (this.house?.npcs ?? [])
      .map((n) => n.id)
      .filter((id) => id !== thread.sourceId && !pos.evicted.has(id) && (!awake || awake.has(id)));
    // The to-player decision: 0092 may FORCE the channel (the drip chose it), else the unchanged seeded
    // `surfaceToPlayerProb` roll. A forced `player` still requires the seam to be wired (the registry sets
    // it); a forced `gossip` skips the to-player branch entirely. Default ⇒ byte-identical to before.
    const toPlayer = force === "player"
      ? this.onThreadSurfaceToPlayer !== undefined
      : force === "gossip"
        ? false
        : rng.next() < THREAD.surfaceToPlayerProb && this.onThreadSurfaceToPlayer !== undefined;
    if (toPlayer && this.onThreadSurfaceToPlayer) {
      // Rare: a modeled pathway already reaches the player — surface a content-lineage-anchored belief
      // (E9). An unanchored attempt is correctly downgraded to a suspicion by 0002; either way the
      // thread is spent (it "surfaced" — the house's drama broke into the open). Fuller fidelity ONLY
      // when this is a close-relationship/confidant pathway (a confidant confides; a stranger glosses).
      const belief = this.isPlayerConfidant(thread.sourceId)
        ? this.confidantThreadRumor(thread, name)
        : rumor;
      const told = this.onThreadSurfaceToPlayer(thread.sourceId, belief);
      // #1913 — nobody awake to relay it tonight: the story is not spent (clock off ⇒ unchanged).
      if (!told && awake) return;
    } else if (livingNpcs.length > 0 && this.onThreadGossip) {
      // The common case: hand the paraphrase to the 0038 gossip engine to diffuse NPC↔NPC.
      const origin = livingNpcs[rng.int(livingNpcs.length)]!;
      this.onThreadGossip(origin, rumor, thread.sourceId);
      // 0101/#1401 — the SHOWRUNNER's ONE consumption effect: it makes sure the PLAYER catches the
      // storylines the producers are leaning on. An EMPHASIZED thread that surfaced NPC-only ALSO reaches
      // the player — an ADDITIVE, Vault-safe belief through the SAME anchored `surfaceInformationTo` seam,
      // ON TOP of the byte-identical NPC gossip above. This is the pure OPEN-SET effect (which surfaced
      // storyline the player hears): it seeds a player BELIEF only — it moves NO relationship edge, folds
      // NOTHING, consumes NO rng, and leaves the NPC gossip / the WHICH-thread-surfaces decision / every
      // activation+resolution FOLD byte-identical. So the closed set (competition / eligibility / vote) is
      // byte-identical whether the showrunner is on or off (proven end-to-end by showrunnerOutcomeNeutral),
      // while the player genuinely catches the season's emphasized arcs. Absent note / off ⇒ no-op.
      if (this.showrunnerEmphasizes(thread.id) && this.onThreadSurfaceToPlayer) {
        const belief = this.isPlayerConfidant(thread.sourceId)
          ? this.confidantThreadRumor(thread, name)
          : rumor;
        this.onThreadSurfaceToPlayer(thread.sourceId, belief);
      }
    } else if (this.onThreadGossip && awake) {
      // Nobody is awake to whisper it tonight: the story is NOT spent — it stays eligible (and off the season
      // cap) for a later surface (cubic #1914).
      return;
    }
    thread.status = "surfaced";
    thread.lifecycleWeek = this.week;
    this.surfacedThreadCount++;
  }

  /** 0101/#1401 — does the CURRENT showrunner note emphasize this thread (above the baseline multiplier)?
   *  Used ONLY to route an emphasized surfaced thread's belief additionally TO THE PLAYER (open-set
   *  knowledge; no fold, no rng, no outcome). False when the layer is off / no note / not on the shortlist. */
  private showrunnerEmphasizes(threadId: string): boolean {
    return emphasisForThread(this.currentShowrunnerNote(), threadId) > SHOWRUNNER.minEmphasis;
  }

  /**
   * 0101/#1401 Phase-2 (#1455) — the Phase-2 REWEIGHT ORDER for `scheduleStoryThreads`. When the reweight
   * sub-flag is ON and the current note emphasizes ≥1 thread, return a re-prioritized VIEW of
   * `this.storyThreads` (the pure `reweightThreadOrder` permutation: the note's top-`reweightSlots` emphases
   * moved to the front in note order, everything else in the unchanged derive order) plus whether it
   * actually differs from the derive order. Reweight OFF / no note / no emphasis / no change ⇒ returns
   * `this.storyThreads` itself (identity), so the loop is byte-identical to today. NEVER mutates
   * `this.storyThreads` (the persisted derive order + the OFF-path byte-identity depend on it) — the view
   * is a fresh array of the SAME thread references (the loop's status mutations still land on the real
   * objects). This ONLY changes visitation order; it can touch no cap, roll, eligibility, or magnitude. */
  private reweightedThreadOrder(): { order: readonly StoryThread[]; reordered: boolean } {
    if (!this.showrunnerReweightEnabled) return { order: this.storyThreads, reordered: false };
    const perm = reweightThreadOrder(this.storyThreads.map((t) => t.id), this.currentShowrunnerNote(), SHOWRUNNER.reweightSlots);
    const reordered = perm.some((idx, i) => idx !== i);
    if (!reordered) return { order: this.storyThreads, reordered: false };
    return { order: perm.map((idx) => this.storyThreads[idx]!), reordered: true };
  }

  /**
   * Is the thread's source a genuine CONFIDANT of the player? (2026-06-20 — gates the higher-fidelity
   * surfacing.) Derived ONLY from the existing relationship model: the player's OWN read of the source
   * (`player→source`). When that bond — trust + affinity, the engine's directed read — sits at/above
   * `THREAD.confidantBondThreshold` (the `ally`-grade band), the source is someone the player is close
   * to, the kind of houseguest who CONFIDES rather than has their secret merely whispered about. This is
   * a pure engine read (no number crosses the wall — it only chooses WHICH Vault-safe paraphrase, never
   * exposes the value). A stranger (bond below the band) always gets the ordinary vague gloss.
   */
  private isPlayerConfidant(sourceId: EntityId): boolean {
    const e = this.rel.edge(PLAYER, sourceId);
    return e.trust + e.affinity >= THREAD.confidantBondThreshold;
  }

  /**
   * The FULLER (but still Vault-safe) paraphrase a CONFIDANT surfacing gives the player (2026-06-20):
   * a richer, less-glossed belief than `threadRumor`, reading like a close ally actually confiding —
   * "they told me, in confidence, that …". It is keyed ONLY by the public source CLASS (the same
   * `weakness`/`true goal`/secret prefix the existing class gloss reads — never the verbatim premise,
   * never the trigger, never a number, §7), so the no-leak sentinel sweep stays strict: the SECRET text
   * never crosses, only a fuller-textured BELIEF with a known source. The §7 leak gate verifies this.
   */
  private confidantThreadRumor(thread: StoryThread, name: string): string {
    // The public source CLASS only — the same rule the engine's class gloss uses (a prefix on the
    // premise label, NOT the secret body). No premise/trigger/number is read here.
    const fuller = thread.premise.startsWith("weakness")
      ? `there's a real soft spot in their game they keep covering for`
      : thread.premise.startsWith("true goal")
        ? `their plan in here runs deeper and quieter than they let the house believe`
        : `they're sitting on something heavy they've hidden from almost the whole house`;
    return `${name} confided in you — you came away believing ${fuller}`;
  }

  /** 0060 §3 (`nominated-twice`) — accrue the DISTINCT weeks each current nominee has been on the block. */
  private recordNominationWeeks(): void {
    for (const id of this.ceremony.nominees) {
      const weeks = (this.nominationWeeks[id] ??= []);
      if (!weeks.includes(this.week)) weeks.push(this.week);
    }
  }

  /**
   * Build the Vault-FREE season position the scheduler's predicates read (0060 §3). Every field is a
   * PUBLIC/engine-internal POSITION fact — never a thread premise. `cornered` is the bottom-quantile of
   * the living house by the engine's own bond read toward the player-side house (engine-internal, never
   * surfaced); `nominatedRepeatedly` reads the hidden nomination-week ledger above.
   */
  private seasonPosition(): SeasonPosition {
    const evicted = new Set(this.live?.evictionOrder ?? []);
    const livingNpcs = (this.house?.npcs ?? []).map((n) => n.id).filter((id) => !evicted.has(id));
    const livingCount = livingNpcs.length + (this.house && !evicted.has(this.house.player.id) ? 1 : 0);
    const powerHolders = new Set<EntityId>();
    if (this.ceremony.hoh) powerHolders.add(this.ceremony.hoh);
    if (this.ceremony.vetoHolder) powerHolders.add(this.ceremony.vetoHolder);
    // `cornered-socially`: a source's standing among the living house. Score each living NPC by how the
    // REST of the living house reads them (mean bondStrength of others' edges toward them); the bottom
    // quantile is "cornered". Pure engine read — never crosses the wall.
    const others = [...livingNpcs, ...(this.house ? [this.house.player.id] : [])];
    const standing = new Map<EntityId, number>();
    for (const id of livingNpcs) {
      let sum = 0; let n = 0;
      for (const o of others) {
        if (o === id) continue;
        const e = this.rel.edge(o, id);
        sum += e.trust + e.affinity - e.threat; n++;
      }
      standing.set(id, n > 0 ? sum / n : 0);
    }
    const ranked = [...standing.entries()].sort((a, b) => a[1] - b[1]).map(([id]) => id);
    const cut = Math.max(1, Math.floor(ranked.length * THREAD.corneredBottomQuantile));
    const cornered = new Set(ranked.slice(0, cut));
    const nominatedRepeatedly = new Set<EntityId>(
      Object.entries(this.nominationWeeks)
        .filter(([, weeks]) => weeks.length >= THREAD.nominatedWeeksForRivalry)
        .map(([id]) => id as EntityId),
    );
    return {
      week: this.week,
      livingCount,
      nominees: new Set(this.ceremony.nominees),
      powerHolders,
      cornered,
      nominatedRepeatedly,
      evicted,
    };
  }

  /**
   * Wire each houseguest's relationship DISPOSITION from their public archetype (B55/audit C5): a
   * villain holds grudges (clash, sticky), a loyalist forgives (bond). Derived from the persisted
   * static Character, so a restore re-derives it — no extra serialization needed.
   */
  private wireDispositions(): void {
    if (!this.house) return;
    for (const hg of [this.house.player, ...this.house.npcs]) {
      this.rel.setDisposition(hg.id, dispositionOf(hg.character.archetype));
    }
  }

  // --- Live weekly loop (0011) ---------------------------------------------------

  /**
   * Whether the in-game time-of-day clock + sleep economy (ADR 0006) is engaged. Default ON since the 2026-11 flip (`=0`/`ORWELL_FLAGS_OFF=1` turn it off; the FE re-pushes it):
   * when off, the clock never advances, `timeOfDay` stays undefined, `restOf` returns 0, and every
   * seeded outcome (the juryReach calibration spine, the UAT) is byte-identical to the pre-feature
   * model. The deploy turns it on. (This is the in-game clock; the runtime play-clock is separate.)
   */
  /**
   * ADR 0006 runtime override for the in-game clock. The FE settings switch flips this through the admin
   * `setTimeOfDay` tool (via the composition delegate) — no engine restart. `null` ⇒ fall back to the
   * `ORWELL_TIME_OF_DAY` env default, so the seeded golden sims (which set neither) stay OFF and
   * byte-identical. Process-global + in-memory: a restart resets it to `null` and the FE re-applies the
   * persisted setting on boot.
   */
  private static timeOfDayOverride: boolean | null = null;

  /** Flip the ADR 0006 clock at runtime (admin-only, wired through the composition delegate). `null` ⇒ env. */
  static setTimeOfDayEnabled(enabled: boolean | null): void {
    GameSessionAdapter.timeOfDayOverride = enabled;
  }

  /** The clock's LIVE state (runtime override, else the env default) — reported on `/health`. */
  static timeOfDayEffective(): boolean {
    // The diagnostic ORWELL_FLAGS_OFF=1 profile WINS over the front-end's persisted clock push (it re-sends ON on every boot).
    if (process.env.ORWELL_FLAGS_OFF === "1") return false;
    if (GameSessionAdapter.timeOfDayOverride !== null) return GameSessionAdapter.timeOfDayOverride;
    return flagDefaultOn("ORWELL_TIME_OF_DAY");
  }

  private get timeOfDayEnabled(): boolean {
    return GameSessionAdapter.timeOfDayEffective();
  }

  /**
   * 0117 (in-game-time pivot) — is in-game time genuinely FLOWING this turn? True only when the master
   * clock is on, the per-conversation clock is on, AND the day has started (the first ceremony beat
   * initialises `live.timeOfDay`). The orchestrator reads this to decide whether a social (aux) turn
   * advances the clock and lets the house live during social play. When false — the seeded calibration
   * spine (time-of-day off) and golden replay (per-conversation clock off) — social turns stay inert and
   * byte-identical. Vault-free: reads only the clock flags + the live day-phase.
   */
  perConversationClockLive(): boolean {
    return this.perConversationClockEnabled && this.timeOfDayEnabled && this.live?.timeOfDay !== undefined;
  }

  /**
   * 0117 — the current in-game clock-HOUR (8..32, the 24-hour model #1125), or undefined when the clock
   * isn't running. The orchestrator debounces the social-play society tick on ELAPSED in-game hours (so
   * the house schemes "with the clock", never once per tool call). Vault-free: reads only the day clock.
   */
  inGameHour(): number | undefined {
    if (!this.timeOfDayEnabled || this.live?.timeOfDay === undefined) return undefined;
    return this.live.nightDepth ?? WAKE_HOUR;
  }

  /**
   * 0118 — has the in-game clock reached the next scheduled ceremony milestone (⇒ the FE's time-aware
   * forced-advance nudge should fire it now, gathering the whole house — the telegraphed hard interrupt)?
   * Vault-free; false unless the per-conversation clock is live AND the clock has reached the milestone's
   * scheduled phase. Mirrors the `daySchedule.due` view flag. A pure read — never mutates, never draws rng.
   */
  milestoneDue(): boolean {
    return this.perConversationClockLive() && milestoneDueOf(this.live);
  }

  /** Build the Vault-free season context the pure loop reads (stats + live relationships + mood). */
  private ctx(): SeasonCtx {
    return {
      player: PLAYER,
      statsOf: (id) => this.statsOf(id),
      rel: this.rel,
      // The LIVE soul emotional state (0041) feeds the competition modifier + the rattled-HOH read.
      // 0124 (part A): with soul-depth on, the COMPOSED read (confidence lifts, distress drags harder)
      // stands in for the single scalar — so "confident AND rattled" competes worse. Off ⇒ the plain state.
      emotionalOf: (id) => this.emotionalReadOf(id),
      // The hidden REST deficit (ADR 0006): the player's from how late THEY stayed up last night, an
      // NPC's from the latest phase they were ACTUALLY awake last night (ENG-NEW-1 — the earlier of
      // their character bedtime and how far the night ran, not a static aptitude tax). Feeds the comp
      // fold only; never crosses the wall. DORMANT unless the clock is actually running (opt-in) ⇒
      // returns 0, so the seeded calibration spine (juryReach / UAT) is BYTE-IDENTICAL to the pre-feature model.
      restOf: (id) => {
        // Tonight's immediate (conflict-drained) deficit + the compounding multi-night fatigue meter.
        return this.restDeficitOf(id);
      },
      // Derived loyalty (0043): disposition (static CHARACTER) × current soul state — feeds the
      // emergent bloc term. Derived per read; never stored (decision 0002).
      loyaltyOf: (id) => {
        const hg = this.house
          ? (this.house.player.id === id ? this.house.player : this.house.npcs.find((n) => n.id === id))
          : undefined;
        if (!hg) return 0.55;
        return derivedLoyalty(this.dispositionReadOf(id), this.emotionalReadOf(id));
      },
      // 0107: the named-alliance cement into bloc detection — bounded, saturation-diluted; 0 for every
      // pair when no alliance is named ⇒ the seeded bloc/vote read is byte-identical (the calibration spine).
      allianceTie: (a, b) => allianceTieBoost(this.alliances.all(), a, b),
      // Static disposition (0044): gates which nomination tactic an HOH plays (pawn/backdoor/direct).
      // 0124 (part B): with soul-depth on, the EFFECTIVE disposition (baseline bent by temperament drift)
      // gates it instead — a repeatedly-burned houseguest plays more defensively. Off ⇒ the static baseline.
      dispositionOf: (id) => this.dispositionReadOf(id),
      // 0044 §9: an NPC's style comes from their archetype; the player's NPC proxy (admin fast-forward)
      // always reads as a threat hunter — the player's own character never picks an NPC lens.
      nominationStyleOf: (id) =>
        id === PLAYER ? "threat-hunter" : this.philosophiesEnabled ? styleOfPhilosophy(this.philosophyOf(id)) : NOMINATION_STYLE_BY_ARCHETYPE[this.archetypeReadOf(id) ?? ""] ?? "threat-hunter",
      // #1320 night-gate: the HOH→nominations day boundary is live ONLY when the clock pacing is running
      // (the per-conversation clock AND the master clock) — it is the "deeper half" of the fast-forward
      // fix and rides the same pair, so the golden replay (which pins `ORWELL_TIME_PER_CONVERSATION=0`)
      // and the calibration harness (master clock off) both leave it inert ⇒ byte-identical.
      nightGate: this.perConversationClockEnabled && this.timeOfDayEnabled,
      // ORW-116 (b): hold the night-roll until the player turns in or the clock reaches 8am (never for the spectator / the engine's own fast-forward).
      nightHold: this.perConversationClockEnabled && this.timeOfDayEnabled && !this.scheduleGateBypass && !this.live?.spectator && !(this.live && playerHasLeft(this.live, PLAYER)), // a player who has left the game has no night to spend
      // Open deals binding the houseguest (0039 → 0044): the vote leans to honor; the ledger still
      // reconciles a break with its full betrayal consequence downstream.
      dealsOf: (id) => this.deals.open().filter((d) => d.condition.promisors.includes(id)),
      // 0085: the per-listener CAMPAIGN tilt — present ONLY when the campaign layer is enabled (off in
      // the calibration harness ⇒ absent ⇒ byte-identical). A campaign to evict `target` that `voter` is
      // AWARE of (knownTo) pushes their vote, scaled by owner persuasiveness × voter susceptibility ×
      // trust × progress (the engine tallies; narration only voices). Bounded; never crosses the wall.
      ...(this.campaignsEnabled ? { campaignTiltFor: (target, voter) => this.campaignTiltFor(target, voter) } : {}),
      // 0024 — this NPC holder's own residual memory of a subject (+grudge − favor), only while the layer is on.
      ...(this.tieBehaviorEnabled ? { tieNomPushFor: (t: EntityId, h: EntityId) => this.tieNomPushFor(t, h), tieVotePushFor: (n: EntityId, v: EntityId) => this.tieVotePushFor(n, v) } : {}),
      ...(this.dealNomsEnabled ? { dealNomPushFor: (t: EntityId, h: EntityId) => this.dealNomPushFor(t, h) } : {}),
      ...(this.juryMemoryEnabled ? { juryMemoryFor: (j: EntityId, f: EntityId) => this.juryMemoryFor(j, f) } : {}),
      ...(this.vetoMemoryEnabled ? { vetoMemoryFor: (n: EntityId, h: EntityId) => this.vetoMemoryFor(n, h) } : {}),
      ...(this.moodVetoEnabled && this.npcTellsEnabled ? { moodVetoFor: (n: EntityId, h: EntityId) => this.moodVetoFor(n, h) } : {}),
      ...(this.hcMemoryEnabled ? { hcMemoryFor: (c: EntityId, h: EntityId) => this.hcMemoryFor(c, h) } : {}),
      ...(this.npcMemoryEnabled ? { memoryTiltFor: (subject: EntityId, holder: EntityId) => this.memoryTiltFor(subject, holder) } : {}),
      ...(this.driveDecisionsEnabled && this.campaignsEnabled ? { drivePushFor: (t: EntityId, d: EntityId) => this.drivePushForDecider(t, d) } : {}),
      ...(this.tellReactionsEnabled && this.npcTellsEnabled ? { moodTiltFor: (subject: EntityId, holder: EntityId) => this.moodTiltFor(subject, holder) } : {}),
      ...(this.lobbyingEnabled ? { pitchTiltFor: (subject: EntityId, holder: EntityId) => this.pitchTiltFor(subject, holder) } : {}),
      ...(this.assurancesEnabled ? { assuranceVoteFor: (n: EntityId, v: EntityId) => this.assuranceVoteFor(n, v), assuranceVotedOut: (v: EntityId, n: EntityId, among?: readonly EntityId[]) => this.assuranceVotedOut(v, n, among) } : {}),
      ...(this.assurancesEnabled ? { assuranceProtects: (t: EntityId, h: EntityId) => this.assuranceProtects(t, h), assuranceNominated: (h: EntityId, n: EntityId) => this.assuranceNominated(h, n) } : {}),
      ...(this.assurancesEnabled ? { assuranceKeptAtNominations: (h: EntityId, ns: readonly EntityId[]) => this.assuranceKeptAtNominations(h, ns), assuranceKeptAtVote: (v: EntityId, sp: EntityId, among?: readonly EntityId[]) => this.assuranceKeptAtVote(v, sp, among), assuranceKeptAtTally: (fn: readonly EntityId[]) => this.assuranceKeptAtTally(fn) } : {}),
      ...(this.npcBeliefNomsEnabled && this.npcBeliefsEnabled ? { beliefTiltFor: (subject: EntityId, holder: EntityId) => this.beliefNomTiltFor(subject, holder) } : {}),
      // #1937 — the same aware-only, character-mediated campaign push, signed (evict +, protect −) and bounded, on
      // the NPC HOH's nominations / replacement and the NPC veto holder's save read. 0 for the player as decider.
      ...(this.campaignsEnabled ? {
        campaignPushFor: (target: EntityId, decider: EntityId) => decider === PLAYER ? 0 : campaignPushFor(
          this.campaigns, target, decider,
          { player: PLAYER, influenceOf: (id) => this.influenceOf(id), trustOf: (o, d) => this.rel.edge(o, d).trust },
        ),
      } : {}),
      // 0006b: NPCs carry a derived competition intent — present ONLY when enabled (off in the calibration
      // harness ⇒ absent ⇒ every NPC competes ⇒ byte-identical). Live-only strategic throw/play-safe.
      ...(this.compIntentEnabled ? { compIntentOf: (id: EntityId, field: readonly EntityId[]) => this.deriveCompIntent(id, field) } : {}),
      // 0110: fold the eviction jury grudge on the evictee's DEDUCED belief (process of elimination) —
      // present ONLY when enabled (off in the calibration harness ⇒ absent ⇒ true ballot folded ⇒ byte-identical).
      ...(this.voteDeductionEnabled ? { voteDeduction: true as const } : {}),
      ...(this.npcBeliefsEnabled ? { npcBeliefs: true as const } : {}),
      // 0126: fold the expanded mechanic pool into the competition draw — present ONLY when enabled (off in
      // the calibration/golden harness ⇒ absent ⇒ the base 12-mechanic draw ⇒ byte-identical).
      ...(this.compMechanicsPlusEnabled ? { expandedComps: true as const } : {}),
      // 0127: blend a hybrid comp's secondary aptitude into its outcome — present ONLY when enabled (off in
      // the calibration/golden harness ⇒ absent ⇒ pure single-stat resolution ⇒ byte-identical).
      ...(this.compMixedEnabled ? { mixedComps: true as const } : {}),
      ...(this.finalHohThreePartEnabled ? { finalHohThreePart: true as const } : {}),
      ...(this.jurorProfilesEnabled ? { jurorProfiles: true as const, jurorProfileSalt: this.gameSeed ?? 0 } : {}),
      // C1 (#1788): the Wipeout Reel presentation layer — present ONLY when enabled (off in the
      // calibration/golden harness ⇒ absent ⇒ no failure-style fact computed ⇒ byte-identical
      // `comp-elimination` content). `archetypeOf` rides ALONGSIDE it — `beginStaged` only ever reads it
      // when `wipeoutReelEnabled` is true, so gating both behind the SAME flag keeps the off-state ctx
      // object itself byte-identical to before this feature existed, not just its downstream effect.
      ...(this.wipeoutReelEnabled
        ? { wipeoutReelEnabled: true as const, archetypeOf: (id: EntityId) => this.archetypeReadOf(id) }
        : {}),
      // #1790: the Traitors' Fury presentation layer (finale bearing display + regrouped reveal) —
      // present ONLY when the flag is ON (off in the calibration harness ⇒ absent ⇒ no bearing
      // word, no reveal regrouping ⇒ byte-identical to the pre-feature path).
      ...(this.traitorsFuryEnabled ? { traitorsFury: true as const } : {}),
    };
  }

  /** Turn 0110 vote deduction on/off. Off by default — the calibration harness leaves it off. */
  setVoteDeductionEnabled(on: boolean): void { this.voteDeductionEnabled = on; }

  /** 0126 — turn the expanded competition-mechanic pool (30 total) on/off. Off by default (the calibration
   *  harness leaves it off ⇒ base 12-mechanic draw ⇒ byte-identical). The deploy turns it on for real play. */
  setCompMechanicsPlusEnabled(on: boolean): void { this.compMechanicsPlusEnabled = on; }
  /** 0126 — the resolved on/off state of the expanded-mechanic pool (for an admin/status read). */
  compMechanicsPlusEnabledNow(): boolean { return this.compMechanicsPlusEnabled; }

  /** 0127 — turn hybrid (mixed-type) competition resolution on/off. Off by default (the calibration harness
   *  leaves it off ⇒ pure single-stat resolution ⇒ byte-identical). The deploy turns it on for real play. */
  setCompMixedEnabled(on: boolean): void { this.compMixedEnabled = on; }
  /** 0127 — the resolved on/off state of hybrid competition resolution (for an admin/status read). */
  compMixedEnabledNow(): boolean { return this.compMixedEnabled; }

  /** C1 (#1788) — turn the Wipeout Reel presentation layer on/off. Off by default (byte-identical
   *  `comp-elimination` content); the deploy/live-demo flip turns it on per the Q8 hybrid ruling. */
  setWipeoutReelEnabled(on: boolean): void { this.wipeoutReelEnabled = on; }
  /** A9 - turn the staged premiere entrances on/off for this session (read at `createCharacter`; tests/BDD; the deploy sets `ORWELL_PREMIERE_ENTRANCES`). */
  setPremiereEntrancesEnabled(on: boolean): void { this.premiereEntrancesEnabled = on; }
  premiereEntrancesEnabledNow(): boolean { return this.premiereEntrancesEnabled; }
  /** 0128 - turn the three-part Final HOH on/off for this session (tests/BDD; the deploy sets `ORWELL_FINAL_HOH_THREE_PART`). */
  setFinalHohThreePartEnabled(on: boolean): void { this.finalHohThreePartEnabled = on; }
  finalHohThreePartEnabledNow(): boolean { return this.finalHohThreePartEnabled; }
  /** A2 - turn per-juror vote profiles on/off for this session (tests/BDD; the deploy sets `ORWELL_JUROR_PROFILES`). */
  setJurorProfilesEnabled(on: boolean): void { this.jurorProfilesEnabled = on; }
  jurorProfilesEnabledNow(): boolean { return this.jurorProfilesEnabled; }
  /** Turn the hang-out lever on/off for this session (tests/BDD; the deploy sets `ORWELL_HANGOUT`). */
  setHangOutEnabled(on: boolean): void { this.hangOutEnabled = on; }
  hangOutEnabledNow(): boolean { return this.hangOutEnabled; }
  /** A8 - turn the NPC desire clock on/off for this session (tests/BDD; the deploy sets `ORWELL_DESIRE_CLOCK`). */
  setDesireClockEnabled(on: boolean): void { this.desireClockEnabled = on; }
  desireClockEnabledNow(): boolean { return this.desireClockEnabled; }
  /** A10 - turn want-driven movement on/off for this session (tests/BDD; the deploy sets `ORWELL_WANT_MOVEMENT`). */
  setWantMovementEnabled(on: boolean): void { this.wantMovementEnabled = on; }
  wantMovementEnabledNow(): boolean { return this.wantMovementEnabled; }

  /** Absolute in-game hour (days elapsed * 24 + clock hour) - the desire clock's cooldown axis. */
  private absHour(): number { return ((this.live?.dayNumber ?? 1) - 1) * 24 + (this.live?.nightDepth ?? WAKE_HOUR); }

  /**
   * A8 - the one NPC (awake, living) whose desire clock has crossed its threshold RIGHT NOW, or null. Deterministic: the relationship drive comes from `rankApproaches` on an
   * hours-keyed stream, the role is public standing (HOH/nominee), the schedule is the public day schedule. Pure read - the caller records the approach.
   */
  private desireApproach(ids: EntityId[]): { npc: EntityId; desire: string } | null {
    const live = this.live;
    if (!live || !this.house || ids.length === 0 || !firstCeremonyBeatResolved(live)) return null;
    const m = nextMilestone(live);
    const noms = new Set<EntityId>(this.ceremony.nominees ?? []);
    const rng = new SeededRandom(hashSeed(`desire:${this.gameSeed ?? ""}:${Math.floor(this.absHour() * 10)}`));
    const drive = new Map(rankApproaches(PLAYER, ids, this.rel, rng, undefined, this.approachBiasHook(PLAYER)).map((a) => [a.npc, a.drive] as const));
    const since = live.desireApproachedAt ?? {};
    const cands: Candidate[] = [];
    for (const id of ids) {
      const desire = desireFor(m?.beat, { isHoh: this.ceremony.hoh === id, isNominee: noms.has(id) });
      if (!desire) continue;
      cands.push({ npc: id, desire, drive: drive.get(id) ?? 0, hoursSinceApproach: since[id] === undefined ? undefined : this.absHour() - since[id]! });
    }
    const until = m ? Math.max(0, m.targetHour - (live.nightDepth ?? WAKE_HOUR)) : null;
    const best = mostUrgent(cands, until);
    return best ? { npc: best.npc, desire: best.desire } : null;
  }

  /** A8 - record that `npc` approached now (the hours-based cooldown). */
  private noteApproach(npc: EntityId): void {
    const live = this.live!;
    (live.desireApproachedAt ??= {})[npc] = this.absHour();
  }
  /** In-game hours the last hang-out spent, read-and-cleared by the orchestrator so the off-screen society can tick for them. */
  consumeHangOutHours(): number { const h = this.hangOutPendingHours; this.hangOutPendingHours = 0; return h; }
  /** C1 (#1788) — the resolved on/off state of the Wipeout Reel layer (for an admin/status read). */
  wipeoutReelEnabledNow(): boolean { return this.wipeoutReelEnabled; }

  /** Turn the live campaign layer on/off (0085 B2). Off by default — the calibration harness leaves it off. */
  setCampaignsEnabled(on: boolean): void { this.campaignsEnabled = on; }

  /**
   * B2 (2026-07-05 activation lane) — the single God-Mode dial for every "living house" behavioral-
   * fidelity layer that ships opt-in behind its own `ORWELL_*` env flag. Mirrors `setTimeOfDay` (ADR
   * 0006): each named field flips ONE layer at runtime — no engine restart — and an absent field
   * leaves that layer's current setting (env default or a prior override) untouched. EVERY field is
   * per-sandbox state (the composition layer wires one delegate per sandbox), so an admin flip on one
   * user's game never reaches another user's. secretPacing/seededTieSurfacing used to write the
   * process-global static instead (a cross-user bleed, #1922); they now set a per-sandbox override that
   * wins over that static, which stays only as the test/default seam.
   * Vault-free by construction (every layer is calibration-proven-neutral-when-off; no Vault handle,
   * no hidden value crosses).
   */
  setBehavioralFlags(flags: BehavioralFlags): void {
    if (flags.campaigns !== undefined) this.campaignsEnabled = flags.campaigns;
    if (flags.trajectories !== undefined) this.trajectoriesEnabled = flags.trajectories;
    if (flags.triggers !== undefined) this.triggersEnabled = flags.triggers;
    if (flags.juryHouse !== undefined) this.juryHouseEnabled = flags.juryHouse;
    // Per-SANDBOX, like every sibling here: these two used to write a process-global static, so flipping
    // them on one user's game changed every user's (#1922). The static stays only as the test/default seam.
    if (flags.secretPacing !== undefined) this.secretPacingSandboxOverride = flags.secretPacing;
    if (flags.seededTieSurfacing !== undefined) this.seededTieSurfacingSandboxOverride = flags.seededTieSurfacing;
    if (flags.mythMaking !== undefined) this.mythMakingEnabled = flags.mythMaking;
    if (flags.showrunner !== undefined) this.showrunnerEnabled = flags.showrunner;
  }

  /** The CURRENT resolved state of every B2 behavioral flag (env default or override) — Vault-free,
   *  admin-visible read-side of `setBehavioralFlags` so the FE dial can render on/off correctly. */
  behavioralFlagsSnapshot(): Required<BehavioralFlags> {
    return {
      campaigns: this.campaignsEnabled,
      trajectories: this.trajectoriesEnabled,
      triggers: this.triggersEnabled,
      secretPacing: this.secretPacingEnabled,
      juryHouse: this.juryHouseEnabled,
      seededTieSurfacing: this.seededTieSurfacingEnabled,
      mythMaking: this.mythMakingEnabled,
      showrunner: this.showrunnerEnabled,
    };
  }

  /** Turn the NPC competition-intent layer on/off (0006b). Off by default — the calibration harness leaves it off. */
  setCompIntentEnabled(on: boolean): void { this.compIntentEnabled = on; }

  /**
   * 0006b — derive an NPC's competition intent (compete / throw / play-safe) for a comp over `field`.
   * Strategic and OCCASIONAL by construction (see COMP_INTENT_THRESHOLDS):
   *   • a NOMINEE always competes (fighting for their life);
   *   • a LAY-LOW houseguest (low archetype aggression) with a strongly-trusted ally ALSO in the field
   *     THROWS — hand the ally the power and keep their own head down;
   *   • a CAUTIOUS houseguest another competitor already reads as a real threat PLAYS SAFE — don't win
   *     the comp that paints a bigger target on you;
   *   • otherwise COMPETE.
   * Pure read of the live board + relationships (no rng, no Vault, no number crosses the wall).
   */
  private deriveCompIntent(id: EntityId, field: readonly EntityId[]): Intent {
    if (id === PLAYER) return "compete"; // the player declares their own approach
    const hg = this.house?.npcs.find((n) => n.id === id);
    if (!hg) return "compete";
    const others = field.filter((o) => o !== id);
    return deriveNpcCompIntent({
      aggression: ARCHETYPE_AGGRESSION[hg.character.archetype] ?? 0.5,
      nominee: this.live?.nominees?.includes(id) ?? false,
      hasOthers: others.length > 0,
      bestAllyBond: others.length ? Math.max(...others.map((o) => this.rel.bondStrength(id, o))) : 0,
      maxThreatOnMe: others.length ? Math.max(...others.map((o) => this.rel.edge(o, id).threat)) : 0,
    });
  }

  /** Turn the RELATIONSHIP-TRAJECTORY layer on/off (0087). Off by default — the calibration harness leaves
   *  it off (with it off the off-screen tick passes no `trajectoryOf` ⇒ the seeded spine is byte-identical). */
  setTrajectoriesEnabled(on: boolean): void { this.trajectoriesEnabled = on; }

  /** Whether the trajectory layer is live (0087) — the orchestrator reads this so it passes `trajectoryOf`
   *  ONLY when on (off ⇒ the off-screen call is byte-identical to the pre-feature stretch). */
  trajectoriesEnabledNow(): boolean { return this.trajectoriesEnabled; }

  /** Turn the 0120 STRATEGIC-DRIVE initiator cadence on/off. Off by default — the calibration harness leaves
   *  it off (with it off the off-screen tick passes no `initiatorDriveOf` ⇒ the seeded spine is byte-identical). */
  setStrategicCadenceEnabled(on: boolean): void { this.strategicCadenceEnabled = on; }

  /** Turn the 0121 deal-depth layer on/off (active-obligation kinds + reliability rewards). Off by default —
   *  the calibration harness leaves it off (off ⇒ the new kinds can't be made ⇒ byte-identical). */
  setDealDepthEnabled(on: boolean): void { this.dealDepthEnabled = on; }
  /** 0024 — turn the NPC memory layer on/off for this session (off ⇒ nothing is written or read). */
  setNpcMemoryEnabled(on: boolean): void { this.npcMemoryEnabled = on; }
  setNpcMemoryStandaloneEnabled(on: boolean): void { this.npcMemoryStandaloneEnabled = on; }
  setNpcMemoryWritersEnabled(on: boolean): void { this.npcMemoryWritersEnabled = on; }
  setNpcBeliefNomsEnabled(on: boolean): void { this.npcBeliefNomsEnabled = on; }
  setNpcBeliefsEnabled(on: boolean): void { this.npcBeliefsEnabled = on; }
  npcMemoryEnabledNow(): boolean { return this.npcMemoryEnabled; }
  /** Whether the deal-depth layer is live (0121). */
  dealDepthEnabledNow(): boolean { return this.dealDepthEnabled; }
  /** 0121 R1 — wire the "keeps their word" reputation diffuser (the registry owns the KnowledgeService +
   *  social graph). Only invoked when the deal-depth layer is on (the ledger gates `reputation` on it), so
   *  an unwired / flag-off game is byte-identical. */
  setDealReputationSink(fn: (honorer: EntityId, other: EntityId) => void): void { this.dealReputationSink = fn; }
  /** 0121 R1 — wire the Vault-free reliability-reputation READER (the registry owns the KnowledgeService):
   *  which honorers a holder credits as "keeps their word" (the diffusing `reliable:<honorer>` belief). Read
   *  by the NPC deal-willingness lean in `mintNpcDeal`. Off unless the deal-depth layer is on ⇒ byte-identical. */
  setReliabilityReader(fn: (holder: EntityId) => ReadonlySet<EntityId>): void { this.reliabilityReader = fn; }

  /** Turn the 0122 deeper+daily confessional layer on/off. Off by default — the calibration harness leaves
   *  it off (off ⇒ no daily sweep, no depth context ⇒ every confessional is byte-identical to 0040). */
  setConfessionalDepthEnabled(on: boolean): void { this.confessionalDepthEnabled = on; }
  /** Whether the deeper+daily confessional layer is live (0122). */
  confessionalDepthEnabledNow(): boolean { return this.confessionalDepthEnabled; }

  /** Turn the 0123 NPC-initiated deal-offer layer on/off. Off by default — the calibration harness leaves
   *  it off (off ⇒ no offer is ever generated ⇒ byte-identical). */
  setNpcDealOffersEnabled(on: boolean): void { this.npcDealOffersEnabled = on; }
  /** Whether the NPC-initiated deal-offer layer is live (0123). */
  npcDealOffersEnabledNow(): boolean { return this.npcDealOffersEnabled; }

  /** Turn the 0124 deeper character-evolution layer on/off. Off by default — the calibration harness leaves
   *  it off (off ⇒ evolveEmotion moves only the 0041 scalar, reads use the plain state ⇒ byte-identical).
   *  Applies the disposition-tuned reactivity post-pass (part C) to the live cast when switched on. */
  setSoulDepthEnabled(on: boolean): void {
    this.soulDepthEnabled = on;
    if (on) this.applyDispositionReactivity();
  }
  /** Whether the deeper character-evolution layer is live (0124). */
  soulDepthEnabledNow(): boolean { return this.soulDepthEnabled; }

  /** Whether the strategic-drive cadence is live (0120) — the orchestrator reads this so it passes
   *  `initiatorDriveOf` ONLY when on (off ⇒ the off-screen initiator is the uniform `rng.pick`). */
  strategicCadenceEnabledNow(): boolean { return this.strategicCadenceEnabled; }

  /** Turn the Wave-2 off-screen-scheming-names-a-real-target layer on/off. Off by default — the calibration
   *  harness leaves it off (off ⇒ the off-screen tick passes no `nameSchemeTargets` ⇒ byte-identical). */
  setSchemeTargetsEnabled(on: boolean): void { this.schemeTargetsEnabled = on; }
  /** Whether the off-screen scheme-target layer is live — the orchestrator reads this so it passes
   *  `nameSchemeTargets` ONLY when on (off ⇒ no third-party target clause is appended to hidden scenes). */
  schemeTargetsEnabledNow(): boolean { return this.schemeTargetsEnabled; }

  /** 0120 — how often this houseguest INITIATES off-screen scheming, weighted by strategic intelligence
   *  (Mental stat) + personality (strategyStyle). Engine-internal (the off-screen society is hidden) —
   *  never a player-facing number. A bounded, slight variance (see `strategicDriveWeight`). */
  initiatorDrive(id: EntityId): number {
    const npc = this.house?.npcs.find((n) => n.id === id);
    return strategicDriveWeight(this.statsOf(id).mental, npc?.character.strategyStyle);
  }

  // --- 0066 Phase-2 (#1125): the three sleep-economy extension flags (each default OFF) --------------

  /** Extension 1 — the per-conversation clock advance. Off by default — calibration leaves it off. */
  setPerConversationClockEnabled(on: boolean): void { this.perConversationClockEnabled = on; }
  /** Extension 2 — NPC next-day social fatigue (dampened sway + conflict-drained bedtime). Off by default. */
  setSocialFatigueEnabled(on: boolean): void { this.socialFatigueEnabled = on; }
  /** Extension 3 — the compounding multi-night fatigue meter. Off by default. */
  setMultiNightFatigueEnabled(on: boolean): void { this.multiNightFatigueEnabled = on; }

  /** #1400 — generative competition design (the model dresses the fixed roll). Off by default (env-gated). */
  setGenCompetitionsEnabled(on: boolean): void { this.genCompetitionsEnabled = on; }
  /** #1400 — the resolved on/off state of the generative-competition flag (for an admin/status read). */
  genCompetitionsEnabledNow(): boolean { return this.genCompetitionsEnabled; }

  /** 0125 — turn the seeded competition THEME/skin layer on/off. On by default (real play wants the variety);
   *  the calibration/golden harness pins it off. Pure Vault-free projection ⇒ off is byte-identical to the
   *  bare 0042 library name/premise, and on never perturbs the seeded winner. */
  setCompThemesEnabled(on: boolean): void { this.compThemesEnabled = on; }
  /** 0125 — the resolved on/off state of the competition-theme layer (for an admin/status read). */
  compThemesEnabledNow(): boolean { return this.compThemesEnabled; }

  /**
   * 0125 — the Vault-free surfaced scaffold for a drawn mechanic def, dressed in this week's seeded theme
   * when the layer is on. The theme is a pure PROJECTION (chosen on a dedicated hash, never the beat rng),
   * so a theme never moves the winner; off (or pre-seed) ⇒ the bare 0042 library name/premise (byte-identical).
   */
  private themedScaffold(
    def: CompetitionDef, frozen?: { week: number; cycle: number },
  ): { name: string; theme?: string; narrative: { premise: string; beats: string[]; winReads: string } } {
    if (!this.compThemesEnabled || this.gameSeed === null) {
      return { name: def.name, narrative: { premise: def.narrative.premise, beats: [...def.narrative.beats], winReads: def.narrative.winReads } };
    }
    // L-F4 (#1743): for an IN-PROGRESS staged comp the theme inputs are FROZEN at draw (week + cycle),
    // so the skin can't flip round to round if the live week/twist changes mid-comp. Absent (pre-stage /
    // legacy save) ⇒ live resolution. A double-eviction night reruns a same-phase comp in the SAME week;
    // the frozen `cycle` (twist "running" ⇒ 1) still draws a distinct skin from the first crown.
    const week = frozen?.week ?? this.week;
    const cycle = frozen ? frozen.cycle : (this.live?.twist?.phase === "running" ? 1 : 0);
    const t = applyTheme(def, themeForWeek(this.gameSeed, def.phase, week, cycle));
    return { name: t.name, theme: t.theme, narrative: t.narrative };
  }

  /** L-F4 (#1743): the FROZEN theme inputs for the in-progress staged comp (pinned at draw), or undefined
   *  when none is staged / a legacy save lacks them ⇒ the caller falls back to live theme resolution. */
  private frozenCompTheme(): { week: number; cycle: number } | undefined {
    const c = this.live?.competition;
    return c && c.themeWeek !== undefined && c.themeCycle !== undefined
      ? { week: c.themeWeek, cycle: c.themeCycle } : undefined;
  }

  /**
   * L-F4 (#1743) — the PINNED comp presentation surfaced on EVERY comp-beat turn's whereabouts (name +
   * format + premise), resolved with the SAME precedence `runCompetition` uses (model-authored #1400
   * fiction > 0125 seeded theme > 0042 library floor), so a comp's format/premise stays CONSISTENT across
   * its first reveal and every staged elimination round — the narrator can never re-author "what kind of
   * comp this is" turn to turn. The FORMAT is ALWAYS the drawn `def.format` (the HARD pin — never model-
   * overridable). `undefined` before a def is drawn (the HOH comp before it stages) and off a comp beat.
   * PURE — `competitionPresentation` + `themedScaffold` consume no rng, so `whereabouts` stays a purely
   * observational, calibration-identical read. Vault-free (public flavor only — never a score/lean/number).
   */
  private pinnedCompView(): { name: string; format: string; premise: string } | undefined {
    if (!this.live) return undefined;
    const pin = competitionPresentation(this.live);
    if (!pin) return undefined;
    // #1400 fiction, once pinned, wins outright (a fresh restart re-grounds the narrator in the authored
    // staging) — exactly `runCompetition`'s precedence; otherwise dress the library floor in this week's
    // seeded theme. The FORMAT never comes from either skin — it is always the drawn library `def.format`.
    if (pin.authored) return { name: pin.name, format: pin.format, premise: pin.premise };
    // L-F4 (#1743): read the theme from the FROZEN inputs pinned at draw, so the name/premise is byte-
    // identical across every round of the comp even if the live week/twist phase changes mid-comp.
    const skin = this.themedScaffold(pin.def, this.frozenCompTheme());
    return { name: skin.name, format: pin.format, premise: skin.narrative.premise };
  }

  /**
   * 0066 Phase-2 (Extension 1) — advance the clock a SMALL step as the player lingers/plays WITHIN a beat.
   * The orchestrator's per-turn off-screen tick calls this once per player TURN (debounced for aux tool
   * calls, E57/R5), so the day's finite scheming time is felt turn-by-turn. SELF-GATED: a NO-OP unless the
   * dedicated flag is on AND the master clock is running AND the clock has initialized (the first ceremony
   * beat starts the day). Pacing-only — it clamps at late-night and NEVER wraps the night without the
   * player's own `turnIn` (ADR 0003 / the lull rule), so it can never rush an engaged scene past their
   * bedtime decision. Off ⇒ nothing advances ⇒ byte-identical. No rng. (Persisted via the snapshot like
   * the per-beat clock.)
   */
  advanceClockPerConversation(opts?: { kind?: ConversationKind; proposedHours?: number }): void {
    if (this.hangOutSkipStepAt !== undefined) { // the hang-out already spent this turn's time: skip the follow-up step once (only if the clock has not moved since)
      const at = this.hangOutSkipStepAt; this.hangOutSkipStepAt = undefined;
      if (this.live?.nightDepth === at) return;
    }
    // Gated no-op: the clock isn't active this turn (per-conversation clock disabled, master clock off, or the day hasn't started). Clock off => nothing advances => byte-identical.
    if (!this.perConversationClockEnabled || !this.timeOfDayEnabled) return;
    if (!this.live || this.live.timeOfDay === undefined) return; // dormant until the per-beat clock starts the day
    // P4c (PO ruling 2026-11-04): the clock ticks per MESSAGE - exactly MINUTES_PER_MESSAGE, continuously, so production/NPCs can interrupt mid-conversation. Cost depends ONLY
    // on message count: `opts.kind` / `opts.proposedHours` are accepted for API compatibility but BILL NOTHING, and the narrator's `feltMinutes` no longer touches the clock
    // (conversation types - passing / casual / strategy / summit - emerge from how many messages they run).
    void opts;
    advanceClockPerMessage(this.live, MINUTES_PER_MESSAGE / 60);
    // A8: an NPC whose desire clock has crossed its threshold CUTS INTO the conversation (shown for exactly the next framing). Flag off => nothing written.
    if (this.desireClockEnabled && this.house) {
      delete this.live.interruption; // the previous one was already shown
      const evicted = new Set(this.live.evictionOrder ?? []);
      const awake = this.awakeNow();
      const ids = this.house.npcs.map((n) => n.id).filter((id) => !evicted.has(id) && (!awake || awake.has(id)));
      const hit = this.desireApproach(ids);
      if (hit) { this.noteApproach(hit.npc); this.live.interruption = { npc: hit.npc, desire: hit.desire, atHour: this.live.nightDepth ?? WAKE_HOUR }; }
    }
  }

  /** #1792 — pending ExchangeAccounting from the last substantive recordInteraction, consumed once
   *  by the next getMomentPrompt call (one-shot delivery — never fires on the HUD/view()). */
  private pendingExchangeAccounting?: ExchangeAccounting;
  /** Stash the exchange-accounting fact for one-shot delivery in the next moment prompt.
   *  No-ops when the producer-read flag is off (safety net — the sink is only wired when ON,
   *  so this is defense-in-depth). */
  stashExchangeAccounting(acc: ExchangeAccounting): void {
    if (!this.producerReadEnabled) return;
    this.pendingExchangeAccounting = acc;
  }

  /**
   * The directed `a→b` arc's hidden TRAJECTORY (0087) — passed to the off-screen society's nature pick when
   * the layer is ON. Returns `STEADY` (no tilt) when the layer is off OR the pair has no momentum yet, so a
   * disabled layer / a fresh pair is the identity (byte-identical to today's `natureWeights`). VAULT-ONLY —
   * called only from the engine-side off-screen tick, never from any outward projection.
   */
  trajectoryOf(a: EntityId, b: EntityId): Trajectory {
    if (!this.trajectoriesEnabled) return STEADY;
    return this.trajectories.get(`${a}->${b}`) ?? STEADY;
  }

  /**
   * Fold one just-recorded off-screen scene into the directed `initiator→partner` arc's momentum (0087) —
   * called ENGINE-SIDE by the off-screen tick AFTER the relationship fold, ONLY when the layer is on. The
   * scene's NATURE is mapped to a Vault-free `FoldSignal` (a signed bond/threat delta from the SAME nature
   * IMPACT the fold applied + a betrayal flag — never a raw edge number), appended to the pair's tiny ring
   * buffer (capped to the recency window), and `deriveTrajectory` re-derives the phase + momentum. Pure +
   * deterministic (no rng): same history ⇒ same arc. No-op when the layer is off ⇒ nothing to persist and
   * the calibration spine is untouched.
   */
  recordTrajectoryFold(initiator: EntityId, partner: EntityId, type: InteractionType): void {
    if (!this.trajectoriesEnabled) return;
    const key = `${initiator}->${partner}`;
    const folds = this.trajectoryFolds.get(key) ?? [];
    folds.push(GameSessionAdapter.foldSignalFor(type));
    while (folds.length > TRAJECTORY_CONSTANTS.recencyWindow) folds.shift();
    this.trajectoryFolds.set(key, folds);
    this.trajectories.set(key, deriveTrajectory(folds, this.trajectories.get(key)));
  }

  /**
   * Decay every directed arc NOT fed this tick toward `steady` (0087) — mirrors 0026's edge neglect decay,
   * so an unfed arc reverts to a flat relationship at the same cadence. `touched` is the set of `a->b` keys
   * that folded a scene this tick (those keep their freshly-built momentum). Pure, no rng. No-op when the
   * layer is off. A pair whose momentum decays below the phase floor is dropped to `STEADY` and forgotten.
   */
  decayUntouchedTrajectories(touched: ReadonlySet<string>): void {
    if (!this.trajectoriesEnabled) return;
    for (const [key, traj] of this.trajectories) {
      if (touched.has(key)) continue;
      const next = decayTrajectory(traj);
      if (next.momentum <= 0 || next.phase === "steady") {
        this.trajectories.delete(key);
        this.trajectoryFolds.delete(key);
      } else {
        this.trajectories.set(key, next);
      }
    }
  }

  /**
   * Map an off-screen scene's NATURE to its Vault-free trajectory FOLD signal (0087). The signed deltas come
   * from the SAME `RELATIONSHIP_CONSTANTS.IMPACT` magnitudes the relationship fold applies — `bondDelta` is
   * the (affinity+trust)/2 move (+ warmer, − cooler), `threatDelta` the threat move — so the arc's direction
   * agrees with how the edge actually moved. `betrayal` flags the souring-momentum injector. Pure + static;
   * carries NO raw edge state (only the nature's constant shape), so it crosses no wall.
   */
  private static foldSignalFor(type: InteractionType): FoldSignal {
    const imp = RELATIONSHIP_CONSTANTS.IMPACT[type];
    const bondDelta = ((imp.affinity ?? 0) + (imp.trust ?? 0)) / 2;
    return { bondDelta, threatDelta: imp.threat ?? 0, betrayal: type === "betrayal" };
  }

  // ─── 0104 — SEASON-OVER-SEASON NOTORIETY (a reputation that precedes the player) ─────────────────

  /**
   * 0104 — hand this session the returning player's accumulated NOTORIETY so `seedFirstImpressions`
   * folds the day-one bias (the registry calls this on a `keepCharacter` restart — the diegetic
   * opt-in, R4). A NEW character / no prior season passes `null` (or never calls this) ⇒ no bias ⇒
   * byte-identical. MUST be set BEFORE `createCharacter` runs `seedFirstImpressions` (the registry's
   * restart hook sets it on the fresh sandbox before delegating the create). Vault-free in: a bounded
   * open-set summary, never a Vault read.
   */
  setNotoriety(summary: NotorietySummary | null): void { this.notoriety = summary; }

  /**
   * 0104 — the (Vault-free) notoriety the narrator may VOICE as a returning-cast callback (the
   * `legendBeats` gist — "word is you're not someone to cross", ADR 0003: facts to voice, never a
   * script, never the numbers). Returns null when the player did not return as the same character.
   * Only the gist crosses: this returns a fresh legend-only PROJECTION, so the reputation FACETS (the
   * hidden numbers behind the day-one biases), placements and season counts never leave the engine —
   * it previously returned the whole summary over the player MCP channel.
   */
  notorietySummary(): NotorietyLegendView | null {
    return this.notoriety ? { legendBeats: [...this.notoriety.legendBeats] } : null;
  }

  /**
   * 0104 — the FULL carried notoriety (reputation facets included). Engine-internal: deliberately NOT
   * on the outward `GameSession` port, so no MCP tool can dispatch it. Tests use it to prove the
   * returning-character carry-over; production reads `this.notoriety` directly.
   */
  carriedNotoriety(): NotorietySummary | null { return this.notoriety; }

  /**
   * 0104 — build the OPEN-SET season outcome record the registry derives notoriety from, at the
   * season-end terminal. PURE projection of the live season's PUBLIC ceremony record (placement, the
   * player's comp wins, how each evictee read the PLAYER's role in their eviction, jury reach + the
   * finale vote share) — facts the player witnessed / the 0048 retrospective unseals. NO Vault handle,
   * NO soul, NO hidden edge crosses (R1). Returns null until a season has actually FINISHED.
   */
  openSetOutcome(): OpenSetSeasonOutcome | null {
    if (!this.house || !this.live?.finished) return null;
    const me = this.house.player.id;
    const castSize = 1 + this.house.npcs.length;
    // Numeric placement: winner = 1, runner-up = 2; otherwise from the eviction order (the later you
    // were evicted, the better the placement). The i-th (0-based) evictee placed `castSize - i`.
    const order = this.live.evictionOrder ?? [];
    let placement: number;
    if (this.live.winner === me) placement = 1;
    else if (this.live.finalTwo?.includes(me)) placement = 2;
    else {
      const idx = order.indexOf(me);
      placement = idx >= 0 ? castSize - idx : castSize; // never-evicted-but-not-a-finalist guard ⇒ worst
    }
    // The player's comp wins — the public-facts `resume` tally (HOH reigns + veto wins).
    const playerCompWins = this.live.resume?.[me] ?? 0;
    // How each evictee read the PLAYER's role in their eviction (open-set: `mannerByEvictee[evictee][PLAYER]`;
    // the player witnessed it / the retrospective unseals it). Only the categorical reads cross — never
    // the hidden edge numbers behind them.
    const manner = this.live.mannerByEvictee ?? {};
    const playerEvictionRoles: OpenSetSeasonOutcome["playerEvictionRoles"] = [];
    for (const evictee of Object.keys(manner)) {
      const m = manner[evictee]?.[me];
      if (m) playerEvictionRoles.push({ blindsided: m.blindsided, betrayed: m.betrayed, respected: m.respected });
    }
    const reachedFinalTwo = this.live.finalTwo?.includes(me) ?? false;
    // Reached the jury = a juror seat (one of the last 9 evictees) OR a finalist (a deeper run still counts).
    const jurors = new Set(order.slice(-9));
    const reachedJury = reachedFinalTwo || jurors.has(me);
    // The finale jury-vote share the player won (open-set ceremony fact) — only meaningful as a finalist.
    let juryVoteShare = 0;
    const votes = this.live.finale?.votes;
    if (reachedFinalTwo && votes) {
      const cast = Object.values(votes);
      const forMe = cast.filter((v) => v === me).length;
      juryVoteShare = cast.length > 0 ? forMe / cast.length : 0;
    }
    return { placement, castSize, playerCompWins, playerEvictionRoles, reachedJury, reachedFinalTwo, juryVoteShare };
  }

  // ─── 0091 — TRIGGER SECRETS & HOUSE-EVENT ERUPTIONS ─────────────────────────────────────────────

  /** Turn the trigger-eruption layer on/off (0091). ON by default (2026-11 flip) — `ORWELL_FLAGS_OFF=1` leaves it off
   *  (off ⇒ the orchestrator never runs the check ⇒ ZERO draws ⇒ the seeded spine is byte-identical). */
  setTriggersEnabled(on: boolean): void { this.triggersEnabled = on; }

  /** Whether the trigger layer is live (0091) — the orchestrator reads this so it runs the check ONLY when
   *  on (off ⇒ no call, no draw, byte-identical calibration). */
  triggersEnabledNow(): boolean { return this.triggersEnabled; }

  /** Map a fired eruption to the erupter's soul fold (0041/0023). A `meltdown`/`showmance-detonation` is a
   *  spiral — `betrayed` deepens distress AND raises volatility, so the charge climbs further. A `blow-up`/
   *  `mask-slips` is a release — `calm` settles VOLATILITY (the arousal half of strain, via the 0028 family),
   *  so the wound-tight edge eases after venting even though the underlying distress (`emotionalState`) only
   *  mean-reverts at its usual cadence; this is the bounded "the storm passed" relaxation, never a reset. */
  private static eruptionEmotion(kind: EruptionKind): EmotionalEvent {
    return kind === "meltdown" || kind === "showmance-detonation" ? "betrayed" : "calm";
  }

  /**
   * 0091 — run the TRIGGER check this tick: for each plausibly-strained, co-present erupting houseguest,
   * evaluate `pressure(volatility × strain × precipitant)` and on a fire RECORD a Vault-safe public eruption
   * `house-event` (player-witnessed) + fold the soul/witness consequence. SELF-GATED by `triggersEnabled` ⇒
   * a no-op (ZERO draws on any rng) when off, so the orchestrator's shared society/vote stream is untouched
   * and the seeded calibration spine is byte-identical (the load-bearing guarantee). Runs on a DEDICATED
   * session side-rng (forked off the game seed + the trigger tick counter) — NEVER the shared tick stream.
   *
   * `precipitants` maps a houseguest id → the spark strength ∈ [0,1] of what JUST happened to them this tick
   * (a fresh conflict/betrayal scene, a nomination). NO precipitant ⇒ pressure 0 ⇒ no fire (the no-cold-open
   * guarantee: a trigger never fires out of a quiet stretch). The sealed `detail`/`volatility`/eruption-kind
   * never reach the recorded event or any projection — only the generic public eruption line does (mandate #2).
   *
   * `events` (the EventStore) is HANDED in by the orchestrator (the `whisperPairings(knowledge)` precedent —
   * the session owns the rng + house + rel; the store is the orchestrator's), so the eruption EVENT is
   * recorded here in the session, anti-repeat consulted against the live `house-event` history.
   */
  runTriggerEruptions(events: EventStore, precipitants: ReadonlyMap<EntityId, number>): void {
    if (!this.triggersEnabled || !this.house) return;
    if (this.eruptionCount >= TRIGGER.eruptionCapPerSeason) return; // season cap spent — no draws, no fire
    if (precipitants.size === 0) return; // no spark anywhere this tick ⇒ nothing to evaluate (no cold open)
    this.triggerTickCount += 1;
    // DEDICATED stream — zero touch to the orchestrator's shared per-user rng (the calibration spine).
    const rng = new SeededRandom(hashSeed(`${this.gameSeed ?? 0}:triggers:${this.triggerTickCount}`));
    const evicted = new Set(this.live?.evictionOrder ?? []);
    const awake = this.awakeNow();
    // A trigger only fires for a LIVING NPC who is co-present (still on the floor / awake) AND has a fresh
    // spark this tick — and we evaluate in a STABLE id order so the dedicated stream is deterministic.
    const candidates = this.house.npcs
      .filter((n) => !evicted.has(n.id) && (!awake || awake.has(n.id)) && (precipitants.get(n.id) ?? 0) > 0)
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (const n of candidates) {
      if (this.eruptionCount >= TRIGGER.eruptionCapPerSeason) break; // cap reached mid-tick
      const trig = n.character.hiddenElements.find((e) => e.kind === "trigger");
      // An armed trigger carries both the eruption kind + a numeric volatility (set together by `armTriggers`).
      if (!trig || trig.eruptionKind === undefined || typeof trig.volatility !== "number") continue;
      const eruptionKind = trig.eruptionKind;
      // The per-kind re-arm policy: a one-shot (a slipped mask) never re-fires; a re-armable kind waits out
      // the cooldown. A spent fuse is skipped WITHOUT drawing (keeps the dedicated stream tied to live fires).
      if (trig.fired) {
        if (TRIGGER.oneShotKinds.includes(eruptionKind)) continue;
        if (trig.lastFiredWeek !== undefined && this.week - trig.lastFiredWeek < TRIGGER.reArmCooldownWeeks) continue;
      }
      const strainNow = triggerStrain(n.soul);
      const precipitant = Math.min(1, Math.max(0, precipitants.get(n.id) ?? 0));
      if (!shouldFire({ volatility: trig.volatility, kind: eruptionKind }, strainNow, precipitant, rng)) continue;
      // FIRE — a Vault-safe PUBLIC eruption. The recorded content is a GENERIC pool line (no name, no
      // sealed wording, no number); the connection trigger → event stays Vault-side.
      const content = eruptionEvent(eruptionKind, events, rng, { week: this.week, phase: this.phase });
      // BE-DEEP2-3/COMP-6: compute the TRUE co-present witness set ONCE and reuse it for both the
      // recorded event's `witnessSet` and the relationship fold below, so the two can never drift apart
      // again. Previously the event hardcoded `[PLAYER, n.id]` regardless of how many OTHER houseguests
      // were actually in the room — starving every other co-present houseguest of a legitimate
      // witnessed-event recall (they couldn't reference "that blow-up" in a confessional even though the
      // fiction says they were standing right there). The player stays unconditionally in the set: this
      // is a headline house-wide announcement (a public eruption, `hidden: false`), and `validateEvent`
      // (src/domain/event.ts) HARD-requires the player be a witness of any non-hidden event.
      const witnesses = this.coPresentWitnessesOf(n.id);
      events.record({
        id: `trigger:erupt:${this.gameSeed ?? 0}:${this.triggerTickCount}:${n.id}`,
        // The EventStore is the monotonic tick authority (B60/E12): any non-advancing ts is normalized to
        // last+1, so a deterministic placeholder keeps the record reproducible (never a wall clock).
        ts: 0,
        type: "house-event",
        initiator: n.id,
        // PLAYER always (see above) + the erupter + every OTHER houseguest actually co-present — never secret.
        witnessSet: [PLAYER, n.id, ...witnesses.filter((id) => id !== PLAYER)],
        hidden: false,
        content,
      });
      // Durable consequence (0023/0041): the erupter's soul folds (charge spent or volatility raised), and
      // co-present witnesses' reads of them shift along the existing pathway (0026) — a real fold, no number.
      this.inflect(n.id, GameSessionAdapter.eruptionEmotion(eruptionKind));
      this.foldEruptionWitnesses(n.id, witnesses, rng);
      // Mark the fuse spent (monotonic, persisted on the byte-stable house) + bump the season cap counter.
      trig.fired = true;
      trig.lastFiredWeek = this.week;
      this.eruptionCount += 1;
    }
  }

  /** 0091/BE-DEEP2-3 — the erupter's TRUE co-present witness set: every living houseguest (including the
   *  player) sharing their room (when presence is tracked) and awake (when the sleep clock is on). Shared
   *  by the recorded event's `witnessSet` and the relationship fold so the two never drift apart. */
  private coPresentWitnessesOf(erupter: EntityId): EntityId[] {
    const room = this.presence?.get(erupter);
    const awake = this.awakeNow();
    return this.livingIds().filter(
      (id) => id !== erupter && (!this.presence || !room || this.presence.get(id) === room) && (!awake || awake.has(id)),
    );
  }

  /** 0091 — a public eruption shifts how the co-present house (and the player) reads the erupter: a small
   *  THREAT/CONFLICT fold along the existing relationship pathway (0026), drawn on the DEDICATED trigger rng
   *  (never the shared spine). The player is a witness like anyone — their read of the erupter moves, never a
   *  number shown. No-op if no one else is on the floor. `witnesses` is the SAME set the caller just used
   *  for the recorded event's `witnessSet` (BE-DEEP2-3) — never recomputed separately. */
  private foldEruptionWitnesses(erupter: EntityId, witnesses: readonly EntityId[], rng: SeededRandom): void {
    for (const w of witnesses) {
      // Seeing someone blow up reads as conflict toward them (threat ▲, warmth ▼) — the society's own
      // `conflict` impact, directed witness → erupter. Drawn on the dedicated trigger rng only.
      this.rel.applyImpactDirected(w, erupter, RELATIONSHIP_CONSTANTS.IMPACT.conflict, rng);
    }
  }

  /**
   * The player's OWN declared campaign target (0085 C) — a player-level, OOC intent, exactly like a
   * Diary-Room strategy: it is the PLAYER'S knowledge with NO in-game pathway to any NPC. It NEVER seeds
   * or moves an NPC campaign (NPC formation reads only NPC threat/ally reads — `campaignActors` excludes
   * the player), so the house responds only to the player's ACTUAL recorded moves, never to their intent.
   */
  private playerCampaignTarget: EntityId | null = null;
  declarePlayerCampaign(target: EntityId): void { this.playerCampaignTarget = target; }
  /** Read back the player's declared campaign target (player-knowledge only; never an NPC pathway). */
  playerCampaignRead(): EntityId | null { return this.playerCampaignTarget; }

  /**
   * Phase 2 of "the player can play offense" (0085 follow-on) — fold ONE of the player's OWN LANDED
   * pitches (`recordInteraction`'s `aboutEdges`, Phase 1) into a real, bounded, persistent campaign the
   * PLAYER owns, so sustained lobbying can tilt the eventual vote through the SAME `campaignTiltFor`
   * mechanism an NPC's own campaign uses. Called ONLY by `EngineCommandsAdapter` for a `more-threatened`
   * pitch that actually landed (never a backfired one). Self-gated: a no-op (ZERO draws, no campaign)
   * unless the campaign layer is enabled, so the calibration harness stays byte-identical. Uses its OWN
   * dedicated rng stream (never the shared society/vote stream) and throttles progress to at most one
   * earning move per beat — the SAME cadence an NPC's own campaign advances at, so pitching many
   * holders in one scene spreads awareness (`knownTo`) but earns no speed advantage.
   *
   * `campaignActors()`/`formCampaigns()` still exclude the player (below) — nothing here EVER
   * autonomously seeds a campaign FOR the player; only their own actual recorded move does.
   */
  foldPlayerCampaignMove(target: EntityId, holder: EntityId): void {
    if (!this.campaignsEnabled) return;
    const beat = this.beatSeqNow();
    const existing = this.campaigns.find((c) => c.owners[0] === PLAYER && c.status === "active");
    const fresh = !existing || existing.target !== target || beat >= existing.deadlineBeat;
    const awardProgress = fresh || this.playerCampaignProgressBeat !== beat;
    this.playerCampaignMoveCount += 1;
    const rng = new SeededRandom(hashSeed(`${this.gameSeed ?? 0}:playerCampaign:${this.playerCampaignMoveCount}`));
    const next = advancePlayerCampaign(existing, PLAYER, target, holder, beat, rng, awardProgress);
    this.campaigns = [...this.campaigns.filter((c) => c.owners[0] !== PLAYER), next];
    if (awardProgress) this.playerCampaignProgressBeat = beat;
  }

  private influenceOf(id: EntityId): Influence {
    const hg = this.house ? (this.house.player.id === id ? this.house.player : this.house.npcs.find((n) => n.id === id)) : undefined;
    return hg?.character.influence ?? { persuasiveness: 0.5, susceptibility: 0.5 };
  }

  /** The summed, character-mediated campaign push on `voter`'s vote against `target` (aware campaigns only). */
  private campaignTiltFor(target: EntityId, voter: EntityId): number {
    let sum = 0;
    for (const c of this.campaigns) {
      if (c.status !== "active" || (c.goal !== "evict" && c.goal !== "protect") || c.target !== target) continue;
      if (!c.knownTo.includes(voter)) continue; // symmetric perspective: only an aware voter is swayed
      const owner = c.owners[0]!;
      // #1937 — THE SCRAMBLE: a `protect` campaign on this nominee counters the `evict` push (spec 0085, campaigns
      // colliding at the vote). The player's own protect campaign is gated by the single switch (CAMPAIGN_PUSH_INCLUDES_PLAYER_OWNED, now on per the 2026-11-03 ruling);
      // a protect owner is the nominee so never reads a self-edge here. The `evict` tilt is exactly as before.
      if (c.goal === "protect") {
        if (owner === voter || (owner === PLAYER && !CAMPAIGN_PUSH_INCLUDES_PLAYER_OWNED)) continue;
        sum -= campaignTilt(c.progress, this.influenceOf(owner).persuasiveness, this.influenceOf(voter).susceptibility, this.rel.edge(owner, voter).trust);
        continue;
      }
      sum += campaignTilt(c.progress, this.influenceOf(owner).persuasiveness, this.influenceOf(voter).susceptibility, this.rel.edge(owner, voter).trust);
    }
    // 0086 ruling #5: the OWN-BALLOT lean — a voter's own LOW (non-promoted) target drive against this
    // nominee nudges THEIR vote only. Skipped if they've already promoted it to a campaign (counted above),
    // so a drive's vote effect is exactly one tier, never additive.
    const drv = this.drives.get(voter);
    if (drv && !this.campaigns.some((c) => c.status === "active" && c.owners[0] === voter && c.target === target)) {
      sum += ownBallotLean(drv, target);
    }
    return sum;
  }

  /** B7 M4 - campaign TARGETS read grudges and beliefs, not only the threat edge (approved tie-in #5). OFF unless exactly `ORWELL_CAMPAIGN_MEMORY=1`; never-flipped. OFF => the raw edge ranking, byte-identical. */
  private campaignMemoryEnabled = flagDefaultOn("ORWELL_CAMPAIGN_MEMORY");
  setCampaignMemoryEnabled(on: boolean): void { this.campaignMemoryEnabled = on; }
  /**
   * B5 - does `actor` still believe the count against `target` is in doubt? Per OTHER living voter (not the actor, the target, or the player's hidden ballot): the true P(votes to evict) is read from
   * that voter's own threat/trust edges toward the target; the actor perceives it with a seeded personality `overconfidence` and a seeded per-(actor, week) noise stream (a DEDICATED sub-rng, never
   * the shared stream). Deterministic; the estimate is private to the actor and never projected.
   */
  /** B37: a stable key of the public board the vote count is read from. Changes when a nominee, the veto holder or the replacement does. */
  private voteInfoEpoch(): string {
    return `${[...(this.ceremony.nominees ?? [])].sort().join(",")}|${this.ceremony.vetoHolder ?? ""}|${this.ceremony.vetoUsed ? 1 : 0}`;
  }
  /** B37 (ORWELL_VOTE_COUNT): campaigns the owner has stopped because their believed count says it is decided (monotonic; observability + tests). */
  private voteCountStops = 0;
  voteCountStopsNow(): number { return this.voteCountStops; }
  private voteStillInDoubt(actor: EntityId, target: EntityId): boolean {
    const voters = this.livingIds().filter((v) => v !== actor && v !== target);
    if (voters.length === 0) return true;
    const trueSupport = voters.map((v) => {
      const e = this.rel.edge(v, target);
      return Math.max(0, Math.min(1, 0.5 + 0.6 * (e.threat - 0.5 * e.trust)));
    });
    const oc = 0.2 + 0.6 * ((hashSeed(`${this.gameSeed ?? 0}:overconfidence:${actor}`) % 1000) / 1000);
    // B37: the noise stream is keyed on the PUBLIC board too (nominees, which already change with a replacement, the veto holder, whether the veto was used), so the estimate is recomputed - a fresh, still reproducible draw - the moment public information changes
    const nrng = new SeededRandom(hashSeed(`${this.gameSeed ?? 0}:votecount:${actor}:${this.live?.week ?? 0}:${this.voteInfoEpoch()}`));
    const noise = voters.map(() => nrng.next() * 2 - 1);
    return inDoubt(believedMargin(trueSupport, oc, noise), voters.length);
  }

  private threatReadsOf(owner: EntityId): Array<{ toward: EntityId; threat: number }> {
    const bend = (id: EntityId): number => {
      if (!this.campaignMemoryEnabled || owner === PLAYER) return 0;
      const mem = this.npcMemoryEnabled ? this.memoryTiltFor(id, owner) : 0;   // + grudge / - favor (the ledger's signed tilt toward acting against `id`)
      const bel = this.npcBeliefNomsEnabled && this.npcBeliefsEnabled ? this.beliefNomTiltFor(id, owner) : 0; // + they are targeting me
      return mem + bel;
    };
    return this.livingIds().filter((id) => id !== owner)
      .map((id) => ({ toward: id, threat: Math.max(0, Math.min(1, this.rel.edge(owner, id).threat + bend(id))) }))
      .sort((a, b) => b.threat - a.threat);
  }

  private allyReadsOf(owner: EntityId): Array<{ toward: EntityId; affinity: number }> {
    return this.livingIds().filter((id) => id !== owner)
      .map((id) => ({ toward: id, affinity: this.rel.edge(owner, id).affinity }))
      .sort((a, b) => b.affinity - a.affinity);
  }

  private campaignActors(): CampaignActor[] {
    return this.livingIds().filter((id) => id !== PLAYER).map((id) => ({
      id, persuasiveness: this.influenceOf(id).persuasiveness,
      threats: this.threatReadsOf(id), allies: this.allyReadsOf(id),
    }));
  }

  /**
   * Advance the live campaign layer one tick (0085 B2) — driven by the orchestrator's per-turn off-screen
   * tick, ONLY when enabled. Prune dead owners, re-plan against the board, form up to the cap, then advance
   * each active campaign one move. Uses a DEDICATED rng (never the shared society/vote stream), and its only
   * effect on the seeded vote is the bounded `campaignTiltFor` provider — it never mutates the relationship
   * edges. No-op (and zero draws) when disabled ⇒ the calibration spine is byte-identical.
   */
  campaignTick(): void {
    if (!this.campaignsEnabled || !this.house) return;
    this.campaignTickCount += 1;
    const rng = new SeededRandom(hashSeed(`${this.gameSeed ?? 0}:campaigns:${this.campaignTickCount}`));
    const beat = this.beatSeqNow();
    const living = new Set(this.livingIds());
    const nominees = new Set(this.ceremony.nominees);
    // Prune campaigns whose owner is gone; re-plan the rest against the live board.
    this.campaigns = this.campaigns
      .filter((c) => living.has(c.owners[0]!))
      // The player's OWN campaign keeps the goal they declared: `replan` re-aims NPC campaigns against the board, but it
      // must not silently turn a player's evict campaign into `protect` them when they are nominated (that would hand
      // the player a free, unearned shield now that `protect` has mechanical effect, #1937).
      .map((c) => c.status === "active" && c.owners[0] !== PLAYER
        ? replan(c, {
            active: living,
            ownerEndangered: nominees.has(c.owners[0]!),
            threats: this.threatReadsOf(c.owners[0]!),
            // The target WON the veto ⇒ safe this week ⇒ an evict campaign re-aims (0085 C).
            targetSafe: this.ceremony.vetoHolder === c.target,
          })
        : c);
    // B37 (ORWELL_VOTE_COUNT, slice 3): ADAPTATION - re-read the believed count for every NPC evict campaign each tick. An owner who now believes the count is decided stops (the campaign is dropped), so an
    // overconfident NPC whose TRUE count differs quits early and is blindsided; if public information changes and the count is in doubt again, formation below re-opens it. Flag off => not entered.
    if (this.voteCountEnabled) {
      this.campaigns = this.campaigns.map((c) => {
        if (c.status !== "active" || c.goal !== "evict" || c.owners[0] === PLAYER || this.voteStillInDoubt(c.owners[0]!, c.target)) return c;
        this.voteCountStops += 1;
        return { ...c, status: "abandoned" as const };
      }).filter((c) => c.status === "active");
    }
    const activeCount = (): number => this.campaigns.filter((c) => c.status === "active").length;
    // Form up to the cap (one active campaign per owner).
    if (activeCount() < CAMPAIGN.maxConcurrent) {
      for (const f of formCampaigns(this.campaignActors(), { rng, beat, ...(this.moodCampaignEnabled && this.npcTellsEnabled ? { steady: (a: EntityId) => this.moodSteady(a) } : {}), ...(this.voteCountEnabled ? { worthWorking: (actor: EntityId, target: EntityId) => this.voteStillInDoubt(actor, target) } : {}) })) {
        if (activeCount() >= CAMPAIGN.maxConcurrent) break;
        if (!this.campaigns.some((c) => c.status === "active" && c.owners[0] === f.owners[0])) this.campaigns.push(f);
      }
    }
    // Advance each active campaign one move (progress + knownTo diffusion), then drop the resolved.
    // EXCLUDES the player's own campaign (Phase 2 of "the player can play offense"): `advanceCampaign`
    // is the AUTONOMOUS off-screen-tick mover — applying it to a player-owned entry would silently
    // grant free progress + knownTo diffusion every tick regardless of whether the player pitched
    // anyone, defeating the per-beat-throttled, pitch-earned design (`foldPlayerCampaignMove`) and the
    // spec's own rule ("no NPC acts on the campaign except in response to the player's actual recorded
    // moves" — this guards the mirror case: nothing autonomously acts FOR the player either).
    this.campaigns = this.campaigns
      .map((c) => c.status === "active" && c.owners[0] !== PLAYER
        ? advanceCampaign(c, { rng, beat, alliesOf: (id) => this.allyReadsOf(id).map((a) => a.toward) })
        // …but a player campaign still EXPIRES at its deadline (no free progress, no diffusion — only the resolution), so a
        // stale entry can't keep pushing nominations / veto saves / votes (now that they are mechanical) or hold a slot.
        : c.status === "active" && beat >= c.deadlineBeat
          ? { ...c, status: c.progress >= 0.5 ? ("won" as const) : ("lost" as const) }
          : c)
      .filter((c) => c.status === "active");
    // 0086: derive EVERY active houseguest's drive this tick (sticky from the prior tick) — the whole house
    // is motivated; only the loudest are campaigns above, the quiet `target` ones add the own-ballot lean.
    const nextDrives = new Map<EntityId, Drive>();
    for (const a of this.campaignActors()) {
      nextDrives.set(a.id, deriveDrive(a, {
        nominated: nominees.has(a.id),
        aggression: ARCHETYPE_AGGRESSION[this.archetypeOf(a.id)] ?? 0.5,
        emotional: this.soulObj(a.id)?.emotionalState ?? 0.5,
      }, this.drives.get(a.id)));
    }
    // 0096 — select (or hold, or hand off) the player's emergent nemesis from the signals just derived:
    // each living NPC's OWN threat-toward-player edge + whether their JUST-DERIVED drive targets the
    // player. PURE, no rng of its own (reads only already-seeded signals) — cannot perturb `rng`'s
    // sequence, so every other draw this tick (campaign formation/advance/alliance-naming below) is
    // byte-identical to before this feature existed. Gated by the same `campaignsEnabled` guard as the
    // rest of this method (unreachable when disabled).
    const nemesisCandidates: NemesisCandidate[] = this.campaignActors().map((a) => {
      const drv = nextDrives.get(a.id);
      return {
        id: a.id,
        threatTowardPlayer: this.rel.edge(a.id, PLAYER).threat,
        targetsPlayer: drv?.motivation === "target" && drv.target === PLAYER,
      };
    });
    this.nemesisTrack = selectNemesis(nemesisCandidates, this.nemesisTrack);
    const nemesis = this.nemesisTrack.current;
    if (nemesis !== undefined) {
      // Escalation bias #1 (0086 drive): hold the nemesis's `target` drive on the player at the UPPER of
      // its existing intensity band — sharpens intensity WITHIN the bound, never past it.
      const drv = nextDrives.get(nemesis);
      if (drv) nextDrives.set(nemesis, { ...drv, intensity: Math.max(drv.intensity, NEMESIS.escalationIntensity) });
      // Escalation bias #2 (0085 campaign): PRIORITIZE an active evict-the-player campaign for the
      // nemesis, under the UNCHANGED `maxConcurrent` cap (never raised). If they already own an active
      // campaign, re-aim it onto the player (a personal obsession displaces whatever else they were
      // pursuing); otherwise seed a fresh one IF the cap allows — never bump another owner's campaign to
      // make room (that would be a new decision path, not a sharpened existing one).
      const existing = this.campaigns.find((c) => c.status === "active" && c.owners[0] === nemesis);
      if (existing) {
        if (existing.goal !== "evict" || existing.target !== PLAYER) {
          this.campaigns = this.campaigns.map((c) => c === existing
            ? { ...c, goal: "evict" as const, target: PLAYER, plan: [...PLAN_FOR.evict], progress: 0 }
            : c);
        }
      } else if (activeCount() < CAMPAIGN.maxConcurrent) {
        const threat = nemesisCandidates.find((cand) => cand.id === nemesis)?.threatTowardPlayer ?? 0;
        this.campaigns.push({
          id: `campaign:${nemesis}:${beat}:nemesis`,
          owners: [nemesis],
          goal: "evict",
          target: PLAYER,
          plan: [...PLAN_FOR.evict],
          progress: 0,
          horizon: "week",
          status: "active",
          startedBeat: beat,
          deadlineBeat: beat + CAMPAIGN.weekBeats,
          confidence: Math.max(0, Math.min(1, threat)),
          knownTo: [nemesis], // owner-only at formation — the symmetric-perspective spine, unchanged
        });
      }
    }
    this.drives = nextDrives;
    // 0107 Phase B: NPCs name alliances off-screen + pitch the player (gated by campaignsEnabled ⇒ the
    // passive calibration harness forms none ⇒ the cement provider stays 0 ⇒ juryReach byte-identical).
    this.formNpcAlliances(rng);
  }

  /**
   * 0107 Phase B — NPCs autonomously NAME alliances off-screen. A `build`-drive (0086) founder over real
   * mutual bonds (the `npcAllyFloor`, higher than the player's pitch floor) names an alliance with their
   * strongest-bonded allies, then PITCHES the player if they're bonded enough (revealing it so the player
   * can accept via `joinAlliance`). Bounded: at most ONE new alliance per tick, one foundership per NPC,
   * deduped by member set. Uses the dedicated campaign rng (seeded). Gated by `campaignTick`'s flag.
   */
  private formNpcAlliances(rng: SeededRandom): void {
    const beat = this.beatSeqNow();
    const npcs = this.livingIds().filter((id) => id !== PLAYER);
    const bondOf = (a: EntityId, b: EntityId): number => (this.rel.edge(a, b).trust + this.rel.edge(a, b).affinity) / 2;
    const mutual = (a: EntityId, b: EntityId): number => Math.min(bondOf(a, b), bondOf(b, a));
    // A founder: a build-drive NPC who hasn't already founded an active alliance.
    const founders = npcs
      .filter((id) => this.drives.get(id)?.motivation === "build" && !this.alliances.all().some((a) => a.founder === id))
      .sort();
    const npcFloor = { ...ALLIANCE, joinBondFloor: ALLIANCE.npcAllyFloor };
    for (const founder of founders) {
      const proposed = npcs
        .filter((m) => m !== founder)
        .sort((a, b) => mutual(founder, b) - mutual(founder, a) || a.localeCompare(b))
        .slice(0, ALLIANCE.maxNpcSize - 1);
      const willing = willingMembers(founder, proposed, (m) => mutual(founder, m), npcFloor);
      if (willing.length < 2) continue; // nobody bonded enough — no alliance this tick
      if (this.alliances.all().some((a) => sameMembers(a.members, willing))) continue; // dedup
      const name = pickAllianceName(rng, new Set(this.alliances.all().map((a) => a.name)));
      const a = this.alliances.add(name, founder, willing, beat);
      // Pitch the player: a founder bonded enough reveals the alliance so the player can accept it.
      if (mutual(founder, PLAYER) >= ALLIANCE.pitchPlayerFloor) this.alliances.reveal(a.id, PLAYER);
      this.persist();
      return; // one new alliance per tick (bounded)
    }
  }

  /**
   * 0100 — advance the sequestered JURY HOUSE one bounded stretch: the last-nine evictees keep living
   * (hidden juror↔juror scenes) and a grievance one juror carried out DIFFUSES to others, hardening the
   * room's read of the responsible houseguest before the finale. Called once per off-screen tick by the
   * orchestrator, AFTER all main-house society/gossip work, passing the live `events`/`knowledge`.
   *
   * SELF-GATED (the `campaignTick` discipline): a no-op (ZERO draws, no grudge) unless the layer is
   * enabled AND a jury already exists — so with the flag off the seeded `juryReach`/UAT spine is
   * byte-identical. Runs on a DEDICATED, isolated rng (forked off the game seed + the jury-house tick
   * counter, NEVER the orchestrator's shared society/competition/vote stream), so even ON it never
   * re-phases the main house's seeded outcomes; only the hidden finale lean changes.
   *
   * Vault Wall (mandate #2): records ONLY hidden events (witness set = the two jurors, EXCLUDES the
   * player — the player is not in the jury house) and folds the grudge into the SEPARATE, saturated
   * `live.juryGrudge` map the finale reads — never a player- or admin-visible number, never a live edge.
   */
  juryHouseTick(events: EventStore, knowledge: KnowledgeService): void {
    if (!this.juryHouseEnabled || !this.house || !this.live) return;
    // The jury is exactly the last-nine evictees (0014/0045). The jury house models the NPC jurors only —
    // the player forms their OWN read (ADR 0003 / 0086 ruling #3), so a player-juror is excluded from the
    // grudge computation (they still EXPERIENCE the jury house as in-character life around them).
    // PO ruling 2026-11-03: the jury house is fully sequestered — ONLY jurors belong in it. Pre-jury evictees
    // go home and never share it (as on the real show). Jury membership is "evicted at or after the jury-start
    // point" (the same rule as `seatOf`), not `slice(-9)` over time — which, while fewer than nine had been
    // evicted, swept the early (pre-jury) evictees in. At the finale the juror set is identical (the last nine).
    const evicted = this.live.evictionOrder ?? [];
    const juryEvictees = evicted.slice(this.juryStartIndex()).filter((id) => id !== this.house!.player.id);
    const jurors = juryEvictees.slice(-9);
    if (jurors.length < 2) return; // sequester hasn't produced a society yet (pre-jury / first juror only)
    // Whom a grudge can matter against: the still-in-the-game houseguests (the potential finalists),
    // INCLUDING the player — jury management cuts both ways (audit A5), so a juror the player blindsided
    // on the way out can sour the room against the PLAYER's own finale. A grievance recorded against an
    // already-evicted houseguest can never reach the finale vote, so only the responsible houseguests
    // still standing are carried here.
    const finalists = this.livingIds();
    // Owner ruling 2026-11-02 (#1922): FAST-FORWARD LIMBO. The jury house advances once per NPC eviction
    // (about once a week), never on every off-screen tick. `juryHouseArrivals` (persisted) counts the
    // evictions already processed — independent of the capped nine-seat roster, so jurors arriving after
    // the ninth still get their stretch — and a double eviction runs both owed stretches.
    // Wait for the eviction to FINISH: the evictee joins `evictionOrder` when the votes are read, but the
    // goodbye messages and exit interview (which set `mannerByEvictee`, the grievance a stretch spreads) come
    // after. Running the arrival's stretch only once the stage has closed lets a cold goodbye count (#1932).
    if (this.live.eviction) return;
    const arrivals = juryEvictees.length + (this.live.juryReturns ?? 0); // a pre-jury eviction is not an arrival: nobody joined the jury house; a battle-back returnee ARRIVED once already
    // A save that counted pre-jury evictions as arrivals is AHEAD of the juror count. Pull it back to one short, so
    // the newest juror's stretch is played (once) under the correct membership instead of being skipped; after that
    // the counters are equal and this never fires again.
    // (A battle-back returnee leaves `evictionOrder`, so the target adds them back via `live.juryReturns` below — the persisted counter is never lowered for one.)
    if (this.juryHouseArrivals !== null && this.juryHouseArrivals > arrivals) this.juryHouseArrivals = Math.max(0, arrivals - 1);
    if (this.juryHouseArrivals === null) {
      // A fresh game starts from zero. A pre-limbo save (its rng counter advanced every tick, no arrival
      // marker) is treated as caught up to now, so the NEXT eviction resumes the jury house normally.
      this.juryHouseArrivals = this.juryHouseTickCount > 0 ? arrivals : 0;
    }
    while (this.juryHouseArrivals < arrivals) {
      this.juryHouseArrivals += 1;
      // The first evictee has nobody to talk to yet; every later arrival plays one short stretch.
      if (this.juryHouseArrivals >= 2) this.juryHouseStretch(events, knowledge, jurors, finalists);
    }
  }

  /** One 0100 jury-house stretch (one new juror's arrival): 1–3 hidden juror scenes + a week's grievance
   *  retelling, folded into the saturated per-(juror, finalist) grudge the finale reads. */
  private juryHouseStretch(
    events: EventStore,
    knowledge: KnowledgeService,
    jurors: EntityId[],
    finalists: EntityId[],
  ): void {
    if (!this.live) return;
    this.juryHouseTickCount += 1;
    // DEDICATED stream — zero touch to the orchestrator's shared per-user rng (the calibration spine).
    const rng = new SeededRandom(hashSeed(`jury-house:${this.gameSeed ?? ""}:${this.juryHouseTickCount}`));
    const { min, max } = JURY_HOUSE.scenesPerArrival;
    const result = runJuryHouseStretch({
      events,
      rng,
      knowledge,
      scenes: min + rng.int(max - min + 1),
      rounds: JURY_HOUSE.roundsPerArrival,
      jurors,
      edgeOf: (a, b) => this.rel.edge(a, b),
      mannerOf: (juror, finalist) => this.live!.mannerByEvictee?.[juror]?.[finalist] ?? {},
      finalists,
    });
    // Fold the bounded grudge increments into the persisted per-(juror, finalist) accumulator: MONOTONIC
    // (grudges only deepen) and SATURATED (clamped to the cap), so a restored game resumes with the
    // accumulated bitterness intact and a grudge can never run away over a long sequester (0007/#4).
    if (result.grudges.length > 0) {
      const map = (this.live.juryGrudge ??= {});
      for (const g of result.grudges) {
        const row = (map[g.juror] ??= {});
        row[g.finalist] = Math.min(JURY_HOUSE.adjustmentCap, (row[g.finalist] ?? 0) + g.delta);
      }
    }
    // #1790 AC1 — TRAITORS' FURY: route the POSSIBLY-WRONG deduced blame into each juror's knowledge,
    // then diffuse it through the jury-house gossip graph as named-blame grievance. FLAG-GATED: with the
    // flag OFF this entire block is a no-op (zero draws, zero beliefs, zero diffuse) — byte-identical.
    // CRITICAL (calibration): the blame diffusion below passes NO `rel` and NO `subjects` to
    // `diffuseGossip` (content-only, zero edge fold) and reuses the already-established dedicated
    // jury-house rng — so it adds ZERO new fold weight and ZERO shared-rng draws. The belief is seeded
    // into a JUROR's knowledge (an NPC), NEVER the player. The jury-house diffusion graph has NO player
    // node (constructed above by `jurors` filter + the `juryHouse.runJuryHouseStretch` graph) — verify
    // nothing routes a pathway to the player. The suspicion/confidence numbers stay in
    // `DeducedVoters.perVoter` (engine-only), never seeded into the belief.
    if (this.traitorsFuryEnabled && this.live.deducedCulprits) {
      const nameOf = (id: EntityId): string => this.nameOf(id);
      // Build the jury-house social graph for blame diffusion — same structure as runJuryHouseStretch
      // (jurors only, NO player node). Reuse the existing `rel` edge reader.
      const rel = { edge: (a: EntityId, b: EntityId) => this.rel.edge(a, b) };
      const graphEdges: Array<readonly [EntityId, EntityId]> = [];
      for (let i = 0; i < jurors.length; i++) {
        for (let j = i + 1; j < jurors.length; j++) {
          if (gossipEdgeAffinity(rel, jurors[i]!, jurors[j]!) > JURY_HOUSE.affinityEdge) {
            graphEdges.push([jurors[i]!, jurors[j]!] as const);
          }
        }
      }
      const graph = makeSocialGraph(graphEdges);
      // For each evicted juror who has a deduced-culprit record, seed the blame belief and diffuse
      for (const juror of jurors) {
        const culprits = this.live.deducedCulprits[juror];
        if (!culprits || culprits.length === 0) continue;
        // Resolve culprit ids to names for Vault-free prose; NO numbers cross.
        const culpritNames = culprits.map((id) => nameOf(id)).join(", ");
        // A stable per-(juror, culprit) factId — deterministic lineage so diffusion reunites itself.
        // Uses the evictee id + a dedup salt so the factId is collision-free across jurors.
        const factBase = `traitors-fury:blame:${juror}`;
        const content = `${nameOf(juror)} believes ${culpritNames} turned on them in the eviction vote`;
        for (const culprit of culprits) {
          const factId = `${factBase}:${culprit}`;
          // Seed the belief into the JUROR's own knowledge (NPC, NEVER the player).
          knowledge.seedBelief(
            juror,
            {
              content,
              factId,
              source: juror,
              hops: 0,
              distortion: 0,
              confidence: 1,
            },
            `jury-house:blame:${juror}`,
          );
        }
        if (graphEdges.length === 0) continue;
        // Diffuse through the jury-house gossip graph: content-only, NO `rel`/`subjects` — same
        // calibration-discipline as the grievance diffusion in runJuryHouseStretch. Uses the dedicated
        // jury-house rng so it adds zero shared-rng draws.
        diffuseGossip({
          knowledge,
          graph,
          rng,
          origin: juror,
          fact: { content },
          rounds: JURY_HOUSE.rounds,
          transmitProb: JURY_HOUSE.transmitProb,
          decay: JURY_HOUSE.decay,
        });
      }
    }
  }

  /** Turn the JURY-HOUSE grudge layer on/off (0100). Off by default — the calibration harness leaves it off
   *  (with it off no stretch runs ⇒ zero draws ⇒ the seeded spine is byte-identical). */
  setJuryHouseEnabled(on: boolean): void { this.juryHouseEnabled = on; }

  /** Whether the jury-house layer is live (0100) — exposed for the orchestrator's wiring symmetry/tests. */
  juryHouseEnabledNow(): boolean { return this.juryHouseEnabled; }


  /** Turn the TRAITORS'-FURY juror-bearing word layer on/off (#1790). Off by default — the
   *  calibration harness leaves it off (with it off bearingWord returns "settled" constantly,
   *  consuming zero rng, so the seeded spine is byte-identical). */
  setTraitorsFuryEnabled(on: boolean): void { this.traitorsFuryEnabled = on; }

  /** Whether the traitors'-fury layer is live (#1790) — exposed for the orchestrator's wiring
   *  symmetry/tests. */
  traitorsFuryEnabledNow(): boolean { return this.traitorsFuryEnabled; }

  /** Turn the Producer Read exchange-accounting beat on/off (#1792). OFF by default — with it
   *  off the sink is never wired ⇒ nothing computed ⇒ byte-identical. */
  setProducerReadEnabled(on: boolean): void { this.producerReadEnabled = on; }

  /** Whether the Producer Read is live (#1792) — exposed for the orchestrator's wiring
   *  symmetry/tests. */
  producerReadEnabledNow(): boolean { return this.producerReadEnabled; }

  /** Turn formation-witness deal collateral on/off (#1802). ON by default (2026-11 flip). */
  setDealsWitnessesEnabled(on: boolean): void { this.dealsWitnessesEnabled = on; }

  /** Whether formation-witness deal collateral is live (#1802) — exposed for tests. */
  dealsWitnessesEnabledNow(): boolean { return this.dealsWitnessesEnabled; }

  /** Turn Booth Has Receipts on/off (#1800). ON by default (2026-11 flip). */
  setBoothReceiptsEnabled(on: boolean): void { this.boothReceiptsEnabled = on; }
  setPlayerDossierEnabled(on: boolean): void { this.playerDossierEnabled = on; }
  playerDossierEnabledNow(): boolean { return this.playerDossierEnabled; }

  /** Whether Booth Has Receipts is live (#1800) — exposed for tests. */
  boothReceiptsEnabledNow(): boolean { return this.boothReceiptsEnabled; }

  /** Turn NPC deal consent on/off (ON by default). OFF => every valid player deal is recorded as before. */
  setNpcDealConsentEnabled(on: boolean): void { this.npcDealConsentEnabled = on; }
  npcDealConsentEnabledNow(): boolean { return this.npcDealConsentEnabled; }
  /**
   * 0101 — NPC MYTH-MAKING: at most once per off-screen tick, mint a LEGEND about a rare, notable player
   * act and let it diffuse NPC-to-NPC exactly like an ordinary rumor (0002/B27b) — see
   * `docs/features/0101-npc-myth-making.md`. Called once per off-screen tick by the orchestrator, AFTER
   * the main-house gossip pass, passing the live `events`/`knowledge`.
   *
   * SELF-GATED (the `campaignTick`/`juryHouseTick` discipline): a no-op (ZERO draws) unless the layer is
   * enabled, so the calibration/UAT harness — which never enables it — is byte-identical. Runs on a
   * DEDICATED, isolated rng (forked off the game seed + this tick's OWN counter, never the orchestrator's
   * shared society/competition/vote stream). Applies NO relationship fold — `diffuseGossip` is called with
   * neither `rel` nor `subjects` — so a legend never moves any NPC's read of the player and never folds the
   * player's own edges (mandate #3 / ADR 0003 — the human forms their own read); this also makes the pass
   * calibration-neutral BY CONSTRUCTION even while ON (only the hidden knowledge layer changes, never a
   * relationship edge). The per-season cap (`LEGEND.maxPerSeason`) and the notable-act watermark
   * (`legendLastActTick`, so a used act is never re-picked) are enforced here.
   */
  legendTick(events: EventStore, knowledge: KnowledgeService): void {
    if (!this.mythMakingEnabled || !this.house) return;
    if (this.legendCount >= LEGEND.maxPerSeason) return;
    this.legendTickCount += 1;
    const rng = new SeededRandom(hashSeed(`legend:${this.gameSeed ?? ""}:${this.legendTickCount}`));
    if (rng.next() >= LEGEND.seedProb) return; // rare — most ticks mint nothing
    const playerName = this.house.player.name;
    const acts = notablePlayerActs(events.query({ witnessedBy: PLAYER }), playerName, this.legendLastActTick);
    if (acts.length === 0) return;
    const act = rng.pick(acts);
    this.legendLastActTick = act.ts; // never re-pick an act already turned into a legend
    const living = this.livingIds().filter((id) => id !== PLAYER);
    if (living.length === 0) return;
    // The origin earwitness (0101 open question #4): a houseguest CURRENTLY co-present with the player if
    // one exists (a real first source), else a seeded pick from the living house — never invented content.
    const occ = this.societyOccupancy();
    const room = occ?.get(PLAYER);
    const coPresent = room ? living.filter((id) => occ!.get(id) === room) : [];
    const origin = coPresent.length > 0 ? rng.pick(coPresent) : rng.pick(living);
    const everyone: EntityId[] = [PLAYER, ...living];
    const edges: Array<readonly [EntityId, EntityId]> = [];
    for (let i = 0; i < everyone.length; i++) {
      for (let j = i + 1; j < everyone.length; j++) {
        if (gossipEdgeAffinity(this.rel, everyone[i]!, everyone[j]!) > GOSSIP.affinityEdge) {
          edges.push([everyone[i]!, everyone[j]!] as const);
        }
      }
    }
    if (edges.length === 0) return;
    // NO `rel` / `subjects` passed (0101 open question #3, v1): a legend never folds ANY edge — not the
    // player's own reads, not any NPC's read of the player — only the belief itself diffuses/distorts.
    diffuseGossip({
      knowledge, graph: makeSocialGraph(edges), rng, origin,
      fact: { content: legendFrom(act.actClass) },
      rounds: GOSSIP.rounds, transmitProb: GOSSIP.transmitProb, decay: GOSSIP.decay,
    });
    this.legendCount += 1;
  }

  /** Turn NPC myth-making on/off (0101). Off by default — the calibration harness leaves it off (with it
   *  off `legendTick` draws nothing and mints no legend ⇒ the seeded spine is byte-identical). */
  setMythMakingEnabled(on: boolean): void { this.mythMakingEnabled = on; }

  /** Whether the myth-making layer is live (0101) — exposed for the orchestrator's wiring symmetry/tests. */
  mythMakingEnabledNow(): boolean { return this.mythMakingEnabled; }

  /**
   * Feature 0101 (#1401) — the AI SHOWRUNNER pass. Runs ONCE per bounded off-screen tick, BEFORE
   * `scheduleStoryThreads`, and writes a Vault-held "producer note" proposing which SIMMERING hidden story
   * threads the next tick's 0060 surfacing should EMPHASIZE. It is the "the season has an arc" layer: a
   * short shortlist of the most dramatic / most overdue / most board-topical threads, each with a bounded,
   * boost-only `emphasis` multiplier (ADR 0005 — SHAPE only; the schema makes an outcome directive
   * inexpressible; the engine keeps every magnitude and the hard 0060 caps still bind).
   *
   * MANDATE (both proven by the boundary tests):
   *  • VAULT-HELD — the note is stored in `showrunnerNotes` (this engine-only session core, like
   *    `storyThreads`), so it reaches NO player/admin projection; it unseals only in the 0048
   *    retrospective (`buildVaultUnseal`).
   *  • CLOSED-SET NEUTRAL — this pass draws NO rng at all (pure scoring), and the scheduler it biases runs
   *    on per-thread SIDE rngs (keyed by thread id, never the shared stream). So with the flag ON *or* OFF
   *    the seeded competition / eligibility / vote stream is BYTE-IDENTICAL. DEFAULT OFF ⇒ nothing composed.
   *
   * ONCE-PER-BEAT: a note already composed for the current (week, phase) is reused — the same cadence the
   * scheduler rolls at — so the bible stays bounded (~one per ceremony beat), append-only, and stable
   * within a beat (consumption is stable across the beat's aux ticks). NO `persist()` here: it rides the
   * orchestrator's bounded tick, whose own commit exports + persists the snapshot (R3/spineHardening).
   */
  showrunnerTick(): void {
    // EITHER sub-flag composes a note: Phase-1 (`showrunnerEnabled`) for the fold-free to-player routing,
    // OR Phase-2 (`showrunnerReweightEnabled`), which cannot re-order the scheduler without a note. Both
    // off ⇒ nothing composed (byte-identical to pre-0101).
    if ((!this.showrunnerEnabled && !this.showrunnerReweightEnabled) || !this.house || this.storyThreads.length === 0) return;
    const last = this.showrunnerNotes[this.showrunnerNotes.length - 1];
    if (last && last.week === this.week && last.phase === this.phase) return; // one note per beat
    const pos = this.seasonPosition();
    // Score every SIMMERING (dormant/active) thread. Signals are all VAULT-FREE: `tension` from the
    // engine's own both-way player↔source edges, `staleness` from the thread's `active`/`dormant` age,
    // `salience` from the Vault-free board position (nominated / cornered / holding power) — NEVER a
    // premise, NEVER a raw hidden number crosses into the note. Pure: this loop draws no rng.
    const signals: ThreadSignal[] = [];
    for (const t of this.storyThreads) {
      if (t.status !== "dormant" && t.status !== "active") continue;
      const reads = relationshipReads(this.rel.edge(PLAYER, t.sourceId), this.rel.edge(t.sourceId, PLAYER));
      const weeksSince = Math.max(0, this.week - (t.lifecycleWeek ?? this.week));
      const staleness = Math.min(1, weeksSince / SHOWRUNNER.stalenessSpanWeeks);
      const salience = pos.nominees.has(t.sourceId) || pos.cornered.has(t.sourceId) || pos.powerHolders.has(t.sourceId) ? 1 : 0;
      signals.push({ threadId: t.id, tension: reads.tension, staleness, salience });
    }
    if (signals.length === 0) return;
    this.showrunnerNoteCount += 1;
    this.showrunnerNotes.push(composeShowrunnerNote(signals, this.week, this.phase, this.showrunnerNoteCount));
  }

  /** The freshest producer note the scheduler should consult — or `undefined` when the layer is off / no
   *  note yet (⇒ the scheduler falls back to the unchanged derive order + baseline `surfaceProb`). */
  private currentShowrunnerNote(): ShowrunnerNote | undefined {
    // The reweight IMPLIES note composition (you cannot re-weight without a note), so either sub-flag
    // exposes the freshest note. Both off ⇒ undefined (the scheduler falls back to the derive order).
    if (!this.showrunnerEnabled && !this.showrunnerReweightEnabled) return undefined;
    return this.showrunnerNotes[this.showrunnerNotes.length - 1];
  }

  /** Turn the AI showrunner on/off (0101/#1401). Off by default — the calibration harness leaves it off
   *  (with it off `showrunnerTick` composes nothing and the scheduler is byte-identical). */
  setShowrunnerEnabled(on: boolean): void { this.showrunnerEnabled = on; }

  /** Whether the showrunner layer is live — exposed for the orchestrator's wiring symmetry / tests. */
  showrunnerEnabledNow(): boolean { return this.showrunnerEnabled; }

  /**
   * 0101/#1401 Phase-2 (#1455) — the PROCESS-GLOBAL override for the OUTCOME-AFFECTING reweight, mirroring
   * `secretPacing`/`seededTieSurfacing` exactly (null ⇒ fall through to the env default). A static (not a
   * per-instance) override so a calibration ON-run flips it ONCE for every session it plays, and so a live
   * deploy that env-enables it needs no restart to toggle. A test resets it to `null` in `afterEach`/
   * `afterAll` so it never leaks across files. */
  private static showrunnerReweightOverride: boolean | null = null;

  /** Set the process-global reweight override (true/false), or `null` to fall back to the env default. */
  static setShowrunnerReweightEnabled(enabled: boolean | null): void {
    GameSessionAdapter.showrunnerReweightOverride = enabled;
  }

  /** The resolved reweight state: the process-global override when set, else the `ORWELL_SHOWRUNNER_REWEIGHT`
   *  env default. Off by default ⇒ the scheduler never re-orders (byte-identical to today AND to Phase-1). */
  private get showrunnerReweightEnabled(): boolean {
    if (GameSessionAdapter.showrunnerReweightOverride !== null) return GameSessionAdapter.showrunnerReweightOverride;
    return SHOWRUNNER_REWEIGHT_ENABLED_DEFAULT;
  }

  /** Whether the Phase-2 reweight is live — exposed for the orchestrator's wiring symmetry / tests. */
  showrunnerReweightEnabledNow(): boolean { return this.showrunnerReweightEnabled; }

  /** The monotonic per-season count of ticks the reweight actually re-ordered the scheduler (0 when off /
   *  never non-trivially re-ordered) — exposed so the ON calibration run can assert non-vacuousness. */
  showrunnerReweightCountNow(): number { return this.showrunnerReweightCount; }

  /** The Vault-held production bible so far (0101/#1401) — engine-only; exposed for the boundary tests
   *  and the 0048 render. NEVER call from a player/admin projection (it IS the sealed producer notes). */
  showrunnerNotesForUnseal(): readonly ShowrunnerNote[] { return this.showrunnerNotes; }

  /**
   * 0099 (hidden half) — the off-screen NPC↔NPC SECRET BARTER: once per bounded off-screen tick, an NPC
   * holding learned secret(s) ABOUT houseguests SPENDS its TOP one — the (secret, recipient) pair a
   * co-house recipient values MOST (issue #1438: the top-valued secret, never the lexicographically-first
   * `factId`), so information becomes liquid in the hidden layer (secrets visibly move; a bond firms for no
   * public reason; the player can be outmaneuvered in the economy). It REUSES the existing 0099 value core
   * verbatim — `tradeValue` + the `SECRET_TRADE` rate/floor (`src/engine/leverage.ts`) — driven
   * on a tick; it is NOT a new secrets system. The traded belief enters the recipient's HIDDEN knowledge
   * through the existing NPC→NPC diffusion pathway (`transmitGossip` — a recorded `told-by:` event whose
   * witness set is {giver, recipient} and EXCLUDES the player), and reaches the player ONLY if a later
   * pathway (overhear/gossip, 0002/0094) terminates at them. Called once per off-screen tick by the
   * orchestrator, AFTER the main-house society/gossip pass, passing the live `events`/`knowledge`.
   *
   * SELF-GATED (the `juryHouseTick`/`legendTick` discipline): a STRUCTURAL no-op (ZERO draws, no counter
   * advance) unless the layer is enabled AND some holder actually holds a tradeable secret — so the
   * calibration/UAT harness (which never enables it, and whose off-screen society mints only subject-LESS
   * gossip/overhear beliefs) is byte-identical. Runs on a DEDICATED, isolated rng (forked off the game
   * seed + this tick's OWN counter, NEVER the orchestrator's shared society/competition/vote stream), and —
   * exactly like `legendTick` — folds NO relationship edge (only the hidden KNOWLEDGE layer changes), so
   * the seeded competition/vote/jury spine is byte-identical whether the layer is OFF or ON. Bounded:
   * ≤ `SECRET_BARTER.maxBartersPerTick` transfers over ≤ `SECRET_BARTER.maxHoldersPerTick` holders, in
   * deterministic sorted order.
   *
   * Vault Wall (mandate #2): the barter is off-screen NPC content — the transfer event's witness set
   * excludes the player, so it never lands on any player OR admin projection; it surfaces to the player
   * only via an existing modeled pathway, never as a Vault read (`tests/unit/secretBarter.test.ts` sentinel).
   */
  secretBarterTick(events: EventStore, knowledge: KnowledgeService): void {
    if (!this.secretBarterEnabled || !this.house) return;
    void events; // the transfer records THROUGH `knowledge` (transmitGossip) — the store is the caller's contract
    const npcs = this.livingIds().filter((id) => id !== PLAYER);
    if (npcs.length < 2) return; // nobody to trade between
    // A holder's TRADEABLE secrets: a learned belief ABOUT a still-active NPC houseguest (never themselves,
    // never the player — a player-subject belief rides the ordinary PV1/gossip path, not a barter). Stable
    // key order so the dedicated draw sequence is reproducible.
    const tradeableOf = (holder: EntityId) =>
      knowledge.knownTo(holder)
        .filter((k) => {
          const subj = k.subject;
          return subj !== undefined && subj !== holder && subj !== PLAYER && this.isActiveNpc(subj);
        })
        .sort((a, b) => (a.factId ?? a.id).localeCompare(b.factId ?? b.id));
    // Holders with something to spend, in deterministic order, capped for work. A tick with NOTHING to
    // trade returns BEFORE advancing the dedicated stream — a true no-op (the byte-identity spine).
    const holders = [...npcs].sort()
      .filter((h) => tradeableOf(h).length > 0)
      .slice(0, SECRET_BARTER.maxHoldersPerTick);
    if (holders.length === 0) return;
    // DEDICATED stream — zero touch to the orchestrator's shared per-user rng (the calibration spine).
    this.secretBarterTickCount += 1;
    const rng = new SeededRandom(hashSeed(`secret-barter:${this.gameSeed ?? ""}:${this.secretBarterTickCount}`));
    let barters = 0;
    for (const holder of holders) {
      if (barters >= SECRET_BARTER.maxBartersPerTick) break;
      // ONE seeded rate roll gates the holder this tick (the existing per-holder decision — drawn FIRST so
      // the dedicated stream advances identically whether or not any secret qualifies). Then, over EVERY
      // tradeable secret × its candidate recipients, keep the STRICT argmax of `tradeValue` above the floor
      // (issue #1438): the holder spends its TOP-valued (secret, recipient), NOT the lexicographically-first
      // `factId`. A holder with a single tradeable secret is byte-identical to the prior single-scan path.
      const fires = rng.next() < SECRET_TRADE.barterRate;
      let bestValue: number = SECRET_TRADE.barterValueFloor;
      let bestSecret: ReturnType<typeof tradeableOf>[number] | undefined;
      let bestRecipient: EntityId | undefined;
      for (const secret of tradeableOf(holder)) {
        const key = secret.factId ?? secret.id;
        const subject = secret.subject!;
        // Severity is the SUBJECT's PUBLIC headline-secret class (never its sealed text) — the SAME
        // resolution the player-side trade uses (`resolveWieldedSecret`), reused, not re-invented.
        const subjectNpc = this.house.npcs.find((n) => n.id === subject);
        const severity = severityOf(subjectNpc ? this.headlineSecretOf(subjectNpc)?.kind : undefined);
        // Candidate recipients: still-active NPCs, not the holder, not the secret's own subject, who do NOT
        // already hold this belief (a barter WIDENS who knows). Deterministic order.
        const candidates: BarterCandidate[] = npcs
          .filter((r) => r !== holder && r !== subject
            && !knowledge.knownTo(r).some((k) => (k.factId ?? k.id) === key))
          .sort()
          .map((r) => ({ recipient: r, signals: this.barterSignalsFor(r, subject, holder, severity) }));
        // Score each candidate with the EXISTING 0099 `tradeValue` (no new value math); carry the running
        // best over the floor across ALL of the holder's secrets, not just the first secret's recipients.
        for (const c of candidates) {
          const v = tradeValue(c.signals, rng);
          if (v > bestValue) { bestValue = v; bestSecret = secret; bestRecipient = c.recipient; }
        }
      }
      if (!fires || bestSecret === undefined || bestRecipient === undefined) continue;
      // Transfer the chosen secret NPC→NPC through the EXISTING diffusion pathway (0002/0094): a recorded
      // `told-by:` gossip event witnessed by {giver, recipient} — hidden (the player is not a witness),
      // reaching the player only if a later pathway terminates at them. The belief keeps its lineage
      // (`factId`), gains a hop, and carries the giver's own (bounded) certainty forward.
      const chosenSubject = bestSecret.subject!;
      knowledge.transmitGossip(
        holder, bestRecipient,
        {
          content: bestSecret.content,
          factId: bestSecret.factId ?? bestSecret.id,
          originalContent: bestSecret.originalContent ?? bestSecret.content,
          confidence: bestSecret.confidence ?? 1,
          source: holder,
          hops: (bestSecret.hops ?? 0) + 1,
          ...(chosenSubject !== undefined ? { subject: chosenSubject } : {}),
        },
        `told-by:${holder}`,
      );
      this.secretBarterCount += 1; // monotonic — a secret has been spent into the hidden economy (non-degradation #4)
      barters += 1;
    }
  }

  /**
   * 0099 (hidden half) — assemble the Vault-hidden `tradeValue` signals for an NPC↔NPC barter: the
   * RECIPIENT's reads of the secret's SUBJECT (do they want leverage on / are they threatened by them?)
   * plus the recipient's trust of the GIVER as the source (a distrusted source's offer is discounted —
   * the `recipientTrustOfPlayer` field is the source-trust slot, which for a barter is the giver, not the
   * player). Reuses the SAME `TradeSignals` shape the player-side trade fills — no new value math.
   */
  private barterSignalsFor(recipient: EntityId, subject: EntityId, giver: EntityId, severity: number): TradeSignals {
    const toSubject = this.rel.edge(recipient, subject);
    return {
      severity,
      recipientThreatOfSubject: toSubject.threat,
      recipientAffinityForSubject: toSubject.affinity,
      recipientTrustOfPlayer: this.rel.edge(recipient, giver).trust, // source-trust slot — the giver, for a barter
    };
  }

  /** Turn the off-screen SECRET BARTER on/off (0099). Off by default — the calibration harness leaves it
   *  off (with it off `secretBarterTick` returns before any draw ⇒ the seeded spine is byte-identical). */
  setSecretBarterEnabled(on: boolean): void { this.secretBarterEnabled = on; }

  /** Whether the off-screen secret-barter layer is live (0099) — exposed for the orchestrator's wiring
   *  symmetry/tests. */
  secretBarterEnabledNow(): boolean { return this.secretBarterEnabled; }

  /** Turn CHARACTER-MEDIATED gossip drift on/off (issue #1397). Off by default — the calibration harness
   *  leaves it off; even ON the drift rides a per-hop fork, so the seeded outcome draw stream is byte-
   *  identical either way (the flag gates only whether the reteller's voice colors the belief content). */
  setGossipDriftEnabled(on: boolean): void { this.gossipDriftEnabled = on; }

  /** Whether voice-mediated gossip drift is live (issue #1397) — the orchestrator reads this to decide
   *  whether to hand `diffuseGossip` a `voiceOf` resolver. */
  gossipDriftEnabledNow(): boolean { return this.gossipDriftEnabled; }

  /**
   * #2017 S0b-2 — the observer the orchestrator hands `diffuseGossip` so each E44 receipt fold is recorded as a `heard-rumor` belief claim (with the edge delta it absorbed).
   * `undefined` when `ORWELL_NPC_BELIEFS` is off or no season is live ⇒ NO observer ⇒ the gossip call is byte-identical to today. The observer is read-only (the fold,
   * its rng draws and its edge moves are unchanged — proven in beliefProvenance.test.ts); it only appends to the engine-only `live.beliefs` store, which nothing reads yet.
   */
  beliefReceiptObserver(): ((r: { listener: EntityId; subject: EntityId; type: string; confidence: number; delta: EdgeDelta }) => void) | undefined {
    if (!this.npcBeliefsEnabled || !this.live) return undefined;
    const live = this.live;
    return (r) => { recordRumorClaim((live.beliefs ??= {}), r, live.week); };
  }

  /**
   * ORW-37 / B40 - lasting GAME PHILOSOPHIES: each NPC plays one philosophy for the whole game (shark / chaos agent / loyal soldier / protector / social climber), a seeded draw conditioned on their archetype
   * (`philosophy.ts`: most keep their archetype's default, so the table below still describes the modal house; some play against type). The philosophy sets the nomination style they play. ON unless
   * `ORWELL_PHILOSOPHIES=0`; OFF => the archetype table (today's behaviour). Deterministic in (game seed, houseguest id): no shared rng, nothing persisted.
   */
  private philosophiesEnabled = flagDefaultOn("ORWELL_PHILOSOPHIES");
  setPhilosophiesEnabled(on: boolean): void { this.philosophiesEnabled = on; }
  philosophyOf(id: EntityId): GamePhilosophy {
    return drawPhilosophy(this.archetypeReadOf(id) ?? "", hashSeed(`${this.gameSeed ?? 0}:philosophy:${id}`));
  }

  private archetypeOf(id: EntityId): string {
    return this.house?.npcs.find((n) => n.id === id)?.character.archetype ?? "floater";
  }

  private statsOf(id: EntityId): Stats {
    const all = this.house ? [this.house.player, ...this.house.npcs] : [];
    return all.find((h) => h.id === id)?.character.stats ?? { physical: 0.5, mental: 0.5, social: 0.5 };
  }

  /** The houseguest's dynamic soul (player or NPC), or undefined when no game is live. */
  private soulObj(id: EntityId): Soul | undefined {
    if (!this.house) return undefined;
    if (this.house.player.id === id) return this.house.player.soul;
    return this.house.npcs.find((n) => n.id === id)?.soul;
  }

  /**
   * Fold a consequential moment into a houseguest's hidden soul (0041): evolve their emotional state
   * (bounded, mean-reverting — 0028 family) and deepen the recall-able arc (`recordToSoul`, 0024).
   * The static CHARACTER is never touched; only the SOUL drifts (0007). Hidden — never surfaced.
   * Audit E52: the swing carries ADR 0001's bounded per-moment temperature roll on a SIDE rng
   * (keyed off the game seed + the soul's own arc position — deterministic, restart-stable, and
   * the main beat stream is untouched).
   */
  /** 0124 — the STATIC baseline disposition (from the archetype, the CHARACTER value); never drifts (0007). */
  private baselineDispositionOf(id: EntityId): Disposition {
    const hg = this.house
      ? (this.house.player.id === id ? this.house.player : this.house.npcs.find((n) => n.id === id))
      : undefined;
    return hg ? dispositionOf(hg.character.archetype) : "neutral";
  }

  /** C1 (#1788) — the houseguest's byte-stable genesis `CHARACTER` archetype, or `undefined` for an
   *  unknown/departed id. Read-only lookup; never mutates, never crosses the wall (the archetype itself
   *  is already a public genesis facet, not Vault content — see `characterFactory.ts`'s 12-member enum). */
  private archetypeReadOf(id: EntityId): string | undefined {
    const hg = this.house
      ? (this.house.player.id === id ? this.house.player : this.house.npcs.find((n) => n.id === id))
      : undefined;
    return hg?.character.archetype;
  }

  /** 0124 (part B) — the EFFECTIVE disposition: the static baseline bent by the soul's temperament drift when
   *  the layer is on; the plain static baseline otherwise (byte-identical). Never mutates the CHARACTER. */
  private dispositionReadOf(id: EntityId): Disposition {
    const baseline = this.baselineDispositionOf(id);
    const soul = this.soulObj(id);
    return this.soulDepthEnabled && soul ? effectiveDisposition(baseline, soul) : baseline;
  }

  /** 0124 (part A) — the emotional read the behavior layer uses: the COMPOSED axes (confidence lifts,
   *  distress drags) when the layer is on; the plain 0041 `emotionalState` scalar otherwise (byte-identical). */
  private emotionalReadOf(id: EntityId): number {
    const soul = this.soulObj(id);
    if (!soul) return 0.5;
    return this.soulDepthEnabled ? composedEmotion(soul) : soul.emotionalState;
  }

  /** 0124 (part C) — stamp each houseguest's reactivity from their DISPOSITION rather than a flat random draw:
   *  `volatility = VOL_OF[disposition]` (the temperamental swing harder; the same table the player uses) and a
   *  `settleScale` (clash lingers, bond shrugs off). Touches only the SOUL (CHARACTER byte-stable, 0007) and no
   *  rng (draw-preserving). Idempotent; applied only when the layer is on (at cast genesis / when toggled on). */
  private applyDispositionReactivity(): void {
    if (!this.house) return;
    for (const hg of [this.house.player, ...this.house.npcs]) {
      const disp = this.baselineDispositionOf(hg.id);
      hg.soul.volatility = VOL_OF[disp];
      hg.soul.settleScale = settleScaleOf(disp);
    }
  }

  private inflect(id: EntityId, event: EmotionalEvent, driftScale?: number): void {
    const soul = this.soulObj(id);
    if (!soul) return;
    const rng = new SeededRandom(hashSeed(
      `${this.gameSeed ?? this.house?.player.name ?? "season"}:arc:${id}:${event}:${soul.emotionalHistory.length}`,
    ));
    evolveEmotion(soul, event, undefined, rng, { soulDepth: this.soulDepthEnabled, ...(this.driftFixEnabled ? { negativityBias: true, ...(driftScale !== undefined ? { driftScale } : {}) } : {}) });
    if (this.npcTellsEnabled) { const r = refreshTells(soul, this.week); soul.tells = r.tells; this.tellOnsetCount += r.onsets; } // B28: the tells follow the arc and keep their hysteresis (flag-off: untouched)
    const note = arcNote(event, this.week);
    soul.memory.push(note);                 // persisted arc (house snapshot, monotonic — 0007/0030)
    this.soul?.recordToSoul(id, note);       // vector recall index (0024), when wired into the sandbox
  }

  /**
   * L27b — DURABLY record a recorded player-witnessed scene's summary into a houseguest's recall
   * memory. The fix this closes: `recordInteraction` (the player channel's social-scene seam) used to
   * index the summary into the SoulStore's vector index ALONE — which is DERIVED state. After a restart
   * `rebuildSoulIndex` replays only each houseguest's PERSISTED `soul.memory` mirror, so a scene's
   * semantic recall silently vanished on restart (the event record survived, but the NPC could no
   * longer RECALL the scene — a non-degradation #4 / L27b leak). Writing the SAME persisted mirror the
   * arc/confessional/deep-profile paths already use makes the scene recall-able IN FULL forever, across
   * restarts. Idempotent against the mirror: a content already present (e.g. a double restore replay) is
   * not duplicated, so the monotonic-count non-degradation guard stays exact.
   */
  /**
   * F-EN-4 (issue #1562) — a per-array membership cache for the scene-memory dedup, keyed on the
   * `soul.memory` ARRAY REFERENCE. The `!includes(content)` guard below asks exactly the question
   * `.includes` asks ("is this content already in the mirror?"), which was an O(memory) linear scan
   * that grows all season and fires once per witness per scene — twice when the scene carries a
   * rationale (content then rationale, back to back against the SAME ever-growing mirror), so a warm
   * cache turns the second and every subsequent same-witness check into O(1).
   *
   * Byte-identity argument — the cache answers `set.has(content)` iff `soul.memory.includes(content)`:
   *  - The set is (re)built as `new Set(arr)` whenever the cache is absent OR `cache.len !== arr.length`,
   *    so any push through ANOTHER path (arc notes, confessionals, deep-profile authoring) — which
   *    always CHANGES the array length — forces a fresh rebuild from the current array before the next
   *    membership test.
   *  - The single same-length in-place content swap (deep-profile reseal) FIRST reassigns `soul.memory`
   *    to a NEW array via `.slice()` (see the `lastIndexOf`/`[idx] = newNote` site), so it presents as a
   *    brand-new WeakMap key ⇒ a fresh rebuild. There is NO in-place `arr[i] = …` on a RETAINED array
   *    reference anywhere, so a stale set can never silently disagree with its array's contents.
   *  - Our own dedup push mutates the SAME array in place and advances the cached set + len in lockstep.
   * `.includes` tests membership (not multiplicity), so duplicate strings other paths may append are
   * harmless. Result: identical push/skip decisions and identical persisted bytes vs. the linear scan.
   */
  private readonly sceneMemoryIndex = new WeakMap<string[], { set: Set<string>; len: number }>();

  recordSceneMemory(id: EntityId, content: string): void {
    const soul = this.soulObj(id);
    if (soul) {
      const arr = soul.memory;
      let cache = this.sceneMemoryIndex.get(arr);
      if (!cache || cache.len !== arr.length) {
        cache = { set: new Set(arr), len: arr.length };
        this.sceneMemoryIndex.set(arr, cache);
      }
      if (!cache.set.has(content)) {
        arr.push(content);                    // persisted mirror — survives + re-indexes on restore (0030)
        cache.set.add(content);
        cache.len = arr.length;
      }
    }
    this.soul?.recordToSoul(id, content);    // vector recall index NOW (0024), same-session recall
  }

  /**
   * Evolve the involved souls from a just-resolved beat (the live consequence fold, 0041): a comp
   * winner is emboldened and the CONTESTED LOSERS are stung (audit E51 — `comp-loss` finally
   * fires); on an eviction the SURVIVING nominee is emboldened (`survived-vote`, the 0041 beat
   * that never fired) and the evictee's closest surviving ally is blindsided toward distress.
   * Drives the live emotional arc that then modulates later competitions + decisions.
   */
  private evolveFromBeat(ev: BeatEvent): void {
    if (!this.house) return;
    const s = this.live;
    switch (ev.beat) {
      case "hoh-competition": {
        const winner = ev.participants[0];
        if (winner) this.inflect(winner, "comp-win");
        // E51 (`comp-loss`): a loss stings where it was genuinely CONTESTED — the final-3 HOH
        // crown, where each loser just watched their endgame narrow. Losing a 13-player
        // mid-season HOH comp is background noise (folding it for the whole house weekly would
        // also drown every soul's recall in identical filler — the C12/E55 lesson).
        if (winner && s && s.active.length === 3) {
          for (const h of s.active) if (h !== winner) this.inflect(h, "comp-loss");
        }
        break;
      }
      case "nominations": {
        // B51: going on the block rattles a houseguest — distress ▲ — so they carry it INTO the veto
        // comp (their odds dip below their calm baseline). The Luck-replacement modifier, finally live.
        for (const nom of s?.nominees ?? []) this.inflect(nom, "nominated");
        break;
      }
      case "veto-competition": {
        const holder = s?.vetoHolder;
        if (holder) this.inflect(holder, "comp-win");
        // E51: the rest of the six-player field contested and lost (the participants ARE the field).
        for (const h of ev.participants) if (h !== holder) this.inflect(h, "comp-loss");
        break;
      }
      case "veto-ceremony": {
        // A replacement nominee is newly on the block — same rattle (they don't play the veto, but the
        // arc is honest). The original saved nominee's relief isn't modeled here (kept minimal).
        if (s?.replacement) this.inflect(s.replacement, "nominated");
        break;
      }
      case "eviction": {
        const evictee = ev.participants[0];
        if (!evictee) break;
        this.blindsideClosestAlly(evictee);
        // E51: the nominee who sat on the block and SURVIVED is emboldened — the 0041 arc beat.
        const survivor = s?.eviction?.nominees.find((n) => n !== evictee);
        if (survivor) this.inflect(survivor, "survived-vote");
        break;
      }
    }
  }

  /** Only a genuine ally (trust above this floor) is blindsided by an eviction — else it was expected. */
  private static readonly ALLY_TRUST_FLOOR = 0.5;

  /** The evictee's most-trusting surviving ally reads the eviction as a blindside (distress ▲, volatility ▲). */
  private blindsideClosestAlly(evictee: EntityId): void {
    const s = this.live;
    if (!s) return;
    let ally: EntityId | undefined;
    let best = GameSessionAdapter.ALLY_TRUST_FLOOR;
    for (const h of s.active) {            // s.active already excludes the just-removed evictee
      if (h === evictee) continue;
      const trust = this.rel.edge(h, evictee).trust;
      if (trust > best) { best = trust; ally = h; }
    }
    if (ally) this.inflect(ally, "blindside");
  }

  /** Deepen a houseguest's soul from an off-screen scene (0038/0041): the house lives between turns.
   *  Role-correct per audit E50: the INITIATOR of a betrayal is scheming, not wounded. */
  recordOffscreenSoul(npc: EntityId, type: InteractionType): void {
    this.inflect(npc, offscreenEmotion(type, "initiator"));
  }

  /**
   * Deepen BOTH participants of an off-screen scene, per role (audit E50): the betrayal victim's
   * soul finally moves (`betrayed`) while the betrayer schemes. The full-scene sibling of
   * `recordOffscreenSoul` — the off-screen tick should prefer this seam.
   */
  recordOffscreenScene(initiator: EntityId, partner: EntityId, type: InteractionType): void {
    this.inflect(initiator, offscreenEmotion(type, "initiator"));
    this.inflect(partner, offscreenEmotion(type, "partner"));
    // 0066 Phase-2 (Extension 2): a conflict drains BOTH ⇒ they turn in earlier tonight. Gated on the
    // dedicated social-fatigue flag (and the clock) — the tally is read by `effectiveBedDepth`; off ⇒
    // never populated ⇒ no effect on who's awake or any deficit ⇒ byte-identical.
    if (this.socialFatigueEnabled && this.timeOfDayEnabled && this.live?.timeOfDay && (type === "conflict" || type === "betrayal")) {
      this.nightConflicts.set(initiator, (this.nightConflicts.get(initiator) ?? 0) + 1);
      this.nightConflicts.set(partner, (this.nightConflicts.get(partner) ?? 0) + 1);
    }
  }

  /** The manner-scale of an eviction fold (audit E48): full shock only for a genuine grievance. */
  private static mannerScale(m: EvictionManner): number {
    if (m.betrayed) return EVICTION_MANNER_SCALE.betrayed;
    if (m.blindsided) return EVICTION_MANNER_SCALE.blindsided;
    if (m.disrespected) return EVICTION_MANNER_SCALE.disrespected;
    return EVICTION_MANNER_SCALE.respected;
  }

  /**
   * Fold the hidden relationship consequence of a resolved ceremony beat (B38/audit C1 — the 0023
   * backbone that the live loop bypassed). Engine-owned, directed, magnitudes from `CEREMONY_IMPACTS`
   * (constants only). The change lives in the hidden layer — the player feels it later as behavior,
   * never as a number (0001). Runs on every ceremony (player- AND NPC-driven).
   *
   * Audit reworks: a comp win moves only the THREAT read (E47 — the house keeps liking its
   * winner); the eviction fold scales by the evictee's RECORDED manner (E48 — a respected,
   * expected eviction is not a betrayal); and the survivors' "proven threat" read lands on THIS
   * week's HOH (E49 — the old code read `outgoingHoh` before the rollover, hitting last week's).
   */
  private foldCeremonyConsequence(ev: BeatEvent): void {
    const s = this.live;
    if (!s) return;
    const rng = this.beatRng();
    const fold = (from: EntityId, to: EntityId, act: CeremonyAct, scale = 1): void => {
      if (from === to) return;
      const impact = scale === 1 ? CEREMONY_IMPACTS[act] : scaleImpact(CEREMONY_IMPACTS[act], scale);
      this.rel.applyImpactDirected(from, to, impact, rng);
    };
    switch (ev.beat) {
      case "hoh-competition": {
        const winner = ev.participants[0]; // the new HOH reads as a threat to the whole house (E47)
        if (winner) for (const h of s.active) fold(h, winner, "comp-won");
        break;
      }
      case "veto-competition": {
        const winner = s.vetoHolder;
        if (winner) for (const h of s.active) fold(h, winner, "comp-won");
        break;
      }
      case "nominations": {
        if (s.hoh && s.nominees) {
          for (const nom of s.nominees) {
            this.rememberFriendAct(nom, s.hoh, "nominated-by-friend"); // BEFORE the fold: the trust test reads the pre-shock edge
            if (this.npcMemoryWritersEnabled && nom !== PLAYER) this.remember(nom, s.hoh, "nominated-by-hoh", nominationMemorySeverity(this.rel.edge(nom, s.hoh).trust)); // B2: same pre-fold read
            fold(nom, s.hoh, "nominated");
          }
        }
        break;
      }
      case "veto-ceremony": {
        // B2: a veto NOT used leaves the NPC nominees on the block — each remembers the holder who could have saved them (graded by their pre-fold trust in the holder).
        if (this.npcMemoryWritersEnabled && !s.vetoUsed && s.vetoHolder && s.nominees) {
          for (const nom of s.nominees) if (nom !== PLAYER && nom !== s.vetoHolder) this.remember(nom, s.vetoHolder, "veto-withheld", vetoWithheldSeverity(this.rel.edge(nom, s.vetoHolder).trust));
        }
        if (s.saved && s.vetoHolder) {
          this.remember(s.saved, s.vetoHolder, "veto-saved", 0.6);
          fold(s.saved, s.vetoHolder, "veto-saved"); // gratitude bond + E54 evidence
        }
        if (s.replacement && s.hoh) {
          // #1965: the betrayal shock lands only on a replacement who TRUSTED the HOH (read PRE-fold), graded by how
          // deep that trust ran (as `mannerToward` grades it); a replacement who never trusted them takes the plain
          // nomination conflict instead — being put up is still a slight, but it is not a betrayal.
          const trust = this.rel.edge(s.replacement, s.hoh).trust;
          this.rememberFriendAct(s.replacement, s.hoh, "replaced-by-friend");
          const { trustBetrayal } = MANNER_THRESHOLDS;
          if (trust > trustBetrayal) {
            const g = MANNER_GRADING.grievanceFloor + (1 - MANNER_GRADING.grievanceFloor) * clamp01((trust - trustBetrayal) / (1 - trustBetrayal));
            fold(s.replacement, s.hoh, "replaced", g);
          } else {
            fold(s.replacement, s.hoh, "nominated");
          }
        }
        break;
      }
      case "eviction": {
        const evictee = ev.participants[0];
        if (!evictee) break;
        // The evictee resents everyone responsible for sending them out (HOH + the voters who voted
        // to evict) — the SAME set the jury manner read captured — scaled by HOW it landed (E48):
        // a betrayal burns; a clean, expected move from a known rival leaves a fraction.
        const manner = s.mannerByEvictee?.[evictee] ?? {};
        for (const r of Object.keys(manner) as EntityId[]) {
          fold(evictee, r, "evicted", GameSessionAdapter.mannerScale(manner[r]!));
        }
        // The survivors read THIS week's HOH as a proven threat — they just ran the week (E49;
        // `rollWeek` has not run yet at this beat, so `s.hoh` is the reign that ends tonight).
        if (s.hoh) for (const h of s.active) fold(h, s.hoh, "comp-won");
        break;
      }
      case "self-eviction": {
        // 0061 §4.4: the present house's souls fold the player's VOLUNTARY walk-out — the house's
        // read of the LEAVER moves (threat▼ as a rival removes itself, a slight warmth/reliability
        // dip for quitting on them). The leaver is gone, so only the house→leaver direction folds.
        // `applySelfEviction` already removed the player, so `s.active` is exactly the present house.
        const leaver = ev.participants[0];
        if (leaver) for (const h of s.active) fold(h, leaver, "self-evicted");
        break;
      }
    }
  }

  /** A deterministic per-(week,beat) RNG so a given moment resolves the same way (and across restart). */
  private beatRng(): SeededRandom {
    // B60/audit E12: key off the GAME's seed (persisted), not the player's display name — two
    // same-named games get distinct streams; a restored game keeps its own. Legacy saves (no seed)
    // fall back to the old name key so their in-flight moments still resolve identically.
    const name = this.house?.player.name ?? "season";
    const root = this.gameSeed ?? name;
    // A double-eviction night (0025/B53) repeats the week's beats in its compressed second cycle —
    // disambiguate so the second HOH comp / eviction don't replay the first cycle's rolls.
    const cycle = this.live?.twist?.phase === "running" ? ":2" : "";
    return new SeededRandom(hashSeed(`${root}:${this.live?.week}:${this.live?.beat}${cycle}`));
  }

  advanceGame(req: { expectedBeatSeq?: number; idempotencyKey?: string } = {}): AdvanceView {
    this.disclosureEpoch++; // B33: an advance ends the previous beat's disclosure events
    // 0065 Part B — an at-most-once replay returns the ORIGINAL view (its beatSeq included) WITHOUT
    // advancing again; it WINS even if beatSeq has since moved (the cache is the authority on the
    // already-applied result). Checked before the CAS guard so a retry of a now-stale key still
    // returns the cached success rather than a spurious stale-beat conflict.
    if (req.idempotencyKey !== undefined) {
      const cached = this.idempotencyCache.get(req.idempotencyKey);
      if (cached) return cached;
    }
    // 0065 Part A — refuse a write computed against a superseded board BEFORE any mutation.
    this.guardBeatSeq(req.expectedBeatSeq);
    if (!this.house || !this.live) {
      const v = this.advanceView(null);
      return req.idempotencyKey !== undefined ? this.rememberIdempotent(req.idempotencyKey, v) : v;
    }
    // FEATURE 0111 — THE CHAMPAGNE-CIRCLE CLOSE EDGE. The model's FIRST advanceGame during the gathered
    // premiere toast RESOLVES the circle: un-pin the player into free-roam premiere (bedroom pick,
    // settling in). It deliberately does NOT run `advanceBeat` — the premiere is NOT over and the first
    // HOH does NOT start here (ADR 0003: guide, don't force-march the week). A LATER advanceGame, once
    // the player has picked a bedroom and settled, begins the first HOH. Committed like any beat (one
    // persist, one beatSeq bump) so the released state is durable; `advanceView(null)` reports no new
    // beat (nothing was resolved — only the toast scene closed).
    if (this.live.premiereEntrance && this.live.premiereEntrance.stage !== "done") { // A9: the staged entrances/toast
      const staged = this.inOneCommit(() => this.advancePremiereEntrance());
      return req.idempotencyKey !== undefined ? this.rememberIdempotent(req.idempotencyKey, staged) : staged;
    }
    if (this.live.champagneCircle === "gathered") {
      const closed = this.inOneCommit(() => {
        this.live!.champagneCircle = "done";
        this.persist(); // one committed mutation — durable + bumps beatSeq via the registry funnel
        return this.advanceView(null);
      });
      return req.idempotencyKey !== undefined ? this.rememberIdempotent(req.idempotencyKey, closed) : closed;
    }
    // FEATURE 0133 — an EARLY-EVICTED player who chose to follow the season: the engine runs the player-less
    // beats itself. `watch` = one whole week per call (its `weekDigests` line is the record); `skip` = straight
    // to the finale. The SAME `advanceOneBeat` steps in the SAME order, so every BEAT rng draw is byte-identical to
    // single-stepping (`beatRng` is a pure function of week/beat). The bounded off-screen tick follows the player's
    // COMMITTED turns (the house lives between the player's turns, ADR 0003/real-time purge), so a skip is one turn and
    // a watch is one per week — fewer turns, fewer ticks; the closed-set spine itself is never altered.
    if (this.live.spectator && !this.live.pending && !this.live.finished) {
      const spectated = this.inOneCommit(() => this.spectatorFastForward());
      return req.idempotencyKey !== undefined ? this.rememberIdempotent(req.idempotencyKey, spectated) : spectated;
    }
    // ORW-116 (b), Ryne's rule: the night is NEVER auto-run. If the next beat would roll the night and the player has not turned in (nor reached 8am), hold: typed `held`, no commit, no beatSeq bump.
    if (this.perConversationClockLive() && !this.scheduleGateBypass && !this.live.spectator && !playerHasLeft(this.live, PLAYER) && !this.live.pending && !this.live.finished
        && nightBreakPending(this.live) && nightHeld(this.live)) {
      return { ...this.advanceView(null), held: { next: this.live.beat as never, minutesUntil: Math.max(0, Math.round((DAY_END_HOUR - (this.live.nightDepth ?? DAY_END_HOUR)) * 60)) } };
    }
    // A65: defense in depth for the production schedule. With the gate on, the clock running and the next milestone NOT yet due, an ordinary beat is REFUSED here (typed `held`, no commit, no beatSeq
    // bump, not cached for idempotency) so the schedule no longer rests on the FE hold alone. Pending decisions, the premiere stages, the spectator fast-forward and the engine's own fast-forward
    // (`scheduleGateBypass`) are unaffected; flag off => this block is skipped entirely (byte-identical).
    if (this.advanceGateEnabled && !this.scheduleGateBypass && this.perConversationClockLive() && !this.live.pending && !this.live.finished) {
      const m = nextMilestone(this.live);
      if (m && !milestoneDueOf(this.live)) return { ...this.advanceView(null), held: { next: m.beat, minutesUntil: minutesUntilDue(this.live) ?? 0 } };
    }
    // One persisted commit per beat (E3): interior persists (a deal broken mid-tally) defer to a
    // single hook call AFTER all state mutation — a refused commit throws instead of narrating.
    const view = this.inOneCommit(() => {
      const ev = this.advanceOneBeat();
      // Surface the just-resolved beat (it is player-witnessed) so the finale reveal/result beats
      // and every ceremony beat are visible in the view, not only recorded to the event store.
      return this.advanceView(ev);
    });
    // 0065 Part B — cache the committed result under its key, so a retry replays it verbatim.
    return req.idempotencyKey !== undefined ? this.rememberIdempotent(req.idempotencyKey, view) : view;
  }

  /**
   * 0133 — run the player-less beats for a spectating (early-evicted) player: `watch` stops once a whole week has
   * completed (its digest recorded), `skip` stops at the finale. BOUNDED (never spins), and halts on anything that
   * needs the player (a pending) or ends the season. Returns the view of the LAST event produced.
   */
  private spectatorFastForward(): AdvanceView {
    const live = this.live!;
    const mode = live.spectator!.mode;
    const digestsBefore = live.weekDigests?.length ?? 0;
    let last: BeatEvent | null = null;
    let idle = 0;
    for (let i = 0; i < 5000 && !live.pending && !live.finished; i++) {
      const ev = this.advanceOneBeat();
      if (ev) { last = ev; idle = 0; } else if (++idle > 8) break; // a run of silent steps that moves nothing
      if (live.pending || live.finished) break;
      if (mode === "skip" ? (live.beat === "finale" || !!live.finale) : (live.weekDigests?.length ?? 0) > digestsBefore) break;
    }
    return this.advanceView(last);
  }

  /** 0129 — an engine-seeded vote-DEDUCTION belief ("X believes A turned on them in the eviction vote", 0110 / the
   *  traitors-fury blame seeding). It attributes a SEALED ballot (E12), so it never rides a juror's telling or the
   *  jury-house prompt block — it unseals only through the 0048 retrospective. */
  private static isSealedAttribution(f: { pathway?: string; factId?: string }): boolean {
    return (f.pathway ?? "").startsWith("jury-house:blame") || (f.factId ?? "").startsWith("traitors-fury:blame");
  }

  /**
   * 0129 slice 3 — the juror-player ASKS a fellow juror what they know. Seam reuse (no new knowledge reader): the
   * candidates are the SAME witnessed-or-told set `npcVoice(juror).knows` already exposes (never the Diary Room
   * class), minus what the player already holds; the ENGINE gates the telling on the juror's recorded bearing
   * (sour never, cool sometimes, even usually, warm always — seeded per juror/beat so a repeat press in one beat
   * reaches the same decision) and picks which fact; the telling reaches the player ONLY via the content-anchored
   * `told-by:<juror>` pathway (`onJurorTell`), recorded as a player-witnessed event. Folds nothing into the live
   * house (a juror has no pathway back to it) and mutates no relationship. Null unless the player holds a juror's
   * seat and `jurorId` is another juror.
   */
  askJuror(jurorId: EntityId, expectedBeatSeq?: number, idempotencyKey?: string): AskJurorResult | null {
    const idemKey = this.foldLedgerKey("askJuror", idempotencyKey);
    const replay = this.foldReplay<AskJurorResult | null>(idemKey);
    if (replay.hit) return replay.value;
    this.guardBeatSeq(expectedBeatSeq);
    const jh = this.juryHouseView();
    const juror = jh?.jurors.find((j) => j.id === jurorId);
    if (!jh || !juror || !this.npcKnowledge) return null;
    const chance = { warm: 1, even: 0.75, cool: 0.4, sour: 0 }[juror.bearing];
    const rng = new SeededRandom(hashSeed(`${this.gameSeed ?? 0}:ask-juror:${jurorId}:${this.week}:${this.phase}`));
    const playerHolds = this.playerKnowledgeReader?.() ?? [];
    const heldIds = new Set(playerHolds.map((k) => k.factId).filter((f): f is string => !!f));
    const heldText = new Set(playerHolds.map((k) => k.content));
    const candidates = this.npcKnowledge.known(jurorId)
      .filter((f) => f.factId && f.pathway !== "diary-room" && !GameSessionAdapter.isSealedAttribution(f)
        && !heldIds.has(f.factId) && !heldText.has(f.content));
    const roll = rng.next();
    const none: AskJurorResult = { told: false, bearing: juror.bearing };
    if (roll >= chance || candidates.length === 0 || !this.onJurorTell) return none;
    const pick = candidates[Math.floor(rng.next() * candidates.length)]!;
    const content = this.onJurorTell(jurorId, pick.factId!, 0.7);
    if (content === null) return none;
    this.jurorTold.add(content); // the informed vote card reads ONLY tellings made here, in the jury house
    this.onPlayerEvent?.(`${this.nameOf(jurorId)} tells ${this.nameOf(PLAYER)} something in the jury house`, [PLAYER, jurorId], "conversation");
    this.persist();
    const result: AskJurorResult = { told: true, bearing: juror.bearing, content: this.humanize(content) };
    if (idemKey !== undefined) this.rememberFoldIdempotent(idemKey, result);
    return result;
  }

  /**
   * 0129 slice 4 — the informed juror-vote card's brief: what the PLAYER was told by fellow jurors (`told-by:<juror>`
   * facts in the player's own knowledge — the sole source, so nothing a juror merely holds can ride), grouped by the
   * finalist it concerned (the fact's subject, or the finalist named in it), most recent last, capped per finalist.
   * `undefined` when nothing relevant was told (the card is then unchanged).
   */
  private jurorBriefFor(finalists: readonly EntityId[]): Array<{ finalist: NamedRef; heard: string[] }> | undefined {
    const jurorIds = new Set((this.juryHouseView()?.jurors ?? []).map((j) => j.id));
    if (jurorIds.size === 0) return undefined;
    const told = (this.playerKnowledgeReader?.() ?? []).filter((k) => {
      const m = /^told-by:(.+)$/.exec(k.pathway ?? "");
      return !!m && jurorIds.has(m[1]!) && this.jurorTold.has(k.content);
    });
    if (told.length === 0) return undefined;
    const out: Array<{ finalist: NamedRef; heard: string[] }> = [];
    for (const f of finalists) {
      const name = this.nameOf(f);
      const heard = told
        .filter((k) => k.subject === f || (name.length > 0 && k.content.includes(name)))
        .slice(-GameSessionAdapter.JUROR_BRIEF_CAP)
        .map((k) => this.humanize(k.content));
      if (heard.length > 0) out.push({ finalist: { id: f, name }, heard });
    }
    return out.length > 0 ? out : undefined;
  }
  private static readonly JUROR_BRIEF_CAP = 4;

  /**
   * 0129 — the jury house roster (slice 1): the OTHER jurors the juror-player lives with, each with a categorical
   * `bearing` read off the recorded jury-management manner toward the player (the eviction's own manner plus any
   * broken-deal demerit — both are how that juror came to regard the player; the same record the finale vote reads). Public record only (the eviction order, the
   * vote record's week, the manner flags the player witnessed) — never a hidden lean, never an edge number.
   * Absent unless the player currently holds a juror's seat. Read-only: draws no rng and mutates nothing, so the
   * seeded spine is byte-identical whether or not anything reads it.
   */
  private juryHouseView(): JuryHouseView | undefined {
    const live = this.live;
    if (!live || this.playerStatus() !== "jury") return undefined;
    const start = this.juryStartIndex();
    const manner = live.mannerByEvictee ?? {};
    const jurors: JuryHouseJurorView[] = [];
    live.evictionOrder.forEach((id, i) => {
      if (i < start || id === PLAYER) return;
      const m = manner[id]?.[PLAYER];
      const bearing: JurorBearing = !m ? "even"
        : (m.betrayed || m.blindsided) ? "sour"
        : m.disrespected ? "cool"
        : m.respected ? "warm" : "even";
      const week = live.voteRecord?.find((r) => r.evictee === id)?.week ?? null;
      jurors.push({ id, name: this.nameOf(id), evictedWeek: week, bearing });
    });
    return { jurors };
  }

  /** 0133 — the PUBLIC week digests an early-evicted, spectating player may read (named, Vault-free). */
  private weekDigestViews(): WeekDigestView[] | undefined {
    const live = this.live;
    if (!live?.spectator) return undefined;
    const since = live.spectator.sinceWeek;
    // The player's OWN eviction night is not a "remaining" week (they lived it; the exit interview voiced it), so it is not digested for them.
    // Bounded by the EVICTION ORDER, not just the week: a double-eviction night can hold an NPC eviction BEFORE the player's own in the same week.
    const order = live.evictionOrder ?? [];
    const playerAt = order.indexOf(PLAYER);
    const rows = (live.weekDigests ?? []).filter((d) => d.week >= since && (d.evictee == null || order.indexOf(d.evictee) > playerAt));
    if (rows.length === 0) return undefined;
    return rows.map((d) => ({
      week: d.week,
      hoh: this.named(d.hoh ?? undefined) ?? null,
      nominees: d.nominees.map((id) => this.named(id)!).filter(Boolean),
      vetoHolder: this.named(d.vetoHolder ?? undefined) ?? null,
      vetoUsed: d.vetoUsed,
      evicted: this.named(d.evictee ?? undefined) ?? null,
      juryCount: d.juryCount,
    }));
  }

  /**
   * The deterministic "one more step" of the live loop: offer the LULL-gated NPC deal check (0123),
   * then draw the CURRENT beat's outcome (or raise its pending), apply the SAME ADR-0006 clock/night
   * bookkeeping a plain `advanceGame` call would, and commit. A no-op (returns `null`, mutates
   * nothing) when the loop is already blocked on a decision, a standing deal offer, or the season is
   * finished — so callers may invoke it unconditionally without re-deriving that guard themselves.
   *
   * Shared by `advanceGame`'s own main path AND T0-2's `submitDecision` auto-advance (below), so a
   * beat reached by chaining off a resolved pending is BYTE-IDENTICAL to the same beat reached via a
   * separate `advanceGame` call — same rng draw (`beatRng` is a pure function of the current
   * week/beat, not of how many calls got us here), same clock/fatigue/conflict folds, same commit.
   *
   * 0123 — at a LULL a motivated houseguest may pull the player aside with a DEAL OFFER.
   * `maybeOfferPlayerDeal` MUST run before the pending/dealOffer/finished guard below — not after —
   * because it is what CAN set `live.dealOffer`: the guard's own `!this.live!.dealOffer` check has to
   * see whatever this SAME call just floated, or a beat could advance in the very turn a fresh offer
   * was raised (a #1824/Greptile P1 finding: the chained `submitDecision` path used to skip this gate
   * entirely, since it called `advanceBeat` directly instead of going through `advanceGame`'s
   * sequence). Folded HERE (not left as a separate call at each call site) so both callers get the
   * gate by construction and can never drift apart again. No-op unless the layer is on; when it fires
   * it sets `live.dealOffer` — open state the narrator voices (PO ruling 2026-11-01: never a pending card,
   * never blocking; the beat still advances). Flag off ⇒ byte-identical.
   */
  private advanceOneBeat(): BeatEvent | null {
    // Only an offer that was ALREADY standing before this step may lapse in it — one floated by this same
    // call must reach the player (be voiced) before the week can roll it away (cubic #1911).
    const standingOfferId = this.live!.dealOffer?.id;
    this.maybeOfferPlayerDeal();
    // PO ruling 2026-11-01: a floated offer NEVER blocks the week (no pop-up, no freeze). It stands as
    // open state the narrator voices in-scene; the player answers in chat, or it lapses at week's end.
    if (!this.live!.pending && !this.live!.finished) {
      const weekBefore = this.live!.week; // the eviction result rolls the week inside this same step
      const ev = advanceBeat(this.live!, this.ctx(), this.beatRng());
      this.maybeLapseDealOffer(standingOfferId); // folded BEFORE commit(ev) so the beat's persist carries it
      // ADR 0006 (opt-in): the in-game clock moves by PLAY — one phase per SUBSTANTIVE advance, cycling
      // toward late-night and wrapping to a new morning (banking a late night the player never ended).
      // The diegetic bound + sleep cost ride this; dormant (byte-identical) unless the clock is enabled.
      //
      // #537: the clock advances by SUBSTANTIVE PLAY — once per resolved ceremony/eviction/finale
      // beat — never on a staged competition's per-round PRESENTATION (the `comp-round` PAUSES, which
      // emit no event, and the inert `comp-elimination` reveal beats: no rng, no fold, no soul
      // inflection — see `advanceCompetition`/`stagedTrajectoryNeutral`). Advancing on each of those
      // cycled most of a day inside ONE competition (the HOH crowned at late-night the morning it
      // began). The clock still INITIALIZES on the first advance (so the HUD/rest cue are live from
      // turn one) even before the first substantive beat lands.
      //
      // 0066 Phase-2 (PR #715): the graded sleep economy — chronotype bedtimes + continuous night
      // depth + the night-end fatigue/conflict bookkeeping — rides this SAME substantive-play gate, so
      // it never over-advances on inert staged-comp beats either. On the bare init advance `advanceClock`
      // only initializes (returns early), so the bookkeeping below is a harmless no-op there: rest
      // deficit is 0 (no night ran) and the conflict tally is still empty.
      if (this.timeOfDayEnabled && (this.live!.timeOfDay === undefined || (ev !== null && !isInertBeat(ev.beat)))) {
        const wasRetired = this.live!.playerRetired ?? false;
        const depthBefore = this.live!.nightDepth;
        // 0119 — different events cost different amounts of the in-game day: a quick ceremony ~1h, a
        // comp ~3h, an eviction ~2h (beatFeltHours), instead of a flat +3h. Applied ONLY when the
        // per-conversation clock is live, so golden replay (that clock off, master on) keeps the flat
        // default and the recorded time-of-day stream is byte-identical (no re-record); calibration
        // (master off) skips this whole block. A beat with no distinct felt duration ⇒ the flat default.
        const feltHours = this.perConversationClockLive() ? beatFeltHours(ev?.beat) : null;
        // PO ruling 2026-11-01 — an eviction night / the finale costs ~2h IN TOTAL: its first step
        // charges the event's budget, every later presentation step costs 0 (it used to be +3h a step,
        // so one eviction night ran most of a day and the finale ran for days).
        // Not while the player is turned in: that advance only WAKES them (no hours move), so the event's
        // budget must not be marked spent on it — the next step charges it for real (cubic #1912).
        const eventHours = ev !== null && this.live!.timeOfDay !== undefined && !this.live!.playerRetired
          ? eventBeatHours(this.live!, ev.beat, weekBefore, eventSpanHours("eviction"))
          : null;
        if (eventHours !== null) advanceClock(this.live!, eventHours);
        else if (feltHours !== null) advanceClock(this.live!, feltHours);
        else advanceClock(this.live!);
        // A genuine night-end is the 8am-wake WRAP (the house ran to the bitter end) — NOT the morning
        // after a turnIn (that night already accrued). Detect: a fresh morning (back at the wake hour) we
        // did NOT reach via retirement.
        // Only when THIS advance crossed into the morning: an event's later 0-hour steps sit at the same 8am
        // and must not re-count the same night (greptile #1912 — one night accrued once per reveal).
        if (!wasRetired && depthBefore !== WAKE_HOUR && this.live!.timeOfDay === DAY_START && (this.live!.nightDepth ?? WAKE_HOUR) === (this.live!.wakeHour ?? WAKE_HOUR)) this.accrueNightFatigue();
        this.rollNightConflicts();
      }
      this.commit(ev);
      return ev;
    }
    return null;
  }

  submitDecision(req: SubmitDecisionReq): AdvanceView {
    // 0065 Part B — replay an already-resolved decision verbatim (wins even if beatSeq moved).
    if (req.idempotencyKey !== undefined) {
      const cached = this.idempotencyCache.get(req.idempotencyKey);
      if (cached) return cached;
    }
    // 0065 Part A — refuse a decision computed against a superseded board BEFORE any mutation.
    this.guardBeatSeq(req.expectedBeatSeq);
    if (!this.house || !this.live) {
      const v = this.advanceView(null);
      return req.idempotencyKey !== undefined ? this.rememberIdempotent(req.idempotencyKey, v) : v;
    }
    // 0065 Part B — every resolved/no-op path below caches its committed view under the key, so a
    // retry replays it verbatim (and never re-applies the decision).
    const remember = (v: AdvanceView): AdvanceView =>
      req.idempotencyKey !== undefined ? this.rememberIdempotent(req.idempotencyKey, v) : v;
    // 0061 — self-eviction is the sanctioned CONFIRMED quit. It rides the SAME `submitDecision`
    // seam but resolves through its own dedicated path (NOT the ceremony-pending machinery): the
    // confirmation must already be raised (the OOC step-1 gate), AND `confirmed` must be true.
    // Anything else (a missing confirmation, confirmed:false/absent) is a safe no-op — the player
    // stays ACTIVE (the anti-accident handshake; never a fabricated exit, §4.2).
    if (req.kind === "self-evict") return remember(this.resolveSelfEviction(req.confirmed === true));
    // 0123 — an NPC deal offer resolves through its own path (NOT the ceremony-pending machinery): it
    // lives on `live.dealOffer`, not `live.pending`. Only an EXPLICIT `accept`/`decline` resolves it; a
    // malformed/missing `vote` (a stale or garbled client call) is a safe NO-OP — the offer stands and no
    // hidden cooling is applied. Never silently decline on bad input (Greptile P1).
    if (req.kind === "deal-offer") {
      if (this.live.finished) return remember(this.advanceView(null)); // a post-season answer binds nothing
      if (req.vote === "accept" || req.vote === "decline") return remember(this.resolveDealOffer(req.vote === "accept"));
      return remember(this.advanceView(null));
    }
    // 0133 — a spectating player may switch WATCH → SKIP later through the same decision kind (no pending needed).
    // SKIP is irreversible and the offer is one-time, so every other answer outside the pending is a safe no-op.
    // Skip is irreversible: a later `watch` is a deliberate typed refusal (not a silent no-op) so the narrator can tell the player why — WHATEVER
    // other decision is open at the time (e.g. the finale interview), hence checked before the no-pending branch below.
    if (req.kind === "spectator-choice" && this.live.spectator?.mode === "skip" && singlePickId(req) === "watch") {
      throw new EngineRefusal("skipping ahead to the finale is irreversible — the player has already chosen to skip, so watching the rest of the season is no longer an option");
    }
    if (req.kind === "spectator-choice" && !this.live.pending) {
      const mode = singlePickId(req);
      if (this.live.spectator?.mode === "watch" && mode === "skip" && !this.live.finished) {
        return remember(this.inOneCommit(() => {
          this.live!.spectator = { mode: "skip", sinceWeek: this.live!.spectator!.sinceWeek };
          this.commit({ beat: "spectator-choice", content: `${PLAYER} switches to skipping ahead to the finale`, participants: [PLAYER] });
          return this.advanceView(null);
        }));
      }
      return remember(this.advanceView(null));
    }
    // No-op unless there's a matching pending decision to resolve (idempotent + robust
    // to malformed calls — the boundary must never throw an unhandled error). `comp-intent` and
    // `comp-round` are interchangeable aliases for the staged per-round approach (0006 staged-rounds).
    const compApproach = (k: string): boolean => k === "comp-intent" || k === "comp-round";
    const pendingKind = this.live.pending?.kind;
    const kindMatches = !!pendingKind && (pendingKind === req.kind || (compApproach(pendingKind) && compApproach(req.kind)));
    if (!kindMatches) return remember(this.advanceView(null));
    // (E42) Eviction-vote reconciliation moved to `commit`: the staged eviction's `voteOf` carries
    // EVERY voter — player and NPC alike — so the ledger now sees all binding votes in one place.
    return remember(this.inOneCommit(() => {
      // The beat-deterministic rng lets the Houseguest's-Choice resume run the veto comp reproducibly (B45).
      const ev = applyDecision(this.live!, this.toDecisionInput(req), this.ctx(), this.beatRng());
      this.commit(ev);
      // T0-2 ("beats terminate themselves") — for the CLOSED-SET ceremony/comp pending kinds
      // (`AUTO_ADVANCE_PENDING_KINDS`, documented above), the resolution's own commit IS the exit: the
      // loop takes ONE more deterministic step right here, in the SAME `inOneCommit` transaction (one
      // beatSeq bump, one fault-injection unit — a failed persist rolls back BOTH mutations together),
      // instead of leaving the game sitting at "decision resolved, nothing moved" until a separate
      // `advanceGame` call arrives. `advanceOneBeat` is already a no-op when the step it would take is
      // itself blocked (a fresh pending, a standing deal offer, or the season finishing) — most visibly
      // for `comp-intent`/`comp-round`, whose own `applyDecision` case already re-entered the staged
      // sub-loop and so left a fresh `comp-round` pending most of the time.
      //
      // The RETURNED event stays `ev` (the pending's OWN resolution) — unchanged contract, so every
      // existing caller keeps seeing exactly what it saw before. The follow-up step's event (if any) is
      // still fully recorded/folded via `commit` above (journal, consequence, relationships) and shows
      // up in the NEXT read (`getGameState`/`stateDelta`/the following `advanceGame`, which — since the
      // step already ran — returns that already-committed result as a genuine no-op rather than doing
      // fresh work). Excluded kinds (goodbye-message, the interactive finale, self-evict, secret-veto,
      // deal-offer) are unaffected — this block never runs for them.
      //
      // #1824 (Greptile P1) — `advanceOneBeat` folds the 0123 `maybeOfferPlayerDeal` LULL-gated NPC
      // deal check BEFORE its own pending/dealOffer/finished guard (see that method's doc comment), so
      // this chained call honors the SAME gate a separate `advanceGame` call would: if a deal is due at
      // the post-resolution lull, it sets `live.dealOffer` and the beat does NOT advance here either —
      // byte-identical to the un-chained two-call path, never bypassed by going straight to a beat draw.
      if (AUTO_ADVANCE_PENDING_KINDS.has(pendingKind!)) this.advanceOneBeat();
      return this.advanceView(ev);
    }));
  }

  /**
   * 0102 (PO review 2026-06-27 redesign, #884) — build the non-committal cliffhanger a daily recap
   * MAY carry, from exactly two Vault-free, already-in-motion signals (never the Vault, never a future
   * roll): (a) a deal the player holds that is `vague` or nearing its negotiated expiry (0109) — a
   * strained understanding the player can already feel; (b) that something surfaced to the player
   * TODAY (the freshly-computed `surfacedToday` slice) that "isn't finished playing out". With more
   * than one eligible candidate, the pick rides a DEDICATED per-day side rng (`daily-recap:<day>`,
   * forked off the game seed) — never the shared season/vote/jury stream, so this can never perturb a
   * seeded outcome. No eligible thread ⇒ `undefined` (a quiet day closes with no manufactured hook).
   */
  private buildDailyRecapHook(day: number, surfacedToday: readonly string[]): DailyRecapHook | undefined {
    if (!this.house || !this.live) return undefined;
    const week = this.live.week;
    const candidates: DailyRecapHook[] = [];
    for (const d of this.deals.forParty(PLAYER)) {
      if (d.status !== "open") continue;
      const other = d.parties.find((p) => p !== PLAYER);
      if (!other) continue;
      const nearingExpiry = d.expiresWeek !== undefined && d.expiresWeek - week <= 1;
      if (d.vague || nearingExpiry) {
        candidates.push({
          thread: `deal:${d.id}`,
          framing: `what you and ${this.nameOf(other)} agreed to feels like it's on borrowed time`,
        });
      }
    }
    if (surfacedToday.length > 0) {
      candidates.push({
        thread: `surfaced:${day}`,
        framing: "what you heard today doesn't feel finished playing out",
      });
    }
    if (candidates.length === 0) return undefined;
    if (candidates.length === 1) return candidates[0];
    const rng = new SeededRandom(hashSeed(`${this.gameSeed ?? 0}:daily-recap:${day}`));
    return rng.pick(candidates);
  }

  /**
   * 0102 (PO review 2026-06-27 redesign, #884) — materialize the "day in review" digest for the day
   * that just closed, called from `turnIn` BEFORE the clock rolls to the next morning (the player's
   * own bedtime lever, ADR 0006 — never a free-floating scheduler). Stitched from exactly the two
   * Vault-free sources the weekly-recap design specified, scoped to the tail since the persisted
   * cursors (never re-scans, never double-counts, never a Vault read):
   *   - the player's witnessed ceremony/scene/deal highlights — the SAME structural filter
   *     `seasonRecap()` already uses, sliced to events recorded since the last materialized day;
   *   - gossip that reached the player's OWN knowledge today via a real in-game pathway (0002) —
   *     `playerKnowledgeReader` (the same source `freshSurfacedFacts` trusts), excluding the OOC
   *     Diary Room (`NO_NPC_PATHWAY`) — a rumor still diffusing in the hidden layer never appears.
   * Persists the result on `this.live.lastDailyRecap` so a later re-read (`dailyRecap()`, a fresh
   * context, a restore) reproduces the EXACT same digest for that day — determinism/non-degradation.
   * Folds nothing, advances no thread, perturbs no seeded outcome — a pure presentation snapshot.
   */
  private materializeDailyRecap(): DailyRecapView | undefined {
    const s = this.live;
    if (!s) return undefined;
    const day = s.dayNumber ?? 1;
    const allEvents = this.record?.events() ?? [];
    const evFrom = Math.min(s.dailyRecapEventCursor ?? 0, allEvents.length);
    const highlights = allEvents.slice(evFrom)
      .filter((e) => !e.hidden && (e.id.startsWith("season:") || e.type === "deal" || e.type === "betrayal"))
      .map((e) => e.content);
    const knownAll = this.playerKnowledgeReader?.() ?? [];
    const knFrom = Math.min(s.dailyRecapKnowledgeCursor ?? 0, knownAll.length);
    const surfaced = knownAll.slice(knFrom)
      .filter((f) => f.pathway !== NO_NPC_PATHWAY)
      .map((f) => this.humanize(f.content));
    const hook = this.buildDailyRecapHook(day, surfaced);
    const recap: DailyRecapView = { day, highlights, surfaced, ...(hook ? { hook } : {}) };
    s.lastDailyRecap = recap;
    s.dailyRecapEventCursor = allEvents.length;
    s.dailyRecapKnowledgeCursor = knownAll.length;
    s.dayNumber = day + 1;
    return recap;
  }

  /**
   * 0102 (PO review 2026-06-27 redesign, #884) — re-fetch the most recently CLOSED day's digest
   * (materialized once, at the `turnIn` that closed it). `null` before any day has closed. Vault-free,
   * reproducible: re-reading returns the exact same materialized view every time (no re-computation).
   */
  dailyRecap(): DailyRecapView | null {
    return this.live?.lastDailyRecap ?? null;
  }

  /**
   * The player's bedtime lever (ADR 0006 §Principle 6): the player CHOOSES to turn in for the night.
   * Ends their night where it stands (an early night ⇒ rested for tomorrow; outlasting the house into
   * late-night ⇒ running on empty) and rolls the house to the next morning. Never auto-called — only
   * the player's own action fires it. A no-op when the clock isn't running, the game is over, or the
   * player has left. Durable (0030): the new morning + banked rest survive a reload.
   *
   * 0102 (redesign #884): BEFORE the night rolls, materializes the day-that-just-closed's Vault-free
   * "day in review" digest and carries it on the result as `dailyRecap` (present only when it exists —
   * `materializeDailyRecap` always returns one once the clock is running, so this is present on every
   * turn-in that actually fires; absent only when the whole call was a dormant no-op above).
   */
  private bedtimeGateEnabled = flagDefaultOn("ORWELL_BEDTIME_GATE");
  setBedtimeGateEnabled(on: boolean): void { this.bedtimeGateEnabled = on; }
  turnIn(req: { expectedBeatSeq?: number; idempotencyKey?: string } = {}): AdvanceView {
    // 0065 Part B — replay an already-ended night verbatim (wins even if beatSeq has since moved), so a
    // retried/duplicate turnIn is REPLAYED, not re-executed: `playerTurnIn` never re-stamps `lastSleepDepth`
    // from the reset wake hour (which would ERASE the earned late-night rest penalty). Checked before the
    // CAS guard so a retry of a now-stale key still returns the cached success, not a spurious conflict.
    if (req.idempotencyKey !== undefined) {
      const cached = this.idempotencyCache.get(req.idempotencyKey);
      if (cached) return cached;
    }
    // 0065 Part A — refuse a bedtime computed against a superseded board BEFORE any mutation.
    this.guardBeatSeq(req.expectedBeatSeq);
    // Every path below (the commit AND the no-op early returns) caches its view under the key, so a retry
    // replays it verbatim and never re-ends the night.
    const remember = (v: AdvanceView): AdvanceView =>
      req.idempotencyKey !== undefined ? this.rememberIdempotent(req.idempotencyKey, v) : v;
    if (!this.house || !this.live) return remember(this.advanceView(null));
    if (!this.timeOfDayEnabled) return remember(this.advanceView(null)); // dormant unless the clock is running
    if (this.live.finished || playerHasLeft(this.live, PLAYER)) return remember(this.advanceView(null));
    // Bedtime gate (found in a live run: the narrator called turnIn on "wake up in the morning" and the engine slept through a whole day). A bed in the morning or afternoon is not a night: refuse with a typed
    // `held` (nothing commits, beatSeq unchanged) so the narrator is told it is not bedtime yet. From the evening on the player owns their bedtime exactly as before (ADR 0006).
    if (this.bedtimeGateEnabled && (this.live.timeOfDay === "morning" || this.live.timeOfDay === "afternoon")) {
      const hour = this.live.nightDepth ?? WAKE_HOUR;
      return remember({ ...this.advanceView(null), held: { next: "bedtime", minutesUntil: Math.max(0, Math.round((CLOCK.phaseStartsHour.evening - hour) * 60)) } });
    }
    return remember(this.inOneCommit(() => {
      const closingDay = this.live!.dayNumber ?? 1; // capture BEFORE materialize bumps it (0122 sweep key)
      const recap = this.materializeDailyRecap();
      // 0122 — most living NPCs privately confess the day that just closed (deeper than 0040, bare games
      // skipped). No-op unless the flag + in-game clock are live ⇒ byte-identical off. Records Vault-only.
      this.sweepDailyConfessionals(closingDay);
      playerTurnIn(this.live!, PLAYER);
      this.accrueNightFatigue(); // the player chose bed — a genuine night-end; accrue before clearing conflicts
      this.rollNightConflicts();
      this.persist();
      const view = this.advanceView(null);
      return recap ? { ...view, dailyRecap: recap } : view;
    }));
  }


  /**
   * "Hang out until X" (PO 2026-11-04): a bounded run of short beats that stops at the FIRST interruption. Flag-gated; every
   * refusal path changes NO state. The beats draw from a dedicated side stream (game seed + a persisted call counter), never
   * the season spine. The clock is clamped to the next scheduled event, so this can never fire or skip one. The stop is
   * RECORDED on `live.hangOutLog` (witnessed passage of time - never narrated-but-unrecorded).
   */
  hangOut(req: HangOutReq = {}): HangOutView {
    this.guardBeatSeq(req.expectedBeatSeq);
    const refuse = (reason: NonNullable<HangOutView["reason"]>): HangOutView => ({ ok: false, reason, beats: 0, minutes: 0, beatSeq: this.beatSeq });
    if (!this.hangOutEnabled) return refuse("disabled");
    if (!this.house || !this.live) return refuse("no-game");
    if (this.live.finished || playerHasLeft(this.live, PLAYER)) return refuse("no-game");
    if (!this.perConversationClockLive()) return refuse("clock-off");
    if (this.live.pending) return refuse("pending-decision");
    return this.inOneCommit(() => {
      const live = this.live!;
      const n = (live.hangOutCount ?? 0) + 1;
      live.hangOutCount = n;
      const rng = new SeededRandom(hashSeed(`hangout:${this.gameSeed ?? ""}:${n}`));
      const day = live.dayNumber ?? 1;
      const evicted = new Set(live.evictionOrder ?? []);
      const awakeNpcs = (): EntityId[] => {
        const awake = this.awakeNow();
        return this.house!.npcs.map((x) => x.id).filter((id) => !evicted.has(id) && (!awake || awake.has(id)));
      };
      const started = firstCeremonyBeatResolved(live);
      const approachOpen = started || (this.morningApproachEnabled && this.premiereSocialOpen()); // A22 (flag-off => `started`)
      const result = runHangOut({
        advance: (h) => { advanceClockPerConversation(live, h); },
        hoursUntilEvent: () => {
          const m = nextMilestone(live);
          return m ? Math.max(0, m.targetHour - (live.nightDepth ?? WAKE_HOUR)) : null;
        },
        eventDue: () => milestoneDueOf(live),
        // PO: the night block (20-24) is prime social time and late night is the sleep-debt mechanic - stop at midnight, or sooner once the house has thinned to the player plus at most one person awake.
        bedtime: () => hangOutBedtime(live.nightDepth ?? WAKE_HOUR, awakeNpcs().length, CLOCK.phaseStartsHour.night, CLOCK.midnightHour),
        pulled: (r) => {
          if (!started || live.hangOutPulledDay === day) return null;
          if (r.next() >= HANGOUT_PULL_P) return null;
          live.hangOutPulledDay = day;
          return { by: r.next() < 0.5 ? "diary-room" : "production" };
        },
        approach: (r) => {
          if (this.desireClockEnabled) {
            // A8: the NPC whose own desire clock has crossed its threshold approaches (no flat roll); recorded for the hours-based cooldown.
            const hit = approachOpen ? this.desireApproach(awakeNpcs()) : null;
            if (!hit) return null;
            this.noteApproach(hit.npc);
            return { npc: this.nameOf(hit.npc), desire: hit.desire };
          }
          if (!approachOpen || r.next() >= HANGOUT_APPROACH_P) return null;
          const ids = awakeNpcs();
          if (ids.length === 0) return null;
          const top = rankApproaches(PLAYER, ids, this.rel, r, undefined, this.approachBiasHook(PLAYER))[0];
          return top ? { npc: this.nameOf(top.npc) } : null;
        },
        observed: (r) => {
          if (r.next() >= HANGOUT_OBSERVED_P || !this.presence) return null;
          // Only what is in the player's eyeshot (their room + sightline rooms) - public presence, Vault-free.
          const me = this.presence.get(PLAYER);
          if (!me) return null;
          const visible = new Set<Room>([me, ...(HOUSE_SIGHTLINE.get(me) ?? [])]);
          const awake = new Set(awakeNpcs());
          const seen = [...this.presence].filter(([id, where]) => id !== PLAYER && awake.has(id) && visible.has(where)).map(([id]) => id).sort();
          if (seen.length === 0) return null;
          const kinds = seen.length >= 2 ? ["overheard-whisper", "argument", "someone-moved"] : ["someone-moved"];
          const kind = kinds[r.int(kinds.length)]!;
          const first = seen[r.int(seen.length)]!;
          const uniq = kind === "someone-moved" ? [first] : [first, seen.filter((x) => x !== first)[r.int(seen.length - 1)]!];
          // A12: what the player SEES is a recorded, witnessed event (never narrated-but-unrecorded). Public and content-free - the engine knows THAT a whisper / row / move happened in
          // their eyeshot, never what was said - so no fold is invented (a hidden-impact fold needs real content; the narrator voices the texture, ADR 0005 open set).
          const [a, b] = uniq.map((id) => this.nameOf(id));
          const what = kind === "overheard-whisper" ? `${a} and ${b} are seen whispering together out of earshot`
            : kind === "argument" ? `${a} and ${b} are seen in a tense exchange`
            : `${a} is seen crossing the house`;
          this.onPlayerEvent?.(what, [PLAYER, ...uniq], kind === "someone-moved" ? "house-event" : "conversation");
          return { kind, who: uniq.map((id) => this.nameOf(id)) };
        },
      }, rng, req.maxBeats !== undefined ? { maxBeats: req.maxBeats } : {});
      const hour = live.nightDepth ?? WAKE_HOUR;
      (live.hangOutLog ??= []).push({
        n, day, hour, beats: result.beats, minutes: result.minutes, stopReason: result.stopReason,
        ...(result.detail ? { detail: result.detail as Record<string, unknown> } : {}),
      });
      this.hangOutSkipStepAt = hour;
      this.hangOutPendingHours = result.minutes / 60;
      this.persist();
      return {
        ok: true, stopReason: result.stopReason, beats: result.beats, minutes: result.minutes,
        ...(result.detail ? { detail: result.detail } : {}),
        ...(live.timeOfDay ? { timeOfDay: live.timeOfDay } : {}),
        beatSeq: this.beatSeq,
      };
    });
  }

  /**
   * Self-eviction step 1 (0061 §4.2) — an OOC intent-to-leave raises the confirmation pending and
   * changes NO game state (the house never hears it; the L36/L39a gate holds for the bare line). It
   * does NOT evict — only a confirmed `submitDecision({ kind: "self-evict", confirmed: true })` does.
   */
  requestSelfEviction(): AdvanceView {
    if (!this.house || !this.live) return this.advanceView(null);
    if (this.live.finished || playerHasLeft(this.live, PLAYER)) return this.advanceView(null);
    return this.inOneCommit(() => {
      requestSelfEvict(this.live!, this.ctx());
      this.persist(); // durable: a raised confirmation survives a reload (0030)
      return this.advanceView(null);
    });
  }

  /** E-1 — re-raise the spectator-choice card for a WATCHING pre-jury evictee (see the port). Typed refusal when there is nothing to raise or the player is skipping. */
  raiseSpectatorChoice(expectedBeatSeq?: number): AdvanceView {
    this.guardBeatSeq(expectedBeatSeq);
    if (!this.house || !this.live) throw new EngineRefusal("no active game");
    const live = this.live;
    if (live.spectator?.mode === "skip") throw new EngineRefusal("skipping ahead to the finale is irreversible — the player is already skipping, so there is no choice to re-open");
    if (live.finished || !live.spectator) throw new EngineRefusal("there is no spectator choice to re-open (only a player who was evicted before the jury and chose to watch has one)");
    if (live.pending?.kind === "spectator-choice") return this.advanceView(null); // already open — idempotent
    if (live.pending) throw new EngineRefusal(`another decision (${live.pending.kind}) is open — answer it first`);
    return this.inOneCommit(() => {
      raiseSpectatorChoiceState(live, PLAYER);
      this.commit({ beat: "spectator-choice", content: `${PLAYER} asks to reconsider skipping ahead to the finale`, participants: [PLAYER] });
      return this.advanceView(null);
    });
  }

  /** Self-eviction cancel (0061 §4.2) — clear the confirmation; the player plays on, ACTIVE, unchanged. */
  cancelSelfEviction(): AdvanceView {
    if (!this.house || !this.live) return this.advanceView(null);
    return this.inOneCommit(() => {
      cancelSelfEvict(this.live!);
      this.persist();
      return this.advanceView(null);
    });
  }

  /**
   * Self-eviction step 2 (0061 §4.1) — the confirmed walk-out. A no-op unless the confirmation was
   * raised AND `confirmed` is true (the anti-accident gate; a stray/unconfirmed call never evicts).
   * Routes the exit through the SAME commit path every beat uses: `applySelfEviction` records a real
   * `self-eviction` BeatEvent (the registry records it player-witnessed + non-hidden), `commit` folds
   * its 0023 hidden impact, the player's status flips via the 0046 `evictionOrder` door, and the
   * snapshot persists. Never narrated-but-not-recorded: either this transition ran, or the player
   * is still in the house.
   */
  private resolveSelfEviction(confirmed: boolean): AdvanceView {
    const s = this.live!;
    // The gate: the OOC confirmation must be standing, the player must still be in, and the confirm
    // must be explicit. Any miss is a safe no-op (the player stays active) — never a fabricated exit.
    if (!confirmed || !s.selfEvictPending || s.finished || playerHasLeft(s, PLAYER)) {
      return this.advanceView(null);
    }
    return this.inOneCommit(() => {
      const ev = applySelfEviction(s, this.ctx());
      this.commit(ev); // record (witness = present house, non-hidden) + fold 0023 + sync + persist
      return this.advanceView(ev);
    });
  }

  /**
   * The player makes a deal with a houseguest (0039). Recorded as a player-witnessed event (their
   * knowledge); the engine reconciles it against later binding actions. Player↔NPC only — NPC↔NPC
   * deals are made off-screen and held in the Vault (never crosses this outward seam).
   */
  makeDeal(req: MakeDealReq): DealView | DealRefusal | null {
    // A10/#591/R1c — AT-MOST-ONCE: a REPEAT key returns the prior deal WITHOUT re-creating it or re-folding
    // the leverage/trade squeeze. Checked BEFORE guardBeatSeq so a re-driven duplicate is a clean no-op even
    // against a moved board (the double-apply case CAS cannot close). Synchronous ⇒ Node serializes callers.
    // The key is NAMESPACED by lever (`foldLedgerKey`) so the SAME idempotencyKey reused across two
    // different levers can't collide (returning one lever's cached result under another's type + skip).
    const idemKey = this.foldLedgerKey("makeDeal", req.idempotencyKey);
    const replay = this.foldReplay<DealView | DealRefusal | null>(idemKey);
    if (replay.hit) {
      return replay.value;
    }
    // 0065 Part A — refuse a deal computed against a superseded board BEFORE any mutation.
    this.guardBeatSeq(req.expectedBeatSeq);
    if (!this.house || !this.live) return null;
    // 0121: the ACTIVE-obligation kinds (comp-throw / veto-save) exist only when the deal-depth layer is on
    // (off ⇒ refuse, so no such deal is ever made in the calibration harness / a stock game — byte-identical).
    if (isPositiveObligation(req.kind) && !this.dealDepthEnabled) return null;
    const target = req.with;
    const evicted = new Set(this.live.evictionOrder);
    const isActiveOther = target !== PLAYER
      && this.house.npcs.some((n) => n.id === target) && !evicted.has(target);
    if (!isActiveOther) return null;
    // NPC CONSENT (anti-sycophancy): the ENGINE decides whether the NPC agrees, BEFORE anything is recorded or folded. A refusal returns here - no event, no deal, no
    // leverage/trade fold, no persist - and (when keyed) is remembered so a re-driven duplicate replays the same refusal. Flag OFF => this block does not exist.
    if (this.npcDealConsentEnabled) {
      const refusal = this.dealConsentRefusal(target, req.kind, isPositiveObligation(req.kind) ? (req.direction ?? "offer") : undefined);
      if (refusal) {
        if (idemKey !== undefined) this.rememberFoldIdempotent(idemKey, refusal);
        return refusal;
      }
    }
    const terms = (req.terms ?? "").slice(0, 200);
    const evId = this.onPlayerEvent?.(
      `${this.nameOf(PLAYER)} and ${this.nameOf(target)} make a ${req.kind} deal: ${terms}`,
      [PLAYER, target], "deal",
    );
    // `madeWeek` (E43) anchors the horizon: a safety/vote promise binds through THIS week's eviction.
    // #1802: when the flag is on, capture co-present houseguests (excluding the two deal parties)
    // as formation witnesses — recorded from presence ground truth at the commit moment.
    let witnesses: EntityId[] | undefined;
    if (this.dealsWitnessesEnabled && this.presence) {
      const playerRoom = this.presence.get(PLAYER);
      if (playerRoom !== undefined) {
        witnesses = Array.from(this.presence.entries())
          .filter(([id, room]) => room === playerRoom && id !== PLAYER && id !== target)
          .map(([id]) => id);
      }
    }
    // B55: an ASKED active obligation binds the NPC (the promisor is parties[0]); everything else keeps the player first, as before
    const parties: [EntityId, EntityId] = isPositiveObligation(req.kind) && req.direction === "ask" ? [target, PLAYER] : [PLAYER, target];
    const deal = this.deals.make(parties, req.kind, terms, evId, this.live.week, boundDealTerm(req.term, this.live.week), witnesses);
    // 0093 — OPTIONAL leverage: a secret the player holds ABOUT the partner colors the deal's formation
    // and folds the squeeze (a wary partner resents it / a persuadable one is bound tighter). The threat
    // persists while the deal is open — it is NOT spent here (only `exposeSecret` spends it). Absent ⇒
    // no extra rng, no fold — byte-identical to 0039.
    if (req.leverage) this.applyDealLeverage(req.leverage, target, deal.id);
    // 0099 — OPTIONAL traded secret: a secret about a THIRD party handed to the partner as consideration
    // (valued to the PARTNER); colors formation, surfaces the secret to the partner, and warms/sours them.
    if (req.tradedSecret) this.applyDealTrade(req.tradedSecret, target);
    this.persist();
    const view = this.dealView(deal);
    // A10/#591/R1c — record the at-most-once result ONLY after the clean commit, so a re-drive replays it.
    if (idemKey !== undefined) this.rememberFoldIdempotent(idemKey, view);
    return view;
  }

  /**
   * NPC deal CONSENT - the NPC's own decision on a player-proposed deal. Reads EXISTING engine state only (the NPC->player edge, the NPC memory grudge/favor, the belief
   * store's `targets-me` claims when its flag is on) and draws ONE value from a dedicated per-moment rng keyed on (game seed, "deal-consent", npc, week, phase) - the same
   * pattern as `secretRng`/`confide`, never the shared season rng. Returns the Vault-free refusal, or `null` when the NPC agrees.
   */
  private dealConsentRefusal(npcId: EntityId, kind: MakeDealReq["kind"], direction?: "offer" | "ask"): DealRefusal | null {
    const live = this.live;
    if (!live) return null;
    const e = this.rel.edge(npcId, PLAYER);
    const entries = this.npcMemoryEnabled ? this.memoryEntriesSeenBy(npcId, live.npcMemory?.[npcId]?.[PLAYER], PLAYER) : undefined;
    // standalone memory reads the ledger on its own; otherwise the residual floor (what the edge no longer carries) - the same split `memoryTiltFor` makes
    const carry = this.npcMemoryStandaloneEnabled ? { threatAboveBaseline: 0, bondAboveNeutral: 0 } : this.memoryCarry(npcId, PLAYER);
    const decay = this.memoryDecayScale(npcId);
    const rng = new SeededRandom(hashSeed(`${this.gameSeed ?? 0}:deal-consent:${npcId}:${live.week}:${this.phase}`));
    const jitter = (rng.next() * 2 - 1) * DEAL_CONSENT.jitter;
    const d = decideDealConsent({
      kind, ...(direction ? { direction } : {}),
      trust: e.trust, affinity: e.affinity, threat: e.threat,
      grudge: memoryGrudge(entries, live.week, decay, carry),
      favor: memoryFavor(entries, live.week, decay, carry),
      targetsMe: this.npcBeliefsEnabled ? targetsMeTilt(live.beliefs, npcId, PLAYER, live.week) : 0,
      jitter,
      ...(this.moodDealEnabled && this.npcTellsEnabled ? { mood: this.moodDealFor(npcId, kind) } : {}),
    });
    return d.accept || !d.reason ? null : { refused: true, reason: d.reason, narratable: DEAL_REFUSAL_LINE[d.reason] };
  }

  /**
   * 0093 — the secret-power per-moment seeded rng, keyed on (game seed, use, factId/subject, week, phase).
   * Repeated presses within a beat reach the same decision; a later beat re-rolls. No raw rng leaks the
   * outcome (anti-sycophancy). Sibling of the `confide` rng derivation.
   */
  private secretRng(use: string, key: string): SeededRandom {
    return new SeededRandom(hashSeed(`${this.gameSeed ?? 0}:secret:${use}:${key}:${this.week}:${this.phase}`));
  }

  /**
   * 0093/0099 — resolve a wielded secret descriptor to its SUBJECT + a Vault-safe severity. For a REAL
   * secret (a `factId`) it validates the player legitimately holds it (`knownTo(player)` — the bright
   * line; a non-learned/spent fact is rejected) and reads the subject + the holding NPC's PUBLIC secret
   * KIND for severity (never the sealed text). For a BLUFF it reads NOTHING from the Vault: severity is
   * the default and the subject is the claimed `subject`. Returns `null` when invalid (rejected).
   */
  private resolveWieldedSecret(
    d: { factId?: string; bluff?: boolean; subject?: EntityId },
  ): { subject: EntityId; severity: number; factId?: string; bluff: boolean } | null {
    if (d.bluff) {
      // A bluff invents a claim — no Vault read. It needs a named subject to fold against.
      if (!d.subject || !this.isActiveNpc(d.subject)) return null;
      return { subject: d.subject, severity: LEVERAGE.defaultSeverity, bluff: true };
    }
    if (!d.factId) return null;
    // The bright line: the player can only wield a fact they LEGITIMATELY HOLD. Reject anything else —
    // a suspicion, a never-learned secret, another entity's knowledge. No Vault-minting.
    // BDD audit D2: a Diary Room note is the player's PRIVATE booth record — never a wieldable secret. Exposing or
    // trading it would surface Diary Room content into a houseguest's knowledge (a DR→NPC pathway the wall forbids).
    const fact = (this.playerKnowledgeReader?.() ?? []).find((f) => f.pathway !== "diary-room" && ((f.factId ?? f.id) === d.factId || f.id === d.factId));
    if (!fact) return null;
    if (this.secretUsedAs[d.factId] === "exposed") return null; // spent (public) — never re-wielded
    // The subject is the houseguest the fact is about (the knowledge `subject`, or the descriptor's hint).
    const subject = fact.subject ?? d.subject;
    if (!subject || !this.isActiveNpc(subject)) return null;
    // Severity from the subject's PUBLIC secret KIND (never the sealed text) — the 0075 gloss sibling.
    const npc = this.house?.npcs.find((n) => n.id === subject);
    const secret = npc ? this.headlineSecretOf(npc) : undefined;
    return { subject, severity: severityOf(secret?.kind), factId: d.factId, bluff: false };
  }

  /** Whether an id is an active (non-evicted) NPC in the live house. */
  private isActiveNpc(id: EntityId): boolean {
    if (!this.house || !this.live || id === PLAYER) return false;
    return this.house.npcs.some((n) => n.id === id) && !this.live.evictionOrder.includes(id);
  }

  /** 0093 — the player→partner SIGNED warmth ((trust+affinity)/2 − threat) the deal-acceptance read uses. */
  private signedWarmthTowardPlayer(npcId: EntityId): number {
    const e = this.rel.edge(npcId, PLAYER);
    return (e.trust + e.affinity) / 2 - e.threat;
  }

  /**
   * 0093 — fold the LEVERAGE of a held secret against the deal partner. Computes the bounded, seeded
   * `leverageStrength`, then the acceptance read AFTER the boost: a persuadable partner is bound a little
   * tighter (a `strategy`-grade warm fold — the pressure landed), a WARY partner (the read lands below the
   * refusal floor) RESENTS the squeeze (the `squeezeBacklash` fold sours their read of the player). A
   * BLUFF folds the same shape weighted by BELIEF (and never tells the player whether it matched a truth);
   * a believed bluff is the same press, a disbelieved one bounces. The threat persists while the deal is
   * open — the secret is NOT marked spent here. The player never sees a number (anti-sycophancy).
   */
  private applyDealLeverage(d: SecretLeverDescriptor, partner: EntityId, _dealId: string): void {
    const resolved = this.resolveWieldedSecret({ ...d, subject: partner }); // leverage is ALWAYS about the partner
    // Leverage presses the PARTNER, so the secret must be about the partner (or a bluff claiming so).
    if (!resolved || (resolved.subject !== partner)) {
      // An invalid/irrelevant leverage simply does nothing (the deal still forms) — no fold, no spend.
      return;
    }
    const rng = this.secretRng("leverage", resolved.factId ?? `bluff:${partner}`);
    if (resolved.bluff) {
      this.playerBluffCount = Math.min(this.playerBluffCount + 1, LEVERAGE.maxPlayerBluffsPerSeason + 1);
      const e = this.rel.edge(partner, PLAYER);
      // Plausibility leans on the partner's own self-threat proxy — bluffing someone is dicey; if they
      // DON'T believe it, the squeeze bounces (no fold). If they do, it presses like a real leverage.
      if (!bluffBelieved(e.trust, e.threat, rng)) return;
    }
    const npc = this.house!.npcs.find((n) => n.id === partner)!;
    const strength = leverageStrength(this.leverageSignalsFor(npc), rng);
    const { accepts } = dealAcceptance(this.signedWarmthTowardPlayer(partner), leverageDealBoost(strength), LEVERAGE.refusalFloor);
    if (accepts) {
      // The pressure landed — the PARTNER is bound a little tighter: a strategy-grade fold on the
      // partner→player edge (initiator PLAYER, toward [partner], so the PARTNER's read of the player moves).
      foldHiddenImpact(this.rel, rng, PLAYER, [PLAYER, partner], "strategy", [partner]);
    } else {
      // A wary partner calls the squeeze and RESENTS it — their hidden read of the player sours (bounded).
      this.rel.applyImpactDirected(partner, PLAYER, LEVERAGE.squeezeBacklash, rng);
    }
  }

  /** 0093 — assemble the Vault-hidden leverageStrength signals (the subject's soul + their read of the player). */
  private leverageSignalsFor(npc: { id: EntityId; soul?: { emotionalState?: number }; character: { hiddenElements?: HiddenElement[] } }): LeverageSignals {
    const e = this.rel.edge(npc.id, PLAYER);
    return {
      severity: severityOf(this.headlineSecretOf(npc)?.kind),
      subjectEmotionalState: npc.soul?.emotionalState ?? 0.5,
      subjectTrust: e.trust, subjectAffinity: e.affinity, subjectThreat: e.threat,
    };
  }

  /**
   * 0099 — fold the TRADE of a held secret to the deal partner (the recipient). Values the secret TO THE
   * RECIPIENT (their reads of the secret's SUBJECT — a rival's secret is gold to that rival's enemy,
   * worthless to their ally), resolves whether they take it, warms them toward the giver (an accepted
   * trade) or sours them (peddling a worthless secret), surfaces the secret into the recipient's
   * knowledge (a recorded `told` pathway — never a Vault read), and marks the secret `traded`/caps it.
   */
  private applyDealTrade(d: SecretLeverDescriptor, recipient: EntityId): void {
    this.resolveAndTrade(d, recipient, "deal");
  }

  /**
   * 0099 — the shared trade resolution (used by `makeDeal`'s `tradedSecret` and the `tradeSecret` lever).
   * Returns whether the recipient accepted (and the Vault-safe reason on a refusal). Validates ownership,
   * values to the recipient, folds, surfaces the secret, marks used, caps. `null` on an invalid setup.
   */
  private resolveAndTrade(
    d: SecretLeverDescriptor, recipient: EntityId, _via: "deal" | "swap",
  ): { accepted: boolean; refused?: TradeResult["refused"]; narratable?: string } | null {
    if (!this.isActiveNpc(recipient)) return { accepted: false, refused: "no-recipient" };
    if (this.tradeCount >= (this.noHardCapsEnabled ? NO_HARD_CAPS.safetyValve : SECRET_TRADE.maxTradesPerSeason)) return { accepted: false, refused: "capped" };
    const resolved = this.resolveWieldedSecret(d);
    if (!resolved) return { accepted: false, refused: "not-learned" };
    if (resolved.subject === recipient) return { accepted: false, refused: "not-learned" }; // can't trade a secret TO its own subject
    // PO ruling 2026-11-03 (0099): "once the info is spread, there's no putting the genie back" — a secret cannot be
    // traded to someone who ALREADY KNOWS it (they witnessed it, or were told — including by an earlier trade). The
    // season cap is unchanged. A bluff carries no real fact, so it has nothing to be "already known".
    if (!resolved.bluff && resolved.factId && this.recipientKnowsSecret(recipient, resolved.factId)) {
      return { accepted: false, refused: "already-spent" };
    }
    const rng = this.secretRng("trade", `${resolved.factId ?? `bluff:${resolved.subject}`}:${recipient}`);
    if (resolved.bluff) {
      this.playerBluffCount = Math.min(this.playerBluffCount + 1, LEVERAGE.maxPlayerBluffsPerSeason + 1);
      const re = this.rel.edge(recipient, PLAYER);
      if (!bluffBelieved(re.trust, this.rel.edge(recipient, resolved.subject).threat, rng)) {
        return { accepted: false, refused: "declined" }; // they don't buy the fabricated secret
      }
    }
    const value = tradeValue(this.tradeSignalsFor(recipient, resolved.subject, resolved.severity), rng);
    const folds = tradeOutcome(value, this.signedWarmthTowardPlayer(recipient), rng);
    if (folds.accepted) {
      if (folds.recipientFold) this.rel.applyImpactDirected(recipient, PLAYER, folds.recipientFold, rng);
      if (resolved.bluff) {
        // A BELIEVED bluff: record it so a later contradicting TRUTH about the same subject catches the
        // player out (the passive lie-catch). A real trade DELIVERS the truth, so it also CATCHES any
        // earlier bluff the player told THIS recipient about this subject.
        this.recordPlayerBluffBelief(recipient, resolved.subject);
      } else {
        this.catchPlayerBluff(recipient, resolved.subject, rng, 0.8, "told"); // a real truth contradicts a prior bluff (evidence: the 0.8 told-by surfacing below)
        // The recipient now HOLDS the traded secret — a recorded `told-by:player` pathway (never a Vault read).
        const content = this.factContentFor(resolved.factId!) ?? `${this.nameOf(PLAYER)} shared a secret about ${this.nameOf(resolved.subject)}`;
        this.onSurfaceToHouseguest?.(recipient, content, resolved.subject, `told-by:${PLAYER}`, 0.8);
      }
      // Mark the REAL secret traded (monotonic — it has been spent into the economy); a bluff is not a real fact.
      if (resolved.factId && this.secretUsedAs[resolved.factId] !== "exposed") this.secretUsedAs[resolved.factId] = "traded";
      if (this.noHardCapsEnabled) {
        // B49: a habitual dealer is felt - each further trade costs THIS recipient's read of the player more (scaled by how much they trusted the player). Own rng: the base fold's stream is untouched.
        this.rel.applyImpactDirected(recipient, PLAYER, repetitionImpact(SECRET_TRADE.traderBacklash, this.tradeCount, this.rel.edge(recipient, PLAYER).trust), this.secretRng("trade-rep", `${recipient}:${this.tradeCount}`));
      }
      this.tradeCount++;
      if (this.npcMemoryWritersEnabled) this.remember(recipient, PLAYER, "secret-given", 0.3); // A24: the recipient remembers the player bought them something they wanted (a favor; bounded by the ledger)
      return { accepted: true, narratable: "they took the trade" };
    }
    // Refused — peddling a secret they don't want reads as untrustworthy (a bounded sour on their read).
    if (folds.traderBacklash) this.rel.applyImpactDirected(recipient, PLAYER, folds.traderBacklash, rng);
    return { accepted: false, refused: "declined", narratable: "they didn't bite" };
  }

  /**
   * Does `npcId` already hold the secret the player holds as `factId`? Matched by lineage (`factId`) or by the same
   * wording (a `told-by` surfacing re-mints the fact under the recipient, so the content is the stable key). Reads
   * only the recipient's OWN knowledge (witnessed or told) — never a suspicion, never the Vault.
   */
  private recipientKnowsSecret(npcId: EntityId, factId: string): boolean {
    const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, " ").trim();
    const content = this.factContentFor(factId);
    const want = content ? norm(content) : undefined;
    return (this.npcKnowledge?.known(npcId) ?? []).some(
      (k) => k.factId === factId || (want !== undefined && norm(k.content ?? "") === want),
    );
  }

  /** 0099 — assemble the Vault-hidden tradeValue signals (the RECIPIENT's reads of the secret's subject + the player). */
  private tradeSignalsFor(recipient: EntityId, subject: EntityId, severity: number): TradeSignals {
    const toSubject = this.rel.edge(recipient, subject);
    const toPlayer = this.rel.edge(recipient, PLAYER);
    return {
      severity,
      recipientThreatOfSubject: toSubject.threat,
      recipientAffinityForSubject: toSubject.affinity,
      recipientTrustOfPlayer: toPlayer.trust,
    };
  }

  /** 0093/0099 — the player-facing CONTENT of a learned fact (so a trade surfaces the SAME content the player holds). */
  private factContentFor(factId: string): string | undefined {
    return (this.playerKnowledgeReader?.() ?? []).find((f) => (f.factId ?? f.id) === factId || f.id === factId)?.content;
  }

  /** deception — record that `npc` BELIEVED a player bluff about `subject` (the passive lie-catch ledger). */
  private recordPlayerBluffBelief(npc: EntityId, subject: EntityId): void {
    const subjects = (this.playerBluffBelief[npc] ??= []);
    if (!subjects.includes(subject)) subjects.push(subject);
    // B23: a bluff the houseguest BELIEVED is a belief they hold (low confidence, from the player), refuted when caught.
    if (this.liesCaughtWriting && npc !== PLAYER) {
      const week = this.live!.week;
      recordClaim((this.live!.beliefs ??= {}), { id: this.bluffBeliefId(npc, subject, week), holder: npc, kind: "heard-rumor", subject, value: true, origin: "told", nature: "bluff", source: PLAYER, confidence: 0.6, week });
    }
  }

  /**
   * deception — the PASSIVE LIE-CATCH (owner direction): a genuine contradicting pathway about `subject`
   * has just reached `npc`. If the player earlier BLUFFED this `npc` about this `subject`, the bluff is
   * CAUGHT — the bluffer takes a betrayal-grade, recoverable hit on the npc→player edge (0026
   * `IMPACT.betrayal`), and the caught bluff is cleared (it can't re-fire). The player never sees a number.
   */
  private catchPlayerBluff(npc: EntityId, subject: EntityId, rng: SeededRandom, evidenceConfidence = 0.85, evidenceOrigin: "witnessed" | "told" = "witnessed"): void {
    const subjects = this.playerBluffBelief[npc];
    if (!subjects || !subjects.includes(subject)) return;
    if (this.liesCaughtWriting) {
      // B23: the npc now holds that the player lied to them, at the evidence's confidence; the bluff they had believed is refuted.
      this.writeLieCaught(npc, PLAYER, evidenceConfidence, evidenceOrigin);
      for (const c of claimsOf(this.live!.beliefs, npc)) if (c.kind === "heard-rumor" && c.nature === "bluff" && c.subject === subject && !c.refuted) c.refuted = true;
    }
    this.rel.applyDirected(npc, PLAYER, "betrayal", rng); // the npc realizes the player lied to them
    this.playerBluffBelief[npc] = subjects.filter((s) => s !== subject);
    recordDealBetrayal(this.live!, npc, PLAYER); // a jury-management demerit too (they remember the lie)
  }

  /**
   * 0107 — the player NAMES an alliance with a set of houseguests. Bond-GATED (anti-watering-down): a
   * proposed member joins only if their mutual bond with the player clears the floor; the unbonded
   * DECLINE, so you can't name everyone your ally. Needs ≥2 willing members or it doesn't form. Recorded
   * as the player's witnessed knowledge; the alliance then CEMENTS the bloc + banks favor (Vault-sealed
   * magnitudes — the player sees the NAME + who's in, never a number).
   */
  formAlliance(req: FormAllianceReq): AllianceView | null {
    this.guardBeatSeq(req.expectedBeatSeq);
    if (!this.house || !this.live) return null;
    const evicted = new Set(this.live.evictionOrder);
    const proposed = [...new Set(req.members)].filter(
      (id) => id !== PLAYER && this.house!.npcs.some((n) => n.id === id) && !evicted.has(id),
    );
    const bondOf = (a: EntityId, b: EntityId): number => (this.rel.edge(a, b).trust + this.rel.edge(a, b).affinity) / 2;
    const willing = willingMembers(PLAYER, proposed, (m) => Math.min(bondOf(PLAYER, m), bondOf(m, PLAYER)));
    if (willing.length < 2) return null; // nobody close enough bought in — no alliance of one
    const name = (req.name ?? "").slice(0, 60).trim() || "our alliance";
    const others = willing.filter((m) => m !== PLAYER);
    this.onPlayerEvent?.(
      `${this.nameOf(PLAYER)} forms an alliance "${name}" with ${others.map((m) => this.nameOf(m)).join(", ")}`,
      willing, "alliance",
    );
    const a = this.alliances.add(name, PLAYER, willing, this.beatSeqNow());
    this.persist();
    return this.allianceView(a);
  }

  /** 0107 — a Vault-safe view of a named alliance (the NAME + member names + whether the player founded it). */
  private allianceView(a: Alliance): AllianceView {
    return {
      id: a.id,
      name: a.name,
      members: a.members.map((m) => ({ id: m, name: this.nameOf(m) })),
      youAreFounder: a.founder === PLAYER,
    };
  }

  /** 0107 — the alliances the PLAYER is a member of (Vault-safe; never the cement/favor numbers). */
  private playerAllianceViews(): AllianceView[] {
    return this.alliances.forMember(PLAYER).map((a) => this.allianceView(a));
  }

  /**
   * 0107 Phase B — the player ACCEPTS an NPC's pitch and joins their alliance. Only a live pitch (the
   * player is `knownTo` but not a member) AND a close enough bond with the founder lets them in — a cold
   * "add me" to an alliance they were never offered is refused. Recorded as the player's knowledge.
   */
  joinAlliance(req: JoinAllianceReq): AllianceView | null {
    this.guardBeatSeq(req.expectedBeatSeq);
    if (!this.house || !this.live) return null;
    const a = this.alliances.byId(req.allianceId);
    if (!a || a.members.includes(PLAYER) || !a.knownTo.includes(PLAYER)) return null; // not an open pitch
    const bondOf = (x: EntityId, y: EntityId): number => (this.rel.edge(x, y).trust + this.rel.edge(x, y).affinity) / 2;
    if (Math.min(bondOf(PLAYER, a.founder), bondOf(a.founder, PLAYER)) < ALLIANCE.joinBondFloor) return null; // not close enough
    const joined = this.alliances.join(a.id, PLAYER)!;
    this.onPlayerEvent?.(`${this.nameOf(PLAYER)} joins the alliance "${joined.name}"`, [...joined.members], "alliance");
    this.persist();
    return this.allianceView(joined);
  }

  /**
   * 0107 Phase B — the named-alliance BETRAYAL fold: when a houseguest takes a binding ADVERSE action
   * (nominate / replace / vote-evict) against someone they share a named alliance with, that betrayal
   * cuts deeper than an unspoken one — a bounded threat ▲ / affinity ▼ on the wronged → betrayer edge, a
   * jury demerit, a witnessed reveal, and the betrayer leaves the alliance (it fractures). Gated by a
   * SHARED alliance existing ⇒ no alliances ⇒ no fold ⇒ the seeded spine is byte-identical.
   */
  /**
   * #1963 — is this break tied to the SECRET weekly eviction ballot AND observable through the wronged party's behaviour?
   * Only an NPC's vote-evict that is backed by the CURRENT staged ballot (`live.eviction.voteOf`) counts: the Final-3 vote is
   * the final HOH's open personal vote (no secret ballot exists), a stale ballot from a previous week must never attribute a
   * later break, and a PLAYER-wronged break keeps the full fold (nothing acts on the player's hidden read).
   */
  private sealedBreak(wronged: EntityId, breaker: EntityId, kind: BindingAction["kind"]): boolean {
    return kind === "vote-evict" && breaker !== PLAYER && wronged !== PLAYER && this.live?.eviction?.voteOf?.[breaker] === wronged;
  }

  /** Everyone who voted to evict `wronged` on the CURRENT staged weekly ballot (the set a sealed break is shared across). */
  private ballotSuspects(wronged: EntityId): EntityId[] {
    const voteOf = this.live?.eviction?.voteOf ?? {};
    return Object.entries(voteOf).filter(([, target]) => target === wronged).map(([voter]) => voter as EntityId);
  }

  private reconcileAllianceBetrayals(action: BindingAction): void {
    if (!this.live || !ALLIANCE_ADVERSE.has(action.kind)) return;
    for (const target of action.targets) {
      if (target === action.actor) continue;
      for (const al of this.alliances.shared(action.actor, target)) {
        // #1963: a betrayal tied to the SECRET weekly ballot (an NPC wronged by an NPC's vote-evict) must not single the
        // betrayer out through the wronged ally's hidden read either, so the bump is SHARED across every voter who voted to
        // evict them and no jury demerit names the betrayer. Public actions (nominate / replace / the open Final-3 vote) and
        // the player-wronged path keep the attributed fold.
        const sealed = this.sealedBreak(target, action.actor, action.kind);
        const pool = sealed ? [...new Set([...this.ballotSuspects(target), action.actor])].sort() : [action.actor];
        for (const who of pool) {
          const e = this.rel.edge(target, who);
          e.threat = Math.min(1, e.threat + ALLIANCE.betrayalThreatBump / pool.length);
          e.affinity = Math.max(0, e.affinity - ALLIANCE.betrayalThreatBump / pool.length);
        }
        if (!sealed) recordDealBetrayal(this.live, target, action.actor);
        // A7/E12: mirrors the deal-break seal below — a betrayal TRIGGERED by the SEALED eviction
        // ballot must not name the betrayer to the wronged ally before the retrospective unseals it
        // (nominate/replace are public ceremonies and reveal normally; the player's OWN vote is never
        // sealed from themselves).
        if (action.kind === "vote-evict" && action.actor !== PLAYER) {
          this.onPlayerEvent?.(
            `${this.nameOf(action.actor)} turned on the alliance "${al.name}", moving against ${this.nameOf(target)}`,
            [action.actor], "betrayal", // no player witness ⇒ Vault-held until the 0048 unseal
          );
          this.onPlayerEvent?.(
            `Someone turned on the alliance "${al.name}"`,
            [target], "betrayal",
          );
        } else {
          this.onPlayerEvent?.(
            `${this.nameOf(action.actor)} turned on the alliance "${al.name}", moving against ${this.nameOf(target)}`,
            [target, action.actor], "betrayal",
          );
        }
        this.alliances.removeMember(al.id, action.actor); // the betrayer is out — the alliance fractures
      }
    }
  }

  /**
   * 0075 — the trust-gated confidence (the single authority). The model presses the ally and calls this;
   * the ENGINE decides everything (whether they open up, how much, true or a lie) and RECORDS the
   * disclosure as the player's knowledge. Vault-safe by construction: an undisclosed secret is never
   * handed to the model; a sub-`full` tier never returns the whole premise; a lie is engine-authored
   * from the public archetype (no real secret of anyone). Monotonic for a true confidence.
   */
  confide(npcId: EntityId, expectedBeatSeq?: number, idempotencyKey?: string): ConfideResult | null {
    // A10/#591/R1c — AT-MOST-ONCE: a REPEAT key returns the prior disclosure WITHOUT re-folding the bond
    // bump / re-incrementing the lie ledger. Checked BEFORE guardBeatSeq so a re-driven duplicate is a
    // clean no-op even against a moved board (the double-apply case CAS cannot close). Key NAMESPACED by
    // lever so the same key on another verb can't collide.
    const idemKey = this.foldLedgerKey("confide", idempotencyKey);
    const replay = this.foldReplay<ConfideResult | null>(idemKey);
    if (replay.hit) return replay.value;
    // 0065 Part A — refuse a confidence computed against a superseded board BEFORE any mutation.
    this.guardBeatSeq(expectedBeatSeq);
    if (!this.house || !this.live) return null;
    const npc = this.house.npcs.find((n) => n.id === npcId);
    const evicted = new Set(this.live.evictionOrder);
    if (!npc || evicted.has(npcId)) return null; // unknown / departed ⇒ no confidence path
    const none: ConfideResult = { disclosed: false, tier: "none", truthful: true };
    // AMEND 0075 item 4: "never a cold pop-up" is ENGINE-enforced - a houseguest who is not in the player's room is not in a scene with them, so they disclose nothing (no content, no bond fold).
    // Only when presence is tracked (a bare harness without a house map is unchanged).
    if (this.presence && this.presence.get(PLAYER) !== this.presence.get(npcId)) return none;
    const secret = this.headlineSecretOf(npc);
    if (!secret) return none; // nothing sealed to share

    const signals = this.confidenceSignalsFor(npc);
    // Deterministic, seeded per (npc, beat): repeated presses inside one beat reach the same decision;
    // a later press (bond grown, a new week) re-rolls. No raw rng leaks the outcome (anti-sycophancy).
    const rng = new SeededRandom(hashSeed(`${this.gameSeed ?? 0}:confide:${npcId}:${this.week}:${this.phase}`));
    const decision = this.noHardCapsEnabled
      ? decideConfidence(signals, rng, { liesRemaining: NO_HARD_CAPS.safetyValve - this.lieCount, lieProbScale: lieProbScale(this.confideLiesBy[npcId] ?? 0) })
      : decideConfidence(signals, rng, { liesRemaining: CONFIDENCE.maxLiesPerSeason - this.lieCount });
    this.noteDisclosure(npcId, confideToDisclosure(decision)); // B33: the closed-set record of what the engine just rolled (the decision itself is untouched)
    if (!decision.disclosed) return none;

    // Monotonic: never re-tell a TRUE secret at a LOWER tier than already reached — idempotent, no new
    // fold (the house's memory only deepens; it never thins, 0007/0030). A lie is its own track.
    const prior = this.confideState[npcId];
    if (decision.truthful && prior?.truthful
      && this.tierRank(decision.tier) <= this.tierRank(prior.tier)) {
      return { disclosed: true, tier: prior.tier, truthful: true, content: discloseTrue(secret, prior.tier) };
    }

    // 0075 — the PASSIVE LIE-CATCH (spec open-Q #4). A genuine, truthful disclosure from a houseguest who
    // PREVIOUSLY planted a lie is the contradicting truth finally reaching the player through a real
    // pathway (they bonded, and now tell the real thing). The earlier false belief flips to the truth
    // (recorded below at the higher truthful confidence), and the realization folds a BETRAYAL-grade blow
    // on the player's read of the liar — in place of the warm bond bump (you do not warmly bond on the
    // beat you catch them out). The player lever only ⇒ never on the seeded sim path ⇒ byte-identical.
    const catchingLie = decision.truthful && prior?.truthful === false;

    const content = decision.truthful ? discloseTrue(secret, decision.tier) : fabricate(rng, secret.kind);
    // Record it as the player's knowledge through the in-game `told-by` pathway (0002, E9) — so it is
    // correctly Journal-visible knowledge, never Vault content. A lie is recorded the same way (the
    // player believes it); the engine knows it is false (`confideState.truthful`).
    this.onConfide?.(npcId, content, decision.truthful ? 0.85 : 0.6);
    if (catchingLie) {
      // The player catches the earlier lie: a betrayal-grade blow on the player→liar edge (0026 IMPACT.betrayal).
      this.rel.applyDirected(PLAYER, npcId, "betrayal", rng);
    } else {
      // Fold the vulnerability bond bump (0023): opening up DEEPENS the bond toward the player.
      foldHiddenImpact(this.rel, rng, npcId, [npcId, PLAYER], CONFIDENCE.bondNature, [PLAYER]);
    }
    if (!decision.truthful) { this.lieCount++; if (this.noHardCapsEnabled) this.confideLiesBy[npcId] = (this.confideLiesBy[npcId] ?? 0) + 1; }
    this.confideState[npcId] = { tier: decision.tier, truthful: decision.truthful };
    this.persist();
    const result: ConfideResult = { disclosed: true, tier: decision.tier, truthful: decision.truthful, content };
    // A10/#591/R1c — record the at-most-once result ONLY after the clean commit, so a re-drive replays it.
    if (idemKey !== undefined) this.rememberFoldIdempotent(idemKey, result);
    return result;
  }

  /**
   * 0093 — OUT a learned secret to the house (the single engine authority). Validates the player
   * legitimately holds the `factId` (a non-learned secret is REJECTED — the Vault bright line; no
   * minting), caps per season, resolves the bounded, seeded standing hit on the subject (folded onto
   * EVERY other active houseguest's read of them — the house re-reads them as a liability) + the
   * betrayal-grade backlash on the exposer FROM the subject + the smaller house recoil + an optional
   * jury mark, RECORDS the exposure as a witnessed pathway event so the house now KNOWS it (0002 —
   * never a Vault read), and marks the secret SPENT (`usedAs: exposed` — never re-wielded). A `bluff`
   * is a separate path: a public CLAIM with no Vault read, folded on belief; the engine never tells the
   * player whether it matched a truth. No number ever crosses (anti-sycophancy). `null` pre-game.
   */
  exposeSecret(req: ExposeSecretReq): ExposeResult | null {
    // A10/#591/R1c — AT-MOST-ONCE: a REPEAT key returns the prior expose WITHOUT re-folding the house-wide
    // standing hit / re-spending the secret / re-incrementing the cap. Checked BEFORE guardBeatSeq so a
    // re-driven duplicate is a clean no-op even against a moved board (the double-apply CAS cannot close).
    // Key NAMESPACED by lever so the same key on another verb can't collide.
    const idemKey = this.foldLedgerKey("exposeSecret", req.idempotencyKey);
    const replay = this.foldReplay<ExposeResult | null>(idemKey);
    if (replay.hit) return replay.value;
    this.guardBeatSeq(req.expectedBeatSeq);
    if (!this.house || !this.live) return null;
    // A real secret already exposed (public) can't be exposed again — checked BEFORE resolution (the
    // resolver rejects a spent fact as un-wieldable, which would otherwise read as `not-learned`).
    if (req.factId && this.secretUsedAs[req.factId] === "exposed") return { exposed: false, refused: "already-spent" };
    if (this.exposeCount >= (this.noHardCapsEnabled ? NO_HARD_CAPS.safetyValve : LEVERAGE.maxExposesPerSeason)) return { exposed: false, refused: "capped" };
    const resolved = this.resolveWieldedSecret({ factId: req.factId, bluff: req.bluff, subject: req.subject });
    if (!resolved) return { exposed: false, refused: req.bluff ? "no-subject" : "not-learned" };
    const subject = resolved.subject;
    const rng = this.secretRng("expose", resolved.factId ?? `bluff:${subject}`);
    if (resolved.bluff) {
      this.playerBluffCount = Math.min(this.playerBluffCount + 1, LEVERAGE.maxPlayerBluffsPerSeason + 1);
      // A public bluff lands by the HOUSE's average willingness to believe a claim about the subject —
      // plausibility on their collective threat read. If it bounces, the exposer just takes the recoil
      // (crying wolf), no subject hit. The engine never reveals whether it matched a real truth.
      const houseThreat = this.avgHouseThreatOf(subject);
      if (!bluffBelieved(this.avgHouseTrustOfPlayer(), houseThreat, rng)) {
        // Disbelieved — only the exposer recoil (a thin ruthlessness/credibility cost), no standing hit.
        this.foldHouseRecoilOnExposer(subject, rng);
        this.foldRepetitionOnExposer(subject);
        this.exposeCount++;
        this.persist();
        const bounced: ExposeResult = { exposed: true, subjectImpactNarratable: "the house didn't seem to buy it" };
        if (idemKey !== undefined) this.rememberFoldIdempotent(idemKey, bounced);
        return bounced;
      }
    }
    const folds = exposeOutcome(resolved.severity, rng);
    // The standing hit: EVERY other active houseguest re-reads the subject as a liability (bounded fold).
    const evicted = new Set(this.live.evictionOrder);
    for (const other of this.house.npcs) {
      if (other.id === subject || evicted.has(other.id)) continue;
      this.rel.applyImpactDirected(other.id, subject, folds.subjectHit, rng);
      if (resolved.bluff) {
        // A believed BLUFF expose: record it against each houseguest so a later contradicting TRUTH catches it.
        this.recordPlayerBluffBelief(other.id, subject);
      } else {
        // A REAL expose DELIVERS the truth to the house — it CATCHES any earlier bluff about this subject.
        this.catchPlayerBluff(other.id, subject, rng, 0.85, "witnessed"); // evidence: the 0.85 public exposure
      }
    }
    // The exposer takes the betrayal-grade hit FROM the subject (the deepest wound — outing IS betrayal).
    this.rel.applyImpactDirected(subject, PLAYER, folds.exposerBacklashFromSubject, rng);
    // The rest of the house recoils a little from the exposer (ruthlessness read).
    this.foldHouseRecoilOnExposer(subject, rng);
    this.foldRepetitionOnExposer(subject);
    // The jury mark (0014): the subject's eventual jurors weigh the outing against the exposer.
    if (folds.juryMark) recordDealBetrayal(this.live, subject, PLAYER);
    // A24: the subject REMEMBERS being outed (a deep grudge about the player; severity grows with the secret's, bounded by the ledger cap).
    if (this.npcMemoryWritersEnabled) this.remember(subject, PLAYER, "secret-exposed", Math.min(1, 0.4 + 0.4 * resolved.severity));
    // Surface the exposure to the house as a WITNESSED pathway event — the house now KNOWS it (0002).
    const content = resolved.bluff ? `${this.nameOf(PLAYER)} outed something about ${this.nameOf(subject)} to the house`
      : this.factContentFor(resolved.factId!) ?? `${this.nameOf(PLAYER)} exposed a secret about ${this.nameOf(subject)}`;
    this.exposeToHouse(subject, content, resolved.bluff ? 0.6 : 0.85);
    // Mark the REAL secret SPENT (public ⇒ never re-leveraged). A bluff is not a real fact to mark.
    if (resolved.factId) this.secretUsedAs[resolved.factId] = "exposed";
    this.exposeCount++;
    this.persist();
    const result: ExposeResult = { exposed: true, subjectImpactNarratable: "the house is reeling from it" };
    // A10/#591/R1c — record the at-most-once result ONLY after the clean commit, so a re-drive replays it.
    if (idemKey !== undefined) this.rememberFoldIdempotent(idemKey, result);
    return result;
  }

  /**
   * 0099 — TRADE a held secret to a THIRD-PARTY recipient for a one-off concession (a comp throw, a
   * secret-for-secret swap). The single engine authority — see `resolveAndTrade` for the resolution; this
   * is the public lever for a NON-deal trade (a standing deal uses `makeDeal`'s `tradedSecret`). `null`
   * pre-game / for an unknown recipient.
   */
  tradeSecret(req: TradeSecretReq): TradeResult | null {
    // A10/#591/R1c — AT-MOST-ONCE: a REPEAT key returns the prior trade WITHOUT re-folding the recipient's
    // warmth/sour or re-incrementing the trade cap. Checked BEFORE guardBeatSeq so a re-driven duplicate is
    // a clean no-op even against a moved board (the double-apply case CAS cannot close). Key NAMESPACED by
    // lever so the same key on another verb can't collide.
    const idemKey = this.foldLedgerKey("tradeSecret", req.idempotencyKey);
    const replay = this.foldReplay<TradeResult | null>(idemKey);
    if (replay.hit) return replay.value;
    this.guardBeatSeq(req.expectedBeatSeq);
    if (!this.house || !this.live) return null;
    const out = this.resolveAndTrade(
      { factId: req.factId, bluff: req.bluff, subject: req.subject }, req.toNpcId, "swap",
    );
    if (!out) return { accepted: false, refused: "no-recipient" };
    this.persist();
    // A10/#591/R1c — record the at-most-once result ONLY after the clean commit, so a re-drive replays it.
    if (idemKey !== undefined) this.rememberFoldIdempotent(idemKey, out);
    return out;
  }

  /** 0093 — the rest of the house recoils a little from the EXPOSER (outing reads as ruthless). */
  private foldHouseRecoilOnExposer(subject: EntityId, rng: SeededRandom): void {
    if (!this.house || !this.live) return;
    const evicted = new Set(this.live.evictionOrder);
    for (const other of this.house.npcs) {
      if (other.id === subject || evicted.has(other.id)) continue;
      this.rel.applyImpactDirected(other.id, PLAYER, LEVERAGE.exposerBacklashFromHouse, rng);
    }
  }

  /**
   * B49 - the REPETITION COST of a further expose (flag-on only; a no-op otherwise). Every other active houseguest re-reads the exposer a little worse for each expose the player already made this
   * season, scaled by how much THAT houseguest had trusted the player: the limit is felt in the house's read, never announced as a count. Own rng so the base folds' stream is untouched.
   */
  private foldRepetitionOnExposer(subject: EntityId): void {
    if (!this.noHardCapsEnabled || !this.house || !this.live || this.exposeCount <= 0) return;
    const evicted = new Set(this.live.evictionOrder);
    for (const other of this.house.npcs) {
      if (other.id === subject || evicted.has(other.id)) continue;
      this.rel.applyImpactDirected(other.id, PLAYER, repetitionImpact(LEVERAGE.exposerBacklashFromHouse, this.exposeCount, this.rel.edge(other.id, PLAYER).trust), this.secretRng("expose-rep", `${other.id}:${this.exposeCount}`));
    }
  }

  /** 0093 — surface an exposed secret to EVERY other active houseguest as witnessed knowledge (0002). The
   *  player is the teller (`told-by:player`): the house learns it BECAUSE the player outed it — a recorded
   *  in-game pathway anchored on the player's own held content (E9), never a Vault read. */
  private exposeToHouse(subject: EntityId, content: string, confidence: number): void {
    if (!this.house || !this.live) return;
    const evicted = new Set(this.live.evictionOrder);
    for (const other of this.house.npcs) {
      if (other.id === subject || evicted.has(other.id)) continue;
      this.onSurfaceToHouseguest?.(other.id, content, subject, `told-by:${PLAYER}`, confidence);
    }
  }

  /** 0093 — the house's average TRUST in the player (a bluff's believability proxy). */
  private avgHouseTrustOfPlayer(): number {
    if (!this.house || !this.live) return 0;
    const evicted = new Set(this.live.evictionOrder);
    const npcs = this.house.npcs.filter((n) => !evicted.has(n.id));
    if (!npcs.length) return 0;
    return npcs.reduce((s, n) => s + this.rel.edge(n.id, PLAYER).trust, 0) / npcs.length;
  }

  /** 0093 — the house's average THREAT read of a subject (a bluff's plausibility proxy). */
  private avgHouseThreatOf(subject: EntityId): number {
    if (!this.house || !this.live) return 0.5;
    const evicted = new Set(this.live.evictionOrder);
    const npcs = this.house.npcs.filter((n) => !evicted.has(n.id) && n.id !== subject);
    if (!npcs.length) return 0.5;
    return npcs.reduce((s, n) => s + this.rel.edge(n.id, subject).threat, 0) / npcs.length;
  }

  /** 0075 — the headline sealed secret a houseguest would confide (their first hidden element). */
  private headlineSecretOf(npc: { character: { hiddenElements?: HiddenElement[] } }): HiddenElement | undefined {
    // 0091 — a TRIGGER is a volatility, not a confidable fact: it ERUPTS (a witnessed public consequence,
    // 0091), it is never TOLD (the 0075 confidence path). So a confidence is drawn from the first NON-trigger
    // hidden element — the trigger's sealed wording NEVER crosses the confidence pathway (the inverse
    // companion to 0075: in 0091 the attribute itself stays fully sealed; only its effect is seen).
    return npc.character.hiddenElements?.find((e) => e.kind !== "trigger");
  }

  /** 0075 — assemble the Vault-hidden confidence signals from the existing relationship + deal ledger. */
  private confidenceSignalsFor(npc: { id: EntityId; character: { archetype: string } }): ConfidenceSignals {
    const npcToPlayer = this.rel.edge(npc.id, PLAYER);
    const playerToNpc = this.rel.edge(PLAYER, npc.id);
    return {
      npcTrust: npcToPlayer.trust,
      npcAffinity: npcToPlayer.affinity,
      npcThreat: npcToPlayer.threat,
      playerTrust: playerToNpc.trust,
      playerAffinity: playerToNpc.affinity,
      goodwill: this.goodwillFromDeals(npc.id),
      archetype: npc.character.archetype,
    };
  }

  /**
   * 0075 — the banked-goodwill scalar ∈ [0,1] derived from the 0039 deal ledger (NOT a new authored
   * signal): kept word + an open pact build it, a broken deal subtracts. Bounded by `CONFIDENCE`.
   */
  private goodwillFromDeals(npcId: EntityId): number {
    const between = this.deals.forParty(PLAYER).filter((d) => d.parties.includes(npcId));
    let g = 0;
    for (const d of between) {
      if (d.status === "kept") g += CONFIDENCE.keptDealGoodwill;
      else if (d.status === "open") g += CONFIDENCE.openDealGoodwill;
      else if (d.status === "broken") g -= CONFIDENCE.brokenDealPenalty;
    }
    // 0107: a NAMED alliance the player shares with this houseguest banks a little good favor (bounded,
    // saturation-diluted) — the "easy favor with your allies" lever. 0 when they share none.
    g += allianceFavor(this.alliances.all(), npcId, PLAYER);
    return Math.max(0, Math.min(1, g));
  }

  /** 0075 — order the disclosure tiers for the monotonic guard (none < tease < partial < full). */
  private tierRank(tier: DisclosureTier): number {
    return { none: 0, tease: 1, partial: 2, full: 3 }[tier];
  }

  /**
   * 0075 — the Vault-SAFE `mayConfide` hint for `npcVoice` (the emergent "no cold open" path). Present
   * ONLY when the genuine disclosure motive clears the floor AND a fresh precipitating event makes the
   * moment plausible (a recent player-witnessed scene with this houseguest). Carries a `reason` word +
   * a `warmth` word — NEVER the secret, NEVER a number. Returns `undefined` otherwise (the common case).
   */
  private mayConfideFor(npc: { id: EntityId; character: { archetype: string } }): NpcVoiceView["mayConfide"] {
    if (!this.onConfide) return undefined; // no pathway wired ⇒ no emergent hint (e.g. bare unit harness)
    const signals = this.confidenceSignalsFor(npc);
    const motive = disclosureMotive(signals);
    if (disclosureTier(motive) === "none") return undefined; // below the floor ⇒ not ready
    // The motive must be carried by GENUINE closeness, not the strategic-lie pull — the hint invites a
    // real opening (a lie still routes through `confide`, but it is never advertised as readiness).
    if (!this.recentPlayerSceneWith(npc.id)) return undefined; // not earned by the scene ⇒ no cold open
    const between = this.deals.forParty(PLAYER).filter((d) => d.parties.includes(npc.id));
    const reason = between.some((d) => d.status === "kept") ? CONFIDENCE.reasons.keptWord
      : between.some((d) => d.status === "open") ? CONFIDENCE.reasons.openPact
        : CONFIDENCE.reasons.closeness;
    return { ready: true, reason, warmth: motive >= CONFIDENCE.bands.full ? "high" : "growing" };
  }

  /**
   * 0075 — was there a FRESH precipitating scene between the player and this houseguest (a favor, a
   * rattled moment, a deal just struck)? The "no cold open" anchor: a confidence reads as prompted by
   * what just happened, never a non-sequitur. Vault-free — reads only the recent player-witnessed
   * relationship history the adapter already tracks (an open/kept deal between them is the concrete
   * proxy a precipitating favor leaves behind).
   */
  private recentPlayerSceneWith(npcId: EntityId): boolean {
    return this.deals.forParty(PLAYER).some(
      (d) => d.parties.includes(npcId) && (d.status === "open" || d.status === "kept"),
    );
  }

  /**
   * 0096 — the Vault-SAFE `rivalry` tone hint for `npcVoice`, present ONLY for the currently-held
   * nemesis and ONLY inside a live scene with them (no cold-open arc announcement, the 0075 sibling
   * guarantee). Carries a coarse HEAT WORD only — never a number, never "this is your nemesis," never
   * the threat edge. Reads the nemesis's OWN threat-toward-player edge (perspective-bound, the same
   * symmetric-perspective spine 0085/0086 hold) to pick the band. `undefined` for everyone else (the
   * common case) and whenever the campaign layer hasn't elevated anyone.
   */
  private rivalryFor(npcId: EntityId): NpcVoiceView["rivalry"] {
    if (this.nemesisTrack.current !== npcId) return undefined;
    if (!this.presence || !this.house) return undefined;
    const room = this.presence.get(npcId);
    if (!room || this.presence.get(this.house.player.id) !== room) return undefined; // only in a live scene
    const threat = this.rel.edge(npcId, PLAYER).threat;
    return { tone: threat >= NEMESIS.threatThreshold + NEMESIS.handoffMargin ? "open" : "simmering" };
  }

  /** Reconcile a binding action against open player-party deals: kept/broken + the fallout (0039). */
  private reconcileDeals(action: BindingAction): void {
    if (!this.live) return;
    const { broken } = this.deals.reconcile(action, {
      rel: this.rel,
      rng: this.beatRng(),
      // 0109 / #1993: the week the break lands in — lets an explicit negotiated term scale the betrayal-shock by
      // the life it had left. A deal with no `expiresWeek` scales by 1 either way ⇒ byte-identical to 0039.
      currentWeek: this.live.week,
      // 0121: the deal-depth layer — a kept deal compounds via the LOYALTY STREAK (consecutive kept deals
      // with the same partner scale the honored fold, bounded). OFF ⇒ the plain 0039/0109 honored fold,
      // byte-identical.
      dealDepth: this.dealDepthEnabled,
      // 0121 R1: a kept deal also seeds a diffusing "keeps their word" reputation — the honorer's deal
      // partner spreads it NPC→NPC, and third parties who hear it lean toward the honorer as a safer deal
      // partner (the positive mirror of the betrayal rumor). The ledger only calls this when `dealDepth`
      // is on, and the sink is registry-wired (it owns the KnowledgeService), so off ⇒ byte-identical.
      reputation: (honorer, other) => {
        this.dealReputationSink?.(honorer, other);
        // B2: the partner remembers the deal being KEPT (a favor), written alongside the diffusing reputation (same `dealDepth` gate). `remember` skips the player as holder.
        if (this.npcMemoryWritersEnabled) this.remember(other, honorer, "deal-kept", 0.5);
      },
      // 0014: the wronged party will weigh this betrayal against the breaker in their jury lean.
      // #1802: formation-witness deal collateral — when enabled, the formation trust-fold
      // scales with audience size (capped by caps) and breaches seed into witness knowledge.
      // OFF ⇒ the plain fold and no diffusion ⇒ byte-identical.
      dealsWitnesses: this.dealsWitnessesEnabled,
      // #1802: at breach, seed the breach fact into each formation-witness via the standard
      // 0038 diffusion pathway. The registry wires this to the KnowledgeService/gossip;
      // standalone ⇒ no-op ⇒ byte-identical.
      revealToWitness: (witness, breaker) => {
        this.onPlayerEvent?.(
          `${this.nameOf(breaker)} broke a deal that ${this.nameOf(witness)} witnessed`,
          [witness], "betrayal",
        );
      },
      juryDemerit: (wronged, breaker) => recordDealBetrayal(this.live!, wronged, breaker),
      // #1963: a break tied to a SECRET eviction ballot (an NPC's vote-evict; the player's own vote is never sealed from
      // themselves) is not attributable by any hidden fold an NPC acts on, so it is skipped when the PLAYER is the wronged
      // party (nothing acts on the player's hidden read). The suspects are every voter who voted to evict the wronged.
      sealed: (wronged, breaker, kind) => this.sealedBreak(wronged, breaker, kind),
      suspects: (wronged) => this.ballotSuspects(wronged),
      // 0002: the wronged party learns the break as a witnessed event (a public ceremony break) —
      // UNLESS the triggering action is the SEALED eviction ballot (E12/A7). Naming the breaker there
      // would deanonymize their vote before the same terminal gate the primary eviction reveal and the
      // 0048 retrospective use: record the full attribution VAULT-SIDE (no player witness ⇒ hidden by
      // the event-visibility invariant, `validateEvent`), and give the wronged party only a Vault-safe,
      // unattributed signal now — they may suspect, never know, until the retrospective unseals it (the
      // same hidden-event sweep, `buildVaultUnseal`, already surfaces it then). The player's OWN vote is
      // never sealed from themselves, and a break from a PUBLIC action (nominate/replace) reveals as before.
      reveal: (wronged, breaker, deal, actionKind) => {
        if (actionKind === "vote-evict" && breaker !== PLAYER) {
          this.onPlayerEvent?.(
            `${this.nameOf(breaker)} broke a ${deal.kind} deal with ${this.nameOf(wronged)}`,
            [breaker], "betrayal", // no player witness ⇒ Vault-held until the 0048 unseal
          );
          return this.onPlayerEvent?.(
            `Someone broke a ${deal.kind} deal with ${this.nameOf(wronged)}`,
            [wronged], "betrayal",
          );
        }
        // 0024: an ATTRIBUTED break (a public action, or the player's own vote) is a memory the wronged party holds; the
        // sealed-ballot branch above deliberately writes none (it would de-anonymize the vote through behaviour).
        this.remember(wronged, breaker, "deal-broken", Math.min(1, 0.6 * breakSeverityScale(deal, this.live?.week)));
        return this.onPlayerEvent?.(
          `${this.nameOf(breaker)} broke a ${deal.kind} deal with ${this.nameOf(wronged)}`,
          [wronged, breaker], "betrayal",
        );
      },
    });
    if (broken.length > 0) this.persist(); // deferred into the beat's ONE commit (E3)
  }

  /**
   * EVERY binding action a resolved beat represents (audit E42 — the ledger must see NPC binding
   * actions, not only the player's). An eviction beat yields one `vote-evict` per voter (player
   * and NPC alike, from the staged reveal's `voteOf`) plus the HOH's deciding vote on a tie; the
   * Final-3 eviction is the final HOH's personal vote. `alternatives` (E43) scope honoring to
   * actions where the partner was a real option.
   */
  private bindingActionsFor(ev: BeatEvent): BindingAction[] {
    const s = this.live;
    if (!s) return [];
    switch (ev.beat) {
      // 0121: a comp CROWN is where a `comp-throw` promise resolves — judged by OUTCOME (did the promisor
      // WIN the comp they swore to throw?), which is observable here; no fragile comp-intent threading.
      // A compete action per competitor: the winner "won" (breaks a throw-promise), everyone else "threw"
      // (kept — they didn't take the power). Gated on the deal-depth layer (off ⇒ no comp-throw deals ⇒
      // a no-op anyway — byte-identical). The intermediate inert comp-round/comp-elimination beats never
      // reach here (distinct beat keys); this fires only at the crown, where the winner is set.
      case "hoh-competition": {
        if (!this.dealDepthEnabled || !s.hoh) return [];
        const finalThree = s.active.length === 3; // Final 3 lifts the outgoing-HOH sit-out
        const field = s.active.filter((id) => finalThree || id !== s.outgoingHoh);
        return field.map((id) => ({
          actor: id, kind: "compete" as const, targets: [],
          outcome: (id === s.hoh ? "won" : "threw") as "won" | "threw",
        }));
      }
      case "veto-competition": {
        if (!this.dealDepthEnabled || !s.vetoHolder || !s.vetoField) return [];
        return s.vetoField.map((id) => ({
          actor: id, kind: "compete" as const, targets: [],
          outcome: (id === s.vetoHolder ? "won" : "threw") as "won" | "threw",
        }));
      }
      case "nominations":
        return s.hoh && s.nominees
          ? [{
              actor: s.hoh, kind: "nominate", targets: [...s.nominees],
              alternatives: s.active.filter((h) => h !== s.hoh),
            }]
          : [];
      case "veto-ceremony": {
        const actions: BindingAction[] = [];
        if (s.hoh && s.replacement) actions.push({ actor: s.hoh, kind: "replace", targets: [s.replacement] });
        // 0121: the veto DECISION as a positive-obligation action — a `veto-save` promise resolves here.
        // `nominees` is who was originally on the block (the replacement is EXCLUDED — it was not up when
        // the veto could have saved anyone); `saved` is who the veto actually pulled down. Gated on the
        // deal-depth layer (off ⇒ no veto-save deals exist ⇒ this would be a no-op anyway — byte-identical).
        if (this.dealDepthEnabled && s.vetoHolder) {
          const saved = s.saved ? [s.saved] : [];
          const onBlock = [...(s.nominees ?? []).filter((n) => n !== s.replacement), ...saved];
          actions.push({ actor: s.vetoHolder, kind: "veto-use", targets: [], saved, nominees: onBlock });
        }
        return actions;
      }
      case "eviction": {
        const e = s.eviction;
        const evictee = ev.participants[0];
        if (!e || !evictee) return [];
        const actions: BindingAction[] = Object.entries(e.voteOf).map(([voter, votedFor]) => ({
          actor: voter as EntityId, kind: "vote-evict", targets: [votedFor], alternatives: e.nominees,
        }));
        // A tied reveal means the HOH cast the deciding vote (player OR NPC) — that is binding too.
        const votes = Object.values(e.voteOf);
        const tied = votes.filter((v) => v === e.nominees[0]).length === votes.filter((v) => v === e.nominees[1]).length;
        if (tied && s.hoh) {
          actions.push({ actor: s.hoh, kind: "vote-evict", targets: [evictee], alternatives: e.nominees });
        }
        return actions;
      }
      case "final-eviction": {
        // Final 3 (0045): the final HOH personally evicts — participants = [hoh, evictee]; the
        // survivor (now in the Final 2 with them) was the alternative they spared.
        const [actor, evictee] = ev.participants;
        if (!actor || !evictee) return [];
        const survivor = s.active.find((h) => h !== actor);
        return [{
          actor, kind: "vote-evict", targets: [evictee],
          alternatives: survivor ? [evictee, survivor] : [evictee],
        }];
      }
      default:
        return [];
    }
  }

  /** Fold a resolved beat into the public projection: record the event, reconcile deals, sync, persist. */
  private commit(ev: BeatEvent | null): void {
    if (ev) this.onEvent?.({ ...ev, content: this.humanize(ev.content) });
    // 0039/E42: a binding ceremony beat may honor or break open deals — the engine adjudicates
    // EVERY binding actor's action (NPC votes and tie-breaks included), never only the player's.
    if (ev) for (const action of this.bindingActionsFor(ev)) { this.reconcileDeals(action); this.reconcileAllianceBetrayals(action); }
    // 0040/E55: at the week's dramatic beats the directly-involved houseguests privately confess
    // their REAL engine-grounded read — Vault-only (witnessed by them alone), reaching no one.
    if (ev) this.recordCeremonyConfessionals(ev);
    // E46: as the block goes up, the tightest unbound NPC pair may seal a hidden pact of their own.
    if (ev && ev.beat === "hoh-competition" && ev.participants[0]) this.recordLobbyPitches(ev.participants[0]); // B38: the pitches made to the new HOH are real, mostly hidden, events
    if (ev && ev.beat === "nominations") this.mintNpcDeal();
    // 0041: the season changes a houseguest — fold the beat's emotional impact into the involved souls
    // (a comp win emboldens; a blindside rattles), evolving the hidden arc that bends their later play.
    if (ev) this.evolveFromBeat(ev);
    // B38/0023: the loop's most consequential acts (noms/veto/replacement/eviction/comp wins) move the
    // HIDDEN relationship layer — the player's action changes how the house feels about them (and each
    // other). Engine-owned, magnitudes from constants, never surfaced (the Vault Wall, 0001).
    if (ev) this.foldCeremonyConsequence(ev);
    // B51/audit C5: on the WEEK ROLLOVER (the eviction's result lands → a new week begins) untended
    // relationships decay slowly toward baseline — grudges and bonds fade if not refreshed, so the house
    // doesn't pin to extremes over a season. Slow (`DECAY_RATE`), disposition-scaled, threat lingers.
    // E43: week-scoped promises whose week just passed un-broken resolve KEPT at the same boundary.
    if (ev && ev.beat === "eviction-result") {
      this.rel.decay(RELATIONSHIP_CONSTANTS.DECAY_RATE);
      this.deals.expireWeekScoped(this.live?.week ?? 0);
    }
    // T0-3 (issue #1778) — derive this beat's Vault-free broadcast chyron(s), IF ANY, from the SAME
    // `ev` + the now-committed `this.live` (every read/mutation above this line is either read-only
    // over the ceremony fields `buildBeatAnnouncements` also reads, or scoped to a different beat, so
    // nothing here perturbs what it sees). Runs at this ONE commit seam for both a plain `advanceGame`
    // step and a T0-2 auto-advanced beat chained off `submitDecision` (both call `commit`), so the two
    // paths announce identically — the whole point of the fix.
    this.recordAnnouncements(ev);
    this.syncProjection();
    this.prunePresence(); // the just-evicted occupy no room (0049)
    this.persist();
  }

  /**
   * T0-3 — build this beat's Vault-free `BeatAnnouncementView`(s) (if any), resolve their subject/
   * detail ids to public names, assign each a stable never-reused `id`, and buffer them into
   * `pendingAnnouncements` (read by `advanceView()` for THIS call's `AdvanceView.announcements`) AND
   * `announcementLog` (the bounded catch-up ring `stateDelta` slices). Each `beatSeq` is provisional
   * here (this runs before the commit funnel's bump) and corrected in place by `inOneCommit`'s
   * post-persist patch — see that method's doc comment for why the correction must happen after.
   */
  private recordAnnouncements(ev: BeatEvent | null): void {
    if (!this.live) return;
    const s = this.live;
    // A structural gap in `advanceBeat`'s NPC-driven "veto-ceremony" case (`src/engine/liveSeason.ts`):
    // when an NPC HOLDS and USES the veto and the PLAYER is HOH (but not the holder), resolving the
    // decision calls `resolveReplacement`, which immediately raises the player's "replacement" pending
    // and returns `null` — so the beat's OWN `commit(null)` never carries an event, and the just-committed
    // "the veto was used" fact would otherwise never announce (its sibling player-veto-holder path,
    // `applyDecision`'s "veto-decision" case, avoids this with an `ev ?? {...}` fallback the NPC path
    // lacks). Detected PURELY structurally, from state this commit already mutated (`vetoUsed`/`saved`
    // just flipped, a fresh "replacement" pending now standing) — this never touches `liveSeason.ts` or
    // consumes the seeded `RandomnessSource`, so it cannot perturb the calibration spine. `announcedVetoDecisionWeek`
    // guards against re-firing on an unrelated later null-ev commit while the SAME pending still stands.
    // `advanceOneBeat` — the ONLY caller of `commit()` that can pass `null` here — calls `commit(null)`
    // for this specific gap AT MOST ONCE per raised "replacement" pending: its own guard
    // (`if (!this.live!.pending && ...)`) means a REPEAT `advanceGame()` call, made while the SAME
    // pending still stands, short-circuits BEFORE ever calling `advanceBeat`/`commit` again — so this
    // branch cannot double-fire for one pending, and no extra bookkeeping is needed to prevent it.
    if (ev === null && s.vetoUsed === true && s.saved !== undefined && s.vetoHolder !== undefined && s.pending?.kind === "replacement") {
      this.emitAnnouncement({ kind: "veto-decision", week: s.week, subjects: [s.vetoHolder], detail: { used: true, saved: s.saved } });
    }
    if (!ev) return;
    for (const fact of buildBeatAnnouncements(ev, s)) this.emitAnnouncement(fact);
  }

  /** Resolve one engine-internal `BeatAnnouncement` to a public `BeatAnnouncementView`, assign it a
   *  stable never-reused id, and buffer it into both `pendingAnnouncements` (this call's `AdvanceView`)
   *  and `announcementLog` (the bounded `stateDelta` catch-up ring). See `recordAnnouncements`'s doc
   *  comment for the commit-timing contract `beatSeq` relies on. */
  private emitAnnouncement(fact: BeatAnnouncement): void {
    const named = (id: EntityId): NamedRef => ({ id, name: this.nameOf(id) });
    const resolveDetail = (d: BeatAnnouncement["detail"]): BeatAnnouncementView["detail"] => {
      if (!d) return undefined;
      return {
        ...(d.by !== undefined ? { by: named(d.by) } : {}),
        ...(d.used !== undefined ? { used: d.used } : {}),
        ...(d.saved !== undefined ? { saved: named(d.saved) } : {}),
        ...(d.tieBroken !== undefined ? { tieBroken: d.tieBroken } : {}),
        ...(d.remaining !== undefined ? { remaining: d.remaining } : {}),
        ...(d.part !== undefined ? { part: d.part } : {}),
      };
    };
    const view: BeatAnnouncementView = {
      id: `ann:${this.announcementSeq++}`,
      kind: fact.kind,
      week: fact.week,
      beatSeq: this.beatSeq, // provisional — corrected post-commit, see `inOneCommit`.
      headline: announcementHeadline(fact, (id) => this.nameOf(id)),
      subjects: fact.subjects.map(named),
      ...(fact.detail ? { detail: resolveDetail(fact.detail) } : {}),
    };
    this.pendingAnnouncements.push(view);
    this.announcementLog.push(view);
    while (this.announcementLog.length > GameSessionAdapter.ANNOUNCEMENT_LOG_MAX) this.announcementLog.shift();
  }

  /** The beats whose directly-involved houseguests confess (E55: noms, the veto ceremony, eviction). */
  private confessorsFor(ev: BeatEvent): { involved: EntityId[]; trigger: string } | null {
    const s = this.live;
    if (!s) return null;
    switch (ev.beat) {
      case "nominations":
        return {
          involved: [s.hoh, ...(s.nominees ?? [])].filter((id): id is EntityId => !!id),
          trigger: "the nomination ceremony",
        };
      case "veto-ceremony":
        return {
          involved: [s.vetoHolder, s.saved, s.replacement, s.hoh].filter((id): id is EntityId => !!id),
          trigger: "the veto ceremony",
        };
      case "eviction": {
        // The survivors of the vote confess: the HOH whose week it was + the nominee who stayed.
        const survivor = s.eviction?.nominees.find((n) => n !== ev.participants[0]);
        return {
          involved: [s.hoh, survivor].filter((id): id is EntityId => !!id),
          trigger: "the eviction vote",
        };
      }
      default:
        return null;
    }
  }

  /**
   * Record each involved NPC's Vault-only confessional at the week's dramatic beats (0040, extended
   * by audit E55): STRUCTURED — it names its trigger, carries the confessor's soul mood, varies its
   * phrasing by seed — and now reaches the NPC's own SOUL (audit C12: `recordConfessionalToSoul` +
   * the durable `soul.memory` mirror), so a houseguest can recall their own past confessionals.
   */
  private recordCeremonyConfessionals(ev: BeatEvent): void {
    const s = this.live;
    if (!s || !this.house || !this.onPlayerEvent) return;
    const at = this.confessorsFor(ev);
    if (!at) return;
    const everyone = [this.house.player.id, ...this.house.npcs.map((n) => n.id)];
    // 0089 — the confessor's OWN witnessed events (the just-recorded ceremony beat is already in the
    // log: `commit` records it via `onEvent` before this runs). `selectRecentForConfessional` filters
    // to `witnessedBy: npc` itself and returns only Vault-safe class-keyed gists, so a confessional
    // reacts to what THIS houseguest lived — never another's hidden read (mandate #2/#3). The seeded
    // tiebreak rng is dedicated (same `confessional:` family), never the shared society/vote stream, so
    // the calibration spine stays byte-identical (the selection draws no rng unless two events fully tie).
    const allEvents = this.record?.events() ?? [];
    const ctxFor = (npc: EntityId): ConfessionalContext => {
      const recentRng = new SeededRandom(hashSeed(`${this.gameSeed ?? ""}:confessional:${npc}:${s.week}:${ev.beat}`));
      // 0090 — the confessor's PUBLIC, byte-stable voice fingerprint, so their confessional reads in
      // THEIR voice (curt vs. expansive phrasing) instead of one uniform template. Voice is public
      // identity (no Vault, no number); a pre-0084 NPC simply has none ⇒ the templated fallback.
      const voice = this.house?.npcs.find((n) => n.id === npc)?.character.voice;
      return {
        trigger: at.trigger,
        recentEvents: selectRecentForConfessional(allEvents, npc, allEvents.length, { rng: recentRng }),
        ...(this.soulObj(npc) ? { emotionalState: this.soulObj(npc)!.emotionalState } : {}),
        ...(voice !== undefined ? { voice } : {}),
        // #845 companion — bake the DISPLAY NAME into the confessional content. Without this, a
        // confessional that targets the PLAYER would render the bare token "player" even in a named game
        // (the retrospective scrubber resolves colon-bearing ids ONLY, leaving `player` as prose). `nameOf`
        // yields the public roster name (player or NPC); it reads no Vault state.
        nameOf: (id) => this.nameOf(id),
        rng: new SeededRandom(hashSeed(`${this.gameSeed ?? ""}:confessional:${npc}:${s.week}:${ev.beat}`)),
      };
    };
    for (const conf of involvedConfessionals(at.involved, everyone, this.rel, ctxFor)) {
      // witnessSet = [the confessing NPC] → hidden=true (the player is never a witness, 0002).
      this.onPlayerEvent(conf.content, [conf.npc], "confessional");
      // C12: the confessional deepens the confessor's own recall-able soul (0024/0040) — durable
      // via the soul.memory mirror (rebuildSoulIndex replays it after a restart, 0030).
      this.soulObj(conf.npc)?.memory.push(conf.content);
      if (this.soul) recordConfessionalToSoul(this.soul, conf);
    }
  }

  /**
   * Feature 0122 — the once-per-in-game-day confessional SWEEP, fired from `turnIn` (the day-close hook,
   * beside 0102's daily recap) once the deeper-confessional layer AND the in-game clock are live. MOST
   * living NPCs privately confess their day's read — DEEPER than the 0040 threat+trust snapshot (the
   * triggered plan / standing / grudge / conversation-aftermath / adjacent-move facets, so the HOH &
   * nominees get the deepest confessionals and a coasting houseguest a short one) — UNLESS their game is
   * bare (`isBareGame`: no clear target/ally and no salient recent beat they witnessed ⇒ nothing to say).
   * Recorded Vault-only (witnessed by the NPC alone, `hidden` — the wall is UNCHANGED from 0040) + folded
   * to soul. A DEDICATED per-npc/day rng drives phrasing; the shared society/vote stream is never touched.
   * The whole method is skipped when the flag or the per-conversation clock is off (calibration + golden
   * both pin it off), so the seeded spine and the golden fixture are byte-identical.
   */
  private sweepDailyConfessionals(day: number): void {
    const s = this.live;
    if (!s || !this.house || !this.onPlayerEvent) return;
    if (!this.confessionalDepthEnabled || !this.perConversationClockLive()) return;
    if (day <= this.lastConfessionalSweepDay) return; // at most once per in-game day
    this.lastConfessionalSweepDay = day;
    const everyone = [this.house.player.id, ...this.house.npcs.map((n) => n.id)];
    const allEvents = this.record?.events() ?? [];
    const living = new Set(this.livingIds());
    for (const n of this.house.npcs) {
      const npc = n.id;
      if (!living.has(npc)) continue; // the evicted don't confess
      const recent = selectRecentForConfessional(allEvents, npc, allEvents.length, {
        rng: new SeededRandom(hashSeed(`${this.gameSeed ?? ""}:confessional-daily-recent:${npc}:${day}`)),
      });
      const hasSalient = recent.some((f) => f.type !== "flavor");
      if (isBareGame(npc, everyone, this.rel, hasSalient)) continue; // a bare game stays quiet this day
      const voice = n.character.voice;
      const conf = confessionalFor(npc, everyone, this.rel, {
        player: PLAYER,
        recentEvents: recent,
        rng: new SeededRandom(hashSeed(`${this.gameSeed ?? ""}:confessional-daily:${npc}:${day}`)),
        nameOf: (id) => this.nameOf(id),
        ...(voice !== undefined ? { voice } : {}),
        ...(this.soulObj(npc) ? { emotionalState: this.soulObj(npc)!.emotionalState } : {}),
        depth: this.confessionalDepthFor(npc, allEvents),
      });
      // witnessSet = [the confessing NPC] → hidden (the player is never a witness, 0002 — same as 0040).
      this.onPlayerEvent(conf.content, [conf.npc], "confessional");
      this.soulObj(conf.npc)?.memory.push(conf.content);
      if (this.soul) recordConfessionalToSoul(this.soul, conf);
    }
  }

  /**
   * Feature 0122 — build the Vault-safe depth inputs for one confessor from PUBLIC role/beat state + the
   * confessor's OWN witnessed events (never another houseguest's hidden read). `role` is their public
   * this-week standing (drives the plan + safe/exposed facets); `recentTalk` is the partner of the most
   * recent conversation THEY witnessed (the aftermath facet); `adjacent` is a relation of theirs (their
   * own top bond / top threat, only when it clears the floor) who is on the live public board.
   */
  private confessionalDepthFor(npc: EntityId, allEvents: readonly GameEvent[]): ConfessionalDepth {
    const s = this.live!;
    let role: ConfessionalDepth["role"] = "none";
    // Precedence matches the codebase's `standing()` read (hoh > nominee > veto-holder): a houseguest who is
    // a current NOMINEE who just won the veto still reads "nominee"/exposed, not "veto-holder"/safe (CodeRabbit).
    if (s.hoh === npc) role = "hoh";
    else if ((s.nominees ?? []).some((id) => id === npc)) role = "nominee";
    else if (s.vetoHolder === npc) role = "veto-holder";
    // recentTalk — the OTHER party of the most recent conversation this houseguest witnessed.
    let recentTalk: EntityId | undefined;
    for (let i = allEvents.length - 1; i >= 0; i--) {
      const ev = allEvents[i]!;
      if (ev.type === "conversation" && ev.witnessSet.includes(npc)) {
        const partner = ev.initiator !== npc ? ev.initiator : ev.witnessSet.find((w) => w !== npc);
        if (partner && partner !== npc) { recentTalk = partner; break; }
      }
    }
    const adjacent = this.adjacentMoveFor(npc);
    return { role, ...(recentTalk ? { recentTalk } : {}), ...(adjacent ? { adjacent } : {}) };
  }

  /**
   * Feature 0122 — the confessor's most charged ADJACENT move: a relation of theirs (their own clear ally
   * or clear target — over the FLOOR, so a coasting houseguest's arbitrary max-peer never triggers it) who
   * is on the live PUBLIC board this week (the HOH, or a nominee). Public board × the confessor's own read
   * — no hidden state of anyone else. Returns the first (most charged) match, else undefined.
   */
  private adjacentMoveFor(npc: EntityId): ConfessionalDepth["adjacent"] {
    const s = this.live;
    if (!s) return undefined;
    const others = this.livingIds().filter((id) => id !== npc);
    let ally: EntityId | undefined; let bestBond = -Infinity;
    let target: EntityId | undefined; let bestThreat = -Infinity;
    for (const o of others) {
      const e = this.rel.edge(npc, o);
      const bond = (e.trust + e.affinity) / 2;
      if (bond > bestBond) { bestBond = bond; ally = o; }
      if (e.threat > bestThreat) { bestThreat = e.threat; target = o; }
    }
    const clearAlly = ally !== undefined && bestBond >= CONFESSIONAL.depth.clearBond ? ally : undefined;
    const clearTarget = target !== undefined && bestThreat >= CONFESSIONAL.depth.clearThreat ? target : undefined;
    const noms = new Set(s.nominees ?? []);
    if (clearAlly && s.hoh === clearAlly) return { relation: clearAlly, bond: "ally", beat: "won-power" };
    if (clearAlly && noms.has(clearAlly)) return { relation: clearAlly, bond: "ally", beat: "nominated" };
    if (clearTarget && s.hoh === clearTarget) return { relation: clearTarget, bond: "target", beat: "won-power" };
    if (clearTarget && noms.has(clearTarget)) return { relation: clearTarget, bond: "target", beat: "nominated" };
    return undefined;
  }

  /**
   * NPC↔NPC deals exist (audit E46): at the nomination ceremony, the tightest UNBOUND pair of
   * living NPCs occasionally seals a pact of their own — Vault-held (the made event's witness set
   * excludes the player ⇒ hidden, 0002), binding through the SAME ledger the votes reconcile
   * against (E42), with full break consequences (betrayal fold, jury demerit, hidden reveal).
   * Seeded + bounded by `DECISION.npcDeal`; the player learns of one only along a pathway.
   */
  private mintNpcDeal(): void {
    const s = this.live;
    if (!s || !this.house || !this.onPlayerEvent) return;
    const D = DECISION.npcDeal;
    const rng = new SeededRandom(hashSeed(`${this.gameSeed ?? ""}:npc-deal:${s.week}`));
    if (rng.next() >= D.mintProb) return;
    const npcs = s.active.filter((id) => id !== PLAYER);
    const bound = (a: EntityId, b: EntityId): boolean =>
      this.deals.open().some((d) => d.parties.includes(a) && d.parties.includes(b));
    let best: [EntityId, EntityId] | null = null;
    let bestScore: number = D.mutualTrustMin; // the WILLINGNESS threshold (mutual trust + any 0121 R1 reputation lean)
    let bestMutual = 0;                        // the chosen pair's BARE mutual trust — drives the KIND, unbiased by reputation
    for (let i = 0; i < npcs.length; i++) {
      for (let j = i + 1; j < npcs.length; j++) {
        const a = npcs[i]!, b = npcs[j]!;
        if (bound(a, b)) continue;
        const mutual = Math.min(this.rel.edge(a, b).trust, this.rel.edge(b, a).trust);
        // 0121 R1: a candidate who credits the other as "keeps their word" (the diffusing 0038 reputation) is
        // a more-appealing partner — a bounded, hidden lean on the WILLINGNESS to seal. Off (flag off / no
        // reader) ⇒ 0 ⇒ this selection is byte-identical to the pre-R1 bare-mutual pick.
        const willingness = mutual + this.reliabilityLean(a, b);
        if (willingness >= bestScore) { bestScore = willingness; bestMutual = mutual; best = [a, b]; }
      }
    }
    if (!best) return;
    // The KIND stays keyed to the BARE mutual trust — reputation buys the OPPORTUNITY to deal, not a bigger promise.
    const kind = bestMutual >= D.finalTwoTrustMin ? "final-two" : "safety";
    const [a, b] = best;
    // A vague paraphrase, not hidden numbers — but still Vault-held (no player witness).
    const evId = this.onPlayerEvent(
      `${this.nameOf(a)} and ${this.nameOf(b)} quietly seal a ${kind} pact`,
      [a, b], "deal",
    );
    this.deals.make(best, kind, "a quiet pact sealed away from the cameras", evId, s.week);
  }

  /**
   * 0121 R1 — the bounded reliability-reputation nudge to a candidate NPC pair's deal WILLINGNESS: a
   * houseguest who credits their prospective partner as "keeps their word" (the diffusing 0038 belief, read
   * through `reliabilityReader`) reads them as a more-appealing deal partner. Either direction crediting the
   * other adds the single, bounded `DEAL_REPUTATION.dealLean`. OFF (deal-depth flag off / no reader wired) ⇒
   * 0, so `mintNpcDeal` is byte-identical. HIDDEN — a magnitude the player never sees (mandate #2/#3), and
   * DISTINCT from the affinity-only social whisper (`GOSSIP_HEARD.reliable`) so the two never double-count.
   */
  private reliabilityLean(a: EntityId, b: EntityId): number {
    if (!this.dealDepthEnabled || !this.reliabilityReader) return 0;
    const credits = this.reliabilityReader(a).has(b) || this.reliabilityReader(b).has(a);
    return credits ? DEAL_REPUTATION.dealLean : 0;
  }

  // ── 0024 — NPC MEMORY (a structured, engine-adjudicated ledger; never `SoulProvider.recall`) ───────────────────────

  /** Write one memory `holder → subject` (NPC holders only; only while the layer is on, so flags-off saves are untouched). */
  private remember(holder: EntityId, subject: EntityId, kind: MemoryKind, severity: number): void {
    if (!this.npcMemoryEnabled || !this.live || holder === PLAYER || holder === subject) return;
    recordMemory((this.live.npcMemory ??= {}), holder, subject, { kind, week: this.live.week, severity });
  }

  /** P4g - the NPCs a recorded PLAYER scene touched remember it: a betrayal / conflict (grudge) or a kindness (favor) about the PLAYER, through the existing 0024 ledger. Needs the
   *  memory layer + writers on (default ON); other kinds write nothing. Deterministic, no rng, bounded by the ledger cap. */
  rememberPlayerScene(holders: readonly EntityId[], sceneKind: string): void {
    if (!this.npcMemoryWritersEnabled) return;
    const m = SCENE_MEMORY_SEVERITY[sceneKind];
    if (!m) return;
    for (const h of holders) this.remember(h, PLAYER, m.kind, m.severity);
    // B32 / #2017 15.7 E5 (ORWELL_DRIFT_FIX): the chat scene feeds the emotional arc too - a betrayal / conflict hardens the wronged NPC, kindness softens - weighted by severity and by how much the NPC TRUSTED the player (a friend's betrayal cuts deeper).
    if (this.driftFixEnabled && this.soulDepthEnabled) {
      for (const h of holders) {
        if (h === PLAYER) continue;
        const trust = this.rel.edge(h, PLAYER).trust;
        const scale = (m.severity / 0.6) * (0.75 + 0.5 * Math.max(0, Math.min(1, trust)));
        this.inflect(h, m.kind === "scene-kindness" ? "bond" : "betrayed", scale);
      }
    }
    // B25: the touched houseguests' closest ties remember the player's treatment of their friend too - smaller, bond-weighted, once per friend (the strongest tie to any touched houseguest).
    if (this.memoryFriendsEnabled) {
      const touched = new Set(holders);
      const best = new Map<EntityId, number>();
      for (const h of holders) {
        for (const f of this.livingIds()) {
          if (f === PLAYER || f === h || touched.has(f)) continue;
          const bond = this.rel.bondStrength(f, h);
          if (bond > (best.get(f) ?? -1)) best.set(f, bond);
        }
      }
      for (const [f, bond] of best) { const sev = friendSeverity(m.severity, bond); if (sev > 0) this.remember(f, PLAYER, m.kind, sev); }
    }
  }
  /** B32 (ORWELL_DRIFT_FIX, default OFF, never-flipped; needs soul depth): chat scenes feed the arc + a negativity bias on temperament drift, so hardening is reachable. */
  private driftFixEnabled = flagDefaultOn("ORWELL_DRIFT_FIX");
  setDriftFixEnabled(on: boolean): void { this.driftFixEnabled = on; }
  /** B25 - the treatment-of-friends writer. OFF unless exactly `ORWELL_MEMORY_FRIENDS=1`; never-flipped. OFF => nothing extra is written (byte-identical). */
  private memoryFriendsEnabled = flagDefaultOn("ORWELL_MEMORY_FRIENDS");
  setMemoryFriendsEnabled(on: boolean): void { this.memoryFriendsEnabled = on; }

  /** A "friend" act (nominated / replaced by someone the holder TRUSTED) — only above the trust bar, read pre-fold. */
  private rememberFriendAct(holder: EntityId, subject: EntityId, kind: "nominated-by-friend" | "replaced-by-friend"): void {
    if (!this.npcMemoryEnabled || holder === PLAYER) return;
    if (this.rel.edge(holder, subject).trust < NPC_MEMORY.trustedAbove) return;
    this.remember(holder, subject, kind, 0.5);
  }

  /**
   * B3 / #2017 — derive (once per holder per week, idempotent by claim id) the `targets-me` beliefs this HOH holds, then return the bounded nomination tilt against `subject`.
   * Sources, all from what the HOH legitimately KNOWS (symmetric perspective):
   *   (1) an ACTIVE evict-campaign aimed at the HOH that the HOH is aware of (`knownTo`) ⇒ they believe its owner targets them (confidence 0.8). With a small DEDICATED-seeded chance the
   *       HOH MISATTRIBUTES it to another houseguest (a wrong belief, by construction — the honest-mistake the PO asked for);
   *   (2) a `betrayal` rumor they heard about someone ⇒ "they may turn on me" (confidence = the rumor's confidence x 0.5; usually not about the HOH at all).
   * Never reads the relationship edge; never draws the shared rng; the PLAYER is never a holder here.
   */
  /**
   * ORW-37 half 2 / B41 - how a pre-show tie's NATURE shapes decisions (`tieBehavior.ts`, decision terms only - NEVER competition odds): the HOH shields a family member / pushes a rival in nominations,
   * and a voter keeps family / evicts a rival. Applies only between the two PEOPLE the tie binds (they know their own tie). ON unless `ORWELL_TIE_BEHAVIOR=0`; OFF => no ctx provider => byte-identical.
   * The old friend's pressure-flip (`pressureFlipAt`) and the ex's scene awkwardness are NOT wired here (ASSUMED, pending Ryne): the shield stays.
   */
  private tieBehaviorEnabled = flagDefaultOn("ORWELL_TIE_BEHAVIOR");
  setTieBehaviorEnabled(on: boolean): void { this.tieBehaviorEnabled = on; }
  private tieBetween(a: EntityId, b: EntityId): PreGameTie | undefined {
    return this.seededRels?.ties?.find((t) => (t.a === a && t.b === b) || (t.a === b && t.b === a));
  }
  tieNomPushFor(target: EntityId, holder: EntityId): number {
    if (!this.tieBehaviorEnabled || holder === PLAYER || target === PLAYER || target === holder) return 0;
    const t = this.tieBetween(holder, target);
    return t ? TIE_BEHAVIOR[t.nature].nominationPush : 0;
  }
  tieVotePushFor(nominee: EntityId, voter: EntityId): number {
    if (!this.tieBehaviorEnabled || voter === PLAYER || nominee === PLAYER || nominee === voter) return 0;
    const t = this.tieBetween(voter, nominee);
    return t ? TIE_BEHAVIOR[t.nature].votePush : 0;
  }

  /** B7 M3 - open protective deals feed the HOH's nominations (approved tie-in #3). OFF unless exactly `ORWELL_DEAL_NOMS=1`; never-flipped. OFF => no ctx provider => byte-identical. */
  private dealNomsEnabled = flagDefaultOn("ORWELL_DEAL_NOMS");
  setDealNomsEnabled(on: boolean): void { this.dealNomsEnabled = on; }
  /** B7 M3 - the nomination-score push (<= 0) from the HOH's OPEN protective deals (safety / final-two) with `target` - a deal-keeping HOH mostly keeps their word. Bounded; deterministic; no rng. */
  dealNomPushFor(target: EntityId, holder: EntityId): number {
    if (!this.dealNomsEnabled || holder === PLAYER || target === holder) return 0;
    const bound = this.deals.open().some((d) => (d.kind === "safety" || d.kind === "final-two") && d.condition.promisors.includes(holder) && d.parties.includes(target));
    return bound ? DEAL_NOMS.protectivePush : 0;
  }

  /** B26 - a juror's finale lean reads their memory of the finalist too. OFF unless exactly `ORWELL_JURY_MEMORY=1`; never-flipped. OFF => no ctx provider => byte-identical. */
  private juryMemoryEnabled = flagDefaultOn("ORWELL_JURY_MEMORY");
  setJuryMemoryEnabled(on: boolean): void { this.juryMemoryEnabled = on; }
  /** B26 - the juror's signed lean toward `finalist` from what the juror remembers of them: a favor raises it, a grudge lowers it (the 0024 ledger's tilt, sign-flipped), bounded to +-JURY_MEMORY.max. No rng. */
  juryMemoryFor(juror: EntityId, finalist: EntityId): number {
    if (!this.juryMemoryEnabled || juror === PLAYER || !this.npcMemoryEnabled) return 0;
    return Math.max(-JURY_MEMORY.max, Math.min(JURY_MEMORY.max, (0 - this.memoryTiltFor(finalist, juror)) * JURY_MEMORY.scale));
  }

  /** B7 M4b - the NPC Houseguest's-Choice holder's pick reads memory too (approved tie-in #6). OFF unless exactly `ORWELL_HC_MEMORY=1`; never-flipped. OFF => no ctx provider => byte-identical. */
  private hcMemoryEnabled = flagDefaultOn("ORWELL_HC_MEMORY");
  setHcMemoryEnabled(on: boolean): void { this.hcMemoryEnabled = on; }
  /** B7 M4b - how much more the `holder` wants `candidate` as the sixth veto player: the SAME combined memory / belief / owed-deal read the veto save uses (a favor or an owed promise raises, a grudge or a 'they target me' belief lowers). Deterministic, no rng, [-1, 1]. */
  hcMemoryFor(candidate: EntityId, holder: EntityId): number {
    if (!this.hcMemoryEnabled || holder === PLAYER) return 0;
    const mem = this.npcMemoryEnabled ? this.memoryTiltFor(candidate, holder) : 0;
    const bel = this.npcBeliefNomsEnabled && this.npcBeliefsEnabled ? this.beliefNomTiltFor(candidate, holder) : 0;
    const owed = this.deals.open().some((d) => d.condition.promisors.includes(holder) && d.parties.includes(candidate) && candidate !== holder) ? 0.1 : 0;
    return Math.max(-1, Math.min(1, -(mem + bel) + owed));
  }

  /** B7 M1b - who approaches the player reads memory too (approved tie-in #2). OFF unless exactly `ORWELL_APPROACH_MEMORY=1`; never-flipped. OFF => no bias passed => byte-identical. */
  private approachMemoryEnabled = flagDefaultOn("ORWELL_APPROACH_MEMORY");
  setApproachMemoryEnabled(on: boolean): void { this.approachMemoryEnabled = on; }
  /**
   * B7 M1b - how much more (+) or less (-) `npc` is drawn to seek the player out, from what they remember about the player (a favor raises it, a grudge lowers it: the 0024 ledger's standalone tilt,
   * sign-flipped, i.e. the same read the veto save uses) and owe (an open deal or kept-able assurance the NPC made to the player raises it). Deterministic, no rng, bounded to [-1, 1] (the ranker clamps further).
   */
  /** Review lead 1: ONE bias provider for every place the NPCs' drive to seek the player is ranked (social initiatives, the hang-out approach, the desire clock's drive). Undefined when neither layer is on => byte-identical. */
  private approachBiasHook(player: EntityId): ((n: EntityId) => number) | undefined {
    return this.approachMemoryEnabled || this.moodApproachEnabled ? (n) => (this.approachMemoryEnabled ? this.approachMemoryFor(n, player) : 0) + this.moodApproachFor(n) : undefined;
  }
  approachMemoryFor(npc: EntityId, player: EntityId): number {
    if (!this.approachMemoryEnabled || npc === PLAYER) return 0;
    const mem = this.npcMemoryEnabled ? this.memoryTiltFor(player, npc) : 0;
    // Review lead 2: a real grudge dominates the cheap owed-promise pull (it counts only while the NPC holds no grudge above the floor).
    const owedOk = mem <= APPROACH_OWED.grudgeFloor;
    const owedDeal = owedOk && this.deals.open().some((d) => d.condition.promisors.includes(npc) && d.parties.includes(player)) ? APPROACH_OWED.bonus : 0;
    const owedAssurance = owedOk && this.assurancesEnabled && this.live?.assurances && AssuranceLedger.fromJSON(this.live.assurances).openFor(npc).some((a) => a.to === player) ? APPROACH_OWED.bonus : 0;
    return Math.max(-1, Math.min(1, -mem + owedDeal + owedAssurance));
  }

  /** B7 M1 - the NPC veto save reads memory too (approved tie-in #1). OFF unless exactly `ORWELL_VETO_MEMORY=1`; never-flipped. OFF => no ctx provider => byte-identical. */
  private vetoMemoryEnabled = flagDefaultOn("ORWELL_VETO_MEMORY");
  setVetoMemoryEnabled(on: boolean): void { this.vetoMemoryEnabled = on; }
  /**
   * B7 M1 - how much more WORTH SAVING `nominee` is to the veto `holder`, from what the holder remembers (a grudge lowers it, a favor raises it - the 0024 ledger's standalone tilt, sign-flipped),
   * believes (a belief that the nominee is targeting the holder lowers it) and owes (an open deal the holder is promisor of, with the nominee a party, raises it). Deterministic, no rng, bounded to [-1, 1].
   */
  vetoMemoryFor(nominee: EntityId, holder: EntityId): number {
    if (!this.vetoMemoryEnabled || holder === PLAYER) return 0;
    const mem = this.npcMemoryEnabled ? this.memoryTiltFor(nominee, holder) : 0;
    const bel = this.npcBeliefNomsEnabled && this.npcBeliefsEnabled ? this.beliefNomTiltFor(nominee, holder) : 0;
    const owed = this.deals.open().some((d) => d.condition.promisors.includes(holder) && d.parties.includes(nominee) && nominee !== holder) ? 0.1 : 0;
    return Math.max(-1, Math.min(1, -(mem + bel) + owed));
  }

  private beliefNomTiltFor(subject: EntityId, holder: EntityId): number {
    if (!this.live || holder === PLAYER || !this.npcBeliefsEnabled) return 0;
    const live = this.live;
    const store = (live.beliefs ??= {});
    const week = live.week;
    const living = this.livingIds().filter((id) => id !== holder);
    for (const c of this.campaigns) {
      if (c.status !== "active" || c.goal !== "evict" || c.target !== holder || !c.knownTo.includes(holder)) continue;
      const owner = c.owners[0];
      if (!owner || owner === holder) continue;
      const rng = new SeededRandom(hashSeed(`${this.gameSeed ?? 0}:targets-me:${week}:${holder}:${c.id}`));
      const wrong = rng.next() < 0.2 && living.length > 2;
      const pool = living.filter((id) => id !== owner);
      const claimed = wrong ? pool[Math.floor(rng.next() * pool.length)]! : owner;
      recordClaim(store, { id: `${holder}|targets-me|${claimed}|c:${c.id}|${week}`, holder, kind: "targets-me", subject: claimed, object: holder, value: true, origin: "told", confidence: 0.8, week });
    }
    for (const r of claimsOf(store, holder)) {
      if (r.kind !== "heard-rumor" || r.nature !== "betrayal" || r.refuted || r.week !== week) continue;
      recordClaim(store, { id: `${holder}|targets-me|${r.subject}|r:${r.id}|${week}`, holder, kind: "targets-me", subject: r.subject, object: holder, value: true, origin: "gossip", confidence: Math.max(0, Math.min(1, r.confidence)) * 0.5, week });
    }
    return targetsMeTilt(store, holder, subject, week);
  }

  /** The residual edge carry for the memory floor: what the relationship edge still holds, so nothing is counted twice. */
  private memoryCarry(holder: EntityId, subject: EntityId): { threatAboveBaseline: number; bondAboveNeutral: number } {
    const B = RELATIONSHIP_CONSTANTS.baseline;
    return {
      threatAboveBaseline: Math.max(0, this.rel.edge(holder, subject).threat - B.threat),
      bondAboveNeutral: Math.max(0, this.rel.bondStrength(holder, subject) - (B.trust + B.affinity) / 2),
    };
  }

  private memoryDecayScale(holder: EntityId): number {
    return RELATIONSHIP_CONSTANTS.dispositionFactors[this.dispositionReadOf(holder) ?? "neutral"].decayScale;
  }

  /** B27 - the FORGIVENESS trait layer (ORW-130: whether a houseguest holds a grudge comes from who they are and the relationship - temperament, how bad, repeats, favors, closeness - not a coin). OFF unless exactly `ORWELL_FORGIVENESS=1`; never-flipped. OFF => the ledger is read as it always was. */
  private forgivenessEnabled = flagDefaultOn("ORWELL_FORGIVENESS");
  setForgivenessEnabled(on: boolean): void { this.forgivenessEnabled = on; }
  /** The memory entries `holder` actually reads: the ledger row, with the forgiveness trait applied when the layer is on. Pure; no rng stream is touched. */
  private memoryEntriesSeenBy(holder: EntityId, entries: readonly MemoryEntry[] | undefined, subject: EntityId): readonly MemoryEntry[] | undefined {
    if (!this.forgivenessEnabled || !this.live) return entries;
    // ORW-130: whether THIS holder holds a grudge against THIS subject is a readable function of who the holder is and what happened between them (no coin): their style, their volatility, the bond, the record.
    const hg = this.house?.npcs.find((n) => n.id === holder);
    const trait = forgivenessTraitFor(entries, {
      ...(hg?.character.strategyStyle !== undefined ? { style: hg.character.strategyStyle } : {}),
      volatility: this.soulObj(holder)?.volatility ?? 0.5,
      closeness: this.rel.bondStrength(holder, subject),
    });
    return applyForgiveness(entries, trait, this.live.week);
  }

  /** The signed residual tilt of `holder` toward acting AGAINST `subject` (`+grudge − favor`); 0 for the player. */
  private memoryTiltFor(subject: EntityId, holder: EntityId): number {
    if (holder === PLAYER || !this.live) return 0;
    const raw = this.live.npcMemory?.[holder]?.[subject];
    if (!raw || raw.length === 0) return 0;
    const entries = this.memoryEntriesSeenBy(holder, raw, subject);
    if (this.npcMemoryStandaloneEnabled) return memoryTiltStandalone(entries, this.live.week, this.memoryDecayScale(holder));
    return memoryTilt(entries, this.live.week, this.memoryDecayScale(holder), this.memoryCarry(holder, subject));
  }

  /** An NPC the player has wronged (a strong residual grudge) does not float a safety/alliance deal to them. */
  private memoryBlocksPlayerDeal(npcId: EntityId): boolean {
    if (!this.npcMemoryEnabled || !this.live) return false;
    const raw = this.live.npcMemory?.[npcId]?.[PLAYER];
    if (!raw || raw.length === 0) return false;
    const entries = this.memoryEntriesSeenBy(npcId, raw, PLAYER);
    return memoryGrudge(entries, this.live.week, this.memoryDecayScale(npcId), this.memoryCarry(npcId, PLAYER)) >= NPC_MEMORY.dealOfferGrudge;
  }

  /**
   * 0123 — the NPC->player deal OFFER (the counterpart of `makeDeal`). At a LULL a motivated houseguest
   * pulls the player aside and floats a deal, GROUNDED in their real read (a strong bond ⇒ a final-two ask;
   * otherwise a mutual-safety ask). Bounded: at most one open offer, at most one per in-game week, seeded +
   * probability-gated. Sets `live.dealOffer` (surfaced as a `deal-offer` pending) and records the approach
   * as a PLAYER-WITNESSED event (not hidden — the NPC came to them). No-op unless the layer is on and the
   * game is at a genuine lull (no ceremony pending), so a ceremony is never preempted and the flag-off path
   * is byte-identical. The choice of NPC + kind draws a DEDICATED seeded rng (never the shared vote stream).
   */
  private maybeOfferPlayerDeal(): void {
    const s = this.live;
    if (!s || !this.house || !this.onPlayerEvent) return;
    if (!this.npcDealOffersEnabled) return;                       // the layer is opt-in
    if (s.pending || s.dealOffer || s.finished) return;           // lull-only, one open offer at a time
    if (s.hoh === undefined) return;                              // the game must be live (an HOH crowned)
    if (s.beat === "finale" || s.beat === "complete") return;     // no deal-making once the finale begins
    if (s.lastDealOfferWeek === s.week) return;                   // at most one offer per in-game week
    const O = DECISION.playerOffer;
    const rng = new SeededRandom(hashSeed(`${this.gameSeed ?? ""}:deal-offer:${s.week}:${s.beat ?? ""}`));
    if (rng.next() >= O.prob) return;
    // Pick the most-motivated living NPC not already bound to the player: max(bond, threat) over the floor.
    const evicted = new Set(s.evictionOrder);
    const boundToPlayer = (id: EntityId): boolean =>
      this.deals.open().some((d) => d.parties.includes(PLAYER) && d.parties.includes(id));
    let from: EntityId | undefined;
    let best: number = O.motivationMin;
    for (const n of this.house.npcs) {
      if (evicted.has(n.id) || boundToPlayer(n.id)) continue;
      if (this.memoryBlocksPlayerDeal(n.id)) continue;             // 0024: an NPC the player wronged does not float a deal
      const e = this.rel.edge(n.id, PLAYER);
      const motivation = Math.max((e.trust + e.affinity) / 2, e.threat); // wants alliance OR wants safety
      if (motivation > best) { best = motivation; from = n.id; }
    }
    if (!from) return;                                            // a house with no motivated NPC floats nothing
    const e = this.rel.edge(from, PLAYER);
    const bond = (e.trust + e.affinity) / 2;
    const kind: DealKind = bond >= O.finalTwoBond ? "final-two" : "safety";
    const terms = kind === "final-two"
      ? "take me to the end and I'll take you"
      : "you keep me safe, I keep you safe";
    s.dealOffer = { id: `offer:${from}:${s.week}`, from, kind, terms, madeWeek: s.week };
    s.lastDealOfferWeek = s.week;
    // A PLAYER-WITNESSED approach (not hidden — the NPC came to them; 0002): the offer is the player's
    // own knowledge, never Vault content. The paraphrase carries no number, no sealed state.
    this.onPlayerEvent(`${this.nameOf(from)} pulls ${this.nameOf(PLAYER)} aside to float a ${kind} deal`, [PLAYER, from], "conversation");
  }

  /**
   * 0123 — resolve an open NPC deal offer. `accept` routes through the SAME `deals.make` spine every deal
   * binds against (a real player↔NPC deal, reconciled/folded like any other); `decline` creates NO deal but
   * applies one bounded, seeded directed COOLING of the rebuffed NPC's read of the player (a mild `conflict`
   * move — never a betrayal-shock; the change is real, recorded, and invisible — the Vault Wall working).
   * Either way the offer is consumed. A no-op (safe) if no offer stands.
   */
  private resolveDealOffer(accept: boolean): AdvanceView {
    const s = this.live;
    if (!s?.dealOffer || !this.house) return this.advanceView(null);
    return this.inOneCommit(() => {
      const o = s.dealOffer!;
      s.dealOffer = undefined; // consumed either way
      // An offer whose party has left (or a finished season) can no longer bind anyone (Greptile #1911).
      if (this.dealOfferPartyGone(o.from) || s.finished) {
        this.persist();
        return this.advanceView(null);
      }
      if (accept) {
        const evId = this.onPlayerEvent?.(
          `${this.nameOf(PLAYER)} accepts ${this.nameOf(o.from)}'s ${o.kind} deal: ${o.terms}`,
          [PLAYER, o.from], "deal",
        );
        this.deals.make([PLAYER, o.from], o.kind, o.terms, evId, o.madeWeek);
      } else {
        this.onPlayerEvent?.(
          `${this.nameOf(PLAYER)} declines ${this.nameOf(o.from)}'s ${o.kind} offer`,
          [PLAYER, o.from], "conversation",
        );
        // The rebuffed houseguest cools on the player a touch (bounded, seeded, hidden — never surfaced).
        const rng = new SeededRandom(hashSeed(`${this.gameSeed ?? ""}:deal-decline:${o.from}:${o.madeWeek}`));
        this.rel.applyDirected(o.from, PLAYER, "conflict", rng);
      }
      this.persist();
      return this.advanceView(null);
    });
  }

  /**
   * 0123 (PO ruling 2026-11-01) — an offer the player never answered LAPSES when the in-game week rolls
   * past the week it was made. No deal is created. The houseguest cools on the player by an amount that
   * DEPENDS ON THE NPC: scaled by their hidden `volatility` (a hothead takes being ignored harder; a calm
   * houseguest shrugs it off). Bounded + seeded + hidden — the player only ever sees later behaviour. The
   * lapse itself is recorded as a PLAYER-WITNESSED event (the player knows they never answered).
   */
  private maybeLapseDealOffer(standingOfferId: string | undefined): void {
    const s = this.live;
    const o = s?.dealOffer;
    if (!s || !o || !this.house) return;
    // A party LEFT (the offerer or the player was evicted — staged evictions remove the evictee before the
    // week rolls): the offer is void at once, quietly (no deal possible, no rebuff to feel). Greptile #1911.
    if (this.dealOfferPartyGone(o.from)) {
      s.dealOffer = undefined;
      return;
    }
    if (o.id !== standingOfferId) return;
    // Lapse when the week rolls past it — or when the season reaches the finale/its end, which never rolls
    // the week (a final-three offer must not dangle into the finale or survive a finished season).
    const seasonOver = !!s.finished || s.beat === "finale" || s.beat === "complete";
    if (s.week <= o.madeWeek && !seasonOver) return;
    s.dealOffer = undefined;
    this.onPlayerEvent?.(
      `${this.nameOf(o.from)}'s ${o.kind} offer to ${this.nameOf(PLAYER)} lapsed unanswered`,
      [PLAYER, o.from], "conversation",
    );
    const L = DECISION.playerOffer.lapse;
    const vol = Math.min(1, Math.max(0, this.soulObj(o.from)?.volatility ?? 0.5));
    const rng = new SeededRandom(hashSeed(`${this.gameSeed ?? ""}:deal-lapse:${o.from}:${o.madeWeek}`));
    this.rel.applyDirected(o.from, PLAYER, "conflict", rng, L.scaleMin + (L.scaleMax - L.scaleMin) * vol);
  }

  /** 0123 — true when either party to a deal offer has left the game (offerer or player evicted). */
  private dealOfferPartyGone(from: EntityId): boolean {
    const gone = new Set(this.live?.evictionOrder ?? []);
    return gone.has(from) || gone.has(PLAYER);
  }

  /** 0123 — the standing NPC deal offer as Vault-free open state for the narrator (null when none). */
  private openDealOfferView(): OpenDealOfferView | null {
    const o = this.live?.dealOffer;
    if (!o || !this.house) return null;
    // The voicing instruction rides WITH the offer (only while one stands) instead of the base prompt — no
    // standing prompt cost (the #1391 budget) and nothing at all when the layer is off / no offer stands.
    return {
      from: this.named(o.from)!, kind: o.kind, terms: o.terms, madeWeek: o.madeWeek,
      howToVoice: "Not a decision card and it never stops the week. Voice this houseguest floating the offer " +
        "in-scene at a natural moment (who, kind, terms). If the player answers in chat, record it with " +
        "submitDecision {kind:\"deal-offer\", vote:\"accept\"|\"decline\"} — never answer for them; an " +
        "ignored offer lapses on its own at week's end.",
    };
  }

  /**
   * Vault-free projection of a player-party deal: parties (names) + kind + terms + status. No numbers.
   * A7/E12: a deal `sealedBallot` marks broken — via the SEALED eviction ballot, not the player's own
   * vote — projects as still "open" until the season finishes: the raw internal `d.status` ("broken")
   * would otherwise deanonymize the breaker's vote on the very next HUD poll (the player already knows
   * exactly who their deal partner is, so the status flip alone is the leak). The retrospective (0048)
   * lifts the seal the same way it unseals everything else — the underlying `d.status` itself is never
   * altered, only this outward render.
   */
  private dealView(d: Deal): DealView {
    const sealed = d.sealedBallot && !this.live?.finished;
    return {
      id: d.id,
      parties: d.parties.map((id) => ({ id, name: this.nameOf(id) })),
      kind: d.kind,
      terms: d.terms,
      status: sealed ? "open" : d.status,
      ...(d.expiresWeek !== undefined || d.vague
        ? { term: { ...(d.expiresWeek !== undefined ? { expiresWeek: d.expiresWeek } : {}), ...(d.vague ? { vague: true } : {}) } }
        : {}),
    };
  }

  /** Project the live-loop state onto the public week/phase/ceremony the status panel reads. */
  private syncProjection(): void {
    const s = this.live;
    if (!s) return;
    // 0088: detect week advance — snapshot the NPC→player bond as the drift anchor
    // so "warming"/"cooling" reads relative to start-of-week.
    const weekChanged = s.week !== this.week;
    // #1322: capture the OUTGOING stretch key BEFORE it's overwritten below, so the cooldown rotation
    // (mirroring this same weekChanged-detection pattern) knows exactly which stretch just ended.
    const outgoingStretchKey = `${this.week}:${this.phase}`;
    this.week = s.week;
    this.phase = s.finished ? "finale" : s.beat;
    // PREMIERE (owner ruling 2026-07-14): the champagne-circle trackers are premiere-scoped. Clear them
    // as part of THIS commit the instant the phase leaves "premiere" (the first HOH begins), rather than
    // lazily on a later read — a lazy clear would fire its own beatSeq-bumping persist at an arbitrary
    // mid-season read (the pre-existing `clearPremiereIfOver` path). Done inside the already-committing
    // advance, so it costs no extra beat. The DURABLE name-lock `introducedNames` is intentionally kept.
    if (this.phase !== "premiere" && (this.premiereMet.size > 0 || this.premiereHotReads.size > 0)) {
      this.premiereMet.clear();
      this.premiereHotReads.clear();
    }
    // 0111: the champagne-circle flag is premiere-scoped — clear it the instant the phase leaves
    // "premiere" so a post-premiere `live` never reports a stale `champagne-circle` house event.
    if (this.phase !== "premiere" && s.champagneCircle !== undefined) s.champagneCircle = undefined;
    if (this.phase !== "premiere" && s.premiereEntrance !== undefined) delete s.premiereEntrance; // A9
    this.ceremony = {
      hoh: s.hoh,
      nominees: (s.finalNominees ?? s.nominees ?? []).slice(),
      vetoHolder: s.vetoHolder,
      vetoUsed: s.vetoUsed,
    };
    if (weekChanged && this.house) {
      const playerId = this.house.player.id;
      const evicted = new Set(this.live?.evictionOrder ?? []);
      for (const npc of this.house.npcs) {
        if (!evicted.has(npc.id)) {
          const bond = (this.rel.edge(npc.id, playerId).trust + this.rel.edge(npc.id, playerId).affinity) / 2;
          this.readAnchors.set(npc.id, bond);
        }
      }
    }
    // #1322: the approach-rotation cooldown only rotates on an ACTUAL stretch transition — never on a
    // read of `socialInitiatives()` itself (which must stay poll-safe/idempotent within a stretch).
    const stretchChanged = outgoingStretchKey !== `${this.week}:${this.phase}`;
    if (stretchChanged) this.advanceApproachCooldown(outgoingStretchKey);
  }

  /**
   * Issue #1322 (P2) — advance the approach-rotation anti-recency cooldown on a stretch transition.
   * Decrements every NPC's remaining cooldown by one (floor 0 — a lapsed entry is dropped so the
   * persisted map stays bounded to whoever is actually cooling down right now), THEN re-arms a fresh
   * `APPROACH_COOLDOWN_STRETCHES`-stretch cooldown for whichever NPCs the JUST-ENDED stretch actually
   * showed the player as top-3 initiators (`lastApproachStretch`, populated by `socialInitiatives()`
   * itself — if the surface was never read during that stretch, no one is penalized, which is correct:
   * nothing was ever shown). Order matters: decrementing first, then re-arming, means an NPC who just
   * initiated is excluded for the NEXT `APPROACH_COOLDOWN_STRETCHES` stretches, never zero.
   *
   * Player-facing PROJECTION bookkeeping only — never touches `rankApproaches`, the relationship
   * model, or any rng stream, so it cannot perturb the seeded society/competition/vote calibration.
   */
  private advanceApproachCooldown(outgoingStretchKey: string): void {
    for (const [id, remaining] of [...this.approachCooldown]) {
      if (remaining > 1) this.approachCooldown.set(id, remaining - 1);
      else this.approachCooldown.delete(id);
    }
    if (this.lastApproachStretch?.key === outgoingStretchKey) {
      for (const id of this.lastApproachStretch.initiators) {
        this.approachCooldown.set(id, APPROACH_COOLDOWN_STRETCHES);
      }
    }
    this.approachStretchKey = outgoingStretchKey;
  }

  private toDecisionInput(req: SubmitDecisionReq): DecisionInput {
    switch (req.kind) {
      case "nominations": {
        const c = req.choice ?? [];
        if (c.length !== 2) throw new Error("nominations require exactly two houseguests");
        return { kind: "nominations", choice: [c[0]!, c[1]!] };
      }
      case "veto-decision":
        return { kind: "veto-decision", use: !!req.use, ...(req.save ? { save: req.save } : {}) };
      case "comp-intent":
      case "comp-round": { // B46 / 0006 staged-rounds: the player declares compete/throw/play-safe.
        // The pending presents this as a generic options/pick decision (id = the intent value), so a
        // caller may submit it as `intent`, `vote`, OR `choice` like every other options/pick decision.
        // `singlePickId` covers `vote`/`choice`; `intent` stays first (R4-02 — `choice` was rejected).
        const intent = (req.intent ?? singlePickId(req)) as Intent | undefined;
        if (!intent || !(COMP_INTENTS as readonly string[]).includes(intent)) throw new Error("a legal competition approach is required");
        return { kind: req.kind, intent };
      }
      case "houseguests-choice": { // B45: the player picks the sixth veto player (A10: `vote` or `choice`).
        const pick = singlePickId(req);
        if (!pick) throw new Error("a Houseguest's Choice pick is required");
        return { kind: "houseguests-choice", pick };
      }
      case "replacement": { // D5-1: accept `replacement`, `vote`, OR `choice` (the generic options/pick shape).
        const replacement = req.replacement ?? singlePickId(req);
        if (!replacement) throw new Error("a replacement nominee is required");
        return { kind: "replacement", replacement };
      }
      case "eviction-vote": { // D5-1: the most-repeated decision now accepts `vote` OR `choice` (A10/R4-02 parity).
        const vote = singlePickId(req);
        if (!vote) throw new Error("an eviction vote is required");
        return { kind: "eviction-vote", vote };
      }
      case "tie-break": { // B44: the player HOH breaks a tied eviction vote (A10: `vote` or `choice`).
        const evict = singlePickId(req);
        if (!evict) throw new Error("a tie-break vote is required");
        return { kind: "tie-break", evict };
      }
      case "final-eviction": { // Final 3 (0045): the final HOH evicts (A10: `vote` or `choice`).
        const evict = singlePickId(req);
        if (!evict) throw new Error("a final-eviction target is required");
        return { kind: "final-eviction", evict };
      }
      case "goodbye-message": { // E34: the tone is surfaced as options/pick, so accept `vote` OR `choice`
        // (B6-02 — `singlePickId` is the shared parity helper; a client using the generic `choice`
        // shape was hard-looping on a rejection, like comp-intent before R4-02).
        const tone = singlePickId(req) as GoodbyeTone | undefined;
        if (!tone || !(GOODBYE_TONES as readonly string[]).includes(tone)) {
          throw new Error("a legal goodbye tone is required (warm / respectful / cold)");
        }
        return { kind: "goodbye-message", tone, ...(req.statement ? { message: req.statement } : {}) };
      }
      case "exit-interview": { // 0130: the stance is surfaced as options/pick — accept `vote` OR `choice`.
        const stance = singlePickId(req) as ExitStance | undefined;
        if (!stance || !(EXIT_STANCES as readonly string[]).includes(stance)) {
          throw new Error("a legal exit stance is required (gracious / defiant / bitter)");
        }
        return { kind: "exit-interview", stance, ...(req.statement ? { message: req.statement } : {}) };
      }
      case "spectator-choice": { // 0133: the mode rides the shared single-pick field (`vote` OR `choice`)
        const mode = singlePickId(req) as SpectatorMode | undefined;
        if (!mode || !(SPECTATOR_MODES as readonly string[]).includes(mode)) {
          throw new Error("a legal spectator mode is required (watch / skip)");
        }
        return { kind: "spectator-choice", mode };
      }
      case "finale-interview": { // 0133: posture like 0130's exit interview
        const stance = singlePickId(req) as ExitStance | undefined;
        if (!stance || !(EXIT_STANCES as readonly string[]).includes(stance)) {
          throw new Error("a legal interview stance is required (gracious / defiant / bitter)");
        }
        return { kind: "finale-interview", stance, ...(req.statement ? { message: req.statement } : {}) };
      }
      // --- finale (0037) ---
      case "finale-statement":
        return { kind: "finale-statement", statement: req.statement ?? "" };
      case "juror-question": // E37: scoreless free text — nothing here can sway the tally.
        return { kind: "juror-question", question: req.statement ?? "" };
      case "finale-answer": {
        if (!req.appeal || !(FINALE_APPEALS as readonly string[]).includes(req.appeal)) {
          throw new Error("a legal finale appeal is required");
        }
        return { kind: "finale-answer", appeal: req.appeal as FinaleAppeal };
      }
      case "juror-vote": { // D5-1: the player-juror's finale vote accepts `vote` OR `choice` (A10 parity).
        const vote = singlePickId(req);
        if (!vote) throw new Error("a juror vote is required");
        return { kind: "juror-vote", vote };
      }
      case "self-evict": // 0061: intercepted in `submitDecision` BEFORE this map — never reached here.
        return { kind: "self-evict", confirmed: req.confirmed === true };
      case "secret-veto": // 0025: the player plays (true) or holds (false) their one-time safety.
        return { kind: "secret-veto", use: req.use === true };
      case "deal-offer": // 0123: intercepted in `submitDecision` BEFORE this map (its own path) — never here.
        throw new Error("deal-offer resolves through resolveDealOffer, not the ceremony-decision map");
    }
  }

  private named(id?: EntityId): NamedRef | null {
    return id ? { id, name: this.nameOf(id) } : null;
  }

  private pendingView(): PendingDecisionView | null {
    const p = this.live?.pending;
    // 0061: surface the OOC self-evict CONFIRMATION. A ceremony pending is a hard stop and takes
    // priority (the in-flight ceremony resolves first, §4.6 — the confirmation waits); when the loop
    // is not blocked on a ceremony decision, the raised confirmation shows on the player-level channel.
    if (!p && this.live?.selfEvictPending && this.house) {
      const by = this.named(PLAYER)!;
      return {
        kind: "self-evict", by,
        prompt: "Leaving the game is final — a real walk-out you cannot undo. Confirm to self-evict and end your season, or cancel to stay in the house.",
        options: [], pick: 0,
      };
    }
    // 0123 (PO ruling 2026-11-01) — a floated deal offer is NOT a pending card any more: it is open state
    // (`openDealOffer` on the state/status views) the narrator voices in-scene. Never a pop-up.
    if (!p) return null;
    const by = this.named(p.by)!;
    const refs = (ids: EntityId[]): NamedRef[] => ids.map((id) => ({ id, name: this.nameOf(id) }));
    switch (p.kind) {
      case "nominations":
        return { kind: p.kind, by, prompt: "You are Head of Household — name two houseguests for eviction.", options: refs(p.options), pick: 2 };
      case "veto-decision":
        // The 0034 legal-options contract (E36): the options ARE the legally saveable nominees.
        // At Final 4 no replacement exists, so the set is EMPTY and the prompt says why — the
        // engine never offers "use" only to silently invert it into "does not use the veto".
        return p.saveable.length === 0
          ? { kind: p.kind, by, prompt: "You hold the Power of Veto — but no replacement nominee exists at Final 4, so the veto cannot change the nominations. Confirm leaving them standing.", options: [], pick: 1 }
          : { kind: p.kind, by, prompt: "You hold the Power of Veto — use it to save a nominee, or leave the nominations.", options: refs(p.saveable), pick: 1 };
      case "comp-intent":
        // The "options" ARE the three intents (id = the intent value), so the generic decision path
        // and the front-end both pick from them; the first ("compete") is the default (B46/audit B5).
        return { kind: p.kind, by, prompt: "Declare your approach to this competition: compete, throw, or play it safe.", options: COMP_INTENTS.map((i) => ({ id: i, name: i })), pick: 1 };
      case "comp-round": {
        // 0006 staged-rounds: the player's approach for THIS elimination round, seeing who is STILL IN.
        // Only the FIRST round BINDS (the intent the single outcome roll honors); later rounds are
        // non-binding FLAVOR over an already-decided result (audit 2026-06-20) — the prompt + the
        // `binding` flag tell the surface to present those as color, not a stakes decision.
        const stillIn = refs(p.stillIn);
        const others = stillIn.filter((r) => r.id !== PLAYER).map((r) => r.name);
        const fieldLine = others.length ? ` Still in with you: ${others.join(", ")}.` : " You are the last one in.";
        // 0128: the three-part Final HOH - say which part this is (1 endurance, 2 physical+mental, 3 quiz) so each part's card reads as its own stage of the finale.
        const finalHohPart = (this.finalHohThreePartEnabled && p.comp === "hoh-competition" && this.live!.active.length === 3) ? (this.live!.finalHohPart ?? 1) : undefined;
        const partLine = finalHohPart === undefined ? "" : `Final Head of Household, Part ${finalHohPart} of 3 (${finalHohPart === 1 ? "endurance, all three finalists" : finalHohPart === 2 ? "physical and mental, the two who lost Part 1" : "the quiz, the two part-winners"}). `;
        const prompt = p.binding
          ? `${partLine}Set your approach to this competition: compete, throw (drop out), or play it safe.${fieldLine} This locks in how you play the comp.`
          : `The field narrows — ${stillIn.length} still standing.${fieldLine} Your approach is already locked from the first round, so this is just color: say how you're pushing through, or skip ahead.`;
        return {
          kind: p.kind, by, prompt,
          options: COMP_INTENTS.map((i) => ({ id: i, name: i })),
          round: p.round, stillIn, binding: p.binding, pick: 1,
          ...(finalHohPart !== undefined ? { finalHohPart } : {}),
        };
      }
      case "houseguests-choice":
        return { kind: p.kind, by, prompt: "You drew Houseguest's Choice — pick the sixth houseguest to play in the veto competition.", options: refs(p.options), pick: 1 };
      case "replacement":
        return { kind: p.kind, by, prompt: `You used the veto on ${this.nameOf((p as { saved: EntityId }).saved)} — name a replacement nominee.`, options: refs(p.options), pick: 1 };
      case "eviction-vote":
        return { kind: p.kind, by, prompt: "Cast your vote to evict one of the two nominees.", options: refs(p.nominees), pick: 1 };
      case "tie-break":
        return { kind: p.kind, by, prompt: "The eviction vote is tied — as Head of Household you cast the deciding vote.", options: refs(p.nominees), pick: 1 };
      case "final-eviction":
        return { kind: p.kind, by, prompt: "You are the final Head of Household — evict one houseguest; the other sits beside you at the Final 2.", options: refs(p.options), pick: 1 };
      // --- eviction night (E34): the player's own goodbye — tone is THEIR choice, never engine-read ---
      case "goodbye-message":
        return {
          kind: p.kind, by,
          prompt: `${this.nameOf(p.evictee)} has been evicted — record your goodbye message. Choose its tone; your own words carry it.`,
          options: p.tones.map((t) => ({ id: t, name: t })),
          evictee: this.named(p.evictee)!, pick: 1,
        };
      // --- exit interview (0130): the player IS the evictee — their posture leaving is THEIRS to choose ---
      case "exit-interview":
        return {
          kind: p.kind, by,
          prompt: "You have been evicted — the producers sit you down for your exit interview. Choose the posture you leave on; your own words carry it.",
          options: p.stances.map((st) => ({ id: st, name: st })),
          stances: [...p.stances], evictee: this.named(p.evictee)!, pick: 1,
        };
      // --- early eviction (0133): the player's own choice of how to follow the rest of the season ---
      case "spectator-choice":
        return {
          kind: p.kind, by,
          // A RE-RAISED card (E-1: watch -> skip) carries a DIFFERENT prompt: the FE keys its at-most-once decision token on the card's kind|options|prompt, so an identical
          // prompt would replay the first (watch) answer verbatim and the skip would never land.
          prompt: p.again
            ? "You chose to keep watching. Do you want to skip ahead to the finale instead? Skipping is final — once you skip, you can't go back to watching. Either way you will be back for the finale night."
            : "You are out before the jury formed. Skip ahead to the finale, or keep watching a condensed version of the rest of the season? Either way you will be back for the finale night.",
          options: p.modes.map((m) => ({ id: m, name: m })),
          pick: 1,
        };
      case "finale-interview":
        return {
          kind: p.kind, by,
          prompt: "The season is crowned — the host sits you down for your finale-night interview. Choose the posture you take; your own words carry it.",
          options: p.stances.map((st) => ({ id: st, name: st })),
          stances: [...p.stances], pick: 1,
        };
      // --- finale (0037) ---
      case "finale-statement":
        return { kind: p.kind, by, prompt: "You are a finalist — give your opening statement to the jury.", options: [], pick: 0 };
      case "finale-answer":
        return {
          kind: p.kind, by,
          prompt: `${this.nameOf(p.juror)} asks you a question — choose how you make your case.`,
          options: [], appeals: [...p.appeals], juror: this.named(p.juror)!, pick: 1,
        };
      // --- finale (E37): the player-juror's own question (scoreless free text) ---
      case "juror-question":
        return {
          kind: p.kind, by,
          prompt: `You sit on the jury — ask ${this.nameOf(p.finalist)} your question. It sways nothing by itself; their answer is theirs.`,
          options: refs([p.finalist]), finalist: this.named(p.finalist)!, pick: 0,
        };
      case "juror-vote":
        return {
          kind: p.kind, by, prompt: "You sit on the jury — cast your vote for the winner.", options: refs(p.finalists), pick: 1,
          ...(() => { const jb = this.jurorBriefFor(p.finalists); return jb ? { jurorBrief: jb } : {}; })(),
        };
      case "self-evict":
        // 0061: the self-evict confirmation never lives on `this.live.pending` (it rides
        // `selfEvictPending`, surfaced above), so this branch is unreachable — handled for
        // type-exhaustiveness only.
        return { kind: p.kind, by, prompt: "Confirm to self-evict, or cancel to stay.", options: [], pick: 0 };
      // --- secret veto (0025 reactive redesign): the reveal + the player's choice, all at once ---
      case "secret-veto":
        return {
          kind: p.kind, by,
          prompt: "You are on the block — and you secretly hold a one-time SECRET VETO. Play it now to pull yourself off the block (the Head of Household must name a replacement), or hold it and take your chances at the vote.",
          options: refs([p.nominee]), pick: 1,
        };
    }
  }

  private advanceView(ev: BeatEvent | null): AdvanceView {
    const s = this.live;
    // T0-3 — drain whatever `commit()` buffered for THIS transaction (one or two commits, per the
    // T0-2 auto-advance chain — see `submitDecision`) into the returned view, then clear the buffer so
    // it never bleeds into a LATER, unrelated `advanceView()` call. Each entry's `beatSeq` is still
    // provisional here; `inOneCommit`'s post-persist patch corrects it in place (same object
    // references, so the correction is visible through this returned array too).
    const announcements = this.pendingAnnouncements.length ? [...this.pendingAnnouncements] : undefined;
    this.pendingAnnouncements = [];
    return {
      started: this.house !== null,
      beatSeq: this.beatSeq, // 0065 Part A — the counter AFTER this advance/decision committed
      // EVT-1 (#569): project the beat's PUBLIC participants (id + name only) alongside the prose, so
      // ceremony result identities are structured, not prose-only. Vault-free — `participants` carries
      // public houseguest ids, never hidden state.
      event: ev
        ? { beat: ev.beat, content: this.humanize(ev.content), participants: ev.participants.map((id) => this.named(id)!) }
        : null,
      pending: this.pendingView(),
      status: this.gameStatus(),
      finished: !!s?.finished,
      winner: this.named(s?.winner),
      finale: this.finaleView(),
      eviction: this.evictionView(),
      ...(announcements ? { announcements } : {}),
    };
  }

  /**
   * Vault-free projection of an in-progress weekly eviction (0047): the two nominees, the stage, and
   * the votes REVEALED SO FAR (`revealIx`) only — never an unread vote, never a pre-reveal tally, never
   * the evictee before the last vote lands. Null unless an eviction is actively staging.
   */
  private evictionView(): EvictionView | null {
    const e: EvictionProgress | undefined = this.live?.eviction;
    if (!e || this.live?.finished) return null;
    const ref = (id: EntityId): NamedRef => ({ id, name: this.nameOf(id) });
    return {
      stage: e.stage,
      nominees: e.nominees.map(ref),
      // E12: secret ballots — the projection carries the anonymized ballots read so far, never
      // the voter; the attribution unseals only in the post-season retrospective (0048).
      votesRevealed: e.revealOrder.slice(0, e.revealIx).map((voter) => ({
        votedFor: ref(e.voteOf[voter]!),
      })),
      ...(e.evictee ? { evictee: ref(e.evictee) } : {}),
    };
  }

  /**
   * Vault-free projection of a finale (0037): names, the current stage, the juror asking, and the
   * votes REVEALED SO FAR (`revealIx`) only. No lean, no tally, no manner, and no pre-reveal winner
   * ever crosses — a juror's vote appears only after it is revealed in order.
   *
   * S4-2: this read SURVIVES THE FLIP TO `finished`. The `finale` progress is durable (persisted +
   * restart-safe via the snapshot), so once the season is over it returns the COMPLETED finale (every
   * reveal, stage `reveal`) plus the crowned `winner` — the same public winner `gameStatus`/
   * `seasonRecap` expose — instead of null, so a finale-panel client agrees with every surface
   * post-finish. `winner` stays null while the finale is still staging (the pre-reveal winner never
   * crosses). Null only when no finale exists at all (never staged / no game).
   */
  finaleView(): FinaleView | null {
    const f: FinaleProgress | undefined = this.live?.finale;
    if (!f) return null;
    const ref = (id: EntityId): NamedRef => ({ id, name: this.nameOf(id) });
    const q = f.script.questions[f.questionIx];
    // Build asking with an optional bearing (Traitors' Fury AC2). PO ruling 2026-11-02: NO `heldBelief` —
    // a juror's belief about WHO voted against them is per-voter attribution of a secret ballot, which unseals
    // only in the 0048 retrospective (E12). Jurors still carry their bearing, just without naming names.
    let asking: (NamedRef & { bearing?: string }) | null = null;
    if (f.stage === "questions" && q) {
      asking = ref(q.juror);
      if (this.traitorsFuryEnabled) {
        const askingJurorId = q.juror;
        const playerFinalistId = f.finalists.includes(PLAYER) ? PLAYER : f.finalists[0];
        let grudge = (this.live?.juryGrudge?.[askingJurorId]?.[playerFinalistId]) ?? 0;
        if (!f.finalists.includes(PLAYER)) {
          grudge = Math.max(
            this.live?.juryGrudge?.[askingJurorId]?.[f.finalists[0]] ?? 0,
            this.live?.juryGrudge?.[askingJurorId]?.[f.finalists[1]] ?? 0,
          );
        }
        asking.bearing = bearingWord(grudge);
      }
    }
    return {
      stage: f.stage,
      finalists: f.finalists.map(ref),
      asking,
      reveals: f.script.revealOrder.slice(0, f.revealIx).map((juror) => ({
        juror: ref(juror), votedFor: ref(f.votes![juror]!),
      })),
      // The crowned winner is a PUBLIC fact only once the season is over — null while staging so the
      // pre-reveal winner never crosses (mirrors gameStatus/seasonRecap/AdvanceView post-finish).
      winner: this.live?.finished ? this.named(this.live.winner) : null,
    };
  }

  /** Replace raw entity ids in a loop event string with the houseguests' public names.
   *  Delegates to the whole-token substituter so beat prose like "the veto players are drawn"
   *  is never mangled by the player's bare-word id "player" (audit A8). */
  private humanize(content: string): string {
    const all = this.house ? [this.house.player, ...this.house.npcs] : [];
    return humanizeIds(content, all);
  }

  /**
   * The POST-SEASON retrospective scrub (0048 — the Wall's ONE sanctioned reveal). Stronger than the
   * everyday `humanize`: it also resolves ids embedded in COMPOUND machine tokens (`thread:npc:8:0`),
   * drops the bare `thread:…` identifier, and translates the thread audit slugs (`[dormant]`, `surfaces
   * via:`, …) into readable prose — so the unsealed story reads like prose, not a debug dump. Used ONLY
   * here, behind the terminal-state gate.
   */
  private retroScrub(content: string): string {
    const all = this.house ? [this.house.player, ...this.house.npcs] : [];
    return humanizeForRetrospective(content, all);
  }

  getGameState(): GameStateView {
    return this.view();
  }

  /**
   * 0065 Part E — the `beatSeq`-keyed delta state feed. Given the caller's last-seen `beatSeq`, return
   * exactly WHAT CHANGED since: the player-visible events appended, the ceremony field transitions, and
   * any finished/winner flip — plus the freshest board to re-anchor on. A pure READ (no mutation).
   *
   * O(Δ): the per-beat checkpoint ring (`beatCheckpoints`) holds the event-log length + the board AS OF
   * `sinceBeatSeq`, so the delta slices ONLY the event tail (`visibleEventsSince(eventCountThen)`) and
   * diffs the ceremony against the captured snapshot — it never re-scans the whole log. VAULT-FREE: the
   * event tail comes through the player's witness-filtered visible projection (no hidden content), and
   * the board/changes are the same ceremony-level public facts `gameStatus` exposes.
   *
   * Full-refresh signal (never a guessed partial delta): the token is ahead of the current counter,
   * negative, or older than the retained window (e.g. after a restart, which empties the ring). Empty
   * delta: `sinceBeatSeq === current` — nothing committed since.
   */
  stateDelta(sinceBeatSeq: number): StateDeltaView {
    const board = this.gameStatus();
    const current = this.beatSeq;
    const empty = (fullRefresh: boolean): StateDeltaView => ({ beatSeq: current, fullRefresh, events: [], board });

    // Nothing committed since (the FE is already up to date) — an empty, non-refresh delta.
    if (sinceBeatSeq === current) return empty(false);
    // A token ahead of the current counter, or negative/malformed ⇒ full refresh (never guess forward).
    if (sinceBeatSeq < 0 || sinceBeatSeq > current) return empty(true);
    // A token older than the retained window (or after a restart, when the ring is empty) ⇒ full refresh.
    const cp = this.beatCheckpoints.get(sinceBeatSeq);
    if (!cp) return empty(true);

    // O(Δ) event tail: only the player-visible events appended AT OR AFTER the checkpoint's event count.
    // Without the registry-wired providers (a standalone adapter) we cannot fetch a Vault-safe tail, so
    // we fall back to a full refresh rather than risk an unscrubbed/over-broad projection.
    if (!this.deltaSource) return empty(true);
    const events = this.deltaSource.visibleEventsSince(cp.eventCount);
    this.deltaScanProbe?.(events.length); // diagnostic only — a count, never content (Part E perf guard)

    // Ceremony field diffs (only the fields that actually moved appear). Compare the captured board AS OF
    // `sinceBeatSeq` against the live ceremony — the same public ceremony-level facts `gameStatus` exposes.
    const changes: NonNullable<StateDeltaView["changes"]> = {};
    if (cp.week !== this.week) changes.week = { from: cp.week, to: this.week };
    if (cp.phase !== this.phase) changes.phase = { from: cp.phase, to: this.phase };
    if (cp.hoh !== this.ceremony.hoh) changes.hoh = { from: this.card(cp.hoh), to: this.card(this.ceremony.hoh) };
    if (!sameIds(cp.nominees, this.ceremony.nominees)) {
      changes.nominees = {
        from: cp.nominees.map((id) => ({ id, name: this.nameOf(id) })),
        to: this.ceremony.nominees.map((id) => ({ id, name: this.nameOf(id) })),
      };
    }
    if (cp.vetoHolder !== this.ceremony.vetoHolder) {
      changes.vetoHolder = { from: this.card(cp.vetoHolder), to: this.card(this.ceremony.vetoHolder) };
    }
    if (cp.vetoUsed !== this.ceremony.vetoUsed) changes.vetoUsed = { from: cp.vetoUsed, to: this.ceremony.vetoUsed };

    const finishedNow = !!this.live?.finished;
    const finishedChanged = cp.finished !== finishedNow || cp.winner !== this.live?.winner;
    const hasChanges = Object.keys(changes).length > 0;
    // T0-3 — the SAME O(Δ) tail slice as `events`, over the (in-memory-only) announcement ring; a token
    // older than the retained window already full-refreshed above via the SAME `beatCheckpoints` miss,
    // so this never needs its own staleness handling.
    const announcements = this.announcementLog.slice(cp.announcementCount);
    return {
      beatSeq: current,
      fullRefresh: false,
      events,
      ...(announcements.length ? { announcements } : {}),
      ...(hasChanges ? { changes } : {}),
      ...(finishedChanged ? { finishedChanged: true } : {}),
      ...(finishedNow ? { winner: this.named(this.live?.winner) } : {}),
      board,
    };
  }

  /**
   * ADR 0019 Layer 2 — each PRESENT houseguest's OWN knowledge scope, for the NARRATION prompt only.
   * The SAME Vault-free `knows`/`suspects` projection `npcVoice` returns, per houseguest actually in the
   * player's room (`whereabouts.present`) — so `renderGameContext` voices each present houseguest from
   * THEIR bounded set by default, without depending on the reliably-under-called `npcVoice`. "Context is
   * not knowledge": a fact witnessed only by B rides under B's labelled block, never A's.
   *
   * Deliberately confined to the moment prompt (the narration model's context, the SAME place `npcVoice`
   * feeds): it is NOT folded onto the general `GameStateView` the HUD/FE reads (`getGameState`/
   * `gameStatus`), which stays free of any houseguest's private knowledge (the B42 canary's line).
   */
  private presentKnowledgeForPrompt(): import("../../ports/GameSession").PresentKnowledgeView[] {
    // 0129 slice 2 — a juror-player is not in the live house, so "who is present" is the OTHER jurors they live
    // with. Seam reuse: the SAME per-person `npcVoice` scope (that juror's own witnessed-or-told set), labelled
    // under THEIR name — no new reader, no cross-juror bleed, nothing from the live house's private knowledge.
    const juryRoster = this.juryHouseView()?.jurors;
    const juryMode = juryRoster !== undefined;
    const present: NamedRef[] = juryRoster?.map((j) => ({ id: j.id, name: j.name })) ?? this.whereabouts()?.present ?? [];
    return present
      .map((p) => {
        const v = this.npcVoice(p.id);
        if (!v) return null;
        // Audit band D F2 — also carry the Vault-safe carriage cues (0084 mood / 0088 currentRead /
        // 0096 rivalry) npcVoice already computed, so the narrator gets them every turn without the
        // under-called tool. Each only when set (absent ⇒ the entry is byte-identical to before).
        // 0129: in the jury house a juror's block omits the engine-seeded vote-deduction beliefs (sealed ballot, E12).
        const knows = juryMode
          ? (this.npcKnowledge?.known(p.id) ?? [])
              .filter((f) => !GameSessionAdapter.isSealedAttribution(f))
              .slice(-GameSessionAdapter.VOICE_KNOWS_CAP)
              .map((f) => this.humanize(f.content))
          : v.knows;
        const e: import("../../ports/GameSession").PresentKnowledgeView = {
          id: p.id,
          name: v.houseguest.name,
          knows,
          suspects: v.suspects,
          ...(v.mood ? { mood: v.mood } : {}),
          ...(v.currentRead ? { currentRead: v.currentRead } : {}),
          ...(v.rivalry ? { rivalry: v.rivalry } : {}),
        };
        return e;
      })
      .filter(
        (e): e is NonNullable<typeof e> =>
          e !== null &&
          (e.knows.length > 0 || e.suspects.length > 0 || e.mood !== undefined || e.currentRead !== undefined || e.rivalry !== undefined),
      );
  }

  getMomentPrompt(req: MomentPromptReq): MomentPromptView {
    // #1792 — one-shot Producer Read: consume the pending ExchangeAccounting and clear
    // it so it never fires again (not even on the shared view()/HUD path). Convert to
    // a Vault-free second-person string.
    const pendingPr = this.pendingExchangeAccounting;
    this.pendingExchangeAccounting = undefined;
    const prLine = pendingPr && this.producerReadEnabled
      ? producerReadPrompt(pendingPr)
      : undefined;
    const baseView = this.view();
    // ADR 0019 Layer 2: augment the NARRATION view (only) with each present houseguest's own knowledge
    // scope. Absent when nobody present holds anything ⇒ byte-identical prompt.
    const pk = this.presentKnowledgeForPrompt();
    // Augment the narration view with the one-shot Producer Read string (if any).
    // Present ONLY in the getMomentPrompt path — the shared view() never carries it,
    // so the HUD/getGameState never sees or consumes it.
    const view = prLine
      ? { ...baseView, presentKnowledge: pk?.length ? pk : undefined, producerRead: prLine }
      : pk.length
        ? { ...baseView, presentKnowledge: pk }
        : baseView;
    const moment = req.moment ?? view.moment;
    // #1735 (A4) — the terminal HARD-CONSTRAINTS block, a SEPARATE field from `systemPrompt` so the
    // caller (the front-end) can append it as the LAST message before generation instead of folding it
    // into the leading system-prompt stack (the measured "lost in the middle" region). Absent when
    // there is nothing to pin (pre-game / no live whereabouts this turn) ⇒ byte-identical response.
    const hardConstraints = renderHardConstraints(view);
    return {
      moment,
      systemPrompt: buildSystemPrompt(
        moment, view, this.storyFacts(moment), this.worldContext(moment), this.producerVoice(moment),
        this.freshSurfacedFacts(),
        // the diary levers are advertised only while their engine flags are live (a flag-off tool is dead)
        { playerDossier: this.playerDossierEnabled, boothReceipts: this.boothReceiptsEnabled, npcTells: this.npcTellsEnabled, npcMemorySpeech: this.npcMemorySpeechEnabled && this.npcMemoryEnabled, confrontMisfire: this.gossipConsequenceEnabled },
      ),
      ...(hardConstraints ? { hardConstraints } : {}),
      // The producer's public name — the byline the FE renders as the chat sender (producer-persona
      // feature). Vault-free: `producer()` is public voice flavor only.
      producerName: this.producer().name,
    };
  }

  /**
   * Feature #1394 — recall the Vault-free witnessed moments involving the scene's houseguest(s),
   * ranked by relevance to the cue. Delegates to the registry-wired `sceneRecall` closure, which reads
   * ONLY the player's `VisibleStateService` projection — so nothing hidden can ever be returned. A pure
   * READ (no beatSeq bump, no persist). Empty `withIds`/`cue`, no wired closure, or no relevant history
   * ⇒ `{ moments: [] }` (the enrichment policy: recall absence is not a failure).
   */
  recallSceneMemories(req: RecallSceneMemoriesReq): RecallSceneMemoriesView {
    const npcIds = (req.withIds ?? []).filter((id) => typeof id === "string" && id.length > 0);
    const cue = typeof req.cue === "string" ? req.cue : "";
    if (npcIds.length === 0 || cue.trim().length === 0 || !this.sceneRecall) return { moments: [] };
    return { moments: this.sceneRecall(npcIds, cue) };
  }

  /**
   * The producer persona for this season — a REAL generated character (as deep as any houseguest, built
   * by the same `CharacterFactory` machinery) but OFF-CAMERA: no headshot, not one of the 16, never in
   * the roster/portraits/whereabouts. Seeded for reproducibility. The interview runs PRE-GAME (before
   * there is a season seed), so the producer's seed is established LAZILY here the first time it's needed,
   * with real entropy, then PERSISTED — so the same producer is voiced every turn of the interview and
   * survives a restart, and `createCharacter` reuses the very same seed into the season. Cached.
   */
  private producer(): Producer {
    if (this.producerSeed === null) {
      // First need (pre-game): mint a stable seed and persist it, so the SAME producer is voiced for the
      // whole interview and survives a restart. (Once a game starts, the season seed is used — see below.)
      this.producerSeed = entropySeed();
      this.producerCache = null;
      this.persist();
    }
    // Merge the seeded floor with the authored overlay (increment 3): the overlay DEEPENS the persona
    // where present, the seeded floor fills the rest, and the NAME always comes from the seed (the byline
    // never churns). No overlay ⇒ the floor is returned byte-identically (non-degradation / opt-in).
    if (!this.producerCache) {
      this.producerCache = mergeProducer(producerForSeed(this.producerSeed), this.producerProfile);
    }
    return this.producerCache;
  }

  /**
   * The producer-persona block woven into the casting-interview prompt (facts to voice, ADR 0003): the
   * model voices THIS specific, seeded producer consistently. Present ONLY on the pre-game casting beat
   * (`character-creation`); every other moment is a houseguest/host beat with no producer voice. Vault-free
   * by construction — the producer carries only PUBLIC voice flavor, never a hidden number or secret.
   */
  private producerVoice(moment: string): string | undefined {
    if (moment !== "character-creation") return undefined;
    return renderProducerVoice(this.producer());
  }

  /**
   * The Vault-free "world you all moved in with" block (feature 0062, §5/§7) woven into the moment
   * prompt — built from the FROZEN persisted snapshot, scaled by the live week (the longer the season,
   * the more dated the house, §7). `social` (and any off-screen) moment gets the off-screen framing (the
   * C32-beyond delta — NPC-to-NPC life shares the same world); every other live moment gets the player
   * framing. Pre-game / no-snapshot ⇒ "" (the §8 fail-soft path; the prompt is unchanged). Public flavor
   * by construction — it reads ONLY the public snapshot, never a hidden number.
   */
  private worldContext(_moment: string): string | undefined {
    if (!this.worldSnapshot || !this.house) return undefined;
    // #580 (NARR-11, PO ruling 2026-06-23): getMomentPrompt is the PLAYER'S narration prompt —
    // every beat here is player-facing. Social/diary-room are player-PRESENT, so they take the
    // player-channel zeitgeist framing, not the off-screen "world you moved in with" framing.
    const channel = "player";
    // 0062 HOH music perk: the player has LIVE music only when they hold it — the reigning HOH (the real-BB
    // luxury) or in the HOH room overhearing it; otherwise the music slice is frozen memory like the rest.
    const block = renderZeitgeist(this.worldSnapshot, {
      week: this.week, channel, musicAccess: this.hasMusicPerk(this.house.player.id),
    });
    return block.length > 0 ? block : undefined;
  }

  /**
   * 0062 media-fidelity (the HOH music perk): who currently has LIVE music — the one live-media exception
   * in the sealed house. The reigning HOH gets the music luxury (real BB), and anyone in the HOH room
   * overhears it. No HOH (premiere / between reigns) ⇒ nobody. Reads ONLY public state (the HOH + room
   * co-presence already cross to the player via gameStatus/whereabouts), so it leaks nothing — and it is a
   * prompt-rendering read, never a game input, so the §6 outcome-invariance holds.
   */
  private hasMusicPerk(id: EntityId): boolean {
    const hoh = this.ceremony.hoh;
    if (!hoh) return false;
    if (id === hoh) return true;
    return this.presence?.get(id) === "hoh-room";
  }

  /**
   * The Vault-free projection of the move-in zeitgeist snapshot (feature 0062) — the FROZEN shared
   * real-world flavor the cast moved in WITH, plus the off-screen-channel "world you moved in with"
   * BLOCK an NPC-to-NPC society/gossip scene is colored by (§5, the C32-beyond delta). `null` pre-game
   * or when no snapshot was captured (the §8 fail-soft skip). Public, shared flavor — never Vault, never
   * a game input (§6): it carries no secret and no number, and reading it changes no outcome.
   */
  worldSnapshotView(): WorldSnapshotView | null {
    // The §8 ABSENT tier reads as "no snapshot present" — an absent snapshot has no voiceable content,
    // so the public view is null (it round-trips as absent). `hasZeitgeist` gates present-and-non-empty.
    if (!this.house || !hasZeitgeist(this.worldSnapshot)) return null;
    const snap = this.worldSnapshot;
    return {
      capturedFor: snap.capturedFor,
      source: snap.source,
      // PUBLIC slices only — `capturedAt`/`lagDays` are operational provenance, never surfaced.
      slices: cloneSession(snap.slices),
      offscreenPrompt: renderZeitgeist(snap, { week: this.week, channel: "offscreen" }),
    };
  }

  /**
   * The FE-owned write-back seam (feature 0062, §8) — the front-end (which owns the concrete `web_search`
   * provider, like the 0051 image port) captures a REAL move-in zeitgeist at season creation and writes
   * it back here so the ENGINE persists it as the single frozen artifact (it then RECALLS it, never
   * re-searches, §9). REPLACES the deterministic `model-framed` fallback for this season (idempotent),
   * freezing it byte-stable thereafter. Outward-safe by construction: the payload is PUBLIC real-world
   * flavor (§6) — no Vault handle, no secret, no game input. A no-op before a game starts (nothing to
   * freeze onto). The slices are bounded to the budget (§11 #3); empty slices keep the fallback's value
   * so a partial capture never thins the snapshot (non-degradation).
   */
  recordWorldSnapshot(req: RecordWorldSnapshotReq): RecordWorldSnapshotResult {
    if (!this.house || !this.worldSnapshot) return { accepted: false, source: "absent" };
    const base = this.worldSnapshot;
    const cap = ZEITGEIST.itemsPerSlice;
    const merge = (key: ZeitgeistSlice): string[] => {
      const incoming = req.slices?.[key];
      // Sanitize untrusted FE text (flatten control chars that could forge a prompt line; cap length +
      // count). An empty/absent slice keeps the fallback's value (non-degradation — never thin it).
      if (!Array.isArray(incoming) || incoming.length === 0) return [...base.slices[key]];
      return incoming
        .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
        .slice(0, cap)
        .map((s) => sanitizeFlavor(s));
    };
    const moodIn = typeof req.slices?.mood === "string" ? req.slices.mood : undefined;
    this.worldSnapshot = {
      capturedFor: typeof req.capturedFor === "string" && req.capturedFor.trim() ? sanitizeFlavor(req.capturedFor, 80) : base.capturedFor,
      capturedAt: typeof req.capturedAt === "string" ? sanitizeFlavor(req.capturedAt, 80) : base.capturedAt,
      lagDays: base.lagDays,
      source: "web_search",
      slices: {
        screen: merge("screen"), music: merge("music"), sports: merge("sports"),
        news: merge("news"), internet: merge("internet"),
        mood: moodIn && moodIn.trim() ? sanitizeFlavor(moodIn) : base.slices.mood,
      },
    };
    this.backgroundPersist(); // R-BND (#628): durable, but NOT a board beat — no beatSeq bump
    return { accepted: true, source: "web_search" };
  }

  /**
   * The FE-driven producer-DEEPENING write-back (increment 3 of #1626) — fold an AUTHORED overlay onto
   * the seeded off-camera casting producer so the ENGINE stays the source of truth (the
   * `recordWorldSnapshot` / `recordCastProfile` handshake). Validate through the `validateProducerProfile`
   * envelope (open-set prose only, length-capped, any stat/soul vocabulary stripped), then ACCUMULATE the
   * accepted fields onto any prior overlay ({...prior, ...new} — a later authoring deepens, never loses a
   * facet). The seeded NAME is never touched (the byline stays byte-stable). Vault-free by construction —
   * no stat/number/hidden field is typed on the request, and any that sneaks in as prose is stripped.
   * Durable pre-game state, but NOT a board beat (background persist, no beatSeq bump). Idempotent /
   * fail-soft: an empty or all-rejected payload leaves the seeded producer standing (accepted:false).
   */
  recordProducerProfile(req: RecordProducerProfileReq): RecordProducerProfileResult {
    const { overlay, fields, rejected } = validateProducerProfile(req as Record<string, unknown>);
    if (fields.length === 0) {
      // Nothing usable ⇒ the seeded floor (and any prior overlay) stands, unchanged.
      return { accepted: false, fields: [], reason: rejected.length > 0 ? "rejected" : "empty" };
    }
    // Establish the producer seed if it isn't yet (pre-interview), so the byline is stable and the merge
    // has a floor — and so the persisted snapshot carries the seed + overlay together.
    this.producer();
    // ACCUMULATE onto any prior overlay (non-degradation): the new fields deepen, none is lost.
    this.producerProfile = { ...(this.producerProfile ?? {}), ...overlay };
    this.producerCache = null; // rebuild the merged persona on next read
    this.backgroundPersist(); // durable pre-game state, NOT a board beat — no beatSeq bump
    return { accepted: true, fields };
  }

  /**
   * Feature #1400 (READ) — the Vault-free "what to hand the model" projection for the currently-staging
   * competition. Null unless generation is enabled AND a comp has RESOLVED its roll (the model dresses a
   * decided result — nothing to hand it before the roll commits; the structural "no outcome-adjacent text
   * before the roll" ordering). Projects ids → names and hands the fixed drop ORDER (public — the reveal
   * tells it round by round anyway) + the 0042 library scaffold the model riffs ON. No number ever crosses.
   */
  competitionStagingView(): import("../../ports/GameSession").CompetitionStagingView | null {
    if (!this.genCompetitionsEnabled || !this.house || !this.live) return null;
    const data = competitionStagingData(this.live);
    if (!data) return null;
    // 0125: dress the library floor in this week's seeded theme so the model riffs FROM structured
    // variety (it may still author its own theme over it). Off/pre-seed ⇒ the bare 0042 scaffold.
    const skin = data.def ? this.themedScaffold(data.def) : undefined;
    return {
      comp: data.comp,
      type: data.type,
      week: this.week,
      ...(data.def ? { format: data.def.format } : {}),
      participants: data.field.map((id) => ({ id, name: this.nameOf(id) })),
      winner: { id: data.winner, name: this.nameOf(data.winner) },
      dropOrder: data.dropOrder.map((id) => ({ id, name: this.nameOf(id) })),
      library: {
        name: skin?.name ?? "",
        ...(skin?.theme ? { theme: skin.theme } : {}),
        premise: skin?.narrative.premise ?? "",
        beats: skin ? [...skin.narrative.beats] : [],
        winReads: skin?.narrative.winReads ?? "",
      },
      alreadyAuthored: data.alreadyAuthored, // the FE's persistent "author exactly once per comp" guard
    };
  }

  /**
   * Feature #1400 (WRITE-BACK) — record the model-authored competition fiction AFTER the roll commits. The
   * pure `validateCompetitionFiction` is the HARD gate: it accepts the fiction ONLY when every elimination
   * it names maps to the engine's fixed drop order EXACTLY (same ids, same order) — any mismatch is
   * REJECTED and nothing is stored, so the deterministic 0042 library floor stands and the generated
   * fiction can never rename who goes or in what order. On success the sanitized fiction lands on the live
   * state (PRESENTATION ONLY — the reveal tells it round by round) and durably persists WITHOUT bumping the
   * closed-set `beatSeq` (like the 0062 zeitgeist / 0058 profile write-backs): it perturbs no seeded roll.
   */
  recordCompetitionFiction(
    req: import("../../ports/GameSession").RecordCompetitionFictionReq,
  ): import("../../ports/GameSession").RecordCompetitionFictionResult {
    if (!this.genCompetitionsEnabled) return { accepted: false, reason: "disabled" };
    if (!this.house || !this.live) return { accepted: false, reason: "no-game" };
    const result = validateCompetitionFiction(this.live, req);
    if (!result.ok) return { accepted: false, reason: result.reason };
    this.live.competitionFiction = result.fiction;
    this.backgroundPersist(); // durable, but NOT a board beat — presentation-only, no beatSeq bump
    return { accepted: true };
  }

  /**
   * 0070 — called by the orchestrator after every off-screen tick to register the ids of the scenes
   * that were just recorded. TRANSIENT: the registry is replaced on each tick so only the MOST RECENT
   * batch is addressable via `getOffscreenSceneSkeletons`. The event store is the durable source of
   * truth; this is a convenience index for the current-tick FE fan-out only.
   */
  notifyOffscreenTick(eventIds: string[]): void {
    this.lastTickOffscreenIds = [...eventIds];
  }

  /**
   * 0070 — the Vault-free skeletons of the off-screen scenes recorded in the most recent tick.
   * Returns only public participant ids, interaction nature, and current prose content (either the
   * deterministic template or the voiced texture if a write-back has already landed). Never returns
   * hidden attributes, relationship numbers, or soul data. Returns [] before a game starts or when
   * no off-screen tick has run yet.
   */
  getOffscreenSceneSkeletons(): import("../../ports/GameSession").OffscreenSceneSkeleton[] {
    if (!this.house || this.lastTickOffscreenIds.length === 0) return [];
    const events = this.record?.events() ?? [];
    const byId = new Map(events.map((e) => [e.id, e]));
    const result: import("../../ports/GameSession").OffscreenSceneSkeleton[] = [];
    for (const id of this.lastTickOffscreenIds) {
      const ev = byId.get(id);
      if (!ev || !ev.hidden) continue; // only hidden events are part of the off-screen texture layer
      // Apply texture override if one exists; otherwise the deterministic template content stands.
      const prose = this.textureOverrides.get(id) ?? ev.baseContent ?? ev.content;
      result.push({
        eventId: ev.id,
        nature: ev.type,
        participants: [...ev.witnessSet], // public participant ids (no Vault content)
        templateContent: prose,
      });
    }
    return result;
  }

  /**
   * FE-driven write-back (0070): enrich the prose `content` of an already-recorded hidden off-screen
   * event with model-voiced texture. CONTENT ONLY — it cannot create an event, alter a witness set,
   * flip the hidden flag, or carry a relationship number. Idempotent; a no-op for an unknown or
   * non-hidden event (returns `{ ok: false }`). Fail-soft: a missing driver leaves the deterministic
   * template content intact.
   */
  recordOffscreenSceneTexture(req: import("../../ports/GameSession").RecordOffscreenSceneTextureReq): import("../../ports/GameSession").RecordOffscreenSceneTextureResult {
    const { eventId, content } = req;
    if (typeof eventId !== "string" || !eventId.trim()) return { ok: false };
    const sanitized = sanitizeFlavor(content, 1000);
    if (!sanitized) return { ok: false };
    // Verify the event exists, is hidden, and was not witnessed by the player — content-only guard.
    const events = this.record?.events() ?? [];
    const ev = events.find((e) => e.id === eventId);
    if (!ev || !ev.hidden) return { ok: false };
    this.textureOverrides.set(eventId, sanitized);
    this.backgroundPersist(); // R-BND (#628): durable, but NOT a board beat — no beatSeq bump
    return { ok: true };
  }

  /** How many recorded witnessed events ground a server-initiated lifecycle beat (B62). */
  private static readonly STORY_FACT_EVENTS = 8;

  /**
   * The story-so-far facts for a server-initiated lifecycle beat (B62/audit J1+J7+J2): the most
   * recent WITNESSED events from the record — the store recalled, never the chat remembered
   * (ADR 0003) — plus the result for a finished season. Vault-free by construction: hidden
   * events never enter, and the winner/week are public ceremony facts. Other moments get none
   * (the per-turn prompt stays tight — prefer removing context to adding it).
   */
  private storyFacts(moment: string): string | undefined {
    if (moment !== "re-entry" && moment !== "post-season") return undefined;
    const recent = (this.record?.events() ?? [])
      .filter((e) => !e.hidden)
      .slice(-GameSessionAdapter.STORY_FACT_EVENTS)
      .map((e) => ({ content: this.humanize(e.content) }));
    const winner = this.live?.finished ? this.named(this.live.winner) : null;
    // Anti-confabulation (priority #3): the reunion/recap was inventing the jury margin and the
    // player's own placement (a real playtest defect — "9-2" for an 8-1 vote, "Final 5" for a Final
    // 6 exit). Hand the model the EXACT public finale facts so it voices them instead of embellishing.
    const tally = this.live?.finished ? this.finaleTally() : null;
    const playerSeason = this.live?.finished ? this.playerSeason() : null;
    return renderStoryFacts(
      recent,
      winner ? { winner: winner.name, week: this.week, ...(tally ? { tally } : {}) } : null,
      playerSeason,
    );
  }

  /** How many of the player's own surfaced facts ride along on EVERY turn (SOC-1/4). Bounded so the
   *  block stays tight, mirroring `STORY_FACT_EVENTS` — this is a per-turn addition, not a full recap. */
  private static readonly SURFACED_FACTS_WINDOW = 5;

  /**
   * SOC-1/4 — the player's own recently-surfaced KNOWLEDGE (an NPC confiding, a seeded-tie belief,
   * gossip that diffused all the way to them): computed by the `KnowledgeService` (`surfaceInformationTo`
   * / `transmitGossip`, wired in `registry.ts`) but, before this fix, NEVER handed to the narrator on an
   * ordinary turn. The provenance EVENT those calls also record (`"surfaced to player via told-by:npc:3"`,
   * `"gossip … reaches player"`) deliberately carries no real content — a shared verbatim string would trip
   * the orchestrator's vault-leak checkpoint substring sweep against another entity's hidden copy (see the
   * comment on `InMemoryKnowledgeService.surfaceInformationTo`) — so the ACTUAL fact text lives only in the
   * `KnowledgeFact.content` this reads back, via the SAME `playerKnowledgeReader` the secrets-as-power
   * levers already trust as the player's own, Vault-free knowledge (0093/0099). Excludes the Diary Room
   * (`NO_NPC_PATHWAY`) — an OOC channel with no in-game pathway to anyone, never something "the house told
   * you". Bounded to the most recent few so the block stays tight (ADR 0003 §1); `undefined` when there is
   * nothing fresh (byte-identical prompt to before this fix).
   */
  private freshSurfacedFacts(): string | undefined {
    const drift = this.gossipDriftEnabledNow();
    const facts = (this.playerKnowledgeReader?.() ?? [])
      .filter((f) => f.pathway !== NO_NPC_PATHWAY)
      .slice(-GameSessionAdapter.SURFACED_FACTS_WINDOW)
      .map((f) => drift
        ? { content: this.humanize(f.content), hops: f.hops }
        : { content: this.humanize(f.content) });
    return renderSurfacedFacts(facts);
  }

  /** The exact, public jury vote margin (anti-confabulation grounding for the recap). Counts the
   *  persisted finale ballots per finalist; null until a winner + Final 2 + ballots exist. */
  private finaleTally(): { winnerVotes: number; runnerUpVotes: number; runnerUp: string } | null {
    const votes = this.live?.finale?.votes;
    const winner = this.live?.winner;
    const finalTwo = this.live?.finalTwo;
    if (!votes || !winner || !finalTwo) return null;
    const runnerUp = finalTwo.find((id) => id !== winner);
    if (!runnerUp) return null;
    let winnerVotes = 0, runnerUpVotes = 0;
    for (const choice of Object.values(votes)) {
      if (choice === winner) winnerVotes += 1;
      else if (choice === runnerUp) runnerUpVotes += 1;
    }
    return { winnerVotes, runnerUpVotes, runnerUp: this.nameOf(runnerUp) };
  }

  /** The player's OWN public placement, stated exactly so the recap can't inflate it (Final N they
   *  went out at, the eviction week, jury seat + their finale vote). Public ceremony facts only. */
  private playerSeason(): string | null {
    if (!this.house || !this.live) return null;
    const me = this.house.player.id;
    if (this.live.winner === me) return "You WON the season.";
    if (this.live.finalTwo?.includes(me)) return "You finished as the RUNNER-UP (the Final 2).";
    const idx = this.live.evictionOrder.indexOf(me);
    if (idx < 0) return null;
    const cast = this.house.npcs.length + 1;
    const finalN = cast - idx; // houseguests remaining (incl. the player) when they were evicted
    const week = this.live.voteRecord?.find((r) => r.evictee === me)?.week;
    let s = `You were evicted${week ? ` in week ${week}` : ""}, going out at the Final ${finalN}`;
    if (this.seatOf(me) === "jury") {
      s += ", then sat on the jury";
      const vote = this.live.finale?.votes?.[me];
      if (vote) s += ` and voted for ${this.nameOf(vote)} to win`;
    }
    return s + ".";
  }

  /**
   * Report the live loop's competition — it is NOT a second resolver (B37/audit A1+A3). The weekly
   * loop (`advanceGame` → `liveSeason`) is the SOLE authority on who wins; `runCompetition` only
   * PREVIEWS the current competition beat's deterministic winner (the loop crowns the same one when
   * the beat advances — same seed). Per remediation principle #3 it validates references and ignores
   * foreign input: ids only, unknown/evicted ids refused, caller stats never read.
   */
  runCompetition(req: RunCompetitionReq): CompetitionResultView {
    const fallbackType = (COMP_TYPES.has(req.type ?? "") ? req.type : "endurance") as CompetitionType;
    if (!this.house) return { started: false, type: fallbackType, week: 0, phase: this.phase, winner: null };

    // Validated references: any caller-supplied id must be a LIVING houseguest (never evicted/unknown).
    if (req.participantIds?.length) {
      const known = new Set([this.house.player.id, ...this.house.npcs.map((n) => n.id)]);
      const evicted = new Set(this.live?.evictionOrder ?? []);
      if (req.participantIds.some((id) => !known.has(id) || evicted.has(id))) {
        return { started: true, type: fallbackType, week: this.week, phase: this.phase, winner: null };
      }
    }

    // Single authority: the field + winner come from the loop, computed from the live house's own
    // stats/souls (caller stats ignored). The evicted are never in an eligibility pool by construction.
    if (this.live) {
      const peek = peekCompetition(this.live, this.ctx(), this.beatRng());
      if (peek) {
        // The drawn library def (0042): name + format + the Vault-free narrative scaffold — the
        // narrator dresses THIS competition. Flavor only; no stat, score, or ranking crosses.
        // #1400: when the model authored + the engine VALIDATED fiction for THIS staged comp, surface
        // the model-authored THEME as the comp name and its premise/winReads as the scaffold, so a fresh
        // context (a restart) re-grounds the narrator in the authored staging instead of the library
        // floor. PRESENTATION ONLY — the winner/format are unchanged; the per-drop fiction rides the
        // comp-elimination beats, so the preview `beats` stay the generic library scaffold (no spoiler).
        // L-F4 (#1743): the presentation SOURCE (authored fiction vs. seeded theme) is decided by the
        // FROZEN pin, NOT the live fiction — so a late first-fiction write-back can never re-skin the
        // active comp's name/premise (and this preview matches whereabouts().houseEvent.comp round to
        // round). `competitionPresentation` also LAZY-FREEZES a legacy in-progress comp on this first read.
        const pres = competitionPresentation(this.live); // non-null for a staged comp; null for a pre-stage preview
        const f = this.live.competitionFiction;
        const authored = pres?.authored ? f : undefined; // pres.authored already honors the frozen source
        // 0125: the seeded theme is the deterministic floor's skin; #1400's model-authored fiction still
        // overrides it (a fresh restart re-grounds the narrator in the authored staging). Precedence:
        // model fiction > seeded theme > bare 0042 library.
        // For an in-progress staged comp read the theme from its FROZEN inputs (pinned at draw, or lazy-
        // frozen just above for a legacy save), so it stays byte-identical round to round.
        const skin = this.themedScaffold(peek.def, this.frozenCompTheme());
        return {
          started: true, type: peek.type, week: this.week, phase: this.phase,
          winner: this.named(peek.winner),
          name: authored?.theme ?? skin.name, format: peek.def.format,
          ...(!authored && skin.theme ? { theme: skin.theme } : {}),
          narrative: {
            premise: authored?.premise ?? skin.narrative.premise,
            beats: [...peek.def.narrative.beats],
            winReads: authored?.winReads ?? skin.narrative.winReads,
          },
        };
      }
      // Between competitions: report the most recently crowned comp from public ceremony state — no re-roll.
      const last = this.ceremony.vetoHolder ?? this.ceremony.hoh;
      return { started: true, type: fallbackType, week: this.week, phase: this.phase, winner: last ? this.named(last) : null };
    }
    return { started: true, type: fallbackType, week: this.week, phase: this.phase, winner: null };
  }

  /**
   * Where the player stands (0046). `active` until they are evicted; once evicted, `jury` if they fall
   * in the last-9 jury (they spectate the public ceremonies and vote at the finale) or `evicted` if they
   * went out pre-jury. Derived purely from the public eviction order + the (fixed) cast size — the jury
   * is the last 9 of the `cast − 2` evictions, so a player evicted at index ≥ that threshold is a juror.
   * Vault-free: nothing here reads a hidden number.
   */
  private playerStatus(): "active" | "jury" | "evicted" {
    // 0061 (owner decision #1): a CONFIRMED self-eviction is a FORFEIT — the player exits the game
    // entirely and never takes a juror's seat, even in the jury phase. So a self-evicted player
    // always reads "evicted" (terminal), overriding the phase-derived seat the eviction index would give.
    if (this.live?.selfEvicted) return "evicted";
    return this.seatOf(PLAYER);
  }

  /** The eviction-order index at which the last-9 jury forms: evictions before it are pre-jury (they go home). */
  private juryStartIndex(): number {
    const cast = this.house ? this.house.npcs.length + 1 : 16;
    return Math.max(0, cast - 2 - 9);
  }

  /** 0025 reactive: the twists the season's sealed plan ARMED that never fired (engine-only; only ever read by the post-crown retrospective unseal). */
  private armedUnfiredReactiveTwists(fired: ReadonlyMap<string, number>): Array<{ kind: string; firedWeek: null }> {
    const plan = this.live?.twistPlan;
    if (!plan) return [];
    const armed: Array<[string, boolean]> = [
      ["double-eviction", plan.doubleEvictionArmed], ["secret-veto", plan.secretVetoArmed], ["battle-back", plan.battleBackArmed],
    ];
    return armed.filter(([kind, on]) => on && !fired.has(kind)).map(([kind]) => ({ kind, firedWeek: null }));
  }

  /** Any houseguest's public seat (B61): still playing, on the last-9 jury, or out pre-jury. */
  private seatOf(id: EntityId): "active" | "jury" | "evicted" {
    const order = this.live?.evictionOrder ?? [];
    const idx = order.indexOf(id);
    if (idx < 0) return "active";
    return idx >= this.juryStartIndex() ? "jury" : "evicted";
  }

  /** The Vault-free projection. Player card = authored persona (no numeric stats); NPCs = name + status only. */
  private view(): GameStateView {
    if (!this.house) {
      // Pre-game, the view carries the interview's status (0050): the engine — not the model —
      // says which building blocks are in and what the next step is.
      return {
        started: false, beatSeq: this.beatSeq, finished: false, week: 0, phase: this.phase, moment: "character-creation",
        ceremony: { hoh: null, nominees: [], veto: { holder: null, used: false, players: [] } },
        whereabouts: null,
        player: null, house: [], casting: castingStatusOf(this.intake),
        pending: null,
      };
    }
    const p = this.house.player;
    const status = this.playerStatus();
    // Once the player is out, the moment frames their new seat (closure / the jury spectator box, 0046)
    // rather than the ceremony phase they can no longer act in. An active player keeps the phase moment.
    // 0061: a VOLUNTARY walk-out gets its own terminal framing (the season is over for them by their OWN
    // choice — no crowned winner to host a reunion around, unlike `post-season`). It trumps every seat.
    // Otherwise the finished terminal state (0048) trumps every seat: the season is over, the reunion begins.
    const moment = this.live?.selfEvicted
      ? "self-evicted"
      : this.live?.finished
      ? "post-season"
      : status === "evicted" ? "evicted" : status === "jury" ? "jury" : momentForPhase(this.phase);
    // 0013 §5 (PS-4/PG-14 fix): the producer's Diary-Room invitation — wires the previously-uncalled
    // `producerPrompt` into the live view every turn already reads. `undefined` at every routine beat
    // (no field ⇒ the FE sees nothing, byte-identical to before this fix); present only at the
    // dramatic beats `beatForMoment` recognizes (nomination/veto-ceremony/eviction). An INVITATION
    // only — it changes no game state and is never forced.
    const drPrompt = producerPrompt(beatForMoment(moment));
    // 0115 — the player's Diary-Room STRATEGY, projected as a PRIVATE steer for the narrator (their
    // real read, in their own words). Vault-free by construction: reads ONLY the player's own
    // `NO_NPC_PATHWAY` knowledge (never a Vault read, never any NPC's knowledge), and never feeds any
    // NPC's knowledge or behavior — the DR wall (`deriveNpcKnowledge`) is untouched. `renderGameContext`
    // fences it as GM-only / do-not-voice so the GM narrates the irony of the player's mask, never leaks it.
    const drStrategy = playerDiaryStrategy(this.playerKnowledgeReader?.() ?? []);
    // #1793 — the Player Dossier: group the player's OWN diary-room/subject-tagged knowledge facts per houseguest.
    const playerDossier = this.playerDossierEnabled
      ? groupPlayerDossier(this.playerKnowledgeReader?.() ?? [])
      : undefined;
    // 0118 — the day's shape, telegraphed. Present ONLY when the per-conversation clock is live, so the
    // seeded calibration spine (time-of-day off) and golden replay (per-conversation clock off) never see
    // it ⇒ byte-identical, no golden re-record. A pure read of the live loop state + the day clock; the
    // HUD shows it and `renderGameContext` primes on it so run-up scenes carry the coming interruption.
    const nextM = this.perConversationClockLive() ? nextMilestone(this.live) : null;
    const daySchedule = nextM
      ? { next: nextM.beat, phase: nextM.phase, due: milestoneDueOf(this.live), minutesUntil: milestoneDueOf(this.live) ? 0 : (minutesUntilDue(this.live) ?? 0) }
      : undefined;
    // #1411 — the single closed-set lever this beat requires the narrator to CALL (advanceGame at the
    // deterministic comp/ceremony/eviction beats), or null otherwise. The FE forces THIS on the wire
    // instead of keeping its own beat→lever map that could drift from the tool registry. Vault-free (a
    // lever NAME only); a pure function of `phase`, so it never perturbs the golden replay's non-force
    // turns. Absent (spread below) at every non-force beat ⇒ byte-identical / no forcing.
    const requiredLever = requiredLeverForPhase(this.phase);
    return {
      started: true,
      beatSeq: this.beatSeq, // 0065 Part A — the monotonic CAS token surfaced on every read
      ...(this.playerSurfaceN > 0 && this.playerSurfaceSource ? { surfacedToPlayer: { n: this.playerSurfaceN, sourceId: this.playerSurfaceSource } } : {}), // N-17: the delivery marker (ids + a counter, never content)
      // M0-7: the SAME pendingView gameStatus/advance expose — the two closed-set
      // projections of one sandbox must never disagree about the live pending (the
      // eviction-vote ballot surfaced only on gameStatus and state-keyed consumers
      // silently missed it).
      pending: this.pendingView(),
      eviction: this.evictionView(),
      ...(this.live?.dealOffer ? { openDealOffer: this.openDealOfferView() } : {}), // 0123: voiced in-scene, never a card
      finished: !!this.live?.finished, // B6-01: the over-signal the FE season lifecycle (0057) gates on
      // C8-04: the live ceremony state in the model's persistent context (the same Vault-free public
      // facts gameStatus() exposes), so the narrator voices the REAL HOH/nominees/veto, never invents.
      ceremony: {
        hoh: this.card(this.ceremony.hoh),
        nominees: this.ceremony.nominees.map((id) => ({ id, name: this.nameOf(id) })),
        veto: {
          holder: this.card(this.ceremony.vetoHolder),
          used: this.ceremony.vetoUsed,
          players: (this.live?.vetoField ?? []).map((id) => ({ id, name: this.nameOf(id) })), // R9-AGENCY-1: the drawn six
        },
      },
      // L21/L24: the player's live whereabouts (room, who's with them + tenure, adjacent rooms) so the
      // narrator voices the REAL, persistent occupancy the engine drives — never invented positions.
      whereabouts: this.whereabouts(),
      week: this.week,
      phase: this.phase,
      ...(this.timeOfDayEnabled && this.live?.timeOfDay ? { timeOfDay: this.live.timeOfDay, asleep: this.asleepNpcs() ?? [] } : {}), // ADR 0006: the public day-phase + who's turned in
      ...(this.timeOfDayEnabled && this.live?.timeOfDay && typeof this.live.nightDepth === "number" ? { clockLabel: formatClockLabel(this.live.nightDepth, this.live.dayNumber ?? 1) } : {}), // P0: the exact clock the narrator must use
      moment,
      // 0133: an early-evicted spectator's public week digests (absent for everyone else).
      ...(this.weekDigestViews() ? { weekDigests: this.weekDigestViews() } : {}),
      // 0129: the jury house — present only while the player holds a juror's seat.
      ...(this.juryHouseView() ? { juryHouse: this.juryHouseView() } : {}),
      // #1411: the closed-set required lever (present ONLY at a comp/ceremony/eviction beat) — the FE's
      // engine-signaled force directive. Absent everywhere else ⇒ byte-identical / no forcing.
      ...(requiredLever ? { requiredLever } : {}),
      player: {
        id: p.id,
        name: p.name,
        // Surface the player's OWN words (what they typed at OOBE) so the narrative voices them as
        // described; fall back to the canonical labels. Stats stay hidden behind the Vault either way.
        archetype: p.persona?.archetype ?? p.character.archetype,
        strategyStyle: p.persona?.strategyStyle ?? p.character.strategyStyle,
        status,
        ...(this.live?.spectator ? { spectator: this.live.spectator.mode } : {}),
        // ADR 0006 §Principle 5: the player's OWN qualitative tiredness (their body is their knowledge) —
        // a cue, never a number, and never any NPC's sleep state. Present only once the clock is running.
        ...(this.timeOfDayEnabled && this.live?.timeOfDay ? { restStatus: restStatusFor(this.live.lastSleepPhase ?? WAKE_HOUR) } : {}),
        // #1326 — the player's OWN recorded pronouns/presentation (OPTIONAL; absent when never
        // answered), so `getMomentPrompt` can voice the SAME facet instead of guessing from the name.
        ...(p.character.genderPresentation !== undefined ? { genderPresentation: p.character.genderPresentation } : {}),
        // The casting card (0050): the interview's payoff, re-showable all season. Tier WORDS are
        // derived from the hidden balanced stats here, engine-side — the numbers never serialize out.
        castingCard: {
          characterType: p.character.archetype,
          strategyStyle: p.character.strategyStyle,
          strengths: {
            physical: strengthTier(p.character.stats.physical),
            mental: strengthTier(p.character.stats.mental),
            social: strengthTier(p.character.stats.social),
          },
          ...(p.character.background ? { story: p.character.background } : {}),
          ...(p.motivation ? { motivation: p.motivation } : {}),
          // C6: an engine-defaulted character type is SURFACED, never a silent grant.
          ...(p.archetypeDefaulted ? { defaulted: true } : {}),
        },
      },
      house: this.house.npcs.map((n) => ({
        id: n.id, name: n.name,
        status: this.seatOf(n.id),
        // B61: the curated PUBLIC persona facets — the narrator's per-person voice anchor
        // (seed-stable, so a houseguest sounds the same in week 8 as week 1). Stats, the
        // soul, and hiddenElements are deliberately NOT selected here.
        archetype: n.character.archetype,
        strategyStyle: n.character.strategyStyle,
        background: n.character.background,
        age: n.character.age,
        presentation: n.character.presentation,
        // L28: the concrete, diverse, PERSISTED backstory facets — the narrator voices the STORED
        // vocation/hometown instead of inventing (and mirroring the player's). Public, Vault-free.
        ...(n.character.vocation !== undefined ? { vocation: n.character.vocation } : {}),
        ...(n.character.hometown !== undefined ? { hometown: n.character.hometown } : {}),
        // L28 (voice register): the STORED observable demeanor — the narrator voices THIS so the cast
        // is not a room of identical warm professionals. Public, Vault-free.
        ...(n.character.demeanor !== undefined ? { demeanor: n.character.demeanor } : {}),
        // 0116: the model-authored FREEFORM identity concept the narrator voices alongside the archetype
        // tag. Public, Vault-free; absent on the deterministic floor cast.
        ...(n.character.identityConcept !== undefined ? { identityConcept: n.character.identityConcept } : {}),
        // 0058: the PUBLIC multi-sentence biography. Public, Vault-free; the HIDDEN profile
        // (secrets/goals/weakness/perception) is NEVER selected here.
        ...(n.character.biography !== undefined ? { biography: n.character.biography } : {}),
        // L29 single physical descriptor (appearance/physicalCharacteristics consistency): the STRUCTURED
        // `physicalCharacteristics` facet is the ONE source of truth narration AND portraits read; the prose
        // `appearance` rides ONLY as the pre-0058 fallback — NEVER both (independently generated, they could
        // contradict on build/skin/hair). When the facet is present it alone is shipped.
        ...(n.character.physicalCharacteristics !== undefined
          ? { physicalCharacteristics: n.character.physicalCharacteristics }
          : n.character.appearance !== undefined ? { appearance: n.character.appearance } : {}),
        // 0063: the PUBLIC diversity-identity facets — the heritage/cultural identity (an authentic facet
        // of a full character, grounding the skin tone), the gender presentation, and a PUBLICLY-OUT
        // orientation only. A PRIVATELY-held orientation is NEVER here (it's Vault-sealed, §5). Descriptive
        // only — the narrator voices them as it would any public facet, never a defining single word.
        ...(n.character.ethnicity !== undefined ? { ethnicity: n.character.ethnicity } : {}),
        ...(n.character.genderPresentation !== undefined ? { genderPresentation: n.character.genderPresentation } : {}),
        ...(n.character.outOrientation !== undefined ? { outOrientation: n.character.outOrientation } : {}),
        // #1067: PUBLIC, Vault-free provenance — `true` once the FE deep-profile authoring landed for this
        // houseguest, otherwise absent (still on the seeded floor). NOT secret content; lets the FE backfill
        // target the still-floor cards.
        ...(n.character.deepProfileAuthored === true ? { authored: true } : {}),
        // I6 distinct-voices fix (NARR-15/PROMPT-2): a COMPACT, player-surface-SAFE voice-fingerprint
        // clause (0084), rendered from the controlled voice DIAL vocab only (register/rhythm/energy/
        // directness/humor/stress-tell) via `voiceFingerprint` — so distinct cadence reaches the narrator
        // every turn without a per-NPC `npcVoice` call it reliably under-calls. A rendered STRING, never the
        // raw VoiceProfile object (whose free-text signature/lexicon can carry "threat"/"100%" and would
        // trip the Vault-Wall player-surface scan). Public, Vault-free; absent only on a pre-0084 save.
        ...(n.character.voice !== undefined ? { voice: voiceFingerprint(n.character.voice) } : {}),
      })),
      // Deals the player is party to (0039) — fact + status only; NPC↔NPC deals never appear here.
      deals: this.deals.forParty(PLAYER).map((d) => this.dealView(d)),
      ...(this.alliances.forMember(PLAYER).length ? { alliances: this.playerAllianceViews() } : {}),
      // 0059/L40 — only PUBLIC (visible) showmances; sealed ties/showmances never surface here.
      ...(this.visibleShowmances().length ? { showmances: this.visibleShowmances() } : {}),
      // PREMIERE (feature #380 follow-on): the meet-everyone progress — who's met + who's still to
      // introduce + their OBSERVABLE persona — woven into the premiere moment prompt so the producer
      // never loses track. Present ONLY during the premiere (null otherwise). Vault-free public facets.
      ...(this.premiereIntros() ? { premiere: this.premiereIntros()! } : {}),
      // FEATURE-01791: notoriety legend clauses — the Vault-free "what they heard" flavor carried on
      // premiere (the house whispers about the returning player) and early-social week 1 (the talk is
      // still fresh). Only the legend gist crosses; the reputation FACETS / the day-one biases never
      // leave the engine. Vault-free by construction — open-set string[] only.
      ...((this.phase === "premiere" || (this.phase === "social" && this.week === 1)) && this.notoriety?.legendBeats.length
        ? { notorietyLegend: [...this.notoriety.legendBeats] }
        : {}),
      // 0013 §5 / PG-14 / PS-4: the producer's Diary-Room invitation at the current dramatic beat.
      ...(drPrompt.invite ? { diaryRoomInvite: drPrompt as { invite: true; reason?: string } } : {}),
      // 0115: the player's DR strategy as a PRIVATE narrator steer (present only when they've recorded one).
      ...(drStrategy.length ? { playerDiaryRoom: drStrategy } : {}),
      // #1793: the player's dossier (present only when the flag is ON and there are tagged entries).
      ...(playerDossier !== undefined ? { playerDossier } : {}),
      // 0118: the telegraphed day schedule (present only when the per-conversation clock is live).
      ...(daySchedule ? { daySchedule } : {}),
      ...(this.desireClockEnabled && this.live?.interruption ? { interruption: { npc: this.nameOf(this.live.interruption.npc), desire: this.live.interruption.desire } } : {}), // A8: an NPC is cutting into the conversation (names only)
    };
  }

  /**
   * #1793 — the player's Diary-Room dossier. Returns diary-room entries grouped per houseguest
   * subject, filtered to a single subject when subjectId is provided. An EMPTY record when the
   * ORWELL_PLAYER_DOSSIER flag is OFF — never `undefined`, which serialized to no JSON at all and
   * crashed the Vault-sentinel sweeps (`liveSentinel` / `mcp` property tests), leaving every tool
   * after it unchecked. Vault-free by construction.
   */
  playerDossier(subjectId?: EntityId): Record<EntityId, { content: string; ts: number }[]> {
    if (!this.playerDossierEnabled) return {};
    const all = groupPlayerDossier(this.playerKnowledgeReader?.() ?? []);
    if (subjectId === undefined) return all;
    const entry = all[subjectId as string];
    return entry !== undefined ? { [subjectId as string]: entry } : {};
  }

  /**
   * #1800 — The Booth Has Receipts. Deterministic contradictions drawn ONLY from the player's own
   * record (deals, events, DR statements). Returns [] when the ORWELL_BOOTH_RECEIPTS flag is OFF.
   * Never reads the Vault. Never returns NPC knowledge or hidden state.
   */
  playerReceipts(): Receipt[] {
    if (!this.boothReceiptsEnabled) return [];
    const allEvents = this.record?.events() ?? [];
    const player = PLAYER;
    const deals = this.deals?.forParty(player) ?? [];
    const knowledge = this.playerKnowledgeReader?.() ?? [];
    const drStatements = knowledge
      .filter((k: any) => k.pathway === NO_NPC_PATHWAY && k.content)
      .map((k: any) => ({ id: k.id ?? k.factId ?? '', content: k.content, ts: k.ts ?? 0, subject: k.subject }));
    const publicStatements = allEvents
      .filter((e: any) => e.content && e.initiator === player && !e.hidden)
      .map((e: any) => ({ id: e.id ?? '', content: e.content, ts: e.ts ?? 0 }));
    // The player's OWN eviction votes (their ballot is their own knowledge), each with that week's
    // nominees and the player's own on-record words from the run-up — windowed between consecutive
    // eviction results (the witnessed "<evictee> leaves the house" beat, initiated by the evictee).
    const witnessed = allEvents.filter((e) => !e.hidden && e.witnessSet.includes(player));
    const ownWords = witnessed.filter((e) => e.initiator === player && e.type !== "house-event" && e.type !== "deal");
    const votes: NonNullable<Parameters<typeof computePlayerReceipts>[0]["votes"]> = [];
    let windowStart = -Infinity;
    for (const week of this.live?.voteRecord ?? []) {
      const result = witnessed.find((e) => e.type === "house-event" && e.initiator === week.evictee
        && e.ts > windowStart && /leaves the house/.test(e.content));
      if (!result) continue;
      const myVote = week.voteOf[player];
      if (myVote) {
        const nominees = [...new Set([week.evictee, ...Object.values(week.voteOf)])];
        votes.push({
          voteEventId: result.id,
          votedFor: { id: myVote, name: this.nameOf(myVote) },
          nominees: nominees.map((id) => ({ id, name: this.nameOf(id) })),
          statements: ownWords.filter((e) => e.ts > windowStart && e.ts < result.ts).map((e) => ({ id: e.id, content: e.content })),
        });
      }
      windowStart = result.ts;
    }
    const names: Record<string, string> = {};
    for (const d of deals) for (const id of d.parties) names[id] = this.nameOf(id);
    return computePlayerReceipts({
      player,
      deals: deals.map((d: any) => ({
        id: d.id, kind: d.kind, parties: d.parties, terms: d.terms, status: d.status, madeEventId: d.madeEventId,
      })),
      events: allEvents.filter((e) => e.initiator === player && !e.hidden)
        .map((e) => ({ id: e.id, kind: e.type, content: e.content, initiator: e.initiator })),
      names,
      votes,
      diaryRoomStatements: drStatements,
      publicStatements,
    });
  }
}
