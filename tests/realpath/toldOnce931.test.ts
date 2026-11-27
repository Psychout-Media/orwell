import { describe, it, expect } from "vitest";
import { playedGame } from "../support/playedGame";
import { firstSeedWhereSync } from "../support/firstSeedWhere";

/**
 * ORW-931 (Fable W2-7), REAL PATH: a season is played through the player's levers only, and each turn the narrator's own view is read (`presentKnowledgeForPrompt`, what the turn's context
 * hands the narrator). Before the fix a claim the player had already been told came back as new: from the same houseguest, or from another one, never marked.
 * Now the same speaker never re-tells the player the same thing, and another houseguest saying it reaches the narrator marked `alreadyHeard` (voiced as confirming, never as news).
 * Tellings are read from the claims record (each once, by its id); the narrator's line for a telling is the speaker's `tellsYou` in a view built that turn (every build is captured).
 * The precondition (a claim the player already heard comes back at all) is reached by a seed scan in a fixed order (ORW-880); the sandbox name is part of the game's identity. Roles only.
 * BOUNDED (Coordinator, 2026-11-26): at most five seasons of 900 turns (the hints 27, 12, 7, 4, then 1; 27 since ORW-779 moved the played seasons, 12 since ORW-972 did) and a 7-minute cap, so a change that moves played seasons fails fast and names the
 * seeds it tried, never runs a shard into its time limit. A PR that moves every listed season past the precondition re-hints this to a seed that reaches it.
 */
type Claim = { id: string; speaker: string; listener: string; kind: string; subject: string; object?: string; label?: string };
type Tell = { kind: string; subject: string; object?: string; label?: string; alreadyHeard?: true };
type Peek = { nameOf(id: string): string; live?: { claims?: { items: Claim[] } }; presentKnowledgeForPrompt(): Array<{ id: string; tellsYou?: Tell }> };
const keyOf = (c: { kind: string; subject: string; object?: string; label?: string }): string => `${c.kind}|${c.subject}|${c.object ?? ""}|${c.label ?? ""}`;

describe("ORW-931 REAL PATH: what the player was already told never comes back as news", () => {
  it("a claim the player already heard comes back only from another houseguest, and the narrator is told it is not news", () => {
    const { at } = firstSeedWhereSync((seed, sandbox) => {
      const g = playedGame({ seed, user: sandbox });
      const s = g.s as unknown as Peek;
      // The narrator's view names people (never ids): a claim's key as the narrator sees it.
      const voiced = (c: Claim): string => keyOf({ ...c, subject: s.nameOf(c.subject), ...(c.object !== undefined ? { object: s.nameOf(c.object) } : {}) });
      const seen = new Set<string>();
      const heardBy = new Map<string, string[]>();
      const comebacks: Array<{ speaker: string; before: string[]; kind: string; tell?: Tell }> = [];
      // Every narrator view built this turn (the turn's own prompt and ours): a telling consumed by the turn's own prompt is still seen.
      let views: Array<{ id: string; tellsYou?: Tell }> = [];
      const build = s.presentKnowledgeForPrompt.bind(s);
      (s as { presentKnowledgeForPrompt: Peek["presentKnowledgeForPrompt"] }).presentKnowledgeForPrompt = () => { const v = build(); views.push(...(v ?? [])); return v; };
      const read = (): void => {
        s.presentKnowledgeForPrompt();
        const view = views;
        views = [];
        for (const c of s.live?.claims?.items ?? []) {
          if (c.listener !== "player" || seen.has(c.id)) continue;
          seen.add(c.id);
          const k = keyOf(c), before = heardBy.get(k) ?? [];
          if (before.length) comebacks.push({ speaker: c.speaker, before: [...before], kind: c.kind, tell: view.find((e) => e.id === c.speaker && e.tellsYou && keyOf(e.tellsYou) === voiced(c))?.tellsYou });
          heardBy.set(k, [...before, c.speaker]);
        }
      };
      // the precondition: a comeback the narrator's view carries (a claim can also reach the player through a scene they were in, e.g. an accusation: never through the view, so not the narrator's to mark)
      g.playUntil(() => { read(); return comebacks.some((c) => c.tell); }, 900, "a claim the player already heard coming back through the narrator");
      return comebacks;
    }, { from: 1, to: 2, hint: [27, 12, 7, 4], sandbox: (s) => `t931-${s}`, what: "a claim the player already heard coming back through the narrator" });
    for (const c of at) {
      expect(c.before, "a houseguest re-told the player the same thing").not.toContain(c.speaker);
      if (c.tell) expect(c.tell.alreadyHeard, "another houseguest's telling of what the player already heard is marked as not news").toBe(true);
    }
  }, 420_000);
});
