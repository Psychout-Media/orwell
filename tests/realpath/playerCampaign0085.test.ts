import { describe, it, expect } from "vitest";
import { PLAYER } from "../../src/domain/ids";
import { CAMPAIGN, type Campaign } from "../../src/engine/campaigns";
import { GameSessionRegistry } from "../../src/composition/registry";
import { playedGame } from "../support/playedGame";
import { firstSeedWhere } from "../support/firstSeedWhere";

/**
 * Feature 0085 phase 2 (the player's own campaign), REAL PATH. A season is played to its second week through the player's levers, then the player works the house
 * the way the front end records it: a few kind scenes with a houseguest they mean to recruit (so that houseguest's trust is earned, not set), then a pitch to them
 * that the target is the real threat (`recordInteraction` with an evict-shaped `aboutEdges` descriptor, over the MCP boundary). A pitch that lands creates the
 * player's own campaign against the target, known to the recruit; the recruit's vote now tilts toward the target, never past the NPC ceiling, and a houseguest
 * nobody pitched is unmoved. The house's own nightly campaign tick never advances it; only another pitch does. A protect-shaped pitch starts nothing. It survives
 * a save and load. With campaigns off the same pitch creates nothing. Seed 1 (the unit boundary test's seed). Roles only.
 */
type Priv = { campaigns: Campaign[]; campaignTiltFor(t: string, v: string): number };

type PitchOpts = { on?: boolean; direction?: "more-threatened" | "less-threatened" };
/** ORW-880: the first seed from 1 whose season reaches week 2 with three houseguests to pitch to, about and past (each in the sandbox `<prefix>-<seed>`). */
async function pitched(prefix: string, opts: PitchOpts = {}) {
  return (await firstSeedWhere((seed, sandbox) => pitchedAt(seed, sandbox, opts), { from: 1, to: 12, hint: 1, sandbox: (s) => `${prefix}-${s}`, what: "week 2 with three houseguests" })).at;
}
async function pitchedAt(seed: number, user: string, opts: PitchOpts) {
  const g = playedGame({ seed, user: user, before: (s) => s.setCampaignsEnabled(opts.on ?? true) });
  g.playUntil(() => (g.s.getGameState() as { week?: number }).week! >= 2 && !g.s.getGameState().pending, 5000, "week 2");
  const npcs = g.s.livingIds().filter((id) => id !== PLAYER);
  if (npcs.length < 3) return undefined;
  const [recruit, target, bystander] = npcs as [string, string, string];
  for (let i = 0; i < 4; i++) await g.sb.mcp.player.callTool("recordInteraction", { initiator: PLAYER, witnessSet: [PLAYER, recruit], content: "the player keeps them company and has their back", kind: "bonding" });
  const res = await g.sb.mcp.player.callTool("recordInteraction", {
    initiator: PLAYER, witnessSet: [PLAYER, recruit], content: "the player pulls them aside and makes the case that the other one is the real threat",
    consequence: { aboutEdges: [{ holder: recruit, about: target, direction: opts.direction ?? "more-threatened", emphasis: "strong" }] },
  });
  return { g, recruit, target, bystander, res, p: g.s as unknown as Priv };
}
const mine = (p: Priv): Campaign[] => p.campaigns.filter((c) => c.owners[0] === PLAYER);

describe("0085 REAL PATH: the player's own campaign, from their own pitch", () => {
  it("a landed evict-shaped pitch starts the player's campaign, known to the recruit; their vote tilts toward the target within the NPC ceiling; a bystander is unmoved", async () => {
    const { g, recruit, target, bystander, res, p } = await pitched("camp-on");
    expect((res as { eventId?: string }).eventId).toBeTruthy();
    const c = mine(p).find((x) => x.target === target);
    expect(c, "the player's campaign against the target exists").toBeDefined();
    expect(c).toMatchObject({ goal: "evict", status: "active" });
    expect(c!.knownTo).toContain(recruit);
    expect(c!.progress).toBeGreaterThan(0);
    const tilt = p.campaignTiltFor(target, recruit);
    expect(tilt).toBeGreaterThan(0);
    expect(tilt).toBeLessThanOrEqual(CAMPAIGN.base);
    expect(p.campaignTiltFor(target, bystander), "a houseguest nobody pitched is unmoved").toBe(0);
    // the house lives on: its own campaign tick never advances the player's campaign
    const before = JSON.stringify(mine(p));
    (g.s as unknown as { campaignTick(): void }).campaignTick();
    expect(JSON.stringify(mine(p))).toBe(before);
    // a save and load keeps it
    const loaded = new GameSessionRegistry().sandboxFor("camp-load").session;
    loaded.restore(JSON.parse(JSON.stringify(g.s.snapshot())));
    expect(mine(loaded as unknown as Priv)).toEqual(mine(p));
  }, 300_000);

  it("a protect-shaped pitch starts nothing; with campaigns off the same evict pitch starts nothing", async () => {
    const protect = await pitched("camp-protect", { direction: "less-threatened" });
    expect(mine(protect.p)).toHaveLength(0);
    const off = await pitched("camp-off", { on: false });
    expect(mine(off.p)).toHaveLength(0);
    expect(off.p.campaignTiltFor(off.target, off.recruit)).toBe(0);
  }, 300_000);
});
