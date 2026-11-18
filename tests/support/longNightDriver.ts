import { GameSessionRegistry } from "../../src/composition/registry";

/**
 * ORW-652: a played-game driver for the double-eviction night. It arms the double eviction at the first roll (the sealed plan is replaced through the snapshot seam), then plays like a person:
 * answers every pending, hangs out (messages) through a schedule hold and turns in through a night hold. Roles only. Returns one row per advance so a test can read the whole night.
 */
type Any = Record<string, any>;

export interface NightRow {
  i: number; week: number; day: number; hour: number; timeOfDay: string; beat: string; twist: string; active: number; evicted: number; hoh: string | undefined;
  nominees: string[]; event: string | undefined; pending: string | undefined; held: Any | undefined;
}
export interface NightRun { session: Any; rows: NightRow[]; fired: boolean; holdsInNight: Any[]; playerRoles: Set<string>; }

export function answer(s: Any, p: Any): Any {
  switch (p.kind) {
    case "nominations": return s.submitDecision({ kind: "nominations", choice: [p.options[0].id, p.options[1].id] });
    case "veto-decision": return s.submitDecision({ kind: "veto-decision", use: false });
    case "comp-intent": return s.submitDecision({ kind: "comp-intent", intent: "compete" });
    case "comp-round": return s.submitDecision({ kind: "comp-round", intent: "compete" });
    case "houseguests-choice": return s.submitDecision({ kind: "houseguests-choice", vote: p.options[0].id });
    case "replacement": return s.submitDecision({ kind: "replacement", replacement: p.options[0].id });
    case "secret-veto": return s.submitDecision({ kind: "secret-veto", use: true });
    case "goodbye-message": return s.submitDecision({ kind: "goodbye-message", vote: p.options[0].id });
    case "ceremony-step": return s.advanceGame();
    default: return s.submitDecision({ kind: p.kind, vote: p.options?.[0]?.id });
  }
}

const rowOf = (s: Any, i: number, v: Any): NightRow => {
  const L = s.live;
  return { i, week: L.week, day: L.dayNumber, hour: L.nightDepth ?? -1, timeOfDay: L.timeOfDay, beat: L.beat, twist: L.twist?.phase ?? "-", active: L.active.length, evicted: L.evictionOrder.length, hoh: L.hoh, nominees: [...(L.finalNominees ?? L.nominees ?? [])], event: v.event?.beat, pending: v.pending?.kind, held: v.held };
};

export function bootPlayed(seed: number, longNight: boolean, activeAt = 12): Any {
  const s = new GameSessionRegistry().sandboxFor(`ln-${seed}-${longNight ? "on" : "off"}`).session as unknown as Any;
  s.setLongNightEnabled(longNight);
  s.createCharacter({ playerName: "P", seed });
  s.noteMessage({ messageId: "m0" });
  const core = s.snapshot();
  core.live.twistPlan = { doubleEvictionAtActive: activeAt, doubleEvictionArmed: true, secretVetoStreak: 9, secretVetoArmed: false, battleBackAtJury: 9, battleBackArmed: false };
  s.restore(core);
  return s;
}

/** Hang out until the held advance lifts (a schedule hold), or turn in (a night hold). */
function passHold(s: Any, v: Any, tag: string): void {
  if (v.held?.reason === "schedule") { for (let k = 0; k < 400; k++) { s.noteMessage({ messageId: `n${tag}-${k}` }); if (!s.advanceGame().held) return; } }
  else s.turnIn();
}

/** Play until the double eviction has fired (or `stopAt` returns true after an advance). */
export function playNight(s: Any, stopAt?: (row: NightRow) => boolean): NightRun {
  const rows: NightRow[] = []; const holdsInNight: Any[] = []; const playerRoles = new Set<string>();
  let fired = false;
  for (let i = 0; i < 3000 && !fired; i++) {
    const v = s.advanceGame();
    const row = rowOf(s, i, v);
    rows.push(row);
    const L = s.live;
    if (L.twist?.phase === "running") {
      if (v.held) holdsInNight.push(v.held);
      if (L.hoh === "player") playerRoles.add("hoh");
      if ((L.finalNominees ?? L.nominees ?? []).includes("player")) playerRoles.add("nominee");
    }
    if (v.pending) answer(s, v.pending);
    if (v.held) passHold(s, v, String(i));
    if ((L.firedTwists ?? []).some((t: Any) => t.kind === "double-eviction")) fired = true;
    if (stopAt?.(row)) break;
    if (v.finished) break;
  }
  return { session: s, rows, fired, holdsInNight, playerRoles };
}

/** The night's span: the rows from the first running-twist row to the second eviction's close. */
export const nightRows = (r: NightRun): NightRow[] => r.rows.filter((x) => x.twist === "running");

/** Who got evicted, in order, and every HOH, over the whole run: the outcome fingerprint neutrality compares. */
export function outcomeFingerprint(r: NightRun): string {
  const hohs = [...new Set(r.rows.filter((x) => x.hoh).map((x) => `${x.week}:${x.hoh}`))];
  return JSON.stringify({ evictionOrder: r.session.live.evictionOrder, hohs });
}
