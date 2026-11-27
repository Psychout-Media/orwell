import { describe } from "vitest";
import { seasonCase } from "./activeInHouseSeason";

// ORW-1084 audit, seed 1 (see ./activeInHouseSeason.ts).
describe("a houseguest who has left the house acts and witnesses nowhere in it", () => {
  seasonCase(1);
});
