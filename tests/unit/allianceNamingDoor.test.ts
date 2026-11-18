import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { EngineCommandsAdapter } from "../../src/adapters/engine/EngineCommandsAdapter";
import { McpServer } from "../../src/adapters/mcp/McpServer";
import { PLAYER_TOOLS, PLAYER_AGENT_LEVERS } from "../../src/surfaces/tools/registry";
import { ALLIANCE_NAMING, NAME_RULES, sharedAnonymousTraits, traitCounts, validateAllianceName, issueNightBatch, jointCarriers } from "../../src/engine/allianceNaming";
import { allianceNameFromHouse } from "../../src/engine/groupIdentity";
import { buildSandbox } from "../support/sandbox";
import { PLAYER } from "../../src/domain/ids";

/**
 * ORW-566 part c2 (spec 0183): formation-time alliance naming through the anonymized sealed-prompt door. Each of the Auditor's seven wall conditions
 * has its own test below (named C1..C7). Roles only.
 */
type Ticket = { kind: "real" | "decoy"; allianceId?: string; issuedNight: number; prompt: string };
type Priv = {
  live: { playedGame?: boolean; dayNumber?: number; week: number; nameTickets?: Record<string, Ticket>; namePending?: string[]; nameNight?: number; groupIdentity?: Record<string, { sealed?: { name: string; floor: string; authored: boolean }; words?: unknown }>; npcMindsAuthored?: { culture?: unknown } };
  alliances: { add(n: string, f: string, m: string[], b: number): { id: string; name: string }; byId(id: string): { name: string; members: string[]; knownTo: string[] } | undefined; history(): ReadonlyArray<{ name: string; kind: string }> };
  house: { npcs: Array<{ id: string; character: Record<string, unknown> }> };
  noteAllianceIdentity(id: string, name: string, founder: string): void;
};
function played(seed = 9) {
  const sb = buildSandbox(1);
  const session = new GameSessionAdapter();
  const commands = new EngineCommandsAdapter(sb.engine.events, sb.engine.knowledge);
  const server = new McpServer("player", { player: sb.player, admin: sb.admin, summary: sb.summary, commands, session });
  const admin = new McpServer("admin/God Mode", { player: sb.player, admin: sb.admin, summary: sb.summary, commands, session });
  session.createCharacter({ playerName: "The Player", seed });
  session.noteMessage({ messageId: "m1" });
  const npcs = session.livingIds().filter((i) => i !== PLAYER);
  const p = session as unknown as Priv;
  /** Form an NPC alliance the way the society does: the record, then the formation hook that gives it its secret floor name. */
  const form = (members: string[], name = `Stock ${members.join("")}`) => {
    const a = p.alliances.add(name, members[0]!, members, 1);
    p.noteAllianceIdentity(a.id, a.name, members[0]!);
    return a;
  };
  const night = () => { p.live.dayNumber = (p.live.dayNumber ?? p.live.week) + 1; session.settleOvernight(1); };
  type Out = Array<{ ticket: string; prompt: string }>;
  const read = async (): Promise<Out> => (await server.callTool("allianceNameTickets", {})) as Out;
  const realTicket = (id: string): string => Object.entries(p.live.nameTickets ?? {}).find(([, t]) => t.kind === "real" && t.allianceId === id)![0];
  const decoyTicket = (): string => Object.entries(p.live.nameTickets ?? {}).find(([, t]) => t.kind === "decoy")![0];
  return { server, admin, session, p, npcs, form, night, read, realTicket, decoyTicket };
}

describe("the wiring (C7 channel)", () => {
  it("C7: both are FE-driven infra (player channel, out of the model lever manifest, in INFRA_LEVERS) and dispatch through McpServer.callTool", async () => {
    const names = PLAYER_TOOLS.map((t) => t.name);
    for (const t of ["recordAllianceName", "allianceNameTickets"]) {
      expect(names).toContain(t);
      expect(PLAYER_AGENT_LEVERS, "infra, not a model lever").not.toContain(t);
      expect(readFileSync("src/surfaces/tools/registry.ts", "utf8")).toMatch(new RegExp(`INFRA_LEVERS[^]*"${t}",`));
      expect(PLAYER_TOOLS.find((x) => x.name === t)!.readsVault).toBe(false);
    }
    const { server, form, npcs, night } = played();
    form([npcs[0]!, npcs[1]!]);
    night();
    const tickets = (await server.callTool("allianceNameTickets", {})) as Array<{ ticket: string }>;
    expect(tickets).toHaveLength(ALLIANCE_NAMING.batch);
    expect(await server.callTool("recordAllianceName", { ticket: tickets[0]!.ticket, name: "A Quiet Table" })).toEqual({ accepted: true });
    await expect(server.callTool("recordAllianceName", { name: "no ticket" })).rejects.toThrow();
    await expect(server.callTool("recordAllianceName", { ticket: "nt-1", name: 5 })).rejects.toThrow();
  });
});

