import { describe, it, expect } from "vitest";
import { liveFinale, driveFinaleSeam, JURY9 } from "../../features/support/liveFinale";
import { PLAYER, npc } from "../../src/domain/ids";
import type { SessionSnapshot } from "../../src/engine/sessionSnapshot";
import type { MemoryEntry } from "../../src/engine/npcMemory";
import type { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";

/**
 * Watch list item 7 (ORW-106): JURY MEMORY decides votes in a real finale. Two real Final-2 games (player vs one NPC, nine jurors) are played through the live seam with
 * IDENTICAL, perfectly even jury relationships; the only difference is what the jurors REMEMBER about the player. Over several seeds, jurors who remember being wronged by the
 * player cast fewer votes for the player than the control, and jurors who remember a kept deal cast more. The memory term is set ON explicitly (the flag under test).
 * Fails if the juror vote stops reading the memory ledger (zero the term). Roles only.
 */
const RIVAL = npc(10);
const EVEN = { trust: 0.5, affinity: 0.5, threat: 0.3 };

async function playerVotes(seed: number, memory: "none" | "grudge" | "favor"): Promise<{ playerVotes: number; total: number }> {
  const user = `jury-mem-live-${seed}-${memory}`;
  const { reg } = await liveFinale(user, seed, { finalists: [PLAYER, RIVAL], jury: JURY9, edgeTo: () => EVEN });
  if (memory !== "none") {
    const snap = reg.snapshot(user) as SessionSnapshot;
    const live = snap.live as unknown as { week: number; npcMemory?: Record<string, Record<string, MemoryEntry[]>> };
    const kind = memory === "grudge" ? "deal-broken" : "deal-kept";
    live.npcMemory = Object.fromEntries(JURY9.map((j) => [j, { [PLAYER]: [{ kind, week: live.week, severity: 1 }] }]));
    reg.restore(user, snap);
  }
  (reg.sandboxFor(user).session as GameSessionAdapter).setJuryMemoryEnabled(true);
  const player = reg.resolver()("player", user) as Parameters<typeof driveFinaleSeam>[0];
  const views = await driveFinaleSeam(player);
  const last = views[views.length - 1]!;
  expect(last.finished && last.winner, "the live jury crowned a winner").toBeTruthy();
  const reveals = views.filter((v) => v.event?.beat === "finale-reveal").map((v) => v.event!.content);
  return { playerVotes: reveals.filter((c) => c.endsWith("votes for Player")).length, total: reveals.length };
}

describe("jury memory moves real finale votes (identical relationships, different memory)", () => {
  const seeds = [1, 2, 3, 4, 5, 6, 7, 8];

  it("every juror reveals a vote (positive control) and the control game is not already lopsided", async () => {
    let p = 0, t = 0;
    for (const seed of seeds) { const r = await playerVotes(seed, "none"); p += r.playerVotes; t += r.total; }
    expect(t, "all nine jurors reveal in every game").toBe(9 * seeds.length);
    expect(p / t, "even relationships give a mixed jury, so memory has room to move it").toBeGreaterThan(0.15);
    expect(p / t).toBeLessThan(0.85);
  });

  it("jurors who remember being wronged vote for the player less; jurors who remember a kept deal vote for the player more", async () => {
    let none = 0, grudge = 0, favor = 0;
    for (const seed of seeds) {
      none += (await playerVotes(seed, "none")).playerVotes;
      grudge += (await playerVotes(seed, "grudge")).playerVotes;
      favor += (await playerVotes(seed, "favor")).playerVotes;
    }
    expect(grudge, `grudge ${grudge} < control ${none}`).toBeLessThan(none);
    expect(favor, `favor ${favor} > control ${none}`).toBeGreaterThan(none);
  }, 120000);
});
