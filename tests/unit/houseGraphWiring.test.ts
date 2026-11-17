import { describe, it, expect, afterEach } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER_TOOLS, ADMIN_TOOLS, DEBUG_VAULT_TOOLS } from "../../src/surfaces/tools/registry";
import type { BondReader } from "../../src/engine/bonds";
import type { GraphBondReader } from "../../src/engine/houseGraph";

/** Theme 3 wiring: the adapter's engine-only houseGraph() accessor. Roles only. */
const _assignable: GraphBondReader = {} as BondReader; // type-level: the real bond reader satisfies the graph's structural reader
void _assignable;

const game = () => {
  const s = new GameSessionRegistry().sandboxFor(`hg-wire-${Math.random()}`).session as GameSessionAdapter;
  s.createCharacter({ playerName: "P", seed: 5 });
  return s;
};
const walk = (d: string): string[] => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : []; });
afterEach(() => GameSessionAdapter.setTimeOfDayEnabled(false));

describe("the house graph accessor on the adapter", () => {
  it("returns a graph of living houseguests only, cached within a day, re-derived when the day advances", () => {
    const s = game();
    for (let i = 0; i < 6; i++) s.advanceGame();
    const g1 = s.houseGraph();
    expect(s.houseGraph()).toBe(g1);
    const living = new Set(s.livingIds());
    const all = [...g1.graph.cliques.flat(), ...g1.graph.hubs, ...g1.graph.loners, ...g1.graph.brokers];
    for (const m of all) expect(living.has(m)).toBe(true);
    (s as unknown as { live: { dayNumber?: number } }).live.dayNumber = (g1.day ?? 1) + 1;
    const g2 = s.houseGraph();
    expect(g2).not.toBe(g1);
    expect(g2.day).toBe((g1.day ?? 1) + 1);
  });
  it("is derived state: snapshot bytes match a session that never called it", () => {
    const a = game(), b = game();
    for (let i = 0; i < 4; i++) { a.advanceGame(); b.advanceGame(); }
    a.houseGraph(); a.houseGraph();
    expect(JSON.stringify(a.snapshot())).toBe(JSON.stringify(b.snapshot()));
    expect(JSON.stringify(a.snapshot())).not.toMatch(/houseGraph/i);
    a.restore(JSON.parse(JSON.stringify(a.snapshot())));
    expect(JSON.stringify(a.snapshot())).toBe(JSON.stringify(b.snapshot()));
  });
  it("exposes no numbers", () => {
    const g = game().houseGraph();
    const walkVals = (v: unknown, path = ""): void => {
      if (typeof v === "number") { expect(path).toBe(".day"); return; }
      if (Array.isArray(v)) v.forEach((x, i) => walkVals(x, `${path}[${i}]`));
      else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walkVals(x, `${path}.${k}`);
    };
    walkVals(g);
  });
  it("is pinned absent from every surface, MCP file, tool descriptor and lever list", () => {
    for (const dir of ["src/surfaces", "src/adapters/mcp"]) for (const f of walk(dir)) expect(readFileSync(f, "utf8")).not.toMatch(/houseGraph/i);
    const names = [...PLAYER_TOOLS, ...ADMIN_TOOLS, ...DEBUG_VAULT_TOOLS].map((t) => t.name);
    expect(names.some((n) => /housegraph/i.test(n))).toBe(false);
    expect(readFileSync("src/surfaces/tools/registry.ts", "utf8")).not.toMatch(/housegraph/i); // PLAYER_TOOLS / INFRA_LEVERS / manifests
    expect(readFileSync("src/ports/GameSession.ts", "utf8")).not.toMatch(/houseGraph/i);
  });
});
