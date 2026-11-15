/**
 * The CANON LEDGER's types (Showrunner memory, Part B / Decision 1; design K4 §2.2). Pure, dependency-free.
 *
 * Decision 1 ("invent, then it's canon, within code-enforced limits") splits narrated detail three ways:
 *   - FREE TEXTURE (light, sound, a gesture): allowed, never stored;
 *   - RECORDED DETAIL (a habit, a nickname, a running joke, a personal item, a minor house detail): allowed,
 *     written HERE with provenance, and binding from then on;
 *   - ENGINE-ONLY (events, outcomes, secrets, discoveries, new places or fixtures, plot devices, rules,
 *     relationship or knowledge changes, new people, new backstory, any number): never invented, never stored
 *     here; only the engine creates those.
 *
 * The ledger is NOT an event store, a knowledge store or NPC memory: nothing here feeds an engine decision.
 * Entries are never deleted (mandate #4); only their status and reference counters move.
 */
import type { EntityId } from "./ids";
import type { Room } from "./house";

/** The recorded-detail categories (K4 §2.2). `explained-hook` is engine-written only (defuse on contact, K4 §4.5). */
export const CANON_CATEGORIES = [
  "habit",            // "stirs her coffee counter-clockwise"
  "catchphrase",      // "says 'checks out' when she agrees"
  "nickname",         // "calls the hot tub 'the soup pot'"
  "running-joke",     // "'toll' is the house word for an apology"
  "personal-item",    // "wears a braided bracelet" (must be an allowed prop category)
  "wardrobe-style",   // "always in the same faded cap"
  "food-preference",  // "hoards the lime seltzer"
  "house-detail",     // a minor detail of a room, backed by a prop category allowed in that room
  "explained-hook",   // the mundane explanation of an engine-only hook that aired; written by the engine only
] as const;
export type CanonCategory = typeof CANON_CATEGORIES[number];

/** The categories a proposal (the after-turn classifier, the plan step) may carry. */
export const PROPOSABLE_CANON_CATEGORIES: readonly CanonCategory[] = CANON_CATEGORIES.filter((c) => c !== "explained-hook");

/** Who or what a detail is about. A houseguest-scoped detail reaches the brief only when that person is present. */
export type CanonScope =
  | { readonly kind: "room"; readonly room: Room }
  | { readonly kind: "houseguest"; readonly id: EntityId }
  | { readonly kind: "house" };

/** How long a detail stays RELEVANT for the brief. It stays BINDING (contradiction-checked) all season regardless. */
export type CanonPersistence = "permanent" | "season" | "week";

/** Never deleted: `active` is binding; `superseded`, `retired` and `promoted` record what became of it. */
export type CanonStatus = "active" | "superseded" | "retired" | "promoted";

/** The engine-only classes (Decision 1's third kind). Used by later checks; never a stored category. */
export type EngineOnlyClass =
  | "place" | "fixture" | "plot_device" | "event" | "outcome" | "secret" | "discovery" | "rule"
  | "relationship" | "knowledge" | "new_person" | "backstory" | "number";

/** Where a recorded detail came from: which turn, which houseguest, which room, and the words that aired. */
export interface CanonProvenance {
  /** The FE turn counter (the same one `beltsFired` uses). */
  readonly turn: number;
  /** The engine beatSeq when the detail aired. */
  readonly beatSeq: number;
  /** The scene the detail counts against for the per-scene budget (v1: one narrated turn, `${turn}`). */
  readonly sceneKey: string;
  /** Who said it: a houseguest id, the narrator's own prose, or the player. */
  readonly speaker: EntityId | "narrator" | "player";
  /** Who was present (ADR 0019: only they can know it). Sorted. */
  readonly witnesses: readonly EntityId[];
  readonly room?: Room;
  /** At most 140 chars, verbatim from the text the player SAW (never the raw buffer). */
  readonly quote: string;
  /** A stable hash of the normalized quote, for dedupe. */
  readonly quoteHash: string;
}

export interface CanonEntry {
  /** Engine-minted, monotonic, never reused. */
  readonly id: `canon:${number}`;
  /** At most 140 chars, third person, normalized by the engine. */
  readonly text: string;
  readonly category: CanonCategory;
  readonly scope: CanonScope;
  readonly persistence: CanonPersistence;
  readonly provenance: CanonProvenance;
  /** 1-4 lowercase anchor words, used to see when later prose references the detail. */
  readonly keyTokens: readonly string[];
  /** For `house-detail` / `personal-item`: the prop category that backs it. */
  readonly propCategory?: string;
  /** For `explained-hook` only (engine-written): what the explanation defuses. */
  readonly explains?: { readonly hookQuote: string; readonly hookClass: EngineOnlyClass; readonly defusalId: string };
  // ── the ONLY fields that may change after the entry is written (K4 §2.5 superset rule) ──
  readonly status: CanonStatus;
  readonly lastReferencedBeatSeq: number;
  readonly referenceCount: number;
  readonly supersededBy?: `canon:${number}`;
  readonly promotedTo?: { readonly kind: "bit"; readonly id: string };
}

/** Why a proposal was not recorded. Codes only; a result never echoes the proposal's text. */
export type CanonRejectReason =
  | "bad-category" | "bad-scope" | "bad-speaker" | "empty" | "too-long" | "forbidden-class" | "lexicon"
  | "prop-not-allowed" | "low-confidence" | "vault-overlap" | "duplicate" | "contradicts-canon"
  | "season-cap" | "budget";

/** The persisted form (a plain JSON object). `schemaVersion` gates future migrations. */
export interface PersistedCanon {
  readonly schemaVersion: 1;
  readonly nextId: number;
  readonly entries: readonly CanonEntry[];
  /** Recent idempotency keys and the result each produced (bounded; a replay returns the stored result). */
  readonly recent: ReadonlyArray<{ readonly key: string; readonly result: RecordCanonResult }>;
}

/** One proposed recorded detail (from the after-turn classifier or the plan step; advice, re-validated here). */
export interface CanonProposal {
  readonly text: string;
  readonly category: string;
  readonly scope: CanonScope;
  readonly persistence?: CanonPersistence;
  readonly speaker: EntityId | "narrator" | "player";
  readonly witnesses: readonly EntityId[];
  readonly room?: Room;
  readonly quote: string;
  readonly propCategory?: string;
  /** 0..1, the proposer's confidence. Below the floor the detail is not recorded. */
  readonly confidence?: number;
  /** `canon:N` when the proposer says this contradicts an existing entry. */
  readonly contradicts?: string;
}

export interface RecordCanonReq {
  readonly turn: number;
  readonly beatSeq: number;
  /** v1: `${turn}` (K4 Decision 5: one narrated turn is one scene). */
  readonly sceneKey: string;
  /** `${sessionId}:${turn}`; a replay returns the stored result and records nothing (two windows, retries). */
  readonly idempotencyKey: string;
  readonly proposals: readonly CanonProposal[];
}

export interface RecordCanonResult {
  readonly results: ReadonlyArray<{
    readonly index: number;
    readonly outcome: "recorded" | "rejected";
    readonly reason?: CanonRejectReason;
    readonly entryId?: `canon:${number}`;
  }>;
  /** The per-scene budget after this call. */
  readonly budget: { readonly used: number; readonly max: number };
}
