import { describe, it, expect, vi } from "vitest";

/**
 * ORW-855 (a REPORT, not a gate): why the scripted talking player wins almost no HOH competitions in played seasons, against about 10% headless.
 * Three arms on the same seeds and sandbox names: (A) the scripted talking player as it is (it goes to bed only when a held night makes it), (B) the same player turning in at a
 * normal hour (once the clock is past 9pm and before 11pm, with nothing open), (C) the headless driver (advance, answer every card, held nights lived through, no announced messages).
 * Every `resolveCompetition` call is recorded (wrapping the one resolver) with each competitor's inputs, so each HOH comp's terms can be rebuilt exactly as the resolver scores
 * them: stat, temperature, emotional modifier, intent, hidden rest penalty. Also: how often an HOH winner is evicted within the next two weeks (ORW-779). Prints only; asserts that
 * each arm reached some competitions. Run: `npx vitest run tests/calibration/hohPlayerRateReport.test.ts` (about 80 minutes on a runner for 12 seeds x 5 weeks; HOH_SEEDS, HOH_WEEKS,
 * HOH_SEED_FROM and HOH_ARM=A|B|C narrow it). Roles only.
 *
 * Measured 2026-11-24 (seeds 1-12, weeks 1-5, shipped flags): the player won A 0/45, B 0/36, C 1/53 of the HOH comps they were in. At the comps they lost, the mean gap to the winner
 * was stat -0.12, temperature -0.29 to -0.33, emotion -0.02 to -0.05, intent 0 (always "compete"), rest -0.48 (A) / -0.28 (B) / +0.02 (C). Removing every rest term from the same
 * rolls would have given the player 1/45 (A) and 0/36 (B). The player's stats are 0.5 on average against an NPC mean of 0.556 (about 9th of 16 on the comp's stat).
 */
type Rec = { field: string[]; type: string; winner: string; terms: Record<string, { stat: number; temp: number; emo: number; intent: number; rest: number; total: number; intentName: string; deficit: number }> };
const calls: Rec[] = [];
vi.mock("../../src/domain/competitionOutcome", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../../src/domain/competitionOutcome")>();
  const { TEMPERATURE_CONSTANTS } = await import("../../src/domain/temperatureConstants");
  const RELEVANT: Record<string, "physical" | "mental" | "social"> = { physical: "physical", mental: "mental", social: "social", endurance: "physical" };
  return {
    ...orig,
    resolveCompetition: (...args: Parameters<typeof orig.resolveCompetition>) => {
      const [competitors, type, intents, , constants, secondary] = args;
      const res = orig.resolveCompetition(...args);
      const w = (constants ?? TEMPERATURE_CONSTANTS).outcome;
      const stat = RELEVANT[type] ?? "physical";
      const terms: Rec["terms"] = {};
      for (const c of competitors) {
        const eff = secondary && secondary !== stat ? c.stats[stat] * (1 - w.mixedSecondaryWeight) + c.stats[secondary] * w.mixedSecondaryWeight : c.stats[stat];
        const intentName = intents.intentOf(c.id);
        const t = { stat: eff * w.stat, temp: res.temperature[c.id]! * w.temperature, emo: ((c.emotionalState ?? 0.5) - 0.5) * 2 * w.emotion, intent: intentName === "throw" ? -w.throwPenalty : intentName === "play-safe" ? -w.playSafePenalty : 0, rest: -orig.sleepCost(c.restPenalty ?? 0, w), total: res.scores[c.id]!, intentName, deficit: c.restPenalty ?? 0 };
        terms[c.id] = t;
      }
      calls.push({ field: competitors.map((c) => c.id), type, winner: res.winner, terms });
      return res;
    },
  };
});

const { playSeason } = await import("../support/whatFired/player");
const { GameSessionRegistry } = await import("../../src/composition/registry");
const { resolvePending } = await import("../../features/support/answerPending");
const { endHeldNightSync } = await import("../support/heldNight");

const SEEDS = Array.from({ length: Number(process.env.HOH_SEEDS ?? 12) }, (_, i) => i + 1 + Number(process.env.HOH_SEED_FROM ?? 0));
const WEEKS = Number(process.env.HOH_WEEKS ?? 6);

