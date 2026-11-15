/**
 * OPEN LEDGER (ORW-407, first slice). Pure helpers for what the narrator invents that matters: a commitment or claim
 * made TO or BY the player, kept as free text (the `kind` is a free string, never a closed list) and remembered with
 * where it came from. Built only from player-visible narration and public presence; it holds no Vault handle and
 * changes no relationship number. No randomness, no I/O.
 */
import { canonHash, normalizeCanonText } from "./canonLedger";

export const OPEN_LEDGER_TEXT_MAX = 240;
export const OPEN_LEDGER_KIND_MAX = 40;
export const OPEN_LEDGER_ADDRESSED_MAX = 4;
export const OPEN_LEDGER_MAX_ENTRIES = 200;
export const OPEN_LEDGER_BRIEF_MAX = 5;
export const OPEN_LEDGER_PLAYER = "player";

export interface OpenLedgerEntry {
  readonly id: string;
  readonly text: string;
  readonly speaker: string;
  readonly addressedTo: readonly string[];
  readonly kind: string;
  readonly turn: number;
  readonly beatSeq: number;
  readonly room: string;
  readonly witnesses: readonly string[];
  readonly quoteHash: string;
  readonly status: "open";
}

export interface OpenLedger {
  readonly nextId: number;
  readonly entries: readonly OpenLedgerEntry[];
}

export type OpenLedgerRejection = "bad-shape" | "empty" | "too-long" | "bad-speaker" | "bad-addressee" | "not-involving-player" | "not-present" | "full";

export const emptyOpenLedger = (): OpenLedger => ({ nextId: 1, entries: [] });

export interface OpenLedgerProposal { text: string; speaker: string; addressedTo: string[]; kind: string }

/** Check the request shape (exactly text, speaker, addressedTo, kind) and normalize it. A string is the rejection code. */
export function openLedgerProposal(req: unknown, knownIds: ReadonlySet<string>): OpenLedgerProposal | OpenLedgerRejection {
  if (!req || typeof req !== "object" || Array.isArray(req)) return "bad-shape";
  const keys = Object.keys(req as object).sort().join(",");
  if (keys !== "addressedTo,kind,speaker,text") return "bad-shape";
  const { text, speaker, addressedTo, kind } = req as Record<string, unknown>;
  if (typeof text !== "string" || typeof speaker !== "string" || typeof kind !== "string" || !Array.isArray(addressedTo)) return "bad-shape";
  if (addressedTo.length > OPEN_LEDGER_ADDRESSED_MAX || addressedTo.some((a) => typeof a !== "string")) return "bad-shape";
  const t = normalizeCanonText(text);
  if (!t) return "empty";
  if (t.length > OPEN_LEDGER_TEXT_MAX) return "too-long";
  const known = (id: string): boolean => id === OPEN_LEDGER_PLAYER || knownIds.has(id);
  if (!known(speaker)) return "bad-speaker";
  const to = [...new Set(addressedTo as string[])];
  if (to.some((a) => !known(a) || a === speaker)) return "bad-addressee";
  if (speaker !== OPEN_LEDGER_PLAYER && !to.includes(OPEN_LEDGER_PLAYER)) return "not-involving-player";
  const k = normalizeCanonText(kind).slice(0, OPEN_LEDGER_KIND_MAX).trim() || "claim";
  return { text: t, speaker, addressedTo: to, kind: k };
}

/** Append one entry (immutably). Everyone involved must be a witness. A repeat of the same words by the same speaker is a no-op. */
export function recordOpenEntry(
  ledger: OpenLedger,
  p: OpenLedgerProposal,
  ctx: { turn: number; beatSeq: number; room: string; witnesses: readonly string[] },
): { ledger: OpenLedger; outcome: "recorded" | "duplicate" | OpenLedgerRejection; id?: string } {
  const witnesses = [...new Set([OPEN_LEDGER_PLAYER, ...ctx.witnesses])].sort();
  if ([p.speaker, ...p.addressedTo].some((id) => !witnesses.includes(id))) return { ledger, outcome: "not-present" };
  const quoteHash = canonHash(`${p.speaker}|${p.text}`);
  const dup = ledger.entries.find((e) => e.quoteHash === quoteHash);
  if (dup) return { ledger, outcome: "duplicate", id: dup.id };
  if (ledger.entries.length >= OPEN_LEDGER_MAX_ENTRIES) return { ledger, outcome: "full" };
  const id = `open:${ledger.nextId}`;
  const entry: OpenLedgerEntry = {
    id, text: p.text, speaker: p.speaker, addressedTo: p.addressedTo, kind: p.kind,
    turn: ctx.turn, beatSeq: ctx.beatSeq, room: ctx.room, witnesses, quoteHash, status: "open",
  };
  return { ledger: { nextId: ledger.nextId + 1, entries: [...ledger.entries, entry] }, outcome: "recorded", id };
}

/** The brief section: open entries involving a houseguest who is here now, newest first. */
export function openLedgerSection(
  ledger: OpenLedger, hereIds: readonly string[], nameOf: (id: string) => string,
): string | undefined {
  const here = new Set(hereIds);
  const lines: string[] = [];
  for (const e of [...ledger.entries].reverse()) {
    if (e.status !== "open") continue;
    const who = [e.speaker, ...e.addressedTo].filter((id) => id !== OPEN_LEDGER_PLAYER && here.has(id));
    if (!who.length) continue;
    const by = e.speaker === OPEN_LEDGER_PLAYER ? "you" : nameOf(e.speaker);
    lines.push(`- open between you and ${nameOf(who[0]!)} (${e.kind}, from ${by}): "${e.text}"`);
    if (lines.length >= OPEN_LEDGER_BRIEF_MAX) break;
  }
  if (!lines.length) return undefined;
  return ["6. OPEN BETWEEN YOU AND THOSE HERE (said in earlier scenes and still standing; keep it consistent, do not resolve it unless the scene does)", ...lines].join("\n");
}

/** Read a saved ledger; anything unreadable yields the empty ledger plus a problem count (the caller keeps the raw copy). */
export function restoreOpenLedger(raw: unknown): { ledger: OpenLedger; problems: number } {
  if (raw === undefined) return { ledger: emptyOpenLedger(), problems: 0 };
  const o = raw as { nextId?: unknown; entries?: unknown } | null;
  if (!o || typeof o !== "object" || !Array.isArray(o.entries) || typeof o.nextId !== "number") return { ledger: emptyOpenLedger(), problems: 1 };
  const entries: OpenLedgerEntry[] = [];
  let problems = 0;
  for (const e of o.entries as OpenLedgerEntry[]) {
    if (e && typeof e.id === "string" && typeof e.text === "string" && typeof e.speaker === "string" && Array.isArray(e.addressedTo)
      && typeof e.quoteHash === "string" && Array.isArray(e.witnesses)) entries.push(e);
    else problems++;
  }
  return { ledger: { nextId: o.nextId, entries }, problems };
}

/** True when `later` still holds every earlier entry's words (append-only; never thinned). */
export function openLedgerSuperset(earlier: OpenLedger, later: OpenLedger): boolean {
  const byId = new Map(later.entries.map((e) => [e.id, e] as const));
  return later.nextId >= earlier.nextId && earlier.entries.every((e) => byId.get(e.id)?.text === e.text);
}
