import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import type { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import type { AdvanceView, SubmitDecisionReq } from "../../src/ports/GameSession";
import { PLAYER } from "../../src/domain/ids";

/**
 * Feature 0129 slice 4 — the INFORMED juror-vote card (ASSUMED, pending Ryne). The brief carries ONLY what the player
 * was told by fellow jurors (`told-by:<juror>`), grouped by finalist; absent when nothing was told; never a lean or a
 * number; nothing a juror merely holds. Roles only.
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
  else if (p.kind === "exit-interview") submit({ kind: "exit-interview", vote: p.stances![0]! });
  else if (p.kind === "spectator-choice") submit({ kind: "spectator-choice", vote: "watch" });
  else if (p.kind === "finale-interview") submit({ kind: "finale-interview", vote: "gracious" });
  else submit({ kind: p.kind, vote: p.options[0]!.id } as never);
}
/** Play a juror-player's game to the open juror-vote card. */
function toVoteCard() {
  for (let seed = 1; seed <= 120; seed++) {
    const sb = new GameSessionRegistry().sandboxFor(`jvc${seq++}`);
    sb.session.createCharacter({ playerName: "P", seed });
    for (let i = 0; i < 9000; i++) {
      const v = sb.session.advanceGame();
      if (v.pending?.kind === "juror-vote" && (sb.session.getGameState().juryHouse?.jurors.length ?? 0) >= 1) return { sb, pending: v.pending };
      if (v.pending) resolve(sb.session, v.pending);
      if (v.finished) break;
    }
  }
  throw new Error("no seed reached a juror-vote card with a jury house");
}
const card = (sb: ReturnType<typeof toVoteCard>["sb"]) => sb.session.advanceGame().pending!;

describe("0129 slice 4 — the informed juror-vote card", () => {
  it("carries no brief when nothing was told (the card is unchanged)", () => {
    const { sb, pending } = toVoteCard();
    expect(pending.kind).toBe("juror-vote");
    expect(pending.jurorBrief).toBeUndefined();
    expect("jurorBrief" in card(sb)).toBe(false);
  });
  it("shows what a juror TOLD the player about a finalist — and nothing a juror merely holds", () => {
    const { sb, pending } = toVoteCard();
    const [f1] = pending.options;
    const [juror] = sb.session.getGameState().juryHouse!.jurors;
    sb.engine.knowledge.seedBelief(juror!.id, { content: `MARK-HELD ${f1!.name} did something unspoken`, originalContent: "x", factId: "jvc:held", confidence: 0.9, hops: 0, distortion: 0, source: juror!.id }, "origin");
    sb.engine.knowledge.seedBelief(juror!.id, { content: `MARK-TOLD ${f1!.name} kept their word`, originalContent: "x", factId: "jvc:told", confidence: 0.9, hops: 0, distortion: 0, source: juror!.id }, "origin");
    sb.engine.knowledge.surfaceInformationTo(PLAYER, { content: `MARK-TOLD ${f1!.name} kept their word`, subject: f1!.id, confidence: 0.7 }, `told-by:${juror!.id}`);
    const c = card(sb);
    expect(c.jurorBrief).toBeDefined();
    const row = c.jurorBrief!.find((b) => b.finalist.id === f1!.id)!;
    expect(row.heard.join(" ")).toContain("MARK-TOLD");
    // grouped by the finalist it concerned: the OTHER finalist has no row for this telling
    expect(c.jurorBrief!.some((b) => b.finalist.id !== f1!.id && b.heard.join(" ").includes("MARK-TOLD"))).toBe(false);
    const blob = JSON.stringify(c);
    expect(blob).not.toContain("MARK-HELD");                     // held by the juror, never told
    for (const banned of ["lean", "trust", "threat", "affinity", "bearing"]) expect(blob.includes(banned), banned).toBe(false);
  });
  it("ignores facts the player learned from a NON-juror teller, and a vault sentinel never rides the card", () => {
    const { sb, pending } = toVoteCard();
    const [f1] = pending.options;
    const live = sb.session.getGameState().house.find((h) => h.status === "active" && h.id !== PLAYER)!;
    const content = `MARK-OTHER ${f1!.name} was seen at the pool`;
    sb.engine.knowledge.seedBelief(live.id, { content, originalContent: content, factId: "jvc:other", confidence: 0.9, hops: 0, distortion: 0, source: live.id }, "origin");
    sb.engine.knowledge.surfaceInformationTo(PLAYER, { content, subject: f1!.id, confidence: 0.7 }, `told-by:${live.id}`);
    expect(sb.engine.knowledge.knownTo(PLAYER).some((f) => f.content.includes("MARK-OTHER") && f.pathway === `told-by:${live.id}`)).toBe(true); // precondition
    sb.engine.vault.writeHidden({ id: "jvc:v", kind: "confessional", content: "SENTINEL-0129-card" });
    const blob = JSON.stringify(card(sb));
    expect(blob).not.toContain("MARK-OTHER");
    expect(blob).not.toContain("SENTINEL-0129-card");
  });
});
