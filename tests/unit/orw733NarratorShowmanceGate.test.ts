import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";

/**
 * ORW-733 (Vault Wall, follow-up A): the narrator's showmance list is a pure projection of the PLAYER's knowledge. A pair the HOUSE has noticed (engine stage `visible`) is
 * never named to the narrator, the visible state, the state read, the recaps or the dossier until the player has seen the pair together (a romance scene they were in or watched)
 * Roles only; the pair is whichever pair the seed deals.
 */
function gameWithASurfacedShowmance() {
  for (let seed = 1; seed <= 300; seed++) {
    const reg = new GameSessionRegistry();
    const sb = reg.sandboxFor(`g733-${seed}`);
    sb.session.createCharacter({ playerName: "The Player", seed });
    const pair = sb.session.snapshot().seededRelationships?.showmances[0];
    if (!pair) continue;
    sb.engine.relationships.edge(pair.a, pair.b).affinity = 0.95;
    sb.engine.relationships.edge(pair.b, pair.a).affinity = 0.95;
    sb.session.advanceShowmances(); // spark -> bond
    sb.session.advanceShowmances(); // bond -> visible: the HOUSE knows
    const stage = sb.session.snapshot().seededRelationships!.showmances[0]!.stage;
    if (stage !== "visible") continue;
    const names = sb.session.getGameState().house.filter((h) => h.id === pair.a || h.id === pair.b).map((h) => h.name);
    return { sb, pair, names };
  }
  throw new Error("no seed produced a surfaced showmance");
}

type Sb = ReturnType<typeof gameWithASurfacedShowmance>["sb"];
function surfaces(sb: Sb): Record<string, string> {
  const out: Record<string, string> = {};
  const add = (k: string, f: () => unknown): void => { try { out[k] = JSON.stringify(f()); } catch (e) { out[k] = `ERR ${String(e)}`; } };
  add("state", () => sb.session.getGameState());
  add("visibleState", () => sb.player.getVisibleState());
  add("moment", () => sb.session.getMomentPrompt({}));
  add("dailyRecap", () => sb.session.dailyRecap());
  add("seasonRecap", () => sb.session.seasonRecap());
  add("dossier", () => sb.session.playerDossier());
  add("whereabouts", () => sb.session.whereabouts());
  return out;
}
// The roster names every houseguest, so "names the pair" means the PAIR is stated: the two names joined as a couple, the house-noticed line, or a showmance listing.
const names = (s: string, n: string[]): boolean => s.includes(`${n[0]} & ${n[1]}`) || s.includes(`${n[1]} & ${n[0]}`) || /grown close|Public showmances? \(|"showmances"/.test(s);

describe("ORW-733 A: the narrator is told a showmance only once the player has seen it", () => {
  it("the house knowing is not the player knowing: a surfaced pair reaches no player-or-narrator read", () => {
    const { sb, pair, names: n } = gameWithASurfacedShowmance();
    // POSITIVE CONTROL: the engine record DOES hold the pair at `visible`, and the house-side event naming it exists.
    expect(sb.session.snapshot().seededRelationships!.showmances[0]!.stage).toBe("visible");
    expect(sb.engine.events.queryAll().some((e) => n.every((x) => e.content.includes(x)) && /showmance/.test(e.content))).toBe(true);
    expect(sb.session.visibleShowmances()).toEqual([]);
    for (const [k, v] of Object.entries(surfaces(sb))) {
      expect(names(v, n), `${k} names the unseen pair`).toBe(false);
    }
    // and the event is the house's, not the player's: the player is not in its witness set
    const ev = sb.engine.events.queryAll().find((e) => n.every((x) => e.content.includes(x)))!;
    expect(ev.witnessSet.includes(PLAYER)).toBe(false);
    expect(pair.a).not.toBe(PLAYER);
  });

  it("after the player is IN a romance scene of the pair, the pair appears", () => {
    const { sb, pair, names: n } = gameWithASurfacedShowmance();
    sb.engine.events.record({ id: "g733-seen", ts: 999, type: "showmance", initiator: pair.a, witnessSet: [PLAYER, pair.a, pair.b], hidden: false, content: "scene" });
    expect(sb.session.visibleShowmances().length).toBe(1);
    const s = surfaces(sb);
    expect(s.state).toMatch(/"showmances"/);
    expect(names(s.moment!, n)).toBe(true);
    expect(s.moment).toMatch(/voice romance for THESE pairs only/);
  });

  it("after the player WATCHES the pair from the same room (seenBy), the pair appears", () => {
    const { sb, pair } = gameWithASurfacedShowmance();
    sb.engine.events.record({ id: "g733-watched", ts: 999, type: "showmance", initiator: pair.a, witnessSet: [pair.a, pair.b], hidden: true, content: "scene",
      houseLife: { action: "flirt", place: "kitchen", manner: "x", truthful: true, stretch: 1, seenBy: [PLAYER] } });
    expect(sb.session.visibleShowmances().length).toBe(1);
  });

  it("a romance scene somebody ELSE watched (not the player) does not list the pair", () => {
    const { sb, pair, names: n } = gameWithASurfacedShowmance();
    const other = sb.session.getGameState().house.find((h) => h.id !== pair.a && h.id !== pair.b && h.id !== PLAYER)!.id;
    sb.engine.events.record({ id: "g733-other", ts: 999, type: "showmance", initiator: pair.a, witnessSet: [pair.a, pair.b], hidden: true, content: "scene",
      houseLife: { action: "flirt", place: "kitchen", manner: "x", truthful: true, stretch: 1, seenBy: [other] } });
    expect(sb.session.visibleShowmances()).toEqual([]);
    expect(names(surfaces(sb).moment!, n)).toBe(false);
  });
});
