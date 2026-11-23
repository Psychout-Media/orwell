import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";
import type { Goal } from "../../src/engine/agenda";
import { urgency } from "../../src/engine/desireClock";
import { sessionCoreSupersetViolation } from "../../src/engine/sessionSnapshot";

/**
 * ORW-709 (B3-3/4/5 and the approach treadmill). UNIT checks only: the pure press curve and the save superset guard (on a hand-staged house and hand-made saves). ORW-812: the
 * played checks are in tests/uat/realPathApproachBrake.test.ts. Roles only.
 * B3-3: hidden scheming about the player to a third party is never an open scene. B3-4: only a genuinely hostile approach folds a fight; a kind answer folds none.
 * B3-5 / treadmill: a houseguest asks a question once (answered or awaiting), stays with the player until the answer lands, and the Diary Room is private.
 */
type Rec = { id: string; actor: string; hostile: boolean; status: string; eventId?: string; goalId: string };
type Seam = {
  livingIds(): EntityId[]; noteMessage(a: object): unknown; houseLifeStretch(events: unknown, awake: readonly EntityId[], i: number): unknown[];
  aimedAtPlayerTick(events: unknown): void; setPlayerAimedEnabled(on: boolean): void; setGroupRolesEnabled(on: boolean): void; createCharacter(a: object): unknown;
  notePlayerTalk(withIds: readonly EntityId[], kind: string | undefined, named: EntityId | undefined): void;
  noteAimedStep(p: object, hostile: boolean, day: number): void; markAimedShown(npc: EntityId, goalId?: string): void;
  desireApproach(ids: EntityId[]): { npc: EntityId; desire: string; q?: string } | null;
  presence: Map<EntityId, string>;
  rel: { edge(a: EntityId, b: EntityId): { affinity: number; trust: number; threat: number } };
  live: { week: number; dayNumber?: number; nightDepth?: number; aimedAtPlayer?: Rec[]; goalApproaches?: Record<string, unknown>; agendas?: Record<string, { goals: Goal[] }>; interruption?: { npc: EntityId; desire: string; atHour: number }; approachAsked?: Record<string, { q: string; week: number; n: number; shownAt: number; answered?: true }> };
};
let n = 0;
function stage(seed: number) {
  const sb = new GameSessionRegistry().sandboxFor(`orw709-${n++}`);
  const s = sb.session as unknown as Seam;
  s.createCharacter({ playerName: "The Player", seed });
  s.setPlayerAimedEnabled(true); s.setGroupRolesEnabled(true); s.noteMessage({ messageId: "m1" });
  const ids = s.livingIds().filter((i) => i !== PLAYER);
  const holder = ids[0]!;
  s.live.agendas![holder]!.goals.push({ id: `${holder}:week:get-them-out:d1`, owner: holder, horizon: "week", kind: "get-them-out", target: PLAYER, why: [{ kind: "character", weight: 1 }], test: { kind: "survives-week" }, commitment: 1, status: "active", formedDay: 1, formedWeek: s.live.week } as unknown as Goal);
  for (const id of [...s.presence.keys()]) s.presence.set(id, "backyard");
  s.presence.set(PLAYER, "kitchen"); s.presence.set(holder, "backyard");
  const e = s.rel.edge(holder, PLAYER); e.trust = 0.1; e.affinity = 0.1; e.threat = 0.9;
  return { sb, s, holder, awake: [...ids.slice(0, 4), PLAYER] as EntityId[] };
}
const goalOf = (h: string) => `${h}:week:get-them-out:d1`;
const step = (h: string) => ({ actor: h, goalId: goalOf(h), goalKind: "get-them-out", kind: "confront", with: [PLAYER] });

describe("B3-5 / the approach treadmill (unit: a pure clock read, and a save-format guard on a hand-staged house)", () => {
  it("their wish to press rises slower each time in a week (a pure clock read)", () => {
    const base = { desire: "plea" as const, drive: 0.4, hoursUntil: 1, hoursSinceApproach: undefined };
    const u = [0, 1, 2, 3].map((presses) => urgency({ ...base, presses }));
    for (let k = 1; k < u.length; k++) expect(u[k]!).toBeLessThan(u[k - 1]!);
    expect(urgency(base)).toBe(u[0]); // no presses: unchanged
  });

  it("the asked-question store is superset-guarded: a restore cannot reopen a closed question, and an old save without it loads", () => {
    const { sb, s, holder } = stage(11);
    s.live.approachAsked = { [holder]: { q: "plea:x:1", week: s.live.week, n: 1, shownAt: 0, answered: true } };
    const later = JSON.parse(JSON.stringify(sb.session.snapshot()));
    const earlier = JSON.parse(JSON.stringify(later)); delete earlier.live.approachAsked;
    expect(sessionCoreSupersetViolation(later as never, earlier as never)).toBeNull();
    const reopened = JSON.parse(JSON.stringify(later)); reopened.live.approachAsked[holder].answered = undefined;
    expect(sessionCoreSupersetViolation(reopened as never, later as never)).toBe("approachAsked");
    const gone = JSON.parse(JSON.stringify(later)); delete gone.live.approachAsked;
    expect(sessionCoreSupersetViolation(gone as never, later as never)).toBe("approachAsked");
    const sb2 = new GameSessionRegistry().sandboxFor("orw709-old"); sb2.session.restore(earlier);
    expect((sb2.session as unknown as Seam).live.approachAsked).toBeUndefined();
  });
});
