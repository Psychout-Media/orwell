import { classify } from "../domain/event";
import type { GameEvent } from "../domain/event";
import { PLAYER } from "../domain/ids";

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
