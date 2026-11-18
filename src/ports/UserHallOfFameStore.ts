import type { HallRecord } from "../engine/hallOfFame";

/**
 * 0208 B3 - per-USER hall of fame (like 0104's `UserNotorietyStore`): keyed to the physical-world user, SEPARATE from the per-season save so it survives
 * `registry.resetUser`, never a cross-user read. `append` is a monotonic merge (a stored season is never changed or dropped: non-degradation). Holds only facts the
 * finished season's retrospective unsealed to the player; no Vault record, no hidden edge.
 */
export interface UserHallOfFameStore {
  read(user: string): HallRecord[];
  append(user: string, record: HallRecord): void;
}
