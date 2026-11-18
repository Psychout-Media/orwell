import type { ArchivedHouseguest } from "../engine/seasonMemory";

/**
 * Feature 0208 (Theme B, B1: returning houseguests) - the per-USER archive of the houseguests from seasons this player actually finished. Keyed by the
 * physical-world user (0021), SEPARATE from the per-season `UserSaveStore` so it survives `registry.resetUser` (like 0104's `UserNotorietyStore`).
 * Append-only (non-degradation): `append` never removes or rewrites an entry already on file, and a season is archived at most once.
 *
 * ENGINE-ONLY: an entry holds a returner's own end feelings toward the player and their own claims about the player (hidden layer), so it is NEVER
 * projected. Only the validated, softened carry (`src/engine/returnees.ts`) ever leaves it, and only into the hidden layer of a new cast.
 */
export interface UserSeasonArchive {
  /** This user's archived houseguests, oldest season first (empty for a first-season player). Never another user's. */
  read(user: string): ArchivedHouseguest[];
  /** Add a finished season's entries. A season already on file is ignored (idempotent: a retried reset can not double it). */
  append(user: string, entries: readonly ArchivedHouseguest[]): void;
}
