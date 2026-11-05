import type { KnowledgeService, BeliefInput } from "../../ports/KnowledgeService";
import type { EventStore } from "../../ports/EventStore";
import { PLAYER } from "../../domain/ids";
import type { EntityId } from "../../domain/ids";
import type { KnowledgeFact, Suspicion, KnowledgeSnapshot } from "../../domain/knowledge";
import { clamp01 } from "../../domain/num";

/**
 * C14: confidence is a [0,1] certainty — clamp at every write seam (a caller-supplied 50 or −3 must
 * never persist). PERSIST-2/BE-101: `Math.min`/`Math.max` pass NaN straight through, so a NaN
 * confidence would otherwise persist as NaN into a knowledge fact; guard NaN → 0. Finite inputs
 * (in range or out) clamp exactly as before.
 */

/**
 * A suspicion is a hunch, never near-certainty (audit C2): any confidence it carries is capped
 * well below knowledge-grade so a downgraded surfacing can't masquerade as an anchored fact.
 */
const SUSPICION_CONFIDENCE_CAP = 0.5;

/**
 * Content lineage (E9/C2/C3): is the CLAIMED content genuinely derived from the SOURCE content?
 * True only when, after normalization (the engine's overhear wrapper stripped, case/whitespace
 * folded), the claim IS the source or a real fragment of it. Anything anchored under this rule is
 * therefore a substring of something that actually happened — fabrication cannot pass. Tiny
 * fragments (< MIN_FRAGMENT chars) must match exactly, so a one-letter "claim" can't fish.
 */
