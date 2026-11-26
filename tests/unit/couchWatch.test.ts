import { describe, it, expect, afterEach } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import type { AdvanceView, SubmitDecisionReq } from "../../src/ports/GameSession";

/**
 * ORW-650 (0133): watching from the couch, richer. A pre-jury evictee in WATCH mode gets the season's PUBLIC moments since
 * they left (`watching.moments`) and nothing hidden; the projection is absent for an active player and for skip mode;
 * flag off = today. Roles only.
 */
afterEach(() => { delete process.env.ORWELL_COUCH_WATCH; });

function resolve(s: GameSessionAdapter, p: NonNullable<AdvanceView["pending"]>, mode: "watch" | "skip"): void {
  const submit = (req: SubmitDecisionReq): void => void s.submitDecision(req);
  if (p.kind === "nominations") submit({ kind: "nominations", choice: [p.options[0]!.id, p.options[1]!.id] });
  else if (p.kind === "veto-decision") submit({ kind: "veto-decision", use: false });
  else if (p.kind === "replacement") submit({ kind: "replacement", replacement: p.options[0]!.id });
  else if (p.kind === "comp-intent") submit({ kind: "comp-intent", intent: "compete" });
  else if (p.kind === "comp-round") submit({ kind: "comp-round", intent: "compete" });
  else if (p.kind === "exit-interview") submit({ kind: "exit-interview", vote: p.stances![0]! });
  else if (p.kind === "goodbye-message") submit({ kind: "goodbye-message", vote: p.options[0]!.id });
  else if (p.kind === "spectator-choice") submit({ kind: "spectator-choice", vote: mode });
  else if (p.kind === "finale-statement") submit({ kind: "finale-statement", statement: "x" });
  else if (p.kind === "finale-answer") submit({ kind: "finale-answer", appeal: p.appeals![0]! });
  else if (p.kind === "finale-interview") submit({ kind: "finale-interview", vote: "gracious", statement: "good game" });
  else if (!p.options?.length) void s.advanceGame();
  else submit({ kind: p.kind, vote: p.options[0]!.id });
}

let seq = 0;
// ORW-985: the search for a seed that evicts the player pre-jury plays ~20 games. It runs once; every later watcher starts at the seed it found (still a fresh, independent play of that game).
let foundSeed = 1;
function watcher(mode: "watch" | "skip" = "watch"): { s: GameSessionAdapter; mcp: { callTool(name: string, args: unknown): Promise<unknown> }; plant: (hidden: boolean, id: string, content: string) => void } {
  for (let seed = foundSeed; seed <= 60; seed++) {
    const reg = new GameSessionRegistry();
    const user = `cw${seq++}`;
    const sb = reg.sandboxFor(user);
    const s = sb.session;
    s.createCharacter({ playerName: "P", seed });
    for (let i = 0; i < 8000; i++) {
      const v = s.advanceGame();
      if (v.pending?.kind === "spectator-choice") {
        resolve(s, v.pending, mode);
        foundSeed = seed;
        const ev = sb.engine.events;
        return {
          s,
          mcp: reg.resolver()("player", user) as unknown as { callTool(name: string, args: unknown): Promise<unknown> },
          plant: (hidden: boolean, id: string, content: string) => void ev.record({ id, ts: ev.count(), type: "house-event", initiator: "x", witnessSet: hidden ? ["x"] : ["x", "player"], hidden, content }),
        };
      }
      if (v.pending) resolve(s, v.pending, mode);
      if (v.finished) break;
    }
  }
  throw new Error("no seed evicted the player pre-jury");
}
const moments = (s: GameSessionAdapter): string[] | undefined => s.getGameState().watching?.moments;

describe("watching from the couch (ORW-650)", () => {
  it("a watching evictee sees public moments of the following weeks, and a planted hidden scene never rides", () => {
    const w = watcher("watch");
    w.plant(true, "season:hidden-sentinel", "WALLSENTINEL hidden scheme");
    w.plant(true, "scene:hidden-sentinel2", "WALLSENTINEL2 secret");
    expect(moments(w.s), "nothing yet: nothing has happened since they left").toBeUndefined();
    w.s.advanceGame();
    const m = moments(w.s);
    expect(m && m.length, "positive control: public moments appear").toBeGreaterThan(0);
    expect(JSON.stringify(w.s.getGameState())).not.toContain("WALLSENTINEL");
    expect(m!.length).toBeLessThanOrEqual(12);
  });

  it("deterministic: same seed, same feed; and off-flag = no field", () => {
    const a = watcher("watch"); a.s.advanceGame();
    const b = watcher("watch"); b.s.advanceGame();
    expect(moments(a.s)).toEqual(moments(b.s));
    process.env.ORWELL_COUCH_WATCH = "0";
    const c = watcher("watch"); c.s.advanceGame();
    expect(moments(c.s)).toBeUndefined();
  });

  it("survives save/restore and is absent for skip mode", () => {
    const w = watcher("watch"); w.s.advanceGame();
    const before = moments(w.s);
    const live = (w.s as unknown as { live: { couchFromEvent?: number } }).live;
    expect(typeof live.couchFromEvent).toBe("number");
    const snap = JSON.parse(JSON.stringify(w.s.snapshot()));
    expect(snap.live.couchFromEvent).toBe(live.couchFromEvent);
    expect(before).toBeDefined();
    const k = watcher("skip"); k.s.advanceGame();
    expect(moments(k.s)).toBeUndefined();
  });

  it("boundary: the field rides getGameState through McpServer.callTool, public only, and a rebuilt session from the snapshot keeps the stamp", async () => {
    const w = watcher("watch");
    w.plant(true, "season:hidden-sentinel", "WALLSENTINEL hidden scheme");
    w.s.advanceGame();
    const viaTool = (await w.mcp.callTool("getGameState", {})) as { watching?: { moments: string[] } };
    expect(viaTool.watching?.moments?.length, "the tool layer returns the field").toBeGreaterThan(0);
    expect(viaTool.watching!.moments).toEqual(moments(w.s));
    expect(JSON.stringify(viaTool)).not.toContain("WALLSENTINEL");
    const snap = JSON.parse(JSON.stringify(w.s.snapshot()));
    const t = new GameSessionRegistry().sandboxFor(`cw-restore-${seq++}`).session as unknown as { restore(x: unknown): void; live: { couchFromEvent?: number } };
    t.restore(snap);
    expect(t.live.couchFromEvent).toBe((w.s as unknown as { live: { couchFromEvent?: number } }).live.couchFromEvent);
  });

  it("is absent for an active player", () => {
    const s = new GameSessionRegistry().sandboxFor(`cw${seq++}`).session;
    s.createCharacter({ playerName: "P", seed: 3 });
    s.advanceGame();
    expect(moments(s)).toBeUndefined();
  });
});
