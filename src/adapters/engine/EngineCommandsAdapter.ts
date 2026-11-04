import type {
  EngineCommands, RecordInteractionReq, SurfaceReq, DiaryRoomReq, RecordImageBeatReq,
} from "../../ports/EngineCommands";
import type { EventStore } from "../../ports/EventStore";
import type { KnowledgeService } from "../../ports/KnowledgeService";
import type { RandomnessSource } from "../../ports/RandomnessSource";
import type { EntityId } from "../../domain/ids";
import { PLAYER } from "../../domain/ids";
import { SeededRandom } from "../random/SeededRandom";
import type { RelationshipModel, InteractionType } from "../../engine/relationships";
import {
  foldHiddenImpact, foldGenerativeConsequence, foldThirdPartyConsequence, foldPlayerReciprocal,
  NO_FATIGUE, type FatigueValence,
} from "../../engine/consequence";
import { rollOverhears } from "../../engine/presence";
import { PRESENCE } from "../../engine/presenceConstants";
import { isPrivateRoom, zonesSameEarshot, type Occupancy, type Zone } from "../../domain/house";
import { StaleBeatError, EngineRefusal } from "../../domain/errors";
import { IMAGE_BUDGET } from "../../engine/imageConstants";
import { computeExchangeAccounting, type ExchangeAccounting } from "../../engine/producerRead";

const INTERACTION_KINDS: ReadonlySet<string> = new Set<InteractionType>([
  "alliance", "gossip", "conflict", "bonding", "strategy", "showmance", "betrayal",
]);

/**
 * Engine-side implementation of the Vault-free command port. It may touch the
 * core to decide but returns only Vault-free results. This lives on the ENGINE
 * side; the MCP server depends on the `EngineCommands` interface, not on this
 * class. (E20: the caller-supplied-stats `resolveCompetition` seam is GONE —
 * `runCompetition` on the session is the single competition authority.)
 *
 * With a relationship model wired in (0023), `recordInteraction` is no longer a
 * no-op log: a happening with a proposed `kind` folds its HIDDEN impact into the
 * layer (how the others feel about the initiator) — invisible to the player.
 */
/** Cap the hidden folds a single recorded interaction may apply, so a caller can't flood the layer (B39). */
const MAX_FOLDS_PER_INTERACTION = 12;

/**
 * E21: the per-BEAT, per-directed-edge fold budget. The per-call cap alone let a caller pump one
 * edge without bound by repeating identical calls within a single game beat; within one beat
 * window (one resolved season beat to the next), at most this many folds may land on any single
 * `witness → initiator` edge — further identical calls still record their events (the scene
 * happened) but move nothing. The budget re-opens when the loop advances to the next beat.
 */
const MAX_FOLDS_PER_PAIR_PER_BEAT = 3;

