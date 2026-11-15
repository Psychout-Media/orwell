import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import type { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import type { AdvanceView, SubmitDecisionReq } from "../../src/ports/GameSession";
import { PLAYER } from "../../src/domain/ids";
import { McpServer } from "../../src/adapters/mcp/McpServer";
import { EngineCommandsAdapter } from "../../src/adapters/engine/EngineCommandsAdapter";

/**
 * Feature 0129 slices 2-3 — the jury house VOICE seam. Seam reuse (no new knowledge reader): the narrator sees each
 * other juror under THEIR OWN knowledge block (the `npcVoice` scope), and `askJuror` is the only way a juror's
 * knowledge reaches the player — through the content-anchored `told-by:<juror>` pathway. Includes the 0001 canary.
 * Roles only.
 */
let seq = 0;
function resolve(s: GameSessionAdapter, p: NonNullable<AdvanceView["pending"]>): void {
  const submit = (req: SubmitDecisionReq): void => void s.submitDecision(req);
  if (p.kind === "nominations") submit({ kind: "nominations", choice: [p.options[0]!.id, p.options[1]!.id] });
  else if (p.kind === "veto-decision") submit({ kind: "veto-decision", use: false });
  else if (p.kind === "replacement") submit({ kind: "replacement", replacement: p.options[0]!.id });
  else if (p.kind === "comp-intent") submit({ kind: "comp-intent", intent: "compete" });
  else if (p.kind === "comp-round") submit({ kind: "comp-round", intent: "compete" });
  else if (p.kind === "finale-statement") submit({ kind: "finale-statement", statement: "x" });
  else if (p.kind === "finale-answer") submit({ kind: "finale-answer", appeal: p.appeals![0]! });
  else if (p.kind === "juror-vote") submit({ kind: "juror-vote", vote: p.options[0]!.id });
  else if (p.kind === "exit-interview") submit({ kind: "exit-interview", vote: p.stances![0]! });
  else if (p.kind === "spectator-choice") submit({ kind: "spectator-choice", vote: "watch" });
  else if (p.kind === "finale-interview") submit({ kind: "finale-interview", vote: "gracious" });
  else submit({ kind: p.kind, vote: p.options[0]!.id } as never);
}
/** A game where the player sits on the jury with at least TWO other jurors. */
function jurorGame() {
  for (let seed = 1; seed <= 120; seed++) {
    const sb = new GameSessionRegistry().sandboxFor(`jv${seq++}`);
    sb.session.createCharacter({ playerName: "P", seed });
    for (let i = 0; i < 8000; i++) {
      const v = sb.session.advanceGame();
      const st = sb.session.getGameState();
      if (st.player?.status === "jury" && (st.juryHouse?.jurors.length ?? 0) >= 2 && !v.pending) return sb;
      if (v.pending) resolve(sb.session, v.pending);
      if (v.finished) break;
    }
  }
  throw new Error("no seed seated the player on the jury with two other jurors");
}
type Sb = ReturnType<typeof jurorGame>;
function hold(sb: Sb, holder: string, factId: string, content: string): void {
  sb.engine.knowledge.seedBelief(holder, { content, originalContent: content, factId, confidence: 0.9, hops: 0, distortion: 0, source: holder }, "origin");
}
function setBearing(sb: Sb, jurorId: string, m: Record<string, boolean>): void {
  const core = sb.session.snapshot();
  core.live!.mannerByEvictee = { ...(core.live!.mannerByEvictee ?? {}), [jurorId]: { [PLAYER]: m } } as never;
  sb.session.restore(core);
}
const prompt = (sb: Sb) => sb.session.getMomentPrompt({}).systemPrompt;

describe("0129 slice 2 — each juror is voiced from THEIR OWN knowledge block", () => {
  it("a juror's fact appears under that juror only, never under the other", () => {
    const sb = jurorGame();
    const [a, b] = sb.session.getGameState().juryHouse!.jurors;
    hold(sb, a!.id, "jv:fa", "MARK-ALPHA kept a quiet pact");
    hold(sb, b!.id, "jv:fb", "MARK-BRAVO saw the veto go unused");
    const p = prompt(sb);
    const blockOf = (name: string) => {
      const at = p.indexOf(`· ${name}:`);
      expect(at).toBeGreaterThan(-1);
      const rest = p.slice(at + 1);
      const next = rest.search(/\n\s{4}· /);
      return next < 0 ? rest.slice(0, 600) : rest.slice(0, next);
    };
    expect(blockOf(a!.name)).toContain("MARK-ALPHA");
    expect(blockOf(a!.name)).not.toContain("MARK-BRAVO");
    expect(blockOf(b!.name)).toContain("MARK-BRAVO");
    expect(blockOf(b!.name)).not.toContain("MARK-ALPHA");
  });
  it("an ACTIVE player (not a juror) is unchanged: no juror blocks", () => {
    const sb = new GameSessionRegistry().sandboxFor(`jv-act${seq++}`);
    sb.session.createCharacter({ playerName: "P", seed: 3 });
    sb.session.advanceGame();
    expect(sb.session.getGameState().juryHouse).toBeUndefined();
    expect(sb.session.askJuror(sb.session.getGameState().house[0]!.id)).toBeNull();
  });
});

describe("0129 slice 3 — askJuror", () => {
  it("a warm juror tells ONE thing they hold; it reaches the player as told-by:<juror> knowledge", () => {
    const sb = jurorGame();
    const [a] = sb.session.getGameState().juryHouse!.jurors;
    setBearing(sb, a!.id, { respected: true });
    hold(sb, a!.id, "jv:t1", "MARK-TOLD the HOH room was rearranged");
    const r = sb.session.askJuror(a!.id)!;
    expect(r.told).toBe(true);
    expect(r.bearing).toBe("warm");
    expect(r.content).toContain("MARK-TOLD");
    const learned = sb.engine.knowledge.knownTo(PLAYER).find((f) => f.content.includes("MARK-TOLD"));
    expect(learned?.pathway).toBe(`told-by:${a!.id}`);
  });
  it("folds nothing: a telling moves NO relationship edge (ORW-112 / 0129 - a juror has no pathway back to the house)", () => {
    const sb = jurorGame();
    const [a] = sb.session.getGameState().juryHouse!.jurors;
    setBearing(sb, a!.id, { respected: true });
    hold(sb, a!.id, "jv:t0", "MARK-FOLD something only this juror holds");
    const edges = () => JSON.stringify(sb.engine.relationships.serialize().edges);
    const before = edges();
    expect(before.length).toBeGreaterThan(2); // positive control: there are edges to move
    const r = sb.session.askJuror(a!.id)!;
    expect(r.told, "a warm juror always tells, so the telling path really ran").toBe(true);
    expect(edges()).toBe(before);
  });
  it("a sour juror stonewalls: nothing is told and the player learns nothing", () => {
    const sb = jurorGame();
    const [a] = sb.session.getGameState().juryHouse!.jurors;
    setBearing(sb, a!.id, { blindsided: true });
    hold(sb, a!.id, "jv:t2", "MARK-SOUR something");
    const r = sb.session.askJuror(a!.id)!;
    expect(r).toEqual({ told: false, bearing: "sour" });
    expect(sb.engine.knowledge.knownTo(PLAYER).some((f) => f.content.includes("MARK-SOUR"))).toBe(false);
  });
  it("never re-tells what the player already holds, and refuses a non-juror / an active player", () => {
    const sb = jurorGame();
    const [a] = sb.session.getGameState().juryHouse!.jurors;
    setBearing(sb, a!.id, { respected: true });
    hold(sb, a!.id, "jv:t3", "MARK-ONCE only thing");
    const first = sb.session.askJuror(a!.id)!;
    expect(first.told).toBe(true);
    // A repeat press never re-tells the same fact (the juror may hold other engine-seeded facts).
    const again = sb.session.askJuror(a!.id)!;
    if (again.told) expect(again.content).not.toBe(first.content);
    expect(sb.session.askJuror("npc:nobody")).toBeNull();
    expect(sb.session.askJuror(PLAYER)).toBeNull();
    const act = new GameSessionRegistry().sandboxFor(`jv-act2${seq++}`);
    act.session.createCharacter({ playerName: "P", seed: 3 });
    expect(act.session.askJuror(act.session.getGameState().house[0]!.id)).toBeNull();
  });
  it("CANARY (0001): a Vault sentinel and a LIVE houseguest's private knowledge never reach the juror's block, the telling, or the state", () => {
    const sb = jurorGame();
    const jurors = sb.session.getGameState().juryHouse!.jurors;
    const [a] = jurors;
    setBearing(sb, a!.id, { respected: true });
    const live = sb.session.getGameState().house.find((h) => h.status === "active" && h.id !== PLAYER)!;
    hold(sb, live.id, "jv:live", "SENTINEL-LIVE-NPC-PRIVATE plan");
    const vault = "SENTINEL-0129-vault";
    sb.engine.vault.writeHidden({ id: "jv:v", kind: "confessional", content: vault });
    hold(sb, a!.id, "jv:ok", "MARK-OK what the juror saw");
    for (let i = 0; i < 6; i++) sb.session.askJuror(a!.id);
    const blob = JSON.stringify([prompt(sb), sb.session.getGameState(), sb.session.askJuror(a!.id), sb.engine.knowledge.knownTo(PLAYER)]);
    expect(blob).not.toContain("SENTINEL-LIVE-NPC-PRIVATE");
    expect(blob).not.toContain(vault);
  });
  it("the telling decision is a pure function of (seed, juror, week, phase): two identical games decide alike", () => {
    const decide = () => {
      const sb = jurorGame();
      const [x] = sb.session.getGameState().juryHouse!.jurors;
      setBearing(sb, x!.id, { disrespected: true });
      hold(sb, x!.id, "jv:t4", "MARK-DET fact");
      return sb.session.askJuror(x!.id)!.told;
    };
    expect(decide()).toBe(decide());
  });
  it("never tells an engine-seeded vote-deduction (sealed ballot attribution) and keeps it out of the juror's block", () => {
    const sb = jurorGame();
    const [x] = sb.session.getGameState().juryHouse!.jurors;
    setBearing(sb, x!.id, { respected: true });
    sb.engine.knowledge.seedBelief(x!.id, { content: "MARK-BLAME believes Someone turned on them in the eviction vote", factId: `traitors-fury:blame:${x!.id}:p`, source: x!.id, hops: 0, distortion: 0, confidence: 1 } as never, `jury-house:blame:${x!.id}`);
    expect(prompt(sb)).not.toContain("MARK-BLAME");
    for (let i = 0; i < 4; i++) expect(JSON.stringify(sb.session.askJuror(x!.id))).not.toContain("MARK-BLAME");
    expect(sb.engine.knowledge.knownTo(PLAYER).some((f) => f.content.includes("MARK-BLAME"))).toBe(false);
  });
});

describe("0129 slice 3 — the askJuror MCP boundary (the write-back/lever dispatch gate)", () => {
  it("dispatches through McpServer.callTool, and refuses a missing jurorId", async () => {
    const sb = jurorGame();
    const commands = new EngineCommandsAdapter(sb.engine.events, sb.engine.knowledge);
    const srv = new McpServer("player", { player: sb.player, admin: sb.admin, summary: sb.summary, commands, session: sb.session });
    const [a] = sb.session.getGameState().juryHouse!.jurors;
    setBearing(sb, a!.id, { respected: true });
    hold(sb, a!.id, "jv:m1", "MARK-MCP told via the tool layer");
    const r = (await srv.callTool("askJuror", { jurorId: a!.id })) as { told: boolean; content?: string };
    expect(r.told).toBe(true);
    expect(r.content).toContain("MARK-MCP");
    await expect(srv.callTool("askJuror", {})).rejects.toThrow();
  });
});
