import { describe, it, expect, vi } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { GameSessionRegistry } from "../../src/composition/registry";
import { Orchestrator } from "../../src/composition/orchestrator";
import { LogicalClock } from "../../src/adapters/time/LogicalClock";

/** ORW-277 - a loud, non-gating, Vault-free alarm when the Show Brief fails to build in a played game. Roles only. */
function played(seed: number, playedGame = true): GameSessionAdapter {
  const g = new GameSessionAdapter();
  g.createCharacter({ playerName: "The Player", seed });
  if (playedGame) g.noteMessage({ messageId: `m${seed}` });
  return g;
}
type Priv = { openThreadLines(): string[] };

describe("show brief alarm", () => {
  it("a played game that builds fine has no alarm and an unchanged brief", () => {
    const g = played(71);
    const a = g.getMomentPrompt({ brief: {} });
    expect(a.showBrief).toBeDefined();
    expect(g.briefAlarmStatus()).toBeUndefined();
    expect(g.getMomentPrompt({ brief: {} }).showBrief!.text).toBe(a.showBrief!.text);
  });

  it("a forced build failure is swallowed (the turn goes on, no brief), counted, and logged once per session", () => {
    const g = played(72);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    (g as unknown as Priv).openThreadLines = () => { throw new Error("SENTINEL-HIDDEN-EXC-9 secret content"); };
    const withoutBrief = g.getMomentPrompt({});
    const mp = g.getMomentPrompt({ brief: {} });
    expect(mp.showBrief).toBeUndefined();
    expect(mp.systemPrompt).toBe(withoutBrief.systemPrompt);
    g.getMomentPrompt({ brief: {} });
    expect(g.briefAlarmStatus()).toEqual({ failures: 2, first: "threw" });
    const alerts = err.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("ALERT show-brief"));
    expect(alerts).toHaveLength(1);
    expect(JSON.stringify([alerts, g.briefAlarmStatus()])).not.toContain("SENTINEL-HIDDEN-EXC-9");
    err.mockRestore();
  });

  it("an unplayed (headless) game never alarms, and no request means no build", () => {
    const g = played(73, false);
    (g as unknown as Priv).openThreadLines = () => { throw new Error("x"); };
    g.getMomentPrompt({ brief: {} });
    expect(g.briefAlarmStatus()).toBeUndefined();
    const h = played(74);
    (h as unknown as Priv).openThreadLines = () => { throw new Error("x"); };
    h.getMomentPrompt({});
    expect(h.briefAlarmStatus()).toBeUndefined();
  });

  it("sandboxHealth shows the alarm only after a failure (admin-visible, codes and a count)", () => {
    const reg = new GameSessionRegistry();
    const orch = new Orchestrator(reg, new LogicalClock());
    const sb = reg.sandboxFor("u-alarm");
    sb.session.createCharacter({ playerName: "The Player", seed: 75 });
    sb.session.noteMessage({ messageId: "m75" });
    expect(orch.sandboxHealth("u-alarm")).not.toHaveProperty("briefAlarm");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    (sb.session as unknown as Priv).openThreadLines = () => { throw new Error("boom"); };
    sb.session.getMomentPrompt({ brief: {} });
    expect((orch.sandboxHealth("u-alarm") as { briefAlarm?: unknown }).briefAlarm).toEqual({ failures: 1, first: "threw" });
    err.mockRestore();
  });
});