export class EngineCommandsAdapter implements EngineCommands {
  /** Save-on-mutation hook (0030); the registry wires it to persist the user's snapshot. */
  private onPersist?: () => void;
  /** The living houseguests an interaction may name (B39); when unset, validation is skipped (standalone). */
  private livingProvider?: () => Iterable<EntityId>;
  /** Phase 2 — where a recorded scene's LLM-proposed felt duration (hours, clamped) is handed to the session
   *  to advance the day clock on the next per-turn tick. Unwired ⇒ inert (standalone / no clock). */
  /** The live occupancy ground truth (0049); when unset, scenes are placeless (standalone — prior behavior). */
  private presenceProvider?: () => Occupancy | null;
  /**
   * ADR 0006 — who is still AWAKE right now (`null` ⇒ the clock is off ⇒ everyone is up). A houseguest who
   * has turned in for the night has left the floor, so they neither witness nor overhear a player scene —
   * the same rule the player's own `whereabouts` view and the off-screen society already apply. Unwired ⇒
   * everyone is up ⇒ byte-identical to the prior behavior.
   */
  private awakeProvider?: () => ReadonlySet<EntityId> | null;
  private sceneMemorySink?: (holders: readonly EntityId[], kind: string) => void;
  private assuranceSink?: (a: { from: EntityId; to: EntityId; kind: "safe" | "vote" | "loyal"; sincerity: number; source: "player" | "npc" }) => void;
  /**
   * The live SUB-ZONE of a houseguest in a zoned big room (0077 Phase 2, OPT-IN). When wired, co-presence
   * witnessing is zone-scoped: a bystander in the SAME room but a DIFFERENT, out-of-earshot zone (the
   * far end of the backyard) is NOT auto-added as a witness — two groups can share a big room without
   * each overhearing the other. UNWIRED ⇒ every same-room occupant witnesses, exactly as the pre-0077
   * build (back-compatible). Pure read-side; never a new rng draw, so calibration is untouched.
   */
  private zoneProvider?: (id: EntityId) => Zone | undefined;
  /**
   * L27: index a recorded social scene into a houseguest's SEMANTIC recall memory (0024). Every
   * houseguest who was in a scene remembers its SUMMARY, so later narrative is built from the STORE
   * recalled (ADR 0003), never the chat window. Unset = standalone (no recall index — prior behavior).
   */
  private soulMemo?: (hg: EntityId, content: string) => void;
  /**
   * Phase 2 of "the player can play offense" (0085 follow-on) — invoked with (target, holder) for each
   * LANDED evict-shaped third-party pitch the PLAYER makes, so the session can fold it into the
   * player's own persistent campaign. Unset = standalone (no campaign effect — prior behavior).
   */
  private playerCampaignFold?: (target: EntityId, holder: EntityId) => void;
  /**
   * #1419 — the scene INITIATOR's ASYMMETRIC social-fatigue valence (the player-side mirror of the
   * off-screen fold): a tired initiator's WARMING folds land softer, their SOURING folds cut deeper.
   * Wired from the session's rest deficit; unset / rested / clock-off ⇒ `NO_FATIGUE` ⇒ byte-identical.
   */
  private fatigueValence?: (id: EntityId) => FatigueValence;
  /**
   * #1318 — invoked with the NPC partners of each recorded player↔NPC scene, so the session can register
   * them as genuine premiere HOT reads (the asymmetric first-power gate unlocks on real engagement, not on
   * a name merely heard). The 0055 auto-record belt guarantees an engaged premiere turn is recorded even
   * when the model skips the tool, making this the RELIABLE hot-read signal. Fired unconditionally on every
   * recorded scene; the session no-ops it outside the premiere. Unset = standalone (no premiere effect).
   */
  private playerReadSink?: (npcIds: EntityId[]) => void;
  /**
   * #1792 — invoked with ExchangeAccounting after a substantive recordInteraction,
   * so the session can stash the producer-read beat for the next moment prompt.
   * Unwired (flag OFF / standalone) ⇒ nothing computed or appended.
   */
  private producerReadSink?: (acc: ExchangeAccounting) => void;
  /**
   * 0065 Part A — the compare-and-swap stale-write guard for this command port. The authoritative
   * monotonic `beatSeq` lives on the session adapter (it owns the snapshot it is persisted in); the
   * registry wires these so this adapter can READ the current counter + the Vault-free current board
   * to compose the typed `stale-beat` refusal. Unset (standalone) ⇒ the guard is skipped (a missing
   * `expectedBeatSeq` is always opt-out anyway — byte-identical to today).
   */
  private beatSeqProvider?: () => number;
  private boardProvider?: () => unknown;
  /** E21: the beat window the fold budget counts within, plus the per-edge tallies inside it. */
  private foldBeatKey = "";
  private readonly foldCounts = new Map<string, number>();
  /**
   * IMG-NEW-1: the image-generation budget tallies (`IMAGE_BUDGET`). Generation is the most
   * expensive lever, so a per-TURN (beat-window) and per-WEEK ceiling bounds the in-game re-shoot
   * paths (facet re-shoot, manual backfill, the studio's "regenerate"). The season-start move-in
   * portrait set is EXEMPT (`moveInPortraitExempt`) — detected structurally as the FIRST image for a
   * houseguest, so the bounded one-time cast shoot never trips the cap while every RE-generation of an
   * already-portrayed houseguest counts. Keyed like `foldCounts`: the count resets when the window
   * (beat / week) rolls over. Tallies are in-memory (a restart re-opens the budget — a restart is no
   * cheap abuse loop), but the EXEMPTION reads the persisted event log, so it stays correct across one.
   */
  private imageTurnKey = "";
  private imageTurnCount = 0;
  private imageWeekKey = "";
  private imageWeekCount = 0;
  /**
   * R3 (Part E latency tail) — an incremental cache for `currentBeatKey`. The window key is "the latest
   * recorded `season:` event id"; the log is APPEND-ONLY, so that latest id is MONOTONIC — it can only move
   * forward as new beats append, never backward. We cache the last answer + the event-count it was computed
   * at, and on the next call scan only the TAIL appended since (`eventsSince` — O(Δ)) backward for a fresh
   * `season:` beat; if the tail holds none, the cached key is still the latest. This replaces the per-
   * `recordInteraction` BACKWARD scan of the WHOLE log (which, between beats, walked every accumulated
   * interaction/gossip/confessional event — O(events), the season-length latency tail). `count()` is the
   * cache key (it only ever grows under append-only), so a miss is always a fresh, correct recompute.
   */
  private beatKeyCache: { atCount: number; key: string } | null = null;
  /**
   * A10 / #591 / R1c — the at-most-once idempotency ledger for `recordInteraction` (idempotencyKey →
   * eventId). See `RecordInteractionReq.idempotencyKey`: it makes the FE's stale-409 re-drive (the
   * single retry of #591 + the CON-11 deferred-fold queue) at-most-once AT THE ENGINE, not merely via
   * the fragile "the engine refuses BEFORE folding" CAS timing — because two concurrent turns draining
   * the SAME deferred fold each carry a valid, freshly-reconciled CAS token, so CAS alone cannot stop a
   * DOUBLE fold. Bounded LRU (the retry window is seconds; a few hundred keys is ample), in-memory
   * per-sandbox (cross-user isolation is structural — ONE adapter per user; a restart also drops the
   * FE's in-flight deferred queue, so there is nothing to dedup across one), and Vault-free (the key is
   * an opaque token, never secret state).
   */
  private static readonly RECORD_IDEMPOTENCY_MAX = 256;
  private readonly recordIdempotency = new Map<string, string>();

  constructor(
    private readonly events: EventStore,
    private readonly knowledge: KnowledgeService,
    private readonly rel?: RelationshipModel,
    private readonly rng: RandomnessSource = new SeededRandom(1),
  ) {}

  /** Wire a persistence callback invoked after every state-mutating command (0030). */
  setOnPersist(fn: () => void): void {
    this.onPersist = fn;
  }

  /** Wire the living-houseguest set so a recorded interaction can't name an evicted/unknown player (B39). */
  setLivingProvider(fn: () => Iterable<EntityId>): void {
    this.livingProvider = fn;
  }

  /** Wire the house occupancy (0049) so recorded scenes gain co-present witnesses + adjacent overhears. */
  setPresenceProvider(fn: () => Occupancy | null): void {
    this.presenceProvider = fn;
  }

