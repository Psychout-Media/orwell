import type { EntityId } from "../domain/ids";

/**
 * Feature 0024 — NPC MEMORY ACTS (PO ruling 2026-11-03: betrayals, favors and broken promises change how an NPC
 * treats the player, and everyone else). A small STRUCTURED, engine-adjudicated ledger — NOT `SoulProvider.recall`
 * (that needs embeddings; the mechanics must not depend on a semantic model). Entries are written only at the fold
 * sites that already exist (the layer's own flag gates the write), keyed `holder → subject`, and the SAME rules
 * apply to NPC↔NPC pairs and to the player. Pure: no rng, no I/O, no Vault handle. ENGINE-ONLY — never a player
 * surface; the player only sees the later behavior.
 *
 * The decision term is a RESIDUAL FLOOR, not an add-on: a fresh betrayal already sits on the relationship edge
 * (threat up, trust down), so the memory contributes only what the edge has since DECAYED away. It therefore never
 * double counts a fresh shock, and a long-ago betrayal stays salient when the edge has mean-reverted — which is
 * the one thing the edges alone cannot do.
 */

export type MemoryKind =
  | "deal-broken"        // a deal the holder was party to was broken by the subject (attributed only)
  | "nominated-by-friend" // the subject (the HOH) nominated the holder while the holder trusted them
  | "replaced-by-friend"  // the subject (the HOH) named the holder the replacement while the holder trusted them
  | "veto-saved"         // the subject (the veto holder) saved the holder
  | "veto-withheld"       // B2: the subject (the veto holder) did NOT use the veto while the holder sat on the block (written only under ORWELL_NPC_MEMORY_WRITERS)
  | "deal-kept"           // B2: the subject kept a deal with the holder (a favor; written only under ORWELL_NPC_MEMORY_WRITERS)
  | "scene-betrayal"      // P4g: the PLAYER betrayed the holder in a recorded scene (grudge)
  | "scene-conflict"      // P4g: the PLAYER clashed with the holder in a recorded scene (smaller grudge)
  | "scene-kindness"      // P4g: the PLAYER was kind / bonded with the holder in a recorded scene (favor, weaker than a grudge)
  | "secret-exposed"     // A24 / AMEND 3a #8: the PLAYER publicly exposed the holder's secret (a landed expose; written only under ORWELL_NPC_MEMORY_WRITERS) - a deep grudge
  | "secret-given"       // A24 / AMEND 3a #8: the PLAYER traded the holder a secret they wanted (an accepted trade; same flag) - a favor
  | "nominated-by-hoh";   // B2: the subject (the HOH) put the holder on the block — whatever their prior trust (written only under ORWELL_NPC_MEMORY_WRITERS)

export interface MemoryEntry { kind: MemoryKind; week: number; /** 0..1 — how much it mattered. */ severity: number }

/** `holder → subject → entries` (capped per pair). Optional on the live state: absent ⇒ empty. */
export type NpcMemoryLedger = Record<EntityId, Record<EntityId, MemoryEntry[]>>;

export interface NpcMemoryConstants {
  /** The MAX residual grudge a fully-salient memory adds to a decision score (below a fresh betrayal's 0.32). */
  grudgeMax: number;
  /** The MAX residual favor (weaker than a grudge on purpose — negativity bias). */
  favorMax: number;
  /** Weeks for a memory's salience to halve for a NEUTRAL holder (scaled by the holder's own decayScale). */
  halfLifeWeeks: number;
  /** Entries kept per (holder, subject) pair; the oldest low-severity ones merge away first. */
  maxEntriesPerPair: number;
  /** A residual grudge toward the player at/above this makes an NPC stop offering them a safety deal. */
  dealOfferGrudge: number;
  /** An edge trust at/above this (read BEFORE the shock folds) means the holder counted the subject a friend. */
  trustedAbove: number;
}

export const NPC_MEMORY: NpcMemoryConstants = {
  grudgeMax: 0.15,
  favorMax: 0.06,
  halfLifeWeeks: 4,
  maxEntriesPerPair: 6,
  dealOfferGrudge: 0.08,
  trustedAbove: 0.4,
};

