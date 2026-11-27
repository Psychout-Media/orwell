import { describe, it, expect } from "vitest";
import { PLAYER_TOOLS, PLAYER_AGENT_LEVERS } from "../../src/surfaces/tools/registry";
import { PLAYER } from "../../src/domain/ids";
import type { ExposeResult, TradeResult } from "../../src/ports/GameSession";
import { playUntil, learned, wfScan, type Stop } from "./playedSeason";
import { firstSeedWhere } from "../support/firstSeedWhere";

/**
 * Features 0093 + 0099 - the BOUNDARY test (the four-place wiring gate). The static gates MISS a missing McpServer dispatch (#4): a lever wired in the port + adapter + registry but
 * NOT dispatched typechecks, passes test:arch + the manifest drift test, and is DEAD at runtime. This dispatches `exposeSecret`, `tradeSecret` and a `makeDeal` with leverage
 * THROUGH the player's MCP channel on the production runtime, on a secret the player LEARNED in a played season (ORW-810: before, the secret was planted by hand).
 * The stop: the first moment the player holds a fact about a living houseguest that reached them through a houseguest (a told / overheard pathway). Roles only.
 */

/** The first moment the player holds a learned fact about a living houseguest; returns the player-channel fact id (the id the front end reads off the player's view). */
async function secretLearned(seed: number): Promise<{ at: Stop; subject: string; factId: string }> {
  const about = (s: Stop) => learned(s).find((f) => f.subject !== undefined && f.subject !== PLAYER && s.sess.livingIds().includes(f.subject));
  const at = await playUntil(seed, (s) => about(s) !== undefined, { user: `wf-${seed}` });
  const fact = about(at)!;
  const view = await at.call("getVisibleStateFor", { entity: "player" });
  const seen = (view.knowledge as Array<{ id: string }>).find((k) => k.id === fact.id);
  expect(seen, "the learned fact is on the player's own view").toBeDefined();
  return { at, subject: fact.subject!, factId: seen!.id };
}

describe("0093/0099 - exposeSecret + tradeSecret are on the player channel + in the lever manifest", () => {
  it("both are advertised player tools (the boundary bug: missing from PLAYER_TOOLS)", () => {
    const names = PLAYER_TOOLS.map((t) => t.name);
    expect(names).toContain("exposeSecret");
    expect(names).toContain("tradeSecret");
  });

  it("both are MODEL levers (in the agent lever manifest, not FE-only infra)", () => {
    expect(PLAYER_AGENT_LEVERS).toContain("exposeSecret");
    expect(PLAYER_AGENT_LEVERS).toContain("tradeSecret");
  });
});

describe("0093/0099 - the levers DISPATCH through the player channel on a secret learned in a played season (the missing-#4 gate)", () => {
  it("exposeSecret on a learned secret is resolved by the engine (exposed), not rejected as unavailable or dead", async () => {
    const { at, factId } = await secretLearned(3);
    const res = (await at.call("exposeSecret", { factId })) as ExposeResult;
    expect(res).toBeTruthy();
    expect(res.exposed).toBe(true); // the engine actually resolved it - not a silent no-op (#4 wired)
  }, 120_000);

  it("tradeSecret of a learned secret to another houseguest is resolved (accepted or declined)", async () => {
    const { at, subject, factId } = await secretLearned(3);
    const recipient = at.sess.livingIds().find((id: string) => id !== PLAYER && id !== subject)!;
    const res = (await at.call("tradeSecret", { factId, toNpcId: recipient, askKind: "vote" })) as TradeResult;
    expect(res).toBeTruthy();
    expect(typeof res.accepted).toBe("boolean"); // the engine resolved it (accepted or declined) - dispatched
  }, 120_000);

  it("makeDeal dispatches WITH a leverage descriptor on the learned secret (the optional secret rides the existing tool)", async () => {
    // ORW-892: whether the partner agrees to the deal is their own read of the player, so the scan picks a season where the deal forms; the claim is that the leverage descriptor rides the tool and the deal still forms
    const f = await firstSeedWhere(async (seed) => {
      const { at, subject, factId } = await secretLearned(seed);
      // Leverage is about the deal PARTNER (the subject of the held secret).
      const res = (await at.call("makeDeal", { with: subject, kind: "safety", terms: "keep me safe", leverage: { factId } })) as { id?: string } | null;
      return res && res.id ? res : undefined;
    }, wfScan([5, 4, 3], "a played season where the learned secret's subject agrees to a safety deal"));
    expect(f.at.id).toBeTruthy(); // the deal still forms (additive); leverage colored it
  }, 600_000);

  it("the arg-guard refuses a malformed call with a 400-shaped field error, never a 500", async () => {
    const { at } = await secretLearned(3);
    // No factId and no bluff => the requireShape guard refuses (a deliberate field error, not a blind cast).
    await expect(at.call("exposeSecret", {})).rejects.toThrow(/factId/);
    await expect(at.call("tradeSecret", { toNpcId: at.sess.livingIds().find((id: string) => id !== PLAYER) })).rejects.toThrow(/factId/);
  }, 120_000);
});