  /** P4g - wire the NPC memory ledger so a recorded betrayal / conflict / kindness scene is remembered by the NPCs it touched. Unwired => inert. */
  setSceneMemorySink(fn: (holders: readonly EntityId[], kind: string) => void): void {
    this.sceneMemorySink = fn;
  }

  /** B4 - wire the assurance ledger so a recorded casual assurance is kept on the live state. Unwired => inert. */
  setAssuranceSink(fn: (a: { from: EntityId; to: EntityId; kind: "safe" | "vote" | "loyal"; sincerity: number; source: "player" | "npc" }) => void): void {
    this.assuranceSink = fn;
  }

  /** Wire the awake set (ADR 0006) so a houseguest who has turned in neither witnesses nor overhears a scene. */
  setAwakeProvider(fn: () => ReadonlySet<EntityId> | null): void {
    this.awakeProvider = fn;
  }

  /** Wire the live zone reader (0077) so co-presence witnessing is earshot-scoped within a big room. */
  setZoneProvider(fn: (id: EntityId) => Zone | undefined): void {
    this.zoneProvider = fn;
  }

  /** Wire the semantic-recall index (L27/0024) so a recorded social scene becomes recallable later. */
  setSoulMemo(fn: (hg: EntityId, content: string) => void): void {
    this.soulMemo = fn;
  }

  /**
   * Phase 2 of "the player can play offense" (0085 follow-on) — wire the session's own campaign fold
   * so a LANDED player pitch (never a backfired one) can grow the player's own persistent campaign,
   * mirroring `formCampaigns`/`advanceCampaign`/`campaignTilt`. Engine-owned magnitude + self-gated by
   * the campaign layer's own flag (see `GameSessionAdapter.foldPlayerCampaignMove`). Unwired ⇒ no-op
   * (byte-identical to before this phase).
   */
  setPlayerCampaignFold(fn: (target: EntityId, holder: EntityId) => void): void {
    this.playerCampaignFold = fn;
  }

  /**
   * #1419 — wire the initiator's social-fatigue valence (see the field doc). The registry routes it to
   * `GameSessionAdapter.socialFoldValence`, which returns `{1,1}` unless the master clock is running,
   * the social-fatigue extension is on, AND the initiator carries a rest deficit — so an unwired /
   * clock-off / rested game is byte-identical to the pre-#1419 fold.
   */
  setFatigueValence(fn: (id: EntityId) => FatigueValence): void {
    this.fatigueValence = fn;
  }

  /**
   * #1318 — wire the premiere hot-read sink (see the field doc). The registry routes it to
   * `GameSessionAdapter.notePremiereReads`; unwired (standalone) ⇒ no-op.
   */
  setPlayerReadSink(fn: (npcIds: EntityId[]) => void): void {
    this.playerReadSink = fn;
  }

  /**
   * #1792 — wire the producer-read sink so the session can stash the exchange-accounting beat.
   * Unwired (flag OFF / standalone) ⇒ nothing computed or appended.
   */
  setProducerReadSink(fn: (acc: ExchangeAccounting) => void): void {
    this.producerReadSink = fn;
  }

  /**
   * 0065 Part A — wire the session's monotonic `beatSeq` reader + the Vault-free board reader so this
   * command port can enforce the compare-and-swap stale-write guard (the counter is owned/persisted by
   * the session adapter). Standalone adapters that never wire these simply skip the guard.
   */
  setBeatSeqProvider(fn: () => number): void {
    this.beatSeqProvider = fn;
  }

  setBoardProvider(fn: () => unknown): void {
    this.boardProvider = fn;
  }

  /**
   * 0065 Part A — refuse a write computed against a superseded board BEFORE any mutation. A present
   * `expectedBeatSeq` that no longer matches the session's committed counter throws a typed
   * `stale-beat` conflict carrying the CURRENT counter + the Vault-free board (HTTP 409). Absent ⇒
   * opt-out (byte-identical to the pre-0065 path); unwired providers ⇒ skipped.
   */
  private guardBeatSeq(expected: number | undefined): void {
    if (expected === undefined || !this.beatSeqProvider) return;
    const current = this.beatSeqProvider();
    if (expected !== current) throw new StaleBeatError(current, this.boardProvider?.() ?? null);
  }

