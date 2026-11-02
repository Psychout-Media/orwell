import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { renderGameContext, renderHardConstraints } from "../../src/engine/momentPrompts";
import type { GameStateView, PresentKnowledgeView, WhereaboutsView } from "../../src/ports/GameSession";
import type { EntityId } from "../../src/domain/ids";
import type { NemesisTrack } from "../../src/engine/campaigns";

/**
 * Audit band D F2 (features 0084 / 0088 / 0096) — the npcVoice carriage cues (`mood`, `currentRead`,
 * `rivalry`) are PUSHED to the narrator every turn through the per-present-NPC knowledge block, the
 * same way `knows`/`suspects` already flow — so they no longer depend on the under-called `npcVoice`.
 * Each cue rides only when set (absent ⇒ byte-identical block), and the cues are Vault-free words:
 * never a number, never the hidden layer. Roles only — no fixture names.
 */

type Peek = {
  presentKnowledgeForPrompt: () => PresentKnowledgeView[];
  nemesisTrack: NemesisTrack;
};

function liveGame(user: string, seed: number) {
  const reg = new GameSessionRegistry();
  const sb = reg.sandboxFor(user);
  sb.session.createCharacter({ playerName: "The Player", seed });
  sb.session.advanceGame(); // close the premiere circle ⇒ normal free-roam presence
  const peek = sb.session as unknown as Peek;
  return { sb, peek };
}

function findPresentNpc(sb: ReturnType<typeof liveGame>["sb"]): EntityId | null {
  for (let i = 0; i < 12; i++) {
    const wa: WhereaboutsView | null = sb.session.whereabouts();
    if (wa && wa.present.length) return wa.present[0]!.id;
    const dest = wa?.nearby.find((n) => n.present.length)?.room ?? wa?.nearby[0]?.room;
    if (!dest) return null;
    sb.session.movePlayer(dest);
  }
  const wa = sb.session.whereabouts();
  return wa && wa.present.length ? wa.present[0]!.id : null;
}

/** The per-present-NPC block of the narration prompt, sliced by its header + indented continuation. */
function presentBlock(systemPrompt: string): string {
  const lines = systemPrompt.split("\n");
  const start = lines.findIndex((l) => l.startsWith("- WHAT EACH HOUSEGUEST IN THE ROOM LEGITIMATELY KNOWS"));
  if (start < 0) return "";
  let end = start + 1;
  while (end < lines.length && /^\s/.test(lines[end]!)) end++;
  return lines.slice(start, end).join("\n");
}

const cueFields = (e: PresentKnowledgeView) => ({ mood: e.mood, currentRead: e.currentRead, rivalry: e.rivalry });

