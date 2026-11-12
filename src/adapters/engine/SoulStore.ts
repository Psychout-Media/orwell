import type { EntityId } from "../../domain/ids";
import type { SoulProvider, Soul, Memory, SoulSection } from "../../ports/SoulProvider";
import { VectorDimMismatchError, type VectorIndex } from "../../ports/VectorIndex";
import { InMemoryVectorIndex } from "../inmemory/InMemoryVectorIndex";

/**
 * The inner-diary section classifier (feature 0024 Option B, PO ruling 2026-07-06). A pure,
 * deterministic function of the memory's own text, so a memory files under the SAME section every
 * time — including when a restore re-derives the whole soul from the persisted `soul.memory` mirror
 * (`rebuildSoulIndex`). Engine-only; never touches an outcome or crosses to the player.
 *
 * Order matters: an EMOTION reading wins over a strategic one ("betrayed — wary" is a feeling; "I'll
 * betray them at the vote" is a leaning), so the feeling probe runs first. Anything that is neither a
 * felt state nor a strategic lean is a plain remembered happening — the default, and the bulk.
 */
const FEELING_RE =
  /\b(feel|feels|felt|feeling|rattled|hurt|angry|furious|happy|glad|guarded|wary|betrayed|shaken|calm|anxious|relieved|relief|proud|bitter|numb|elated|crushed|excited|nervous|devastated|scared|afraid|hopeful|heartbroken|resentful|exposed|paranoid|comfortable|uneasy)\b/;
const LEANING_RE =
  /\b(trust|distrust|ally|allies|alliance|aligned|align|target|targets|threat|loyal|loyalty|vote|votes|voting|betray|betrays|side with|sides with|working with|work with|turn on|turning on|closer to|drifting|drift|lean|leans|leaning toward|against them|final two|f2|deal|deals|pact)\b/;

export function classifySoulSection(content: string): SoulSection {
  const t = content.toLowerCase();
  if (FEELING_RE.test(t)) return "feeling";
  if (LEANING_RE.test(t)) return "leaning";
  return "memory";
}

/** The fixed render order + human heading for each inner-diary section (0024 Option B). */
const SECTION_ORDER: ReadonlyArray<{ section: SoulSection; heading: string }> = [
  { section: "memory", heading: "## Memories" },
  { section: "leaning", heading: "## Leanings" },
  { section: "feeling", heading: "## Feelings" },
];

/**
 * Render the lightly-sectioned inner-diary markdown from the authoritative memory list (0024 Option
 * B). Memories keep their append order WITHIN each section; a section with no memories renders no
 * heading. Recomposed from `memories` on every write, so it is always a faithful projection of the
 * authoritative record — never a lossy running buffer.
 */
export function composeSectionedNarrative(memories: ReadonlyArray<Memory>): string {
  const blocks: string[] = [];
  for (const { section, heading } of SECTION_ORDER) {
    const lines = memories.filter((m) => m.section === section).map((m) => m.content);
    if (lines.length > 0) blocks.push([heading, ...lines].join("\n"));
  }
  return blocks.join("\n\n");
}