  recordInteraction(req: RecordInteractionReq): { eventId: string } {
    // A10 / #591 / R1c — AT-MOST-ONCE: a REPEAT idempotencyKey returns the prior eventId WITHOUT
    // re-recording or re-folding, so a concurrently re-driven fold (two windows draining the same
    // deferred-fold queue, or an ambiguous-response retry) can never double-apply. Checked BEFORE
    // guardBeatSeq so a duplicate is a no-op SUCCESS regardless of how far the board has since moved —
    // the reconcile / re-drive returns the prior eventId cleanly, never a spurious 409 the FE would
    // conservatively re-queue (which is precisely how the second fold lands under sustained concurrency).
    // This whole method is synchronous (no await), so Node serializes two concurrent calls: the first
    // fully records + stores its key before the second is dispatched, and the second short-circuits here.
    if (req.idempotencyKey !== undefined) {
      const prior = this.recordIdempotency.get(req.idempotencyKey);
      if (prior !== undefined) {
        this.rememberRecordIdempotent(req.idempotencyKey, prior); // refresh LRU recency
        return { eventId: prior };
      }
    }
    // #1792 — snapshot the player's knowledge BEFORE the interaction commits,
    // so the post-commit diff can detect what the player gained.
    const beforeIds = new Set(this.knowledge.knownTo(PLAYER).map((f) => f.factId ?? f.id));
    // 0065 Part A — refuse a scene computed against a superseded board BEFORE recording/folding.
    this.guardBeatSeq(req.expectedBeatSeq);
    // Validated references (B39/audit A4): an interaction may only name LIVING houseguests — never an
    // evicted or invented one. The player is always living. Skipped when no roster is wired (standalone).
    // BE-102: `living` is also reused BELOW to filter `toward` / the consequence descriptor's targets —
    // those fields used to bypass this check entirely, letting a caller fold a relationship move onto an
    // evicted juror (or an invented id) with no scene, no witness, no in-game pathway. Since jurors'
    // relationship-derived reads feed the deterministic jury vote (I2/I4), that was a real side-channel
    // for tilting jury sentiment. Unlike `initiator`/`witnessSet` (refused outright, before anything is
    // recorded), a bad `toward`/edge target is silently DROPPED rather than thrown — the event itself may
    // already be a legitimate scene; only the out-of-bounds fold target is refused.
    const living = this.livingProvider ? new Set<EntityId>([PLAYER, ...this.livingProvider()]) : null;
    if (living) {
      for (const id of [req.initiator, ...req.witnessSet]) {
        if (!living.has(id)) throw new Error(`recordInteraction names a non-living houseguest: ${id}`);
      }
    }
    const isLiving = (id: EntityId): boolean => !living || living.has(id);
    // E21: this is the PLAYER channel's recording seam — it may only record scenes the player is
    // part of. The player initiating counts (they are in the scene; their seat is made explicit).
    // A witness set excluding the player would mint an off-screen "ground truth" indistinguishable
    // from the engine's own hidden scenes; off-screen life is the ENGINE's to mint (0038), never a
    // caller's. Refused outright — the Vault's hidden layer cannot be written from this channel.
    // Presence grounds the scene (0049): everyone in the initiator's ROOM is a witness — being in the
    // room means you saw it (co-presence ⇒ witness; ADR 0003 §8). Read the live occupancy UP FRONT: it
    // grounds BOTH the BL-014 reconciliation of caller-named witnesses (immediately below) AND the
    // co-presence expansion (further down). Placeless (no provider / initiator unplaced) keeps prior behavior.
    const occupancy = this.presenceProvider?.() ?? null;
    const room = occupancy?.get(req.initiator);
    // ADR 0006: a houseguest who has turned in for the night is off the floor — they neither witness nor
    // overhear the scene, even if presence still seats them in a room (the player's `whereabouts` already
    // hides them). Never the player or the initiator. `null` (clock off / unwired) ⇒ identity ⇒ byte-identical.
    const awake = this.awakeProvider?.() ?? null;
    const isUp = (id: EntityId): boolean => !awake || id === PLAYER || id === req.initiator || awake.has(id);
    const upOccupancy: Occupancy | null =
      occupancy && awake ? new Map([...occupancy].filter(([id]) => isUp(id))) : occupancy;
    // BL-014 — CO-PRESENCE RECONCILIATION. The model / FE belts (`_auto_record_scene`, the E22 fallback)
    // can name a `withIds` participant whom the engine's OWN occupancy (presenceProvider → session
    // occupancy → the live presence map) places in a DIFFERENT room — a PHANTOM co-presence. If recorded,
    // engine truth turns internally inconsistent (the EventStore says they witnessed a scene presence says
    // they weren't in), and that contradiction is re-injected on every recall + relationship fold — a
    // non-degradation breach (mandate #4): don't PERSIST corruption. So when the scene is GROUNDED
    // (occupancy known AND the initiator HAS a room) drop any caller-named NON-PLAYER witness the occupancy
    // POSITIVELY places elsewhere, BEFORE the witness set / the directed relationship fold / the premiere
    // hot-read read it. NEVER the PLAYER (their knowledge is the game) nor the INITIATOR (they own the
    // scene). Fails OPEN — no provider / placeless scene / unplaced initiator, or a witness the occupancy
    // doesn't place at all ⇒ keep them, so a presence hiccup can never zero the 0055 consequence-recording
    // safety net. Same room = co-present at ANY zone: zone still governs bystander EARSHOT (the co-presence
    // pass + `rollOverhears` below), never a NAMED participant's legality. This runs ENGINE-SIDE on the
    // engine's OWN committed occupancy in one atomic snapshot, so it is beatSeq-ordered by construction and
    // cannot race the FE's one-turn seating-freeze (a render-lag projection, not engine truth) — the exact
    // reason the earlier FE-side attempt fought the spine and was dropped from #1721.
    const grounded = occupancy !== null && room !== undefined;
    const namedWitnesses = grounded
      ? req.witnessSet.filter((id) => {
          if (id === PLAYER || id === req.initiator) return true; // never drop the player or the initiator
          const where = occupancy!.get(id);
          return where === undefined || where === room; // keep unless POSITIVELY placed in another room
        })
      : req.witnessSet;
    const awakeNamed = awake ? namedWitnesses.filter(isUp) : namedWitnesses; // a named sleeper is a phantom witness too
    const witnessSet = [...awakeNamed];
    if (req.initiator === PLAYER && !witnessSet.includes(PLAYER)) witnessSet.push(PLAYER);
    if (!witnessSet.includes(PLAYER)) {
      throw new Error("recordInteraction is player-witnessed only: the witness set must include the player (off-screen scenes are the engine's to mint)");
    }
    // 0077 (PO ruling #791): the scene's earshot zone is the initiator's. A same-room bystander becomes
    // a FULL CO-WITNESS only when they share the SAME zone — an ADJACENT zone is NOT full earshot (it is
    // overhear-eligible only; handled below by `rollOverhears`), and a FAR zone (workout corner vs.
    // poolside) hears nothing. With no zone provider wired, both zones read `undefined`,
    // `zonesSameEarshot` is always true, and every same-room occupant witnesses, byte-identical to pre-0077.
    const sceneZone = occupancy && room ? this.zoneProvider?.(req.initiator) : undefined;
    if (upOccupancy && room) {
      for (const [id, where] of upOccupancy) {
        if (where !== room || witnessSet.includes(id)) continue;
        if (!zonesSameEarshot(room, sceneZone, this.zoneProvider?.(id))) continue; // only same-zone co-presence witnesses in full
        witnessSet.push(id);
      }
    }
    // Derive the id + ts from the store's current size (B40/audit C2): monotonic and restart-safe —
    // after a restore the count resumes high, so a post-restart interaction never collides with a
    // pre-restart one (the old `++this.seq` restarted at 0, minting duplicate ids).
    const n = this.events.count();
    const eventId = `evt:mcp:${n}`;
    this.events.record({
      id: eventId, ts: n, type: "conversation",
      initiator: req.initiator, witnessSet,
      hidden: !witnessSet.includes(PLAYER), content: req.content,
    });
    // #1318 — a recorded player↔NPC scene is a GENUINE premiere hot read. Feed the reconciled
    // caller-named partners (`namedWitnesses` + initiator, minus the player) — NOT the presence-expanded
    // set — so a mere same-room bystander added by co-presence above is not miscounted as a read; the
    // player must actually be in a scene WITH the houseguest. BL-014: `namedWitnesses` has already dropped
    // any phantom (different-room) witness, so a hot read can never form off a name the engine's own
    // occupancy places elsewhere. The session no-ops this outside the premiere, so it is free every other
    // turn. This is the reliable engagement signal that lets first power become reachable.
    if (this.playerReadSink) {
      const partners = new Set<EntityId>(namedWitnesses);
      partners.add(req.initiator);
      partners.delete(PLAYER);
      const reads = [...partners].filter(isLiving);
      if (reads.length) this.playerReadSink(reads);
    }
    // Adjacency overhears (0049): occupants of the rooms NEXT DOOR may catch a piece of the scene —
    // an NPC overhearing the player's conversation, exactly as the player overhears NPCs. Gated,
    // recorded, traceable (`overheard:<eventId>`), partial and lower-confidence.
    if (occupancy && room) {
      rollOverhears({
        eventId, room, content: req.content, participants: witnessSet,
        occupancy: upOccupancy ?? occupancy, knowledge: this.knowledge, rng: this.rng,
        // 0077: a scene behind a closed door is harder to overhear. Player channel only — its own
        // isolated `commands:` rng stream — so the off-screen society/calibration spine is untouched.
        muffle: isPrivateRoom(room) ? PRESENCE.doorMuffle : 1,
        // 0077 (PO ruling #791): a SAME-ROOM ADJACENT-zone bystander (the patio next to the pool) is NOT
        // a full witness above — they instead become overhear-eligible here, catching the same rare,
        // partial, lower-confidence fragment an adjacent ROOM does. Same zone = witness (already in the
        // set above); far zone = nothing. Zone reads are the live zone provider; unwired ⇒ no zoned
        // listeners ⇒ byte-identical to the pre-ruling adjacent-room-only overhear path.
        sceneZone, zoneOf: this.zoneProvider,
      });
    }
    // Consequence (0023): the initiator's action moves how the OTHERS feel about them — a real,
    // recorded, HIDDEN shift (the engine owns the magnitude; the player never sees the numbers).
    // ONE fold implementation (B59): shared with the 0023 ConsequenceEngine; bounded per call (B39)
    // AND per beat per edge (E21) — repeating an identical call can't pump an edge without bound.
    //
    // Two paths, both engine-owned magnitude (anti-sycophancy #3):
    //  • The generative path (ADR 0005): when a `consequence` descriptor names per-edge directions,
    //    those PARTNER edges fold by their scene-chosen direction/emphasis (the LLM reads the scene;
    //    the engine still sets the amount). A novel move that fits NO enum still folds here — it must
    //    never evaporate (ADR 0005 principle #4). Any `kind` then runs the bystander pass over the
    //    witnesses the descriptor did NOT name, so the 7-way tag stays the FLOOR, never the ceiling.
    //  • The `kind`-only floor: with NO descriptor, this is BYTE-IDENTICAL to the prior behavior.
    // BE-102: drop any edge naming a non-living `toward` BEFORE it ever reaches the fold — a caller
    // could otherwise move an evicted juror's (or an invented id's) hidden opinion of the initiator
    // with no scene, no witness, no in-game pathway, silently tilting the deterministic jury read.
    // #1419 — the initiator's ASYMMETRIC fatigue valence (a tired actor sways WARMING folds less and
    // SOURING folds more). `NO_FATIGUE` unless the master clock is running, social fatigue is on, AND the
    // initiator carries a rest deficit — so a clock-off / rested game is byte-identical. Applies to the
    // partner / generative / third-party folds (the actor's outgoing sway), NOT the reciprocal player→NPC
    // read (the player's own feeling) or a bystander's own-belief observation.
    const fatigue: FatigueValence = this.fatigueValence?.(req.initiator) ?? NO_FATIGUE;
    const genEdges = req.consequence?.edges?.filter((e) => isLiving(e.toward));
    if (this.rel && (genEdges?.length || (req.kind && INTERACTION_KINDS.has(req.kind)))) {
      this.rollBeatWindow();
      let named: Set<EntityId>;
      if (genEdges?.length) {
        // The descriptor drives the partner folds — each named edge spends one unit of the per-beat
        // per-edge budget (E21) exactly as a `kind` partner would. (Phase 3/SG-2 scope note: the
        // reciprocal player-channel fold below is wired only onto the `kind`-only floor branch's
        // partners — a per-EDGE `direction` here has no single engine `kind` to reciprocate with,
        // so a generative descriptor's own edges are left for a future pass.)
        named = foldGenerativeConsequence(
          this.rel, this.rng, req.initiator, genEdges,
          (toward) => toward !== req.initiator && this.spendFoldBudget(toward, req.initiator),
          fatigue,
        );
        // If a `kind` ALSO rides along, it observes the room MINUS the descriptor's named edges (the
        // tag is the floor): co-present witnesses not named by the descriptor react by their own
        // beliefs. A private generative bond must never bond the whole room (audit 2026-06-18).
        if (req.kind && INTERACTION_KINDS.has(req.kind)) {
          const bystanders = witnessSet.filter(
            (w) => w !== req.initiator && !named.has(w) && this.spendFoldBudget(w, req.initiator),
          );
          foldHiddenImpact(this.rel, this.rng, req.initiator, witnessSet, req.kind as InteractionType,
            [], MAX_FOLDS_PER_INTERACTION, bystanders, fatigue);
        }
      } else {
        // PARTNERS — only those the initiator actually ENGAGED (the caller-named witnesses, or an
        // explicit `toward`) take the full directed fold. Presence-grounding adds co-present
        // bystanders to the witness set, but a private bond must never bond the whole room (audit
        // 2026-06-18): bystanders only OBSERVE, reacting by their own beliefs (foldHiddenImpact).
        // BE-102: same living-only guard for the flat `toward` field — it named a target directly,
        // bypassing the witnessSet/presence liveness that grounds every other targeting mechanism.
        // BL-014: when the partners come from the witness set (no explicit `toward`), use the RECONCILED
        // `namedWitnesses` — a phantom different-room witness must not take a directed relationship fold
        // (that is the very contradiction we refuse to persist). `toward` is a deliberate explicit
        // override with its own liveness guard and never enters the recorded witness set, so it is left as-is.
        const partnerNames = (req.toward ? req.toward.filter(isLiving) : namedWitnesses.filter((w) => w !== req.initiator));
        const namedSet = new Set(partnerNames);
        const partners = partnerNames.filter((o) => o !== req.initiator && this.spendFoldBudget(o, req.initiator));
        const bystanders = witnessSet.filter(
          (w) => w !== req.initiator && !namedSet.has(w) && this.spendFoldBudget(w, req.initiator),
        );
        foldHiddenImpact(this.rel, this.rng, req.initiator, witnessSet, req.kind as InteractionType,
          partners, MAX_FOLDS_PER_INTERACTION, bystanders, fatigue);
        // Phase 3 (SG-2, the closed-set relationship layer): a PLAYER-initiated scene ALSO
        // reciprocates a bounded share of this SAME kind impact onto the player's OWN edge toward
        // each partner they just engaged — see `foldPlayerReciprocal`. No-op for any other
        // initiator, and spends no new budget (`partners` is already budget-cleared above).
        foldPlayerReciprocal(this.rel, this.rng, req.initiator, partners, req.kind as InteractionType);
      }
    }
    // THIRD-PARTY consequence (Phase 1 of "the player can play offense" — layered on ADR 0005): a
    // scene can ALSO propose that a WITNESSED houseguest's opinion of a THIRD PARTY moves — "I pulled
    // Lorenzo aside and floated that Maeve is the real threat." Independent of the `genEdges`/`kind`
    // block above (a scene may carry both a self-edge and a third-party pitch). Witness-gated (I3):
    // `foldThirdPartyConsequence` silently drops any entry naming a holder NOT in `witnessSet` — a
    // read can only form from what was actually witnessed, so this can never mint an off-screen edge
    // move from the player channel. Engine-owned magnitude + a real backfire path (anti-sycophancy
    // #3/I2) live in `foldThirdPartyConsequence` itself. Rides the SAME per-beat-per-edge anti-pump
    // budget (E21), keyed `holder->about` instead of `holder->initiator`.
    // BE-102: `holder` is already witness-gated below (foldThirdPartyConsequence), and every witness
    // is living by construction — but `about` (the third party being pitched against) is NOT
    // witness-gated, so an invented/evicted id there was a second, unguarded way to plant a hidden
    // opinion on a juror. Drop any entry naming a non-living `about` (or, defense-in-depth, `holder`).
    const aboutEdges = req.consequence?.aboutEdges?.filter((e) => isLiving(e.holder) && isLiving(e.about));
    if (this.rel && aboutEdges?.length) {
      this.rollBeatWindow();
      const moved = foldThirdPartyConsequence(
        this.rel, this.rng, req.initiator, witnessSet, aboutEdges,
        (holder, about) => this.spendFoldBudget(holder, about),
        fatigue,
      );
      // Phase 2 of "the player can play offense" (0085 follow-on): an evict-shaped pitch ("more-
      // threatened") FROM THE PLAYER that actually LANDED (never a backfired one — `moved` only
      // contains holders whose edge really moved) feeds the player's own persistent campaign, so
      // sustained lobbying can tilt the eventual vote exactly as a sustained NPC campaign does. Never
      // fires for an NPC-initiated scene (this channel is the player's own offense, not a proxy for
      // one). Self-gated downstream by the campaign layer's own on/off flag.
      if (this.playerCampaignFold && req.initiator === PLAYER) {
        for (const e of aboutEdges) {
          if (e.direction === "more-threatened" && moved.has(e.holder)) this.playerCampaignFold(e.about, e.holder);
        }
      }
    }
    // L27: index the scene's SUMMARY into each houseguest's semantic recall memory (0024) — every
    // houseguest who was in it remembers it, so later story/narrative is built from the STORE recalled
    // (ADR 0003), never the chat window. The player's own knowledge already lives in the event record.
    if (this.soulMemo) {
      for (const w of witnessSet) if (w !== PLAYER) this.soulMemo(w, req.content);
    }
    // ADR 0005: the descriptor's `rationale` is OPEN-SET content (the LLM's reading of WHY the scene
    // mattered). It is RECORDED — a separate player-witnessed event so the scene's own `content` stays
    // byte-equal (lossless) — and NEVER scored into any magnitude (no fold reads it). Recording it
    // makes the generative reasoning recallable; it just never moves a hidden number.
    const rationale = req.consequence?.rationale;
    if (rationale && rationale.length) {
      const rn = this.events.count();
      this.events.record({
        id: `evt:mcp:${rn}`, ts: rn, type: "consequence-rationale",
        initiator: req.initiator, witnessSet: [...witnessSet],
        hidden: !witnessSet.includes(PLAYER), content: rationale,
      });
      if (this.soulMemo) for (const w of witnessSet) if (w !== PLAYER) this.soulMemo(w, rationale);
    }
    // #1792 — Producer Read: compute ExchangeAccounting and fire the sink BEFORE persist,
    // so the pending accounting survives the commit alongside the event. Only fires for
    // substantive interactions (matching the same guard the consequence block uses).
    // Unwired sink ⇒ nothing computed (flag OFF ⇒ byte-identical).
    if (this.producerReadSink && req.kind && INTERACTION_KINDS.has(req.kind)) {
      this.producerReadSink(computeExchangeAccounting(
        { content: req.content, kind: req.kind },
        beforeIds,
        this.knowledge.knownTo(PLAYER),
      ));
    }
    // P4g: a betrayal / conflict / kindness scene is REMEMBERED by the NPCs it touched (0024 ledger) - bounded, deterministic, one write per recorded scene (this point is
    // reached once per recorded scene: an idempotent replay returned earlier). Inert unwired / writers off.
    if (this.sceneMemorySink && req.kind) {
      const touched = (req.toward ?? awakeNamed).filter((id) => id !== PLAYER); // the NAMED partners (not presence-expanded bystanders)
      if (touched.length > 0) this.sceneMemorySink(touched, req.kind);
    }
    // B4: a casual assurance rides the recorded scene (one per recorded scene per assured party; an idempotent replay returned earlier). Inert unwired / flag off.
    if (this.assuranceSink && req.assurance) {
      const from = req.assurance.from ?? req.initiator;
      const sincerity = typeof req.assurance.sincerity === "number" ? req.assurance.sincerity : 1;
      const tos = from === PLAYER ? awakeNamed.filter((id) => id !== PLAYER) : [PLAYER]; // the NAMED partners (not the presence-expanded bystanders)
      for (const to of tos) this.assuranceSink({ from, to, kind: req.assurance.kind, sincerity, source: from === PLAYER ? "player" : "npc" });
    }
    this.onPersist?.(); // durable save (0030): events + the hidden layer survive a restart
    // A10/#591 — record the at-most-once key ONLY after a clean commit. Placed AFTER onPersist so a
    // persist failure (which rolls the whole commit back, including this in-memory event) leaves no key
    // behind — a later retry then correctly re-attempts rather than short-circuiting to a rolled-back id.
    if (req.idempotencyKey !== undefined) this.rememberRecordIdempotent(req.idempotencyKey, eventId);
    // `req.feltMinutes` is accepted but no longer touches the clock (P4c: cost depends only on message count).
    return { eventId };
  }

