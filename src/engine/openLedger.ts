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
/** The most lines the brief ever shows for one turn (ranked: most people here involved first, then most recent). */
export const OPEN_LEDGER_BRIEF_MAX = 5;
export const OPEN_LEDGER_PARTIES_MAX = 8;
export const OPEN_LEDGER_ABOUT_MAX = 80;
export const OPEN_LEDGER_NOTE_MAX = 160;
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
  /** Slice 2: everyone party to it (a group pact lists them all, once). Absent on a slice-1 entry: then speaker + addressedTo. */
  readonly parties?: readonly string[];
  /** Slice 2: who or what a claim concerns, free text (a houseguest id when it is one). */
  readonly about?: string;
  readonly status: OpenLedgerStatus;
  /** Slice 2: why it was marked kept, broken or withdrawn (free text), and the turn it was marked. */
  readonly note?: string;
  readonly resolvedTurn?: number;
}

export type OpenLedgerStatus = "open" | "kept" | "broken" | "withdrawn";
export const OPEN_LEDGER_RESOLUTIONS: readonly OpenLedgerStatus[] = ["kept", "broken", "withdrawn"];

/** Everyone party to an entry (speaker, addressees, extra group members), without duplicates. */
export const partiesOf = (e: OpenLedgerEntry): string[] => [...new Set([e.speaker, ...e.addressedTo, ...(e.parties ?? [])])];

export interface OpenLedger {
  readonly nextId: number;
  readonly entries: readonly OpenLedgerEntry[];
}

export type OpenLedgerRejection = "bad-shape" | "empty" | "too-long" | "bad-speaker" | "bad-addressee" | "not-present" | "full";

export const emptyOpenLedger = (): OpenLedger => ({ nextId: 1, entries: [] });

export interface OpenLedgerProposal { text: string; speaker: string; addressedTo: string[]; kind: string; parties?: string[]; about?: string }

/** Check the request shape (text, speaker, addressedTo, kind, and optionally parties and about) and normalize it. A string is the rejection code. */
export function openLedgerProposal(req: unknown, knownIds: ReadonlySet<string>): OpenLedgerProposal | OpenLedgerRejection {
  if (!req || typeof req !== "object" || Array.isArray(req)) return "bad-shape";
  const given = Object.keys(req as object);
  if (given.some((k) => !["addressedTo", "kind", "speaker", "text", "parties", "about"].includes(k))) return "bad-shape";
  if (["addressedTo", "kind", "speaker", "text"].some((k) => !given.includes(k))) return "bad-shape";
  const { text, speaker, addressedTo, kind, parties, about } = req as Record<string, unknown>;
  if (parties !== undefined && (!Array.isArray(parties) || parties.length > OPEN_LEDGER_PARTIES_MAX || parties.some((a) => typeof a !== "string"))) return "bad-shape";
  if (about !== undefined && typeof about !== "string") return "bad-shape";
  if (typeof text !== "string" || typeof speaker !== "string" || typeof kind !== "string" || !Array.isArray(addressedTo)) return "bad-shape";
  if (addressedTo.length > OPEN_LEDGER_ADDRESSED_MAX || addressedTo.some((a) => typeof a !== "string")) return "bad-shape";
  const t = normalizeCanonText(text);
  if (!t) return "empty";
  if (t.length > OPEN_LEDGER_TEXT_MAX) return "too-long";
  const known = (id: string): boolean => id === OPEN_LEDGER_PLAYER || knownIds.has(id);
  if (!known(speaker)) return "bad-speaker";
  const to = [...new Set(addressedTo as string[])];
  if (to.some((a) => !known(a) || a === speaker)) return "bad-addressee";
  const group = [...new Set((parties as string[] | undefined) ?? [])];
  if (group.some((a) => !known(a))) return "bad-addressee";
  const k = normalizeCanonText(kind).slice(0, OPEN_LEDGER_KIND_MAX).trim() || "claim";
  const ab = about === undefined ? "" : normalizeCanonText(about).slice(0, OPEN_LEDGER_ABOUT_MAX).trim();
  return { text: t, speaker, addressedTo: to, kind: k, ...(group.length ? { parties: group } : {}), ...(ab ? { about: ab } : {}) };
}

/** Append one entry (immutably). Everyone involved (speaker, addressees, group) must be a witness; a claim ABOUT someone
 * may name a houseguest who is not here (they only have to be known), because the player heard it where they stand. A repeat of the same words by the same speaker is a no-op. */
