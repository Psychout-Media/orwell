import { describe, it, expect } from "vitest";
import { liveFinale, driveFinaleSeam, JURY9 } from "../../features/support/liveFinale";
import { PLAYER, npc } from "../../src/domain/ids";
import type { SessionSnapshot } from "../../src/engine/sessionSnapshot";

/**
 * ORW-112 (PO ruling, Ryne 2026-11-05): the jury respects a Final-HOH part win on a finalist's resume. finalHohResumeCredit.test.ts pins that each part win credits `live.resume`; THIS proves the
 * vote-time half through a real live Final 2 (nine jurors, perfectly even relationships): the finalist whose resume is 3 vs 0 (the credit a Final HOH part win adds) draws MORE juror votes than at an
 * even resume, and the mirror draws fewer. Mutant: zero JURY_WEIGHTS.gameRespect (jury.ts) -> the three arms collapse and this goes red. Roles only.
 */
const RIVAL = npc(10);
const EVEN = { trust: 0.5, affinity: 0.5, threat: 0.3 };
type Arm = "even" | "playerLeads" | "rivalLeads";

async function playerVotes(seed: number, arm: Arm): Promise<{ playerVotes: number; total: number }> {
  const user = `fh-vote-${seed}-${arm}`;
  const { reg } = await liveFinale(user, seed, { finalists: [PLAYER, RIVAL], jury: JURY9, edgeTo: () => EVEN });
  const snap = reg.snapshot(user) as SessionSnapshot;
  const live = snap.live as unknown as { resume?: Record<string, number> };
  live.resume = arm === "even" ? { [PLAYER]: 0, [RIVAL]: 0 } : arm === "playerLeads" ? { [PLAYER]: 3, [RIVAL]: 0 } : { [PLAYER]: 0, [RIVAL]: 3 };
  reg.restore(user, snap);
  const player = reg.resolver()("player", user) as Parameters<typeof driveFinaleSeam>[0];
  const views = await driveFinaleSeam(player);
  const reveals = views.filter((v) => v.event?.beat === "finale-reveal").map((v) => v.event!.content);
  return { playerVotes: reveals.filter((c) => c.endsWith("votes for Player")).length, total: reveals.length };
}

describe("a Final-HOH part win on the resume moves the live Final-2 vote (equal relationships)", () => {
  const seeds = [1, 2, 3, 4, 5, 6, 7, 8];
  it("positive control: all nine jurors reveal and the even-resume jury is mixed (room for the resume to move it)", async () => {
    let p = 0, t = 0;
    for (const seed of seeds) { const r = await playerVotes(seed, "even"); p += r.playerVotes; t += r.total; }
    expect(t).toBe(9 * seeds.length);
    expect(p / t).toBeGreaterThan(0.15);
    expect(p / t).toBeLessThan(0.85);
  }, 120000);

  it("resume 3 vs 0 draws more votes than even; the mirror draws fewer", async () => {
    let even = 0, lead = 0, trail = 0;
    for (const seed of seeds) {
      even += (await playerVotes(seed, "even")).playerVotes;
      lead += (await playerVotes(seed, "playerLeads")).playerVotes;
      trail += (await playerVotes(seed, "rivalLeads")).playerVotes;
    }
    expect(lead, `lead ${lead} > even ${even}`).toBeGreaterThan(even);
    expect(trail, `trail ${trail} < even ${even}`).toBeLessThan(even);
  }, 180000);
});