  /** A10/#591 — remember a recordInteraction result under its idempotency key (bounded LRU; oldest evicts). */
  private rememberRecordIdempotent(key: string, eventId: string): void {
    this.recordIdempotency.delete(key);          // re-insert at the tail (insertion-ordered = LRU)
    this.recordIdempotency.set(key, eventId);
    while (this.recordIdempotency.size > EngineCommandsAdapter.RECORD_IDEMPOTENCY_MAX) {
      const oldest = this.recordIdempotency.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.recordIdempotency.delete(oldest);
    }
  }

  /**
   * E21: roll the fold-budget window forward if the loop has advanced. The window is keyed off the
   * most recent recorded season beat (`season:` event) — a new beat re-opens every edge's budget.
   */
  private rollBeatWindow(): void {
    const key = this.currentBeatKey();
    if (key !== this.foldBeatKey) {
      this.foldBeatKey = key;
      this.foldCounts.clear();
    }
  }

  /**
   * E21: take one unit of the current beat window's fold budget for the directed edge
   * `from → initiator`; false once that edge's budget for the beat is spent.
   */
  private spendFoldBudget(from: EntityId, initiator: EntityId): boolean {
    const pair = `${from}->${initiator}`;
    const spent = this.foldCounts.get(pair) ?? 0;
    if (spent >= MAX_FOLDS_PER_PAIR_PER_BEAT) return false;
    this.foldCounts.set(pair, spent + 1);
    return true;
  }

