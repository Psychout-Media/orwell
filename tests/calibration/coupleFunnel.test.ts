import { describe, it } from "vitest";
import { playMixGame } from "../support/houseMixDriver";

/** REPORT, NOT A GATE (ORW-636 follow-up): the couple-term funnel over played chat-paced seasons. Skipped unless ORWELL_COUPLE_FUNNEL=1 (ORWELL_COUPLE_FUNNEL_SEEDS default 8, _MESSAGES default 1500). */
const RUN = process.env.ORWELL_COUPLE_FUNNEL === "1";
const N = Number.parseInt(process.env.ORWELL_COUPLE_FUNNEL_SEEDS ?? "8", 10);
const MSGS = Number.parseInt(process.env.ORWELL_COUPLE_FUNNEL_MESSAGES ?? "1500", 10);
type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any

describe.skipIf(!RUN)("couple funnel (not a gate)", () => {
  it("prints the funnel per seed", async () => {
    for (let seed = 1; seed <= N; seed++) {
      const f = { hohSteps: 0, npcHohSteps: 0, hohWithPush: 0, pushSum: 0, maxPairBondSeenByAnyone: 0 };
      let week = 0, day = 0;
      let peak = { bondPairs: 0, seenPairs: 0, both: 0 };
      const step = (s: Any, i: number): void => {
        const live = s.live; if (!live) return;
        week = live.week; day = live.day ?? day;
        if (live.hoh) {
          f.hohSteps++;
          if (live.hoh !== "player") {
            f.npcHohSteps++;
            let any = 0;
            for (const t of live.active) any = Math.max(any, s.couplePushFor(t, live.hoh));
            if (any > 0) { f.hohWithPush++; f.pushSum += any; }
          }
        }
        if (i % 100 === 99) {
          // unordered pairs with a romance scene, per reader
          const evs = s.record?.events?.() ?? [];
          const rom = new Set<string>();
          for (const e of evs) if (e.type === "showmance" && e.witnessSet.length === 2) rom.add([...e.witnessSet].sort().join("|"));
          let bondPairs = 0, seenPairs = 0, both = 0;
          for (const k of rom) {
            const [a, b] = k.split("|");
            for (const h of live.active) {
              if (h === a || h === b || h === "player") continue;
              const bond = s.perceivedBond(h, a, b), seen = s.romanceSeenBy(h, a, b);
              if (bond >= 0.65) bondPairs++;
              if (seen) seenPairs++;
              if (bond >= 0.65 && seen) both++;
            }
          }
          peak = { bondPairs: Math.max(peak.bondPairs, bondPairs), seenPairs: Math.max(peak.seenPairs, seenPairs), both: Math.max(peak.both, both) };
        }
      };
      let n = 0;
      await playMixGame(seed, MSGS, { advanceEvery: 6, onStep: (s) => step(s, n++), inspect: (s: Any) => {
        const live = s.live;
        const chem = live.chemistry ?? {}, tog = live.together ?? {};
        const evs = s.record?.events?.() ?? [];
        const rom = evs.filter((e: Any) => e.type === "showmance");
        const romPairs = new Set(rom.filter((e: Any) => e.witnessSet.length === 2).map((e: Any) => [...e.witnessSet].sort().join("|")));
        const seenRom = rom.filter((e: Any) => (e.houseLife?.seenBy ?? []).length > 0).length;
        const hl = evs.filter((e: Any) => e.houseLife);
        const acts: Record<string, number> = {};
        for (const e of hl) { const a = String(e.houseLife.action); if (/flirt|cuddle|kiss|romance/.test(a)) acts[a] = (acts[a] ?? 0) + 1; }
        const chemKeys = Object.keys(chem);
        const togVals = Object.keys(tog).map((k) => tog[k]);
        const maxTog = Math.max(0, ...togVals);
        // attraction >= flirt threshold
        const { ATTRACTION_LIFE, attractionOf } = (s as Any).__attr ?? {};
        const att = chemKeys.map((k) => { const [from, to] = k.replace(/^chem:/, "").split(">"); return Math.min(chem[k], Math.max(0, (tog[k] ?? 0) / 12) * 0.08); });
        console.log(`FUNNEL seed=${seed} week=${week} msgs=${MSGS} chemOrderedPairs=${chemKeys.length} attAtLeast0.2=${att.filter((a) => a >= 0.2).length} maxTogetherStretches=${maxTog} togetherPairs=${togVals.filter((v) => v > 0).length} houseLifeScenes=${hl.length} showmanceEvents=${rom.length} showmancePairs=${romPairs.size} seenShowmance=${seenRom} acts=${JSON.stringify(acts)} peakReaders(bond>=.65)=${peak.bondPairs} peakReaders(seen)=${peak.seenPairs} peakReaders(both)=${peak.both} hohSteps=${f.hohSteps} npcHohSteps=${f.npcHohSteps} hohStepsWithCouplePush=${f.hohWithPush}`);
      } });
    }
  }, 3_600_000);
});
