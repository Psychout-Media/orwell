import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { EngineCommandsAdapter } from "../../src/adapters/engine/EngineCommandsAdapter";
import { McpServer } from "../../src/adapters/mcp/McpServer";
import { PLAYER_TOOLS } from "../../src/surfaces/tools/registry";
import { buildSandbox } from "../support/sandbox";
import { ROOM_CANON_FEATURE_MAX, roomCanonProposal, roomCanonSection } from "../../src/engine/roomCanon";
import { emptyCanonLedger, recordCanon } from "../../src/engine/canonLedger";
import { HOUSE_ROOMS } from "../../src/domain/house";
import type { MomentPromptView } from "../../src/ports/GameSession";

/**
 * ORW-223 slice 1 - the room canon write-back (Showrunner memory part B, house map only). Roles only: the cast is
 * generated from a seed and no name appears here. The write-back accepts only {roomId, feature}, records append-only
 * Vault-free canon for a played game, and the Show Brief lists the current room's canon.
 */

type Priv = { live: { playedGame?: boolean } | null; canonLedger: { entries: Array<{ text: string; scope: { room?: string } }> }; canonAsLoaded: unknown };

function played(seed = 11): GameSessionAdapter {
  const g = new GameSessionAdapter();
  g.createCharacter({ playerName: "The Player", seed });
  g.noteMessage({ messageId: `m-${seed}-1` }); // a person is playing: the same door the FE uses
  return g;
}
const room = (g: GameSessionAdapter): string => g.whereabouts()!.room;
const brief = (g: GameSessionAdapter): MomentPromptView => g.getMomentPrompt({ brief: {} });

describe("roomCanonProposal (shape and content gate)", () => {
  it("accepts exactly {roomId, feature} for a known room and builds a room-scoped house-detail proposal", () => {
    const p = roomCanonProposal({ roomId: "kitchen", feature: "  a chipped\nmug sits by the sink  " });
    expect(typeof p).toBe("object");
    if (typeof p === "string") return;
    expect(p.feature).toBe("a chipped mug sits by the sink");
    expect(p.proposal.scope).toEqual({ kind: "room", room: "kitchen" });
    expect(p.proposal.category).toBe("house-detail");
  });
  it("rejects extra keys, missing keys, non-objects and non-strings", () => {
    expect(roomCanonProposal({ roomId: "kitchen", feature: "x", extra: 1 })).toBe("bad-shape");
    expect(roomCanonProposal({ roomId: "kitchen" })).toBe("bad-shape");
    expect(roomCanonProposal(null)).toBe("bad-shape");
    expect(roomCanonProposal([])).toBe("bad-shape");
    expect(roomCanonProposal({ roomId: 3, feature: "x" })).toBe("bad-shape");
  });
  it("rejects an unknown room, an empty feature and an over-long feature (never truncates)", () => {
    expect(roomCanonProposal({ roomId: "attic", feature: "a dusty mug" })).toBe("bad-room");
    expect(roomCanonProposal({ roomId: "kitchen", feature: "   " })).toBe("empty");
    expect(roomCanonProposal({ roomId: "kitchen", feature: "m".repeat(ROOM_CANON_FEATURE_MAX + 1) })).toBe("too-long");
    expect(typeof roomCanonProposal({ roomId: "kitchen", feature: "m".repeat(ROOM_CANON_FEATURE_MAX) })).toBe("object");
  });
});