  /**
   * The current beat window: the latest recorded season beat's id (pre-season counts as one window).
   *
   * R3 — INCREMENTAL: the log is append-only, so the latest `season:` id is monotonic. We scan only the
   * tail appended since the last call (`eventsSince(atCount)` — O(Δ)); a tail with a fresh beat updates
   * the cache, an empty/beat-free tail reuses the cached key, and a count that hasn't moved is the
   * cached key verbatim. The result is byte-identical to the old whole-log backward scan: the old scan
   * returned the highest-index `season:` event's id (or `"pre-season"` if none ever recorded), and the
   * cache, being monotonic and seeded once from `"pre-season"`, holds exactly that. (`count()` is the
   * cache key; it only grows under append-only, so a stale cache is impossible — a miss recomputes.)
   */
  private currentBeatKey(): string {
    const count = this.events.count();
    if (this.beatKeyCache && this.beatKeyCache.atCount === count) return this.beatKeyCache.key;
    const from = this.beatKeyCache ? this.beatKeyCache.atCount : 0;
    let key = this.beatKeyCache?.key ?? "pre-season";
    const tail = this.events.eventsSince(from); // O(Δ): only the events appended since the last call
    for (let i = tail.length - 1; i >= 0; i--) {
      if (tail[i]!.id.startsWith("season:")) { key = tail[i]!.id; break; } // latest fresh beat in the tail
    }
    this.beatKeyCache = { atCount: count, key };
    return key;
  }

