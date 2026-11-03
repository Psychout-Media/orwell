/**
 * A-12 lever-call probe — step 1: export real narrator scenarios (system prompt + player message + the lever a good
 * narrator must call) from a freshly seeded in-process engine. Stateless, no network, no key.
 *   npx tsx dev/scripts/lever_probe/export_scenarios.ts > scenarios.json
 */
import { GameSessionRegistry } from "../../../src/composition/registry";
import type { SubmitDecisionReq, AdvanceView } from "../../../src/ports/GameSession";

type Pending = NonNullable<AdvanceView["pending"]>;
function answer(p: Pending): SubmitDecisionReq {
  switch (p.kind) {
    case "nominations": return { kind: "nominations", choice: [p.options[0]!.id, p.options[1]!.id] };
    case "veto-decision": return { kind: "veto-decision", use: false };
    case "replacement": return { kind: "replacement", replacement: p.options[0]!.id };
    case "comp-intent": return { kind: "comp-intent", intent: "compete" };
    case "comp-round": return { kind: "comp-round", intent: "compete" };
    default: return { kind: p.kind, vote: p.options?.[0]?.id } as never;
  }
}
/** phase -> [player message, lever a correct narrator must call this turn] */
const WANT: Record<string, [string, string]> = {
  "hoh-competition": ["Let's get on with it.", "advanceGame"],
  "nominations": ["Go ahead, move to the ceremony.", "advanceGame"],
  "veto-ceremony": ["Continue.", "advanceGame"],
  "eviction": ["Let's see how the vote goes.", "advanceGame"],
};
const out: unknown[] = [];
const seen = new Set<string>();
const sb = new GameSessionRegistry().sandboxFor("lever-probe");
sb.session.createCharacter({ playerName: "The Player", seed: 11 });
for (let i = 0; i < 3000 && seen.size < Object.keys(WANT).length; i++) {
  const gs = sb.session.getGameState();
  const phase = String(gs.phase ?? "");
  if (WANT[phase] && !seen.has(phase)) {
    seen.add(phase);
    const mp = sb.session.getMomentPrompt({});
    out.push({ id: phase, system: mp.systemPrompt, hard: mp.hardConstraints ?? null, user: WANT[phase]![0], expect: WANT[phase]![1] });
  }
  const v = sb.session.advanceGame();
  if (v.pending) sb.session.submitDecision(answer(v.pending));
  if (v.finished) break;
}
// Social scenarios against a live houseguest (the under-called levers the FE belts exist for).
const npc = sb.session.getGameState().house.find((h) => h.id !== "player" && h.status === "active");
if (npc) {
  // The social levers are measured under the SOCIAL moment, not whatever closed-set phase the walk above ended on.
  const social = sb.session.getMomentPrompt({ moment: "social" });
  out.push({ id: "deal", system: social.systemPrompt, hard: social.hardConstraints ?? null, expect: "makeDeal",
    user: `${npc.name} and I shake on it: I won't put you up this week and you keep my name out of your mouth. Done deal.` });
  out.push({ id: "confide", system: social.systemPrompt, hard: social.hardConstraints ?? null, expect: "confide",
    user: `${npc.name}, we're alone and I trust you. What's really going on with you? You can tell me.` });
}
// Fail loudly: a probe over a silently smaller scenario set would report rates for the wrong thing.
const missing = Object.keys(WANT).filter((p) => !seen.has(p));
if (missing.length || !npc) {
  console.error(`export_scenarios: missing phases [${missing.join(", ")}]${npc ? "" : " and no active houseguest for the social scenarios"}`);
  process.exit(2);
}
process.stdout.write(JSON.stringify(out));
