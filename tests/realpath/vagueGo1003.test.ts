import { describe, it, expect } from "vitest";
import { PLAYER } from "../../src/domain/ids";
import { parseVagueGo } from "../../src/engine/playerMoveIntent";
import { playedGame } from "../support/playedGame";
import { firstSeedWhereSync } from "../support/firstSeedWhere";

/**
 * ORW-1003 (Ryne: "I don't want to talk about going somewhere 3 messages in a row"): a go with no named place moves the player before the narrator writes. "walk over and say hi" / "head over there" goes to the
 * houseguest last named (the player's words, else the previous reply); "I follow her / them" goes after who just left; when it is not clear, nobody moves and the narrator is told to ask. REAL PATH: a played
 * season, the lever, public presence. Roles only.
 */
type W = { room: string; present: Array<{ id: string; name: string }>; nearby: Array<{ room: string; present: Array<{ id: string; name: string }> }> };
type Priv = { presence: Map<string, string>; nameOf(id: string): string; house: { npcs: Array<{ id: string; character: { genderPresentation?: string } }> } };

function withSomeoneNearby(seed: number, sandbox: string) {
  const g = playedGame({ seed, user: sandbox });
  for (let i = 0; i < 3000; i++) {
    const st = g.s.getGameState() as { phase: string; pending?: unknown; whereabouts?: W };
    const w = g.s.whereabouts() as unknown as W | null;
    if (st.phase !== "premiere" && !st.pending && w && w.nearby.some((n) => n.present.length > 0)) return g;
    g.turn();
  }
  return undefined;
}

describe("a go with no named place (played)", () => {
  const found = () => firstSeedWhereSync((seed, sandbox) => withSomeoneNearby(seed, sandbox), { from: 1, to: 6, hint: [1, 2], sandbox: (s) => `vg-${s}`, what: "a houseguest in sight next door" }).at;

  it("reads only the forms", () => {
    expect(parseVagueGo("I walk over and say hi")).toEqual({ kind: "over" });
    expect(parseVagueGo("I head over there.")).toEqual({ kind: "over" });
    expect(parseVagueGo("I go over to them")).toEqual({ kind: "over" });
    expect(parseVagueGo("I follow her.")).toEqual({ kind: "follow", pronoun: "her" });
    expect(parseVagueGo("I follow them out")).toEqual({ kind: "follow", pronoun: "them" });
    for (const t of ["maybe I head over there later", "should I follow her?", "I don't follow them", "She said \"I follow her\"", "I follow your logic"]) expect(parseVagueGo(t), t).toBeNull();
  });

  it("walk over: goes to the houseguest the player or the previous reply last named, before the narrator writes", () => {
    for (const from of ["player", "reply"] as const) {
      const g = found(), p = g.s as unknown as Priv;
      const w = g.s.whereabouts() as unknown as W;
      const n = w.nearby.find((x) => x.present.length > 0)!;
      const name = n.present[0]!.name;
      const text = from === "player" ? `${name} is over there. I walk over and say hi.` : "I walk over and say hi.";
      const reply = from === "reply" ? `${name} waves from across the way.` : "";
      const r = g.s.resolvePlayerMove({ text, previousReply: reply });
      expect(r.playerMove, `${from}: moved`).toMatchObject({ to: n.room });
      expect(p.presence.get(PLAYER)).toBe(n.room);
    }
  });

  it("I follow them: goes after the houseguest the reply named who is next door", () => {
    const g = found(), p = g.s as unknown as Priv;
    const w = g.s.whereabouts() as unknown as W;
    const n = w.nearby.find((x) => x.present.length > 0)!;
    const r = g.s.resolvePlayerMove({ text: "I follow them.", previousReply: `${n.present[0]!.name} says they are heading out, and goes.` });
    expect(r.playerMove).toMatchObject({ to: n.room });
    expect(p.presence.get(PLAYER)).toBe(n.room);
  });

  it("the previous reply crosses the MCP boundary", async () => {
    const g = found(), p = g.s as unknown as Priv;
    const w = g.s.whereabouts() as unknown as W;
    const n = w.nearby.find((x) => x.present.length > 0)!;
    await g.sb.mcp.player.callTool("resolvePlayerMove", { text: "I head over there.", previousReply: `${n.present[0]!.name} waves from across the way.` });
    expect(p.presence.get(PLAYER)).toBe(n.room);
  });

  it("nothing clear: nobody moves and the narrator is told to ask", () => {
    const g = found(), p = g.s as unknown as Priv;
    const here = p.presence.get(PLAYER);
    const r = g.s.resolvePlayerMove({ text: "I follow her.", previousReply: "Someone mutters something and leaves." });
    expect(r.playerMove).toMatchObject({ refused: true });
    expect(p.presence.get(PLAYER)).toBe(here);
  });
});