describe("C1: nothing identifying in the payload (k-anonymity floor)", () => {
  it("C1: a sentinel pair with a unique shared trait gets a prompt WITHOUT that trait, and no id, name, count, room or day", async () => {
    const { p, npcs, form, night, read, server } = played();
    const [a, b] = [npcs[0]!, npcs[1]!];
    for (const id of [a, b]) {
      const c = p.house.npcs.find((n) => n.id === id)!.character;
      c["hometown"] = "Sentinelville, ZZ"; c["demeanor"] = "zzuniquedemeanorzz"; c["vocation"] = "zzuniquevocationzz";
    }
    const al = form([a, b]);
    night();
    const real = Object.values(p.live.nameTickets!).find((t) => t.kind === "real" && t.allianceId === al.id)!;
    for (const needle of ["Sentinelville", "ZZ", "zzuniquedemeanorzz", "zzuniquevocationzz"]) expect(real.prompt, needle).not.toContain(needle);
    const wire = JSON.stringify(await read());
    for (const id of npcs) expect(wire, id).not.toContain(id);
    expect(wire).not.toContain(PLAYER);
    expect(wire).not.toContain(al.id);
    expect(wire).not.toContain(al.name);
    for (const n of p.house.npcs) for (const w of String((n.character as { name?: string }).name ?? "").split(/\s+/).filter((x) => x.length > 2)) expect(wire).not.toContain(w);
    const data = (await read()).map((o) => o.prompt.split("\n")[1]).join(" ");
    expect(data, "the data line carries no member count, room or day").not.toMatch(/member|room|day \d|week \d|alliance|group/i);
    // positive control, pure: the same trait shared by enough living houseguests DOES pass the floor
    const table = new Map<string, string[]>([["m1", ["shared", "rare"]], ["m2", ["shared", "rare"]], ["x1", ["shared"]], ["x2", ["shared"]]]);
    expect(sharedAnonymousTraits(["m1", "m2"], table, traitCounts(table))).toEqual(["shared"]);
    expect(await server.callTool("groupsAwaitingWords", {})).toEqual([]);
  });

  it("C1: every trait in every prompt is shared by at least the floor of living houseguests", () => {
    const table = new Map<string, string[]>();
    for (let i = 0; i < 12; i++) table.set(`h${i}`, [`all`, i < 6 ? "half" : "other", `solo${i}`]);
    const out = issueNightBatch({ seed: 5, night: 2, pending: [{ id: "g", members: ["h0", "h1", "h2"] }], table, culture: undefined });
    const counts = traitCounts(table);
    for (const t of Object.values(out)) {
      const traits = (JSON.parse(t.prompt.split("\n")[1]!) as { sharedTraits: string[] }).sharedTraits;
      for (const tr of traits) expect(counts.get(tr)!, tr).toBeGreaterThanOrEqual(ALLIANCE_NAMING.decoyMinMembers + ALLIANCE_NAMING.floorExtra);
      expect(traits.some((x) => x.startsWith("solo"))).toBe(false);
    }
  });
});

describe("C1 (ORW-684): the floor holds for the traits TOGETHER", () => {
  // Each trait passes the per-trait floor alone, but the three the members share are carried together by exactly the members: intersecting the prompt's traits names the group.
  const table = (): Map<string, string[]> => {
    const t = new Map<string, string[]>();
    for (let i = 0; i < 16; i++) t.set(`h${i}`, []);
    const give = (trait: string, ids: number[]) => ids.forEach((i) => t.get(`h${i}`)!.push(trait));
    give("t0", [0, 1, 2, 3, 4, 5, 6]); give("t1", [0, 1, 2, 7, 8, 9, 10]); give("t2", [0, 1, 2, 11, 12, 13, 14]);
    give("t3", [3, 4, 5, 6, 7, 8, 9]); give("t4", [10, 11, 12, 13, 14, 15, 3]); give("t5", [0, 5, 9, 12, 14, 15, 2]);
    return t;
  };
  it("C1: no prompt's traits can be intersected down below the floor (real or decoy), and every ticket carries the same number of traits", () => {
    const tbl = table();
    for (const night of [2, 3, 4, 5, 6]) for (const pending of [[], [{ id: "g", members: ["h0", "h1", "h2"] }]]) {
      const out = Object.values(issueNightBatch({ seed: 5, night, pending, table: tbl, culture: undefined }));
      const shown = out.map((t) => (JSON.parse(t.prompt.split("\n")[1]!) as { sharedTraits: string[] }).sharedTraits);
      for (const [i, t] of out.entries()) {
        const floor = t.kind === "real" ? 3 + ALLIANCE_NAMING.floorExtra : ALLIANCE_NAMING.decoyMinMembers + ALLIANCE_NAMING.floorExtra;
        expect(jointCarriers(tbl, shown[i]!), `${t.kind} ${shown[i]}`).toBeGreaterThanOrEqual(floor);
      }
      expect(new Set(shown.map((x) => x.length)).size).toBe(1);
      // the count does not depend on what formed: the same night with and without a group shows the same number of traits
      expect(shown[0]!.length).toBe((JSON.parse(Object.values(issueNightBatch({ seed: 5, night, pending: [], table: tbl, culture: undefined }))[0]!.prompt.split("\n")[1]!) as { sharedTraits: string[] }).sharedTraits.length);
    }
  });
});

