import type { EntityId } from "../domain/ids";
import { FAVOR } from "./favorConstants";

/**
 * 0171 / Theme 3 slice 3 - THE FAVOR LEDGER (pure: no I/O, no rng, no Vault). A favor owed is a real debt between two houseguests: the SOURCE OF TRUTH for the debt on a bond (the bond record reads it through
 * `setFavorDebtSource`; nothing here is written into the relationship model's own debt fields). APPEND-ONLY: an entry is never deleted, only moved through `owed -> repaid | refused | passed`; a pass appends
 * a NEW owed entry for the new holder and keeps the old one as `passed`, so the original debtor is remembered. Engine-held and hidden: a favor between two NPCs is Vault content (the player learns of it only
 * through a pathway), and no view, narrator projection or admin surface carries a row, a count or a figure.
 */
export type FavorState = "owed" | "repaid" | "refused" | "passed" | "lapsed";

export interface FavorEntry {
  id: string;
  /** The debtor: who owes it. */
  owedBy: EntityId;
  /** Who it was originally owed TO (never changes, so a passed favor still remembers whose it was). */
  owedTo: EntityId;
  /** Who may call it in NOW (equals `owedTo` until it is passed on). */
  holder: EntityId;
  /** What it came from: a deal id, a counter id or an assurance id. A passed favor's new entry names the entry it came from in `passedFrom`. */
  origin: string;
  madeBeat: number;
  state: FavorState;
  /** The houseguests who heard it promised (the ones who weigh a refusal; never the two parties). */
  witnesses: EntityId[];
  resolvedBeat?: number;
  calledBeat?: number;
  passedFrom?: string;
}

export interface NewFavor { owedBy: EntityId; owedTo: EntityId; origin: string; beat: number; witnesses?: readonly EntityId[]; holder?: EntityId }

export class FavorLedger {
  private entries: FavorEntry[] = [];
  private seq = 0;

  /** A new favor is owed. Never between a houseguest and themself. */
  owe(f: NewFavor): FavorEntry | undefined {
    if (f.owedBy === f.owedTo) return undefined;
    const holder = f.holder ?? f.owedTo;
    const e: FavorEntry = {
      id: `favor:${++this.seq}`, owedBy: f.owedBy, owedTo: f.owedTo, holder, origin: f.origin, madeBeat: f.beat, state: "owed",
      witnesses: [...new Set(f.witnesses ?? [])].filter((w) => w !== f.owedBy && w !== holder && w !== f.owedTo),
    };
    this.entries.push(e);
    return e;
  }

  get all(): readonly FavorEntry[] { return this.entries; }
  get(id: string): FavorEntry | undefined { return this.entries.find((e) => e.id === id); }
  /** Favors still owed that `holder` may call in. */
  openHeldBy(holder: EntityId): FavorEntry[] { return this.entries.filter((e) => e.state === "owed" && e.holder === holder); }
  openOwedBy(debtor: EntityId): FavorEntry[] { return this.entries.filter((e) => e.state === "owed" && e.owedBy === debtor); }

  /** Mark a favor as called in (once). The debtor's answer follows with `resolve`. */
  call(id: string, beat: number): boolean {
    const e = this.get(id);
    if (!e || e.state !== "owed" || e.calledBeat !== undefined) return false;
    e.calledBeat = beat;
    return true;
  }

  /** `owed -> repaid | refused`, once. A resolved favor stays on the ledger. */
  resolve(id: string, state: "repaid" | "refused", beat: number): boolean {
    const e = this.get(id);
    if (!e || e.state !== "owed") return false;
    e.state = state;
    e.resolvedBeat = beat;
    return true;
  }

  /** Pass a favor on: the old entry becomes `passed`, a new owed entry for `to` carries the same debtor and original creditor. Not to the debtor, and not to the current holder. */
  /** 0195: a favor that can no longer be collected (the holder or the debtor left the house) - kept on the ledger, never deleted. */
  lapse(id: string, beat: number): boolean {
    const e = this.get(id);
    if (!e || e.state !== "owed") return false;
    e.state = "lapsed";
    e.resolvedBeat = beat;
    return true;
  }

  pass(id: string, to: EntityId, beat: number): FavorEntry | undefined {
    const e = this.get(id);
    if (!e || e.state !== "owed" || to === e.owedBy || to === e.holder) return undefined;
    e.state = "passed";
    e.resolvedBeat = beat;
    const next: FavorEntry = {
      id: `favor:${++this.seq}`, owedBy: e.owedBy, owedTo: e.owedTo, holder: to, origin: e.origin, madeBeat: beat, state: "owed",
      witnesses: e.witnesses.filter((w) => w !== to), passedFrom: e.id,
    };
    this.entries.push(next);
    return next;
  }

  /** Signed debt on the bond `holder -> other`: + means `other` owes `holder`, - means `holder` owes `other`; clamped to -1..1 (the `BondView.debt` convention). */
  debtBetween(holder: EntityId, other: EntityId): number {
    let owedToMe = 0;
    let iOwe = 0;
    for (const e of this.entries) {
      if (e.state !== "owed") continue;
      if (e.holder === holder && e.owedBy === other) owedToMe++;
      else if (e.holder === other && e.owedBy === holder) iOwe++;
    }
    return Math.max(-1, Math.min(1, (owedToMe - iOwe) * FAVOR.debtPerFavor));
  }

  serialize(): FavorEntry[] {
    return this.entries.map((e) => ({ ...e, witnesses: [...e.witnesses] }));
  }

  /** Replace from a snapshot; `seq` is recomputed from the loaded ids so a later favor never reuses one. */
  load(entries: readonly FavorEntry[]): void {
    this.entries = entries.map((e) => ({ ...e, witnesses: [...e.witnesses] }));
    this.seq = this.entries.reduce((m, e) => Math.max(m, Number(e.id.split(":")[1]) || 0), 0);
  }
}
