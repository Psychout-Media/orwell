/** ORW-253 slice 6 core: tunables for jury and final-HOH minds (`juryMinds.ts`), one module (the B59 pattern). */
import type { Archetype, StrategyStyle } from "./characterFactory";
import type { JurorArchetype } from "./jurorProfile";

type Lean = Partial<Record<JurorArchetype, number>>;

export const JURY_MINDS = {
  /** Which juror style each character archetype leans to (0..1). */
  byArchetype: {
    "comp-beast": { competitor: 1.0, "grudge-holder": 0.3 }, mastermind: { competitor: 0.8, pragmatist: 0.6 },
    "social-butterfly": { forgiver: 0.9, loyalist: 0.4 }, floater: { pragmatist: 1.0, forgiver: 0.3 },
    villain: { "grudge-holder": 0.8, competitor: 0.6 }, underdog: { loyalist: 0.9, forgiver: 0.4 },
    flirt: { pragmatist: 0.7, forgiver: 0.5 }, loyalist: { loyalist: 1.0, "grudge-holder": 0.3 },
    wildcard: { pragmatist: 0.6, "grudge-holder": 0.5 }, analyst: { competitor: 0.9, pragmatist: 0.4 },
    hothead: { "grudge-holder": 1.0, competitor: 0.3 }, peacemaker: { forgiver: 1.0, loyalist: 0.4 },
  } as Readonly<Record<Archetype, Lean>>,
  /** Their own strategy style adds to it. */
  byStyle: {
    aggressive: { "grudge-holder": 0.3, competitor: 0.2 }, social: { forgiver: 0.3 }, strategic: { competitor: 0.3, pragmatist: 0.2 },
    "under-the-radar": { pragmatist: 0.3 }, emotional: { "grudge-holder": 0.3, forgiver: 0.1 }, loyal: { loyalist: 0.4 },
  } as Readonly<Record<StrategyStyle, Lean>>,
  /** Seeded jitter (0..jitter): breaks near-ties only, never overrides a clear character lean. */
  jitter: 0.15,
  finalHoh: {
    /** Default weights: jury odds matter most, threat next, bond least. */
    base: { juryOdds: 1.0, threat: 0.5, bond: 0.3 },
    byArchetype: {
      mastermind: { juryOdds: 1.4, threat: 0.3, bond: 0.1 }, analyst: { juryOdds: 1.3, threat: 0.4, bond: 0.1 },
      villain: { juryOdds: 1.2, threat: 0.5, bond: 0.0 }, loyalist: { juryOdds: 0.6, threat: 0.3, bond: 1.2 },
      underdog: { juryOdds: 0.8, threat: 0.4, bond: 0.8 }, peacemaker: { juryOdds: 0.7, threat: 0.3, bond: 1.0 },
      hothead: { juryOdds: 0.4, threat: 1.3, bond: 0.3 }, "comp-beast": { juryOdds: 0.7, threat: 1.0, bond: 0.3 },
    } as Readonly<Partial<Record<Archetype, { juryOdds: number; threat: number; bond: number }>>>,
  },
} as const;