describe("C2: no timing or count side channel", () => {
  it("C2: the read has the identical shape on a night with zero, one and several new alliances", async () => {
    const shape = async (formed: number) => {
      const g = played(9);
      for (let i = 0; i < formed; i++) g.form([g.npcs[i * 2]!, g.npcs[i * 2 + 1]!]);
      g.night();
      const out = await g.read();
      return {
        n: out.length,
        keys: out.map((o) => Object.keys(o).sort().join(",")),
        ids: out.map((o) => /^nt-[0-9a-f]{24}$/.test(o.ticket)),
        rules: out.map((o) => o.prompt.split("\n")[0] === NAME_RULES),
        traitCounts: out.map((o) => (JSON.parse(o.prompt.split("\n")[1]!) as { sharedTraits: string[] }).sharedTraits.length),
        promptKeys: out.map((o) => Object.keys(JSON.parse(o.prompt.split("\n")[1]!)).join(",")),
      };
    };
    const zero = await shape(0);
    expect(zero.n).toBe(ALLIANCE_NAMING.batch);
    expect(await shape(1)).toEqual(zero);
    expect(await shape(3)).toEqual(zero);
    expect(new Set(zero.traitCounts).size, "every ticket carries the same number of traits").toBe(1);
  });

  it("C2: a fixed cadence: one batch per in-game night, never more, and more real alliances than slots wait for the next night", async () => {
    const g = played(9);
    for (let i = 0; i < 5; i++) g.form([g.npcs[i * 2]!, g.npcs[i * 2 + 1]!]);
    g.night();
    const first = await g.read();
    expect(first).toHaveLength(ALLIANCE_NAMING.batch);
    g.session.settleOvernight(1); // same night again: no re-issue
    expect(await g.read()).toEqual(first);
    const realNow = Object.values(g.p.live.nameTickets!).filter((t) => t.kind === "real").map((t) => t.allianceId!);
    expect(realNow).toHaveLength(ALLIANCE_NAMING.batch);
    for (const f of first) await g.server.callTool("recordAllianceName", { ticket: f.ticket, name: "Quiet Porch Table" });
    expect(await g.read()).toEqual([]);
    g.night();
    const second = await g.read();
    expect(second).toHaveLength(ALLIANCE_NAMING.batch);
    const realNext = Object.values(g.p.live.nameTickets!).filter((t) => t.kind === "real").map((t) => t.allianceId!);
    expect(realNext.sort()).toEqual(g.p.live.namePending!.slice().sort().slice(0, realNext.length));
    expect(realNext.every((id) => !realNow.includes(id) || g.p.live.groupIdentity![id]!.sealed!.authored === false)).toBe(true);
    expect(realNext).toHaveLength(2); // the two that waited
  });

  it("C2: the batch is keyed hashing only: it never draws the shared rng and replays byte-identically", () => {
    const a = played(9); const b = played(9);
    for (const g of [a, b]) { g.form([g.npcs[0]!, g.npcs[1]!]); g.night(); }
    expect(JSON.stringify(a.p.live.nameTickets)).toBe(JSON.stringify(b.p.live.nameTickets));
  });
});