describe("F2 — npcVoice carriage cues reach the narrator via present knowledge", () => {
  it("a co-present houseguest's mood + currentRead ride in present knowledge and the prompt, matching npcVoice", () => {
    const { sb, peek } = liveGame("f2-cues", 4);
    const B = findPresentNpc(sb);
    expect(B, "the scene must have a present houseguest").not.toBeNull();
    const voice = sb.session.npcVoice(B!)!;
    expect(voice.mood, "an active houseguest has a live mood").toBeTruthy();
    expect(voice.currentRead, "an active houseguest has a current read").toBeDefined();

    const entry = peek.presentKnowledgeForPrompt().find((e) => e.id === B);
    expect(entry, "the present houseguest has a present-knowledge entry").toBeDefined();
    expect(entry!.mood).toBe(voice.mood);
    expect(entry!.currentRead).toEqual(voice.currentRead);
    expect(entry!.rivalry, "no nemesis held ⇒ no rivalry cue").toBeUndefined();
    expect("rivalry" in entry!, "an unset cue is ABSENT, not undefined-valued").toBe(false);

    const block = presentBlock(sb.session.getMomentPrompt({}).systemPrompt);
    const label = block.indexOf(`· ${voice.houseguest.name}:`);
    expect(label).toBeGreaterThanOrEqual(0);
    const cueLine = `now (play as conduct, never state): mood ${voice.mood}; toward the player ${voice.currentRead!.toward} (${voice.currentRead!.drift})`;
    expect(block).toContain(cueLine);
    expect(block.indexOf(cueLine)).toBeGreaterThan(label);
    expect(block).not.toContain("rivalry");
  });

  it("the held nemesis, in a live scene, carries the rivalry tone cue", () => {
    const { sb, peek } = liveGame("f2-rivalry", 4);
    const B = findPresentNpc(sb)!;
    peek.nemesisTrack = { current: B, streak: {} };
    const voice = sb.session.npcVoice(B)!;
    expect(voice.rivalry).toBeDefined();
    const entry = peek.presentKnowledgeForPrompt().find((e) => e.id === B)!;
    expect(entry.rivalry).toEqual(voice.rivalry);
    expect(presentBlock(sb.session.getMomentPrompt({}).systemPrompt)).toContain(`rivalry ${voice.rivalry!.tone}`);
  });

  it("the cues are Vault-free words — no numbers, no hidden-layer vocabulary, no Vault sentinel", () => {
    const { sb, peek } = liveGame("f2-vaultfree", 5);
    const B = findPresentNpc(sb)!;
    peek.nemesisTrack = { current: B, streak: {} };
    const SENTINEL = "SENTINEL_F2_vault_confessional_token";
    sb.engine.vault.writeHidden({ id: "f2:v", kind: "confessional", content: SENTINEL });
    const entries = peek.presentKnowledgeForPrompt();
    expect(entries.length).toBeGreaterThan(0);
    const cueJson = JSON.stringify(entries.map(cueFields));
    expect(cueJson).not.toMatch(/\d/);
    expect(cueJson).not.toMatch(/trust|threat|affinity|emotional|volatil|nemesis|campaign/i);
    expect(cueJson).not.toContain(SENTINEL);
    const cueLines = presentBlock(sb.session.getMomentPrompt({}).systemPrompt)
      .split("\n")
      .filter((l) => l.includes("now (play as conduct"));
    expect(cueLines.length).toBeGreaterThan(0);
    for (const l of cueLines) {
      expect(l).not.toMatch(/\d/);
      expect(l).not.toContain(SENTINEL);
      expect(l).not.toMatch(/trust|threat|affinity|nemesis/i);
    }
    // The HUD view still never carries present knowledge (cues included).
    expect(sb.session.getGameState().presentKnowledge).toBeUndefined();
  });
});

describe("F2 — absent cues ⇒ byte-identical rendering", () => {
  const base = (() => {
    const reg = new GameSessionRegistry();
    const sb = reg.sandboxFor("f2-render");
    sb.session.createCharacter({ playerName: "The Player", seed: 7 });
    return sb.session.getGameState();
  })();
  const withPk = (pk: PresentKnowledgeView[]): GameStateView => ({ ...base, presentKnowledge: pk });
  const knowsOnly: PresentKnowledgeView = { id: "npc:1" as EntityId, name: "Houseguest A", knows: ["a witnessed fact"], suspects: [] };

  it("an entry with no cues renders exactly the pre-F2 knows/suspects lines", () => {
    const out = renderGameContext(withPk([knowsOnly]));
    expect(out).toContain("    · Houseguest A:\n        knows: a witnessed fact\n");
    expect(out).not.toContain("now (play as conduct");
  });

  it("an entry with cues adds ONE compact cue line and nothing else", () => {
    const withCues: PresentKnowledgeView = {
      ...knowsOnly,
      mood: "tense",
      currentRead: { toward: "guarded", drift: "cooling" },
      rivalry: { tone: "simmering" },
    };
    const plain = renderGameContext(withPk([knowsOnly]));
    const cued = renderGameContext(withPk([withCues]));
    const cueLine = "        now (play as conduct, never state): mood tense; toward the player guarded (cooling); rivalry simmering\n";
    expect(cued).toContain(cueLine);
    expect(cued.replace(cueLine, "")).toBe(plain);
  });

  it("the terminal hard-constraints block ignores a cues-only entry (no empty KNOWLEDGE SCOPE header)", () => {
    const cuesOnly: PresentKnowledgeView = { ...knowsOnly, knows: [], mood: "tense" };
    const view = withPk([cuesOnly]);
    const hc = renderHardConstraints(view);
    expect(hc ?? "").not.toContain("KNOWLEDGE SCOPE");
    expect(hc).toBe(renderHardConstraints({ ...base }));
  });
});