const GRUDGE_KINDS: ReadonlySet<MemoryKind> = new Set(["deal-broken", "nominated-by-friend", "replaced-by-friend", "nominated-by-hoh", "veto-withheld", "scene-betrayal", "scene-conflict", "secret-exposed"]);
/** ORW-131: does this memory kind weigh as a grievance (vs a favor / neutral)? */
export const isGrudgeKind = (k: MemoryKind): boolean => GRUDGE_KINDS.has(k);
const FAVOR_KINDS: ReadonlySet<MemoryKind> = new Set(["veto-saved", "deal-kept", "scene-kindness", "secret-given"]);

const clamp01 = (x: number): number => (Number.isNaN(x) ? 0 : x < 0 ? 0 : x > 1 ? 1 : x);

/**
 * Record one memory (mutates `ledger`). Over the cap, the entry with the lowest DECAYED weight at the new entry's week
 * drops first (`severity x 0.5^(age / halfLife)`; ties keep the newer), so stale memories go before a fresh one — six old
 * low-severity favors can never evict a fresh betrayal.
 */
export function recordMemory(
  ledger: NpcMemoryLedger, holder: EntityId, subject: EntityId, entry: MemoryEntry,
  c: NpcMemoryConstants = NPC_MEMORY,
): void {
  if (holder === subject) return;
  const row = (ledger[holder] ??= {});
  const list = (row[subject] ??= []);
  list.push({ kind: entry.kind, week: entry.week, severity: clamp01(entry.severity) });
  const now = entry.week;
  const weight = (e: MemoryEntry): number => e.severity * Math.pow(0.5, Math.max(0, now - e.week) / c.halfLifeWeeks);
  while (list.length > c.maxEntriesPerPair) {
    let drop = 0;
    for (let i = 1; i < list.length; i++) {
      const a = list[i]!;
      const b = list[drop]!;
      if (weight(a) < weight(b) || (weight(a) === weight(b) && a.week < b.week)) drop = i;
    }
    list.splice(drop, 1);
  }
}

/**
 * The combined, decayed salience (0..1) of the entries of the given kinds at `week`: each entry is
 * `severity × 0.5^(Δweeks / (halfLife / decayScale))`, and they combine as `1 − Π(1 − sᵢ)` (diminishing, so a pile of
 * small memories never exceeds one big one by much). `decayScale` is the holder's own temperament (a clash holder
 * holds a grudge longer, a forgiving one lets go sooner).
 */
export function salience(
  entries: readonly MemoryEntry[] | undefined, kinds: ReadonlySet<MemoryKind>, week: number, decayScale: number,
  c: NpcMemoryConstants = NPC_MEMORY,
): number {
  if (!entries || entries.length === 0) return 0;
  const half = c.halfLifeWeeks / Math.max(0.05, decayScale);
  let keep = 1;
  for (const e of entries) {
    if (!kinds.has(e.kind)) continue;
    const age = Math.max(0, week - e.week);
    keep *= 1 - clamp01(e.severity) * Math.pow(0.5, age / half);
  }
  return 1 - keep;
}

/** What the relationship edge already carries, so the memory only adds the RESIDUAL (never double counts). */
export interface EdgeCarry {
  /** `max(0, threat(holder→subject) − baseline.threat)` — the grudge the edge still holds. */
  threatAboveBaseline: number;
  /** `max(0, bondStrength(holder, subject) − neutral bond)` — the warmth the edge still holds. */
  bondAboveNeutral: number;
}

/** The residual GRUDGE (0..grudgeMax): the memory's salience minus what the edge still carries, floored at 0. */
export function memoryGrudge(
  entries: readonly MemoryEntry[] | undefined, week: number, decayScale: number, carry: EdgeCarry,
  c: NpcMemoryConstants = NPC_MEMORY,
): number {
  return Math.max(0, c.grudgeMax * salience(entries, GRUDGE_KINDS, week, decayScale, c) - Math.max(0, carry.threatAboveBaseline));
}

