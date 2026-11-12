import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { Orchestrator } from "../../src/composition/orchestrator";
import type { SessionSnapshot } from "../../src/engine/sessionSnapshot";
import type { UserSaveStore } from "../../src/ports/UserSaveStore";

/**
 * ORW-286 item 6 (Ryne, BDD cards 30-33). A houseguest's PUBLIC details (age, appearance, presentation, the identity concept, vocation, hometown, biography, the structured
 * physical characteristics, ethnicity, gender presentation, public orientation) must read the same after the game is saved and the server restarts. They live on the
 * byte-stable Character, outside the soul that evolves, and nothing may re-derive or drift them on load. Asserted for the whole cast AND the player, across two restarts, and
 * ALSO after the one legitimate change (the season-start floor -> authored upgrade through recordCastProfile) so the upgraded values, not the seeded floor, are what come back.
 * Roles only, no names; the restart is a fresh registry over the SAME durable store (0030).
 */

class MemoryStore implements UserSaveStore {
  readonly saved = new Map<string, SessionSnapshot[]>();
  saveFor(user: string, s: SessionSnapshot): void { this.saved.set(user, [...(this.saved.get(user) ?? []), s]); }
  hasSave(user: string): boolean { return (this.saved.get(user)?.length ?? 0) > 0; }
  loadLatest(user: string): SessionSnapshot | null { const l = this.saved.get(user); return l?.length ? l[l.length - 1]! : null; }
}

const PUBLIC_FIELDS = ["age", "appearance", "presentation", "identityConcept", "vocation", "hometown", "biography", "physicalCharacteristics", "ethnicity", "genderPresentation", "outOrientation", "background"] as const;

function boot(store: MemoryStore, user: string, seed: number) {
  const reg = new GameSessionRegistry(store);
  new Orchestrator(reg, { now: () => seed }, { seed });
  return { reg, sb: reg.sandboxFor(user) };
}

/** Every houseguest's public details, keyed by id, as plain JSON (so a deep difference shows up as a difference). */
function publicDetails(sb: ReturnType<typeof boot>["sb"]): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const n of sb.session.snapshot().house!.npcs) {
    const c = n.character as unknown as Record<string, unknown>;
    out[n.id] = { name: n.name, ...Object.fromEntries(PUBLIC_FIELDS.map((f) => [f, c[f] ?? null])) };
  }
  return out;
}

describe("a houseguest's public details survive a save and a restart unchanged", () => {
  it("the whole cast reads the same across two restarts (and the sweep is not vacuous)", async () => {
    const user = "public-roundtrip";
    const store = new MemoryStore();
    const first = boot(store, user, 6101);
    first.sb.session.createCharacter({ playerName: "The Player", seed: 6101 });
    for (let i = 0; i < 5; i++) first.sb.session.advanceGame();   // some play, so any lazy re-derivation has had its chance
    await first.sb.mcp.player.callTool("noteMessage", { messageId: "turn-before-save" });
    const before = publicDetails(first.sb);
    expect(Object.keys(before).length).toBeGreaterThan(10);
    // the sweep compares real values: most of the fields are populated for most of the cast
    const populated = Object.values(before).filter((d) => d.age !== null && d.appearance !== null && d.presentation !== null).length;
    expect(populated).toBeGreaterThan(10);

    const second = boot(store, user, 6101);
    expect(publicDetails(second.sb)).toEqual(before);
    await second.sb.mcp.player.callTool("noteMessage", { messageId: "turn-after-restart" });
    const third = boot(store, user, 6101);
    expect(publicDetails(third.sb)).toEqual(before);
  });

  it("an authored profile (the floor -> authored upgrade) comes back as authored, not as the seeded floor", async () => {
    const user = "public-roundtrip-authored";
    const store = new MemoryStore();
    const first = boot(store, user, 6102);
    first.sb.session.createCharacter({ playerName: "The Player", seed: 6102 });
    const id = first.sb.session.getGameState().house[0]!.id;
    const floor = publicDetails(first.sb)[id]!;
    const res = first.sb.session.recordCastProfile({
      houseguestId: id,
      vocation: "court reporter",
      biography: "Grew up one of five in a small river town and spent a decade transcribing other people's worst days before trying her luck on television.",
    });
    expect(res.accepted).toBe(true);
    await first.sb.mcp.player.callTool("noteMessage", { messageId: "turn-after-authoring" });
    const authored = publicDetails(first.sb)[id]!;
    expect(authored.vocation).toBe("court reporter");
    expect(authored.biography).not.toBe(floor.biography);           // the upgrade really changed something, so the comparison below means something

    const restarted = boot(store, user, 6102);
    expect(publicDetails(restarted.sb)[id]).toEqual(authored);      // and the restart returns the authored values
  });

  it("the player's own public character reads the same after a restart", async () => {
    const user = "public-roundtrip-player";
    const store = new MemoryStore();
    const first = boot(store, user, 6103);
    first.sb.session.createCharacter({ playerName: "The Player", seed: 6103, backstory: "a life of small wins", motivation: "to prove it" });
    await first.sb.mcp.player.callTool("noteMessage", { messageId: "turn-before-save" });
    const snap = (s: ReturnType<typeof boot>["sb"]) => JSON.stringify(s.session.getGameState().player ?? null);
    const before = snap(first.sb);
    expect(before).not.toBe("null");
    expect(snap(boot(store, user, 6103).sb)).toBe(before);
  });

  it("the probe is live: an age that drifted inside the save file is seen after the restart (positive control)", async () => {
    const user = "public-roundtrip-control";
    const store = new MemoryStore();
    const first = boot(store, user, 6104);
    first.sb.session.createCharacter({ playerName: "The Player", seed: 6104 });
    await first.sb.mcp.player.callTool("noteMessage", { messageId: "turn-before-save" });
    const before = publicDetails(first.sb);
    const latest = store.loadLatest(user)!;
    const victim = latest.house!.npcs[0]! as unknown as { id: string; character: { age: number } };
    victim.character.age += 1;                       // the save file now disagrees with what was true
    const after = publicDetails(boot(store, user, 6104).sb);
    expect(after[victim.id]!.age).toBe((before[victim.id]!.age as number) + 1);
    expect(after).not.toEqual(before);
  });
});