describe("recordRoomCanon (the adapter write-back)", () => {
  it("records a room feature, persists it in the save, and refuses nothing about a clean mug", () => {
    const g = played();
    const r = room(g);
    const res = g.recordRoomCanon({ roomId: r, feature: "a chipped mug sits by the window" });
    // a room with no loose props (the diary room) is the one legitimate refusal; every other room accepts
    if (r === "diary-room") { expect(res.accepted).toBe(false); return; }
    expect(res).toMatchObject({ accepted: true });
    expect(res.entryId).toMatch(/^canon:\d+$/);
    expect((g.snapshot() as unknown as { canon: { entries: Array<{ text: string }> } }).canon.entries.map((e) => e.text)).toContain("a chipped mug sits by the window");
  });

  it("is append-only: a repeat is a no-op, and nothing recorded is ever removed", () => {
    const g = played();
    const r = HOUSE_ROOMS.find((x) => x !== "diary-room")!;
    expect(g.recordRoomCanon({ roomId: r, feature: "a faded blanket over the arm" }).accepted).toBe(true);
    const before = (g as unknown as Priv).canonLedger.entries.length;
    expect(g.recordRoomCanon({ roomId: r, feature: "a faded blanket over the arm" }).accepted).toBe(true); // idempotent replay
    expect((g as unknown as Priv).canonLedger.entries.length).toBe(before);
    expect(g.recordRoomCanon({ roomId: r, feature: "a worn towel on the hook" }).accepted).toBe(true);
    expect((g as unknown as Priv).canonLedger.entries.length).toBe(before + 1);
  });

  it("rejects everything that is not a minor room detail, and records nothing for it", () => {
    const g = played();
    const r = HOUSE_ROOMS.find((x) => x !== "diary-room")!;
    const bad: Array<[string, string]> = [
      ["event", "she nominates him for eviction tonight"],         // relationship / event words
      ["secret", "there is a hidden tunnel behind the wall"],       // hidden place
      ["device", "a key and a note are tucked under the mug"],      // plot devices
      ["number", "exactly 3 mugs sit on the shelf"],                // any number
      ["knowledge", "he secretly knows that she plans to betray him"],
    ];
    for (const [, feature] of bad) {
      const res = g.recordRoomCanon({ roomId: r, feature });
      expect(res.accepted, feature).toBe(false);
      expect(res.reason, feature).toBeTruthy();
    }
    expect((g as unknown as Priv).canonLedger.entries.length).toBe(0);
    // a rejection never echoes the text
    expect(JSON.stringify(g.recordRoomCanon({ roomId: r, feature: "a hidden tunnel under the rug" }))).not.toContain("tunnel");
  });

  it("is a no-op before a game, before anyone plays, when the flag is off, and while the stored ledger is locked", () => {
    const fresh = new GameSessionAdapter();
    expect(fresh.recordRoomCanon({ roomId: "kitchen", feature: "a chipped mug" })).toEqual({ accepted: false, reason: "no-game" });
    const headless = new GameSessionAdapter();
    headless.createCharacter({ playerName: "The Player", seed: 3 });
    expect(headless.recordRoomCanon({ roomId: "kitchen", feature: "a chipped mug" }).reason).toBe("no-game");
    const off = played(4);
    off.setRoomCanonEnabled(false);
    expect(off.recordRoomCanon({ roomId: "kitchen", feature: "a chipped mug" }).reason).toBe("off");
    const locked = played(5);
    (locked as unknown as Priv).canonAsLoaded = { schemaVersion: 1, nextId: 1, entries: [], recent: [] };
    expect(locked.recordRoomCanon({ roomId: "kitchen", feature: "a chipped mug" }).reason).toBe("locked");
  });

  it("does not bump beatSeq and touches no game state (a played-game byte-identity check, canon aside)", () => {
    const a = played(21);
    const b = played(21);
    const r = HOUSE_ROOMS.find((x) => x !== "diary-room")!;
    const seqBefore = b.getGameState().beatSeq;
    b.recordRoomCanon({ roomId: r, feature: "a faded blanket over the arm" });
    b.recordRoomCanon({ roomId: r, feature: "a cheerful plant by the door" });
    expect(b.getGameState().beatSeq).toBe(seqBefore);
    const strip = (g: GameSessionAdapter): string => {
      const s = JSON.parse(JSON.stringify(g.snapshot())) as Record<string, unknown>;
      delete s.canon;
      return JSON.stringify(s);
    };
    expect(strip(b)).toBe(strip(a));
    // and the same actions afterward still agree: the write-back consumed no randomness
    const stepA = JSON.stringify(a.advanceGame());
    const stepB = JSON.stringify(b.advanceGame());
    expect(stepB).toBe(stepA);
  });

  it("an unplayed (headless) game saves byte-identically with the feature present", () => {
    const g = new GameSessionAdapter();
    g.createCharacter({ playerName: "The Player", seed: 8 });
    expect(JSON.stringify(g.snapshot())).not.toContain('"canon"');
    g.recordRoomCanon({ roomId: "kitchen", feature: "a chipped mug" });
    expect(JSON.stringify(g.snapshot())).not.toContain('"canon"');
  });
});

