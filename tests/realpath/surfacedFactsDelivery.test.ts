import { describe, it, expect } from "vitest";
import { PLAYER } from "../../src/domain/ids";
import { provenanceWord } from "../../src/domain/humanize";
import type { KnowledgeFact } from "../../src/domain/knowledge";
import { learned, type Stop, firstStop, wfScan } from "./playedSeason";

/**
 * SOC-1/4 - surfaced-fact DELIVERY to the per-turn narrator, and #1789 - the telephone-game provenance word, in a PLAYED season (ORW-810: before, every fact was planted by hand).
 *
 * The engine anchors facts that reach the player through a real in-game pathway (a houseguest telling them, a rumor that diffused all the way to them, an overheard fragment)
 * into the player's knowledge. The "WHAT YOU'VE LEARNED" block of an ordinary turn's moment prompt hands the narrator the freshest few of them (5), while what reached the
 * player through no pathway (a houseguest's own belief, a hidden scene, the Vault, the player's own Diary Room) never rides there. Each test stops the season at the first moment
 * the state it needs exists in play (seed 3, the scripted talking player), then reads the prompt; the drift tests switch only the flag. Roles only.
 */
const HINT = 3; // ORW-880: the seed tried first; each test scans from here (wfScan)
const WINDOW = 5; // GameSessionAdapter.SURFACED_FACTS_WINDOW
const HEADER = "WHAT YOU'VE LEARNED";
const GUIDANCE = "multiple mouths";

/** The player's own surfaced-facts section of the composed prompt (not a present houseguest's own knowledge block, ADR 0019 Layer 2). */
const playerBlock = (systemPrompt: string): string => systemPrompt.split("\n\n").find((s) => s.startsWith(HEADER)) ?? "";
const prompt = (s: Stop): string => s.sess.getMomentPrompt({ moment: "social" }).systemPrompt as string;
/** The text the narrator is handed for a fact (the engine's own humanizer: ids become names). */
const text = (s: Stop, f: KnowledgeFact): string => s.sess.humanize(f.content) as string;
/** The facts the block should carry: the player's newest learned facts, oldest first. */
const windowOf = (s: Stop): KnowledgeFact[] => learned(s).slice(-WINDOW);

describe("SOC-1/4 - the player's pathway-surfaced facts reach the per-turn narrator prompt (played season)", () => {
  it("a fact a houseguest told the player reaches the ordinary (non-lifecycle) moment prompt, with every fact of the window", async () => {
    const at = await firstStop((s) => windowOf(s).some((f) => f.pathway.startsWith("told-by:")), wfScan(HINT));
    const told = windowOf(at).find((f) => f.pathway.startsWith("told-by:"))!;
    const p = prompt(at);
    expect(p).toContain(HEADER);
    expect(playerBlock(p)).toContain(text(at, told));
    for (const f of windowOf(at)) expect(playerBlock(p)).toContain(text(at, f));
  }, 120_000);

  it("before anything has reached the player the block is absent (the prompt stays tight); the first learned fact brings it", async () => {
    let before: { prompt: string; known: number } | undefined;
    const at = await firstStop((s) => learned(s).length > 0, wfScan(HINT), {
      // right after createCharacter, before the first message: the player has been told nothing yet
      setup: (sess) => { before = { prompt: sess.getMomentPrompt({ moment: "social" }).systemPrompt, known: (sess.playerKnowledgeReader?.() ?? []).length }; },
    });
    expect(before!.known).toBe(0);
    expect(before!.prompt).not.toContain(HEADER);
    expect(prompt(at)).toContain(HEADER);
  }, 120_000);

  it("a belief a houseguest holds with NO pathway to the player never enters the player's block, and hidden scenes and Vault content never reach the prompt", async () => {
    const npcOnly = (s: Stop): string[] => {
      const mine = new Set(s.engine.knowledge.knownTo(PLAYER).map((f) => text(s, f)));
      return s.sess.livingIds().filter((id: string) => id !== PLAYER)
        .flatMap((id: string) => s.engine.knowledge.knownTo(id).map((f) => text(s, f)))
        .filter((c: string) => !mine.has(c));
    };
    const hidden = (s: Stop): string[] => [
      ...s.engine.events.queryAll().filter((e) => e.hidden && !e.witnessSet.includes(PLAYER)).map((e) => String(e.content)),
      ...s.engine.vault.readHidden().map((r) => r.content),
    ].filter((c) => c.trim().length > 0);
    const at = await firstStop((s) => learned(s).length > 0 && npcOnly(s).length > 0 && hidden(s).length > 0, wfScan(HINT));
    const p = prompt(at);
    const block = playerBlock(p);
    expect(block).toContain(HEADER); // non-vacuous: the block is there, it just does not carry them
    for (const c of npcOnly(at)) expect(block, "a houseguest's own belief framed as the player's knowledge").not.toContain(c);
    for (const c of hidden(at)) expect(p, "hidden or Vault content in the prompt").not.toContain(c);
  }, 120_000);

  it("the player's Diary-Room entry (no NPC pathway) is NOT rendered as 'the house told you'", async () => {
    const at = await firstStop((s) => learned(s).length > 0, wfScan(HINT));
    const DR = "a private diary room note about who I want out next";
    await at.call("diaryRoom", { entry: DR });
    expect(at.engine.knowledge.knownTo(PLAYER).some((f) => f.pathway === "diary-room" && f.content.includes(DR)), "the entry is the player's own knowledge").toBe(true);
    const p = prompt(at);
    expect(p).toContain(HEADER);
    expect(p.slice(p.indexOf(HEADER))).not.toContain(DR);
  }, 120_000);

  it("only the most recent few facts ride along: the block stays bounded", async () => {
    const outside = (s: Stop): KnowledgeFact | undefined => {
      const all = learned(s);
      if (all.length <= WINDOW) return undefined;
      const inWin = new Set(windowOf(s).map((f) => text(s, f)));
      return all.slice(0, -WINDOW).reverse().find((f) => !inWin.has(text(s, f)));
    };
    const at = await firstStop((s) => outside(s) !== undefined, wfScan(HINT));
    const block = playerBlock(prompt(at));
    for (const f of windowOf(at)) expect(block).toContain(text(at, f));
    expect(block, "an older fact dropped out of the window").not.toContain(text(at, outside(at)!));
  }, 120_000);
});

