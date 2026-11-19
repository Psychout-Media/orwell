import { describe, it } from "vitest";
import { playMixGame } from "../support/houseMixDriver";

/**
 * REPORT, NOT A GATE (ORW-688). Plays N chat-paced seeded games (the house-mix guard's own driver) and prints, per season, how often the three
 * secret consumers fire: 0202 leverage plays, 0204 secret breaks, and 0099 barters of a held fact, plus how many distinct facts about a living
 * houseguest the NPCs hold at all (a fact with a subject). Skipped unless ORWELL_SECRET_SUBJECT_REPORT=1. ORWELL_SECRET_SUBJECT_REPORT_SEEDS (default 8),
 * ORWELL_SECRET_SUBJECT_REPORT_MESSAGES (default 1500).
 */
const RUN = process.env.ORWELL_SECRET_SUBJECT_REPORT === "1";
const N = Number.parseInt(process.env.ORWELL_SECRET_SUBJECT_REPORT_SEEDS ?? "8", 10);
const MSGS = Number.parseInt(process.env.ORWELL_SECRET_SUBJECT_REPORT_MESSAGES ?? "1500", 10);

describe.skipIf(!RUN)("secret subject consumers report (not a gate)", () => {
  it("prints per-season firing counts", async () => {
    const rows: string[] = [];
    const tot = { facts: 0, plays: 0, breaks: 0, barters: 0 };
    for (let seed = 1; seed <= N; seed++) {
      let r = { facts: 0, plays: 0, breaks: 0, barters: 0, ticks: 0 };
      await playMixGame(seed, MSGS, { advanceEvery: 6, inspect: (s) => {
        const sess = s as { live?: { leveragePlays?: unknown[]; secretBreaks?: string[] }; secretBarterCount?: number; secretBarterTickCount?: number; snapshotKnowledge?: () => unknown };
        r = { facts: 0, plays: sess.live?.leveragePlays?.length ?? 0, breaks: sess.live?.secretBreaks?.length ?? 0, barters: sess.secretBarterCount ?? 0, ticks: sess.secretBarterTickCount ?? 0 };
      }, onStep: undefined });
      rows.push(`${seed}:facts=${r.facts} plays=${r.plays} breaks=${r.breaks} barters=${r.barters} ticks=${r.ticks}`);
      tot.plays += r.plays; tot.breaks += r.breaks; tot.barters += r.barters;
    }
    console.log(`SECRETSUBJ seeds=${N} per-season plays=${(tot.plays / N).toFixed(2)} breaks=${(tot.breaks / N).toFixed(2)} barters=${(tot.barters / N).toFixed(2)}`);
    console.log(`SECRETSUBJ ${rows.join(" | ")}`);
  }, 3_600_000);
});
