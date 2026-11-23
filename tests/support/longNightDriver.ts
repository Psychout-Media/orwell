import { GameSessionRegistry } from "../../src/composition/registry";
import type { Any } from "./longNightPlay";
export * from "./longNightPlay";

/**
 * ORW-652: the double-eviction night driver for UNIT tests. `bootPlayed` arms the double eviction at the first roll by replacing the sealed plan through the snapshot seam (a hand-set
 * state: the real-path guard forbids importing this module in tests/realpath); the playing half lives in `./longNightPlay` and is re-exported. Roles only.
 */
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
