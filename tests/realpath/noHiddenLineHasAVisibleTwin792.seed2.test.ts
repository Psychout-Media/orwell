import { describe } from "vitest";
import { sweepSeason } from "./hiddenTwinSweep";

// ORW-792 sweep, seed 2 (see ./hiddenTwinSweep.ts; one seed per file since ORW-410).
describe("no hidden engine line is a verbatim twin of a line the player sees (played)", () => {
  sweepSeason(2);
});
