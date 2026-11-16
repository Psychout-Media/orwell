/**
 * ORW-555: the narrator's engine-built prompt pieces for N consecutive turns of one played game, as JSON on stdout (or --out <file>).
 * Fake game, fixed seed, no model call, no network. The front-end half of the audit (frontend/scripts/orwell_prefix_audit.py) takes this
 * file, builds the real wire messages around it and reports where consecutive requests first differ.
 *
 * Usage: npx tsx scripts/probes/promptPrefix.ts [--turns 4] [--seed 7] [--out turns.json]
 * Each turn: { systemPrompt, hardConstraints, showBrief, briefSections } as `getMomentPrompt({ brief })` returns them.
 */
import { writeFileSync } from "node:fs";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";

const arg = (name: string, d: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : d;
};

export function playTurns(turns: number, seed: number): Array<Record<string, unknown>> {
  const g = new GameSessionAdapter();
  g.createCharacter({ playerName: "The Player", seed });
  const rooms = ["living-room", "kitchen", "backyard", "bedroom"];
  const out: Array<Record<string, unknown>> = [];
  let seen: unknown;
  for (let t = 0; t < turns; t++) {
    g.noteMessage({ messageId: `m-${t}` });                       // the clock steps one message
    const wa = g.movePlayer(rooms[t % rooms.length]!) ?? g.whereabouts();
    const who = wa?.present.find((p) => p.id !== g.getGameState().player?.id);
    const mp = g.getMomentPrompt({ brief: seen ? { seen: seen as never } : {} });
    out.push({
      turn: t, systemPrompt: mp.systemPrompt, hardConstraints: mp.hardConstraints ?? "",
      showBrief: mp.showBrief?.text ?? "", briefSections: (mp.showBrief?.sections ?? []).map((s) => s.id),
    });
    seen = mp.showBrief?.seen;
    // what the narrator "said" this turn: the engine keeps a rolling record of it and lists it in the next brief
    const first = who ? (g.getGameState().house.find((h) => h.id === who.id)?.name ?? "Alex").split(" ")[0]! : "Alex";
    g.recordNarrationUse({ text: `You walk into the ${rooms[t % rooms.length]}. ${first} tucks a strand behind an ear. "Honestly, I could use a drink," ${first} says. The house hums.` });
  }
  return out;
}

if (process.argv[1] && process.argv[1].includes("promptPrefix")) {
  const res = JSON.stringify(playTurns(Number(arg("turns", "4")), Number(arg("seed", "7"))), null, 1);
  const o = arg("out", "");
  if (o) writeFileSync(o, res); else process.stdout.write(res);
}
