/**
 * The CANON LEDGER store (Showrunner memory Part B; design K4 §2): the record of small, lasting, harmless
 * details the narrator has established on screen, with provenance (turn, houseguest, room, the words that
 * aired), so they stay true for the rest of the season.
 *
 * Pure and deterministic: no I/O, no clock, no randomness, no Vault handle. Every function returns a NEW ledger
 * (the input is never mutated). The engine owns the ledger (K4 D3); proposals from the after-turn classifier or
 * the plan step are ADVICE that `recordCanon` re-validates in code (Decision 1: the model's word is never enough).
 *
 * What is enforced here (K4 §2.4, in order): idempotency; a proposable category; a valid scope (a real room, or
 * a real houseguest who witnessed it); a speaker; text and quote shape (1-140 chars); the engine-only fence (the
 * injected forbidden-term lexicon, relationship/knowledge words, any number); a prop category the room allows for
 * `house-detail` / `personal-item`; the confidence floor; the Vault sweep (the injected `leaksVault` closure, so
 * this module never imports the Vault); dedupe; a contradiction of an active entry; the season cap; and the
 * per-scene budget, ranked by confidence then category.
 *
 * Entries are NEVER deleted (mandate #4). After write only `status`, `lastReferencedBeatSeq`, `referenceCount`,
 * `supersededBy` and `promotedTo` may change; `canonSupersetProblems` is the check the save-state wiring will
 * use. Not wired anywhere yet: no engine session holds a ledger, no tool writes to it, and the narrator does
 * not read it. That wiring (snapshot + `saveState` superset + the FE write-back + the brief section) is next.
 */
import type { EntityId } from "../domain/ids";
import { HOUSE_ROOMS, type Room } from "../domain/house";
import {
  CANON_CATEGORIES, PROPOSABLE_CANON_CATEGORIES,
  type CanonCategory, type CanonEntry, type CanonPersistence, type CanonProposal, type CanonRejectReason,
  type CanonScope, type CanonStatus, type PersistedCanon, type RecordCanonReq, type RecordCanonResult,
} from "../domain/canon";

// ── constants (K4 §2.4-§2.7, K plan §12) ──────────────────────────────────────────────────────────────────
/** Decision 1b: at most 2 new recorded details per scene (one narrated turn in v1). Tunable via the policy. */
export const CANON_BUDGET_PER_SCENE = 2;
/** K plan §12 (K4 D5): at most 150 ACTIVE entries per season, so canon cannot sprawl. */
export const CANON_SEASON_CAP = 150;
export const CANON_TEXT_MAX = 140;
/** Below this proposer confidence a detail stays free texture (K4 §4.4). */
export const CANON_MIN_CONFIDENCE = 0.6;
/** A detail leaves the brief this many beats after its last reference (week-scoped details: half). */
export const CANON_FADE_BEATS = 40;
/** The brief shows at most this many canon lines (K4 §2.6, about 350 tokens). */
export const CANON_BRIEF_MAX = 8;
/** The after-turn check sees at most this many active lines (K4 §2.7). */
export const CANON_CHECK_MAX = 40;
/** How many recent idempotency keys (and their results) the ledger keeps. */
export const CANON_IDEMPOTENCY_KEEP = 128;
/** A reference is counted when at least this share of an entry's anchors appear in the emitted text. */
const REFERENCE_SHARE = 0.6;

/**
 * What the ledger needs from the rest of the engine, injected so this module stays pure and Vault-free
 * (the K4 §2.8 `leaksVault` closure pattern, the same shape as the registry-wired `sceneRecall`).
 */
export interface CanonPolicy {
  /** True when text overlaps hidden (Vault) content. Composition-wired; this module never sees the Vault. */
  readonly leaksVault: (text: string) => boolean;
  /** The engine-only term a text contains (hidden places, plot devices), from the shared lexicon. */
  readonly forbiddenTerm: (text: string) => string | undefined;
  /** The prop categories a scope allows: a room's own list; for a houseguest or the house, every category. */
  readonly propCategoriesFor: (scope: CanonScope) => readonly string[];
  /** True for a real houseguest id (an NPC on the roster; not the player). */
  readonly isHouseguest: (id: EntityId) => boolean;
  /** Overrides `CANON_BUDGET_PER_SCENE`. */
  readonly budgetPerScene?: number;
  /** Overrides `CANON_SEASON_CAP`. */
  readonly seasonCap?: number;
}

