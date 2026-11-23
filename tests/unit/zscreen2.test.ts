import { it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSaveStore } from "/home/ryne/orwell-w771/src/adapters/engine/FileSaveStore";
import { GameSessionAdapter } from "/home/ryne/orwell-w771/src/adapters/engine/GameSessionAdapter";
import { GameSessionRegistry } from "/home/ryne/orwell-w771/src/composition/registry";
it("screen", () => {
  GameSessionAdapter.setTimeOfDayEnabled(true);
  const hits: any[] = [];
  for (let seed = 1; seed <= 40; seed++) {
    const s: any = new GameSessionRegistry(new FileSaveStore(mkdtempSync(join(tmpdir(), "z-")))).sandboxFor("u").session;
    s.createCharacter({ playerName: "P", seed });
    let k = 0, hit = false;
    for (let i = 0; i < 12000 && !hit; i++) {
      k++;
      const st = s.getGameState();
      if (st.finished || st.player?.status && st.player.status !== "active") break;
      const p = s.gameStatus().pending ?? st.pending;
      const cer = p?.ceremony;
      if (p?.kind === "ceremony-step" && cer?.kind === "eviction" && cer?.stepId === "ballot") { hit = true; hits.push({ seed, week: st.week ?? st.status?.week, i }); break; }
      if (p) {
        const a: any = { "comp-round": { kind: "comp-round", intent: "compete" }, "comp-intent": { kind: "comp-intent", intent: "compete" }, nominations: { kind: "nominations", choice: p.options.slice(0, 2).map((o: any) => o.id) }, "veto-decision": { kind: "veto-decision", use: false }, replacement: { kind: "replacement", replacement: p.options[0]?.id }, "houseguests-choice": { kind: "houseguests-choice", vote: p.options[0]?.id }, "eviction-vote": { kind: "eviction-vote", vote: p.options[0]?.id }, "tie-break": { kind: "tie-break", vote: p.options[0]?.id } }[p.kind];
        if (p.kind === "ceremony-step") s.advanceGame(); else if (a) s.submitDecision(a); else break;
        continue;
      }
      const ent = s.premiereIntros?.()?.entrance;
      if (ent && ent.stage !== "done" && ent.stage !== undefined) { s.advanceGame(); continue; }
      if (st.timeOfDay === "night" || st.timeOfDay === "late-night") { s.turnIn(); s.noteMessage({ messageId: "t" + k }); continue; }
      if (st.daySchedule?.due) { s.advanceGame(); continue; }
      s.noteMessage({ messageId: "t" + k });
    }
  }
  console.log("HITS2", JSON.stringify(hits));
}, 900000);
