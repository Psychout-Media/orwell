import type { buildSandbox } from "../../tests/support/sandbox";
import { PLAYER } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";

/** The player LEARNS a secret about `subject` through a modeled pathway (told-by) - shared by the 0093 and 0099 step files (AMEND 3a / A25: it was copy-pasted in both). Returns the fact id. */
export function learn(sb: ReturnType<typeof buildSandbox>, subject: EntityId): string {
  sb.engine.knowledge.seedBelief(subject, { content: `a learned secret about ${subject}`, originalContent: "x", factId: `seed:${subject}`, confidence: 0.9, hops: 0, distortion: 0, source: subject }, "origin");
  sb.engine.knowledge.surfaceInformationTo(PLAYER, { content: `a learned secret about ${subject}`, subject, confidence: 0.85 }, `told-by:${subject}`);
  const fact = sb.engine.knowledge.knownTo(PLAYER).find((f) => f.subject === subject)!;
  return fact.factId ?? fact.id;
}
