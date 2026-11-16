#!/usr/bin/env python3
"""ORW-511: the short-list guard. Fails when the code gains
  (a) a string list that feeds a random / hash / modulo pick and has fewer than LIMIT items, or
  (b) an example line ("e.g.", "for example", "such as") or a closed menu inside a STRING (prompt text),
unless ci/short_list_allowlist.json carries an entry for it with an owner and a written reason. See ci/short_list_scan.py for exactly what is detected.

An allowlist entry is {path, kind, name, max, owner, reason}: `max` is a ceiling on how many hits of that kind/name the file may hold (text hits use name "text"),
so a NEW example in an already-listed file still fails. An owner's PR removes its entries as it fixes the sites; an entry whose ceiling is above the real count is
reported (not failed) so the ratchet is visibly loose. Usage: check_short_lists.py [--list] [--write-allowlist] (exit 1 on a violation)."""
from __future__ import annotations

import collections
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import short_list_scan as S  # noqa: E402

ALLOWLIST = S.ROOT / "ci" / "short_list_allowlist.json"
MIN_REASON = 20

# Seed rules for --write-allowlist: first match wins. (path regex, kind or "*", owner, reason)
OWNER_RULES = [
    (r"^src/engine/(characterFactory|deepProfile|characters|castGenesis|genesisConstants|diversityConstants|seededRelationships)\.ts$|^src/domain/", "list", "ORW-508", "cast and character pool (ORW-508 audit); moves to world tables / per-person authoring"),
    (r"^frontend/src/orwell_facet_ledger\.py$", "*", "ORW-508", "front-end facet ledger menu (ORW-508 audit C27)"),
    (r"^frontend/src/orwell_(cast_authoring|cast_genesis)\.py$", "*", "ORW-480", "cast-text authoring prompt and tables, rewritten by the ORW-480 PRs"),
    (r"^frontend/src/orwell_portrait|^src/engine/(portraitPrompts|imageConstants)\.ts$", "*", "ORW-480", "photo track: portrait prompt tables and shot brief"),
    (r"^src/engine/(alliances|confessionals|zeitgeist|reserveTwists)\.ts$", "*", "ORW-509", "world-side list (alliance names, confessional fallbacks, world snapshot, twist pool)"),
    (r"^src/engine/momentPrompts\.ts$|^frontend/src/agent_loop\.py$", "*", "ORW-510", "live narrator / moment prompt text"),
    (r"^src/engine/producerPersona\.ts$", "list", "ORW-511", "component of a composed floor: each producer field is a first clause (5-6) times a second clause (8) drawn on its own, and the live writer overlay authors the real persona"),
    (r"^src/engine/(dealConsent|juryMinds)\.ts$", "list", "ORW-511", "mechanics: internal key order or archetype keys, never shown to a player"),
    (r"^frontend/(mcp_servers|routes/email|src/document_processor)", "list", "ORW-511", "mechanics: file/folder/model name candidates tried in order, never shown to a player"),
    (r"^frontend/src/orwell_cast_identity\.py$", "menu", "ORW-511", "closed by design: structural enumerations the response validator checks (gender, orientation); not an example the model copies"),
    (r"^src/adapters/mcp/McpServer\.ts$", "menu", "ORW-511", "closed by design: tool argument schema message, not model-visible prose"),
    (r"^frontend/(static/js|src/(tool_|deep_research|teacher|visual|integrations|ai_interaction|youtube|chroma|goal|task_|memory)|routes|services|core|mcp_servers|app\.py|setup\.py|src/orwell_open)", "*", "ORW-511", "non-game assistant/admin surface (tool schemas, settings hints, route help) by path: not creative text for the game player; ORW-511 sweeps these for copyable examples as they are touched"),
    (r"^src/adapters/mcp/", "*", "ORW-511", "tool schema text, not game prose"),
]


def load_allowlist() -> list[dict]:
    return json.loads(ALLOWLIST.read_text(encoding="utf8"))["entries"]


def counts(hits: list[S.Hit]) -> dict[tuple[str, str, str], int]:
    c: dict[tuple[str, str, str], int] = collections.Counter()
    for h in hits:
        name = h.name if h.kind == "list" else "text"
        c[(h.path, h.kind, name)] += 1
    return c


def check(hits: list[S.Hit], entries: list[dict]) -> tuple[list[str], list[str]]:
    """(violations, loose-ceiling notes)."""
    bad: list[str] = []
    notes: list[str] = []
    allowed = {(e["path"], e["kind"], e["name"]): e for e in entries}
    for e in entries:
        if len(str(e.get("reason", "")).strip()) < MIN_REASON or not e.get("owner"):
            bad.append(f"allowlist entry {e.get('path')}:{e.get('kind')}:{e.get('name')} needs an owner and a written reason (>= {MIN_REASON} chars)")
    got = counts(hits)
    lines = collections.defaultdict(list)
    for h in hits:
        lines[(h.path, h.kind, h.name if h.kind == "list" else "text")].append(h.line)
    for key, n in sorted(got.items()):
        e = allowed.get(key)
        where = f"{key[0]}:{','.join(map(str, lines[key][:6]))}"
        if e is None:
            what = {"list": f"string list {key[2]!r} dealt from with fewer than {S.LIMIT} items", "example": "example line inside prompt text", "menu": "closed menu inside prompt text"}[key[1]]
            fix = ("author it per moment from the game's facts or compose it from independent parts so the floor is wide, then it needs no entry" if key[1] == "list"
                   else "state the quality wanted as a rule instead of a sample the model will copy")
            bad.append(f"{where}: new {what}. Fix: {fix}; or add an entry to ci/short_list_allowlist.json with an owner and a reason.")
        elif n > int(e["max"]):
            bad.append(f"{where}: {n} hit(s), allowlist ceiling is {e['max']} (owner {e['owner']}); a NEW one was added. Fix it as above, do not raise the ceiling.")
    for key, e in allowed.items():
        if got.get(key, 0) < int(e["max"]):
            notes.append(f"loose: {key[0]} {key[1]} {key[2]} ceiling {e['max']}, found {got.get(key, 0)} (owner {e['owner']}): lower or delete the entry")
    return bad, notes


def seed_entries(hits: list[S.Hit]) -> list[dict]:
    out = []
    for (path, kind, name), n in sorted(counts(hits).items()):
        for rx, k, owner, reason in OWNER_RULES:
            if re.search(rx, path) and k in ("*", kind):
                break
        else:
            owner, reason = "ORW-511", "unassigned at seed time: needs a reviewer"
        out.append({"path": path, "kind": kind, "name": name, "max": n, "owner": owner, "reason": reason})
    return out


def main(argv: list[str]) -> int:
    hits = S.scan()
    if "--write-allowlist" in argv:
        ALLOWLIST.write_text(json.dumps({"limit": S.LIMIT, "entries": seed_entries(hits)}, indent=1, ensure_ascii=False) + "\n", encoding="utf8")
        print(f"wrote {ALLOWLIST} ({len(seed_entries(hits))} entries)")
        return 0
    bad, notes = check(hits, load_allowlist())
    for n in notes:
        print("note:", n)
    for b in bad:
        print("::error::short-list guard:", b)
    print(f"short-list guard: {len(hits)} hit(s) scanned, {len(bad)} violation(s)")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