export function recordOpenEntry(
  ledger: OpenLedger,
  p: OpenLedgerProposal,
  ctx: { turn: number; beatSeq: number; room: string; witnesses: readonly string[] },
): { ledger: OpenLedger; outcome: "recorded" | "duplicate" | OpenLedgerRejection; id?: string } {
  const witnesses = [...new Set([OPEN_LEDGER_PLAYER, ...ctx.witnesses])].sort();
  if ([p.speaker, ...p.addressedTo, ...(p.parties ?? [])].some((id) => !witnesses.includes(id))) return { ledger, outcome: "not-present" };
  const quoteHash = canonHash(`${p.speaker}|${p.text}`);
  const dup = ledger.entries.find((e) => e.quoteHash === quoteHash);
  if (dup) return { ledger, outcome: "duplicate", id: dup.id };
  if (ledger.entries.length >= OPEN_LEDGER_MAX_ENTRIES) return { ledger, outcome: "full" };
  const id = `open:${ledger.nextId}`;
  const entry: OpenLedgerEntry = {
    id, text: p.text, speaker: p.speaker, addressedTo: p.addressedTo, kind: p.kind,
    ...(p.parties ? { parties: p.parties } : {}), ...(p.about ? { about: p.about } : {}),
    turn: ctx.turn, beatSeq: ctx.beatSeq, room: ctx.room, witnesses, quoteHash, status: "open",
  };
  return { ledger: { nextId: ledger.nextId + 1, entries: [...ledger.entries, entry] }, outcome: "recorded", id };
}

/** Entries that matter to whoever is here now: any party, or the subject, is here. Most people here first, then most recent. At most `max`. */
export function openLedgerRelevant(ledger: OpenLedger, hereIds: readonly string[], max = OPEN_LEDGER_BRIEF_MAX): Array<{ e: OpenLedgerEntry; here: string[] }> {
  const here = new Set(hereIds.filter((id) => id !== OPEN_LEDGER_PLAYER));
  const hits: Array<{ e: OpenLedgerEntry; here: string[]; i: number }> = [];
  ledger.entries.forEach((e, i) => {
    const ids = [...partiesOf(e), ...(e.about ? [e.about] : [])].filter((id) => here.has(id));
    const unique = [...new Set(ids)];
    if (unique.length) hits.push({ e, here: unique, i });
  });
  hits.sort((x, y) => y.here.length - x.here.length || y.i - x.i);
  return hits.slice(0, Math.max(0, max)).map(({ e, here: h }) => ({ e, here: h }));
}

/** The brief section: what the player heard that still matters to those here now, phrased as heard; marked kept, broken or withdrawn where so. */
export function openLedgerSection(
  ledger: OpenLedger, hereIds: readonly string[], nameOf: (id: string) => string,
): string | undefined {
  const label = (id: string): string => (id === OPEN_LEDGER_PLAYER ? "you" : nameOf(id));
  const lines = openLedgerRelevant(ledger, hereIds).map(({ e, here }) => {
    const by = label(e.speaker);
    const group = partiesOf(e).filter((id) => id !== e.speaker);
    const plain = !e.about && !e.parties?.length && (e.speaker === OPEN_LEDGER_PLAYER || e.addressedTo.includes(OPEN_LEDGER_PLAYER));
    const status = e.status === "open" ? "" : ` [${e.status}${e.note ? `: ${e.note}` : ""}]`;
    if (plain) {
      return `- open between you and ${nameOf(here[0]!)} (${e.kind}, from ${by}): "${e.text}"${status}`;
    }
    const withWho = group.length ? `, among ${group.map(label).join(", ")}` : "";
    const about = e.about ? `, about ${e.about.startsWith("npc:") || here.includes(e.about) ? label(e.about) : e.about}` : "";
    return `- you heard ${by} say (${e.kind}${about}${withWho}): "${e.text}"${status}`;
  });
  if (!lines.length) return undefined;
  return ["6. OPEN BETWEEN YOU AND THOSE HERE (said in earlier scenes and still standing, or marked kept, broken or withdrawn; keep it consistent, do not resolve it unless the scene does)", ...lines].join("\n");
}

