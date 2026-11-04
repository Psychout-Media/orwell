import type { EntityId } from "../domain/ids";

/**
 * The CLOSED set of consequence DIRECTIONS a caller may propose (ADR 0005, the generative path).
 * This is NOT a new closed enum standing in for the open scene — it is the closed SIGNAL space the
 * relationship model has always had (trust/affinity/threat/alignment, `EdgeSignals`), exposed so the
 * LLM can pick WHICH signal(s) move and in WHICH direction per edge. The OPEN-set interpretation
 * (which signal, toward whom, why) rides the free-text `content` + `rationale`; the closed-set
 * authority (the AMOUNT) stays engine-owned. `reliability` is deliberately absent: it is EVIDENCE
 * (E54 — honored deals, protective votes), never a sentiment a single utterance proposes.
 */
export type ConsequenceDirection =
  | "warmer"
  | "cooler"
  | "more-trust"
  | "less-trust"
  | "more-threatened"
  | "less-threatened"
  | "more-aligned"
  | "less-aligned";

/** RELATIVE weight only — the engine maps this to a BOUNDED, CLAMPED multiplier on ITS OWN base. */
export type ConsequenceEmphasis = "slight" | "notable" | "strong";

/**
 * The generative consequence descriptor (ADR 0005 — "split authority by openness"). Proposed by the
 * caller/LLM as scene-grounded reading-comprehension of the player's OWN action: which directed edges
 * move, in which direction, with what RELATIVE emphasis, and why. It widens what the LLM may PROPOSE
 * (open-set interpretation) WITHOUT widening what it may MAGNITUDE (the engine owns the amount —
 * anti-sycophancy #3). No raw number ever crosses from the caller.
 *
 * IMPORTANT (ADR 0005 §"Interpretation is open; magnitude is closed"): the relationship SIGNAL space
 * is legitimately a small CLOSED set — `direction` names a member of it. That is fine. What must stay
 * OPEN is the *interpretation* of the scene, which lives in `content` + `rationale` (recorded
 * losslessly, never collapsed). The generative win is PER-EDGE, scene-chosen direction/targeting/
 * emphasis instead of one global 7-way `kind`.
 */
export interface ConsequenceDescriptor {
  /** Per-edge proposals: whose hidden feeling about the INITIATOR moves, and how. */
  edges?: Array<{
    /** Whose hidden opinion of the initiator moves (a living houseguest in the scene). */
    toward: EntityId;
    /** Which signal(s) move and their sign — a member of the closed `EdgeSignals` space. */
    direction: ConsequenceDirection;
    /** RELATIVE weight only (NOT a magnitude) → a bounded, clamped multiplier on the engine's base. */
    emphasis?: ConsequenceEmphasis;
  }>;
  /**
   * THIRD-PARTY proposals (Phase 1 of "the player can play offense"): `holder`'s hidden opinion of
   * `about` moves — the classic "I pulled Lorenzo aside and floated that Maeve is the bigger threat."
   * Honored ONLY when `holder` actually WITNESSED this scene (I3/Vault Wall — a belief can only form
   * from what was witnessed; an absent holder's entry is silently dropped, never minting an off-screen
   * read). The engine still owns the amount (anti-sycophancy #3): it trust-gates the fold against
   * `holder`'s read of the initiator and may FAIL or BACKFIRE (I2 — never an auto-success lever). See
   * `ThirdPartyConsequence` + `src/engine/consequence.ts`'s `foldThirdPartyConsequence`.
   */
  aboutEdges?: ThirdPartyConsequence[];
  /** Why, grounded in the scene — RECORDED (open-set content), NEVER scored into the magnitude. */
  rationale?: string;
}

/**
 * A per-edge THIRD-PARTY consequence PROPOSAL (Phase 1 of the player-offense work, layered on ADR
 * 0005). Unlike `edges` (whose opinion of the INITIATOR moves), this names a completely separate
 * directed edge: `holder`'s hidden opinion of `about`. The caller/LLM proposes WHICH edge moves, in
 * WHICH direction, with what RELATIVE emphasis — the engine still owns the amount, gates it on
 * `holder` having actually witnessed the scene, and may fail/backfire rather than auto-succeed.
 */
export interface ThirdPartyConsequence {
  /** Who the player/initiator is actually talking to — MUST be a witness of this scene (I3). */
  holder: EntityId;
  /** The third party whose standing with `holder` is being pitched (must differ from holder/initiator). */
  about: EntityId;
  /** Which signal(s) move and their sign — the SAME closed `EdgeSignals` space as `edges`. */
  direction: ConsequenceDirection;
  /** RELATIVE weight only (NOT a magnitude) → a bounded, clamped multiplier on the engine's base. */
  emphasis?: ConsequenceEmphasis;
}

/**
 * Vault-free command port (0009). Action tools cross the membrane through THIS
 * interface: the engine performs them (and may read the core/Vault internally to
 * decide), but every argument and return type here is Vault-free, so the outward
 * MCP server depends on this — never on the engine root or `VaultStore`.
 */
