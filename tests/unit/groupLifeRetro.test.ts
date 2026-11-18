import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { GameSessionRegistry } from "../../src/composition/registry";
import type { AdvanceView } from "../../src/ports/GameSession";
import type { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { buildGroupLife, groupLifeLine, type GroupLifeRow } from "../../src/engine/groupLifeRetro";
import { pairKey } from "../../src/engine/groupIdentity";
import { readFileSync } from "node:fs";

/** ORW-566 part d / spec 0183: the retrospective's `groupLife`. Roles only. */
type Priv = {
  live: { playedGame?: boolean; dayNumber?: number; week: number; nameTickets?: Record<string, { kind: string; allianceId?: string }>; groupIdentity?: Record<string, Record<string, unknown>> };
  alliances: { add(n: string, f: string, m: string[], b: number): { id: string; name: string } };
  house: { npcs: Array<{ id: string }> };
  noteAllianceIdentity(id: string, name: string, founder: string): void;
};
function resolve(s: GameSessionAdapter, p: NonNullable<AdvanceView["pending"]>): void {
  if (p.kind === "nominations") s.submitDecision({ kind: "nominations", choice: [p.options[0]!.id, p.options[1]!.id] });
  else if (p.kind === "veto-decision") s.submitDecision({ kind: "veto-decision", use: false });
  else if (p.kind === "comp-intent") s.submitDecision({ kind: "comp-intent", intent: "compete" });
  else if (p.kind === "finale-statement") s.submitDecision({ kind: "finale-statement", statement: "x" });
  else if (p.kind === "finale-answer") s.submitDecision({ kind: "finale-answer", appeal: p.appeals![0]! });
  else if (p.options[0]) s.submitDecision({ kind: p.kind, vote: p.options[0].id, replacement: p.options[0].id } as never);
}
function playToEnd(s: GameSessionAdapter, seen?: unknown[]): void {
  for (let i = 0; i < 4000; i++) {
    const v = s.advanceGame();
    seen?.push(v);
    if (v.pending) resolve(s, v.pending);
    if (v.finished) return;
  }
  throw new Error("the season did not finish");
}
const SENTINEL = "Zzsentinel Lanterns";
function season(user: string, seed: number, flag = true) {
  const sb = new GameSessionRegistry().sandboxFor(user);
  sb.session.setGroupIdentityEnabled(flag);
  sb.session.createCharacter({ playerName: "The Player", seed });
  const p = sb.session as unknown as Priv;
  return { sb, s: sb.session as GameSessionAdapter, p };
}
const hash = (sb: ReturnType<typeof season>["sb"]): string =>
  createHash("sha256").update(sb.engine.events.queryAll().map((e) => `${e.type}|${e.initiator}|${e.hidden ? 1 : 0}|${e.content}`).join("\n")).digest("hex");

/** A hidden alliance with its sealed authored name, and a close pair's habit the player never saw. */
function stage(g: ReturnType<typeof season>) {
  g.p.live.playedGame = true;
  const ids = g.p.house.npcs.map((n) => n.id);
  const [a, b, c, d] = [ids[0]!, ids[1]!, ids[2]!, ids[3]!];
  const al = g.p.alliances.add("Stock Name", a, [a, b], 1);
  g.p.noteAllianceIdentity(al.id, al.name, a);
  g.p.live.groupIdentity![al.id]!["sealed"] = { name: SENTINEL, floor: al.name, authored: true };
  g.p.live.groupIdentity![pairKey(c, d)] = { kind: "debrief", spot: "the pantry nook", since: 0, week: g.p.live.week };
  g.p.live.playedGame = false; // the auto-driver cannot answer a played game's pendings; the gate is re-read at the crown
  return { al, a, b, c, d };
}

describe("groupLife (pure)", () => {
  const row = (o: Partial<GroupLifeRow>): GroupLifeRow => ({ kind: "alliance", members: ["x", "y"], youWere: false, youKnew: false, ...o });
  it("composes a floor line from names, the group's name, the room and the weeks; deterministic; absent when empty", () => {
    expect(buildGroupLife([])).toBeUndefined();
    const l = groupLifeLine(row({ name: "the Sentinels", formedWeek: 2, endedWeek: 4, endedHow: "it faded" }));
    expect(l).toContain("x and y");
    expect(l).toContain("the Sentinels");
    expect(l).toContain("week 2");
    expect(l).toContain("week 4");
    expect(l).toContain("you never knew");
    expect(groupLifeLine(row({ kind: "pair", spot: "the pantry", youKnew: true }))).toContain("in the pantry");
    const rows = [row({ formedWeek: 3 }), row({ formedWeek: 1, members: ["a", "b"] })];
    expect(JSON.stringify(buildGroupLife(rows))).toBe(JSON.stringify(buildGroupLife([...rows].reverse())));
    expect(buildGroupLife(rows)!.groups[0]!.formedWeek).toBe(1);
  });
});

describe("groupLife in a played season", () => {
  for (const seed of [3, 11]) {
    it(`seed ${seed}: nothing before the crown; after it the hidden alliance (sealed name, members) and the pair habit (spot) appear; no ids or decimals; deterministic`, () => {
      const on = season(`gl-on-${seed}`, seed);
      const g = stage(on);
      expect(on.s.seasonRetrospective(), "before the crown: nothing at all").toBeNull();
      const live: unknown[] = [on.s.groupsAwaitingWords()];
      playToEnd(on.s, live);
      on.p.live.playedGame = true;
      expect(JSON.stringify(live), "wall: the sealed name is in no live read").not.toContain("entinel");
      const r = on.s.seasonRetrospective()!;
      const gl = r.groupLife!;
      expect(gl).toBeDefined();
      const alliance = gl.groups.find((x) => x.kind === "alliance" && x.name === SENTINEL)!;
      expect(alliance, "the hidden alliance appears with its sealed name (the sanctioned unsealing)").toBeDefined();
      expect(alliance.members).toHaveLength(2);
      expect(alliance.knownAs).toBe("Stock Name");
      expect(alliance.youKnew).toBe(false);
      expect(alliance.line).toContain(SENTINEL);
      const pair = gl.groups.find((x) => x.kind === "pair")!;
      expect(pair.spot).toBe("the pantry nook");
      expect(pair.line).toContain("the pantry nook");
      const json = JSON.stringify(gl);
      expect(json).not.toMatch(/npc:\d/);
      expect(json).not.toContain(g.al.id);
      expect(json).not.toContain(pairKey(g.c, g.d));
      expect(json).not.toMatch(/\d\.\d/);
      expect(JSON.stringify(on.s.seasonRetrospective())).toBe(JSON.stringify(r));
    }, 180_000);

    it(`seed ${seed}: flag on vs off is byte-identical in the event record, and the retrospective is the same minus the field`, () => {
      const on = season(`gl-bi-on-${seed}`, seed), off = season(`gl-bi-off-${seed}`, seed, false);
      playToEnd(on.s); playToEnd(off.s);
      on.p.live.playedGame = true; off.p.live.playedGame = true;
      expect(hash(on.sb)).toBe(hash(off.sb));
      const { groupLife: _g, ...rest } = on.s.seasonRetrospective()!; void _g;
      expect(JSON.stringify(off.s.seasonRetrospective())).toBe(JSON.stringify(rest));
      expect(off.s.seasonRetrospective()!.groupLife).toBeUndefined();
    }, 180_000);
  }

  it("a headless season carries no groupLife", () => {
    const sb = new GameSessionRegistry().sandboxFor("gl-headless");
    sb.session.createCharacter({ playerName: "The Player", seed: 3 });
    playToEnd(sb.session as GameSessionAdapter);
    expect(sb.session.seasonRetrospective()!.groupLife).toBeUndefined();
  }, 120_000);

  it("the rules ride the post-season moment fragment, not the base prompt, and the FE renders the field", () => {
    expect(readFileSync("src/engine/momentPrompts.ts", "utf8")).toContain("seasonRetrospective carries `groupLife`");
    expect(readFileSync("frontend/static/js/orwellRetrospective.js", "utf8")).toContain("unsealed.groupLife");
  });
});
