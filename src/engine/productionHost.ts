import type { EntityId } from "../domain/ids";
import { agendaRoll } from "./agenda";
import { hostQuestions, type HostFact } from "./production";

/**
 * THEME C slice C1 (ORW-667, spec 0210) - THE HOST ON EVICTION NIGHT. Pure, no I/O, no rng draw, no Vault handle, no hidden state.
 *
 * The host is a stable character for the season. Its manner is three continuous leanings (warmth, edge, pace) read from keyed hashes of the game seed
 * (`agendaRoll`, which touches no shared random stream), so a save restored mid-season gives the same host and a headless run is byte-identical. The engine
 * hands the narrator FACTS (a `host` block on the eviction view); the narrator authors every word the host says. There is no list of lines or personas here:
 * the manner reaches the narrator as composed words from the three leanings, and the facts as names and public record.
 *
 * The seam 668 (Diary Room calls) and 669 (the pushing-back producer) share: `hostRegister` is the one place a production voice's manner is derived
 * (they call it with their own owner key), and `hostQuestionTexts` is the pattern for turning public facts into narrator-facing statements.
 */
export interface HostRegister { warmth: number; edge: number; pace: number }

/** A production voice's manner for a season: three leanings in 0..1, keyed by `owner` (the host uses "host"). */
export function hostRegister(seed: number, owner = "host"): HostRegister {
  return {
    warmth: agendaRoll(seed, owner, "reg:warmth"),
    edge: agendaRoll(seed, owner, "reg:edge"),
    pace: agendaRoll(seed, owner, "reg:pace"),
  };
}

/** How much a leaning leans, as a degree word (a ladder over a continuous value, not a pool of lines). */
function degree(x: number): string {
  return x < 0.2 ? "barely" : x < 0.4 ? "a little" : x < 0.6 ? "fairly" : x < 0.8 ? "quite" : "very";
}

/** The manner as composed words for the narrator to voice in its own way. Never a number. */
export function registerWords(r: HostRegister): string {
  const slow = r.pace < 0.5;
  return `${degree(r.warmth)} warm, ${degree(r.edge)} sharp, and ${degree(slow ? 1 - r.pace : r.pace)} ${slow ? "unhurried" : "brisk"} with the room`;
}

/** The shape of a committed count, from the public ballots only. `tieBroken`: both nominees drew the same number, so the HOH decided. */
export type CountShape = "unanimous" | "tie-broken" | "one-vote" | "close" | "lopsided";
export function countShape(a: number, b: number): CountShape {
  const hi = Math.max(a, b), lo = Math.min(a, b);
  if (lo === 0) return "unanimous";
  if (hi === lo) return "tie-broken";
  if (hi - lo === 1) return "one-vote";
  return hi - lo <= Math.max(2, Math.floor((hi + lo) / 4)) ? "close" : "lopsided";
}

/** What the host may say about the count once it is committed (words only; the exact count rides the existing TALLY line). */
export function countFact(shape: CountShape): string {
  switch (shape) {
    case "unanimous": return "every ballot read named the same nominee";
    case "tie-broken": return "the ballots split evenly and the Head of Household had to break the tie";
    case "one-vote": return "the count was decided by a single vote";
    case "close": return "the count was close";
    default: return "the count was lopsided";
  }
}

/** A public fact the host may raise with the evictee, with the sentence the narrator is handed. */
export interface HostLine extends HostFact { text: string }

/** The host's questions for the exit interview as plain statements of public record (own choices first, at most 3, never hidden). */
export function hostQuestionTexts(lines: readonly HostLine[], evictee: EntityId): string[] {
  const byId = new Map(lines.map((l) => [l.id, l.text] as const));
  return hostQuestions(lines, evictee).map((q) => byId.get(q.id)!);
}

/** The player's own seat in this week's public ceremony, as plain role phrases. */
export function playerRoles(p: { player: EntityId; hoh?: EntityId | null; nominees: readonly EntityId[]; vetoHolder?: EntityId | null; vetoUsed?: boolean; evictee?: EntityId | null }): string[] {
  const out: string[] = [];
  if (p.hoh === p.player) out.push("the Head of Household who named the block");
  if (p.nominees.includes(p.player)) out.push("on the block");
  if (p.vetoHolder === p.player) out.push(p.vetoUsed ? "the veto holder, who used it" : "the veto holder, who did not use it");
  if (p.evictee === p.player) out.push("the one voted out");
  return out;
}

/**
 * ORW-719 - what ONE houseguest saying goodbye to the evicted PLAYER can truthfully say about the player: the player's own public record with them, as plain facts
 * (a question they put to the player and whether it was answered, the scenes the two shared in the open, the weeks the player put them on the block). Pure; no rng, no
 * hidden state, no ballot. With no record at all the line says so, so the narrator invents none.
 */
export function goodbyeRecordLines(f: { approach?: { week: number; answered: boolean }; playerScenes: number; speakerScenes: number; putOnBlockByPlayerWeeks: readonly number[] }): string[] {
  const out: string[] = [];
  if (f.approach) out.push(f.approach.answered ? `put a question to the player in week ${f.approach.week} and the player answered it` : `put a question to the player in week ${f.approach.week} and the player has not answered it`);
  if (f.playerScenes > 0) out.push(`the player went to them in ${f.playerScenes} scene${f.playerScenes === 1 ? "" : "s"} the house saw`);
  if (f.speakerScenes > 0) out.push(`they went to the player in ${f.speakerScenes} scene${f.speakerScenes === 1 ? "" : "s"} the house saw`);
  if (f.putOnBlockByPlayerWeeks.length) out.push(`the player, as Head of Household, put them on the block in week ${f.putOnBlockByPlayerWeeks.join(", ")}`);
  if (out.length === 0) out.push("no scene, question or act between the two is on record");
  return out;
}