export interface RecordInteractionReq {
  initiator: EntityId;
  witnessSet: EntityId[];
  content: string;
  /**
   * Optional interaction nature (caller/LLM-PROPOSED): "bonding" | "betrayal" | "conflict" |
   * "strategy" | "alliance" | "gossip" | "showmance". When present, the engine folds the HIDDEN
   * relationship impact into the layer (0017/0023) — the magnitude is the engine's (anti-sycophancy).
   * `kind` is the FLOOR and DEFAULT (ADR 0005): with no `consequence` descriptor, the fold is
   * byte-identical to the legacy 7-way path.
   */
  kind?: string;
  /**
   * B4 (casual assurances, behind ORWELL_ASSURANCES, default OFF): this scene carried a cheap promise - "you're safe with me" (`safe`), "you have my vote" (`vote`), "I'm with you"
   * (`loyal`). Only a RECORDED assurance exists to the engine. `from` defaults to the initiator (the player assuring the others); name an NPC speaker to record THEIR assurance to the
   * player; `sincerity` (0..1, default 1) lets a strategic lie be low. The ENGINE later decides whether it is kept (self-interested, personality-scaled) - the model never does.
   */
  assurance?: { kind: "safe" | "vote" | "loyal"; from?: EntityId; sincerity?: number };
  /** Whose hidden opinion of the initiator moves (default: the other witnesses). */
  toward?: EntityId[];
  /**
   * Phase 2 (duration-based clock) — the LLM's proposal for how long THIS scene felt, in in-game MINUTES
   * (a quick word ~15–30, a chat ~60, a long strategy summit ~150). When supplied AND the in-game clock is
   * running, the engine advances the day's clock by this scene's bounded duration on the next per-turn tick
   * (instead of the flat per-conversation floor), so time tracks the play the player actually did. The
   * value is CLAMPED to a sane envelope (`feltHoursFromMinutes`) — the model proposes, the engine bounds
   * it (ADR 0005 for time). ABSENT ⇒ the flat floor ⇒ byte-identical; clock OFF ⇒ inert (the seeded sims).
   */
  feltMinutes?: number;
  /**
   * The OPTIONAL generative-consequence descriptor (ADR 0005). When supplied, it REFINES the fold's
   * targeting + per-edge direction (open-set interpretation of the scene) while `kind` may still seed
   * the engine's base magnitude. When ABSENT, behavior is byte-identical to the `kind`-only path.
   */
  consequence?: ConsequenceDescriptor;
  /**
   * Optional compare-and-swap token (0065 Part A): the `beatSeq` the caller computed this scene
   * against. When present and `!== current`, the recording is REFUSED with a typed `stale-beat`
   * conflict (HTTP 409, no event recorded, no fold). Absent ⇒ byte-identical to the pre-0065 path.
   */
  expectedBeatSeq?: number;
  /**
   * Optional at-most-once retry key (0065 Part B, extended to this port — A10 / #591 / R1c). The FE
   * re-drives a fold-bearing scene after a stale-409: the single retry of issue #591 PLUS the CON-11
   * deferred-fold queue. `expectedBeatSeq` (CAS-before-write) makes ONE retry safe — but under sustained
   * two-window concurrency two turns can drain the SAME deferred fold and re-drive it, and a 409 there is
   * AMBIGUOUS ("the peer already applied this" vs "the board moved on"), so the FE conservatively
   * re-queues it and it folds TWICE (the hidden relationship layer moves twice — a non-degradation /
   * anti-sycophancy break). CAS cannot close this: both re-drives carry a valid, freshly-reconciled
   * token. A stable caller-minted `idempotencyKey` does: a repeat key returns the prior `eventId` WITHOUT
   * re-recording or re-folding — at-most-once, exactly the discipline `advanceGame`/`submitDecision`
   * already use. Absent ⇒ byte-identical to the pre-key path (every call folds, as today).
   */
  idempotencyKey?: string;
}

export interface SurfaceReq {
  entity: EntityId;
  fact: { content: string };
  pathway: string;
  /**
   * Optional compare-and-swap token (0065 Part A): the `beatSeq` the caller computed this surfacing
   * against. When present and `!== current`, it is REFUSED with a typed `stale-beat` conflict (HTTP
   * 409, nothing surfaced). Absent ⇒ byte-identical to the pre-0065 path.
   */
  expectedBeatSeq?: number;
}

export interface DiaryRoomReq {
  /** The player's out-of-character confessional entry. */
  entry: string;
  /** Optional subject to tag this entry to a specific houseguest. */
  subjectId?: EntityId;
}

export interface RecordImageBeatReq {
  houseguestId: string;
  imageRef: string;
  /**
   * Optional compare-and-swap token (0065 Part A / BE-5): the `beatSeq` the caller computed this image
   * beat against. When present and `!== current`, it is REFUSED with a typed `stale-beat` conflict
   * (HTTP 409, no event recorded, no budget spent). Absent ⇒ byte-identical to the pre-BE-5 path — this
   * write-back was the one FE-driven mutating call on this port with no beatSeq guard at all, unlike
   * every other mutating tool (`recordInteraction`/`surfaceInformationTo`).
   */
  expectedBeatSeq?: number;
}

export interface EngineCommands {
  /**
   * Records the interaction + folds its hidden impact. Throws if it names a non-living houseguest
   * (B39) or if the witness set excludes the player (E21 — this is the player channel; off-screen
   * scenes are the engine's to mint). Folds are budgeted per beat per edge (E21).
   *
   * (E20: there is NO `resolveCompetition` on this port — a caller-supplied-stats resolver was a
   * seed-shopping second authority; the session's `runCompetition` over the LIVE house is the one.)
   */
  recordInteraction(req: RecordInteractionReq): { eventId: string };
  /** `surfaced:true` if anchored into knowledge; `false` if the pathway was unanchored ⇒ a suspicion (A4). */
  surfaceInformationTo(req: SurfaceReq): { ok: true; surfaced: boolean };
  /**
   * Record a player Diary-Room entry (0013): the player's OWN out-of-character knowledge,
   * tagged with NO in-game pathway to any NPC. It may inform the engine's read of player
   * strategy but NEVER reaches NPC behavior — no houseguest can ever learn it.
   */
  diaryRoom(req: DiaryRoomReq): { recorded: true };

  /** Record that an image was shown to the player in-character (0051) — a player-witnessed image-shown event. */
  recordImageBeat(req: RecordImageBeatReq): { eventId: string };
}
