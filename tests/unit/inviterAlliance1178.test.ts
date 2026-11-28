import { describe, it, expect } from "vitest";
import { composeRuntime } from "../../src/composition/runtime";
import { FakeClock } from "../../src/adapters/time/FakeClock";
import { PLAYER } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";
import { AllianceStore } from "../../src/engine/alliances";

/**
 * ORW-1178: a yes to a houseguest's invitation joins the alliance that houseguest REALLY belongs to (or founds one with them); no two alliances share a name.
 * Roles only (inviter, other, third).
 */
type S = {
  livingIds(): EntityId[];
  alliances: AllianceStore;
  rel: { edge(a: EntityId, b: EntityId): { trust: number; affinity: number } };
  joinAlliance(req: { allianceId?: string; inviter?: EntityId; name?: string }): { id: string; name: string; members: { id: string }[] } | null;
};
async function setup(seed = 21) {
  const reg = composeRuntime({ clock: new FakeClock(), seed }).registry;
  const user = `inviter-${seed}-${Math.random()}`;
  const mcp = reg.resolver()("player", user);
  await mcp.callTool("createCharacter", { playerName: "The Player", seed, archetype: "floater" });
  await mcp.callTool("noteMessage", { messageId: "first" });
  const s = reg.sandboxFor(user).session as unknown as S;
  const [inviter, other, third] = s.livingIds().filter((i) => i !== PLAYER) as [EntityId, EntityId, EntityId];
  s.alliances.load([]);
  const bond = (a: EntityId, b: EntityId, v: number) => { for (const [x, y] of [[a, b], [b, a]] as const) { s.rel.edge(x, y).trust = v; s.rel.edge(x, y).affinity = v; } };
  return { s, inviter, other, third, bond };
}

describe("a yes to an invitation commits the inviter's real alliance (ORW-1178)", () => {
  it("joins the alliance the inviter is in, though the player was never pitched it", async () => {
    const { s, inviter, other, third, bond } = await setup();
    s.alliances.add("Real One", inviter, [inviter, other], 1);
    s.alliances.add("Decoy", other, [other, third], 1); // the group the narrator named is not the inviter's
    bond(PLAYER, inviter, 0.8);
    const v = s.joinAlliance({ inviter });
    expect(v?.name).toBe("Real One");
    const real = s.alliances.all().find((a) => a.name === "Real One")!;
    expect(real.members).toEqual(expect.arrayContaining([PLAYER, inviter, other]));
    expect(s.alliances.all().find((a) => a.name === "Decoy")!.members).not.toContain(PLAYER);
  });

  it("founds a new alliance with the inviter when they are in none", async () => {
    const { s, inviter, bond } = await setup();
    bond(PLAYER, inviter, 0.8);
    const v = s.joinAlliance({ inviter });
    expect(v).not.toBeNull();
    const made = s.alliances.forMember(PLAYER);
    expect(made).toHaveLength(1);
    expect(made[0]!.members).toEqual(expect.arrayContaining([PLAYER, inviter]));
  });

  it("is idempotent and keeps the closeness gate", async () => {
    const { s, inviter, other, bond } = await setup();
    s.alliances.add("Real One", inviter, [inviter, other], 1);
    expect(s.joinAlliance({ inviter })).toBeNull(); // the player barely knows them: refused, nothing recorded
    expect(s.alliances.forMember(PLAYER)).toHaveLength(0);
    bond(PLAYER, inviter, 0.8);
    s.joinAlliance({ inviter });
    s.joinAlliance({ inviter });
    expect(s.alliances.forMember(PLAYER)).toHaveLength(1);
  });
});

describe("two alliances never share a name (ORW-1178)", () => {
  it("add and rename keep names unique, ignoring case, a leading The and punctuation", () => {
    const st = new AllianceStore();
    const a = st.add("The Pack", "npc:1" as EntityId, ["npc:1", "npc:2"] as EntityId[], 1);
    const b = st.add("pack", "npc:3" as EntityId, ["npc:3", "npc:4"] as EntityId[], 1);
    expect(b.name).not.toBe(a.name);
    const c = st.add("Other", "npc:5" as EntityId, ["npc:5", "npc:6"] as EntityId[], 1);
    st.rename(c.id, "The PACK!");
    const names = st.all().map((x) => x.name.toLowerCase().replace(/^the\s+/, "").replace(/[^a-z0-9]+/g, " ").trim());
    expect(new Set(names).size).toBe(names.length);
  });
});