describe("#1789 - telephone-game provenance word on surfaced gossip (hops>=2), played season", () => {
  const hops2 = (s: Stop) => windowOf(s).find((f) => (f.hops ?? 0) >= 2);
  // ORW-1043: the drift ON and drift OFF tests read the SAME stopped season (same seed, same scan, same stop), so it is played once. Each sets the flag it reads,
  // and building the prompt writes nothing to the game.
  let hops2At: Promise<Stop> | undefined;
  const hops2Stop = (): Promise<Stop> => (hops2At ??= firstStop((s) => hops2(s) !== undefined, wfScan(HINT)));

  it("drift ON - the provenance word rides a hops>=2 fact, with the guidance line, and no raw hop count leaks", async () => {
    const at = await hops2Stop();
    at.sess.setGossipDriftEnabled(true);
    const f = hops2(at)!;
    const block = playerBlock(prompt(at));
    expect(block).toContain(`(${provenanceWord(f.hops!)}) ${text(at, f)}`);
    expect(block).not.toMatch(/\bhops[=:]?\s*\d/);
    expect(block).not.toMatch(/\(\s*\d\)/);
    expect(block).toContain(GUIDANCE);
  }, 120_000);

  it("drift OFF - no provenance word, no guidance line: the fact renders plain", async () => {
    const at = await hops2Stop();
    at.sess.setGossipDriftEnabled(false); // not as shipped: the drift-OFF render is the spec under test (#1789)
    const f = hops2(at)!;
    const block = playerBlock(prompt(at));
    expect(block).not.toContain("(third-hand)");
    expect(block).not.toContain("(second-hand)");
    expect(block).not.toContain("(everyone's saying)");
    expect(block).not.toContain(GUIDANCE);
    expect(block).toContain(`  - ${text(at, f)}`);
  }, 120_000);

  it("hops=1 with drift ON - no provenance word (below the threshold)", async () => {
    const hop1 = (s: Stop) => windowOf(s).find((f) => f.hops === 1);
    const at = await firstStop((s) => hop1(s) !== undefined, wfScan(HINT));
    at.sess.setGossipDriftEnabled(true);
    const block = playerBlock(prompt(at));
    expect(block).toContain(`  - ${text(at, hop1(at)!)}`);
  }, 120_000);

  it("the guidance line only appears when at least one fact in the window has hops>=2", async () => {
    const at = await firstStop((s) => windowOf(s).length > 0 && hops2(s) === undefined, wfScan(HINT));
    at.sess.setGossipDriftEnabled(true);
    const block = playerBlock(prompt(at));
    expect(block).toContain(HEADER);
    expect(block).not.toContain(GUIDANCE);
    expect(block).not.toContain("passed through");
  }, 120_000);
});
