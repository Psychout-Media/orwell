import { describe, it } from "vitest";
import { playMixGame } from "../support/houseMixDriver";
import type { DecisionWhy } from "../../src/engine/decisionWhy";

/**
 * REPORT, NOT A GATE (ORW-634; Ryne 2026-11-17, option b). Plays N chat-paced seeded seasons and, for every eviction with an NPC HOH, reads from the engine's own records:
 * the HOH's target (their `nomination-target` why record), whether the veto took the target off the block, who went home, and how liked the HOH was by that week's
 * voters against the house's typical bond (the `hohBond` / `houseBond` inputs each vote's why record carries). Prints how often the HOH's target went home, overall
 * and by the HOH's popularity, in plain words. Skipped unless ORWELL_HOH_REPORT=1. ORWELL_HOH_REPORT_SEEDS (default 12), ORWELL_HOH_REPORT_MESSAGES (default 2500).
 */
const RUN = process.env.ORWELL_HOH_REPORT === "1";
const N = Number.parseInt(process.env.ORWELL_HOH_REPORT_SEEDS ?? "12", 10);
const MSGS = Number.parseInt(process.env.ORWELL_HOH_REPORT_MESSAGES ?? "2500", 10);
/** A popularity gap (mean of each voter's bond with the HOH minus the house's typical bond) beyond this is "liked" / "disliked". */
const BAND = 0.05;

type Row = { popularity?: number; targetWent: boolean };
describe.skipIf(!RUN)("HOH referendum report (not a gate)", () => {
  it("prints how often the HOH's target goes home, overall and by how liked the HOH is", async () => {
    const rows: Row[] = [];
    let savedByVeto = 0, playerHoh = 0, noTarget = 0;
    for (let seed = 1; seed <= N; seed++) {
      await playMixGame(seed, MSGS, { advanceEvery: 6, inspect: (s) => {
        const live = (s as { live?: { voteRecord?: Array<{ week: number; evictee: string; voteOf: Record<string, string> }>; weekDigests?: Array<{ week: number; hoh: string | null; nominees: string[]; evictee: string | null }>; decisionWhy?: DecisionWhy[] } }).live;
        const why = live?.decisionWhy ?? [];
        for (const r of live?.voteRecord ?? []) {
          const d = live?.weekDigests?.find((x) => x.week === r.week && x.evictee === r.evictee);
          if (!d?.hoh) continue;
          if (d.hoh === "player") { playerHoh++; continue; }
          const target = why.find((w) => w.kind === "nomination-target" && w.by === d.hoh && w.week === r.week)?.options[0]?.option;
          if (!target) { noTarget++; continue; }
          if (!d.nominees.includes(target)) { savedByVeto++; continue; }
          const pops = why.filter((w) => w.kind === "vote" && w.week === r.week).map((w) => w.options[0]?.inputs).filter((i): i is Record<string, number> => i?.hohBond !== undefined && i.houseBond !== undefined).map((i) => i.hohBond! - i.houseBond!);
          rows.push({ ...(pops.length ? { popularity: pops.reduce((a, b) => a + b, 0) / pops.length } : {}), targetWent: r.evictee === target });
        }
      } });
    }
    const pct = (xs: Row[]) => (xs.length ? `${Math.round((100 * xs.filter((x) => x.targetWent).length) / xs.length)}% of ${xs.length}` : "none");
    const liked = rows.filter((x) => x.popularity !== undefined && x.popularity > BAND);
    const disliked = rows.filter((x) => x.popularity !== undefined && x.popularity < -BAND);
    const middling = rows.filter((x) => x.popularity !== undefined && Math.abs(x.popularity) <= BAND);
    console.log(`HOHREPORT seasons=${N} messages=${MSGS} evictions-with-an-NPC-HOH-and-target-on-the-block=${rows.length} (veto saved the target: ${savedByVeto}; player HOH: ${playerHoh}; no target record: ${noTarget})`);
    console.log(`HOHREPORT the HOH's target went home: overall ${pct(rows)}`);
    console.log(`HOHREPORT   a liked HOH (the voters like them more than the house's norm): ${pct(liked)}`);
    console.log(`HOHREPORT   an HOH the house feels about as usual about: ${pct(middling)}`);
    console.log(`HOHREPORT   a disliked or isolated HOH: ${pct(disliked)}`);
    if (rows.some((x) => x.popularity === undefined)) console.log(`HOHREPORT   (no popularity read on ${rows.filter((x) => x.popularity === undefined).length}: the build has no ORW-634 inputs)`);
  }, 3_600_000);
});