/**
 * ENGINE-ONLY soul store (feature 0024): per-houseguest dynamic Soul = a growing
 * markdown narrative + a per-houseguest vector index for SEMANTIC recall. Recall
 * runs over the FULL (hidden) soul engine-side; only pathway-filtered results ever
 * reach the player (0002). Holds Vault-side data — no outward module depends on it.
 *
 * `embed` is injected (the deterministic fake in tests; a real model at runtime).
 *
 * Lane G8 — a soul-write batch must let the event loop BREATHE. The real embedder
 * (ADR 0004) is a synchronous worker bridge: each `embed()` call blocks the Node
 * event loop for the inference. A bulk batch used to run every embed back-to-back
 * inside one synchronous call — pinning the loop for the whole batch, so `/health`
 * (and every concurrent request) stalled and the front-end reported a false outage.
 * The fix keeps BOTH contracts intact:
 *
 * - the AUTHORITATIVE soul (narrative + memories) still updates synchronously in
 *   `recordToSoul` — lossless, monotonic, snapshot-visible (0007/0030);
 * - each embed is still ONE synchronous call on the ADR 0004 seam — only the
 *   *spacing* changes: indexing is queued and drained one memory per macrotask
 *   (`setImmediate`), so the loop serves I/O between embed calls.
 *
 * Lane G12 — the breathing batch lane is SHARED process-wide, at the seam. G8's
 * queue/drain lived per instance: every SoulStore (one per user sandbox) ran its own
 * `setImmediate` chain, so N sandboxes flooding together — the boot preload restores
 * EVERY saved user (`composeRuntime`), several restores landing in one tick — put up
 * to N back-to-back embeds into a single check phase: stalls stacked to N × one
 * inference. The drain is now ONE module-wide lane, mirroring the one ONNX worker
 * that actually serves every sandbox (ADR 0004): the loop never carries more than a
 * single embed per macrotask NO MATTER how many sandboxes are bursting, and every
 * present or future burst site inherits the breathing by construction the moment it
 * calls `recordToSoul`:
 *
 *   - creation-time seeding (G8's original case — casting finalization, and the
 *     season-restart re-seeding through the one restart door, D1/R1);
 *   - `rebuildSoulIndex` replaying a whole season's arc on restore (0030), including
 *     the boot preload over every saved user;
 *   - the eviction-night / finale fold+confessional bursts and the per-turn
 *     off-screen tick (0040/0041 via `GameSessionAdapter`).
 *
 * Teardown hygiene (G12): when a sandbox is dropped or replaced (season reset,
 * rollback restore, LRU unload, a refused resume), `discardPending` drops ITS queued
 * index work — derived state for indexes about to be garbage — so a dead season's
 * backlog never delays a live one's drain or burns inference on the shared lane.
 *
 * Correctness: the vector index is DERIVED state. `recall` flushes any still-queued
 * memories for that houseguest (this store only) synchronously first, so a recall is
 * always complete — callers observe exactly the old semantics, just without the loop
 * pinned.
 *
 * PERSIST-1 / PERSIST-4 self-heal: `embed` may change WHICH provider it delegates to across the
 * life of one `SoulStore` (`engineRoot`'s embed closure now reads the live process-wide provider
 * on every call, so a sandbox built during the fastembed boot warm-up upgrades the moment warm-up
 * finishes, instead of being pinned to the deterministic fallback forever — the PERSIST-4 race). A
 * provider change means a houseguest's index can suddenly see a vector of a different dimension
 * than the one already indexed; `VectorIndex.upsert` is contractually required to THROW
 * `VectorDimMismatchError` rather than silently mix spaces (PERSIST-1). `indexOne` catches exactly
 * that error and self-heals: it discards the stale index and re-embeds the houseguest's WHOLE
 * memory history through the CURRENT embed function before retrying, so the index converges back
 * to one consistent space instead of ever holding two. This is a rare, one-time-per-transition
 * event (at most a couple of times per game), so the synchronous re-embed burst is an accepted
 * trade against the alternative — a permanently corrupted or permanently frozen index.
 */
export class SoulStore implements SoulProvider {
  // ── The ONE shared breathing lane (G8 spacing; G12 hoisted process-wide) ──────
  /** Memories recorded but not yet embedded into a (derived) vector index — ALL stores. */
  private static readonly pending: Array<{ store: SoulStore; hg: EntityId; mem: Memory }> = [];
  private static drainScheduled = false;

  /** Drain ONE queued embed per macrotask — process-wide — so /health and concurrent
   *  requests answer between embeds no matter how many sandboxes are bursting at once. */
  private static scheduleDrain(): void {
    if (SoulStore.drainScheduled || SoulStore.pending.length === 0) return;
    SoulStore.drainScheduled = true;
    setImmediate(() => {
      SoulStore.drainScheduled = false;
      const next = SoulStore.pending.shift();
      if (next) next.store.indexOne(next.hg, next.mem);
      SoulStore.scheduleDrain();
    });
  }

  /** Queued (not-yet-embedded) index entries across EVERY store — test/ops visibility. */
  static pendingTotal(): number {
    return SoulStore.pending.length;
  }

  private readonly souls = new Map<EntityId, Soul>();
  private readonly indexes = new Map<EntityId, VectorIndex>();
  private seq = 0;

  constructor(
    private readonly embed: (text: string) => number[],
    // PERSIST-7: `hg` is threaded through so a sqlite-backed factory can key its table on the
    // houseguest's stable id (durable across a restart); `freshStart` tells that same factory to
    // drop any stale on-disk state first when this is a dimension-mismatch self-heal rebuild rather
    // than an ordinary lazy-create/resume. The in-memory default ignores both — no behavior change.
    private readonly makeIndex: (hg?: EntityId, freshStart?: boolean) => VectorIndex = () => new InMemoryVectorIndex(),
  ) {}

  soulOf(hg: EntityId): Soul {
    let soul = this.souls.get(hg);
    if (!soul) { soul = { narrative: "", memories: [] }; this.souls.set(hg, soul); }
    return soul;
  }

  private indexFor(hg: EntityId): VectorIndex {
    let idx = this.indexes.get(hg);
    if (!idx) { idx = this.makeIndex(hg); this.indexes.set(hg, idx); }
    return idx;
  }

  recordToSoul(hg: EntityId, content: string, section?: SoulSection): Memory {
    const soul = this.soulOf(hg);
    const mem: Memory = {
      id: `mem:${hg}:${++this.seq}`,
      content,
      ts: this.seq,
      // 0024 Option B: file under the caller's explicit bucket, else classify from content.
      section: section ?? classifySoulSection(content),
    };
    soul.memories.push(mem);
    // Recompose the lightly-sectioned inner diary from the authoritative (append-only, never
    // thinned — 0007) memory list. Length grows monotonically with every record: each memory adds
    // its own line (and, for a section's first memory, a heading) — never removes one.
    soul.narrative = composeSectionedNarrative(soul.memories);
    // G8/G12: queue the (derived) vector indexing on the shared lane instead of embedding
    // inline — no soul-write burst, from any sandbox, ever pins the event loop.
    SoulStore.pending.push({ store: this, hg, mem });
    SoulStore.scheduleDrain();
    return mem;
  }

