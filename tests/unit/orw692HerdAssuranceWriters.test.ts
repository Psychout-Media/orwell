import { describe, it, expect } from "vitest";
import { playMixGame } from "../support/houseMixDriver";
import { herdVoices } from "../../src/engine/houseNorms";

/**
 * ORW-692 (Fable bug scan B1-8 herd, B1-10 assurance shield). Both small vote terms were "built on" but had no writer a played game could reach: the tests wrote the
 * triggering state directly. These play real seeded games (the house-mix driver: chat-paced messages, the real house-life tick, the real nominations) and read what the
 * REAL writers left. No state is injected. Flag off (`ORWELL_HERD_VOICES=0` / `ORWELL_NPC_ASSURANCES=0`) is the old read.
 */
type Live = { week: number; hoh?: string; nominees?: string[]; finalNominees?: string[]; beliefs?: Record<string, Array<{ kind: string; nature?: string; subject: string; object?: string; value: boolean; refuted?: boolean; week: number }>>;
  assurances?: { items: Array<{ from: string; to: string; kind: string; status: string; source: string; week: number }> } };
interface Seen { maxVoices: number; voiced: number; npcVoteAssurances: number; shielded: number }

async function play(seed: number, env: Record<string, string | undefined>): Promise<Seen> {
  const was: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) { was[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  const seen: Seen = { maxVoices: 0, voiced: 0, npcVoteAssurances: 0, shielded: 0 };
  try {
    await playMixGame(seed, 2500, { advanceEvery: 6, stopAtWeek: 4, onStep: (sess) => {
      const s = sess as { live?: Live; assuranceVoteFor?: (n: string, v: string) => number };
      const live = s.live; if (!live?.beliefs) return;
      const block = live.finalNominees ?? live.nominees;
      if (!block || block.length !== 2) return;
      for (const [holder, claims] of Object.entries(live.beliefs)) {
        const v = herdVoices(claims as never, holder, block as never, live.week);
        seen.maxVoices = Math.max(seen.maxVoices, v[0], v[1]);
        seen.voiced += claims.filter((b) => b.kind === "heard-rumor" && b.nature === "going-after" && b.week === live.week && b.object !== undefined && block.includes(b.object)).length;
        for (const n of block) if (holder !== live.hoh && !block.includes(holder) && holder !== "player" && s.assuranceVoteFor?.(n, holder)) seen.shielded++;
      }
      seen.npcVoteAssurances = Math.max(seen.npcVoteAssurances, (live.assurances?.items ?? []).filter((a) => a.source === "npc" && a.kind === "vote" && a.from !== "player" && a.to !== "player").length);
    } });
  } finally { for (const [k, v] of Object.entries(was)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
  return seen;
}

describe("ORW-692: the herd and the assurance shield have working writers in a played game", () => {
  const SEEDS = [1, 2, 3];
  it("ON: real play produces herd voices at a nominee and NPC-to-NPC vote assurances that shield", async () => {
    const all = [];
    for (const seed of SEEDS) all.push(await play(seed, {}));
    expect(all.some((x) => x.voiced > 0)).toBe(true);
    expect(Math.max(...all.map((x) => x.maxVoices))).toBeGreaterThanOrEqual(2); // enough voices that the herd pulls at all (HERD.minVoices)
    expect(all.some((x) => x.npcVoteAssurances > 0)).toBe(true);
    expect(all.some((x) => x.shielded > 0)).toBe(true);
  }, 1_800_000);
  it("OFF: the flags restore the old read (no voices, no NPC-to-NPC assurance)", async () => {
    const off = await play(SEEDS[0]!, { ORWELL_HERD_VOICES: "0", ORWELL_NPC_ASSURANCES: "0" });
    expect(off.npcVoteAssurances).toBe(0);
    expect(off.maxVoices).toBeLessThan(2);
  }, 1_800_000);
});
