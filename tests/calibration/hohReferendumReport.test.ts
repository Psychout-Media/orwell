import { describe, it } from "vitest";
import { playMixGame } from "../support/houseMixDriver";
import type { DecisionWhy } from "../../src/engine/decisionWhy";

/**
 * REPORT, NOT A GATE (ORW-634; Ryne 2026-11-17, option b). Plays N chat-paced seeded seasons and, for every eviction with an NPC HOH whose target stayed on the block:
 *  - the HOH's popularity AT THE VOTE, measured by the report itself (so it reads the same on any build, before or after): the voters' mean bond with the HOH minus the
 *    house's typical bond (every pair), sampled as the eviction ceremony begins;
 *  - the HOH's target (their `nomination-target` why record), and whether it went home;
 *  - per voter (the vote why records): the HOH-referendum term on the target, and the voter's own threat gap (threat on the target minus on the pawn), to see whether a
 *    voter's own threat read swamps their loyalty to the HOH.
 * Prints the outcome overall and by popularity, in plain words. Skipped unless ORWELL_HOH_REPORT=1. ORWELL_HOH_REPORT_SEEDS (default 20), ORWELL_HOH_REPORT_MESSAGES (default 2000).
 */
const RUN = process.env.ORWELL_HOH_REPORT === "1";
const N = Number.parseInt(process.env.ORWELL_HOH_REPORT_SEEDS ?? "20", 10);
const MSGS = Number.parseInt(process.env.ORWELL_HOH_REPORT_MESSAGES ?? "2000", 10);
/** A popularity gap beyond this is "liked" / "disliked". */
const BAND = 0.03;

type Rel = { bondStrength(a: string, b: string): number };
type Live = { week: number; hoh?: string; active: string[]; eviction?: { nominees?: string[] }; finalNominees?: string[]; voteRecord?: Array<{ week: number; evictee: string; voteOf: Record<string, string> }>; weekDigests?: Array<{ week: number; hoh: string | null; nominees: string[]; evictee: string | null }>; decisionWhy?: DecisionWhy[] };
type Row = { popularity: number; targetWent: boolean; opposed: number; opposedEvictedTarget: number; refAbs: number[]; threatGap: number[]; threatBeatRef: number };
const median = (xs: number[]) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2; };

describe.skipIf(!RUN)("HOH referendum report (not a gate)", () => {
  it("prints how often the HOH's target goes home, overall and by how liked the HOH is at the vote", async () => {
    const rows: Row[] = [];
    let savedByVeto = 0, playerHoh = 0, noTarget = 0, noPop = 0;
    const failed: string[] = [];
    for (let seed = 1; seed <= N; seed++) {
      const popAt = new Map<number, { hoh: string; pop: number }>();
      try { await playMixGame(seed, MSGS, {
        advanceEvery: 6,
        onStep: (s) => {
          const sess = s as { live?: Live; rel: Rel };
          const live = sess.live;
          if (!live?.eviction || !live.hoh || live.hoh === "player" || popAt.has(live.week)) return;
          const fn = live.finalNominees ?? live.eviction.nominees ?? [];
          const voters = live.active.filter((v) => v !== live.hoh && !fn.includes(v));
          const ids = live.active;
          let sum = 0, n = 0;
          for (const a of ids) for (const b of ids) if (a !== b) { sum += sess.rel.bondStrength(a, b); n++; }
          const house = n ? sum / n : 0;
          const toHoh = voters.length ? voters.reduce((t, v) => t + sess.rel.bondStrength(v, live.hoh!), 0) / voters.length : house;
          popAt.set(live.week, { hoh: live.hoh, pop: toHoh - house });
        },
        inspect: (s) => {
          const live = (s as { live?: Live }).live;
          const why = live?.decisionWhy ?? [];
          for (const r of live?.voteRecord ?? []) {
            const d = live?.weekDigests?.find((x) => x.week === r.week && x.evictee === r.evictee);
            if (!d?.hoh) continue;
            if (d.hoh === "player") { playerHoh++; continue; }
            const target = why.find((w) => w.kind === "nomination-target" && w.by === d.hoh && w.week === r.week)?.options[0]?.option;
            if (!target) { noTarget++; continue; }
            if (!d.nominees.includes(target)) { savedByVeto++; continue; }
            const p = popAt.get(r.week);
            if (!p || p.hoh !== d.hoh) { noPop++; continue; }
            const pawn = d.nominees.find((x) => x !== target);
            const row: Row = { popularity: p.pop, targetWent: r.evictee === target, opposed: 0, opposedEvictedTarget: 0, refAbs: [], threatGap: [], threatBeatRef: 0 };
            for (const w of why.filter((x) => x.kind === "vote" && x.week === r.week)) {
              const opt = (o: string | undefined) => w.options.find((x) => x.option === o);
              const term = (o: string | undefined, n: string) => opt(o)?.terms.find(([k]) => k === n)?.[1] ?? 0;
              const ref = term(target, "hoh-referendum");
              const gap = term(target, "threat") - term(pawn, "threat");
              row.refAbs.push(Math.abs(ref)); row.threatGap.push(gap);
              if (ref < 0) {
                row.opposed++;
                if (w.options[0]?.option === target) row.opposedEvictedTarget++;
                if (gap > Math.abs(ref)) row.threatBeatRef++;
              }
            }
            rows.push(row);
          }
        },
      }); } catch (e) { failed.push(`seed ${seed}: ${String((e as Error).message).slice(0, 160)}`); } // a season the engine refused is reported, not hidden; the rest still count
    }
    if (failed.length) console.log(`HOHREPORT seasons that stopped early (engine refused a turn): ${failed.join(" | ")}`);
    const pct = (xs: Row[]) => (xs.length ? `${Math.round((100 * xs.filter((x) => x.targetWent).length) / xs.length)}% of ${xs.length}` : "none");
    const liked = rows.filter((x) => x.popularity > BAND), disliked = rows.filter((x) => x.popularity < -BAND), middling = rows.filter((x) => Math.abs(x.popularity) <= BAND);
    const sumOf = (xs: Row[], f: (r: Row) => number) => xs.reduce((t, r) => t + f(r), 0);
    console.log(`HOHREPORT seasons=${N} messages=${MSGS} evictions=${rows.length} (veto saved the target: ${savedByVeto}; player HOH: ${playerHoh}; no target record: ${noTarget}; no popularity sample: ${noPop}) band=${BAND}`);
    console.log(`HOHREPORT the HOH's target went home: overall ${pct(rows)}`);
    console.log(`HOHREPORT   a liked HOH: ${pct(liked)}`);
    console.log(`HOHREPORT   an HOH the house feels about as usual about: ${pct(middling)}`);
    console.log(`HOHREPORT   a disliked or isolated HOH: ${pct(disliked)}`);
    for (const [name, xs] of [["liked", liked], ["usual", middling], ["disliked", disliked]] as const) {
      const opp = sumOf(xs, (r) => r.opposed);
      console.log(`HOHREPORT   ${name}: voters opposed to the HOH ${opp} of ${sumOf(xs, (r) => r.refAbs.length)}; of those, voted the target out anyway ${sumOf(xs, (r) => r.opposedEvictedTarget)}; own threat gap bigger than the loyalty term ${sumOf(xs, (r) => r.threatBeatRef)}; median |loyalty term| ${median(xs.flatMap((r) => r.refAbs)).toFixed(2)} vs median threat gap ${median(xs.flatMap((r) => r.threatGap)).toFixed(2)}`);
    }
  }, 7_200_000);
});