describe("the Show Brief Canon section", () => {
  it("lists the current room's canon (and only that room's), after the established section", () => {
    const g = played(12);
    const r = room(g);
    const other = HOUSE_ROOMS.find((x) => x !== r && x !== "diary-room")!;
    if (r !== "diary-room") expect(g.recordRoomCanon({ roomId: r, feature: "a scuffed mug sits on the ledge" }).accepted).toBe(true);
    expect(g.recordRoomCanon({ roomId: other, feature: "a spare towel hangs by the door" }).accepted).toBe(true);
    const b = brief(g).showBrief!;
    if (r === "diary-room") { expect(b.text).not.toContain("4. CANON"); return; }
    expect(b.sections.map((s) => s.id)).toEqual(["header", "now", "changed", "established", "canon"]);
    expect(b.text).toContain("4. CANON");
    expect(b.text).toContain("- a scuffed mug sits on the ledge");
    expect(b.text).not.toContain("spare towel");
    expect(b.text.indexOf("3. WHAT YOU ESTABLISHED")).toBeLessThan(b.text.indexOf("4. CANON"));
  });

  it("no canon recorded (or the flag off) leaves the brief exactly as it was", () => {
    const g = played(13);
    const base = brief(g).showBrief!;
    expect(base.text).not.toContain("CANON");
    expect(base.sections.map((s) => s.id)).toEqual(["header", "now", "changed", "established"]);
    const r = room(g);
    if (r !== "diary-room") {
      g.recordRoomCanon({ roomId: r, feature: "a scuffed mug sits on the ledge" });
      g.setRoomCanonEnabled(false);
      expect(brief(g).showBrief!.text).toBe(base.text);
    }
  });

  it("the section is small and deterministic (pure function of the ledger)", () => {
    const policy = { leaksVault: () => false, forbiddenTerm: () => undefined, propCategoriesFor: () => ["drinkware"], isHouseguest: () => false };
    let l = emptyCanonLedger();
    for (let i = 0; i < 9; i++) {
      l = recordCanon(l, {
        turn: i, beatSeq: i, sceneKey: String(i), idempotencyKey: `k${i}`,
        proposals: [{ text: `a tin mug number ${"abcdefghi"[i]}`.replace("number ", ""), category: "house-detail", scope: { kind: "room", room: "kitchen" }, speaker: "narrator", witnesses: ["player"], quote: `q${i}`, propCategory: "drinkware" }],
      }, policy).ledger;
    }
    const s1 = roomCanonSection("kitchen", l.entries)!;
    expect(s1).toBe(roomCanonSection("kitchen", l.entries));
    expect(s1.split("\n").filter((x) => x.startsWith("- ")).length).toBe(6); // capped
    expect(roomCanonSection("backyard", l.entries)).toBeUndefined();
  });
});

describe("the Vault Wall (sentinel)", () => {
  const SENTINEL = "SENTINEL-HIDDEN-5521";
  it("nothing hidden reaches the ledger, the save or the brief; the brief/canon path reads only Vault-free projections", () => {
    const g = played(31);
    const r = HOUSE_ROOMS.find((x) => x !== "diary-room")!;
    g.recordRoomCanon({ roomId: r, feature: "a plain mug sits on the shelf" });
    const blob = JSON.stringify([g.snapshot(), brief(g), g.getGameState()]);
    expect(blob).not.toContain(SENTINEL);
    // the module stays outward-safe: no Vault, VectorIndex or SoulProvider edge
    const src = readFileSync("src/engine/roomCanon.ts", "utf8");
    expect(src).not.toMatch(/ports\/(VaultStore|VectorIndex|SoulProvider)/);
  });
  it("a feature that tries to carry hidden machinery is refused by the class fence, not stored", () => {
    const g = played(32);
    const r = HOUSE_ROOMS.find((x) => x !== "diary-room")!;
    for (const feature of ["the vault holds a secret recording", "a hidden hatch under the rug", "she is secretly allied with him"]) {
      expect(g.recordRoomCanon({ roomId: r, feature }).accepted, feature).toBe(false);
    }
  });
});

describe("the write-back reaches the engine over the MCP boundary (four-place wiring)", () => {
  function playerServer(): { server: McpServer; session: GameSessionAdapter } {
    const sb = buildSandbox(1);
    const session = new GameSessionAdapter();
    const commands = new EngineCommandsAdapter(sb.engine.events, sb.engine.knowledge);
    const server = new McpServer("player", { player: sb.player, admin: sb.admin, summary: sb.summary, commands, session });
    return { server, session };
  }
  it("recordRoomCanon is on the player channel and dispatches through callTool", async () => {
    expect(PLAYER_TOOLS.map((t) => t.name)).toContain("recordRoomCanon");
    const { server, session } = playerServer();
    session.createCharacter({ playerName: "The Player", seed: 9 });
    session.noteMessage({ messageId: "m-boundary" });
    const r = HOUSE_ROOMS.find((x) => x !== "diary-room")!;
    const res = (await server.callTool("recordRoomCanon", { roomId: r, feature: "a worn rug lies under the table" })) as { accepted: boolean };
    expect(res.accepted).toBe(true);
    const bad = (await server.callTool("recordRoomCanon", { roomId: "nowhere", feature: "a worn rug" })) as { accepted: boolean; reason: string };
    expect(bad).toEqual({ accepted: false, reason: "bad-room" });
  });
  it("the boundary refuses a malformed call with a typed field name, and the engine rejects extra keys", async () => {
    const { server, session } = playerServer();
    session.createCharacter({ playerName: "The Player", seed: 10 });
    session.noteMessage({ messageId: "m-boundary2" });
    await expect(server.callTool("recordRoomCanon", { roomId: "kitchen" })).rejects.toThrow(/feature/);
    await expect(server.callTool("recordRoomCanon", { feature: "a rug" })).rejects.toThrow(/roomId/);
    const extra = (await server.callTool("recordRoomCanon", { roomId: "kitchen", feature: "a rug", hiddenFactId: "x" })) as { accepted: boolean; reason: string };
    expect(extra).toEqual({ accepted: false, reason: "bad-shape" });
  });
});
