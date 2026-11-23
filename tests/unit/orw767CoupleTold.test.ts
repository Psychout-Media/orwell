import { describe, it, expect } from "vitest";
import { playMixGame } from "../support/houseMixDriver";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import { coupleFactId } from "../../src/engine/coupleTold";
import { sessionCoreSupersetViolation } from "../../src/engine/sessionSnapshot";

/**
 * ORW-767 (0207): a showmance reaches the player by being TOLD. Everything here is played through the real runtime (the house-mix driver: player messages, advanceGame, the house-life ticks; the player's own
 * social acts go through the real `recordInteraction` tool so houseguests come to trust them); nothing sets a belief, a stage, a trust or a told fact by hand. Roles only. Read-only peeks at the live
 * sandbox are test-only (as in the other played-season tests).
 */
type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any

interface Told { pair: string; pathway: string; confidence?: number; content: string }
interface Run {
  seed: number; coupleBeliefs: Any[]; scenes: Any[]; told: Told[]; narratorLines: string[]; sess?: Any; real: Set<string>;
}
const pairOf = (ids: readonly string[]): string => [...ids].filter((x) => x !== PLAYER).sort().join("|");

async function play(seed: number, o: { flagOn: boolean; messages: number; stopOnTold: boolean }): Promise<Run> {
  const run: Run = { seed, coupleBeliefs: [], scenes: [], told: [], narratorLines: [], real: new Set() };
  const prev = process.env.ORWELL_COUPLE_TOLD;
  if (!o.flagOn) process.env.ORWELL_COUPLE_TOLD = "0";
  let sess: Any;
  try {
    await playMixGame(seed, o.messages, {
      advanceEvery: 6,
      onMessage: async (call, i) => {
        // the player's own social play: a warm scene with whoever is in the room, every so often (the real tool path; this is what makes a houseguest trust them enough to confide)
        if (i % 12 === 5) {
          const wa = (await call("whereabouts", {}).catch(() => null)) as { present?: Array<{ id: string }> } | null;
          const npc = (wa?.present ?? []).map((x) => x.id).find((id) => id !== PLAYER);
          if (npc) await call("recordInteraction", { initiator: PLAYER, witnessSet: [PLAYER, npc], content: "a long easy talk, warm and open", kind: "bonding" }).catch(() => null);
        }
        if (i % 3 === 0) {
          const mp = JSON.stringify(await call("getMomentPrompt", {}).catch(() => ""));
          for (const m of mp.matchAll(/tellsYou \(their own words to the player, certainty [a-z ]+\): ([^\\"]*? is seeing [^\\"]*)/g)) run.narratorLines.push(m[1]!);
        }
      },
      onStep: (s: Any) => { sess = s; },
      stopWhen: (s: Any) => o.stopOnTold && (s.playerKnowledgeReader?.() ?? []).some((f: Any) => typeof f.factId === "string" && f.factId.startsWith("couple:")),
      inspect: (s: Any) => { sess = s; },
    });
  } finally {
    if (prev === undefined) delete process.env.ORWELL_COUPLE_TOLD; else process.env.ORWELL_COUPLE_TOLD = prev;
  }
  const s = sess;
  const events = (s.record?.events?.() ?? []) as Any[];
  run.scenes = events.filter((e) => e.type === "showmance" && e.witnessSet.filter((x: string) => x !== PLAYER).length === 2);
  run.real = new Set(run.scenes.map((e) => pairOf(e.witnessSet)));
  run.coupleBeliefs = (Object.values(s.live?.beliefs ?? {}).flat() as Any[]).filter((b) => b.kind === "couple");
  run.told = ((s.playerKnowledgeReader?.() ?? []) as Any[]).filter((f) => typeof f.factId === "string" && f.factId.startsWith("couple:")).map((f) => ({ pair: f.factId.slice(7), pathway: f.pathway, confidence: f.confidence, content: f.content }));
  run.sess = s;
  return run;
}

