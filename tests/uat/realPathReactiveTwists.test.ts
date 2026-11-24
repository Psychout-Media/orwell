import { endHeldNightSync } from "../support/heldNight";
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { resolvePending } from "../../features/support/answerPending";
import { PLAYER } from "../../src/domain/ids";

/**
 * Reactive twists ON (PO ruling 2026-11-03) — the PLAYER-PATH e2e for each twist, through the real session seam (advanceGame / submitDecision) under the
 * full deployed profile, on each season's OWN sealed twist plan (ORW-813: the plan is never overridden; tests/property/reactiveTwistsPlayerPaths.property.test.ts
 * forces it early for breadth). Many seasons are played (a headless player: every card answered, held nights lived); every season must render its cards,
 * resolve, never freeze, and still close at a jury of EXACTLY 9 and a Final 2. HEAVY LANE (tests/uat/**, the `real-path` leg): about 1.5 s a season.
 *  • double eviction: the player is a nominee / a voter in the double-eviction week;
 *  • battle-back: the player is an evicted juror in the recent window — competes, and (when they win) RE-ENTERS and plays on;
 *  • secret veto: the player holds it and plays or declines it (the unit/e2e gates cover the card; here: the full-season seam).
 * Roles only.
 */
const profile = execFileSync("bash", ["-c", 'source "$1" && orwell_optin_env_defaults "$2"', "_", "deploy/orwell-env-defaults.sh", "/nonexistent/orwell-data"], { encoding: "utf8" })
  .split("\n").map((l) => l.trim()).filter(Boolean)
  .map((l) => { if (!/^ORWELL_[A-Z0-9_]+=\S+$/.test(l)) throw new Error(`unexpected line from orwell_optin_env_defaults: ${l}`); return l; })
  .filter((l) => !/^ORWELL_(EMBEDDINGS|EMBED_CACHE)=/.test(l));
if (profile.length < 20) throw new Error(`the deployed flag profile did not load (${profile.length} flags)`);
for (const line of profile) { const i = line.indexOf("="); process.env[line.slice(0, i)] = line.slice(i + 1); }
process.env.ORWELL_REACTIVE_TWISTS = "1";
const { GameSessionRegistry } = await import("../../src/composition/registry");

interface Plan { doubleEvictionAtActive: number; doubleEvictionArmed: boolean; secretVetoStreak: number; secretVetoArmed: boolean; battleBackAtJury: number; battleBackArmed: boolean }

/** A season as the seed deals it: its own sealed twist plan. */
function newGame(seed: number) {
  const s = new GameSessionRegistry().sandboxFor(`rp-${seed}`).session; // ORW-852: a fixed name per seed (each call builds its own registry)
  s.createCharacter({ playerName: "P", seed });
  return s;
}

interface Trace { seed: number; finished: boolean; jury: number; finalTwo: number; fired: string[]; steps: number; events: string[]; plan: Plan }

/** Play to the end answering every card; call `watch` after each step with the live state. */
function play(seed: number, watch?: (live: any, v: any, s: any) => void, secretVetoUse = false): Trace {
  const s = newGame(seed);
  const plan = (s.snapshot().live as any).twistPlan as Plan;
  let finished = false, i = 0;
  const events: string[] = [];
  let stall = 0, lastSeq = -1;
  for (; i < 9000; i++) {
    const v = s.advanceGame();
    if (v.held) endHeldNightSync(s); // ORW-116: a held night is the player's: time passes, then they turn in
    if (v.pending) {
      if (v.pending.kind === "secret-veto") s.submitDecision({ kind: "secret-veto", use: secretVetoUse });
      else resolvePending(v.pending, (req) => void s.submitDecision(req));
    }
    const live = s.snapshot().live as any;
    watch?.(live, v, s);
    const sig = JSON.stringify([live.week, live.beat, live.active.length, live.evictionOrder.length, !!live.pending, live.finished]);
    stall = sig === String(lastSeq) ? stall + 1 : 0; lastSeq = sig as never;
    expect(stall, `seed ${seed}: the game is not frozen at ${sig}`).toBeLessThan(40);
    if (v.finished) { finished = true; break; }
  }
  const live = s.snapshot().live as any;
  return { seed, finished, jury: (live.jury ?? []).length, finalTwo: (live.finalTwo ?? []).length, fired: (live.firedTwists ?? []).map((t: any) => t.kind), steps: i, events, plan };
}