  /** This store's still-queued (not-yet-embedded) index entries — test/ops visibility. */
  pendingCount(): number {
    let n = 0;
    for (const p of SoulStore.pending) if (p.store === this) n++;
    return n;
  }

  /**
   * Drop this store's queued index work from the shared lane (G12) — called when the
   * owning sandbox is dropped or replaced. Derived state only: the authoritative soul
   * is untouched, and a restore re-derives every index (`rebuildSoulIndex`).
   */
  discardPending(): void {
    // Compact in place (no spread): `push(...keep)` overflows the call stack once the shared lane holds ~100k+ queued embeds (a long synchronous burst, e.g. a full season driven in one tick).
    const q = SoulStore.pending;
    let w = 0;
    for (let r = 0; r < q.length; r++) if (q[r]!.store !== this) q[w++] = q[r]!;
    q.length = w;
  }

  /** One synchronous embed+upsert (the ADR 0004 sync-per-call seam, unchanged). */
  private indexOne(hg: EntityId, mem: Memory): void {
    try {
      this.indexFor(hg).upsert(mem.id, this.embed(mem.content), { content: mem.content });
    } catch (e) {
      if (e instanceof VectorDimMismatchError) {
        // PERSIST-1/PERSIST-4: the embed provider changed space mid-life for this houseguest
        // (a fastembed warm-up upgrade or a mid-process degrade). Rebuild THIS houseguest's
        // index from the authoritative narrative memories in the NEW space, then retry once —
        // self-healing back to one consistent space instead of ever comparing across two.
        console.error(
          `[orwell] soul index for ${hg} hit a vector-space change (${e.message}); rebuilding this houseguest's index in the current space so recall never mixes dimensions`,
        );
        this.rebuildIndexFor(hg);
        try {
          this.indexFor(hg).upsert(mem.id, this.embed(mem.content), { content: mem.content });
        } catch (e2) {
          console.error(
            `[orwell] soul index upsert failed for ${hg} even after a rebuild: ${e2 instanceof Error ? e2.message : String(e2)}`,
          );
        }
      } else {
        // Vectors are derived state: a failed embed only degrades recall for this memory
        // (a restart re-derives every index); it must never crash the drain loop. Still
        // surfaced loudly (PERSIST-6) so an operator can see recall silently degrading.
        console.error(
          `[orwell] soul index upsert failed for ${hg}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  }

  /**
   * Rebuild `hg`'s per-houseguest index from scratch, re-embedding every memory in the
   * AUTHORITATIVE `soul.memories` list (never touched by this — 0007) through the CURRENT embed
   * function. Used to self-heal a vector-space transition (PERSIST-1/PERSIST-4): mirrors what a
   * full restart already does process-wide (`rebuildSoulIndex` in `GameSessionAdapter.restore`),
   * scoped to just the one houseguest that actually hit a dimension mismatch. `freshStart: true`
   * tells a name-keyed factory (PERSIST-7's sqlite adapter) to drop this houseguest's stale on-disk
   * table first — otherwise a durable index would recover the OLD (now-incompatible) dimension from
   * its persisted metadata and immediately re-throw `VectorDimMismatchError` on every re-embed.
   */
  private rebuildIndexFor(hg: EntityId): void {
    this.indexes.delete(hg);
    const soul = this.souls.get(hg);
    if (!soul) return;
    const fresh = this.makeIndex(hg, true);
    this.indexes.set(hg, fresh);
    for (const m of soul.memories) {
      try {
        fresh.upsert(m.id, this.embed(m.content), { content: m.content });
      } catch (e) {
        console.error(
          `[orwell] soul index rebuild failed for ${hg}/${m.id}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  }

  /** Synchronously index everything still queued for `hg` IN THIS STORE — a recall must
   *  see a complete index; other sandboxes' backlogs stay on the breathing lane. */
  private flushPending(hg: EntityId): void {
    if (SoulStore.pending.length === 0) return;
    // Compact in place (no spread): `push(...keep)` overflows the call stack on a very large shared queue (same hazard as discardPending). indexOne never enqueues, so reading and writing one array is safe.
    const q = SoulStore.pending;
    let w = 0;
    for (let r = 0; r < q.length; r++) {
      const p = q[r]!;
      if (p.store === this && p.hg === hg) this.indexOne(p.hg, p.mem);
      else q[w++] = p;
    }
    q.length = w;
  }

  recall(hg: EntityId, context: string, k = 3): Memory[] {
    this.flushPending(hg); // G8: the deferred indexing is invisible to recall semantics
    const idx = this.indexes.get(hg);
    const soul = this.souls.get(hg);
    if (!idx || !soul) return [];
    const byId = new Map(soul.memories.map((m) => [m.id, m]));
    return idx.query(this.embed(context), k)
      .map((match) => byId.get(match.id))
      .filter((m): m is Memory => m !== undefined);
  }
}
