/**
 * ORW-298 - stage an engine save positioned in the finale, so a browser walk can start there instead of playing a whole season.
 *
 *   npx tsx scripts/stage-finale-snapshot.ts <outDir> <variant>
 *
 * variant: npc      an NPC Final HOH whose eviction ceremony has OPENED (decision step pending), taking the other NPC so the player stays in
 *          player   the crowned Final HOH is the player
 *          evicted  an NPC Final HOH whose eviction ceremony has OPENED with the player as the evictee (decision step pending)
 *          juror    the player was evicted earlier and sits on the jury; an NPC is the crowned Final HOH
 * The save is the engine's own FileSaveStore format under the user key "default" (what the HTTP engine routes an unheadered call to).
 * It is Vault-bearing engine state (the engine's own save), so it is generated at test time and never committed. Prints the seed used. Roles only.
 */
import { mkdirSync } from "node:fs";
import { FileSaveStore } from "../src/adapters/engine/FileSaveStore";
import { GameSessionRegistry } from "../src/composition/registry";
import { PLAYER } from "../src/domain/ids";
import { isPreJuryEvictee } from "../src/engine/liveSeason";
import { resolvePending } from "../features/support/answerPending";

type Any = Record<string, any>;
const [outDir, variant] = process.argv.slice(2);
if (!outDir || !["npc", "player", "evicted", "juror"].includes(variant ?? "")) throw new Error("usage: stage-finale-snapshot.ts <outDir> <npc|player|evicted|juror>");
const USER = "default";

const open = (d: string): Any => new GameSessionRegistry(new FileSaveStore(d)).sandboxFor(USER).session as unknown as Any;

/** Drive until the Final HOH is crowned (beat final-eviction, nothing pending); `wantPlayerIn` picks the player-in-Final-3 vs player-on-the-jury seasons. */
function drive(s: Any, wantPlayerIn: boolean): boolean {
  for (let i = 0; i < 9000; i++) {
    const live = s.live as Any;
    if (live.finished) return false;
    if (live.beat === "final-eviction" && !live.pending && !live.ceremony) {
      const inn = live.active.includes(PLAYER);
      return wantPlayerIn ? inn : !inn && live.evictionOrder.includes(PLAYER) && !isPreJuryEvictee(live, PLAYER);
    }
    const v = s.advanceGame();
    if (v.pending) resolvePending(v.pending, (r: any) => void s.submitDecision(r));
  }
  return false;
}

for (let seed = 1; seed <= 40; seed++) {
  const d = `${outDir}/s${seed}`;
  mkdirSync(d, { recursive: true });
  const s = open(d);
  s.createCharacter({ playerName: "P", seed });
  s.setFinalHohThreePartEnabled(true);
  s.noteMessage({ messageId: "m1" }); // the played-game flag (live.playedGame)
  s.scheduleGateBypass = true;
  if (!drive(s, variant !== "juror")) continue;
  const live = s.live as Any;
  const others = live.active.filter((h: string) => h !== PLAYER);
  live.hoh = variant === "player" ? PLAYER : others[0];
  if (variant === "evicted" || variant === "npc") {
    s.advanceGame(); // the ceremony opens (decision step); the evictee is decided once, at the opening
    live.ceremony.finalEvictee = variant === "evicted" ? PLAYER : others[1]; // npc: the rival the Final HOH does not take, so the player stays in (a deterministic walk)
  }
  if (variant === "player" || variant === "juror") {
    // The crowned Final HOH is not DUE yet (the day clock: ~115 min of the afternoon). Spend the player's own messages (5 in-game minutes each) until the schedule says it is due, so the browser's first
    // advance opens the ceremony - the real order (the player chats until the event comes due) without making every walk type ~23 lines.
    for (let i = 0; i < 400 && !s.getGameState().daySchedule?.due; i++) s.noteMessage({ messageId: `clock${i}` });
    if (!s.getGameState().daySchedule?.due) throw new Error("the staged Final HOH never came due");
  }
  s.noteMessage({ messageId: "m2" }); // a committed mutation, so the registry saves the staged state
  const back = open(d).live as Any; // prove the save round-trips the staging
  if (back.hoh !== live.hoh) throw new Error("the staged HOH was not persisted");
  if (variant === "evicted" && back.ceremony?.finalEvictee !== PLAYER) throw new Error("the staged ceremony was not persisted");
  console.log(JSON.stringify({ dir: d, seed, variant }));
  process.exit(0);
}
throw new Error("no seed in 1..40 produced the requested staging");
