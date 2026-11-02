import { classify } from "../domain/event";
import type { GameEvent } from "../domain/event";
import { PLAYER } from "../domain/ids";
import type { SeasonResult } from "./simulation";

/** The seven typed interaction natures the live off-screen society records (0038). */
export const TYPED_SCENES: ReadonlySet<string> = new Set([
  "alliance", "gossip", "conflict", "bonding", "strategy", "showmance", "betrayal",
]);

/**
 * Behavioral-fidelity metrics over the PRODUCTION event store (B54/audit D3) — computed from the
 * real events a live sandbox recorded, never from a parallel simulation. If `defaultApply` stopped
 * recording typed scenes, every count here would collapse and the gate would fail.
 */
export interface LiveRichnessMetrics {
  totalEvents: number;
  /** Fraction of events the player did not witness (the off-screen society, 0003). */
  offscreenShare: number;
  /** Distinct event types present. */
  typeDiversity: number;
  types: string[];
  /** Off-screen scenes carrying a real interaction nature (alliance/gossip/conflict/…). */
  typedScenes: number;
  allianceScenes: number;
  /** Fracture pressure: conflicts + betrayals (the churn half of alliance life). */
  churnScenes: number;
  /** Share of typed scenes in which a hidden element surfaced (B50's rare-reveal loop). */
  revealShare: number;
  totalReveals: number;
}

export function liveRichnessMetrics(events: readonly GameEvent[]): LiveRichnessMetrics {
  // The off-screen share measures SOCIAL life (mandate #1: most of it happens away from the
  // player) — the broadcast ceremony record (`season:` beats, day markers) is inherently public
  // and would dilute the measure; legal pathway surfacings to the player (gossip tellings,
  // overhears) stay IN the denominator, so a game that funnels everything to the player still
  // fails the gate.
  const social = events.filter((e) => !e.id.startsWith("season:") && e.type !== "house-event");
  const offscreen = social.filter((e) => classify(e, PLAYER) === "HIDDEN").length;
  const types = [...new Set(events.map((e) => e.type))];
  const typed = events.filter((e) => TYPED_SCENES.has(e.type));
  const reveals = typed.filter((e) => e.reveal === true).length;
  return {
    totalEvents: events.length,
    offscreenShare: social.length === 0 ? 0 : offscreen / social.length,
    typeDiversity: types.length,
    types,
    typedScenes: typed.length,
    allianceScenes: typed.filter((e) => e.type === "alliance").length,
    churnScenes: typed.filter((e) => e.type === "conflict" || e.type === "betrayal").length,
    revealShare: typed.length === 0 ? 0 : reveals / typed.length,
    totalReveals: reveals,
  };
}

/** Behavioral-fidelity metrics computed over a simulated season. */
export interface RichnessMetrics {
  totalMoments: number;
  /** Fraction of interactions the player did not witness (from the EventStore). */
  offscreenShare: number;
  typeDiversity: number;
  types: string[];
  alliancesFormed: number;
  alliancesFractured: number;
  edgeStrengthsChanged: boolean;
  /** Share of moments that revealed a hidden element. */
  surfacingRate: number;
  maxRevealsPerMoment: number;
  totalReveals: number;
}

export function richnessMetrics(result: SeasonResult): RichnessMetrics {
  // Off-screen share + type diversity read from the EventStore via the real
  // visibility model (feature 0002) — off-screen = the player is not a witness.
  const events = result.events.queryAll();
  const offscreen = events.filter((e) => classify(e, PLAYER) === "HIDDEN").length;
  const types = [...new Set(events.map((e) => e.type))];

  const reveals = result.moments.map((m) => m.reveals);
  const totalReveals = reveals.reduce((a, b) => a + b, 0);
  const momentsWithReveal = result.moments.filter((m) => m.reveals > 0).length;

  return {
    totalMoments: result.moments.length,
    offscreenShare: events.length === 0 ? 0 : offscreen / events.length,
    typeDiversity: types.length,
    types,
    alliancesFormed: result.alliancesFormed,
    alliancesFractured: result.alliancesFractured,
    edgeStrengthsChanged: result.edgeStrengthsChanged,
    surfacingRate: result.moments.length === 0 ? 0 : momentsWithReveal / result.moments.length,
    maxRevealsPerMoment: reveals.length === 0 ? 0 : Math.max(...reveals),
    totalReveals,
  };
}
