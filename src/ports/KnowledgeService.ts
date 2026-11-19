import type { EntityId } from "../domain/ids";
import type { KnowledgeFact, Suspicion, KnowledgeSnapshot } from "../domain/knowledge";

/** A belief as it travels NPC-to-NPC: lineage + provenance + confidence + drift. */
export interface BeliefInput {
  content: string;
  factId: string;
  originalContent?: string;
  confidence?: number;
  source?: EntityId;
  hops?: number;
  distortion?: number;
  subject?: EntityId;
}

export interface KnowledgeService {
  /** Facts the entity may legitimately act on (witnessed-telling or surfaced). */
  knownTo(entity: EntityId): KnowledgeFact[];

  /** Hunches with no pathway. Never knowledge. */
  suspicionsOf(entity: EntityId): Suspicion[];

  /**
   * Surface a hidden fact to an entity through an in-game pathway. The pathway must be ANCHORED to a
   * real source on CONTENT LINEAGE (B39/audit A4 + E9/C2/C3): `told-by:<id>` where the claimed teller
   * actually holds content the claim derives from (they were told it OR witnessed it), or
   * `overheard:<eventId>` where that event exists AND the claim derives from ITS content (a strict
   * fragment, as the engine's overhear roll produces). If anchored, it records a traceable surfacing
   * event AND adds the fact to the entity's knowledge (returns the `KnowledgeFact`). If NOT anchored —
   * the narrator inventing a source, padding a real one, or citing an unrelated event — it is
   * **downgraded to a suspicion with capped confidence** (never knowledge) and returns `null`.
   * The model cannot mint ground truth.
   */
  surfaceInformationTo(
    entity: EntityId,
    fact: { content: string; subject?: EntityId; confidence?: number; /** ORW-688: the lineage this surfacing belongs to (so a record with a subject also has a lineage the secret consumers can count). Absent => lineage-less, as before. */ factId?: string },
    pathway: string,
  ): KnowledgeFact | null;

  /** Give an entity a suspicion (no pathway, never promoted to knowledge here). Confidence is capped. */
  addSuspicion(entity: EntityId, fact: { content: string; subject?: EntityId; confidence?: number }): Suspicion;

  /**
   * The player's Diary Room: player-level, OOC. Its content becomes the PLAYER's
   * own knowledge but has NO in-game pathway to any NPC.
   */
  recordDiaryRoom(content: string, subjectId?: EntityId): KnowledgeFact;

  /** Seed an origin belief on an entity (no telling event — they already knew it). */
  seedBelief(entity: EntityId, fact: BeliefInput, pathway: string): KnowledgeFact;

  /**
   * One retelling along the social graph: records the telling as its own event
   * (witnessed by teller + listener) and lodges the (possibly distorted) belief
   * in the listener's knowledge with its provenance and confidence.
   */
  transmitGossip(from: EntityId, to: EntityId, fact: BeliefInput, pathway: string): KnowledgeFact;

  /**
   * Serialize the whole knowledge layer (B40/audit C2): per-entity knowledge + suspicions PLUS the
   * id/ts counters, so a restart resumes it (no lost facts, no duplicate ids). Part of the port (E63)
   * so the durable-snapshot export goes THROUGH the seam — the composition root never hard-casts a
   * concrete adapter to reach it. ENGINE-ONLY in effect: only the composition root (snapshot) calls
   * it. Plain JSON — part of the durable `SessionSnapshot` contract.
   */
  serialize(): KnowledgeSnapshot;

  /** Rebuild the knowledge layer from a snapshot (B40) — resume, don't reset. The 0030 resume path. */
  load(snap: KnowledgeSnapshot): void;
}
