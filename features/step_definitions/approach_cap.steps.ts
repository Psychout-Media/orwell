import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { GameSessionRegistry } from "../../src/composition/registry";
import { DESIRE } from "../../src/engine/desireClock";
import type { SessionCore } from "../../src/engine/sessionSnapshot";
import { resolvePending } from "../support/answerPending";

/**
 * ORW-423 (#2736) + ORW-443 (#2769), feature 0012 (NPC-initiated approaches; 0036 is spec-only, not wired) - the same-purpose approach cap. In a PLAYED game with the desire clock on, after
 * `DESIRE.streakCap` approaches of one purpose in a stretch, the next one of that purpose is held back (no houseguest cuts in) and the game
 * state carries `approachHeld: true` for that turn only. Drives the REAL adapter through its public per-message clock
 * (`advanceClockPerConversation`); roles only.
 *
 * TEST-ONLY seam on `live` (as in tests/unit/approachStreakCap.test.ts): `playedGame` is set directly (a person playing sets it through the
 * message path), and the alternative-history scenarios restore the snapshot taken just before the held turn and rewrite `approachStreak`
 * (an older last approach, or a different purpose) before replaying that one turn. The approach pick uses no rng, so the replay is exact.
 */
type Streak = { desire: string; count: number; lastHour: number };
type Live = { playedGame?: boolean; approachStreak?: Streak; interruption?: { npc: string; desire: string }; desireApproachedAt?: Record<string, number>; approachHeld?: true; hoh?: string };
type View = { approachHeld?: boolean; interruption?: { npc: string; desire: string }; daySchedule?: { due: boolean }; pending?: unknown };
type Turn = { stamped: boolean; interruption?: string; held: boolean };
type Bag = { s?: GameSessionAdapter; seed?: number; before?: SessionCore; heldStreak?: Streak; turns: Turn[]; replay?: { view: View; streak?: Streak } };
const bag = (w: unknown): Bag => ((w as { cap450?: Bag }).cap450 ??= { turns: [] });
const live = (s: GameSessionAdapter): Live => (s as unknown as { live: Live }).live; // TEST-ONLY seam (see above)
const view = (s: GameSessionAdapter): View => s.getGameState() as unknown as View;
let n = 0;

function fresh(seed: number): GameSessionAdapter {
  GameSessionAdapter.setTimeOfDayEnabled(true); // reset after every scenario by features/support/resetStaticOverrides.ts
  const s = new GameSessionRegistry().sandboxFor(`cap450-${n++}`).session as GameSessionAdapter;
  s.createCharacter({ playerName: "The Player", seed });
  s.setPerConversationClockEnabled(true); s.setHangOutEnabled(true); s.setDesireClockEnabled(true);
  return s;
}
/** Advance the season to a day whose next event is not yet due, nothing pending, nobody cutting in, an HOH reigning. */
function parked(seed: number): GameSessionAdapter | null {
  const s = fresh(seed);
  for (let i = 0; i < 600; i++) {
    const v = s.advanceGame();
    if (v.pending) resolvePending(v.pending, (req) => void s.submitDecision(req));
    const st = view(s);
    if (st.daySchedule && st.daySchedule.due === false && !st.pending && live(s).interruption === undefined && live(s).hoh !== undefined) return s;
  }
  return null;
}
/** One player message: the clock steps and the desire clock may bring a houseguest over. */
function turn(s: GameSessionAdapter): Turn {
  const before = JSON.stringify(live(s).desireApproachedAt ?? {});
  s.advanceClockPerConversation();
  const v = view(s);
  return { stamped: JSON.stringify(live(s).desireApproachedAt ?? {}) !== before, interruption: v.interruption?.desire, held: v.approachHeld === true };
}

