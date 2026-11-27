import { describe } from "vitest";
import { seasonCase } from "./activeInHouseSeason";

// ORW-1084 audit, seed 10 (see ./activeInHouseSeason.ts). Seed 1 and the levers are in the sibling files (ORW-410).
describe("a houseguest who has left the house acts and witnesses nowhere in it", () => {
  seasonCase(10);
});
