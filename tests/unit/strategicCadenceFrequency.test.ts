import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { Orchestrator } from "../../src/composition/orchestrator";

/**
 * AMEND 0120 #4 - the headline claim, finally COUNTED: with the strategic cadence on, over ~200 off-screen ticks the most strategic houseguests initiate scheming MORE often than the
 * most passive ones, and the skew stays slight (ratio < 3). Seeded; the pooled top-3 vs bottom-3 by `initiatorDrive` keeps one unlucky pair from deciding it. Roles only.
 */
function run(seed: number, ticks = 200): { top: number; bottom: number } {
  const reg = new GameSessionRegistry();
  const orch = new Orchestrator(reg, { now: () => seed }, { seed });
  const user = `freq-${seed}`;
  const sb = reg.sandboxFor(user);
  sb.session.createCharacter({ playerName: "P", seed });
  sb.session.setStrategicCadenceEnabled(true);
  for (let t = 0; t < ticks; t++) orch.advance(user, "offscreen-tick");
  const ids = sb.session.snapshot().house!.npcs.map((n) => n.id);
  const ranked = [...ids].sort((a, b) => sb.session.initiatorDrive(b) - sb.session.initiatorDrive(a));
  const top = new Set(ranked.slice(0, 3)), bottom = new Set(ranked.slice(-3));
  let t = 0, b = 0;
  for (const e of sb.engine.events.queryAll()) {
    if (!(e.hidden && e.id.startsWith("offscreen:"))) continue;
    if (top.has(e.initiator)) t++;
    if (bottom.has(e.initiator)) b++;
  }
  return { top: t, bottom: b };
}

describe("0120 strategic cadence - measured frequency", () => {
  it("the sharpest initiate scheming more often than the most passive, with a slight skew (ratio < 3), pooled over seeds", () => {
    let top = 0, bottom = 0;
    for (const seed of [7, 21, 41]) { const r = run(seed); top += r.top; bottom += r.bottom; }
    // eslint-disable-next-line no-console
    console.log(`[0120 frequency] top-3 initiated ${top}, bottom-3 initiated ${bottom}, ratio ${(top / Math.max(bottom, 1)).toFixed(2)}`);
    expect(top + bottom).toBeGreaterThan(30);
    expect(top).toBeGreaterThan(bottom);
    expect(top / Math.max(bottom, 1)).toBeLessThan(3);
  });
});