export interface CanonLedger {
  readonly schemaVersion: 1;
  readonly nextId: number;
  readonly entries: readonly CanonEntry[];
  readonly recent: PersistedCanon["recent"];
}

export function emptyCanonLedger(): CanonLedger {
  return { schemaVersion: 1, nextId: 1, entries: [], recent: [] };
}

// ── text helpers ────────────────────────────────────────────────────────────────────────────────────────────
/** Collapse control characters and whitespace; trim. The stored text is the engine's normalization. */
export function normalizeCanonText(s: string): string {
  // eslint-disable-next-line no-control-regex
  return String(s ?? "").replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim();
}

/** A stable 64-bit FNV-1a hash (hex) of the normalized, lowercased text. Deterministic; no crypto needed. */
export function canonHash(s: string): string {
  let h = 0xcbf29ce484222325n;
  for (const ch of normalizeCanonText(s).toLowerCase()) {
    h ^= BigInt(ch.codePointAt(0)!);
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, "0");
}

const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "onto", "over", "when", "what", "who", "his", "her",
  "hers", "their", "they", "them", "she", "him", "you", "your", "its", "are", "was", "were", "has", "have", "had",
  "always", "every", "calls", "says", "said", "word", "house", "keeps", "wears", "likes", "loves", "hates",
]);
const WORD_RE = /[a-z][a-z'-]*[a-z]|[a-z]/g;

/**
 * 1-4 anchor words for a detail. When the text quotes a phrase (a nickname, a catchphrase, a house word), the
 * quoted words ARE the anchors: "the soup pot" is the detail, not "the hot tub" it names. Otherwise the text's
 * own words: lowercase, no stopwords, at least 3 letters, capitalized words skipped (they are usually names, which
 * would make every mention of a person count as a reference). Deterministic.
 */
export function canonKeyTokens(text: string): string[] {
  const t = normalizeCanonText(text);
  const quoted = [...t.matchAll(/["“'‘]([^"”'’]{2,60})["”'’]/g)].map((m) => m[1]!);
  const pick = (src: string, skipCapitalized: boolean): string[] => {
    const out: string[] = [];
    for (const raw of src.split(/\s+/)) {
      const bare = raw.replace(/^[^A-Za-z]+|[^A-Za-z]+$/g, "");
      if (!bare) continue;
      if (skipCapitalized && /^[A-Z]/.test(bare)) continue;
      for (const w of bare.toLowerCase().match(WORD_RE) ?? []) if (w.length >= 3 && !STOPWORDS.has(w)) out.push(w);
    }
    return out;
  };
  const fromQuotes = quoted.flatMap((q) => pick(q, false));
  const ordered = fromQuotes.length ? fromQuotes : pick(t, true);
  const tokens = [...new Set(ordered)].slice(0, 4);
  if (tokens.length > 0) return tokens;
  // Fallback: the longest word of any kind, so every entry has at least one anchor.
  const any = (t.toLowerCase().match(WORD_RE) ?? []).sort((a, b) => b.length - a.length || a.localeCompare(b));
  return any.length ? [any[0]!] : [];
}

/**
 * The engine-only fence beyond the lexicon (K4 §2.8.4, Decision 1): relationship and knowledge words, and any
 * number. A "recorded detail" that says who trusts whom, what someone knows, or how many of something there
 * are is engine-only by definition and is never stored here.
 */
const RELATIONSHIP_OR_KNOWLEDGE_RE =
  /\b(trusts?|distrusts?|suspects?|knows that|knew that|secretly|plans? to|planning to|allian(?:ce|ces)|allied|betray\w*|targets?|targeting|nominat\w*|evict\w*|votes?|voting)\b/i;
const NUMBER_RE = /\d/;

const CATEGORY_RANK: Readonly<Record<CanonCategory, number>> = {
  "nickname": 0, "catchphrase": 0, "running-joke": 1, "habit": 1,
  "personal-item": 2, "wardrobe-style": 2, "food-preference": 2, "house-detail": 3, "explained-hook": 4,
};

const DEFAULT_PERSISTENCE: Readonly<Record<CanonCategory, CanonPersistence>> = {
  "nickname": "permanent", "catchphrase": "permanent", "habit": "permanent",
  "running-joke": "season", "personal-item": "season", "wardrobe-style": "season", "food-preference": "season",
  "house-detail": "season", "explained-hook": "season",
};

const isRoom = (r: unknown): r is Room => typeof r === "string" && (HOUSE_ROOMS as readonly string[]).includes(r);
const entryNumber = (id: string): number => Number(id.slice("canon:".length));

function scopeKey(scope: CanonScope): string {
  return scope.kind === "room" ? `room:${scope.room}` : scope.kind === "houseguest" ? `houseguest:${scope.id}` : "house";
}

// ── the write path ─────────────────────────────────────────────────────────────────────────────────────────
type Candidate = { index: number; proposal: CanonProposal; text: string; quote: string; witnesses: EntityId[]; category: CanonCategory };

/** Validate one proposal in isolation. Returns the cleaned candidate or the first reason it fails. */
function check(p: CanonProposal, policy: CanonPolicy, ledger: CanonLedger): Candidate | CanonRejectReason {
  if (!(PROPOSABLE_CANON_CATEGORIES as readonly string[]).includes(p.category)) return "bad-category";
  const category = p.category as CanonCategory;
  const witnesses = [...new Set((p.witnesses ?? []).filter((w) => w === "player" || policy.isHouseguest(w)))].sort();
  const scope = p.scope;
  if (!scope || typeof scope !== "object") return "bad-scope";
  if (scope.kind === "room") { if (!isRoom(scope.room)) return "bad-scope"; }
  else if (scope.kind === "houseguest") { if (!policy.isHouseguest(scope.id) || !witnesses.includes(scope.id)) return "bad-scope"; }
  else if (scope.kind !== "house") return "bad-scope";
  if (p.room !== undefined && !isRoom(p.room)) return "bad-scope";
  if (!(p.speaker === "narrator" || p.speaker === "player" || policy.isHouseguest(p.speaker))) return "bad-speaker";
  const text = normalizeCanonText(p.text);
  const quote = normalizeCanonText(p.quote);
  if (!text || !quote) return "empty";
  if (text.length > CANON_TEXT_MAX || quote.length > CANON_TEXT_MAX) return "too-long";
  // The Vault sweep runs before every other content check, so an overlap is always reported (and counted) as one.
  if (policy.leaksVault(text) || policy.leaksVault(quote)) return "vault-overlap";
  if (policy.forbiddenTerm(text) !== undefined || policy.forbiddenTerm(quote) !== undefined) return "lexicon";
  if (RELATIONSHIP_OR_KNOWLEDGE_RE.test(text) || NUMBER_RE.test(text)) return "forbidden-class";
  if (category === "house-detail" || category === "personal-item") {
    if (category === "house-detail" && scope.kind !== "room") return "bad-scope";
    if (typeof p.propCategory !== "string" || !policy.propCategoriesFor(scope).includes(p.propCategory)) return "prop-not-allowed";
  }
  if (typeof p.confidence === "number" && !(p.confidence >= CANON_MIN_CONFIDENCE)) return "low-confidence";
  if (typeof p.contradicts === "string" && ledger.entries.some((e) => e.id === p.contradicts && e.status === "active")) return "contradicts-canon";
  return { index: -1, proposal: p, text, quote, witnesses, category };
}

/**
 * Record proposed details. Re-validates everything (the proposer's labels are advice), applies dedupe, the
 * season cap and the per-scene budget, and returns a NEW ledger plus a per-proposal result. A replayed
 * `idempotencyKey` returns the stored result and records nothing. A result never echoes proposal text.
 */
export function recordCanon(ledger: CanonLedger, req: RecordCanonReq, policy: CanonPolicy): { ledger: CanonLedger; result: RecordCanonResult; replay: boolean } {
  const replayed = ledger.recent.find((r) => r.key === req.idempotencyKey);
  if (replayed) return { ledger, result: replayed.result, replay: true };

  const max = Math.max(0, Math.floor(policy.budgetPerScene ?? CANON_BUDGET_PER_SCENE));
  const cap = Math.max(0, Math.floor(policy.seasonCap ?? CANON_SEASON_CAP));
  const sceneKey = String(req.sceneKey);
  const usedBefore = ledger.entries.filter((e) => e.provenance.sceneKey === sceneKey).length;
  let active = ledger.entries.filter((e) => e.status === "active").length;

  const outcomes = new Map<number, { reason?: CanonRejectReason; entryId?: `canon:${number}` }>();
  const valid: Candidate[] = [];
  (req.proposals ?? []).forEach((p, index) => {
    const c = check(p, policy, ledger);
    if (typeof c === "string") outcomes.set(index, { reason: c });
    else valid.push({ ...c, index });
  });

  // Rank (K4 §2.4.7): confidence desc, then category priority, then proposal order (stable, deterministic).
  valid.sort((a, b) => (b.proposal.confidence ?? 1) - (a.proposal.confidence ?? 1)
    || CATEGORY_RANK[a.category] - CATEGORY_RANK[b.category] || a.index - b.index);

  const entries = [...ledger.entries];
  const seenHashes = new Set(entries.map((e) => e.provenance.quoteHash));
  const seenTexts = new Set(entries.filter((e) => e.status === "active").map((e) => `${scopeKey(e.scope)}|${e.text.toLowerCase()}`));
  let nextId = ledger.nextId;
  let used = usedBefore;
  for (const c of valid) {
    const quoteHash = canonHash(c.quote);
    const textKey = `${scopeKey(c.proposal.scope)}|${c.text.toLowerCase()}`;
    if (seenHashes.has(quoteHash) || seenTexts.has(textKey)) { outcomes.set(c.index, { reason: "duplicate" }); continue; }
    if (active >= cap) { outcomes.set(c.index, { reason: "season-cap" }); continue; }
    if (used >= max) { outcomes.set(c.index, { reason: "budget" }); continue; }
    const id = `canon:${nextId}` as const;
    nextId += 1;
    const p = c.proposal;
    const scope: CanonScope = p.scope.kind === "room" ? { kind: "room", room: p.scope.room }
      : p.scope.kind === "houseguest" ? { kind: "houseguest", id: p.scope.id } : { kind: "house" };
    const entry: CanonEntry = {
      id,
      text: c.text,
      category: c.category,
      scope,
      persistence: p.persistence === "permanent" || p.persistence === "season" || p.persistence === "week" ? p.persistence : DEFAULT_PERSISTENCE[c.category],
      provenance: {
        turn: req.turn, beatSeq: req.beatSeq, sceneKey, speaker: p.speaker, witnesses: c.witnesses,
        ...(p.room !== undefined ? { room: p.room } : {}), quote: c.quote, quoteHash,
      },
      keyTokens: canonKeyTokens(c.text),
      ...(typeof p.propCategory === "string" && (c.category === "house-detail" || c.category === "personal-item") ? { propCategory: p.propCategory } : {}),
      status: "active",
      lastReferencedBeatSeq: req.beatSeq,
      referenceCount: 0,
    };
    entries.push(entry);
    seenHashes.add(quoteHash);
    seenTexts.add(textKey);
    used += 1;
    active += 1;
    outcomes.set(c.index, { entryId: id });
  }

  const result: RecordCanonResult = {
    results: (req.proposals ?? []).map((_p, index) => {
      const o = outcomes.get(index)!;
      return o.entryId ? { index, outcome: "recorded" as const, entryId: o.entryId } : { index, outcome: "rejected" as const, reason: o.reason! };
    }),
    budget: { used, max },
  };
  const recent = [...ledger.recent, { key: req.idempotencyKey, result }].slice(-CANON_IDEMPOTENCY_KEEP);
  return { ledger: { schemaVersion: 1, nextId, entries, recent }, result, replay: false };
}

/**
 * Mark the active entries the emitted text references (a deterministic anchor match, K4 §2.2): at least 60% of an
 * entry's anchor words appear as whole words. A referenced entry's `lastReferencedBeatSeq` moves forward and its
 * `referenceCount` grows, which also revives a faded entry in the brief. Being shown in the brief is NOT a reference.
 */
export function noteCanonReferences(ledger: CanonLedger, emittedText: string, beatSeq: number): CanonLedger {
  const words = new Set((normalizeCanonText(emittedText).toLowerCase().match(WORD_RE) ?? []));
  let changed = false;
  const entries = ledger.entries.map((e) => {
    if (e.status !== "active" || e.keyTokens.length === 0) return e;
    const hits = e.keyTokens.filter((t) => words.has(t)).length;
    if (hits < Math.max(1, Math.ceil(e.keyTokens.length * REFERENCE_SHARE))) return e;
    changed = true;
    return { ...e, referenceCount: e.referenceCount + 1, lastReferencedBeatSeq: Math.max(e.lastReferencedBeatSeq, beatSeq) };
  });
  return changed ? { ...ledger, entries } : ledger;
}

// ── status transitions (engine-only; never a deletion) ────────────────────────────────────────────────────
type TransitionFail = "unknown-entry" | "not-active" | "bad-target" | "not-promotable";
type Transition = { ledger: CanonLedger; ok: boolean; reason?: TransitionFail };

function transition(ledger: CanonLedger, id: string, next: (e: CanonEntry) => CanonEntry | TransitionFail): Transition {
  const i = ledger.entries.findIndex((e) => e.id === id);
  if (i < 0) return { ledger, ok: false, reason: "unknown-entry" };
  const cur = ledger.entries[i]!;
  if (cur.status !== "active") return { ledger, ok: false, reason: "not-active" };
  const out = next(cur);
  if (typeof out === "string") return { ledger, ok: false, reason: out };
  const entries = [...ledger.entries];
  entries[i] = out;
  return { ledger: { ...ledger, entries }, ok: true };
}

/** An active entry stops being binding (e.g. a week-scoped detail at the weekly boundary). Kept, never deleted. */
export function retireCanon(ledger: CanonLedger, id: string): Transition {
  return transition(ledger, id, (e) => ({ ...e, status: "retired" }));
}

/** At the weekly boundary every active `week` entry retires (K4 §2.7). */
export function retireWeekCanon(ledger: CanonLedger): CanonLedger {
  let changed = false;
  const entries = ledger.entries.map((e) => {
    if (e.status !== "active" || e.persistence !== "week") return e;
    changed = true;
    return { ...e, status: "retired" as const };
  });
  return changed ? { ...ledger, entries } : ledger;
}

/** An active entry is replaced by a newer active one (the engine decides; e.g. a nickname that changed on screen). */
export function supersedeCanon(ledger: CanonLedger, id: string, byId: string): Transition {
  const by = ledger.entries.find((e) => e.id === byId);
  if (!by || by.status !== "active" || byId === id) return { ledger, ok: false, reason: "bad-target" };
  return transition(ledger, id, (e) => ({ ...e, status: "superseded", supersededBy: by.id }));
}

/**
 * The engine (never a model) adopts a running joke, catchphrase or nickname as a Running Bit (ORW-51, K4 §2.10).
 * The text is unchanged; provenance gains the bit id.
 */
export function promoteCanon(ledger: CanonLedger, id: string, bitId: string): Transition {
  if (!normalizeCanonText(bitId)) return { ledger, ok: false, reason: "bad-target" };
  return transition(ledger, id, (e) => (e.category === "running-joke" || e.category === "catchphrase" || e.category === "nickname"
    ? { ...e, status: "promoted", promotedTo: { kind: "bit", id: normalizeCanonText(bitId) } }
    : "not-promotable"));
}

// ── the read path ──────────────────────────────────────────────────────────────────────────────────────────
export function canonEntry(ledger: CanonLedger, id: string): CanonEntry | undefined {
  return ledger.entries.find((e) => e.id === id);
}

/** Every active (binding) entry, oldest first. */
export function activeCanon(ledger: CanonLedger): CanonEntry[] {
  return ledger.entries.filter((e) => e.status === "active");
}

/** The compact list the after-turn check compares prose against: active entries, most recently referenced first, capped. */
export function canonForCheck(ledger: CanonLedger, max: number = CANON_CHECK_MAX): CanonEntry[] {
  return activeCanon(ledger)
    .sort((a, b) => b.lastReferencedBeatSeq - a.lastReferencedBeatSeq || entryNumber(a.id) - entryNumber(b.id))
    .slice(0, Math.max(0, max));
}

export interface CanonBriefContext {
  /** The player's room. */
  readonly room: Room;
  /** Rooms next door (room-scoped details there may still matter). */
  readonly adjacentRooms: readonly Room[];
  /** Who is with the player (houseguest-scoped details show only for them: ADR 0019). */
  readonly presentIds: readonly EntityId[];
  readonly beatSeq: number;
}

/**
 * The entries relevant to this moment, for the brief (K4 §2.6-§2.7): active only; in scope (this room or next
 * door, a houseguest who is present, or the whole house); not faded (unreferenced for longer than the fade
 * window), unless the detail is permanent and its scope is here; permanent-and-here first, then most recently
 * referenced, capped. Fading never deletes and never stops the contradiction check.
 */
export function selectBriefCanon(ledger: CanonLedger, ctx: CanonBriefContext, opts: { max?: number; fadeBeats?: number } = {}): CanonEntry[] {
  const fade = Math.max(0, opts.fadeBeats ?? CANON_FADE_BEATS);
  const present = new Set(ctx.presentIds);
  const near = new Set<Room>([ctx.room, ...ctx.adjacentRooms]);
  const here = (s: CanonScope): boolean => s.kind === "house" || (s.kind === "room" ? s.room === ctx.room : present.has(s.id));
  const inScope = (s: CanonScope): boolean => s.kind === "house" || (s.kind === "room" ? near.has(s.room) : present.has(s.id));
  const pinned = (e: CanonEntry): boolean => e.persistence === "permanent" && here(e.scope);
  return activeCanon(ledger)
    .filter((e) => inScope(e.scope))
    .filter((e) => pinned(e) || ctx.beatSeq - e.lastReferencedBeatSeq <= (e.persistence === "week" ? Math.floor(fade / 2) : fade))
    .sort((a, b) => Number(pinned(b)) - Number(pinned(a)) || b.lastReferencedBeatSeq - a.lastReferencedBeatSeq || entryNumber(a.id) - entryNumber(b.id))
    .slice(0, Math.max(0, opts.max ?? CANON_BRIEF_MAX));
}

/** The brief's lines for selected entries: the engine-normalized text only, never the quote or provenance. */
export function canonBriefLines(entries: readonly CanonEntry[]): string[] {
  return entries.map((e) => e.text);
}

// ── persistence ────────────────────────────────────────────────────────────────────────────────────────────
/** The persisted form: a deep, plain-JSON copy. */
export function serializeCanon(ledger: CanonLedger): PersistedCanon {
  return JSON.parse(JSON.stringify({ schemaVersion: 1, nextId: ledger.nextId, entries: ledger.entries, recent: ledger.recent })) as PersistedCanon;
}

const STATUSES: readonly CanonStatus[] = ["active", "superseded", "retired", "promoted"];
const PERSISTENCES: readonly CanonPersistence[] = ["permanent", "season", "week"];

function entryProblem(e: unknown): string | undefined {
  if (!e || typeof e !== "object") return "not an object";
  const x = e as Record<string, unknown>;
  if (typeof x.id !== "string" || !/^canon:[1-9]\d*$/.test(x.id)) return "bad id";
  if (typeof x.text !== "string" || !x.text) return "bad text";
  if (!(CANON_CATEGORIES as readonly string[]).includes(String(x.category))) return "bad category";
  const s = x.scope as Record<string, unknown> | undefined;
  if (!s || !(s.kind === "house" || (s.kind === "room" && isRoom(s.room)) || (s.kind === "houseguest" && typeof s.id === "string"))) return "bad scope";
  if (!PERSISTENCES.includes(x.persistence as CanonPersistence)) return "bad persistence";
  if (!STATUSES.includes(x.status as CanonStatus)) return "bad status";
  const p = x.provenance as Record<string, unknown> | undefined;
  if (!p || typeof p.turn !== "number" || typeof p.beatSeq !== "number" || typeof p.sceneKey !== "string"
    || typeof p.quote !== "string" || typeof p.quoteHash !== "string" || !Array.isArray(p.witnesses)) return "bad provenance";
  if (!Array.isArray(x.keyTokens)) return "bad keyTokens";
  if (typeof x.lastReferencedBeatSeq !== "number" || typeof x.referenceCount !== "number") return "bad counters";
  return undefined;
}

/**
 * Rebuild a ledger from its persisted form. A pre-feature save (`undefined`) is an empty ledger with no problems.
 * Anything malformed is REPORTED, never silently dropped: the caller decides (the save-state wiring will refuse
 * a load that would lose canon, mandate #4). Entries that fail the shape check are excluded from the returned
 * ledger and listed in `problems`.
 */
export function restoreCanon(raw: unknown): { ledger: CanonLedger; problems: string[] } {
  if (raw === undefined || raw === null) return { ledger: emptyCanonLedger(), problems: [] };
  if (typeof raw !== "object") return { ledger: emptyCanonLedger(), problems: ["canon: not an object"] };
  const r = raw as Record<string, unknown>;
  const problems: string[] = [];
  if (r.schemaVersion !== 1) problems.push(`canon: unknown schemaVersion ${String(r.schemaVersion)}`);
  const entries: CanonEntry[] = [];
  const ids = new Set<string>();
  for (const [i, e] of (Array.isArray(r.entries) ? r.entries : []).entries()) {
    const p = entryProblem(e);
    if (p) { problems.push(`canon entry ${i}: ${p}`); continue; }
    const entry = e as CanonEntry;
    if (ids.has(entry.id)) { problems.push(`canon entry ${i}: duplicate id ${entry.id}`); continue; }
    ids.add(entry.id);
    entries.push(entry);
  }
  if (r.entries !== undefined && !Array.isArray(r.entries)) problems.push("canon: entries is not a list");
  const maxId = entries.reduce((m, e) => Math.max(m, entryNumber(e.id)), 0);
  const nextIdOk = typeof r.nextId === "number" && Number.isInteger(r.nextId) && r.nextId > maxId;
  const nextId = nextIdOk ? (r.nextId as number) : maxId + 1;
  if (!nextIdOk) problems.push("canon: nextId repaired past the highest id");
  const recent = (Array.isArray(r.recent) ? r.recent : [])
    .filter((x): x is PersistedCanon["recent"][number] => !!x && typeof (x as { key?: unknown }).key === "string" && typeof (x as { result?: unknown }).result === "object")
    .slice(-CANON_IDEMPOTENCY_KEEP);
  return { ledger: JSON.parse(JSON.stringify({ schemaVersion: 1, nextId, entries, recent })) as CanonLedger, problems };
}

const ALLOWED_STATUS_MOVES: Readonly<Record<CanonStatus, readonly CanonStatus[]>> = {
  active: ["active", "superseded", "retired", "promoted"],
  superseded: ["superseded"],
  retired: ["retired"],
  promoted: ["promoted"],
};

/** JSON with object keys sorted at every depth, so two equal values always serialize to the same bytes. */
function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

/** Byte-stable fields: everything except the five that may change (K4 §2.5). */
function stablePart(e: CanonEntry): string {
  const { status: _s, lastReferencedBeatSeq: _l, referenceCount: _r, supersededBy: _b, promotedTo: _p, ...rest } = e;
  return stableStringify(rest);
}

/**
 * The non-degradation rule for the ledger (K4 §2.5), for the save-state superset check: nothing that was written
 * may disappear or change, except status (only forward, out of `active`), the reference counters (never back),
 * and `supersededBy` / `promotedTo` (set once). `nextId` never goes back. `[]` means `after` is a superset.
 */
export function canonSupersetProblems(before: CanonLedger, after: CanonLedger): string[] {
  const problems: string[] = [];
  if (after.nextId < before.nextId) problems.push(`canon nextId went back (${before.nextId} -> ${after.nextId})`);
  const byId = new Map(after.entries.map((e) => [e.id, e] as const));
  for (const b of before.entries) {
    const a = byId.get(b.id);
    if (!a) { problems.push(`${b.id} was removed`); continue; }
    if (stablePart(a) !== stablePart(b)) problems.push(`${b.id} changed a byte-stable field`);
    if (!ALLOWED_STATUS_MOVES[b.status].includes(a.status)) problems.push(`${b.id} status moved ${b.status} -> ${a.status}`);
    if (a.referenceCount < b.referenceCount) problems.push(`${b.id} referenceCount went back`);
    if (a.lastReferencedBeatSeq < b.lastReferencedBeatSeq) problems.push(`${b.id} lastReferencedBeatSeq went back`);
    if (b.supersededBy !== undefined && a.supersededBy !== b.supersededBy) problems.push(`${b.id} supersededBy changed`);
    if (b.promotedTo !== undefined && JSON.stringify(a.promotedTo) !== JSON.stringify(b.promotedTo)) problems.push(`${b.id} promotedTo changed`);
  }
  return problems;
}
