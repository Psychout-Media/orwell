import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import type { BeliefClaim } from "../../src/engine/beliefStore";

/** ORW-686 item 5. Roles only: a believer (h), the one a rumor is about (b), the one betrayed (v). */
type Seam = {
  live: { playedGame?: boolean; week: number; beliefs?: Record<string, BeliefClaim[]> };
  noteTargetsMeClaims(h: string): void;
};

describe("a betrayal rumor is not turned into 'they target me' (item 5)", () => {
  function rumor(played: boolean, object?: string) {
    const sb = new GameSessionRegistry().sandboxFor(`orw686-rumor-${played}-${object ?? "none"}`);
    sb.session.createCharacter({ playerName: "The Player", seed: 5 });
    const s = sb.session as unknown as Seam;
    s.live.playedGame = played;
    const [h, b, v] = sb.session.livingIds().filter((id) => id !== PLAYER);
    (s.live.beliefs ??= {})[h!] = [{ id: `${h}|heard-rumor|${b}|t`, holder: h!, kind: "heard-rumor", subject: b!, ...(object === "holder" ? { object: h! } : object === "other" ? { object: v! } : {}), value: true, origin: "gossip", nature: "betrayal", confidence: 0.8, week: s.live.week } as BeliefClaim];
    s.noteTargetsMeClaims(h!);
    return (s.live.beliefs[h!] ?? []).filter((c) => c.kind === "targets-me");
  }
  it("played: a rumor about someone else's betrayal (or an unnamed one) adds no 'targets me'", () => {
    expect(rumor(true, "other")).toEqual([]);
    expect(rumor(true)).toEqual([]);
  });
  it("played: a rumor that the holder was the one betrayed still folds once", () => {
    expect(rumor(true, "holder")).toHaveLength(1);
  });
  it("headless keeps the legacy fold", () => {
    expect(rumor(false)).toHaveLength(1);
  });
});
