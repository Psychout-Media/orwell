import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { ROUTINE_ACTIONS, ROUTINE_ROOMS } from "../../src/engine/houseLife";

/** ORW-978: the front end mirrors the engine's closed sets for a written routine (`ROUTINE_ROOMS`, `ROUTINE_ACTIONS`); the prompt is only as good as the mirror, so they are pinned equal. Roles only. */
const src = readFileSync("frontend/src/orwell_npc_minds_words.py", "utf8");
const tuple = (name: string): string[] => {
  const m = new RegExp(`^${name} = \\(([^)]*)\\)`, "m").exec(src);
  expect(m, `${name} not found in the front end`).not.toBeNull();
  return [...m![1]!.matchAll(/"([^"]+)"/g)].map((x) => x[1]!);
};
describe("the front end's routine sets mirror the engine's", () => {
  it("rooms", () => expect(tuple("ROUTINE_ROOMS")).toEqual([...ROUTINE_ROOMS]));
  it("actions", () => expect(tuple("ROUTINE_ACTIONS")).toEqual([...ROUTINE_ACTIONS]));
});
