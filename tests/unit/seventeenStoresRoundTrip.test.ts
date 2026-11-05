import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSaveStore } from "../../src/adapters/engine/FileSaveStore";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER, npc } from "../../src/domain/ids";

/**
 * B20 (playtest hardening) - EVERY #2017 store survives a save and a restart: the NPC memory ledger, the belief store, the casual-assurance ledger (with its lapse), the vote record, the deduced
 * culprits, the noteMessage dedupe ring, and the B10/B11 co-presence told ledger. One mid-season game with every store populated is saved, restored into a FRESH registry over the same dir, and
 * each store must be deep-equal after. A pre-change save (those keys absent) round-trips with the keys still absent (no spurious empty maps). Mutation: drop any one map from the snapshot => red.
 * Roles only.
 */
const dir = (): string => mkdtempSync(join(tmpdir(), "orwell-b20-"));
type Live = Record<string, unknown> & { npcMemory?: unknown; beliefs?: unknown; assurances?: unknown; voteRecord?: unknown; deducedCulprits?: unknown };
type Sess = { live: Live; copresenceToldLedger(): { record(h: string, f: string, l: string, t: unknown): boolean; snapshot(): unknown }; noteMessage(r: { messageId: string }): unknown; snapshot(): { live?: Live; seenMessageIds?: string[]; toldLedger?: unknown } };

function populated(d: string) {
  const reg = new GameSessionRegistry(new FileSaveStore(d));
  const sb = reg.sandboxFor("u");
  sb.session.createCharacter({ playerName: "P", seed: 5 });
  sb.session.advanceGame(); sb.session.advanceGame();
  const s = sb.session as unknown as Sess;
  const [a, b] = [npc(1), npc(2)];
  s.live.npcMemory = { [a]: { [b]: [{ kind: "deal-kept", week: 1, severity: 0.4 }] } };
  s.live.beliefs = { [a]: [{ id: `${a}|lied-to-me|${b}||1`, holder: a, kind: "lied-to-me", subject: b, value: true, origin: "witnessed", confidence: 0.8, week: 1 }] };
  s.live.assurances = { seq: 2, items: [
    { id: "asr:1", from: a, to: b, kind: "safe", week: 1, sincerity: 1, source: "npc", status: "kept" },
    { id: "asr:2", from: b, to: PLAYER, kind: "vote", week: 1, sincerity: 0.1, source: "npc", status: "open" },
  ] };
  s.live.voteRecord = [{ week: 1, evictee: b, voteOf: { [a]: b } }];
  s.live.deducedCulprits = { [a]: [b] };
  s.copresenceToldLedger().record(a, "fact:1", PLAYER, { outcome: "share" });
  s.noteMessage({ messageId: "m-b20-1" });
  reg.saveUser("u");
  return { reg, s };
}
const reload = (d: string) => new GameSessionRegistry(new FileSaveStore(d)).sandboxFor("u").session as unknown as Sess;

describe("every #2017 store survives a save and restart", () => {
  it("deep-equal after a restore into a fresh registry", () => {
    const d = dir();
    const { s } = populated(d);
    const before = s.snapshot();
    const after = reload(d).snapshot();
    for (const k of ["npcMemory", "beliefs", "assurances", "voteRecord", "deducedCulprits"] as const) {
      expect(before.live?.[k], `${k} was populated before the save`).toBeDefined();
      expect(after.live?.[k], `${k} after a restart`).toEqual(before.live?.[k]);
    }
    expect(after.seenMessageIds).toEqual(before.seenMessageIds);
    expect(after.toldLedger, "the co-presence told ledger after a restart").toEqual(before.toldLedger);
    expect((before.toldLedger as { entries: unknown[] }).entries.length).toBe(1);
  });
  it("a restored told ledger still refuses to re-decide the same telling", () => {
    const d = dir();
    populated(d);
    const r = reload(d);
    expect(r.copresenceToldLedger().record(npc(1), "fact:1", PLAYER, { outcome: "hold" }), "first write wins across the restart").toBe(false);
  });
  it("a pre-change save (those keys absent) round-trips with the keys still absent", () => {
    const d = dir();
    const reg = new GameSessionRegistry(new FileSaveStore(d));
    const sb = reg.sandboxFor("u");
    sb.session.createCharacter({ playerName: "P", seed: 5 });
    sb.session.advanceGame(); sb.session.advanceGame();
    reg.saveUser("u");
    const after = reload(d).snapshot();
    expect(after.toldLedger).toBeUndefined();
    expect(after.seenMessageIds).toBeUndefined();
    for (const k of ["beliefs", "assurances", "voteRecord", "deducedCulprits"] as const) expect(after.live?.[k], `${k} must stay absent`).toBeUndefined();
  });
});
