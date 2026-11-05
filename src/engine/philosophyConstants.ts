import type { NominationStyle } from "./decisionConstants";

/**
 * B40 (#2017 design S4, PURE ONLY - NOT wired into any decision) - game PHILOSOPHIES: the lasting way a houseguest plays. Every magnitude lives in THIS one module (the 0044 B59 gate), so a retune is one
 * edit. The default mapping archetype -> philosophy -> nomination style reproduces today's NOMINATION_STYLE_BY_ARCHETYPE exactly (proven by tests/unit/philosophy.test.ts), so wiring this later is
 * byte-identical for the default draw. The philosophy NAMES and which archetype maps to which are ASSUMED, pending Ryne - only the resulting STYLE per archetype is fixed by the existing table.
 */
export type GamePhilosophy = "shark" | "chaos-agent" | "loyal-soldier" | "protector" | "social-climber";
export const PHILOSOPHIES: readonly GamePhilosophy[] = ["shark", "chaos-agent", "loyal-soldier", "protector", "social-climber"];

/** NOTE (review): `protector` and `loyal-soldier` both play the `loyalist` style - that keeps the byte-identical table, but the distinction is INERT until something else reads the philosophy (3 of the 12 archetypes - flirt, social-butterfly, peacemaker - default to `protector`).
 * Which nomination style a philosophy plays (the existing four styles; the table the default mapping must reproduce). */
export const STYLE_OF_PHILOSOPHY: Readonly<Record<GamePhilosophy, NominationStyle>> = {
  shark: "threat-hunter",
  "chaos-agent": "duo-breaker",
  "loyal-soldier": "loyalist",
  protector: "loyalist",
  "social-climber": "floater-cleaner",
};

/** The DEFAULT philosophy of each archetype (the modal draw). Composed with STYLE_OF_PHILOSOPHY it equals NOMINATION_STYLE_BY_ARCHETYPE. Unknown archetypes read as sharks (= threat-hunter, today's fallback). */
export const DEFAULT_PHILOSOPHY_BY_ARCHETYPE: Readonly<Record<string, GamePhilosophy>> = {
  "comp-beast": "shark",
  hothead: "shark",
  analyst: "shark",
  floater: "shark",
  villain: "social-climber",
  mastermind: "chaos-agent",
  wildcard: "chaos-agent",
  "social-butterfly": "protector",
  underdog: "loyal-soldier",
  flirt: "protector",
  loyalist: "loyal-soldier",
  peacemaker: "protector",
};
export const FALLBACK_PHILOSOPHY: GamePhilosophy = "shark";

export const PHILOSOPHY_DRAW = {
  /** The chance a houseguest keeps their archetype's default philosophy; the rest of the mass goes to a different one. */
  keepDefault: 0.75,
  /** Relative weight of each OTHER philosophy when the default is not kept (equal by default). */
  alternativeWeight: { shark: 1, "chaos-agent": 1, "loyal-soldier": 1, protector: 1, "social-climber": 1 } as Readonly<Record<GamePhilosophy, number>>,
} as const;