describe("C3: one-way, single-use ticket and a bare receipt", () => {
  it("C3: real and decoy get the identical receipt; a decoy write changes nothing; an unknown or used ticket is just {accepted:false}", async () => {
    const { server, p, npcs, form, night, realTicket, decoyTicket } = played();
    const al = form([npcs[0]!, npcs[1]!]);
    night();
    const before = JSON.stringify(p.live.groupIdentity);
    const decoyRes = await server.callTool("recordAllianceName", { ticket: decoyTicket(), name: "Lantern Lane Society" });
    expect(JSON.stringify(p.live.groupIdentity), "a decoy's write-back is discarded").toBe(before);
    const real = realTicket(al.id);
    const realRes = await server.callTool("recordAllianceName", { ticket: real, name: "Lantern Lane Society" });
    expect(realRes).toEqual({ accepted: true });
    expect(decoyRes).toEqual(realRes);
    expect(await server.callTool("recordAllianceName", { ticket: real, name: "Again" })).toEqual({ accepted: false });
    expect(await server.callTool("recordAllianceName", { ticket: "nt-doesnotexist", name: "Whatever Name" })).toEqual({ accepted: false });
    expect(JSON.stringify(await server.callTool("recordAllianceName", { ticket: "x", name: "y" }))).not.toMatch(/reason|unknown|used|decoy|real/i);
    expect(p.live.groupIdentity![al.id]!.sealed).toMatchObject({ name: "Lantern Lane Society", authored: true });
  });

  it("C3: a ticket carries no alliance in its text, and write-once per alliance holds", async () => {
    const { server, p, npcs, form, night, realTicket, read } = played();
    const al = form([npcs[0]!, npcs[1]!]);
    night();
    const wire = JSON.stringify(await read());
    expect(wire).not.toContain(al.id);
    const real = realTicket(al.id);
    await server.callTool("recordAllianceName", { ticket: real, name: "First Chosen Name" });
    night();
    // the alliance is no longer pending, so it never appears as a real ticket again
    expect(Object.values(p.live.nameTickets!).some((t) => t.allianceId === al.id)).toBe(false);
    expect(p.live.groupIdentity![al.id]!.sealed!.name).toBe("First Chosen Name");
    // a stale ticket from the previous night lapsed
    expect(await server.callTool("recordAllianceName", { ticket: real, name: "Second Name" })).toEqual({ accepted: false });
  });
});

describe("C4: validation engine-side", () => {
  it("C4: refuses a houseguest's name (any houseguest), a collision with another alliance, bad text and bad lengths; the floor stands", async () => {
    const { server, p, npcs, form, night, realTicket, session } = played();
    const outsider = (session as unknown as { nameOf(id: string): string }).nameOf(npcs[7]!).split(/\s+/)[0]!;
    const other = form([npcs[2]!, npcs[3]!], "Other Pact");
    const al = form([npcs[0]!, npcs[1]!]);
    const floor = al.name;
    const attempt = async (name: unknown): Promise<string> => {
      if (!(p.live.namePending ??= []).includes(al.id)) p.live.namePending.push(al.id); // the previous try consumed its pending slot: re-queue it
      night(); // a fresh batch each try
      const t = realTicket(al.id);
      expect(await server.callTool("recordAllianceName", { ticket: t, name })).toEqual({ accepted: true });
      return p.live.groupIdentity![al.id]!.sealed!.name;
    };
    expect(await attempt(`The ${outsider} Crew`), "a non-member houseguest's name").toBe(floor);
    expect(await attempt("the other pact"), "collides with another alliance").toBe(floor);
    expect(await attempt("npc:5 Crew"), "an engine id").toBe(floor);
    expect(await attempt("Crew 12345"), "digits").toBe(floor);
    expect(await attempt("Hi"), "too short").toBe(floor);
    expect(await attempt("x".repeat(80)), "too long").toBe(floor);
    expect(await attempt("One two three four five six"), "too many words").toBe(floor);
    expect(p.live.groupIdentity![al.id]!.sealed!.authored).toBe(false);
    expect(other.name).toBe("Other Pact");
    expect(validateAllianceName("Porch Lantern Society", { peopleWords: new Set(), takenNorm: new Set() })).toBe("Porch Lantern Society");
    expect(validateAllianceName("\"Porch Lantern Society\"", { peopleWords: new Set(), takenNorm: new Set() })).toBe("Porch Lantern Society");
    expect(await attempt("Porch Lantern Society"), "a clean name lands once").toBe("Porch Lantern Society");
  });
});

