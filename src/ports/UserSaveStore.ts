import type { SessionSnapshot } from "../engine/sessionSnapshot";

/**
 * Durable, per-user persistence for the LIVE game (feature 0030). Keyed by the
 * authenticated user (0021): user A's reload can only load user A's game, and a
 * user with no save is treated as new (onboarding). A "restart" is a fresh process
 * (new registry) over the SAME durable store — `hasSave`/`loadLatest` recall the
 * game from disk with no in-memory pointer.
 *
 * ENGINE-ONLY: a snapshot carries the house's souls + the hidden relationship
 * layer, so no outward module may import this (enforced by dependency-cruiser,
 * like `VaultStore`/`SoulProvider`).
 */
/** ORW-404: save-sync backlog numbers for `/health` (operational only; no ids, no content). */
export interface SaveDurability {
  saveLatestVersion: number;
  saveDurableVersion: number;
  /** Age (ms) of the oldest save not yet fsynced; 0 when none. */
  saveOldestUnsyncedAgeMs: number;
  saveUnsyncedUsers: number;
  /** True while the reported user's marker is 0 because nothing has been synced yet since boot (not a lag). */
  saveDurabilityPending?: boolean;
}

export interface UserSaveStore {
  /** Persist the user's latest snapshot (a new version; prior versions are never overwritten). */
  saveFor(user: string, snapshot: SessionSnapshot): void;
  /** Whether a durable save exists for this user (drives load-on-resume vs fresh onboarding). */
  hasSave(user: string): boolean;
  /** The user's latest durable snapshot, or null if they have none. */
  loadLatest(user: string): SessionSnapshot | null;
  /** The users with durable saves (B60/audit E11) — lets the runtime preload at boot. Optional. */
  listUsers?(): string[];
  /**
   * A season RESTART (audit E1/D1/R1): retire the user's saves off the live path so `hasSave` is
   * false and the new season's history starts clean — an engine restart must resume season 2,
   * never resurrect the dead one. Implementations ROTATE rather than destroy (non-degradation:
   * the retired season's record stays on disk for inspection). Optional.
   */
  resetUser?(user: string): void;
  /**
   * PERS-NEW-2 (#592): a quarantine belt PARALLEL to the corrupt-quarantine, for a save that PARSED
   * fine but was REJECTED by the resume (a future/incompatible `snapshotVersion`). Rename the newest
   * version off the `vNNNNNN.json` path (`.incompatible`) so the fresh sandbox's later saves can never
   * prune the user's own higher-schema save out of retention — it stays on disk, recoverable on a
   * downgrade. Best-effort; a no-op when no save exists. Optional.
   */
  quarantineIncompatible?(user: string): void;
  /** ORW-404: the fsync backlog (stores that fsync in the background). Optional. */
  durability?(): SaveDurability;
  /** ORW-404: synchronously harden every un-synced save before exit, bounded by `timeoutMs`. Optional. */
  flushDurable?(timeoutMs?: number): void;
  /** ORW-404: non-blocking shutdown flush (async fsync, resolves by `timeoutMs` even if a sync never settles). Optional. */
  flushDurableAsync?(timeoutMs?: number): Promise<void>;
}
