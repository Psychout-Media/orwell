import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import { roleEvidence, roleRead, ROLES, type RoleScene } from "../../src/engine/socialRoles";
import { planSpeech } from "../../src/engine/houseSpeech";
import { sayable } from "../../src/engine/claimsToPlayer";
import { recordClaim, type BeliefStore } from "../../src/engine/beliefStore";
import { underTest } from "../../src/engine/beliefConviction";
import { reputationNature } from "../../src/engine/spokenClaims";

/** 0184 part 2a (ORW-564): social roles, read from what each houseguest saw and was told, and voiced as gossip. Roles only (observer, subject, others). */
const O = "npc:o", S = "npc:s", A = "npc:a", B = "npc:b", X = "npc:x";
const sc = (type: string, initiator: string, people: string[], seenBy: string[] = []): RoleScene => ({ type, initiator, people, seenBy });
const read = (scenes: RoleScene[], humor = false, told = {}, standing = 1, floater = 0) => roleRead(roleEvidence(scenes, O, S, humor), standing, floater, told);

describe("0184 part 2a: roles emerge from what the observer saw", () => {
  it("villain: starts fights; peacemaker: brings both sides of a fight together; therapist: takes the one who got hit aside", () => {
    expect(read([sc("conflict", S, [S, A, O]), sc("conflict", S, [S, B, O]), sc("betrayal", S, [S, A, O])])).toBe("villain");
    const fight = sc("conflict", A, [A, B, O]);
    expect(read([fight, sc("bonding", S, [S, A, B, O]), fight, sc("bonding", S, [S, A, B], [O])])).toBe("peacemaker");
    expect(read([fight, sc("bonding", S, [S, B], [O]), fight, sc("bonding", S, [S, B], [O])])).toBe("therapist");
  });
  it("jokester needs a sense of humour; outcast is seen with almost nobody in a house the observer watched; snake and floater come from the observer's own reads", () => {
    const groups = [1, 2, 3].map(() => sc("bonding", S, [S, A, B, O]));
    expect(read(groups, true)).toBe("jokester");
    expect(read(groups, false)).toBeUndefined();
    const house = Array.from({ length: ROLES.outcastMinScenes }, () => sc("bonding", A, [A, B, O]));
    expect(read(house)).toBe("outcast");
    expect(read([], false, {}, 0.6)).toBe("snake");
    expect(read([], false, {}, 1, 0.9)).toBe("floater");
  });
  it("the read is the observer's OWN: scenes they neither were in nor saw do not count; told labels count at their confidence and can tip it", () => {
    const unseen = [sc("conflict", S, [S, A]), sc("conflict", S, [S, B]), sc("conflict", S, [S, X])];
    expect(read(unseen)).toBeUndefined();
    const two = [sc("conflict", S, [S, A, O]), sc("conflict", S, [S, B, O])];
    expect(read(two)).toBeUndefined();
    expect(read(two, false, { villain: 0.8 })).toBe("villain");
  });
});

describe("0184 part 2a: roles travel as gossip claims", () => {
  const facts = { goalAgainst: () => false, votedToEvict: () => false, votedToKeep: () => false, finalTwo: () => false, liedTo: () => false, talkedAbout: () => false, roleOf: (who: string) => (who === S ? "villain" : undefined) };
  it("asked what they know with nothing else to pass on, a houseguest says their read of someone's role; it is true only when the record supports it", () => {
    const c = planSpeech("fish", A, O, S, true, { living: [O, A, S], beliefs: {}, facts, roll: 0, roleOf: (h, x) => (h === O && x === S ? "villain" : undefined) })!;
    expect(c).toMatchObject({ speaker: O, listener: A, kind: "has-reputation", subject: S, label: "villain", isTrue: true });
    const wrong = planSpeech("fish", A, O, S, true, { living: [O, A, S], beliefs: {}, facts, roll: 0, roleOf: () => "peacemaker" })!;
    expect(wrong.isTrue).toBe(false);
    expect(planSpeech("fish", A, O, S, true, { living: [O, A, S], beliefs: {}, facts, roll: 0 })).toBeUndefined(); // no roleOf: byte-identical (nothing said)
    expect(planSpeech("leak", O, A, S, true, { living: [O, A, S], beliefs: {}, facts, roll: 0, roleOf: () => "villain" })).toBeUndefined(); // 0153: a leak never voices a role
  });
  it("a heard reputation can be passed to the player, about the player too ('everyone thinks you're the snake'); it is never a doubt to go and test", () => {
    const store: BeliefStore = {};
    recordClaim(store, { holder: O, kind: "heard-rumor", subject: PLAYER, value: true, origin: "told", source: A, nature: reputationNature("snake"), confidence: 0.6, week: 1 });
    const b = store[O]![0]!;
    expect(sayable(b, O, PLAYER)).toMatchObject({ kind: "has-reputation", subject: PLAYER, label: "snake" });
    expect(underTest(b)).toBe(false);
  });
});