interface Arm { noRestWins: number; playerRestOnlyWins: number; beds: number[]; hohComps: number; playerIn: number; playerWins: number; lost: Array<Rec["terms"][string] & { gapToWinner: Record<string, number> }>; intents: Record<string, number>; winners: Array<{ who: "player" | "npc"; evictedSoon: boolean }> }
const newArm = (): Arm => ({ noRestWins: 0, playerRestOnlyWins: 0, beds: [], hohComps: 0, playerIn: 0, playerWins: 0, lost: [], intents: {}, winners: [] });

/** Read the season's HOH comps out of the recorded calls between `from` and now: the HOH crown is the call whose winner became `live.hoh` that week. */
function harvest(arm: Arm, from: number, hohByWeek: Map<number, string>, evictedAt: Map<string, number>): void {
  const hohWinners = new Set(hohByWeek.values());
  for (const c of calls.slice(from)) {
    if (!hohWinners.has(c.winner) || c.field.length < 4) continue; // the HOH crowns (a veto field is six; a veto winner who was also an HOH is filtered by the week match below)
    const week = [...hohByWeek].find(([, h]) => h === c.winner)?.[0];
    if (week === undefined) continue;
    hohByWeek.delete(week); // one crown per week
    arm.hohComps++;
    const p = c.terms["player"];
    const out = evictedAt.get(c.winner);
    arm.winners.push({ who: c.winner === "player" ? "player" : "npc", evictedSoon: out !== undefined && out <= week + 2 });
    if (!p) continue;
    arm.playerIn++;
    arm.intents[p.intentName] = (arm.intents[p.intentName] ?? 0) + 1;
    // counterfactuals on the SAME roll: (1) no rest term for anyone, (2) only the player's rest term removed
    const best = (f: (id: string) => number) => c.field.reduce((b, id) => (f(id) > f(b) ? id : b), c.field[0]!);
    if (best((id) => c.terms[id]!.total - c.terms[id]!.rest) === "player") arm.noRestWins++;
    if (best((id) => (id === "player" ? c.terms[id]!.total - c.terms[id]!.rest : c.terms[id]!.total)) === "player") arm.playerRestOnlyWins++;
    if (c.winner === "player") { arm.playerWins++; continue; }
    const wt = c.terms[c.winner]!;
    arm.lost.push({ ...p, gapToWinner: { stat: p.stat - wt.stat, temp: p.temp - wt.temp, emo: p.emo - wt.emo, intent: p.intent - wt.intent, rest: p.rest - wt.rest, total: p.total - wt.total } });
  }
}

/** Track the week each HOH was crowned and the week each houseguest left. */
function tracker(arm: Arm) {
  const hohByWeek = new Map<number, string>(); const evictedAt = new Map<string, number>(); let lastBed: number | undefined;
  const note = (live: { week: number; hoh?: string; evictionOrder: string[]; lastSleepDepth?: number }) => {
    if (live.lastSleepDepth !== undefined && live.lastSleepDepth !== lastBed) { lastBed = live.lastSleepDepth; arm.beds.push(live.lastSleepDepth); } // the hour the player's last night ended (24 = midnight, 32 = 8am)
    if (live.hoh && !hohByWeek.has(live.week)) hohByWeek.set(live.week, live.hoh);
    for (const id of live.evictionOrder) if (!evictedAt.has(id)) evictedAt.set(id, live.week);
  };
  return { hohByWeek, evictedAt, note };
}

async function playedArm(earlyBed: boolean): Promise<Arm> {
  const arm = newArm();
  for (const seed of SEEDS) {
    const from = calls.length; const t = tracker(arm);
    await playSeason({
      seed, maxMessages: 6000,
      watch: async ({ sess, call }) => {
        const live = sess.live; if (!live) return false;
        t.note(live);
        if (earlyBed) {
          const h = live.nightDepth ?? 0, tod = sess.gameStatus().timeOfDay;
          if ((tod === "night" || tod === "late-night") && h >= 21 && h < 23 && !sess.getGameState().pending && !live.ceremony) await call("turnIn", {});
        }
        return (live.week ?? 1) > WEEKS || !!live.finished;
      },
    });
    harvest(arm, from, t.hohByWeek, t.evictedAt);
  }
  return arm;
}

