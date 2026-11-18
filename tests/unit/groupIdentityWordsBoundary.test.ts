import { describe, it, expect } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { EngineCommandsAdapter } from "../../src/adapters/engine/EngineCommandsAdapter";
import { McpServer } from "../../src/adapters/mcp/McpServer";
import { PLAYER_TOOLS, PLAYER_AGENT_LEVERS } from "../../src/surfaces/tools/registry";
import { validateGroupIdentity, noteWords, pairKey } from "../../src/engine/groupIdentity";
import { buildSandbox } from "../support/sandbox";
import { PLAYER } from "../../src/domain/ids";

/**
 * ORW-566 part c (spec 0183): the model's words for a group reach the engine through the MCP boundary (a write-back missing its McpServer case is dead
 * at runtime), the engine validates them, keeps the first record per group (write-once), may rename a hidden alliance once, and none of it reaches a
 * player surface. Roles only.
 */
type Priv = {
  live: { playedGame?: boolean; groupIdentity?: Record<string, { kind: string; spot?: string; since: number; seen?: boolean; words?: Record<string, string> }> };
  alliances: { add(n: string, f: string, m: string[], b: number): { id: string }; byId(id: string): { name: string; knownTo: string[] } | undefined; history(): ReadonlyArray<{ name: string; kind: string }> };
};
const reveal = (p: Priv, id: string): void => { p.alliances.byId(id)!.knownTo.push(PLAYER); };
function played(seed = 9): { server: McpServer; session: GameSessionAdapter; p: Priv; npcs: string[] } {
  const sb = buildSandbox(1);
  const session = new GameSessionAdapter();
  const commands = new EngineCommandsAdapter(sb.engine.events, sb.engine.knowledge);
  const server = new McpServer("player", { player: sb.player, admin: sb.admin, summary: sb.summary, commands, session });
  session.createCharacter({ playerName: "The Player", seed });
  session.noteMessage({ messageId: "m1" });
  const npcs = session.livingIds().filter((i) => i !== PLAYER);
  return { server, session, p: session as unknown as Priv, npcs };
}

describe("the four-place wiring", () => {
  it("both are player-channel infra (FE-driven, not model levers)", () => {
    const names = PLAYER_TOOLS.map((t) => t.name);
    for (const t of ["recordGroupIdentity", "groupsAwaitingWords"]) {
      expect(names).toContain(t);
      expect(PLAYER_AGENT_LEVERS, "infra, so not in the model's lever manifest").not.toContain(t);
    }
  });
});

describe("validateGroupIdentity", () => {
  it("keeps clean text, drops engine ids and digit-heavy text, and refuses nothing-usable", () => {
    expect(validateGroupIdentity({ name: "  The   Porch  Crowd ", ritual: "npc:3 does it", signal: "a double knock", insideJoke: "call 5551234 now" })).toEqual({ name: "The Porch Crowd", signal: "a double knock" });
    expect(validateGroupIdentity({ name: "npc:4" })).toBeUndefined();
    expect(validateGroupIdentity("text")).toBeUndefined();
    expect(validateGroupIdentity({ name: 7 })).toBeUndefined();
  });
  it("noteWords is write-once and keeps the floor already stored", () => {
    const store: Record<string, { kind: "alliance"; since: number; spot?: string; words?: { name?: string } }> = { g: { kind: "alliance", since: 2, spot: "the Deck" } };
    expect(noteWords(store as never, "g", "alliance", { name: "A" }, 5)).toBe(true);
    expect(noteWords(store as never, "g", "alliance", { name: "B" }, 6)).toBe(false);
    expect(store["g"]).toEqual({ kind: "alliance", since: 2, spot: "the Deck", words: { name: "A" } });
  });
});