describe("0184 part 2a in the live adapter", () => {
  type Seam = {
    live: { playedGame?: boolean; week: number; beliefs?: BeliefStore; pending?: unknown };
    record?: { events(): unknown[] };
    roleOf(o: string, s: string): string | undefined; reputationOf(o: string, s: string): number; setSocialRolesEnabled(on: boolean): void;
    tellClaim(c: { speaker: string; listener: string; kind: string; subject: string; label?: string; isTrue: boolean; intent: string }): unknown;
  };
  function setup(on = true) {
    const sb = new GameSessionRegistry().sandboxFor(`roles-${Math.random()}`);
    sb.session.createCharacter({ playerName: "The Player", archetype: "floater", seed: 64 });
    sb.session.advanceGame(); sb.session.advanceGame();
    const g = sb.session as unknown as Seam;
    g.setSocialRolesEnabled(on);
    g.live.playedGame = true; g.live.pending = undefined;
    const [o, s, a, b] = sb.session.livingIds().filter((i) => i !== PLAYER) as [string, string, string, string];
    return { g, o, s, a, b };
  }
  const fights = (s: string, o: string, a: string, b: string) => [0, 1, 2].map((i) => ({ id: `e${i}`, ts: i, type: "conflict", initiator: s, witnessSet: [s, i % 2 ? a : b, o], hidden: false, content: "" }));

  it("an observer who saw a houseguest start fights reads them as the villain; the player can be read the same way", () => {
    const { g, o, s, a, b } = setup();
    g.record = { events: () => [...fights(s, o, a, b), ...fights(PLAYER, o, a, b).map((e) => ({ ...e, id: `p${e.id}` }))] };
    expect(g.roleOf(o, s)).toBe("villain");
    expect(g.roleOf(o, PLAYER)).toBe("villain");
    expect(g.roleOf(PLAYER, s)).toBeUndefined(); // the read is per observer: this one was in none of those scenes
  });

  it("told 'snake' lowers the listener's standing of the subject (part 1 reads it)", () => {
    const { g, o, s, a } = setup();
    g.record = { events: () => [] };
    const before = g.reputationOf(a, s);
    g.tellClaim({ speaker: o, listener: a, kind: "has-reputation", subject: s, label: "snake", isTrue: false, intent: "inform" });
    expect(g.reputationOf(a, s)).toBeLessThan(before);
  });

  it("flag off: no role is read", () => {
    const { g, o, s, a, b } = setup(false);
    g.record = { events: () => fights(s, o, a, b) };
    expect(g.roleOf(o, s)).toBeUndefined();
  });
});

import { playMixGame } from "../support/houseMixDriver";
describe("0184 part 2a fires in a played game (the S-4 lesson: a built system must be seen to fire)", () => {
  it("a chat-paced played season produces reputation gossip between houseguests", async () => {
    let said = 0, labels = new Set<string>();
    await playMixGame(1, 1500, { advanceEvery: 6, inspect: (s) => {
      const items = (s as { live?: { claims?: { items: Array<{ kind: string; label?: string }> } } }).live?.claims?.items ?? [];
      for (const c of items) if (c.kind === "has-reputation") { said++; if (c.label) labels.add(c.label); }
    } });
    expect(said, "no reputation gossip in a played season").toBeGreaterThan(0);
    console.log(`ROLES gossip claims=${said} labels=${[...labels].sort().join(",")}`);
  }, 300_000);
});

