# 0175 - The bond record (Theme 3 Core 1)

Card: ORW-552 (Ryne approved the Theme 3 plan, 2026-11-17). Executable spec: `0175-the-bond-record.feature`. Plan: the vault note "Theme 3 Slice Plan",
Core 1. Read API: `src/engine/bonds.ts` (posted on ORW-552; the house graph, Overseer B, consumes it). Record and folds: `src/engine/bondRecord.ts`.

## What it is

One directed, lopsided bond per ordered pair, beyond today's trust, affinity, threat and reliability (which are read through unchanged):

- **warmth**: felt closeness, apart from strategy;
- **debt**: who owes whom (a veto save leaves the saved one owing the saver);
- **resentment**: a grudge, which fades slowly; its **peak** is kept for good;
- **strain**: how frayed the bond is now; it repairs night by night without new conflict, and faster with a warm scene;
- **history**: shared key moments; it only grows;
- **commitment**: what the pair's open deals hold (`casual`, `final-two`, or `ride-or-die` when a final two runs deep);
- **kind**: read from the record. It can be friendship, showmance, rivals-turned-allies (a grudge that healed into warmth), protector (owed a lot) or business (committed, not warm). "mentor" and "puppet-master" need reads that later slices add.
- **rank**: each houseguest's private pecking order, their top five by strength.

`strength`, the one 0..1 tie weight consumers read, is the edge strength plus warmth minus a grudge.

## How it is folded

The engine folds the record from what happened, never from narration. It is deterministic and draws no rng:

- scenes the pair shared: house-life scenes and recorded interactions of a bonding, alliance, romance, strategy or conflict kind. A whole-house moment is not a pair's scene.
- deals kept, and deals broken. `Deal.brokenBy` is a new field recording who broke it, so the wronged party's grudge points at the breaker, and the breaker feels strain only.
- a veto save;
- one night's repair per in-game day passed.

It runs overnight and whenever the bond is read, and is idempotent: an event cursor and a seen-list of deal and save marks.

## The wall and the rest

- The record lives in the live season (`live.bonds`), engine-only (Vault class). It is saved and restored with the season, and never projected: no number, label or roster reaches the player or admin.
- Nothing decides from it yet. The later slices (deals, bonds' feelings, groups) read it, so this slice moves no outcome and no calibration.
- Flag `ORWELL_BOND_RECORD`: default ON. `=0` gives the edge-only bond read and keeps no record.
