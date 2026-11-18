import { clamp01 } from "../domain/num";
import { COUNTER_STANDS } from "./npcDealConstants";

/** The temperament reads (0..1) a houseguest brings to a refused counter: their soul's volatility and emotional steadiness. Hidden: only the outcome ever leaves the engine. */
export interface CounterTraits { volatility: number; steadiness: number }

/** The chance the original offer still stands after a refused counter: smooth and monotone (falls with volatility, rises with steadiness), held inside a band so both outcomes occur. */
export function counterStandsChance(t: CounterTraits): number {
  const raw = COUNTER_STANDS.base - COUNTER_STANDS.perVolatility * (clamp01(t.volatility) - 0.5) + COUNTER_STANDS.perSteadiness * (clamp01(t.steadiness) - 0.5);
  return Math.max(COUNTER_STANDS.floor, Math.min(COUNTER_STANDS.ceiling, raw));
}

/** Pure: `roll` is a 0..1 draw from the offer's own keyed side stream. True = the offer still stands. */
export function offerStandsAfterRefusedCounter(traits: CounterTraits, roll: number): boolean {
  return roll < counterStandsChance(traits);
}
