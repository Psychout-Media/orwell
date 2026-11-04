import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";

/** AMEND 0137 — THE EXCHANGE producer-read line: delivered exactly once after a stashed accounting,
 *  cleared on the next prompt, never when the lever is OFF (ON-vs-OFF prompt diff is exactly that line).
 *  Roles only. */
const MARK = "THE EXCHANGE (voice this in second person";
const ACC = { playerGained: true, npcGained: false, asymmetry: "player-ahead" as const };
function start(user: string, on: boolean) {
  const sb = new GameSessionRegistry().sandboxFor(user);
  sb.session.createCharacter({ playerName: "The Player", seed: 7 });
  (sb.session as any).setProducerReadEnabled(on);
  return sb;
}
const prompt = (sb: ReturnType<typeof start>) => sb.session.getMomentPrompt({ moment: "social" }).systemPrompt;

describe("0137 — THE EXCHANGE is a one-shot prompt line", () => {
  it("appears exactly once, then is cleared", () => {
    const sb = start("ex-on", true);
    (sb.session as any).stashExchangeAccounting(ACC);
    const first = prompt(sb);
    expect(first.split(MARK).length - 1).toBe(1);
    expect(prompt(sb)).not.toContain(MARK);
  });
  it("never appears when the lever is OFF, and ON-vs-OFF differ by only that line", () => {
    const off = start("ex-off", false);
    (off.session as any).stashExchangeAccounting(ACC);
    const offP = prompt(off);
    expect(offP).not.toContain(MARK);
    const on = start("ex-on2", true);
    (on.session as any).stashExchangeAccounting(ACC);
    const onP = prompt(on);
    const extra = onP.split("\n").filter((l) => !offP.split("\n").includes(l));
    expect(extra.length).toBe(1);
    expect(extra[0]).toContain(MARK);
  });
  it("never states numbers or edges", () => {
    const sb = start("ex-num", true);
    (sb.session as any).stashExchangeAccounting(ACC);
    const line = prompt(sb).split("\n").find((l) => l.includes(MARK))!;
    expect(line).not.toMatch(/\d/);
    expect(line).not.toMatch(/npc:/);
  });
});