const MIN_FRAGMENT = 4;
function normalizeContent(s: string): string {
  return s
    .replace(/^\(overheard, muffled\)\s*/i, "")
    .replace(/…\s*$/, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}
function contentDerivedFrom(claimed: string, source: string): boolean {
  const a = normalizeContent(claimed);
  const b = normalizeContent(source);
  if (!a || !b) return false;
  if (a === b) return true;
  return a.length >= MIN_FRAGMENT && b.includes(a);
}

export class InMemoryKnowledgeService implements KnowledgeService {
  private readonly knowledge = new Map<EntityId, KnowledgeFact[]>();
  private readonly suspicions = new Map<EntityId, Suspicion[]>();
  private seq = 0;
  private tick = 0;

  /**
   * Serialize the whole knowledge layer (B40/audit C2): per-entity knowledge + suspicions AND the
   * id/ts counters, so a restart resumes it (no lost facts, no duplicate ids). ENGINE-ONLY — only the
   * composition root (snapshot) calls this; never an outward surface.
   */
  serialize(): KnowledgeSnapshot {
    const knowledge: Record<EntityId, KnowledgeFact[]> = {};
    for (const [k, v] of this.knowledge) knowledge[k] = v.map((f) => ({ ...f }));
    const suspicions: Record<EntityId, Suspicion[]> = {};
    for (const [k, v] of this.suspicions) suspicions[k] = v.map((s) => ({ ...s }));
    return { knowledge, suspicions, seq: this.seq, tick: this.tick };
  }

  /** Rebuild the knowledge layer from a snapshot (B40) — resume, don't reset. */
  load(snap: KnowledgeSnapshot): void {
    this.knowledge.clear();
    this.suspicions.clear();
    for (const [k, v] of Object.entries(snap.knowledge)) this.knowledge.set(k, v.map((f) => ({ ...f })));
    for (const [k, v] of Object.entries(snap.suspicions)) this.suspicions.set(k, v.map((s) => ({ ...s })));
    this.seq = snap.seq;
    this.tick = snap.tick;
  }

  constructor(
    private readonly events: EventStore,
    private readonly clock: () => number = () => ++this.tick,
  ) {}

  knownTo(entity: EntityId): KnowledgeFact[] {
    return [...(this.knowledge.get(entity) ?? [])];
  }

  suspicionsOf(entity: EntityId): Suspicion[] {
    return [...(this.suspicions.get(entity) ?? [])];
  }

  addSuspicion(entity: EntityId, fact: { content: string; subject?: EntityId; confidence?: number }): Suspicion {
    const s: Suspicion = {
      id: `suspect:${++this.seq}`,
      content: fact.content,
      ts: this.clock(),
      ...(fact.subject !== undefined ? { subject: fact.subject } : {}),
      // C2/C14: a suspicion's certainty is clamped AND capped — it is a hunch, never knowledge-grade.
      ...(fact.confidence !== undefined
        ? { confidence: Math.min(clamp01(fact.confidence), SUSPICION_CONFIDENCE_CAP) }
        : {}),
    };
    const list = this.suspicions.get(entity) ?? [];
    list.push(s);
    this.suspicions.set(entity, list);
    return s;
  }

  surfaceInformationTo(
    entity: EntityId,
    fact: { content: string; subject?: EntityId; confidence?: number },
    pathway: string,
  ): KnowledgeFact | null {
    // Anti-sycophancy anchor (A4): a surfacing must trace to a REAL source. An unanchored "fact" —
    // the narrator inventing who said what — is downgraded to a SUSPICION, never knowledge.
    if (!this.pathwayAnchored(pathway, fact)) {
      this.addSuspicion(entity, fact);
      return null;
    }
    const ts = this.clock();
    const sourceEventId = `evt:surface:${++this.seq}`;
    const witnessSet: EntityId[] = [entity];
    this.events.record({
      id: sourceEventId, ts, type: "surfacing",
      initiator: entity, witnessSet, hidden: !witnessSet.includes(PLAYER),
      // Entity-specific content: when SEVERAL entities gain the same pathway (e.g. two rooms
      // overhear one scene, 0049), each surfacing is a distinct happening — a shared string would
      // make the player's visible copy textually identical to another NPC's hidden one and trip
      // the vault-leak checkpoint's substring sweep (0031) on a non-leak.
      content: `surfaced to ${entity} via ${pathway}`,
    });
    // A surfaced fact may carry reduced confidence (0049: an overhear is partial — heard through a
    // wall, not witnessed). Witnessed/told facts omit it (full confidence by default).
    return this.pushKnown(entity, {
      content: fact.content, pathway, sourceEventId, ts, subject: fact.subject,
      ...(fact.confidence !== undefined ? { confidence: fact.confidence } : {}),
    });
  }

  /**
   * Is the pathway anchored to a real source (A4), on CONTENT LINEAGE (audit E9/C2/C3)?
   *  - `told-by:<id>`     the claimed teller actually holds the fact — a held belief (its content
   *                       or its undistorted origin) the claim derives from, OR an event they
   *                       WITNESSED whose content the claim derives from (firsthand).
   *                       A subject-only match is NOT anchoring (C2): "the teller knows *something
   *                       about them*" must never launder an invented claim into knowledge.
   *  - `overheard:<id>`   the event exists AND the claim derives from THAT event's content (E9/C3
   *                       — the engine's `rollOverhears` always passes a strict fragment; a real
   *                       event id must not anchor unrelated invented content).
   * Anything else (an invented or sourceless pathway) is NOT anchored. Anchored content is by
   * construction a fragment of something real — the model cannot mint ground truth.
   */
  private pathwayAnchored(pathway: string, fact: { content: string; subject?: EntityId }): boolean {
    const told = /^told-by:(.+)$/.exec(pathway);
    if (told) {
      const teller = told[1]!;
      const holds = this.knownTo(teller).some(
        (k) =>
          contentDerivedFrom(fact.content, k.content) ||
          (k.originalContent !== undefined && contentDerivedFrom(fact.content, k.originalContent)),
      );
      if (holds) return true;
      // BE-6: a genuinely engine-internal full scan (any event the teller witnessed, of any type/
      // visibility) — the explicit `queryAll()` escape hatch, never bare `query()`.
      return this.events
        .queryAll()
        .some((e) => e.witnessSet.includes(teller) && contentDerivedFrom(fact.content, e.content));
    }
    const heard = /^overheard:(.+)$/.exec(pathway);
    if (heard) {
      const source = this.events.queryAll().find((e) => e.id === heard[1]);
      return source !== undefined && contentDerivedFrom(fact.content, source.content);
    }
    return false;
  }

  recordDiaryRoom(content: string, subjectId?: EntityId): KnowledgeFact {
    const ts = this.clock();
    const sourceEventId = `evt:dr:${++this.seq}`;
    this.events.record({
      id: sourceEventId, ts, type: "diary-room",
      initiator: PLAYER, witnessSet: [PLAYER], hidden: false,
      content: `[diary-room] ${content}`,
    });
    return this.pushKnown(PLAYER, { content, pathway: "diary-room", sourceEventId, ts, ...(subjectId !== undefined ? { subject: subjectId } : {}) });
  }

  seedBelief(entity: EntityId, fact: BeliefInput, pathway: string): KnowledgeFact {
    return this.pushKnown(entity, { ...fact, pathway, ts: this.clock() });
  }

  transmitGossip(from: EntityId, to: EntityId, fact: BeliefInput, pathway: string): KnowledgeFact {
    const ts = this.clock();
    const sourceEventId = `evt:gossip:${++this.seq}`;
    const witnessSet: EntityId[] = [from, to];
    // The retelling is its own traceable event; player-witnessed iff the listener is the player.
    // Recipient-specific content (B27b — the B64 lesson): two retellings of one rumor must never
    // mint textually identical hidden/visible twins, or the 0031 substring sweep false-fires.
    this.events.record({
      id: sourceEventId, ts, type: "gossip",
      initiator: from, witnessSet, hidden: !witnessSet.includes(PLAYER),
      content: `gossip ${pathway} reaches ${to}`,
    });
    return this.pushKnown(to, { ...fact, pathway, sourceEventId, ts });
  }

  private pushKnown(
    entity: EntityId,
    f: {
      content: string; pathway: string; ts: number; sourceEventId?: string; subject?: EntityId;
      factId?: string; source?: EntityId; confidence?: number; hops?: number;
      distortion?: number; originalContent?: string;
    },
  ): KnowledgeFact {
    const k: KnowledgeFact = {
      id: `know:${++this.seq}`,
      content: f.content,
      pathway: f.pathway,
      ts: f.ts,
      ...(f.sourceEventId !== undefined ? { sourceEventId: f.sourceEventId } : {}),
      ...(f.subject !== undefined ? { subject: f.subject } : {}),
      ...(f.factId !== undefined ? { factId: f.factId } : {}),
      ...(f.source !== undefined ? { source: f.source } : {}),
      // C14: every entry seam (surfacing, seeding, gossip) clamps certainty into [0,1].
      ...(f.confidence !== undefined ? { confidence: clamp01(f.confidence) } : {}),
      ...(f.hops !== undefined ? { hops: f.hops } : {}),
      ...(f.distortion !== undefined ? { distortion: f.distortion } : {}),
      ...(f.originalContent !== undefined ? { originalContent: f.originalContent } : {}),
    };
    const list = this.knowledge.get(entity) ?? [];
    list.push(k);
    this.knowledge.set(entity, list);
    return k;
  }
}