describe("double eviction — the player is a nominee / a voter in the double-eviction week", () => {
  it("fires on every season whose own plan arms it, renders the player's cards, resolves, and the season closes at jury 9 / Final 2 (30 seeds)", () => {
    let sawPlayerNominee = 0, sawPlayerVoteInTwistWeek = 0, fired = 0, armed = 0;
    for (let seed = 1; seed <= 30; seed++) {
      let twistWeek: number | undefined;
      const kindsInTwistWeek: string[] = [];
      let playerNomineeInTwist = false;
      const r = play(seed, (live, v) => {
        const fired = (live.firedTwists ?? []).find((t: any) => t.kind === "double-eviction");
        if (fired && twistWeek === undefined) twistWeek = fired.beat;
        if (live.twist && live.twist.kind === "double-eviction") {
          if ((live.finalNominees ?? []).includes(PLAYER)) playerNomineeInTwist = true;
          if (v.pending) kindsInTwistWeek.push(v.pending.kind);
        }
      });
      expect(r.finished, `seed ${seed} finished`).toBe(true);
      expect(r.jury, `seed ${seed}: jury of 9`).toBe(9);
      expect(r.finalTwo, `seed ${seed}: Final 2`).toBe(2);
      if (r.fired.includes("double-eviction")) fired++;
      if (r.plan.doubleEvictionArmed) { armed++; expect(r.fired, `seed ${seed}: its plan armed the double eviction`).toContain("double-eviction"); }
      if (playerNomineeInTwist) sawPlayerNominee++;
      if (kindsInTwistWeek.includes("eviction-vote")) sawPlayerVoteInTwistWeek++;
    }
    // eslint-disable-next-line no-console
    console.log(`DOUBLE EVICTION (own plans, 30 seeds): armed ${armed}; fired ${fired}; player was a nominee in ${sawPlayerNominee}; player was asked to vote in the twist cycle in ${sawPlayerVoteInTwistWeek}`);
    expect(fired).toBeGreaterThan(10);
    expect(sawPlayerNominee, "the player was a nominee in some twist week").toBeGreaterThan(0);
    expect(sawPlayerVoteInTwistWeek, "the player was asked to vote in the twist cycle").toBeGreaterThan(0);
  }, 600_000);
});

describe("battle-back — the player is an evicted juror in the recent window", () => {
  it("competes; when the player WINS they re-enter and play on; either way jury 9 / Final 2 and nothing freezes (own plans, scan up to 240 seeds)", () => {
    let inField = 0, playerWon = 0, playerLost = 0;
    const problems: string[] = [];
    for (let seed = 1; seed <= 240 && (playerWon < 3 || playerLost < 2); seed++) {
      let before: string[] | undefined;
      let spectatorAfterReturn: unknown;
      let fireSeen = false, playerReturned = false, statusAfter: string | undefined, kindsAfter: string[] = [];
      let prevFired = 0;
      const r = play(seed, (live, v, s) => {
        const fired = (live.firedTwists ?? []).filter((t: any) => t.kind === "battle-back").length;
        if (!fireSeen && fired > prevFired) {
          fireSeen = true;
          // the field was the last four evictions BEFORE the fire; the winner was removed from the record
          before = before ?? [];
          playerReturned = live.active.includes(PLAYER) && (before.includes(PLAYER));
          statusAfter = s.getGameState().player?.status;
          spectatorAfterReturn = live.spectator;
        } else if (!fireSeen) {
          before = live.evictionOrder.slice(-4);
        }
        prevFired = fired;
        if (fireSeen && playerReturned && v.pending) kindsAfter.push(v.pending.kind);
      });
      if (!r.finished || r.jury !== 9 || r.finalTwo !== 2) problems.push(`seed ${seed}: finished=${r.finished} jury=${r.jury} finalTwo=${r.finalTwo}`);
      if (fireSeen && before?.includes(PLAYER)) {
        inField++;
        if (playerReturned) {
          playerWon++;
          if (spectatorAfterReturn) problems.push(`seed ${seed}: player re-entered but live.spectator is still ${JSON.stringify(spectatorAfterReturn)} (the engine would keep fast-forwarding them)`);
          if (statusAfter !== "active") problems.push(`seed ${seed}: player re-entered but status is ${String(statusAfter)}`);
          if (!kindsAfter.length) problems.push(`seed ${seed}: player re-entered but was never given a card again`);
        } else playerLost++;
      }
    }
    // eslint-disable-next-line no-console
    console.log(`BATTLE-BACK (own plans): player in the field ${inField}; player won+re-entered ${playerWon}; player lost ${playerLost}; problems: ${JSON.stringify(problems.slice(0, 6))}`);
    expect(problems).toEqual([]);
    expect(inField).toBeGreaterThan(0);
    expect(playerWon, "the player WON and re-entered on at least one seed").toBeGreaterThan(0);
  }, 900_000);
});

describe("secret veto — the player holds it, and plays or declines it", () => {
  it("granted to the player on some seeds: the card is raised when they are on the block, it resolves, jury 9 / Final 2 (own plans, scan up to 120 seeds)", () => {
    let held = 0, cardRaised = 0, played = 0, anyFired = 0;
    const problems: string[] = [];
    for (let seed = 1; seed <= 120 && (played < 1 || held < 4 || cardRaised < 3); seed++) {
      let playerHolds = false, sawCard = false, wasUsed = false;
      const r = play(seed, (live, v) => {
        if (live.secretVeto?.holder === PLAYER) playerHolds = true;
        if (v.pending?.kind === "secret-veto") sawCard = true;
        if (live.secretVeto?.holder === PLAYER && live.secretVeto.used) wasUsed = true;
      }, seed % 2 === 0); // even seeds: the player PLAYS it; odd seeds: the player HOLDS it
      if (!r.finished || r.jury !== 9 || r.finalTwo !== 2) problems.push(`seed ${seed}: finished=${r.finished} jury=${r.jury} finalTwo=${r.finalTwo}`);
      if (r.fired.includes("secret-veto")) anyFired++;
      if (playerHolds) { held++; if (sawCard) cardRaised++; if (wasUsed) played++; }
    }
    // eslint-disable-next-line no-console
    console.log(`SECRET VETO (own plans): player held it on ${held} seeds; the card was raised on ${cardRaised}; the player played it on ${played}; an NPC/anyone fired it on ${anyFired}; problems: ${JSON.stringify(problems.slice(0, 5))}`);
    expect(problems).toEqual([]);
    expect(held).toBeGreaterThan(0);
  }, 900_000);
});