  surfaceInformationTo(req: SurfaceReq): { ok: true; surfaced: boolean } {
    // 0065 Part A — refuse a surfacing computed against a superseded board BEFORE anything anchors.
    this.guardBeatSeq(req.expectedBeatSeq);
    // Anchored ⇒ knowledge; unanchored ⇒ a suspicion (A4). Either way it persists (the prior bug: it
    // never called onPersist, so a surfaced fact was lost on restart — mandate #4).
    const fact = this.knowledge.surfaceInformationTo(req.entity, req.fact, req.pathway);
    this.onPersist?.();
    return { ok: true, surfaced: fact !== null };
  }

  diaryRoom(req: DiaryRoomReq): { recorded: true } {
    // OOC player knowledge with NO in-game pathway to any NPC (0013): the recorded event's
    // witness set is the player alone, and deriveNpcKnowledge filters the diary-room pathway —
    // so the house can never learn it. The player's strategy may inform the engine, never NPCs.
    this.knowledge.recordDiaryRoom(req.entry, req.subjectId);
    this.onPersist?.(); // durable save (0030): the player's DR is their persisted knowledge
    return { recorded: true };
  }

  recordImageBeat(req: RecordImageBeatReq): { eventId: string } {
    // BE-5: refuse an image beat computed against a superseded board BEFORE anything is recorded or the
    // budget is spent — the same guard every other mutating tool on this port already has.
    this.guardBeatSeq(req.expectedBeatSeq);
    // 0051: an image shown to the player in-character is a BEAT — recorded like any scene, so it
    // has consequence and memory ("recorded or it didn't happen"). Player-witnessed by construction
    // (the witness set is the player — they saw it); never hidden. No hidden-layer write: the image
    // is built only from the player's visible state, so showing it is the player's own knowledge.

    // IMG-NEW-1: enforce the generation budget (`IMAGE_BUDGET`). The season-start MOVE-IN portrait
    // (the FIRST image for a houseguest) is exempt — a bounded one-time cast cost; every RE-generation
    // of an already-portrayed houseguest is metered against the per-turn + per-week caps so a looping
    // model / button-masher / public-exposure abuser has an engine-side spend ceiling. Refused past the
    // cap with a typed `EngineRefusal` (HTTP 400) so the FE generation loop can stop re-shooting.
    if (!IMAGE_BUDGET.moveInPortraitExempt || this.hasPriorImageFor(req.houseguestId)) {
      const turnKey = this.currentBeatKey();
      if (turnKey !== this.imageTurnKey) { this.imageTurnKey = turnKey; this.imageTurnCount = 0; }
      const weekKey = String((this.boardProvider?.() as { week?: number } | undefined)?.week ?? "");
      if (weekKey !== this.imageWeekKey) { this.imageWeekKey = weekKey; this.imageWeekCount = 0; }
      if (this.imageTurnCount >= IMAGE_BUDGET.perTurnCap) {
        throw new EngineRefusal(`image budget exhausted for this turn (max ${IMAGE_BUDGET.perTurnCap} generations)`);
      }
      if (this.imageWeekCount >= IMAGE_BUDGET.perWeekCap) {
        throw new EngineRefusal(`image budget exhausted for this week (max ${IMAGE_BUDGET.perWeekCap} generations)`);
      }
      this.imageTurnCount += 1;
      this.imageWeekCount += 1;
    }

    // Monotonic, restart-safe id off the store size (same discipline as recordInteraction, B40).
    const n = this.events.count();
    const eventId = `evt:image:${n}`;
    this.events.record({
      id: eventId, ts: n, type: "image-shown",
      initiator: PLAYER, witnessSet: [PLAYER],
      hidden: false, content: `image shown to the player: ${req.houseguestId} (${req.imageRef})`,
    });
    this.onPersist?.(); // durable save (0030): the image beat survives a restart
    return { eventId };
  }

  /**
   * IMG-NEW-1 exemption: has this houseguest ALREADY had an image shown? The first image per
   * houseguest is the move-in/season-start portrait (exempt from the budget); a second or later one is
   * a metered RE-generation. Reads the persisted `image-shown` log (the same `content` `recordImageBeat`
   * writes), so the exemption stays correct across a restart even though the in-memory tallies reset.
   */
  private hasPriorImageFor(houseguestId: EntityId): boolean {
    const marker = `image shown to the player: ${houseguestId} (`;
    return this.events.query({ type: "image-shown" }).some((e) => e.content.startsWith(marker));
  }
}