Given("a played game with the desire clock on, stepped message by message until the approach cap holds a houseguest back", function () {
  const b = bag(this);
  for (const seed of [3, 5, 8, 11, 13]) {
    const s = parked(seed); if (!s) continue;
    live(s).playedGame = true;
    const turns: Turn[] = [];
    for (let i = 0; i < 120; i++) {
      const pre = s.snapshot(); const streak = live(s).approachStreak;
      const t = turn(s); turns.push(t);
      // held = a houseguest's want was spent this message (the cooldown stamp) but nobody cut in
      if (t.stamped && t.interruption === undefined) {
        Object.assign(b, { s, seed, before: structuredClone(pre), heldStreak: structuredClone(streak), turns });
        return;
      }
      if (view(s).daySchedule?.due) break;
    }
  }
  throw new Error("no seed reached a message on which the cap held an approach back (is the cap applied at all?)");
});

Then("the two approaches just before it in that stretch were for the same purpose", function () {
  const b = bag(this); const st = b.heldStreak!;
  assert.ok(st, "no running streak was recorded before the held message");
  assert.equal(st.count, DESIRE.streakCap, "the cap held before the streak reached its size");
  const shown = b.turns.slice(0, -1).filter((t) => t.interruption !== undefined).map((t) => t.interruption!);
  assert.ok(shown.length >= DESIRE.streakCap, `fewer than ${DESIRE.streakCap} approaches came before the held one: ${shown.join(",")}`);
  assert.deepEqual(shown.slice(-DESIRE.streakCap), Array(DESIRE.streakCap).fill(st.desire), `the last approaches were ${shown.join(",")}`);
});

Then("no houseguest cuts into the conversation on that message", function () {
  const s = bag(this).s!;
  assert.equal(view(s).interruption, undefined);
});

Then("the game state tells the narrator an approach was held back", function () {
  const v = view(bag(this).s!);
  assert.equal(v.approachHeld, true, "approachHeld is not set on the held message");
  assert.equal(JSON.stringify(v.approachHeld), "true", "approachHeld carries more than a flag");
});

When("the player keeps talking until a message on which nothing is held back", function () {
  const b = bag(this); const s = b.s!;
  for (let i = 0; i < 40; i++) {
    const t = turn(s); b.turns.push(t);
    if (!(t.stamped && t.interruption === undefined)) return;
  }
  throw new Error("every following message was held back too");
});

Then("the game state no longer carries the held-back signal", function () {
  const v = view(bag(this).s!);
  assert.equal("approachHeld" in v, false, "approachHeld outlived the message it belonged to");
});

When(/^that same message is replayed (as though the last approach came two quiet in-game hours earlier|as though the stretch so far had been a different purpose|in a game nobody is playing)$/, function (variant: string) {
  const b = bag(this); const s = b.s!; const st = b.heldStreak!;
  // Sanity: the unchanged replay is held again (the pick is deterministic), so any difference below is the variant's.
  s.restore(structuredClone(b.before!));
  const control = turn(s);
  assert.ok(control.stamped && control.interruption === undefined && control.held, "replaying the held message unchanged did not hold it again");
  s.restore(structuredClone(b.before!));
  if (variant.startsWith("as though the last approach")) live(s).approachStreak = { ...st, lastHour: st.lastHour - DESIRE.streakQuietHours };
  else if (variant.startsWith("as though the stretch")) live(s).approachStreak = { ...st, desire: Object.keys(DESIRE.weight).find((d) => d !== st.desire)! };
  else live(s).playedGame = false; // TEST-ONLY seam: a headless/simulated game
  const streakBefore = structuredClone(live(s).approachStreak);
  s.advanceClockPerConversation();
  b.replay = { view: view(s), streak: streakBefore };
});

Then("the held houseguest now cuts into the conversation for that purpose", function () {
  const b = bag(this);
  assert.equal(b.replay!.view.interruption?.desire, b.heldStreak!.desire, "the approach was still held back");
});

Then("the game state carries no held-back signal", function () {
  assert.equal("approachHeld" in bag(this).replay!.view, false);
});

Then("the stretch is left untouched", function () {
  const s = bag(this).s!;
  assert.deepEqual(live(s).approachStreak, bag(this).replay!.streak, "a game nobody is playing wrote to the approach streak");
});
