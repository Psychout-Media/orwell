import { describe, it } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { composeRuntime } from "../../src/composition/runtime";
import { FakeClock } from "../../src/adapters/time/FakeClock";
import { playSeason } from "./calibrationArms";
import { effectiveDisposition } from "../../src/engine/emotionalArc";
import { dispositionOf } from "../../src/engine/characterFactory";
import { PLAYER } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";

/**
 * B32 acceptance instrument (opt-in; not in the default suite - tests/calibration/** is excluded). Plays ORWELL_DRIFT_SEASONS seasons (default 4) per arm with ORWELL_DRIFT_FIX off and on and counts, over every
 * NPC at the end of each season, who DRIFTED off their baseline temperament and in which direction: hardened (effective disposition clash, baseline not clash) vs softened (bond, baseline not bond).
 * Acceptance (design 15.7): hardened >= ~25% of the drifted set with the fix on (the #2104 finding was 0 hardened / 9 softened off). Run: ORWELL_DRIFT_RUN=1 npx vitest run tests/calibration/driftMeasure.test.ts
 */
type Soul = { temperamentDrift?: number };
describe.skipIf(process.env.ORWELL_DRIFT_RUN !== "1")("drift measure (B32)", () => {
  for (const fix of [false, true]) {
    it(`ORWELL_DRIFT_FIX=${fix ? "1" : "off"}`, async () => {
      if (fix) process.env.ORWELL_DRIFT_FIX = "1"; else process.env.ORWELL_DRIFT_FIX = "0"; // the flag defaults ON since 2026-11-05, so "off" must be explicit
      const seasons = Number.parseInt(process.env.ORWELL_DRIFT_SEASONS ?? "4", 10);
      let hardened = 0, softened = 0, total = 0, nominatedPlayer = 0;
      for (const arm of ["solid", "reckless"] as const) {
        for (let seed = 1; seed <= seasons; seed++) {
          const runtime = composeRuntime({ clock: new FakeClock(), seed: 1 });
          await playSeason(runtime.registry.resolver(), seed, arm);
          const sb = runtime.registry.sandboxFor(`instrument-${arm}-${seed}`);
          const s = sb.session as unknown as { soulObj(id: EntityId): Soul | undefined; house?: { npcs: Array<{ id: EntityId; character: { archetype: string } }> } };
          for (const n of s.house?.npcs ?? []) {
            const soul = s.soulObj(n.id) as never;
            if (!soul) continue;
            total++;
            const base = dispositionOf(n.character.archetype as never);
            const eff = effectiveDisposition(base, soul);
            if (eff !== base) { if (eff === "clash") hardened++; else if (eff === "bond") softened++; }
          }
          void PLAYER; void nominatedPlayer;
        }
      }
      const drifted = hardened + softened;
      console.log(`B32-DRIFT fix=${fix ? "on" : "off"} npcs=${total} drifted=${drifted} hardened=${hardened} softened=${softened} hardenedShare=${drifted ? (hardened / drifted).toFixed(2) : "n/a"}`);
    }, 3_600_000);
  }
});

/**
 * ORW-33: the BETRAYING arm. The scripted solid/reckless arms record few betrayals, so they cannot show hardening. Here each seed starts a house and the player records `ORWELL_DRIFT_BETRAYALS` (default 3)
 * betrayal scenes against EVERY houseguest through the real scene-memory sink (`rememberPlayerScene`, the same call `recordInteraction` makes for a recorded scene), then counts drifted NPCs exactly as above.
 * Acceptance: hardened >= ~25% of the drifted set with the fix on. Reported by baseline disposition: only a NEUTRAL baseline can newly read clash (clash is already clash; bond needs |drift| > 1.5, out of reach).
 */
describe.skipIf(process.env.ORWELL_DRIFT_RUN !== "1")("drift measure - betraying arm (ORW-33)", () => {
  for (const fix of [false, true]) {
    it(`betraying arm ORWELL_DRIFT_FIX=${fix ? "1" : "off"}`, () => {
      if (fix) process.env.ORWELL_DRIFT_FIX = "1"; else process.env.ORWELL_DRIFT_FIX = "0"; // the flag defaults ON since 2026-11-05, so "off" must be explicit
      const seasons = Number.parseInt(process.env.ORWELL_DRIFT_SEASONS ?? "4", 10);
      const reps = Number.parseInt(process.env.ORWELL_DRIFT_BETRAYALS ?? "3", 10);
      let hardened = 0, softened = 0, total = 0;
      const byBase: Record<string, { n: number; hardened: number }> = {};
      for (let seed = 1; seed <= seasons; seed++) {
        const sb = new GameSessionRegistry().sandboxFor(`drift-betray-${fix}-${seed}`);
        sb.session.createCharacter({ playerName: "P", archetype: "floater", seed });
        sb.session.advanceGame(); sb.session.advanceGame();
        const s = sb.session as unknown as { soulObj(id: EntityId): Soul | undefined; rememberPlayerScene(h: readonly EntityId[], k: string): void; house?: { npcs: Array<{ id: EntityId; character: { archetype: string } }> } };
        const npcs = s.house?.npcs ?? [];
        for (let r = 0; r < reps; r++) for (const n of npcs) s.rememberPlayerScene([n.id], "betrayal");
        for (const n of npcs) {
          const soul = s.soulObj(n.id) as never; if (!soul) continue;
          total++;
          const base = dispositionOf(n.character.archetype as never);
          const eff = effectiveDisposition(base, soul);
          const b = (byBase[base] ??= { n: 0, hardened: 0 }); b.n++;
          if (eff !== base) { if (eff === "clash") { hardened++; b.hardened++; } else if (eff === "bond") softened++; }
        }
      }
      const drifted = hardened + softened;
      console.log(`ORW33-BETRAY fix=${fix ? "on" : "off"} reps=${reps} npcs=${total} drifted=${drifted} hardened=${hardened} softened=${softened} hardenedShare=${drifted ? (hardened / drifted).toFixed(2) : "n/a"} byBaseline=${JSON.stringify(byBase)}`);
    }, 600_000);
  }
});
