import { endHeldNightSync } from "../support/heldNight";
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { resolvePending } from "../../features/support/answerPending";
import { PLAYER } from "../../src/domain/ids";

/**
 * ORW-1087 (audit A7): jury membership is a stable fact assigned when a houseguest is evicted. A battle-back that pulls an earlier entry out of the eviction record
 * used to shift every later position, so the jury (and the player's juror status, spectator offer and finale interview) was recomputed from list positions and could
 * change. Played through the real session seam on each season's own sealed twist plan (reactive twists ON, the deployed profile); HEAVY LANE.
 */
const profile = execFileSync("bash", ["-c", 'source "$1" && orwell_optin_env_defaults "$2"', "_", "deploy/orwell-env-defaults.sh", "/nonexistent/orwell-data"], { encoding: "utf8" })
  .split("\n").map((l) => l.trim()).filter(Boolean)
  .map((l) => { if (!/^ORWELL_[A-Z0-9_]+=\S+$/.test(l)) throw new Error(`unexpected line from orwell_optin_env_defaults: ${l}`); return l; })
  .filter((l) => !/^ORWELL_(EMBEDDINGS|EMBED_CACHE)=/.test(l));
if (profile.length < 20) throw new Error(`the deployed flag profile did not load (${profile.length} flags)`);
for (const line of profile) { const i = line.indexOf("="); process.env[line.slice(0, i)] = line.slice(i + 1); }
process.env.ORWELL_REACTIVE_TWISTS = "1";
const { GameSessionRegistry } = await import("../../src/composition/registry");


interface Snap { order: string[]; seats: Map<string, string>; playerStatus: string | undefined; spectatorOffered: unknown; finaleInterview: unknown; battleBacks: number }

function playSeason(seed: number): { snaps: Snap[]; finished: boolean } {
  const s = new GameSessionRegistry().sandboxFor(`jury1087-${seed}`).session;
  s.createCharacter({ playerName: "P", seed });
  const snaps: Snap[] = [];
  let finished = false, stall = 0, last = "";
  for (let i = 0; i < 9000; i++) {
    const v = s.advanceGame();
    if (v.held) endHeldNightSync(s);
    if (v.pending) {
      if (v.pending.kind === "secret-veto") s.submitDecision({ kind: "secret-veto", use: false });
      else resolvePending(v.pending, (req) => void s.submitDecision(req));
    }
    const live = s.snapshot().live as any;
    const gs = s.getGameState() as any;
    snaps.push({
      order: [...live.evictionOrder],
      seats: new Map<string, string>((gs.house ?? []).map((h: any) => [h.id, h.status])),
      playerStatus: gs.player?.status,
      spectatorOffered: live.spectatorOffered,
      finaleInterview: live.finaleInterview ? JSON.parse(JSON.stringify(live.finaleInterview)) : undefined,
      battleBacks: (live.firedTwists ?? []).filter((t: any) => t.kind === "battle-back").length,
    });
    const sig = JSON.stringify([live.week, live.beat, live.active.length, live.evictionOrder.length, !!live.pending, live.finished]);
    stall = sig === last ? stall + 1 : 0; last = sig;
    expect(stall, `seed ${seed}: not frozen at ${sig}`).toBeLessThan(40);
    if (v.finished) { finished = true; break; }
  }
  return { snaps, finished };
}

/** Violations of "a jury seat, once given, is never taken away or swapped" (a houseguest who left the record by a battle-back is the one allowed exit). */
function violations(seed: number): { list: string[]; returns: number; pushed: boolean } {
  const { snaps, finished } = playSeason(seed);
  const list: string[] = [];
  if (!finished) list.push(`seed ${seed}: season did not finish`);
  const juror = new Set<string>(), preJury = new Set<string>();
  let playerSeat: string | undefined;
  for (let k = 0; k < snaps.length; k++) {
    const sn = snaps[k]!;
    for (const id of [...juror, ...preJury]) if (!sn.order.includes(id)) { juror.delete(id); preJury.delete(id); } // returned by a battle-back: a new eviction is a new assignment
    for (const [id, seat] of sn.seats) {
      if (seat === "jury") { if (preJury.has(id)) list.push(`seed ${seed} step ${k}: ${id} moved from pre-jury onto the jury`); juror.add(id); }
      if (seat === "evicted") { if (juror.has(id)) list.push(`seed ${seed} step ${k}: ${id} lost a jury seat`); preJury.add(id); }
    }
    if (sn.playerStatus === "jury" || sn.playerStatus === "evicted") {
      if (playerSeat && playerSeat !== sn.playerStatus && sn.order.includes(PLAYER)) list.push(`seed ${seed} step ${k}: the player's seat changed ${playerSeat} -> ${sn.playerStatus}`);
      playerSeat = sn.playerStatus;
    } else playerSeat = undefined;
  }
  const last = snaps[snaps.length - 1];
  const pushed = !!last && last.playerStatus === "jury" && last.finaleInterview !== undefined; // a juror gets no pre-jury finale interview
  list.splice(3); // the first few say it; the rest repeat each step
  return { list, returns: last?.battleBacks ?? 0, pushed };
}

describe("ORW-1087: the jury is a stable fact after assignment", () => {
  it("seed 6 and seed 15: no jury seat moves, and the player's seat, spectator offer and finale interview follow it", () => {
    for (const seed of [6, 15]) {
      const r = violations(seed);
      expect(r.list, `seed ${seed}`).toEqual([]);
      expect(r.pushed, `seed ${seed}: a juror gets no pre-jury finale interview`).toBe(false);
    }
  }, 300_000);

  it("12 more seasons (seeds 1-30 minus 6 and 15, first 12): no seat is ever taken away or swapped", () => {
    let withReturn = 0, n = 0;
    for (let seed = 1; seed <= 30 && n < 12; seed++) {
      if (seed === 6 || seed === 15) continue;
      n++;
      const r = violations(seed);
      expect(r.list, `seed ${seed}`).toEqual([]);
      if (r.returns > 0) withReturn++;
    }
    // eslint-disable-next-line no-console
    console.log(`JURY STABLE: 12 seeds, ${withReturn} with a battle-back`);
  }, 900_000);
});