describe("recordGroupIdentity through callTool", () => {
  it("renames a hidden alliance once, keeps the old name in history, and is write-once", async () => {
    const { server, p, npcs } = played();
    const a = p.alliances.add("Stock Name", npcs[0]!, [npcs[0]!, npcs[1]!], 1);
    reveal(p, a.id);
    const waiting = await server.callTool("groupsAwaitingWords", {}) as Array<{ groupId: string; kind: string; members: string[] }>;
    expect(waiting.map((w) => w.groupId)).toContain(a.id);
    const res = await server.callTool("recordGroupIdentity", { groupId: a.id, name: "The Porch Crowd", ritual: "a quiet check-in", signal: "two taps on the table", insideJoke: "the great toast heist" });
    expect(res).toEqual({ accepted: true });
    expect(p.alliances.byId(a.id)!.name).toBe("The Porch Crowd");
    expect(p.alliances.history().some((h) => h.kind === "formed" && h.name === "Stock Name")).toBe(true);
    expect(await server.callTool("recordGroupIdentity", { groupId: a.id, name: "Another" })).toEqual({ accepted: false, reason: "frozen" });
    expect(p.alliances.byId(a.id)!.name).toBe("The Porch Crowd");
    const after = await server.callTool("groupsAwaitingWords", {}) as Array<{ groupId: string }>;
    expect(after.map((w) => w.groupId)).not.toContain(a.id);
  });

  it("drops a colliding name but keeps the other words; never collides with another alliance", async () => {
    const { server, p, npcs } = played();
    p.alliances.add("Taken Name", npcs[2]!, [npcs[2]!, npcs[3]!], 1);
    const b = p.alliances.add("Second", npcs[0]!, [npcs[0]!, npcs[1]!], 1);
    reveal(p, b.id);
    expect(await server.callTool("recordGroupIdentity", { groupId: b.id, name: "the taken name", signal: "a wink" })).toEqual({ accepted: true });
    expect(p.alliances.byId(b.id)!.name).toBe("Second");
    expect(p.live.groupIdentity![b.id]!.words).toEqual({ signal: "a wink" });
  });

  it("Vault Wall ruling: a hidden alliance is never listed or accepted; it appears only once the player learns of it", async () => {
    const { server, p, npcs } = played();
    const h = p.alliances.add("Hidden Pact", npcs[0]!, [npcs[0]!, npcs[1]!], 1);
    const listed = await server.callTool("groupsAwaitingWords", {});
    expect(listed).toEqual([]);
    expect(JSON.stringify(listed)).not.toContain(npcs[0]!);
    expect(await server.callTool("recordGroupIdentity", { groupId: h.id, name: "Early Crew", signal: "a nod" })).toEqual({ accepted: false, reason: "unknown-group" });
    expect(p.alliances.byId(h.id)!.name).toBe("Hidden Pact");
    reveal(p, h.id);
    const after = await server.callTool("groupsAwaitingWords", {}) as Array<{ groupId: string; members: string[] }>;
    expect(after.map((w) => w.groupId)).toEqual([h.id]);
    expect(await server.callTool("recordGroupIdentity", { groupId: h.id, name: "Early Crew", signal: "a nod" })).toEqual({ accepted: true });
    expect(p.alliances.byId(h.id)!.name).toBe("Early Crew");
  });

  it("the player's own alliance is never listed (the narrator names it)", async () => {
    const { server, p, npcs } = played();
    const own = p.alliances.add("Mine", npcs[0]!, [npcs[0]!, PLAYER], 1);
    reveal(p, own.id);
    expect(await server.callTool("groupsAwaitingWords", {})).toEqual([]);
  });

  it("a close pair's group key takes words once", async () => {
    const { server, p, npcs } = played();
    const key = pairKey(npcs[0]!, npcs[1]!);
    (p.live.groupIdentity ??= {})[key] = { kind: "debrief", spot: "the Deck", since: 1 };
    expect(await server.callTool("groupsAwaitingWords", {}), "an unseen habit is never listed").toEqual([]);
    expect(await server.callTool("recordGroupIdentity", { groupId: key, ritual: "too early" })).toEqual({ accepted: false, reason: "unknown-group" });
    p.live.groupIdentity[key]!.seen = true;
    const waiting = await server.callTool("groupsAwaitingWords", {}) as Array<{ groupId: string; kind: string; members: string[]; spot?: string }>;
    expect(waiting).toMatchObject([{ groupId: key, kind: "pair", members: key.split("|"), spot: "the Deck" }]);
    expect(await server.callTool("recordGroupIdentity", { groupId: key, ritual: "a slow walk and a whisper" })).toEqual({ accepted: true });
    expect(await server.callTool("recordGroupIdentity", { groupId: key, ritual: "different" })).toEqual({ accepted: false, reason: "frozen" });
    expect(p.live.groupIdentity![key]).toMatchObject({ kind: "debrief", spot: "the Deck", since: 1, words: { ritual: "a slow walk and a whisper" } });
  });

  it("a habit scene marks the pair as seen only when the player was in that room", () => {
    const { session, p, npcs } = played();
    const priv = session as unknown as { noteHabitScene(a: unknown, e: unknown): void; presence: Map<string, string>; house: { player: { id: string } } };
    const mk = (habit: string, place: string) => ({ habit, place, actor: npcs[0], with: [npcs[1]] });
    priv.presence.set(priv.house.player.id, "kitchen");
    priv.noteHabitScene(mk("seen|pair", "kitchen"), { houseLife: {} });
    priv.noteHabitScene(mk("unseen|pair", "backyard"), { houseLife: {} });
    expect(p.live.groupIdentity!["seen|pair"]!.seen).toBe(true);
    expect(p.live.groupIdentity!["unseen|pair"]!.seen).toBeUndefined();
  });

  it("rejects id-bearing and digit-heavy text, an unknown group, a wrong shape, and the flag off", async () => {
    const { server, session, p, npcs } = played();
    const a = p.alliances.add("Stock", npcs[0]!, [npcs[0]!, npcs[1]!], 1);
    reveal(p, a.id);
    expect(await server.callTool("recordGroupIdentity", { groupId: a.id, name: "npc:3 and friends", ritual: "meet at 1234567" })).toEqual({ accepted: false, reason: "invalid" });
    expect(await server.callTool("recordGroupIdentity", { groupId: "alliance:99", name: "Ghost Crew" })).toEqual({ accepted: false, reason: "unknown-group" });
    await expect(server.callTool("recordGroupIdentity", { name: "no id" })).rejects.toThrow();
    await expect(server.callTool("recordGroupIdentity", { groupId: a.id, name: 5 })).rejects.toThrow();
    session.setGroupIdentityEnabled(false);
    expect(await server.callTool("recordGroupIdentity", { groupId: a.id, name: "Off Crew" })).toEqual({ accepted: false, reason: "off" });
    expect(await server.callTool("groupsAwaitingWords", {})).toEqual([]);
  });

  it("is refused before a game exists", async () => {
    const sb = buildSandbox(1);
    const session = new GameSessionAdapter();
    const commands = new EngineCommandsAdapter(sb.engine.events, sb.engine.knowledge);
    const server = new McpServer("player", { player: sb.player, admin: sb.admin, summary: sb.summary, commands, session });
    expect(await server.callTool("recordGroupIdentity", { groupId: "alliance:1", name: "Early Crew" })).toEqual({ accepted: false, reason: "no-game" });
  });
});

describe("the wall: the authored words never reach a player or admin read", () => {
  it("a sentinel in the words is absent from every projection", async () => {
    const { server, p, npcs } = played();
    const a = p.alliances.add("Stock", npcs[0]!, [npcs[0]!, npcs[1]!], 1);
    reveal(p, a.id);
    await server.callTool("recordGroupIdentity", { groupId: a.id, ritual: "zzsentinelritualzz", signal: "zzsentinelsignalzz", insideJoke: "zzsentineljokezz" });
    for (const tool of ["getGameState", "gameStatus", "whereabouts", "socialRead", "recallSceneMemories"]) {
      let r: unknown;
      try { r = await server.callTool(tool, {}); } catch (e) { r = String(e); }
      expect(JSON.stringify(r ?? null), tool).not.toContain("zzsentinel");
    }
    const prompt = JSON.stringify(await server.callTool("getMomentPrompt", { kind: "free-play" }).catch((e) => String(e)));
    expect(prompt).not.toContain("zzsentinel");
    expect(JSON.stringify(p.live.groupIdentity)).toContain("zzsentinel");
  });
});