describe("ORW-767: a couple is told, through a played game", () => {
  it("houseguests who saw a romance scene hold the pair, and a pair is told to the player as a belief with a source", async () => {
    let found: Run | undefined;
    const tried: string[] = [];
    for (const seed of [2, 3, 4, 5, 6, 7]) {
      const r = await play(seed, { flagOn: true, messages: 900, stopOnTold: true });
      tried.push(`${seed}:${r.coupleBeliefs.length}c/${r.told.length}t`);
      console.log("ORW767 seed", seed, r.coupleBeliefs.length, "couple beliefs;", r.told.length, "told to the player;", r.narratorLines.length, "narrator lines");
      if (r.told.length > 0) { found = r; break; }
    }
    expect(found, `no seed told the player a couple (${tried.join(" ")})`).toBeDefined();
    const r = found!;
    const s = r.sess;

    // the houseguests who saw a scene hold the pair first-hand: each witnessed belief names a REAL scene's pair and a holder who was in the room for it
    const witnessed = r.coupleBeliefs.filter((b) => b.origin === "witnessed");
    expect(witnessed.length).toBeGreaterThan(0);
    for (const b of witnessed) {
      expect(r.real.has([b.subject, b.object].sort().join("|"))).toBe(true);
      expect(r.scenes.some((e) => pairOf(e.witnessSet) === [b.subject, b.object].sort().join("|") && (e.houseLife?.seenBy ?? []).includes(b.holder))).toBe(true);
      expect(b.confidence).toBeLessThan(1);
    }

    // the player holds the told pair as a KNOWLEDGE fact told by a houseguest, with a confidence below certainty, and the teller held it as their own belief
    const t = r.told[0]!;
    expect(t.pathway).toMatch(/^told-by:npc:/);
    expect(t.confidence ?? 1).toBeLessThan(1);
    const teller = t.pathway.slice("told-by:".length);
    expect(r.coupleBeliefs.some((b) => b.holder === teller && [b.subject, b.object].sort().join("|") === t.pair)).toBe(true);
    expect(t.pair.split("|").every((id) => id !== PLAYER && id !== teller)).toBe(true);

    // the narrator was handed it as the teller's own words (a certainty band), and the player has now "seen or been told" the pair
    expect(r.narratorLines.length).toBeGreaterThan(0);
    const [a, b] = t.pair.split("|") as [string, string];
    expect(s.romanceSeenBy(PLAYER, a, b)).toBe(true);
    expect(s.romanceSeenBy(PLAYER, b, a)).toBe(true);

    // a belief is never upgraded to the truth: a pair that was only told (never a real scene) is never in the narrator's showmance list
    const listed = (s.visibleShowmances() as Array<{ a: string; b: string }>).map((x) => [x.a, x.b].sort().join("|"));
    const nameOf = (id: string): string => s.house.npcs.find((n: Any) => n.id === id)?.name ?? id;
    if (!r.real.has(t.pair)) expect(listed).not.toContain([nameOf(a), nameOf(b)].sort().join("|"));

    // Vault-free: the engine's belief ids, kinds and lineage never reach the player-facing reads
    const surfaces = JSON.stringify([s.getGameState(), s.whereabouts(), s.getMomentPrompt({})]);
    for (const needle of ["|couple|", "\"kind\":\"couple\"", "coupleBeliefs"]) expect(surfaces).not.toContain(needle);
    expect(t.content).toMatch(/ and .* are seeing each other$/);

    // persistence: the belief store round-trips through a save
    const snap = JSON.parse(JSON.stringify(s.snapshot()));
    const sb2 = new GameSessionRegistry().sandboxFor("orw767-restore");
    sb2.session.restore(JSON.parse(JSON.stringify(snap)) as never);
    const kept = (Object.values((sb2.session as Any).live?.beliefs ?? {}).flat() as Any[]).filter((x) => x.kind === "couple").length;
    expect(kept).toBe(r.coupleBeliefs.length);
    expect(sessionCoreSupersetViolation(snap as never, snap as never)).toBeNull();
    expect(coupleFactId(a, b)).toBe(`couple:${t.pair}`);
  }, 1_800_000);

  it("flag off: nothing is written and nothing is told (the control)", async () => {
    const r = await play(2, { flagOn: false, messages: 400, stopOnTold: false });
    expect(r.coupleBeliefs).toEqual([]);
    expect(r.told).toEqual([]);
    expect(r.narratorLines).toEqual([]);
    expect(r.scenes.length).toBeGreaterThan(0); // positive control: the same played game does hold romance scenes
  }, 900_000);
});