describe("C5: the name is secret content", () => {
  it("C5: a sentinel name is stored engine-side and is absent from every player and admin read, tool result and prompt", async () => {
    const { server, admin, p, npcs, form, night, realTicket, read } = played();
    const al = form([npcs[0]!, npcs[1]!]);
    p.alliances.byId(al.id)!.knownTo.push(PLAYER); // the strongest case: the player even knows the alliance exists
    night();
    const receipt = await server.callTool("recordAllianceName", { ticket: realTicket(al.id), name: "Zzsentinel Lanterns" });
    expect(JSON.stringify(receipt)).not.toContain("entinel");
    const surfaces: unknown[] = [receipt, await read(), await server.callTool("groupsAwaitingWords", {})];
    for (const tool of ["getGameState", "gameStatus", "whereabouts", "socialRead", "recallSceneMemories", "seasonRecap", "seasonRetrospective", "stateDelta", "playerDossier"]) {
      try { surfaces.push(await server.callTool(tool, {})); } catch (e) { surfaces.push(String(e)); }
    }
    surfaces.push(await server.callTool("getMomentPrompt", {}).catch((e) => String(e)));
    surfaces.push(await admin.callTool("inspectNonVaultState", {}));
    expect(JSON.stringify(surfaces)).not.toContain("entinel");
    expect(JSON.stringify(p.live.groupIdentity), "positive control: the engine's own record holds it").toContain("Zzsentinel Lanterns");
    expect(p.alliances.byId(al.id)!.name, "the alliance's displayed name is untouched").toBe(al.name);
  });
});

describe("C6: the floor", () => {
  it("C6: with no model every alliance still has a name from formation, composed by the existing floor; nothing is invented later", async () => {
    const { p, npcs, form, night, session } = played();
    const culture = { spots: [{ room: "backyard", nickname: "the Fishbowl" }], rituals: [] };
    (p.live.npcMindsAuthored ??= {}).culture = culture as never;
    const al = form([npcs[0]!, npcs[1]!]);
    expect(p.live.groupIdentity![al.id]!.sealed).toEqual({ name: al.name, floor: al.name, authored: false });
    night(); night(); night(); // nobody answers any ticket
    expect(p.live.groupIdentity![al.id]!.sealed).toEqual({ name: al.name, floor: al.name, authored: false });
    expect(session.allianceNameTickets()).toHaveLength(ALLIANCE_NAMING.batch);
    // the floor is the existing composed one: a house name when the house has authored words
    expect(allianceNameFromHouse(1, "k", culture as never, "backyard", new Set())?.name).toBe("the Fishbowl");
  });

  it("C6: the formation hook is wired at both NPC formation sites and gives every NPC alliance a secret name", () => {
    const src = readFileSync("src/adapters/engine/GameSessionAdapter.ts", "utf8");
    expect((src.match(/this\.noteAllianceIdentity\(/g) ?? []).length).toBe(4); // the NPC formation sites: the founder loop and the pull-them-in goal, plus the two slice-6 formation sites (the shadow group and a cracked alliance's cutters, 0172); the definition is `private noteAllianceIdentity(`
    expect(src).toContain("s.namePending");
  });
});

describe("flag off and headless", () => {
  it("flag off: no tickets, no state, a write-back refused; a game nobody plays is untouched", async () => {
    const g = played();
    g.session.setGroupIdentityEnabled(false);
    g.form([g.npcs[0]!, g.npcs[1]!]);
    g.night();
    expect(await g.read()).toEqual([]);
    expect(g.p.live.nameTickets).toBeUndefined();
    expect(g.p.live.namePending).toBeUndefined();
    expect(await g.server.callTool("recordAllianceName", { ticket: "nt-x", name: "Any Name" })).toEqual({ accepted: false });
    const h = played();
    h.p.live.playedGame = false;
    h.form([h.npcs[0]!, h.npcs[1]!]);
    h.night();
    expect(await h.read()).toEqual([]);
    expect(h.p.live.nameTickets).toBeUndefined();
  });

  it("is refused before a game exists", async () => {
    const sb = buildSandbox(1);
    const session = new GameSessionAdapter();
    const commands = new EngineCommandsAdapter(sb.engine.events, sb.engine.knowledge);
    const server = new McpServer("player", { player: sb.player, admin: sb.admin, summary: sb.summary, commands, session });
    expect(await server.callTool("allianceNameTickets", {})).toEqual([]);
    expect(await server.callTool("recordAllianceName", { ticket: "nt-x", name: "Any Name" })).toEqual({ accepted: false });
  });
});

describe("the prompt states rules, not samples", () => {
  it("has no example name, no 'e.g.', no 'for example', no 'such as', no quoted word list", () => {
    const text = NAME_RULES;
    expect(text).not.toMatch(/e\.g\.|for example|such as|for instance|like "/i);
    expect(text).not.toMatch(/["“][^"”]+["”]/);
    expect(text).not.toMatch(/\b\w+, \w+, (or|and) \w+\b.*:/);
  });
});