/** Mark one open entry kept, broken or withdrawn with a free-text note. Changes no relationship number. */
export function resolveOpenEntry(
  ledger: OpenLedger, req: unknown, turn: number,
): { ledger: OpenLedger; outcome: "resolved" | "bad-shape" | "unknown" | "already-resolved" | "bad-status" } {
  if (!req || typeof req !== "object" || Array.isArray(req)) return { ledger, outcome: "bad-shape" };
  if (Object.keys(req as object).sort().join(",") !== "entryId,note,status") return { ledger, outcome: "bad-shape" };
  const { entryId, status, note } = req as Record<string, unknown>;
  if (typeof entryId !== "string" || typeof status !== "string" || typeof note !== "string") return { ledger, outcome: "bad-shape" };
  if (!OPEN_LEDGER_RESOLUTIONS.includes(status as OpenLedgerStatus)) return { ledger, outcome: "bad-status" };
  const cur = ledger.entries.find((e) => e.id === entryId);
  if (!cur) return { ledger, outcome: "unknown" };
  if (cur.status !== "open") return { ledger, outcome: "already-resolved" };
  const n = normalizeCanonText(note).slice(0, OPEN_LEDGER_NOTE_MAX).trim();
  const entries = ledger.entries.map((e) => (e.id === entryId ? { ...e, status: status as OpenLedgerStatus, note: n, resolvedTurn: turn } : e));
  return { ledger: { ...ledger, entries }, outcome: "resolved" };
}

const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");
const STATUSES: readonly string[] = ["open", ...OPEN_LEDGER_RESOLUTIONS];

/**
 * A saved entry is accepted only when every field it carries has its declared type (a `parties: {}` or a
 * non-string `about` used to pass and then threw inside `partiesOf` on the next brief). Fields a slice-1 save
 * never had (parties, about, note, resolvedTurn, and a missing status) stay optional, so an old save loads.
 */
function validEntry(e: unknown): e is OpenLedgerEntry {
  if (!e || typeof e !== "object" || Array.isArray(e)) return false;
  const x = e as Record<string, unknown>;
  const opt = (k: string, t: "string" | "number"): boolean => x[k] === undefined || typeof x[k] === t;
  return typeof x.id === "string" && typeof x.text === "string" && typeof x.speaker === "string" && isStrings(x.addressedTo)
    && typeof x.quoteHash === "string" && isStrings(x.witnesses)
    && (x.parties === undefined || isStrings(x.parties))
    && opt("about", "string") && opt("note", "string") && opt("resolvedTurn", "number")
    && opt("kind", "string") && opt("room", "string") && opt("turn", "number") && opt("beatSeq", "number")
    && (x.status === undefined || (typeof x.status === "string" && STATUSES.includes(x.status)));
}

/** Read a saved ledger; anything unreadable yields the empty ledger plus a problem count (the caller keeps the raw copy). */
export function restoreOpenLedger(raw: unknown): { ledger: OpenLedger; problems: number } {
  if (raw === undefined) return { ledger: emptyOpenLedger(), problems: 0 };
  const o = raw as { nextId?: unknown; entries?: unknown } | null;
  if (!o || typeof o !== "object" || !Array.isArray(o.entries) || typeof o.nextId !== "number") return { ledger: emptyOpenLedger(), problems: 1 };
  const entries: OpenLedgerEntry[] = [];
  let problems = 0;
  for (const e of o.entries as unknown[]) {
    if (validEntry(e)) entries.push(e.status === undefined ? ({ ...e, status: "open" } as OpenLedgerEntry) : e);
    else problems++;
  }
  return { ledger: { nextId: o.nextId, entries }, problems };
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const IMMUTABLE_FIELDS = ["text", "speaker", "addressedTo", "kind", "turn", "beatSeq", "room", "witnesses", "quoteHash", "parties", "about"] as const;

/**
 * True when `later` still holds every earlier entry unchanged (append-only; never thinned or rewritten): every
 * identity, participant and provenance field is identical, and the only change allowed is open to resolved
 * (kept, broken or withdrawn, with its note and turn). A resolved entry stays exactly as it was resolved.
 */
export function openLedgerSuperset(earlier: OpenLedger, later: OpenLedger): boolean {
  const byId = new Map(later.entries.map((e) => [e.id, e] as const));
  return later.nextId >= earlier.nextId && earlier.entries.every((e) => {
    const l = byId.get(e.id);
    if (!l || !IMMUTABLE_FIELDS.every((k) => same(e[k], l[k]))) return false;
    if (e.status !== "open") return l.status === e.status && same(e.note, l.note) && same(e.resolvedTurn, l.resolvedTurn);
    return true;
  });
}