/** The residual FAVOR (0..favorMax), the warm mirror of the grudge. */
export function memoryFavor(
  entries: readonly MemoryEntry[] | undefined, week: number, decayScale: number, carry: EdgeCarry,
  c: NpcMemoryConstants = NPC_MEMORY,
): number {
  return Math.max(0, c.favorMax * salience(entries, FAVOR_KINDS, week, decayScale, c) - Math.max(0, carry.bondAboveNeutral));
}

/** The signed decision tilt toward acting AGAINST the subject: `+grudge − favor`. */
export function memoryTilt(
  entries: readonly MemoryEntry[] | undefined, week: number, decayScale: number, carry: EdgeCarry,
  c: NpcMemoryConstants = NPC_MEMORY,
): number {
  return memoryGrudge(entries, week, decayScale, carry, c) - memoryFavor(entries, week, decayScale, carry, c);
}

/**
 * B2 / #2017 — the STANDALONE read (`ORWELL_NPC_MEMORY_STANDALONE`, default ON since #2059 / PO ruling 2026-11-03; `=0` rolls back): the memory on its own, with NO edge-carry subtraction. The residual floor is
 * exactly 0 for every in-season read (the relationship edge already carries a fresh betrayal and decays slower than the memory's salience), so "NPCs act on what they
 * remember" was a no-op. Standalone, a betrayal's grudge outlives the edge's mean-reversion and a favor is repaid because it is remembered — bounded by the SAME grudgeMax /
 * favorMax. It can double-count a fresh shock the edge also carries; that is deliberate and bounded (the maxima sit below a fresh betrayal's own edge move), and it is why this
 * has its own flag and its own signed-direction calibration read before any flip. Pure.
 */
export function memoryTiltStandalone(
  entries: readonly MemoryEntry[] | undefined, week: number, decayScale: number, c: NpcMemoryConstants = NPC_MEMORY,
): number {
  return c.grudgeMax * salience(entries, GRUDGE_KINDS, week, decayScale, c) - c.favorMax * salience(entries, FAVOR_KINDS, week, decayScale, c);
}

/** P4g - how much a remembered PLAYER scene mattered, by kind (bounded, deterministic): a betrayal weighs most, a clash less, a kindness least (negativity bias). */
export const SCENE_MEMORY_SEVERITY: Readonly<Record<string, { kind: MemoryKind; severity: number }>> = {
  betrayal: { kind: "scene-betrayal", severity: 0.6 },
  conflict: { kind: "scene-conflict", severity: 0.4 },
  bonding: { kind: "scene-kindness", severity: 0.3 },
  alliance: { kind: "scene-kindness", severity: 0.3 },
};

/** B2 — how much a remembered nomination mattered, graded by the holder's PRE-fold trust in the HOH (a betrayal by a friend weighs more): 0.3 floor .. 0.7. Pure, bounded. */
export function nominationMemorySeverity(priorTrust: number): number {
  const t = Number.isNaN(priorTrust) ? 0 : Math.max(0, Math.min(1, priorTrust));
  return 0.3 + 0.4 * t;
}

/** B2 — how much a veto NOT used for a nominee mattered (a smaller slight than a nomination; graded by the holder's trust in the veto holder): 0.15 .. 0.4. Pure, bounded. */
export function vetoWithheldSeverity(priorTrust: number): number {
  const t = Number.isNaN(priorTrust) ? 0 : Math.max(0, Math.min(1, priorTrust));
  return 0.15 + 0.25 * t;
}

/**
 * B25 (flag ORWELL_MEMORY_FRIENDS, off by default) - TREATMENT OF FRIENDS: when a recorded player scene touches a houseguest, that houseguest's CLOSEST TIES remember it too, smaller and bond-weighted.
 * `minBond` is the closeness a friend needs; the entry's severity is `severity x factor x bond` (so a closer friend remembers more), well under the touched houseguest's own. ASSUMED, pending Ryne.
 */
export const FRIEND_MEMORY = { minBond: 0.55, factor: 0.5 } as const;

/** The severity a friend with this bond to the touched houseguest records (0 when below the closeness bar). Pure; monotone in bond. */
export function friendSeverity(sceneSeverity: number, bond: number): number {
  if (bond < FRIEND_MEMORY.minBond) return 0;
  return clamp01(sceneSeverity * FRIEND_MEMORY.factor * clamp01(bond));
}