function headlessArm(): Arm {
  const arm = newArm();
  for (const seed of SEEDS) {
    const from = calls.length; const t = tracker(arm);
    const s = new GameSessionRegistry().sandboxFor(`wf-${seed}`).session as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    s.createCharacter({ playerName: "The Player", seed, archetype: "floater" });
    for (let i = 0; i < 9000; i++) {
      const v = s.advanceGame(); if (v.held) endHeldNightSync(s);
      if (v.pending) resolvePending(v.pending, (r) => void s.submitDecision(r));
      const live = s.snapshot().live; t.note(live);
      if (v.finished || live.week > WEEKS) break;
    }
    harvest(arm, from, t.hohByWeek, t.evictedAt);
  }
  return arm;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
function summary(name: string, a: Arm): string {
  const g = (k: string) => mean(a.lost.map((l) => l.gapToWinner[k]!)).toFixed(3);
  const own = (k: "stat" | "temp" | "emo" | "intent" | "rest") => mean(a.lost.map((l) => l[k])).toFixed(3);
  const soon = (who: "player" | "npc") => { const w = a.winners.filter((x) => x.who === who); return `${w.filter((x) => x.evictedSoon).length}/${w.length}`; };
  return [
    `${name}: HOH comps ${a.hohComps}, the player in the field ${a.playerIn}, the player won ${a.playerWins} (${a.playerIn ? ((100 * a.playerWins) / a.playerIn).toFixed(1) : "-"}%); player intents ${JSON.stringify(a.intents)}`,
    `  comps the player lost (${a.lost.length}): mean gap to the winner - stat ${g("stat")}, temperature ${g("temp")}, emotion ${g("emo")}, intent ${g("intent")}, rest ${g("rest")}, total ${g("total")}`,
    `  the player's own terms there: stat ${own("stat")}, temperature ${own("temp")}, emotion ${own("emo")}, intent ${own("intent")}, rest ${own("rest")}; rest < 0 in ${a.lost.filter((l) => l.rest < 0).length}/${a.lost.length}; rest alone exceeds the losing margin in ${a.lost.filter((l) => l.gapToWinner.rest < 0 && l.gapToWinner.total - l.gapToWinner.rest >= 0).length}/${a.lost.length}`,
    `  same rolls with no rest term for anyone: the player would have won ${a.noRestWins}/${a.playerIn}; with only the player's rest term removed: ${a.playerRestOnlyWins}/${a.playerIn}; the player's nights ended at (hour, 24 = midnight) median ${a.beds.length ? [...a.beds].sort((x, y) => x - y)[Math.floor(a.beds.length / 2)]!.toFixed(1) : "-"}, past midnight ${a.beds.filter((b) => b >= 24).length}/${a.beds.length}, mean deficit at the comps ${mean(a.lost.map((l) => l.deficit)).toFixed(2)}`,
    `  ORW-779: an HOH winner evicted within two weeks of the crown - player ${soon("player")}, NPC ${soon("npc")}`,
  ].join("\n");
}

describe("ORW-855 the player's HOH win rate, played vs headless (report)", () => {
  it("prints the three arms", async () => {
    const which = (process.env.HOH_ARM ?? "ABC").split("");
    const out: string[] = [""];
    const arms: Arm[] = [];
    if (which.includes("A")) { const a = await playedArm(false); arms.push(a); out.push(summary("A played (scripted bedtime)", a)); }
    if (which.includes("B")) { const a = await playedArm(true); arms.push(a); out.push(summary("B played (turns in 9-11pm)", a)); }
    if (which.includes("C")) { const a = headlessArm(); arms.push(a); out.push(summary("C headless", a)); }
    // eslint-disable-next-line no-console
    console.log(out.join("\n"));
    for (const a of arms) expect(a.hohComps).toBeGreaterThan(0);
  }, 3_600_000);
});
